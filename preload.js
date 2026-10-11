const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    printSilent: () => ipcRenderer.send('print-silent'),
    reloadApp: (hard) => ipcRenderer.send('reload-app', hard)
});
