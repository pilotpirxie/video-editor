import { describe, expect, it } from 'vitest'
import { MEDIA_STATES, SAMPLE_MEDIA, SECOND, STICKER_MEDIA, VIDEO_INFO, VIDEO_MEDIA, audioClip, clipIds, clipOf, projectOf, reopened, track, videoClip } from '../../test/fixtures.js'
import type { MediaInfo } from '../shared/mediaProtocol.js'
import type { MediaRef } from '../shared/project.js'
import { canvasForFirstClip, clipForMedia, dropMedia, mediaFileName, mediaUses, relinkedMedia, unlinkedMedia, type MediaDrop } from './place.js'

const CANVAS = projectOf([]).canvas
const NEW_TRACK = { id: 'new-track', name: 'Track' }
const VIDEO_REF: MediaRef = { id: 'video', path: '/footage/video.mp4', relativePath: '' }

function drop(overrides: Partial<MediaDrop>): MediaDrop {
  return { reference: VIDEO_REF, info: VIDEO_MEDIA, clipId: 'dropped', start: 0, trackIndex: 0, newTrack: NEW_TRACK, ...overrides }
}

describe('clipForMedia', () => {
  it('makes a video clip as long as its source, centred at full size', () => {
    expect(clipForMedia('video', VIDEO_MEDIA, CANVAS, 'c', 2 * SECOND)).toEqual({
      id: 'c',
      type: 'video',
      mediaId: 'video',
      start: 2 * SECOND,
      duration: 10 * SECOND,
      sourceStart: 0,
      speedPercent: 100,
      volume: 1,
      opacity: 1,
      transform: { x: 960, y: 540, scaleX: 1, scaleY: 1, rotation: 0 },
    })
  })

  it('cuts the duration down to whole frames', () => {
    const info: MediaInfo = { ...VIDEO_MEDIA, duration: 10 * SECOND + 12_345 }
    expect(clipForMedia('video', info, CANVAS, 'c', 0).duration).toBe(10 * SECOND)
    expect(clipForMedia('video', { ...VIDEO_MEDIA, duration: 5 }, CANVAS, 'c', 0).duration).toBe(SECOND / 30)
  })

  it('scales a picture larger than the canvas down to fit, and never enlarges a small one', () => {
    const large: MediaInfo = { kind: 'image', width: 3840, height: 1080, hasAlpha: false }
    expect(clipForMedia('logo', large, CANVAS, 'c', 0)).toMatchObject({ type: 'image', duration: 5 * SECOND, transform: { scaleX: 0.5, scaleY: 0.5 } })
    const small = MEDIA_STATES.logo
    if (small === undefined || 'error' in small) throw new Error('fixture')
    expect(clipForMedia('logo', small.info, CANVAS, 'c', 0)).toMatchObject({ transform: { scaleX: 1, scaleY: 1 } })
  })

  it('makes an animated image a looping clip that lasts as long as a still', () => {
    expect(clipForMedia('sticker', STICKER_MEDIA, CANVAS, 'c', 0)).toMatchObject({ type: 'video', loop: true, duration: 5 * SECOND, sourceStart: 0, speedPercent: 100 })
    const long = { ...STICKER_MEDIA, duration: 8 * SECOND }
    expect(clipForMedia('sticker', long, CANVAS, 'c', 0)).toMatchObject({ loop: true, duration: 8 * SECOND })
  })

  it('gives a still image five seconds', () => {
    expect(clipForMedia('logo', { kind: 'image', width: 400, height: 200, hasAlpha: true }, CANVAS, 'c', SECOND)).toMatchObject({ type: 'image', start: SECOND, duration: 5 * SECOND })
  })

  it('makes an audio clip without a picture', () => {
    const music = MEDIA_STATES.music
    if (music === undefined || 'error' in music) throw new Error('fixture')
    expect(clipForMedia('music', music.info, CANVAS, 'c', 0)).toEqual({ id: 'c', type: 'audio', mediaId: 'music', start: 0, duration: 60 * SECOND, sourceStart: 0, speedPercent: 100, volume: 1 })
  })
})

describe('canvasForFirstClip', () => {
  it('takes size and frame rate from a video', () => {
    const info: MediaInfo = { ...VIDEO_MEDIA, video: { ...VIDEO_INFO, width: 1280, height: 720, frameDuration: 960_000 } }
    expect(canvasForFirstClip(info, CANVAS)).toEqual({ width: 1280, height: 720, frameRate: { num: 25, den: 1 } })
  })

  it.each([
    [8_000_000 / 20, { num: 60, den: 1 }],
    [200_000, { num: 60, den: 1 }],
    [1_001_000, { num: 24000, den: 1001 }],
    [1_600_000, { num: 24000, den: 1001 }],
  ])('maps a %i-tick source frame to the nearest project frame rate', (frameDuration, expected) => {
    const info: MediaInfo = { ...VIDEO_MEDIA, video: { ...VIDEO_INFO, frameDuration } }
    expect(canvasForFirstClip(info, CANVAS).frameRate).toEqual(expected)
  })

  it('keeps the aspect ratio when the source is larger or smaller than a canvas can be', () => {
    const huge: MediaInfo = { ...VIDEO_MEDIA, video: { ...VIDEO_INFO, width: 7680, height: 4320 } }
    expect(canvasForFirstClip(huge, CANVAS)).toMatchObject({ width: 3840, height: 2160 })
    const tiny: MediaInfo = { kind: 'image', width: 64, height: 64, hasAlpha: false }
    expect(canvasForFirstClip(tiny, CANVAS)).toMatchObject({ width: 160, height: 160 })
  })

  it('takes the size but not the frame rate from an animated image', () => {
    expect(canvasForFirstClip(STICKER_MEDIA, CANVAS)).toEqual({ width: 214, height: 120, frameRate: CANVAS.frameRate })
  })

  it('leaves the canvas alone for audio', () => {
    const music = MEDIA_STATES.music
    if (music === undefined || 'error' in music) throw new Error('fixture')
    expect(canvasForFirstClip(music.info, CANVAS)).toBe(CANVAS)
  })
})

describe('dropMedia', () => {
  const occupied = projectOf([track('t1', [videoClip('a', 0, 4 * SECOND)]), track('t2', [])])

  it('sets the canvas from the first clip and adds the media to the project', () => {
    const info: MediaInfo = { ...VIDEO_MEDIA, video: { ...VIDEO_INFO, width: 1280, height: 720 } }
    const dropped = dropMedia(projectOf([], []), drop({ info }))
    expect(dropped.canvas).toMatchObject({ width: 1280, height: 720 })
    expect(dropped.media).toEqual([VIDEO_REF])
    expect(clipIds(reopened(dropped))).toEqual([['dropped']])
    expect(clipOf(dropped, 'dropped')).toMatchObject({ transform: { x: 640, y: 360, scaleX: 1 } })
  })

  it('keeps the canvas once the project has clips', () => {
    const info: MediaInfo = { ...VIDEO_MEDIA, video: { ...VIDEO_INFO, width: 640, height: 360 } }
    expect(dropMedia(occupied, drop({ info, start: 4 * SECOND })).canvas).toBe(occupied.canvas)
  })

  it('lands on the track it was dropped on when the space is free', () => {
    expect(clipIds(dropMedia(occupied, drop({ start: 4 * SECOND })))).toEqual([['a', 'dropped'], []])
    expect(clipIds(dropMedia(occupied, drop({ trackIndex: 1 })))).toEqual([['a'], ['dropped']])
  })

  it('creates a track directly above when the space is occupied', () => {
    const dropped = dropMedia(occupied, drop({ start: 2 * SECOND }))
    expect(clipIds(dropped)).toEqual([['a'], ['dropped'], []])
    expect(dropped.tracks[1]).toMatchObject({ id: 'new-track', name: 'Track', locked: false })
    reopened(dropped)
  })

  it('creates a track on top when dropped above all tracks, and never drops onto a locked track', () => {
    expect(clipIds(dropMedia(occupied, drop({ trackIndex: 7 })))).toEqual([['a'], [], ['dropped']])
    const locked = projectOf([track('t1', [], { locked: true })])
    expect(clipIds(dropMedia(locked, drop({})))).toEqual([[], ['dropped']])
  })

  it('does not list the same media twice', () => {
    expect(dropMedia(occupied, drop({ trackIndex: 1 })).media).toEqual(SAMPLE_MEDIA)
  })
})

describe('media that moved', () => {
  const project = projectOf([
    track('t1', [videoClip('a', 0, SECOND), audioClip('sound-of-video', 2 * SECOND, SECOND, { mediaId: 'video' })]),
    track('t2', [audioClip('music', 0, SECOND)]),
    track('t3', [{ id: 'still', type: 'image', mediaId: 'logo', start: 0, duration: SECOND, opacity: 1, transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 } }]),
  ])

  it('names a media file by the last part of its path', () => {
    expect(mediaFileName({ id: 'a', path: '/footage/day 1/clip.mp4', relativePath: '' })).toBe('clip.mp4')
    expect(mediaFileName({ id: 'a', path: '', relativePath: '../media/song.mp3' })).toBe('song.mp3')
  })

  it('knows what the clips need from a file', () => {
    expect(mediaUses(project, 'video')).toEqual(['video', 'sound'])
    expect(mediaUses(project, 'music')).toEqual(['sound'])
    expect(mediaUses(project, 'logo')).toEqual(['image'])
    expect(mediaUses(project, 'unused')).toEqual([])
  })

  it('lists the files that are missing, not the ones that are there or merely unreadable', () => {
    const states = { ...MEDIA_STATES, video: { error: 'gone', isMissing: true }, music: { error: 'damaged', isMissing: false } }
    expect(unlinkedMedia(project, states)).toEqual([{ reference: SAMPLE_MEDIA[0], uses: ['video', 'sound'] }])
  })

  it('points media at the files that were found and leaves the rest alone', () => {
    const relinked = relinkedMedia(project, [{ id: 'video', path: '/new/video.mp4' }])
    expect(relinked.media).toEqual([{ id: 'video', path: '/new/video.mp4', relativePath: '' }, SAMPLE_MEDIA[1], SAMPLE_MEDIA[2]])
    expect(relinked.tracks).toBe(project.tracks)
    expect(relinkedMedia(project, [{ id: 'video', path: '/footage/video.mp4' }])).toBe(project)
    reopened(relinked)
  })
})

