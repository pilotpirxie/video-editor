import { clipAnimationCurves, type AnimationCurves } from '../engine/presets.js'
import { valueAt, type AnimatableProperty, type Animation, type AnimationType, type Clip, type Keyframe, type Keyframes, type Project } from '../shared/project.js'
import { TICKS_PER_SECOND, TIMELINE_GRID } from '../shared/time.js'
import { editClips, isVisual } from './clips.js'

export type AnimationEdge = 'in' | 'out'

export const DEFAULT_ANIMATION = TICKS_PER_SECOND / 2

// What each animation is called in the editor. A slide comes in from the side it is named after, and goes out to that side.
export const ANIMATION_NAMES: Record<AnimationType, string> = {
  fade: 'Fade',
  pop: 'Pop',
  slideLeft: 'Slide, left side',
  slideRight: 'Slide, right side',
  slideUp: 'Slide, top',
  slideDown: 'Slide, bottom',
  zoom: 'Zoom',
  typewriter: 'Typewriter',
}

// Only a text clip has letters to show one after the other.
export function takesAnimation(clip: Clip, type: AnimationType): boolean {
  if (!isVisual(clip)) return false
  return type !== 'typewriter' || clip.type === 'text'
}

// Sets, changes or (with no animation) takes away how the chosen clips come in or go out. An animation is never longer than its clip.
export function setAnimation(project: Project, clipIds: readonly string[], edge: AnimationEdge, animation: Animation | undefined): Project {
  const key = edge === 'in' ? 'animationIn' : 'animationOut'
  return editClips(project, new Set(clipIds), (clip) => {
    if (!isVisual(clip)) return clip
    const current = clip[key]
    if (animation === undefined) return current === undefined ? clip : { ...clip, [key]: undefined }
    if (!takesAnimation(clip, animation.type)) return clip
    const onGrid = Math.round(animation.duration / TIMELINE_GRID) * TIMELINE_GRID
    const duration = Math.min(clip.duration, Math.max(TIMELINE_GRID, onGrid))
    const isUnchanged = current !== undefined && current.type === animation.type && current.duration === duration
    return isUnchanged ? clip : { ...clip, [key]: { type: animation.type, duration } }
  })
}

type Combined = {
  property: AnimatableProperty
  curve: keyof AnimationCurves
  // A factor is multiplied with the clip's own value, anything else is added to it.
  isFactor: boolean
}

const COMBINED: readonly Combined[] = [
  { property: 'opacity', curve: 'opacity', isFactor: true },
  { property: 'scaleX', curve: 'scale', isFactor: true },
  { property: 'scaleY', curve: 'scale', isFactor: true },
  { property: 'x', curve: 'x', isFactor: false },
  { property: 'y', curve: 'y', isFactor: false },
]

// The easing of the stretch a time lies in: that of the last keyframe at or before it.
function easingAt(keyframes: readonly Keyframe[], time: number): Keyframe['easing'] | undefined {
  let easing: Keyframe['easing'] | undefined
  for (const keyframe of keyframes) {
    if (keyframe.time > time) break
    easing = keyframe.easing
  }
  const isPastTheEnd = (keyframes.at(-1)?.time ?? Infinity) <= time
  return isPastTheEnd ? undefined : easing
}

// The clip's own keyframes of one property with the curves of its animations worked in.
// Exact where one curve moves at a time; where two overlap, the values at the keyframes are right and the way between them is that of the first.
function mergedKeyframes(own: readonly Keyframe[], base: number, curves: readonly Keyframe[][], isFactor: boolean): Keyframe[] {
  const times = new Set<number>()
  for (const list of [own, ...curves]) {
    for (const keyframe of list) times.add(keyframe.time)
  }
  const merged: Keyframe[] = []
  for (const time of [...times].sort((a, b) => a - b)) {
    let value = valueAt(own, time) ?? base
    let easing: Keyframe['easing'] | undefined
    for (const curve of curves) {
      const change = valueAt(curve, time) ?? (isFactor ? 1 : 0)
      value = isFactor ? value * change : value + change
      easing ??= easingAt(curve, time)
    }
    merged.push({ time, value, easing: easing ?? easingAt(own, time) ?? 'linear' })
  }
  return merged
}

function baseOf(clip: Extract<Clip, { opacity: number }>, property: AnimatableProperty): number {
  if (property === 'opacity') return clip.opacity
  if (property === 'x' || property === 'y' || property === 'scaleX' || property === 'scaleY') return clip.transform[property]
  return 0
}

// Turns the animations of the chosen clips into keyframes that draw the same picture, so they can be changed by hand.
// A typewriter stays an animation: no property of a clip holds how many letters are shown.
export function convertAnimations(project: Project, clipIds: readonly string[]): Project {
  return editClips(project, new Set(clipIds), (clip) => {
    if (!isVisual(clip)) return clip
    const animationIn = clip.animationIn?.type === 'typewriter' ? undefined : clip.animationIn
    const animationOut = clip.animationOut?.type === 'typewriter' ? undefined : clip.animationOut
    if (animationIn === undefined && animationOut === undefined) return clip

    const curves = clipAnimationCurves({ duration: clip.duration, animationIn, animationOut }, project.canvas)
    const keyframes: Keyframes = { ...clip.keyframes }
    for (const { property, curve, isFactor } of COMBINED) {
      const moving: Keyframe[][] = []
      for (const entry of curves) {
        const list = entry[curve]
        if (list !== undefined) moving.push(list)
      }
      if (moving.length > 0) keyframes[property] = mergedKeyframes(clip.keyframes?.[property] ?? [], baseOf(clip, property), moving, isFactor)
    }
    return {
      ...clip,
      keyframes,
      animationIn: clip.animationIn === animationIn ? undefined : clip.animationIn,
      animationOut: clip.animationOut === animationOut ? undefined : clip.animationOut,
    }
  })
}
