// preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    log: (message) => ipcRenderer.send('log', message),
    quitApp: () => ipcRenderer.send('app:quit'),
    openFileDialog: () => ipcRenderer.invoke('dialog:openFile'),
    fetchSheetData: () => ipcRenderer.invoke('fetch-sheet-data'),
    analyzeVideos: (filePaths) => ipcRenderer.send('analyze-videos', filePaths),
    processVideos: (data) => ipcRenderer.send('process-videos', data),
    onLogMessage: (callback) => ipcRenderer.on('log-message', (event, ...args) => callback(...args)),
    onUpdateStatus: (callback) => ipcRenderer.on('update-status', (event, ...args) => callback(...args)),
    onProcessingComplete: (callback) => ipcRenderer.on('processing-complete', (event, ...args) => callback(...args)),
    onProcessingError: (callback) => ipcRenderer.on('processing-error', (event, ...args) => callback(...args)),
    onAnalyzeComplete: (callback) => ipcRenderer.on('analyze-complete', (event, ...args) => callback(...args)),
    onChapterUpdate: (callback) => ipcRenderer.on('chapter-update', (event, ...args) => callback(...args)),
});
