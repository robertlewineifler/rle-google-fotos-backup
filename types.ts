

export interface ProcessingLog {
  timestamp: number;
  message: string;
  type: 'info' | 'error' | 'success' | 'debug' | 'warning' | 'album';
}

export interface DownloadedFile {
    id: string;
    originalName: string; // Vom Server (Google)
    fileName: string;     // Lokal gespeichert
    webDate: Date;        // Vom Crawler erkannt
    fileDate: Date | null;// Datum der heruntergeladenen Datei (Exif/FS)
    originalExifDate?: Date | null; // Das ursprüngliche Datum in der Datei VOR Anpassung
    isMatch: boolean;
    wasAdjusted: boolean;
    type: 'image' | 'video';
    status: string;
    path: string;
}

export interface DownloadConfig {
    id: string; // NEU: ID zum Tracking
    targetDir: string;
    dateTimestamp: number; // Für fs.utimes
    flatStructure?: boolean; // NEU: Keine Jahr/Monat-Unterordner (für Album-Downloads)
    trusted?: boolean; // NEU: false => keine EXIF/QuickTime/FS-Rewrites (Panel unsicher)
}

export interface DownloadResult {
    id: string; // NEU: ID zum Tracking
    success: boolean;
    filename: string; // Der finale Dateiname auf der Festplatte
    progressFilename?: string; // Der Name, unter dem der Fortschritt gemeldet wurde (wichtig bei ZIPs)
    originalName: string;
    path: string;
    error?: string;
    originalExifDate?: string; // Raw Exif String
    hash?: string; // SHA-256 nach Metadaten-Rewrite (Datei auf der Platte)
    sourceHash?: string; // SHA-256 des Rohdownloads vor dem Rewrite
    finalDateTimestamp?: number; // Das tatsächlich geschriebene Datum (ggf. mit Sekunden aus Original)
    metadataWritten?: boolean; // NEU: false => Metadaten wurden bewusst nicht angefasst
}

export interface DownloadProgress {
    filename: string;
    percent: number; // 0.0 bis 1.0
    received: number; // bytes
    total: number; // bytes
    // F11: Warteanzeige (bis download-started eintrifft)
    waiting?: boolean;
    waitStartedAt?: number;
    waitTimeoutMs?: number | null; // 45000 im Backup, null = Einzeldownload ohne Limit
    slot?: number; // F12: fester UI-Slot 1-5 (kein Nachrutschen)
}

// --- DATABASE TYPES ---

export interface ScannedRange {
    startDate: number;
    endDate: number;
    scannedAt: number;
}

export interface DatabaseEntry {
    filename: string;
    timestamp: number; // Web Datum (bestimmt den Ordner)
    originalDate?: string;
    originalName?: string; // NEU: Der Name der Datei auf Google Photos (ohne Kollisions-Zähler)
    savedAt: number; // Veraltet (Legacy), wird beibehalten
    downloadedAt?: number; // Neu: Wann wurde die Datei zuletzt heruntergeladen
    scannedAt?: number;    // Neu: Wann wurde die Datei zuletzt online gesichtet
    hash?: string;         // SHA-256 der Datei WIE SIE AUF DER PLATTE LIEGT (nach Metadaten-Rewrite)
    sourceHash?: string;   // SHA-256 des Google-Rohdownloads VOR jedem lokalen Rewrite (stabiler Quell-Fingerprint)
    size?: number;         // NEU: Dateigröße in Bytes
    missingSince?: number; // Timestamp, wann die Datei erstmals lokal nicht mehr gefunden wurde
    onlineMissingSince?: number; // Timestamp, wann das Bild online (im Scan) erstmals nicht mehr gesehen wurde (Datei lokal vorhanden)
    integrityStatus?: 'ok' | 'corrupt'; // NEU: Ergebnis des File-Checks
    integrityCheckedAt?: number; // NEU: Wann geprüft
}

// F10: Fotos, deren Download-Start nach dem Timeout nie bestätigt wurde (Google-ID als Key).
export interface SkippedDownload {
    id: string;                 // Google Photo ID (aus /photo/<id>)
    webTimestamp: number;       // Web-Datum aus dem Panel; 0 = unbekannt
    filename?: string;          // Dateiname aus dem Panel, falls ermittelbar
    detectedAt: number;         // Zeitpunkt des Timeouts
    mode: 'backup' | 'album';
}

export interface FileDatabase {
    basePath: string; // Pfad zum Ordner, in dem die DB liegt (und die Fotos)
    dbFilePath?: string; // Voller Pfad zur JSON Datei
    lastUpdated: number;
    files: Record<string, DatabaseEntry>; // Key = Google Photo ID
    
    scannedDays?: Record<string, number>; // NEU: 'YYYY-MM-DD' -> Timestamp des letzten Scans
    skippedDownloads?: Record<string, SkippedDownload>; // F10: Key = Google Photo ID
    scannedRanges?: ScannedRange[]; // VERALTET (Legacy support)
    hashScheme?: number; // NEU: 2 = sourceHash/hash getrennt (Migration abgeschlossen)
}

export interface IntegrityError {
    id: string;
    filename: string;
    timestamp: number;
    errorType?: 'missing' | 'corrupt'; // NEU: Unterscheidung
}

// F21: Datei auf der Platte, die in keinem DB-Eintrag referenziert ist.
export interface UntrackedFile {
    path: string;         // vollständiger Pfad
    filename: string;
    year: string;
    month: string;
    size: number;
    hash?: string;
    duplicateOf?: string; // Dateiname eines getrackten Fotos mit identischem Hash
    // F23: Basisdatei (ohne "(n)"), während der getrackte Eintrag ein "(n)"-Duplikat ist
    trackedDuplicate?: { id: string; filename: string };
}

export interface IntegrityResult {
    missing: IntegrityError[];
    duplicates: { hash: string; ids: string[] }[];
    corrupt?: IntegrityError[]; // NEU: Liste der defekten Dateien
    total: number;
    updates: Record<string, string>; // ID -> Calculated Hash (for migration)
    sizeUpdates?: Record<string, number>; // NEU: ID -> Dateigröße in Bytes
    legacyCount?: number; // NEU: Anzahl veralteter Einträge
    untracked?: UntrackedFile[]; // F21: verwaiste Dateien auf der Platte
    renamable?: { // F24: Ergebnis der Dateinamen-Prüfung (Info-Tab)
        entries: RenameCheckEntry[];
        stats?: RenamableStats;
        autoRenamed?: number;
        autoResolved?: number;
    };
}

export interface RenamableFile {
    id: string;
    currentName: string;
    newName: string;
    timestamp: number;
    path: string; // Relativer Pfad
    resolveDuplicate?: boolean; // F23: Basisdatei hash-identisch -> Duplikat auflösen statt umbenennen
}

export interface RenamableStats {
    nTotal: number;          // Einträge mit "(n)" im Namen
    legitNames: number;      // "(n)" gehört zum echten Google-Namen
    noName: number;          // kein originalName gespeichert
    nameMismatch: number;    // originalName passt nicht zum Basisnamen
    currentMissing: number;  // "(n)"-Datei liegt nicht auf der Platte
    collisionPair: number;   // Basisdatei existiert ebenfalls, Inhalt unterschiedlich
    targetMissing: number;   // Basisname ist frei -> Kandidat
    resolveDuplicate: number; // F23: Basisdatei hash-identisch -> auflösbar
}

// F24: Einzel-Eintrag der Dateinamen-Prüfung (für den Info-Tab).
export interface RenameCheckEntry {
    id: string;
    currentName: string;
    newName?: string;
    originalName?: string;
    timestamp: number;
    status: 'protected' | 'noName' | 'nameMismatch' | 'missing'
          | 'collision' | 'resolveDuplicate' | 'renamable';
}

// Global Window Interface für Electron
declare global {
  interface Window {
    electron: {
      selectDirectory: () => Promise<string | null>;
      selectDatabaseFile: () => Promise<string | null>; // Neu: Wählt explizit Datei
      clearSessionCache: () => Promise<void>;
      logToConsole: (msg: string, type?: string) => void;
      openLogsFolder: () => Promise<string>;
      
      // Database Ops
      loadDatabase: (filePath: string) => Promise<FileDatabase | null>; // Nimmt jetzt FilePath
      saveDatabase: (filePath: string, data: FileDatabase) => Promise<boolean>;
      saveTextFile: (filePath: string, content: string) => Promise<{success: boolean, path?: string, error?: string}>; // NEU: CSV Export
      checkIntegrity: (basePath: string, files: Record<string, DatabaseEntry>, onlySubset?: boolean) => Promise<IntegrityResult>;
      findRenamableFiles: (basePath: string, files: Record<string, DatabaseEntry>) => Promise<{ candidates: RenamableFile[], stats: RenamableStats, entries?: RenameCheckEntry[] }>;
      verifyFileIntegrityBatch: (basePath: string, files: {id: string, filename: string, timestamp: number}[]) => Promise<Record<string, 'ok' | 'corrupt'>>; // NEU

      // Download
      prepareDownload: (config: DownloadConfig) => Promise<boolean>;
      cancelPendingDownload: () => Promise<boolean>; // F10: entwertet die offene Download-Config
      onDownloadStarted: (callback: (id: string, filename: string) => void) => void; // F11: finaler Dateiname
      onDownloadComplete: (callback: (result: DownloadResult) => void) => void;
      onDownloadProgress: (callback: (progress: DownloadProgress) => void) => void;
      removeDownloadListener: () => void;
      
      // Datei Operationen
      deleteFile: (config: { basePath: string, filename: string, timestamp: number }) => Promise<boolean>;
      renameFile: (config: { basePath: string, oldName: string, newName: string, timestamp: number, expectedHash?: string }) => Promise<{ success: boolean, error?: string }>;
      checkFileExists: (config: { basePath: string, filename: string, timestamp: number }) => Promise<boolean>;
      computeFileHash: (config: { basePath: string, filename: string, timestamp: number }) => Promise<{ success: boolean, hash?: string, error?: string }>;
      
      // NEU: Verschieben und Metadaten Update
      moveAndUpdateFile: (config: { 
          basePath: string, 
          oldFilename: string, 
          oldTimestamp: number, 
          newTimestamp: number,
          expectedHash?: string
      }) => Promise<{ success: boolean, newFilename?: string, newHash?: string, actualHash?: string, error?: string }>;

      showItemInFolder: (fullPath: string) => Promise<void>;
      openFile: (fullPath: string) => Promise<string>; // F16: Standard-Viewer; "" = Erfolg
    };
  }
}