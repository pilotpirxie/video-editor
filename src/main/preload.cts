// Sandboxed preload: CommonJS, self-contained, no local imports.
import electron = require('electron')

const { contextBridge, ipcRenderer, webUtils } = electron

// This file is compiled without DOM types; this is the one page API it uses.
declare const window: { postMessage(message: unknown, targetOrigin: string, transfer: readonly unknown[]): void }

// Ports cannot cross the context bridge, so hand them to the page as a window message.
ipcRenderer.on('media-port', (event) => {
  window.postMessage({ type: 'media-port' }, '*', event.ports)
})

contextBridge.exposeInMainWorld('host', {
  openProjectDialog: () => ipcRenderer.invoke('open-project-dialog'),
  saveExportDialog: (suggestedName: string) => ipcRenderer.invoke('save-export-dialog', suggestedName),
  startExport: (job: unknown) => ipcRenderer.send('start-export', job),
  cancelExport: () => ipcRenderer.send('cancel-export'),
  reportJobEvent: (event: unknown) => ipcRenderer.send('job-event', event),
  // A dropped file's path is only readable here, not in the page.
  pathOfFile: (file: File) => webUtils.getPathForFile(file),
  onCommand: (listener: (command: unknown) => void) => {
    ipcRenderer.on('command', (_event, command) => listener(command))
  },
})
