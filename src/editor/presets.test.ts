import { describe, expect, it } from 'vitest'
import { SECOND, clipOf, groupClip, projectOf, reopened, textClip, track, videoClip } from '../../test/fixtures.js'
import type { Project } from '../shared/project.js'
import { setAnimation, takesAnimation } from './presets.js'

function sample(): Project {
  return projectOf([track('t1', [videoClip('a', SECOND, 4 * SECOND)]), track('t2', [textClip('title', 0, 3 * SECOND)]), track('t3', [groupClip('group', 0, 2 * SECOND, [[videoClip('m', 0, 2 * SECOND)]])])])
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
