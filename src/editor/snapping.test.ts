import { describe, expect, it } from 'vitest'
import { SECOND, projectOf, track, videoClip } from '../../test/fixtures.js'
import { nearestWithin, positionTargets, snapDelta, snapPosition, timelineTargets } from './snapping.js'

describe('nearestWithin', () => {
  it('finds the closest target in range, or nothing', () => {
    expect(nearestWithin(103, [0, 100, 110], 8)).toBe(100)
    expect(nearestWithin(106, [0, 100, 110], 8)).toBe(110)
    expect(nearestWithin(50, [0, 100], 8)).toBeUndefined()
    expect(nearestWithin(108, [100], 8)).toBe(100)
  })
})

describe('snapDelta', () => {
  it('lands the closest edge on its target and reports where the guide goes', () => {
    expect(snapDelta([100, 300], 95, [200, 500], 10)).toEqual({ delta: 100, guide: 200 })
    expect(snapDelta([100, 300], 195, [200, 500], 10)).toEqual({ delta: 200, guide: 500 })
  })

  it('prefers the edge that is nearer to a target', () => {
    expect(snapDelta([100, 300], 96, [200, 398], 10)).toEqual({ delta: 98, guide: 398 })
  })

  it('leaves the movement alone when nothing is in range', () => {
    expect(snapDelta([100, 300], 40, [200, 500], 10)).toEqual({ delta: 40, guide: undefined })
  })
})

describe('timelineTargets', () => {
  const project = projectOf([
    track('t1', [
      videoClip('a', SECOND, 2 * SECOND, { keyframes: { x: [{ time: -SECOND, value: 0, easing: 'linear' }, { time: SECOND, value: 5, easing: 'linear' }] } }),
      videoClip('moving', 6 * SECOND, SECOND),
    ]),
  ])

  it('offers the timeline start, the playhead, other clip edges and their visible keyframes', () => {
    const targets = timelineTargets(project, new Set(['moving']), 4 * SECOND).sort((a, b) => a - b)
    expect(targets).toEqual([0, SECOND, 2 * SECOND, 3 * SECOND, 4 * SECOND])
  })
})

describe('snapPosition', () => {
  const canvas = { width: 1920, height: 1080 }
  const other = { left: 100, top: 100, right: 500, bottom: 300 }
  const targets = positionTargets([other], canvas)

  it('snaps edges and centres to the canvas edges and centre lines', () => {
    const moving = { left: 800, top: 400, right: 1000, bottom: 600 }
    const snapped = snapPosition(moving, 57, 43, targets, 8)
    expect(snapped.x).toEqual({ delta: 60, guide: 960 })
    expect(snapped.y).toEqual({ delta: 40, guide: 540 })
  })

  it('snaps to the edges and centres of other clips', () => {
    const moving = { left: 600, top: 400, right: 700, bottom: 500 }
    const snapped = snapPosition(moving, -105, -97, targets, 8)
    expect(snapped.x).toEqual({ delta: -100, guide: 500 })
    expect(snapped.y).toEqual({ delta: -100, guide: 300 })
  })

  it('leaves an axis alone when nothing is within range', () => {
    const moving = { left: 600, top: 400, right: 700, bottom: 500 }
    expect(snapPosition(moving, 30, 0, targets, 8).x).toEqual({ delta: 30, guide: undefined })
  })
})
