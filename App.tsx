

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { ProcessingLog, DownloadedFile, DownloadResult, FileDatabase, DatabaseEntry, IntegrityResult, DownloadProgress, RenamableFile, SkippedDownload } from './types';
import { parseGoogleDateString, parseExifDateToDate, getIsoDateString } from './utils/exifUtils';
import * as Crawler from './logic/crawlerActions';
import * as DbUtils from './logic/databaseUtils';
import { StartupScreen } from './components/StartupScreen';
import { IntegrityReportModal, CorrectionModal, RenameModal, AlbumDownloadModal } from './components/ActionModals';
import { ScanHeatmapModal } from './components/ScanHeatmap';

// F10: Google braucht bei großen Videos teils >30 s bis will-download feuert.
// Danach wird die Config entwertet und das Foto in skippedDownloads geführt.
const DOWNLOAD_START_TIMEOUT_MS = 45000;

// F14: true = Trust-Zeile für jedes Foto (Diagnose). Standard: nur bei Auffälligkeiten.
const VERBOSE_TRUST_LOG = false;

const App: React.FC = () => {
  // --- UI State ---
  const [isInitialized, setIsInitialized] = useState(false);
  const [logs, setLogs] = useState<ProcessingLog[]>([]); 
  const [exportPath, setExportPath] = useState<string | null>(null);
  const [dbFilePath, setDbFilePath] = useState<string | null>(null);
  // F10: Spiegel des DB-Pfads, damit saveDatabase auch aus Callbacks des ersten Renders (onDownloadComplete) korrekt arbeitet.
  const dbFilePathRef = useRef<string | null>(null);
  
  const [isWalking, setIsWalking] = useState(false);
  const [isChecking, setIsChecking] = useState(false); // NEU: Lade-Status für Checks
  const [processedCount, setProcessedCount] = useState(0);
  const [downloadedFiles, setDownloadedFiles] = useState<DownloadedFile[]>([]);
  const [scannedDays, setScannedDays] = useState<Record<string, number>>({});
  
  // Neuer State für den Batch-Fortschritt
  const [batchCount, setBatchCount] = useState(0);

  // State für mehrere parallele Downloads (Job-Key/Filename -> Progress)
  const [activeProgress, setActiveProgress] = useState<Record<string, DownloadProgress>>({});
  const [nowTs, setNowTs] = useState(Date.now()); // F11: 1-s-Ticker für die Warteanzeige
  const [activeDownloadsCount, setActiveDownloadsCount] = useState(0);

  // --- Database & Tracking State (Refs) ---
  const dbRef = useRef<FileDatabase>({ basePath: '', lastUpdated: 0, files: {}, scannedDays: {}, skippedDownloads: {} });
  const processedIdsRef = useRef<Set<string>>(new Set());
  const sessionSeenIds = useRef<Set<string>>(new Set());
  const minDateEncountered = useRef<number | null>(null);
  const maxDateEncountered = useRef<number | null>(null);
  
  // --- Asynchronous Pipeline State ---
  const activeDownloadsRef = useRef(0);
  // F10: Resolver-Signatur mit started-Flag (Stop/Reset brechen mit false ab, Timeout mit false + Warnung)
  const pendingStartResolvers = useRef<Map<string, (started: boolean) => void>>(new Map());
  // F11: finaler Dateiname -> stabiler Job-Key (Wartekarte wird in-place zur Fortschrittskarte)
  const jobKeyByFilenameRef = useRef<Map<string, string>>(new Map());
  const isResettingRef = useRef(false); // NEU: Verhindert IPC nach Reset

  // --- Orphans, Duplicates & Missing ---
  const [orphans, setOrphans] = useState<{id: string, entry: DatabaseEntry}[]>([]);
  const [skippedPhotos, setSkippedPhotos] = useState<Record<string, SkippedDownload>>({}); // F10
  const [onlineMissing, setOnlineMissing] = useState<{id: string, entry: DatabaseEntry}[]>([]); // F13
  const [integrityResult, setIntegrityResult] = useState<IntegrityResult | null>(null);
  const [renamableFiles, setRenamableFiles] = useState<RenamableFile[]>([]); // NEU
  
  // CORRECTIONS & MODALS STATE
  const [showCorrectionModal, setShowCorrectionModal] = useState(false);
  // correctionTab removed as per request (now combined view)
  
  const [showIntegrityModal, setShowIntegrityModal] = useState(false);
  const [showHeatmapModal, setShowHeatmapModal] = useState(false);
  const [showRenameModal, setShowRenameModal] = useState(false); // NEU
  const [showAlbumModal, setShowAlbumModal] = useState(false);

  // --- Refs ---
  const webviewRef = useRef<any>(null);
  const tableContainerRef = useRef<HTMLDivElement>(null);
  const logContainerRef = useRef<HTMLDivElement>(null);
  const isWalkingRef = useRef(false);
  const isAlbumModeRef = useRef(false);
  const albumTargetPathRef = useRef<string | null>(null);
  // --- Stale-Panel-Schutz (0-ms-Detektor) ---
  const prevTrueMetaRef = useRef<{ id: string; filename?: string; originalDate?: string; webTimestamp?: number } | null>(null);
  const newDownloadMetaRef = useRef<Map<string, { filename: string; originalDate?: string }>>(new Map());
  // --- Panel-Refresh-Wait (F1) ---
  const lastPanelSignatureRef = useRef<string | null>(null);
  const panelRefreshedRef = useRef(false); // Panel nach Navigation bestätigt aktualisiert
  const panelSyncedRef = useRef(true);     // Panel gehört vermutlich zum aktuellen URL-Foto
  const panelScrolledRef = useRef(false);  // F1.1: Panel-Scroll-Retry für dieses Foto bereits versucht
  const pendingInfoRef = useRef<any>(null); // F1.2: bestätigtes Scrape-Ergebnis aus dem Panel-Refresh-Wait
  const desyncAbortRef = useRef(false);     // F1.3: Panel-Desync nicht behebbar -> Session sauber abbrechen
  
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
  const addLog = (message: string, type: 'info' | 'error' | 'success' | 'debug' | 'warning' | 'album' = 'info') => {
    // Check if resetting to avoid state updates on unmounted/reset components
    if (isResettingRef.current) return;

    if (window.electron && window.electron.logToConsole) {
        window.electron.logToConsole(message, type);
    }
    
    const isRelevantForUI = 
        type !== 'debug' &&
        (type === 'error' || 
        type === 'success' || 
        type === 'warning' ||
        type === 'album' ||
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
        message.includes('Scan-Log'));

    if (isRelevantForUI) {
        setLogs(prev => {
            const newLogs = [...prev, { timestamp: Date.now(), message, type }];
            if (newLogs.length > 300) return newLogs.slice(newLogs.length - 300);
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
          return result as {id: string, dateStr: string, potentialFilename?: string, panelSignature: string};
      } catch (e: any) {
          // NEU: Fehler beim Reset ignorieren
          if (e.message && e.message.includes('GUEST_VIEW_MANAGER_CALL')) return null;
          return null;
      }
  };

  // --- STALE-PANEL-DETEKTOR (kostet im Normalfall 0 ms) ---
  // Erkennt, ob der gerade gelesene Panel-Inhalt noch zum Vorgängerfoto gehört.
  const sameName = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
  // Entfernt einen Kollisions-Suffix " (1)" vor der Endung (lokale Dateinamen).
  const stripCollisionSuffix = (name?: string | null) => (name || '').replace(/\s\(\d+\)(\.[^.]+)$/, '$1');

  // --- PANEL-REFRESH-WAIT (F1/F1.3) ---
  // Wartet nach der Navigation darauf, dass das Info-Panel tatsächlich zum neuen Foto wechselt.
  // "Refreshed" = Signatur weicht vom Vorgänger ab, entspricht NICHT dem Vorgängerfoto (Namens-Anker, F1.3)
  //               und ist bei zwei aufeinanderfolgenden Reads stabil.
  // prevSignature === null => nur auf Stabilität warten (Erst-Synchronisierung).
  // Rückgabe: true = Panel bestätigt aktualisiert; false = Timeout/Abbruch.
  const PANEL_REFRESH_INTERVAL_MS = 150;
  const PANEL_REFRESH_TIMEOUT_MS = 3000;
  const isPreviousPhotoPanel = (info: any): boolean => {
      const prev = prevTrueMetaRef.current;
      const probeName = info?.potentialFilename;
      if (!prev?.filename || !probeName) return false;
      return stripCollisionSuffix(probeName).toLowerCase() === stripCollisionSuffix(prev.filename).toLowerCase();
  };
  const waitForPanelRefresh = async (prevSignature: string | null, timeoutMs: number = PANEL_REFRESH_TIMEOUT_MS): Promise<boolean> => {
      const start = Date.now();
      let candidate: string | null = null;
      let lastProbe: { name: string; dateOk: boolean; texts: number; sig: string } | null = null;
      while (Date.now() - start < timeoutMs) {
          if (!isWalkingRef.current) return false;
          await sleep(PANEL_REFRESH_INTERVAL_MS);
          if (!isWalkingRef.current) return false;
          const info = await safeExtractInfo();
          if (!info?.panelSignature) {
              lastProbe = { name: '(scrape null)', dateOk: false, texts: 0, sig: '-' };
              continue;
          }
          lastProbe = {
              name: info.potentialFilename || '-',
              dateOk: !isNaN(parseGoogleDateString(info.dateStr || '').getTime()),
              texts: (info.dateStr || '').split('\n').filter(Boolean).length,
              sig: (info.panelSignature || '').substring(0, 10)
          };
          if (prevSignature !== null && info.panelSignature === prevSignature) {
              candidate = null; // noch altes Panel
              continue;
          }
          if (isPreviousPhotoPanel(info)) {
              candidate = null; // F1.3: Panel zeigt nachweislich noch das Vorgängerfoto
              continue;
          }
          if (candidate === info.panelSignature) {
              pendingInfoRef.current = info; // F1.2: bestätigtes Ergebnis für die nächste Iteration puffern
              return true; // stabil (und != vorher)
          }
          candidate = info.panelSignature;
      }
      // F1.4: Diagnose bei Timeout
      if (lastProbe) {
          addLog(`Panel-Wait-Timeout: name=${lastProbe.name} dateOk=${lastProbe.dateOk} texts=${lastProbe.texts} sig=${lastProbe.sig}`, 'debug');
      } else {
          addLog('Panel-Wait-Timeout ohne Probe (Scrape lieferte nie etwas).', 'debug');
      }
      return false;
  };

  const evaluateScrapeTrust = (panelRefreshed: boolean, result: any, webTimestamp: number, entry?: DatabaseEntry): { trusted: boolean; reason: string } => {
      const prev = prevTrueMetaRef.current;
      const candidate = result?.potentialFilename as string | undefined;

      // Harte Namenssperre: Kandidat ist exakt der Name des Vorgängerfotos, aber nicht der eigene Name.
      // Gilt auch bei bestätigtem Panel-Refresh (schützt vor Teil-Updates).
      if (prev?.filename && candidate) {
          const ownNames = [entry?.filename, entry?.originalName].filter(Boolean).map(n => n!.toLowerCase());
          if (sameName(candidate, prev.filename) && !ownNames.includes(candidate.toLowerCase())) {
              return { trusted: false, reason: 'Kandidat entspricht Vorgängername' };
          }
      }

      // Panel wurde nach der Navigation nachweislich neu aufgebaut -> vertrauenswürdig.
      if (panelRefreshed) return { trusted: true, reason: '' };

      if (!prev) return { trusted: true, reason: '' }; // Erstes Foto: Panel stand still

      let prevDate: number | null = null;
      if (prev.originalDate) {
          const d = parseExifDateToDate(prev.originalDate);
          if (d) prevDate = d.getTime();
      }
      if (prevDate === null && prev.webTimestamp) prevDate = prev.webTimestamp;

      if (prevDate === null && !prev.filename) {
          // Referenz unvollständig: nicht blockieren (verhindert Untrusted-Kaskade), nur beobachten.
          return { trusted: true, reason: 'Vorgänger-Referenz unvollständig (Fallback)' };
      }

      const within60 = (a: number, b: number) => Math.abs(a - b) <= 60000;

      const matchesPrev = (prevDate !== null && within60(webTimestamp, prevDate)) || sameName(candidate, prev.filename);

      let matchesOwn = false;
      if (entry?.originalDate) {
          const od = parseExifDateToDate(entry.originalDate);
          if (od) matchesOwn = within60(webTimestamp, od.getTime());
      }
      if (!matchesOwn && entry?.timestamp) {
          matchesOwn = within60(webTimestamp, entry.timestamp);
      }

      if (matchesPrev && !matchesOwn) {
          return { trusted: false, reason: 'Panel zeigt vermutlich Vorgängerfoto' };
      }
      return { trusted: true, reason: '' };
  };

  // Merkt sich die verlässlichsten Metadaten des zuletzt besuchten Fotos (für den Detektor).
  const rememberTrueMeta = (id: string, entry: DatabaseEntry | undefined, result: any, webTimestamp: number, trusted: boolean) => {
      if (entry) {
          prevTrueMetaRef.current = { id, filename: entry.filename, originalDate: entry.originalDate, webTimestamp: trusted ? webTimestamp : undefined };
          return;
      }
      const dl = newDownloadMetaRef.current.get(id);
      if (dl) {
          prevTrueMetaRef.current = { id, filename: dl.filename, originalDate: dl.originalDate, webTimestamp: trusted ? webTimestamp : undefined };
      } else {
          prevTrueMetaRef.current = { id, filename: trusted ? (result?.potentialFilename || undefined) : undefined, originalDate: undefined, webTimestamp: trusted ? webTimestamp : undefined };
      }
  };

  // --- GLOBAL ELECTRON LISTENER (PIPELINE) ---
  useEffect(() => {
      if(window.electron) {
          window.electron.onDownloadStarted((id: string, filename: string) => {
               const resolver = pendingStartResolvers.current.get(id);
               if (resolver) {
                   resolver(true); 
                   pendingStartResolvers.current.delete(id);
               }
               // F11: Wartekarte in-place in die Fortschrittskarte überführen (gleicher Key -> kein Positionssprung)
               const jobKey = `job:${id}`;
               if (!filename) {
                   // Dev-Hinweis: passiert, wenn der Main-Prozess noch die alte main.cjs geladen hat (kein Neustart nach F11).
                   addLog('⚠️ download-started ohne Dateinamen – Main-Prozess veraltet? Bitte App neu starten.', 'warning');
               }
               if (filename) jobKeyByFilenameRef.current.set(filename, jobKey);
               setActiveProgress(prev => {
                   const entry = prev[jobKey];
                   if (!entry) return prev;
                   return { ...prev, [jobKey]: { ...entry, filename: filename || entry.filename, waiting: false, percent: 0, received: 0, total: 0 } };
               });
          });

          window.electron.onDownloadComplete(async (result: DownloadResult) => {
              activeDownloadsRef.current = Math.max(0, activeDownloadsRef.current - 1);
              setActiveDownloadsCount(activeDownloadsRef.current);
              
              if (isResettingRef.current) return; // Ignore updates if resetting

              setActiveProgress(prev => {
                  const next = { ...prev };
                  const keyToRemove = result.progressFilename || result.filename;
                  const mappedKey = jobKeyByFilenameRef.current.get(keyToRemove);
                  if (mappedKey) jobKeyByFilenameRef.current.delete(keyToRemove);
                  delete next[mappedKey || keyToRemove];
                  delete next[`job:${result.id}`]; // F11: defensiv
                  return next;
              });

              if (result.success) {
                  // F10: erfolgreich nachgeladen -> aus Übersprungen-Liste entfernen.
                  // Persistiert wird erst am Ende des Blocks, damit der Snapshot auch den neuen files-Eintrag enthält.
                  const wasSkipped = removeSkippedPhoto(result.id);
                  newDownloadMetaRef.current.set(result.id, { filename: result.filename, originalDate: result.originalExifDate || undefined });
                  const ext = result.filename.split('.').pop()?.toLowerCase();
                  const isVideo = ['mp4', 'mov', 'm4v', 'avi', '3gp', 'mpg'].includes(ext || '');
                  const originalExifDate = parseExifDateToDate(result.originalExifDate || "");
                  const finalDate = new Date(result.finalDateTimestamp || Date.now());

                  if (isAlbumModeRef.current) {
                      // ALBUM-MODUS: Keine DB-Aktualisierung, nur Log
                      const albumEntry: DownloadedFile = {
                          id: result.id, originalName: result.originalName, fileName: result.filename,
                          webDate: finalDate, fileDate: finalDate, originalExifDate: originalExifDate,
                          isMatch: true, wasAdjusted: true, type: (isVideo ? 'video' : 'image') as 'image' | 'video', status: 'Album', path: result.path
                      };
                      setDownloadedFiles(prev => [...prev, albumEntry].slice(-100));
                      addLog(`[ALBUM] Download fertig: ${result.filename}`, 'album');
                  } else {
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
                          sourceHash: result.sourceHash,
                          // WICHTIG: Integrity Status NICHT auf 'ok' setzen, sondern offen lassen (undefined).
                          // Damit gilt die Datei als "ungeprüft" im Dashboard und kann validiert werden.
                      };

                      setProcessedCount(prev => prev + 1);
                      addLog(`Download fertig: ${result.filename}`, 'success');
                  }

                  // F10: Jetzt enthält der DB-Snapshot sowohl die Skip-Entfernung als auch den neuen files-Eintrag.
                  if (wasSkipped) void saveDatabase();
              } else {
                  if (isAlbumModeRef.current) {
                      addLog(`[ALBUM] Fehler beim Download (${result.id}): ${result.error}`, 'album');
                  } else {
                      addLog(`Fehler beim Download (${result.id}): ${result.error}`, 'error');
                  }
              }
          });

          window.electron.onDownloadProgress((progress: DownloadProgress) => {
             if (isResettingRef.current) return;
             // F11: über das Dateiname-Mapping denselben Job-Key weiterverwenden (Karte bleibt bestehen)
             const jobKey = jobKeyByFilenameRef.current.get(progress.filename) || progress.filename;
             setActiveProgress(prev => {
                 const existing = prev[jobKey];
                 // F12: vorhandenen Slot behalten; im Fallback (kein Mapping) neuen Slot vergeben
                 const slot = existing ? existing.slot : assignProgressSlot(prev);
                 return { ...prev, [jobKey]: { ...progress, slot } };
             });
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

  // F10: Übersprungene Fotos (Download-Start-Timeout) aus der DB in den UI-State spiegeln.
  // Einträge, die inzwischen eine DB-Datei haben, werden selbstheilend entfernt.
  const updateSkippedList = () => {
      const skipped = dbRef.current.skippedDownloads || {};
      let changed = false;
      for (const id of Object.keys(skipped)) {
          if (dbRef.current.files[id]) { delete skipped[id]; changed = true; }
      }
      if (changed) void saveDatabase();
      setSkippedPhotos({ ...skipped });
  };

  // F13: Online nicht gefundene Dateien (Datei lokal vorhanden) in den UI-State spiegeln.
  // Einträge mit missingSince laufen in der Orphan-Sektion (Vorrang), daher hier ausgeschlossen.
  const updateOnlineMissingList = () => {
      const list = (Object.entries(dbRef.current.files || {}) as [string, DatabaseEntry][])
          .filter(([_, entry]) => !!entry.onlineMissingSince && !entry.missingSince)
          .map(([id, entry]) => ({ id, entry }));
      setOnlineMissing(list);
  };

  useEffect(() => { if (isInitialized) { updateOrphansList(); updateSkippedList(); updateOnlineMissingList(); } }, [isInitialized]);

  // F11: Sekunden-Ticker nur, solange eine Wartekarte sichtbar ist.
  const hasWaitingProgress = Object.values(activeProgress).some(p => p.waiting);
  useEffect(() => {
      if (!hasWaitingProgress) return;
      const timer = setInterval(() => setNowTs(Date.now()), 1000);
      return () => clearInterval(timer);
  }, [hasWaitingProgress]);

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
            // Falls alte DB ohne scannedDays/skippedDownloads, initialisieren
            if (!dbRef.current.scannedDays) dbRef.current.scannedDays = {};
            if (!dbRef.current.skippedDownloads) dbRef.current.skippedDownloads = {}; // F10

            // EINMALIGE HASH-MIGRATION (Schema 2):
            // Bisheriger "hash" war der Roh-Hash VOR dem Metadaten-Rewrite -> jetzt sourceHash.
            // Der aktuelle Datei-Hash wird lazy nachgezogen (Hash-Gate / Integritätsprüfung).
            if (loadedDb.hashScheme !== 2) {
                let migrated = 0;
                for (const id of Object.keys(loadedDb.files)) {
                    const entry = loadedDb.files[id];
                    if (entry.hash && !entry.sourceHash) {
                        entry.sourceHash = entry.hash;
                        delete entry.hash;
                        migrated++;
                    }
                }
                loadedDb.hashScheme = 2;
                try {
                    const migrateSave = { ...loadedDb, basePath: '.' };
                    delete migrateSave.dbFilePath; // F8: absoluten Altpfad nicht persistieren
                    await window.electron.saveDatabase(filePath, migrateSave);
                    setTimeout(() => addLog(`🔀 Hash-Migration: ${migrated} Einträge (alter Hash -> sourceHash) gespeichert.`, 'info'), 700);
                } catch (migErr) {
                    console.error("Hash-Migration konnte nicht gespeichert werden", migErr);
                }
            }

            processedIdsRef.current = new Set(Object.keys(loadedDb.files));
            setScannedDays(dbRef.current.scannedDays);
            setExportPath(basePath);
            setDbFilePath(filePath);
            dbFilePathRef.current = filePath;
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
            scannedDays: {}, // Initial leer
            skippedDownloads: {}, // F10
            hashScheme: 2
        };
        processedIdsRef.current = new Set();
        setScannedDays({});
        setExportPath(basePath);
        setDbFilePath(filePath);
        dbFilePathRef.current = filePath;
        setOrphans([]);
        setSkippedPhotos({});
        setOnlineMissing([]); // F13 (leere DB -> leere Liste)
        
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
      const targetPath = dbFilePathRef.current; // F10: Ref statt State, damit auch alte Callback-Closures korrekt speichern
      if (!targetPath || !window.electron) return;
      dbRef.current.lastUpdated = Date.now();
      const dbToSave = { ...dbRef.current, basePath: '.' };
      delete dbToSave.dbFilePath; // F8: absoluten Pfad nicht in die DB schreiben (kommt beim Laden aus dem Dateipfad)
      try {
          const success = await window.electron.saveDatabase(targetPath, dbToSave);
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
          const deleted = await window.electron.deleteFile({
              basePath: exportPath,
              filename: entry.filename,
              timestamp: entry.timestamp
          });
          if (!deleted) {
              addLog(`Löschen fehlgeschlagen (Datei bleibt bestehen, DB unverändert): ${entry.filename}`, 'warning');
              return false;
          }
          
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
      let failedCount = 0;
      for (const [id, entry] of corrupt) {
          try {
              const deleted = await window.electron.deleteFile({
                  basePath: exportPath,
                  filename: entry.filename,
                  timestamp: entry.timestamp
              });
              if (!deleted) {
                  failedCount++;
                  addLog(`Löschen fehlgeschlagen (DB unverändert): ${entry.filename}`, 'warning');
                  continue;
              }
              if (dbRef.current.files[id]) {
                  delete dbRef.current.files[id].integrityStatus;
                  delete dbRef.current.files[id].hash;
              }
              deletedCount++;
          } catch(e) { console.error(e); failedCount++; }
      }
      
      await saveDatabase();
      setProcessedCount(prev => prev + 1);
      addLog(`${deletedCount} defekte Dateien gelöscht.${failedCount > 0 ? ` ${failedCount} fehlgeschlagen (siehe Warnungen).` : ''} Bereit für Re-Download.`, failedCount > 0 ? 'warning' : 'success');
  };
  
  // --- RENAME LOGIC ---
  const scanForRenamableFiles = async () => {
      if (!window.electron || !exportPath || !dbRef.current.files) return;
      addLog("Suche nach unnötigen Nummerierungen...", 'info');
      
      try {
          const result = await window.electron.findRenamableFiles(exportPath, dbRef.current.files);
          const candidates = result?.candidates || [];
          const s = result?.stats;

          if (candidates.length > 0) {
              setRenamableFiles(candidates);
              setShowRenameModal(true);
              addLog(`${candidates.length} Dateien können bereinigt werden.`, 'info');
          } else if (s) {
              addLog(`Bereinigung: 0 Kandidaten. ${s.nTotal} Namen mit "(n)": ${s.legitNames} originale Google-Namen (geschützt), ${s.collisionPair} Kollisions-Kopien (Basisdatei existiert), ${s.nameMismatch} ohne Namensbezug, ${s.noName} ohne Originalname, ${s.currentMissing} Datei fehlt.`, 'success');
              const msg =
                  `Keine sicheren Umbenennungen gefunden.\n\n` +
                  `${s.nTotal} Dateinamen mit "(n)":\n` +
                  `• ${s.legitNames} sind originale Google-Namen (werden geschützt)\n` +
                  `• ${s.collisionPair} sind Kollisions-Kopien, Basisdatei existiert bereits\n` +
                  `• ${s.nameMismatch} ohne passenden Originalnamen\n` +
                  `• ${s.noName} ohne Originalname\n` +
                  `• ${s.currentMissing} Datei(en) fehlen lokal\n\n` +
                  `Inhaltsgleiche Duplikate findest du über "Datenbank prüfen" → "Duplikate lösen".\n\n` +
                  `Duplikat-Prüfung jetzt öffnen?`;
              if (confirm(msg)) {
                  openIntegrityMenu();
              }
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
              const res = await window.electron.renameFile({
                  basePath: exportPath,
                  oldName: item.currentName,
                  newName: item.newName,
                  timestamp: item.timestamp,
                  expectedHash: dbRef.current.files[item.id]?.hash
              });
              
              if (res.success) {
                  // DB Update
                  if (dbRef.current.files[item.id]) {
                      dbRef.current.files[item.id].filename = item.newName;
                  }
                  successCount++;
              } else {
                  addLog(`Umbenennen fehlgeschlagen: ${item.currentName} (${res.error || 'unbekannt'})`, 'warning');
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
        'savedAt', 'downloadedAt', 'scannedAt', 'hash', 'sourceHash', 'missingSince', 'id',
        'integrityStatus', 'integrityCheckedAt', 'size', 'onlineMissingSince'
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

  // F13: Online-nicht-gefunden-Einträge behalten (Status zurücksetzen).
  const executeResetOnlineMissing = async () => {
      if (onlineMissing.length === 0) return;
      addLog(`Setze Status für ${onlineMissing.length} online-nicht-gefundene Dateien zurück...`, 'info');
      try {
          onlineMissing.forEach(o => {
              if (dbRef.current.files[o.id]) delete dbRef.current.files[o.id].onlineMissingSince;
          });
          await saveDatabase();
          updateOnlineMissingList();
          addLog("Status zurückgesetzt. Dateien gelten wieder als synchron.", 'success');
      } catch (e: any) {
          addLog("Fehler bei Reset: " + e.message, 'error');
      }
  };

  // F13: Online-nicht-gefunden-Dateien lokal löschen (Datei + DB-Eintrag; F7-Muster).
  const executeDeleteAllOnlineMissing = async () => {
      if (!exportPath || onlineMissing.length === 0) return;
      if (!confirm(`Wirklich alle ${onlineMissing.length} Dateien von der Festplatte löschen und aus der DB entfernen?`)) return;

      addLog(`Lösche ${onlineMissing.length} online-nicht-gefundene Dateien von Disk...`, 'info');
      let deletedCount = 0;
      let failedCount = 0;
      for (const item of onlineMissing) {
          try {
              const deleted = await window.electron.deleteFile({
                  basePath: exportPath,
                  filename: item.entry.filename,
                  timestamp: item.entry.timestamp
              });
              if (!deleted) {
                  failedCount++;
                  addLog(`Löschen fehlgeschlagen (DB unverändert): ${item.entry.filename}`, 'warning');
                  continue;
              }
              delete dbRef.current.files[item.id];
              processedIdsRef.current.delete(item.id);
              deletedCount++;
          } catch (e) { console.error(e); failedCount++; }
      }
      await saveDatabase();
      updateOnlineMissingList();
      addLog(`${deletedCount} Dateien lokal + in DB gelöscht.${failedCount > 0 ? ` ${failedCount} fehlgeschlagen (siehe Warnungen).` : ''}`, failedCount > 0 ? 'warning' : 'success');
  };

  // F10: Übersprungenen Eintrag ignorieren (aus DB/Liste entfernen).
  const handleIgnoreSkipped = async (id: string) => {
      removeSkippedPhoto(id);
      await saveDatabase();
      addLog(`Übersprungen-Eintrag ignoriert: ${id}`, 'info');
  };

  // F10: Alle übersprungenen Einträge ignorieren.
  const handleIgnoreAllSkipped = async () => {
      const count = Object.keys(dbRef.current.skippedDownloads || {}).length;
      if (count === 0) return;
      dbRef.current.skippedDownloads = {};
      setSkippedPhotos({});
      await saveDatabase();
      addLog(`${count} übersprungene Einträge ignoriert.`, 'info');
  };

  const executeResolveDuplicates = async () => {
      if (!exportPath || !integrityResult || integrityResult.duplicates.length === 0) return;
      if (!confirm(`Duplikat-Bereinigung starten?\n\nEs werden nur Offline-Kopien gelöscht (Einträge, die online nicht mehr gefunden wurden). Online vorhandene Google-Fotos bleiben immer erhalten.`)) return;
      
      addLog(`Löse ${integrityResult.duplicates.length} Duplikat-Gruppen auf...`, 'info');
      try {
          const { deletedIds, count, skippedOnlineGroups } = await DbUtils.resolveDuplicatesOnDisk(integrityResult.duplicates, dbRef.current.files, exportPath);
          for (const id of deletedIds) {
              delete dbRef.current.files[id];
              processedIdsRef.current.delete(id);
          }
          await saveDatabase();
          setIntegrityResult(prev => prev ? ({...prev, duplicates: []}) : null);
          setShowIntegrityModal(false);
          addLog(`Duplikat-Bereinigung fertig. ${count} gelöscht.${skippedOnlineGroups > 0 ? ` ${skippedOnlineGroups} Gruppen übersprungen (alle Einträge noch online).` : ''}`, 'success');
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
      dbFilePathRef.current = null;
      setLogs([]);
      setDownloadedFiles([]);
      setProcessedCount(0);
      setOrphans([]);
      setSkippedPhotos({}); // F10
      setOnlineMissing([]); // F13
      setIntegrityResult(null);
      setBatchCount(0);
      
      // Reset Modal States
      setShowCorrectionModal(false);
      setShowIntegrityModal(false);
      setShowRenameModal(false); 
      setShowAlbumModal(false);
      setRenamableFiles([]); 
      
      // 3. Clear Refs
      dbRef.current = { basePath: '', lastUpdated: 0, files: {}, scannedDays: {}, skippedDownloads: {}, hashScheme: 2 };
      processedIdsRef.current = new Set();
      activeDownloadsRef.current = 0;
      setActiveDownloadsCount(0);
      setActiveProgress({});
      jobKeyByFilenameRef.current.clear(); // F11
      cancelPendingStarts(); // F10: offene Starts sofort auflösen (Reset)
      isAlbumModeRef.current = false;
      albumTargetPathRef.current = null;
      prevTrueMetaRef.current = null;
      newDownloadMetaRef.current.clear();
      lastPanelSignatureRef.current = null;
      panelRefreshedRef.current = false;
      panelSyncedRef.current = true;
      panelScrolledRef.current = false;
      pendingInfoRef.current = null;
      desyncAbortRef.current = false;
      
      // 4. Force Cleanup of Webview State if possible
      setIsInitialized(false);
      setIsWalking(false);
  };

  const clearCacheAndLogout = async () => {
      if (webviewRef.current) {
          isWalkingRef.current = false;
          cancelPendingStarts(); // F10: offene Starts auflösen (Logout)
          addLog("Lösche Cache...", 'info');
          try {
            await window.electron.clearSessionCache();
            webviewRef.current.loadURL('https://accounts.google.com/Logout');
            setProcessedCount(0);
            addLog("Cache geleert.", 'success');
          } catch (e) { addLog("Fehler beim Cache leeren", 'error'); }
      }
  };

  // --- F10: Pending-Start-Verwaltung ---

  // Löst alle offenen Start-Wartevorgänge sofort auf (Reset/Logout/Session-Ende, ohne Warnlog).
  const cancelPendingStarts = () => {
      pendingStartResolvers.current.forEach((resolve) => resolve(false));
      pendingStartResolvers.current.clear();
  };

  // F10b: Vor einem neuen prepareDownload muss die vorherige Config geklärt sein
  // (Singleton-Schutz in main.cjs), sonst könnte ein später Start die neue Config erben.
  const discardPendingStarts = async () => {
      if (pendingStartResolvers.current.size === 0) return;
      pendingStartResolvers.current.forEach((resolve) => resolve(false));
      pendingStartResolvers.current.clear();
      await window.electron.cancelPendingDownload();
  };

  // F10: Foto nach Start-Timeout als "übersprungen" vormerken (persistiert in der DB).
  const recordSkippedPhoto = (info: any, isAlbumDownload: boolean) => {
      const id = info?.id;
      if (!id) return;
      const webTs = parseGoogleDateString(info.dateStr || '').getTime();
      if (!dbRef.current.skippedDownloads) dbRef.current.skippedDownloads = {};
      dbRef.current.skippedDownloads[id] = {
          id,
          webTimestamp: isNaN(webTs) ? 0 : webTs,
          filename: info.potentialFilename || undefined,
          detectedAt: Date.now(),
          mode: isAlbumDownload ? 'album' : 'backup'
      };
      setSkippedPhotos({ ...dbRef.current.skippedDownloads });
      void saveDatabase();
  };

  // F10: Nach erfolgreichem Download bzw. Ignorieren austragen.
  // Rückgabe: true, wenn tatsächlich ein Eintrag entfernt wurde (für sofortiges Persistieren).
  const removeSkippedPhoto = (id: string): boolean => {
      if (!dbRef.current.skippedDownloads || !dbRef.current.skippedDownloads[id]) return false;
      delete dbRef.current.skippedDownloads[id];
      setSkippedPhotos({ ...dbRef.current.skippedDownloads });
      return true;
  };

  // F12: Obersten freien Slot (1-5) für eine Download-Karte ermitteln.
  // Fertige Downloads geben ihren Slot frei -> Karten rutschen nicht nach, Lücken bleiben.
  const assignProgressSlot = (prev: Record<string, DownloadProgress>): number | undefined => {
      const used = new Set(Object.values(prev).map(p => p.slot).filter((s): s is number => typeof s === 'number'));
      return [1, 2, 3, 4, 5].find(s => !used.has(s));
  };

  // --- CORE CRAWLER LOGIC ---
  // F10: startTimeoutMs === null (Einzeldownload) -> kein Limit, wartet bis zum Start.
  const initiateDownloadAsync = async (info: any, savePath: string, isAlbumDownload: boolean = false, trusted: boolean = true, startTimeoutMs: number | null = DOWNLOAD_START_TIMEOUT_MS): Promise<boolean> => {
      const webDate = parseGoogleDateString(info.dateStr || "");
      if (isNaN(webDate.getTime())) return false;
      
      await window.electron.prepareDownload({
          id: info.id,
          targetDir: savePath,
          dateTimestamp: webDate.getTime(),
          flatStructure: isAlbumDownload,
          trusted
      });

      // F11: Wartekarte sofort anzeigen (stabiler Job-Key; wird beim Start in-place zur Fortschrittskarte).
      // F12: fester Slot (oberster freier), damit nichts nachrutscht.
      const waitKey = `job:${info.id}`;
      setActiveProgress(prev => ({
          ...prev,
          [waitKey]: {
              filename: info.potentialFilename || info.id,
              percent: 0, received: 0, total: 0,
              waiting: true,
              waitStartedAt: Date.now(),
              waitTimeoutMs: startTimeoutMs,
              slot: assignProgressSlot(prev)
          }
      }));

      // F3 (A1) + F10: Resolver meldet, OB der Download gestartet ist (verhindert Slot-Leak bei Timeout).
      const startPromise = new Promise<boolean>((resolve) => {
          pendingStartResolvers.current.set(info.id, (started: boolean) => resolve(started));
          if (startTimeoutMs !== null) {
              setTimeout(() => {
                  if (pendingStartResolvers.current.has(info.id)) {
                      pendingStartResolvers.current.delete(info.id);
                      console.error("Timeout waiting for download start:", info.id);
                      addLog(`Download-Start fehlgeschlagen (Timeout): ${info.id}`, 'warning');
                      recordSkippedPhoto(info, isAlbumDownload); // F10
                      resolve(false);
                  }
              }, startTimeoutMs);
          }
      });

      await Crawler.triggerDownloadKeys(webviewRef.current);
      const started = await startPromise;

      if (!started) {
          // F11: Wartekarte entfernen (Timeout bzw. Stop/Reset-Cancel)
          setActiveProgress(prev => {
              if (!(waitKey in prev)) return prev;
              const next = { ...prev };
              delete next[waitKey];
              return next;
          });
          // F10: Config entwerten, damit ein später eintreffender Start sie nicht mehr erben kann.
          await window.electron.cancelPendingDownload();
          return false; // keinen Slot belegen, ID nicht als verarbeitet markieren
      }
      
      activeDownloadsRef.current += 1;
      setActiveDownloadsCount(activeDownloadsRef.current);
      if (!isAlbumDownload) {
          processedIdsRef.current.add(info.id);
      }
      return true;
  };

  const getUrlContextType = (url: string): 'main' | 'album' | 'share' | 'search' => {
      if (url.includes('/search/')) return 'search';
      if (url.includes('/album/')) return 'album';
      if (url.includes('/share/')) return 'share';
      if (url.includes('/photo/')) return 'main';
      return 'main';
  };

  const handleSingleDownload = async () => {
      if (!webviewRef.current || !exportPath) return addLog('Fehler: Kein Zielordner oder Webview nicht bereit.', 'error');
      
      const url = webviewRef.current.getURL();
      const context = getUrlContextType(url);

      if (context === 'search') {
          return addLog('FEHLER: Downloads aus der Suche sind deaktiviert.', 'error');
      }

      if (context === 'album' || context === 'share') {
          setShowAlbumModal(true);
          return;
      }

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
              await discardPendingStarts(); // F10b: alten offenen Einzel-Start verwerfen
              const started = await initiateDownloadAsync(result, exportPath, false, true, null); // F10b: Einzeldownload ohne Limit
              if (started) addLog(`Download für ${result.id} angefordert.`, 'info');
          }

      } catch (e: any) {
          addLog(`Fehler beim Einzeldownload: ${e.message}`, 'error');
      }
  };

  const checkForOrphans = async () => {
      if (!exportPath) return;
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
      let markedLocal = 0;
      let markedOnline = 0;
      const entries = Object.entries(dbRef.current.files) as [string, DatabaseEntry][];
      for (const [id, entry] of entries) {
          if (entry.timestamp < safeStart.getTime() || entry.timestamp >= safeEnd.getTime()) continue;
          if (sessionSeenIds.current.has(id)) continue;
          if (entry.missingSince || entry.onlineMissingSince) continue;

          const exists = await window.electron.checkFileExists({
              basePath: exportPath,
              filename: entry.filename,
              timestamp: entry.timestamp
          });

          if (!exists) {
              entry.missingSince = Date.now();
              markedLocal++;
              addLog(`Vermisst (Datei fehlt lokal): ${entry.filename}`, 'error');
          } else {
              entry.onlineMissingSince = Date.now();
              markedOnline++;
              addLog(`Online nicht gefunden (Datei vorhanden): ${entry.filename}`, 'warning');
          }
      }
      if (markedLocal > 0) updateOrphansList();
      if (markedOnline > 0) updateOnlineMissingList(); // F13
      if (markedLocal > 0 || markedOnline > 0) {
          addLog(`${markedLocal} Dateien lokal vermisst, ${markedOnline} online nicht gefunden.`, markedLocal > 0 ? 'error' : 'warning');
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
  
  const finishBackupSession = async (skipOrphans: boolean = false) => {
      if (isResettingRef.current) return;

      if (skipOrphans) {
          addLog("Missing-Prüfung übersprungen (Session unvollständig/Desync).", 'warning');
      } else {
          await checkForOrphans();
      }
      
      // Hinweis: Die "scannedRanges" Logik wurde hier entfernt, da wir jetzt pro Tag (scannedDays) speichern.
      // Die Aktualisierung der scannedDays passiert live in der Schleife bei Tageswechsel.

      if (dbFilePath && (processedIdsRef.current.size > 0 || minDateEncountered.current)) {
          await saveDatabase();
          addLog("Datenbank gespeichert.", 'success');
      }
      
      setIsWalking(false); 
      addLog("Backup-Vorgang beendet.", 'success');
      cancelPendingStarts(); // F10: defensiv (offene Starts sollten bereits abgeschlossen sein)
  };

  const updateRangeTracking = (timestamp: number) => {
      if (!minDateEncountered.current || timestamp < minDateEncountered.current) minDateEncountered.current = timestamp;
      if (!maxDateEncountered.current || timestamp > maxDateEncountered.current) maxDateEncountered.current = timestamp;
  };

  const navigateAndVerifyChange = async (oldId: string): Promise<boolean> => {
      if (desyncAbortRef.current) return false; // F1.3: nach Abbruch keine weitere Navigation
      await Crawler.navigateNext(webviewRef.current);
      
      // NEU: Sofort nach Navigation Video-Killer feuern
      await Crawler.killVideoPlayers(webviewRef.current);

      let retries = 0;
      while (retries < 30) {
          if (!isWalkingRef.current) return false;
          await sleep(200);
          
          // Wir benutzen hier die lightweight-ID extraction ohne DOM-Scan
          const newId = await Crawler.extractIdFromUrl(webviewRef.current);
          if (newId && newId !== oldId) {
              // F1: Panel-Refresh abwarten (nur Haupt-Backup; Alben bleiben unverändert)
              if (!isAlbumModeRef.current) {
                  let changed = await waitForPanelRefresh(lastPanelSignatureRef.current);

                  // F1.5a: Nutzer-Stop/Reset während des Waits ist KEIN Desync -> normal beenden
                  if (!isWalkingRef.current) return false;

                  // F1.3: Resync – Panel per prev/next zwingen, zum aktuellen Foto zu wechseln.
                  // Nötig, wenn das Panel einen Schritt hinterherhängt (Refresh-Check allein reicht nicht).
                  for (let resyncTry = 0; !changed && resyncTry < 2 && isWalkingRef.current; resyncTry++) {
                      addLog(`Panel-Desync erkannt – Resync ${resyncTry + 1}/2...`, 'warning');
                      await Crawler.navigatePrevious(webviewRef.current);
                      await sleep(400);
                      await Crawler.navigateNext(webviewRef.current);
                      await Crawler.killVideoPlayers(webviewRef.current);
                      await sleep(300);
                      // F1.4: verifizieren, dass die Resync-Navigation wieder beim Zielfoto angekommen ist
                      const resyncId = await Crawler.extractIdFromUrl(webviewRef.current);
                      if (!resyncId || resyncId !== newId) {
                          addLog(`Resync-Navigation verfehlt das Ziel (${resyncId || 'leer'} != ${newId}).`, 'warning');
                      }
                      changed = await waitForPanelRefresh(lastPanelSignatureRef.current);
                  }

                  if (!changed) {
                      // F1.3: nicht behebbar -> Session abbrechen (keine Falschdaten)
                      desyncAbortRef.current = true;
                      addLog(`Session beendet: Panel-Desync nicht behebbar (Element ${oldId}) – bitte manuell prüfen.`, 'error');
                      return false;
                  }
                  panelSyncedRef.current = true;
                  panelRefreshedRef.current = true;
              }
              return true;
          }
          retries++;
      }
      addLog("Navigation Timeout - Kein neues Bild gefunden.", 'error');
      return false;
  };

  const startWalkthrough = async () => {
    if (!webviewRef.current || !exportPath) return addLog('Fehler: Kein Zielordner.', 'error');

    const url = webviewRef.current.getURL();
    const context = getUrlContextType(url);

    if (context === 'search') {
      return addLog('FEHLER: Downloads aus der Suche sind deaktiviert.', 'error');
    }

    if (context === 'album' || context === 'share') {
      setShowAlbumModal(true);
      return;
    }

    if (!url.includes('/photo/')) {
      return addLog('Bitte öffne zuerst ein Bild!', 'error');
    }

    await runBackupSession(false);
  };

  const runBackupSession = async (isAlbumMode: boolean) => {
    if (!webviewRef.current || !exportPath) return;

    isAlbumModeRef.current = isAlbumMode;
    isWalkingRef.current = true;
    setIsWalking(true);
    setProcessedCount(0);
    setBatchCount(0);
    sessionSeenIds.current = new Set();
    minDateEncountered.current = null;
    maxDateEncountered.current = null;
    isResettingRef.current = false;
    prevTrueMetaRef.current = null;
    newDownloadMetaRef.current.clear();
    lastPanelSignatureRef.current = null;
    panelRefreshedRef.current = false;
    panelSyncedRef.current = true;
    panelScrolledRef.current = false;
    pendingInfoRef.current = null;
    desyncAbortRef.current = false;
    await discardPendingStarts(); // F10b: alten offenen Einzel-Start vor der Session klären

    if (isAlbumMode) {
      addLog(`[ALBUM] Starte separaten Album-Download nach ${albumTargetPathRef.current}...`, 'album');
    } else {
      addLog('Starte Turbo-Backup (Parallel)...', 'info');
    }

    // Panel-Toggle nur im Album-Modus (dort wird nicht gescraped)
    if (isAlbumMode) {
      await Crawler.toggleInfoPanel(webviewRef.current);
      await sleep(1000);
    }

    const targetPath = isAlbumMode ? albumTargetPathRef.current : exportPath;
    if (!targetPath) {
      addLog('FEHLER: Kein Zielordner für den Download festgelegt.', 'error');
      isWalkingRef.current = false;
      setIsWalking(false);
      return;
    }

    // F1.4: Deterministischer Start – aktuelles Foto neu laden und Panel sicherstellen.
    // Ersetzt den F1.3-Nudge (der das Panel einen Schritt hinterherließ und den Namens-Anker blockierte).
    if (!isAlbumMode) {
        const startId = await Crawler.extractIdFromUrl(webviewRef.current);
        if (startId) {
            addLog('Synchronisiere Startfoto (Panel-Refresh)...', 'debug');
            try {
                await webviewRef.current.loadURL(`https://photos.google.com/photo/${startId}`);
            } catch (e) { /* best effort */ }
            await sleep(1200);

            // Panel-Öffnungs-Check (max. 3 Runden): sicherstellen, dass das Panel lesbar ist.
            // Achtung: Bei null-Scrape (Seite lädt noch) NICHT togglen, sonst schließt man ein evtl. offenes Panel.
            for (let panelTry = 0; panelTry < 3; panelTry++) {
                const probe = await safeExtractInfo();
                if (!probe) { await sleep(700); continue; }
                const probeOk = !isNaN(parseGoogleDateString(probe.dateStr || '').getTime());
                if (probeOk) break;
                await Crawler.toggleInfoPanel(webviewRef.current);
                await sleep(900);
            }
            const finalProbe = await safeExtractInfo();
            const finalOk = !!finalProbe && !isNaN(parseGoogleDateString(finalProbe.dateStr || '').getTime());
            addLog(`Panel beim Start ${finalOk ? 'synchronisiert' : 'nicht lesbar – fahre fort'} (${startId}).`, finalOk ? 'debug' : 'warning');
        }
    }

    // F1: Erst-Synchronisierung – warten, bis das Panel stabil ist (kein Mid-Update-Scrape)
    if (!isAlbumMode) {
        const initialStable = await waitForPanelRefresh(null, 2000);
        if (!initialStable) addLog('Panel bei Start nicht stabil – fahre trotzdem fort.', 'debug');
    }

    let consecutiveErrors = 0;
    let currentId = await Crawler.extractIdFromUrl(webviewRef.current);
    let lastSaveTime = Date.now();
    let batchCounter = 0; 
    let lastDayIdentifier: string | null = null;
    let firstDayIdentifier: string | null = null;

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
             if (!isAlbumMode) await saveDatabase();
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
            panelScrolledRef.current = false; // F1.1: Panel-Scroll-Retry pro Foto einmal erlauben

            if (!isAlbumMode && Date.now() - lastSaveTime > 30000) {
                await saveDatabase();
                lastSaveTime = Date.now();
            }

            // F1.3: Ein nicht behebbarer Desync bricht die Session ab (Flag wird post-loop ausgewertet)
            if (desyncAbortRef.current) break;

            // --- 1. Metadaten lesen (mit Timeout) ---
            // F1.2: Vom Panel-Refresh-Wait bestätigtes Ergebnis wiederverwenden (spart einen Vollscan).
            let result: any = pendingInfoRef.current;
            pendingInfoRef.current = null;
            if (result && currentId && result.id !== currentId) {
                addLog(`Pending-Panel verworfen (ID-Mismatch: ${result.id} != ${currentId})`, 'debug');
                result = null;
            }

            const hasValidDate = (r: any) => !!(r && !isNaN(parseGoogleDateString(r.dateStr || "").getTime()));
            let attempts = 0;
            if (!hasValidDate(result)) {
                result = null;
                while (attempts < 5) { 
                    if (!isWalkingRef.current) break;
                    
                    result = await safeExtractInfo();
                    
                    if (hasValidDate(result)) break;
                    
                    await sleep(500); 
                    attempts++;
                }
            }
            
            if (!isWalkingRef.current) break;

            let webDate = parseGoogleDateString(result?.dateStr || "");
            let webTimestamp = webDate.getTime();

            // --- 2. Fehlerbehandlung (Datum nicht lesbar) ---
            if (isNaN(webTimestamp)) {
                // F1.1a: Diagnose – welcher Panel-Text lag vor?
                const panelSnippet = (result?.dateStr || '').replace(/\s+/g, ' ').trim().slice(0, 300);
                addLog(`Diagnose Datum nicht lesbar: id=${currentId} result=${result ? 'ok' : 'null'} panel="${panelSnippet}"`, 'debug');

                // F1.1b: Einmalig rechtes Panel nach unten scrollen und neu scrapen
                // (Details/Datum liegt bei manchen Fotos unterhalb des sichtbaren Bereichs)
                if (!panelScrolledRef.current) {
                    panelScrolledRef.current = true;
                    await Crawler.scrollSidePanelToBottom(webviewRef.current);
                    await sleep(300);
                    const rescrape = await safeExtractInfo();
                    const rescrapeDate = parseGoogleDateString(rescrape?.dateStr || "");
                    if (!isNaN(rescrapeDate.getTime())) {
                        result = rescrape;
                        webDate = rescrapeDate;
                        webTimestamp = webDate.getTime();
                        addLog(`Panel-Scroll lieferte Datum: ${webDate.toLocaleString()}`, 'debug');
                    }
                }
            }

            if (isNaN(webTimestamp)) {
                consecutiveErrors++;
                addLog(`Datum nicht lesbar für ${currentId}. Versuche Reload (L/R)...`, 'warning');
                
                await Crawler.navigatePrevious(webviewRef.current);
                await sleep(500);
                if (!isWalkingRef.current) break;
                await Crawler.navigateNext(webviewRef.current);
                await Crawler.killVideoPlayers(webviewRef.current);
                await sleep(250);
                
                currentId = await Crawler.extractIdFromUrl(webviewRef.current);
                
                if (consecutiveErrors >= 3) {
                    addLog("Trotz Reload keine Daten. Überspringe Bild...", 'error');
                    let changed = await navigateAndVerifyChange(currentId);
                    // F1.1c: Navigation wiederholen – Focus/UI kann kurzzeitig blockieren
                    for (let navTry = 0; !changed && navTry < 2 && isWalkingRef.current && !desyncAbortRef.current; navTry++) {
                        addLog(`Navigation blockiert – Wiederholung ${navTry + 1}/2...`, 'warning');
                        await sleep(1500);
                        changed = await navigateAndVerifyChange(currentId);
                    }
                    if (changed) { 
                        currentId = await Crawler.extractIdFromUrl(webviewRef.current); 
                        consecutiveErrors = 0; 
                        continue; 
                    } else { 
                        if (!desyncAbortRef.current) {
                            addLog(`Session beendet: Element ${currentId} blockiert die Navigation – bitte manuell prüfen.`, 'error');
                        }
                        break; 
                    } 
                }
                continue; 
            }
            
            consecutiveErrors = 0;
            if (!isAlbumMode && result?.panelSignature) {
                lastPanelSignatureRef.current = result.panelSignature;
            }

            // NEU: Tageswechsel-Erkennung & Scan-Log (nur im Hauptbackup)
            const currentDayIdentifier = getIsoDateString(webDate);
            
            if (firstDayIdentifier === null) {
                firstDayIdentifier = currentDayIdentifier;
            }
            
            if (!isAlbumMode && lastDayIdentifier !== null && lastDayIdentifier !== currentDayIdentifier) {
                if (lastDayIdentifier !== firstDayIdentifier) {
                    if (!dbRef.current.scannedDays) dbRef.current.scannedDays = {};
                    dbRef.current.scannedDays[lastDayIdentifier] = Date.now();
                    
                    addLog(`📅 Scan-Log: ${lastDayIdentifier} erledigt.`, 'success');
                    await saveDatabase();
                    batchCounter = 0;
                    setBatchCount(0);
                } else {
                    addLog(`📅 Scan-Log: ${lastDayIdentifier} übersprungen (Start-Tag unsicher).`, 'info');
                }
            }
            lastDayIdentifier = currentDayIdentifier;

            if (!isAlbumMode) {
                updateRangeTracking(webTimestamp);
                sessionSeenIds.current.add(result.id);
            }

            // --- 3. Download Entscheidung ---
            let needsDownload = false;
            let trustedForPhoto = true;

            if (isAlbumMode) {
                // Im Album-Modus immer herunterladen, keine DB-Prüfung
                needsDownload = true;
            } else {
                if (processedIdsRef.current.has(result.id)) {
                    const existingEntry = dbRef.current.files[result.id];
                    if (existingEntry) {
                        const fileExists = await window.electron.checkFileExists({
                            basePath: exportPath,
                            filename: existingEntry.filename,
                            timestamp: existingEntry.timestamp
                        });

                        if (!fileExists) {
                            addLog(`⚠️ Datei fehlt lokal: ${existingEntry.filename} -> Download`, 'warning');
                            needsDownload = true;
                        } else {
                            let metaUpdated = false;
                            const trustInfo = evaluateScrapeTrust(panelRefreshedRef.current, result, webTimestamp, existingEntry);
                            trustedForPhoto = trustInfo.trusted;
                            // F14: nur bei Auffälligkeiten loggen (Vollprotokoll via VERBOSE_TRUST_LOG)
                            const trustProblem = !trustInfo.trusted || trustInfo.reason !== '' || (!panelRefreshedRef.current && !!prevTrueMetaRef.current);
                            if (VERBOSE_TRUST_LOG || trustProblem) {
                                addLog(`Trust: refreshed=${panelRefreshedRef.current} synced=${panelSyncedRef.current} reason=${trustInfo.reason || '-'} id=${result.id}`, 'debug');
                            }

                            if (existingEntry.missingSince) {
                                 delete existingEntry.missingSince; 
                                 metaUpdated = true;
                                 addLog(`✅ Status korrigiert: ${existingEntry.filename} wiedergefunden.`, 'success');
                            }
                            if (existingEntry.onlineMissingSince) {
                                 delete existingEntry.onlineMissingSince;
                                 metaUpdated = true;
                                 updateOnlineMissingList(); // F13: UI-Liste aktualisieren
                                 addLog(`✅ Status korrigiert: ${existingEntry.filename} wieder online gesehen.`, 'success');
                            }

                            if (result.potentialFilename && (!existingEntry.originalName || existingEntry.originalName !== result.potentialFilename)) {
                                 const candidateName = result.potentialFilename;
                                 if (candidateName.toLowerCase() === existingEntry.filename.toLowerCase()) {
                                     // Kandidat entspricht bereits dem Dateinamen -> nichts zu tun
                                 } else if (!trustInfo.trusted) {
                                     addLog(`⚠️ Namens-Korrektur übersprungen (${trustInfo.reason}): "${candidateName}" für ${existingEntry.filename}`, 'warning');
                                 } else {
                                     const oldNameLog = existingEntry.originalName || "(keiner)";
                                     existingEntry.originalName = candidateName;
                                     metaUpdated = true;
                                     addLog(`📝 Metadaten: Original-Name aktualisiert (${oldNameLog} -> ${candidateName})`, 'info');
                                 }
                            }

                            if (Math.abs(existingEntry.timestamp - webTimestamp) > 60000) {
                                const oldDateStr = new Date(existingEntry.timestamp).toLocaleString();
                                const newDateStr = new Date(webTimestamp).toLocaleString();

                                if (!trustInfo.trusted) {
                                    addLog(`⚠️ Datums-Korrektur übersprungen (${trustInfo.reason}): ${existingEntry.filename} ${oldDateStr} -> ${newDateStr}`, 'warning');
                                } else if (!existingEntry.hash) {
                                    const hashRes = await window.electron.computeFileHash({ basePath: exportPath, filename: existingEntry.filename, timestamp: existingEntry.timestamp });
                                     if (hashRes.success && hashRes.hash) {
                                         existingEntry.hash = hashRes.hash;
                                         addLog(`🔐 Hash nachgetragen – Datums-Korrektur folgt beim nächsten Lauf: ${existingEntry.filename} ${oldDateStr} -> ${newDateStr}`, 'warning');
                                    } else {
                                        addLog(`⚠️ Datums-Korrektur übersprungen (Hash nicht lesbar): ${existingEntry.filename}`, 'warning');
                                    }
                                } else {
                                    addLog(`📂 Verschiebe Datei: "${existingEntry.filename}"...`, 'warning');
                                    const moveResult = await window.electron.moveAndUpdateFile({
                                        basePath: exportPath,
                                        oldFilename: existingEntry.filename,
                                        oldTimestamp: existingEntry.timestamp,
                                        newTimestamp: webTimestamp,
                                        expectedHash: existingEntry.hash
                                    });

                                    if (moveResult.success) {
                                         existingEntry.timestamp = webTimestamp;
                                         if (moveResult.newFilename) existingEntry.filename = moveResult.newFilename;
                                         if (moveResult.newHash) existingEntry.hash = moveResult.newHash;
                                         metaUpdated = true;
                                         addLog(`✅ Verschoben: ${oldDateStr} -> ${newDateStr}. Pfad angepasst.`, 'success');
                                     } else if (moveResult.error === 'HASH_MISMATCH') {
                                         if (moveResult.actualHash) {
                                             existingEntry.hash = moveResult.actualHash;
                                             addLog(`🔐 Hash aktualisiert (Datei wurde früher umgeschrieben) – Korrektur folgt beim nächsten Lauf: ${existingEntry.filename}`, 'warning');
                                        } else {
                                            addLog(`❌ Hash-Mismatch – Korrektur abgebrochen: ${existingEntry.filename}`, 'error');
                                        }
                                    } else {
                                        addLog(`❌ Fehler beim Verschieben: ${moveResult.error}`, 'error');
                                    }
                                }
                            }

                            existingEntry.scannedAt = Date.now();

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
            }

            if (needsDownload) {
                if (!isAlbumMode) {
                    const trustInfo = evaluateScrapeTrust(panelRefreshedRef.current, result, webTimestamp, dbRef.current.files[result.id]);
                    trustedForPhoto = trustInfo.trusted;
                    // F14: nur bei Auffälligkeiten loggen (Vollprotokoll via VERBOSE_TRUST_LOG)
                    const trustProblem = !trustInfo.trusted || trustInfo.reason !== '' || (!panelRefreshedRef.current && !!prevTrueMetaRef.current);
                    if (VERBOSE_TRUST_LOG || trustProblem) {
                        addLog(`Trust: refreshed=${panelRefreshedRef.current} synced=${panelSyncedRef.current} reason=${trustInfo.reason || '-'} id=${result.id}`, 'debug');
                    }
                }
                await initiateDownloadAsync(result, targetPath, isAlbumMode, trustedForPhoto);
            }

            if (!isAlbumMode) {
                rememberTrueMeta(result.id, dbRef.current.files[result.id], result, webTimestamp, trustedForPhoto);
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
            if (changed) {
                currentId = await Crawler.extractIdFromUrl(webviewRef.current);
            } else {
                addLog(`Session beendet: Ausnahme und Navigation blockiert – bitte manuell prüfen.`, 'error');
                break;
            }
        }
    }
    
    // --- POST LOOP ---
    if (activeDownloadsRef.current > 0) {
        addLog(`Warte auf ${activeDownloadsRef.current} noch laufende Downloads...`, 'info');
        while (activeDownloadsRef.current > 0) {
            await sleep(500);
        }
    }

    if (isAlbumMode) {
        setIsWalking(false);
        isAlbumModeRef.current = false;
        albumTargetPathRef.current = null;
        addLog('[ALBUM] Album-Download beendet.', 'album');
        cancelPendingStarts(); // F10: defensiv
    } else {
        await finishBackupSession(desyncAbortRef.current);
    }
  };

  if (!isInitialized) return <StartupScreen onLoadDatabase={handleInitLoadDatabase} onNewDatabase={handleInitNewDatabase} />;

  const duplicateCount = integrityResult?.duplicates?.length || 0;
  const skippedCount = Object.keys(skippedPhotos).length; // F10
  const onlineMissingCount = onlineMissing.length; // F13
  const hasCorrections = orphans.length > 0 || corruptFilesCount > 0 || skippedCount > 0 || onlineMissingCount > 0;

  // F12: Download-Karten festen Slots zuordnen (Lücken bleiben stehen, nichts rutscht nach)
  const progressBySlot = new Map<number, [string, DownloadProgress]>();
  const unslottedProgress: [string, DownloadProgress][] = [];
  (Object.entries(activeProgress) as [string, DownloadProgress][]).forEach(([key, p]) => {
      if (typeof p.slot === 'number' && p.slot >= 1 && p.slot <= 5) progressBySlot.set(p.slot, [key, p]);
      else unslottedProgress.push([key, p]);
  });

  const renderProgressCard = (key: string, progress: DownloadProgress) => {
      const isWaiting = !!progress.waiting;
      const elapsed = isWaiting ? Math.max(0, Math.floor((nowTs - (progress.waitStartedAt || nowTs)) / 1000)) : 0;
      const waitLabel = progress.waitTimeoutMs === null ? 'ohne Limit' : `max. ${Math.round(DOWNLOAD_START_TIMEOUT_MS / 1000)} s`;
      return (
       <div key={key} className={`bg-blue-900/90 text-white p-2 rounded-lg shadow-xl border backdrop-blur-sm ${isWaiting ? 'border-sky-400' : 'border-blue-500'}`}>
          <div className="flex justify-between text-[10px] mb-1 font-mono">
              <span className="truncate max-w-[150px]">{progress.filename}</span>
              <span>{isWaiting ? `${elapsed} s` : (progress.total > 0 ? Math.round(progress.percent * 100) + '%' : '...')}</span>
          </div>
          <div className="h-1.5 bg-blue-950 rounded-full overflow-hidden">
              <div className={`h-full bg-blue-400 transition-all duration-200 ${progress.total === 0 ? 'animate-pulse w-full opacity-50' : ''}`} style={{width: progress.total > 0 ? `${progress.percent * 100}%` : '100%'}}></div>
          </div>
          {/* F11: reservierte Fußzeile -> konstante Kartenhöhe, Übergang verschiebt nichts */}
          <div className={`h-3 mt-0.5 text-[9px] leading-3 flex justify-between ${isWaiting ? 'text-sky-200/90' : 'text-transparent'}`}>
              <span>{isWaiting ? 'Warte auf Download…' : '\u00A0'}</span>
              <span>{isWaiting ? waitLabel : '\u00A0'}</span>
          </div>
      </div>
      );
  };

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
              skipped={Object.values(skippedPhotos).sort((a, b) => b.detectedAt - a.detectedAt)}
              onlineMissing={onlineMissing}
              onClose={() => setShowCorrectionModal(false)}
              onDeleteOrphans={executeDeleteOrphans}
              onResetOrphans={executeResetOrphans}
              onShowInFolder={handleShowFileInExplorer}
              onDeleteCorrupt={handleRemoveCorruptFile}
              onDeleteAllCorrupt={executeDeleteAllCorrupt}
              onNavigate={handleOpenMissingPhoto}
              onOpenSkipped={handleOpenMissingPhoto}
              onIgnoreSkipped={handleIgnoreSkipped}
              onIgnoreAllSkipped={handleIgnoreAllSkipped}
              onResetOnlineMissing={executeResetOnlineMissing}
              onDeleteAllOnlineMissing={executeDeleteAllOnlineMissing}
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
      {showAlbumModal && (
          <AlbumDownloadModal
              isOpen={showAlbumModal}
              onClose={() => setShowAlbumModal(false)}
              onStart={(folderName) => {
                  if (!exportPath) return;
                  const albumPath = exportPath + '\\Alben\\' + folderName;
                  albumTargetPathRef.current = albumPath;
                  setShowAlbumModal(false);
                  runBackupSession(true);
              }}
              basePath={exportPath}
          />
      )}
      
      <div className="flex-1 bg-white relative border-b-4 border-slate-700 min-h-[40%]">
        <webview ref={webviewRef} src="https://photos.google.com" className="w-full h-full" 
        // @ts-ignore
        allowpopups="true" />
        
        {/* DOWNLOAD STATUS OVERLAY (F12: feste Slots 1-5, fertige Downloads hinterlassen Lücken) */}
        <div className="absolute top-4 left-4 z-50 flex flex-col gap-2 w-80 pointer-events-none">
            {[1, 2, 3, 4, 5].map(slot => {
                const found = progressBySlot.get(slot);
                if (!found) {
                    // Unsichtbarer Platzhalter (gleicher Aufbau) -> freier Slot bleibt als Lücke stehen
                    return (
                        <div key={`slot-${slot}`} className="invisible w-full bg-blue-900/90 p-2 rounded-lg shadow-xl border border-blue-500">
                            <div className="flex justify-between text-[10px] mb-1 font-mono"><span>{'\u00A0'}</span><span>{'\u00A0'}</span></div>
                            <div className="h-1.5 bg-blue-950 rounded-full overflow-hidden"><div className="h-full w-full"></div></div>
                            <div className="h-3 mt-0.5 text-[9px] leading-3 flex justify-between"><span>{'\u00A0'}</span><span>{'\u00A0'}</span></div>
                        </div>
                    );
                }
                return renderProgressCard(found[0], found[1]);
            })}
            {unslottedProgress.map(([key, progress]) => renderProgressCard(key, progress))}
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
                     <span className="bg-white/20 px-1.5 rounded text-[10px]">{orphans.length + corruptFilesCount + skippedCount + onlineMissingCount}</span>
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
             <div className="flex justify-between items-center mb-1">
                 <h3 className="font-bold text-slate-400 uppercase text-xs tracking-wider">Wichtige Ereignisse</h3>
                 <button onClick={() => window.electron.openLogsFolder()} className="text-[10px] text-slate-400 hover:text-white px-1" title="Log-Ordner öffnen">📜 Logs</button>
             </div>
             <div className="flex-1 bg-black/50 rounded border border-slate-700 p-2 overflow-y-auto font-mono text-[10px] scrollbar-thin" ref={logContainerRef}>
                 {logs.map((l, i) => (
                    <div key={i} className={`mb-1 px-1 rounded ${
                        l.type === 'error' ? 'bg-red-900/30 text-red-300' : 
                        l.type === 'success' ? 'bg-green-900/30 text-green-300' : 
                        l.type === 'warning' ? 'bg-amber-900/30 text-amber-300' : 
                        l.type === 'album' ? 'bg-purple-900/30 text-purple-300 border-l-2 border-purple-500' : 
                        'text-slate-300'
                    }`}>
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