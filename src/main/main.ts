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
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { totalmem } from 'node:os'
import { basename, dirname, extname, join, normalize, resolve } from 'node:path'
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
  MenuShortcuts,
  UnsavedChoice,
} from '../shared/mediaProtocol.js'
import { DEFAULT_BINDINGS, MENU_SHORTCUT_ACTIONS, menuShortcutsOf } from '../editor/shortcuts.js'
import { isMemoryUnderPressure, startMemoryMonitor, type MemoryMonitor } from './memory.js'
import { SAMPLE_RATE, isProjectFrameRate } from '../shared/time.js'
import {
  discardExportSnapshot,
  discardRecoveredWork,
  discardRecovery,
  exportSnapshotPath,
  findRecoveries,
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

const CLI_FLAGS = ['project', 'export', 'frames', 'out', 'preset', 'encoder', 'via', 'at', 'size', 'selftest', 'uitest', 'media', 'seconds', 'seed', 'report-memory']
const DEFAULT_SELFTEST_SECONDS = 2
const BYTES_PER_MEGABYTE = 1024 * 1024
const SIZE_PATTERN = /^(?<width>\d+)x(?<height>\d+)$/
// A media process that stops sooner than this after starting is started again after a wait that doubles each time, up to the longest one.
const MEDIA_PROCESS_MIN_UPTIME_MS = 5000
const MEDIA_RESTART_FIRST_WAIT_MS = 1000
const MEDIA_RESTART_LONGEST_WAIT_MS = 30_000
// The end of what the media process wrote to its error output, which says why it died.
const MEDIA_OUTPUT_TAIL_CHARS = 4096
const MEMORY_PRESSURE_POLL_MS = 5000
const UNTITLED = 'Untitled'
const CLEAN_DOCUMENT: DocumentState = { isDirty: false, undoLabel: undefined, redoLabel: undefined }
const PROJECT_FILTERS = [{ name: 'Project', extensions: ['json'] }]
const MEDIA_EXTENSIONS = [
  'mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'flv', 'ts', 'mts', '3gp',
  'mp3', 'm4a', 'aac', 'wav', 'aiff', 'aif', 'flac', 'ogg', 'opus',
  'jpg', 'jpeg', 'png', 'webp', 'gif', 'apng',
]
const UNSAVED_CHOICES: readonly UnsavedChoice[] = ['save', 'discard', 'cancel']
// A new window opens this far below and to the right of the one in front, so both can be seen.
const CASCADE_PIXELS = 22
// Where windows of a test run open: beyond every screen, so a run does not cover the desktop. Shown there, they still draw every frame.
const OFF_SCREEN = { x: -20_000, y: 0 }
// A window whose page dies again this soon after it was brought back is left as it is: reloading it once more would loop.
const RESTART_GUARD_MS = 10_000

type WindowMode = 'editor' | 'harness' | 'headless'

type Editor = {
  window: BrowserWindow
  document: DocumentInfo
  documentState: DocumentState
  isCloseConfirmed: boolean
  // When the window was last reloaded after its page died.
  restartedAt: number | undefined
}

type AppState = {
  // Undefined while a media process that stopped is waiting to be started again.
  mediaProcess: UtilityProcess | undefined
  // How many times in a row the media process stopped soon after it started.
  mediaQuickExits: number
  isUnderMemoryPressure: boolean
  // One project per window.
  editors: Editor[]
  // The window used last, which the menu belongs to and which a menu command goes to when no window has the focus.
  activeEditor: Editor | undefined
  harnessWindow: BrowserWindow | undefined
  exportWindow: BrowserWindow | undefined
  // The window whose export is running: its dialog follows the export, so the window stays while it runs.
  exportRequester: BrowserWindow | undefined
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
  // Test runs open every window muted and in the background.
  isUnattended: boolean
  menuShortcuts: MenuShortcuts
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

function isMenuShortcuts(value: unknown): value is MenuShortcuts {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const known = new Set<string>(MENU_SHORTCUT_ACTIONS)
  return Object.entries(value).every(([action, accelerator]) => known.has(action) && typeof accelerator === 'string')
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

function launchMediaProcess(state: AppState): UtilityProcess {
  const startedAt = Date.now()
  const child = utilityProcess.fork(MEDIA_SERVICE_PATH, [], { serviceName: 'Media', stdio: ['ignore', 'inherit', 'pipe'] })
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
    if (isVersionReport(message)) state.versions = showVersionsInAboutPanel(message)
  })
  // Its error output goes on to the app's own, through the console, which does not fail when nothing reads it any more. Its end is kept for the crash log.
  let errorOutputTail = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString()
    console.error(text.trimEnd())
    errorOutputTail = `${errorOutputTail}${text}`.slice(-MEDIA_OUTPUT_TAIL_CHARS)
  })
  child.on('exit', (code) => {
    if (state.isQuitting) return
    if (code !== 0) {
      logError('The media process stopped', new Error(`exit code ${code}`))
      writeCrashLog({ process: 'media', exitCode: code, errorOutput: errorOutputTail })
    }
    restartMediaProcess(state, Date.now() - startedAt)
  })
  return child
}

// Work is never lost with the media process: a new one is started and every window connects to it as it is.
function restartMediaProcess(state: AppState, uptimeMs: number): void {
  state.mediaProcess = undefined
  state.mediaQuickExits = uptimeMs < MEDIA_PROCESS_MIN_UPTIME_MS ? state.mediaQuickExits + 1 : 0
  const waitMs = state.mediaQuickExits === 0 ? 0 : Math.min(MEDIA_RESTART_LONGEST_WAIT_MS, MEDIA_RESTART_FIRST_WAIT_MS * 2 ** (state.mediaQuickExits - 1))
  if (waitMs > 0) logError('The media process keeps stopping', new Error(`it ran for ${uptimeMs} ms`), { restartsInMs: waitMs })
  setTimeout(() => {
    if (state.isQuitting) return
    state.mediaProcess = launchMediaProcess(state)
    for (const editor of state.editors) {
      if (editor.window.isDestroyed()) continue
      const page = editor.window.webContents
      // A page that is loading, or that died and is loaded again, connects once it has loaded.
      if (page.isLoading() || page.isCrashed()) continue
      connectToMedia(state, editor.window)
    }
  }, waitMs)
}

function crashLogPath(): string {
  return join(app.getPath('userData'), 'logs', 'crash.log')
}

// One line for each process that died, kept on this Mac only. Written at once, as the process may be about to end.
function writeCrashLog(entry: Record<string, unknown>): void {
  try {
    const path = crashLogPath()
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`)
  } catch (error) {
    logError('Could not write the crash log', error, entry)
  }
}

// The page loads again from its recovery file, so at most the last ten seconds of work are lost.
function restartEditor(editor: Editor, cause: string): void {
  if (editor.window.isDestroyed()) return
  const now = Date.now()
  if (editor.restartedAt !== undefined && now - editor.restartedAt < RESTART_GUARD_MS) {
    writeCrashLog({ process: 'editor', event: 'not restarted again', cause })
    return
  }
  editor.restartedAt = now
  editor.window.webContents.reload()
}

function watchForCrashes(state: AppState): void {
  process.on('uncaughtExceptionMonitor', (error, origin) => {
    writeCrashLog({ process: 'main', reason: origin, error: describeError(error), stack: error.stack })
  })
  app.on('render-process-gone', (_event, webContents, details) => {
    if (state.isQuitting || details.reason === 'clean-exit') return
    writeCrashLog({ process: 'renderer', reason: details.reason, exitCode: details.exitCode, url: webContents.getURL() })
    const editor = state.editors.find((each) => each.window.webContents === webContents)
    if (editor !== undefined) restartEditor(editor, `its page ${details.reason}`)
  })
  // A GPU process that dies takes the drawing of every window with it; Chromium starts a new one, and each page draws again on it by itself.
  app.on('child-process-gone', (_event, details) => {
    if (state.isQuitting || details.reason === 'clean-exit') return
    // The media process has an entry of its own, with the end of its error output.
    if (details.type === 'Utility' && details.name === 'Media') return
    writeCrashLog({ process: details.type, name: details.name ?? details.serviceName, reason: details.reason, exitCode: details.exitCode })
  })
}

// Every window keeps smaller caches while macOS is short of memory. A window opened meanwhile hears it at the next check.
function watchMemoryPressure(state: AppState): void {
  let hasCheckFailed = false
  async function check(): Promise<void> {
    let isUnderPressure: boolean
    try {
      isUnderPressure = await isMemoryUnderPressure()
    } catch (error) {
      if (!hasCheckFailed) logError('Could not read the memory pressure', error)
      hasCheckFailed = true
      return
    }
    const hasChanged = isUnderPressure !== state.isUnderMemoryPressure
    state.isUnderMemoryPressure = isUnderPressure
    if (!isUnderPressure && !hasChanged) return
    const command: HostCommand = { type: 'memory-pressure', isUnderPressure }
    for (const editor of state.editors) send(editor.window, command)
    if (state.exportWindow !== undefined) send(state.exportWindow, command)
  }
  setInterval(() => void check(), MEMORY_PRESSURE_POLL_MS)
}

// Every load gets fresh ports: a reloaded page has lost the old ones, and closing them ends the old media session. A page that loads while the media process is being restarted gets its ports when the new one runs.
function connectToMedia(state: AppState, window: BrowserWindow): void {
  const mediaProcess = state.mediaProcess
  if (mediaProcess === undefined) return
  const engine = new MessageChannelMain()
  const ui = new MessageChannelMain()
  const connect: MediaProcessCommand = { type: 'connect' }
  mediaProcess.postMessage(connect, [engine.port1, ui.port1])
  window.webContents.postMessage('media-port', undefined, [engine.port2, ui.port2])
}

function send(window: BrowserWindow, command: HostCommand): void {
  if (!window.isDestroyed()) window.webContents.send('command', command)
}

type WindowOptions = {
  mode: WindowMode
  isUnattended: boolean
  // Where the top left corner goes; left out, the system places the window.
  position?: { x: number; y: number }
}

function createWindow(state: AppState, options: WindowOptions): BrowserWindow {
  const { mode } = options
  const isHeadless = mode === 'headless'
  const window = new BrowserWindow({
    ...options.position,
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
    // macOS keeps a window on a screen as it first shows it, so it is moved once shown.
    if (options.position === undefined) window.setPosition(OFF_SCREEN.x, OFF_SCREEN.y)
  } else if (!isHeadless) {
    window.show()
  }
  window.webContents.on('console-message', (details) => {
    if (details.level === 'error') logError('A window reported an error', new Error(details.message), { mode })
  })
  window.webContents.on('did-finish-load', () => connectToMedia(state, window))
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
  state.exportRequester = requester
  window.on('closed', () => {
    state.exportWindow = undefined
    state.exportRequester = undefined
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
  // The menu shows the Undo and Redo of the window in front.
  if (state.activeEditor === editor) buildEditorMenu(state)
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

// The page has dealt with the unsaved changes, so the window closes without asking again.
async function closeDocument(editor: Editor): Promise<void> {
  await discardRecovery(editor.document.recoveryPath)
  if (editor.window.isDestroyed()) return
  editor.isCloseConfirmed = true
  editor.window.close()
}

// An untitled window without changes is taken over by the project opened next, as Mac apps do.
async function openInPlace(state: AppState, editor: Editor, projectPath: string): Promise<void> {
  await discardRecovery(editor.document.recoveryPath)
  if (editor.window.isDestroyed()) return
  editor.document = documentFor(state, projectPath)
  editor.documentState = CLEAN_DOCUMENT
  showDocument(state, editor)
  editor.window.webContents.reload()
}

function bringForward(state: AppState, editor: Editor): void {
  state.activeEditor = editor
  buildEditorMenu(state)
  if (!state.isUnattended) editor.window.focus()
}

// A project that is open already comes to the front. Otherwise it takes over the window it was opened from when that is untitled and unchanged, or opens in a window of its own.
async function openProject(state: AppState, projectPath: string, from: Editor | undefined): Promise<void> {
  const path = resolve(projectPath)
  const shown = state.editors.find((editor) => editor.document.path === path)
  if (shown !== undefined) {
    bringForward(state, shown)
    return
  }
  const isUntouched = from !== undefined && from.document.path === undefined && !from.documentState.isDirty
  if (isUntouched) await openInPlace(state, from, path)
  else openEditor(state, documentFor(state, path))
}

async function chooseAndOpen(state: AppState, from: Editor | undefined): Promise<void> {
  const answer = state.dialogAnswers.openProject
  if (answer !== undefined) {
    await openProject(state, answer, from)
    return
  }
  const options = { properties: ['openFile' as const, 'multiSelections' as const], filters: PROJECT_FILTERS }
  const chosen = from === undefined ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(from.window, options)
  for (const path of chosen.filePaths) await openProject(state, path, from)
}

function editorOf(state: AppState, sender: Electron.WebContents): Editor | undefined {
  return state.editors.find((editor) => editor.window.webContents === sender)
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

  ipcMain.on('close-document', (event) => {
    const editor = editorOf(state, event.sender)
    if (editor !== undefined) void closeDocument(editor)
  })

  // Every window sends the keys it was given; they are kept per Mac, so all windows send the same.
  ipcMain.on('menu-shortcuts', (event, shortcuts: unknown) => {
    if (editorOf(state, event.sender) === undefined || !isMenuShortcuts(shortcuts)) return
    state.menuShortcuts = shortcuts
    buildEditorMenu(state)
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
  const documentState = state.activeEditor?.documentState ?? CLEAN_DOCUMENT

  // A command goes to the window that has the focus, or else to the one used last.
  function editorFor(window: Electron.BaseWindow | undefined): Editor | undefined {
    return state.editors.find((editor) => editor.window === window) ?? state.activeEditor
  }

  function sendToEditor(action: MenuAction, window: Electron.BaseWindow | undefined): void {
    const target = editorFor(window)
    if (target !== undefined) send(target.window, { type: 'menu', action })
  }

  function item(action: MenuAction, label: string, accelerator?: string): MenuItemConstructorOptions {
    const click: MenuItemConstructorOptions['click'] = (_item, window) => sendToEditor(action, window)
    return accelerator === undefined ? { id: action, label, click } : { id: action, label, accelerator, click }
  }

  // The keys of these commands can be changed. The menu shows them, but the page answers to them, so a single key never fires while a text field has the focus.
  function rebindable(action: MenuAction, label: string): MenuItemConstructorOptions {
    const accelerator = state.menuShortcuts[action]
    return accelerator === undefined ? item(action, label) : { ...item(action, label, accelerator), registerAccelerator: false }
  }

  function withLabel(verb: string, label: string | undefined): string {
    return label === undefined ? verb : `${verb} ${label}`
  }

  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        item('settings', 'Settings…', 'CmdOrCtrl+,'),
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        { id: 'new', label: 'New Project', accelerator: 'CmdOrCtrl+N', click: () => openEditor(state, documentFor(state, undefined)) },
        { id: 'open-project', label: 'Open…', accelerator: 'CmdOrCtrl+O', click: (_item, window) => void chooseAndOpen(state, editorFor(window)) },
        { label: 'Open Recent', role: 'recentDocuments', submenu: [{ label: 'Clear Menu', role: 'clearRecentDocuments' }] },
        { type: 'separator' },
        item('save', 'Save', 'CmdOrCtrl+S'),
        item('save-as', 'Save As…', 'Shift+CmdOrCtrl+S'),
        { type: 'separator' },
        rebindable('import', 'Import Media…'),
        rebindable('export', 'Export…'),
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
        rebindable('duplicate', 'Duplicate'),
        rebindable('delete', 'Delete'),
        rebindable('ripple-delete', 'Ripple Delete'),
        { type: 'separator' },
        rebindable('split', 'Split at Playhead'),
        rebindable('split-all', 'Split All Tracks'),
        rebindable('group', 'Group'),
        rebindable('ungroup', 'Ungroup'),
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
        rebindable('preview-mode', 'Preview Mode'),
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

async function shouldRestore(state: AppState, found: readonly FoundRecovery[]): Promise<boolean> {
  if (state.dialogAnswers.restore !== undefined) return state.dialogAnswers.restore
  const names = found.map((each) => `"${each.projectPath === undefined ? UNTITLED : basename(each.projectPath)}"`).join(', ')
  const answer = await dialog.showMessageBox({
    type: 'question',
    message: found.length === 1 ? `The editor closed unexpectedly while ${names} had unsaved changes.` : `The editor closed unexpectedly while ${found.length} projects had unsaved changes: ${names}.`,
    detail: 'Restore brings back your work as it was at most 10 seconds before the editor closed.',
    buttons: ['Restore', 'Discard'],
    defaultId: 0,
    cancelId: 1,
  })
  return answer.response === 0
}

function recoveredDocument(found: FoundRecovery): DocumentInfo {
  return { path: found.projectPath, loadFrom: found.recoveryPath, recoveryPath: found.recoveryPath, exportSnapshotPath: exportSnapshotPath(found.recoveryPath), hasSmallMemory: totalmem() <= SMALL_MEMORY_BYTES }
}

// The documents the first windows show: the work of every window that had unsaved changes when the editor closed, or else the project asked for.
async function firstDocuments(state: AppState, projectPath: string | undefined): Promise<DocumentInfo[]> {
  const found = await findRecoveries(state.recoveryDirectory)
  if (found.length > 0 && (await shouldRestore(state, found))) {
    const restored = found.map(recoveredDocument)
    const isRestored = restored.some((document) => document.path === projectPath)
    return projectPath === undefined || isRestored ? restored : [...restored, documentFor(state, projectPath)]
  }
  for (const each of found) await discardRecovery(each.recoveryPath)
  return [documentFor(state, projectPath)]
}

function openEditor(state: AppState, document: DocumentInfo): BrowserWindow {
  const front = state.activeEditor?.window
  let position: WindowOptions['position']
  if (front !== undefined && !front.isDestroyed()) {
    const [left = 0, top = 0] = front.getPosition()
    position = { x: left + CASCADE_PIXELS, y: top + CASCADE_PIXELS }
  }
  const window = createWindow(state, { mode: 'editor', isUnattended: state.isUnattended, position })
  const editor: Editor = { window, document, documentState: CLEAN_DOCUMENT, isCloseConfirmed: false, restartedAt: undefined }
  state.editors.push(editor)
  state.activeEditor = editor
  // The window is named after its document, not after the page it shows.
  window.on('page-title-updated', (event) => event.preventDefault())
  window.on('focus', () => {
    state.activeEditor = editor
    buildEditorMenu(state)
  })
  showDocument(state, editor)

  // A document with unsaved changes closes only after the page has asked the user; a crashed page cannot ask.
  // While it exports, the window stays, as one with a sheet does: its dialog is the only place to follow the export or to stop it.
  window.on('close', (event) => {
    const isExporting = state.exportRequester === window
    const hasNothingToAsk = editor.isCloseConfirmed || !editor.documentState.isDirty
    const canCloseNow = window.webContents.isCrashed() || (!isExporting && hasNothingToAsk)
    if (canCloseNow) return
    event.preventDefault()
    // A close that is refused calls off the quit it may have been part of.
    state.isQuitting = false
    if (!isExporting) send(window, { type: 'menu', action: 'close' })
    else if (!state.isUnattended) shell.beep()
  })
  // For the same reason an export does not outlive the page that started it: a page that loads again has forgotten it.
  window.webContents.on('did-start-loading', () => {
    if (state.exportRequester === window) state.exportWindow?.destroy()
  })
  window.on('closed', () => {
    state.editors = state.editors.filter((other) => other !== editor)
    if (state.activeEditor === editor) state.activeEditor = state.editors.at(-1)
    if (!editor.documentState.isDirty || editor.isCloseConfirmed) void discardRecovery(editor.document.recoveryPath)
    if (state.activeEditor !== undefined) buildEditorMenu(state)
  })
  return window
}

// Core Audio takes about 130 ms to set up the first sound output of the app, and the page that asks for it can do nothing else meanwhile.
// A hidden page of its own asks first, so the editor's first Space does not stall its window; the outputs after the first open at once.
async function prepareSoundOutput(): Promise<void> {
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } })
  window.webContents.setAudioMuted(true)
  try {
    await window.loadURL('about:blank')
    await window.webContents.executeJavaScript(`new AudioContext({ sampleRate: ${SAMPLE_RATE}, latencyHint: 'interactive' }).close()`)
  } catch (error) {
    logError('Could not prepare the sound output', error)
  } finally {
    window.destroy()
  }
}

async function openFirstEditors(state: AppState, projectPath: string | undefined): Promise<BrowserWindow> {
  const [first, ...others] = await firstDocuments(state, projectPath)
  const firstWindow = openEditor(state, first ?? documentFor(state, projectPath))
  for (const document of others) openEditor(state, document)
  // Started once a window is open: the hidden page closing must not look like the last window closing.
  void prepareSoundOutput()
  return firstWindow
}

type UiTestInputs = {
  projectPath: string | undefined
  outputDirectory: string | undefined
  mediaDirectory: string | undefined
  // How long a scenario that runs for a while goes on, and the seed of one that acts at random.
  seconds: number | undefined
  seed: number | undefined
}

async function runCliUiTest(state: AppState, scenario: string, inputs: UiTestInputs): Promise<void> {
  try {
    // A recovery file can only be there because the test left one on purpose, so it is restored without asking.
    state.dialogAnswers.restore = true
    state.isUnattended = true
    app.dock?.hide()
    const window = await openFirstEditors(state, inputs.projectPath)
    const { outputDirectory, mediaDirectory, seconds, seed } = inputs
    const report = await runUiTest(window, { scenario, outputDirectory, mediaDirectory, seconds, seed, answers: state.dialogAnswers })
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
  const seed = options.has('seed') ? Number(options.get('seed')) : undefined
  if (seed !== undefined && !Number.isSafeInteger(seed)) throw new UsageError('--seed must be a whole number')
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
    if (started === undefined) fileToOpen = path
    else void openProject(started, path, started.activeEditor)
  })

  await app.whenReady()
  serveRenderer()
  const state: AppState = {
    mediaProcess: undefined,
    mediaQuickExits: 0,
    isUnderMemoryPressure: false,
    editors: [],
    activeEditor: undefined,
    harnessWindow: undefined,
    exportWindow: undefined,
    exportRequester: undefined,
    jobListeners: new Map(),
    exportPathOverride: undefined,
    lastExportPath: undefined,
    dialogAnswers: {},
    recoveryDirectory: join(app.getPath('userData'), 'recovery'),
    remembersRecentDocuments: isInteractive,
    isQuitting: false,
    memory: options.has('report-memory') ? startMemoryMonitor(process.pid) : undefined,
    versions: undefined,
    isUnattended: false,
    menuShortcuts: menuShortcutsOf(DEFAULT_BINDINGS),
  }
  started = state
  watchForCrashes(state)
  if (!isInteractive) exitWhenOutputCloses(state)
  state.mediaProcess = launchMediaProcess(state)
  watchMemoryPressure(state)
  registerIpc(state)
  registerDocumentIpc(state)
  app.on('before-quit', () => {
    state.isQuitting = true
  })
  app.on('window-all-closed', () => app.quit())
  app.on('second-instance', () => state.activeEditor?.window.focus())

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
    await runCliUiTest(state, uiTestScenario, {
      projectPath,
      outputDirectory: resolved(options.get('out')),
      mediaDirectory: resolved(options.get('media')),
      seconds: options.has('seconds') ? playSeconds : undefined,
      seed,
    })
    return
  }
  await openFirstEditors(state, projectPath)
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
