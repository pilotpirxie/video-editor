import { exportJobFor, selectionRange, type ExportChoices } from '../editor/export.js'
import { mediaFileName, mediaUses, relinkedMedia, unlinkedMedia, withMedia } from '../editor/place.js'
import type { MediaStates } from '../engine/resolve.js'
import { describeError, logError } from '../shared/log.js'
import type { DocumentInfo, DocumentState, HostCommand, JobEvent, MediaClient, NextDocument, Preparation } from '../shared/mediaProtocol.js'
import { projectDuration, type Project } from '../shared/project.js'
import { createActions, type Actions } from './actions.js'
import type { EngineHost } from './engineHost.js'
import { createEditorStore, type EditorStore } from './store.js'
import { createThumbnails, type Thumbnails } from './thumbnails.js'
import { createTransport, isModalOpen, isTypingTarget, type Transport } from './transport.js'

const AUTOSAVE_INTERVAL_MS = 10_000
const PREPARATION_POLL_MS = 500

type PreparationStates = Readonly<Record<string, Preparation>>

export type Session = {
  store: EditorStore
  transport: Transport
  engine: EngineHost
  actions: Actions
  thumbnails: Thumbnails
  preparation(): PreparationStates
  onPreparation(listener: () => void): () => void
  open(): Promise<void>
  importFiles(paths: readonly string[]): Promise<void>
  chooseAndImport(): Promise<void>
  relink(mediaId: string): Promise<void>
  exportVideo(choices: ExportChoices): Promise<void>
  cancelExport(): void
}

type SentProject = {
  project: Project
  mediaStates: MediaStates
}

export function createSession(engine: EngineHost, media: MediaClient, info: DocumentInfo): Session {
  const store = createEditorStore()
  const transport = createTransport(engine, store.notify)
  const actions = createActions(store, transport)
  const thumbnails = createThumbnails(media, () => transport.position().isPlaying)
  const preparationListeners = new Set<() => void>()
  let preparation: PreparationStates = {}
  let preparationTimer: number | undefined
  let sent: SentProject | undefined
  let isSendScheduled = false
  let reportedState = ''
  let recovered = store.getState().project
  let recoveryWork: Promise<void> = Promise.resolve()
  let hasRecoveryFailed = false

  // Preparation is only asked about while something is still being prepared, so an idle editor does no work.
  async function pollPreparation(): Promise<void> {
    preparationTimer = undefined
    try {
      preparation = await media.preparation()
    } catch (error) {
      logError('Could not read the preparation progress', error)
      return
    }
    for (const listener of preparationListeners) listener()
    const isBusy = Object.values(preparation).some((state) => state.progress < 1 && !state.hasFailed)
    if (isBusy) preparationTimer = window.setTimeout(() => void pollPreparation(), PREPARATION_POLL_MS)
  }

  function watchPreparation(): void {
    if (preparationTimer === undefined) preparationTimer = window.setTimeout(() => void pollPreparation(), 0)
  }

  async function importFiles(paths: readonly string[]): Promise<void> {
    const known = new Set(store.getState().project.media.map((reference) => reference.path))
    const fresh = [...new Set(paths)].filter((path) => !known.has(path))
    const failures: string[] = []
    for (const [index, path] of fresh.entries()) {
      store.setPendingImports(fresh.slice(index))
      try {
        const added = await media.addMedia(path)
        store.setMediaState(added.id, { info: added.info })
        store.apply('Import Media', (project) => withMedia(project, { id: added.id, path, relativePath: '' }))
        watchPreparation()
      } catch (error) {
        failures.push(describeError(error))
      }
    }
    store.setPendingImports([])
    if (failures.length > 0) store.notify(failures.join(' '))
  }

  async function chooseAndImport(): Promise<void> {
    await importFiles(await window.host.importMediaDialog())
  }

  // Asks where a file went. The other missing files are looked for in the same folder, so one answer usually brings them all back.
  async function relink(mediaId: string): Promise<void> {
    const { project, mediaStates } = store.getState()
    const reference = project.media.find((candidate) => candidate.id === mediaId)
    if (reference === undefined) return
    const path = await window.host.chooseMediaFile(mediaFileName(reference))
    if (path === undefined) return

    const others = unlinkedMedia(project, mediaStates).filter((unlinked) => unlinked.reference.id !== mediaId)
    try {
      const found = await media.relinkMedia(path, { reference, uses: mediaUses(project, mediaId) }, others)
      for (const item of found) store.setMediaState(item.id, { info: item.info })
      store.apply('Relink Media', (current) => relinkedMedia(current, found))
      watchPreparation()
      if (found.length > 1) store.notify(`${found.length - 1} more missing ${found.length === 2 ? 'file was' : 'files were'} found in the same folder.`)
    } catch (error) {
      store.notify(describeError(error))
    }
  }

  // The engine gets the whole project at most once per frame, however many pointer events arrived in between.
  function sendToEngine(): void {
    isSendScheduled = false
    const { project, mediaStates } = store.getState()
    if (sent !== undefined && sent.project === project && sent.mediaStates === mediaStates) return
    sent = { project, mediaStates }
    engine.send({ type: 'project', loaded: { project, media: mediaStates } })
  }

  function reportDocumentState(): void {
    const { project, savedProject, history } = store.getState()
    const state: DocumentState = {
      isDirty: project !== savedProject,
      undoLabel: history.done.at(-1)?.label,
      redoLabel: history.undone.at(-1)?.label,
    }
    const key = `${state.isDirty}|${state.undoLabel ?? ''}|${state.redoLabel ?? ''}`
    if (key === reportedState) return
    reportedState = key
    window.host.setDocumentState(state)
  }

  store.subscribe(() => {
    reportDocumentState()
    if (isSendScheduled) return
    isSendScheduled = true
    requestAnimationFrame(sendToEngine)
  })

  async function writeRecovery(earlier: Promise<void>, project: Project): Promise<void> {
    await earlier
    if (project === store.getState().savedProject) {
      window.host.discardRecovery()
      return
    }
    try {
      await media.saveProject(info.recoveryPath, project)
      hasRecoveryFailed = false
    } catch (error) {
      logError('Could not write the recovery file', error, { recoveryPath: info.recoveryPath })
      if (!hasRecoveryFailed) store.notify(`Autosave is not working: ${describeError(error)}`)
      hasRecoveryFailed = true
    }
  }

  function autosave(): void {
    const project = store.committedProject()
    if (project === recovered) return
    recovered = project
    recoveryWork = writeRecovery(recoveryWork, project)
  }

  const autosaveTimer = setInterval(autosave, AUTOSAVE_INTERVAL_MS)

  async function saveTo(path: string): Promise<boolean> {
    const project = store.committedProject()
    try {
      await media.saveProject(path, project)
    } catch (error) {
      store.notify(describeError(error))
      return false
    }
    store.markSaved(project, path)
    window.host.setDocumentPath(path)
    autosave()
    return true
  }

  async function save(): Promise<boolean> {
    const path = store.getState().documentPath ?? (await window.host.saveProjectDialog())
    return path === undefined ? false : saveTo(path)
  }

  async function saveAs(): Promise<boolean> {
    const path = await window.host.saveProjectDialog()
    return path === undefined ? false : saveTo(path)
  }

  function fileNameOf(path: string): string {
    return path.split('/').at(-1) ?? path
  }

  // The export reads a copy of the project written at this moment. From here until its result has been read, a dialog holds the window, so nothing plays or changes behind it.
  async function exportVideo(choices: ExportChoices): Promise<void> {
    transport.pause()
    const { documentPath, selection } = store.getState()
    const projectName = documentPath === undefined ? 'Untitled' : fileNameOf(documentPath).replace(/\.json$/, '')
    const outputPath = await window.host.saveExportDialog(`${projectName}.mp4`)
    if (outputPath === undefined) return

    const snapshot = store.committedProject()
    try {
      await media.saveProject(info.exportSnapshotPath, snapshot)
    } catch (error) {
      store.notify(`The export could not start: ${describeError(error)}`)
      return
    }
    const job = exportJobFor(choices, selectionRange(snapshot, selection), { projectPath: info.exportSnapshotPath, outputPath })
    store.setExportStatus({ phase: 'running', fileName: fileNameOf(outputPath), done: 0, total: 1, startedAt: performance.now() })
    window.host.startExport(job)
  }

  // Nothing comes back from a cancelled export: its window is closed and its unfinished file removed.
  function cancelExport(): void {
    window.host.cancelExport()
    store.setExportStatus(undefined)
  }

  function onExportEvent(event: JobEvent): void {
    const running = store.getState().exportStatus
    if (running?.phase !== 'running') return
    const { fileName } = running
    if (event.type === 'progress') store.setExportStatus({ ...running, done: event.done, total: event.total })
    else if (event.type === 'done') store.setExportStatus({ phase: 'done', fileName })
    else store.setExportStatus({ phase: 'failed', fileName, message: event.message })
  }

  function openExportDialog(): void {
    const { project, exportStatus } = store.getState()
    if (exportStatus === undefined && projectDuration(project) > 0) store.showExportDialog(true)
  }

  // New, Open and Close all leave the current document, so they share one unsaved-changes check.
  async function leaveFor(next: NextDocument): Promise<void> {
    store.cancel()
    const { project, savedProject } = store.getState()
    if (project !== savedProject) {
      const choice = await window.host.confirmUnsavedChanges()
      if (choice === 'cancel') return
      if (choice === 'save' && !(await save())) return
    }
    // An autosave still running would write the recovery file again after the main process removed it.
    clearInterval(autosaveTimer)
    await recoveryWork
    window.host.replaceDocument(next)
  }

  async function chooseAndOpen(): Promise<void> {
    const path = await window.host.openProjectDialog()
    if (path !== undefined) await leaveFor({ kind: 'open', path })
  }

  function undoOrRedo(action: 'undo' | 'redo'): void {
    // The menu shortcut also arrives while a text field has focus, where it must undo typing, not the project.
    if (isTypingTarget(document.activeElement)) {
      document.execCommand(action)
    } else if (action === 'undo') {
      store.undo()
    } else {
      store.redo()
    }
  }

  // Like Undo, the menu's Select All also arrives while a text field has focus, where it must select the text.
  function selectAll(): void {
    if (isTypingTarget(document.activeElement)) document.execCommand('selectAll')
    else actions.selectAll()
  }

  window.host.onCommand((command: HostCommand) => {
    if (command.type === 'export-event') {
      onExportEvent(command.event)
      return
    }
    // Under an open dialog the project can still be saved and the window closed; every other command waits for the dialog to go.
    const isForUnderADialog = command.type === 'menu' && (command.action === 'save' || command.action === 'save-as' || command.action === 'close')
    if (isModalOpen() && !isForUnderADialog) return
    if (command.type === 'open-project') {
      void leaveFor({ kind: 'open', path: command.path })
    } else if (command.type !== 'menu') {
      return
    } else if (command.action === 'export') {
      openExportDialog()
    } else if (command.action === 'new') {
      void leaveFor({ kind: 'new' })
    } else if (command.action === 'close') {
      void leaveFor({ kind: 'close' })
    } else if (command.action === 'open-project') {
      void chooseAndOpen()
    } else if (command.action === 'save') {
      void save()
    } else if (command.action === 'save-as') {
      void saveAs()
    } else if (command.action === 'undo' || command.action === 'redo') {
      undoOrRedo(command.action)
    } else if (command.action === 'import') {
      void chooseAndImport()
    } else if (command.action === 'split') {
      actions.split()
    } else if (command.action === 'split-all') {
      actions.splitAll()
    } else if (command.action === 'select-all') {
      selectAll()
    } else if (command.action === 'deselect-all') {
      store.select([])
    } else if (command.action === 'duplicate') {
      actions.duplicate()
    } else if (command.action === 'delete') {
      actions.deleteSelection(false)
    } else if (command.action === 'ripple-delete') {
      actions.deleteSelection(true)
    }
  })

  async function open(): Promise<void> {
    if (info.loadFrom === undefined) return
    try {
      const loaded = await media.loadProject(info.loadFrom, true)
      const isRecovered = info.loadFrom !== info.path
      store.open(loaded, info.path, !isRecovered)
      recovered = loaded.project
      watchPreparation()
      const missingCount = unlinkedMedia(loaded.project, loaded.media).length
      if (missingCount > 0) store.notify(`${missingCount} media ${missingCount === 1 ? 'file is' : 'files are'} missing. Use Relink in the Media tab to say where ${missingCount === 1 ? 'it is' : 'they are'}.`)
    } catch (error) {
      // The path is not kept: Save must ask where to write instead of replacing a file that could not be read.
      store.notify(describeError(error))
    }
  }

  return {
    store,
    transport,
    engine,
    actions,
    thumbnails,
    preparation: () => preparation,
    onPreparation(listener) {
      preparationListeners.add(listener)
      return () => preparationListeners.delete(listener)
    },
    open,
    importFiles,
    chooseAndImport,
    relink,
    exportVideo,
    cancelExport,
  }
}
