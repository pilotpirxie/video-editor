import type { CameraKeyframe, Clip, Track } from '../shared/project.js'
import { TICKS_PER_SECOND } from '../shared/time.js'
import { endOf, hasVolume, isVisual } from './clips.js'
import type { Fade } from './properties.js'
import { transitionSpans, type TransitionEdge } from './transitions.js'

export const RULER_HEIGHT = 24
// The lane under the ruler that shows the zooms of the camera. It does not scroll away with the tracks.
export const CAMERA_LANE_HEIGHT = 22
export const TRACKS_TOP = RULER_HEIGHT + CAMERA_LANE_HEIGHT
export const TRACK_HEIGHT = 56
export const CLIP_INSET = 2

const PICTURE_SHARE = 0.6
const FADE_HANDLE_INSET = 7
const HANDLE_REACH = 8
const MIN_WIDTH_FOR_FADES = 4 * FADE_HANDLE_INSET
const MAX_VOLUME = 2
const VOLUME_LINE_REACH = 4
const DIAMOND_INSET = 6
const ZOOM_REACH = 6
const ZOOM_START_REACH = 2 * ZOOM_REACH
const MIN_WIDTH_FOR_ZOOM_START = 2 * ZOOM_START_REACH

const MIN_LABEL_SPACING = 90
const MAX_PIXELS_PER_FRAME = 20
const SHORTEST_FIT_SECONDS = 10
const ZOOM_OUT_PAST_PROJECT = 10
const SHORTEST_WIDEST_VIEW_SECONDS = 3600
const SECOND_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14_400, 28_800, 43_200, 86_400, 172_800, 345_600]
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
  return TRACKS_TOP + (trackCount - 1 - trackIndex) * TRACK_HEIGHT - view.scrollY
}

// May return an index one past the top track or below zero: rows where a drop creates a track.
export function trackIndexAt(y: number, trackCount: number, view: TimelineView): number {
  const row = Math.floor((y - TRACKS_TOP + view.scrollY) / TRACK_HEIGHT)
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

// The furthest zoom out leaves room beyond the last clip: the view holds ten times the project, and never less than an hour.
function widestZoom(limits: ZoomLimits): number {
  const seconds = Math.max((ZOOM_OUT_PAST_PROJECT * limits.duration) / TICKS_PER_SECOND, SHORTEST_WIDEST_VIEW_SECONDS)
  return limits.viewWidth / seconds
}

// Zooms so that the time under `anchorX` stays under it, between far beyond the project and single frames.
export function zoomAround(view: TimelineView, factor: number, anchorX: number, limits: ZoomLimits): TimelineView {
  const widest = Math.min(widestZoom(limits), maxZoom(limits.frameTicks))
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
  if (track === undefined || y < TRACKS_TOP) return undefined
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

export type Band = {
  top: number
  height: number
}

// Where a clip shows its picture and where its sound, inside its row. A clip with both shows the thumbnails above the waveform.
export type ClipBands = {
  picture: Band | undefined
  sound: Band | undefined
}

export function clipBands(clip: Clip, makesSound: boolean, rowTop: number): ClipBands {
  const whole: Band = { top: rowTop + CLIP_INSET, height: TRACK_HEIGHT - 2 * CLIP_INSET }
  if (clip.type === 'audio') return { picture: undefined, sound: whole }
  if (!makesSound) return { picture: whole, sound: undefined }
  const pictureHeight = Math.round(whole.height * PICTURE_SHARE)
  return {
    picture: { top: whole.top, height: pictureHeight },
    sound: { top: whole.top + pictureHeight, height: whole.height - pictureHeight },
  }
}

export type FadeHandle = {
  fade: Fade
  x: number
  y: number
}

// The handles that set a clip's fades: at the top corners for the picture, at the bottom corners for the sound.
// Each sits where its fade ends, but never closer to the clip edge than its own radius, so it stays apart from the trim edge.
export function fadeHandles(clip: Clip, makesSound: boolean, view: TimelineView, rowTop: number): FadeHandle[] {
  const left = timeToX(clip.start, view)
  const right = timeToX(endOf(clip), view)
  if (right - left < MIN_WIDTH_FOR_FADES) return []

  function fadeInX(fade: number | undefined): number {
    const end = left + ((fade ?? 0) / TICKS_PER_SECOND) * view.pixelsPerSecond
    return Math.min(right - FADE_HANDLE_INSET, Math.max(left + FADE_HANDLE_INSET, end))
  }

  function fadeOutX(fade: number | undefined): number {
    const end = right - ((fade ?? 0) / TICKS_PER_SECOND) * view.pixelsPerSecond
    return Math.min(right - FADE_HANDLE_INSET, Math.max(left + FADE_HANDLE_INSET, end))
  }

  const bands = clipBands(clip, makesSound, rowTop)
  const handles: FadeHandle[] = []
  if (clip.type !== 'audio' && bands.picture !== undefined) {
    const y = bands.picture.top + FADE_HANDLE_INSET
    handles.push({ fade: 'fadeIn', x: fadeInX(clip.fadeIn), y }, { fade: 'fadeOut', x: fadeOutX(clip.fadeOut), y })
  }
  if (hasVolume(clip) && bands.sound !== undefined) {
    const y = bands.sound.top + bands.sound.height - FADE_HANDLE_INSET
    handles.push({ fade: 'volumeFadeIn', x: fadeInX(clip.volumeFadeIn), y }, { fade: 'volumeFadeOut', x: fadeOutX(clip.volumeFadeOut), y })
  }
  return handles
}

// Which of the handles is under the pointer, or -1. The reach is larger than the dot that is drawn, so a handle is easy to grab.
function nearestInReach(handles: readonly { x: number; y: number }[], x: number, y: number): number {
  let nearest = -1
  let nearestDistance = HANDLE_REACH
  for (const [index, handle] of handles.entries()) {
    const distance = Math.hypot(handle.x - x, handle.y - y)
    if (distance <= nearestDistance) {
      nearest = index
      nearestDistance = distance
    }
  }
  return nearest
}

export function fadeHandleAt(handles: readonly FadeHandle[], x: number, y: number): FadeHandle | undefined {
  return handles[nearestInReach(handles, x, y)]
}

// A volume keyframe of a clip, where it is drawn on the clip's sound. `index` is its place among the clip's volume keyframes.
export type VolumePoint = {
  index: number
  x: number
  y: number
}

// The height in a band that stands for a volume: silence at the bottom, twice the recorded volume at the top.
function volumeY(band: Band, volume: number): number {
  return band.top + band.height * (1 - volume / MAX_VOLUME)
}

// The volume a height in a band stands for, within what a clip can have.
export function volumeAtY(band: Band, y: number): number {
  return Math.min(MAX_VOLUME, Math.max(0, (1 - (y - band.top) / band.height) * MAX_VOLUME))
}

export function volumePoints(clip: Clip, makesSound: boolean, view: TimelineView, rowTop: number): VolumePoint[] {
  const keyframes = clip.keyframes?.volume
  const band = clipBands(clip, makesSound, rowTop).sound
  if (keyframes === undefined || band === undefined || !hasVolume(clip)) return []
  return keyframes.map((keyframe, index) => ({ index, x: timeToX(clip.start + keyframe.time, view), y: volumeY(band, keyframe.value) }))
}

export function volumePointAt(points: readonly VolumePoint[], x: number, y: number): VolumePoint | undefined {
  return points[nearestInReach(points, x, y)]
}

// A moment of a clip that has a keyframe of its picture, where its diamond is drawn. `time` is measured from the start of the clip.
export type KeyframeDiamond = {
  time: number
  x: number
  y: number
}

// One diamond for each moment inside the clip that keys its place, size, turn, opacity or crop, along the bottom of its picture.
// Volume keyframes have dots of their own on the volume line, and keyframes outside the clip, kept by a split, are not seen.
export function keyframeDiamonds(clip: Clip, picture: Band | undefined, view: TimelineView): KeyframeDiamond[] {
  if (picture === undefined || clip.keyframes === undefined) return []
  const times = new Set<number>()
  for (const [property, keyframes] of Object.entries(clip.keyframes)) {
    if (property === 'volume' || keyframes === undefined) continue
    for (const keyframe of keyframes) {
      if (keyframe.time >= 0 && keyframe.time <= clip.duration) times.add(keyframe.time)
    }
  }
  const y = picture.top + picture.height - DIAMOND_INSET
  const sorted = [...times].sort((a, b) => a - b)
  return sorted.map((time) => ({ time, x: timeToX(clip.start + time, view), y }))
}

export function keyframeDiamondAt(diamonds: readonly KeyframeDiamond[], x: number, y: number): KeyframeDiamond | undefined {
  return diamonds[nearestInReach(diamonds, x, y)]
}

// How much the volume changes when the line is dragged from one height to another.
export function volumeChange(band: Band, fromY: number, toY: number): number {
  return ((fromY - toY) / band.height) * MAX_VOLUME
}

// The volume line of a clip at one point across it, as it is drawn: straight from keyframe to keyframe, level before the first and after the last, and level at the clip's volume when it has none.
export type VolumeLineSpot = {
  y: number
  band: Band
  // The keyframes at the two ends of the stretch of line there: none without keyframes, only one before the first or after the last.
  indices: number[]
}

export function volumeLineAt(clip: Clip, makesSound: boolean, view: TimelineView, rowTop: number, x: number): VolumeLineSpot | undefined {
  const band = clipBands(clip, makesSound, rowTop).sound
  if (band === undefined || !hasVolume(clip)) return undefined
  if (x < timeToX(clip.start, view) || x > timeToX(endOf(clip), view)) return undefined
  const points = volumePoints(clip, makesSound, view, rowTop)
  const first = points[0]
  const last = points.at(-1)
  if (first === undefined || last === undefined) return { y: volumeY(band, clip.volume), band, indices: [] }
  if (x <= first.x) return { y: first.y, band, indices: [first.index] }
  if (x >= last.x) return { y: last.y, band, indices: [last.index] }
  const afterIndex = points.findIndex((point) => point.x >= x)
  const after = points[afterIndex]
  const before = points[afterIndex - 1]
  if (after === undefined || before === undefined) return undefined
  const share = (x - before.x) / (after.x - before.x)
  return { y: before.y + (after.y - before.y) * share, band, indices: [before.index, after.index] }
}

// The stretch of volume line under the pointer, when the pointer is close enough to grab it.
export function volumeLineNear(clip: Clip, makesSound: boolean, view: TimelineView, rowTop: number, point: { x: number; y: number }): VolumeLineSpot | undefined {
  const spot = volumeLineAt(clip, makesSound, view, rowTop, point.x)
  return spot !== undefined && Math.abs(spot.y - point.y) <= VOLUME_LINE_REACH ? spot : undefined
}

// Where a transition is drawn on its clip, and the grip that sets its length.
export type TransitionBand = {
  edge: TransitionEdge
  left: number
  right: number
  // The end of the band that can be dragged, at half the height of the row: the end that lies inside the clip.
  gripX: number
  gripY: number
  isOnCut: boolean
}

// `before` and `after` are the clips next to this one on its track, in time order.
export function transitionBands(clip: Clip, before: Clip | undefined, after: Clip | undefined, view: TimelineView, rowTop: number): TransitionBand[] {
  if (!isVisual(clip) || (clip.transitionIn === undefined && clip.transitionOut === undefined)) return []
  const spans = transitionSpans(clip, before, after)
  const gripY = rowTop + TRACK_HEIGHT / 2
  const bands: TransitionBand[] = []
  if (spans.in !== undefined) {
    const right = timeToX(spans.in.to, view)
    bands.push({ edge: 'in', left: timeToX(spans.in.from, view), right, gripX: right, gripY, isOnCut: spans.in.isOnCut })
  }
  if (spans.out !== undefined) {
    const left = timeToX(spans.out.from, view)
    bands.push({ edge: 'out', left, right: timeToX(spans.out.to, view), gripX: left, gripY, isOnCut: false })
  }
  return bands
}

export function transitionBandAt(bands: readonly TransitionBand[], x: number, y: number): TransitionBand | undefined {
  const grips = bands.map((band) => ({ x: band.gripX, y: band.gripY }))
  return bands[nearestInReach(grips, x, y)]
}

// A zoom on the camera lane: a bar for the time its move takes, ending where the zoom is reached.
export type ZoomBar = {
  index: number
  from: number
  to: number
}

// A move never starts before the zoom before it has been reached, whatever length it was given.
export function zoomBars(camera: readonly CameraKeyframe[]): ZoomBar[] {
  return camera.map((zoom, index) => ({ index, from: Math.max(zoom.time - zoom.duration, camera[index - 1]?.time ?? 0), to: zoom.time }))
}

export type ZoomHit = {
  index: number
  // The start of the bar changes how long the move takes; anywhere else on it moves the zoom in time.
  part: 'zoom' | 'start'
}

export function hitZoom(camera: readonly CameraKeyframe[], view: TimelineView, x: number): ZoomHit | undefined {
  const bars = zoomBars(camera)
  // The diamonds come first. A move that starts at the zoom before it has its start on that zoom's diamond, and the diamond must stay easy to grab.
  const reached = bars.findLast((bar) => Math.abs(x - timeToX(bar.to, view)) <= ZOOM_REACH)
  if (reached !== undefined) return { index: reached.index, part: 'zoom' }
  for (const bar of bars) {
    const left = timeToX(bar.from, view)
    const right = timeToX(bar.to, view)
    if (x < left || x > right) continue
    const isAtStart = right - left >= MIN_WIDTH_FOR_ZOOM_START && x <= left + ZOOM_START_REACH
    return { index: bar.index, part: isAtStart ? 'start' : 'zoom' }
  }
  return undefined
}
