const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Returns the backend HTTP port (set after Python server starts).
  // May return null if called before the backend is ready.
  getBackendPort: () => ipcRenderer.invoke('get-backend-port'),

  // Subscribe to backend events (one-shot lifecycle events — use once to prevent duplicate listeners).
  onBackendReady: (callback) => ipcRenderer.once('backend-ready', (_event, port) => callback(port)),
  onBackendError: (callback) => ipcRenderer.once('backend-error', (_event, message) => callback(message)),

  // Opens a native folder picker; returns the selected path or null
  selectFolder: () => ipcRenderer.invoke('select-folder'),

  // Platform info
  platform: process.platform,
});
