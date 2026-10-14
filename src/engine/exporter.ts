import { DEFAULT_GIF_FRAME_RATE, exportSize, fitCanvas, hasMovingPicture, hasSound, pixelLayoutOf, type ExportFormat, type Size } from '../shared/exportPresets.js'
import type { ExportJob, ExportTarget, FramesJob, LoadedProject, MediaClient } from '../shared/mediaProtocol.js'
import { describeError } from '../shared/log.js'
import { projectDuration } from '../shared/project.js'
import { SAMPLE_RATE, TICKS_PER_SAMPLE, TICKS_PER_SECOND, frameDuration, timecode, type FrameRate } from '../shared/time.js'
import { viewAt } from './camera.js'
import type { Compositor } from './compositor.js'
import type { FrameProvider } from './frameProvider.js'
import { mix, type AudioReader } from './mixer.js'
import { resolveFrame } from './resolve.js'

const PROGRESS_STEPS = 200
const FRAME_NUMBER_DIGITS = 6

const SOUND_CHUNK_SAMPLES = SAMPLE_RATE
const MS_PER_SECOND = 1000
const NO_SOUND = new Float32Array(0)
const NO_PICTURE = new ArrayBuffer(0)
// Frames on their way to the encoder at once. One more hides the time each takes to cross to the media process; each holds a copy of a frame.
const WRITES_IN_FLIGHT = 2

class ExportError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ExportError'
  }
}

export type RenderContext = {
  loaded: LoadedProject
  media: MediaClient
  compositor: Compositor
  provider: FrameProvider
  readAudio: AudioReader
}

export type ProgressListener = (done: number, total: number) => void

export type JobSummary = Record<string, unknown>

type Quality = 'stream' | 'full'

type Stage = 'fetch' | 'render' | 'readback' | 'mix' | 'write'

// Where the time of an export goes, in milliseconds per stage.
type StageClock = {
  lap(stage: Stage): void
  totals(): Record<Stage, number>
}

function startStageClock(): StageClock {
  const totals: Record<Stage, number> = { fetch: 0, render: 0, readback: 0, mix: 0, write: 0 }
  let mark = performance.now()
  return {
    lap(stage) {
      const now = performance.now()
      totals[stage] += now - mark
      mark = now
    },
    totals: () => totals,
  }
}

// Draws the picture at a moment of project time into the compositor, ready to be read.
async function drawAt(context: RenderContext, time: number, output: Size, quality: Quality, clock?: StageClock): Promise<void> {
  const { project, media: states } = context.loaded
  const outputScale = fitCanvas(project.canvas, output).scale
  const view = viewAt(project.camera, time, project.canvas)
  const layers = resolveFrame(project, states, time, outputScale)
  const items = await context.provider.itemsFor(layers, quality, outputScale * view.largestScale)
  clock?.lap('fetch')
  context.compositor.render(project.canvas, output, view, items)
  context.provider.collect()
  clock?.lap('render')
}

function roundedTotals(clock: StageClock): Record<Stage, number> {
  const totals = clock.totals()
  return {
    fetch: Math.round(totals.fetch),
    render: Math.round(totals.render),
    readback: Math.round(totals.readback),
    mix: Math.round(totals.mix),
    write: Math.round(totals.write),
  }
}

// Hands an encoder all that `write` produces; on any failure the unfinished file is removed and the error says where on the timeline it stopped.
async function encode(context: RenderContext, target: ExportTarget, write: (jobId: number) => Promise<void>, reachedTime: () => number): Promise<void> {
  const jobId = await context.media.exportStart(target)
  try {
    await write(jobId)
    await context.media.exportFinish(jobId)
  } catch (error) {
    await context.media.exportCancel(jobId)
    // The place on the timeline tells which clip to look at.
    throw new ExportError(`The export stopped at ${timecode(reachedTime(), context.loaded.project.canvas.frameRate)}: ${describeError(error)}`, { cause: error })
  } finally {
    await context.provider.closeStreams()
  }
}

function targetOf(job: ExportJob, format: ExportFormat, output: Size, frameRate: FrameRate, hasAudio: boolean): ExportTarget {
  return { path: job.outputPath, format, encoder: job.encoder ?? 'x264', ...output, frameRate, quality: job.quality ?? 'high', hasAudio }
}

async function exportPictures(context: RenderContext, job: ExportJob, format: ExportFormat, onProgress: ProgressListener): Promise<JobSummary> {
  const { project, media: states } = context.loaded
  const output = exportSize(job.preset, project.canvas)
  const frameRate = job.frameRate ?? (format === 'gif' ? DEFAULT_GIF_FRAME_RATE : project.canvas.frameRate)
  const frameTicks = frameDuration(frameRate)
  const range = job.range ?? { start: 0, end: projectDuration(project) }
  const hasAudio = (job.hasAudio ?? true) && hasSound(format)
  const frameCount = Math.ceil((range.end - range.start) / frameTicks)
  if (frameCount <= 0) throw new ExportError('There is nothing on the timeline to export.')

  const progressInterval = Math.max(1, Math.round(frameCount / PROGRESS_STEPS))
  const layout = pixelLayoutOf(format)
  const clock = startStageClock()
  const startedAt = performance.now()
  let time = range.start
  await encode(
    context,
    targetOf(job, format, output, frameRate, hasAudio),
    async (jobId) => {
      // While a frame is copied out of the GPU the next one is fetched and drawn, and the encoder takes the frames before it meanwhile.
      // A write is copied as it is sent, so the pixels can be read into again at once.
      const writes: Promise<void>[] = []
      let drawn: { frame: number; time: number; pixels: () => Promise<ArrayBuffer> } | undefined

      async function send(frame: number, frameTime: number, pixels: () => Promise<ArrayBuffer>): Promise<void> {
        const firstSample = Math.ceil(frameTime / TICKS_PER_SAMPLE)
        const endSample = Math.ceil((frameTime + frameTicks) / TICKS_PER_SAMPLE)
        const audio = hasAudio ? await mix(project, states, firstSample, endSample - firstSample, context.readAudio) : NO_SOUND
        clock.lap('mix')
        const read = await pixels()
        clock.lap('readback')
        while (writes.length >= WRITES_IN_FLIGHT) await writes.shift()
        clock.lap('write')
        const writing = context.media.exportWrite(jobId, read, audio)
        // Its failure is seen when it is awaited, at a later frame or after the last.
        writing.catch(() => {})
        writes.push(writing)
        const isLast = frame === frameCount - 1
        if (isLast || frame % progressInterval === 0) onProgress(frame + 1, frameCount)
      }

      const outputScale = fitCanvas(project.canvas, output).scale
      for (let frame = 0; frame < frameCount; frame++) {
        time = range.start + frame * frameTicks
        await drawAt(context, time, output, 'stream', clock)
        if (frame + 1 < frameCount) context.provider.prefetchStreams(resolveFrame(project, states, time + frameTicks, outputScale))
        const pixels = context.compositor.startReadback(layout)
        if (drawn !== undefined) await send(drawn.frame, drawn.time, drawn.pixels)
        drawn = { frame, time, pixels }
      }
      if (drawn !== undefined) await send(drawn.frame, drawn.time, drawn.pixels)
      for (const writing of writes) await writing
      clock.lap('write')
    },
    () => time,
  )
  const elapsedSeconds = (performance.now() - startedAt) / MS_PER_SECOND
  const realTimeRatio = (range.end - range.start) / TICKS_PER_SECOND / elapsedSeconds
  return { path: job.outputPath, format, frames: frameCount, ...output, realTimeRatio: Number(realTimeRatio.toFixed(2)), stageMs: roundedTotals(clock) }
}

// Sound alone needs no pictures: the mix is made a second at a time.
async function exportSound(context: RenderContext, job: ExportJob, format: ExportFormat, onProgress: ProgressListener): Promise<JobSummary> {
  const { project, media: states } = context.loaded
  const range = job.range ?? { start: 0, end: projectDuration(project) }
  const firstSample = Math.ceil(range.start / TICKS_PER_SAMPLE)
  const endSample = Math.ceil(range.end / TICKS_PER_SAMPLE)
  const chunkCount = Math.ceil((endSample - firstSample) / SOUND_CHUNK_SAMPLES)
  if (chunkCount <= 0) throw new ExportError('There is nothing on the timeline to export.')

  let time = range.start
  await encode(
    context,
    targetOf(job, format, { width: 0, height: 0 }, project.canvas.frameRate, true),
    async (jobId) => {
      for (let chunk = 0; chunk < chunkCount; chunk++) {
        const chunkFirst = firstSample + chunk * SOUND_CHUNK_SAMPLES
        time = chunkFirst * TICKS_PER_SAMPLE
        const audio = await mix(project, states, chunkFirst, Math.min(SOUND_CHUNK_SAMPLES, endSample - chunkFirst), context.readAudio)
        await context.media.exportWrite(jobId, NO_PICTURE, audio)
        onProgress(chunk + 1, chunkCount)
      }
    },
    () => time,
  )
  return { path: job.outputPath, format, samples: endSample - firstSample }
}

// The picture at one frame, at the size of the project, made from the original files the way the paused preview is.
async function exportStill(context: RenderContext, job: ExportJob): Promise<JobSummary> {
  const { project } = context.loaded
  const output: Size = { width: project.canvas.width, height: project.canvas.height }
  const frame = job.frame ?? 0
  const time = frame * frameDuration(project.canvas.frameRate)
  await encode(
    context,
    targetOf(job, 'png', output, project.canvas.frameRate, false),
    async (jobId) => {
      await drawAt(context, time, output, 'full')
      await context.media.exportWrite(jobId, context.compositor.readPixels(), NO_SOUND)
    },
    () => time,
  )
  return { path: job.outputPath, format: 'png', frame, ...output }
}

export async function exportMedia(context: RenderContext, job: ExportJob, onProgress: ProgressListener): Promise<JobSummary> {
  const format = job.format ?? 'mp4'
  if (format === 'png') return exportStill(context, job)
  if (!hasMovingPicture(format)) return exportSound(context, job, format, onProgress)
  return exportPictures(context, job, format, onProgress)
}

export async function renderFrames(context: RenderContext, job: FramesJob): Promise<JobSummary> {
  const { project } = context.loaded
  const output: Size = job.size ?? { width: project.canvas.width, height: project.canvas.height }
  const frameTicks = frameDuration(project.canvas.frameRate)
  const quality = job.via === 'paused' ? 'full' : 'stream'
  const frames = [...job.frames].sort((a, b) => a - b)

  try {
    for (const frame of frames) {
      await drawAt(context, frame * frameTicks, output, quality)
      const name = `frame-${String(frame).padStart(FRAME_NUMBER_DIGITS, '0')}.rgba`
      await context.media.writeFile(job.outputDirectory, name, context.compositor.readPixels())
    }
  } finally {
    await context.provider.closeStreams()
  }
  return { directory: job.outputDirectory, frames, ...output }
}
