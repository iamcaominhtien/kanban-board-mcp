const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Returns the backend HTTP port (set after Python server starts)
  getBackendPort: () => ipcRenderer.invoke('get-backend-port'),

  // Platform info
  platform: process.platform,
});
