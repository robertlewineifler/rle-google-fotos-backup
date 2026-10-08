<div align="center">
<img src="assets/icon.png" alt="RLE Google Fotos Backup" width="96" />
<h1>RLE Google Fotos Backup</h1>
<p>Windows-Desktop-App zur lokalen Sicherung deiner Google-Fotos-Bibliothek.</p>
</div>

---

## Über das Projekt

RLE Google Fotos Backup lädt Fotos und Videos aus Google Fotos herunter, sortiert sie automatisch nach Jahr und Monat und korrigiert dabei die Zeitstempel anhand der Original-EXIF-Daten. Eine JSON-Datenbank dokumentiert den Fortschritt, sodass ein Backup jederzeit unterbrochen und später fortgesetzt werden kann.

Alle Daten bleiben lokal auf deinem Rechner. Es gibt keine Cloud-Anbindung, keine Telemetrie und keine externen Server.

## Features

- **Vollständiges Backup** der Google-Fotos-Bibliothek über den eingebetteten Browser
- **Fortsetzbare Backups** dank JSON-Datenbank (`gphotos_db.json`)
- **Automatische EXIF-Korrektur** – Dateisystem-Zeitstempel, JPEG-EXIF und Video-Metadaten werden auf das Original-Aufnahmedatum gesetzt
- **Stale-Panel-Schutz** – Namens-Anker, Panel-Resync und sauberer Session-Abbruch verhindern falsche Metadaten
- **Parallele Downloads** (bis zu 5 gleichzeitig) mit Wartekarten und festen Slots
- **Live Photos** – ZIP-Downloads werden automatisch entpackt
- **Einzeldownload** („⬇ 1“) für einzelne geöffnete Fotos
- **🛠️ Prüfung & Korrekturen** – manueller, rein lesender Struktur-Check mit sieben Tabs:
  - Vermisst · Defekt · Übersprungen · Online nicht gefunden · Verwaist · Dateinamen · Duplikate
  - Dateiänderungen (Umbenennen/Löschen) erst nach Bestätigung, mit automatischem DB-Backup
- **✨ Dateinamen bereinigen** – `(n)`-Auflösung, Entfernen doppelter Endungen und durchgängig kleingeschriebene Dateiendungen
- **DB-Backups** – einmal pro Kalendertag (Tagesstart) und forciert vor Bulk-Aktionen; max. 20, älteste werden rotiert
- **Missing-Prüfung pro Tag** – beim Scannen eines vollständigen Tages wird sofort geprüft, ob Dateien lokal fehlen oder online nicht mehr zu finden sind
- **Inhaltsprüfung** – findet defekte Dateien (0 Bytes/Lesefehler) über vollständiges Einlesen
- **Scan-Historie** als Heatmap im Dashboard
- **Ruhemodus-Schutz** – während Scan und laufender Downloads wird der Standby/Bildschirm-Aus verhindert
- **Auto-Scroll** in Log- und Datei-Liste (pausiert bei Mouse-Hover)
- **CSV-Export** der Datenbank (UTF-8, Semikolon)
- **Getrennter Album-Download** – Alben und geteilte Sammlungen werden in einen separaten Ordner geladen, ohne die Backup-Datenbank oder -Statistik zu beeinflussen
- **Suche blockiert** – Downloads aus Suchergebnissen sind deaktiviert, um unbeabsichtigte Duplikate zu vermeiden

## Download

Die aktuellen Versionen findest du auf der [Releases-Seite](https://github.com/robertlewineifler/rle-google-fotos-backup/releases):

| Variante | Beschreibung |
|---|---|
| `RLE Google Fotos Backup Setup x.y.z.exe` | Installer (empfohlen) |
| `RLE Google Fotos Backup x.y.z.exe` | Portable – ohne Installation nutzbar |
| `RLE Google Fotos Backup x.y.z win-unpacked.zip` | Entpackte Version zum manuellen Starten |

> **Hinweis:** Ältere Releases bleiben zu Archivzwecken erhalten, werden aber nicht mehr unterstützt. Es wird empfohlen, immer die neueste Version zu verwenden.

## Benutzung

1. App starten und einen Zielordner für das Backup wählen (oder eine vorhandene `gphotos_db.json` laden).
2. Im eingebetteten Google-Fotos-Fenster anmelden und ein beliebiges Bild öffnen.
3. **Start Backup** klicken – die App navigiert automatisch durch die Bibliothek und lädt die Dateien herunter.
4. Fertige Dateien landen in der Struktur `<Zielordner>/YYYY/MM/`.
5. Nach dem Scan: **🛠️ Prüfung & Korrekturen** öffnen → **🔍 Struktur prüfen** → Befunde sichten und nach Bestätigung bereinigen.

### Prüfung & Korrekturen

- Der Struktur-Check ist **rein lesend** und ändert keine Dateien.
- Umbenennungen und Löschungen laufen gesammelt über bestätigte Aktionen (mit automatischem DB-Backup).
- Über den Tab **Dateinamen** werden Dateinamen bereinigt; der Tab **Duplikate** zeigt Datenbank-Duplikate (gleicher Inhalt), der Tab **Verwaist** Dateien ohne Datenbank-Eintrag.

### Album-Download

Befindest du dich in einem Album oder einer geteilten Sammlung, kannst du diese **getrennt vom Backup** herunterladen:

- Die Fotos landen in `<Zielordner>/Alben/<Name>/`
- Sie werden **nicht in die Datenbank** aufgenommen und erscheinen **nicht in der Statistik**
- Duplikate sind dabei beabsichtigt – der Album-Ordner kann jederzeit separat gelöscht werden

## Entwicklung

**Voraussetzungen:** Node.js

```bash
npm install
npm run electron:dev     # Entwicklungsmodus (Vite auf Port 5273 + Electron)
npm run electron:build   # Release-Build (Installer, Portable, Unpacked)
```

### Projektstruktur

```
App.tsx                    Hauptlogik und UI
main.cjs                   Electron-Hauptprozess, Download-Handling, Metadaten
preload.cjs                IPC-Bridge
components/                UI-Komponenten (Modals, Startup, Heatmap)
logic/                     Crawler-Aktionen und Datenbank-Utilities
utils/                     EXIF- und Datums-Helfer
CHANGELOG.md               Versionshistorie
AGENTS.md                  Projektwissen für Agenten/Entwickler
```

## Changelog

Alle Änderungen pro Version: [CHANGELOG.md](CHANGELOG.md)

## Lizenz

MIT
