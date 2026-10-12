import { describe, expect, it } from 'vitest'
import type { MediaInfo, VideoInfo } from '../shared/mediaProtocol.js'
import type { Clip, Easing, Keyframe, Project, Track, VideoClip } from '../shared/project.js'
import { ease, fadeFactor, resolveFrame, sourceHalvings, valueAt, type Layer, type MediaStates, type VideoLayer } from './resolve.js'

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
  logo: { info: { kind: 'image', width: 400, height: 200, hasAlpha: true, isAnimated: false } },
  broken: { error: '"broken.mp4" could not be read.' },
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

  it('accounts for a picture that starts after the container', () => {
    const delayed: MediaStates = { footage: { info: videoMedia({ startOffset: FRAME_30 * 3 }) } }
    const layers = (time: number): Layer[] => resolveFrame(project([track([videoClip()])]), delayed, time, 1)
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
    // Held until the next keyframe, then jumps.
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
