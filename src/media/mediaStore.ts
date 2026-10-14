import { createHash, randomUUID } from 'node:crypto'
import { existsSync, type Stats } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { CACHE_SEGMENT_SECONDS, FRAME_DECODE_PIXEL_BUDGET, MAX_OPEN_STREAMS } from '../shared/limits.js'
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
  Wanted,
  WaveformLevel,
} from '../shared/mediaProtocol.js'
import { parseProject, type MediaRef, type Project } from '../shared/project.js'
import { WAVEFORM_FILE, audioSegmentPath, buildAudioRun, buildStretchedSegment, buildWaveform, readSegmentedAudio, readWaveform, stretchedLayout, tempoFilter, type AudioLayout } from './audio.js'
import type { DiskCache } from './cache.js'
import { startEncoder, type Encoder } from './encoder.js'
import type { FfmpegRunner } from './ffmpeg.js'
import { decodeFrame, decodeKeyframe, openFrameStream, toArrayBuffer, type FrameStream, type VideoSource } from './frames.js'
import { audioLayoutOf, planPreparation, previewLayoutOf, type PreparationJob } from './preparation.js'
import { buildPreviewRun, createPreviewReader, previewSegmentFiles, type PreviewReader, type SegmentInProgress } from './previewCopy.js'
import { ProbeError, probeMedia } from './probe.js'
import { withSavedPaths, writeProjectFile } from './projectFile.js'

const CACHE_KEY_LENGTH = 32
// After opening or seeking, the paused frame is asked for within this time; preparation waits so it does not start first.
const PREPARATION_GRACE_MS = 250
const INFO_FILE = 'info.json'
// A run decodes a few segments at most, so a new playhead position is taken up within seconds.
const PREVIEW_RUN_SEGMENTS = 4
const AUDIO_RUN_SEGMENTS = 4
// A media file whose preparation fails again after one retry is marked as broken; its clips show "media error" and the session goes on.
const ALLOWED_FAILURES = 1
// Beyond this share of the cache's limit only what is needed now is prepared.
const LATER_PREPARATION_SHARE = 0.8
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
  failures: number
  hasFailed: boolean
  // Segments past the end of the sound track, which read as silence.
  soundless: Set<string>
}

type OpenProject = {
  media: Map<string, MediaEntry>
  // Directory of the project file the media list came from; undefined for a project that was never saved.
  directory: string | undefined
  lifetime: AbortController
}

function emptyProject(): OpenProject {
  return { media: new Map(), directory: undefined, lifetime: new AbortController() }
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
  private readonly previews: PreviewReader
  private nextId = 1
  private wanted: Wanted | undefined
  // What to prepare, most urgent first; made again whenever the timeline, the playhead or the media change.
  private plan: PreparationJob[] = []
  private inProgress: SegmentInProgress | undefined
  private wake: (() => void) | undefined
  // The project the preparation loop works for; the loop ends with that project's lifetime.
  private preparing: OpenProject | undefined
  private preparedWaiters: (() => void)[] = []
  private isWaveformRunning = false

  constructor(
    private readonly ffmpeg: FfmpegRunner,
    private readonly cache: DiskCache,
    private readonly segmentSeconds = CACHE_SEGMENT_SECONDS,
  ) {
    this.previews = createPreviewReader(cache)
  }

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
    this.project = { media, directory: dirname(path), lifetime }
    this.wanted = undefined
    this.replan()
    if (forPreview) this.startPreparing(this.project)
    return { project: parsed.project, media: states }
  }

  // Resolves once everything the timeline needs now is prepared, or has failed.
  whenPrepared(): Promise<void> {
    if (this.isNearPrepared()) return Promise.resolve()
    return new Promise((resolve) => this.preparedWaiters.push(resolve))
  }

  async want(wanted: Wanted): Promise<void> {
    this.wanted = wanted
    this.replan()
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

  // How much of what the timeline needs now is prepared, per media file. The segment being written counts by its frames.
  async preparation(): Promise<Record<string, Preparation>> {
    const counts = new Map<string, { ready: number; total: number }>()
    for (const job of this.plan) {
      if (!countsAsPrepared(job)) continue
      const count = counts.get(job.mediaId) ?? { ready: 0, total: 0 }
      count.total += 1
      count.ready += this.readinessOf(job)
      counts.set(job.mediaId, count)
    }
    const states: Record<string, Preparation> = {}
    for (const [id, entry] of this.project.media) {
      const count = counts.get(id)
      const progress = count === undefined || count.total === 0 ? 1 : count.ready / count.total
      states[id] = { progress, hasFailed: entry.hasFailed }
    }
    return states
  }

  async waveform(mediaId: string): Promise<WaveformLevel[] | undefined> {
    const entry = this.entryOf(mediaId)
    const path = join(entry.directory, WAVEFORM_FILE)
    await this.cache.ready
    if (!this.cache.has(path)) return undefined
    this.cache.used(path)
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
    const entry = this.entryOf(mediaId)
    const layout = previewLayoutOf(entry.info, this.segmentSeconds)
    if (layout === undefined) return undefined
    const jpeg = await this.previews.read(entry.directory, layout, frame, this.inProgress)
    return jpeg === undefined ? undefined : toArrayBuffer(jpeg)
  }

  fullFrame(mediaId: string, frame: number, halvings: number, signal?: AbortSignal): Promise<RawFrame> {
    const source = this.videoSourceOf(mediaId)
    const pixelCount = source.video.width * source.video.height
    return this.frameDecodes.run(pixelCount, () => decodeFrame(this.ffmpeg, source, frame, halvings, signal))
  }

  // Outside the limit on full-quality decodes: a thumbnail must not hold back the paused frame.
  keyframeThumbnail(mediaId: string, frame: number, halvings: number): Promise<RawFrame> {
    return decodeKeyframe(this.ffmpeg, this.videoSourceOf(mediaId), frame, halvings)
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

  // Segments that are not prepared yet are made at once, and the answer waits for them.
  async audio(mediaId: string, firstSample: number, sampleCount: number, stretch?: AudioStretch): Promise<Float32Array | undefined> {
    const entry = this.entryOf(mediaId)
    const layout = audioLayoutOf(entry.info, this.segmentSeconds)
    if (layout === undefined) return undefined
    // The request comes from the window; a speed that cannot be played is refused before it becomes part of a file name.
    if (stretch !== undefined) tempoFilter(stretch)
    await this.cache.ready
    const { signal } = this.project.lifetime
    const segmentLayout = stretch === undefined ? layout : stretchedLayout(layout, stretch)
    return readSegmentedAudio(entry.directory, segmentLayout, firstSample, sampleCount, (segment) => this.ensureSound(entry, layout, segment, stretch, signal), stretch)
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
    this.inProgress = undefined
    this.wanted = undefined
    this.plan = []
    this.cache.protect(this, new Set())
    this.settleWaiters()
  }

  // A project that was never loaded, such as a new one, starts preparing with its first file.
  private register(project: OpenProject, id: string, entry: MediaEntry): void {
    project.media.set(id, entry)
    if (project !== this.project) return
    this.replan()
    this.startPreparing(project)
  }

  private startPreparing(project: OpenProject): void {
    if (this.preparing === project) return
    this.preparing = project
    void this.prepareInBackground(project.lifetime.signal)
  }

  // The cache belongs to the media file, not to a project: an untitled project, Save As and a recovery file all reuse the same preview copy.
  private async openFile(path: string): Promise<MediaEntry> {
    let file: Stats
    try {
      file = await stat(path)
    } catch (error) {
      throw new MediaError(`"${basename(path)}" was not found.`, { cause: error })
    }
    const directory = join(this.cache.directory, cacheKey(`${path}\n${file.size}\n${file.mtimeMs}`))
    await mkdir(directory, { recursive: true })
    const info = await this.infoOf(path, directory)
    return { path, info, directory, failures: 0, hasFailed: false, soundless: new Set() }
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
    await this.cache.added(infoPath)
    return info
  }

  private async saveAfter(earlier: Promise<void>, path: string, project: Project): Promise<void> {
    await earlier
    await writeProjectFile(path, project)
  }

  private replan(): void {
    const media = [...this.project.media.entries()].map(([id, entry]) => ({ id, info: entry.info }))
    this.plan = planPreparation(this.wanted, media, this.segmentSeconds)
    const needed = new Set<string>()
    for (const job of this.plan) {
      const path = this.jobPath(job)
      if (job.isNear && path !== undefined) needed.add(path)
    }
    for (const entry of this.project.media.values()) needed.add(join(entry.directory, INFO_FILE))
    this.cache.protect(this, needed)
    this.wake?.()
    this.settleWaiters()
  }

  private jobPath(job: PreparationJob): string | undefined {
    const entry = this.project.media.get(job.mediaId)
    if (entry === undefined) return undefined
    if (job.kind === 'waveform') return join(entry.directory, WAVEFORM_FILE)
    if (job.kind === 'picture') return previewSegmentFiles(entry.directory, job.segment).index
    return audioSegmentPath(entry.directory, job.segment, job.stretch)
  }

  private readinessOf(job: PreparationJob): number {
    const entry = this.project.media.get(job.mediaId)
    const path = this.jobPath(job)
    if (entry === undefined || path === undefined || entry.hasFailed || this.cache.has(path) || entry.soundless.has(path)) return 1
    const inProgress = this.inProgress
    const layout = previewLayoutOf(entry.info, this.segmentSeconds)
    const isBeingWritten = job.kind === 'picture' && inProgress?.directory === entry.directory && inProgress.segment === job.segment
    if (!isBeingWritten || layout === undefined) return 0
    return inProgress.locations.length / layout.framesPerSegment
  }

  private isNearPrepared(): boolean {
    for (const job of this.plan) {
      if (countsAsPrepared(job) && this.readinessOf(job) < 1) return false
    }
    return true
  }

  private settleWaiters(): void {
    if (this.preparedWaiters.length === 0) return
    const isClosed = this.project.media.size === 0
    if (!isClosed && !this.isNearPrepared()) return
    const waiters = this.preparedWaiters
    this.preparedWaiters = []
    for (const resolveWaiter of waiters) resolveWaiter()
  }

  private nextJob(): PreparationJob | undefined {
    const isFull = this.cache.totalBytes() >= this.cache.limitBytes() * LATER_PREPARATION_SHARE
    for (const job of this.plan) {
      // The plan holds what is needed now first; past it, a full cache stops preparation.
      if (!job.isNear && isFull) return undefined
      if (job.kind === 'waveform' && this.isWaveformRunning) continue
      const entry = this.project.media.get(job.mediaId)
      const path = this.jobPath(job)
      if (entry === undefined || entry.hasFailed || path === undefined) continue
      if (this.cache.has(path) || this.cache.pending(path) !== undefined || entry.soundless.has(path)) continue
      return job
    }
    return undefined
  }

  private untilWoken(signal: AbortSignal): Promise<void> {
    return new Promise((resolveWake) => {
      this.wake = resolveWake
      signal.addEventListener('abort', () => resolveWake(), { once: true })
    })
  }

  // One segment job at a time, most urgent first, with a waveform beside it; paused-frame decodes go before both.
  private async prepareInBackground(signal: AbortSignal): Promise<void> {
    await this.cache.ready
    let wasIdle = true
    while (!signal.aborted) {
      this.settleWaiters()
      const job = this.nextJob()
      if (job === undefined) {
        await this.untilWoken(signal)
        wasIdle = true
        continue
      }
      // The plan may change meanwhile, so the job is chosen again after the wait.
      if (wasIdle) {
        await sleep(PREPARATION_GRACE_MS)
        wasIdle = false
        continue
      }
      await this.frameDecodes.whenIdle()
      if (signal.aborted) return
      if (job.kind === 'waveform') {
        void this.runWaveform(job, signal)
        continue
      }
      await this.runJob(job, signal)
    }
  }

  // Waveforms are made one at a time beside the segments: one covers a whole file, and a long one must not hold back what the playhead needs.
  private async runWaveform(job: PreparationJob, signal: AbortSignal): Promise<void> {
    this.isWaveformRunning = true
    try {
      await this.runJob(job, signal)
    } finally {
      this.isWaveformRunning = false
      this.wake?.()
    }
  }

  private async runJob(job: PreparationJob, signal: AbortSignal): Promise<void> {
    const entry = this.project.media.get(job.mediaId)
    if (entry === undefined) return
    try {
      if (job.kind === 'waveform') {
        await this.buildWaveformOf(entry, signal)
      } else if (job.kind === 'picture') {
        await this.buildPreviewSegments(entry, job.segment, signal)
      } else {
        const layout = audioLayoutOf(entry.info, this.segmentSeconds)
        if (layout !== undefined) await this.ensureSound(entry, layout, job.segment, job.stretch, signal)
      }
    } catch (error) {
      if (signal.aborted) return
      entry.failures += 1
      entry.hasFailed = entry.failures > ALLOWED_FAILURES
      logError('Could not prepare media', error, { path: entry.path, job: job.kind })
    }
  }

  private async buildWaveformOf(entry: MediaEntry, signal: AbortSignal): Promise<void> {
    const path = join(entry.directory, WAVEFORM_FILE)
    const claim = this.cache.claim([path])
    if (claim.paths.length === 0) return
    try {
      await buildWaveform(this.ffmpeg, audioSource(entry), entry.directory, this.cache, signal)
      claim.written(path)
    } finally {
      claim.giveUp(new MediaError('The waveform was not made'))
    }
  }

  private async buildPreviewSegments(entry: MediaEntry, firstSegment: number, signal: AbortSignal): Promise<void> {
    const layout = previewLayoutOf(entry.info, this.segmentSeconds)
    if (layout === undefined) return
    const paths: string[] = []
    const end = Math.min(layout.segmentCount, firstSegment + PREVIEW_RUN_SEGMENTS)
    for (let segment = firstSegment; segment < end; segment++) {
      const index = previewSegmentFiles(entry.directory, segment).index
      if (this.cache.has(index) || this.cache.pending(index) !== undefined) break
      paths.push(index)
    }
    const claim = this.cache.claim(paths)
    await buildPreviewRun({
      ffmpeg: this.ffmpeg,
      source: videoSource(entry),
      directory: entry.directory,
      layout,
      cache: this.cache,
      firstSegment,
      claim,
      signal,
      onFrame: (inProgress) => {
        this.inProgress = inProgress
      },
    })
  }

  // Makes one segment of sound, or waits for the build already making it. A segment past the end of the sound stays missing and reads as silence.
  private async ensureSound(entry: MediaEntry, layout: AudioLayout, segment: number, stretch: AudioStretch | undefined, signal: AbortSignal): Promise<void> {
    const path = audioSegmentPath(entry.directory, segment, stretch)
    if (entry.soundless.has(path)) return
    if (this.cache.has(path)) {
      this.cache.used(path)
      return
    }
    const pending = this.cache.pending(path)
    if (pending !== undefined) {
      // A build that gave up is the business of whoever started it; this one tries again below.
      await Promise.allSettled([pending])
      if (this.cache.has(path)) return
    }
    if (stretch === undefined) {
      await this.buildBaseSound(entry, layout, segment, signal)
      return
    }
    await buildStretchedSegment({
      ffmpeg: this.ffmpeg,
      directory: entry.directory,
      layout: stretchedLayout(layout, stretch),
      cache: this.cache,
      stretch,
      segment,
      claim: this.cache.claim([path]),
      readBase: (firstSample, sampleCount) => readSegmentedAudio(entry.directory, layout, firstSample, sampleCount, (baseSegment) => this.ensureSound(entry, layout, baseSegment, undefined, signal)),
      signal,
    })
  }

  // A run from the segment on; a file that cannot seek exactly is decoded from its start, writing the missing segments on the way.
  private async buildBaseSound(entry: MediaEntry, layout: AudioLayout, segment: number, signal: AbortSignal): Promise<void> {
    const firstSegment = layout.seeksExactly ? segment : 0
    const lastSegment = Math.min(layout.segmentCount - 1, segment + AUDIO_RUN_SEGMENTS - 1)
    const paths: string[] = []
    for (let candidate = firstSegment; candidate <= lastSegment; candidate++) {
      const path = audioSegmentPath(entry.directory, candidate)
      const isMissing = !this.cache.has(path) && this.cache.pending(path) === undefined
      if (isMissing) paths.push(path)
      else if (layout.seeksExactly && candidate > segment) break
    }
    const claim = this.cache.claim(paths)
    const last = layout.seeksExactly ? segment + paths.length - 1 : lastSegment
    const soundless = await buildAudioRun({ ffmpeg: this.ffmpeg, source: audioSource(entry), directory: entry.directory, layout, cache: this.cache, firstSegment, lastSegment: last, claim, signal })
    for (const path of soundless) entry.soundless.add(path)
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

// A waveform is needed now, so it is kept and made even in a full cache, but it covers its whole file: a twenty-hour one takes minutes and is not needed to play what is around the playhead.
function countsAsPrepared(job: PreparationJob): boolean {
  return job.isNear && job.kind !== 'waveform'
}

function videoSource(entry: MediaEntry): VideoSource {
  if (entry.info.kind !== 'video') throw new MediaError(`"${basename(entry.path)}" is not a video`)
  return { path: entry.path, containerStart: entry.info.containerStart, video: entry.info.video }
}

function audioSource(entry: MediaEntry): { path: string; containerStart: number } {
  const containerStart = entry.info.kind === 'image' ? 0 : entry.info.containerStart
  return { path: entry.path, containerStart }
}

// A failed save must not block the saves queued after it; its own caller still sees the failure.
async function settled(work: Promise<void>): Promise<void> {
  await Promise.allSettled([work])
}
