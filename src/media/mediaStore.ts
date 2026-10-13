import { createHash, randomUUID } from 'node:crypto'
import { existsSync, type Stats } from 'node:fs'
import { mkdir, readFile, stat, writeFile, type FileHandle } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { FRAME_DECODE_PIXEL_BUDGET, MAX_OPEN_STREAMS } from '../shared/limits.js'
import { describeError, logError } from '../shared/log.js'
import type {
  AddedMedia,
  AudioStretch,
  ExportTarget,
  LoadedProject,
  MediaClient,
  MediaInfo,
  MediaState,
  MediaUse,
  Preparation,
  RawFrame,
  RelinkedMedia,
  UnlinkedMedia,
  WaveformLevel,
} from '../shared/mediaProtocol.js'
import { parseProject, type MediaRef, type Project } from '../shared/project.js'
import { isAudioPrepared, openPreparedAudio, openStretchedAudio, prepareAudio, readAudio, readWaveform, stretchKey } from './audio.js'
import { startEncoder, type Encoder } from './encoder.js'
import type { FfmpegRunner } from './ffmpeg.js'
import { decodeFrame, openFrameStream, toArrayBuffer, type FrameStream, type VideoSource } from './frames.js'
import { isPreviewComplete, openPreviewCopy, type PreviewCopy } from './previewCopy.js'
import { ProbeError, probeMedia } from './probe.js'
import { withSavedPaths, writeProjectFile } from './projectFile.js'

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
  // The sound at other speeds, by speed and pitch setting.
  stretched: Map<string, Promise<FileHandle>>
  hasFailed: boolean
}

type OpenProject = {
  media: Map<string, MediaEntry>
  // Directory of the project file the media list came from; undefined for a project that was never saved.
  directory: string | undefined
  lifetime: AbortController
  prepared: Promise<void>
}

function emptyProject(): OpenProject {
  return { media: new Map(), directory: undefined, lifetime: new AbortController(), prepared: Promise.resolve() }
}

function preparationOf(entry: MediaEntry): Preparation {
  const { info, hasFailed } = entry
  if (info.kind === 'image') return { progress: 1, hasFailed }
  if (info.kind === 'audio') return { progress: isAudioPrepared(entry.directory) ? 1 : 0, hasFailed }
  if (isPreviewComplete(entry.directory)) return { progress: 1, hasFailed }
  const builtFrames = entry.preview?.frameCount() ?? 0
  return { progress: Math.min(1, builtFrames / info.video.frameCount), hasFailed }
}

function cacheKey(text: string): string {
  const digest = createHash('sha256').update(text).digest('hex')
  return digest.slice(0, CACHE_KEY_LENGTH)
}

function isMediaInfo(value: unknown): value is MediaInfo {
  if (typeof value !== 'object' || value === null || !('kind' in value)) return false
  // Animated images used to be described as stills; such a remembered answer is not used, so the file is looked at again.
  const isOutdatedAnimation = 'isAnimated' in value && value.isAnimated === true
  return typeof value.kind === 'string' && MEDIA_KINDS.includes(value.kind) && !isOutdatedAnimation
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
  private project = emptyProject()
  private saving: Promise<void> = Promise.resolve()
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
    const media = new Map<string, MediaEntry>()
    const states: Record<string, MediaState> = {}
    for (const reference of parsed.project.media) {
      const found = existingPath(reference, dirname(path))
      if (found === undefined) {
        states[reference.id] = { error: `"${fileNameOf(reference)}" was not found.`, isMissing: true }
        continue
      }
      try {
        const entry = await this.openFile(found)
        media.set(reference.id, entry)
        states[reference.id] = { info: entry.info }
      } catch (error) {
        if (!(error instanceof ProbeError) && !(error instanceof MediaError)) throw error
        states[reference.id] = { error: error.message, isMissing: false }
      }
    }

    const lifetime = new AbortController()
    const prepared = forPreview ? this.prepareInBackground([...media.values()], lifetime.signal) : Promise.resolve()
    this.project = { media, directory: dirname(path), lifetime, prepared }
    return { project: parsed.project, media: states }
  }

  async whenPrepared(): Promise<void> {
    await this.project.prepared
  }

  async addMedia(path: string): Promise<AddedMedia> {
    const project = this.project
    const id = randomUUID()
    const entry = await this.openFile(path)
    this.register(project, id, entry)
    return { id, info: entry.info }
  }

  // Puts the file the user pointed at in the place of unlinked media, then looks beside it for the other unlinked files by name.
  async relinkMedia(path: string, wanted: UnlinkedMedia, others: readonly UnlinkedMedia[]): Promise<RelinkedMedia[]> {
    const project = this.project
    const chosen = await this.openFile(path)
    const lacking = wanted.uses.find((use) => !offers(chosen.info, use))
    if (lacking !== undefined) {
      throw new MediaError(`"${basename(path)}" cannot take the place of "${fileNameOf(wanted.reference)}": the project uses that file for its ${lacking}.`)
    }
    this.register(project, wanted.reference.id, chosen)
    const relinked: RelinkedMedia[] = [{ id: wanted.reference.id, path, info: chosen.info }]

    for (const other of others) {
      const beside = join(dirname(path), fileNameOf(other.reference))
      if (project.media.has(other.reference.id) || !existsSync(beside)) continue
      try {
        const entry = await this.openFile(beside)
        if (!other.uses.every((use) => offers(entry.info, use))) continue
        this.register(project, other.reference.id, entry)
        relinked.push({ id: other.reference.id, path: beside, info: entry.info })
      } catch (error) {
        // A neighbour that cannot be read simply stays unlinked; the file that was asked for is relinked all the same.
        if (!(error instanceof ProbeError) && !(error instanceof MediaError)) throw error
        logError('A file beside the relinked one could not be used', error, { path: beside })
      }
    }
    return relinked
  }

  async preparation(): Promise<Record<string, Preparation>> {
    const states: Record<string, Preparation> = {}
    for (const [id, entry] of this.project.media) states[id] = preparationOf(entry)
    return states
  }

  async waveform(mediaId: string): Promise<WaveformLevel[] | undefined> {
    const entry = this.entryOf(mediaId)
    if (!isAudioPrepared(entry.directory)) return undefined
    return readWaveform(entry.directory)
  }

  // Saves run one at a time, so an autosave and a Save can never interleave their writes.
  saveProject(path: string, project: Project): Promise<void> {
    const resolvedPaths = new Map<string, string>()
    for (const [id, entry] of this.project.media) resolvedPaths.set(id, entry.path)
    const saved = withSavedPaths(project, { resolvedPaths, sourceDirectory: this.project.directory }, path)
    const done = this.saveAfter(this.saving, path, saved)
    this.saving = settled(done)
    return done
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

  async audio(mediaId: string, firstSample: number, sampleCount: number, stretch?: AudioStretch): Promise<Float32Array | undefined> {
    const entry = this.entryOf(mediaId)
    if (entry.info.kind === 'image' || entry.info.audio === undefined) return undefined
    const { signal } = this.project.lifetime
    const prepared = await this.preparedAudio(entry, signal)
    if (stretch === undefined) return readAudio(prepared, firstSample, sampleCount)
    return readAudio(await this.stretchedAudio(entry, stretch, signal), firstSample, sampleCount)
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
    this.project = emptyProject()
    project.lifetime.abort()
    for (const entry of project.media.values()) {
      await entry.preview?.close()
      if (entry.audio !== undefined) await closeWhenOpened(entry.audio)
      for (const stretched of entry.stretched.values()) await closeWhenOpened(stretched)
    }
  }

  private register(project: OpenProject, id: string, entry: MediaEntry): void {
    project.media.set(id, entry)
    project.prepared = this.prepareAfter(project.prepared, entry, project.lifetime.signal)
  }

  // The cache belongs to the media file, not to a project: an untitled project, Save As and a recovery file all reuse the same preview copy.
  private async openFile(path: string): Promise<MediaEntry> {
    let file: Stats
    try {
      file = await stat(path)
    } catch (error) {
      throw new MediaError(`"${basename(path)}" was not found.`, { cause: error })
    }
    const directory = join(this.cacheDirectory, cacheKey(`${path}\n${file.size}\n${file.mtimeMs}`))
    await mkdir(directory, { recursive: true })
    const info = await this.infoOf(path, directory)
    return { path, info, directory, preview: undefined, audio: undefined, stretched: new Map(), hasFailed: false }
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

  private async prepareAfter(earlier: Promise<void>, entry: MediaEntry, signal: AbortSignal): Promise<void> {
    await earlier
    await this.prepareInBackground([entry], signal)
  }

  private async saveAfter(earlier: Promise<void>, path: string, project: Project): Promise<void> {
    await earlier
    await writeProjectFile(path, project)
  }

  private async prepareInBackground(entries: readonly MediaEntry[], signal: AbortSignal): Promise<void> {
    for (const entry of entries) {
      if (signal.aborted) return
      if (entry.info.kind === 'image' || entry.info.audio === undefined) continue
      try {
        await this.preparedAudio(entry, signal)
      } catch (error) {
        if (signal.aborted) return
        entry.hasFailed = true
        logError('Could not prepare audio', error, { path: entry.path })
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
        if (signal.aborted) return
        entry.hasFailed = true
        logError('Could not prepare the preview copy', error, { path: entry.path })
      }
    }
  }

  private preparedAudio(entry: MediaEntry, signal: AbortSignal): Promise<FileHandle> {
    entry.audio ??= openAudio(this.ffmpeg, entry, signal)
    return entry.audio
  }

  // A copy that could not be made is asked for again the next time it is needed.
  private async stretchedAudio(entry: MediaEntry, stretch: AudioStretch, signal: AbortSignal): Promise<FileHandle> {
    const key = stretchKey(stretch)
    let opening = entry.stretched.get(key)
    if (opening === undefined) {
      opening = openStretchedAudio(this.ffmpeg, entry.directory, stretch, signal)
      entry.stretched.set(key, opening)
    }
    try {
      return await opening
    } catch (error) {
      entry.stretched.delete(key)
      throw error
    }
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
    const entry = this.project.media.get(mediaId)
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

function fileNameOf(reference: MediaRef): string {
  return basename(reference.path === '' ? reference.relativePath : reference.path)
}

// Where a project's media file is now: where it was, or where it is relative to the project file that may have moved with it.
function existingPath(reference: MediaRef, projectDirectory: string): string | undefined {
  const candidates: string[] = []
  if (reference.path !== '') candidates.push(reference.path)
  if (reference.relativePath !== '') candidates.push(resolve(projectDirectory, reference.relativePath))
  return candidates.find((candidate) => existsSync(candidate))
}

function offers(info: MediaInfo, use: MediaUse): boolean {
  if (use === 'video') return info.kind === 'video'
  if (use === 'image') return info.kind === 'image'
  return info.kind === 'audio' || (info.kind === 'video' && info.audio !== undefined)
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

// A failed save must not block the saves queued after it; its own caller still sees the failure.
async function settled(work: Promise<void>): Promise<void> {
  await Promise.allSettled([work])
}

async function closeWhenOpened(audio: Promise<FileHandle>): Promise<void> {
  const [opened] = await Promise.allSettled([audio])
  if (opened.status === 'fulfilled') await opened.value.close()
}
