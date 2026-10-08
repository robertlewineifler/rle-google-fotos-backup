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
- Alles bleibt lokal: **keine Cloud, keine Telemetrie, keine externen Server** (einzige Ausnahme: photos.google.com im Webview und Tailwind-CDN im index.html).

**Grundprinzip:** Der Download-Mechanismus ist ausschließlich der **Webview-Crawler + Electron-`will-download`-Interception**. Ein früherer Google-Photos-Library-API-Ansatz wurde beim Cleanup (Phase 1) vollständig entfernt (Datei `services/googlePhotosService.ts`, IPC-Kanal `google-api-request`). Nicht wieder einführen.

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

```bash
npm install

npm run dev            # nur Vite-Dev-Server auf Port 5273 (strictPort)
npm run electron:dev   # Vite + Electron parallel (concurrently -k) -> Entwicklungsmodus
npm run build          # tsc (nur Typecheck, noEmit) && vite build -> dist/
npm run electron:build # npm run build && electron-builder --win -> release/
```

- **Verifikation nach Änderungen:** mindestens `npm run build` (TypeScript-Typecheck + Bundle). Es gibt keinen Linter und keine Tests.
- `DEV starten.bat` startet `npm run electron:dev` **als Administrator** (UAC-Prompt) – nötig für Webview/Download-Flow.
- `vite.config.ts`: `base: './'` (wichtig für Electron-Dateipfade), Build nach `dist/`.
- `tsconfig.json`: strict, `jsx: react-jsx`, `noEmit`. `webview`-JSX und `piexifjs` sind in `declarations.d.ts` als `any` deklariert.

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
components/ActionModals.tsx      CorrectionModal („Prüfung & Korrekturen“, 7 Tabs), AlbumDownloadModal
components/ScanHeatmap.tsx       Scan-Historie-Heatmap (4 Ansichtsmodi)
public/icon.ico, assets/icon.png Icons (Packaging/UI)
.env.local                   Platzhalter GEMINI_API_KEY (ungenutzt, nicht verwenden)
dist/, release/              Build-Artefakte (via .gitignore ausgeschlossen)
```

**Wichtig:** `main.cjs` und `preload.cjs` sind **CommonJS** (package.json hat `"type": "module"`!). Dürfen nicht auf ESM umgestellt werden. Das Frontend ist ESM/TSX.

---

## 4. End-to-End Workflow

### 4.1 Start
1. `StartupScreen` erscheint (Haupt-UI erst nach `isInitialized`).
2. **„Vorhandene .json laden“** → `select-database-file` → DB laden, `basePath` aus Dateipfad ableiten.
   - Bei `hashScheme !== 2` läuft eine **einmalige Migration**: alter `hash` → `sourceHash`, `hash` gelöscht, `hashScheme = 2`, sofort gespeichert (davor Force-Backup).
   - `scannedDays`/`skippedDownloads` werden initialisiert, falls altes Format.
3. **„Neuen Ordner wählen“** → `select-directory` → DB-Struktur im Speicher, Pfad `<Ordner>/gphotos_db.json`. Existiert die Datei schon, wird nur gewarnt (nichts überschrieben).

### 4.2 Backup starten
1. Nutzer meldet sich im Webview an und öffnet ein beliebiges Foto (`/photo/<id>`-URL ist Pflicht).
2. „▶ Start Backup“ prüft die URL:
   - `/search/` → **blockiert** (Suche deaktiviert, um Duplikate zu vermeiden).
   - `/album/` oder `/share/` → öffnet den **AlbumDownloadModal**.
   - sonst: `/photo/` muss enthalten sein, sonst Fehler „Bitte öffne zuerst ein Bild!“.
3. `runBackupSession(false)` startet den Loop:
   - **Tages-Backup:** Vor dem ersten Scan des Kalendertags wird (nur Haupt-Backup) einmalig ein DB-Backup erstellt, falls für heute noch keins existiert (`backupDatabase('daily', 'Tagesstart')`). Album-Modus: kein Backup.
   - **Deterministischer Start:** Aktuelles Foto per `loadURL` neu laden, ~1,2 s warten, Panel-Öffnungs-Check (max. 3 Runden; bei `null`-Scrape **nicht** togglen), dann initiale Panel-Stabilisierung (2 s). Der Full-Reload ist bewusst (frisches Panel, verhindert Stale-Panel-Fehler) und verursacht den sichtbaren kurzen „Flicker“ beim Start. Album-Modus: nur `toggleInfoPanel` + 1 s.
   - Schleifenbedingung: `isWalkingRef.current === true`.
   - **Parallelitätsgrenze:** max. 5 aktive Downloads (`activeDownloadsRef >= 5` → 500 ms warten).
   - **Download-Checkpoint:** Nach je **25 erfolgreichen Downloads** (nur Haupt-Backup) wird die DB gespeichert (`downloadsSinceSaveRef`). Album-Modus: kein Checkpoint.
4. Pro Iteration:
   a. `safeExtractInfo()` (3-s-Timeout) liest Bild-ID (URL) + Sidepanel-Text (Datum + evtl. Dateiname). Bis zu 5 Versuche à 500 ms, wenn kein valides Datum.
   b. Datum via `parseGoogleDateString(webDate)`; bei NaN: Diagnose-Log, einmaliger `scrollSidePanelToBottom` + Re-Scrape, dann `navigatePrevious` + `navigateNext` + `killVideoPlayers` + Reload-Versuche; nach 3 Fehlern in Folge wird das Bild übersprungen. Schlägt auch die Navigation fehl (2 Wiederholungen), Abbruch mit „Session beendet: Element `<id>` blockiert die Navigation“.
   c. **Tageswechsel:** ändert sich `getIsoDateString(webDate)` gegenüber `lastDayIdentifier`, wird der **vorherige, volle Tag** in `scannedDays[YYYY-MM-DD] = Date.now()` eingetragen (Start-Tag der Session wird ausgelassen, evtl. unvollständig). **Direkt danach** prüft `checkMissingForDay(dayIso)` den fertigen Tag, erst dann wird gespeichert.
   d. `updateRangeTracking(webTimestamp)`; `sessionSeenIds.add(id)`.
   e. **Download-Entscheidung (nur Haupt-Backup):**
      - ID unbekannt → Download.
      - ID bekannt, Datei fehlt physisch (`check-file-exists`) → Download + Warnlog.
      - ID bekannt, Datei existiert → **kein Download**, aber Metadaten-Abgleich:
        * `missingSince`/`onlineMissingSince` löschen (wieder gefunden/online).
        * `originalName` aus Panel-Filename aktualisieren (nur wenn „trusted“, Abschnitt 9) – **auch wenn** der Panel-Name (case-insensitiv) dem Dateinamen entspricht (Altwert kann aus der Stale-Panel-Ära stammen).
        * Weicht `entry.timestamp` um > 60 s vom Web-Datum ab → `moveAndUpdateFile` – **nur mit Hash-Gate** (6.3). Ohne gespeicherten Hash wird dieser nachgetragen und die Korrektur auf den nächsten Lauf verschoben.
        * `scannedAt = Date.now()`.
   f. **Download anstoßen** (`initiateDownloadAsync`): `prepareDownload(config)` → `triggerDownloadKeys` (Shift+D) → blockierend auf `download-started` warten (max. **45 s**). Nur bei echtem Start: `activeDownloads`++ + ID in `processedIdsRef`. Bei Timeout: Warnlog, Eintrag in `db.skippedDownloads[id]`, `cancelPendingDownload`, **kein** Slot/`processedIds`; späte Downloads werden im Main verworfen. Einzeldownload: `startTimeoutMs = null` → **kein Limit**. Während des Wartens zeigt das Overlay die Wartekarte.
   g. **Navigation:** `navigateNext` + `killVideoPlayers`, bis zu 30× à 200 ms auf URL-ID-Wechsel prüfen (`navigateAndVerifyChange`). Danach `waitForPanelRefresh` (150 ms-Poll, max. 3 s) auf den Panel-Wechsel. Bei Nicht-Erfolg bis zu 2 Resyncs (prev/next); bleibt es stale → Session-Abbruch (Abschnitt 9.1). Kein ID-Wechsel nach 6 s → Loop bricht ab (vermutlich Bibliotheksende).
5. Nach dem Loop: auf alle aktiven Downloads warten.
6. `finishBackupSession()` (nur Haupt-Backup): DB speichern + Log „Backup-Vorgang beendet.“ **Keine** Missing-Sammel-Prüfung (die läuft pro Tag, s. 8.9).
7. „⏹ Stop“ setzt `isWalkingRef=false` und speichert sicherheitshalber. Ein offener Start-Wartevorgang läuft noch bis Start oder 45-s-Timeout zu Ende; Reset/Logout brechen sofort ab (ohne Warnlog).

### 4.3 Einzel-Download („⬇ 1“)
- Nur wenn nicht `isWalking`, Zielordner vorhanden und URL-Kontext nicht Suche/Album/Share.
- Liest Metadaten (ggf. Infopanel-Toggle), prüft DB + physische Existenz, lädt sonst einzeln. **Trusted ist hier immer `true`** (kein Stale-Panel-Detektor).
- Die physische Existenz wird **immer** geprüft (auch bei `missingSince`). Existiert die Datei, wird kein Download erzwungen; ein stale `missingSince` wird gelöscht, Listen aktualisiert, sofort gespeichert (verhindert `(1)`-Kopien durch veraltete Flags).
- Wartet **ohne Zeitlimit** auf den Start; davor werden offene frühere Einzel-Starts verworfen (`discardPendingStarts`).
- Kein Album-/Scan-Tracking.

### 4.4 Download-Ergebnis (Frontend `onDownloadComplete`)
- Bei Erfolg wird die ID aus `skippedDownloads` entfernt. Die DB wird sofort gespeichert, wenn `wasSkipped || wasMissing || wasOnlineMissing || !isWalkingRef.current` (Skip-/Orphan-Auflösung oder manueller Einzeldownload); sonst gelten die regulären Speicherpunkte.
- Vor dem Überschreiben werden `missingSince`/`onlineMissingSince` gemerkt; danach `updateOrphansList()`/`updateOnlineMissingList()` (wiederhergestellte Dateien verschwinden sofort aus den Listen).
- `saveDatabase` liest den DB-Pfad aus `dbFilePathRef` (nicht aus dem State) – wichtig für Callback-Closures des ersten Renders.
- Haupt-Backup-Eintrag: `filename`, `originalName`, `timestamp` (finales Datum), `savedAt`, `downloadedAt`, `scannedAt`, `originalDate`, `hash`, `sourceHash`. **`integrityStatus` wird absichtlich NICHT gesetzt** → Datei gilt als „ungeprüft“.
- Album-Modus: **kein DB-Eintrag**, nur Log + „Neue Dateien“-Liste.
- Vergleich Web-Datum ↔ Original-EXIF: Abweichung > 60 s → UI-Status „Manuell“ (⚠) + Warn-Log; sonst „OK“ (✔).
- `activeProgress` wird pro `progressFilename`/`filename` entfernt, `activeDownloadsCount` dekrementiert.

---

## 5. Download-Pipeline im Main-Prozess (`main.cjs`)

### 5.1 `will-download`-Handler
- Reagiert nur, wenn `nextDownloadConfig.active === true` (via `prepare-download`). Ungeplante/verspätete Downloads werden **verworfen** (`event.preventDefault()`, kein Speichern-Dialog/Tracking) und geloggt.
- `nextDownloadConfig` ist ein **globaler Singleton**; deshalb wartet das Frontend blockierend auf Start/Timeout, bevor die nächste ID vorbereitet wird. `cancel-pending-download` entwertet die Config bei Timeout/Reset/Logout.
- `download-started` wird **nach** dem Sanitizing gesendet (id + finaler Dateiname), damit die Wartekarte in-place zur Fortschrittskarte wird.
- Pfade: Normal `<targetDir>/<YYYY>/<MM>/`; Album (`flatStructure`) direkt `<targetDir>/`.
- **Dateinamen-Sanitizing:**
  - Endung case-insensitiv abtrennen, in Kleinbuchstaben normalisieren (`.MP4` → `.mp4`).
  - **Doppelte Endungen entfernen** (Google liefert z. B. `IMG_3181.JPG.jpg` → `IMG_3181.jpg`).
  - Basisname auf **100 Zeichen** kürzen.
  - Kollisionen: `Name (1).ext`, `Name (2).ext`, … über `fs.existsSync` **und** `reservedTargetPaths`-Set. Das Set reserviert Zielpfade, solange der Download läuft (Datei entsteht erst nach `setSavePath`), und wird im `done`-Handler freigegeben → parallele Gleichnamige überschreiben sich nicht. Auch die ZIP-Extraktion reserviert.
- Logs: Download-Start (id/Datei/Ordner/Web-Datum/trusted); Abschluss mit Source-/File-Hash-Präfix.

### 5.2 ZIP-Handling (Live Photos)
- Nur bei `.zip`: `adm-zip` sucht den ersten Eintrag (kein Ordner, kein `__macosx`) mit `.jpg`/`.jpeg`.
- Bild entpacken, Kollisionen `(n)`, ZIP löschen (best effort), `savePath`/`finalFilename`/`ext` umstellen. Der extrahierte Bildname bekommt **immer** eine kleingeschriebene Endung.
- Fehler beim Entpacken: Download gilt trotzdem als erfolgreich, ZIP bleibt liegen.

### 5.3 Metadaten
1. **sourceHash** = SHA-256 der rohen Datei **vor** jedem Rewrite (stabiler Quell-Fingerprint).
2. Original-Datum lesen: **JPEG** `piexif.load` (bevorzugt `Exif.DateTimeOriginal` 36867, sonst `0th.DateTime` 306); **Video** eigener MVHD-Parser (7.2).
3. **finalDate** = `webDate`; hat `originalDate` dieselbe Minute (`YYYY-MM-DD HH:MM`) wie `webDate`, wird `originalDate` (inkl. Sekunden) übernommen.
4. **Nur wenn `trusted`** (Abschnitt 9): JPEG-EXIF, Video-Atome und FS-Zeitstempel werden geschrieben. Sonst Log „Metadaten-Rewrite übersprungen“, `metadataWritten=false`.
5. **hash** = SHA-256 **nach** dem Rewrite (entspricht der Datei auf der Platte).

### 5.4 Ergebnis-Payload (`download-complete`)
`{ id, success, filename, progressFilename, originalName, path, error, originalExifDate, hash, sourceHash, finalDateTimestamp, metadataWritten }`
- `progressFilename` = Name, unter dem Fortschritt gemeldet wurde (wichtig bei ZIP-Umbenennung).
- Im `finally` wird **immer** geantwortet, damit der Frontend-Slot freigegeben wird.

---

## 6. Datenbank (`gphotos_db.json`)

### 6.1 Struktur (`types.ts` → `FileDatabase`, `DatabaseEntry`)
```jsonc
{
  "basePath": ".",              // wird beim Speichern immer auf "." gesetzt (relativ zur JSON-Datei)
  "lastUpdated": 1234567890,
  "hashScheme": 2,              // 2 = hash/sourceHash getrennt
  "scannedDays": { "2024-05-01": 1714590000000 },
  "skippedDownloads": { "<GooglePhotoId>": { "id": "…", "webTimestamp": 0, "filename": "IMG_1234.jpg", "detectedAt": 0, "mode": "backup|album" } },
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
      "missingSince": 0,                // gesetzt wenn Datei lokal nicht gefunden
      "onlineMissingSince": 0,          // gesetzt wenn online nicht gesehen (Datei lokal vorhanden)
      "integrityStatus": "ok|corrupt",  // undefined = ungeprüft
      "integrityCheckedAt": 0
    }
  }
}
```
- Key der `files`-Map ist die **Google Photo ID** (aus der URL `/photo/<id>`).
- `basePath` ist nur informativ; der echte Basisordner kommt beim Laden aus dem Dateipfad.
- Die UI führt `processedIdsRef = Set(Object.keys(db.files))` (bekannte ID-Menge der Session).
- `skippedDownloads`: Fotos, deren Download-Start nicht innerhalb von 45 s bestätigt wurde. Quelle der Sektion „Übersprungen“; wird bei erfolgreichem Download/„Ignorieren“ entfernt und beim Laden gegen `files` bereinigt (selbstheilend). Einträge besitzen bewusst **keinen** `files`-Eintrag.

### 6.2 Speichern & Backups
- `saveDatabase` ruft IPC `save-database`; dieses schreibt `JSON.stringify(data, null, 2)` — **kein Auto-Backup** (das frühere 10-Minuten-Auto-Backup wurde entfernt).
- **DB-Backups:** IPC `create-db-backup` kopiert nach `<DB-Ordner>/Backups/gphotos_db_<YYYY-MM-DD_HHMMSS>.json` (Kollisionssuffix `_n` bei gleicher Sekunde); max. **20**, älteste werden rotiert. Zwei Modi:
  - `daily` (`backupDatabase('daily', 'Tagesstart')` am Anfang jeder Haupt-Backup-Session): nur, wenn für den heutigen **Kalendertag** noch kein Backup existiert → im Notfall geht höchstens der Fortschritt des aktuellen Kalendertags verloren.
  - `force` (vor irreversiblen Bulk-Aktionen: Duplikate bereinigen, Vermisste-Cleanup, „Alle löschen“ bei Defekt/OnlineMissing/Verwaist, Legacy-Bereinigung, „✨ Dateinamen bereinigen“, Hash-Migration): immer.
  - Wiederherstellung ist **manuell** (Backup-JSON zurück nach `gphotos_db.json` kopieren).
- Speicherpunkte: Integrität/Rename/Korrekturen, **Download-Checkpoint alle 25**, Tageswechsel, Stop, Session-Ende; nicht bei jedem Download-Complete.

### 6.3 Hash-Gate (wichtigstes Sicherheitskonzept)
- `hash` = aktueller Dateiinhalt; `sourceHash` = Rohdownload.
- `move-and-update-file` und `rename-file` akzeptieren `expectedHash`:
  - Mismatch → **kein Schreibzugriff**, Antwort `HASH_MISMATCH` + `actualHash`.
  - Frontend speichert bei Mismatch den tatsächlichen Hash und vertagt die Korrektur auf den nächsten Lauf (keine Endlosschleifen, Schutz vor fremden Dateien).
- Ohne gespeicherten Hash wird zuerst `compute-file-hash` ausgeführt und ebenfalls vertagt.

---

## 7. Metadaten-Korrektur im Detail

### 7.1 JPEG-EXIF (`updateExifData`)
Schreibt `YYYY:MM:DD HH:MM:SS` in `Exif.DateTimeOriginal` (36867), `Exif.DateTimeDigitized` (36868), `0th.DateTime` (306).

### 7.2 MP4/MOV (`readVideoMetadataAsync` / `updateVideoMetadataAsync`)
- Eigener ISO-BMFF-Atom-Parser (async, `fileHandle.read/write`):
  - **Lesen:** `moov` → `mvhd`, 32-/64-Bit-Zeit je Version; Zeitbasis **1904-01-01** (Offset `2082844800` s).
  - **Schreiben:** rekursiv `moov` → `trak` → `mdia`; patcht `mvhd`, `tkhd`, `mdhd` (CreationTime + ModificationTime), Version 0 = 4 Byte, Version 1 = 8 Byte.
- Kein ffmpeg. Unbekannte Container (`.avi`, `.mts`) werden versucht, können aber fehlschlagen.

### 7.3 Dateisystem-Zeitstempel (`updateFileTimestamps`)
- `fs.utimesSync(filePath, date, date)`.
- **Windows-Zusatz:** per `powershell.exe -NoProfile -Command` werden `CreationTime`, `LastWriteTime`, `LastAccessTime` über `Get-Item -LiteralPath` gesetzt (Pfad escaped: `'` → `''`).
- Fehler werden nur geloggt, nie geworfen.

---

## 8. Integritätsprüfung & Wartung

### 8.1 Struktur-Check (IPC `check-db-integrity` / „🔍 Struktur prüfen“)
- Prüft für jede DB-Datei `<basePath>/<YYYY>/<MM>/<filename>` → `missing`.
- Sammelt `sizeUpdates` und berechnet Hashes, falls keiner vorhanden (`updates`). `onlySubset=true` überspringt Hashes für `integrityStatus === 'ok'` mit vorhandenem Hash.
- **Duplikaterkennung ausschließlich hash-basiert** über alle validen Dateien (die frühere Dateinamen-Heuristik wurde entfernt – sie erzeugte Re-Download-Zyklen).
- Ergebnis wird im Frontend in die DB übernommen, `missing` sofort als `missingSince` markiert, dann gespeichert.
- **Selbstheilung:** Einträge mit `missingSince`, die **nicht** in `result.missing` stehen, verlieren das Flag; `updateOrphansList()` läuft danach **immer**.
- **Untracked-Scan:** Die `JJJJ/MM`-Ordner werden nach Dateien durchsucht, die in keinem DB-Eintrag stehen (`untracked`; Alben/Backups/Logs ausgenommen). Für jede Datei wird der SHA-256 berechnet und mit bekannten Hashes verglichen → `duplicateOf` („Duplikat von <Datei>“) bzw. `trackedDuplicate` (Basisdatei, während die DB auf `Name (n).ext` zeigt). Anzeige im Tab „Verwaist“.
- **Auflösung hash-identischer Namenspaare** (nur nach Bestätigung, s. 8.4): DB auf Basisnamen umstellen + `(n)`-Datei löschen bzw. umgekehrt untracked `(n)`-Datei löschen.

### 8.2 Inhalts-Check / Deep Scan (IPC `verify-file-integrity-batch` / „💾 Inhalt prüfen“)
- Chunks von **100** Dateien; pro Datei: `stat` (0 Bytes → `corrupt`), Datei als Read-Stream komplett lesen (I/O-Fehler). `ENOENT` wird ignoriert.
- Auswahl-Dialog („⚡ Nur Ungeprüfte/Defekte“ vs. „🔍 Alles neu scannen“) im Fenster „Prüfung & Korrekturen“; Overlay mit Fortschritt. Ergebnis setzt `integrityStatus` + `integrityCheckedAt` (Silent Save); defekte Dateien im Tab „Defekt“.

### 8.3 Fenster „Prüfung & Korrekturen“ (7 Tabs)
- **Kein Auto-Start:** Öffnen löst **keinen** Check aus. Der **prominente Primär-Button „🔍 Struktur prüfen“** sitzt in der Kopfzeile neben dem sekundären „💾 Inhalt prüfen“ (pulsiert, bis ein Ergebnis vorliegt; weiche Führung). Untertitel: „1. Struktur prüfen → 2. Befunde sichten → 3. bereinigen (mit Bestätigung)“. Der Check ist **rein lesend** (aktualisiert nur DB-Metadaten + Vorschau).
- **Statuszeile:** vor dem ersten Check amber Hinweis, währenddessen Spinner, danach „Struktur geprüft · Befunde in den Tabs · Veraltet n“; rechts nur noch „Veraltete Felder bereinigen (n)“.
- **Einheitlicher Tab-Aufbau:** Kopfzeile (Icon/Name/Anzahl + Unterzeile) + Erklärungsbox, darunter Liste + Aktionen oder `TabEmpty`.
- **Tabs:**
  - **Vermisst:** aus DB löschen, „Status zurücksetzen“, „🌐 Web öffnen“ (`photo/<id>`).
  - **Defekt:** „🗑 Löschen“ entfernt die Datei physisch, DB-Eintrag bleibt (ohne `integrityStatus`/`hash`) → Re-Download; Batch „Alle von Festplatte löschen“; „📂 Explorer“/„🖼️ Anzeigen“.
  - **Übersprungen:** „🌐 Web öffnen“ (danach „⬇ 1“ ohne Limit), „✖ Ignorieren“/„Alle ignorieren“.
  - **Online nicht gefunden:** „🌐 Web öffnen“ (ausgegraut, klickbar), „📂 Explorer“, „🖼️ Anzeigen“, „🗑 Löschen“ (Datei + DB-Eintrag); Batch „Status zurücksetzen (Behalten)“ / „Alle lokal löschen“.
  - **Verwaist:** pro Zeile Explorer/Anzeigen/Löschen; Batch „Alle löschen“. Hash-identische Paare werden nur **vorgemerkt** und über „✨ Dateinamen bereinigen“ entfernt; eindeutige Waisen bleiben zum manuellen Sichten.
  - **Dateinamen:** prominente Statistik-Karte (Headline „Vorgemerkt für Bereinigung“ + Chips; Kacheln Namen mit „(n)“/Geschützt/Kollisionen/Namensabweichung/Ohne Originalname/Datei fehlt). Die vier listenfähigen Kacheln sind **Klick-Toggles** mit je eigener **Lazy-Liste** (erst beim Ausklappen gefiltert/sortiert, alphabetisch, `localeCompare` numeric; „Alle Listen ausblenden“). Button „✨ Dateinamen bereinigen (n)“ direkt neben der Headline.
  - **Duplikate:** **DB-Einträge mit identischem SHA-256** (≠ Verwaist: Dateien ohne DB-Eintrag). Erklärungsbox; pro Gruppe Tabelle mit Dateiname/Ordner/Status und **voraussichtlicher Aktion** (clientseitig berechnet); Button „🗑 Duplikate bereinigen (x Dateien in y Gruppen)“ (`onExecuteDuplicates`, Online-Einträge nie löschen; Force-Backup) – **deaktiviert**, wenn alle Gruppen online sind.
- **Bestätigungsdialog „✨ Dateinamen bereinigen“:** Zusammenfassung + Hinweis „DB-Backup wird erstellt“; Detail-Liste „Altname → Neuname“ erst auf Klick (Lazy, max. 500 Zeilen). Erst „Ausführen“ startet die Bereinigung (Force-Backup → Hash-Gate → Speichern) + Erfolgs-Banner „✅ Bereinigt: …“ (8 s).
- **Force-Backup:** Vor jeder Batch-Löschung/-Bereinigung (s. 6.2) einmalig; Einzel-Löschungen und Status-Resets lösen kein Backup aus.

### 8.4 Dateinamen-Prüfung & Bereinigung (IPC `find-renamable-files`)
- Läuft **rein lesend** am Ende des Struktur-Checks; füllt `renamable.entries/stats` + `cleanupPreview`.
- `(n)`-Kandidaten: `originalName` vorhanden, nicht selbst exakt der aktuelle Name, gleicher Dateistamm (case-insensitiv, deckt `.JPG`/`.jpg`/HEIC→jpg ab), `(n)`-Datei existiert, Zielname frei.
- Basisdatei existiert → Hash-Vergleich: identisch → `resolveDuplicate` (DB auf Basisnamen, `(n)` löschen); unterschiedlich → `collisionPair` (echte Kollision, nichts tun).
- **Endungs-Normalisierung:** doppelte Endungen (`Name.EXT.ext` → `Name.ext`, hash-identischer Zwilling wird mitgelöscht) und großgeschriebene Endungen (`Name.EXT` → `Name.ext`, case-only; `rename-file` nutzt einen Temp-Zwischenschritt). `(n)`-Umbenennungen zielen immer auf kleingeschriebene Endungen. Kandidaten tragen die Flags `doubleExt`/`twinName` bzw. `caseOnlyExt`; `find-renamable-files` liefert `entries` (`RenameCheckEntry`) für alle Kategorien.
- **Ausführung nur nach Bestätigung:** `executeCleanFilenames()` (Force-Backup) führt aus: getrackte `(n)`-Auflösung (DB → Basisname + löschen), verwaiste hash-identische Duplikate löschen (inkl. Zwillinge), dann Umbenennungen — alles mit Hash-Gate. Ergebnis `CleanupSummary` (`renamed`, `doubleExt`, `extLowercased`, `removed`, `failed`).
- Der Tab „Dateinamen“ zeigt als Einzelzeilen nur `protected`, `noName`, `nameMismatch`, `collision`; übrige Kategorien nur als Zähler.

### 8.5 CSV-Export („📄 Excel CSV Export“)
- `<DB-Ordner>/gphotos_export_YYYY-MM-DD.csv`, **UTF-8 mit BOM**, Trennzeichen **Semikolon**, Felder gequotet, sortiert nach `timestamp` absteigend.
- Spalten: ID; Filename; Original Name; Web Date (Readable); Timestamp; Original Date; Hash; Source Hash; Integrity Status; Saved At; Downloaded At; Scanned At; Missing Since; Online Missing Since.

### 8.6 Legacy-Bereinigung („Veraltete Felder bereinigen“)
- Entfernt `scannedRanges` (Root) und alle unbekannten Felder aus `files`-Einträgen. Gültige Keys (synchron halten!):
  `filename, timestamp, originalDate, originalName, savedAt, downloadedAt, scannedAt, hash, sourceHash, missingSince, onlineMissingSince, id, integrityStatus, integrityCheckedAt, size`.
- Die Liste existiert **doppelt**: `App.tsx` (`executeCleanLegacy`) und `components/ActionModals.tsx` (Legacy-Zählung). **Bei Schema-Änderungen beide anpassen!**

### 8.7 Duplikate auflösen (DB-Duplikate)
- `resolveDuplicatesOnDisk` (logic/databaseUtils.ts) arbeitet nur auf Hash-Duplikatgruppen:
  - Online-Einträge (kein `missingSince`/`onlineMissingSince`) werden **nie** gelöscht.
  - Gruppe mit Online-Einträgen → alle Offline-Kopien physisch löschen + aus DB entfernen.
  - Nur Offline-Einträge → der „beste“ bleibt (kürzester Dateiname, bei Gleichstand ältestes `timestamp`), Rest löschen.
  - Gruppen ohne löschbare Einträge werden übersprungen (`skippedOnlineGroups`).

### 8.8 Scan-Heatmap
- `scannedDays` + DB-Dateien als GitHub-Style-Grid pro Kalenderjahr. 4 Modi: Relativ (grün), Absolut (blau), Menge (rot), Größe (gelb). Sonderfälle: gescannt & 0 Fotos = gestreift; Fotos ohne Scan = amber.

### 8.9 Missing-Prüfung pro Tag (`checkMissingForDay`)
- Läuft beim **Tageswechsel** für den soeben fertig gescannten Tag (Start-Tag einer Session wird übersprungen).
- Alle DB-Einträge dieses Tags, die **nicht** in `sessionSeenIds` sind und noch kein Flag haben: Datei fehlt lokal → `missingSince` (Fehlerlog); Datei existiert, online aber nicht gesehen → `onlineMissingSince` (Warnlog). Danach Listen-Refresh + `📅 Missing-Check <Tag>: …`.
- Vorteil: Ein Desync-Abbruch kostet höchstens die Prüfung des aktuellen Tags; fertige Tage sind bereits geprüft.

---

## 9. Trust-/Stale-Panel-Mechanik (wichtig, leicht zu brechen!)

Google Photos aktualisiert das Info-Sidepanel asynchron verzögert beim Navigieren. Dadurch kann der Scraper **Metadaten des Vorgängerfotos** lesen. Zwei Mechanismen: **Panel-Refresh-Wait** (primär) + **Trust-Detektor** (Fallback).

### 9.1 Panel-Refresh-Wait
- `extractCurrentImageInfo` liefert `panelSignature` (Sidebar-Texte + Anzahl + `potentialFilename`; Tags `H4`, `BUTTON`, `A`, `LI`, `TD`, `LABEL`).
- `scrollSidePanelToBottom`: scrollt das größte scrollbare Element rechts (>70 % Viewportbreite) ans Ende (lazy Details). Nur im Fehlerpfad „Datum nicht lesbar“ einmal pro Foto (`panelScrolledRef`).
- `waitForPanelRefresh(prevSignature, timeoutMs=3000)`: pollt alle **150 ms**; „refreshed“ = Signatur ≠ Vorgänger **und** zwei stabile Reads. `prevSignature === null` = nur Stabilität (Erst-Synchronisierung). Respektiert Stop/Reset.
- **Namens-Anker:** Eine Probe gilt als „noch Vorgängerfoto“, wenn ihr `potentialFilename` (case-insensitiv) **exakt** dem Dateinamen **oder** dem gespeicherten Google-Namen (`originalName`) des zuletzt verarbeiteten Fotos entspricht → weiter pollen. Auf den vom Kollisions-Suffix `(n)` befreiten lokalen Namen wird **nur** zurückgegriffen, wenn der Google-Name des Vorgängers unbekannt ist (`prevTrueMetaRef` speichert `originalName`). **Wichtig:** Legitime Google-Namen wie `DB 2025 (970).JPG` dürfen nicht gestrippt mit `DB 2025 (969).JPG` kollidieren – das führte zu falschen Desync-Abbrüchen.
- Nach jeder Navigation (`navigateAndVerifyChange`):
  - Erfolg → `panelRefreshedRef=true` (Trust-Beweis), `panelSyncedRef=true`.
  - **Resync:** bei Nicht-Erfolg bis zu 2× `navigatePrevious` + 400 ms + `navigateNext` + 300 ms + erneuter Wait (mit URL-Verifikation `resyncId === newId`).
  - **Abbruch:** bleibt es stale → `desyncAbortRef=true`, Log `Session beendet: Panel-Desync nicht behebbar (Element <id>) – bitte manuell prüfen.`; DB wird gespeichert; fertige Tage sind bereits per 8.9 geprüft.
  - **Stop-Abgrenzung:** Stop/Reset während des Waits ist **kein** Desync (kein Flag, normaler Ausstieg).
- **Deterministischer Session-Start:** aktuelle Foto-ID merken → `loadURL('…/photo/<id>')` (frisches Panel, bewusster Reload) → 1,2 s → Panel-Öffnungs-Check (max. 3 Runden; bei `null`-Scrape NICHT togglen) → 2 s Stabilisierung. Bei Wait-Timeout wird die letzte Probe als `Panel-Wait-Timeout: name=… dateOk=… texts=… sig=…` geloggt.
- **Album-Modus überspringt Wait/Resync komplett** (Trust irrelevant).
- **Vollscan:** `extractCurrentImageInfo` scannt die ganze Seite (kein gecachter Panel-Container – der lieferte veraltete Inhalte). `pendingInfoRef`: das vom Wait bestätigte Ergebnis wird in der nächsten Iteration wiederverwendet (ID-Abgleich mit `currentId`; bei Mismatch verworfen).

### 9.2 Trust-Detektor (`evaluateScrapeTrust`)
- **Harte Namenssperre (immer):** `potentialFilename` == Vorgänger-Dateiname **oder** Vorgänger-`originalName` und ≠ eigener Name (`filename`/`originalName`) → `trusted=false` („Kandidat entspricht Vorgängername“). Schützt auch bei bestätigtem Refresh vor Teil-Updates.
- **`panelRefreshed`** → `trusted=true` (60-s-Heuristik umgangen).
- **Fallback:** kein Vorgänger → vertrauenswürdig. Sonst Vorgänger-Datum (EXIF/Web) bzw. Name vergleichen (60 s / gleich); zusätzlich `matchesOwn` gegen `entry.timestamp`, wenn kein EXIF-Datum. Unvollständige Vorgänger-Referenz → `trusted=true` (verhindert Untrusted-Kaskade).
- Debug-Log nur bei Auffälligkeiten (`Trust: refreshed=… synced=… reason=… id=…`); Vollprotokoll via `VERBOSE_TRUST_LOG = true` (App.tsx).

### 9.3 Konsequenzen bei `trusted=false`
- Download läuft, aber `trusted=false` im Config → Main schreibt **keine** Metadaten (`metadataWritten=false`).
- Namens-/Datums-Korrekturen werden mit Warnlog übersprungen.
- `rememberTrueMeta` speichert den Web-Timestamp nicht als verlässlich.
- Einzeldownload nutzt den Detektor **nicht** (immer `trusted=true`).

---

## 10. Album-Download (getrennt vom Backup)

- Auslöser: URL-Kontext `/album/` oder `/share/` → `AlbumDownloadModal` (Ordnername, Sanitizing `[\\/:*?"<>|]` → `_`).
- Ziel: `exportPath + '\\Alben\\' + folderName` (hartkodierter Backslash, flache Struktur).
- Verhalten: **immer herunterladen**, keine DB-Prüfung, **kein DB-Eintrag**, keine Statistik/`scannedDays`/Orphan-Prüfung. Logs Typ `album`.
- Duplikate sind erwünscht; Ordner kann separat gelöscht werden. `isAlbumModeRef` steuert global, wird nach dem Loop zurückgesetzt.

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
| `saveDatabase` | `save-database` | invoke | JSON schreiben (kein Auto-Backup) |
| `createDatabaseBackup` | `create-db-backup` | invoke | DB-Backup (`daily`/`force`) |
| `saveTextFile` | `save-text-file` | invoke | CSV schreiben |
| `checkIntegrity` | `check-db-integrity` | invoke | Struktur-Check (Objekt-Argument!) |
| `findRenamableFiles` | `find-renamable-files` | invoke | Rename-Kandidaten |
| `verifyFileIntegrityBatch` | `verify-file-integrity-batch` | invoke | Deep Scan |
| `prepareDownload` | `prepare-download` | invoke | Setzt `nextDownloadConfig` |
| `cancelPendingDownload` | `cancel-pending-download` | invoke | Entwertet offene Download-Config |
| `setPowerSaveBlocker` | `set-power-save-blocker` | invoke | Ruhemodus + Bildschirm-Aus verhindern |
| `onDownloadStarted` | `download-started` | on | Slot-Freigabe + finaler Dateiname |
| `onDownloadComplete` | `download-complete` | on | Ergebnis |
| `onDownloadProgress` | `download-progress` | on | Fortschritt |
| `removeDownloadListener` | – | – | entfernt alle 3 Listener |
| `deleteFile` | `delete-file` | invoke | Datei löschen |
| `renameFile` | `rename-file` | invoke | Umbenennen (Hash-Gate) |
| `checkFileExists` | `check-file-exists` | invoke | Existenzprüfung |
| `computeFileHash` | `compute-file-hash` | invoke | SHA-256 |
| `moveAndUpdateFile` | `move-and-update-file` | invoke | Verschieben + Metadaten (Hash-Gate) |
| `showItemInFolder` | `show-item-in-folder` | invoke | Explorer |
| `openFile` | `open-file` | invoke | Datei im Standard-Viewer öffnen |

- TS-Typisierung in `types.ts` (`declare global { interface Window { electron: … } }`). **Neue IPC-Funktionen immer an drei Stellen ergänzen: `main.cjs`, `preload.cjs`, `types.ts`.**
- `checkIntegrity` ist als `(basePath, files, onlySubset?)` typisiert.

---

## 12. UI-Struktur (App.tsx)

- **StartupScreen** solange `!isInitialized`.
- **Webview-Bereich** oben (`photos.google.com`, `allowpopups`). Overlays:
  - Download-Fortschrittskarten (links oben, feste Slots 1–5; Wartekarte „Warte auf Download…“ mit Sekunden-Timer + „max. 45 s“/„ohne Limit“, geht in-place in den Fortschritt über; fertige Downloads hinterlassen unsichtbare Lücken).
  - Status-Infos im Header „Neue Dateien“: Spinner = Backup läuft, „Aktive Downloads: x/5“.
  - **Ruhemodus-Schutz:** bei `isWalking || activeDownloadsCount > 0` läuft im Main `powerSaveBlocker.start('prevent-display-sleep')` (IPC `set-power-save-blocker`); Freigabe bei Stop/Reset/App-Ende (`will-quit`-Absicherung).
  - **Backup-Flyout:** nach jedem DB-Backup 8 s grüner Hinweis „📦 DB-Backup erstellt (<Anlass>).“ (`z-[100]`, auch über Modals; Reset räumt ihn ab).
- **Untere Leiste (h-64):**
  - Links: Status, Scan-Historie, **„🛠️ Prüfung & Korrekturen“** (einziger Einstieg; Check **manuell** über „🔍 Struktur prüfen“, Dateiänderungen erst nach Bestätigung; rot/pulsierend bei Problemen, Badge = Summe der fünf Kategorien + „+n Dup.“), CSV-Export, Reset, Logout, Start/Stop, „⬇ 1“.
  - Mitte: Log-Fenster (nur relevante Meldungen, max. 300, Button „Logs“). **Auto-Scroll:** springt bei neuen Einträgen nach unten; pausiert nur bei Mouse-Hover (manuelles Scrollen möglich), beim Verlassen sofort wieder nach unten.
  - Rechts: Liste „Neue Dateien“ (max. letzte 100, Web vs. Original-Datum, ✔/⚠) – gleiches Auto-Scroll-/Hover-Verhalten.
- **Log-Filterung** (`addLog`): Alles geht an Konsole/Logdatei; UI zeigt `error/success/warning/album` + Schlüsselwörter (Backup, Datenbank, Bereinigung, Status, Web, Bereits, Bekannt, vermisst, Warte, Umbenannt, Verschoben, Metadaten, Tageswechsel, Scan-Log). Debug nur Konsole – **Ausnahme:** `DEBUG_UI_KEYWORDS` (`Panel-Wait-Timeout`, `Bekannt:`) erscheinen zusätzlich im UI (kursiv/grau).
- **`isResettingRef`** blockiert während Reset alle State-/IPC-Updates.
- **Reset** setzt alle States/Refs zurück (inkl. Cleanup-Vorschau + Hover-Refs) → StartupScreen.
- **Logout** (`clearCacheAndLogout`): `clearSessionCache()` + Navigation zu `https://accounts.google.com/Logout`.

---

## 13. Logging & Dateien auf der Platte

| Artefakt | Ort | Details |
|---|---|---|
| Datenbank | `<Zielordner>/gphotos_db.json` | siehe Abschnitt 6 |
| DB-Backups | `<Zielordner>/Backups/gphotos_db_<stamp>.json` | Tages-Backup + Force vor Bulk-Aktionen; max. 20 |
| Logs | `<Zielordner>/Logs/backup-YYYY-MM-DD.log` | Tagesrotation; vor DB-Load: `app.getPath('userData')/Logs` |
| CSV-Export | `<Zielordner>/gphotos_export_YYYY-MM-DD.csv` | UTF-8 BOM, Semikolon |
| Fotos/Videos | `<Zielordner>/<YYYY>/<MM>/` | Album: `<Zielordner>/Alben/<Name>/` flach |
| Build | `dist/`, `release/` | ignoriert von Git |

- `appendLog` schreibt fehlertolerant (try/catch, bricht nie den Ablauf ab).
- `main.cjs` loggt jeden Download-Start/-Abschluss mit Hash-Präfixen.

---

## 14. Legacy / tote Pfade / bekannte Fallstricke

1. **Toter Code (Cleanup Phase 1, nicht wieder einführen):** `services/googlePhotosService.ts` (Library-API), IPC `google-api-request` + `create-directory`, `deleteOrphansFromDisk`, `determineAlbumName`, `formatDateForExif`, `blobToDataURL`, `dataURLtoBlob`, `AppState`, `GooglePhotoAlbum`, `GoogleMediaItem`, `foundInSidePanel`, `public/index.css`, `metadata.json`. `panelSignature` wurde bewusst wieder eingebaut und ist aktiv.
2. **`scannedRanges`** ist Legacy (Root-Feld); nur für Migration/Bereinigung relevant.
3. **Doppelte Valid-Key-Listen** für die Legacy-Bereinigung (App.tsx + ActionModals.tsx) – synchron halten!
4. **`basePath` wird beim Speichern auf `"."` gesetzt** – echter Basispfad kommt beim Laden aus dem Dateipfad. Absicht (portable DB).
5. **`index.html`** lädt eine Importmap mit React 19 von esm.sh (package.json: React 18); Vite bundelt ohnehin. Harmlos, kein Vorbild.
6. **Tailwind läuft über CDN** – die App braucht Internetzugang für die UI-Styles (Webview ohnehin).
7. **`.env.local`** enthält nur einen ungenutzten `GEMINI_API_KEY`-Platzhalter. Keine Secrets im Repo.
8. **Windows-only-Annahmen:** hartkodierte `\\`-Pfade (Alben), PowerShell für CreationTime, `includes('\\')`-Erkennung.
9. **Extension-Listen synchron halten:** JPG `.jpg/.jpeg`; Video `.mp4 .mov .m4v .avi .3gp .mpg .mts` (main.cjs Download + Move, App.tsx Anzeige-Typ).
10. **Der Crawler hängt an der Google-Photos-Web-DOM.** Änderungen an Google (aria-labels, Shift+D / i / Pfeiltasten, Panel-Layout >70 % Viewportbreite) können den Scraper brechen. `extractCurrentImageInfo` ist die zentrale Stelle.
11. **Timeouts:** Start-Timeout 45 s im Haupt-Backup, Einzeldownload ohne Limit, 3 s beim Scraping. **Kein** Gesamt-Download-Timeout – hängende Downloads blockieren die 5 Slots.
12. **DB wird bei Download-Complete nur im Speicher aktualisiert**, persistiert erst beim nächsten Speicherpunkt (Checkpoint alle 25 / Tageswechsel / Stop / Session-Ende). Ein harter Absturz kann bis zu 24 Einträge verlieren; abgesichert über das Tages-Backup.
13. **`DB 2025 (9xx)`-Falle (behoben, nicht wieder einbauen):** Legitime Google-Namen enden teils auf `(n)`. Der Namens-Anker darf `(n)` nicht blind strippen, sonst gelten aufeinanderfolgende Fotos als „Vorgängerfoto“ → Desync-Abbruch.
14. **Offene Kleinigkeit (A7):** Der Veraltet-Zähler im Struktur-Check prüft `files['scannedRanges']` (existiert nie – Root-Feld). Root-Legacy allein würde den Button nicht einblenden; die Bereinigung selbst funktioniert.
15. **A9:** „Neuen Ordner wählen“ bei existierender DB warnt nur per Log; startet man trotzdem, werden alle Dateien neu geladen (Kollisions-Kopien).

### 14.1 Learnings aus behobenen Fehlern

- **Start ≠ Timeout:** Download-Slot und `processedIds` erst bei bestätigtem `download-started` belegen; Timeout-Fälle in `skippedDownloads` führen.
- **Nie in Retry-Schleifen laufen:** Scheitert die Navigation nach einer Exception, Schleife mit klarer Meldung beenden.
- **Stale-Panel ernst nehmen:** Panel-Signaturänderung beweist nicht das aktuelle Foto. Namens-Anker exakt (Dateiname **oder** `originalName`), Resync mit URL-Verifikation, im Zweifel Session-Abbruch statt Falschdaten. `(n)`-Suffixe nie blind strippen.
- **Namenskorrektur nie überspringen, nur weil Panelname == Dateiname** (case-insensitiv) – genau dann ist der Altwert oft falsch.
- **Kollisionsschutz:** Zielpfade reservieren (`reservedTargetPaths`), nicht nur `existsSync`.
- **Hash-Gate nie umgehen:** Mutation nur gegen gespeicherten Hash; fehlt/weicht er ab → Hash nachtragen/aktualisieren und Korrektur vertagen.
- **Duplikate nur hash-basiert** behandeln; Online-Einträge nie löschen; untracked Waisen separat (Tab „Verwaist“).
- **Physisches Löschen prüfen:** DB-Eintrag/Flags nur ändern, wenn `deleteFile` erfolgreich war.
- **Einzeldownload:** Existenz immer prüfen (auch bei `missingSince`), stale Flags heilen, sofort speichern – verhindert `(1)`-Kopien.
- **Missing-Prüfung pro fertigem Tag** (nicht am Session-Ende): Session-Abbrüche dürfen keine Massen-Flags erzeugen.
- **`dbFilePath` nie persistieren**; `basePath` bleibt `"."`.
- **Trust-Fallback:** unvollständige Vorgänger-Referenz → `trusted=true` (verhindert Kaskaden); `entry.timestamp` als Fallback für EXIF-lose Fotos.
- **Bulk-Änderungen nur nach Bestätigung + Force-Backup** (F23/F24/F29): Vorschau zeigen, Hash-Gate anwenden, Lazy-Listen für große Datenmengen.

---

## 15. Konventionen & Arbeitsanweisungen für Agenten

1. **AGENTS.md aktualisieren bei jeder Änderung** (siehe Kopf). Betroffene Abschnitte anpassen, keine widersprüchlichen Angaben stehen lassen.
2. **Sprache:** UI-Texte und Logs auf Deutsch; Code-Bezeichner Englisch. Bestehenden Stil nachahmen.
3. **Keine neuen Abhängigkeiten**, wenn es ohne geht. Wenn doch, `package.json` anpassen und hier dokumentieren. Browser-only-Libs im Renderer vermeiden (Node-Zugriff nur über IPC).
4. **Sicherheit:** `contextIsolation: true`, `nodeIntegration: false`, `sandbox: false`, `webviewTag: true` sind gesetzt. Keine Secrets/Telemetrie/Netzwerkaufrufe hinzufügen (außer Google Photos im Webview).
5. **Hash-Gate nie umgehen.** Jegliche Datei-Mutation (Move/Rename/Rewrite) muss `expectedHash` berücksichtigen.
6. **DB-Schema-Erweiterungen** erfordern: `types.ts` (`DatabaseEntry`/`FileDatabase`), beide Valid-Key-Listen (8.6), ggf. CSV-Spalten, ggf. Migration + `hashScheme`-Erhöhung, und diesen AGENTS.md-Abschnitt.
7. **Neue IPC-Funktionen** an drei Stellen ergänzen (main.cjs, preload.cjs, types.ts) und in Abschnitt 11 dokumentieren.
8. **CommonJS-Beibehaltung** in `main.cjs`/`preload.cjs`.
9. **Vor Abschluss einer Aufgabe:** `npm run build` ausführen (TypeScript-Check). Bei UI-/Ablaufsänderungen zusätzlich manuell per `npm run electron:dev` testen, sofern möglich.
10. **Git:** Nicht committen/pushen, außer der Nutzer fordert es ausdrücklich. Commit-Präfixe üblich: `feat:`, `fix:`, `docs:`, `chore:`.

---

## 16. Glossar

| Begriff | Bedeutung |
|---|---|
| **webDate** | Aufnahmedatum aus der Google-Photos-Sidebar; bestimmt den Zielordner |
| **finalDate** | Tatsächlich geschriebenes Datum (Web-Datum, ggf. mit Sekunden aus EXIF) |
| **sourceHash** | SHA-256 des Rohdownloads vor Metadaten-Rewrite (stabil) |
| **hash** | SHA-256 der Datei auf der Platte nach Rewrite (änderbar durch Korrekturen) |
| **trusted** | Metadaten-Scrape gilt als verlässlich; sonst keine Rewrites/Korrekturen |
| **Orphan / vermisst** | DB-Eintrag mit `missingSince`, Datei fehlt lokal |
| **onlineMissing** | DB-Eintrag mit `onlineMissingSince`: Datei lokal vorhanden, online nicht gesehen |
| **corrupt** | Datei mit 0 Bytes oder Lesefehler (`integrityStatus === 'corrupt'`) |
| **Backup-Loop** | Der parallele Crawler-Loop (max. 5 gleichzeitige Downloads) |
| **Download-Checkpoint** | Nach je 25 erfolgreichen Haupt-Backup-Downloads wird die DB gespeichert |
| **Tages-Backup** | 1× pro Kalendertag vor dem ersten Scan erstellte DB-Kopie (`create-db-backup` Modus `daily`) |
| **scannedDays** | `YYYY-MM-DD` → Scan-Zeitpunkt; Grundlage der Heatmap; Tageswechsel löst die Missing-Prüfung aus |
| **Übersprungen / skippedDownloads** | Foto mit Download-Start-Timeout (45 s); Key = Google-ID |
| **Hash-Gate** | Pflicht-Hash-Vergleich vor Datei-Mutation |
| **Stale Panel** | Sidebar zeigt verzögert noch Daten des vorherigen Fotos |

---

## 17. Kurz-Checkliste für typische Aufgaben

- **Neues Feature in der Backup-Schleife:** `App.tsx` (`runBackupSession`), ggf. `logic/crawlerActions.ts`; Parallelitäts-/Checkpoint-Mechanik beachten; Log via `addLog`; AGENTS.md Abschnitt 4/12.
- **Neuer Metadaten-Typ:** Main-Prozess (Download-`done`-Handler + `move-and-update-file`), Extension-Listen, `DownloadResult`/`DatabaseEntry`-Typen, AGENTS.md Abschnitt 5/7.
- **Neue Wartungs-/Prüffunktion:** Handler in `main.cjs`, Bridge + Typ, Modal in `components/ActionModals.tsx`, Einbindung in App.tsx, AGENTS.md Abschnitt 8.
- **DB-Feld:** siehe Konvention 6.
- **Crawler-Anpassung (Google-DOM):** `logic/crawlerActions.ts` + `utils/exifUtils.ts` (Datumsformat), Trust-Detektor in App.tsx prüfen; AGENTS.md Abschnitt 9/14.
