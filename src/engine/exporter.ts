// Rendering a whole project, or chosen frames of it, without a window: the same resolver,
// compositor and mixer as the preview, fed from the original files.
import { exportSize, fitCanvas, type Size } from '../shared/exportPresets.js'
import type { ExportJob, FramesJob, LoadedProject, MediaClient } from '../shared/mediaProtocol.js'
import { projectDuration } from '../shared/project.js'
import { TICKS_PER_SAMPLE, frameDuration } from '../shared/time.js'
import type { Compositor } from './compositor.js'
import type { FrameProvider } from './frameProvider.js'
import { mix, type AudioReader } from './mixer.js'
import { resolveFrame } from './resolve.js'

/** Progress is reported about this many times over a whole export. */
const PROGRESS_STEPS = 200
const FRAME_NUMBER_DIGITS = 6

export class ExportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExportError'
  }
}

/** What a render needs: the loaded project and the engine parts that draw and mix it. */
export type RenderContext = {
  loaded: LoadedProject
  media: MediaClient
  compositor: Compositor
  provider: FrameProvider
  readAudio: AudioReader
}

export type ProgressListener = (done: number, total: number) => void

export type JobSummary = Record<string, unknown>

/** Renders the whole timeline to an MP4 file at the size of the job's preset. */
export async function exportMp4(context: RenderContext, job: ExportJob, onProgress: ProgressListener): Promise<JobSummary> {
  const { project, media: states } = context.loaded
  const output = exportSize(job.preset, project.canvas)
  const outputScale = fitCanvas(project.canvas, output).scale
  const frameTicks = frameDuration(project.canvas.frameRate)
  const frameCount = Math.ceil(projectDuration(project) / frameTicks)
  if (frameCount === 0) throw new ExportError('There is nothing on the timeline to export.')

  const progressInterval = Math.max(1, Math.round(frameCount / PROGRESS_STEPS))
  const jobId = await context.media.exportStart({ path: job.outputPath, ...output, frameRate: project.canvas.frameRate })
  try {
    for (let frame = 0; frame < frameCount; frame++) {
      const time = frame * frameTicks
      const layers = resolveFrame(project, states, time, outputScale)
      const items = await context.provider.itemsFor(layers, 'stream', outputScale)
      context.compositor.render(project.canvas, output, items)
      context.provider.collect()

      // Each frame carries the samples that start inside it; together they cover the timeline exactly once.
      const firstSample = Math.ceil(time / TICKS_PER_SAMPLE)
      const endSample = Math.ceil((time + frameTicks) / TICKS_PER_SAMPLE)
      const audio = await mix(project, states, firstSample, endSample - firstSample, context.readAudio)
      await context.media.exportWrite(jobId, context.compositor.readPixels(), audio)

      const isLast = frame === frameCount - 1
      if (isLast || frame % progressInterval === 0) onProgress(frame + 1, frameCount)
    }
    await context.media.exportFinish(jobId)
  } catch (error) {
    await context.media.exportCancel(jobId)
    throw error
  } finally {
    await context.provider.closeStreams()
  }
  return { path: job.outputPath, frames: frameCount, ...output }
}

/**
 * Renders single frames and writes each as raw RGBA, top row first. `via` chooses whether the
 * originals are read by seeking (as a paused preview does) or in order (as an export does).
 */
export async function renderFrames(context: RenderContext, job: FramesJob): Promise<JobSummary> {
  const { project, media: states } = context.loaded
  const output: Size = job.size ?? { width: project.canvas.width, height: project.canvas.height }
  const outputScale = fitCanvas(project.canvas, output).scale
  const frameTicks = frameDuration(project.canvas.frameRate)
  const quality = job.via === 'paused' ? 'full' : 'stream'
  // A sequential decoder can only move forwards.
  const frames = [...job.frames].sort((a, b) => a - b)

  try {
    for (const frame of frames) {
      const layers = resolveFrame(project, states, frame * frameTicks, outputScale)
      const items = await context.provider.itemsFor(layers, quality, outputScale)
      context.compositor.render(project.canvas, output, items)
      context.provider.collect()
      const name = `frame-${String(frame).padStart(FRAME_NUMBER_DIGITS, '0')}.rgba`
      await context.media.writeFile(job.outputDirectory, name, context.compositor.readPixels())
    }
  } finally {
    await context.provider.closeStreams()
  }
  return { directory: job.outputDirectory, frames, ...output }
}
