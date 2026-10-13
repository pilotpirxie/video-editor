import type { MediaStates } from '../engine/resolve.js'
import type { Size } from '../shared/exportPresets.js'
import { MAX_CANVAS, MIN_CANVAS, valueAt, type AnimatableProperty, type Clip, type Crop, type Easing, type Keyframe, type Keyframes, type Project, type Transform } from '../shared/project.js'
import { MAX_SPEED_PERCENT, MIN_SPEED_PERCENT, TIMELINE_GRID, type FrameRate } from '../shared/time.js'
import { editClips, hasSource, hasVolume, isCroppable, isVisual, locateClip, withFadesWithin } from './clips.js'
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
  if (property === 'volume') return hasVolume(clip) ? clip.volume : undefined
  if (clip.type === 'audio') return undefined
  if (property === 'opacity') return clip.opacity
  if (isTransformProperty(property)) return clip.transform[property]
  const side = cropSide(property)
  if (side === undefined || !isCroppable(clip)) return undefined
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
  if (property === 'volume') return hasVolume(clip) ? { ...clip, volume: value } : clip
  if (clip.type === 'audio') return clip
  if (property === 'opacity') return { ...clip, opacity: value }
  if (isTransformProperty(property)) return { ...clip, transform: { ...clip.transform, [property]: value } }
  const side = cropSide(property)
  if (side === undefined || !isCroppable(clip)) return clip
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
  return { ...clip, keyframes: { ...clip.keyframes, [property]: withKeyframeAt(keyframes, localGridTime(clip, time), next) } }
}

// The moment of a clip that a project time falls on, on the time grid and inside the clip.
function localGridTime(clip: Clip, time: number): number {
  const inside = Math.min(clip.duration, Math.max(0, time - clip.start))
  return Math.round(inside / TIMELINE_GRID) * TIMELINE_GRID
}

// A group is scaled by one number, so either of its two scales sets both.
function evenlyScaled(values: PropertyValues): PropertyValues {
  const scale = values.scaleX ?? values.scaleY
  return scale === undefined ? values : { ...values, scaleX: scale, scaleY: scale }
}

export function setProperties(project: Project, clipIds: readonly string[], values: PropertyValues, time: number): Project {
  return editClips(project, new Set(clipIds), (clip) => {
    const wanted = clip.type === 'group' ? evenlyScaled(values) : values
    let edited = clip
    for (const property of ANIMATABLE) {
      const value = wanted[property]
      if (value !== undefined) edited = withProperty(edited, property, value, time)
    }
    return edited
  })
}

function withKeyframeList(clip: Clip, property: AnimatableProperty, list: readonly Keyframe[]): Clip {
  const keyframes: Keyframes = { ...clip.keyframes, [property]: list.length === 0 ? undefined : [...list] }
  const isLeft = Object.values(keyframes).some((other) => other !== undefined)
  return { ...clip, keyframes: isLeft ? keyframes : undefined }
}

// Puts a keyframe at the given time, holding the value the property has there, or takes away the one that is there.
function withKeyframeToggled(clip: Clip, property: AnimatableProperty, time: number): Clip {
  const current = propertyAt(clip, property, time)
  if (current === undefined) return clip
  const local = localGridTime(clip, time)
  const list = clip.keyframes?.[property] ?? []
  const existing = list.find((keyframe) => keyframe.time === local)
  if (existing === undefined) return withKeyframeList(clip, property, withKeyframeAt(list, local, current))
  return withoutKeyframe(clip, property, list, existing)
}

// When the last keyframe goes, the property keeps the value that keyframe had, so nothing jumps.
function withoutKeyframe(clip: Clip, property: AnimatableProperty, list: readonly Keyframe[], removed: Keyframe): Clip {
  const remaining = list.filter((keyframe) => keyframe !== removed)
  const settled = remaining.length === 0 ? withBaseValue(clip, property, removed.value) : clip
  return withKeyframeList(settled, property, remaining)
}

export function toggleKeyframe(project: Project, clipIds: readonly string[], property: AnimatableProperty, time: number): Project {
  return editClips(project, new Set(clipIds), (clip) => {
    const isGroupScale = clip.type === 'group' && (property === 'scaleX' || property === 'scaleY')
    if (!isGroupScale) return withKeyframeToggled(clip, property, time)
    // The two scales of a group are one number, so they are keyed together.
    return withKeyframeToggled(withKeyframeToggled(clip, 'scaleX', time), 'scaleY', time)
  })
}

// Whether the property of a clip has a keyframe at the given time.
export function hasKeyframeAt(clip: Clip, property: AnimatableProperty, time: number): boolean {
  const local = localGridTime(clip, time)
  return clip.keyframes?.[property]?.some((keyframe) => keyframe.time === local) === true
}

export type KeyframeChange = {
  // Measured from the start of the clip. A keyframe never passes its neighbours.
  time?: number
  value?: number
  easing?: Easing
}

// Changes one keyframe of a clip, counted from the first. A change of nothing returns the project as it is.
export function changeKeyframe(project: Project, clipId: string, property: AnimatableProperty, index: number, change: KeyframeChange): Project {
  return editClips(project, new Set([clipId]), (clip) => {
    const list = clip.keyframes?.[property]
    const keyframe = list?.[index]
    if (list === undefined || keyframe === undefined) return clip
    const earliest = (list[index - 1]?.time ?? -Infinity) + TIMELINE_GRID
    const latest = (list[index + 1]?.time ?? Infinity) - TIMELINE_GRID
    const wantedTime = Math.round((change.time ?? keyframe.time) / TIMELINE_GRID) * TIMELINE_GRID
    const next: Keyframe = {
      time: Math.min(latest, Math.max(earliest, wantedTime)),
      value: change.value === undefined ? keyframe.value : limited(property, change.value),
      easing: change.easing ?? keyframe.easing,
    }
    const isUnchanged = next.time === keyframe.time && next.value === keyframe.value && next.easing === keyframe.easing
    return isUnchanged ? clip : withKeyframeList(clip, property, list.with(index, next))
  })
}

export function removeKeyframe(project: Project, clipId: string, property: AnimatableProperty, index: number): Project {
  return editClips(project, new Set([clipId]), (clip) => {
    const list = clip.keyframes?.[property]
    const keyframe = list?.[index]
    return list === undefined || keyframe === undefined ? clip : withoutKeyframe(clip, property, list, keyframe)
  })
}

export type SoundSwitches = {
  changesPitch?: boolean
  hasFastSound?: boolean
}

// How the sound of the chosen clips follows their speed. A switch that is off is left out of the clip, as the file format wants it.
export function setSoundSwitches(project: Project, clipIds: readonly string[], switches: SoundSwitches): Project {
  return editClips(project, new Set(clipIds), (clip) => {
    if (!hasSource(clip)) return clip
    const changesPitch = (switches.changesPitch ?? clip.changesPitch === true) ? true : undefined
    const hasFastSound = (switches.hasFastSound ?? clip.hasFastSound === true) ? true : undefined
    const isUnchanged = changesPitch === clip.changesPitch && hasFastSound === clip.hasFastSound
    return isUnchanged ? clip : { ...clip, changesPitch, hasFastSound }
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
  if (isVolumeFade) return hasVolume(clip) ? { ...clip, [fade]: length } : clip
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
