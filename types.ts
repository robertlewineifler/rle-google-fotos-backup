

export interface GooglePhotoAlbum {
  id: string;
  title: string;
  mediaItemsCount: string;
  coverPhotoBaseUrl: string;
  productUrl: string;
}

export interface GoogleMediaItem {
  id: string;
  filename: string;
  baseUrl: string;
  mimeType: string;
  mediaMetadata: {
    creationTime: string;
    width: string;
    height: string;
    photo?: {
      cameraMake?: string;
      cameraModel?: string;
      focalLength?: number;
      apertureFNumber?: number;
      isoEquivalent?: number;
    };
  };
}

export interface ProcessingLog {
  timestamp: number;
  message: string;
  type: 'info' | 'error' | 'success' | 'debug' | 'warning';
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

export interface AppState {
  accessToken: string | null;
  albums: GooglePhotoAlbum[];
  selectedAlbums: Set<string>;
  isProcessing: boolean;
  progress: number;
  totalItemsToProcess: number;
  logs: ProcessingLog[];
}

export interface DownloadConfig {
    id: string; // NEU: ID zum Tracking
    targetDir: string;
    dateTimestamp: number; // Für fs.utimes
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
    hash?: string; // SHA-256 Hash
    finalDateTimestamp?: number; // Das tatsächlich geschriebene Datum (ggf. mit Sekunden aus Original)
}

export interface DownloadProgress {
    filename: string;
    percent: number; // 0.0 bis 1.0
    received: number; // bytes
    total: number; // bytes
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
    hash?: string;         // SHA-256 Hash des Datei-Inhalts
    size?: number;         // NEU: Dateigröße in Bytes
    missingSince?: number; // Timestamp, wann das Bild erstmals nicht mehr gefunden wurde
    integrityStatus?: 'ok' | 'corrupt'; // NEU: Ergebnis des File-Checks
    integrityCheckedAt?: number; // NEU: Wann geprüft
}

export interface FileDatabase {
    basePath: string; // Pfad zum Ordner, in dem die DB liegt (und die Fotos)
    dbFilePath?: string; // Voller Pfad zur JSON Datei
    lastUpdated: number;
    files: Record<string, DatabaseEntry>; // Key = Google Photo ID
    
    scannedDays?: Record<string, number>; // NEU: 'YYYY-MM-DD' -> Timestamp des letzten Scans
    scannedRanges?: ScannedRange[]; // VERALTET (Legacy support)
}

export interface IntegrityError {
    id: string;
    filename: string;
    timestamp: number;
    errorType?: 'missing' | 'corrupt'; // NEU: Unterscheidung
}

export interface IntegrityResult {
    missing: IntegrityError[];
    duplicates: { hash: string; ids: string[] }[];
    corrupt?: IntegrityError[]; // NEU: Liste der defekten Dateien
    total: number;
    updates: Record<string, string>; // ID -> Calculated Hash (for migration)
    sizeUpdates?: Record<string, number>; // NEU: ID -> Dateigröße in Bytes
    legacyCount?: number; // NEU: Anzahl veralteter Einträge
}

export interface RenamableFile {
    id: string;
    currentName: string;
    newName: string;
    timestamp: number;
    path: string; // Relativer Pfad
}

// Global Window Interface für Electron
declare global {
  interface Window {
    electron: {
      selectDirectory: () => Promise<string | null>;
      selectDatabaseFile: () => Promise<string | null>; // Neu: Wählt explizit Datei
      createDirectory: (path: string) => Promise<boolean>;
      clearSessionCache: () => Promise<void>;
      logToConsole: (msg: string, type?: string) => void;
      
      // Database Ops
      loadDatabase: (filePath: string) => Promise<FileDatabase | null>; // Nimmt jetzt FilePath
      saveDatabase: (filePath: string, data: FileDatabase) => Promise<boolean>;
      saveTextFile: (filePath: string, content: string) => Promise<{success: boolean, path?: string, error?: string}>; // NEU: CSV Export
      checkIntegrity: (basePath: string, files: Record<string, DatabaseEntry>) => Promise<IntegrityResult>;
      findRenamableFiles: (basePath: string, files: Record<string, DatabaseEntry>) => Promise<RenamableFile[]>;
      verifyFileIntegrityBatch: (basePath: string, files: {id: string, filename: string, timestamp: number}[]) => Promise<Record<string, 'ok' | 'corrupt'>>; // NEU

      // Download
      prepareDownload: (config: DownloadConfig) => Promise<boolean>;
      onDownloadStarted: (callback: (id: string) => void) => void; // NEU
      onDownloadComplete: (callback: (result: DownloadResult) => void) => void;
      onDownloadProgress: (callback: (progress: DownloadProgress) => void) => void;
      removeDownloadListener: () => void;
      
      // Datei Operationen
      deleteFile: (config: { basePath: string, filename: string, timestamp: number }) => Promise<boolean>;
      renameFile: (config: { basePath: string, oldName: string, newName: string, timestamp: number }) => Promise<boolean>;
      checkFileExists: (config: { basePath: string, filename: string, timestamp: number }) => Promise<boolean>;
      
      // NEU: Verschieben und Metadaten Update
      moveAndUpdateFile: (config: { 
          basePath: string, 
          oldFilename: string, 
          oldTimestamp: number, 
          newTimestamp: number 
      }) => Promise<{ success: boolean, newFilename?: string, error?: string }>;

      showItemInFolder: (fullPath: string) => Promise<void>;

      // API Proxy
      googleApiRequest: (url: string, options: any) => Promise<any>;
    };
  }
}