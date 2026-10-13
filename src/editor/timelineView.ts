import type { Clip, Track } from '../shared/project.js'
import { TICKS_PER_SECOND } from '../shared/time.js'
import { endOf } from './clips.js'

export const RULER_HEIGHT = 24
export const TRACK_HEIGHT = 56

const MIN_LABEL_SPACING = 90
const MAX_PIXELS_PER_FRAME = 20
const SHORTEST_FIT_SECONDS = 10
const SECOND_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200]
const FRAME_STEPS = [1, 2, 5, 10]

export type TimelineView = {
  pixelsPerSecond: number
  // Timeline pixels scrolled off to the left and above.
  scrollX: number
  scrollY: number
}

export type ZoomLimits = {
  viewWidth: number
  duration: number
  frameTicks: number
}

export type IndexRange = {
  first: number
  end: number
}

export function timeToX(time: number, view: TimelineView): number {
  return (time / TICKS_PER_SECOND) * view.pixelsPerSecond - view.scrollX
}

export function xToTime(x: number, view: TimelineView): number {
  return ((x + view.scrollX) / view.pixelsPerSecond) * TICKS_PER_SECOND
}

// The top row shows the top layer, so rows run opposite to the track list, whose first entry is the bottom layer.
export function trackTop(trackIndex: number, trackCount: number, view: TimelineView): number {
  return RULER_HEIGHT + (trackCount - 1 - trackIndex) * TRACK_HEIGHT - view.scrollY
}

// May return an index one past the top track or below zero: rows where a drop creates a track.
export function trackIndexAt(y: number, trackCount: number, view: TimelineView): number {
  const row = Math.floor((y - RULER_HEIGHT + view.scrollY) / TRACK_HEIGHT)
  return trackCount - 1 - row
}

// Shows the whole project, or ten seconds of an empty one so the first clip has a sensible width.
export function fitZoom(limits: ZoomLimits): number {
  const seconds = Math.max(limits.duration / TICKS_PER_SECOND, SHORTEST_FIT_SECONDS)
  return limits.viewWidth / seconds
}

function maxZoom(frameTicks: number): number {
  return (MAX_PIXELS_PER_FRAME * TICKS_PER_SECOND) / frameTicks
}

// Zooms so that the time under `anchorX` stays under it, between "whole project visible" and single frames.
export function zoomAround(view: TimelineView, factor: number, anchorX: number, limits: ZoomLimits): TimelineView {
  const widest = Math.min(fitZoom(limits), maxZoom(limits.frameTicks))
  const pixelsPerSecond = Math.min(maxZoom(limits.frameTicks), Math.max(widest, view.pixelsPerSecond * factor))
  const anchorTime = xToTime(anchorX, view)
  const scrollX = Math.max(0, (anchorTime / TICKS_PER_SECOND) * pixelsPerSecond - anchorX)
  return { ...view, pixelsPerSecond, scrollX }
}

// Spacing of ruler labels, in ticks: whole frames when zoomed in, round numbers of seconds otherwise.
export function rulerStep(pixelsPerSecond: number, frameTicks: number): number {
  for (const frames of FRAME_STEPS) {
    const step = frames * frameTicks
    if (step < TICKS_PER_SECOND && (step / TICKS_PER_SECOND) * pixelsPerSecond >= MIN_LABEL_SPACING) return step
  }
  for (const seconds of SECOND_STEPS) {
    if (seconds * pixelsPerSecond >= MIN_LABEL_SPACING) return seconds * TICKS_PER_SECOND
  }
  return (SECOND_STEPS.at(-1) ?? 1) * TICKS_PER_SECOND
}

export type ClipIndex = (track: Track) => readonly Clip[]

// Clips of a track in time order. Tracks are never changed in place, so the order is worked out once per track object.
export function createClipIndex(): ClipIndex {
  const sorted = new WeakMap<Track, readonly Clip[]>()
  return (track) => {
    const known = sorted.get(track)
    if (known !== undefined) return known
    const inOrder = [...track.clips].sort((a, b) => a.start - b.start)
    sorted.set(track, inOrder)
    return inOrder
  }
}

// Which of the time-ordered, non-overlapping clips touch the span from `from` to `to`.
export function visibleRange(inOrder: readonly Clip[], from: number, to: number): IndexRange {
  let low = 0
  let high = inOrder.length
  while (low < high) {
    const middle = (low + high) >> 1
    const clip = inOrder[middle]
    if (clip !== undefined && endOf(clip) <= from) low = middle + 1
    else high = middle
  }
  const first = low
  high = inOrder.length
  while (low < high) {
    const middle = (low + high) >> 1
    const clip = inOrder[middle]
    if (clip !== undefined && clip.start < to) low = middle + 1
    else high = middle
  }
  return { first, end: low }
}

const EDGE_GRIP = 6
const MIN_WIDTH_FOR_EDGES = 3 * EDGE_GRIP

export type ClipHit = {
  clip: Clip
  track: Track
  trackIndex: number
  // Which edge the pointer is close enough to trim, if any.
  edge: 'start' | 'end' | undefined
}

export function hitClip(tracks: readonly Track[], inOrder: ClipIndex, view: TimelineView, x: number, y: number): ClipHit | undefined {
  const trackIndex = trackIndexAt(y, tracks.length, view)
  const track = tracks[trackIndex]
  if (track === undefined || y < RULER_HEIGHT) return undefined
  const time = xToTime(x, view)
  const clips = inOrder(track)
  const range = visibleRange(clips, time, time + 1)
  const clip = clips[range.first]
  if (clip === undefined || range.end === range.first) return undefined

  const left = timeToX(clip.start, view)
  const right = timeToX(endOf(clip), view)
  let edge: ClipHit['edge']
  if (right - left >= MIN_WIDTH_FOR_EDGES) {
    if (x - left <= EDGE_GRIP) edge = 'start'
    if (right - x <= EDGE_GRIP) edge = 'end'
  }
  return { clip, track, trackIndex, edge }
}

export type Marquee = {
  left: number
  top: number
  right: number
  bottom: number
}

export function clipsInMarquee(tracks: readonly Track[], inOrder: ClipIndex, view: TimelineView, marquee: Marquee): string[] {
  const from = xToTime(marquee.left, view)
  const to = xToTime(marquee.right, view)
  const ids: string[] = []
  for (const [trackIndex, track] of tracks.entries()) {
    const top = trackTop(trackIndex, tracks.length, view)
    if (track.locked || top + TRACK_HEIGHT <= marquee.top || top >= marquee.bottom) continue
    const clips = inOrder(track)
    const range = visibleRange(clips, from, Math.max(to, from + 1))
    for (let index = range.first; index < range.end; index++) {
      const clip = clips[index]
      if (clip !== undefined) ids.push(clip.id)
    }
  }
  return ids
}
