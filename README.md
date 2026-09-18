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
- **Parallele Downloads** (Turbo-Modus, bis zu 5 gleichzeitig)
- **Live Photos** – ZIP-Downloads werden automatisch entpackt
- **Duplikaterkennung** über SHA-256-Hashes und Metadaten-Heuristiken
- **Integritätsprüfung** – findet fehlende, defekte und duplizierte Dateien
- **Scan-Historie** als Heatmap im Dashboard
- **Getrennter Album-Download** – Alben und geteilte Sammlungen werden in einen separaten Ordner geladen, ohne die Backup-Datenbank oder -Statistik zu beeinflussen
- **Suche blockiert** – Downloads aus Suchergebnissen sind deaktiviert, um unbeabsichtigte Duplikate zu vermeiden

## Download

Die aktuellen Versionen findest du auf der [Releases-Seite](https://github.com/robertlewineifler/rle-google-fotos-backup/releases):

| Variante | Beschreibung |
|---|---|
| `RLE Google Fotos Backup Setup x.y.z.exe` | Installer (empfohlen) |
| `RLE Google Fotos Backup x.y.z.exe` | Portable – ohne Installation nutzbar |
| `RLE Google Fotos Backup x.y.z win-unpacked.zip` | Entpackte Version zum manuellen Starten |

## Benutzung

1. App starten und einen Zielordner für das Backup wählen (oder eine vorhandene `gphotos_db.json` laden).
2. Im eingebetteten Google-Fotos-Fenster anmelden und ein beliebiges Bild öffnen.
3. **Start Backup** klicken – die App navigiert automatisch durch die Bibliothek und lädt die Dateien herunter.
4. Fertige Dateien landen in der Struktur `<Zielordner>/YYYY/MM/`.

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
services/                  Google-Photos-API-Helfer
utils/                     EXIF- und Datums-Helfer
```

## Lizenz

MIT
