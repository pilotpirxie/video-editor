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
const ESTIMATE_AFTER_MS = 3000
const ESTIMATE_AFTER_FRACTION = 0.02

export type ExportChoices = {
  format: ExportFormat
  preset: ExportPreset
  frameRate: FrameRate
  quality: ExportQuality
  encoder: ExportEncoder
  isSelectionOnly: boolean
  hasAudio: boolean
}

export type RememberedChoices = Partial<Pick<ExportChoices, 'format' | 'preset' | 'quality' | 'encoder' | 'hasAudio'>>

function framesPerSecond(rate: FrameRate): number {
  return rate.num / rate.den
}

export function exportFrameRates(format: ExportFormat): FrameRate[] {
  const rates = format === 'gif' ? GIF_FRAME_RATES : PROJECT_FRAME_RATES
  return [...rates].sort((a, b) => framesPerSecond(b) - framesPerSecond(a))
}

function isSameRate(a: FrameRate, b: FrameRate): boolean {
  return a.num === b.num && a.den === b.den
}

function isRateOf(format: ExportFormat, value: unknown): boolean {
  if (typeof value !== 'object' || value === null || !('num' in value) || !('den' in value)) return false
  const { num, den } = value
  if (typeof num !== 'number' || typeof den !== 'number') return false
  return exportFrameRates(format).some((rate) => isSameRate(rate, { num, den }))
}

function isTimeRange(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || !('start' in value) || !('end' in value)) return false
  return typeof value.start === 'number' && typeof value.end === 'number' && value.start >= 0 && value.end > value.start
}

// A job arrives from a window, so every choice in it is checked before it is run; the frame rate must be one its format offers.
export function isExportJob(value: unknown): value is ExportJob {
  if (typeof value !== 'object' || value === null) return false
  if (!('kind' in value) || value.kind !== 'export') return false
  if (!('projectPath' in value) || typeof value.projectPath !== 'string') return false
  if (!('outputPath' in value) || typeof value.outputPath !== 'string') return false
  if (!('preset' in value) || typeof value.preset !== 'string' || !isExportPreset(value.preset)) return false
  if ('format' in value && value.format !== undefined && !(typeof value.format === 'string' && isExportFormat(value.format))) return false
  const format = 'format' in value && typeof value.format === 'string' && isExportFormat(value.format) ? value.format : 'mp4'
  if ('frameRate' in value && value.frameRate !== undefined && !isRateOf(format, value.frameRate)) return false
  if ('quality' in value && value.quality !== undefined && !(typeof value.quality === 'string' && isExportQuality(value.quality))) return false
  if ('range' in value && value.range !== undefined && !isTimeRange(value.range)) return false
  if ('encoder' in value && value.encoder !== undefined && !(typeof value.encoder === 'string' && isExportEncoder(value.encoder))) return false
  if ('frame' in value && value.frame !== undefined && !(Number.isInteger(value.frame) && Number(value.frame) >= 0)) return false
  return !('hasAudio' in value) || value.hasAudio === undefined || typeof value.hasAudio === 'boolean'
}

export function withFormat(choices: ExportChoices, format: ExportFormat, projectRate: FrameRate): ExportChoices {
  const canKeepRate = exportFrameRates(format).some((rate) => isSameRate(rate, choices.frameRate))
  if (canKeepRate) return { ...choices, format }
  return { ...choices, format, frameRate: format === 'gif' ? DEFAULT_GIF_FRAME_RATE : projectRate }
}

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

export function exportJobFor(choices: ExportChoices, range: TimeRange | undefined, paths: Pick<ExportJob, 'projectPath' | 'outputPath'>, pngFrame: number): ExportJob {
  const { format } = choices
  const job: ExportJob = { kind: 'export', ...paths, format, preset: choices.preset }
  if (format === 'png') {
    job.frame = pngFrame
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

export function timeLeftMs(done: number, total: number, elapsedMs: number): number | undefined {
  const isSteady = done > 0 && elapsedMs >= ESTIMATE_AFTER_MS && done / total >= ESTIMATE_AFTER_FRACTION
  if (!isSteady) return undefined
  return (elapsedMs / done) * (total - done)
}

export function durationText(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.round(milliseconds / MS_PER_SECOND))
  const totalMinutes = Math.floor(totalSeconds / SECONDS_PER_MINUTE)
  const hours = Math.floor(totalMinutes / MINUTES_PER_HOUR)
  if (hours > 0) return `${hours}h ${totalMinutes % MINUTES_PER_HOUR}m`
  if (totalMinutes > 0) return `${totalMinutes}m ${totalSeconds % SECONDS_PER_MINUTE}s`
  return `${totalSeconds}s`
}
