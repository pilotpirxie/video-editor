import type { Size } from '../shared/exportPresets.js'
import type { MediaInfo } from '../shared/mediaProtocol.js'
import { MAX_CANVAS, MIN_CANVAS, type Canvas, type Clip, type MediaRef, type Project, type Transform } from '../shared/project.js'
import { NORMAL_SPEED_PERCENT, PROJECT_FRAME_RATES, TICKS_PER_SECOND, frameDuration, type FrameRate } from '../shared/time.js'
import { placeOnTrack, type NewTrack } from './clips.js'

const STILL_DURATION = 5 * TICKS_PER_SECOND

export type MediaDrop = {
  reference: MediaRef
  info: MediaInfo
  clipId: string
  start: number
  trackIndex: number
  newTrack: NewTrack
}

function wholeFrames(duration: number, frameTicks: number): number {
  return Math.max(1, Math.floor(duration / frameTicks)) * frameTicks
}

function centred(natural: Size, canvas: Canvas): Transform {
  const fit = Math.min(1, canvas.width / natural.width, canvas.height / natural.height)
  return { x: canvas.width / 2, y: canvas.height / 2, scaleX: fit, scaleY: fit, rotation: 0 }
}

// A new clip shows the whole picture: centred and scaled down to fit, never enlarged.
export function clipForMedia(mediaId: string, info: MediaInfo, canvas: Canvas, clipId: string, start: number): Clip {
  const frameTicks = frameDuration(canvas.frameRate)
  if (info.kind === 'image') {
    return { id: clipId, type: 'image', mediaId, start, duration: STILL_DURATION, transform: centred(info, canvas), opacity: 1 }
  }
  const source = { mediaId, sourceStart: 0, speedPercent: NORMAL_SPEED_PERCENT, volume: 1 }
  const timing = { id: clipId, start, duration: wholeFrames(info.duration, frameTicks) }
  if (info.kind === 'audio') return { ...timing, ...source, type: 'audio' }
  return { ...timing, ...source, type: 'video', transform: centred(info.video, canvas), opacity: 1 }
}

function nearestProjectFrameRate(frameTicks: number): FrameRate {
  let nearest = PROJECT_FRAME_RATES[0] ?? { num: 30, den: 1 }
  for (const rate of PROJECT_FRAME_RATES) {
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

// The first clip decides what the project looks like: its size, and for video its frame rate.
export function canvasForFirstClip(info: MediaInfo, canvas: Canvas): Canvas {
  if (info.kind === 'audio') return canvas
  if (info.kind === 'image') return { ...canvas, ...canvasSizeFor(info) }
  return { ...canvasSizeFor(info.video), frameRate: nearestProjectFrameRate(info.video.frameDuration) }
}

function hasClips(project: Project): boolean {
  return project.tracks.some((track) => track.clips.length > 0)
}

export function withMedia(project: Project, reference: MediaRef): Project {
  if (project.media.some((existing) => existing.id === reference.id)) return project
  return { ...project, media: [...project.media, reference] }
}

export function dropMedia(project: Project, drop: MediaDrop): Project {
  const canvas = hasClips(project) ? project.canvas : canvasForFirstClip(drop.info, project.canvas)
  const clip = clipForMedia(drop.reference.id, drop.info, canvas, drop.clipId, drop.start)
  const prepared = withMedia({ ...project, canvas }, drop.reference)
  return placeOnTrack(prepared, { clips: [clip], trackIndex: drop.trackIndex, newTrack: drop.newTrack })
}
