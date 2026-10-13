import type { MediaStates } from '../engine/resolve.js'
import type { Clip, Project, Track } from '../shared/project.js'
import { TIMELINE_GRID, sourceTime } from '../shared/time.js'
import { editClips, endOf, hasSource, locateClip, placeOnTrack, shiftedKeyframes, withFadesWithin, type NewTrack } from './clips.js'

export type Move = {
  clipIds: readonly string[]
  deltaTime: number
  // Row the pointer is over, counted in the project the move starts from. Only a single clip changes track.
  targetTrackIndex: number | undefined
  isRipple: boolean
  newTrack: NewTrack
}

export type Trim = {
  clipId: string
  edge: 'start' | 'end'
  time: number
  isRipple: boolean
  frameTicks: number
  mediaStates: MediaStates
}

function movable(project: Project, clipIds: readonly string[], isRipple: boolean): Set<string> {
  const chosen = new Set(clipIds)
  const moving = new Set<string>()
  for (const track of project.tracks) {
    if (track.locked) continue
    const selected = track.clips.filter((clip) => chosen.has(clip.id))
    if (selected.length === 0) continue
    const rippleFrom = Math.min(...selected.map((clip) => clip.start))
    for (const clip of track.clips) {
      if (chosen.has(clip.id) || (isRipple && clip.start >= rippleFrom)) moving.add(clip.id)
    }
  }
  return moving
}

// Several clips keep their tracks and stop at the first clip in their way, so the group never lands on top of anything.
function unobstructedDelta(project: Project, moving: ReadonlySet<string>, deltaTime: number): number {
  let delta = deltaTime
  for (const track of project.tracks) {
    const staying = track.clips.filter((clip) => !moving.has(clip.id))
    for (const clip of track.clips) {
      if (!moving.has(clip.id)) continue
      delta = Math.max(delta, -clip.start)
      for (const other of staying) {
        if (delta > 0 && other.start >= endOf(clip)) delta = Math.min(delta, other.start - endOf(clip))
        if (delta < 0 && endOf(other) <= clip.start) delta = Math.max(delta, endOf(other) - clip.start)
      }
    }
  }
  return delta
}

export function moveClips(project: Project, move: Move): Project {
  const moving = movable(project, move.clipIds, move.isRipple)
  const [onlyId] = moving
  if (onlyId === undefined) return project

  if (moving.size > 1) {
    const delta = unobstructedDelta(project, moving, move.deltaTime)
    if (delta === 0) return project
    return editClips(project, moving, (clip) => ({ ...clip, start: clip.start + delta }))
  }

  const located = locateClip(project, onlyId)
  if (located === undefined) return project
  const start = Math.max(0, located.clip.start + move.deltaTime)
  const trackIndex = move.targetTrackIndex ?? located.trackIndex
  if (start === located.clip.start && trackIndex === located.trackIndex) return project
  const lifted = editClips(project, moving, () => undefined)
  return placeOnTrack(lifted, { clips: [{ ...located.clip, start }], trackIndex, newTrack: move.newTrack })
}

export function neighbours(track: Track, clip: Clip): { previousEnd: number; nextStart: number } {
  let previousEnd = 0
  let nextStart = Infinity
  for (const other of track.clips) {
    if (other.id === clip.id) continue
    if (endOf(other) <= clip.start) previousEnd = Math.max(previousEnd, endOf(other))
    if (other.start >= endOf(clip)) nextStart = Math.min(nextStart, other.start)
  }
  return { previousEnd, nextStart }
}

// How much source a clip can draw on; undefined when nothing limits it, as for a clip that loops or whose media is unknown.
export function sourceDuration(clip: Clip, mediaStates: MediaStates): number | undefined {
  if (!hasSource(clip) || (clip.type === 'video' && clip.loop === true)) return undefined
  const state = mediaStates[clip.mediaId]
  if (state === undefined || 'error' in state || state.info.kind === 'image') return undefined
  return state.info.duration
}

// Longest stretch of timeline a span of source can fill at the clip's speed, on the time grid.
export function timelineSpan(sourceSpan: number, speedPercent: number): number {
  return Math.floor(sourceSpan / speedPercent) * TIMELINE_GRID
}

function trimmedStart(clip: Clip, start: number): Clip {
  const delta = start - clip.start
  const timing = { start, duration: clip.duration - delta, keyframes: shiftedKeyframes(clip.keyframes, -delta) }
  if (!hasSource(clip)) return withFadesWithin({ ...clip, ...timing })
  return withFadesWithin({ ...clip, ...timing, sourceStart: sourceTime(clip, start) })
}

function shiftLater(project: Project, track: Track, from: number, delta: number, exceptId: string): Project {
  const later = new Set<string>()
  for (const other of track.clips) {
    if (other.id !== exceptId && other.start >= from) later.add(other.id)
  }
  return editClips(project, later, (clip) => ({ ...clip, start: clip.start + delta }))
}

export function trimClip(project: Project, trim: Trim): Project {
  const located = locateClip(project, trim.clipId)
  if (located === undefined || located.track.locked) return project
  const { clip, track } = located
  const only = new Set([clip.id])
  const { previousEnd, nextStart } = neighbours(track, clip)
  const available = sourceDuration(clip, trim.mediaStates)

  if (trim.edge === 'end') {
    const longest = hasSource(clip) && available !== undefined ? timelineSpan(available - clip.sourceStart, clip.speedPercent) : Infinity
    const latest = Math.min(clip.start + longest, trim.isRipple ? Infinity : nextStart)
    const end = Math.max(clip.start + trim.frameTicks, Math.min(trim.time, latest))
    if (end === endOf(clip)) return project
    const trimmed = editClips(project, only, (found) => withFadesWithin({ ...found, duration: end - found.start }))
    return trim.isRipple ? shiftLater(trimmed, track, endOf(clip), end - endOf(clip), clip.id) : trimmed
  }

  const headroom = hasSource(clip) ? timelineSpan(clip.sourceStart, clip.speedPercent) : Infinity
  const earliest = trim.isRipple ? clip.start - headroom : Math.max(clip.start - headroom, previousEnd)
  const start = Math.min(endOf(clip) - trim.frameTicks, Math.max(trim.time, earliest))
  if (start === clip.start) return project
  if (!trim.isRipple) return editClips(project, only, (found) => trimmedStart(found, start))

  // A ripple trim keeps the clip where it starts and pulls everything after it along.
  const delta = start - clip.start
  const trimmed = editClips(project, only, (found) => ({ ...trimmedStart(found, start), start: found.start }))
  return shiftLater(trimmed, track, endOf(clip), -delta, clip.id)
}
