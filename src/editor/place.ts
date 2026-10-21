import type { Size } from '../shared/exportPresets.js'
import type { MediaStates } from '../engine/resolve.js'
import type { MediaInfo, MediaUse, UnlinkedMedia } from '../shared/mediaProtocol.js'
import { MAX_CANVAS, MIN_CANVAS, type Canvas, type Clip, type MediaRef, type Project, type Track, type Transform } from '../shared/project.js'
import { NORMAL_SPEED_PERCENT, PROJECT_FRAME_RATES, frameDuration, type FrameRate } from '../shared/time.js'
import { allClips, endOf, hasMedia, placeOnTrack, type NewTrack } from './clips.js'

const MAX_AUTOMATIC_FRAMES_PER_SECOND = 60

export type NewStill = {
  clipId: string
  start: number
  duration: number
  newTrack: NewTrack
  trackIndex?: number
  centre?: { x: number; y: number }
}

export function centredStill(project: Project, added: NewStill): { id: string; start: number; duration: number; transform: Transform; opacity: number } {
  const { canvas } = project
  const centre = added.centre ?? { x: canvas.width / 2, y: canvas.height / 2 }
  return {
    id: added.clipId,
    start: added.start,
    duration: added.duration,
    transform: { x: centre.x, y: centre.y, scaleX: 1, scaleY: 1, rotation: 0 },
    opacity: 1,
  }
}

export type DroppedMedia = {
  reference: MediaRef
  info: MediaInfo
  clipId: string
}

export type MediaDrop = {
  media: readonly DroppedMedia[]
  start: number
  trackIndex: number
  newTrack: NewTrack
  stillDuration: number
}

function wholeFrames(duration: number, frameTicks: number): number {
  return Math.max(1, Math.floor(duration / frameTicks)) * frameTicks
}

function centred(natural: Size, canvas: Canvas): Transform {
  const fit = Math.min(1, canvas.width / natural.width, canvas.height / natural.height)
  return { x: canvas.width / 2, y: canvas.height / 2, scaleX: fit, scaleY: fit, rotation: 0 }
}

export function clipForMedia(mediaId: string, info: MediaInfo, canvas: Canvas, clipId: string, start: number, stillDuration: number): Clip {
  const frameTicks = frameDuration(canvas.frameRate)
  if (info.kind === 'image') {
    return { id: clipId, type: 'image', mediaId, start, duration: stillDuration, transform: centred(info, canvas), opacity: 1 }
  }
  const source = { mediaId, sourceStart: 0, speedPercent: NORMAL_SPEED_PERCENT, volume: 1 }
  const timing = { id: clipId, start, duration: wholeFrames(info.duration, frameTicks) }
  if (info.kind === 'audio') return { ...timing, ...source, type: 'audio' }
  const video: Clip = { ...timing, ...source, type: 'video', transform: centred(info.video, canvas), opacity: 1 }
  if (info.isAnimatedImage !== true) return video
  return { ...video, loop: true, duration: Math.max(timing.duration, stillDuration) }
}

// Higher project rates are a deliberate choice: a phone's slow-motion clip should not make the whole project twice as heavy to play and export.
function nearestProjectFrameRate(frameTicks: number): FrameRate {
  let nearest = PROJECT_FRAME_RATES[0] ?? { num: 30, den: 1 }
  for (const rate of PROJECT_FRAME_RATES) {
    if (rate.num / rate.den > MAX_AUTOMATIC_FRAMES_PER_SECOND) continue
    if (Math.abs(frameDuration(rate) - frameTicks) < Math.abs(frameDuration(nearest) - frameTicks)) nearest = rate
  }
  return nearest
}

function even(value: number): number {
  return Math.round(value / 2) * 2
}

function canvasSizeFor(natural: Size): Size {
  const shrink = Math.min(1, MAX_CANVAS.width / natural.width, MAX_CANVAS.height / natural.height)
  const grow = Math.max(1, MIN_CANVAS.width / natural.width, MIN_CANVAS.height / natural.height)
  const scale = shrink < 1 ? shrink : grow
  return {
    width: Math.min(MAX_CANVAS.width, Math.max(MIN_CANVAS.width, even(natural.width * scale))),
    height: Math.min(MAX_CANVAS.height, Math.max(MIN_CANVAS.height, even(natural.height * scale))),
  }
}

export function canvasForFirstClip(info: MediaInfo, canvas: Canvas): Canvas {
  if (info.kind === 'audio') return canvas
  if (info.kind === 'image') return { ...canvas, ...canvasSizeFor(info) }
  if (info.isAnimatedImage === true) return { ...canvas, ...canvasSizeFor(info.video) }
  return { ...canvasSizeFor(info.video), frameRate: nearestProjectFrameRate(info.video.frameDuration) }
}

export function mediaFileName(reference: MediaRef): string {
  const path = reference.path === '' ? reference.relativePath : reference.path
  return path.split('/').at(-1) ?? path
}

export function mediaUses(project: Project, mediaId: string): MediaUse[] {
  const uses = new Set<MediaUse>()
  for (const clip of allClips(project.tracks)) {
    if (!hasMedia(clip) || clip.mediaId !== mediaId) continue
    if (clip.type === 'audio') uses.add('sound')
    else uses.add(clip.type)
  }
  return [...uses]
}

export function unlinkedMedia(project: Project, mediaStates: MediaStates): UnlinkedMedia[] {
  const unlinked: UnlinkedMedia[] = []
  for (const reference of project.media) {
    const state = mediaStates[reference.id]
    const isUnlinked = state === undefined || ('error' in state && state.isMissing)
    if (isUnlinked) unlinked.push({ reference, uses: mediaUses(project, reference.id) })
  }
  return unlinked
}

export function relinkedMedia(project: Project, found: readonly { id: string; path: string }[]): Project {
  const paths = new Map(found.map((item) => [item.id, item.path]))
  let hasChanged = false
  const media = project.media.map((reference) => {
    const path = paths.get(reference.id)
    if (path === undefined || path === reference.path) return reference
    hasChanged = true
    return { id: reference.id, path, relativePath: '' }
  })
  return hasChanged ? { ...project, media } : project
}

function hasClips(project: Project): boolean {
  return project.tracks.some((track) => track.clips.length > 0)
}

export function withMedia(project: Project, reference: MediaRef): Project {
  if (project.media.some((existing) => existing.id === reference.id)) return project
  return { ...project, media: [...project.media, reference] }
}

function tracksWithoutMedia(tracks: readonly Track[], mediaIds: ReadonlySet<string>): Track[] {
  const kept: Track[] = []
  for (const track of tracks) {
    const clips: Clip[] = []
    for (const clip of track.clips) {
      if (hasMedia(clip) && mediaIds.has(clip.mediaId)) continue
      if (clip.type !== 'group') {
        clips.push(clip)
        continue
      }
      const members = tracksWithoutMedia(clip.tracks, mediaIds)
      const hasMembersLeft = members.some((member) => member.clips.length > 0)
      if (hasMembersLeft) clips.push({ ...clip, tracks: members })
    }
    kept.push({ ...track, clips })
  }
  return kept
}

export function withoutMedia(project: Project, mediaIds: readonly string[]): Project {
  const removed = new Set(mediaIds)
  const media = project.media.filter((reference) => !removed.has(reference.id))
  if (media.length === project.media.length) return project
  return { ...project, media, tracks: tracksWithoutMedia(project.tracks, removed) }
}

export function placeableMedia(project: Project, mediaStates: MediaStates, mediaIds: readonly string[], newClipId: (index: number) => string): DroppedMedia[] {
  const placeable: DroppedMedia[] = []
  for (const mediaId of mediaIds) {
    const reference = project.media.find((candidate) => candidate.id === mediaId)
    const state = mediaStates[mediaId]
    if (reference === undefined || state === undefined || 'error' in state) continue
    placeable.push({ reference, info: state.info, clipId: newClipId(placeable.length) })
  }
  return placeable
}

export function dropMedia(project: Project, drop: MediaDrop): Project {
  if (drop.media.length === 0) return project
  const firstPicture = drop.media.find((item) => item.info.kind !== 'audio')
  const canvas = hasClips(project) || firstPicture === undefined ? project.canvas : canvasForFirstClip(firstPicture.info, project.canvas)
  let prepared: Project = { ...project, canvas }
  const clips: Clip[] = []
  let start = drop.start
  for (const item of drop.media) {
    const clip = clipForMedia(item.reference.id, item.info, canvas, item.clipId, start, drop.stillDuration)
    clips.push(clip)
    start = endOf(clip)
    prepared = withMedia(prepared, item.reference)
  }
  return placeOnTrack(prepared, { clips, trackIndex: drop.trackIndex, newTrack: drop.newTrack })
}
