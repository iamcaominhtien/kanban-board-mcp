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

  // Opens a native folder picker; returns the selected path or null
  selectFolder: () => ipcRenderer.invoke('select-folder'),

  // Platform info
  platform: process.platform,
});
