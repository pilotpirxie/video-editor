import { describe, expect, it } from 'vitest'
import { ANIMATION_TYPES, valueAt, type Keyframe } from '../shared/project.js'
import { isOnTimelineGrid } from '../shared/time.js'
import { animationChangeAt, animationCurves, largestAnimationScale, type AnimationCurves } from './presets.js'

const SECOND = 24_000_000
const CANVAS = { width: 1920, height: 1080 }

function listsOf(curves: AnimationCurves): Keyframe[][] {
  return [curves.opacity, curves.scale, curves.x, curves.y, curves.letters].filter((list) => list !== undefined)
}

describe('animationCurves', () => {
  it('ends every way in with the clip as it is, and starts every way out with it', () => {
    for (const type of ANIMATION_TYPES) {
      const arriving = animationCurves({ type, duration: SECOND }, 'in', 5 * SECOND, CANVAS)
      const leaving = animationCurves({ type, duration: SECOND }, 'out', 5 * SECOND, CANVAS)
      for (const curve of [arriving.opacity, arriving.scale, arriving.letters]) expect(curve?.at(-1)?.value ?? 1, type).toBe(1)
      for (const curve of [arriving.x, arriving.y]) expect(curve?.at(-1)?.value ?? 0, type).toBe(0)
      for (const curve of [leaving.opacity, leaving.scale, leaving.letters]) expect(curve?.[0]?.value ?? 1, type).toBe(1)
      for (const curve of [leaving.x, leaving.y]) expect(curve?.[0]?.value ?? 0, type).toBe(0)
      expect(listsOf(arriving).length, type).toBeGreaterThan(0)
    }
  })

  it('keeps every keyframe on the time grid, so the curves can become keyframes of the clip', () => {
    for (const type of ANIMATION_TYPES) {
      for (const edge of ['in', 'out'] as const) {
        const curves = animationCurves({ type, duration: 1_234_500 }, edge, 7 * SECOND, CANVAS)
        for (const list of listsOf(curves)) {
          for (const keyframe of list) expect(isOnTimelineGrid(keyframe.time), `${type} ${edge}`).toBe(true)
        }
      }
    }
  })

  it('plays the way out as the way in backwards', () => {
    for (const type of ANIMATION_TYPES) {
      const arriving = animationCurves({ type, duration: 2 * SECOND }, 'in', 6 * SECOND, CANVAS)
      const leaving = animationCurves({ type, duration: 2 * SECOND }, 'out', 6 * SECOND, CANVAS)
      const pairs = [[arriving.opacity, leaving.opacity], [arriving.scale, leaving.scale], [arriving.x, leaving.x], [arriving.y, leaving.y], [arriving.letters, leaving.letters]]
      for (const [forwards, backwards] of pairs) {
        if (forwards === undefined || backwards === undefined) continue
        for (const sinceStart of [0, 0.3 * SECOND, SECOND, 1.3 * SECOND, 2 * SECOND]) {
          expect(valueAt(backwards, 6 * SECOND - sinceStart), `${type} at ${sinceStart}`).toBeCloseTo(valueAt(forwards, sinceStart) ?? Number.NaN, 9)
        }
      }
    }
  })
})

describe('animationChangeAt', () => {
  it('is nothing for a clip without animations', () => {
    expect(animationChangeAt({ duration: SECOND }, 0, CANVAS)).toBeUndefined()
  })

  it('combines the way in and the way out where they overlap', () => {
    const clip = { duration: 2 * SECOND, animationIn: { type: 'fade', duration: 2 * SECOND }, animationOut: { type: 'fade', duration: 2 * SECOND } } as const
    expect(animationChangeAt(clip, SECOND, CANVAS)).toEqual({ opacity: 0.25, scale: 1, offsetX: 0, offsetY: 0, letters: undefined })
  })

  it('holds the first and the last value outside the clip, where a transition may draw it', () => {
    const clip = { duration: 2 * SECOND, animationIn: { type: 'slideRight', duration: SECOND }, animationOut: { type: 'zoom', duration: SECOND } } as const
    expect(animationChangeAt(clip, -SECOND, CANVAS)).toMatchObject({ offsetX: 1920, opacity: 1, scale: 1 })
    expect(animationChangeAt(clip, 3 * SECOND, CANVAS)).toMatchObject({ offsetX: 0, opacity: 0, scale: 0.5 })
  })
})

describe('largestAnimationScale', () => {
  it('is more than 1 only for a pop', () => {
    expect(largestAnimationScale({ duration: SECOND })).toBe(1)
    expect(largestAnimationScale({ duration: SECOND, animationIn: { type: 'zoom', duration: SECOND } })).toBe(1)
    expect(largestAnimationScale({ duration: SECOND, animationOut: { type: 'pop', duration: SECOND } })).toBe(1.1)
  })
})
