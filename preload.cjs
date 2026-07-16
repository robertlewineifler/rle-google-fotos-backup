








const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  selectDatabaseFile: () => ipcRenderer.invoke('select-database-file'),
  createDirectory: (path) => ipcRenderer.invoke('create-directory', path),
  clearSessionCache: () => ipcRenderer.invoke('clear-session-cache'),
  // Update: Nimmt jetzt auch 'type' entgegen
  logToConsole: (msg, type) => ipcRenderer.send('log-to-console', msg, type),
  
  // Database Functions
  loadDatabase: (filePath) => ipcRenderer.invoke('load-database', filePath),
  saveDatabase: (filePath, data) => ipcRenderer.invoke('save-database', filePath, data),
  saveTextFile: (filePath, content) => ipcRenderer.invoke('save-text-file', filePath, content), // NEU
  checkIntegrity: (basePath, files, onlySubset) => ipcRenderer.invoke('check-db-integrity', { basePath, files, onlySubset }),
  findRenamableFiles: (basePath, files) => ipcRenderer.invoke('find-renamable-files', { basePath, files }),
  verifyFileIntegrityBatch: (basePath, files) => ipcRenderer.invoke('verify-file-integrity-batch', basePath, files),

  // Neue Funktionen für Shift+D Flow
  prepareDownload: (config) => ipcRenderer.invoke('prepare-download', config),
  onDownloadStarted: (callback) => {
      const listener = (event, id) => callback(id);
      ipcRenderer.on('download-started', listener);
  },
  onDownloadComplete: (callback) => {
      const listener = (event, result) => callback(result);
      ipcRenderer.on('download-complete', listener);
  },
  onDownloadProgress: (callback) => {
      const listener = (event, progress) => callback(progress);
      ipcRenderer.on('download-progress', listener);
  },
  removeDownloadListener: () => {
      ipcRenderer.removeAllListeners('download-started');
      ipcRenderer.removeAllListeners('download-complete');
      ipcRenderer.removeAllListeners('download-progress');
  },
  
  // Datei Operationen
  deleteFile: (config) => ipcRenderer.invoke('delete-file', config),
  renameFile: (config) => ipcRenderer.invoke('rename-file', config),
  checkFileExists: (config) => ipcRenderer.invoke('check-file-exists', config),
  showItemInFolder: (fullPath) => ipcRenderer.invoke('show-item-in-folder', fullPath),
  
  moveAndUpdateFile: (config) => ipcRenderer.invoke('move-and-update-file', config),
  
  // API Proxy
  googleApiRequest: (url, options) => ipcRenderer.invoke('google-api-request', url, options)
});