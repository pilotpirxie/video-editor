import { describe, expect, it } from 'vitest'
import { FRAME, SECOND, track, videoClip } from '../../test/fixtures.js'
import type { Clip } from '../shared/project.js'
import { RULER_HEIGHT, TRACK_HEIGHT, clipsInMarquee, createClipIndex, fitZoom, hitClip, rulerStep, timeToX, trackIndexAt, trackTop, visibleRange, xToTime, zoomAround } from './timelineView.js'

const view = { pixelsPerSecond: 100, scrollX: 250, scrollY: 0 }
const limits = { viewWidth: 1000, duration: 100 * SECOND, frameTicks: FRAME }

describe('time and pixels', () => {
  it('converts both ways', () => {
    expect(timeToX(5 * SECOND, view)).toBe(250)
    expect(xToTime(250, view)).toBe(5 * SECOND)
    expect(xToTime(timeToX(123 * FRAME, view), view)).toBeCloseTo(123 * FRAME, 3)
  })

  it('shows the top layer in the top row', () => {
    expect(trackTop(2, 3, view)).toBe(RULER_HEIGHT)
    expect(trackTop(0, 3, view)).toBe(RULER_HEIGHT + 2 * TRACK_HEIGHT)
    expect(trackIndexAt(RULER_HEIGHT + 5, 3, view)).toBe(2)
    expect(trackIndexAt(RULER_HEIGHT + 2 * TRACK_HEIGHT + 5, 3, view)).toBe(0)
    expect(trackIndexAt(RULER_HEIGHT + 3 * TRACK_HEIGHT + 5, 3, view)).toBe(-1)
    expect(trackIndexAt(RULER_HEIGHT + 5, 3, { ...view, scrollY: TRACK_HEIGHT })).toBe(1)
  })
})

describe('zoomAround', () => {
  it('keeps the time under the pointer in place', () => {
    const zoomed = zoomAround(view, 2, 400, limits)
    expect(zoomed.pixelsPerSecond).toBe(200)
    expect(xToTime(400, zoomed)).toBeCloseTo(xToTime(400, view), 3)
  })

  it('stops at the whole project and at single frames', () => {
    expect(zoomAround(view, 0.0001, 0, limits).pixelsPerSecond).toBe(fitZoom(limits))
    expect(zoomAround(view, 100_000, 0, limits).pixelsPerSecond).toBe(20 * 30)
  })

  it('shows a 20-hour project in one view', () => {
    const twentyHours = { ...limits, duration: 20 * 3600 * SECOND }
    const zoomed = zoomAround(view, 0, 0, twentyHours)
    expect(timeToX(20 * 3600 * SECOND, { ...zoomed, scrollX: 0 })).toBeCloseTo(1000, 6)
  })
})

describe('rulerStep', () => {
  it('labels round numbers of seconds, and frames when zoomed in', () => {
    expect(rulerStep(100, FRAME)).toBe(SECOND)
    expect(rulerStep(10, FRAME)).toBe(10 * SECOND)
    expect(rulerStep(0.014, FRAME)).toBe(7200 * SECOND)
    expect(rulerStep(600, FRAME)).toBe(5 * FRAME)
    expect(rulerStep(3000, FRAME)).toBe(FRAME)
  })
})

describe('visibleRange', () => {
  const clips: Clip[] = []
  for (let index = 0; index < 4096; index++) clips.push(videoClip(`c${index}`, index * 2 * SECOND, SECOND))

  it('finds the clips that touch a time span', () => {
    expect(visibleRange(clips, 0, SECOND)).toEqual({ first: 0, end: 1 })
    expect(visibleRange(clips, 10 * SECOND, 20 * SECOND)).toEqual({ first: 5, end: 10 })
    expect(visibleRange(clips, SECOND, 2 * SECOND)).toEqual({ first: 1, end: 1 })
    expect(visibleRange(clips, 10 * SECOND + 1, 10 * SECOND + 2)).toEqual({ first: 5, end: 6 })
    expect(visibleRange(clips, 9000 * SECOND, 9001 * SECOND)).toEqual({ first: 4096, end: 4096 })
    expect(visibleRange([], 0, SECOND)).toEqual({ first: 0, end: 0 })
  })

  it('agrees with a plain scan everywhere', () => {
    for (const from of [0, 3 * SECOND, 777 * SECOND + 5, 8190 * SECOND]) {
      const to = from + 37 * SECOND
      const expected = clips.filter((clip) => clip.start + clip.duration > from && clip.start < to).map((clip) => clip.id)
      const range = visibleRange(clips, from, to)
      expect(clips.slice(range.first, range.end).map((clip) => clip.id)).toEqual(expected)
    }
  })
})

describe('createClipIndex', () => {
  it('orders clips by time once per track', () => {
    const unordered = track('t1', [videoClip('late', 5 * SECOND, SECOND), videoClip('early', 0, SECOND)])
    const inOrder = createClipIndex()
    expect(inOrder(unordered).map((clip) => clip.id)).toEqual(['early', 'late'])
    expect(inOrder(unordered)).toBe(inOrder(unordered))
  })
})

describe('hitClip and clipsInMarquee', () => {
  const flat = { pixelsPerSecond: 100, scrollX: 0, scrollY: 0 }
  const tracks = [
    track('bottom', [videoClip('a', 0, 2 * SECOND), videoClip('b', 3 * SECOND, 2 * SECOND)]),
    track('top', [videoClip('c', SECOND, SECOND)], { locked: true }),
  ]
  const inOrder = createClipIndex()
  const bottomRow = RULER_HEIGHT + TRACK_HEIGHT + 10
  const topRow = RULER_HEIGHT + 10

  it('finds the clip under the pointer and the edge it is near', () => {
    expect(hitClip(tracks, inOrder, flat, 100, bottomRow)).toMatchObject({ clip: { id: 'a' }, trackIndex: 0, edge: undefined })
    expect(hitClip(tracks, inOrder, flat, 3, bottomRow)?.edge).toBe('start')
    expect(hitClip(tracks, inOrder, flat, 197, bottomRow)?.edge).toBe('end')
    expect(hitClip(tracks, inOrder, flat, 150, topRow)).toMatchObject({ clip: { id: 'c' }, trackIndex: 1 })
  })

  it('finds nothing in a gap, on the ruler or below the tracks', () => {
    expect(hitClip(tracks, inOrder, flat, 250, bottomRow)).toBeUndefined()
    expect(hitClip(tracks, inOrder, flat, 100, 10)).toBeUndefined()
    expect(hitClip(tracks, inOrder, flat, 100, RULER_HEIGHT + 2 * TRACK_HEIGHT + 10)).toBeUndefined()
  })

  it('offers no trim edges on a clip too narrow to grab in the middle', () => {
    const zoomedOut = { pixelsPerSecond: 5, scrollX: 0, scrollY: 0 }
    expect(hitClip(tracks, inOrder, zoomedOut, 1, bottomRow)).toMatchObject({ clip: { id: 'a' }, edge: undefined })
  })

  it('selects the clips a marquee touches, skipping locked tracks', () => {
    const everything = { left: 0, top: 0, right: 1000, bottom: 1000 }
    expect(clipsInMarquee(tracks, inOrder, flat, everything)).toEqual(['a', 'b'])
    expect(clipsInMarquee(tracks, inOrder, flat, { left: 250, top: bottomRow, right: 320, bottom: bottomRow + 5 })).toEqual(['b'])
    expect(clipsInMarquee(tracks, inOrder, flat, { left: 0, top: topRow, right: 1000, bottom: topRow + 5 })).toEqual([])
  })
})
