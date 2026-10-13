import { describe, expect, it } from 'vitest'
import type { MediaInfo, VideoInfo } from '../shared/mediaProtocol.js'
import { TRANSITION_TYPES, ease, type CameraKeyframe, type Clip, type Easing, type Keyframe, type Project, type Track, type TransitionType, type VideoClip } from '../shared/project.js'
import { fadeFactor, resolveFrame, sourceHalvings, transitionChange, valueAt, type Layer, type MediaStates, type TransitionPart, type VideoLayer } from './resolve.js'

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
  isHdr: false,
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
      { kind: 'text', clipId: 'title', text: 'Hello', family: 'Helvetica', size: 72, color: '#FFFFFF', align: 'center', transform: text.transform, opacity: 1 },
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
      expect(whole).toMatchObject({ opacity: 1, offsetY: 0, scale: 1 })
      expect(Math.abs(whole.offsetX)).toBe(0)
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

  it('moves the picture of a slide and leaves the place of the clip as it is', () => {
    const [leaving, arriving] = layersAt(cut('slide'), 2 * SECOND)
    expect(leaving?.transition?.transform).toEqual(leaving?.transform)
    expect(arriving?.transform.x).toBe(960)
    expect(arriving?.transition?.transform.x).toBe(960 + 960)
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
    expect(videoLayerAt(clip, 3 * SECOND + HALF).transition?.transform.x).toBe(960 - 960)
  })

  it('does not play the end transition of a clip whose cut has a transition of its own', () => {
    const clips = cut('crossDissolve', { transitionOut: { type: 'push', duration: SECOND } })
    const [leaving] = layersAt(clips, 2 * SECOND - HALF / 2)
    expect(leaving?.transition?.transform).toEqual(leaving?.transform)
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
