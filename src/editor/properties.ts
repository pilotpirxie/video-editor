import { valueAt, type MediaStates } from '../engine/resolve.js'
import type { Size } from '../shared/exportPresets.js'
import { MAX_CANVAS, MIN_CANVAS, type AnimatableProperty, type Clip, type Crop, type Keyframe, type Project, type Transform } from '../shared/project.js'
import { MAX_SPEED_PERCENT, MIN_SPEED_PERCENT, TIMELINE_GRID, type FrameRate } from '../shared/time.js'
import { editClips, hasSource, isVisual, locateClip, withFadesWithin } from './clips.js'
import { neighbours, sourceDuration, timelineSpan, trimClip } from './moveTrim.js'

function clampWhole(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.round(value), min), max)
}

export function setCanvasSize(project: Project, size: Size): Project {
  const width = clampWhole(size.width, MIN_CANVAS.width, MAX_CANVAS.width)
  const height = clampWhole(size.height, MIN_CANVAS.height, MAX_CANVAS.height)
  if (width === project.canvas.width && height === project.canvas.height) return project
  return { ...project, canvas: { ...project.canvas, width, height } }
}

export function setFrameRate(project: Project, frameRate: FrameRate): Project {
  const current = project.canvas.frameRate
  if (current.num === frameRate.num && current.den === frameRate.den) return project
  return { ...project, canvas: { ...project.canvas, frameRate } }
}

const NO_CROP: Crop = { left: 0, top: 0, right: 0, bottom: 0 }
const MAX_VOLUME = 2
const ANIMATABLE: readonly AnimatableProperty[] = ['x', 'y', 'scaleX', 'scaleY', 'rotation', 'opacity', 'cropLeft', 'cropTop', 'cropRight', 'cropBottom', 'volume']

export type PropertyValues = Partial<Record<AnimatableProperty, number>>
export type Fade = 'fadeIn' | 'fadeOut' | 'volumeFadeIn' | 'volumeFadeOut'

function cropSide(property: AnimatableProperty): keyof Crop | undefined {
  if (property === 'cropLeft') return 'left'
  if (property === 'cropTop') return 'top'
  if (property === 'cropRight') return 'right'
  if (property === 'cropBottom') return 'bottom'
  return undefined
}

function isTransformProperty(property: AnimatableProperty): property is keyof Transform {
  return property === 'x' || property === 'y' || property === 'scaleX' || property === 'scaleY' || property === 'rotation'
}

// The value a property has while nothing animates it; undefined when this kind of clip does not have the property at all.
function baseValue(clip: Clip, property: AnimatableProperty): number | undefined {
  if (property === 'volume') return hasSource(clip) ? clip.volume : undefined
  if (clip.type === 'audio') return undefined
  if (property === 'opacity') return clip.opacity
  if (isTransformProperty(property)) return clip.transform[property]
  const side = cropSide(property)
  if (side === undefined || clip.type === 'text') return undefined
  return (clip.crop ?? NO_CROP)[side]
}

export function propertyAt(clip: Clip, property: AnimatableProperty, time: number): number | undefined {
  const base = baseValue(clip, property)
  if (base === undefined) return undefined
  const keyframes = clip.keyframes?.[property]
  return keyframes === undefined ? base : (valueAt(keyframes, time - clip.start) ?? base)
}

function limited(property: AnimatableProperty, value: number): number {
  if (property === 'opacity') return Math.min(1, Math.max(0, value))
  if (property === 'volume') return Math.min(MAX_VOLUME, Math.max(0, value))
  if (property === 'x' || property === 'y' || property === 'rotation') return value
  return Math.max(0, value)
}

function withBaseValue(clip: Clip, property: AnimatableProperty, value: number): Clip {
  if (property === 'volume') return hasSource(clip) ? { ...clip, volume: value } : clip
  if (clip.type === 'audio') return clip
  if (property === 'opacity') return { ...clip, opacity: value }
  if (isTransformProperty(property)) return { ...clip, transform: { ...clip.transform, [property]: value } }
  const side = cropSide(property)
  if (side === undefined || clip.type === 'text') return clip
  const crop = { ...(clip.crop ?? NO_CROP), [side]: value }
  const cropsNothing = crop.left === 0 && crop.top === 0 && crop.right === 0 && crop.bottom === 0
  return { ...clip, crop: cropsNothing ? undefined : crop }
}

function withKeyframeAt(keyframes: readonly Keyframe[], time: number, value: number): Keyframe[] {
  const existing = keyframes.find((keyframe) => keyframe.time === time)
  if (existing !== undefined) return keyframes.map((keyframe) => (keyframe === existing ? { ...keyframe, value } : keyframe))
  return [...keyframes, { time, value, easing: 'linear' as const }].sort((a, b) => a.time - b.time)
}

// A property that is already animated gets a keyframe at the given time, so the change is seen at once; setting only its resting value would be hidden behind the animation.
function withProperty(clip: Clip, property: AnimatableProperty, value: number, time: number): Clip {
  const current = propertyAt(clip, property, time)
  const next = limited(property, value)
  if (current === undefined || current === next) return clip
  const keyframes = clip.keyframes?.[property]
  if (keyframes === undefined) return withBaseValue(clip, property, next)
  const inside = Math.min(clip.duration, Math.max(0, time - clip.start))
  const local = Math.round(inside / TIMELINE_GRID) * TIMELINE_GRID
  return { ...clip, keyframes: { ...clip.keyframes, [property]: withKeyframeAt(keyframes, local, next) } }
}

export function setProperties(project: Project, clipIds: readonly string[], values: PropertyValues, time: number): Project {
  return editClips(project, new Set(clipIds), (clip) => {
    let edited = clip
    for (const property of ANIMATABLE) {
      const value = values[property]
      if (value !== undefined) edited = withProperty(edited, property, value, time)
    }
    return edited
  })
}

export function setDuration(project: Project, clipIds: readonly string[], duration: number, frameTicks: number, mediaStates: MediaStates): Project {
  let edited = project
  for (const clipId of clipIds) {
    const located = locateClip(edited, clipId)
    if (located === undefined) continue
    edited = trimClip(edited, { clipId, edge: 'end', time: located.clip.start + duration, isRipple: false, frameTicks, mediaStates })
  }
  return edited
}

export function setSourceStart(project: Project, clipIds: readonly string[], sourceStart: number, mediaStates: MediaStates): Project {
  return editClips(project, new Set(clipIds), (clip) => {
    if (!hasSource(clip)) return clip
    const used = (clip.duration / TIMELINE_GRID) * clip.speedPercent
    const available = sourceDuration(clip, mediaStates) ?? Infinity
    const latest = Math.max(0, available - used)
    const start = Math.round(Math.min(latest, Math.max(0, sourceStart)))
    return start === clip.sourceStart ? clip : { ...clip, sourceStart: start }
  })
}

// Changing the speed keeps the same stretch of source, so the clip gets shorter or longer; it stops growing at the next clip.
export function setSpeed(project: Project, clipIds: readonly string[], speedPercent: number): Project {
  const speed = Math.min(MAX_SPEED_PERCENT, Math.max(MIN_SPEED_PERCENT, Math.round(speedPercent)))
  let edited = project
  for (const clipId of clipIds) {
    const located = locateClip(edited, clipId)
    if (located === undefined || !hasSource(located.clip) || located.clip.speedPercent === speed) continue
    const { clip, track } = located
    const used = (clip.duration / TIMELINE_GRID) * clip.speedPercent
    const room = neighbours(track, clip).nextStart - clip.start
    const duration = Math.max(TIMELINE_GRID, Math.min(room, Math.floor(used / speed) * TIMELINE_GRID))
    edited = editClips(edited, new Set([clipId]), (found) => (hasSource(found) ? withFadesWithin({ ...found, speedPercent: speed, duration }) : found))
  }
  return edited
}

// Only an animated image can loop. Switching the loop off ends the clip where one play of its source ends.
export function setLoop(project: Project, clipIds: readonly string[], isLooping: boolean, mediaStates: MediaStates): Project {
  return editClips(project, new Set(clipIds), (clip) => {
    if (clip.type !== 'video' || (clip.loop === true) === isLooping) return clip
    const state = mediaStates[clip.mediaId]
    if (state === undefined || 'error' in state || state.info.kind !== 'video' || state.info.isAnimatedImage !== true) return clip
    if (isLooping) return { ...clip, loop: true }

    const { loop: _loop, ...once } = clip
    const sourceStart = clip.sourceStart % state.info.duration
    const longest = Math.max(TIMELINE_GRID, timelineSpan(state.info.duration - sourceStart, clip.speedPercent))
    return withFadesWithin({ ...once, sourceStart, duration: Math.min(clip.duration, longest) })
  })
}

function withFade(clip: Clip, fade: Fade, length: number | undefined): Clip {
  const isVolumeFade = fade === 'volumeFadeIn' || fade === 'volumeFadeOut'
  if (isVolumeFade) return hasSource(clip) ? { ...clip, [fade]: length } : clip
  return isVisual(clip) ? { ...clip, [fade]: length } : clip
}

export function setFade(project: Project, clipIds: readonly string[], fade: Fade, length: number): Project {
  return editClips(project, new Set(clipIds), (clip) => {
    const onGrid = Math.round(Math.min(clip.duration, Math.max(0, length)) / TIMELINE_GRID) * TIMELINE_GRID
    return withFade(clip, fade, onGrid === 0 ? undefined : onGrid)
  })
}

// What a field shows for several clips: their common value, or nothing when they differ.
export function sharedValue<Value>(values: readonly Value[]): Value | undefined {
  const [first] = values
  return values.every((value) => value === first) ? first : undefined
}
