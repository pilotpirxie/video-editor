import type { MediaStates } from '../engine/resolve.js'
import type { Clip, Project, Track } from '../shared/project.js'
import { TIMELINE_GRID, sourceTime } from '../shared/time.js'
import { editClips, emptyTrack, endOf, hasSource, locateClip, placeOnTrack, shiftedKeyframes, withFadesWithin, type NewTrack } from './clips.js'

export type Move = {
  clipIds: readonly string[]
  deltaTime: number
  // Rows the pointer has travelled from the row of the grabbed clip, counted in the project the move starts from; up is positive.
  trackShift: number
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

function inTimeOrder(clips: readonly Clip[]): Clip[] {
  return [...clips].sort((a, b) => a.start - b.start)
}

// Whether a clip of one time-ordered list shares time with a clip of the other.
function overlap(arriving: readonly Clip[], staying: readonly Clip[]): boolean {
  let arrivingIndex = 0
  let stayingIndex = 0
  for (;;) {
    const arrived = arriving[arrivingIndex]
    const stays = staying[stayingIndex]
    if (arrived === undefined || stays === undefined) return false
    if (endOf(arrived) <= stays.start) arrivingIndex += 1
    else if (endOf(stays) <= arrived.start) stayingIndex += 1
    else return true
  }
}

// Several clips moved by whole tracks as well as in time. Nothing comes back when they do not fit: a row is missing or locked, or a clip would land on one that stays.
function shiftedAcrossTracks(project: Project, moving: ReadonlySet<string>, deltaTime: number, trackShift: number, newTrack: NewTrack): Project | undefined {
  const leaving = project.tracks.map((track) => track.clips.filter((clip) => moving.has(clip.id)))
  let earliestStart = Infinity
  for (const clip of leaving.flat()) earliestStart = Math.min(earliestStart, clip.start)
  const delta = Math.max(deltaTime, -earliestStart)

  // One row more than there are tracks: a group dragged above the top track gets a new one there, as a single clip does.
  const rows = [...project.tracks, emptyTrack(newTrack)]
  const arriving: Clip[][] = rows.map(() => [])
  for (const [trackIndex, clips] of leaving.entries()) {
    if (clips.length === 0) continue
    const target = arriving[trackIndex + trackShift]
    if (target === undefined) return undefined
    for (const clip of clips) target.push({ ...clip, start: clip.start + delta })
  }

  const tracks: Track[] = []
  for (const [rowIndex, row] of rows.entries()) {
    const arrived = arriving[rowIndex] ?? []
    const isTouched = arrived.length > 0 || (leaving[rowIndex] ?? []).length > 0
    if (!isTouched) {
      if (rowIndex < project.tracks.length) tracks.push(row)
      continue
    }
    const staying = row.clips.filter((clip) => !moving.has(clip.id))
    const isTaken = arrived.length > 0 && (row.locked || overlap(inTimeOrder(arrived), inTimeOrder(staying)))
    if (isTaken) return undefined
    tracks.push({ ...row, clips: [...staying, ...arrived] })
  }
  return { ...project, tracks }
}

// Several clips that keep their tracks stop at the first clip in their way, so the group never lands on top of anything.
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
    // A group goes as far toward the pointer as it fits: the wanted row first, then one row closer to where it was each time.
    const farthest = project.tracks.length
    const wanted = move.isRipple ? 0 : Math.max(-farthest, Math.min(farthest, move.trackShift))
    for (let shift = wanted; shift !== 0; shift -= Math.sign(wanted)) {
      const shifted = shiftedAcrossTracks(project, moving, move.deltaTime, shift, move.newTrack)
      if (shifted !== undefined) return shifted
    }
    const delta = unobstructedDelta(project, moving, move.deltaTime)
    if (delta === 0) return project
    return editClips(project, moving, (clip) => ({ ...clip, start: clip.start + delta }))
  }

  const located = locateClip(project, onlyId)
  if (located === undefined) return project
  const start = Math.max(0, located.clip.start + move.deltaTime)
  const trackIndex = Math.max(0, located.trackIndex + move.trackShift)
  if (start === located.clip.start && trackIndex === located.trackIndex) return project
  const lifted = editClips(project, moving, () => undefined)
  return placeOnTrack(lifted, { clips: [{ ...located.clip, start }], trackIndex, newTrack: move.newTrack })
}

function neighbours(track: Track, clip: Clip): { previousEnd: number; nextStart: number } {
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

// How much earlier a clip could start: as far as its file, or the content of a group, reaches back.
function headroom(clip: Clip): number {
  if (hasSource(clip)) return timelineSpan(clip.sourceStart, clip.speedPercent)
  return clip.type === 'group' ? (clip.contentStart ?? 0) : Infinity
}

function trimmedStart(clip: Clip, start: number): Clip {
  const delta = start - clip.start
  const timing = { start, duration: clip.duration - delta, keyframes: shiftedKeyframes(clip.keyframes, -delta) }
  if (hasSource(clip)) return withFadesWithin({ ...clip, ...timing, sourceStart: sourceTime(clip, start) })
  if (clip.type !== 'group') return withFadesWithin({ ...clip, ...timing })
  // A group shows its members from later on, or from earlier; the members themselves stay as they are.
  const contentStart = (clip.contentStart ?? 0) + delta
  return withFadesWithin({ ...clip, ...timing, contentStart: contentStart === 0 ? undefined : contentStart })
}

export function shiftLater(project: Project, track: Track, from: number, delta: number, exceptId: string): Project {
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

  const earliest = trim.isRipple ? clip.start - headroom(clip) : Math.max(clip.start - headroom(clip), previousEnd)
  const start = Math.min(endOf(clip) - trim.frameTicks, Math.max(trim.time, earliest))
  if (start === clip.start) return project
  if (!trim.isRipple) return editClips(project, only, (found) => trimmedStart(found, start))

  // A ripple trim keeps the clip where it starts and pulls everything after it along.
  const delta = start - clip.start
  const trimmed = editClips(project, only, (found) => ({ ...trimmedStart(found, start), start: found.start }))
  return shiftLater(trimmed, track, endOf(clip), -delta, clip.id)
}
