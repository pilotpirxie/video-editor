import { fitCanvas, type Size } from '../shared/exportPresets.js'
import { AUDIO_CACHE_BYTES, AUDIO_QUEUE_SECONDS, READ_AHEAD_FRAMES } from '../shared/limits.js'
import { describeError } from '../shared/log.js'
import type { ExportJob, FramesJob, LoadedProject, MediaClient } from '../shared/mediaProtocol.js'
import { projectDuration, type Canvas } from '../shared/project.js'
import { SAMPLE_RATE, TICKS_PER_SAMPLE, frameAt, frameDuration } from '../shared/time.js'
import { viewAt, wholeCanvas, type View } from './camera.js'
import { createPlaybackClock, type PlaybackClock } from './clock.js'
import { CompositorError, createCompositor, type DrawItem } from './compositor.js'
import { exportMp4, renderFrames, type JobSummary, type ProgressListener, type RenderContext } from './exporter.js'
import { createFrameProvider } from './frameProvider.js'
import { cachedAudioReader, mix } from './mixer.js'
import { resolveFrame, type Layer } from './resolve.js'

const AUDIO_BLOCK_SAMPLES = 2048

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
  | { type: 'error'; message: string }

type OutputCommand = { type: 'start' } | { type: 'samples'; samples: Float32Array } | { type: 'stop' }
type OutputReport = { type: 'consumed'; samples: number }

export type Engine = {
  load(projectPath: string, forPreview: boolean): Promise<void>
  setProject(project: LoadedProject): void
  setOutputSize(size: Size): void
  // While the zoom tool is used, the paused picture shows the whole canvas, so any part of it can be framed. Playing always goes through the camera.
  showWholeCanvasWhenPaused(isShown: boolean): void
  attachAudio(port: MessagePort): void
  seek(time: number): void
  play(outputLatencySeconds: number): void
  pause(): void
  exportMp4(job: ExportJob, onProgress: ProgressListener): Promise<JobSummary>
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
  return typeof value === 'object' && value !== null && 'type' in value && value.type === 'consumed' && 'samples' in value && typeof value.samples === 'number'
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
  const compositor = createCompositor(gl)
  const provider = createFrameProvider(media, compositor)
  const readAudio = cachedAudioReader((mediaId, firstSample, sampleCount, stretch) => media.audio(mediaId, firstSample, sampleCount, stretch), AUDIO_CACHE_BYTES)

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
    compositor.render(project.project.canvas, output, view, items)
    compositor.present()
    provider.collect()
  }

  // Text is drawn for the largest size the camera's move reaches, so a zoom does not draw it anew on every frame.
  function textScale(project: LoadedProject, view: View): number {
    return outputScale(project) * view.largestScale
  }

  function emitPosition(fullQualityMs: number | undefined): void {
    emit({ type: 'position', time, isPlaying: playback !== undefined, droppedFrames, fullQualityMs })
  }

  async function showPaused(): Promise<void> {
    const project = loaded
    if (project === undefined) return
    generation += 1
    const shown = generation
    const layers = layersAt(project, time)
    const { canvas, camera } = project.project
    const view = isWholeCanvasShownWhenPaused ? wholeCanvas(canvas) : viewAt(camera, time, canvas)
    const scale = textScale(project, view)
    // An edit that needs the same source frames keeps the running decodes: aborting them on every drag frame would never let a slow decode finish.
    const needed = decodesNeeded(layers)
    if (refining === undefined || refining.signal.aborted || needed !== refiningFor) {
      refining?.abort()
      refining = new AbortController()
      refiningFor = needed
    }
    const controller = refining
    const startedAt = performance.now()
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
    }
  }

  async function fillAudioQueue(project: LoadedProject, playing: Playback): Promise<void> {
    if (playing.isMixing) return
    playing.isMixing = true
    try {
      const queueTarget = AUDIO_QUEUE_SECONDS * SAMPLE_RATE
      while (playback === playing && playing.mixedUntil - (playing.startSample + playing.consumedSamples) < queueTarget) {
        const samples = await mix(project.project, project.media, playing.mixedUntil, AUDIO_BLOCK_SAMPLES, readAudio)
        if (playback !== playing) return
        const command: OutputCommand = { type: 'samples', samples }
        audioPort?.postMessage(command, [samples.buffer])
        playing.mixedUntil += AUDIO_BLOCK_SAMPLES
      }
    } catch (error) {
      emit({ type: 'error', message: describeError(error) })
    } finally {
      playing.isMixing = false
    }
  }

  function cameraAt(project: LoadedProject, frameTime: number): View {
    return viewAt(project.project.camera, frameTime, project.project.canvas)
  }

  async function prepareAhead(project: LoadedProject, frame: number, frameTicks: number): Promise<void> {
    const loads: Promise<void>[] = []
    for (let ahead = 0; ahead <= READ_AHEAD_FRAMES; ahead++) {
      const frameTime = (frame + ahead) * frameTicks
      loads.push(provider.prepare(layersAt(project, frameTime), textScale(project, cameraAt(project, frameTime))))
    }
    await Promise.all(loads)
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
      const skipped = playing.drawnFrame === undefined ? 0 : frame - playing.drawnFrame - 1
      const view = cameraAt(project, frame * frameTicks)
      const { items, lateLayers } = provider.itemsNow(layersAt(project, frame * frameTicks), textScale(project, view))
      droppedFrames += Math.max(0, skipped) + (lateLayers > 0 ? 1 : 0)
      playing.drawnFrame = frame
      time = frame * frameTicks
      draw(project, view, items)
      emitPosition(undefined)
    }
    void prepareAhead(project, frame + 1, frameTicks)
    requestAnimationFrame(() => tick(project, playing))
  }

  function stopPlayback(): void {
    if (playback === undefined) return
    playback = undefined
    const command: OutputCommand = { type: 'stop' }
    audioPort?.postMessage(command)
  }

  async function startPlayback(project: LoadedProject, playing: Playback, frameTicks: number): Promise<void> {
    await prepareAhead(project, frameAt(time, frameTicks), frameTicks)
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

  function showWholeCanvasWhenPaused(isShown: boolean): void {
    if (isShown === isWholeCanvasShownWhenPaused) return
    isWholeCanvasShownWhenPaused = isShown
    if (playback === undefined) void showPaused()
  }

  // The playback loop holds the project it started with, so an edit pauses instead of swapping the project under it.
  function setProject(project: LoadedProject): void {
    stopPlayback()
    loaded = project
    time = frameStartNear(project, time)
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
    seek,
    play,
    pause,
    exportMp4: (job, onProgress) => exportMp4(renderContext(), job, onProgress),
    renderFrames: (job) => renderFrames(renderContext(), job),
  }
}
