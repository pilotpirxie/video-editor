import type { MessagePortMain } from 'electron'
import { describeError, logError } from '../shared/log.js'
import type { MediaMessage, MediaProcessCommand, MediaProcessReport, MediaReply, MediaRequest } from '../shared/mediaProtocol.js'
import { createFfmpegRunner, type Binary, type FfmpegRunner } from './ffmpeg.js'
import { MediaError, MediaSession } from './mediaStore.js'

const VERSION_TIMEOUT_MS = 10_000
const VERSION_PATTERN = /version (?<version>\d[\w.]*)/

function isCommand(value: unknown): value is MediaProcessCommand {
  return typeof value === 'object' && value !== null && 'type' in value && (value.type === 'setup' || value.type === 'connect')
}

function isMessage(value: unknown): value is MediaMessage {
  if (typeof value !== 'object' || value === null) return false
  if ('abort' in value) return typeof value.abort === 'number'
  return 'id' in value && typeof value.id === 'number' && 'request' in value && typeof value.request === 'object'
}

function unknownRequest(request: never): never {
  throw new MediaError(`The media process does not know the request ${JSON.stringify(request)}`)
}

function perform(session: MediaSession, request: MediaRequest, signal: AbortSignal): Promise<unknown> {
  switch (request.method) {
    case 'loadProject':
      return session.loadProject(request.path, request.forPreview)
    case 'whenPrepared':
      return session.whenPrepared()
    case 'readImage':
      return session.readImage(request.mediaId)
    case 'previewFrame':
      return session.previewFrame(request.mediaId, request.frame)
    case 'fullFrame':
      return session.fullFrame(request.mediaId, request.frame, request.halvings, signal)
    case 'openStream':
      return session.openStream(request.mediaId, request.frame, request.halvings)
    case 'streamFrame':
      return session.streamFrame(request.streamId, request.frame)
    case 'closeStream':
      return session.closeStream(request.streamId)
    case 'audio':
      return session.audio(request.mediaId, request.firstSample, request.sampleCount)
    case 'exportStart':
      return session.exportStart(request.target)
    case 'exportWrite':
      return session.exportWrite(request.jobId, request.pixels, request.audio)
    case 'exportFinish':
      return session.exportFinish(request.jobId)
    case 'exportCancel':
      return session.exportCancel(request.jobId)
    case 'writeFile':
      return session.writeFile(request.directory, request.name, request.data)
    default:
      return unknownRequest(request)
  }
}

function serve(port: MessagePortMain, ffmpeg: FfmpegRunner, cacheDirectory: string): void {
  const session = new MediaSession(ffmpeg, cacheDirectory)
  const inFlight = new Map<number, AbortController>()

  async function answer(id: number, request: MediaRequest): Promise<void> {
    const controller = new AbortController()
    inFlight.set(id, controller)
    let reply: MediaReply
    try {
      reply = { id, result: await perform(session, request, controller.signal) }
    } catch (error) {
      reply = { id, error: describeError(error) }
    }
    inFlight.delete(id)
    port.postMessage(reply)
  }

  port.on('message', (event) => {
    const message: unknown = event.data
    if (!isMessage(message)) return
    if ('abort' in message) {
      inFlight.get(message.abort)?.abort()
      return
    }
    void answer(message.id, message.request)
  })
  async function shutDown(): Promise<void> {
    try {
      await session.dispose()
    } catch (error) {
      logError('Could not shut a media session down cleanly', error)
    }
  }

  port.on('close', () => void shutDown())
  port.start()
}

async function versionOf(ffmpeg: FfmpegRunner, binary: Binary): Promise<string> {
  const output = await ffmpeg.runOnce(binary, ['-version'], { timeoutMs: VERSION_TIMEOUT_MS })
  return VERSION_PATTERN.exec(output.toString())?.groups?.version ?? 'unknown'
}

async function reportVersions(ffmpeg: FfmpegRunner): Promise<void> {
  try {
    const report: MediaProcessReport = {
      type: 'versions',
      ffmpeg: await versionOf(ffmpeg, 'ffmpeg'),
      ffprobe: await versionOf(ffmpeg, 'ffprobe'),
    }
    process.parentPort.postMessage(report)
  } catch (error) {
    logError('The bundled FFmpeg could not be run', error)
  }
}

function start(): void {
  let ffmpeg: FfmpegRunner | undefined
  let cacheDirectory: string | undefined

  process.parentPort.on('message', (event) => {
    const command: unknown = event.data
    if (!isCommand(command)) return

    if (command.type === 'setup') {
      ffmpeg = createFfmpegRunner(command.setup.ffmpegDirectory)
      cacheDirectory = command.setup.cacheDirectory
      process.on('exit', ffmpeg.killAll)
      void reportVersions(ffmpeg)
      return
    }

    const port = event.ports[0]
    if (port === undefined || ffmpeg === undefined || cacheDirectory === undefined) {
      logError('A window connected before the media process was set up', new Error('missing setup or port'))
      return
    }
    serve(port, ffmpeg, cacheDirectory)
  })
}

start()
