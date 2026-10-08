const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Returns the backend HTTP port (set after Python server starts).
  // May return null if called before the backend is ready.
  getBackendPort: () => ipcRenderer.invoke('get-backend-port'),

  // Subscribe to backend events (one-shot lifecycle events).
  // Returns a cleanup function to deregister the listener if the component unmounts before the event fires.
  onBackendReady: (callback) => {
    const handler = (_event, port) => callback(port);
    ipcRenderer.once('backend-ready', handler);
    return () => ipcRenderer.removeListener('backend-ready', handler);
  },
  onBackendError: (callback) => {
    const handler = (_event, message) => callback(message);
    ipcRenderer.once('backend-error', handler);
    return () => ipcRenderer.removeListener('backend-error', handler);
  },

  // Starts the backend again after a startup failure (events are re-sent to the renderer).
  retryBackend: () => ipcRenderer.invoke('retry-backend'),

  // Opens a native folder picker; returns the selected path or null
  selectFolder: () => ipcRenderer.invoke('select-folder'),

  // Opens a local file using the OS default application (e.g. Excel for .xlsx, Word for .docx)
  openPath: (filePath) => ipcRenderer.invoke('open-path', filePath),

  // Opens an external URL in the default web browser
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // Auto-update (GitHub releases)
  getUpdateInfo: () => ipcRenderer.invoke('update-get'),
  checkForUpdate: () => ipcRenderer.invoke('update-check'),
  downloadUpdate: () => ipcRenderer.invoke('update-download'),
  installUpdate: (filePath) => ipcRenderer.invoke('update-install', filePath),
  onUpdateAvailable: (callback) => {
    const handler = (_event, info) => callback(info);
    ipcRenderer.on('update-available', handler);
    return () => ipcRenderer.removeListener('update-available', handler);
  },
  onUpdateProgress: (callback) => {
    const handler = (_event, fraction) => callback(fraction);
    ipcRenderer.on('update-progress', handler);
    return () => ipcRenderer.removeListener('update-progress', handler);
  },

  // Platform info
  platform: process.platform,
});
