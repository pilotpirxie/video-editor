import type { Size } from '../shared/exportPresets.js'
import { valueAt, type AnimationPreset, type Keyframe } from '../shared/project.js'
import { TIMELINE_GRID } from '../shared/time.js'

const POP_OVERSHOOT = 1.1
const POP_PEAK_AT = 0.6
const ZOOM_FROM = 0.5

export type AnimationCurves = {
  opacity?: Keyframe[]
  scale?: Keyframe[]
  x?: Keyframe[]
  y?: Keyframe[]
  letters?: Keyframe[]
}

export type AnimatedClip = {
  duration: number
  animationIn?: AnimationPreset
  animationOut?: AnimationPreset
}

export type AnimationChange = {
  opacity: number
  scale: number
  offsetX: number
  offsetY: number
  letters: number | undefined
}

function onGrid(time: number): number {
  return Math.round(time / TIMELINE_GRID) * TIMELINE_GRID
}

function curvesIn(animation: AnimationPreset, canvas: Size): AnimationCurves {
  const { type, duration } = animation
  function rise(from: number, to: number, easing: Keyframe['easing']): Keyframe[] {
    return [
      { time: 0, value: from, easing },
      { time: duration, value: to, easing: 'linear' },
    ]
  }
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

function mirrored(keyframes: readonly Keyframe[], clipDuration: number): Keyframe[] {
  const backwards: Keyframe[] = []
  for (let index = keyframes.length - 1; index >= 0; index--) {
    const keyframe = keyframes[index]
    const earlier = keyframes[index - 1]
    if (keyframe === undefined) continue
    const easing = earlier === undefined ? 'linear' : MIRRORED_EASING[earlier.easing]
    backwards.push({ time: clipDuration - keyframe.time, value: keyframe.value, easing })
  }
  return backwards
}

export function animationCurves(animation: AnimationPreset, edge: 'in' | 'out', clipDuration: number, canvas: Size): AnimationCurves {
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

function clipAnimationCurves(clip: AnimatedClip, canvas: Size): AnimationCurves[] {
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

export function largestAnimationScale(clip: AnimatedClip): number {
  const isPopping = clip.animationIn?.type === 'pop' || clip.animationOut?.type === 'pop'
  return isPopping ? POP_OVERSHOOT : 1
}
