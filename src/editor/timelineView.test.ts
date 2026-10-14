import { describe, expect, it } from 'vitest'
import { FRAME, SECOND, audioClip, track, videoClip } from '../../test/fixtures.js'
import type { CameraKeyframe, Clip } from '../shared/project.js'
import {
  CAMERA_LANE_HEIGHT,
  CLIP_INSET,
  RULER_HEIGHT,
  TRACKS_TOP,
  TRACK_HEIGHT,
  clipBands,
  clipsInMarquee,
  createClipIndex,
  fadeHandleAt,
  fadeHandles,
  fitZoom,
  hitClip,
  hitZoom,
  rulerStep,
  timeToX,
  trackIndexAt,
  trackTop,
  transitionBandAt,
  transitionBands,
  visibleRange,
  volumeChange,
  volumeLineAt,
  volumeLineNear,
  xToTime,
  zoomAround,
  zoomBars,
} from './timelineView.js'

const view = { pixelsPerSecond: 100, scrollX: 250, scrollY: 0 }
const limits = { viewWidth: 1000, duration: 100 * SECOND, frameTicks: FRAME }

describe('time and pixels', () => {
  it('converts both ways', () => {
    expect(timeToX(5 * SECOND, view)).toBe(250)
    expect(xToTime(250, view)).toBe(5 * SECOND)
    expect(xToTime(timeToX(123 * FRAME, view), view)).toBeCloseTo(123 * FRAME, 3)
  })

  it('shows the top layer in the top row', () => {
    expect(trackTop(2, 3, view)).toBe(TRACKS_TOP)
    expect(trackTop(0, 3, view)).toBe(TRACKS_TOP + 2 * TRACK_HEIGHT)
    expect(trackIndexAt(TRACKS_TOP + 5, 3, view)).toBe(2)
    expect(trackIndexAt(TRACKS_TOP + 2 * TRACK_HEIGHT + 5, 3, view)).toBe(0)
    expect(trackIndexAt(TRACKS_TOP + 3 * TRACK_HEIGHT + 5, 3, view)).toBe(-1)
    expect(trackIndexAt(TRACKS_TOP + 5, 3, { ...view, scrollY: TRACK_HEIGHT })).toBe(1)
  })
})

describe('zoomAround', () => {
  it('keeps the time under the pointer in place', () => {
    const zoomed = zoomAround(view, 2, 400, limits)
    expect(zoomed.pixelsPerSecond).toBe(200)
    expect(xToTime(400, zoomed)).toBeCloseTo(xToTime(400, view), 3)
  })

  it('stops at an hour in view for a short project, and at single frames', () => {
    const zoomedOut = zoomAround(view, 0.0001, 0, limits)
    expect(zoomedOut.pixelsPerSecond).toBe(1000 / 3600)
    expect(zoomedOut.pixelsPerSecond).toBeLessThan(fitZoom(limits))
    expect(zoomAround(view, 100_000, 0, limits).pixelsPerSecond).toBe(20 * 30)
  })

  it('zooms out to ten times a long project, which still fits exactly on request', () => {
    const twentyHours = { ...limits, duration: 20 * 3600 * SECOND }
    const zoomedOut = zoomAround(view, 0, 0, twentyHours)
    expect(timeToX(20 * 3600 * SECOND, { ...zoomedOut, scrollX: 0 })).toBeCloseTo(100, 6)
    expect(timeToX(20 * 3600 * SECOND, { ...view, pixelsPerSecond: fitZoom(twentyHours), scrollX: 0 })).toBeCloseTo(1000, 6)
  })

  it('keeps the start of the timeline at the left edge when zoomed out past the project', () => {
    expect(zoomAround(view, 0, 700, limits).scrollX).toBe(0)
  })
})

describe('rulerStep', () => {
  it('labels round numbers of seconds, and frames when zoomed in', () => {
    expect(rulerStep(100, FRAME)).toBe(SECOND)
    expect(rulerStep(10, FRAME)).toBe(10 * SECOND)
    expect(rulerStep(0.014, FRAME)).toBe(7200 * SECOND)
    // Two hundred hours across a thousand pixels: a label a day.
    expect(rulerStep(1000 / (200 * 3600), FRAME)).toBe(86_400 * SECOND)
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
  const bottomRow = TRACKS_TOP + TRACK_HEIGHT + 10
  const topRow = TRACKS_TOP + 10

  it('finds the clip under the pointer and the edge it is near', () => {
    expect(hitClip(tracks, inOrder, flat, 100, bottomRow)).toMatchObject({ clip: { id: 'a' }, trackIndex: 0, edge: undefined })
    expect(hitClip(tracks, inOrder, flat, 3, bottomRow)?.edge).toBe('start')
    expect(hitClip(tracks, inOrder, flat, 197, bottomRow)?.edge).toBe('end')
    expect(hitClip(tracks, inOrder, flat, 150, topRow)).toMatchObject({ clip: { id: 'c' }, trackIndex: 1 })
  })

  it('finds nothing in a gap, on the ruler or below the tracks', () => {
    expect(hitClip(tracks, inOrder, flat, 250, bottomRow)).toBeUndefined()
    expect(hitClip(tracks, inOrder, flat, 100, 10)).toBeUndefined()
    expect(hitClip(tracks, inOrder, flat, 100, RULER_HEIGHT + CAMERA_LANE_HEIGHT / 2)).toBeUndefined()
    expect(hitClip(tracks, inOrder, flat, 100, TRACKS_TOP + 2 * TRACK_HEIGHT + 10)).toBeUndefined()
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

describe('clipBands', () => {
  const rowTop = 100
  const top = rowTop + CLIP_INSET
  const height = TRACK_HEIGHT - 2 * CLIP_INSET

  it('gives a silent picture the whole clip', () => {
    expect(clipBands(videoClip('a', 0, SECOND), false, rowTop)).toEqual({ picture: { top, height }, sound: undefined })
  })

  it('gives a sound the whole clip', () => {
    expect(clipBands(audioClip('a', 0, SECOND), true, rowTop)).toEqual({ picture: undefined, sound: { top, height } })
  })

  it('shows the picture of a linked clip above its sound', () => {
    const bands = clipBands(videoClip('a', 0, SECOND), true, rowTop)
    expect(bands.picture).toEqual({ top, height: 31 })
    expect(bands.sound).toEqual({ top: top + 31, height: height - 31 })
  })
})

describe('fade handles', () => {
  const flat = { pixelsPerSecond: 100, scrollX: 0, scrollY: 0 }
  const rowTop = TRACKS_TOP
  const pictureY = rowTop + CLIP_INSET + 7
  const soundY = rowTop + TRACK_HEIGHT - CLIP_INSET - 7

  it('rest just inside the corners while there is no fade', () => {
    expect(fadeHandles(videoClip('a', SECOND, 4 * SECOND), true, flat, rowTop)).toEqual([
      { fade: 'fadeIn', x: 107, y: pictureY },
      { fade: 'fadeOut', x: 493, y: pictureY },
      { fade: 'volumeFadeIn', x: 107, y: soundY },
      { fade: 'volumeFadeOut', x: 493, y: soundY },
    ])
  })

  it('sit where their fade ends', () => {
    const clip = videoClip('a', SECOND, 4 * SECOND, { fadeIn: SECOND, fadeOut: SECOND / 2, volumeFadeOut: 2 * SECOND })
    expect(fadeHandles(clip, true, flat, rowTop).map((handle) => handle.x)).toEqual([200, 450, 107, 300])
  })

  it('stay inside the clip when a fade is as long as the clip', () => {
    const clip = videoClip('a', SECOND, 4 * SECOND, { fadeIn: 4 * SECOND })
    expect(fadeHandles(clip, false, flat, rowTop)[0]).toMatchObject({ fade: 'fadeIn', x: 493 })
  })

  it('offer only the fades a clip has', () => {
    expect(fadeHandles(videoClip('a', 0, 4 * SECOND), false, flat, rowTop).map((handle) => handle.fade)).toEqual(['fadeIn', 'fadeOut'])
    expect(fadeHandles(audioClip('a', 0, 4 * SECOND), true, flat, rowTop).map((handle) => handle.fade)).toEqual(['volumeFadeIn', 'volumeFadeOut'])
  })

  it('are left out of a clip too narrow to hold them', () => {
    expect(fadeHandles(videoClip('a', 0, SECOND / 5), true, flat, rowTop)).toEqual([])
  })

  it('are grabbed within reach of the dot, the nearest one first', () => {
    const handles = fadeHandles(videoClip('a', SECOND, 4 * SECOND), true, flat, rowTop)
    expect(fadeHandleAt(handles, 107, pictureY)?.fade).toBe('fadeIn')
    expect(fadeHandleAt(handles, 101, pictureY + 5)?.fade).toBe('fadeIn')
    expect(fadeHandleAt(handles, 490, soundY - 3)?.fade).toBe('volumeFadeOut')
    expect(fadeHandleAt(handles, 107, rowTop + TRACK_HEIGHT / 2)).toBeUndefined()
    expect(fadeHandleAt(handles, 300, pictureY)).toBeUndefined()
  })

  it('leave most of the clip edge to trimming', () => {
    const handles = fadeHandles(videoClip('a', SECOND, 4 * SECOND), true, flat, rowTop)
    expect(fadeHandleAt(handles, 101, rowTop + TRACK_HEIGHT / 2)).toBeUndefined()
  })
})


describe('transition bands', () => {
  const flat = { pixelsPerSecond: 100, scrollX: 0, scrollY: 0 }
  const rowTop = TRACKS_TOP
  const middle = rowTop + TRACK_HEIGHT / 2
  const first = videoClip('first', SECOND, 3 * SECOND, { transitionIn: { type: 'zoom', duration: SECOND }, transitionOut: { type: 'push', duration: SECOND / 2 } })
  const second = videoClip('second', 4 * SECOND, 3 * SECOND, { transitionIn: { type: 'crossDissolve', duration: SECOND } })

  it('lie inside the clip at a free end, with the grip at the end that points into the clip', () => {
    expect(transitionBands(first, undefined, undefined, flat, rowTop)).toEqual([
      { edge: 'in', left: 100, right: 200, gripX: 200, gripY: middle, isOnCut: false },
      { edge: 'out', left: 350, right: 400, gripX: 350, gripY: middle, isOnCut: false },
    ])
  })

  it('lie across the cut when two clips touch, and replace the end transition of the earlier clip', () => {
    expect(transitionBands(second, first, undefined, flat, rowTop)).toEqual([{ edge: 'in', left: 350, right: 450, gripX: 450, gripY: middle, isOnCut: true }])
    expect(transitionBands(first, undefined, second, flat, rowTop).map((band) => band.edge)).toEqual(['in'])
  })

  it('are grabbed at their grip, which is apart from the fade handles in the corners', () => {
    const bands = transitionBands(first, undefined, undefined, flat, rowTop)
    expect(transitionBandAt(bands, 203, middle - 4)?.edge).toBe('in')
    expect(transitionBandAt(bands, 349, middle)?.edge).toBe('out')
    expect(transitionBandAt(bands, 200, rowTop + CLIP_INSET + 7)).toBeUndefined()
    expect(transitionBands(audioClip('music', 0, SECOND), undefined, undefined, flat, rowTop)).toEqual([])
  })
})

describe('camera lane', () => {
  const flat = { pixelsPerSecond: 100, scrollX: 0, scrollY: 0 }

  function zoom(time: number, duration: number): CameraKeyframe {
    return { time, duration, easing: 'easeInOut', x: 960, y: 540, scale: 2 }
  }

  const camera = [zoom(2 * SECOND, SECOND), zoom(2.5 * SECOND, 3 * SECOND), zoom(6 * SECOND, 2 * SECOND)]

  it('draws each zoom as a bar for its move, which never starts before the zoom before it', () => {
    expect(zoomBars(camera)).toEqual([
      { index: 0, from: SECOND, to: 2 * SECOND },
      { index: 1, from: 2 * SECOND, to: 2.5 * SECOND },
      { index: 2, from: 4 * SECOND, to: 6 * SECOND },
    ])
    expect(zoomBars([zoom(SECOND / 2, SECOND)])).toEqual([{ index: 0, from: 0, to: SECOND / 2 }])
  })

  it('finds the zoom under the pointer, and its start where the length of the move is changed', () => {
    expect(hitZoom(camera, flat, 600)).toEqual({ index: 2, part: 'zoom' })
    expect(hitZoom(camera, flat, 500)).toEqual({ index: 2, part: 'zoom' })
    expect(hitZoom(camera, flat, 403)).toEqual({ index: 2, part: 'start' })
    expect(hitZoom(camera, flat, 150)).toEqual({ index: 0, part: 'zoom' })
    expect(hitZoom(camera, flat, 320)).toBeUndefined()
    expect(hitZoom(camera, flat, 50)).toBeUndefined()
  })

  it('keeps the diamond of a zoom ahead of the start of the move that begins there', () => {
    expect(hitZoom(camera, flat, 201)).toEqual({ index: 0, part: 'zoom' })
    expect(hitZoom(camera, flat, 209)).toEqual({ index: 1, part: 'start' })
    expect(hitZoom(camera, flat, 230)).toEqual({ index: 1, part: 'zoom' })
  })
})

describe('volume line', () => {
  const flat = { pixelsPerSecond: 100, scrollX: 0, scrollY: 0 }
  const rowTop = TRACKS_TOP
  const band = { top: rowTop + CLIP_INSET, height: TRACK_HEIGHT - 2 * CLIP_INSET }

  it('lies level at the volume of a clip without keyframes, across the clip only', () => {
    const music = audioClip('music', SECOND, 4 * SECOND, { volume: 1 })
    expect(volumeLineAt(music, true, flat, rowTop, 300)).toEqual({ y: band.top + band.height / 2, band, indices: [] })
    expect(volumeLineAt(music, true, flat, rowTop, 50)).toBeUndefined()
    expect(volumeLineNear(music, true, flat, rowTop, { x: 300, y: band.top + band.height / 2 + 3 })).toBeDefined()
    expect(volumeLineNear(music, true, flat, rowTop, { x: 300, y: band.top + band.height / 2 + 6 })).toBeUndefined()
  })

  it('names the keyframes at the ends of the stretch under the pointer', () => {
    const keyframes = [
      { time: SECOND, value: 2, easing: 'linear' as const },
      { time: 3 * SECOND, value: 0, easing: 'linear' as const },
    ]
    const music = audioClip('music', 0, 4 * SECOND, { keyframes: { volume: keyframes } })
    expect(volumeLineAt(music, true, flat, rowTop, 50)).toEqual({ y: band.top, band, indices: [0] })
    expect(volumeLineAt(music, true, flat, rowTop, 200)).toEqual({ y: band.top + band.height / 2, band, indices: [0, 1] })
    expect(volumeLineAt(music, true, flat, rowTop, 350)).toEqual({ y: band.top + band.height, band, indices: [1] })
  })

  it('turns a drag up the band into more volume', () => {
    expect(volumeChange(band, 40, 40 - band.height / 4)).toBeCloseTo(0.5)
  })
})
