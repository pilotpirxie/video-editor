import { describe, expect, it } from 'vitest'
import { MEDIA_STATES, SECOND, clipOf, groupClip, projectOf, reopened, textClip, track, videoClip } from '../../test/fixtures.js'
import { resolveFrame } from '../engine/resolve.js'
import type { Project } from '../shared/project.js'
import { convertAnimations, setAnimation, takesAnimation } from './animations.js'

function sample(): Project {
  return projectOf([track('t1', [videoClip('a', SECOND, 4 * SECOND)]), track('t2', [textClip('title', 0, 3 * SECOND)]), track('t3', [groupClip('group', 0, 2 * SECOND, [[videoClip('m', 0, 2 * SECOND)]])])])
}

// What is drawn at a number of moments, with the numbers rounded so that two ways to the same picture compare equal.
function drawn(project: Project, times: readonly number[]): unknown[] {
  return times.map((time) =>
    resolveFrame(project, MEDIA_STATES, time, 1).map((layer) => {
      const at = layer.placed ?? layer.transform
      return { id: layer.clipId, x: at.x.toFixed(6), y: at.y.toFixed(6), scaleX: at.scaleX.toFixed(6), scaleY: at.scaleY.toFixed(6), opacity: layer.opacity.toFixed(6) }
    }),
  )
}

describe('setAnimation', () => {
  it('sets, changes and takes away the animation of either end', () => {
    const fading = setAnimation(sample(), ['a'], 'in', { type: 'fade', duration: SECOND })
    expect(clipOf(fading, 'a')).toMatchObject({ animationIn: { type: 'fade', duration: SECOND } })
    const both = setAnimation(fading, ['a'], 'out', { type: 'slideLeft', duration: SECOND / 2 })
    expect(clipOf(both, 'a')).toMatchObject({ animationIn: { type: 'fade' }, animationOut: { type: 'slideLeft', duration: SECOND / 2 } })
    expect(reopened(both)).toEqual(both)
    const none = setAnimation(both, ['a'], 'in', undefined)
    expect(clipOf(reopened(none), 'a')).not.toHaveProperty('animationIn')
    expect(setAnimation(none, ['a'], 'in', undefined)).toBe(none)
  })

  it('keeps an animation on the time grid and no longer than its clip', () => {
    expect(clipOf(setAnimation(sample(), ['a'], 'in', { type: 'pop', duration: 99 * SECOND }), 'a')).toMatchObject({ animationIn: { duration: 4 * SECOND } })
    expect(clipOf(setAnimation(sample(), ['a'], 'in', { type: 'pop', duration: 149 }), 'a')).toMatchObject({ animationIn: { duration: 100 } })
    expect(clipOf(setAnimation(sample(), ['a'], 'in', { type: 'pop', duration: 0 }), 'a')).toMatchObject({ animationIn: { duration: 100 } })
  })

  it('gives a typewriter to text only', () => {
    const typed = setAnimation(sample(), ['a', 'title', 'group'], 'in', { type: 'typewriter', duration: SECOND })
    expect(clipOf(typed, 'title')).toMatchObject({ animationIn: { type: 'typewriter' } })
    expect(clipOf(typed, 'a')).not.toHaveProperty('animationIn')
    expect(takesAnimation(clipOf(typed, 'group'), 'typewriter')).toBe(false)
    expect(takesAnimation(clipOf(typed, 'group'), 'zoom')).toBe(true)
    expect(reopened(typed)).toEqual(typed)
  })

  it('does nothing when nothing changes', () => {
    const fading = setAnimation(sample(), ['a'], 'in', { type: 'fade', duration: SECOND })
    expect(setAnimation(fading, ['a'], 'in', { type: 'fade', duration: SECOND })).toBe(fading)
  })
})

describe('convertAnimations', () => {
  const moments = [0, 0.2, 0.5, 0.9, 1, 1.5, 2, 3.3, 3.7, 4, 4.6, 4.99].map((seconds) => Math.round((seconds * SECOND) / 100) * 100)

  it.each(['fade', 'pop', 'zoom', 'slideLeft', 'slideRight', 'slideUp', 'slideDown'] as const)('draws the same picture after a %s is turned into keyframes', (type) => {
    let animated = setAnimation(sample(), ['a', 'group'], 'in', { type, duration: SECOND })
    animated = setAnimation(animated, ['a', 'group'], 'out', { type, duration: SECOND / 2 })
    const converted = convertAnimations(animated, ['a', 'group'])
    expect(clipOf(converted, 'a').keyframes).toBeDefined()
    expect(clipOf(reopened(converted), 'a')).not.toHaveProperty('animationIn')
    expect(clipOf(reopened(converted), 'a')).not.toHaveProperty('animationOut')
    expect(drawn(converted, moments)).toEqual(drawn(animated, moments))
    expect(reopened(converted)).toEqual(converted)
  })

  it('works the animation into keyframes the clip already has', () => {
    const keyframed = videoClip('a', SECOND, 4 * SECOND, {
      opacity: 0.5,
      keyframes: { x: [{ time: 0, value: 100, easing: 'linear' }, { time: 4 * SECOND, value: 500, easing: 'linear' }] },
    })
    const animated = setAnimation(projectOf([track('t1', [keyframed])]), ['a'], 'in', { type: 'fade', duration: SECOND })
    const converted = clipOf(convertAnimations(animated, ['a']), 'a')
    expect(converted.keyframes?.opacity).toEqual([{ time: 0, value: 0, easing: 'linear' }, { time: SECOND, value: 0.5, easing: 'linear' }])
    expect(converted.keyframes?.x).toEqual(keyframed.keyframes?.x)
  })

  it('leaves a typewriter as it is, and clips without animations', () => {
    let typed = setAnimation(sample(), ['title'], 'in', { type: 'typewriter', duration: SECOND })
    expect(convertAnimations(typed, ['title', 'a'])).toBe(typed)
    typed = setAnimation(typed, ['title'], 'out', { type: 'fade', duration: SECOND })
    const converted = clipOf(convertAnimations(typed, ['title']), 'title')
    expect(converted).toMatchObject({ animationIn: { type: 'typewriter' } })
    expect(reopened(projectOf([track('t1', [converted])])).tracks[0]?.clips[0]).not.toHaveProperty('animationOut')
    expect(converted.keyframes?.opacity).toHaveLength(2)
  })
})
