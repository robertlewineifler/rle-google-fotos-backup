# AGENTS.md – RLE Google Fotos Backup

> **PFLICHTREGEL FÜR ALLE LLM-AGENTEN:**
> Bei **jeder** Änderung am Code, an den Typen, an der Datenbankstruktur, an IPC-Kanälen, an den Build-Skripten oder am Verhalten der App muss diese `AGENTS.md` **im selben Arbeitsschritt** mit aktualisiert werden. Diese Datei ist die zentrale Wissensbasis für nachfolgende Chats/Agenten. Veraltete Angaben hier gelten als Bug.
> Diese Datei nicht löschen oder umbenennen. Änderungen immer in deutscher Sprache ergänzen (Projektsprache).

- Version (package.json): **1.1.0**
- Plattform: **Windows-Desktop** (Electron). Kein Mac/Linux-Support angestrebt (Windows-spezifische Pfade/APIs).
- Repository: `https://github.com/robertlewineifler/rle-google-fotos-backup`
- UI-Sprache: **Deutsch**. Code-Bezeichner/Kommentare: überwiegend Englisch, teils Deutsch.

---

## 1. Was ist dieses Programm?

Eine lokale Windows-Desktop-App, die die eigene **Google-Fotos-Bibliothek** sichert (Fotos + Videos). Sie lädt Dateien über einen **eingebetteten Browser (Electron `<webview>`)** herunter, indem sie die Google-Photos-Weboberfläche per simulierten Tastatureingaben fernsteuert (kein offizielles Google-API!). Danach werden lokale Metadaten korrigiert:

- Dateien landen in `<Zielordner>/<Jahr>/<Monat>/` und werden auf das **Original-Aufnahmedatum** gesetzt (JPEG-EXIF, MP4/MOV-Atome und Dateisystem-Zeitstempel).
- Eine **JSON-Datenbank** (`gphotos_db.json`) im Zielordner dokumentiert jede Datei, sodass Backups unterbrochen und fortgesetzt werden können.
- Es gibt Integritätsprüfungen (fehlende/defekte/duplizierte Dateien), Namensbereinigung, CSV-Export, Scan-Heatmap und einen getrennten **Album-Download**.
- Alles bleibt lokal: **keine Cloud, keine Telemetrie, keine externen Server** (einzige Ausnahme: geladene Webseite photos.google.com im Webview und Tailwind-CDN im index.html).

### Grundprinzip / Warum Crawling statt API?
Der Download-Mechanismus ist ausschließlich der **Webview-Crawler + Electron-`will-download`-Interception**. Ein früherer Google-Photos-Library-API-Ansatz wurde beim Cleanup (Phase 1) vollständig entfernt (Datei `services/googlePhotosService.ts`, IPC-Kanal `google-api-request`, zugehörige Typen). Nicht wieder einführen.

---

## 2. Tech-Stack & Befehle

| Bereich | Technologie |
|---|---|
| Desktop-Shell | Electron 29 (`main.cjs`, CommonJS; `preload.cjs`, CommonJS) |
| Frontend | React 18 + TypeScript 5, Vite 5, TailwindCSS via CDN (`index.html`) |
| EXIF | `piexifjs` (JPEG lesen/schreiben) |
| ZIP (Live Photos) | `adm-zip` |
| Video-Metadaten | eigene MP4/MOV-Atom-Parser (kein ffmpeg!) |
| Packaging | `electron-builder` (Ziele: `dir`, `portable`, `nsis`) → `release/` |
| Tests | **keine** (kein Test-Framework im Repo) |

### Befehle (`package.json`)

```bash
npm install

npm run dev            # nur Vite-Dev-Server auf Port 5273 (strictPort)
npm run electron:dev   # Vite + Electron parallel (concurrently -k) -> Entwicklungsmodus
npm run build          # tsc (nur Typecheck, noEmit) && vite build -> dist/
npm run electron:build # npm run build && electron-builder --win -> release/
```

- **Verifikation nach Änderungen:** mindestens `npm run build` (TypeScript-Typecheck + Bundle). Es gibt keinen Linter und keine Tests.
- `DEV starten.bat` startet `npm run electron:dev` **als Administrator** (UAC-Prompt). Wird für den Webview/Download-Flow benötigt.
- `vite.config.ts`: `base: './'` (wichtig für Electron-Dateipfade), Build nach `dist/`.
- `tsconfig.json`: strict, `jsx: react-jsx`, `noEmit`. `webview`-JSX wird in `declarations.d.ts` als `any` deklariert. `piexifjs` ist dort ebenfalls als `any`-Modul deklariert.

---

## 3. Dateiübersicht & Verantwortlichkeiten

```
App.tsx                      Zentrale UI + komplette Crawler-/Backup-Orchestrierung (React)
main.cjs                     Electron-Main: Downloads abfangen, Metadaten schreiben, Datei-/DB-IO, Logs, Backups
preload.cjs                  contextBridge: window.electron IPC-API (CommonJS!)
types.ts                     Alle TS-Typen inkl. window.electron-Interface (IPC-Typen)
index.html                   HTML-Shell, Tailwind-CDN, Importmap, Custom-Scrollbar-Styles
index.tsx                    React-Bootstrap (createRoot)
declarations.d.ts            Modul-/JSX-Deklarationen (webview, *.png, piexifjs)
logic/crawlerActions.ts      DOM-Steuerung im Webview (Tastatur-Events, Metadaten-Scraping, Panel-Scroll)
logic/databaseUtils.ts       CSV-Export, Duplikat-Auflösung
utils/exifUtils.ts           Datums-Parser (Google-Sidebar-Texte, EXIF), ISO-Datums-Helfer
components/StartupScreen.tsx     Startbildschirm (DB laden/neu anlegen)
components/ActionModals.tsx      CorrectionModal (F22: „Prüfung & Korrekturen“, 6 Tabs), AlbumDownloadModal
components/ScanHeatmap.tsx       Scan-Historie-Heatmap (4 Ansichtsmodi)
public/icon.ico, assets/icon.png Icons (Packaging/UI)
.env.local                   Platzhalter GEMINI_API_KEY (ungenutzt, nicht verwenden)
dist/, release/              Build-Artefakte (via .gitignore ausgeschlossen)
```

**Wichtig:** `main.cjs` und `preload.cjs` sind **CommonJS** (package.json hat `"type": "module"`!). Dürfen nicht auf ESM umgestellt werden. Das Frontend ist ESM/TSX.

---

## 4. End-to-End Workflow (was wann passiert)

### 4.1 Start
1. `StartupScreen` erscheint (App.tsx ist erst nach `isInitialized` die Haupt-UI).
2. **„Vorhandene .json laden“** → Datei-Dialog (`select-database-file`) → DB laden, `basePath` aus Dateipfad ableiten.
   - Enthält die DB `hashScheme !== 2`, läuft eine **einmalige Migration**: alter `hash` → `sourceHash`, `hash` gelöscht, `hashScheme = 2`, DB wird sofort gespeichert.
   - `scannedDays` wird initialisiert, falls altes Format.
3. **„Neuen Ordner wählen“** → Ordner-Dialog (`select-directory`) → DB-Struktur im Speicher anlegen, Pfad `<Ordner>/gphotos_db.json`. Existiert die Datei schon, wird nur gewarnt (nichts überschrieben).

### 4.2 Backup starten
1. Nutzer meldet sich im eingebetteten Webview (`https://photos.google.com`) an und öffnet ein beliebiges Foto (`/photo/<id>`-URL ist Pflicht).
2. „▶ Start Backup“ prüft die URL:
   - `/search/` → **blockiert** (Meldung: Suche deaktiviert, um Duplikate zu vermeiden).
   - `/album/` oder `/share/` → öffnet stattdessen den **AlbumDownloadModal**.
   - sonst: `/photo/` muss enthalten sein, sonst Fehler „Bitte öffne zuerst ein Bild!“.
3. `runBackupSession(false)` startet den Loop:
   - **F1.4-Start:** Aktuelles Foto per `loadURL` neu laden, ~1,2 s warten, Panel-Öffnungs-Check (falls nötig `i`, max. 3 Runden; bei `null`-Scrape nicht togglen), dann initiale Panel-Stabilisierung. (Album-Modus: weiterhin nur `toggleInfoPanel` + 1 s.)
   - Schleifenbedingung: `isWalkingRef.current === true`.
   - **Parallelitätsgrenze:** max. 5 aktive Downloads (`activeDownloadsRef >= 5` → 500 ms warten).
   - **Download-Checkpoint (F15):** Nach je **25 erfolgreichen Downloads** (nur Haupt-Backup) wird die DB gespeichert (`downloadsSinceSaveRef`). Ersetzt das frühere 30-s-Autosave und das Batch-Limit 1000. Album-Modus: kein Checkpoint (keine DB-Einträge).
4. Pro Iteration:
   a. `safeExtractInfo()` (mit 3-s-Timeout) liest Bild-ID (aus URL) + Sidepanel-Text (Datum + evtl. Dateiname). Bis zu 5 Versuche à 500 ms, wenn kein valides Datum.
   b. Datum via `parseGoogleDateString(webDate)`; bei NaN (F1.1): Diagnose-Log mit rohem Panel-Text, einmaliger `scrollSidePanelToBottom`-Versuch + Re-Scrape, dann `navigatePrevious` + `navigateNext` + `killVideoPlayers` + Reload-Versuche; nach 3 Fehlern in Folge wird das Bild übersprungen. Schlägt auch die Navigation fehl, wird sie 2× wiederholt; danach Abbruch mit eindeutiger Meldung „Session beendet: Element `<id>` blockiert die Navigation".
   c. **Tageswechsel-Erkennung:** ändert sich `getIsoDateString(webDate)` gegenüber `lastDayIdentifier`, wird der **vorherige, volle Tag** in `db.scannedDays[YYYY-MM-DD] = Date.now()` eingetragen (der erste Tag einer Session wird absichtlich ausgelassen, weil er evtl. unvollständig gescannt wurde). Dabei wird die DB gespeichert.
   d. `updateRangeTracking(webTimestamp)` aktualisiert Min/Max-Datum der Session; `sessionSeenIds.add(id)`.
   e. **Download-Entscheidung (nur Haupt-Backup):**
      - ID unbekannt → Download.
      - ID bekannt, Datei fehlt physisch (`check-file-exists`) → Download + Warnlog.
      - ID bekannt, Datei existiert → **kein Download**, aber Metadaten-Abgleich:
        * `missingSince` löschen (lokal wiedergefunden).
        * `onlineMissingSince` löschen (wieder online gesehen).
        * `originalName` aus Panel-Filename aktualisieren (nur wenn „trusted“, siehe Abschnitt 9).
        * Weicht `entry.timestamp` um > 60 s vom Web-Datum ab → Datei verschieben/umschreiben via `moveAndUpdateFile` – **nur mit Hash-Gate** (siehe 6.3). Ohne gespeicherten Hash wird dieser erst nachgetragen und die Korrektur auf den nächsten Lauf verschoben.
        * `scannedAt = Date.now()`.
   f. **Download anstoßen** (`initiateDownloadAsync`): `prepareDownload(config)` → `triggerDownloadKeys(webview)` (simuliert **Shift+D**) → blockierend warten auf `download-started` (max. **45 s**, F10). Nur bei echtem Start: `activeDownloads` erhöhen + ID zu `processedIdsRef` hinzufügen. Bei Timeout (F3/F10): Warnlog, Eintrag in `db.skippedDownloads[id]` (persistiert), `cancelPendingDownload` entwertet die Config, **kein** Slot/`processedIds`; die Navigation läuft erst nach Start oder Timeout weiter. Ein später eintreffender Download wird vom Main-Prozess verworfen. Einzeldownload („⬇ 1“) übergibt `startTimeoutMs = null` → **kein Limit** (F10b). Während des Wartens zeigt das Overlay die Wartekarte (F11).
   g. **Navigation:** `navigateNext` (ArrowRight) + `killVideoPlayers`, dann bis zu 30× à 200 ms prüfen, ob die URL-ID wechselt (`navigateAndVerifyChange`). Anschließend wartet `waitForPanelRefresh` (F1, 150 ms-Poll, max. 3 s) darauf, dass das Info-Panel zum neuen Foto wechselt (F1.3-Namens-Anker gegen Ein-Schritt-Lag). Bei Nicht-Erfolg: bis zu 2 Resyncs (prev/next); bleibt es stale → Session-Abbruch (F1.3). Kein ID-Wechsel nach 6 s → Loop bricht ab (vermutlich Bibliotheksende).
5. Nach dem Loop: auf alle aktiven Downloads warten.
6. `finishBackupSession()` (nur Haupt-Backup): `checkForOrphans()` + DB speichern + Log „Backup-Vorgang beendet.“
   - `checkForOrphans` (F2): prüft DB-Einträge, deren `timestamp` in **kompletten gescannten Tagen** liegt (safeStart = Min-Datum + 1 Tag um 00:00, safeEnd = Max-Datum um 00:00) und deren ID nicht in `sessionSeenIds` ist. Existiert die Datei lokal nicht → `missingSince`; existiert sie lokal, wurde aber online nicht gesehen → `onlineMissingSince` (Warnlog). Bereits markierte Einträge werden übersprungen.
7. „⏹ Stop“ setzt `isWalkingRef=false` und speichert sicherheitshalber. Ein offener Start-Wartevorgang läuft bewusst noch bis Start oder 45-s-Timeout zu Ende (F10); Reset/Logout brechen sofort ab (ohne Warnlog).

### 4.3 Einzel-Download („⬇ 1“)
- Nur wenn nicht `isWalking`, Zielordner vorhanden und URL-Kontext nicht Suche/Album/Share.
- Liest Metadaten (ggf. Infopanel-Toggle), prüft DB + physische Existenz, lädt sonst einzeln herunter. **Trusted ist hier immer `true`** (kein Stale-Panel-Detektor).
- **F20:** Die physische Existenz wird **immer** geprüft (auch bei gesetztem `missingSince`). Existiert die Datei bereits, wird kein Download erzwungen; ein stale `missingSince` wird gelöscht, die Orphan-Liste aktualisiert und sofort gespeichert (verhindert `(1)`-Kopien durch veraltete Flags).
- **F10b:** wartet **ohne Zeitlimit** auf den Start; davor werden offene frühere Einzel-Starts verworfen (`discardPendingStarts` → `cancelPendingDownload`).
- Kein Album-/Scan-Tracking.

### 4.4 Download-Ergebnis (Frontend `onDownloadComplete`)
- Bei Erfolg wird die ID aus `skippedDownloads` entfernt (F10). Die DB wird **sofort gespeichert** (erst **am Ende** des Success-Blocks, nachdem der neue `files`-Eintrag geschrieben wurde), wenn `wasSkipped || wasMissing || wasOnlineMissing || !isWalkingRef.current` – also bei Skip-/Orphan-Auflösung oder jedem manuellen Einzeldownload (F20); sonst gelten weiterhin die regulären Speicherpunkte.
- **F17:** Vor dem Überschreiben des Eintrags werden `missingSince`/`onlineMissingSince` des Vorgängers gemerkt; nach dem Schreiben werden `updateOrphansList()`/`updateOnlineMissingList()` aufgerufen, damit wiederhergestellte Dateien sofort aus den Korrektur-Listen verschwinden.
- `saveDatabase` liest den DB-Pfad aus `dbFilePathRef` (nicht aus dem State), damit auch Callback-Closures des ersten Renders (dieser Listener) korrekt speichern können.
- Haupt-Backup: Eintrag in `dbRef.current.files[id]` mit `filename`, `originalName`, `timestamp` (= finales Datum), `savedAt`, `downloadedAt`, `scannedAt`, `originalDate` (EXIF-String), `hash`, `sourceHash`. **`integrityStatus` wird absichtlich NICHT gesetzt** → Datei gilt als „ungeprüft“.
- Album-Modus: **kein DB-Eintrag**, nur Log + Anzeige in der „Neue Dateien“-Liste (max. letzte 100).
- Vergleich Web-Datum ↔ Original-EXIF: Abweichung > 60 s → UI-Status „Manuell“ (⚠) und Warn-Log; sonst „OK“ (✔).
- `activeProgress` wird pro `progressFilename`/`filename` entfernt, `activeDownloadsCount` dekrementiert.

---

## 5. Download-Pipeline im Main-Prozess (`main.cjs`)

### 5.1 `will-download`-Handler
- Reagiert nur, wenn `nextDownloadConfig.active === true` (Werte kommen via `prepare-download`). Ungeplante/verspätete Downloads werden **verworfen** (`event.preventDefault()`, F10; kein Speichern-Dialog, kein Tracking) und geloggt (`Ungeplanter Download verworfen`).
- `nextDownloadConfig` ist ein **globaler Singleton**; deshalb wartet das Frontend, bevor die nächste ID vorbereitet wird: in der Schleife blockierend auf Start/Timeout, vor Einzeldownloads/Session-Start per `discardPendingStarts`. `cancel-pending-download` entwertet die Config bei Timeout/Reset/Logout.
- `download-started` (F11) wird **nach** der Dateinamen-Sanitizing-Logik gesendet und enthält `id` + finalen Dateinamen (`finalFilename`), damit das Frontend die Wartekarte in-place zur Fortschrittskarte machen kann.
- Pfadlogik:
  - Normal: `<targetDir>/<YYYY>/<MM>/`
  - Album (`flatStructure: true`): direkt `<targetDir>/` (also z. B. `…/Alben/Urlaub_2024/`)
- **Dateinamen-Sanitizing:**
  - Endung wird **case-insensitiv** abgetrennt und in Kleinbuchstaben normalisiert (`.MP4` → `.mp4`).
  - Basisname auf **100 Zeichen** gekürzt (Google liefert teils Beschreibungen als Namen).
  - Kollisionen im Zielordner: `Name (1).ext`, `Name (2).ext`, … (Zähler-Schleife, `fs.existsSync` **und** `reservedTargetPaths`-Set, F5). Das Set reserviert gewählte Pfade, solange der Download läuft (Datei existiert erst nach `setSavePath`/Downloadstart), und wird im `done`-Handler wieder freigegeben → parallele Gleichnamige können sich nicht überschreiben. Auch die ZIP-Extraktion nutzt die Reservierung.
- Log-Einträge: Download-Start mit id/Datei/Ordner/Web-Datum/trusted; Abschluss mit Source-/File-Hash-Prefix.

### 5.2 ZIP-Handling (Live Photos)
- Nur bei `.zip`: `adm-zip` sucht den ersten Eintrag (nicht Ordner, kein `__macosx`) mit `.jpg`/`.jpeg`.
- Bild wird entpackt, Kollisionen erhalten `(n)`, das ZIP wird gelöscht (best effort), `savePath`/`finalFilename`/`ext` werden auf das Bild umgestellt.
- Fehler beim Entpacken: Download gilt trotzdem als erfolgreich, ZIP bleibt liegen.

### 5.3 Metadaten
1. **sourceHash** = SHA-256 der rohen Datei **vor** jedem Rewrite (stabiler Quell-Fingerprint).
2. Original-Datum lesen:
   - **JPEG:** `piexif.load` → bevorzugt `Exif.DateTimeOriginal` (Tag 36867), sonst `0th.DateTime` (306).
   - **Video** (`.mp4 .mov .m4v .avi .3gp .mpg .mts`): eigener MVHD-Parser (siehe 7.2).
3. **finalDate** = `webDate`; hat `originalDate` dieselbe Minute (`YYYY-MM-DD HH:MM`) wie `webDate`, wird `originalDate` (inkl. Sekunden!) übernommen.
4. **Nur wenn `trusted`** (siehe 9): JPEG-EXIF, Video-Atome und Dateisystem-Zeitstempel werden geschrieben. Bei `trusted=false`: Log „Metadaten-Rewrite übersprungen“, `metadataWritten=false` im Ergebnis.
5. **hash** = SHA-256 **nach** dem Rewrite (entspricht der Datei auf der Platte).

### 5.4 Ergebnis-Payload (`download-complete`)
`{ id, success, filename, progressFilename, originalName, path, error, originalExifDate, hash, sourceHash, finalDateTimestamp, metadataWritten }`
- `progressFilename` ist der Name, unter dem Fortschritt gemeldet wurde (wichtig, weil ZIPs umbenannt werden).
- Im `finally` wird **immer** geantwortet, damit der Frontend-Slot freigegeben wird.

---

## 6. Datenbank (`gphotos_db.json`)

### 6.1 Struktur (`types.ts` → `FileDatabase`, `DatabaseEntry`)
```jsonc
{
  "basePath": ".",              // wird beim Speichern immer auf "." gesetzt (relativ zur JSON-Datei)
  "lastUpdated": 1234567890,
  "hashScheme": 2,              // 2 = hash/sourceHash getrennt
  "scannedDays": { "2024-05-01": 1714590000000 },   // Tag -> Zeitpunkt des letzten Scans
  "skippedDownloads": { "<GooglePhotoId>": { "id": "…", "webTimestamp": 1714590000000, "filename": "IMG_1234.jpg", "detectedAt": 1714590000000, "mode": "backup|album" } }, // F10
  "files": {
    "<GooglePhotoId>": {
      "filename": "IMG_1234.jpg",      // lokaler Name (inkl. evtl. "(n)")
      "originalName": "IMG_1234.jpg",  // Name auf Google (ohne Kollisionszähler)
      "timestamp": 1234567890,          // Web-Datum; bestimmt den Ordner YYYY/MM
      "originalDate": "2024:05:01 12:00:00",
      "savedAt": 0,                     // LEGACY
      "downloadedAt": 0, "scannedAt": 0,
      "hash": "…",                      // SHA-256 der Datei auf der Platte
      "sourceHash": "…",                // SHA-256 des Rohdownloads
      "size": 123456,                   // Bytes (durch Struktur-Check befüllt)
      "missingSince": 0,                // Timestamp, gesetzt wenn Datei lokal nicht gefunden
      "onlineMissingSince": 0,          // Timestamp, gesetzt wenn online nicht gesehen (Datei lokal vorhanden)
      "integrityStatus": "ok|corrupt",  // undefined = ungeprüft
      "integrityCheckedAt": 0
    }
  },
  "scannedRanges": []            // LEGACY, wird per „Bereinigen“ entfernt
}
```
- Key der `files`-Map ist die **Google Photo ID** (aus der URL `/photo/<id>`).
- `basePath` im JSON ist nur informativ; der echte Basisordner wird beim Laden aus dem Dateipfad abgeleitet.
- `hashScheme`-Migration 1→2 passiert automatisch in `handleInitLoadDatabase` (App.tsx).
- Die UI führt `processedIdsRef = Set(Object.keys(db.files))` mit; das ist die bekannte ID-Menge der Session.
- `skippedDownloads` (F10): Fotos, deren Download-Start nicht innerhalb von 45 s bestätigt wurde (Key = **Google Photo ID**). Quelle der Sektion „Übersprungen“ im Korrektur-Modal; wird bei erfolgreichem Download/„Ignorieren“ entfernt und beim Laden gegen `files` bereinigt (selbstheilend). Einträge besitzen bewusst **keinen** `files`-Eintrag.

### 6.2 Speichern & Backups
- `saveDatabase` ruft IPC `save-database`; dieses schreibt `JSON.stringify(data, null, 2)` und ruft vorher `maybeBackupDatabase`.
- **DB-Backups:** `maybeBackupDatabase` kopiert höchstens **alle 10 Minuten** nach `<DB-Ordner>/Backups/gphotos_db_<YYYY-MM-DD_HHMMSS>.json`; es werden max. **20** Backups behalten (älteste werden gelöscht).
- Speichern passiert u. a.: nach Download-Complete nicht, sondern bei Trigger `saveDatabase()` (Integrität, Rename, Korrekturen, **Download-Checkpoint alle 25**, Tageswechsel, Stop, Session-Ende).

### 6.3 Hash-Gate (wichtigstes Sicherheitskonzept)
- `hash` beschreibt den **aktuellen Dateiinhalt**; `sourceHash` den Rohdownload.
- `move-and-update-file` und `rename-file` akzeptieren `expectedHash`:
  - Stimmt der tatsächliche SHA-256 nicht überein → **kein Schreibzugriff**, Antwort `HASH_MISMATCH` + `actualHash`.
  - Frontend aktualisiert bei Mismatch den gespeicherten Hash und verschiebt die Korrektur auf den nächsten Lauf (verhindert Endlosschleifen und schützt vor fremden Dateien).
- Ohne gespeicherten Hash wird zuerst `compute-file-hash` ausgeführt und die Korrektur ebenfalls vertagt.
- Gleiches Gate gilt beim Umbenennen.

---

## 7. Metadaten-Korrektur im Detail

### 7.1 JPEG-EXIF (`updateExifData`)
Schreibt `YYYY:MM:DD HH:MM:SS` in:
- `Exif.DateTimeOriginal` (36867)
- `Exif.DateTimeDigitized` (36868)
- `0th.DateTime` (306)

### 7.2 MP4/MOV (`readVideoMetadataAsync` / `updateVideoMetadataAsync`)
- Eigener ISO-BMFF-Atom-Parser (async, mit `fileHandle.read/write`):
  - **Lesen:** toppt `moov`-Container, sucht `mvhd`, liest je nach Version 32-/64-Bit-Zeit; Zeitbasis **1904-01-01** (Offset `2082844800` Sekunden).
  - **Schreiben:** rekursiv durch `moov` → `trak` → `mdia`; patcht `mvhd`, `tkhd`, `mdhd` (CreationTime + ModificationTime), Version 0 = 4 Byte, Version 1 = 8 Byte.
- Kein ffmpeg. Für unbekannte Container (`.avi`, `.mts`) wird gelesen/geschrieben versucht, kann aber fehlschlagen.

### 7.3 Dateisystem-Zeitstempel (`updateFileTimestamps`)
- `fs.utimesSync(filePath, date, date)`.
- **Windows-Zusatz:** per `powershell.exe -NoProfile -Command` werden `CreationTime`, `LastWriteTime`, `LastAccessTime` über `Get-Item -LiteralPath` gesetzt (Pfad wird mit einfachen Anführungszeichen escaped: `'` → `''`).
- Fehler werden nur geloggt, nie geworfen.

---

## 8. Integritätsprüfung & Wartung

### 8.1 Struktur-Check (IPC `check-db-integrity` / Button „🏗️ Struktur prüfen“)
- Prüft für jede DB-Datei, ob `<basePath>/<YYYY>/<MM>/<filename>` existiert → `missing`.
- Sammelt `sizeUpdates` (Dateigröße in Bytes) und, falls kein Hash vorhanden, berechnet er Hashes → `updates`.
- Mit `onlySubset=true` werden Hashes für Dateien mit `integrityStatus === 'ok'` und vorhandenem Hash übersprungen (Performanz).
- **Duplikaterkennung (F6):** ausschließlich **hash-basiert** über alle validen Dateien. Die frühere Dateinamen-Heuristik (`Name (n).ext` + gleiche Größe ± 2 s mtime) wurde entfernt, weil sie legitime, online vorhandene Google-Fotos mit gleichem Namen fälschlich als Duplikate markiert hat (Re-Download-Zyklus).
- Ergebnis wird im Frontend in die DB übernommen (Hashes, Größen), `missing` sofort als `missingSince` markiert, dann DB-Speichern.
- **F17-Selbstheilung:** Einträge mit `missingSince`, die **nicht** in `result.missing` stehen (Datei wieder vorhanden), verlieren das Flag (Log „Vermisst-Status zurückgesetzt…“); `updateOrphansList()` läuft danach **immer** (auch bei 0 neuen Missing-Einträgen), damit die Korrektur-Liste nie veraltet bleibt.
- **F21-Untracked-Scan:** Zusätzlich werden die Ordner `<basePath>/<YYYY>/<MM>/` nach Dateien durchsucht, die in **keinem** DB-Eintrag referenziert sind (`untracked` in `IntegrityResult`). Alben/Backups/Logs sind ausgenommen (nur 4-stellige Jahres-/2-stellige Monatsordner). Für jede verwaiste Datei wird der SHA-256 berechnet und mit bekannten Hashes verglichen → `duplicateOf` („Duplikat von <Datei>“) bzw. `trackedDuplicate` (Basisdatei, während die DB auf `Name (n).ext` zeigt). Angezeigt im Tab **„Verwaist“** des Fensters „Prüfung & Korrekturen“ (F22) mit Explorer/Anzeigen/Löschen (Löschen nutzt das bestehende `delete-file`-IPC, kein neuer Kanal).
- **F23-Auto-Auflösung:** Hash-identische Namenspaare werden beim Struktur-Check **automatisch** bereinigt (kein Button): Zeigt die DB auf `Name (n).ext` und die Basisdatei liegt untracked vor, wird der DB-Eintrag auf `Name.ext` umgestellt, gespeichert und danach `Name (n).ext` gelöscht; ist umgekehrt die `(n)`-Datei untracked (hash-identisch), wird sie gelöscht. Fehlschläge bleiben mit Hinweis im Tab „Verwaist“.

### 8.2 Inhalts-Check / Deep Scan (IPC `verify-file-integrity-batch` / „💾 Inhalt prüfen“)
- Chunks von **100** Dateien (F15); pro Datei:
  - `stat`: 0 Bytes → `corrupt`.
  - Datei wird als kompakter Read-Stream **komplett gelesen** (findet I/O-Fehler/bad sectors). JPEG-EOF-Check (FF D9) wurde bewusst entfernt („zu strikt“).
  - `ENOENT` wird ignoriert (Missing macht der Struktur-Check).
- Gestartet über den Kopf-Button „💾 Inhalt prüfen“ im Fenster „Prüfung & Korrekturen“; der Klick öffnet einen Auswahl-Dialog („⚡ Nur Ungeprüfte/Defekte (X)“ vs. „🔍 Alles neu scannen (N)“ mit Erklärung). Währenddessen Overlay mit Fortschritt. Ergebnis setzt `integrityStatus` + `integrityCheckedAt` in der DB (Silent Save); defekte Dateien erscheinen im Tab „Defekt“.

### 8.3 Fenster „Prüfung & Korrekturen“ (F22/F26, zusammengeführt)
Ein Modal mit **sechs Tabs** (oben, mit Zählern) und einer Statuszeile; vereint Strukturbericht, Korrekturen und Dateinamen-Prüfung:
- **Öffnen startet automatisch den Struktur-Check** (F26, inkl. F23/F24-Automatik); der frühere „Struktur prüfen“-Button ist entfernt.
- **Kopfzeile:** „💾 Inhalt prüfen“ (öffnet Auswahl-Dialog), „✕“. **Statuszeile:** „Prüfe Struktur…“ (Spinner) bzw. letzter Check (Duplikate/Veraltet) + Inhaltsprüfungs-Ergebnis; Buttons „Duplikate bereinigen“ / „Veraltete Felder bereinigen“ (nur bei n > 0). **Auto-Banner (F26):** Wurden beim Check Duplikate/Kollisionsreste entfernt oder Dateien umbenannt, erscheint kurz „✅ Automatisch bereinigt: …“ (8 s).
- **Einheitlicher Tab-Aufbau (F26):** Jeder Tab zeigt immer Kopfzeile (Icon/Name/Anzahl + Unterzeile) und Erklärungsbox; darunter Liste + Aktionen oder „Keine Einträge in dieser Kategorie.“.
- **Tab „Vermisst“:** aus DB löschen (Cleanup), „Status zurücksetzen“ oder „🌐 Web öffnen“ (`https://photos.google.com/photo/<id>`; Modal schließt).
- **Tab „Defekt“:** „🗑 Löschen“ entfernt die Datei **physisch**, der DB-Eintrag bleibt bewusst bestehen (ohne `integrityStatus`/`hash`) → beim nächsten Backup neu laden; „Alle von Festplatte löschen“ als Batch; pro Zeile „📂 Explorer“ und „🖼️ Anzeigen“ (F16).
- **Tab „Übersprungen“ (F10):** „🌐 Web öffnen“ lädt `photo/<id>` im Webview (danach „⬇ 1“ ohne Zeitlimit), „✖ Ignorieren“/„Alle ignorieren“ entfernt den Eintrag aus `skippedDownloads`.
- **Tab „Online nicht gefunden“ (F13/F27):** pro Zeile „🌐 Web öffnen“ (ausgegraut, da online meist nicht mehr vorhanden – bewusst weiterhin klickbar), „📂 Explorer“, „🖼️ Anzeigen“, **„🗑 Löschen“ (einzeln, F27: Datei + DB-Eintrag)**; Batch „Status zurücksetzen (Behalten)“ und „Alle lokal löschen“ (F7-Muster).
- **Tab „Verwaist“ (F21):** verwaiste Dateien aus dem letzten Struktur-Check, pro Zeile „📂 Explorer“, „🖼️ Anzeigen“, „🗑 Löschen“; Batch „Alle löschen“. Hash-identische `(n)`-Paare werden bereits automatisch beim Check aufgelöst (F23); Basisdateien mit fehlgeschlagener Auflösung haben keinen Löschen-Button.
- **Tab „Dateinamen“ (F24, read-only):** kompakte Stats-Zeile (inkl. „Automatisch erledigt“) und Einzelzeilen nur für `protected`, `noName`, `nameMismatch`, `collision` (keine Buttons).

### 8.4 Dateinamen-Prüfung (IPC `find-renamable-files`; F24 automatisch)
- Läuft **automatisch** am Ende von `handleIntegrityCheckDone` (Struktur-Check); es gibt keinen separaten Button und kein manuelles Rename-Modal mehr.
- Kandidaten sind Dateien mit Muster `Name (n).ext`, bei denen:
  1. `originalName` vorhanden ist,
  2. `originalName` **nicht** selbst exakt der aktuelle Name ist (echte Google-Namen mit Klammer werden geschützt),
  3. der Dateistamm (ohne Endung, case-insensitiv) von `originalName` und Basisname (`Name.ext`) übereinstimmt (deckt `.JPG`/`.jpg`/HEIC→jpg ab),
  4. die `(n)`-Datei existiert,
  5. der Zielname frei ist.
- Basisdatei existiert bereits → Hashes vergleichen (F23): **identisch** → `resolveDuplicate` (DB auf Basisnamen, `(n)` löschen); **unterschiedlich** → kein Rename, nur `collisionPair` (echte Kollision).
- **Automatische Ausführung (F24):** `resolveDuplicate` wird via DB-Umstellung + `deleteFile` aufgelöst (Hash-Gate über `compute-file-hash`); sichere `targetMissing`-Kandidaten via `rename-file` mit `expectedHash`. Erfolge werden gezählt (`autoRenamed`/`autoResolved`) und geloggt.
- `find-renamable-files` liefert zusätzlich `entries` (F24, `RenameCheckEntry`) für **alle** Kategorien; der sechste Tab „Dateinamen“ im Fenster „Prüfung & Korrekturen“ zeigt als **Einzelzeilen** nur `protected`, `noName`, `nameMismatch` und `collision` (read-only); die übrigen Kategorien nur als Zähler (`stats`).

### 8.5 CSV-Export („📄 Excel CSV Export“)
- Datei: `<DB-Ordner>/gphotos_export_YYYY-MM-DD.csv`.
- **UTF-8 mit BOM** (`\uFEFF`), Trennzeichen **Semikolon**, Felder in Anführungszeichen (`"` wird verdoppelt), sortiert nach `timestamp` absteigend.
- Spalten: ID; Filename; Original Name; Web Date (Readable); Timestamp; Original Date; Hash; Source Hash; Integrity Status (Nicht geprüft/OK/Defekt); Saved At; Downloaded At; Scanned At; Missing Since; Online Missing Since.

### 8.6 Legacy-Bereinigung („Bereinigen“ im Struktur-Bericht)
- Entfernt `scannedRanges` (Root) und alle unbekannten Felder aus `files`-Einträgen. Gültige Keys (müssen synchron gehalten werden!):
  `filename, timestamp, originalDate, originalName, savedAt, downloadedAt, scannedAt, hash, sourceHash, missingSince, onlineMissingSince, id, integrityStatus, integrityCheckedAt, size`.
- Die gleiche Key-Liste existiert **doppelt**: in `App.tsx` (`executeCleanLegacy`) und in `components/ActionModals.tsx` (Legacy-Zählung). **Bei Schema-Änderungen beide Stellen anpassen!**

### 8.7 Duplikate auflösen (F6 / Variante A)
- `resolveDuplicatesOnDisk` (logic/databaseUtils.ts) arbeitet nur noch auf Hash-Duplikatgruppen:
  - Einträge, die **noch online vorhanden** sind (kein `missingSince`/`onlineMissingSince`), werden **nie** gelöscht.
  - Enthält die Gruppe Online-Einträge: alle **Offline-Kopien** werden physisch gelöscht und aus der DB entfernt.
  - Enthält sie nur Offline-Einträge: der **beste** bleibt (kürzester Dateiname, bei Gleichstand ältestes `timestamp`), der Rest wird gelöscht.
  - Gruppen, in denen nichts gelöscht werden darf (alle online), werden übersprungen und gezählt (`skippedOnlineGroups`).
- Damit bleiben mehrere Google-Fotos mit gleichem Namen/Inhalt erhalten, solange sie online existieren; der frühere Lösch-/Re-Download-Zyklus ist beseitigt.

### 8.8 Scan-Heatmap
- `scannedDays` (Tag → Scan-Zeitpunkt) + DB-Dateien werden pro Kalenderjahr als GitHub-Style-Grid gerendert.
- 4 Modi: **Relativ (grün)**, **Absolut (blau, Alter des Scans)**, **Menge (rot, Fotos/Tag)**, **Größe (gelb, Bytes/Tag)**.
- Sonderfälle: gescannt & 0 Fotos = gestreift; Fotos vorhanden, aber nie gescannt = amber Warnfarbe.

---

## 9. Trust-/Stale-Panel-Mechanik (wichtig, leicht zu brechen!)

Google Photos aktualisiert das Info-Sidepanel asynchron verzögert beim Navigieren. Dadurch kann der Scraper **Metadaten des Vorgängerfotos** lesen. Seit F1 gibt es dafür zwei Mechanismen: den **Panel-Refresh-Wait** (primär) und den **Trust-Detektor** (Fallback).

### 9.1 Panel-Refresh-Wait (F1)

- `extractCurrentImageInfo` liefert wieder eine `panelSignature` (Sidebar-Texte + Anzahl + `potentialFilename`). Erfasst seit F1.1 zusätzlich die Tags `H4`, `BUTTON`, `A`, `LI`, `TD`, `LABEL` (Datums-/Detailzeilen sind teils klickbar).
- `scrollSidePanelToBottom` (F1.1): scrollt das größte scrollbare Element rechts (>70 % Viewportbreite) ans Ende, damit lazy/virtualisierte Details gerendert werden. Wird nur im Fehlerpfad „Datum nicht lesbar" einmal pro Foto aufgerufen; `panelScrolledRef` steuert die Einmaligkeit.
- `waitForPanelRefresh(prevSignature, timeoutMs=3000)` in App.tsx: pollt alle **150 ms**; „refreshed" = Signatur ≠ Vorgänger **und** bei zwei aufeinanderfolgenden Reads stabil. `prevSignature === null` = nur Stabilität (Erst-Synchronisierung). Respektiert `isWalkingRef` (Stop/Reset).
- **F1.3-Namens-Anker:** Eine Probe gilt als „noch Vorgängerfoto", wenn ihr `potentialFilename` (ohne Kollisions-Suffix `(n)`, case-insensitiv) dem zuletzt verarbeiteten Dateinamen entspricht → wird **nicht** akzeptiert, weiter gepollt. Verhindert den Ein-Schritt-Lag („Panel ändert sich" ≠ „Panel gehört zur aktuellen URL").
- Nach jeder Navigation (`navigateAndVerifyChange`) wird der Refresh abgewartet:
  - Erfolg → `panelRefreshedRef=true` (Trust-Beweis für das nächste Foto), `panelSyncedRef=true`.
  - **F1.3-Resync:** Bei Nicht-Erfolg bis zu 2× `navigatePrevious` + 400 ms + `navigateNext` + 300 ms + erneuter Wait (zwingt Google, das Panel für das aktuelle Foto neu zu rendern).
  - **F1.3-Abbruch:** Bleibt es stale → `desyncAbortRef=true`, Log `Session beendet: Panel-Desync nicht behebbar (Element <id>) – bitte manuell prüfen.`; die Schleife bricht ab, die DB wird gespeichert, die **Missing-/Orphan-Prüfung wird übersprungen** (`finishBackupSession(skipOrphans=true)`), da die Session unvollständig ist.
  - **F1.5a-Stop-Abgrenzung:** Wird während des Waits gestoppt/resettet (`isWalkingRef=false`), wird **kein** Desync gemeldet und kein Abbruch-Flag gesetzt – der Scan endet normal (Missing-Prüfung läuft).
- **Deterministischer Session-Start (F1.4):** Der F1.3-Nudge (prev/next) wurde entfernt – er hinterließ das Panel einen Schritt zurück und blockierte den Namens-Anker (Sackgasse). Stattdessen: aktuelle Foto-ID merken → `loadURL('https://photos.google.com/photo/<id>')` (frisches Panel) → 1,2 s warten → **Panel-Öffnungs-Check** (max. 3 Runden; bei `null`-Scrape NICHT togglen, sonst schließt man ein offenes Panel) → initiale Panel-Stabilisierung (2 s). Log: `Panel beim Start synchronisiert|nicht lesbar`. Der Resync verifiziert seit F1.4 zusätzlich die URL (`resyncId === newId`), und bei Wait-Timeout wird die letzte Probe als Debug-Zeile geloggt (`Panel-Wait-Timeout: name=… dateOk=… texts=… sig=…`).
- **Album-Modus überspringt Wait/Nudge komplett** (unverändert schnell; Trust ist dort irrelevant).
- **F1.2-Rückbau (Vollscan wieder aktiv):** Der frühere Teilscan über einen gecachten Panel-Container (`window.__rlePanelRoot`) wurde entfernt – er lieferte nach Navigationen veraltete (versteckte) Panel-Inhalte und führte zum Desync-Abbruch. `extractCurrentImageInfo` scannt wieder die gesamte Seite (Elemente rechts >70 % Viewportbreite), inkl. erweiterter Tag-Liste (`H4`, `BUTTON`, `A`, `LI`, `TD`, `LABEL`). **Beibehalten:** `pendingInfoRef` – das vom Wait per zweitem Read bestätigte Ergebnis wird in der nächsten Iteration statt eines redundanten dritten Scans verwendet (ID-Abgleich mit `currentId`; bei Mismatch verworfen).

### 9.2 Trust-Detektor (`evaluateScrapeTrust(panelRefreshed, result, webTimestamp, entry)`)

- **Harte Namenssperre (immer):** `potentialFilename` == Vorgängername und ≠ eigener Name (`filename`/`originalName`) → `trusted=false` („Kandidat entspricht Vorgängername"). Schützt auch bei bestätigtem Refresh vor Teil-Updates.
- **`panelRefreshed`** → `trusted=true` (60-s-Heuristik wird umgangen).
- **Fallback (Timeout/erste Iteration):**
  - Kein Vorgänger → vertrauenswürdig.
  - Vorgänger-Datum (EXIF oder Web) bzw. `filename` vergleichen: Match innerhalb 60 s oder gleicher Name.
  - Zusätzlich `matchesOwn` gegen `entry.timestamp`, wenn kein EXIF-Datum vorliegt.
  - Unvollständige Vorgänger-Referenz → **`trusted=true`** statt untrusted (verhindert die frühere Untrusted-Kaskade).
- Debug-Log **nur bei Auffälligkeiten** (F14): `Trust: refreshed=… synced=… reason=… id=…` (Typ `debug`, nur Konsole/Logdatei) wird geloggt, wenn `!trusted`, `reason != ''` oder der Panel-Refresh nicht bestätigt ist (nicht beim ersten Foto). Normale Fotos erzeugen keine Zeile. Vollprotokoll für Diagnose: `VERBOSE_TRUST_LOG = true` (Modul-Konstante in App.tsx).

### 9.3 Konsequenzen bei `trusted=false`

- Download läuft trotzdem, aber **`trusted=false` im Download-Config** → Main-Prozess schreibt **keine** Metadaten (EXIF/Video/FS), `metadataWritten=false`.
- Namens-/Datums-Korrekturen werden mit Warnlog übersprungen.
- `rememberTrueMeta` speichert den Web-Timestamp dann nicht als verlässlich.
- `handleSingleDownload` nutzt diesen Detektor **nicht** (immer `trusted=true`).

---

## 10. Album-Download (getrennt vom Backup)

- Auslöser: URL-Kontext `/album/` oder `/share/` bei Start/`⬇ 1` → `AlbumDownloadModal` (Ordnername, Sanitizing `[\\/:*?"<>|]` → `_`).
- Ziel: `exportPath + '\\Alben\\' + folderName` (**hartkodierter Backslash**, Windows only; flache Struktur).
- Verhalten: **immer herunterladen**, keine DB-Prüfung, **kein DB-Eintrag**, keine Statistik, keine `scannedDays`, keine Orphan-Prüfung. Logs mit Typ `album` (violett in der UI).
- Duplikate sind ausdrücklich erwünscht; der Ordner kann separat gelöscht werden.
- `isAlbumModeRef` steuert das Verhalten global; nach dem Loop wird es zurückgesetzt.

---

## 11. IPC-API (preload.cjs → `window.electron`)

Alle Kanalnamen exakt so (main.cjs `ipcMain`):

| Preload-Funktion | Kanal | Typ | Zweck |
|---|---|---|---|
| `selectDirectory` | `select-directory` | invoke | Ordner-Dialog |
| `selectDatabaseFile` | `select-database-file` | invoke | JSON-Datei-Dialog |
| `clearSessionCache` | `clear-session-cache` | invoke | `session.clearStorageData()` |
| `logToConsole` | `log-to-console` | send | Log in Konsole + Datei |
| `openLogsFolder` | `open-logs-folder` | invoke | Log-Ordner öffnen |
| `loadDatabase` | `load-database` | invoke | JSON lesen, setzt `currentDbPath` |
| `saveDatabase` | `save-database` | invoke | JSON schreiben + DB-Backup |
| `saveTextFile` | `save-text-file` | invoke | CSV schreiben |
| `checkIntegrity` | `check-db-integrity` | invoke | Struktur-Check (Objekt-Argument!) |
| `findRenamableFiles` | `find-renamable-files` | invoke | Rename-Kandidaten |
| `verifyFileIntegrityBatch` | `verify-file-integrity-batch` | invoke | Deep Scan |
| `prepareDownload` | `prepare-download` | invoke | Setzt `nextDownloadConfig` |
| `cancelPendingDownload` | `cancel-pending-download` | invoke | Entwertet offene Download-Config (F10) |
| `onDownloadStarted` | `download-started` | on | Slot-Freigabe + finaler Dateiname (F11) |
| `onDownloadComplete` | `download-complete` | on | Ergebnis |
| `onDownloadProgress` | `download-progress` | on | Fortschritt |
| `removeDownloadListener` | – | – | entfernt alle 3 Listener |
| `deleteFile` | `delete-file` | invoke | Datei löschen |
| `renameFile` | `rename-file` | invoke | Umbenennen (Hash-Gate) |
| `checkFileExists` | `check-file-exists` | invoke | Existenzprüfung |
| `computeFileHash` | `compute-file-hash` | invoke | SHA-256 |
| `moveAndUpdateFile` | `move-and-update-file` | invoke | Verschieben + Metadaten (Hash-Gate) |
| `showItemInFolder` | `show-item-in-folder` | invoke | Explorer |
| `openFile` | `open-file` | invoke | Datei im Standard-Viewer öffnen (F16) |

- Die TS-Typisierung liegt in `types.ts` im `declare global { interface Window { electron: … } }`. **Neue IPC-Funktionen immer an drei Stellen ergänzen: `main.cjs` (Handler), `preload.cjs` (Bridge), `types.ts` (Typ).**
- `checkIntegrity` ist als `(basePath, files, onlySubset?)` typisiert (F9); der frühere `@ts-ignore` ist entfernt.

---

## 12. UI-Struktur (App.tsx, Zeilen ~1313 ff.)

- **StartupScreen** solange `!isInitialized`.
- **Webview-Bereich** oben (`https://photos.google.com`, `allowpopups`). Overlays:
  - Download-Fortschrittsbalken (links oben, bis 5 gleichzeitig). **F11:** Während des Wartens auf `download-started` zeigt dieselbe Karte (stabiler Key `job:<id>`) „Warte auf Download…“, einen Sekunden-Timer und klein „max. 45 s“ (bzw. „ohne Limit“ beim Einzeldownload); beim Start wechselt sie in-place zum Fortschritt (kein Positionssprung, konstante Kartenhöhe durch reservierte Fußzeile). **F12:** feste Slots 1–5 (`slot` am Progress-Eintrag, oberster freier Slot); fertige Downloads hinterlassen unsichtbare Lücken, Karten rutschen nicht nach.
  - Status-Infos im Header „Neue Dateien“ (unten rechts): Spinner = Backup läuft (`isWalking`), „Aktive Downloads: x/5“ (bei laufendem Backup oder aktiven Einzeldownloads). Kein Overlay oben rechts mehr.
- **Untere Leiste (h-64):**
  - Links: Status, Scan-Historie-Button, **„🛠️ Prüfung & Korrekturen“** (einziger Einstieg; startet beim Öffnen automatisch den Struktur-Check (F26); rot/pulsierend bei Problemen, Badge = Summe der fünf Kategorien + „+n Dup.“ bei Duplikaten), CSV-Export, Reset, Logout, Start/Stop, „⬇ 1“. Entfernt: „🔎 Datenbank prüfen“ + Duplikat-Banner (F22) und „✨ Dateinamen bereinigen“ (F24, läuft jetzt automatisch beim Struktur-Check).
  - Mitte: Log-Fenster (nur relevante Meldungen, max. 300 Einträge, Button „Logs“ öffnet Ordner).
  - Rechts: Liste „Neue Dateien“ (max. letzte 100, Web vs. Original-Datum, ✔/⚠).
- **Log-Filterung** (`addLog`): Alles geht an Konsole/Logdatei, aber die UI zeigt nur `error/success/warning/album` sowie Meldungen mit Schlüsselwörtern (Backup, Datenbank, Bereinigung, Status, Web, Bereits, Bekannt, vermisst, Warte, Umbenannt, Verschoben, Metadaten, Tageswechsel, Scan-Log). Debug nur Konsole – **Ausnahme (F18):** Debug-Meldungen mit einem Muster aus `DEBUG_UI_KEYWORDS` (`Panel-Wait-Timeout`, `Bekannt:`) erscheinen zusätzlich im UI-Fenster (kursiv/grau), die Logdatei bleibt `[debug]`.
- **`isResettingRef`** blockiert während Reset alle State-/IPC-Updates.
- **Reset** setzt sämtliche States/Refs zurück (dbRef, processedIds, Progress, Modals, Album-Refs) und zeigt wieder den StartupScreen.
- **Logout** (`clearCacheAndLogout`): `clearSessionCache()` + Navigation zu `https://accounts.google.com/Logout`.

---

## 13. Logging & Dateien auf der Platte

| Artefakt | Ort | Details |
|---|---|---|
| Datenbank | `<Zielordner>/gphotos_db.json` | siehe Abschnitt 6 |
| DB-Backups | `<Zielordner>/Backups/gphotos_db_<stamp>.json` | max. 20, min. 10 min Abstand |
| Logs | `<Zielordner>/Logs/backup-YYYY-MM-DD.log` | Tagesrotation; vor DB-Load: `app.getPath('userData')/Logs` |
| CSV-Export | `<Zielordner>/gphotos_export_YYYY-MM-DD.csv` | UTF-8 BOM, Semikolon |
| Fotos/Videos | `<Zielordner>/<YYYY>/<MM>/` | Album: `<Zielordner>/Alben/<Name>/` flach |
| Build | `dist/`, `release/` | ignoriert von Git |

- `appendLog` schreibt fehlertolerant (try/catch, bricht nie den Ablauf ab).
- `main.cjs` loggt zusätzlich jeden Download-Start/-Abschluss mit Hash-Präfixen.

---

## 14. Legacy / tote Pfade / bekannte Fallstricke

Diese Punkte sind bewusst dokumentiert, damit Agenten sie nicht für funktionierenden Code halten:

1. **Toter Code wurde in Cleanup-Phase 1 entfernt:** `services/googlePhotosService.ts` (Library-API), IPC `google-api-request` + `create-directory`, `deleteOrphansFromDisk`, `determineAlbumName`, `formatDateForExif`, `blobToDataURL`, `dataURLtoBlob`, `AppState`, `GooglePhotoAlbum`, `GoogleMediaItem`, `foundInSidePanel`, unbenutzte Imports, `public/index.css`, `metadata.json`. Nicht wieder einführen. **Ausnahme:** `panelSignature` wurde in F1 bewusst wieder eingebaut und ist jetzt aktiv (Abschnitt 9.1).
2. **`scannedRanges`** ist Legacy (Root-Feld). Nur noch für Migration/Bereinigung relevant.
3. **Doppelte Valid-Key-Listen** für die Legacy-Bereinigung (App.tsx + ActionModals.tsx) – synchron halten!
4. **`basePath` wird beim Speichern auf `"."` gesetzt** – der echte Basispfad kommt beim Laden aus dem Dateipfad. Nicht „korrigieren“, das ist Absicht (portable DB).
5. **`index.html`** lädt eine Importmap mit React 19 von esm.sh, obwohl package.json React 18 nutzt; Vite bundelt ohnehin. Harmlos, aber nicht als Vorbild nehmen.
6. **Tailwind läuft über CDN** (`cdn.tailwindcss.com`) – die App braucht Internetzugang zum Laden der UI-Styles (Webview braucht das ohnehin).
7. **`.env.local`** enthält nur einen ungenutzten `GEMINI_API_KEY`-Platzhalter. Keine Secrets im Repo anlegen.
8. **Windows-only-Annahmen:** hartkodierte `\\`-Pfade (Alben), PowerShell für CreationTime, Backslash-/Separator-Erkennung über `includes('\\')`.
9. **Extension-Listen müssen synchron bleiben:** JPG-Erkennung `.jpg/.jpeg`; Video-Erkennung `.mp4 .mov .m4v .avi .3gp .mpg .mts`. Sie existieren mehrfach (main.cjs Download + move, App.tsx Anzeige-Typ). Bei neuen Formaten alle Stellen prüfen.
10. **Der Crawler hängt an der Google-Photos-Web-DOM.** Änderungen an Google (aria-labels, Tastenkürzel Shift+D / i / Pfeiltasten, Panel-Layout >70 % Viewportbreite) können den Scraper brechen. `extractCurrentImageInfo` ist die zentrale Stelle.
11. **Kein automatisches Timeout für den gesamten Download** – Start-Timeout **45 s** im Haupt-Backup (F10), Einzeldownload **ohne Limit** (F10b), 3-s-Timeout beim Scraping. Hängende Downloads können die 5-Slot-Grenze blockieren.
12. **DB wird bei Download-Complete nur im Speicher aktualisiert**, persistiert erst durch nachfolgendes `saveDatabase()` (Download-Checkpoint alle 25 / Tageswechsel / Stop / Session-Ende). Ein harter Absturz kann bis zu 24 Downloads verlieren (dafür gibt es die Backups alle 10 min).

### 14.1 Bekannte offene Logikfehler (Review-Liste, werden in Phase 2 einzeln abgearbeitet)

| # | Prio | Problem | Ort |
|---|---|---|---|
| A1 | kritisch | ~~Download-Slot-Leak: Bei `download-started`-Timeout wird trotzdem `activeDownloadsRef++` + `processedIdsRef.add()` ausgeführt~~ **behoben in F3**: Resolver liefert `boolean`; nur bei echtem Start wird der Slot belegt. Timeout-Fälle landen seit F10 zusätzlich in `skippedDownloads` (Korrektur-Modal) – kein automatischer Retry, aber Einzeldownload/„🌐 Web öffnen“ | App.tsx `initiateDownloadAsync` |
| A2 | kritisch | ~~Endlosschleife im `catch` der Backup-Schleife: fehlendes `break`, wenn `navigateAndVerifyChange` nach einer Exception scheitert~~ **behoben in F4**: bei fehlgeschlagener Navigation bricht der `catch` mit eindeutiger Meldung ab | App.tsx `runBackupSession` |
| A3 | mittel | ~~Trust-Detektor: `matchesOwn` prüft nur `entry.originalDate` → Minuten-Bursts dauerhaft `trusted=false`~~ **behoben in F1** (Panel-Refresh-Wait, `entry.timestamp`-Fallback, Kaskaden-Fix, harte Namenssperre). Offen bleibt die Datenpflege der bereits korrupten `originalName`-Altfälle (s. Analyse) | App.tsx `evaluateScrapeTrust` |
| A4 | mittel | ~~Namenskollisions-Race: `(n)`-Prüfung via `existsSync` vor physischer Dateierstellung; parallele Gleichnamige können denselben Zielpfad erhalten → Overwrite~~ **behoben in F5**: `reservedTargetPaths`-Set reserviert Zielpfade bis zum Download-Ende | main.cjs `will-download` |
| A5 | klein | ~~`deleteFile`-Rückgabewert in Korrektur-Pfaden wird ignoriert~~ **behoben in F7**: DB-Reset nur bei erfolgreichem physischem Löschen, sonst Warnlog | App.tsx `handleRemoveCorruptFile`/`executeDeleteAllCorrupt` |
| A6 | klein | ~~`dbFilePath` wird in die DB-JSON persistiert~~ **behoben in F8**: wird beim Speichern (auch bei Hash-Migration) entfernt | App.tsx `saveDatabase` |
| A7 | klein | Legacy-Zähler prüft `files['scannedRanges']` (existiert nie – Root-Feld), Root-Legacy wird nie gezählt | ActionModals.tsx `runStructureCheck` |
| A8 | klein | ~~`checkIntegrity`-Typ deklariert `(basePath, files)`, Aufruf mit `onlySubset` via `@ts-ignore`~~ **behoben in F9**: Typ um `onlySubset?: boolean` ergänzt, `@ts-ignore` entfernt | types.ts / ActionModals.tsx |
| A9 | klein | „Neuen Ordner wählen“ bei existierender DB warnt nur per Log; startet man, werden alle Dateien neu geladen (Kollisions-Kopien) | App.tsx `handleInitNewDatabase` |
| A10 | klein | ~~`handleShowFileInExplorer` → `onShowInFolder`-Prop ist tote Kette (CorrectionModal nutzt sie nie)~~ **behoben in F16**: „📂 Explorer“ und „🖼️ Anzeigen“ sind in den Sektionen Defekt und OnlineMissing verdrahtet; neuer IPC `open-file` (Standard-Viewer) | App.tsx / ActionModals.tsx |
| K4 | mittel | ~~Duplikat-Lösch-/Re-Download-Zyklus durch Dateinamen-Heuristik bei gleichnamigen Google-Fotos~~ **behoben in F6**: nur Hash-Duplikate; Online-Einträge werden nie gelöscht | main.cjs `check-db-integrity`, databaseUtils `resolveDuplicatesOnDisk` |
| K5 | kritisch | ~~Ein-Schritt-Lag: Panel-Refresh-Wait akzeptierte das Vorgängerfoto als „refreshed" (nur Signaturänderung geprüft) → jedes Foto bekam das Google-Datum des Vorgängers; Lag perpetuierte sich; `trusted=true` schrieb Falschdaten in EXIF/FS/DB~~ **behoben in F1.3/F1.4**: Namens-Anker + Resync (mit URL-Verifikation) + Session-Abbruch bei nicht behebbarem Desync; deterministischer Start per `loadURL` + Panel-Öffnungs-Check (der F1.3-Nudge erwies sich als Sackgasse und wurde entfernt). **Zusatzursache gefunden/behoben:** Der F1.2-Teilscan über den gecachten Panel-Container lieferte veraltete Panel-Inhalte (sichtbarer Panel war aktuell) → F1.2-Teilscan zurückgebaut, Vollscan wieder aktiv; `pendingInfo` bleibt. | App.tsx `waitForPanelRefresh`, `navigateAndVerifyChange`, `runBackupSession`, crawlerActions `extractCurrentImageInfo` |
| F10 | mittel | ~~Große Videos: Google feuert `will-download` erst 11–32 s nach Shift+D; der 15-s-Timeout brach zu früh ab → verfrühte Timeout-Warnungen und (nach früher Folge-Config) Risiko falscher Zuordnung~~ **behoben in F10**: Start-Timeout 45 s; Timeout-Fälle werden in `skippedDownloads` geführt (Korrektur-Modal, „🌐 Web öffnen“, „✖ Ignorieren“); `cancel-pending-download` entwertet die Config; späte Starts werden per `preventDefault` verworfen; Einzeldownload ohne Limit (F10b). Stop wartet bewusst den 45-s-Timeout ab. | App.tsx, main.cjs |
| F17 | mittel | Wiederhergestellte Dateien blieben in „Korrekturen → Vermisste Dateien“ stehen: `onDownloadComplete` ersetzt den DB-Eintrag (Flag weg), aktualisierte aber den `orphans`-State nicht; der Struktur-Check rief `updateOrphansList()` nur bei neuen Missing-Einträgen auf und löschte `missingSince` nie für wieder vorhandene Dateien. **Behoben in F17**: Flags vor dem Überschreiben merken + Listen-Refresh; Struktur-Check heilt `missingSince` selbst und aktualisiert die Liste immer. | App.tsx `onDownloadComplete`/`handleIntegrityCheckDone` |
| F20 | mittel | Einzeldownloads wurden nicht sofort persistiert; nach Reload kam ein bereits geheilter `missingSince`-Stand zurück. Zusätzlich erzwang `handleSingleDownload` bei gesetztem `missingSince` einen Download ohne Existenzprüfung → `(1)`-Kopie, obwohl die Datei existierte. **Behoben in F20**: Speichern bei `wasSkipped/wasMissing/wasOnlineMissing` oder manuellem Einzeldownload; Existenzprüfung immer, stale Flag wird ohne Download zurückgesetzt. | App.tsx `onDownloadComplete`/`handleSingleDownload` |
| F21 | mittel | Verwaiste Dateien (auf der Platte, in keinem DB-Eintrag – z. B. `(1)`-Kollisionsreste) wurden von Struktur-Check/Namensbereinigung nie erkannt, weil beide nur DB-Einträge betrachten. **Behoben in F21**: `check-db-integrity` scannt `<YYYY>/<MM>` nach untracked Dateien, vergleicht Hashes („Duplikat von …“) und zeigt sie im Integrity-Modal mit Explorer/Anzeigen/Löschen. | main.cjs `check-db-integrity`, ActionModals.tsx |
| F22 | klein | Strukturbericht und Korrekturen waren zwei getrennte Fenster (plus separater „Datenbank prüfen“-Button und Duplikat-Banner) – redundante Einstiege, gestapelte Sektionen. **Behoben in F22**: ein Fenster „🛠️ Prüfung & Korrekturen“ mit fünf Tabs (Vermisst/Defekt/Übersprungen/Online/Verwaist), Prüf-Aktionen + Duplikate/Veraltet in Kopf-/Statuszeile; `IntegrityReportModal` entfernt. | ActionModals.tsx, App.tsx |
| F23 | mittel | Kollisionsrest `(1)` wurde nicht aufgelöst: DB zeigte auf `Name (1).ext`, Basisdatei lag untracked vor; „Dateinamen bereinigen“ übersprang den Fall als `collisionPair` (kein Hash-Vergleich, kein Löschen). **Behoben in F23**: Untracked-Scan erkennt die Richtung (`trackedDuplicate`); Struktur-Check löst hash-identische Paare automatisch auf (DB auf Basisname, `(1)` löschen; umgekehrt untracked `(1)` löschen); Namensbereinigung erhält `resolveDuplicate`-Kandidaten mit Hash-Gate. | main.cjs `check-db-integrity`/`find-renamable-files`, App.tsx |
| F24 | klein | Dateinamen-Prüfung war ein separater Button/Modal-Ablauf mit manuellen Umbenennungen; die Ergebnisse waren nur Summen. **Behoben in F24**: läuft automatisch beim Struktur-Check, sichere Umbenennungen + Duplikate werden automatisch angewandt; sechster Info-Tab „Dateinamen“ listet Einzelzeilen (protected/noName/nameMismatch/collision, read-only); Button und RenameModal entfernt. | main.cjs `find-renamable-files`, App.tsx, ActionModals.tsx |
| F26 | klein | Korrektur-UI uneinheitlich (unterschiedliche Leerzustände, manueller „Struktur prüfen“-Button, zwei Inhalt-Prüf-Buttons, redundante Auto-Kacheln). **Behoben in F26**: Modal startet den Struktur-Check automatisch beim Öffnen; ein „Inhalt prüfen“-Button mit Auswahl-Dialog (vollständig/offen + Erklärung); einheitlicher Tab-Aufbau (Kopfzeile + Erklärungsbox immer sichtbar, `TabEmpty`); Dateinamen-Tab ohne Auto-Kacheln; Auto-Banner nach Duplikat-/Umbenennungs-Aktionen (8 s). | ActionModals.tsx, App.tsx |
| F27 | klein | Im Tab „Online nicht gefunden“ fehlte ein Einzel-Löschen; „Web öffnen“ wirkte verfügbar, obwohl das Foto online meist gelöscht ist. **Behoben in F27**: pro Zeile „🗑 Löschen“ (Datei + DB-Eintrag, geteilter Helfer `deleteOnlineMissingEntry`); „🌐 Web öffnen“ ausgegraut, aber weiterhin klickbar. | App.tsx, ActionModals.tsx |

---

## 15. Konventionen & Arbeitsanweisungen für Agenten

1. **AGENTS.md aktualisieren bei jeder Änderung** (siehe Kopf). Betroffene Abschnitte anpassen, keine widersprüchlichen Angaben stehen lassen.
2. **Sprache:** UI-Texte und Logs auf Deutsch; Code-Bezeichner Englisch. Bestehenden Stil nachahmen.
3. **Keine neuen Abhängigkeiten**, wenn es ohne geht. Wenn doch, `package.json` anpassen und hier dokumentieren. Browser-only-Libs im Renderer vermeiden (Node-Zugriff nur über IPC).
4. **Sicherheit:** `contextIsolation: true`, `nodeIntegration: false`, `sandbox: false`, `webviewTag: true` sind gesetzt. Keine Secrets/Telemetrie/Netzwerkaufrufe hinzufügen (außer Google Photos im Webview).
5. **Hash-Gate nie umgehen.** Jegliche Datei-Mutation (Move/Rename/Rewrite) muss `expectedHash` berücksichtigen, sonst gehen Daten verloren.
6. **DB-Schema-Erweiterungen** erfordern: `types.ts` (`DatabaseEntry`/`FileDatabase`), beide Valid-Key-Listen (Abschnitt 8.6), ggf. CSV-Spalten, ggf. Migration + `hashScheme`-Erhöhung, und diesen AGENTS.md-Abschnitt.
7. **Neue IPC-Funktionen** an drei Stellen ergänzen (main.cjs, preload.cjs, types.ts) und in Abschnitt 11 dokumentieren.
8. **CommonJS-Beibehaltung** in `main.cjs`/`preload.cjs`.
9. **Vor Abschluss einer Aufgabe:** `npm run build` ausführen (TypeScript-Check). Bei UI-/Ablaufsänderungen zusätzlich manuell per `npm run electron:dev` testen, sofern möglich.
10. **Git:** Nicht committen/pushen, außer der Nutzer fordert es ausdrücklich. Commits auf Deutsch/Englisch gemischt üblich (Präfixe `feat:`, `fix:`, `docs:`, `chore:`).

---

## 16. Glossar

| Begriff | Bedeutung |
|---|---|
| **webDate** | Aufnahmedatum, das aus der Google-Photos-Sidebar gescraped wird; bestimmt den Zielordner |
| **finalDate** | Tatsächlich geschriebenes Datum (Web-Datum, ggf. mit Sekunden aus EXIF) |
| **sourceHash** | SHA-256 des Rohdownloads vor Metadaten-Rewrite (stabil) |
| **hash** | SHA-256 der Datei auf der Platte nach Rewrite (änderbar durch Korrekturen) |
| **trusted** | Metadaten-Scrape gilt als verlässlich; sonst keine Rewrites/Korrekturen |
| **Orphan / vermisst** | DB-Eintrag mit `missingSince`, Datei fehlt lokal |
| **onlineMissing** | DB-Eintrag mit `onlineMissingSince`: Datei lokal vorhanden, aber online im Scan nicht gesehen |
| **corrupt** | Datei mit 0 Bytes oder Lesefehler (`integrityStatus === 'corrupt'`) |
| **Backup-Loop** | Der parallele Crawler-Loop (max. 5 gleichzeitige Downloads) |
| **Download-Checkpoint** | Nach je 25 erfolgreichen Haupt-Backup-Downloads wird die DB gespeichert (F15) |
| **scannedDays** | `YYYY-MM-DD` → Scan-Zeitpunkt; Grundlage der Heatmap und Orphan-Prüfung |
| **Übersprungen / skippedDownloads** | Foto mit Download-Start-Timeout (45 s); Key = Google-ID, gelistet im Korrektur-Modal (F10) |
| **Hash-Gate** | Pflicht-Hash-Vergleich vor Datei-Mutation |
| **Stale Panel** | Sidebar zeigt verzögert noch Daten des vorherigen Fotos |

---

## 17. Kurz-Checkliste für typische Aufgaben

- **Neues Feature in der Backup-Schleife:** `App.tsx` (`runBackupSession`), ggf. `logic/crawlerActions.ts`; Parallelitäts-/Download-Checkpoint-Mechanik beachten; Log via `addLog`; AGENTS.md Abschnitt 4/12.
- **Neuer Metadaten-Typ:** Main-Prozess (Download-`done`-Handler + `move-and-update-file`), Extension-Listen, `DownloadResult`/`DatabaseEntry`-Typen, AGENTS.md Abschnitt 5/7.
- **Neue Wartungs-/Prüffunktion:** Handler in `main.cjs`, Bridge + Typ, Modal in `components/ActionModals.tsx`, Einbindung in App.tsx, AGENTS.md Abschnitt 8.
- **DB-Feld:** siehe Konvention 6.
- **Crawler-Anpassung (Google-DOM):** `logic/crawlerActions.ts` + `utils/exifUtils.ts` (Datumsformat), Trust-Detektor in App.tsx prüfen; AGENTS.md Abschnitt 9/14.11.
