import {
  DEFAULT_GIF_FRAME_RATE,
  EXPORT_PRESETS,
  GIF_FRAME_RATES,
  hasMovingPicture,
  hasSound,
  isExportEncoder,
  isExportFormat,
  isExportPreset,
  isExportQuality,
  shortSideOf,
  type ExportEncoder,
  type ExportFormat,
  type ExportPreset,
  type ExportQuality,
  type Size,
} from '../shared/exportPresets.js'
import type { ExportJob, TimeRange } from '../shared/mediaProtocol.js'
import type { Project } from '../shared/project.js'
import { PROJECT_FRAME_RATES, type FrameRate } from '../shared/time.js'
import { endOf } from './clips.js'

const SMALLEST_PRESET: ExportPreset = '120p'
const MS_PER_SECOND = 1000
const SECONDS_PER_MINUTE = 60
const MINUTES_PER_HOUR = 60
// An estimate made from the first moments of an export swings wildly, so none is given until this much is done.
const STEADY_AFTER_MS = 3000
const STEADY_AFTER_FRACTION = 0.02

// What the export dialog lets the user choose.
export type ExportChoices = {
  format: ExportFormat
  preset: ExportPreset
  frameRate: FrameRate
  quality: ExportQuality
  encoder: ExportEncoder
  isSelectionOnly: boolean
  hasAudio: boolean
}

// The choices worth keeping for the next export. Frame rate and range belong to one project and one moment, so they start fresh each time.
export type RememberedChoices = Partial<Pick<ExportChoices, 'format' | 'preset' | 'quality' | 'encoder' | 'hasAudio'>>

function framesPerSecond(rate: FrameRate): number {
  return rate.num / rate.den
}

// Every frame rate a format can hold, fastest first. A rate above the project's still moves keyframes, the camera and transitions more smoothly.
export function exportFrameRates(format: ExportFormat): FrameRate[] {
  const rates = format === 'gif' ? GIF_FRAME_RATES : PROJECT_FRAME_RATES
  return [...rates].sort((a, b) => framesPerSecond(b) - framesPerSecond(a))
}

function isSameRate(a: FrameRate, b: FrameRate): boolean {
  return a.num === b.num && a.den === b.den
}

// Another format keeps the frame rate when it can hold it; otherwise it starts from its own default.
export function withFormat(choices: ExportChoices, format: ExportFormat, projectRate: FrameRate): ExportChoices {
  const canKeepRate = exportFrameRates(format).some((rate) => isSameRate(rate, choices.frameRate))
  if (canKeepRate) return { ...choices, format }
  return { ...choices, format, frameRate: format === 'gif' ? DEFAULT_GIF_FRAME_RATE : projectRate }
}

// The largest size that keeps the shape of the canvas without enlarging it.
export function defaultPreset(canvas: Size): ExportPreset {
  const canvasShortSide = Math.min(canvas.width, canvas.height)
  let largest = SMALLEST_PRESET
  for (const preset of EXPORT_PRESETS) {
    const shortSide = shortSideOf(preset)
    const isLarger = shortSide !== undefined && shortSide > (shortSideOf(largest) ?? 0)
    if (shortSide !== undefined && shortSide <= canvasShortSide && isLarger) largest = preset
  }
  return largest
}

// Reads the choices stored after the last export. Whatever is missing or not understood is simply left out.
export function parseRememberedChoices(text: string | undefined): RememberedChoices {
  if (text === undefined) return {}
  let stored: unknown
  try {
    stored = JSON.parse(text)
  } catch (error) {
    if (error instanceof SyntaxError) return {}
    throw error
  }
  if (typeof stored !== 'object' || stored === null) return {}
  const remembered: RememberedChoices = {}
  if ('format' in stored && typeof stored.format === 'string' && isExportFormat(stored.format)) remembered.format = stored.format
  if ('encoder' in stored && typeof stored.encoder === 'string' && isExportEncoder(stored.encoder)) remembered.encoder = stored.encoder
  if ('preset' in stored && typeof stored.preset === 'string' && isExportPreset(stored.preset)) remembered.preset = stored.preset
  if ('quality' in stored && typeof stored.quality === 'string' && isExportQuality(stored.quality)) remembered.quality = stored.quality
  if ('hasAudio' in stored && typeof stored.hasAudio === 'boolean') remembered.hasAudio = stored.hasAudio
  return remembered
}

// With nothing remembered, an MP4 by the Mac's media engine on a Mac with little memory, otherwise by x264.
export function startingChoices(project: Project, remembered: RememberedChoices, hasSmallMemory: boolean): ExportChoices {
  const projectRate = project.canvas.frameRate
  const choices: ExportChoices = {
    format: 'mp4',
    preset: remembered.preset ?? defaultPreset(project.canvas),
    frameRate: projectRate,
    quality: remembered.quality ?? 'high',
    encoder: remembered.encoder ?? (hasSmallMemory ? 'hardware' : 'x264'),
    isSelectionOnly: false,
    hasAudio: remembered.hasAudio ?? true,
  }
  return withFormat(choices, remembered.format ?? 'mp4', projectRate)
}

// From the start of the first selected clip to the end of the last one.
export function selectionRange(project: Project, selection: readonly string[]): TimeRange | undefined {
  const selected = new Set(selection)
  let start = Infinity
  let end = -Infinity
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (!selected.has(clip.id)) continue
      start = Math.min(start, clip.start)
      end = Math.max(end, endOf(clip))
    }
  }
  return end > start ? { start, end } : undefined
}

// Only what the format uses goes into the job. `frame` is the frame of a PNG.
export function exportJobFor(choices: ExportChoices, range: TimeRange | undefined, paths: Pick<ExportJob, 'projectPath' | 'outputPath'>, frame: number): ExportJob {
  const { format } = choices
  const job: ExportJob = { kind: 'export', ...paths, format, preset: choices.preset }
  if (format === 'png') {
    job.frame = frame
    return job
  }
  if (hasMovingPicture(format)) job.frameRate = choices.frameRate
  if (format === 'mp4' || format === 'webm') {
    job.quality = choices.quality
    job.hasAudio = choices.hasAudio
  }
  if (format === 'mp4') job.encoder = choices.encoder
  if (!hasMovingPicture(format) && hasSound(format)) job.hasAudio = true
  if (choices.isSelectionOnly && range !== undefined) job.range = range
  return job
}

// How long the rest of an export will take, in milliseconds; undefined until enough is done for an honest answer.
export function timeLeft(done: number, total: number, elapsedMs: number): number | undefined {
  const isSteady = done > 0 && elapsedMs >= STEADY_AFTER_MS && done / total >= STEADY_AFTER_FRACTION
  if (!isSteady) return undefined
  return (elapsedMs / done) * (total - done)
}

// "45 s", "2 min 5 s", "1 h 3 min": as exact as a person needs at that length.
export function durationText(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.round(milliseconds / MS_PER_SECOND))
  const totalMinutes = Math.floor(totalSeconds / SECONDS_PER_MINUTE)
  const hours = Math.floor(totalMinutes / MINUTES_PER_HOUR)
  if (hours > 0) return `${hours}h ${totalMinutes % MINUTES_PER_HOUR}m`
  if (totalMinutes > 0) return `${totalMinutes}m ${totalSeconds % SECONDS_PER_MINUTE}s`
  return `${totalSeconds}s`
}
