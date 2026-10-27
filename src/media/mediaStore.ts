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
  AnimationOverrides,
  Documents,
  LoadedAnimations,
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
import { isTimed } from '../shared/mediaProtocol.js'
import { MAX_ANIMATION_DEPTH, isAnimationPath, parseProject, type DocumentKind, type MediaRef, type Project } from '../shared/project.js'
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
import { withMediaIdsChanged } from '../editor/place.js'

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
  emptySegmentPaths: Set<string>
}

type OpenProject = {
  media: Map<string, MediaEntry>
  directory: string | undefined
  lifetime: AbortController
}

type MediaSource = {
  references: readonly MediaRef[]
  directory: string | undefined
}

type OpenedSources = {
  entries: Map<string, MediaEntry>
  states: Record<string, MediaState>
}

type DocumentTree = {
  documents: Record<string, Project>
  sources: MediaSource[]
}

function emptyProject(): OpenProject {
  return { media: new Map(), directory: undefined, lifetime: new AbortController() }
}

function cacheKey(text: string): string {
  const digest = createHash('sha256').update(text).digest('hex')
  return digest.slice(0, CACHE_KEY_LENGTH)
}

async function readDocument(path: string, kind: DocumentKind, readFrom = path): Promise<Project> {
  let text: string
  try {
    text = await readFile(readFrom, 'utf8')
  } catch (error) {
    throw new MediaError(`"${basename(path)}" could not be opened: ${describeError(error)}`, { cause: error })
  }
  const parsed = parseProject(text, kind)
  if (parsed.ok) return parsed.project
  throw new MediaError(kind === 'project' ? parsed.message : `"${basename(path)}" cannot be used: ${parsed.message}`)
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

  async loadProject(path: string, forPreview: boolean, animationOverrides: AnimationOverrides = {}): Promise<LoadedProject> {
    const project = await readDocument(path, 'project')
    const episode: MediaSource = { references: project.media, directory: dirname(path) }
    const tree = await readDocumentTree(animationPathsOf(episode), mediaPathsOf(episode), animationOverrides)
    const media = await this.open([episode, ...tree.sources], path, forPreview)
    return { project, media, documents: tree.documents }
  }

  openMedia(media: readonly MediaRef[], projectPath: string | undefined): Promise<Record<string, MediaState>> {
    return this.open([{ references: media, directory: projectPath === undefined ? undefined : dirname(projectPath) }], projectPath, true)
  }

  async loadAnimations(paths: readonly string[]): Promise<LoadedAnimations> {
    const project = this.project
    const knownPaths = new Map<string, string>()
    for (const [id, entry] of project.media) knownPaths.set(id, entry.path)
    const tree = await readDocumentTree(paths, knownPaths, {})
    const media = await this.openMore(project, tree.sources)
    return { documents: tree.documents, media }
  }

  reopenAnimations(documents: Documents): Promise<Record<string, MediaState>> {
    const sources = Object.entries(documents).map(([path, document]) => ({ references: document.media, directory: dirname(path) }))
    return this.openMore(this.project, sources)
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
    this.register(project, new Map([[id, entry]]))
    return { id, info: entry.info, createdAt: entry.createdAt }
  }

  async relinkMedia(path: string, wanted: UnlinkedMedia, others: readonly UnlinkedMedia[]): Promise<RelinkedMedia[]> {
    const project = this.project
    const chosen = await this.openFile(path)
    const lacking = wanted.uses.find((use) => !offers(chosen.info, use))
    if (lacking !== undefined) {
      throw new MediaError(`"${basename(path)}" cannot take the place of "${fileNameOf(wanted.reference)}": the project uses that file for its ${lacking}.`)
    }
    this.register(project, new Map([[wanted.reference.id, chosen]]))
    const relinked: RelinkedMedia[] = [{ id: wanted.reference.id, path, info: chosen.info, createdAt: chosen.createdAt }]

    for (const other of others) {
      const beside = join(dirname(path), fileNameOf(other.reference))
      if (project.media.has(other.reference.id) || !existsSync(beside)) continue
      try {
        const entry = await this.openFile(beside)
        if (!other.uses.every((use) => offers(entry.info, use))) continue
        this.register(project, new Map([[other.reference.id, entry]]))
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
      let variant: string
      if (job.kind === 'picture') variant = `${job.cadence?.step}:${job.cadence?.phase}`
      else variant = JSON.stringify(job.stretch)
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

  saveProject(path: string, project: Project, animationPath?: string): Promise<void> {
    const resolvedPaths = new Map<string, string>()
    for (const [id, entry] of this.project.media) resolvedPaths.set(id, entry.path)
    const sourceDirectory = animationPath === undefined ? this.project.directory : dirname(animationPath)
    const saved = withSavedPaths(project, { resolvedPaths, sourceDirectory }, path)
    const done = this.saveAfter(this.saving, path, saved, animationPath === undefined ? 'project' : 'animation')
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
    if (stretch !== undefined) tempoFilter(stretch)
    await this.cache.ready
    const { signal } = this.project.lifetime
    const segmentLayout = stretch === undefined ? layout : stretchedLayout(layout, stretch)
    return readSegmentedAudio(
      entry.directory,
      segmentLayout,
      firstSample,
      sampleCount,
      (segment) => this.ensureSound(entry, layout, segment, stretch, signal),
      stretch,
    )
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

  private async open(sources: readonly MediaSource[], projectPath: string | undefined, forPreview: boolean): Promise<Record<string, MediaState>> {
    await this.closeProject()
    const directory = projectPath === undefined ? undefined : dirname(projectPath)
    const { entries: media, states } = await this.openSources(sources, new Map())
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
      if (error instanceof ProbeError || error instanceof MediaError) return { state: { error: error.message, isMissing: false } }
      logError('Could not open a media file', error, { path: found })
      return { state: { error: describeError(error), isMissing: false } }
    }
  }

  private async openSources(sources: readonly MediaSource[], alreadyOpen: ReadonlyMap<string, MediaEntry>): Promise<OpenedSources> {
    const states: Record<string, MediaState> = {}
    const wanted = new Map<string, { reference: MediaRef; directory: string | undefined }>()
    for (const source of sources) {
      for (const reference of source.references) {
        const entry = alreadyOpen.get(reference.id)
        if (entry !== undefined) states[reference.id] = { info: entry.info, createdAt: entry.createdAt }
        else if (!wanted.has(reference.id)) wanted.set(reference.id, { reference, directory: source.directory })
      }
    }
    const items = [...wanted.values()]
    const opened = await Promise.all(items.map((item) => this.openReference(item.reference, item.directory)))
    const entries = new Map<string, MediaEntry>()
    for (const [index, item] of items.entries()) {
      const result = opened[index]
      if (result === undefined) continue
      states[item.reference.id] = result.state
      if (result.entry !== undefined) entries.set(item.reference.id, result.entry)
    }
    return { entries, states }
  }

  private async openMore(project: OpenProject, sources: readonly MediaSource[]): Promise<Record<string, MediaState>> {
    const opened = await this.openSources(sources, project.media)
    this.register(project, opened.entries)
    return opened.states
  }

  private register(project: OpenProject, entries: ReadonlyMap<string, MediaEntry>): void {
    for (const [id, entry] of entries) project.media.set(id, entry)
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
    // Until the cache has scanned what earlier runs left, a folder made here could be removed as an empty leftover.
    await this.cache.ready
    let file: Stats
    try {
      file = await stat(path)
    } catch (error) {
      throw new MediaError(`"${basename(path)}" was not found.`, { cause: error })
    }
    // A disk without creation times reports 0.
    const createdAt = file.birthtimeMs > 0 ? file.birthtimeMs : file.mtimeMs
    if (isAnimationPath(path)) {
      await readDocument(path, 'animation')
      return { path, info: { kind: 'animation', path }, createdAt, directory: '', failures: 0, hasFailed: false, emptySegmentPaths: new Set() }
    }
    const directory = join(this.cache.directory, cacheKey(`${path}\n${file.size}\n${file.mtimeMs}`))
    await mkdir(directory, { recursive: true })
    const info = await this.infoOf(path, directory)
    return { path, info, createdAt, directory, failures: 0, hasFailed: false, emptySegmentPaths: new Set() }
  }

  private async infoOf(path: string, directory: string): Promise<MediaInfo> {
    const infoPath = join(directory, INFO_FILE)
    const cached = await readCachedInfo(infoPath)
    if (cached !== undefined) return cached
    const info = await this.probes.run(1, () => probeMedia(this.ffmpeg, path))
    await writeFile(infoPath, JSON.stringify(info))
    await this.cache.added(infoPath)
    return info
  }

  private async saveAfter(earlier: Promise<void>, path: string, project: Project, kind: DocumentKind): Promise<void> {
    await earlier
    await writeProjectFile(path, project, kind)
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
    if (entry === undefined || path === undefined || entry.hasFailed) return 1
    const isReady = this.cache.has(path) || entry.emptySegmentPaths.has(path)
    if (isReady) return 1
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
      const isMadeOrMaking = this.cache.has(path) || this.cache.pending(path) !== undefined || entry.emptySegmentPaths.has(path)
      if (isMadeOrMaking) continue
      return job
    }
    return undefined
  }

  private untilWoken(signal: AbortSignal): Promise<void> {
    return new Promise((resolveWake) => {
      const woken = (): void => {
        signal.removeEventListener('abort', woken)
        resolveWake()
      }
      this.wake = woken
      signal.addEventListener('abort', woken, { once: true })
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
    let threads = 0
    if (this.settings().backgroundCores === 'half') threads = Math.max(1, Math.ceil(availableParallelism() / 2))
    const emptySegmentPaths = await buildPreviewRun({
      ffmpeg: this.ffmpeg,
      source: videoSource(entry),
      directory: entry.directory,
      layout,
      cache: this.cache,
      firstSegment,
      claim,
      threads,
      signal,
      onFrame: (inProgress) => {
        this.inProgress = inProgress
      },
    })
    // A source shorter than its header says has no pictures for its last segments; otherwise they would be decoded again without end.
    for (const path of emptySegmentPaths) entry.emptySegmentPaths.add(path)
  }

  private async ensureSound(entry: MediaEntry, layout: AudioLayout, segment: number, stretch: AudioStretch | undefined, signal: AbortSignal): Promise<void> {
    const path = audioSegmentPath(entry.directory, segment, stretch)
    if (entry.emptySegmentPaths.has(path)) return
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
    const ensureBaseSegment = (baseSegment: number): Promise<void> => this.ensureSound(entry, layout, baseSegment, undefined, signal)
    await buildStretchedSegment({
      ffmpeg: this.ffmpeg,
      directory: entry.directory,
      layout: stretchedLayout(layout, stretch),
      cache: this.cache,
      stretch,
      segment,
      claim: this.cache.claim([path]),
      readBase: (firstSample, sampleCount) => readSegmentedAudio(entry.directory, layout, firstSample, sampleCount, ensureBaseSegment),
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
    const emptySegmentPaths = await buildAudioRun({
      ffmpeg: this.ffmpeg,
      source: audioSource(entry),
      directory: entry.directory,
      layout,
      cache: this.cache,
      firstSegment,
      lastSegment: last,
      claim,
      signal,
    })
    for (const path of emptySegmentPaths) entry.emptySegmentPaths.add(path)
  }

  private suspendIdleStreams(): void {
    const excess = this.streams.size - MAX_OPEN_STREAMS
    let suspended = 0
    for (const stream of this.streams.values()) {
      if (suspended >= excess) return
      if (stream.isReading()) continue
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

function referencePath(reference: MediaRef, directory: string | undefined): string {
  const found = existingPath(reference, directory)
  if (found !== undefined) return found
  if (reference.path !== '' || directory === undefined) return reference.path
  return resolve(directory, reference.relativePath)
}

function mediaPathsOf(source: MediaSource): Map<string, string> {
  return new Map(source.references.map((reference) => [reference.id, referencePath(reference, source.directory)]))
}

function animationPathsOf(source: MediaSource): string[] {
  const paths: string[] = []
  for (const reference of source.references) {
    const found = existingPath(reference, source.directory)
    if (found !== undefined && isAnimationPath(found)) paths.push(found)
  }
  return paths
}

// Ids only collide in copied files; a copy keeps its ids for the same files, so only other files get new ones.
function withUniqueMediaIds(document: Project, directory: string, knownPaths: Map<string, string>): Project {
  const renamed = new Map<string, string>()
  for (const reference of document.media) {
    const path = referencePath(reference, directory)
    const known = knownPaths.get(reference.id)
    if (known === undefined) {
      knownPaths.set(reference.id, path)
    } else if (known !== path) {
      const id = randomUUID()
      renamed.set(reference.id, id)
      knownPaths.set(id, path)
    }
  }
  return withMediaIdsChanged(document, renamed)
}

async function readAnimationDocument(path: string, override: string | undefined): Promise<Project | undefined> {
  try {
    const document = await readDocument(path, 'animation', override)
    if (override === undefined) return document
    // A copy's relative paths start from the copy's folder; everything else reads them from the real file's folder.
    return withSavedPaths(document, { resolvedPaths: new Map(), sourceDirectory: dirname(override) }, path)
  } catch (error) {
    // The clips of a file that cannot be read show why through its media state, which opening the file reports.
    if (error instanceof MediaError) return undefined
    throw error
  }
}

async function readDocumentTree(startPaths: readonly string[], knownPaths: Map<string, string>, overrides: AnimationOverrides): Promise<DocumentTree> {
  const documents: Record<string, Project> = {}
  const sources: MediaSource[] = []
  let level = [...new Set(startPaths)]
  for (let depth = 0; depth < MAX_ANIMATION_DEPTH && level.length > 0; depth += 1) {
    const unread = level.filter((path) => documents[path] === undefined)
    const read = await Promise.all(unread.map((path) => readAnimationDocument(path, overrides[path])))
    const next: string[] = []
    for (const [index, path] of unread.entries()) {
      const document = read[index]
      if (document === undefined) continue
      const source: MediaSource = { references: document.media, directory: dirname(path) }
      const unique = withUniqueMediaIds(document, dirname(path), knownPaths)
      documents[path] = unique
      sources.push({ ...source, references: unique.media })
      next.push(...animationPathsOf(source))
    }
    level = [...new Set(next)]
  }
  return { documents, sources }
}

function offers(info: MediaInfo, use: MediaUse): boolean {
  if (use === 'video') return info.kind === 'video'
  if (use === 'image') return info.kind === 'image'
  if (use === 'animation') return info.kind === 'animation'
  return info.kind === 'audio' || (info.kind === 'video' && info.audio !== undefined)
}

async function readCachedInfo(infoPath: string): Promise<MediaInfo | undefined> {
  if (!existsSync(infoPath)) return undefined
  const cachedText = await readFile(infoPath, 'utf8')
  let cached: unknown
  try {
    cached = JSON.parse(cachedText)
  } catch (error) {
    logError('Ignoring an unreadable media info cache', error, { infoPath })
  }
  if (!isMediaInfo(cached)) return undefined
  const now = new Date()
  utimes(infoPath, now, now).catch((error: unknown) => logError('Could not mark a media info cache as used', error, { infoPath }))
  return cached
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
  const containerStart = isTimed(entry.info) ? entry.info.containerStart : 0
  return { path: entry.path, containerStart }
}

async function settled(work: Promise<void>): Promise<void> {
  await Promise.allSettled([work])
}
