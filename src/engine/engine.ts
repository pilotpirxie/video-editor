import { fitCanvas, type Size } from '../shared/exportPresets.js'
import { AUDIO_CACHE_BYTES, AUDIO_QUEUE_SECONDS, READ_AHEAD_FRAMES, UNDER_PRESSURE_SHARE } from '../shared/limits.js'
import { describeError } from '../shared/log.js'
import type { ExportJob, FramesJob, LoadedProject, MediaClient } from '../shared/mediaProtocol.js'
import { projectDuration, type Canvas } from '../shared/project.js'
import { SAMPLE_RATE, TICKS_PER_SAMPLE, TICKS_PER_SECOND, frameAt, frameDuration } from '../shared/time.js'
import { viewAt, wholeCanvas, type View } from './camera.js'
import { createPlaybackClock, type PlaybackClock } from './clock.js'
import { CompositorError, createCompositor, type DrawItem } from './compositor.js'
import { exportMedia, renderFrames, type JobSummary, type ProgressListener, type RenderContext } from './exporter.js'
import { createFrameProvider } from './frameProvider.js'
import { cachedAudioReader, mix, soundRanges, type AudioReader } from './mixer.js'
import { pictureRanges, resolveFrame, type Layer } from './resolve.js'

const AUDIO_BLOCK_SAMPLES = 2048
const WANT_AGAIN_AFTER_TICKS = 10 * TICKS_PER_SECOND
const WANT_INTERVAL_MS = 500
const START_WAIT_MS = 1000
const START_RETRY_MS = 50

function decodesNeeded(layers: readonly Layer[]): string {
  const decodes: string[] = []
  for (const layer of layers) {
    if (layer.kind === 'video') decodes.push(`${layer.mediaId}:${layer.frame}:${layer.halvings}`)
  }
  return decodes.join(' ')
}

export type EngineEvent =
  | { type: 'loaded'; duration: number; canvas: Canvas; problems: string[] }
  | { type: 'position'; time: number; isPlaying: boolean; droppedFrames: number; fullQualityMs: number | undefined }
  | { type: 'prepared' }
  | { type: 'wanted' }
  | { type: 'preview-lost' }
  | { type: 'preview-restored' }
  | { type: 'error'; message: string }

type OutputCommand = { type: 'start' } | { type: 'samples'; samples: Float32Array } | { type: 'stop' }
type OutputReport = { type: 'consumed'; samples: number }

export type Engine = {
  load(projectPath: string, forPreview: boolean): Promise<void>
  setProject(project: LoadedProject): void
  setOutputSize(size: Size): void
  showWholeCanvasWhenPaused(isShown: boolean): void
  attachAudio(port: MessagePort): void
  setUnderPressure(isUnderPressure: boolean): void
  seek(time: number): void
  play(outputLatencySeconds: number): void
  pause(): void
  exportMedia(job: ExportJob, onProgress: ProgressListener): Promise<JobSummary>
  renderFrames(job: FramesJob): Promise<JobSummary>
}

type Playback = {
  clock: PlaybackClock
  startSample: number
  mixedUntil: number
  consumedSamples: number
  isMixing: boolean
  drawnFrame: number | undefined
}

function isOutputReport(value: unknown): value is OutputReport {
  if (typeof value !== 'object' || value === null) return false
  if (!('type' in value) || value.type !== 'consumed') return false
  return 'samples' in value && typeof value.samples === 'number'
}

class EngineError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EngineError'
  }
}

export function createEngine(media: MediaClient, surface: OffscreenCanvas, emit: (event: EngineEvent) => void): Engine {
  const gl = surface.getContext('webgl2', { alpha: false, antialias: false, premultipliedAlpha: true })
  if (gl === null) throw new CompositorError('WebGL2 is not available on this machine')
  let compositor = createCompositor(gl)
  let provider = createFrameProvider(media, compositor)
  const readFromMedia: AudioReader = (mediaId, firstSample, sampleCount, stretch) => media.audio(mediaId, firstSample, sampleCount, stretch)
  let readAudio = cachedAudioReader(readFromMedia, AUDIO_CACHE_BYTES)
  let isUnderPressure = false
  let isContextLost = false
  let pausedRenders = 0

  let loaded: LoadedProject | undefined
  let output: Size = { width: surface.width, height: surface.height }
  let time = 0
  let generation = 0
  let refining: AbortController | undefined
  let refiningFor = ''
  let audioPort: MessagePort | undefined
  let playback: Playback | undefined
  let outputLatency = 0
  let droppedFrames = 0
  let isWholeCanvasShownWhenPaused = false
  let wantedFor: LoadedProject | undefined
  let wantedAt: number | undefined
  let wantSentAt = -Infinity
  let wantTimer: ReturnType<typeof setTimeout> | undefined

  function requireLoaded(): LoadedProject {
    if (loaded === undefined) throw new EngineError('No project is loaded')
    return loaded
  }

  function outputScale(project: LoadedProject): number {
    return fitCanvas(project.project.canvas, output).scale
  }

  function layersAt(project: LoadedProject, frameTime: number): Layer[] {
    return resolveFrame(project.project, project.media, frameTime, outputScale(project))
  }

  function draw(project: LoadedProject, view: View, items: readonly DrawItem[]): void {
    if (isContextLost) return
    compositor.render(project.project.canvas, output, view, items)
    compositor.present()
    provider.collect()
  }

  function textScale(project: LoadedProject, view: View): number {
    return outputScale(project) * view.largestScale
  }

  async function sendWanted(): Promise<void> {
    clearTimeout(wantTimer)
    wantTimer = undefined
    const project = loaded
    if (project === undefined) return
    wantedFor = project
    wantedAt = time
    wantSentAt = performance.now()
    const ranges = [...pictureRanges(project.project, project.media), ...soundRanges(project.project, project.media)]
    try {
      await media.want({ playhead: time, ranges })
    } catch (error) {
      emit({ type: 'error', message: describeError(error) })
      return
    }
    emit({ type: 'wanted' })
  }

  function updateWanted(): void {
    if (loaded === undefined || wantTimer !== undefined) return
    const hasMovedFar = wantedAt === undefined || Math.abs(time - wantedAt) >= WANT_AGAIN_AFTER_TICKS
    if (wantedFor === loaded && !hasMovedFar) return
    const wait = Math.max(0, wantSentAt + WANT_INTERVAL_MS - performance.now())
    wantTimer = setTimeout(() => void sendWanted(), wait)
  }

  function emitPosition(fullQualityMs: number | undefined): void {
    emit({ type: 'position', time, isPlaying: playback !== undefined, droppedFrames, fullQualityMs })
  }

  async function showPaused(): Promise<void> {
    const project = loaded
    if (project === undefined || isContextLost) return
    generation += 1
    const shown = generation
    const layers = layersAt(project, time)
    const { canvas, camera } = project.project
    const view = isWholeCanvasShownWhenPaused ? wholeCanvas(canvas) : viewAt(camera, time, canvas)
    const scale = textScale(project, view)
    const needed = decodesNeeded(layers)
    if (refining === undefined || refining.signal.aborted || needed !== refiningFor) {
      refining?.abort()
      refining = new AbortController()
      refiningFor = needed
    }
    const controller = refining
    const startedAt = performance.now()
    pausedRenders += 1
    try {
      const quick = await provider.itemsFor(layers, 'preview', scale, controller.signal)
      if (shown !== generation) return
      draw(project, view, quick)
      emitPosition(undefined)

      const exact = await provider.itemsFor(layers, 'full', scale, controller.signal)
      if (shown !== generation) return
      draw(project, view, exact)
      emitPosition(performance.now() - startedAt)
    } catch (error) {
      if (controller.signal.aborted) return
      emit({ type: 'error', message: describeError(error) })
    } finally {
      pausedRenders -= 1
    }
  }

  async function fillAudioQueue(project: LoadedProject, playing: Playback): Promise<void> {
    if (playing.isMixing) return
    playing.isMixing = true
    try {
      const queueTarget = AUDIO_QUEUE_SECONDS * SAMPLE_RATE
      while (playback === playing) {
        const queuedSamples = playing.mixedUntil - (playing.startSample + playing.consumedSamples)
        if (queuedSamples >= queueTarget) break
        const samples = await mix(project.project, project.media, playing.mixedUntil, AUDIO_BLOCK_SAMPLES, readAudio)
        if (playback !== playing) return
        const command: OutputCommand = { type: 'samples', samples }
        audioPort?.postMessage(command, [samples.buffer])
        playing.mixedUntil += AUDIO_BLOCK_SAMPLES
      }
    } catch (error) {
      if (playback === playing) pause()
      emit({ type: 'error', message: describeError(error) })
    } finally {
      playing.isMixing = false
    }
  }

  function cameraAt(project: LoadedProject, frameTime: number): View {
    return viewAt(project.project.camera, frameTime, project.project.canvas)
  }

  // Nearest frame first, and only as far as the cache holds, so reading ahead never pushes out the frame about to be shown.
  async function prepareAhead(project: LoadedProject, frame: number, frameTicks: number): Promise<boolean> {
    let isReady = true
    for (let ahead = 0; ahead <= READ_AHEAD_FRAMES; ahead++) {
      if (ahead > 0 && !provider.hasRoomAhead()) break
      const frameTime = (frame + ahead) * frameTicks
      const layers = layersAt(project, frameTime)
      const scale = textScale(project, cameraAt(project, frameTime))
      if (ahead === 0) provider.keepNextFrame(layers, scale)
      const isFrameReady = await provider.prepare(layers, scale)
      isReady = isReady && isFrameReady
    }
    return isReady
  }

  function tick(project: LoadedProject, playing: Playback): void {
    if (playback !== playing) return
    const frameTicks = frameDuration(project.project.canvas.frameRate)
    const position = playing.clock.positionAt(performance.now())
    if (position >= projectDuration(project.project)) {
      pause()
      return
    }

    const frame = frameAt(position, frameTicks)
    if (frame !== playing.drawnFrame) {
      try {
        drawPlaying(project, playing, frame, frameTicks)
      } catch (error) {
        pause()
        emit({ type: 'error', message: describeError(error) })
        return
      }
      void prepareAhead(project, frame + 1, frameTicks)
    }
    requestAnimationFrame(() => tick(project, playing))
  }

  function drawPlaying(project: LoadedProject, playing: Playback, frame: number, frameTicks: number): void {
    const skipped = playing.drawnFrame === undefined ? 0 : frame - playing.drawnFrame - 1
    const view = cameraAt(project, frame * frameTicks)
    const layers = layersAt(project, frame * frameTicks)
    const { items, lateLayers } = provider.itemsNow(layers, textScale(project, view))
    droppedFrames += Math.max(0, skipped)
    if (lateLayers > 0) droppedFrames += 1
    playing.drawnFrame = frame
    time = frame * frameTicks
    draw(project, view, items)
    emitPosition(undefined)
    updateWanted()
  }

  function stopPlayback(): void {
    if (playback === undefined) return
    playback = undefined
    provider.keepNextFrame([], 0)
    const command: OutputCommand = { type: 'stop' }
    audioPort?.postMessage(command)
  }

  async function startPlayback(project: LoadedProject, playing: Playback, frameTicks: number): Promise<void> {
    const startFrame = frameAt(time, frameTicks)
    const waitUntil = performance.now() + START_WAIT_MS
    // Right after a project opens, the playback copies of its first frames may still be in the making.
    let isReady = await prepareAhead(project, startFrame, frameTicks)
    while (!isReady && playback === playing && performance.now() < waitUntil) {
      await new Promise((resolve) => setTimeout(resolve, START_RETRY_MS))
      isReady = await prepareAhead(project, startFrame, frameTicks)
    }
    if (playback !== playing) return
    const command: OutputCommand = { type: 'start' }
    audioPort?.postMessage(command)
    void fillAudioQueue(project, playing)
    requestAnimationFrame(() => tick(project, playing))
  }

  function play(outputLatencySeconds: number): void {
    const project = loaded
    if (project === undefined || playback !== undefined || audioPort === undefined) return
    outputLatency = outputLatencySeconds
    const frameTicks = frameDuration(project.project.canvas.frameRate)
    if (time + frameTicks >= projectDuration(project.project)) time = 0

    generation += 1
    refining?.abort()
    const startSample = Math.ceil(time / TICKS_PER_SAMPLE)
    const playing: Playback = {
      clock: createPlaybackClock(startSample, Math.round(outputLatencySeconds * SAMPLE_RATE)),
      startSample,
      mixedUntil: startSample,
      consumedSamples: 0,
      isMixing: false,
      drawnFrame: undefined,
    }
    playback = playing
    droppedFrames = 0
    emitPosition(undefined)
    void startPlayback(project, playing, frameTicks)
  }

  function pause(): void {
    stopPlayback()
    void showPaused()
  }

  function frameStartNear(project: LoadedProject, target: number): number {
    const frameTicks = frameDuration(project.project.canvas.frameRate)
    const lastFrame = Math.max(0, Math.ceil(projectDuration(project.project) / frameTicks) - 1)
    const frame = Math.min(Math.max(frameAt(target, frameTicks), 0), lastFrame)
    return frame * frameTicks
  }

  function seek(target: number): void {
    const project = loaded
    if (project === undefined) return
    const wasPlaying = playback !== undefined
    stopPlayback()
    time = frameStartNear(project, target)
    updateWanted()
    if (wasPlaying) {
      play(outputLatency)
    } else {
      void showPaused()
    }
  }

  function attachAudio(port: MessagePort): void {
    audioPort = port
    port.onmessage = (event: MessageEvent<unknown>): void => {
      const playing = playback
      const project = loaded
      if (playing === undefined || project === undefined || !isOutputReport(event.data)) return
      playing.consumedSamples = event.data.samples
      playing.clock.report(event.data.samples, performance.now())
      void fillAudioQueue(project, playing)
    }
  }

  function setOutputSize(size: Size): void {
    const width = Math.max(1, Math.round(size.width))
    const height = Math.max(1, Math.round(size.height))
    if (width === output.width && height === output.height) return
    output = { width, height }
    surface.width = width
    surface.height = height
    if (playback === undefined) void showPaused()
  }

  function setUnderPressure(isNowUnderPressure: boolean): void {
    if (isNowUnderPressure === isUnderPressure) return
    isUnderPressure = isNowUnderPressure
    const share = isUnderPressure ? UNDER_PRESSURE_SHARE : 1
    provider.setCacheShare(share)
    if (playback === undefined && pausedRenders === 0) provider.collect()
    readAudio = cachedAudioReader(readFromMedia, AUDIO_CACHE_BYTES * share)
  }

  surface.addEventListener('webglcontextlost', (event) => {
    event.preventDefault()
    isContextLost = true
    stopPlayback()
    generation += 1
    refining?.abort()
    emitPosition(undefined)
    emit({ type: 'preview-lost' })
  })
  surface.addEventListener('webglcontextrestored', () => {
    compositor = createCompositor(gl)
    provider = createFrameProvider(media, compositor)
    provider.setCacheShare(isUnderPressure ? UNDER_PRESSURE_SHARE : 1)
    isContextLost = false
    emit({ type: 'preview-restored' })
    emitPosition(undefined)
    void showPaused()
  })

  function showWholeCanvasWhenPaused(isShown: boolean): void {
    if (isShown === isWholeCanvasShownWhenPaused) return
    isWholeCanvasShownWhenPaused = isShown
    if (playback === undefined) void showPaused()
  }

  function setProject(project: LoadedProject): void {
    stopPlayback()
    loaded = project
    time = frameStartNear(project, time)
    updateWanted()
    void showPaused()
  }

  async function load(projectPath: string, forPreview: boolean): Promise<void> {
    stopPlayback()
    generation += 1
    refining?.abort()
    loaded = undefined
    provider.clear()
    const project = await media.loadProject(projectPath, forPreview)
    loaded = project
    time = 0

    const problems: string[] = []
    for (const state of Object.values(project.media)) {
      if ('error' in state) problems.push(state.error)
    }
    emit({ type: 'loaded', duration: projectDuration(project.project), canvas: project.project.canvas, problems })
    if (!forPreview) return
    void sendWanted()
    void announcePrepared(project)
    await showPaused()
  }

  async function announcePrepared(project: LoadedProject): Promise<void> {
    try {
      await media.whenPrepared()
    } catch (error) {
      emit({ type: 'error', message: describeError(error) })
      return
    }
    if (loaded === project) emit({ type: 'prepared' })
  }

  function renderContext(): RenderContext {
    return { loaded: requireLoaded(), media, compositor, provider, readAudio }
  }

  return {
    load,
    setProject,
    setOutputSize,
    showWholeCanvasWhenPaused,
    attachAudio,
    setUnderPressure,
    seek,
    play,
    pause,
    exportMedia: (job, onProgress) => exportMedia(renderContext(), job, onProgress),
    renderFrames: (job) => renderFrames(renderContext(), job),
  }
}
