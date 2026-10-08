# Changelog

Alle nennenswerten Änderungen an diesem Projekt. Format angelehnt an „Keep a Changelog“, Versionierung nach SemVer.

## [1.2.0] – 2026-10-08

### Added
- **Fenster „🛠️ Prüfung & Korrekturen“ mit sieben Tabs:** Vermisst, Defekt, Übersprungen, Online nicht gefunden, Verwaist, Dateinamen, Duplikate – jeweils mit Erklärung, Aktionen und einheitlichem Aufbau.
- **Manueller Struktur-Check („🔍 Struktur prüfen“):** rein lesend; aktualisiert nur Datenbank-Metadaten (Hashes, Größen, Vermisst-Status). Dateiänderungen laufen ausschließlich über bestätigte Aktionen.
- **„✨ Dateinamen bereinigen“:** `(n)`-Auflösung, Entfernen doppelter Endungen, durchgängig kleingeschriebene Dateiendungen; Zusammenfassung + Lazy-Detail-Liste + automatisches Force-Backup vor der Ausführung.
- **DB-Backup-Strategie:** Tages-Backup (1× pro Kalendertag vor dem ersten Scan) und Force-Backup vor Bulk-/Löschaktionen; max. 20 Backups, älteste werden rotiert; grüner Flyout-Hinweis nach jedem Backup.
- **Missing-Prüfung pro Tag:** Beim Scannen eines vollständigen Tages wird sofort geprüft, ob Dateien lokal fehlen (`missingSince`) oder online nicht mehr gefunden wurden (`onlineMissingSince`).
- **Ruhemodus-Schutz:** Während Scan und laufender Downloads wird der Standby/Bildschirm-Aus per `powerSaveBlocker` verhindert.
- **Auto-Scroll** für Log- und „Neue Dateien“-Liste, pausiert bei Mouse-Hover (manuelles Scrollen möglich).
- **Tab „Duplikate“:** Datenbank-Einträge mit identischem SHA-256 inkl. voraussichtlicher Aktion; Online-Einträge werden nie gelöscht.
- **Tab „Verwaist“:** Dateien auf der Platte ohne Datenbank-Eintrag mit Hash-Abgleich („Duplikat von …“) und Einzel-/Batch-Aktionen.
- **Tab „Dateinamen“:** prominente Statistik-Karte mit Klick-Toggles und Lazy-Listen je Kategorie.
- **CSV-Export** der Datenbank (UTF-8 mit BOM, Semikolon).
- **Scan-Heatmap** (4 Ansichtsmodi: relativ, absolut, Menge, Größe).
- **Einzeldownload („⬇ 1“)** für das gerade geöffnete Foto, ohne Zeitlimit.

### Changed
- **Backup-Strategie:** Das zeitbasierte Auto-Backup (alle 10 Minuten) wurde entfernt – Backups entstehen jetzt an definierten Ereignissen (Tagesstart, Bulk-Aktionen).
- **Stale-Panel-Schutz komplett überarbeitet:** Namens-Anker (exakter Vergleich inkl. Google-Originalname), Panel-Resync mit URL-Verifikation, deterministischer Session-Start per Reload und sauberer Session-Abbruch statt Falschdaten.
- **ZIP-/Live-Photo-Namen:** Entpackte Bilder erhalten immer eine kleingeschriebene Endung.
- **Namenskorrekturen:** `originalName` wird beim Re-Scan auch dann aktualisiert, wenn der Panel-Name dem lokalen Dateinamen entspricht (Altwerte aus der Stale-Panel-Ära).
- **Download-Wartekarte:** fester Slot 1–5, In-Place-Übergang in den Fortschritt, Sekunden-Timer.
- **Kollisionsschutz:** Zielpfade werden während des Downloads reserviert (kein Überschreiben bei parallelen Gleichnamigen).
- **Legacy-Bereinigung:** entfernt veraltete Felder (`scannedRanges` und unbekannte Eintrags-Felder).

### Fixed
- **One-off-/Stale-Panel-Schäden:** Beim Re-Scan werden verschobene Namen und Datumsabweichungen korrekt erkannt und behoben (Ordner, EXIF, Video-Atome, Dateisystem-Zeitstempel).
- **Desync-Abbruch im `DB 2025 (9xx)`-Block:** Legitime Google-Namen mit `(n)`-Endung kollidierten im Namens-Anker und blockierten den Scan – behoben durch exakten Vergleich.
- **Hash-Gate überall:** Verschieben/Umbenennen nur bei passendem gespeichertem Hash; sonst Hash nachtragen und Korrektur vertagen.
- **Download-Slots:** Belegung erst bei bestätigtem Start; Timeouts landen in „Übersprungen“ statt einen Slot zu blockieren.
- **Datenbank-Reset nur nach erfolgreichem physischem Löschen** (keine Geister-Einträge).
- **Vermisst-Status:** Selbstheilung beim Struktur-Check; wiederhergestellte Dateien verschwinden sofort aus den Listen.
- **Doppelte Endungen** (z. B. `IMG_3181.JPG.jpg`) werden beim Download und bei der Bereinigung normalisiert.

## [1.1.0] – 2026-09-18
- Album-Download als getrennte Funktion (eigener Ordner, keine DB-/Statistik-Einträge).
- Downloads aus der Suche (`/search/`) blockiert.
- Versionsnummer dynamisch aus `package.json` im Startbildschirm.
- Eigener Dev-Server-Port 5273.
