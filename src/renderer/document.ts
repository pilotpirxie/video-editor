import { exportJobFor, selectionRange, type ExportChoices } from '../editor/export.js'
import { allClips } from '../editor/clips.js'
import { mediaFileName, mediaUses, relinkedMedia, unlinkedMedia, withMedia } from '../editor/place.js'
import { menuShortcutsOf, parseBindings, type Bindings } from '../editor/shortcuts.js'
import { missingFonts } from '../editor/text.js'
import type { MediaStates } from '../engine/resolve.js'
import { describeError, describeErrorAsSentence, logError } from '../shared/log.js'
import type { AddedMedia, DocumentInfo, DocumentState, HostCommand, JobEvent, MenuAction, Preparation } from '../shared/mediaProtocol.js'
import { projectDuration, type Project } from '../shared/project.js'
import { frameDuration } from '../shared/time.js'
import { createActions, type Actions } from './actions.js'
import type { EngineHost, MediaPorts } from './engineHost.js'
import { installedFontFamilies } from './fonts.js'
import type { MediaConnection } from './mediaClient.js'
import { createEditorStore, type EditorStore } from './store.js'
import { createThumbnails, type Thumbnails } from './thumbnails.js'
import { createTransport, isModalOpen, isTypingTarget, type Transport } from './transport.js'

const AUTOSAVE_INTERVAL_MS = 10_000
const PREPARATION_POLL_MS = 500
// Chromium gives the preview back within a second or two of starting a new GPU process.
const PREVIEW_RETURN_MS = 5_000

type PreparationStates = Readonly<Record<string, Preparation>>

export type Session = {
  store: EditorStore
  transport: Transport
  engine: EngineHost
  actions: Actions
  thumbnails: Thumbnails
  // Decides which encoder an MP4 starts with.
  hasSmallMemory: boolean
  preparation(): PreparationStates
  onPreparation(listener: () => void): () => void
  open(): Promise<void>
  importFiles(paths: readonly string[]): Promise<void>
  chooseAndImport(): Promise<void>
  relink(mediaId: string): Promise<void>
  exportVideo(choices: ExportChoices): Promise<void>
  cancelExport(): void
  runMenuAction(action: MenuAction): void
  // The keys of the actions, as chosen on this Mac.
  shortcuts: Shortcuts
  // The View menu shows and hides the panels, which the window lays out.
  onPanelToggle(listener: (panel: Panel) => void): () => void
}

export type Panel = 'library' | 'properties' | 'timeline'

type Shortcuts = {
  get(): Bindings
  set(bindings: Bindings): void
  subscribe(listener: () => void): () => void
}

const SHORTCUTS_KEY = 'shortcuts'
// Sent on the window for the menu's Select All, before the clips are selected.
export const SELECT_ALL_EVENT = 'editor-select-all'
// Sent on the window for Delete and Ripple Delete, before the clips are deleted.
export const DELETE_EVENT = 'editor-delete'

// The keys are kept per Mac, for every window: a change in one window reaches the others through the storage they share.
function createShortcuts(): Shortcuts {
  let bindings = parseBindings(localStorage.getItem(SHORTCUTS_KEY) ?? undefined)
  const listeners = new Set<() => void>()

  function tellMenu(): void {
    window.host.setMenuShortcuts(menuShortcutsOf(bindings))
  }

  function changeTo(next: Bindings): void {
    bindings = next
    for (const listener of listeners) listener()
    tellMenu()
  }

  window.addEventListener('storage', (event) => {
    if (event.key === SHORTCUTS_KEY) changeTo(parseBindings(event.newValue ?? undefined))
  })
  tellMenu()

  return {
    get: () => bindings,
    set(next) {
      try {
        localStorage.setItem(SHORTCUTS_KEY, JSON.stringify(next))
      } catch (error) {
        logError('Could not remember the keys', error)
      }
      changeTo(next)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

type SentProject = {
  project: Project
  mediaStates: MediaStates
}

// A font this Mac does not have is drawn as the system font, and its name stays in the file for a Mac that has it.
async function missingFontsNotice(project: Project): Promise<string | undefined> {
  let installed: string[]
  try {
    installed = await installedFontFamilies()
  } catch (error) {
    logError('Could not list the installed fonts to look for missing ones', error)
    return undefined
  }
  const missing = missingFonts(allClips(project.tracks), installed)
  if (missing.length === 0) return undefined
  const names = missing.map((name) => `"${name}"`).join(', ')
  if (missing.length === 1) return `The font ${names} is not installed on this Mac. Its words are shown in the system font until it is.`
  return `The fonts ${names} are not installed on this Mac. Their words are shown in the system font until they are.`
}

export function createSession(engine: EngineHost, media: MediaConnection, info: DocumentInfo): Session {
  const store = createEditorStore()
  const transport = createTransport(engine, store.notify)
  const actions = createActions(store, transport)
  const thumbnails = createThumbnails(media, () => transport.position().isPlaying)
  const preparationListeners = new Set<() => void>()
  const panelListeners = new Set<(panel: Panel) => void>()
  let preparation: PreparationStates = {}
  let preparationTimer: number | undefined
  let sent: SentProject | undefined
  let isSendScheduled = false
  let reportedState = ''
  let recovered: Project | undefined = store.getState().wholeProject
  let recoveryWork: Promise<void> = Promise.resolve()
  let hasRecoveryFailed = false
  let isMediaConnected = true
  // Set until the project has been read: one whose reading the media process did not live to finish is read again by the next one.
  let isOpenNeeded = info.loadFrom !== undefined
  // Settles once a restarted media process knows the project's files; a file added before that would be forgotten by it.
  let mediaReopened: Promise<void> = Promise.resolve()
  let previewLostTimer: number | undefined

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

  engine.onEvent((event) => {
    if (event.type === 'wanted') {
      watchPreparation()
    } else if (event.type === 'preview-lost') {
      previewLostTimer ??= window.setTimeout(() => void reloadWithoutPreview(), PREVIEW_RETURN_MS)
    } else if (event.type === 'preview-restored') {
      window.clearTimeout(previewLostTimer)
      previewLostTimer = undefined
    }
  })

  // A preview that does not come back after the GPU process stopped comes back with the page, which reopens from the recovery file written here.
  async function reloadWithoutPreview(): Promise<void> {
    logError('The preview did not come back after the GPU process stopped; the window is loaded again', new Error(`waited ${PREVIEW_RETURN_MS} ms`))
    autosave()
    await recoveryWork
    location.reload()
  }

  // An answer that is waited for in order is caught at once, so a later file that fails first is not reported as unhandled.
  async function settledAddition(path: string): Promise<PromiseSettledResult<AddedMedia>> {
    try {
      return { status: 'fulfilled', value: await media.addMedia(path) }
    } catch (reason) {
      return { status: 'rejected', reason }
    }
  }

  // Every file is asked for at once, so the media process looks at several side by side; they join the project in the order given.
  async function importFiles(paths: readonly string[]): Promise<void> {
    await mediaReopened
    const known = new Set(store.getState().project.media.map((reference) => reference.path))
    const fresh = [...new Set(paths)].filter((path) => !known.has(path))
    const additions = fresh.map(settledAddition)
    const failures: string[] = []
    for (const [index, path] of fresh.entries()) {
      store.setPendingImports(fresh.slice(index))
      const addition = await additions[index]
      if (addition === undefined) continue
      if (addition.status === 'rejected') {
        failures.push(describeError(addition.reason))
        continue
      }
      const added = addition.value
      store.setMediaState(added.id, { info: added.info })
      store.apply('Import Media', (project) => withMedia(project, { id: added.id, path, relativePath: '' }))
      watchPreparation()
    }
    store.setPendingImports([])
    if (failures.length > 0) store.notify(failures.join(' '))
  }

  async function chooseAndImport(): Promise<void> {
    await importFiles(await window.host.importMediaDialog())
  }

  // Asks where a file went. The other missing files are looked for in the same folder, so one answer usually brings them all back.
  async function relink(mediaId: string): Promise<void> {
    const { wholeProject: project, mediaStates } = store.getState()
    const reference = project.media.find((candidate) => candidate.id === mediaId)
    if (reference === undefined) return
    const path = await window.host.chooseMediaFile(mediaFileName(reference))
    if (path === undefined) return

    const others = unlinkedMedia(project, mediaStates).filter((unlinked) => unlinked.reference.id !== mediaId)
    await mediaReopened
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
    const { wholeProject: project, mediaStates } = store.getState()
    if (sent !== undefined && sent.project === project && sent.mediaStates === mediaStates) return
    sent = { project, mediaStates }
    engine.send({ type: 'project', loaded: { project, media: mediaStates } })
  }

  function reportDocumentState(): void {
    const { wholeProject: project, savedProject, history } = store.getState()
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
    transport.setOffset(store.getState().scope?.offset ?? 0)
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
      // Written again at the next tick, even if nothing changes meanwhile.
      if (recovered === project) recovered = undefined
      logError('Could not write the recovery file', error, { recoveryPath: info.recoveryPath })
      if (!hasRecoveryFailed) store.notify(`Autosave is not working: ${describeErrorAsSentence(error)} Save with ⌘S to keep your work.`)
      hasRecoveryFailed = true
    }
  }

  // While the media process is being restarted there is nothing to write with; the restart writes as soon as it is back.
  function autosave(): void {
    if (!isMediaConnected) return
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
    const outputPath = await window.host.saveExportDialog(`${projectName}.${choices.format}`)
    if (outputPath === undefined) return

    const snapshot = store.committedProject()
    try {
      await media.saveProject(info.exportSnapshotPath, snapshot)
    } catch (error) {
      store.notify(`The export could not start: ${describeErrorAsSentence(error)} Check that the disk has room, then export again.`)
      return
    }
    // A PNG shows the frame under the playhead, which inside an open group is counted from the group's start.
    const playheadTime = transport.position().time + (store.getState().scope?.offset ?? 0)
    const frame = Math.round(playheadTime / frameDuration(snapshot.canvas.frameRate))
    const job = exportJobFor(choices, selectionRange(snapshot, selection), { projectPath: info.exportSnapshotPath, outputPath }, frame)
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
    const { wholeProject, exportStatus } = store.getState()
    if (exportStatus === undefined && projectDuration(wholeProject) > 0) store.showExportDialog(true)
  }

  // A document with unsaved changes closes only after the user has said what happens to them.
  async function close(): Promise<void> {
    store.cancel()
    const { wholeProject, savedProject } = store.getState()
    if (wholeProject !== savedProject) {
      const choice = await window.host.confirmUnsavedChanges()
      if (choice === 'cancel') return
      if (choice === 'save' && !(await save())) return
    }
    // An autosave still running would write the recovery file again after the main process removed it.
    clearInterval(autosaveTimer)
    await recoveryWork
    window.host.closeDocument()
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
  // A panel with a selection of its own cancels the event while it is the one in use, and then the clips stay as they are.
  function selectAll(): void {
    if (isTypingTarget(document.activeElement)) document.execCommand('selectAll')
    else if (window.dispatchEvent(new Event(SELECT_ALL_EVENT, { cancelable: true }))) actions.selectAll()
  }

  // A panel with a selection of its own cancels the event while it is the one in use, and then the clips stay as they are.
  function deleteSelection(isRipple: boolean): void {
    if (window.dispatchEvent(new Event(DELETE_EVENT, { cancelable: true }))) actions.deleteSelection(isRipple)
  }

  // A menu command, chosen in the menu or with its keys.
  function runMenuAction(action: MenuAction): void {
    if (action === 'export') openExportDialog()
    else if (action === 'close') void close()
    else if (action === 'save') void save()
    else if (action === 'save-as') void saveAs()
    else if (action === 'undo' || action === 'redo') undoOrRedo(action)
    else if (action === 'import') void chooseAndImport()
    else if (action === 'split') actions.split()
    else if (action === 'split-all') actions.splitAll()
    else if (action === 'select-all') selectAll()
    else if (action === 'deselect-all') store.select([])
    else if (action === 'duplicate') actions.duplicate()
    else if (action === 'delete') deleteSelection(false)
    else if (action === 'ripple-delete') deleteSelection(true)
    else if (action === 'group') actions.group()
    else if (action === 'ungroup') actions.ungroup()
    else if (action === 'toggle-library') togglePanel('library')
    else if (action === 'toggle-properties') togglePanel('properties')
    else if (action === 'toggle-timeline') togglePanel('timeline')
    else if (action === 'preview-mode') store.setPreviewing(!store.getState().isPreviewing)
    else if (action === 'settings') store.showSettings(true)
  }

  window.host.onCommand((command: HostCommand) => {
    if (command.type === 'export-event') {
      onExportEvent(command.event)
      return
    }
    if (command.type === 'memory-pressure') {
      engine.send({ type: 'memory-pressure', isUnderPressure: command.isUnderPressure })
      thumbnails.setUnderPressure(command.isUnderPressure)
      return
    }
    if (command.type !== 'menu') return
    // Under an open dialog the project can still be saved and the window closed; every other command waits for the dialog to go.
    const isForUnderADialog = command.action === 'save' || command.action === 'save-as' || command.action === 'close'
    if (isModalOpen() && !isForUnderADialog) return
    runMenuAction(command.action)
  })

  function togglePanel(panel: Panel): void {
    for (const listener of panelListeners) listener(panel)
  }

  async function open(): Promise<void> {
    if (info.loadFrom === undefined) return
    store.setOpening(info.path === undefined ? 'Untitled' : fileNameOf(info.path))
    try {
      const loaded = await media.loadProject(info.loadFrom, true)
      isOpenNeeded = false
      const isRecovered = info.loadFrom !== info.path
      store.open(loaded, info.path, !isRecovered)
      recovered = loaded.project
      watchPreparation()
      const notices: string[] = []
      const missingCount = unlinkedMedia(loaded.project, loaded.media).length
      if (missingCount > 0) notices.push(`${missingCount} media ${missingCount === 1 ? 'file is' : 'files are'} missing. Use Relink in the Media tab to say where ${missingCount === 1 ? 'it is' : 'they are'}.`)
      const fonts = await missingFontsNotice(loaded.project)
      if (fonts !== undefined) notices.push(fonts)
      if (notices.length > 0) store.notify(notices.join(' '))
    } catch (error) {
      // The media process stopped while reading: the notice says so, and the restarted one reads the project again.
      if (!isMediaConnected) return
      isOpenNeeded = false
      // The path is not kept: Save must ask where to write instead of replacing a file that could not be read.
      store.notify(describeError(error))
    } finally {
      store.setOpening(undefined)
    }
  }

  media.onClose(() => {
    isMediaConnected = false
    transport.pause()
    store.notify('The media process stopped. It is being restarted; your work is safe.')
  })

  // A restarted media process knows nothing of this window. It is told the project's files before the engine asks it for frames, and the engine is then given the project again so it asks for what it lost.
  async function reconnect(ports: MediaPorts): Promise<void> {
    media.reconnect(ports.ui)
    isMediaConnected = true
    if (isOpenNeeded) {
      await open()
    } else {
      await reopenMedia()
    }
    engine.send({ type: 'media-port' }, [ports.engine])
    sent = undefined
    sendToEngine()
    autosave()
  }

  async function reopenMedia(): Promise<void> {
    const { wholeProject } = store.getState()
    try {
      store.setMediaStates(await media.openMedia(wholeProject.media, info.loadFrom))
    } catch (error) {
      if (!isMediaConnected) return
      logError('Could not open the media again in the restarted media process', error)
      store.notify(`The media process was restarted, but the media could not be opened again: ${describeErrorAsSentence(error)} Save with ⌘S and open the project again.`)
      return
    }
    store.notify('The media process was restarted. Nothing was lost.')
  }

  engine.onReconnect((ports) => {
    mediaReopened = reconnect(ports)
  })

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
    hasSmallMemory: info.hasSmallMemory,
    cancelExport,
    runMenuAction,
    shortcuts: createShortcuts(),
    onPanelToggle(listener) {
      panelListeners.add(listener)
      return () => panelListeners.delete(listener)
    },
  }
}
