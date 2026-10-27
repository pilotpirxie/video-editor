import electron = require('electron')

const { contextBridge, ipcRenderer, webUtils } = electron

declare const window: { postMessage(message: unknown, targetOrigin: string, transfer: readonly unknown[]): void }

ipcRenderer.on('media-port', (event) => {
  window.postMessage({ type: 'media-port' }, '*', event.ports)
})

contextBridge.exposeInMainWorld('host', {
  openProjectDialog: () => ipcRenderer.invoke('open-project-dialog'),
  saveExportDialog: (suggestedName: string) => ipcRenderer.invoke('save-export-dialog', suggestedName),
  startExport: (job: unknown) => ipcRenderer.send('start-export', job),
  cancelExport: () => ipcRenderer.send('cancel-export'),
  reportJobEvent: (event: unknown) => ipcRenderer.send('job-event', event),
  pathOfFile: (file: File) => webUtils.getPathForFile(file),
  onCommand: (listener: (command: unknown) => void) => {
    ipcRenderer.on('command', (_event, command) => listener(command))
  },
  documentInfo: () => ipcRenderer.invoke('document-info'),
  setDocumentState: (state: unknown) => ipcRenderer.send('document-state', state),
  setDocumentPath: (path: string) => ipcRenderer.send('document-path', path),
  saveProjectDialog: () => ipcRenderer.invoke('save-project-dialog'),
  importMediaDialog: () => ipcRenderer.invoke('import-media-dialog'),
  newAnimationDialog: () => ipcRenderer.invoke('new-animation-dialog'),
  chooseMediaFile: (name: string) => ipcRenderer.invoke('choose-media-file', name),
  showLastExport: () => ipcRenderer.send('show-last-export'),
  confirmUnsavedChanges: () => ipcRenderer.invoke('confirm-unsaved-changes'),
  closeDocument: () => ipcRenderer.send('close-document'),
  discardRecovery: () => ipcRenderer.send('discard-recovery'),
  setMenuShortcuts: (shortcuts: unknown) => ipcRenderer.send('menu-shortcuts', shortcuts),
  reportSlowFrame: (frame: unknown) => ipcRenderer.send('slow-frame', frame),
  debugInfo: () => ipcRenderer.invoke('debug-info'),
  settings: () => ipcRenderer.invoke('settings'),
  setSettings: (settings: unknown) => ipcRenderer.send('set-settings', settings),
})
