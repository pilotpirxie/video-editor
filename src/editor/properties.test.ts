import { describe, expect, it } from 'vitest'
import { ALL_MEDIA, FRAME, MEDIA_STATES, SECOND, audioClip, clipOf, projectOf, reopened, track, videoClip } from '../../test/fixtures.js'
import type { Clip, Project } from '../shared/project.js'
import { propertyAt, setCanvasSize, setDuration, setFade, setFrameRate, setLoop, setProperties, setSourceStart, setSpeed, sharedValue } from './properties.js'

const TEXT: Clip = {
  id: 'title',
  type: 'text',
  start: 0,
  duration: 2 * SECOND,
  text: 'Title',
  font: { family: 'Helvetica Neue', size: 48 },
  color: '#FFFFFF',
  align: 'center',
  transform: { x: 100, y: 100, scaleX: 1, scaleY: 1, rotation: 0 },
  opacity: 1,
}

function sample(): Project {
  return projectOf([
    track('t1', [videoClip('a', 0, 4 * SECOND), videoClip('b', 6 * SECOND, 2 * SECOND)]),
    track('t2', [audioClip('music', 0, 4 * SECOND)]),
    track('t3', [TEXT]),
  ])
}

describe('canvas settings', () => {
  it('sets the canvas size within the allowed range, as whole pixels', () => {
    expect(setCanvasSize(sample(), { width: 1280.4, height: 720 }).canvas).toMatchObject({ width: 1280, height: 720 })
    expect(setCanvasSize(sample(), { width: 10, height: 99_999 }).canvas).toMatchObject({ width: 160, height: 2160 })
  })

  it('sets the frame rate and reports no change when nothing changed', () => {
    const project = sample()
    expect(setFrameRate(project, { num: 25, den: 1 }).canvas.frameRate).toEqual({ num: 25, den: 1 })
    expect(setFrameRate(project, { num: 30, den: 1 })).toBe(project)
    expect(setCanvasSize(project, { width: 1920, height: 1080 })).toBe(project)
  })
})

describe('setProperties', () => {
  it('sets transform, opacity and volume on the clips that have them', () => {
    const edited = setProperties(sample(), ['a', 'music', 'title'], { x: 10, opacity: 0.5, volume: 1.5 }, 0)
    expect(clipOf(edited, 'a')).toMatchObject({ transform: { x: 10, y: 540 }, opacity: 0.5, volume: 1.5 })
    expect(clipOf(edited, 'music')).toMatchObject({ volume: 1.5 })
    expect(clipOf(edited, 'music')).not.toHaveProperty('opacity')
    expect(clipOf(edited, 'title')).toMatchObject({ transform: { x: 10 }, opacity: 0.5 })
    expect(clipOf(edited, 'title')).not.toHaveProperty('volume')
    reopened(edited)
  })

  it('keeps values within their limits', () => {
    const edited = setProperties(sample(), ['a'], { opacity: 7, volume: 9, scaleX: -3, cropLeft: -5 }, 0)
    expect(clipOf(edited, 'a')).toMatchObject({ opacity: 1, volume: 2, transform: { scaleX: 0 } })
    reopened(edited)
  })

  it('adds a crop and removes it again when nothing is cropped', () => {
    const cropped = setProperties(sample(), ['a'], { cropLeft: 40 }, 0)
    expect(clipOf(cropped, 'a')).toMatchObject({ crop: { left: 40, top: 0, right: 0, bottom: 0 } })
    const restored = reopened(setProperties(cropped, ['a'], { cropLeft: 0 }, 0))
    expect(clipOf(restored, 'a')).not.toHaveProperty('crop')
    expect(clipOf(setProperties(sample(), ['title'], { cropLeft: 40 }, 0), 'title')).not.toHaveProperty('crop')
  })

  it('updates or adds a keyframe at the playhead when the property is animated', () => {
    const animated = projectOf([
      track('t1', [videoClip('a', 2 * SECOND, 4 * SECOND, { keyframes: { x: [{ time: 0, value: 0, easing: 'easeIn' }, { time: 4 * SECOND, value: 400, easing: 'linear' }] } })]),
    ])
    const added = setProperties(animated, ['a'], { x: 250, y: 5 }, 3 * SECOND)
    expect(clipOf(added, 'a')).toMatchObject({
      transform: { x: 960, y: 5 },
      keyframes: { x: [{ time: 0, value: 0, easing: 'easeIn' }, { time: SECOND, value: 250, easing: 'linear' }, { time: 4 * SECOND, value: 400, easing: 'linear' }] },
    })
    expect(propertyAt(clipOf(added, 'a'), 'x', 3 * SECOND)).toBe(250)

    const updated = setProperties(added, ['a'], { x: 0.5 }, 2 * SECOND)
    expect(clipOf(updated, 'a').keyframes?.x?.[0]).toEqual({ time: 0, value: 0.5, easing: 'easeIn' })

    const outside = setProperties(animated, ['a'], { x: 77 }, 60 * SECOND)
    expect(clipOf(outside, 'a').keyframes?.x?.at(-1)).toEqual({ time: 4 * SECOND, value: 77, easing: 'linear' })
    reopened(outside)
  })

  it('returns the same project when the values are already set', () => {
    const project = sample()
    expect(setProperties(project, ['a'], { x: 960, opacity: 1 }, 0)).toBe(project)
  })
})

describe('timing', () => {
  it('sets the duration, limited by the next clip and the source', () => {
    expect(clipOf(setDuration(sample(), ['a'], SECOND, FRAME, MEDIA_STATES), 'a').duration).toBe(SECOND)
    expect(clipOf(setDuration(sample(), ['a'], 60 * SECOND, FRAME, MEDIA_STATES), 'a').duration).toBe(6 * SECOND)
    expect(clipOf(setDuration(sample(), ['b'], 60 * SECOND, FRAME, MEDIA_STATES), 'b').duration).toBe(10 * SECOND)
  })

  it('sets the source offset, keeping the clip inside its source', () => {
    expect(clipOf(setSourceStart(sample(), ['a'], 2 * SECOND, MEDIA_STATES), 'a')).toMatchObject({ sourceStart: 2 * SECOND, duration: 4 * SECOND })
    expect(clipOf(setSourceStart(sample(), ['a'], 60 * SECOND, MEDIA_STATES), 'a')).toMatchObject({ sourceStart: 6 * SECOND })
    expect(clipOf(setSourceStart(sample(), ['a'], -5, MEDIA_STATES), 'a')).toMatchObject({ sourceStart: 0 })
  })

  it('changes the speed and the duration together, so the same source is shown', () => {
    const faster = setSpeed(sample(), ['a'], 200)
    expect(clipOf(faster, 'a')).toMatchObject({ speedPercent: 200, duration: 2 * SECOND, sourceStart: 0 })
    const slower = setSpeed(sample(), ['a'], 50)
    expect(clipOf(slower, 'a')).toMatchObject({ speedPercent: 50, duration: 6 * SECOND })
    expect(clipOf(setSpeed(sample(), ['a'], 5), 'a')).toMatchObject({ speedPercent: 25 })
    expect(clipOf(setSpeed(sample(), ['a'], 99_999), 'a')).toMatchObject({ speedPercent: 10_000 })
    reopened(faster)
    reopened(slower)
  })

  it('sets and removes fades, never longer than the clip', () => {
    const faded = setFade(setFade(sample(), ['a', 'music'], 'fadeIn', SECOND), ['a', 'music'], 'volumeFadeOut', 60 * SECOND)
    expect(clipOf(faded, 'a')).toMatchObject({ fadeIn: SECOND, volumeFadeOut: 4 * SECOND })
    expect(clipOf(faded, 'music')).toMatchObject({ volumeFadeOut: 4 * SECOND })
    expect(clipOf(faded, 'music')).not.toHaveProperty('fadeIn')
    const removed = reopened(setFade(faded, ['a'], 'fadeIn', 0))
    expect(clipOf(removed, 'a')).not.toHaveProperty('fadeIn')
  })
})

describe('setLoop', () => {
  const stretched = projectOf([track('t1', [videoClip('gif', 0, 8 * SECOND, { mediaId: 'sticker', loop: true, sourceStart: 1.5 * SECOND, fadeOut: 2 * SECOND }), videoClip('a', 10 * SECOND, SECOND)])], ALL_MEDIA)

  it('ends a clip after one play of its source when the loop is switched off', () => {
    const once = setLoop(stretched, ['gif'], false, MEDIA_STATES)
    const clip = clipOf(once, 'gif')
    expect(clip).toMatchObject({ sourceStart: 0.3 * SECOND, duration: 0.9 * SECOND, fadeOut: 0.9 * SECOND })
    expect(clip).not.toHaveProperty('loop')
    reopened(once)
  })

  it('switches the loop on again without changing the length', () => {
    const once = setLoop(stretched, ['gif'], false, MEDIA_STATES)
    expect(clipOf(setLoop(once, ['gif'], true, MEDIA_STATES), 'gif')).toMatchObject({ loop: true, duration: 0.9 * SECOND })
  })

  it('only loops animated images', () => {
    expect(setLoop(stretched, ['a'], true, MEDIA_STATES)).toBe(stretched)
    expect(setLoop(stretched, ['gif'], true, MEDIA_STATES)).toBe(stretched)
  })
})

describe('sharedValue', () => {
  it('is the value all clips agree on', () => {
    expect(sharedValue([3, 3, 3])).toBe(3)
    expect(sharedValue([3, 4])).toBeUndefined()
    expect(sharedValue([3, undefined])).toBeUndefined()
    expect(sharedValue([])).toBeUndefined()
  })
})
