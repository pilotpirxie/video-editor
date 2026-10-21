import { describe, expect, it } from 'vitest'
import type { MediaInfo, VideoInfo } from '../shared/mediaProtocol.js'
import { TRANSITION_TYPES, ease, valueAt, type CameraKeyframe, type Clip, type Easing, type Keyframe, type Project, type Track, type TransitionType, type VideoClip } from '../shared/project.js'
import { fadeFactor, groupFrameAt, pictureRanges, resolveFrame, sourceHalvings, transitionChange, type Layer, type MediaStates, type TransitionPart, type VideoLayer } from './resolve.js'

const SECOND = 24_000_000
const FRAME_30 = 800_000

const VIDEO: VideoInfo = {
  width: 1920,
  height: 1080,
  frameDuration: FRAME_30,
  frameCount: 300,
  startOffset: 0,
  seekPreroll: 3 * FRAME_30,
  isVariableFrameRate: false,
  hasAlpha: false,
  colorMatrix: 'bt709',
  colorRange: 'tv',
  transfer: 'sdr',
  codec: 'h264',
}

function videoMedia(video: Partial<VideoInfo> = {}): MediaInfo {
  return { kind: 'video', duration: 10 * SECOND, containerStart: 0, video: { ...VIDEO, ...video } }
}

const MEDIA: MediaStates = {
  footage: { info: videoMedia() },
  logo: { info: { kind: 'image', width: 400, height: 200, hasAlpha: true } },
  broken: { error: '"broken.mp4" could not be read.', isMissing: false },
}

function videoClip(overrides: Partial<VideoClip> = {}): VideoClip {
  return {
    id: 'clip',
    type: 'video',
    mediaId: 'footage',
    start: 0,
    duration: 5 * SECOND,
    sourceStart: 0,
    speedPercent: 100,
    transform: { x: 960, y: 540, scaleX: 1, scaleY: 1, rotation: 0 },
    opacity: 1,
    volume: 1,
    ...overrides,
  }
}

function track(clips: Clip[], overrides: Partial<Track> = {}): Track {
  return { id: `track-${clips.map((clip) => clip.id).join('-')}`, name: '', hidden: false, locked: false, muted: false, clips, ...overrides }
}

function project(tracks: Track[]): Project {
  return { version: 1, canvas: { width: 1920, height: 1080, frameRate: { num: 30, den: 1 } }, media: [], tracks }
}

function layersAt(clips: Clip[], time: number): Layer[] {
  return resolveFrame(project([track(clips)]), MEDIA, time, 1)
}

function videoLayerAt(clip: VideoClip, time: number): VideoLayer {
  const layer = layersAt([clip], time)[0]
  if (layer?.kind !== 'video') throw new Error(`No video layer at ${time}`)
  return layer
}

function keyframes(...points: [time: number, value: number, easing: Easing][]): Keyframe[] {
  return points.map(([time, value, easing]) => ({ time, value, easing }))
}

describe('active clips', () => {
  const clip = videoClip({ start: 2 * SECOND, duration: 3 * SECOND })

  it('includes the first tick and excludes the end', () => {
    expect(layersAt([clip], 2 * SECOND - 100)).toHaveLength(0)
    expect(layersAt([clip], 2 * SECOND)).toHaveLength(1)
    expect(layersAt([clip], 5 * SECOND - 100)).toHaveLength(1)
    expect(layersAt([clip], 5 * SECOND)).toHaveLength(0)
  })

  it('draws nothing in a gap and hands over exactly at a cut', () => {
    const first = videoClip({ id: 'first', start: 0, duration: SECOND })
    const second = videoClip({ id: 'second', start: SECOND, duration: SECOND })
    const third = videoClip({ id: 'third', start: 3 * SECOND, duration: SECOND })
    expect(layersAt([first, second, third], SECOND - 100).map((layer) => layer.clipId)).toEqual(['first'])
    expect(layersAt([first, second, third], SECOND).map((layer) => layer.clipId)).toEqual(['second'])
    expect(layersAt([first, second, third], 2 * SECOND + 500_000)).toEqual([])
  })

  it('orders layers bottom track first and skips hidden tracks', () => {
    const tracks = [
      track([videoClip({ id: 'bottom' })]),
      track([videoClip({ id: 'hidden' })], { hidden: true }),
      track([videoClip({ id: 'muted' })], { muted: true }),
      track([videoClip({ id: 'top' })]),
    ]
    const layers = resolveFrame(project(tracks), MEDIA, 0, 1)
    expect(layers.map((layer) => layer.clipId)).toEqual(['bottom', 'muted', 'top'])
  })

  it('skips clips whose media failed, without affecting the others', () => {
    const tracks = [track([videoClip({ id: 'bad', mediaId: 'broken' })]), track([videoClip({ id: 'missing', mediaId: 'nowhere' })]), track([videoClip({ id: 'good' })])]
    expect(resolveFrame(project(tracks), MEDIA, 0, 1).map((layer) => layer.clipId)).toEqual(['good'])
  })

  it('never produces a layer for an audio clip', () => {
    const audio: Clip = { id: 'music', type: 'audio', mediaId: 'footage', start: 0, duration: SECOND, sourceStart: 0, speedPercent: 100, volume: 1 }
    expect(layersAt([audio], 0)).toEqual([])
  })
})

describe('source frame', () => {
  it('follows the timeline at normal speed', () => {
    const clip = videoClip({ start: SECOND })
    expect(videoLayerAt(clip, SECOND).frame).toBe(0)
    expect(videoLayerAt(clip, SECOND + FRAME_30).frame).toBe(1)
    expect(videoLayerAt(clip, SECOND + FRAME_30 * 30 - 100).frame).toBe(29)
    expect(videoLayerAt(clip, SECOND + FRAME_30 * 30).frame).toBe(30)
  })

  it('starts from the source offset', () => {
    const clip = videoClip({ sourceStart: FRAME_30 * 45 + 7 })
    expect(videoLayerAt(clip, 0).frame).toBe(45)
    expect(videoLayerAt(clip, FRAME_30 * 10).frame).toBe(55)
  })

  it.each([
    [25, [0, 0, 0, 0, 1, 1, 1, 1, 2]],
    [50, [0, 0, 1, 1, 2, 2, 3, 3, 4]],
    [100, [0, 1, 2, 3, 4, 5, 6, 7, 8]],
    [150, [0, 1, 3, 4, 6, 7, 9, 10, 12]],
    [200, [0, 2, 4, 6, 8, 10, 12, 14, 16]],
    [400, [0, 4, 8, 12, 16, 20, 24, 28, 32]],
  ])('at %i%% speed shows the frame at or before the mapped source time', (speedPercent, expected) => {
    const clip = videoClip({ speedPercent })
    const frames = expected.map((_frame, index) => videoLayerAt(clip, index * FRAME_30).frame)
    expect(frames).toEqual(expected)
  })

  it('skips source frames at 5000% and 10000%, and holds the last frame past the end', () => {
    expect(videoLayerAt(videoClip({ speedPercent: 5000 }), FRAME_30 * 3).frame).toBe(150)
    expect(videoLayerAt(videoClip({ speedPercent: 10_000 }), FRAME_30 * 2).frame).toBe(200)
    expect(videoLayerAt(videoClip({ speedPercent: 10_000 }), FRAME_30 * 5).frame).toBe(299)
  })

  it('starts a looping clip over when its source ends, and holds the last frame of one that does not loop', () => {
    const short: MediaStates = { footage: { info: { kind: 'video', duration: 12 * FRAME_30, containerStart: 0, video: { ...VIDEO, frameCount: 12 }, isAnimatedImage: true } } }
    function frameAt(clip: VideoClip, frame: number): number {
      const layer = resolveFrame(project([track([clip])]), short, frame * FRAME_30, 1)[0]
      return layer?.kind === 'video' ? layer.frame : -1
    }
    const looping = videoClip({ loop: true })
    expect([0, 5, 11, 12, 13, 24, 30].map((frame) => frameAt(looping, frame))).toEqual([0, 5, 11, 0, 1, 0, 6])
    expect([11, 12, 30].map((frame) => frameAt(videoClip(), frame))).toEqual([11, 11, 11])
    expect(frameAt(videoClip({ loop: true, sourceStart: 10 * FRAME_30, speedPercent: 200 }), 3)).toBe(4)
  })

  it('accounts for a picture that starts after the container', () => {
    const delayed: MediaStates = { footage: { info: videoMedia({ startOffset: FRAME_30 * 3 }) } }
    function layers(time: number): Layer[] {
      return resolveFrame(project([track([videoClip()])]), delayed, time, 1)
    }
    expect(layers(0)[0]).toMatchObject({ frame: 0 })
    expect(layers(FRAME_30 * 3)[0]).toMatchObject({ frame: 0 })
    expect(layers(FRAME_30 * 4)[0]).toMatchObject({ frame: 1 })
  })

  it('maps a 24 fps source onto a 30 fps timeline', () => {
    const film: MediaStates = { footage: { info: videoMedia({ frameDuration: 1_000_000 }) } }
    const frames = [0, 1, 2, 3, 4, 5].map((index) => resolveFrame(project([track([videoClip()])]), film, index * FRAME_30, 1)[0])
    expect(frames.map((layer) => (layer?.kind === 'video' ? layer.frame : -1))).toEqual([0, 0, 1, 2, 3, 4])
  })
})

describe('easing', () => {
  it.each<[Easing, number[]]>([
    ['linear', [0, 0.25, 0.5, 0.75, 1]],
    ['easeIn', [0, 0.015625, 0.125, 0.421875, 1]],
    ['easeOut', [0, 0.578125, 0.875, 0.984375, 1]],
    ['easeInOut', [0, 0.0625, 0.5, 0.9375, 1]],
    ['hold', [0, 0, 0, 0, 0]],
  ])('%s', (easing, expected) => {
    expect([0, 0.25, 0.5, 0.75, 1].map((progress) => ease(easing, progress))).toEqual(expected)
  })

  it('every easing is monotonic and never overshoots', () => {
    for (const easing of ['linear', 'easeIn', 'easeOut', 'easeInOut'] as const) {
      let previous = 0
      for (let step = 0; step <= 1000; step++) {
        const value = ease(easing, step / 1000)
        expect(value).toBeGreaterThanOrEqual(previous)
        expect(value).toBeLessThanOrEqual(1)
        previous = value
      }
    }
  })
})

describe('keyframes', () => {
  const track = keyframes([SECOND, 100, 'linear'], [2 * SECOND, 200, 'hold'], [3 * SECOND, 50, 'easeIn'], [4 * SECOND, 150, 'linear'])

  it('uses the first value before the first keyframe and the last value after the last', () => {
    expect(valueAt(track, 0)).toBe(100)
    expect(valueAt(track, 4 * SECOND)).toBe(150)
    expect(valueAt(track, 9 * SECOND)).toBe(150)
  })

  it('shapes each segment by the keyframe that starts it', () => {
    expect(valueAt(track, SECOND)).toBe(100)
    expect(valueAt(track, 1.5 * SECOND)).toBe(150)
    expect(valueAt(track, 2 * SECOND)).toBe(200)
    expect(valueAt(track, 3 * SECOND - 100)).toBe(200)
    expect(valueAt(track, 3 * SECOND)).toBe(50)
    expect(valueAt(track, 3.5 * SECOND)).toBe(50 + 100 * 0.125)
  })

  it('returns nothing for an empty track', () => {
    expect(valueAt([], SECOND)).toBeUndefined()
  })

  it('gives the same bits as reading the keyframes one by one, at and between every keyframe of a long track', () => {
    const easings: Easing[] = ['linear', 'easeIn', 'easeOut', 'easeInOut', 'hold']
    const long: Keyframe[] = []
    for (let index = 0; index < 600; index++) long.push({ time: index * 80_000, value: (index * 37) % 11, easing: easings[index % easings.length] ?? 'linear' })

    function oneByOne(list: readonly Keyframe[], time: number): number | undefined {
      let previous: Keyframe | undefined
      for (const keyframe of list) {
        if (keyframe.time > time) {
          if (previous === undefined) return keyframe.value
          const progress = (time - previous.time) / (keyframe.time - previous.time)
          return previous.value + (keyframe.value - previous.value) * ease(previous.easing, progress)
        }
        previous = keyframe
      }
      return previous?.value
    }

    for (let time = -80_000; time <= 601 * 80_000; time += 20_000) {
      expect(valueAt(long, time), `time ${time}`).toBe(oneByOne(long, time))
    }
    expect(valueAt(long.slice(0, 1), 5)).toBe(0)
  })

  it('animates transform, crop and opacity relative to the clip start', () => {
    const clip = videoClip({
      start: 10 * SECOND,
      crop: { left: 10, top: 0, right: 0, bottom: 0 },
      keyframes: {
        x: keyframes([0, 0, 'linear'], [2 * SECOND, 1000, 'linear']),
        rotation: keyframes([0, 0, 'easeInOut'], [2 * SECOND, 90, 'linear']),
        opacity: keyframes([0, 1, 'linear'], [4 * SECOND, 0, 'linear']),
        cropTop: keyframes([0, 0, 'linear'], [2 * SECOND, 80, 'linear']),
      },
    })
    const layer = videoLayerAt(clip, 11 * SECOND)
    expect(layer.transform).toEqual({ x: 500, y: 540, scaleX: 1, scaleY: 1, rotation: 45 })
    expect(layer.opacity).toBe(0.75)
    expect(layer.crop).toEqual({ left: 10, top: 40, right: 0, bottom: 0 })
  })
})

describe('fades', () => {
  it('ramps linearly at both ends', () => {
    const duration = 10 * SECOND
    expect(fadeFactor(0, duration, 2 * SECOND, undefined)).toBe(0)
    expect(fadeFactor(SECOND, duration, 2 * SECOND, undefined)).toBe(0.5)
    expect(fadeFactor(2 * SECOND, duration, 2 * SECOND, undefined)).toBe(1)
    expect(fadeFactor(9 * SECOND, duration, undefined, 4 * SECOND)).toBe(0.25)
    expect(fadeFactor(5 * SECOND, duration, 2 * SECOND, 4 * SECOND)).toBe(1)
    expect(fadeFactor(5 * SECOND, duration, undefined, undefined)).toBe(1)
  })

  it('multiplies overlapping fades and the clip opacity', () => {
    expect(fadeFactor(SECOND, 2 * SECOND, 2 * SECOND, 2 * SECOND)).toBe(0.25)
    const clip = videoClip({ opacity: 0.8, fadeIn: 2 * SECOND })
    expect(videoLayerAt(clip, SECOND).opacity).toBeCloseTo(0.4, 12)
  })
})

describe('other layer kinds', () => {
  it('resolves an image with its natural size', () => {
    const image: Clip = { id: 'logo', type: 'image', mediaId: 'logo', start: 0, duration: SECOND, transform: { x: 100, y: 50, scaleX: 0.5, scaleY: 0.5, rotation: 10 }, opacity: 0.5 }
    expect(layersAt([image], 0)).toEqual([
      { kind: 'image', clipId: 'logo', mediaId: 'logo', width: 400, height: 200, transform: { x: 100, y: 50, scaleX: 0.5, scaleY: 0.5, rotation: 10 }, opacity: 0.5, crop: { left: 0, top: 0, right: 0, bottom: 0 } },
    ])
  })

  it('resolves text without needing any media', () => {
    const text: Clip = { id: 'title', type: 'text', start: 0, duration: SECOND, text: 'Hello', font: { family: 'Helvetica', size: 72 }, color: '#FFFFFF', align: 'center', transform: { x: 960, y: 540, scaleX: 1, scaleY: 1, rotation: 0 }, opacity: 1 }
    expect(resolveFrame(project([track([text])]), {}, 0, 1)).toEqual([
      { kind: 'text', clipId: 'title', look: { text: 'Hello', font: { family: 'Helvetica', size: 72 }, color: '#FFFFFF', align: 'center' }, sharpScaleX: 1, sharpScaleY: 1, transform: text.transform, opacity: 1 },
    ])
  })
})

describe('sourceHalvings', () => {
  function scaled(scale: number): VideoClip {
    return videoClip({ transform: { x: 0, y: 0, scaleX: scale, scaleY: scale, rotation: 0 } })
  }

  it('keeps full size when drawn at or above half size', () => {
    expect(sourceHalvings(VIDEO, scaled(1), 1)).toBe(0)
    expect(sourceHalvings(VIDEO, scaled(3), 1)).toBe(0)
    expect(sourceHalvings(VIDEO, scaled(0.51), 1)).toBe(0)
  })

  it('halves once per power of two the clip is drawn below full size', () => {
    expect(sourceHalvings(VIDEO, scaled(0.5), 1)).toBe(1)
    expect(sourceHalvings(VIDEO, scaled(0.3), 1)).toBe(1)
    expect(sourceHalvings(VIDEO, scaled(0.25), 1)).toBe(2)
    expect(sourceHalvings(VIDEO, scaled(1), 0.5)).toBe(1)
    expect(sourceHalvings(VIDEO, scaled(0.5), 0.5)).toBe(2)
  })

  it('uses the largest scale the clip ever reaches', () => {
    const zooming = videoClip({
      transform: { x: 0, y: 0, scaleX: 0.25, scaleY: 0.25, rotation: 0 },
      keyframes: { scaleX: keyframes([0, 0.25, 'linear'], [SECOND, 1, 'linear']), scaleY: keyframes([0, 0.25, 'linear'], [SECOND, 0.5, 'linear']) },
    })
    expect(sourceHalvings(VIDEO, zooming, 1)).toBe(0)
  })

  it('always halves sources too large for the GPU, and stops at a floor', () => {
    const huge = { ...VIDEO, width: 7680, height: 4320 }
    expect(sourceHalvings(huge, scaled(4), 1)).toBe(1)
    expect(sourceHalvings(huge, scaled(0.2), 1)).toBe(2)
    expect(sourceHalvings(VIDEO, scaled(0.0001), 1)).toBe(6)
    expect(sourceHalvings(VIDEO, scaled(0), 1)).toBe(6)
  })
})

describe('transitionChange', () => {
  const CANVAS = { width: 1920, height: 1080 }

  function change(type: TransitionType, progress: number, isArriving: boolean, isOnCut = true): ReturnType<typeof transitionChange> {
    const part: TransitionPart = { type, progress, isArriving, isOnCut }
    return transitionChange(part, CANVAS)
  }

  it.each(TRANSITION_TYPES)('%s leaves the arriving picture whole at its end and the leaving one whole at its start', (type) => {
    for (const whole of [change(type, 1, true), change(type, 0, false)]) {
      expect(whole).toMatchObject({ opacity: 1, scale: 1 })
      expect(Math.abs(whole.offsetX)).toBe(0)
      expect(Math.abs(whole.offsetY)).toBe(0)
      expect(Math.abs(whole.rotation)).toBe(0)
      expect(whole.tint?.amount ?? 0).toBe(0)
    }
  })

  it('shares a dissolve so that the two pictures always add up to one', () => {
    for (const progress of [0, 0.25, 0.5, 0.9, 1]) {
      expect(change('crossDissolve', progress, true).opacity + change('crossDissolve', progress, false).opacity).toBeCloseTo(1, 12)
    }
  })

  it('takes one half of a fade through a colour to reach the colour and the other to leave it', () => {
    expect(change('fadeBlack', 0.25, false)).toMatchObject({ opacity: 1, tint: { color: 'black', amount: 0.5 } })
    expect(change('fadeBlack', 0.5, false)).toMatchObject({ opacity: 1, tint: { color: 'black', amount: 1 } })
    expect(change('fadeBlack', 0.75, false)).toMatchObject({ opacity: 0.5, tint: { color: 'black', amount: 1 } })
    expect(change('fadeWhite', 0.25, true)).toMatchObject({ opacity: 0.5, tint: { color: 'white', amount: 1 } })
    expect(change('fadeWhite', 0.75, true)).toMatchObject({ opacity: 1, tint: { color: 'white', amount: 0.5 } })
  })

  it('moves the edge of a wipe across the canvas, with the two pictures on opposite sides of it', () => {
    expect(change('wipeLeft', 0.5, true).reveal).toEqual({ kind: 'line', x: 960, y: 0, normalX: 1, normalY: 0 })
    expect(change('wipeLeft', 0.5, false).reveal).toEqual({ kind: 'line', x: 960, y: 0, normalX: -1, normalY: -0 })
    expect(change('wipeLeft', 0, true).reveal).toMatchObject({ x: 1920 })
    expect(change('wipeRight', 0, true).reveal).toMatchObject({ x: 0, normalX: -1 })
    expect(change('wipeUp', 1, true).reveal).toMatchObject({ y: 0, normalY: 1 })
    expect(change('wipeDown', 0.5, true).reveal).toMatchObject({ y: 540, normalY: -1 })
  })

  it('slides the new picture in from the right over one that stays, and pushes the old one out to the left', () => {
    expect(change('slide', 0, true).offsetX).toBe(1920)
    expect(change('slide', 0.5, true).offsetX).toBe(960)
    expect(change('slide', 0.5, false)).toMatchObject({ offsetX: 0, opacity: 1 })
    expect(change('slide', 0.5, false, false).offsetX).toBe(-960)
    expect(change('push', 0.5, false).offsetX).toBe(-960)
    expect(change('push', 1, false).offsetX).toBe(-1920)
  })

  it('grows the leaving picture and the arriving one while they dissolve in a zoom', () => {
    expect(change('zoom', 0, true)).toMatchObject({ opacity: 0, scale: 0.5 })
    expect(change('zoom', 0.5, true)).toMatchObject({ opacity: 0.5, scale: 0.75 })
    expect(change('zoom', 1, false)).toMatchObject({ opacity: 0, scale: 2 })
  })

  it('opens a circle from the middle of the canvas that reaches its corners at the end', () => {
    expect(change('circleReveal', 0, true).reveal).toEqual({ kind: 'circle', x: 960, y: 540, radius: 0, isInside: true })
    expect(change('circleReveal', 1, false).reveal).toEqual({ kind: 'circle', x: 960, y: 540, radius: Math.hypot(960, 540), isInside: false })
  })

  it('closes a circle on the leaving picture, with the arriving one around it', () => {
    expect(change('circleClose', 0, true).reveal).toEqual({ kind: 'circle', x: 960, y: 540, radius: Math.hypot(960, 540), isInside: false })
    expect(change('circleClose', 0.5, false).reveal).toEqual({ kind: 'circle', x: 960, y: 540, radius: Math.hypot(960, 540) / 2, isInside: true })
  })

  it.each<{ type: TransitionType; corner: { x: number; y: number } }>([
    { type: 'wipeUpLeft', corner: { x: 1920, y: 1080 } },
    { type: 'wipeUpRight', corner: { x: 0, y: 1080 } },
    { type: 'wipeDownLeft', corner: { x: 1920, y: 0 } },
    { type: 'wipeDownRight', corner: { x: 0, y: 0 } },
  ])('sweeps the edge of $type from its corner through the middle to the opposite corner', ({ type, corner }) => {
    function past(reveal: ReturnType<typeof change>['reveal'], x: number, y: number): number {
      if (reveal?.kind !== 'line') throw new Error('Expected a wipe')
      return (x - reveal.x) * reveal.normalX + (y - reveal.y) * reveal.normalY
    }
    const opposite = { x: 1920 - corner.x, y: 1080 - corner.y }
    expect(past(change(type, 0, true).reveal, corner.x, corner.y)).toBeCloseTo(0, 9)
    expect(past(change(type, 0.5, true).reveal, 960, 540)).toBeCloseTo(0, 9)
    expect(past(change(type, 1, true).reveal, opposite.x, opposite.y)).toBeCloseTo(0, 9)
    expect(past(change(type, 0.5, true).reveal, corner.x, corner.y)).toBeGreaterThan(0)
    expect(past(change(type, 0.5, false).reveal, opposite.x, opposite.y)).toBeGreaterThan(0)
  })

  it.each<{ type: TransitionType; arrivingFrom: { x: number; y: number } }>([
    { type: 'slideRight', arrivingFrom: { x: -1920, y: 0 } },
    { type: 'slideUp', arrivingFrom: { x: 0, y: 1080 } },
    { type: 'slideDown', arrivingFrom: { x: 0, y: -1080 } },
    { type: 'pushRight', arrivingFrom: { x: -1920, y: 0 } },
    { type: 'pushUp', arrivingFrom: { x: 0, y: 1080 } },
    { type: 'pushDown', arrivingFrom: { x: 0, y: -1080 } },
  ])('brings the new picture of $type in from a canvas away', ({ type, arrivingFrom }) => {
    const start = change(type, 0, true)
    expect(start.offsetX).toBeCloseTo(arrivingFrom.x, 9)
    expect(start.offsetY).toBeCloseTo(arrivingFrom.y, 9)
    const halfway = change(type, 0.5, false)
    const isPush = type.startsWith('push')
    expect(halfway.offsetX).toBeCloseTo(isPush ? -arrivingFrom.x / 2 : 0, 9)
    expect(halfway.offsetY).toBeCloseTo(isPush ? -arrivingFrom.y / 2 : 0, 9)
  })

  it('shrinks the leaving picture of a shrink away over the arriving one, which grows in on its own', () => {
    expect(change('shrink', 0.5, false)).toMatchObject({ opacity: 1, scale: 0.5, rotation: 0 })
    expect(change('shrink', 0.5, true)).toMatchObject({ opacity: 1, scale: 1 })
    expect(change('shrink', 0.5, true, false)).toMatchObject({ opacity: 1, scale: 0.5 })
  })

  it('turns the leaving picture of a spin once while it shrinks, and fades the arriving one in beneath it', () => {
    expect(change('spin', 0.5, false)).toMatchObject({ opacity: 1, scale: 0.5, rotation: 180 })
    expect(change('spin', 0.5, true)).toMatchObject({ opacity: 0.5, scale: 1, rotation: 0 })
    expect(change('spin', 0, true, false)).toMatchObject({ scale: 0, rotation: -360 })
  })
})

describe('transitions on a track', () => {
  const HALF = SECOND / 2

  function cut(type: TransitionType, first: Partial<VideoClip> = {}, second: Partial<VideoClip> = {}): Clip[] {
    return [
      videoClip({ id: 'first', start: 0, duration: 2 * SECOND, sourceStart: 2 * SECOND, ...first }),
      videoClip({ id: 'second', start: 2 * SECOND, duration: 2 * SECOND, sourceStart: 4 * SECOND, transitionIn: { type, duration: SECOND }, ...second }),
    ]
  }

  function idsAt(clips: Clip[], time: number): string[] {
    return layersAt(clips, time).map((layer) => layer.clipId)
  }

  function frameOf(layer: Layer | undefined): number {
    if (layer?.kind !== 'video') throw new Error('Expected a video layer')
    return layer.frame
  }

  it('draws both clips for the whole length of a transition on their cut, the leaving one first', () => {
    const clips = cut('crossDissolve')
    expect(idsAt(clips, 2 * SECOND - HALF - 100)).toEqual(['first'])
    expect(idsAt(clips, 2 * SECOND - HALF)).toEqual(['first', 'second'])
    expect(idsAt(clips, 2 * SECOND)).toEqual(['first', 'second'])
    expect(idsAt(clips, 2 * SECOND + HALF - 100)).toEqual(['first', 'second'])
    expect(idsAt(clips, 2 * SECOND + HALF)).toEqual(['second'])
  })

  it('marks the two layers of a dissolve to be added up, at shares that make one', () => {
    const [leaving, arriving] = layersAt(cut('crossDissolve'), 2 * SECOND - HALF / 2)
    expect(leaving?.opacity).toBeCloseTo(0.75, 12)
    expect(arriving?.opacity).toBeCloseTo(0.25, 12)
    expect(leaving?.transition?.mixKey).toBe('second')
    expect(arriving?.transition?.mixKey).toBe('second')
  })

  it.each<TransitionType>(['slide', 'push', 'fadeBlack', 'fadeWhite'])('draws the layers of a %s one over the other', (type) => {
    const layers = layersAt(cut(type), 2 * SECOND)
    expect(layers.map((layer) => layer.transition?.mixKey)).toEqual([undefined, undefined])
  })

  it.each<TransitionType>(['shrink', 'spin'])('draws the leaving picture of a %s over the arriving one', (type) => {
    expect(idsAt(cut(type), 2 * SECOND)).toEqual(['second', 'first'])
  })

  it('turns the leaving picture of a spin about the middle of the canvas', () => {
    const [, leaving] = layersAt(cut('spin', { transform: { x: 1460, y: 540, scaleX: 1, scaleY: 1, rotation: 10 } }), 2 * SECOND)
    expect(leaving?.placed?.x).toBeCloseTo(960 - 250, 9)
    expect(leaving?.placed?.y).toBeCloseTo(540, 9)
    expect(leaving?.placed).toMatchObject({ scaleX: 0.5, scaleY: 0.5, rotation: 190 })
  })

  it('moves the picture of a slide and leaves the place of the clip as it is', () => {
    const [leaving, arriving] = layersAt(cut('slide'), 2 * SECOND)
    expect(leaving?.placed).toEqual(leaving?.transform)
    expect(arriving?.transform.x).toBe(960)
    expect(arriving?.placed?.x).toBe(960 + 960)
  })

  it('plays a clip on through its file beyond the cut', () => {
    const clips = cut('crossDissolve')
    const afterCut = layersAt(clips, 2 * SECOND + HALF / 2)
    const beforeCut = layersAt(clips, 2 * SECOND - HALF / 2)
    expect(frameOf(afterCut[0])).toBe(Math.floor((4 * SECOND + HALF / 2) / FRAME_30))
    expect(frameOf(beforeCut[1])).toBe(Math.floor((4 * SECOND - HALF / 2) / FRAME_30))
  })

  it('holds the last and the first frame where the file has no more footage', () => {
    const clips = cut('crossDissolve', { sourceStart: 8 * SECOND }, { sourceStart: 0 })
    expect(frameOf(layersAt(clips, 2 * SECOND + HALF / 2)[0])).toBe(299)
    expect(frameOf(layersAt(clips, 2 * SECOND - HALF / 2)[1])).toBe(0)
  })

  it('treats clips that do not touch as two clips with a transition each', () => {
    const clips = cut('crossDissolve', {}, { start: 2 * SECOND + 100 })
    expect(idsAt(clips, 2 * SECOND - HALF / 2)).toEqual(['first'])
    const alone = layersAt(clips, 2 * SECOND + 100 + HALF)
    expect(alone.map((layer) => layer.clipId)).toEqual(['second'])
    expect(alone[0]?.opacity).toBeCloseTo(0.5, 12)
    expect(alone[0]?.transition?.mixKey).toBeUndefined()
  })

  it('plays a transition at the start and at the end of a clip inside the clip', () => {
    const clip = videoClip({ duration: 4 * SECOND, transitionIn: { type: 'crossDissolve', duration: SECOND }, transitionOut: { type: 'push', duration: SECOND } })
    expect(videoLayerAt(clip, SECOND / 4).opacity).toBeCloseTo(0.25, 12)
    expect(videoLayerAt(clip, SECOND).transition).toBeUndefined()
    expect(videoLayerAt(clip, 3 * SECOND - 100).transition).toBeUndefined()
    expect(videoLayerAt(clip, 3 * SECOND + HALF).placed?.x).toBe(960 - 960)
  })

  it('does not play the end transition of a clip whose cut has a transition of its own', () => {
    const clips = cut('crossDissolve', { transitionOut: { type: 'push', duration: SECOND } })
    const [leaving] = layersAt(clips, 2 * SECOND - HALF / 2)
    expect(leaving?.placed).toEqual(leaving?.transform)
    expect(layersAt(clips, SECOND + 100)[0]?.transition).toBeUndefined()
  })

  it('plays the nearer cut when a clip is shorter than its two transitions', () => {
    const clips: Clip[] = [
      videoClip({ id: 'a', start: 0, duration: 2 * SECOND }),
      videoClip({ id: 'b', start: 2 * SECOND, duration: SECOND / 2, transitionIn: { type: 'crossDissolve', duration: SECOND } }),
      videoClip({ id: 'c', start: 2.5 * SECOND, duration: 2 * SECOND, transitionIn: { type: 'crossDissolve', duration: SECOND } }),
    ]
    expect(idsAt(clips, 2 * SECOND + SECOND / 8)).toEqual(['a', 'b'])
    expect(idsAt(clips, 2 * SECOND + (3 * SECOND) / 8)).toEqual(['b', 'c'])
  })

  it('keeps a clip as faded as at its end while a transition draws it past that end', () => {
    const clips = cut('slide', { fadeOut: SECOND })
    expect(layersAt(clips, 2 * SECOND + HALF / 2)[0]?.opacity).toBe(0)
    expect(layersAt(clips, 2 * SECOND - HALF)[0]?.opacity).toBeCloseTo(0.5, 12)
  })
})

describe('effects and shapes', () => {
  const PLACE = { x: 400, y: 300, scaleX: 1, scaleY: 1, rotation: 0 }
  const blur: Clip = { id: 'blur', type: 'blur', start: 0, duration: SECOND, transform: PLACE, opacity: 1, width: 300, height: 100, shape: 'rectangle', softEdge: 4, strength: 12 }
  const spotlight: Clip = { id: 'spot', type: 'highlight', start: SECOND, duration: SECOND, transform: PLACE, opacity: 0.5, width: 200, height: 200, shape: 'ellipse', softEdge: 0, color: '#404040', isSpotlight: true, transitionIn: { type: 'crossDissolve', duration: SECOND } }

  it('passes on the effects that are switched on, in their order', () => {
    const clip = videoClip({
      effects: [
        { type: 'border', width: 4, color: '#FFFFFF' },
        { type: 'clipBlur', strength: 6, isOff: true },
        { type: 'blackAndWhite', amount: 1 },
      ],
    })
    expect(videoLayerAt(clip, 0).effects).toEqual([
      { type: 'border', width: 4, color: '#FFFFFF' },
      { type: 'blackAndWhite', amount: 1 },
    ])
    expect(videoLayerAt(videoClip({ effects: [{ type: 'blackAndWhite', amount: 1, isOff: true }] }), 0).effects).toBeUndefined()
  })

  it('resolves a blur clip and a highlight clip without any media', () => {
    expect(resolveFrame(project([track([blur])]), {}, 0, 1)).toEqual([
      { kind: 'blur', clipId: 'blur', transform: PLACE, opacity: 1, width: 300, height: 100, shape: 'rectangle', softEdge: 4, strength: 12, isPixelated: false },
    ])
    expect(resolveFrame(project([track([{ ...spotlight, transitionIn: undefined }])]), {}, SECOND, 1)).toEqual([
      { kind: 'highlight', clipId: 'spot', transform: PLACE, opacity: 0.5, width: 200, height: 200, shape: 'ellipse', softEdge: 0, color: '#404040', isSpotlight: true },
    ])
  })

  it('never adds a clip without a picture to its neighbour, whatever the transition', () => {
    const layers = resolveFrame(project([track([blur, spotlight])]), {}, SECOND, 1)
    expect(layers.map((layer) => layer.clipId)).toEqual(['blur', 'spot'])
    expect(layers.map((layer) => layer.transition?.mixKey)).toEqual([undefined, undefined])
    expect(layers[1]?.opacity).toBeCloseTo(0.25, 12)
  })
})

describe('decode size under a camera zoom', () => {
  const half = { x: 960, y: 540, scaleX: 0.5, scaleY: 0.5, rotation: 0 }

  function halvingsWith(camera: CameraKeyframe[], clips: Clip[], time: number): number {
    const layer = resolveFrame({ ...project([track(clips)]), camera }, MEDIA, time, 1).at(-1)
    if (layer?.kind !== 'video') throw new Error('Expected a video layer')
    return layer.halvings
  }

  const zoomAtThree: CameraKeyframe[] = [{ time: 3 * SECOND, duration: SECOND, easing: 'linear', x: 960, y: 540, scale: 2 }]

  it('decodes a clip for the largest zoom that happens while it is on screen, at every moment of the clip', () => {
    const clip = videoClip({ transform: half })
    expect(halvingsWith(zoomAtThree, [clip], 0)).toBe(0)
    expect(halvingsWith(zoomAtThree, [clip], 4 * SECOND)).toBe(0)
  })

  it('does not decode more for a zoom that starts after the clip has ended', () => {
    const clip = videoClip({ transform: half, duration: 2 * SECOND })
    expect(halvingsWith(zoomAtThree, [clip], SECOND)).toBe(1)
  })

  it('counts the half of a transition that draws the clip past its end', () => {
    const clips: Clip[] = [
      videoClip({ id: 'first', transform: half, duration: 2 * SECOND }),
      videoClip({ id: 'second', transform: half, start: 2 * SECOND, duration: 2 * SECOND, transitionIn: { type: 'crossDissolve', duration: SECOND } }),
    ]
    const layers = resolveFrame({ ...project([track(clips)]), camera: zoomAtThree }, MEDIA, SECOND, 1)
    expect(layers[0]).toMatchObject({ clipId: 'first', halvings: 0 })
  })
})

describe('callouts and arrows', () => {
  it('describes a callout and an arrow for the one who draws them', () => {
    const base = { start: 0, duration: SECOND, transform: { x: 100, y: 200, scaleX: 2, scaleY: 3, rotation: 0 }, opacity: 1 }
    const callout: Clip = { ...base, id: 'note', type: 'callout', width: 300, height: 100, shape: 'speechBubble', fill: '#FFFFFF', borderColor: '#000000', borderWidth: 4, tail: { x: -200, y: 90 }, text: 'Here', font: { family: 'Helvetica', size: 40, weight: 700 }, color: '#000000', align: 'center' }
    const arrow: Clip = { ...base, id: 'pointer', type: 'arrow', length: 250, thickness: 10, color: '#FF0000', startHead: 'none', endHead: 'triangle' }
    const [calloutLayer, arrowLayer] = resolveFrame(project([track([callout]), track([arrow])]), {}, 0, 1)
    expect(calloutLayer).toEqual({
      kind: 'callout',
      clipId: 'note',
      transform: base.transform,
      opacity: 1,
      sharpScaleX: 2,
      sharpScaleY: 3,
      look: { width: 300, height: 100, shape: 'speechBubble', fill: '#FFFFFF', borderColor: '#000000', borderWidth: 4, tail: { x: -200, y: 90 }, text: { text: 'Here', font: { family: 'Helvetica', size: 40, weight: 700 }, color: '#000000', align: 'center' } },
    })
    expect(arrowLayer).toMatchObject({ kind: 'arrow', clipId: 'pointer', look: { length: 250, thickness: 10, color: '#FF0000', startHead: 'none', endHead: 'triangle' } })
  })

  it('makes the picture of a text for the largest scale its keyframes reach', () => {
    const grow: Keyframe[] = [{ time: 0, value: 0.5, easing: 'linear' }, { time: SECOND, value: 4, easing: 'linear' }]
    const text: Clip = { id: 'title', type: 'text', start: 0, duration: 2 * SECOND, text: 'Hi', font: { family: 'Helvetica', size: 72 }, color: '#FFFFFF', align: 'left', transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 }, opacity: 1, keyframes: { scaleX: grow, scaleY: grow } }
    for (const time of [0, SECOND / 2, 2 * SECOND - FRAME_30]) {
      expect(layersAt([text], time)[0]).toMatchObject({ sharpScaleX: 4, sharpScaleY: 4 })
    }
  })
})

describe('animations', () => {
  const HALF = SECOND / 2
  const text: Extract<Clip, { type: 'text' }> = { id: 'title', type: 'text', start: SECOND, duration: 4 * SECOND, text: 'Hello you', font: { family: 'Helvetica', size: 72 }, color: '#FFFFFF', align: 'left', transform: { x: 500, y: 300, scaleX: 2, scaleY: 2, rotation: 0 }, opacity: 0.8 }

  function animated(changes: Partial<typeof text>, time: number): Layer | undefined {
    return layersAt([{ ...text, ...changes }], time)[0]
  }

  it('leaves a clip without animations alone', () => {
    const layer = animated({}, 2 * SECOND)
    expect(layer?.placed).toBeUndefined()
    expect(layer?.opacity).toBe(0.8)
  })

  it('fades in and out, on top of the clip\'s own opacity', () => {
    const changes = { animationIn: { type: 'fade', duration: SECOND }, animationOut: { type: 'fade', duration: 2 * SECOND } } as const
    expect(animated(changes, SECOND)?.opacity).toBe(0)
    expect(animated(changes, SECOND + HALF)?.opacity).toBeCloseTo(0.4)
    expect(animated(changes, 2 * SECOND)?.opacity).toBeCloseTo(0.8)
    expect(animated(changes, 4 * SECOND)?.opacity).toBeCloseTo(0.4)
  })

  it('moves the drawn layer and keeps the clip\'s own place for the handles', () => {
    const sliding = animated({ animationIn: { type: 'slideLeft', duration: SECOND } }, SECOND)
    expect(sliding?.transform).toEqual(text.transform)
    expect(sliding?.placed).toEqual({ ...text.transform, x: 500 - 1920 })
    expect(animated({ animationIn: { type: 'slideLeft', duration: SECOND } }, 2 * SECOND)?.placed).toEqual(text.transform)
    expect(animated({ animationOut: { type: 'slideDown', duration: SECOND } }, 5 * SECOND - 100)?.placed?.y).toBeGreaterThan(300 + 1070)
    expect(animated({ animationIn: { type: 'slideRight', duration: SECOND } }, SECOND)?.placed?.x).toBe(500 + 1920)
    expect(animated({ animationIn: { type: 'slideUp', duration: SECOND } }, SECOND)?.placed?.y).toBe(300 - 1080)
  })

  it('pops past its size and settles, and is drawn sharp for the largest size', () => {
    const popping = { animationIn: { type: 'pop', duration: SECOND } } as const
    expect(animated(popping, SECOND)?.placed?.scaleX).toBe(0)
    expect(animated(popping, SECOND + 0.6 * SECOND)?.placed?.scaleX).toBeCloseTo(2.2)
    expect(animated(popping, 2 * SECOND)?.placed?.scaleX).toBe(2)
    expect(animated(popping, 3 * SECOND)).toMatchObject({ sharpScaleX: 2.2, sharpScaleY: 2.2 })
  })

  it('zooms in from half its size while it fades in, and out the same way backwards', () => {
    const zooming = { animationIn: { type: 'zoom', duration: SECOND }, animationOut: { type: 'zoom', duration: SECOND } } as const
    expect(animated(zooming, SECOND)).toMatchObject({ opacity: 0, placed: { scaleX: 1, scaleY: 1 } })
    expect(animated(zooming, 5 * SECOND - HALF)?.opacity).toBeCloseTo(0.4)
    expect(animated(zooming, 5 * SECOND - HALF)?.placed?.scaleX).toBeCloseTo(2 * (0.5 + 0.5 * (1 - 0.5 ** 3)))
  })

  it('types a text letter by letter', () => {
    const typing = { animationIn: { type: 'typewriter', duration: 3 * SECOND } } as const
    expect(animated(typing, SECOND)).toMatchObject({ shownLetters: 0 })
    expect(animated(typing, 2 * SECOND)).toMatchObject({ shownLetters: 3 })
    expect(animated({ ...typing, text: '👨‍👩‍👧 née\nab' }, 3 * SECOND)).toMatchObject({ shownLetters: 4 })
    expect(animated(typing, 4 * SECOND)).not.toHaveProperty('shownLetters')
  })

  it('lets a transition move what the animation has placed', () => {
    const both = animated({ animationIn: { type: 'pop', duration: 2 * SECOND }, transitionIn: { type: 'slide', duration: SECOND } }, SECOND)
    expect(both?.placed?.scaleX).toBe(0)
    expect(both?.placed?.x).toBe(500 + 1920)
  })
})

describe('groups', () => {
  type Group = Extract<Clip, { type: 'group' }>
  const IDENTITY = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 }

  function member(id: string, x: number, y: number, overrides: Partial<VideoClip> = {}): VideoClip {
    return videoClip({ id, start: 0, duration: 4 * SECOND, transform: { x, y, scaleX: 0.5, scaleY: 0.25, rotation: 10 }, ...overrides })
  }

  function group(overrides: Partial<Group>, ...tracks: Clip[][]): Group {
    return { id: 'group', type: 'group', start: 2 * SECOND, duration: 3 * SECOND, transform: IDENTITY, opacity: 1, volume: 1, tracks: tracks.map((clips) => track(clips)), ...overrides }
  }

  it('draws its members where the group puts them, bottom track first', () => {
    const grouped = group({ transform: { x: 1000, y: 500, scaleX: 2, scaleY: 2, rotation: 90 } }, [member('below', 100, 0)], [member('above', 0, 50)])
    const layers = layersAt([grouped], 2 * SECOND)
    expect(layers.map((layer) => layer.clipId)).toEqual(['below', 'above'])
    const [below, above] = layers
    expect(below?.transform.x).toBeCloseTo(1000)
    expect(below?.transform.y).toBeCloseTo(500 + 200)
    expect(above?.transform.x).toBeCloseTo(1000 - 100)
    expect(above?.transform.y).toBeCloseTo(500)
    expect(below?.transform).toMatchObject({ scaleX: 1, scaleY: 0.5, rotation: 100 })
    expect(below?.groups).toEqual(['group'])
  })

  it('leaves a member untouched when the group changes nothing', () => {
    const alone = layersAt([member('m', 300, 200, { start: 2 * SECOND })], 3 * SECOND)[0]
    const grouped = layersAt([group({}, [member('m', 300, 200)])], 3 * SECOND)[0]
    expect(grouped).toEqual({ ...alone, groups: ['group'] })
  })

  it('shows its members in its own time, from its content start on', () => {
    const late = member('late', 0, 0, { start: SECOND, duration: SECOND, sourceStart: 0 })
    const grouped = group({ contentStart: SECOND / 2 }, [late])
    expect(layersAt([grouped], 2 * SECOND)).toEqual([])
    const shown = layersAt([grouped], 2 * SECOND + SECOND / 2 + 3 * FRAME_30)[0]
    expect(shown).toMatchObject({ clipId: 'late', frame: 3 })
    expect(layersAt([grouped], 3 * SECOND + SECOND / 2)).toEqual([])
    expect(layersAt([grouped], SECOND)).toEqual([])
  })

  it('multiplies its opacity and fades into every member', () => {
    const grouped = group({ opacity: 0.5, fadeIn: SECOND, keyframes: { opacity: [{ time: 0, value: 0.5, easing: 'linear' }] } }, [member('m', 0, 0, { opacity: 0.8 })])
    expect(layersAt([grouped], 2 * SECOND + SECOND / 2)[0]?.opacity).toBeCloseTo(0.8 * 0.5 * 0.5)
    expect(layersAt([grouped], 4 * SECOND)[0]?.opacity).toBeCloseTo(0.4)
  })

  it('follows the keyframes and animations of the group', () => {
    const moving = group({ keyframes: { x: [{ time: 0, value: 0, easing: 'linear' }, { time: 2 * SECOND, value: 400, easing: 'linear' }] }, animationIn: { type: 'slideUp', duration: SECOND } }, [member('m', 10, 20)])
    const start = layersAt([moving], 2 * SECOND)[0]
    expect(start?.transform.x).toBe(10)
    expect(start?.transform.y).toBe(20 - 1080)
    const later = layersAt([moving], 3 * SECOND)[0]
    expect(later?.transform.x).toBe(210)
    expect(later?.transform.y).toBe(20)
  })

  it('adds its effects after the member\'s own and scales lengths with the group', () => {
    const own = member('m', 0, 0, { effects: [{ type: 'border', width: 4, color: '#FFFFFF' }, { type: 'blackAndWhite', amount: 1, isOff: true }] })
    const grouped = group({ transform: { ...IDENTITY, scaleX: 3, scaleY: 3 }, effects: [{ type: 'roundedCorners', radius: 10 }, { type: 'clipBlur', strength: 5, isOff: true }] }, [own])
    const layer = layersAt([grouped], 2 * SECOND)[0]
    expect(layer?.kind === 'video' && layer.effects).toEqual([{ type: 'border', width: 12, color: '#FFFFFF' }, { type: 'roundedCorners', radius: 10 }])
  })

  it('scales the strength and the soft edge of a blur inside, and gives it no effects', () => {
    const blur: Clip = { id: 'blur', type: 'blur', start: 0, duration: 4 * SECOND, transform: IDENTITY, opacity: 1, width: 100, height: 50, shape: 'ellipse', softEdge: 4, strength: 10 }
    const grouped = group({ transform: { ...IDENTITY, scaleX: 2, scaleY: 2 }, effects: [{ type: 'blackAndWhite', amount: 1 }] }, [blur])
    expect(layersAt([grouped], 2 * SECOND)[0]).toEqual({ kind: 'blur', clipId: 'blur', groups: ['group'], transform: { ...IDENTITY, scaleX: 2, scaleY: 2 }, opacity: 1, width: 100, height: 50, shape: 'ellipse', softEdge: 8, strength: 20, isPixelated: false })
  })

  it('composes groups inside groups', () => {
    const inner = group({ id: 'inner', start: 0, duration: 4 * SECOND, transform: { x: 100, y: 0, scaleX: 2, scaleY: 2, rotation: 0 }, opacity: 0.5 }, [member('m', 10, 0)])
    const outer = group({ id: 'outer', transform: { x: 1000, y: 500, scaleX: 0.5, scaleY: 0.5, rotation: 180 }, opacity: 0.5 }, [inner])
    const layer = layersAt([outer], 3 * SECOND)[0]
    expect(layer?.transform.x).toBeCloseTo(1000 - 0.5 * (100 + 2 * 10))
    expect(layer?.transform.y).toBeCloseTo(500)
    expect(layer?.transform).toMatchObject({ scaleX: 0.5, scaleY: 0.25, rotation: 190 })
    expect(layer?.opacity).toBeCloseTo(0.25)
    expect(layer?.groups).toEqual(['outer', 'inner'])
  })

  it('plays a transition of the group on every member, without adding pictures up', () => {
    const before = videoClip({ id: 'before', start: 0, duration: 2 * SECOND })
    const grouped = group({ transitionIn: { type: 'crossDissolve', duration: SECOND } }, [member('a', 0, 0)], [member('b', 0, 0)])
    const layers = layersAt([before, grouped], 2 * SECOND)
    expect(layers.map((layer) => layer.clipId)).toEqual(['before', 'a', 'b'])
    expect(layers.map((layer) => layer.opacity)).toEqual([0.5, 0.5, 0.5])
    expect(layers.every((layer) => layer.transition?.mixKey === undefined)).toBe(true)

    const wiped = layersAt([group({ transitionIn: { type: 'wipeLeft', duration: SECOND } }, [member('a', 0, 0)])], 2 * SECOND)[0]
    expect(wiped?.transition?.reveal).toMatchObject({ kind: 'line' })
  })

  it('skips hidden tracks inside and draws nothing for an empty group', () => {
    const grouped = group({}, [member('seen', 0, 0)], [member('unseen', 0, 0)])
    grouped.tracks[1]!.hidden = true
    expect(layersAt([grouped], 2 * SECOND).map((layer) => layer.clipId)).toEqual(['seen'])
    expect(layersAt([group({})], 2 * SECOND)).toEqual([])
  })

  it('decodes a member for the largest size the group reaches', () => {
    const grow: Keyframe[] = [{ time: 0, value: 0.25, easing: 'linear' }, { time: SECOND, value: 1, easing: 'linear' }]
    const still = layersAt([group({ transform: { ...IDENTITY, scaleX: 0.25, scaleY: 0.25 } }, [member('m', 0, 0, { transform: IDENTITY })])], 2 * SECOND)[0]
    const growing = layersAt([group({ transform: { ...IDENTITY, scaleX: 0.25, scaleY: 0.25 }, keyframes: { scaleX: grow, scaleY: grow } }, [member('m', 0, 0, { transform: IDENTITY })])], 2 * SECOND)[0]
    expect(still).toMatchObject({ halvings: 2 })
    expect(growing).toMatchObject({ halvings: 0 })
  })

  it('tells the editor where a group puts its members', () => {
    const inner = group({ id: 'inner', start: SECOND, duration: SECOND, transform: { x: 100, y: 0, scaleX: 2, scaleY: 2, rotation: 0 } }, [member('m', 0, 0)])
    const outer = group({ id: 'outer', transform: { x: 1000, y: 500, scaleX: 0.5, scaleY: 0.5, rotation: 90 } }, [inner])
    const whole = project([track([outer])])
    expect(groupFrameAt(whole, [], 3 * SECOND)).toMatchObject({ x: 0, y: 0, scale: 1, rotation: 0 })
    expect(groupFrameAt(whole, ['outer'], 3 * SECOND)).toMatchObject({ x: 1000, y: 500, scale: 0.5, rotation: 90 })
    const frame = groupFrameAt(whole, ['outer', 'inner'], 3 * SECOND)
    expect(frame.x).toBeCloseTo(1000)
    expect(frame.y).toBeCloseTo(550)
    expect(frame).toMatchObject({ scale: 1, rotation: 90 })
  })
})

describe('pictureRanges', () => {
  it('lists the video the visible tracks show, members of groups from where the group shows them', () => {
    const shown = videoClip({ id: 'shown', start: 2 * SECOND, duration: 4 * SECOND, sourceStart: SECOND, speedPercent: 200 })
    const hidden = track([videoClip({ id: 'hidden', duration: SECOND })], { hidden: true })
    const looping = videoClip({ id: 'looping', mediaId: 'sticker', loop: true })
    const group: Clip = { id: 'group', type: 'group', start: 10 * SECOND, duration: 2 * SECOND, contentStart: SECOND, transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 }, opacity: 1, volume: 1, tracks: [track([looping])] }
    const media: MediaStates = { ...MEDIA, sticker: { info: videoMedia({ codec: 'gif' }) } }
    expect(pictureRanges(project([track([shown]), hidden, track([group])]), media)).toEqual([
      { mediaId: 'footage', use: 'picture', timelineStart: 2 * SECOND, timelineEnd: 6 * SECOND, sourceStart: SECOND, speedPercent: 200, isLooping: false },
      { mediaId: 'sticker', use: 'picture', timelineStart: 10 * SECOND, timelineEnd: 12 * SECOND, sourceStart: SECOND, speedPercent: 100, isLooping: true },
    ])
  })
})
