import { exportSize, fitCanvas, type Size } from '../shared/exportPresets.js'
import type { ExportJob, FramesJob, LoadedProject, MediaClient } from '../shared/mediaProtocol.js'
import { projectDuration } from '../shared/project.js'
import { TICKS_PER_SAMPLE, frameDuration } from '../shared/time.js'
import type { Compositor } from './compositor.js'
import type { FrameProvider } from './frameProvider.js'
import { mix, type AudioReader } from './mixer.js'
import { resolveFrame } from './resolve.js'

const PROGRESS_STEPS = 200
const FRAME_NUMBER_DIGITS = 6

class ExportError extends Error {
  constructor(message: string) {
    super(message)
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

export async function renderFrames(context: RenderContext, job: FramesJob): Promise<JobSummary> {
  const { project, media: states } = context.loaded
  const output: Size = job.size ?? { width: project.canvas.width, height: project.canvas.height }
  const outputScale = fitCanvas(project.canvas, output).scale
  const frameTicks = frameDuration(project.canvas.frameRate)
  const quality = job.via === 'paused' ? 'full' : 'stream'
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
