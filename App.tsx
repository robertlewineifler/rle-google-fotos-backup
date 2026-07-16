

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { ProcessingLog, DownloadedFile, DownloadResult, FileDatabase, ScannedRange, DatabaseEntry, IntegrityResult, DownloadProgress, IntegrityError, RenamableFile } from './types';
import { parseGoogleDateString, parseExifDateToDate, getIsoDateString } from './utils/exifUtils';
import * as Crawler from './logic/crawlerActions';
import * as DbUtils from './logic/databaseUtils';
import { StartupScreen } from './components/StartupScreen';
import { IntegrityReportModal, CorrectionModal, RenameModal } from './components/ActionModals';
import { ScanHeatmapModal } from './components/ScanHeatmap';

const App: React.FC = () => {
  // --- UI State ---
  const [isInitialized, setIsInitialized] = useState(false);
  const [logs, setLogs] = useState<ProcessingLog[]>([]); 
  const [exportPath, setExportPath] = useState<string | null>(null);
  const [dbFilePath, setDbFilePath] = useState<string | null>(null);
  
  const [isWalking, setIsWalking] = useState(false);
  const [isChecking, setIsChecking] = useState(false); // NEU: Lade-Status für Checks
  const [processedCount, setProcessedCount] = useState(0);
  const [downloadedFiles, setDownloadedFiles] = useState<DownloadedFile[]>([]);
  const [scannedDays, setScannedDays] = useState<Record<string, number>>({});
  
  // Neuer State für den Batch-Fortschritt
  const [batchCount, setBatchCount] = useState(0);

  // State für mehrere parallele Downloads (Filename -> Progress)
  const [activeProgress, setActiveProgress] = useState<Record<string, DownloadProgress>>({});
  const [activeDownloadsCount, setActiveDownloadsCount] = useState(0);

  // --- Database & Tracking State (Refs) ---
  const dbRef = useRef<FileDatabase>({ basePath: '', lastUpdated: 0, files: {}, scannedDays: {} });
  const processedIdsRef = useRef<Set<string>>(new Set());
  const sessionSeenIds = useRef<Set<string>>(new Set());
  const minDateEncountered = useRef<number | null>(null);
  const maxDateEncountered = useRef<number | null>(null);
  
  // --- Asynchronous Pipeline State ---
  const activeDownloadsRef = useRef(0);
  const pendingStartResolvers = useRef<Map<string, () => void>>(new Map());
  const isResettingRef = useRef(false); // NEU: Verhindert IPC nach Reset

  // --- Orphans, Duplicates & Missing ---
  const [orphans, setOrphans] = useState<{id: string, entry: DatabaseEntry}[]>([]);
  const [integrityResult, setIntegrityResult] = useState<IntegrityResult | null>(null);
  const [renamableFiles, setRenamableFiles] = useState<RenamableFile[]>([]); // NEU
  
  // CORRECTIONS & MODALS STATE
  const [showCorrectionModal, setShowCorrectionModal] = useState(false);
  // correctionTab removed as per request (now combined view)
  
  const [showIntegrityModal, setShowIntegrityModal] = useState(false);
  const [showHeatmapModal, setShowHeatmapModal] = useState(false);
  const [showRenameModal, setShowRenameModal] = useState(false); // NEU

  // --- Refs ---
  const webviewRef = useRef<any>(null);
  const tableContainerRef = useRef<HTMLDivElement>(null);
  const logContainerRef = useRef<HTMLDivElement>(null);
  const isWalkingRef = useRef(false);
  
  // --- Computed Stats ---
  // Zählt, an wie vielen Tagen das Programm tatsächlich benutzt wurde (Scan-Aktivität)
  const uniqueUsageDays = useMemo(() => {
      const dates = new Set<string>();
      Object.values(scannedDays).forEach(ts => {
          dates.add(new Date(ts as number).toLocaleDateString());
      });
      return dates.size;
  }, [scannedDays]);

  // Berechne Anzahl defekter Dateien (für den Button)
  const corruptFilesCount = useMemo(() => {
      if (!isInitialized) return 0;
      return (Object.values(dbRef.current.files) as DatabaseEntry[]).filter(f => f.integrityStatus === 'corrupt').length;
  }, [processedCount, isInitialized, showIntegrityModal]); // Recalc on updates

  // --- Helper Functions ---
  const addLog = (message: string, type: 'info' | 'error' | 'success' | 'debug' | 'warning' = 'info') => {
    // Check if resetting to avoid state updates on unmounted/reset components
    if (isResettingRef.current) return;

    if (window.electron && window.electron.logToConsole) {
        window.electron.logToConsole(message, type);
    }
    
    const isRelevantForUI = 
        type === 'error' || 
        type === 'success' || 
        type === 'warning' ||
        message.includes('Backup') || 
        message.includes('Datenbank') ||
        message.includes('Bereinigung') ||
        message.includes('Status') ||
        message.includes('Web') ||
        message.includes('Bereits') ||
        message.includes('Bekannt') || 
        message.includes('vermisst') ||
        message.includes('Warte') ||
        message.includes('Umbenannt') ||
        message.includes('Verschoben') ||
        message.includes('Metadaten') ||
        message.includes('Tageswechsel') ||
        message.includes('Batch') ||
        message.includes('Scan-Log');

    if (isRelevantForUI) {
        setLogs(prev => {
            const newLogs = [...prev, { timestamp: Date.now(), message, type }];
            if (newLogs.length > 100) return newLogs.slice(newLogs.length - 100);
            return newLogs;
        });
    }
  };
  
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

  // --- HELPER: Safe Crawler Calls with Timeout ---
  // Das verhindert, dass das Programm hängt, wenn das Webview nicht antwortet
  const safeExtractInfo = async () => {
      if (!webviewRef.current) return null;
      try {
          const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 3000));
          const result = await Promise.race([
              Crawler.extractCurrentImageInfo(webviewRef.current),
              timeoutPromise
          ]);
          return result as {id: string, dateStr: string, foundInSidePanel: boolean, potentialFilename?: string};
      } catch (e: any) {
          // NEU: Fehler beim Reset ignorieren
          if (e.message && e.message.includes('GUEST_VIEW_MANAGER_CALL')) return null;
          return null;
      }
  };

  // --- GLOBAL ELECTRON LISTENER (PIPELINE) ---
  useEffect(() => {
      if(window.electron) {
          window.electron.onDownloadStarted((id: string) => {
               const resolver = pendingStartResolvers.current.get(id);
               if (resolver) {
                   resolver(); 
                   pendingStartResolvers.current.delete(id);
               }
          });

          window.electron.onDownloadComplete(async (result: DownloadResult) => {
              activeDownloadsRef.current = Math.max(0, activeDownloadsRef.current - 1);
              setActiveDownloadsCount(activeDownloadsRef.current);
              
              if (isResettingRef.current) return; // Ignore updates if resetting

              setActiveProgress(prev => {
                  const next = { ...prev };
                  const keyToRemove = result.progressFilename || result.filename;
                  delete next[keyToRemove];
                  return next;
              });

              if (result.success) {
                  const ext = result.filename.split('.').pop()?.toLowerCase();
                  const isVideo = ['mp4', 'mov', 'm4v', 'avi', '3gp', 'mpg'].includes(ext || '');
                  const originalExifDate = parseExifDateToDate(result.originalExifDate || "");
                  const finalDate = new Date(result.finalDateTimestamp || Date.now());

                  let isMatch = true;
                  if (originalExifDate) {
                      const diff = Math.abs(finalDate.getTime() - originalExifDate.getTime());
                      if (diff > 60000) isMatch = false; 
                  }
                  
                  if (!isMatch && originalExifDate) {
                      addLog(`Datum korrigiert: ${result.filename} (Original: ${originalExifDate.toLocaleString()} -> Web: ${finalDate.toLocaleString()})`, 'warning');
                  }

                  const entry: DownloadedFile = {
                      id: result.id, originalName: result.originalName, fileName: result.filename,
                      webDate: finalDate, fileDate: finalDate, originalExifDate: originalExifDate,
                      isMatch: isMatch, wasAdjusted: true, type: isVideo ? 'video' : 'image', status: isMatch ? 'OK' : 'Manuell', path: result.path
                  };
                  
                  setDownloadedFiles(prev => [...prev, entry].slice(-100));
                  
                  // DB UPDATE: Jetzt mit originalName
                  dbRef.current.files[result.id] = {
                      filename: result.filename, 
                      originalName: result.originalName, // NEU: Originalname speichern für spätere Bereinigung
                      timestamp: finalDate.getTime(), 
                      savedAt: Date.now(),
                      downloadedAt: Date.now(), 
                      scannedAt: Date.now(), 
                      originalDate: result.originalExifDate, 
                      hash: result.hash,
                      // WICHTIG: Integrity Status NICHT auf 'ok' setzen, sondern offen lassen (undefined).
                      // Damit gilt die Datei als "ungeprüft" im Dashboard und kann validiert werden.
                  };

                  setProcessedCount(prev => prev + 1);
                  addLog(`Download fertig: ${result.filename}`, 'success');
              } else {
                  addLog(`Fehler beim Download (${result.id}): ${result.error}`, 'error');
              }
          });

          window.electron.onDownloadProgress((progress: DownloadProgress) => {
             if (isResettingRef.current) return;
             setActiveProgress(prev => ({
                 ...prev,
                 [progress.filename]: progress
             }));
          });
      }
      return () => {
          if(window.electron) window.electron.removeDownloadListener();
      }
  }, []);

  const updateOrphansList = () => {
      if (!dbRef.current.files) return;
      const missingFiles = (Object.entries(dbRef.current.files) as [string, DatabaseEntry][])
          .filter(([_, entry]) => !!entry.missingSince)
          .map(([id, entry]) => ({ id, entry }));
      setOrphans(missingFiles);
  };

  useEffect(() => { if (isInitialized) updateOrphansList(); }, [isInitialized]);

  // --- INITIALIZATION HANDLERS ---
  const handleInitLoadDatabase = async () => {
    if (!window.electron) return;
    const filePath = await window.electron.selectDatabaseFile();
    if (!filePath) return; 

    const isWindows = filePath.includes('\\');
    const separator = isWindows ? '\\' : '/';
    const basePath = filePath.substring(0, filePath.lastIndexOf(separator));

    try {
        const loadedDb = await window.electron.loadDatabase(filePath);
        if (loadedDb) {
            dbRef.current = loadedDb;
            dbRef.current.dbFilePath = filePath;
            dbRef.current.basePath = basePath;
            // Falls alte DB ohne scannedDays, initialisieren
            if (!dbRef.current.scannedDays) dbRef.current.scannedDays = {};
            
            processedIdsRef.current = new Set(Object.keys(loadedDb.files));
            setScannedDays(dbRef.current.scannedDays);
            setExportPath(basePath);
            setDbFilePath(filePath);
            updateOrphansList();
            setIsInitialized(true); 
            isResettingRef.current = false;
            setTimeout(() => addLog(`Datenbank geladen: ${filePath}`, 'success'), 500);
            setTimeout(() => addLog(`${Object.keys(loadedDb.files).length} Dateien bekannt.`, 'info'), 600);
        } else {
             alert("Datei konnte nicht gelesen werden oder ist leer.");
        }
    } catch (e: any) {
        console.error(e);
        alert("Fehler beim Laden der Datenbank: " + e.message);
    }
  };

  const handleInitNewDatabase = async () => {
      if (!window.electron) return;
      const basePath = await window.electron.selectDirectory();
      if (!basePath) return;

      const isWindows = basePath.includes('\\');
      const separator = isWindows ? '\\' : '/';
      const filePath = basePath + separator + 'gphotos_db.json';

      try {
        dbRef.current = {
            basePath: basePath,
            dbFilePath: filePath,
            lastUpdated: Date.now(),
            files: {},
            scannedDays: {} // Initial leer
        };
        processedIdsRef.current = new Set();
        setScannedDays({});
        setExportPath(basePath);
        setDbFilePath(filePath);
        setOrphans([]);
        
        let existing = null;
        try { existing = await window.electron.loadDatabase(filePath); } catch (e) { /* ignore */ }
        
        setIsInitialized(true);
        isResettingRef.current = false;
        setTimeout(() => {
            if (existing) addLog(`ACHTUNG: Datenbank existiert bereits.`, 'info');
            else addLog(`Neue Datenbank erstellt: ${filePath}`, 'success');
        }, 500);
      } catch (e: any) {
          console.error(e);
          alert("Fehler beim Initialisieren: " + e.message);
      }
  };

  // --- DATABASE OPERATIONS ---
  const saveDatabase = async () => {
      if (!dbFilePath || !window.electron) return;
      dbRef.current.lastUpdated = Date.now();
      const dbToSave = { ...dbRef.current, basePath: '.' };
      try {
          const success = await window.electron.saveDatabase(dbFilePath, dbToSave);
          if (!success) addLog("WARNUNG: Datenbank konnte nicht gespeichert werden!", 'error');
          else setScannedDays({ ...dbRef.current.scannedDays }); // Update UI
      } catch (err: any) {
          addLog(`DB SAVE ERROR: ${err.message}`, 'error');
      }
  };

  // --- INTEGRITY & CHECKS ---
  
  // Geändert: Führt nicht sofort Logik aus, sondern öffnet das Menü.
  // Das Modal selbst triggert dann die Logik.
  const openIntegrityMenu = () => {
      setIntegrityResult(null); // Reset result
      setShowIntegrityModal(true);
  };
  
  // Callback: Wird vom Modal aufgerufen, wenn Struktur-Check fertig ist
  const handleIntegrityCheckDone = (result: IntegrityResult) => {
      setIntegrityResult(result);
      
      // 1. Auto-Update Hashes in DB
      const updateKeys = Object.keys(result.updates);
      if (updateKeys.length > 0) {
          addLog(`${updateKeys.length} Hashes aktualisiert.`, 'success');
          for(const [id, hash] of Object.entries(result.updates)) {
              if (dbRef.current.files[id]) dbRef.current.files[id].hash = hash;
          }
      }

      // 2. NEU: Auto-Update Sizes in DB
      if (result.sizeUpdates) {
          const sizeKeys = Object.keys(result.sizeUpdates);
          if (sizeKeys.length > 0) {
              addLog(`${sizeKeys.length} Dateigrößen gespeichert.`, 'success');
              for(const [id, size] of Object.entries(result.sizeUpdates)) {
                  if (dbRef.current.files[id]) dbRef.current.files[id].size = size;
              }
          }
      }

      // WICHTIG: Die gerade gefundenen Missing Files sofort als 'vermisst' markieren und zu Orphans hinzufügen
      if (result.missing.length > 0) {
          let newMissingCount = 0;
          result.missing.forEach(m => {
              if(dbRef.current.files[m.id] && !dbRef.current.files[m.id].missingSince) {
                  dbRef.current.files[m.id].missingSince = Date.now();
                  newMissingCount++;
              }
          });
          if(newMissingCount > 0) {
              addLog(`${newMissingCount} neu vermisste Dateien markiert.`, 'warning');
              updateOrphansList(); // Aktualisiert den State für das Modal
          }
      }
      
      saveDatabase();
  };

  // Callback: Wird vom Modal aufgerufen, wenn neue Status-Updates für Dateien vorliegen
  const handleIntegrityStatusUpdate = (updates: Record<string, 'ok' | 'corrupt'>) => {
      let dirty = false;
      Object.entries(updates).forEach(([id, status]) => {
          if (dbRef.current.files[id]) {
              dbRef.current.files[id].integrityStatus = status;
              dbRef.current.files[id].integrityCheckedAt = Date.now();
              dirty = true;
          }
      });
      if (dirty) {
          saveDatabase(); // Silent Save
          setProcessedCount(prev => prev + 1); // Trigger refresh
      }
  };
  
  const handleRemoveCorruptFile = async (id: string) => {
      if (!dbRef.current.files[id] || !window.electron || !exportPath) return false;
      
      const entry = dbRef.current.files[id];
      try {
          // 1. Physisch löschen
          await window.electron.deleteFile({
              basePath: exportPath,
              filename: entry.filename,
              timestamp: entry.timestamp
          });
          
          // 2. DB Eintrag ZURÜCKSETZEN (nicht löschen), damit Download neu getriggert wird
          // delete dbRef.current.files[id]; // <-- ALTE LOGIK
          if (dbRef.current.files[id]) {
              delete dbRef.current.files[id].integrityStatus; // Status reset
              delete dbRef.current.files[id].hash; // Hash reset
          }
          
          await saveDatabase();
          setProcessedCount(prev => prev + 1); // Trigger UI update (corrput count)
          addLog(`Defekte Datei von Platte gelöscht (DB-Eintrag bleibt für Re-Download): ${entry.filename}`, 'success');
          return true;
      } catch(e) {
          addLog(`Fehler beim Löschen: ${entry.filename}`, 'error');
          return false;
      }
  };

  const executeDeleteAllCorrupt = async () => {
      if (!exportPath) return;
      const corrupt = (Object.entries(dbRef.current.files) as [string, DatabaseEntry][])
          .filter(([_, e]) => e.integrityStatus === 'corrupt');
      
      if (corrupt.length === 0) return;
      if (!confirm(`Wirklich alle ${corrupt.length} defekten Dateien von der Festplatte löschen? Sie werden beim nächsten Scan erneut heruntergeladen.`)) return;

      addLog(`Lösche ${corrupt.length} defekte Dateien von Disk...`, 'info');
      
      let deletedCount = 0;
      for (const [id, entry] of corrupt) {
          try {
              await window.electron.deleteFile({
                  basePath: exportPath,
                  filename: entry.filename,
                  timestamp: entry.timestamp
              });
              if (dbRef.current.files[id]) {
                  delete dbRef.current.files[id].integrityStatus;
                  delete dbRef.current.files[id].hash;
              }
              deletedCount++;
          } catch(e) { console.error(e); }
      }
      
      await saveDatabase();
      setProcessedCount(prev => prev + 1);
      addLog(`${deletedCount} defekte Dateien gelöscht. Bereit für Re-Download.`, 'success');
  };
  
  // --- RENAME LOGIC ---
  const scanForRenamableFiles = async () => {
      if (!window.electron || !exportPath || !dbRef.current.files) return;
      addLog("Suche nach unnötigen Nummerierungen...", 'info');
      
      try {
          const candidates = await window.electron.findRenamableFiles(exportPath, dbRef.current.files);
          if (candidates.length > 0) {
              setRenamableFiles(candidates);
              setShowRenameModal(true);
              addLog(`${candidates.length} Dateien können bereinigt werden.`, 'info');
          } else {
              addLog("Keine Dateien zur Bereinigung gefunden.", 'success');
              alert("Keine Dateien gefunden, bei denen die Original-Datei fehlt UND der Original-Name sicher übereinstimmt.");
          }
      } catch (e: any) {
          addLog("Fehler beim Scan: " + e.message, 'error');
      }
  };
  
  const executeRenameFiles = async () => {
      if (!exportPath || renamableFiles.length === 0) return;
      addLog(`Benenne ${renamableFiles.length} Dateien um...`, 'info');
      
      let successCount = 0;
      for (const item of renamableFiles) {
          try {
              const success = await window.electron.renameFile({
                  basePath: exportPath,
                  oldName: item.currentName,
                  newName: item.newName,
                  timestamp: item.timestamp
              });
              
              if (success) {
                  // DB Update
                  if (dbRef.current.files[item.id]) {
                      dbRef.current.files[item.id].filename = item.newName;
                  }
                  successCount++;
              }
          } catch (e) {
              console.error(e);
          }
      }
      
      await saveDatabase();
      setShowRenameModal(false);
      setRenamableFiles([]);
      addLog(`Bereinigung abgeschlossen. ${successCount} Dateien umbenannt.`, 'success');
  };

  const executeCleanLegacy = async () => {
      if (!dbRef.current) return;
      if (!confirm("Veraltete Datenfelder werden aus der Datenbank-Datei entfernt. Die Dateien selbst bleiben unberührt.")) return;
      
      addLog("Bereinige veraltete Datenfelder...", 'info');
      
      // 1. Root Legacy löschen
      if (dbRef.current.scannedRanges) {
          delete dbRef.current.scannedRanges;
      }

      // 2. Entries bereinigen
      const validKeys = new Set([
        'filename', 'timestamp', 'originalDate', 'originalName', 
        'savedAt', 'downloadedAt', 'scannedAt', 'hash', 'missingSince', 'id',
        'integrityStatus', 'integrityCheckedAt', 'size' // NEU: 'size' is valid
      ]);
      
      let cleanedCount = 0;
      for(const id in dbRef.current.files) {
          const entry = dbRef.current.files[id];
          const keys = Object.keys(entry);
          let modified = false;
          
          for(const key of keys) {
              if(!validKeys.has(key)) {
                  // @ts-ignore
                  delete entry[key];
                  modified = true;
              }
          }
          if (modified) cleanedCount++;
      }

      await saveDatabase();
      if (integrityResult) {
          setIntegrityResult({ ...integrityResult, legacyCount: 0 });
      }
      addLog(`Bereinigung fertig. ${cleanedCount} Einträge aktualisiert.`, 'success');
  };

  // --- ACTION HANDLERS ---
  const handleExportCsv = async () => {
      if (!dbFilePath) return;
      try {
          addLog("Exportiere CSV...", 'info');
          const savePath = await DbUtils.exportDatabaseToCsv(dbRef.current.files, dbFilePath);
          addLog(`CSV Exportiert nach: ${savePath}`, 'success');
      } catch (e: any) {
          addLog(e.message, 'error');
      }
  };

  const executeDeleteOrphans = async () => {
      if (!exportPath || orphans.length === 0) return;
      if(!confirm(`Sicher? ${orphans.length} Einträge werden aus der DB entfernt (Dateien fehlen ja bereits).`)) return;
      
      addLog(`Lösche ${orphans.length} vermisste Dateien aus DB...`, 'info');
      try {
        // Hier löschen wir nur aus DB, da Orphan = Datei fehlt physikalisch
        for (const orphan of orphans) {
            delete dbRef.current.files[orphan.id];
            processedIdsRef.current.delete(orphan.id);
        }
        await saveDatabase();
        updateOrphansList();
        addLog("DB Bereinigung abgeschlossen.", 'success');
      } catch (e: any) {
          addLog("Fehler bei Bereinigung: " + e.message, 'error');
      }
  };
  
  const executeResetOrphans = async () => {
      if (orphans.length === 0) return;
      addLog(`Setze Status für ${orphans.length} Dateien zurück...`, 'info');
      try {
          orphans.forEach(o => {
              if (dbRef.current.files[o.id]) delete dbRef.current.files[o.id].missingSince;
          });
          await saveDatabase();
          updateOrphansList();
          addLog("Status zurückgesetzt. Dateien gelten wieder als vorhanden.", 'success');
      } catch (e: any) {
          addLog("Fehler bei Reset: " + e.message, 'error');
      }
  };

  const executeResolveDuplicates = async () => {
      if (!exportPath || !integrityResult || integrityResult.duplicates.length === 0) return;
      if (!confirm(`Soll eine automatische Bereinigung gestartet werden?`)) return;
      
      addLog(`Löse ${integrityResult.duplicates.length} Duplikat-Gruppen auf...`, 'info');
      try {
          const { deletedIds, count } = await DbUtils.resolveDuplicatesOnDisk(integrityResult.duplicates, dbRef.current.files, exportPath);
          for (const id of deletedIds) {
              delete dbRef.current.files[id];
              processedIdsRef.current.delete(id);
          }
          await saveDatabase();
          setIntegrityResult(prev => prev ? ({...prev, duplicates: []}) : null);
          setShowIntegrityModal(false);
          addLog(`Duplikat-Bereinigung fertig. ${count} gelöscht.`, 'success');
      } catch (e: any) {
          addLog("Fehler bei Duplikat-Lösung: " + e.message, 'error');
      }
  };

  // --- UI & MISC HANDLERS ---
  const handleOpenMissingPhoto = (id: string) => {
      if (webviewRef.current) {
          const url = `https://photos.google.com/photo/${id}`;
          webviewRef.current.loadURL(url);
          addLog(`Navigiere zu: ${url}`, 'info');
          // Modal bleibt offen, damit man mehr machen kann, oder schließt sich?
          // User request: "neu heruntergeladen kann".
          // Besser: Modal schließen, damit user interagieren kann? 
          // Der User muss im Webview "D" drücken oder es passiert beim nächsten Scan.
          // Wir schließen das Modal, damit der User das Webview sehen kann.
          setShowCorrectionModal(false);
      }
  };
  
  const handleShowFileInExplorer = async (orphan: { id: string, entry: DatabaseEntry }) => {
      if (!window.electron || !exportPath) return;
      const dateObj = new Date(orphan.entry.timestamp);
      const year = dateObj.getFullYear().toString();
      const month = (dateObj.getMonth() + 1).toString().padStart(2, '0');
      const isWindows = exportPath.includes('\\');
      const sep = isWindows ? '\\' : '/';
      const fullPath = `${exportPath}${sep}${year}${sep}${month}${sep}${orphan.entry.filename}`;
      await window.electron.showItemInFolder(fullPath);
  };

  const resetProgramState = () => {
      // 1. Stop Flag
      isWalkingRef.current = false;
      isResettingRef.current = true; // Block UI updates
      
      // 2. Clear State
      setExportPath(null);
      setDbFilePath(null);
      setLogs([]);
      setDownloadedFiles([]);
      setProcessedCount(0);
      setOrphans([]);
      setIntegrityResult(null);
      setBatchCount(0);
      
      // Reset Modal States
      setShowCorrectionModal(false);
      setShowIntegrityModal(false);
      setShowRenameModal(false); 
      setRenamableFiles([]); 
      
      // 3. Clear Refs
      dbRef.current = { basePath: '', lastUpdated: 0, files: {}, scannedDays: {} };
      processedIdsRef.current = new Set();
      activeDownloadsRef.current = 0;
      setActiveDownloadsCount(0);
      setActiveProgress({});
      pendingStartResolvers.current.clear();
      
      // 4. Force Cleanup of Webview State if possible
      setIsInitialized(false);
      setIsWalking(false);
  };

  const clearCacheAndLogout = async () => {
      if (webviewRef.current) {
          isWalkingRef.current = false;
          addLog("Lösche Cache...", 'info');
          try {
            await window.electron.clearSessionCache();
            webviewRef.current.loadURL('https://accounts.google.com/Logout');
            setProcessedCount(0);
            addLog("Cache geleert.", 'success');
          } catch (e) { addLog("Fehler beim Cache leeren", 'error'); }
      }
  };

  // --- CORE CRAWLER LOGIC ---
  const initiateDownloadAsync = async (info: any, savePath: string): Promise<void> => {
      const webDate = parseGoogleDateString(info.dateStr || "");
      if (isNaN(webDate.getTime())) return;
      
      await window.electron.prepareDownload({
          id: info.id,
          targetDir: savePath,
          dateTimestamp: webDate.getTime()
      });

      const startPromise = new Promise<void>((resolve) => {
          pendingStartResolvers.current.set(info.id, resolve);
          setTimeout(() => {
              if (pendingStartResolvers.current.has(info.id)) {
                  console.error("Timeout waiting for download start:", info.id);
                  pendingStartResolvers.current.delete(info.id);
                  resolve(); 
              }
          }, 15000);
      });

      await Crawler.triggerDownloadKeys(webviewRef.current);
      await startPromise;
      
      activeDownloadsRef.current += 1;
      setActiveDownloadsCount(activeDownloadsRef.current);
      processedIdsRef.current.add(info.id);
  };

  const handleSingleDownload = async () => {
      if (!webviewRef.current || !exportPath) return addLog('Fehler: Kein Zielordner oder Webview nicht bereit.', 'error');
      addLog("Analysiere aktuelles Bild...", 'info');

      try {
          let result = await safeExtractInfo();
          let webDate = parseGoogleDateString(result?.dateStr || "");

          if (!result?.id || isNaN(webDate.getTime())) {
              await Crawler.toggleInfoPanel(webviewRef.current);
              await sleep(800);
              result = await safeExtractInfo();
              webDate = parseGoogleDateString(result?.dateStr || "");
          }

          if (!result?.id || isNaN(webDate.getTime())) {
              return addLog("Konnte Metadaten nicht lesen. Bitte 'i'-Panel prüfen.", 'error');
          }

          const existing = dbRef.current.files[result.id];
          let needsDownload = true;

          if (existing && !existing.missingSince) {
              // NEU: Prüfe physische Existenz, bevor wir "Vorhanden" sagen.
              const exists = await window.electron.checkFileExists({
                  basePath: exportPath,
                  filename: existing.filename,
                  timestamp: existing.timestamp
              });

              if (exists) {
                  needsDownload = false;
                  addLog(`Info: Datei ${result.id} bereits vorhanden. Download übersprungen.`, 'warning');
              } else {
                  addLog(`Datei in DB aber nicht auf Platte. Erzwinge Download...`, 'warning');
                  needsDownload = true;
              }
          }

          if (needsDownload) {
              await initiateDownloadAsync(result, exportPath);
              addLog(`Download für ${result.id} angefordert.`, 'info');
          }

      } catch (e: any) {
          addLog(`Fehler beim Einzeldownload: ${e.message}`, 'error');
      }
  };

  const checkForOrphans = () => {
      if (minDateEncountered.current === null || maxDateEncountered.current === null) return;
      const minTs = minDateEncountered.current;
      const maxTs = maxDateEncountered.current;
      const safeStart = new Date(minTs); safeStart.setHours(0,0,0,0); safeStart.setDate(safeStart.getDate() + 1);
      const safeEnd = new Date(maxTs); safeEnd.setHours(0,0,0,0);
      
      if (safeStart.getTime() >= safeEnd.getTime()) {
          addLog("Keine vollständigen Tage gescannt. Überspringe Missing-Prüfung.", 'info');
          return;
      }
      
      addLog(`Prüfe Missing zwischen ${safeStart.toLocaleDateString()} und ${safeEnd.toLocaleDateString()}...`, 'info');
      let markedCount = 0;
      (Object.entries(dbRef.current.files) as [string, DatabaseEntry][]).forEach(([id, entry]) => {
          if (entry.timestamp >= safeStart.getTime() && entry.timestamp < safeEnd.getTime()) {
              if (!sessionSeenIds.current.has(id)) {
                  if (!entry.missingSince) {
                      entry.missingSince = Date.now();
                      markedCount++;
                      addLog(`Vermisst: ${entry.filename}`, 'error');
                  }
              }
          }
      });
      if (markedCount > 0) {
          updateOrphansList();
          addLog(`${markedCount} Dateien als 'vermisst' markiert.`, 'error');
      } else {
          addLog("Alles synchron.", 'success');
      }
  };

  const stopWalkthrough = async () => {
      isWalkingRef.current = false;
      addLog("Stoppe angefordert...", 'warning');
      await saveDatabase();
      addLog("Sicherheits-Speicherung durchgeführt.", 'success');
  };
  
  const finishBackupSession = () => {
      if (isResettingRef.current) return;

      checkForOrphans();
      
      // Hinweis: Die "scannedRanges" Logik wurde hier entfernt, da wir jetzt pro Tag (scannedDays) speichern.
      // Die Aktualisierung der scannedDays passiert live in der Schleife bei Tageswechsel.

      if (dbFilePath && (processedIdsRef.current.size > 0 || minDateEncountered.current)) {
          saveDatabase().then(() => addLog("Datenbank gespeichert.", 'success'));
      }
      
      setIsWalking(false); 
      addLog("Backup-Vorgang beendet.", 'success');
      pendingStartResolvers.current.clear();
  };

  const updateRangeTracking = (timestamp: number) => {
      if (!minDateEncountered.current || timestamp < minDateEncountered.current) minDateEncountered.current = timestamp;
      if (!maxDateEncountered.current || timestamp > maxDateEncountered.current) maxDateEncountered.current = timestamp;
  };

  const navigateAndVerifyChange = async (oldId: string): Promise<boolean> => {
      await Crawler.navigateNext(webviewRef.current);
      
      // NEU: Sofort nach Navigation Video-Killer feuern
      await Crawler.killVideoPlayers(webviewRef.current);

      let retries = 0;
      while (retries < 30) {
          if (!isWalkingRef.current) return false;
          await sleep(200);
          
          // Wir benutzen hier die lightweight-ID extraction ohne DOM-Scan
          const newId = await Crawler.extractIdFromUrl(webviewRef.current);
          if (newId && newId !== oldId) return true; 
          retries++;
      }
      addLog("Navigation Timeout - Kein neues Bild gefunden.", 'error');
      return false;
  };

  const startWalkthrough = async () => {
    if (!webviewRef.current || !exportPath) return addLog('Fehler: Kein Zielordner.', 'error');
    if (webviewRef.current.getURL().includes('/album/')) return addLog("FEHLER: Downloads aus Alben deaktiviert.", 'error');
    if (!webviewRef.current.getURL().includes('/photo/')) return addLog('Bitte öffne zuerst ein Bild!', 'error');

    isWalkingRef.current = true;
    setIsWalking(true);
    setProcessedCount(0);
    setBatchCount(0);
    sessionSeenIds.current = new Set();
    minDateEncountered.current = null;
    maxDateEncountered.current = null;
    isResettingRef.current = false;
    addLog('Starte Turbo-Backup (Parallel)...', 'info');
    
    await Crawler.toggleInfoPanel(webviewRef.current);
    await sleep(1000);

    let consecutiveErrors = 0;
    let currentId = await Crawler.extractIdFromUrl(webviewRef.current);
    let lastSaveTime = Date.now();
    let batchCounter = 0; 
    let lastDayIdentifier: string | null = null; // NEU: Tracking für Tageswechsel ("YYYY-MM-DD")
    let firstDayIdentifier: string | null = null; // NEU: Verhindert, dass der erste (unvollständige) Tag als fertig markiert wird

    while (isWalkingRef.current) {
        if (batchCounter >= 1000) {
             addLog("⚠️ Batch-Limit (1000) erreicht. Sicherheits-Pause...", 'warning');
             if (activeDownloadsRef.current > 0) {
                 addLog(`Warte auf ${activeDownloadsRef.current} aktive Downloads...`, 'info');
                 while(activeDownloadsRef.current > 0) {
                     if(!isWalkingRef.current) break;
                     await sleep(200);
                 }
             }
             await saveDatabase();
             await sleep(1500);
             batchCounter = 0;
             setBatchCount(0);
             addLog("✅ Daten gesichert. Setze Scan fort...", 'success');
        }

        while (activeDownloadsRef.current >= 5) {
             if (!isWalkingRef.current) break; 
             await sleep(500);
        }
        
        if (!isWalkingRef.current) break;

        try {
            if (Date.now() - lastSaveTime > 30000) {
                await saveDatabase();
                lastSaveTime = Date.now();
            }

            // --- 1. Metadaten lesen (mit Timeout) ---
            let result: any = null;
            let attempts = 0;
            
            while (attempts < 5) { 
                if (!isWalkingRef.current) break;
                
                result = await safeExtractInfo(); // NEU: Timeout Wrapper
                
                const validDate = result && !isNaN(parseGoogleDateString(result.dateStr || "").getTime());
                if (validDate) break;
                
                await sleep(500); 
                attempts++;
            }
            
            if (!isWalkingRef.current) break;

            const webDate = parseGoogleDateString(result?.dateStr || "");
            const webTimestamp = webDate.getTime();

            // --- 2. Fehlerbehandlung (Datum nicht lesbar) ---
            if (isNaN(webTimestamp)) {
                consecutiveErrors++;
                addLog(`Datum nicht lesbar für ${currentId}. Versuche Reload (L/R)...`, 'warning');
                
                await Crawler.navigatePrevious(webviewRef.current);
                await sleep(500); // Kürzere Wartezeit
                if (!isWalkingRef.current) break;
                await Crawler.navigateNext(webviewRef.current);
                await Crawler.killVideoPlayers(webviewRef.current);
                await sleep(250); // Nur kurz warten für Transition, dann übernimmt die Hauptschleife das Polling
                
                currentId = await Crawler.extractIdFromUrl(webviewRef.current);
                
                if (consecutiveErrors >= 3) {
                    addLog("Trotz Reload keine Daten. Überspringe Bild...", 'error');
                    const changed = await navigateAndVerifyChange(currentId);
                    if (changed) { 
                        currentId = await Crawler.extractIdFromUrl(webviewRef.current); 
                        consecutiveErrors = 0; 
                        continue; 
                    } else { 
                        break; 
                    } 
                }
                continue; 
            }
            
            consecutiveErrors = 0;

            // NEU: Tageswechsel-Erkennung & Scan-Log
            // Wir erzeugen einen Schlüssel YYYY-MM-DD
            const currentDayIdentifier = getIsoDateString(webDate);
            
            // Initialisierung des allerersten Tages der Session
            if (firstDayIdentifier === null) {
                firstDayIdentifier = currentDayIdentifier;
            }
            
            // Wenn wir den Tag gewechselt haben (z.B. von "2023-12-05" auf "2023-12-04"),
            // dann ist der alte Tag (lastDayIdentifier) nun fertig gescannt.
            if (lastDayIdentifier !== null && lastDayIdentifier !== currentDayIdentifier) {
                
                // WICHTIG: Den ERSTEN Tag der Session nicht als fertig markieren, da wir mitten im Tag gestartet sein könnten.
                if (lastDayIdentifier !== firstDayIdentifier) {
                    if (!dbRef.current.scannedDays) dbRef.current.scannedDays = {};
                    dbRef.current.scannedDays[lastDayIdentifier] = Date.now();
                    
                    addLog(`📅 Scan-Log: ${lastDayIdentifier} erledigt.`, 'success');
                    await saveDatabase(); // Sofort speichern
                    batchCounter = 0;     // Batch Reset, da gespeichert
                    setBatchCount(0);
                } else {
                    // Optionales Log zur Info
                    addLog(`📅 Scan-Log: ${lastDayIdentifier} übersprungen (Start-Tag unsicher).`, 'info');
                }
            }
            lastDayIdentifier = currentDayIdentifier;

            updateRangeTracking(webTimestamp);
            sessionSeenIds.current.add(result.id);

            // --- 3. Download Entscheidung & Metadaten Update ---
            let needsDownload = false;
            let dbDirty = false;

            if (processedIdsRef.current.has(result.id)) {
                const existingEntry = dbRef.current.files[result.id];
                if (existingEntry) {
                    // NEU: Prüfe, ob die Datei physisch existiert
                    const fileExists = await window.electron.checkFileExists({
                        basePath: exportPath,
                        filename: existingEntry.filename,
                        timestamp: existingEntry.timestamp
                    });

                    if (!fileExists) {
                        addLog(`⚠️ Datei fehlt lokal: ${existingEntry.filename} -> Download`, 'warning');
                        needsDownload = true;
                    } else {
                        // Datei existiert -> Prüfe Metadaten
                        let metaUpdated = false;

                        // A: Missing-Status aufheben
                        if (existingEntry.missingSince) {
                             delete existingEntry.missingSince; 
                             metaUpdated = true;
                             dbDirty = true;
                             addLog(`✅ Status korrigiert: ${existingEntry.filename} wiedergefunden.`, 'success');
                        }

                        // B: Original Name aktualisieren (falls im Crawl gefunden und in DB fehlend/anders)
                        // Wir nehmen an, dass 'potentialFilename' aus dem Crawler der Titel aus der Info-Sidebar ist.
                        if (result.potentialFilename && (!existingEntry.originalName || existingEntry.originalName !== result.potentialFilename)) {
                             const oldNameLog = existingEntry.originalName || "(keiner)";
                             existingEntry.originalName = result.potentialFilename;
                             metaUpdated = true;
                             dbDirty = true;
                             addLog(`📝 Metadaten: Original-Name aktualisiert (${oldNameLog} -> ${result.potentialFilename})`, 'info');
                        }

                        // C: Datum korrigieren UND Datei verschieben
                        if (Math.abs(existingEntry.timestamp - webTimestamp) > 60000) {
                            const oldDateStr = new Date(existingEntry.timestamp).toLocaleString();
                            const newDateStr = new Date(webTimestamp).toLocaleString();
                            addLog(`📂 Verschiebe Datei: "${existingEntry.filename}"...`, 'warning');
                            
                            const moveResult = await window.electron.moveAndUpdateFile({
                                basePath: exportPath,
                                oldFilename: existingEntry.filename,
                                oldTimestamp: existingEntry.timestamp,
                                newTimestamp: webTimestamp
                            });

                            if (moveResult.success) {
                                existingEntry.timestamp = webTimestamp;
                                if (moveResult.newFilename) existingEntry.filename = moveResult.newFilename;
                                metaUpdated = true;
                                dbDirty = true;
                                addLog(`✅ Verschoben: ${oldDateStr} -> ${newDateStr}. Pfad angepasst.`, 'success');
                            } else {
                                addLog(`❌ Fehler beim Verschieben: ${moveResult.error}`, 'error');
                            }
                        }

                        existingEntry.scannedAt = Date.now();

                        // D: Log für bekannte Dateien (nur wenn keine relevante Änderung war, als 'Bekannt')
                        if (!metaUpdated) {
                            addLog(`Bekannt: ${existingEntry.filename} (Übersprungen)`, 'debug');
                        }
                    }
                } else {
                    needsDownload = true;
                }
            } else {
                needsDownload = true;
            }
            
            if (dbDirty) {
                // Optional: Sofort speichern bei wichtigen Änderungen oder Debouncen lassen
            }

            if (needsDownload) {
                await initiateDownloadAsync(result, exportPath);
            }
            
            if (!isWalkingRef.current) break;

            const navigated = await navigateAndVerifyChange(currentId);
            
            batchCounter++;
            setBatchCount(batchCounter); 

            if (!navigated) { break; } 
            else currentId = await Crawler.extractIdFromUrl(webviewRef.current); 

        } catch (e: any) {
            console.error(e);
            addLog(`ERROR: ${e.message}`, 'error');
            await sleep(2000);
            if (!isWalkingRef.current) break;
            const changed = await navigateAndVerifyChange(currentId);
            if(changed) currentId = await Crawler.extractIdFromUrl(webviewRef.current);
        }
    }
    
    // --- POST LOOP ---
    if (activeDownloadsRef.current > 0) {
        addLog(`Warte auf ${activeDownloadsRef.current} noch laufende Downloads...`, 'info');
        while (activeDownloadsRef.current > 0) {
            await sleep(500);
        }
    }
    finishBackupSession();
  };

  if (!isInitialized) return <StartupScreen onLoadDatabase={handleInitLoadDatabase} onNewDatabase={handleInitNewDatabase} />;

  const duplicateCount = integrityResult?.duplicates?.length || 0;
  const hasCorrections = orphans.length > 0 || corruptFilesCount > 0;

  return (
    <div className="flex flex-col h-screen bg-slate-900 text-slate-100 overflow-hidden relative">
      {/* LOADING OVERLAY */}
      {isChecking && (
          <div className="fixed inset-0 bg-black/70 z-[100] flex flex-col items-center justify-center backdrop-blur-sm">
               <div className="animate-spin rounded-full h-16 w-16 border-t-4 border-blue-500 mb-4"></div>
               <div className="text-xl font-bold text-white">Datenbank wird geprüft...</div>
               <div className="text-sm text-slate-400 mt-2">Dies kann bei großen Sammlungen einen Moment dauern.</div>
          </div>
      )}

      {showCorrectionModal && (
          <CorrectionModal 
              orphans={orphans} 
              files={dbRef.current.files}
              onClose={() => setShowCorrectionModal(false)}
              onDeleteOrphans={executeDeleteOrphans}
              onResetOrphans={executeResetOrphans}
              onShowInFolder={handleShowFileInExplorer}
              onDeleteCorrupt={handleRemoveCorruptFile}
              onDeleteAllCorrupt={executeDeleteAllCorrupt}
              onNavigate={handleOpenMissingPhoto}
          />
      )}

      {showIntegrityModal && ( 
          <IntegrityReportModal 
            initialResult={integrityResult} // Pass existing result if available
            basePath={exportPath || ""}
            files={dbRef.current.files} 
            onClose={() => setShowIntegrityModal(false)} 
            onCheckDone={handleIntegrityCheckDone}
            onExecuteDuplicates={executeResolveDuplicates} 
            onShowMissing={() => { setShowIntegrityModal(false); setShowCorrectionModal(true); }} 
            onCleanLegacy={executeCleanLegacy}
            onUpdateFileStatus={handleIntegrityStatusUpdate}
            onDeleteCorruptFile={handleRemoveCorruptFile}
          /> 
      )}
      {/* MISSING FILES MODAL REMOVED - now handled by CorrectionModal */}
      {showRenameModal && <RenameModal candidates={renamableFiles} onClose={() => setShowRenameModal(false)} onExecute={executeRenameFiles} />}
      {showHeatmapModal && <ScanHeatmapModal scannedDays={scannedDays} files={dbRef.current.files} onClose={() => setShowHeatmapModal(false)} />}
      
      <div className="flex-1 bg-white relative border-b-4 border-slate-700 min-h-[40%]">
        <webview ref={webviewRef} src="https://photos.google.com" className="w-full h-full" 
        // @ts-ignore
        allowpopups="true" />
        
        {/* DOWNLOAD STATUS OVERLAY */}
        <div className="absolute top-4 left-4 z-50 flex flex-col gap-2 w-80 pointer-events-none">
            {(Object.values(activeProgress) as DownloadProgress[]).map((progress, idx) => (
                 <div key={idx} className="bg-blue-900/90 text-white p-2 rounded-lg shadow-xl border border-blue-500 backdrop-blur-sm">
                    <div className="flex justify-between text-[10px] mb-1 font-mono">
                        <span className="truncate max-w-[150px]">{progress.filename}</span>
                        <span>{progress.total > 0 ? Math.round(progress.percent * 100) + '%' : '...'}</span>
                    </div>
                    <div className="h-1.5 bg-blue-950 rounded-full overflow-hidden">
                        <div className={`h-full bg-blue-400 transition-all duration-200 ${progress.total === 0 ? 'animate-pulse w-full opacity-50' : ''}`} style={{width: progress.total > 0 ? `${progress.percent * 100}%` : '100%'}}></div>
                    </div>
                </div>
            ))}
        </div>

        {isWalking && (
            <div className="absolute top-4 right-4 bg-slate-800/90 text-white p-4 rounded shadow-xl border border-blue-500 z-50">
                <div className="flex items-center gap-3"><div className="animate-spin rounded-full h-4 w-4 border-t-2 border-white"></div><div className="font-bold">Turbo Backup</div></div>
                <div className="text-sm mt-1 text-slate-300">Neu gefunden: {processedCount}</div>
                <div className="text-xs text-slate-400 mt-1">Aktive Downloads: {activeDownloadsCount} / 5</div>
                <div className="text-xs text-blue-300 mt-2 border-t border-slate-600 pt-1 flex justify-between"><span>Batch:</span> <span className="font-mono">{batchCount} / 1000</span></div>
            </div>
        )}
      </div>

      <div className="h-64 flex flex-col md:flex-row bg-slate-800 shrink-0 border-b border-slate-700">
        <div className="w-full md:w-1/4 p-3 border-r border-slate-700 flex flex-col gap-2 overflow-y-auto bg-slate-800">
            <h3 className="font-bold text-blue-400 uppercase text-xs tracking-wider mb-1">Status: Aktiv</h3>
            {exportPath && (
                <div className="mb-2 p-2 bg-slate-900 rounded border border-slate-600">
                     <div className="text-[10px] text-slate-400 uppercase tracking-wider">Zielverzeichnis</div>
                     <div className="text-xs text-blue-300 truncate font-mono" title={exportPath}>...{exportPath.slice(-25)}</div>
                     <div className="text-[10px] text-slate-500 mt-1">DB: {processedIdsRef.current.size} Einträge</div>
                </div>
            )}
            
            <button onClick={() => setShowHeatmapModal(true)} className="bg-slate-700 hover:bg-slate-600 text-slate-200 px-2 py-2 rounded text-xs border border-slate-600 flex items-center justify-between mb-2"><span className="font-bold">📊 Scan-Historie</span><span className="text-[10px] bg-slate-800 px-1 rounded">{uniqueUsageDays} Aktiv-Tage</span></button>
            
            {duplicateCount > 0 && <div className="mb-2 p-2 bg-amber-900/50 border border-amber-500 rounded text-xs animate-pulse"><div className="font-bold text-amber-200">⚠ Duplikate ({duplicateCount})</div><button onClick={() => setShowIntegrityModal(true)} className="w-full bg-amber-700 hover:bg-amber-600 text-white text-[10px] py-1 rounded mt-1">Lösen</button></div>}
            
            <button onClick={openIntegrityMenu} className="bg-slate-700 hover:bg-slate-600 text-slate-200 px-2 py-1 rounded text-xs border border-slate-600 mb-1">🔎 Datenbank prüfen</button>
            <button onClick={scanForRenamableFiles} className="bg-slate-700 hover:bg-slate-600 text-slate-200 px-2 py-1 rounded text-xs border border-slate-600 mb-1">✨ Dateinamen bereinigen</button>
            
            {hasCorrections && (
                 <button 
                    onClick={() => { setShowCorrectionModal(true); }}
                    className="bg-red-700 hover:bg-red-600 text-white font-bold px-2 py-2 rounded text-xs border border-red-500 shadow-lg animate-pulse mb-1 flex items-center justify-between"
                 >
                     <span>🛠️ Korrekturen</span>
                     <span className="bg-white/20 px-1.5 rounded text-[10px]">{orphans.length + corruptFilesCount}</span>
                 </button>
            )}

            <button onClick={handleExportCsv} className="bg-slate-700 hover:bg-slate-600 text-slate-200 px-2 py-1 rounded text-xs border border-slate-600 mb-2">📄 Excel CSV Export</button>

            <div className="grid grid-cols-2 gap-2 mt-auto">
                 <button onClick={resetProgramState} className="bg-amber-900/40 hover:bg-amber-800 border border-amber-800 text-amber-100 px-2 py-2 rounded text-xs flex items-center justify-center gap-1"><span>🔄 Reset</span></button>
                <button onClick={clearCacheAndLogout} className="bg-red-900/40 hover:bg-red-800 border border-red-800 text-red-100 px-2 py-2 rounded text-xs flex items-center justify-center gap-1"><span>⚡ Logout</span></button>
            </div>
            
            <div className="flex gap-2 mt-2">
                 <button onClick={isWalking ? stopWalkthrough : startWalkthrough} className={`flex-1 px-3 py-3 rounded font-bold shadow transition flex items-center justify-center gap-2 text-sm ${isWalking ? 'bg-red-600 hover:bg-red-500 text-white' : 'bg-green-600 hover:bg-green-500 text-white'}`}>
                    {isWalking ? '⏹ Stop' : '▶ Start Backup'}
                </button>
                {!isWalking && (<button onClick={handleSingleDownload} className="bg-blue-600 hover:bg-blue-500 text-white px-3 py-3 rounded font-bold shadow transition flex items-center justify-center gap-2 text-sm w-1/4" title="1 Foto laden">⬇ 1</button>)}
            </div>
        </div>

        <div className="hidden md:flex w-full md:w-1/4 p-3 border-r border-slate-700 flex-col min-w-0 opacity-50 hover:opacity-100 transition-opacity">
             <div className="flex justify-between items-center mb-1"><h3 className="font-bold text-slate-400 uppercase text-xs tracking-wider">Wichtige Ereignisse</h3></div>
             <div className="flex-1 bg-black/50 rounded border border-slate-700 p-2 overflow-y-auto font-mono text-[10px] scrollbar-thin" ref={logContainerRef}>
                {logs.map((l, i) => (
                    <div key={i} className={`mb-1 px-1 rounded ${l.type === 'error' ? 'bg-red-900/30 text-red-300' : l.type === 'success' ? 'bg-green-900/30 text-green-300' : l.type === 'warning' ? 'bg-amber-900/30 text-amber-300' : 'text-slate-300'}`}>
                        <span className="opacity-50 mr-2">{new Date(l.timestamp).toLocaleTimeString()}</span>{l.message}
                    </div>
                ))}
             </div>
        </div>

        <div className="flex-1 p-3 flex flex-col min-w-0">
             <div className="flex justify-between items-center mb-1"><h3 className="font-bold text-slate-400 uppercase text-xs tracking-wider">Neue Dateien ({processedCount})</h3><button onClick={() => setDownloadedFiles([])} className="text-[10px] text-slate-500 hover:text-white">Leeren</button></div>
             <div className="flex-1 bg-slate-900 rounded border border-slate-700 overflow-hidden flex flex-col">
                <div className="flex bg-slate-800 text-[10px] text-slate-400 p-2 font-bold border-b border-slate-700"><div className="w-6 text-center"></div><div className="flex-1 px-1">Name</div><div className="w-24">Web</div><div className="w-24">Original</div><div className="w-12 text-center">Status</div></div>
                <div className="flex-1 overflow-y-auto scrollbar-thin p-0" ref={tableContainerRef}>
                    {downloadedFiles.map((file, idx) => (
                        <div key={idx} className={`flex text-[10px] border-b border-slate-800 p-1.5 items-center ${!file.isMatch ? 'bg-amber-900/30' : 'hover:bg-slate-800/50'}`}>
                            <div className="w-6 text-center text-sm">{file.type === 'video' ? '🎬' : '📷'}</div>
                            <div className="flex-1 truncate px-1 text-blue-300 font-mono" title={file.fileName}>{file.fileName}</div>
                            <div className="w-24 text-slate-300">{file.webDate.toLocaleDateString()} {file.webDate.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</div>
                            <div className={`w-24 ${!file.isMatch ? 'text-amber-400 font-bold' : 'text-slate-500'}`}>{file.originalExifDate ? <>{file.originalExifDate.toLocaleDateString()} {file.originalExifDate.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</> : <span className="opacity-30">-</span>}</div>
                            <div className="w-12 text-center">{file.isMatch ? <span className="text-green-500">✔</span> : <span className="text-amber-500">⚠</span>}</div>
                        </div>
                    ))}
                </div>
             </div>
        </div>
      </div>
    </div>
  );
};

export default App;