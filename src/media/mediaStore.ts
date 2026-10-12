import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile, type FileHandle } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { FRAME_DECODE_PIXEL_BUDGET, MAX_OPEN_STREAMS } from '../shared/limits.js'
import { describeError, logError } from '../shared/log.js'
import type { ExportTarget, LoadedProject, MediaClient, MediaInfo, MediaState, RawFrame } from '../shared/mediaProtocol.js'
import { parseProject, type MediaRef } from '../shared/project.js'
import { openPreparedAudio, prepareAudio, readAudio } from './audio.js'
import { startEncoder, type Encoder } from './encoder.js'
import type { FfmpegRunner } from './ffmpeg.js'
import { decodeFrame, openFrameStream, toArrayBuffer, type FrameStream, type VideoSource } from './frames.js'
import { isPreviewComplete, openPreviewCopy, type PreviewCopy } from './previewCopy.js'
import { ProbeError, probeMedia } from './probe.js'

const CACHE_KEY_LENGTH = 32
const PREPARATION_GRACE_MS = 250
const INFO_FILE = 'info.json'
const MEDIA_KINDS = ['video', 'audio', 'image']

export class MediaError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'MediaError'
  }
}

type MediaEntry = {
  path: string
  info: MediaInfo
  directory: string
  preview: PreviewCopy | undefined
  audio: Promise<FileHandle> | undefined
}

type OpenProject = {
  media: Map<string, MediaEntry>
  lifetime: AbortController
  prepared: Promise<void>
}

function cacheKey(text: string): string {
  const digest = createHash('sha256').update(text).digest('hex')
  return digest.slice(0, CACHE_KEY_LENGTH)
}

function isMediaInfo(value: unknown): value is MediaInfo {
  if (typeof value !== 'object' || value === null || !('kind' in value)) return false
  return typeof value.kind === 'string' && MEDIA_KINDS.includes(value.kind)
}

type WeightLimiter = {
  run<Result>(weight: number, task: () => Promise<Result>): Promise<Result>
  whenIdle(): Promise<void>
}

function createWeightLimiter(capacity: number): WeightLimiter {
  let runningWeight = 0
  const waiting: { weight: number; start: () => void }[] = []
  let idleListeners: (() => void)[] = []

  function startWaiting(): void {
    for (;;) {
      const next = waiting[0]
      const fits = next !== undefined && (runningWeight === 0 || runningWeight + next.weight <= capacity)
      if (next === undefined || !fits) break
      waiting.shift()
      runningWeight += next.weight
      next.start()
    }
    if (runningWeight > 0 || waiting.length > 0) return
    const listeners = idleListeners
    idleListeners = []
    for (const listener of listeners) listener()
  }

  async function run<Result>(weight: number, task: () => Promise<Result>): Promise<Result> {
    await new Promise<void>((start) => {
      waiting.push({ weight, start })
      startWaiting()
    })
    try {
      return await task()
    } finally {
      runningWeight -= weight
      startWaiting()
    }
  }

  function whenIdle(): Promise<void> {
    if (runningWeight === 0 && waiting.length === 0) return Promise.resolve()
    return new Promise((resolve) => idleListeners.push(resolve))
  }

  return { run, whenIdle }
}

export class MediaSession implements MediaClient {
  private project: OpenProject | undefined
  private readonly streams = new Map<number, FrameStream>()
  private readonly exports = new Map<number, Encoder>()
  private readonly frameDecodes = createWeightLimiter(FRAME_DECODE_PIXEL_BUDGET)
  private nextId = 1

  constructor(
    private readonly ffmpeg: FfmpegRunner,
    private readonly cacheDirectory: string,
  ) {}

  async loadProject(path: string, forPreview: boolean): Promise<LoadedProject> {
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      throw new MediaError(`"${basename(path)}" could not be opened: ${describeError(error)}`, { cause: error })
    }
    const parsed = parseProject(text)
    if (!parsed.ok) throw new MediaError(parsed.message)

    await this.closeProject()
    const projectCache = join(this.cacheDirectory, cacheKey(path))
    const media = new Map<string, MediaEntry>()
    const states: Record<string, MediaState> = {}
    for (const reference of parsed.project.media) {
      try {
        const entry = await this.openMedia(reference, dirname(path), projectCache)
        media.set(reference.id, entry)
        states[reference.id] = { info: entry.info }
      } catch (error) {
        if (!(error instanceof ProbeError) && !(error instanceof MediaError)) throw error
        states[reference.id] = { error: error.message }
      }
    }

    const lifetime = new AbortController()
    const prepared = forPreview ? this.prepareInBackground(media, lifetime.signal, path) : Promise.resolve()
    this.project = { media, lifetime, prepared }
    return { project: parsed.project, media: states }
  }

  async whenPrepared(): Promise<void> {
    await this.project?.prepared
  }

  async readImage(mediaId: string): Promise<ArrayBuffer> {
    const entry = this.entryOf(mediaId)
    return toArrayBuffer(await readFile(entry.path))
  }

  async previewFrame(mediaId: string, frame: number): Promise<ArrayBuffer | undefined> {
    const jpeg = await this.entryOf(mediaId).preview?.readFrame(frame)
    return jpeg === undefined ? undefined : toArrayBuffer(jpeg)
  }

  fullFrame(mediaId: string, frame: number, halvings: number, signal?: AbortSignal): Promise<RawFrame> {
    const source = this.videoSourceOf(mediaId)
    const pixelCount = source.video.width * source.video.height
    return this.frameDecodes.run(pixelCount, () => decodeFrame(this.ffmpeg, source, frame, halvings, signal))
  }

  async openStream(mediaId: string, frame: number, halvings: number): Promise<number> {
    const id = this.nextId++
    this.streams.set(id, openFrameStream(this.ffmpeg, this.videoSourceOf(mediaId), frame, halvings))
    return id
  }

  async streamFrame(streamId: number, frame: number): Promise<RawFrame> {
    const stream = this.streams.get(streamId)
    if (stream === undefined) throw new MediaError(`Frame stream ${streamId} is not open`)
    this.streams.delete(streamId)
    this.streams.set(streamId, stream)
    this.suspendIdleStreams()
    return stream.frame(frame)
  }

  async closeStream(streamId: number): Promise<void> {
    this.streams.get(streamId)?.close()
    this.streams.delete(streamId)
  }

  async audio(mediaId: string, firstSample: number, sampleCount: number): Promise<Float32Array | undefined> {
    const entry = this.entryOf(mediaId)
    if (entry.info.kind === 'image' || entry.info.audio === undefined) return undefined
    const lifetime = this.project?.lifetime.signal ?? AbortSignal.abort()
    return readAudio(await this.preparedAudio(entry, lifetime), firstSample, sampleCount)
  }

  async exportStart(target: ExportTarget): Promise<number> {
    const id = this.nextId++
    this.exports.set(id, startEncoder(this.ffmpeg, target))
    return id
  }

  async exportWrite(jobId: number, pixels: ArrayBuffer, audio: Float32Array): Promise<void> {
    await this.encoderOf(jobId).write(pixels, audio)
  }

  async exportFinish(jobId: number): Promise<void> {
    const encoder = this.encoderOf(jobId)
    this.exports.delete(jobId)
    await encoder.finish()
  }

  async exportCancel(jobId: number): Promise<void> {
    const encoder = this.exports.get(jobId)
    this.exports.delete(jobId)
    await encoder?.cancel()
  }

  async writeFile(directory: string, name: string, data: ArrayBuffer): Promise<void> {
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, basename(name)), new Uint8Array(data))
  }

  async dispose(): Promise<void> {
    for (const stream of this.streams.values()) stream.close()
    this.streams.clear()
    const encoders = [...this.exports.values()]
    this.exports.clear()
    for (const encoder of encoders) await encoder.cancel()
    await this.closeProject()
  }

  private async closeProject(): Promise<void> {
    const project = this.project
    if (project === undefined) return
    this.project = undefined
    project.lifetime.abort()
    for (const entry of project.media.values()) {
      await entry.preview?.close()
      if (entry.audio !== undefined) await closeWhenOpened(entry.audio)
    }
  }

  private async openMedia(reference: MediaRef, projectDirectory: string, projectCache: string): Promise<MediaEntry> {
    const candidates: string[] = []
    if (reference.path !== '') candidates.push(reference.path)
    if (reference.relativePath !== '') candidates.push(resolve(projectDirectory, reference.relativePath))
    const path = candidates.find((candidate) => existsSync(candidate))
    if (path === undefined) throw new MediaError(`"${basename(candidates[0] ?? reference.id)}" was not found.`)

    const file = await stat(path)
    const directory = join(projectCache, cacheKey(`${path}\n${file.size}\n${file.mtimeMs}`))
    await mkdir(directory, { recursive: true })
    const info = await this.infoOf(path, directory)
    return { path, info, directory, preview: undefined, audio: undefined }
  }

  private async infoOf(path: string, directory: string): Promise<MediaInfo> {
    const infoPath = join(directory, INFO_FILE)
    if (existsSync(infoPath)) {
      const cachedText = await readFile(infoPath, 'utf8')
      let cached: unknown
      try {
        cached = JSON.parse(cachedText)
      } catch (error) {
        logError('Ignoring an unreadable media info cache', error, { infoPath })
      }
      if (isMediaInfo(cached)) return cached
    }
    const info = await probeMedia(this.ffmpeg, path)
    await writeFile(infoPath, JSON.stringify(info))
    return info
  }

  private async prepareInBackground(media: ReadonlyMap<string, MediaEntry>, signal: AbortSignal, projectPath: string): Promise<void> {
    const entries = [...media.values()]
    for (const entry of entries) {
      if (signal.aborted) return
      if (entry.info.kind === 'image' || entry.info.audio === undefined) continue
      try {
        await this.preparedAudio(entry, signal)
      } catch (error) {
        if (!signal.aborted) logError('Could not prepare audio', error, { path: entry.path, project: projectPath })
      }
    }

    const videos = entries.filter((entry) => entry.info.kind === 'video')
    videos.sort((a, b) => Number(isPreviewComplete(b.directory)) - Number(isPreviewComplete(a.directory)))
    for (const entry of videos) {
      await sleep(PREPARATION_GRACE_MS)
      await this.frameDecodes.whenIdle()
      if (signal.aborted) return
      try {
        entry.preview = await openPreviewCopy(this.ffmpeg, videoSource(entry), entry.directory, signal)
        await entry.preview.finished
      } catch (error) {
        if (!signal.aborted) logError('Could not prepare the preview copy', error, { path: entry.path, project: projectPath })
      }
    }
  }

  private preparedAudio(entry: MediaEntry, signal: AbortSignal): Promise<FileHandle> {
    entry.audio ??= openAudio(this.ffmpeg, entry, signal)
    return entry.audio
  }

  private suspendIdleStreams(): void {
    const excess = this.streams.size - MAX_OPEN_STREAMS
    let suspended = 0
    for (const stream of this.streams.values()) {
      if (suspended >= excess) return
      stream.close()
      suspended += 1
    }
  }

  private entryOf(mediaId: string): MediaEntry {
    const entry = this.project?.media.get(mediaId)
    if (entry === undefined) throw new MediaError(`Media "${mediaId}" is not available`)
    return entry
  }

  private videoSourceOf(mediaId: string): VideoSource {
    return videoSource(this.entryOf(mediaId))
  }

  private encoderOf(jobId: number): Encoder {
    const encoder = this.exports.get(jobId)
    if (encoder === undefined) throw new MediaError(`Export ${jobId} is not running`)
    return encoder
  }
}

function videoSource(entry: MediaEntry): VideoSource {
  if (entry.info.kind !== 'video') throw new MediaError(`"${basename(entry.path)}" is not a video`)
  return { path: entry.path, containerStart: entry.info.containerStart, video: entry.info.video }
}

async function openAudio(ffmpeg: FfmpegRunner, entry: MediaEntry, signal: AbortSignal): Promise<FileHandle> {
  const containerStart = entry.info.kind === 'image' ? 0 : entry.info.containerStart
  await prepareAudio(ffmpeg, { path: entry.path, containerStart }, entry.directory, signal)
  return openPreparedAudio(entry.directory)
}

async function closeWhenOpened(audio: Promise<FileHandle>): Promise<void> {
  const [opened] = await Promise.allSettled([audio])
  if (opened.status === 'fulfilled') await opened.value.close()
}
