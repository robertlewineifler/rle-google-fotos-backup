@echo off
:: Überprüfen, ob wir bereits Administrator-Rechte haben
net session >nul 2>&1

:: Wenn der Errorlevel nicht 0 ist, haben wir keine Admin-Rechte -> Neustart als Admin anfordern
if %errorLevel% neq 0 (
    echo Fordere Administrator-Rechte an...
    powershell -Command "Start-Process '%~dpnx0' -Verb RunAs"
    exit /b
)

:: --- Ab hier läuft das Skript als Administrator ---

:: In das Verzeichnis wechseln, in dem diese .bat Datei liegt
cd /d "%~dp0"

:: Den Befehl ausführen
echo Starte npm run electron:dev...
npm run electron:dev

:: Fenster offen lassen, damit man eventuelle Fehler sieht (optional)
pause