import type { MediaStates } from '../engine/resolve.js'
import type { DebugSystemInfo, Preparation } from '../shared/mediaProtocol.js'
import { projectDuration, type Clip, type Project, type Track } from '../shared/project.js'
import { TICKS_PER_SECOND, timecode, type FrameRate } from '../shared/time.js'

const MAX_DETAILED_CLIPS = 20
const BYTES_PER_MEGABYTE = 1024 * 1024
const BYTES_PER_GIGABYTE = 1024 * BYTES_PER_MEGABYTE

export type DebugReportInput = {
  project: Project
  openGroups: readonly string[]
  selection: readonly string[]
  mediaStates: MediaStates
  preparation: Readonly<Record<string, Preparation>>
  playhead: number
  droppedFrames: number
  fullQualityMs: number | undefined
  documentPath: string | undefined
  system: DebugSystemInfo | 'reading' | 'unavailable'
}

function timeText(ticks: number, rate: FrameRate): string {
  return `${(ticks / TICKS_PER_SECOND).toFixed(3)}s (${timecode(ticks, rate)})`
}

function systemLine(system: DebugReportInput['system']): string {
  if (system === 'reading') return 'System: reading…'
  if (system === 'unavailable') return 'System: unavailable'
  const memory = `${Math.round(system.totalMemoryBytes / BYTES_PER_GIGABYTE)} GB`
  const used = system.footprintBytes === undefined ? 'unknown' : `${Math.round(system.footprintBytes / BYTES_PER_MEGABYTE)} MB`
  return [`Playback ${system.appVersion}`, ...system.versions, `macOS ${system.macOS}`, system.cpu, memory, `using ${used}`].join(' | ')
}

function trackLine(track: Track, rate: FrameRate): string {
  let start = Infinity
  let end = 0
  for (const clip of track.clips) {
    start = Math.min(start, clip.start)
    end = Math.max(end, clip.start + clip.duration)
  }
  const span = track.clips.length === 0 ? 'empty' : `${timeText(start, rate)} to ${timeText(end, rate)}`
  const flags = `locked ${track.locked ? 'yes' : 'no'} | hidden ${track.hidden ? 'yes' : 'no'} | muted ${track.muted ? 'yes' : 'no'}`
  return `${track.name} [${track.id}] | ${track.clips.length} clips | ${span} | ${flags}`
}

function mediaLines(clip: Clip, input: DebugReportInput): string[] {
  if (!('mediaId' in clip)) return []
  const reference = input.project.media.find((media) => media.id === clip.mediaId)
  const preparation = input.preparation[clip.mediaId]
  const prepared = preparation === undefined ? 'unknown' : `${Math.round(preparation.progress * 100)}%${preparation.hasFailed ? ' (failed)' : ''}`
  return [`  media ${reference?.path ?? clip.mediaId} | prepared ${prepared}`, `  info ${JSON.stringify(input.mediaStates[clip.mediaId] ?? 'unknown')}`]
}

function clipLines(clip: Clip, track: Track, input: DebugReportInput): string[] {
  const rate = input.project.canvas.frameRate
  const timing = [`start ${timeText(clip.start, rate)}`, `duration ${timeText(clip.duration, rate)}`]
  if ('speedPercent' in clip) timing.push(`source ${timeText(clip.sourceStart, rate)}`, `speed ${clip.speedPercent}%`)
  return [`Clip ${clip.id} | ${clip.type} on ${track.name} | ${timing.join(' | ')}`, ...mediaLines(clip, input), `  json ${JSON.stringify(clip)}`]
}

export function debugReport(input: DebugReportInput): string {
  const { project } = input
  const rate = project.canvas.frameRate
  const clipCount = project.tracks.reduce((count, track) => count + track.clips.length, 0)
  const lines = [
    systemLine(input.system),
    `File ${input.documentPath ?? 'untitled'}`,
    [
      `Project ${project.canvas.width}x${project.canvas.height} ${rate.num}/${rate.den} fps`,
      `${project.tracks.length} tracks`,
      `${clipCount} clips`,
      `${project.media.length} files`,
      `${project.camera?.length ?? 0} zooms`,
      `length ${timeText(projectDuration(project), rate)}`,
      `playhead ${timeText(input.playhead, rate)}`,
      `dropped ${input.droppedFrames} frames`,
      `full-quality frame ${input.fullQualityMs === undefined ? 'none yet' : `${Math.round(input.fullQualityMs)} ms`}`,
      `group ${input.openGroups.length === 0 ? 'none' : input.openGroups.join(' > ')}`,
    ].join(' | '),
  ]
  for (const track of project.tracks) lines.push(trackLine(track, rate))

  const wanted = new Set(input.selection)
  if (wanted.size === 0) return lines.join('\n')
  lines.push(`Selected ${wanted.size}`)
  let detailed = 0
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (!wanted.has(clip.id) || detailed === MAX_DETAILED_CLIPS) continue
      detailed += 1
      lines.push(...clipLines(clip, track, input))
    }
  }
  if (wanted.size > detailed) lines.push(`…and ${wanted.size - detailed} more`)
  return lines.join('\n')
}
