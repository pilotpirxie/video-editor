import {
  BrowserWindow,
  Menu,
  MessageChannelMain,
  app,
  dialog,
  ipcMain,
  powerSaveBlocker,
  protocol,
  shell,
  utilityProcess,
  type MenuItemConstructorOptions,
  type UtilityProcess,
} from 'electron'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { totalmem } from 'node:os'
import { basename, extname, join, normalize, resolve } from 'node:path'
import { EXPORT_FORMATS, EXPORT_PRESETS, isExportEncoder, isExportFormat, isExportPreset, isExportQuality, type ExportFormat } from '../shared/exportPresets.js'
import { describeError, logError } from '../shared/log.js'
import type {
  DocumentInfo,
  DocumentState,
  ExportJob,
  FramesJob,
  HeadlessJob,
  HostCommand,
  JobEvent,
  MediaProcessCommand,
  MediaProcessReport,
  MenuAction,
  NextDocument,
  UnsavedChoice,
} from '../shared/mediaProtocol.js'
import { startMemoryMonitor, type MemoryMonitor } from './memory.js'
import { isProjectFrameRate } from '../shared/time.js'
import {
  discardExportSnapshot,
  discardRecoveredWork,
  discardRecovery,
  exportSnapshotPath,
  findRecovery,
  newRecoveryPath,
  rememberProjectPath,
  type FoundRecovery,
} from './recovery.js'
import { runSelfTest, type SelfTestOptions } from './selfTest.js'
import type { DialogAnswers } from './uiDriver.js'
import { runUiTest } from './uiTest.js'

const RENDERER_DIRECTORY = join(import.meta.dirname, '..', '..', '..', 'renderer')
const MEDIA_SERVICE_PATH = join(import.meta.dirname, '..', 'media', 'service.js')
const PRELOAD_PATH = join(import.meta.dirname, 'preload.cjs')
const WINDOW_BACKGROUND = '#14171D'
const USAGE_EXIT_CODE = 2
const NOT_FOUND_STATUS = 404
const WINDOW_SIZE = { width: 1440, height: 900 }
const MIN_WINDOW_SIZE = { width: 1280, height: 720 }

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
}

const CLI_FLAGS = ['project', 'export', 'frames', 'out', 'preset', 'encoder', 'via', 'at', 'size', 'selftest', 'uitest', 'media', 'seconds', 'report-memory']
const DEFAULT_SELFTEST_SECONDS = 2
const BYTES_PER_MEGABYTE = 1024 * 1024
const SIZE_PATTERN = /^(?<width>\d+)x(?<height>\d+)$/
const MEDIA_PROCESS_MIN_UPTIME_MS = 5000
const UNTITLED = 'Untitled'
const CLEAN_DOCUMENT: DocumentState = { isDirty: false, undoLabel: undefined, redoLabel: undefined }
const PROJECT_FILTERS = [{ name: 'Project', extensions: ['json'] }]
const MEDIA_EXTENSIONS = [
  'mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'flv', 'ts', 'mts', '3gp',
  'mp3', 'm4a', 'aac', 'wav', 'aiff', 'aif', 'flac', 'ogg', 'opus',
  'jpg', 'jpeg', 'png', 'webp', 'gif', 'apng',
]
const UNSAVED_CHOICES: readonly UnsavedChoice[] = ['save', 'discard', 'cancel']

type WindowMode = 'editor' | 'harness' | 'headless'

type Editor = {
  window: BrowserWindow
  document: DocumentInfo
  documentState: DocumentState
  isCloseConfirmed: boolean
}

type AppState = {
  mediaProcess: UtilityProcess | undefined
  editor: Editor | undefined
  harnessWindow: BrowserWindow | undefined
  exportWindow: BrowserWindow | undefined
  jobListeners: Map<number, (event: JobEvent) => void>
  exportPathOverride: string | undefined
  // The file the last finished export wrote, for "Show in Finder".
  lastExportPath: string | undefined
  dialogAnswers: DialogAnswers
  recoveryDirectory: string
  // False for test runs, which must not leave their scratch files in the system's Open Recent list.
  remembersRecentDocuments: boolean
  isQuitting: boolean
  memory: MemoryMonitor | undefined
  versions: string[] | undefined
}

class UsageError extends Error {}

// On a Mac with this much memory or less, the media engine's speed and small memory use matter more than x264's smaller files.
const SMALL_MEMORY_BYTES = 8 * 1024 ** 3

const SAVED_FORMAT_NAMES: Record<ExportFormat, string> = {
  mp4: 'MP4 video',
  webm: 'WebM video',
  gif: 'Animated GIF',
  m4a: 'M4A sound',
  mp3: 'MP3 sound',
  wav: 'WAV sound',
  png: 'PNG picture',
}

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }])

function cliOptions(argv: readonly string[]): Map<string, string> {
  const options = new Map<string, string>()
  for (const [index, argument] of argv.entries()) {
    if (!argument.startsWith('--')) continue
    const name = argument.slice(2)
    if (!CLI_FLAGS.includes(name)) continue
    const next = argv[index + 1]
    const hasValue = next !== undefined && !next.startsWith('--')
    options.set(name, hasValue ? next : '')
  }
  return options
}

// The format is the extension of `--out`. A PNG is the frame `--at`.
function exportJobFromCli(projectPath: string, options: Map<string, string>): ExportJob {
  const preset = options.get('preset') ?? '1080p'
  const outputPath = options.get('out')
  if (outputPath === undefined || outputPath === '') throw new UsageError('--export needs --out <file.mp4>')
  if (!isExportPreset(preset)) throw new UsageError(`--preset must be one of ${EXPORT_PRESETS.join(', ')}`)
  const format = extname(outputPath).slice(1).toLowerCase()
  if (!isExportFormat(format)) throw new UsageError(`--out must end in one of .${EXPORT_FORMATS.join(', .')}`)
  const job: ExportJob = { kind: 'export', projectPath: resolve(projectPath), outputPath: resolve(outputPath), preset, format }
  const encoder = options.get('encoder')
  if (encoder !== undefined) {
    if (!isExportEncoder(encoder)) throw new UsageError('--encoder must be x264 or hardware')
    job.encoder = encoder
  }
  if (format !== 'png') return job
  const frame = Number(options.get('at') ?? '0')
  if (!Number.isInteger(frame) || frame < 0) throw new UsageError('--at must be a frame number')
  job.frame = frame
  return job
}

function framesJobFromCli(projectPath: string, options: Map<string, string>): FramesJob {
  const via = options.get('via') ?? 'paused'
  const outputDirectory = options.get('out')
  if (outputDirectory === undefined || outputDirectory === '') throw new UsageError('--frames needs --out <directory>')
  if (via !== 'paused' && via !== 'export') throw new UsageError('--via must be paused or export')

  const frames: number[] = []
  for (const text of (options.get('at') ?? '0').split(',')) {
    const frame = Number(text)
    if (!Number.isInteger(frame) || frame < 0) throw new UsageError('--at must be a comma-separated list of frame numbers')
    frames.push(frame)
  }

  const job: FramesJob = { kind: 'frames', projectPath: resolve(projectPath), via, frames, outputDirectory: resolve(outputDirectory) }
  const size = SIZE_PATTERN.exec(options.get('size') ?? '')?.groups
  if (size !== undefined) job.size = { width: Number(size.width), height: Number(size.height) }
  return job
}

function isFrameRateChoice(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || !('num' in value) || !('den' in value)) return false
  return typeof value.num === 'number' && typeof value.den === 'number' && isProjectFrameRate({ num: value.num, den: value.den })
}

function isTimeRange(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || !('start' in value) || !('end' in value)) return false
  return typeof value.start === 'number' && typeof value.end === 'number' && value.start >= 0 && value.end > value.start
}

// A job arrives from a window, so every choice in it is checked before it is run.
function isExportJob(value: unknown): value is ExportJob {
  if (typeof value !== 'object' || value === null) return false
  if (!('kind' in value) || value.kind !== 'export') return false
  if (!('projectPath' in value) || typeof value.projectPath !== 'string') return false
  if (!('outputPath' in value) || typeof value.outputPath !== 'string') return false
  if (!('preset' in value) || typeof value.preset !== 'string' || !isExportPreset(value.preset)) return false
  if ('frameRate' in value && value.frameRate !== undefined && !isFrameRateChoice(value.frameRate)) return false
  if ('quality' in value && value.quality !== undefined && !(typeof value.quality === 'string' && isExportQuality(value.quality))) return false
  if ('range' in value && value.range !== undefined && !isTimeRange(value.range)) return false
  if ('format' in value && value.format !== undefined && !(typeof value.format === 'string' && isExportFormat(value.format))) return false
  if ('encoder' in value && value.encoder !== undefined && !(typeof value.encoder === 'string' && isExportEncoder(value.encoder))) return false
  if ('frame' in value && value.frame !== undefined && !(Number.isInteger(value.frame) && Number(value.frame) >= 0)) return false
  return !('hasAudio' in value) || value.hasAudio === undefined || typeof value.hasAudio === 'boolean'
}

function isJobEvent(value: unknown): value is JobEvent {
  if (typeof value !== 'object' || value === null || !('type' in value)) return false
  return value.type === 'progress' || value.type === 'done' || value.type === 'error'
}

function isDocumentState(value: unknown): value is DocumentState {
  if (typeof value !== 'object' || value === null) return false
  if (!('isDirty' in value) || typeof value.isDirty !== 'boolean') return false
  const undoLabel = 'undoLabel' in value ? value.undoLabel : undefined
  const redoLabel = 'redoLabel' in value ? value.redoLabel : undefined
  const isLabel = (label: unknown): boolean => label === undefined || typeof label === 'string'
  return isLabel(undoLabel) && isLabel(redoLabel)
}

function isNextDocument(value: unknown): value is NextDocument {
  if (typeof value !== 'object' || value === null || !('kind' in value)) return false
  if (value.kind === 'new' || value.kind === 'close') return true
  return value.kind === 'open' && 'path' in value && typeof value.path === 'string'
}

function isVersionReport(value: unknown): value is MediaProcessReport {
  return typeof value === 'object' && value !== null && 'type' in value && value.type === 'versions'
}

function serveRenderer(): void {
  protocol.handle('app', async (request) => {
    const filePath = join(RENDERER_DIRECTORY, normalize(decodeURIComponent(new URL(request.url).pathname)))
    if (!filePath.startsWith(RENDERER_DIRECTORY)) return new Response('Not found', { status: NOT_FOUND_STATUS })
    try {
      const body = await readFile(filePath)
      return new Response(body, { headers: { 'content-type': CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream' } })
    } catch (error) {
      logError('Could not serve a renderer file', error, { filePath })
      return new Response('Not found', { status: NOT_FOUND_STATUS })
    }
  })
}

function showVersionsInAboutPanel(report: MediaProcessReport): string[] {
  const versions = [
    `Electron ${process.versions.electron}`,
    `Chromium ${process.versions.chrome}`,
    `FFmpeg ${report.ffmpeg}`,
    `FFprobe ${report.ffprobe}`,
  ]
  app.setAboutPanelOptions({ applicationName: app.getName(), applicationVersion: app.getVersion(), credits: versions.join('\n') })
  return versions
}

function startMediaProcess(onVersions: (versions: string[]) => void, onStopped: (uptimeMs: number) => void): UtilityProcess {
  const startedAt = Date.now()
  const child = utilityProcess.fork(MEDIA_SERVICE_PATH, [], { serviceName: 'Media' })
  const setup: MediaProcessCommand = {
    type: 'setup',
    setup: {
      ffmpegDirectory: app.isPackaged ? join(process.resourcesPath, 'ffmpeg') : join(app.getAppPath(), 'vendor', 'ffmpeg'),
      // The second layout of the cache, in segments; the media process removes the first one.
      cacheDirectory: join(app.getPath('userData'), 'cache', 'v2'),
    },
  }
  child.postMessage(setup)
  child.on('message', (message: unknown) => {
    if (isVersionReport(message)) onVersions(showVersionsInAboutPanel(message))
  })
  child.on('exit', (code) => {
    if (code !== 0) logError('The media process stopped', new Error(`exit code ${code}`))
    onStopped(Date.now() - startedAt)
  })
  return child
}

function launchMediaProcess(state: AppState): UtilityProcess {
  return startMediaProcess(
    (versions) => {
      state.versions = versions
    },
    (uptimeMs) => restartMediaProcess(state, uptimeMs),
  )
}

// Work is never lost with the media process: a new one is started and the editor reopens from its recovery file.
function restartMediaProcess(state: AppState, uptimeMs: number): void {
  if (state.isQuitting) return
  if (uptimeMs < MEDIA_PROCESS_MIN_UPTIME_MS) {
    logError('The media process keeps stopping and was not restarted', new Error(`it ran for ${uptimeMs} ms`))
    return
  }
  state.mediaProcess = launchMediaProcess(state)
  const editor = state.editor
  if (editor !== undefined && !editor.window.isDestroyed()) editor.window.webContents.reload()
}

function send(window: BrowserWindow, command: HostCommand): void {
  if (!window.isDestroyed()) window.webContents.send('command', command)
}

type WindowOptions = {
  mode: WindowMode
  isUnattended: boolean
}

function createWindow(state: AppState, options: WindowOptions): BrowserWindow {
  const { mode } = options
  const isHeadless = mode === 'headless'
  const window = new BrowserWindow({
    width: WINDOW_SIZE.width,
    height: WINDOW_SIZE.height,
    minWidth: MIN_WINDOW_SIZE.width,
    minHeight: MIN_WINDOW_SIZE.height,
    show: false,
    backgroundColor: WINDOW_BACKGROUND,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: !isHeadless && !options.isUnattended,
    },
  })
  if (options.isUnattended) {
    window.webContents.setAudioMuted(true)
    window.showInactive()
  } else if (!isHeadless) {
    window.show()
  }
  window.webContents.on('console-message', (details) => {
    if (details.level === 'error') logError('A window reported an error', new Error(details.message), { mode })
  })
  // Every load gets fresh ports: a reloaded page has lost the old ones, and closing them ends the old media session.
  window.webContents.on('did-finish-load', () => {
    const engine = new MessageChannelMain()
    const ui = new MessageChannelMain()
    const connect: MediaProcessCommand = { type: 'connect' }
    state.mediaProcess?.postMessage(connect, [engine.port1, ui.port1])
    window.webContents.postMessage('media-port', undefined, [engine.port2, ui.port2])
  })
  void loadPage(window, mode)
  return window
}

async function loadPage(window: BrowserWindow, mode: WindowMode): Promise<void> {
  try {
    await window.loadURL(`app://editor/index.html?mode=${mode}`)
  } catch (error) {
    // An export that is cancelled at once closes its window while the page is still loading; that is not a failure.
    if (window.isDestroyed()) return
    logError('Could not load the window', error, { mode })
  }
}

function runHeadlessJob(state: AppState, job: HeadlessJob, onEvent: (event: JobEvent) => void): BrowserWindow {
  const window = createWindow(state, { mode: 'headless', isUnattended: false })
  const senderId = window.webContents.id
  const blockerId = powerSaveBlocker.start('prevent-app-suspension')
  state.jobListeners.set(senderId, onEvent)
  window.webContents.once('did-finish-load', () => send(window, { type: 'run-job', job }))
  window.webContents.on('render-process-gone', (_event, details) => {
    onEvent({ type: 'error', message: `The render process stopped unexpectedly (${details.reason}).` })
  })
  window.on('closed', () => {
    state.jobListeners.delete(senderId)
    powerSaveBlocker.stop(blockerId)
  })
  return window
}

// Marks the exit as intended first, so the media process stopping with the app is not taken for a crash.
function exit(state: AppState, code: number): void {
  state.isQuitting = true
  app.exit(code)
}

// A command-line run whose reader is gone (a closed pipe, a test that gave up) cannot deliver its result; going on would throw at every line.
function exitWhenOutputCloses(state: AppState): void {
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', (error) => {
      logError('The output of a command-line run closed', error)
      exit(state, 1)
    })
  }
}

async function finish(state: AppState, result: Record<string, unknown>): Promise<void> {
  const report = { ...result }
  if (state.memory !== undefined) report.peakMemoryMegabytes = Math.round((await state.memory.stop()) / BYTES_PER_MEGABYTE)
  process.stdout.write(`${JSON.stringify(report)}\n`)
  exit(state, 0)
}

function runCliJob(state: AppState, job: HeadlessJob): void {
  app.dock?.hide()
  runHeadlessJob(state, job, (event) => {
    if (event.type === 'progress') {
      process.stdout.write(`progress ${event.done}/${event.total}\n`)
    } else if (event.type === 'done') {
      void finish(state, event.summary)
    } else {
      process.stderr.write(`${event.message}\n`)
      exit(state, 1)
    }
  })
}

async function runCliSelfTest(state: AppState, projectPath: string, options: SelfTestOptions): Promise<void> {
  state.exportPathOverride = options.exportPath
  const window = openHarness(state, projectPath, true)
  try {
    const report = await runSelfTest(window, options)
    await finish(state, { ...report, aboutPanel: state.versions ?? [] })
  } catch (error) {
    process.stderr.write(`${describeError(error)}\n`)
    exit(state, 1)
  }
}

function startExportFor(state: AppState, requester: BrowserWindow, job: ExportJob): void {
  if (state.exportWindow !== undefined) {
    send(requester, { type: 'export-event', event: { type: 'error', message: 'Another export is already running.' } })
    return
  }
  const window = runHeadlessJob(state, job, (event) => {
    if (event.type === 'done') state.lastExportPath = job.outputPath
    send(requester, { type: 'export-event', event })
    if (event.type !== 'progress') window.destroy()
  })
  state.exportWindow = window
  window.on('closed', () => {
    state.exportWindow = undefined
    void discardExportSnapshot(job.projectPath, state.recoveryDirectory)
  })
}

function titleOf(document: DocumentInfo): string {
  return document.path === undefined ? UNTITLED : basename(document.path)
}

function showDocument(state: AppState, editor: Editor): void {
  const { window, document, documentState } = editor
  if (window.isDestroyed()) return
  window.setTitle(titleOf(document))
  window.setRepresentedFilename(document.path ?? '')
  window.setDocumentEdited(documentState.isDirty)
  buildEditorMenu(state)
}

function documentFor(state: AppState, projectPath: string | undefined): DocumentInfo {
  const recoveryPath = newRecoveryPath(state.recoveryDirectory)
  const document: DocumentInfo = { path: projectPath, loadFrom: projectPath, recoveryPath, exportSnapshotPath: exportSnapshotPath(recoveryPath), hasSmallMemory: totalmem() <= SMALL_MEMORY_BYTES }
  if (projectPath !== undefined) {
    if (state.remembersRecentDocuments) app.addRecentDocument(projectPath)
    void rememberProjectPath(document.recoveryPath, projectPath)
  }
  return document
}

async function replaceDocument(state: AppState, editor: Editor, next: NextDocument): Promise<void> {
  await discardRecovery(editor.document.recoveryPath)
  if (editor.window.isDestroyed()) return
  if (next.kind === 'close') {
    editor.isCloseConfirmed = true
    editor.window.close()
    return
  }
  editor.document = documentFor(state, next.kind === 'open' ? next.path : undefined)
  editor.documentState = CLEAN_DOCUMENT
  showDocument(state, editor)
  editor.window.webContents.reload()
}

function editorOf(state: AppState, sender: Electron.WebContents): Editor | undefined {
  const editor = state.editor
  return editor !== undefined && editor.window.webContents === sender ? editor : undefined
}

async function askUnsavedChanges(state: AppState, editor: Editor): Promise<UnsavedChoice> {
  if (state.dialogAnswers.unsavedChanges !== undefined) return state.dialogAnswers.unsavedChanges
  const answer = await dialog.showMessageBox(editor.window, {
    type: 'warning',
    message: `Do you want to save the changes you made to "${titleOf(editor.document)}"?`,
    detail: 'Your changes will be lost if you do not save them.',
    buttons: ['Save', "Don't Save", 'Cancel'],
    defaultId: 0,
    cancelId: 2,
  })
  return UNSAVED_CHOICES[answer.response] ?? 'cancel'
}

function registerDocumentIpc(state: AppState): void {
  // A page that loads again (after Reload, or when the media process was restarted) continues from its recovery file, which holds the unsaved work.
  ipcMain.handle('document-info', (event): DocumentInfo | undefined => {
    const document = editorOf(state, event.sender)?.document
    if (document === undefined || !existsSync(document.recoveryPath)) return document
    return { ...document, loadFrom: document.recoveryPath }
  })

  ipcMain.on('document-state', (event, documentState: unknown) => {
    const editor = editorOf(state, event.sender)
    if (editor === undefined || !isDocumentState(documentState)) return
    editor.documentState = documentState
    showDocument(state, editor)
  })

  ipcMain.on('document-path', (event, path: unknown) => {
    const editor = editorOf(state, event.sender)
    if (editor === undefined || typeof path !== 'string') return
    editor.document = { ...editor.document, path }
    if (state.remembersRecentDocuments) app.addRecentDocument(path)
    void rememberProjectPath(editor.document.recoveryPath, path)
    showDocument(state, editor)
  })

  ipcMain.handle('save-project-dialog', async (event): Promise<string | undefined> => {
    if (state.dialogAnswers.saveProject !== undefined) return state.dialogAnswers.saveProject
    const owner = BrowserWindow.fromWebContents(event.sender)
    if (owner === null) return undefined
    const chosen = await dialog.showSaveDialog(owner, { defaultPath: `${UNTITLED}.json`, filters: PROJECT_FILTERS })
    if (chosen.canceled || chosen.filePath === '') return undefined
    return chosen.filePath
  })

  ipcMain.handle('import-media-dialog', async (event): Promise<string[]> => {
    if (state.dialogAnswers.importMedia !== undefined) return state.dialogAnswers.importMedia
    const owner = BrowserWindow.fromWebContents(event.sender)
    if (owner === null) return []
    const chosen = await dialog.showOpenDialog(owner, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Media', extensions: MEDIA_EXTENSIONS }],
    })
    return chosen.filePaths
  })

  ipcMain.handle('choose-media-file', async (event, name: unknown): Promise<string | undefined> => {
    if (state.dialogAnswers.relinkMedia !== undefined) return state.dialogAnswers.relinkMedia
    const owner = BrowserWindow.fromWebContents(event.sender)
    if (owner === null) return undefined
    const chosen = await dialog.showOpenDialog(owner, {
      message: typeof name === 'string' ? `Where is "${name}"?` : 'Where is the file?',
      buttonLabel: 'Relink',
      properties: ['openFile'],
      filters: [{ name: 'Media', extensions: MEDIA_EXTENSIONS }],
    })
    return chosen.filePaths[0]
  })

  ipcMain.handle('confirm-unsaved-changes', async (event): Promise<UnsavedChoice> => {
    const editor = editorOf(state, event.sender)
    return editor === undefined ? 'cancel' : askUnsavedChanges(state, editor)
  })

  ipcMain.on('discard-recovery', (event) => {
    const editor = editorOf(state, event.sender)
    if (editor !== undefined) void discardRecoveredWork(editor.document.recoveryPath)
  })

  ipcMain.on('replace-document', (event, next: unknown) => {
    const editor = editorOf(state, event.sender)
    if (editor !== undefined && isNextDocument(next)) void replaceDocument(state, editor, next)
  })
}

function registerIpc(state: AppState): void {
  ipcMain.handle('open-project-dialog', async (event): Promise<string | undefined> => {
    if (state.dialogAnswers.openProject !== undefined) return state.dialogAnswers.openProject
    const owner = BrowserWindow.fromWebContents(event.sender)
    if (owner === null) return undefined
    const chosen = await dialog.showOpenDialog(owner, { properties: ['openFile'], filters: PROJECT_FILTERS })
    return chosen.filePaths[0]
  })

  ipcMain.handle('save-export-dialog', async (event, suggestedName: unknown): Promise<string | undefined> => {
    if (state.dialogAnswers.exportPath !== undefined) return state.dialogAnswers.exportPath
    if (state.exportPathOverride !== undefined) return state.exportPathOverride
    const owner = BrowserWindow.fromWebContents(event.sender)
    if (owner === null) return undefined
    const defaultPath = typeof suggestedName === 'string' ? suggestedName : 'export.mp4'
    const extension = extname(defaultPath).slice(1)
    const format: ExportFormat = isExportFormat(extension) ? extension : 'mp4'
    const chosen = await dialog.showSaveDialog(owner, { defaultPath, filters: [{ name: SAVED_FORMAT_NAMES[format], extensions: [format] }] })
    if (chosen.canceled || chosen.filePath === '') return undefined
    return chosen.filePath
  })

  ipcMain.on('job-event', (event, jobEvent: unknown) => {
    if (isJobEvent(jobEvent)) state.jobListeners.get(event.sender.id)?.(jobEvent)
  })

  ipcMain.on('start-export', (event, job: unknown) => {
    const requester = BrowserWindow.fromWebContents(event.sender)
    if (requester !== null && isExportJob(job)) startExportFor(state, requester, job)
  })

  ipcMain.on('cancel-export', () => state.exportWindow?.destroy())

  ipcMain.on('show-last-export', () => {
    if (state.lastExportPath !== undefined) shell.showItemInFolder(state.lastExportPath)
  })
}

function buildHarnessMenu(state: AppState): void {
  function sendToHarness(action: MenuAction): void {
    if (state.harnessWindow !== undefined) send(state.harnessWindow, { type: 'menu', action })
  }
  const template: MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    {
      label: 'File',
      submenu: [
        { label: 'Open Project…', accelerator: 'CmdOrCtrl+O', click: () => sendToHarness('open-project') },
        { label: 'Export MP4…', accelerator: 'CmdOrCtrl+E', click: () => sendToHarness('export') },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function buildEditorMenu(state: AppState): void {
  const documentState = state.editor?.documentState ?? CLEAN_DOCUMENT

  function item(action: MenuAction, label: string, accelerator?: string): MenuItemConstructorOptions {
    const click = (): void => {
      if (state.editor !== undefined) send(state.editor.window, { type: 'menu', action })
    }
    return accelerator === undefined ? { id: action, label, click } : { id: action, label, accelerator, click }
  }

  function withLabel(verb: string, label: string | undefined): string {
    return label === undefined ? verb : `${verb} ${label}`
  }

  const template: MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    {
      label: 'File',
      submenu: [
        item('new', 'New Project', 'CmdOrCtrl+N'),
        item('open-project', 'Open…', 'CmdOrCtrl+O'),
        { label: 'Open Recent', role: 'recentDocuments', submenu: [{ label: 'Clear Menu', role: 'clearRecentDocuments' }] },
        { type: 'separator' },
        item('save', 'Save', 'CmdOrCtrl+S'),
        item('save-as', 'Save As…', 'Shift+CmdOrCtrl+S'),
        { type: 'separator' },
        item('import', 'Import Media…', 'CmdOrCtrl+I'),
        item('export', 'Export…', 'CmdOrCtrl+E'),
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        item('undo', withLabel('Undo', documentState.undoLabel), 'CmdOrCtrl+Z'),
        item('redo', withLabel('Redo', documentState.redoLabel), 'Shift+CmdOrCtrl+Z'),
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        item('duplicate', 'Duplicate', 'CmdOrCtrl+D'),
        item('delete', 'Delete'),
        item('ripple-delete', 'Ripple Delete'),
        { type: 'separator' },
        item('split', 'Split at Playhead', 'CmdOrCtrl+T'),
        item('split-all', 'Split All Tracks', 'Shift+CmdOrCtrl+T'),
        item('group', 'Group', 'CmdOrCtrl+G'),
        item('ungroup', 'Ungroup', 'CmdOrCtrl+U'),
        { type: 'separator' },
        item('select-all', 'Select All', 'CmdOrCtrl+A'),
        item('deselect-all', 'Deselect All', 'Shift+CmdOrCtrl+A'),
      ],
    },
    {
      label: 'View',
      submenu: [
        item('toggle-library', 'Toggle Library'),
        item('toggle-properties', 'Toggle Properties'),
        item('toggle-timeline', 'Toggle Timeline'),
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function openHarness(state: AppState, projectPath: string | undefined, isUnattended: boolean): BrowserWindow {
  const window = createWindow(state, { mode: 'harness', isUnattended })
  state.harnessWindow = window
  window.on('closed', () => {
    state.harnessWindow = undefined
  })
  if (projectPath !== undefined && projectPath !== '') {
    window.webContents.once('did-finish-load', () => send(window, { type: 'open-project', path: resolve(projectPath) }))
  }
  return window
}

async function shouldRestore(state: AppState, found: FoundRecovery): Promise<boolean> {
  if (state.dialogAnswers.restore !== undefined) return state.dialogAnswers.restore
  const name = found.projectPath === undefined ? UNTITLED : basename(found.projectPath)
  const answer = await dialog.showMessageBox({
    type: 'question',
    message: `The editor closed unexpectedly while "${name}" had unsaved changes.`,
    detail: 'Restore brings back your work as it was at most 10 seconds before the editor closed.',
    buttons: ['Restore', 'Discard'],
    defaultId: 0,
    cancelId: 1,
  })
  return answer.response === 0
}

async function firstDocument(state: AppState, projectPath: string | undefined): Promise<DocumentInfo> {
  const found = await findRecovery(state.recoveryDirectory)
  if (found === undefined) return documentFor(state, projectPath)
  if (await shouldRestore(state, found)) {
    return { path: found.projectPath, loadFrom: found.recoveryPath, recoveryPath: found.recoveryPath, exportSnapshotPath: exportSnapshotPath(found.recoveryPath), hasSmallMemory: totalmem() <= SMALL_MEMORY_BYTES }
  }
  await discardRecovery(found.recoveryPath)
  return documentFor(state, projectPath)
}

async function openEditor(state: AppState, projectPath: string | undefined, isUnattended: boolean): Promise<BrowserWindow> {
  const document = await firstDocument(state, projectPath)
  const window = createWindow(state, { mode: 'editor', isUnattended })
  const editor: Editor = { window, document, documentState: CLEAN_DOCUMENT, isCloseConfirmed: false }
  state.editor = editor
  // The window is named after its document, not after the page it shows.
  window.on('page-title-updated', (event) => event.preventDefault())
  showDocument(state, editor)

  // A document with unsaved changes closes only after the page has asked the user; a crashed page cannot ask.
  // While it exports, the window stays, as one with a sheet does: its dialog is the only place to follow the export or to stop it.
  window.on('close', (event) => {
    const isExporting = state.exportWindow !== undefined
    const hasNothingToAsk = editor.isCloseConfirmed || !editor.documentState.isDirty
    const canCloseNow = window.webContents.isCrashed() || (!isExporting && hasNothingToAsk)
    if (canCloseNow) return
    event.preventDefault()
    // A close that is refused calls off the quit it may have been part of.
    state.isQuitting = false
    if (!isExporting) send(window, { type: 'menu', action: 'close' })
    else if (!isUnattended) shell.beep()
  })
  // For the same reason an export does not outlive the page that started it: a page that loads again has forgotten it.
  window.webContents.on('did-start-loading', () => state.exportWindow?.destroy())
  window.on('closed', () => {
    state.editor = undefined
    if (!editor.documentState.isDirty || editor.isCloseConfirmed) void discardRecovery(editor.document.recoveryPath)
  })
  return window
}

type UiTestPaths = {
  projectPath: string | undefined
  outputDirectory: string | undefined
  mediaDirectory: string | undefined
}

async function runCliUiTest(state: AppState, scenario: string, paths: UiTestPaths): Promise<void> {
  try {
    // A recovery file can only be there because the test left one on purpose, so it is restored without asking.
    state.dialogAnswers.restore = true
    const window = await openEditor(state, paths.projectPath, true)
    const { outputDirectory, mediaDirectory } = paths
    const report = await runUiTest(window, { scenario, outputDirectory, mediaDirectory, answers: state.dialogAnswers })
    await finish(state, report)
  } catch (error) {
    process.stderr.write(`${describeError(error)}\n`)
    exit(state, 1)
  }
}

function resolved(path: string | undefined): string | undefined {
  return path === undefined || path === '' ? undefined : resolve(path)
}

async function main(): Promise<void> {
  const options = cliOptions(process.argv)
  const exportPath = options.get('export')
  const framesPath = options.get('frames')
  let cliJob: HeadlessJob | undefined
  if (exportPath !== undefined) cliJob = exportJobFromCli(exportPath, options)
  if (framesPath !== undefined) cliJob = framesJobFromCli(framesPath, options)
  const selfTestPath = options.get('selftest')
  const uiTestScenario = options.get('uitest')
  const playSeconds = Number(options.get('seconds') ?? DEFAULT_SELFTEST_SECONDS)
  if (!(playSeconds > 0)) throw new UsageError('--seconds must be a positive number')
  // A UI test restores recovery files without asking and changes stored settings, so it must never run on the profile that holds someone's real work.
  const hasOwnProfile = app.commandLine.hasSwitch('user-data-dir')
  if (uiTestScenario !== undefined && !hasOwnProfile) throw new UsageError('--uitest needs a profile of its own: add --user-data-dir=<empty folder>')

  // Two editors on one profile would each offer to restore the other's live recovery file.
  const isInteractive = cliJob === undefined && selfTestPath === undefined && uiTestScenario === undefined
  if (isInteractive && !app.requestSingleInstanceLock()) {
    app.quit()
    return
  }
  let started: AppState | undefined
  let fileToOpen: string | undefined
  app.on('open-file', (event, path) => {
    event.preventDefault()
    fileToOpen = path
    const editor = started?.editor
    if (editor !== undefined) send(editor.window, { type: 'open-project', path })
  })

  await app.whenReady()
  serveRenderer()
  const state: AppState = {
    mediaProcess: undefined,
    editor: undefined,
    harnessWindow: undefined,
    exportWindow: undefined,
    jobListeners: new Map(),
    exportPathOverride: undefined,
    lastExportPath: undefined,
    dialogAnswers: {},
    recoveryDirectory: join(app.getPath('userData'), 'recovery'),
    remembersRecentDocuments: isInteractive,
    isQuitting: false,
    memory: options.has('report-memory') ? startMemoryMonitor(process.pid) : undefined,
    versions: undefined,
  }
  started = state
  if (!isInteractive) exitWhenOutputCloses(state)
  state.mediaProcess = launchMediaProcess(state)
  registerIpc(state)
  registerDocumentIpc(state)
  app.on('before-quit', () => {
    state.isQuitting = true
  })
  app.on('window-all-closed', () => app.quit())
  app.on('second-instance', () => state.editor?.window.focus())

  if (cliJob !== undefined) {
    runCliJob(state, cliJob)
    return
  }
  if (selfTestPath !== undefined) {
    buildHarnessMenu(state)
    await runCliSelfTest(state, selfTestPath, { playSeconds, exportPath: resolved(options.get('out')) })
    return
  }
  const projectPath = resolved(options.get('project')) ?? fileToOpen
  if (uiTestScenario !== undefined) {
    await runCliUiTest(state, uiTestScenario, { projectPath, outputDirectory: resolved(options.get('out')), mediaDirectory: resolved(options.get('media')) })
    return
  }
  await openEditor(state, projectPath, false)
}

async function run(): Promise<void> {
  try {
    await main()
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n`)
      app.exit(USAGE_EXIT_CODE)
    } else {
      logError('The app could not start', error)
      app.exit(1)
    }
  }
}

void run()
