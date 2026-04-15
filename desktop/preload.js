const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Returns the backend HTTP port (set after Python server starts).
  // May return null if called before the backend is ready.
  getBackendPort: () => ipcRenderer.invoke('get-backend-port'),

  // Subscribe to backend-ready event. Callback receives the port number.
  // Fires once when the Python server has finished booting.
  onBackendReady: (callback) => {
    ipcRenderer.on('backend-ready', (_event, port) => callback(port));
  },

  // Subscribe to backend-error event. Callback receives the error message string.
  // Fires if the Python server fails to start.
  onBackendError: (callback) => {
    ipcRenderer.on('backend-error', (_event, message) => callback(message));
  },

  // Opens a native folder picker; returns the selected path or null
  selectFolder: () => ipcRenderer.invoke('select-folder'),

  // Platform info
  platform: process.platform,
});
