import type { Size } from '../shared/exportPresets.js'
import { valueAt, type Animation, type Keyframe } from '../shared/project.js'
import { TIMELINE_GRID } from '../shared/time.js'

const POP_OVERSHOOT = 1.1
const POP_PEAK_AT = 0.6
const ZOOM_FROM = 0.5

// What an animation changes, as keyframes in the time of its clip. Opacity and scale are multiplied with what the clip has, x and y are added;
// `letters` is the share of a text's letters that is shown. Written as keyframes, an animation can be turned into the clip's own.
export type AnimationCurves = {
  opacity?: Keyframe[]
  scale?: Keyframe[]
  x?: Keyframe[]
  y?: Keyframe[]
  letters?: Keyframe[]
}

export type AnimatedClip = {
  duration: number
  animationIn?: Animation
  animationOut?: Animation
}

// What the animations of a clip make of it at one moment.
export type AnimationChange = {
  opacity: number
  scale: number
  offsetX: number
  offsetY: number
  // Undefined when all letters are shown.
  letters: number | undefined
}

function onGrid(time: number): number {
  return Math.round(time / TIMELINE_GRID) * TIMELINE_GRID
}

// An animation that brings a clip in, from time 0 of the clip.
function curvesIn(animation: Animation, canvas: Size): AnimationCurves {
  const { type, duration } = animation
  const rise = (from: number, to: number, easing: Keyframe['easing']): Keyframe[] => [
    { time: 0, value: from, easing },
    { time: duration, value: to, easing: 'linear' },
  ]
  if (type === 'fade') return { opacity: rise(0, 1, 'linear') }
  if (type === 'zoom') return { opacity: rise(0, 1, 'linear'), scale: rise(ZOOM_FROM, 1, 'easeOut') }
  if (type === 'typewriter') return { letters: rise(0, 1, 'linear') }
  if (type === 'slideLeft') return { x: rise(-canvas.width, 0, 'easeOut') }
  if (type === 'slideRight') return { x: rise(canvas.width, 0, 'easeOut') }
  if (type === 'slideUp') return { y: rise(-canvas.height, 0, 'easeOut') }
  if (type === 'slideDown') return { y: rise(canvas.height, 0, 'easeOut') }
  return {
    scale: [
      { time: 0, value: 0, easing: 'easeOut' },
      { time: onGrid(duration * POP_PEAK_AT), value: POP_OVERSHOOT, easing: 'easeInOut' },
      { time: duration, value: 1, easing: 'linear' },
    ],
  }
}

const MIRRORED_EASING: Record<Keyframe['easing'], Keyframe['easing']> = { linear: 'linear', easeIn: 'easeOut', easeOut: 'easeIn', easeInOut: 'easeInOut', hold: 'hold' }

// The same move played backwards, ending with the clip: each stretch between two keyframes keeps its shape, turned around.
function mirrored(keyframes: readonly Keyframe[], clipDuration: number): Keyframe[] {
  const backwards: Keyframe[] = []
  for (let index = keyframes.length - 1; index >= 0; index--) {
    const keyframe = keyframes[index]
    const earlier = keyframes[index - 1]
    if (keyframe === undefined) continue
    backwards.push({ time: clipDuration - keyframe.time, value: keyframe.value, easing: earlier === undefined ? 'linear' : MIRRORED_EASING[earlier.easing] })
  }
  return backwards
}

export function animationCurves(animation: Animation, edge: 'in' | 'out', clipDuration: number, canvas: Size): AnimationCurves {
  const arriving = curvesIn(animation, canvas)
  if (edge === 'in') return arriving
  const leaving: AnimationCurves = {}
  if (arriving.opacity !== undefined) leaving.opacity = mirrored(arriving.opacity, clipDuration)
  if (arriving.scale !== undefined) leaving.scale = mirrored(arriving.scale, clipDuration)
  if (arriving.x !== undefined) leaving.x = mirrored(arriving.x, clipDuration)
  if (arriving.y !== undefined) leaving.y = mirrored(arriving.y, clipDuration)
  if (arriving.letters !== undefined) leaving.letters = mirrored(arriving.letters, clipDuration)
  return leaving
}

// The curves of both animations of a clip; where both change the same thing, a clip has two curves for it.
export function clipAnimationCurves(clip: AnimatedClip, canvas: Size): AnimationCurves[] {
  const curves: AnimationCurves[] = []
  if (clip.animationIn !== undefined) curves.push(animationCurves(clip.animationIn, 'in', clip.duration, canvas))
  if (clip.animationOut !== undefined) curves.push(animationCurves(clip.animationOut, 'out', clip.duration, canvas))
  return curves
}

export function animationChangeAt(clip: AnimatedClip, localTime: number, canvas: Size): AnimationChange | undefined {
  if (clip.animationIn === undefined && clip.animationOut === undefined) return undefined
  const change: AnimationChange = { opacity: 1, scale: 1, offsetX: 0, offsetY: 0, letters: undefined }
  for (const curves of clipAnimationCurves(clip, canvas)) {
    if (curves.opacity !== undefined) change.opacity *= valueAt(curves.opacity, localTime) ?? 1
    if (curves.scale !== undefined) change.scale *= valueAt(curves.scale, localTime) ?? 1
    if (curves.x !== undefined) change.offsetX += valueAt(curves.x, localTime) ?? 0
    if (curves.y !== undefined) change.offsetY += valueAt(curves.y, localTime) ?? 0
    if (curves.letters !== undefined) change.letters = Math.min(change.letters ?? 1, valueAt(curves.letters, localTime) ?? 1)
  }
  if (change.letters !== undefined && change.letters >= 1) change.letters = undefined
  return change
}

// The largest factor the animations of a clip scale it by. It decides how large a text is drawn and a video decoded.
export function largestAnimationScale(clip: AnimatedClip): number {
  const isPopping = clip.animationIn?.type === 'pop' || clip.animationOut?.type === 'pop'
  return isPopping ? POP_OVERSHOOT : 1
}
