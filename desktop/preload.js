const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Returns the backend HTTP port (set after Python server starts)
  getBackendPort: () => ipcRenderer.invoke('get-backend-port'),

  // Opens a native folder picker; returns the selected path or null
  selectFolder: () => ipcRenderer.invoke('select-folder'),

  // Platform info
  platform: process.platform,
});
