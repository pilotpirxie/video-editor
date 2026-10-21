import { createHash, randomUUID } from 'node:crypto'
import { existsSync, type Stats } from 'node:fs'
import { mkdir, readFile, stat, utimes, writeFile } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { CACHE_SEGMENT_SECONDS, FRAME_DECODE_PIXEL_BUDGET, MAX_OPEN_STREAMS } from '../shared/limits.js'
import { describeError, logError } from '../shared/log.js'
import type {
  AddedMedia,
  AudioStretch,
  CacheUsage,
  Cadence,
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
import { DEFAULT_SETTINGS, mediaSettingsOf, type MediaSettings } from '../shared/settings.js'
import { WAVEFORM_FILE, audioSegmentPath, buildAudioRun, buildStretchedSegment, buildWaveform, readSegmentedAudio, readWaveform, stretchedLayout, tempoFilter, type AudioLayout } from './audio.js'
import type { DiskCache } from './cache.js'
import { startEncoder, type Encoder } from './encoder.js'
import type { FfmpegRunner } from './ffmpeg.js'
import { decodeFrame, decodeKeyframe, openFrameStream, toArrayBuffer, type FrameStream, type VideoSource } from './frames.js'
import { audioLayoutOf, planPreparation, previewLayoutOf, type PreparationJob } from './preparation.js'
import { buildPreviewRun, createPreviewReader, previewSegmentFiles, type PreviewLayout, type PreviewReader, type SegmentInProgress } from './previewCopy.js'
import { ProbeError, probeMedia } from './probe.js'
import { withSavedPaths, writeProjectFile } from './projectFile.js'

const CACHE_KEY_LENGTH = 32
const PREPARATION_GRACE_MS = 250
const INFO_FILE = 'info.json'
const PREVIEW_RUN_SEGMENTS = 4
const AUDIO_RUN_SEGMENTS = 4
const MAX_PREPARATION_RETRIES = 1
const LATER_PREPARATION_CACHE_SHARE = 0.8
const MEDIA_KINDS = ['video', 'audio', 'image']
const PROBES_AT_ONCE = 4

export class MediaError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'MediaError'
  }
}

type MediaEntry = {
  path: string
  info: MediaInfo
  createdAt: number
  directory: string
  failures: number
  hasFailed: boolean
  silentSegmentPaths: Set<string>
}

type OpenProject = {
  media: Map<string, MediaEntry>
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
  private readonly probes = createWeightLimiter(PROBES_AT_ONCE)
  private readonly previews: PreviewReader
  private nextId = 1
  private wanted: Wanted | undefined
  private plan: PreparationJob[] = []
  private cadences = new Map<string, Cadence[]>()
  private inProgress: SegmentInProgress | undefined
  private wake: (() => void) | undefined
  private preparing: OpenProject | undefined
  private preparedWaiters: (() => void)[] = []
  private isWaveformRunning = false

  constructor(
    private readonly ffmpeg: FfmpegRunner,
    private readonly cache: DiskCache,
    private readonly segmentSeconds = CACHE_SEGMENT_SECONDS,
    private readonly settings: () => MediaSettings = () => mediaSettingsOf(DEFAULT_SETTINGS),
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
    const media = await this.open(parsed.project.media, path, forPreview)
    return { project: parsed.project, media }
  }

  openMedia(media: readonly MediaRef[], projectPath: string | undefined): Promise<Record<string, MediaState>> {
    return this.open(media, projectPath, true)
  }

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
    return { id, info: entry.info, createdAt: entry.createdAt }
  }

  async relinkMedia(path: string, wanted: UnlinkedMedia, others: readonly UnlinkedMedia[]): Promise<RelinkedMedia[]> {
    const project = this.project
    const chosen = await this.openFile(path)
    const lacking = wanted.uses.find((use) => !offers(chosen.info, use))
    if (lacking !== undefined) {
      throw new MediaError(`"${basename(path)}" cannot take the place of "${fileNameOf(wanted.reference)}": the project uses that file for its ${lacking}.`)
    }
    this.register(project, wanted.reference.id, chosen)
    const relinked: RelinkedMedia[] = [{ id: wanted.reference.id, path, info: chosen.info, createdAt: chosen.createdAt }]

    for (const other of others) {
      const beside = join(dirname(path), fileNameOf(other.reference))
      if (project.media.has(other.reference.id) || !existsSync(beside)) continue
      try {
        const entry = await this.openFile(beside)
        if (!other.uses.every((use) => offers(entry.info, use))) continue
        this.register(project, other.reference.id, entry)
        relinked.push({ id: other.reference.id, path: beside, info: entry.info, createdAt: entry.createdAt })
      } catch (error) {
        if (!(error instanceof ProbeError) && !(error instanceof MediaError)) throw error
        logError('A file beside the relinked one could not be used', error, { path: beside })
      }
    }
    return relinked
  }

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

  async cacheUsage(): Promise<CacheUsage> {
    let freeBytes = 0
    try {
      freeBytes = await this.cache.freeBytes()
    } catch (error) {
      logError('Could not read the free space of the cache disk', error, { directory: this.cache.directory })
    }
    return { usedBytes: this.cache.totalBytes(), limitBytes: this.cache.limitBytes(), neededBytes: this.neededBytes(), freeBytes }
  }

  async clearCache(): Promise<void> {
    await this.cache.clear()
    this.replan()
  }

  settingsChanged(): void {
    this.replan()
  }

  private neededBytes(): number {
    const kinds = new Map<string, { madeBytes: number; made: number; missing: number }>()
    for (const job of this.plan) {
      if (job.kind === 'waveform') continue
      const path = this.jobPath(job)
      if (path === undefined) continue
      const variant = job.kind === 'picture' ? `${job.cadence?.step}:${job.cadence?.phase}` : JSON.stringify(job.stretch)
      const key = `${job.kind}:${job.mediaId}:${variant}`
      const kind = kinds.get(key) ?? { madeBytes: 0, made: 0, missing: 0 }
      const bytes = this.cache.bytesOf(path)
      if (bytes === undefined) {
        kind.missing += 1
      } else {
        kind.madeBytes += bytes
        kind.made += 1
      }
      kinds.set(key, kind)
    }
    let needed = 0
    for (const kind of kinds.values()) {
      if (kind.made > 0) needed += kind.madeBytes + (kind.missing * kind.madeBytes) / kind.made
    }
    return Math.round(needed)
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
    for (const cadence of this.cadences.get(mediaId) ?? []) {
      const sparse = this.layoutOf(entry, cadence)
      if (sparse === undefined) continue
      const jpeg = await this.previews.read(entry.directory, sparse, frame, this.inProgress)
      if (jpeg !== undefined) return toArrayBuffer(jpeg)
    }
    const layout = this.layoutOf(entry, undefined)
    if (layout === undefined) return undefined
    const jpeg = await this.previews.read(entry.directory, layout, frame, this.inProgress)
    return jpeg === undefined ? undefined : toArrayBuffer(jpeg)
  }

  fullFrame(mediaId: string, frame: number, halvings: number, signal?: AbortSignal): Promise<RawFrame> {
    const source = this.videoSourceOf(mediaId)
    const pixelCount = source.video.width * source.video.height
    return this.frameDecodes.run(pixelCount, () => decodeFrame(this.ffmpeg, source, frame, halvings, signal))
  }

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

  private async open(references: readonly MediaRef[], projectPath: string | undefined, forPreview: boolean): Promise<Record<string, MediaState>> {
    await this.closeProject()
    const directory = projectPath === undefined ? undefined : dirname(projectPath)
    const opened = await Promise.all(references.map((reference) => this.openReference(reference, directory)))
    const media = new Map<string, MediaEntry>()
    const states: Record<string, MediaState> = {}
    for (const [index, reference] of references.entries()) {
      const result = opened[index]
      if (result === undefined) continue
      states[reference.id] = result.state
      if (result.entry !== undefined) media.set(reference.id, result.entry)
    }

    const lifetime = new AbortController()
    this.project = { media, directory, lifetime }
    this.wanted = undefined
    this.replan()
    if (forPreview) this.startPreparing(this.project)
    return states
  }

  private async openReference(reference: MediaRef, directory: string | undefined): Promise<{ state: MediaState; entry?: MediaEntry }> {
    const found = existingPath(reference, directory)
    if (found === undefined) return { state: { error: `"${fileNameOf(reference)}" was not found.`, isMissing: true } }
    try {
      const entry = await this.openFile(found)
      return { state: { info: entry.info, createdAt: entry.createdAt }, entry }
    } catch (error) {
      if (!(error instanceof ProbeError) && !(error instanceof MediaError)) throw error
      return { state: { error: error.message, isMissing: false } }
    }
  }

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

  private async openFile(path: string): Promise<MediaEntry> {
    // Until the cache has looked at what earlier runs left, a folder made here could be taken for an empty one and removed.
    await this.cache.ready
    let file: Stats
    try {
      file = await stat(path)
    } catch (error) {
      throw new MediaError(`"${basename(path)}" was not found.`, { cause: error })
    }
    const directory = join(this.cache.directory, cacheKey(`${path}\n${file.size}\n${file.mtimeMs}`))
    await mkdir(directory, { recursive: true })
    const info = await this.infoOf(path, directory)
    // A disk that keeps no creation time reports 0; the time of the last change stands in for it.
    const createdAt = file.birthtimeMs > 0 ? file.birthtimeMs : file.mtimeMs
    return { path, info, createdAt, directory, failures: 0, hasFailed: false, silentSegmentPaths: new Set() }
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
      if (isMediaInfo(cached)) {
        const now = new Date()
        utimes(infoPath, now, now).catch((error: unknown) => logError('Could not mark a media info cache as used', error, { infoPath }))
        return cached
      }
    }
    const info = await this.probes.run(1, () => probeMedia(this.ffmpeg, path))
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
    this.cadences = cadencesOf(this.wanted)
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
    if (job.kind === 'picture') {
      const layout = this.layoutOf(entry, job.cadence)
      return layout === undefined ? undefined : previewSegmentFiles(entry.directory, job.segment, layout).index
    }
    return audioSegmentPath(entry.directory, job.segment, job.stretch)
  }

  private layoutOf(entry: MediaEntry, cadence: Cadence | undefined): PreviewLayout | undefined {
    return previewLayoutOf(entry.info, this.segmentSeconds, cadence, this.settings().previewLongSide)
  }

  private readinessOf(job: PreparationJob): number {
    const entry = this.project.media.get(job.mediaId)
    const path = this.jobPath(job)
    if (entry === undefined || path === undefined || entry.hasFailed || this.cache.has(path) || entry.silentSegmentPaths.has(path)) return 1
    const inProgress = this.inProgress
    const layout = this.layoutOf(entry, undefined)
    const isBeingWritten = job.kind === 'picture' && inProgress?.index === path
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
    const isFull = this.cache.totalBytes() >= this.cache.limitBytes() * LATER_PREPARATION_CACHE_SHARE
    for (const job of this.plan) {
      if (!job.isNear && isFull) return undefined
      if (job.kind === 'waveform' && this.isWaveformRunning) continue
      const entry = this.project.media.get(job.mediaId)
      const path = this.jobPath(job)
      if (entry === undefined || entry.hasFailed || path === undefined) continue
      if (this.cache.has(path) || this.cache.pending(path) !== undefined || entry.silentSegmentPaths.has(path)) continue
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
        await this.buildPreviewSegments(entry, job.segment, job.cadence, signal)
      } else {
        const layout = audioLayoutOf(entry.info, this.segmentSeconds)
        if (layout !== undefined) await this.ensureSound(entry, layout, job.segment, job.stretch, signal)
      }
    } catch (error) {
      if (signal.aborted) return
      entry.failures += 1
      entry.hasFailed = entry.failures > MAX_PREPARATION_RETRIES
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

  private async buildPreviewSegments(entry: MediaEntry, firstSegment: number, cadence: Cadence | undefined, signal: AbortSignal): Promise<void> {
    const layout = this.layoutOf(entry, cadence)
    if (layout === undefined) return
    const paths: string[] = []
    const end = Math.min(layout.segmentCount, firstSegment + PREVIEW_RUN_SEGMENTS)
    for (let segment = firstSegment; segment < end; segment++) {
      const index = previewSegmentFiles(entry.directory, segment, layout).index
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
      threads: this.settings().backgroundCores === 'half' ? Math.max(1, Math.ceil(availableParallelism() / 2)) : 0,
      signal,
      onFrame: (inProgress) => {
        this.inProgress = inProgress
      },
    })
  }

  private async ensureSound(entry: MediaEntry, layout: AudioLayout, segment: number, stretch: AudioStretch | undefined, signal: AbortSignal): Promise<void> {
    const path = audioSegmentPath(entry.directory, segment, stretch)
    if (entry.silentSegmentPaths.has(path)) return
    if (this.cache.has(path)) {
      this.cache.used(path)
      return
    }
    const pending = this.cache.pending(path)
    if (pending !== undefined) {
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
    const silentSegmentPaths = await buildAudioRun({ ffmpeg: this.ffmpeg, source: audioSource(entry), directory: entry.directory, layout, cache: this.cache, firstSegment, lastSegment: last, claim, signal })
    for (const path of silentSegmentPaths) entry.silentSegmentPaths.add(path)
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

function existingPath(reference: MediaRef, projectDirectory: string | undefined): string | undefined {
  const candidates: string[] = []
  if (reference.path !== '') candidates.push(reference.path)
  if (reference.relativePath !== '' && projectDirectory !== undefined) candidates.push(resolve(projectDirectory, reference.relativePath))
  return candidates.find((candidate) => existsSync(candidate))
}

function offers(info: MediaInfo, use: MediaUse): boolean {
  if (use === 'video') return info.kind === 'video'
  if (use === 'image') return info.kind === 'image'
  return info.kind === 'audio' || (info.kind === 'video' && info.audio !== undefined)
}

function cadencesOf(wanted: Wanted | undefined): Map<string, Cadence[]> {
  const byMedia = new Map<string, Cadence[]>()
  for (const range of wanted?.ranges ?? []) {
    const { cadence } = range
    if (cadence === undefined) continue
    const known = byMedia.get(range.mediaId) ?? []
    const isKnown = known.some((other) => other.step === cadence.step && other.phase === cadence.phase)
    if (!isKnown) known.push(cadence)
    byMedia.set(range.mediaId, known)
  }
  return byMedia
}

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
