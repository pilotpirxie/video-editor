import { minimumHalvings } from '../shared/limits.js'
import type { MediaState, VideoInfo } from '../shared/mediaProtocol.js'
import type { AnimatableProperty, Clip, Crop, Easing, Keyframe, Keyframes, Project, TextAlign, Transform, VisualClip } from '../shared/project.js'
import { frameIndexAt, loopedTime, sourceTime } from '../shared/time.js'

const MAX_HALVINGS = 6
const NO_CROP: Crop = { left: 0, top: 0, right: 0, bottom: 0 }

type LayerBase = {
  clipId: string
  transform: Transform
  opacity: number
}

export type VideoLayer = LayerBase & {
  kind: 'video'
  mediaId: string
  video: VideoInfo
  frame: number
  halvings: number
  crop: Crop
}

export type ImageLayer = LayerBase & {
  kind: 'image'
  mediaId: string
  width: number
  height: number
  crop: Crop
}

export type TextLayer = LayerBase & {
  kind: 'text'
  text: string
  family: string
  size: number
  color: string
  align: TextAlign
}

export type Layer = VideoLayer | ImageLayer | TextLayer

export type MediaStates = Readonly<Record<string, MediaState>>

export function ease(easing: Easing, progress: number): number {
  if (easing === 'hold') {
    return 0
  } else if (easing === 'easeIn') {
    return progress * progress * progress
  } else if (easing === 'easeOut') {
    const remaining = 1 - progress
    return 1 - remaining * remaining * remaining
  } else if (easing === 'easeInOut') {
    if (progress < 0.5) return 4 * progress * progress * progress
    const remaining = 1 - progress
    return 1 - 4 * remaining * remaining * remaining
  } else {
    return progress
  }
}

export function valueAt(keyframes: readonly Keyframe[], localTime: number): number | undefined {
  let previous: Keyframe | undefined
  for (const keyframe of keyframes) {
    if (keyframe.time > localTime) {
      if (previous === undefined) return keyframe.value
      const progress = (localTime - previous.time) / (keyframe.time - previous.time)
      return previous.value + (keyframe.value - previous.value) * ease(previous.easing, progress)
    }
    previous = keyframe
  }
  return previous?.value
}

function animated(keyframes: Keyframes | undefined, property: AnimatableProperty, localTime: number, fallback: number): number {
  const track = keyframes?.[property]
  if (track === undefined) return fallback
  return valueAt(track, localTime) ?? fallback
}

export function fadeFactor(localTime: number, duration: number, fadeIn: number | undefined, fadeOut: number | undefined): number {
  let factor = 1
  if (fadeIn !== undefined && localTime < fadeIn) factor *= localTime / fadeIn
  const remaining = duration - localTime
  if (fadeOut !== undefined && remaining < fadeOut) factor *= remaining / fadeOut
  return factor
}

function transformAt(clip: VisualClip, localTime: number): Transform {
  return {
    x: animated(clip.keyframes, 'x', localTime, clip.transform.x),
    y: animated(clip.keyframes, 'y', localTime, clip.transform.y),
    scaleX: animated(clip.keyframes, 'scaleX', localTime, clip.transform.scaleX),
    scaleY: animated(clip.keyframes, 'scaleY', localTime, clip.transform.scaleY),
    rotation: animated(clip.keyframes, 'rotation', localTime, clip.transform.rotation),
  }
}

function cropAt(clip: { crop?: Crop; keyframes?: Keyframes }, localTime: number): Crop {
  const base = clip.crop ?? NO_CROP
  return {
    left: animated(clip.keyframes, 'cropLeft', localTime, base.left),
    top: animated(clip.keyframes, 'cropTop', localTime, base.top),
    right: animated(clip.keyframes, 'cropRight', localTime, base.right),
    bottom: animated(clip.keyframes, 'cropBottom', localTime, base.bottom),
  }
}

function opacityAt(clip: VisualClip, localTime: number): number {
  const opacity = animated(clip.keyframes, 'opacity', localTime, clip.opacity)
  return opacity * fadeFactor(localTime, clip.duration, clip.fadeIn, clip.fadeOut)
}

function largestValue(keyframes: Keyframes | undefined, property: AnimatableProperty, fallback: number): number {
  const track = keyframes?.[property]
  if (track === undefined) return fallback
  let largest = -Infinity
  for (const keyframe of track) largest = Math.max(largest, keyframe.value)
  return largest
}

export function sourceHalvings(video: VideoInfo, clip: VisualClip, outputScale: number): number {
  const largestScale = Math.max(
    largestValue(clip.keyframes, 'scaleX', clip.transform.scaleX),
    largestValue(clip.keyframes, 'scaleY', clip.transform.scaleY),
  )
  const drawnScale = largestScale * outputScale
  const required = minimumHalvings(video.width, video.height)
  if (drawnScale <= 0) return Math.max(required, MAX_HALVINGS)
  const affordable = Math.floor(Math.log2(1 / drawnScale))
  return Math.min(MAX_HALVINGS, Math.max(required, affordable))
}

function layerOf(clip: Clip, time: number, media: MediaStates, outputScale: number): Layer | undefined {
  if (clip.type === 'audio') return undefined
  const localTime = time - clip.start
  const base: LayerBase = { clipId: clip.id, transform: transformAt(clip, localTime), opacity: opacityAt(clip, localTime) }

  if (clip.type === 'text') {
    return { ...base, kind: 'text', text: clip.text, family: clip.font.family, size: clip.font.size, color: clip.color, align: clip.align }
  }

  const state = media[clip.mediaId]
  if (state === undefined || 'error' in state) return undefined
  const info = state.info

  if (clip.type === 'image') {
    if (info.kind !== 'image') return undefined
    return { ...base, kind: 'image', mediaId: clip.mediaId, width: info.width, height: info.height, crop: cropAt(clip, localTime) }
  }

  if (info.kind !== 'video') return undefined
  return {
    ...base,
    kind: 'video',
    mediaId: clip.mediaId,
    video: info.video,
    frame: frameIndexAt(info.video, loopedTime(sourceTime(clip, time), info.duration, clip.loop === true)),
    halvings: sourceHalvings(info.video, clip, outputScale),
    crop: cropAt(clip, localTime),
  }
}

export function resolveFrame(project: Project, media: MediaStates, time: number, outputScale: number): Layer[] {
  const layers: Layer[] = []
  for (const track of project.tracks) {
    if (track.hidden) continue
    for (const clip of track.clips) {
      const isActive = time >= clip.start && time < clip.start + clip.duration
      if (!isActive) continue
      const layer = layerOf(clip, time, media, outputScale)
      if (layer !== undefined) layers.push(layer)
    }
  }
  return layers
}
