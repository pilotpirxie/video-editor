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
  confirmUnsavedChanges: () => ipcRenderer.invoke('confirm-unsaved-changes'),
  replaceDocument: (next: unknown) => ipcRenderer.send('replace-document', next),
  discardRecovery: () => ipcRenderer.send('discard-recovery'),
})
