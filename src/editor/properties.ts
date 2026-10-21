import { scaledEffect, type MediaStates } from '../engine/resolve.js'
import type { Size } from '../shared/exportPresets.js'
import { MAX_CANVAS, MIN_CANVAS, valueAt, type AnimatableProperty, type Clip, type Crop, type Easing, type Keyframe, type Keyframes, type Project, type Transform } from '../shared/project.js'
import { MAX_SPEED_PERCENT, MIN_SPEED_PERCENT, TIMELINE_GRID, frameAt, frameDuration, type FrameRate } from '../shared/time.js'
import { editClips, endOf, hasSource, hasVolume, isCroppable, isVisual, locateClip, withFadesWithin, withOnlyAtEnd } from './clips.js'
import type { Point } from './geometry.js'
import { shiftLater, sourceDuration, timelineSpan, trimClip } from './moveTrim.js'

function clampWhole(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.round(value), min), max)
}

type Rescale = {
  scale: number
  x(value: number): number
  y(value: number): number
}

function rescaledList(list: readonly Keyframe[] | undefined, map: (value: number) => number): Keyframe[] | undefined {
  return list?.map((keyframe) => ({ ...keyframe, value: map(keyframe.value) }))
}

function rescaledKeyframes(keyframes: Keyframes | undefined, rescale: Rescale): Keyframes | undefined {
  if (keyframes === undefined) return undefined
  const byScale = (value: number): number => value * rescale.scale
  const rescaled: Keyframes = { ...keyframes }
  if (keyframes.x !== undefined) rescaled.x = rescaledList(keyframes.x, rescale.x)
  if (keyframes.y !== undefined) rescaled.y = rescaledList(keyframes.y, rescale.y)
  if (keyframes.scaleX !== undefined) rescaled.scaleX = rescaledList(keyframes.scaleX, byScale)
  if (keyframes.scaleY !== undefined) rescaled.scaleY = rescaledList(keyframes.scaleY, byScale)
  return rescaled
}

function rescaledClip(clip: Clip, rescale: Rescale): Clip {
  if (!isVisual(clip)) return clip
  const { transform } = clip
  const placed = {
    ...clip,
    transform: { ...transform, x: rescale.x(transform.x), y: rescale.y(transform.y), scaleX: transform.scaleX * rescale.scale, scaleY: transform.scaleY * rescale.scale },
    keyframes: rescaledKeyframes(clip.keyframes, rescale),
  }
  if (placed.type === 'blur') return { ...placed, strength: placed.strength * rescale.scale, softEdge: placed.softEdge * rescale.scale }
  if (placed.type === 'highlight') return { ...placed, softEdge: placed.softEdge * rescale.scale }
  if (placed.effects === undefined) return placed
  return { ...placed, effects: placed.effects.map((effect) => scaledEffect(effect, rescale.scale)) }
}

export function setCanvasSize(project: Project, size: Size): Project {
  const width = clampWhole(size.width, MIN_CANVAS.width, MAX_CANVAS.width)
  const height = clampWhole(size.height, MIN_CANVAS.height, MAX_CANVAS.height)
  const { canvas } = project
  if (width === canvas.width && height === canvas.height) return project
  const scale = Math.min(width / canvas.width, height / canvas.height)
  const rescale: Rescale = {
    scale,
    x: (value) => width / 2 + (value - canvas.width / 2) * scale,
    y: (value) => height / 2 + (value - canvas.height / 2) * scale,
  }
  const tracks = project.tracks.map((track) => ({ ...track, clips: track.clips.map((clip) => rescaledClip(clip, rescale)) }))
  const camera = project.camera?.map((zoom) => ({ ...zoom, x: rescale.x(zoom.x), y: rescale.y(zoom.y) }))
  return { ...project, canvas: { ...canvas, width, height }, tracks, camera }
}

export function setFrameRate(project: Project, frameRate: FrameRate): Project {
  const current = project.canvas.frameRate
  if (current.num === frameRate.num && current.den === frameRate.den) return project
  return { ...project, canvas: { ...project.canvas, frameRate } }
}

const NO_CROP: Crop = { left: 0, top: 0, right: 0, bottom: 0 }
const MAX_VOLUME = 2

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

const KEYFRAME_SETS = {
  position: ['x', 'y'],
  size: ['scaleX', 'scaleY'],
  rotation: ['rotation'],
  opacity: ['opacity'],
  crop: ['cropLeft', 'cropTop', 'cropRight', 'cropBottom'],
  volume: ['volume'],
} as const satisfies Record<string, readonly AnimatableProperty[]>

export type KeyframeSet = keyof typeof KEYFRAME_SETS

const ALL_SETS: readonly KeyframeSet[] = ['position', 'size', 'rotation', 'opacity', 'crop', 'volume']
const PATH_STEPS = 16

function propertiesOf(clip: Clip, set: KeyframeSet): AnimatableProperty[] {
  const owned: AnimatableProperty[] = []
  for (const property of KEYFRAME_SETS[set]) {
    if (baseValue(clip, property) !== undefined) owned.push(property)
  }
  return owned
}

function isAnimated(clip: Clip, properties: readonly AnimatableProperty[]): boolean {
  return properties.some((property) => clip.keyframes?.[property] !== undefined)
}

function keyTimeAt(clip: Clip, properties: readonly AnimatableProperty[], time: number, frameTicks: number): number {
  const local = localGridTime(clip, time)
  for (const property of properties) {
    const inFrame = clip.keyframes?.[property]?.find((keyframe) => keyframe.time >= local && keyframe.time < local + frameTicks)
    if (inFrame !== undefined) return inFrame.time
  }
  return local
}

function easingAt(clip: Clip, properties: readonly AnimatableProperty[], local: number): Easing {
  for (const property of properties) {
    const partner = clip.keyframes?.[property]?.find((keyframe) => keyframe.time === local)
    if (partner !== undefined) return partner.easing
  }
  return 'linear'
}

function withKeyframeAt(keyframes: readonly Keyframe[], time: number, value: number, easing: Easing): Keyframe[] {
  const existing = keyframes.find((keyframe) => keyframe.time === time)
  if (existing !== undefined) return keyframes.map((keyframe) => (keyframe === existing ? { ...keyframe, value } : keyframe))
  return [...keyframes, { time, value, easing }].sort((a, b) => a.time - b.time)
}

function withSetKeyed(clip: Clip, properties: readonly AnimatableProperty[], values: PropertyValues, local: number): Clip {
  const easing = easingAt(clip, properties, local)
  let keyed = clip
  for (const property of properties) {
    const wanted = values[property]
    const value = wanted === undefined ? propertyAt(clip, property, clip.start + local) : limited(property, wanted)
    const list = keyed.keyframes?.[property] ?? []
    const existing = list.find((keyframe) => keyframe.time === local)
    if (value === undefined || existing?.value === value) continue
    keyed = withKeyframeList(keyed, property, withKeyframeAt(list, local, value, easing))
  }
  return keyed
}

function withBaseValues(clip: Clip, properties: readonly AnimatableProperty[], values: PropertyValues, time: number): Clip {
  let edited = clip
  for (const property of properties) {
    const wanted = values[property]
    if (wanted === undefined) continue
    const next = limited(property, wanted)
    if (next !== propertyAt(clip, property, time)) edited = withBaseValue(edited, property, next)
  }
  return edited
}

function changedSets(clip: Clip, values: PropertyValues, time: number): AnimatableProperty[][] {
  const changed: AnimatableProperty[][] = []
  for (const set of ALL_SETS) {
    const properties = propertiesOf(clip, set)
    let isChanged = false
    for (const property of properties) {
      const wanted = values[property]
      if (wanted !== undefined && limited(property, wanted) !== propertyAt(clip, property, time)) isChanged = true
    }
    if (isChanged) changed.push(properties)
  }
  return changed
}

function localGridTime(clip: Clip, time: number): number {
  const inside = Math.min(clip.duration, Math.max(0, time - clip.start))
  return Math.round(inside / TIMELINE_GRID) * TIMELINE_GRID
}

function evenlyScaled(values: PropertyValues): PropertyValues {
  const scale = values.scaleX ?? values.scaleY
  return scale === undefined ? values : { ...values, scaleX: scale, scaleY: scale }
}

export function setProperties(project: Project, clipIds: readonly string[], values: PropertyValues, time: number): Project {
  const frameTicks = frameDuration(project.canvas.frameRate)
  return editClips(project, new Set(clipIds), (clip) => {
    const wanted = clip.type === 'group' ? evenlyScaled(values) : values
    const changed = changedSets(clip, wanted, time)
    const isKeyed = changed.some((properties) => isAnimated(clip, properties))
    let edited = clip
    for (const properties of changed) {
      edited = isKeyed ? withSetKeyed(edited, properties, wanted, keyTimeAt(edited, properties, time, frameTicks)) : withBaseValues(edited, properties, wanted, time)
    }
    return edited
  })
}

function withKeyframeList(clip: Clip, property: AnimatableProperty, list: readonly Keyframe[]): Clip {
  const keyframes: Keyframes = { ...clip.keyframes, [property]: list.length === 0 ? undefined : [...list] }
  const isLeft = Object.values(keyframes).some((other) => other !== undefined)
  return { ...clip, keyframes: isLeft ? keyframes : undefined }
}

function withoutKeyframe(clip: Clip, property: AnimatableProperty, list: readonly Keyframe[], removed: Keyframe): Clip {
  const remaining = list.filter((keyframe) => keyframe !== removed)
  const settled = remaining.length === 0 ? withBaseValue(clip, property, removed.value) : clip
  return withKeyframeList(settled, property, remaining)
}

function withoutKeyframesAt(clip: Clip, properties: readonly AnimatableProperty[], local: number): Clip {
  let edited = clip
  for (const property of properties) {
    const list = edited.keyframes?.[property]
    const removed = list?.find((keyframe) => keyframe.time === local)
    if (list !== undefined && removed !== undefined) edited = withoutKeyframe(edited, property, list, removed)
  }
  return edited
}

export function setKeyframesAt(project: Project, clipIds: readonly string[], set: KeyframeSet, time: number, isKeyed: boolean): Project {
  const frameTicks = frameDuration(project.canvas.frameRate)
  return editClips(project, new Set(clipIds), (clip) => {
    const properties = propertiesOf(clip, set)
    if (properties.length === 0) return clip
    const local = keyTimeAt(clip, properties, time, frameTicks)
    return isKeyed ? withSetKeyed(clip, properties, {}, local) : withoutKeyframesAt(clip, properties, local)
  })
}

export function hasKeyframesAt(clip: Clip, set: KeyframeSet, time: number, frameTicks: number): boolean {
  const properties = propertiesOf(clip, set)
  const local = keyTimeAt(clip, properties, time, frameTicks)
  return properties.length > 0 && properties.every((property) => clip.keyframes?.[property]?.some((keyframe) => keyframe.time === local) === true)
}

export function keyframeFrame(clip: Clip, localTime: number, frameTicks: number): number {
  const firstFrame = Math.ceil(clip.start / frameTicks)
  const lastFrame = Math.ceil((clip.start + clip.duration) / frameTicks) - 1
  return Math.min(lastFrame, Math.max(firstFrame, frameAt(clip.start + localTime, frameTicks)))
}

export function nearestKeyframe(clips: readonly Clip[], set: KeyframeSet, time: number, direction: 1 | -1, frameTicks: number): number | undefined {
  const current = frameAt(time, frameTicks)
  let nearest: number | undefined
  for (const clip of clips) {
    for (const property of KEYFRAME_SETS[set]) {
      for (const keyframe of clip.keyframes?.[property] ?? []) {
        if (keyframe.time < 0 || keyframe.time > clip.duration) continue
        const frame = keyframeFrame(clip, keyframe.time, frameTicks)
        const isOnThatSide = direction === 1 ? frame > current : frame < current
        const isCloser = nearest === undefined || Math.abs(frame - current) < Math.abs(nearest - current)
        if (isOnThatSide && isCloser) nearest = frame
      }
    }
  }
  return nearest === undefined ? undefined : nearest * frameTicks
}

export type MotionPath = {
  line: Point[]
  dots: { time: number; point: Point }[]
}

export function motionPath(clip: Clip): MotionPath | undefined {
  if (clip.type === 'audio') return undefined
  const keyframes = [...(clip.keyframes?.x ?? []), ...(clip.keyframes?.y ?? [])]
  if (keyframes.length === 0) return undefined
  const placeAt = (local: number): Point => ({
    x: propertyAt(clip, 'x', clip.start + local) ?? clip.transform.x,
    y: propertyAt(clip, 'y', clip.start + local) ?? clip.transform.y,
  })

  const keyTimes = new Set<number>()
  for (const keyframe of keyframes) {
    if (keyframe.time >= 0 && keyframe.time <= clip.duration) keyTimes.add(keyframe.time)
  }
  const times = [...new Set([0, ...keyTimes, clip.duration])].sort((a, b) => a - b)
  const line: Point[] = []
  for (let index = 1; index < times.length; index += 1) {
    const from = times[index - 1] ?? 0
    const to = times[index] ?? 0
    for (let step = 0; step < PATH_STEPS; step += 1) line.push(placeAt(from + ((to - from) * step) / PATH_STEPS))
  }
  line.push(placeAt(clip.duration))

  const dots = [...keyTimes].sort((a, b) => a - b).map((time) => ({ time, point: placeAt(time) }))
  return { line, dots }
}

export type KeyframeChange = {
  time?: number
  value?: number
  easing?: Easing
}

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

export function setSpeed(project: Project, clipIds: readonly string[], speedPercent: number): Project {
  const speed = Math.min(MAX_SPEED_PERCENT, Math.max(MIN_SPEED_PERCENT, Math.round(speedPercent)))
  let edited = project
  for (const clipId of clipIds) {
    // Located again each time: an earlier clip of the same track may have moved this one.
    const located = locateClip(edited, clipId)
    if (located === undefined || !hasSource(located.clip) || located.clip.speedPercent === speed) continue
    const { clip, track } = located
    const used = (clip.duration / TIMELINE_GRID) * clip.speedPercent
    const duration = Math.max(TIMELINE_GRID, Math.floor(used / speed) * TIMELINE_GRID)
    edited = editClips(edited, new Set([clipId]), (found) => (hasSource(found) ? withFadesWithin({ ...found, speedPercent: speed, duration }) : found))
    edited = shiftLater(edited, track, endOf(clip), duration - clip.duration, clipId)
  }
  return edited
}

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
  if (!isVisual(clip)) return clip
  const faded = { ...clip, [fade]: length }
  return length === undefined ? faded : withOnlyAtEnd(faded, fade === 'fadeIn' ? 'in' : 'out', 'fade')
}

export function setFade(project: Project, clipIds: readonly string[], fade: Fade, length: number): Project {
  return editClips(project, new Set(clipIds), (clip) => {
    const onGrid = Math.round(Math.min(clip.duration, Math.max(0, length)) / TIMELINE_GRID) * TIMELINE_GRID
    return withFade(clip, fade, onGrid === 0 ? undefined : onGrid)
  })
}

export function sharedValue<Value>(values: readonly Value[]): Value | undefined {
  const [first] = values
  return values.every((value) => value === first) ? first : undefined
}
