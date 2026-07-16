



















const { app, BrowserWindow, ipcMain, dialog, session, fs: fsOriginal, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs').promises; // NEU: Async FS
const piexif = require('piexifjs');
const { exec } = require('child_process');
const crypto = require('crypto');
const AdmZip = require('adm-zip');

// --- CHROMIUM FLAGS ---
// Verhindert Autoplay von Videos global (wichtig für Crawler)
app.commandLine.appendSwitch('autoplay-policy', 'user-gesture-required');

// --- SETUP ---
const isDev = !app.isPackaged;
let mainWindow;

// Globaler State für den NÄCHSTEN Download-Vorgang (Initialisierung)
// Da JS single-threaded ist, können wir dies kurzzeitig global halten, bis 'will-download' feuert.
let nextDownloadConfig = {
    active: false,
    id: '',
    targetDir: '',
    dateTimestamp: 0
};

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 1000,
    title: 'RLE Google Fotos Backup',
    icon: path.join(__dirname, 'public', 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      webviewTag: true, 
      sandbox: false 
    },
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    // mainWindow.webContents.openDevTools(); 
  } else {
    mainWindow.loadFile(path.join(__dirname, 'dist', 'index.html'));
  }

  // --- DOWNLOAD HANDLER (Shift + D Interception) ---
  mainWindow.webContents.session.on('will-download', (event, item, webContents) => {
    if (!nextDownloadConfig.active) {
        console.log("Ungeplanter Download:", item.getFilename());
        return;
    }

    // KONFIGURATION SICHERN (Scope Capture für diesen spezifischen Download)
    const config = { ...nextDownloadConfig };
    
    // Global sofort resetten, damit der nächste Loop nicht blockiert oder überschreibt
    nextDownloadConfig.active = false; 

    // SIGNAL AN FRONTEND: "Habe Download übernommen, du kannst weitermachen"
    mainWindow.webContents.send('download-started', config.id);

    const originalNameRaw = item.getFilename();
    const webDate = new Date(config.dateTimestamp);
    
    // PFAD-LOGIK: Immer YYYY/MM
    const year = webDate.getFullYear().toString();
    const month = (webDate.getMonth() + 1).toString().padStart(2, '0');
    const targetSubFolder = path.join(config.targetDir, year, month);
    
    if (!fs.existsSync(targetSubFolder)){
        fs.mkdirSync(targetSubFolder, { recursive: true });
    }

    // --- FILENAME SANITIZATION & TRUNCATION ---
    // Google liefert manchmal die ganze Beschreibung als Dateinamen.
    // Wir begrenzen auf 100 Zeichen (Base) + Extension.
    const MAX_FILENAME_LEN = 100;
    
    let rawExt = path.extname(originalNameRaw);
    let baseName = path.basename(originalNameRaw); 

    // FIX: Extension Case-Insensitive entfernen (.MP4 -> .mp4 verhindern)
    // path.basename(name, ext) ist auf manchen Systemen case-sensitive.
    if (rawExt.length > 0) {
        if (baseName.toLowerCase().endsWith(rawExt.toLowerCase())) {
            baseName = baseName.substring(0, baseName.length - rawExt.length);
        }
    }
    
    let ext = rawExt.toLowerCase();

    // Kürzen, falls zu lang
    if (baseName.length > MAX_FILENAME_LEN) {
        baseName = baseName.substring(0, MAX_FILENAME_LEN).trim();
    }
    
    // Sicherer Name
    const safeOriginalName = baseName + ext;

    // Duplikate behandeln
    let finalFilename = safeOriginalName;
    const nameWithoutExt = baseName; // Bereits gekürzt
    let counter = 1;
    
    while (fs.existsSync(path.join(targetSubFolder, finalFilename))) {
        finalFilename = `${nameWithoutExt} (${counter})${ext}`;
        counter++;
    }

    let savePath = path.join(targetSubFolder, finalFilename);
    item.setSavePath(savePath);

    // Fortschritts-Listener
    item.on('updated', (event, state) => {
        if (state === 'progressing') {
            if (!item.isPaused()) {
                mainWindow.webContents.send('download-progress', {
                    filename: finalFilename,
                    percent: item.getTotalBytes() > 0 ? item.getReceivedBytes() / item.getTotalBytes() : 0,
                    received: item.getReceivedBytes(),
                    total: item.getTotalBytes()
                });
            }
        }
    });

    item.on('done', async (event, state) => {
      // WICHTIG: Den Namen merken, unter dem wir Progress gemeldet haben.
      // Wenn es ein ZIP ist, ändert sich finalFilename gleich, aber das Frontend wartet auf diesen Namen.
      const progressFilename = finalFilename; 

      let resultPayload = {
          id: config.id,
          success: false,
          filename: finalFilename,
          progressFilename: progressFilename,
          originalName: originalNameRaw,
          path: savePath,
          finalDateTimestamp: 0,
          error: ''
      };

      try {
          if (state === 'completed') {
            // Kurze Pause, um sicherzustellen, dass Dateihandles frei sind
            await new Promise(r => setTimeout(r, 200));

            // --- ZIP HANDLING (Live Photos) ---
            if (ext === '.zip') {
                try {
                    const zip = new AdmZip(savePath);
                    const entries = zip.getEntries();
                    // Suche nach JPG/JPEG im ZIP
                    const imageEntry = entries.find(e => {
                        const name = e.entryName.toLowerCase();
                        return !e.isDirectory && 
                               !name.startsWith('__macosx') && 
                               (name.endsWith('.jpg') || name.endsWith('.jpeg'));
                    });

                    if (imageEntry) {
                        const originalImageName = path.basename(imageEntry.entryName);
                        const imageExt = path.extname(originalImageName);
                        // Auch hier: Case-Insensitive logic anwenden
                        let imageNameNoExt = path.basename(originalImageName);
                        if (imageExt.length > 0 && imageNameNoExt.toLowerCase().endsWith(imageExt.toLowerCase())) {
                            imageNameNoExt = imageNameNoExt.substring(0, imageNameNoExt.length - imageExt.length);
                        }
                        
                        let newFilename = originalImageName;
                        let zipCounter = 1;
                        const lowerImageExt = imageExt.toLowerCase();

                        // Kollisionsprüfung für das entpackte Bild
                        while (fs.existsSync(path.join(targetSubFolder, newFilename))) {
                            newFilename = `${imageNameNoExt} (${zipCounter})${lowerImageExt}`;
                            zipCounter++;
                        }
                        
                        const newSavePath = path.join(targetSubFolder, newFilename);
                        
                        // Entpacken
                        fs.writeFileSync(newSavePath, imageEntry.getData());
                        
                        // Original ZIP löschen (Versuch)
                        try { fs.unlinkSync(savePath); } catch(e) { console.error("Konnte ZIP nicht löschen:", e); }
                        
                        // Pfade aktualisieren für weitere Verarbeitung
                        savePath = newSavePath;
                        finalFilename = newFilename;
                        ext = lowerImageExt;
                    }
                } catch (zipErr) {
                    console.error("[ZIP] Fehler beim Entpacken:", zipErr);
                    // Wir lassen success auf true, aber loggen den Fehler. 
                    // Die .zip Datei bleibt erhalten.
                }
            }
            
            // Result update falls Name geändert wurde (durch Zip Extract)
            resultPayload.filename = finalFilename;
            resultPayload.path = savePath;

            // --- HASH & METADATA ---
            let hash = null;
            // Hash Berechnung asynchron lassen (Stream)
            try { hash = await getFileHash(savePath); } catch(e) { console.error("Hash Error", e); }
            
            const isJpg = ['.jpg', '.jpeg'].includes(ext);
            const isVideo = ['.mp4', '.mov', '.m4v', '.avi', '.3gp', '.mpg', '.mts'].includes(ext);

            let originalDateObj = null;
            let binaryData = null; 

            if (isJpg) {
                try {
                    // EXIF ist meist klein, kann synchron bleiben
                    const fileBuffer = fs.readFileSync(savePath);
                    binaryData = fileBuffer.toString('binary');
                    const exifObj = piexif.load(binaryData);
                    let exifStr = null;
                    if (exifObj["Exif"] && exifObj["Exif"][36867]) exifStr = exifObj["Exif"][36867];
                    else if (exifObj["0th"] && exifObj["0th"][306]) exifStr = exifObj["0th"][306];
                    if (exifStr) originalDateObj = parsePiexifDate(exifStr);
                } catch (readErr) { /* Ignore EXIF errors */ }
            } else if (isVideo) {
                // UPDATE: Async Video Read
                originalDateObj = await readVideoMetadataAsync(savePath);
            }

            let finalDate = webDate; 
            if (originalDateObj) {
                const pad = n => (n < 10 ? '0' + n : n);
                const getKey = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
                if (getKey(webDate) === getKey(originalDateObj)) {
                    finalDate = originalDateObj;
                }
            }

            // Schreibvorgänge
            if (isJpg && binaryData) updateExifData(savePath, binaryData, finalDate);
            if (isVideo) await updateVideoMetadataAsync(savePath, finalDate); // UPDATE: Async Update
            
            await updateFileTimestamps(savePath, finalDate);

            // Ergebnis finalisieren
            resultPayload.success = true;
            resultPayload.originalExifDate = originalDateObj ? formatExifLike(originalDateObj) : null;
            resultPayload.hash = hash;
            resultPayload.finalDateTimestamp = finalDate.getTime();
          } else {
              resultPayload.error = `Download Status: ${state}`;
          }

      } catch (globalErr) {
          console.error("FATAL DOWNLOAD ERROR:", globalErr);
          resultPayload.success = false;
          resultPayload.error = globalErr.message;
      } finally {
          // WICHTIG: Sende IMMER eine Antwort, damit der Slot im React-Frontend freigegeben wird.
          mainWindow.webContents.send('download-complete', resultPayload);
      }
    });
  });
}

// --- HELPER FUNCTIONS ---
function parsePiexifDate(exifStr) {
    if (!exifStr) return null;
    const parts = exifStr.split(' ');
    if (parts.length < 2) return null;
    const dParts = parts[0].split(':');
    const tParts = parts[1].split(':');
    if (dParts.length < 3 || tParts.length < 3) return null;
    return new Date(parseInt(dParts[0]), parseInt(dParts[1]) - 1, parseInt(dParts[2]), parseInt(tParts[0]), parseInt(tParts[1]), parseInt(tParts[2]));
}

function formatExifLike(date) {
    const pad = n => n < 10 ? '0' + n : n;
    return `${date.getFullYear()}:${pad(date.getMonth() + 1)}:${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// --- APP LIFECYCLE & IPC ---

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();
  app.on('activate', function () { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', function () { if (process.platform !== 'darwin') app.quit(); });

ipcMain.on('log-to-console', (event, message, type = 'info') => {
    const timestamp = new Date().toLocaleTimeString();
    console.log(`[${timestamp}] ${type}: ${message}`);
});

ipcMain.handle('select-directory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('select-database-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters: [{ name: 'JSON Database', extensions: ['json'] }] });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('create-directory', async (event, dirPath) => {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
  return true;
});

ipcMain.handle('load-database', async (event, filePath) => {
    if (!fs.existsSync(filePath)) return null;
    try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); } catch (e) { return null; }
});

ipcMain.handle('save-database', async (event, filePath, data) => {
    try { fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8'); return true; } catch (e) { return false; }
});

ipcMain.handle('save-text-file', async (event, filePath, content) => {
    try { 
        fs.writeFileSync(filePath, content, 'utf-8'); 
        return { success: true, path: filePath }; 
    } catch (e) { 
        return { success: false, error: e.message }; 
    }
});

// NEU: Verschiebt und aktualisiert eine Datei, wenn sich das Datum geändert hat
ipcMain.handle('move-and-update-file', async (event, { basePath, oldFilename, oldTimestamp, newTimestamp }) => {
    const oldDate = new Date(oldTimestamp);
    const newDate = new Date(newTimestamp);

    const oldYear = oldDate.getFullYear().toString();
    const oldMonth = (oldDate.getMonth() + 1).toString().padStart(2, '0');
    
    const newYear = newDate.getFullYear().toString();
    const newMonth = (newDate.getMonth() + 1).toString().padStart(2, '0');

    const oldDir = path.join(basePath, oldYear, oldMonth);
    const newDir = path.join(basePath, newYear, newMonth);
    
    const oldPath = path.join(oldDir, oldFilename);

    if (!fs.existsSync(oldPath)) {
        return { success: false, error: "Ursprungsdatei nicht gefunden: " + oldPath };
    }

    if (!fs.existsSync(newDir)) {
        fs.mkdirSync(newDir, { recursive: true });
    }

    // Namenskollision im Zielordner behandeln
    let finalFilename = oldFilename;
    const ext = path.extname(oldFilename);
    const nameWithoutExt = path.basename(oldFilename, ext);
    let counter = 1;
    
    // Prüfen, ob Zieldatei existiert. 
    // ACHTUNG: Wenn wir im gleichen Ordner bleiben, ist oldPath == newPath (sofern Name gleich).
    // Das müssen wir abfangen.
    const isSameDir = oldDir === newDir;

    if (!isSameDir) {
        while (fs.existsSync(path.join(newDir, finalFilename))) {
            finalFilename = `${nameWithoutExt} (${counter})${ext}`;
            counter++;
        }
    } else {
        // Gleicher Ordner: Kein Rename nötig, es sei denn wir wollen den Namen explizit ändern (hier nicht der Fall)
        finalFilename = oldFilename;
    }

    const newPath = path.join(newDir, finalFilename);

    try {
        if (!isSameDir) {
            fs.renameSync(oldPath, newPath);
        }

        // Metadaten aktualisieren (Exif / Video Header / FileSystem TS)
        // 1. Filesystem
        await updateFileTimestamps(newPath, newDate);

        // 2. Inhaltliche Metadaten
        const isJpg = ['.jpg', '.jpeg'].includes(ext.toLowerCase());
        const isVideo = ['.mp4', '.mov', '.m4v', '.avi', '.3gp', '.mpg', '.mts'].includes(ext.toLowerCase());

        if (isJpg) {
            try {
                const fileBuffer = fs.readFileSync(newPath);
                const binaryData = fileBuffer.toString('binary');
                updateExifData(newPath, binaryData, newDate);
            } catch (exifErr) { console.error("EXIF Update failed during move", exifErr); }
        } else if (isVideo) {
            await updateVideoMetadataAsync(newPath, newDate);
        }

        return { success: true, newFilename: finalFilename };

    } catch (e) {
        console.error("Move failed:", e);
        return { success: false, error: e.message };
    }
});

// NEU: Batch Integrity Check (prüft ob Datei lesbar/korrupt)
ipcMain.handle('verify-file-integrity-batch', async (event, basePath, files) => {
    const results = {}; // { id: 'ok' | 'corrupt' }
    
    for (const file of files) {
        const dateObj = new Date(file.timestamp);
        const year = dateObj.getFullYear().toString();
        const month = (dateObj.getMonth() + 1).toString().padStart(2, '0');
        const fullPath = path.join(basePath, year, month, file.filename);

        try {
            // 1. Basic Stat Check (Existenz + Größe)
            const stats = await fsPromises.stat(fullPath);
            if (stats.size === 0) {
                results[file.id] = 'corrupt'; // 0 Bytes = Defekt
                continue;
            }

            // 2. DEEP SCAN: Datei komplett lesen, um I/O Fehler (bad sectors) zu finden
            // Wir lesen den Stream, um sicherzustellen, dass das Dateisystem die Datei tatsächlich liefern kann.
            await new Promise((resolve, reject) => {
                const stream = fs.createReadStream(fullPath);
                stream.resume(); // Daten fließen lassen (und verwerfen)
                stream.on('error', (err) => reject(err));
                stream.on('end', () => resolve());
            });

            // CHECK ENTFERNT: JPEG EOF (FF D9). Wurde als zu strikt empfunden.

            results[file.id] = 'ok';

        } catch (e) {
            // ENOENT = Missing wird hier ignoriert (macht der Missing Check)
            if (e.code === 'ENOENT') {
                // results[file.id] = 'missing'; 
            } else {
                console.log(`Corrupt file detected (Deep Scan): ${fullPath} (${e.message})`);
                results[file.id] = 'corrupt';
            }
        }
    }
    return results;
});

ipcMain.handle('check-db-integrity', async (event, { basePath, files, onlySubset }) => {
    const missing = [];
    const hashRegistry = {};
    const updates = {}; 
    const sizeUpdates = {}; // NEU: ID -> Size in Bytes
    const entries = Object.entries(files);
    
    // Wir sammeln alle validen Dateien für den erweiterten Duplikat-Check
    const validFiles = [];

    for (const [id, entry] of entries) {
        const dateObj = new Date(entry.timestamp);
        const year = dateObj.getFullYear().toString();
        const month = (dateObj.getMonth() + 1).toString().padStart(2, '0');
        const standardPath = path.join(basePath, year, month, entry.filename);
        
        if (!fs.existsSync(standardPath)) {
            missing.push({ id, filename: entry.filename, timestamp: entry.timestamp });
        } else {
            // Stats für Heuristik (und Dateigröße!) holen
            let stats;
            try { stats = fs.statSync(standardPath); } catch(e) {}
            
            if (stats) {
                // NEU: Dateigröße IMMER in die Updates schreiben
                sizeUpdates[id] = stats.size;

                // Optimierung: Überspringe Hash-Berechnung, wenn 'onlySubset' aktiv ist, 
                // die Datei als 'ok' markiert ist und bereits einen Hash hat.
                const isKnownGood = onlySubset && entry.integrityStatus === 'ok' && entry.hash;
                
                let currentHash = entry.hash;
                if (!currentHash && !isKnownGood) {
                    try { currentHash = await getFileHash(standardPath); updates[id] = currentHash; } catch(e) {}
                }
                
                validFiles.push({
                    id,
                    filename: entry.filename,
                    year,
                    month,
                    size: stats.size,
                    mtime: stats.mtimeMs,
                    hash: currentHash
                });
            }
        }
    }

    // 1. Hash basierte Duplikate
    validFiles.forEach(f => {
        if(f.hash) {
             if (!hashRegistry[f.hash]) hashRegistry[f.hash] = [];
             hashRegistry[f.hash].push(f.id);
        }
    });

    // 2. Heuristische Duplikate (Dateiname (1) + Gleiche Größe + Gleiches Datum)
    // Map für schnellen Zugriff auf "saubere" Dateinamen
    const fileLookup = new Map(); // Key: "Year|Month|Filename" -> FileObj
    validFiles.forEach(f => fileLookup.set(`${f.year}|${f.month}|${f.filename}`, f));

    // Regex für "Name (1).ext"
    const copyRegex = /^(.*?)\s\(\d+\)(\.[^.]+)$/;

    validFiles.forEach(f => {
        const match = f.filename.match(copyRegex);
        if (match) {
            const cleanName = match[1] + match[2]; // Base + Ext
            const cleanKey = `${f.year}|${f.month}|${cleanName}`;
            const cleanFile = fileLookup.get(cleanKey);

            if (cleanFile) {
                // Vergleich: Gleiche Größe und Datum (Toleranz 2s für Dateisystem-Unterschiede)
                const timeDiff = Math.abs(f.mtime - cleanFile.mtime);
                if (f.size === cleanFile.size && timeDiff < 2000) {
                     // Treffer! Wir gruppieren diese Dateien.
                     // Falls beide Hashes haben, sind sie schon in Schritt 1 erfasst.
                     // Falls nicht, erstellen wir eine künstliche Gruppe.
                     
                     // Wir nutzen einen synthetischen Key, falls kein gemeinsamer Hash existiert
                     let groupKey = cleanFile.hash || f.hash || `HEURISTIC_${cleanFile.id}_${f.size}`;
                     
                     if (!hashRegistry[groupKey]) hashRegistry[groupKey] = [];
                     
                     if (!hashRegistry[groupKey].includes(cleanFile.id)) hashRegistry[groupKey].push(cleanFile.id);
                     if (!hashRegistry[groupKey].includes(f.id)) hashRegistry[groupKey].push(f.id);
                }
            }
        }
    });

    const duplicates = Object.entries(hashRegistry).filter(([_, ids]) => ids.length > 1).map(([hash, ids]) => ({ hash, ids }));
    // NEU: sizeUpdates zurückgeben
    return { missing, duplicates, updates, sizeUpdates, total: entries.length };
});

// NEU: Sucht nach Dateien wie "IMG_1234 (1).jpg", wo "IMG_1234.jpg" NICHT existiert
ipcMain.handle('find-renamable-files', async (event, { basePath, files }) => {
    const candidates = [];
    const entries = Object.entries(files);
    
    // Regex für "Name (ZAHL).ext"
    const suffixRegex = /^(.*?)\s\(\d+\)(\.[^.]+)$/;

    for (const [id, entry] of entries) {
        const match = entry.filename.match(suffixRegex);
        if (match) {
            // Es ist ein Kandidat: "Name (1).jpg"
            const cleanName = match[1] + match[2]; // "Name.jpg"
            
            const dateObj = new Date(entry.timestamp);
            const year = dateObj.getFullYear().toString();
            const month = (dateObj.getMonth() + 1).toString().padStart(2, '0');
            
            const dir = path.join(basePath, year, month);
            const currentPath = path.join(dir, entry.filename);
            const targetPath = path.join(dir, cleanName);
            
            // Check 1: Existiert die aktuelle Datei überhaupt?
            if (!fs.existsSync(currentPath)) continue;

            // Check 2: Existiert die Zieldatei (ohne Suffix)?
            // Wenn NEIN, dann KÖNNTEN wir umbenennen.
            if (!fs.existsSync(targetPath)) {
                
                // Check 3: Sicherheits-Check via Original-Name (MUSS vorhanden und identisch sein)
                // Wir benennen NUR um, wenn wir sicher wissen, wie die Datei eigentlich heißen soll.
                if (!entry.originalName || entry.originalName !== cleanName) {
                    continue; 
                }

                candidates.push({
                    id,
                    currentName: entry.filename,
                    newName: cleanName,
                    timestamp: entry.timestamp,
                    path: path.join(year, month) // Nur für Info
                });
            }
        }
    }
    return candidates;
});

ipcMain.handle('rename-file', async (event, { basePath, oldName, newName, timestamp }) => {
    const dateObj = new Date(timestamp);
    const year = dateObj.getFullYear().toString();
    const month = (dateObj.getMonth() + 1).toString().padStart(2, '0');
    const dir = path.join(basePath, year, month);
    
    const oldPath = path.join(dir, oldName);
    const newPath = path.join(dir, newName);

    try {
        if (!fs.existsSync(oldPath)) return false;
        if (fs.existsSync(newPath)) return false; // Sicherheit
        
        fs.renameSync(oldPath, newPath);
        return true;
    } catch (e) {
        console.error("Rename failed", e);
        return false;
    }
});

ipcMain.handle('clear-session-cache', async () => {
    try { await mainWindow.webContents.session.clearStorageData(); return true; } catch(e) { return false; }
});

ipcMain.handle('prepare-download', async (event, config) => {
    nextDownloadConfig = { active: true, id: config.id, targetDir: config.targetDir, dateTimestamp: config.dateTimestamp };
    return true;
});

ipcMain.handle('delete-file', async (event, { basePath, filename, timestamp }) => {
    const dateObj = new Date(timestamp);
    const year = dateObj.getFullYear().toString();
    const month = (dateObj.getMonth() + 1).toString().padStart(2, '0');
    const filePath = path.join(basePath, year, month, filename);
    if (fs.existsSync(filePath)) { try { fs.unlinkSync(filePath); return true; } catch(e) { return false; } }
    return true; 
});

ipcMain.handle('check-file-exists', async (event, { basePath, filename, timestamp }) => {
    const dateObj = new Date(timestamp);
    const year = dateObj.getFullYear().toString();
    const month = (dateObj.getMonth() + 1).toString().padStart(2, '0');
    const filePath = path.join(basePath, year, month, filename);
    return fs.existsSync(filePath);
});

ipcMain.handle('show-item-in-folder', async (event, fullPath) => {
    if (fullPath) shell.showItemInFolder(fullPath);
});

// --- METADATA & FILE UTILS ---

function getFileHash(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('error', err => reject(err));
        stream.on('data', chunk => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
    });
}

function updateFileTimestamps(filePath, dateObj) {
    return new Promise((resolve) => {
        try { fs.utimesSync(filePath, dateObj, dateObj); } catch (e) { console.error("utimes Error:", e); }

        if (process.platform === 'win32') {
             const year = dateObj.getFullYear();
             const month = dateObj.getMonth() + 1; 
             const day = dateObj.getDate();
             const hours = dateObj.getHours();
             const minutes = dateObj.getMinutes();
             const seconds = dateObj.getSeconds();
             const safePath = filePath.replace(/'/g, "''");
             const dateCmd = `Get-Date -Year ${year} -Month ${month} -Day ${day} -Hour ${hours} -Minute ${minutes} -Second ${seconds}`;
             const cmd = `powershell.exe -NoProfile -Command "$date = ${dateCmd}; $item = Get-Item -LiteralPath '${safePath}'; $item.CreationTime = $date; $item.LastWriteTime = $date; $item.LastAccessTime = $date"`;
             exec(cmd, (err) => { if(err) console.error("PowerShell TS Error:", err); resolve(); });
        } else {
            resolve();
        }
    });
}

function updateExifData(filePath, binaryData, dateObj) {
    try {
        let exifObj;
        try { exifObj = piexif.load(binaryData); } catch (e) { exifObj = { "0th": {}, "Exif": {}, "GPS": {} }; }
        const exifDateStr = formatExifLike(dateObj);
        exifObj["Exif"][piexif.ExifIFD.DateTimeOriginal] = exifDateStr;
        exifObj["Exif"][piexif.ExifIFD.DateTimeDigitized] = exifDateStr;
        exifObj["0th"][piexif.ImageIFD.DateTime] = exifDateStr;
        const newBinary = piexif.insert(piexif.dump(exifObj), binaryData);
        fs.writeFileSync(filePath, Buffer.from(newBinary, 'binary'));
    } catch (e) { console.error("EXIF Write Error:", e); }
}

// ASYNC IMPLEMENTATION OF VIDEO METADATA READER
async function readVideoMetadataAsync(filePath) {
    let fileHandle;
    try {
        fileHandle = await fsPromises.open(filePath, 'r');
        const stats = await fileHandle.stat();
        const size = stats.size;
        let pos = 0;
        
        while (pos < size) {
            // Read 8 bytes for size and type
            const buffer = Buffer.alloc(8);
            const readResult = await fileHandle.read(buffer, 0, 8, pos);
            if (readResult.bytesRead < 8) break;
            
            const sizeUInt32 = buffer.readUInt32BE(0);
            const type = buffer.toString('ascii', 4, 8);
            
            let atomSize = sizeUInt32;
            let headerSize = 8;
            
            if (sizeUInt32 === 1) {
                const size64Buf = Buffer.alloc(8);
                await fileHandle.read(size64Buf, 0, 8, pos + 8);
                atomSize = Number(size64Buf.readBigUInt64BE(0));
                headerSize = 16;
            }
            
            if (type === 'moov') {
                // Enter container
                pos += headerSize;
                continue;
            }
            
            if (type === 'mvhd') {
                // Read version
                const verBuf = Buffer.alloc(1);
                await fileHandle.read(verBuf, 0, 1, pos + headerSize);
                const version = verBuf.readUInt8(0);
                
                let mp4Time = 0;
                if (version === 0) {
                    const tBuf = Buffer.alloc(4);
                    await fileHandle.read(tBuf, 0, 4, pos + headerSize + 4);
                    mp4Time = tBuf.readUInt32BE(0);
                } else {
                    const tBuf = Buffer.alloc(8);
                    await fileHandle.read(tBuf, 0, 8, pos + headerSize + 4);
                    mp4Time = Number(tBuf.readBigUInt64BE(0));
                }
                
                await fileHandle.close();
                if (mp4Time === 0) return null;
                return new Date((mp4Time - 2082844800) * 1000);
            }
            
            if (atomSize === 0) break;
            pos += atomSize;
            
            // Safety break for very broken files
            if (pos > size) break;
        }
    } catch (e) {
        console.error("Read Video Meta Async Failed", e);
    } finally {
        if (fileHandle) await fileHandle.close();
    }
    return null;
}

// ASYNC IMPLEMENTATION OF VIDEO METADATA WRITER
async function updateVideoMetadataAsync(filePath, dateObj) {
    let fileHandle;
    try {
        fileHandle = await fsPromises.open(filePath, 'r+');
        const stats = await fileHandle.stat();
        const unixSeconds = Math.floor(dateObj.getTime() / 1000);
        const mp4Time = unixSeconds + 2082844800;
        
        const containers = ['moov', 'trak', 'mdia'];
        const atomsToPatch = ['mvhd', 'tkhd', 'mdhd'];
        
        // Recursive async processor
        const processRange = async (startPos, endPos) => {
            let pos = startPos;
            while (pos < endPos) {
                const buffer = Buffer.alloc(8);
                const readResult = await fileHandle.read(buffer, 0, 8, pos);
                if (readResult.bytesRead < 8) break;
                
                let size = buffer.readUInt32BE(0);
                const type = buffer.toString('ascii', 4, 8);
                let headerSize = 8;
                let atomSize = size;
                
                if (size === 1) {
                     const size64Buf = Buffer.alloc(8);
                     await fileHandle.read(size64Buf, 0, 8, pos + 8);
                     atomSize = Number(size64Buf.readBigUInt64BE(0));
                     headerSize = 16;
                } else if (size === 0) {
                    atomSize = endPos - pos;
                }
                
                if (atomsToPatch.includes(type)) {
                    const verBuf = Buffer.alloc(1);
                    await fileHandle.read(verBuf, 0, 1, pos + headerSize);
                    const version = verBuf.readUInt8(0);
                    const dataOffset = pos + headerSize + 4;
                    
                    if (version === 0) {
                        const timeBuf = Buffer.alloc(4);
                        timeBuf.writeUInt32BE(mp4Time);
                        await fileHandle.write(timeBuf, 0, 4, dataOffset);
                        await fileHandle.write(timeBuf, 0, 4, dataOffset + 4);
                    } else {
                        const timeBuf = Buffer.alloc(8);
                        timeBuf.writeBigUInt64BE(BigInt(mp4Time));
                        await fileHandle.write(timeBuf, 0, 8, dataOffset);
                        await fileHandle.write(timeBuf, 0, 8, dataOffset + 8);
                    }
                }
                
                if (containers.includes(type)) {
                    await processRange(pos + headerSize, pos + atomSize);
                }
                
                pos += atomSize;
                
                // Allow event loop to breathe
                await new Promise(resolve => setImmediate(resolve));
            }
        };
        
        await processRange(0, stats.size);
        
    } catch (e) {
        console.error("[Video] Meta Async Update Failed:", e);
    } finally {
        if (fileHandle) await fileHandle.close();
    }
}