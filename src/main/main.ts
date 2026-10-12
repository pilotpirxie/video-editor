import {
  BrowserWindow,
  Menu,
  MessageChannelMain,
  app,
  dialog,
  ipcMain,
  powerSaveBlocker,
  protocol,
  utilityProcess,
  type MenuItemConstructorOptions,
  type UtilityProcess,
} from 'electron'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, resolve } from 'node:path'
import { EXPORT_PRESETS, isExportPreset } from '../shared/exportPresets.js'
import { describeError, logError } from '../shared/log.js'
import type { ExportJob, FramesJob, HeadlessJob, HostCommand, JobEvent, MediaProcessCommand, MediaProcessReport } from '../shared/mediaProtocol.js'
import { startMemoryMonitor, type MemoryMonitor } from './memory.js'
import { runSelfTest, type SelfTestOptions } from './selfTest.js'

const RENDERER_DIRECTORY = join(import.meta.dirname, '..', '..', '..', 'renderer')
const MEDIA_SERVICE_PATH = join(import.meta.dirname, '..', 'media', 'service.js')
const PRELOAD_PATH = join(import.meta.dirname, 'preload.cjs')
const WINDOW_BACKGROUND = '#14171D'
const USAGE_EXIT_CODE = 2

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
}

const CLI_FLAGS = ['project', 'export', 'frames', 'out', 'preset', 'via', 'at', 'size', 'selftest', 'seconds', 'report-memory']
const DEFAULT_SELFTEST_SECONDS = 2
const BYTES_PER_MEGABYTE = 1024 * 1024
const SIZE_PATTERN = /^(?<width>\d+)x(?<height>\d+)$/

type WindowMode = 'harness' | 'headless'

/** Everything the main process keeps track of while it runs. */
type AppState = {
  mediaProcess: UtilityProcess
  harnessWindow: BrowserWindow | undefined
  exportWindow: BrowserWindow | undefined
  /** Who is told about job events, by the id of the window that runs the job. */
  jobListeners: Map<number, (event: JobEvent) => void>
  /** Answers the export save dialog without showing it; set while the self-test runs. */
  exportPathOverride: string | undefined
  /** Running when --report-memory was given. */
  memory: MemoryMonitor | undefined
  /** The lines shown in the About panel, once the bundled FFmpeg has reported its versions. */
  versions: string[] | undefined
}

/** The command line was not understood; the message says how to fix it. */
class UsageError extends Error {}

// Must happen before the app is ready.
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }])

/** `--name value` pairs for the flags this app knows; other arguments belong to Electron. */
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

function exportJobFromCli(projectPath: string, options: Map<string, string>): ExportJob {
  const preset = options.get('preset') ?? '1080p'
  const outputPath = options.get('out')
  if (outputPath === undefined || outputPath === '') throw new UsageError('--export needs --out <file.mp4>')
  if (!isExportPreset(preset)) throw new UsageError(`--preset must be one of ${EXPORT_PRESETS.join(', ')}`)
  return { kind: 'export', projectPath: resolve(projectPath), outputPath: resolve(outputPath), preset }
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

function isExportJob(value: unknown): value is ExportJob {
  if (typeof value !== 'object' || value === null) return false
  if (!('kind' in value) || value.kind !== 'export') return false
  if (!('projectPath' in value) || typeof value.projectPath !== 'string') return false
  if (!('outputPath' in value) || typeof value.outputPath !== 'string') return false
  return 'preset' in value && typeof value.preset === 'string' && isExportPreset(value.preset)
}

function isJobEvent(value: unknown): value is JobEvent {
  if (typeof value !== 'object' || value === null || !('type' in value)) return false
  return value.type === 'progress' || value.type === 'done' || value.type === 'error'
}

function isVersionReport(value: unknown): value is MediaProcessReport {
  return typeof value === 'object' && value !== null && 'type' in value && value.type === 'versions'
}

/** Serves the built renderer files under app://, so the page never runs from file://. */
function serveRenderer(): void {
  protocol.handle('app', async (request) => {
    const filePath = join(RENDERER_DIRECTORY, normalize(decodeURIComponent(new URL(request.url).pathname)))
    if (!filePath.startsWith(RENDERER_DIRECTORY)) return new Response('Not found', { status: 404 })
    try {
      const body = await readFile(filePath)
      return new Response(body, { headers: { 'content-type': CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream' } })
    } catch (error) {
      logError('Could not serve a renderer file', error, { filePath })
      return new Response('Not found', { status: 404 })
    }
  })
}

/** Lists the versions of everything bundled in the About panel. */
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

function startMediaProcess(onVersions: (versions: string[]) => void): UtilityProcess {
  const child = utilityProcess.fork(MEDIA_SERVICE_PATH, [], { serviceName: 'Media' })
  const setup: MediaProcessCommand = {
    type: 'setup',
    setup: {
      ffmpegDirectory: app.isPackaged ? join(process.resourcesPath, 'ffmpeg') : join(app.getAppPath(), 'vendor', 'ffmpeg'),
      cacheDirectory: join(app.getPath('userData'), 'cache'),
    },
  }
  child.postMessage(setup)
  child.on('message', (message: unknown) => {
    if (isVersionReport(message)) onVersions(showVersionsInAboutPanel(message))
  })
  child.on('exit', (code) => {
    if (code !== 0) logError('The media process stopped', new Error(`exit code ${code}`))
  })
  return child
}

function send(window: BrowserWindow, command: HostCommand): void {
  if (!window.isDestroyed()) window.webContents.send('command', command)
}

type WindowOptions = {
  mode: WindowMode
  /** Shown without taking focus and never slowed down when covered: for unattended runs. */
  isUnattended: boolean
}

function createWindow(state: AppState, options: WindowOptions): BrowserWindow {
  const { mode } = options
  const isHeadless = mode === 'headless'
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1280,
    minHeight: 720,
    show: false,
    backgroundColor: WINDOW_BACKGROUND,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // A hidden window must keep rendering at full speed while it exports.
      backgroundThrottling: !isHeadless && !options.isUnattended,
    },
  })
  if (options.isUnattended) {
    window.webContents.setAudioMuted(true)
    window.showInactive()
  } else if (!isHeadless) {
    window.show()
  }
  // Problems inside a window would otherwise be visible only in its developer tools.
  window.webContents.on('console-message', (details) => {
    if (details.level === 'error') logError('A window reported an error', new Error(details.message), { mode })
  })
  // Gives the window's engine a private line to the media process.
  window.webContents.once('did-finish-load', () => {
    const { port1, port2 } = new MessageChannelMain()
    const connect: MediaProcessCommand = { type: 'connect' }
    state.mediaProcess.postMessage(connect, [port1])
    window.webContents.postMessage('media-port', undefined, [port2])
  })
  window.loadURL(`app://editor/index.html?mode=${mode}`).catch((error: unknown) => logError('Could not load the window', error, { mode }))
  return window
}

/** Runs a job in a hidden engine window and reports its events to `onEvent`. */
function runHeadlessJob(state: AppState, job: HeadlessJob, onEvent: (event: JobEvent) => void): BrowserWindow {
  const window = createWindow(state, { mode: 'headless', isUnattended: false })
  const senderId = window.webContents.id
  // macOS would otherwise slow down an app with no visible window.
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

/** Prints a result as one JSON line, with the peak memory when it was being measured, and exits. */
async function finish(state: AppState, result: Record<string, unknown>): Promise<void> {
  const report = { ...result }
  if (state.memory !== undefined) report.peakMemoryMegabytes = Math.round((await state.memory.stop()) / BYTES_PER_MEGABYTE)
  process.stdout.write(`${JSON.stringify(report)}\n`)
  app.exit(0)
}

/** Runs one job for the command line: progress and the result go to stdout, then the app exits. */
function runCliJob(state: AppState, job: HeadlessJob): void {
  app.dock?.hide()
  runHeadlessJob(state, job, (event) => {
    if (event.type === 'progress') {
      process.stdout.write(`progress ${event.done}/${event.total}\n`)
    } else if (event.type === 'done') {
      void finish(state, event.summary)
    } else {
      process.stderr.write(`${event.message}\n`)
      app.exit(1)
    }
  })
}

/** Opens the harness on a project, drives it through the self-test and prints the report. */
async function runCliSelfTest(state: AppState, projectPath: string, options: SelfTestOptions): Promise<void> {
  state.exportPathOverride = options.exportPath
  const window = openHarness(state, projectPath, true)
  try {
    const report = await runSelfTest(window, options)
    await finish(state, { ...report, aboutPanel: state.versions ?? [] })
  } catch (error) {
    process.stderr.write(`${describeError(error)}\n`)
    app.exit(1)
  }
}

function startExportFor(state: AppState, requester: BrowserWindow, job: ExportJob): void {
  if (state.exportWindow !== undefined) {
    send(requester, { type: 'export-event', event: { type: 'error', message: 'Another export is already running.' } })
    return
  }
  const window = runHeadlessJob(state, job, (event) => {
    send(requester, { type: 'export-event', event })
    if (event.type !== 'progress') window.destroy()
  })
  state.exportWindow = window
  window.on('closed', () => {
    state.exportWindow = undefined
  })
}

function registerIpc(state: AppState): void {
  ipcMain.handle('open-project-dialog', async (event): Promise<string | undefined> => {
    const owner = BrowserWindow.fromWebContents(event.sender)
    if (owner === null) return undefined
    const result = await dialog.showOpenDialog(owner, {
      properties: ['openFile'],
      filters: [{ name: 'Project', extensions: ['json'] }],
    })
    return result.filePaths[0]
  })

  ipcMain.handle('save-export-dialog', async (event, suggestedName: unknown): Promise<string | undefined> => {
    if (state.exportPathOverride !== undefined) return state.exportPathOverride
    const owner = BrowserWindow.fromWebContents(event.sender)
    if (owner === null) return undefined
    const result = await dialog.showSaveDialog(owner, {
      defaultPath: typeof suggestedName === 'string' ? suggestedName : 'export.mp4',
      filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
    })
    return result.canceled || result.filePath === '' ? undefined : result.filePath
  })

  ipcMain.on('job-event', (event, jobEvent: unknown) => {
    if (isJobEvent(jobEvent)) state.jobListeners.get(event.sender.id)?.(jobEvent)
  })

  ipcMain.on('start-export', (event, job: unknown) => {
    const requester = BrowserWindow.fromWebContents(event.sender)
    if (requester !== null && isExportJob(job)) startExportFor(state, requester, job)
  })

  // Closing the window drops its media connection, which stops FFmpeg and removes the partial file.
  ipcMain.on('cancel-export', () => state.exportWindow?.destroy())
}

function buildMenu(state: AppState): void {
  function sendToHarness(action: 'open-project' | 'export'): void {
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

async function main(): Promise<void> {
  const options = cliOptions(process.argv)
  const exportPath = options.get('export')
  const framesPath = options.get('frames')
  // Parsed before anything starts, so a bad command line fails at once.
  let cliJob: HeadlessJob | undefined
  if (exportPath !== undefined) cliJob = exportJobFromCli(exportPath, options)
  if (framesPath !== undefined) cliJob = framesJobFromCli(framesPath, options)
  const selfTestPath = options.get('selftest')
  const playSeconds = Number(options.get('seconds') ?? DEFAULT_SELFTEST_SECONDS)
  if (!(playSeconds > 0)) throw new UsageError('--seconds must be a positive number')

  await app.whenReady()
  serveRenderer()
  const state: AppState = {
    mediaProcess: startMediaProcess((versions) => {
      state.versions = versions
    }),
    harnessWindow: undefined,
    exportWindow: undefined,
    jobListeners: new Map(),
    exportPathOverride: undefined,
    memory: options.has('report-memory') ? startMemoryMonitor(process.pid) : undefined,
    versions: undefined,
  }
  registerIpc(state)
  app.on('window-all-closed', () => app.quit())

  if (cliJob !== undefined) {
    runCliJob(state, cliJob)
    return
  }
  buildMenu(state)
  if (selfTestPath !== undefined) {
    const out = options.get('out')
    const exportPath = out === undefined || out === '' ? undefined : resolve(out)
    await runCliSelfTest(state, selfTestPath, { playSeconds, exportPath })
    return
  }
  openHarness(state, options.get('project'), false)
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

// Not awaited: Electron only signals "ready" once this module has finished loading, so a
// top-level await on anything that waits for "ready" would never complete.
void run()
