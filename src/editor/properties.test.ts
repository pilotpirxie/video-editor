import { describe, expect, it } from 'vitest'
import { ALL_MEDIA, FRAME, MEDIA_STATES, SECOND, audioClip, clipOf, groupClip, projectOf, reopened, track, videoClip } from '../../test/fixtures.js'
import type { Clip, Project } from '../shared/project.js'
import {
  changeKeyframe,
  hasKeyframesAt,
  motionPath,
  nearestKeyframe,
  propertyAt,
  removeKeyframe,
  setCanvasSize,
  setDuration,
  setFade,
  setFrameRate,
  setKeyframesAt,
  setLoop,
  setProperties,
  setSoundSwitches,
  setSourceStart,
  setSpeed,
  sharedValue,
} from './properties.js'

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

  it('scales everything by the same amount when the canvas keeps its shape', () => {
    const clip = videoClip('a', 0, 4 * SECOND, {
      transform: { x: 480, y: 270, scaleX: 0.5, scaleY: 0.5, rotation: 30 },
      keyframes: { x: [{ time: 0, value: 0, easing: 'linear' }], scaleY: [{ time: 0, value: 2, easing: 'hold' }], rotation: [{ time: 0, value: 45, easing: 'linear' }] },
      effects: [{ type: 'border', width: 30, color: '#FFFFFF' }],
    })
    const project = { ...projectOf([track('t1', [clip])]), camera: [{ time: 0, duration: SECOND, easing: 'easeInOut' as const, x: 960, y: 0, scale: 2 }] }
    const resized = setCanvasSize(project, { width: 1280, height: 720 })
    expect(clipOf(resized, 'a')).toMatchObject({
      transform: { x: 320, y: 180, rotation: 30 },
      keyframes: { x: [{ value: 0 }], scaleY: [{ value: 4 / 3 }], rotation: [{ value: 45 }] },
      effects: [{ width: 20 }],
    })
    const scaled = clipOf(resized, 'a')
    expect(scaled.type === 'video' && scaled.transform.scaleX).toBeCloseTo(1 / 3)
    expect(resized.camera).toEqual([{ time: 0, duration: SECOND, easing: 'easeInOut', x: 640, y: 0, scale: 2 }])
    expect(reopened(resized)).toEqual(reopened(resized))
  })

  it('fits the whole picture into a canvas of another shape, centred', () => {
    const blur: Clip = { id: 'blur', type: 'blur', start: 0, duration: SECOND, transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 }, opacity: 1, width: 200, height: 100, shape: 'rectangle', softEdge: 16, strength: 32 }
    const resized = setCanvasSize(projectOf([track('t1', [blur])]), { width: 1080, height: 1920 })
    const scale = 1080 / 1920
    expect(clipOf(resized, 'blur')).toMatchObject({ transform: { x: 0, y: 960 - 540 * scale, scaleX: scale }, softEdge: 16 * scale, strength: 32 * scale })
  })

  it('leaves the members of a group to the group, so they land where the group takes them', () => {
    const member = videoClip('member', 0, SECOND, { transform: { x: 100, y: 50, scaleX: 1, scaleY: 1, rotation: 0 }, effects: [{ type: 'roundedCorners', radius: 10 }] })
    const project = projectOf([track('t1', [groupClip('group', 0, SECOND, [[member]], { transform: { x: 960, y: 540, scaleX: 1, scaleY: 1, rotation: 0 } })])])
    const resized = setCanvasSize(project, { width: 960, height: 540 })
    const group = clipOf(resized, 'group')
    expect(group).toMatchObject({ transform: { x: 480, y: 270, scaleX: 0.5, scaleY: 0.5 } })
    expect(group.type === 'group' && group.tracks[0]?.clips[0]).toEqual(member)
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

  it('updates or adds a keyframe at the playhead when the property is animated, keying its partner with it', () => {
    const animated = projectOf([
      track('t1', [videoClip('a', 2 * SECOND, 4 * SECOND, { keyframes: { x: [{ time: 0, value: 0, easing: 'easeIn' }, { time: 4 * SECOND, value: 400, easing: 'linear' }] } })]),
    ])
    const added = setProperties(animated, ['a'], { x: 250, y: 5 }, 3 * SECOND)
    expect(clipOf(added, 'a')).toMatchObject({
      transform: { x: 960, y: 540 },
      keyframes: {
        x: [{ time: 0, value: 0, easing: 'easeIn' }, { time: SECOND, value: 250, easing: 'linear' }, { time: 4 * SECOND, value: 400, easing: 'linear' }],
        y: [{ time: SECOND, value: 5, easing: 'linear' }],
      },
    })
    expect(propertyAt(clipOf(added, 'a'), 'x', 3 * SECOND)).toBe(250)

    // The partner takes the easing of the keyframe it is put beside.
    const updated = setProperties(added, ['a'], { x: 0.5 }, 2 * SECOND)
    expect(clipOf(updated, 'a').keyframes?.x?.[0]).toEqual({ time: 0, value: 0.5, easing: 'easeIn' })
    expect(clipOf(updated, 'a').keyframes?.y?.[0]).toEqual({ time: 0, value: 5, easing: 'easeIn' })

    const outside = setProperties(animated, ['a'], { x: 77 }, 60 * SECOND)
    expect(clipOf(outside, 'a').keyframes?.x?.at(-1)).toEqual({ time: 4 * SECOND, value: 77, easing: 'linear' })
    reopened(outside)
  })

  it('keys every set a change touches once one of them is animated, and changes resting values otherwise', () => {
    const sized = { scaleX: [{ time: 0, value: 1, easing: 'easeOut' as const }], scaleY: [{ time: 0, value: 1, easing: 'easeOut' as const }] }
    const animated = projectOf([track('t1', [videoClip('a', 0, 4 * SECOND, { keyframes: sized })])])
    // A corner drag changes the size and the place together.
    const dragged = setProperties(animated, ['a'], { x: 100, y: 200, scaleX: 2, scaleY: 2 }, SECOND)
    expect(clipOf(dragged, 'a')).toMatchObject({
      transform: { x: 960, y: 540, scaleX: 1 },
      keyframes: {
        x: [{ time: SECOND, value: 100, easing: 'linear' }],
        y: [{ time: SECOND, value: 200, easing: 'linear' }],
        scaleX: [{ time: 0, value: 1, easing: 'easeOut' }, { time: SECOND, value: 2, easing: 'linear' }],
      },
    })
    reopened(dragged)

    const turned = setProperties(dragged, ['a'], { rotation: 45 }, 2 * SECOND)
    expect(clipOf(turned, 'a')).toMatchObject({ transform: { rotation: 45 } })
    expect(clipOf(turned, 'a').keyframes).not.toHaveProperty('rotation')
  })

  it('changes a keyframe that lies inside the frame of the playhead instead of adding one beside it', () => {
    const between = SECOND + 300
    const project = projectOf([track('t1', [audioClip('music', 0, 4 * SECOND, { keyframes: { volume: [{ time: 0, value: 1, easing: 'linear' }, { time: between, value: 0.5, easing: 'linear' }] } })])])
    const quieter = setProperties(project, ['music'], { volume: 0.2 }, SECOND)
    expect(clipOf(quieter, 'music').keyframes?.volume).toEqual([
      { time: 0, value: 1, easing: 'linear' },
      { time: between, value: 0.2, easing: 'linear' },
    ])
    expect(hasKeyframesAt(clipOf(quieter, 'music'), 'volume', SECOND, FRAME)).toBe(true)
    expect(clipOf(setKeyframesAt(quieter, ['music'], 'volume', SECOND, false), 'music').keyframes?.volume).toHaveLength(1)
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

describe('keyframes by hand', () => {
  it('puts keyframes for a whole set at the playhead that hold the values there', () => {
    const keyed = setKeyframesAt(sample(), ['music', 'a'], 'volume', SECOND + 49, true)
    expect(clipOf(keyed, 'music').keyframes).toEqual({ volume: [{ time: SECOND, value: 1, easing: 'linear' }] })
    expect(hasKeyframesAt(clipOf(keyed, 'music'), 'volume', SECOND, FRAME)).toBe(true)
    expect(hasKeyframesAt(clipOf(keyed, 'music'), 'volume', 2 * SECOND, FRAME)).toBe(false)
    expect(reopened(keyed)).toEqual(keyed)

    const placed = setKeyframesAt(sample(), ['a', 'title'], 'position', SECOND, true)
    expect(clipOf(placed, 'a').keyframes).toEqual({ x: [{ time: SECOND, value: 960, easing: 'linear' }], y: [{ time: SECOND, value: 540, easing: 'linear' }] })
    expect(clipOf(placed, 'title').keyframes).toEqual({ x: [{ time: SECOND, value: 100, easing: 'linear' }], y: [{ time: SECOND, value: 100, easing: 'linear' }] })
    expect(hasKeyframesAt(clipOf(placed, 'a'), 'position', SECOND, FRAME)).toBe(true)
    expect(setKeyframesAt(placed, ['a', 'title'], 'position', SECOND, true)).toBe(placed)
  })

  it('takes the keyframes at the playhead away again, and leaves the values the last ones had', () => {
    const keyed = setProperties(setKeyframesAt(sample(), ['music'], 'volume', SECOND, true), ['music'], { volume: 0.4 }, SECOND)
    const plain = setKeyframesAt(keyed, ['music'], 'volume', SECOND, false)
    expect(clipOf(plain, 'music')).toMatchObject({ volume: 0.4 })
    expect(clipOf(reopened(plain), 'music')).not.toHaveProperty('keyframes')

    const moved = setProperties(setKeyframesAt(sample(), ['a'], 'position', 0, true), ['a'], { x: 10, y: 20 }, 0)
    const unplaced = setKeyframesAt(moved, ['a'], 'position', 0, false)
    expect(clipOf(unplaced, 'a')).toMatchObject({ transform: { x: 10, y: 20 } })
    expect(clipOf(reopened(unplaced), 'a')).not.toHaveProperty('keyframes')
  })

  it('does nothing for a property the clip does not have', () => {
    const project = sample()
    expect(setKeyframesAt(project, ['title'], 'volume', 0, true)).toBe(project)
    expect(setKeyframesAt(project, ['music'], 'opacity', 0, true)).toBe(project)
    expect(setKeyframesAt(project, ['title'], 'crop', 0, true)).toBe(project)
  })

  it('moves a keyframe in time and value, never past its neighbours or out of range', () => {
    let keyed = sample()
    for (const seconds of [0, 1, 2]) keyed = setKeyframesAt(keyed, ['music'], 'volume', seconds * SECOND, true)
    const moved = changeKeyframe(keyed, 'music', 'volume', 1, { time: 1.5 * SECOND + 30, value: 5, easing: 'easeOut' })
    expect(clipOf(moved, 'music').keyframes?.volume?.[1]).toEqual({ time: 1.5 * SECOND, value: 2, easing: 'easeOut' })
    expect(clipOf(changeKeyframe(keyed, 'music', 'volume', 1, { time: 9 * SECOND }), 'music').keyframes?.volume?.[1]?.time).toBe(2 * SECOND - 100)
    expect(clipOf(changeKeyframe(keyed, 'music', 'volume', 1, { time: -SECOND }), 'music').keyframes?.volume?.[1]?.time).toBe(100)
    expect(reopened(moved)).toEqual(moved)
  })

  it('leaves the project alone when a keyframe does not change or is not there', () => {
    const keyed = setKeyframesAt(sample(), ['music'], 'volume', SECOND, true)
    expect(changeKeyframe(keyed, 'music', 'volume', 0, { time: SECOND, value: 1 })).toBe(keyed)
    expect(changeKeyframe(keyed, 'music', 'volume', 3, { value: 0 })).toBe(keyed)
    expect(removeKeyframe(keyed, 'music', 'volume', 3)).toBe(keyed)
  })

  it('removes one keyframe, and with the last one the list', () => {
    let keyed = sample()
    for (const seconds of [0, 1]) keyed = setKeyframesAt(keyed, ['music'], 'volume', seconds * SECOND, true)
    keyed = changeKeyframe(keyed, 'music', 'volume', 1, { value: 0.3 })
    const one = removeKeyframe(keyed, 'music', 'volume', 0)
    expect(clipOf(one, 'music').keyframes?.volume).toEqual([{ time: SECOND, value: 0.3, easing: 'linear' }])
    const none = removeKeyframe(one, 'music', 'volume', 0)
    expect(clipOf(none, 'music')).toMatchObject({ volume: 0.3 })
    expect(clipOf(reopened(none), 'music')).not.toHaveProperty('keyframes')
  })
})

describe('nearestKeyframe', () => {
  const keyed = projectOf([
    track('t1', [
      videoClip('a', 0, 4 * SECOND, {
        keyframes: {
          x: [
            { time: -SECOND, value: 0, easing: 'linear' },
            { time: 0, value: 0, easing: 'linear' },
            { time: SECOND + 300, value: 1, easing: 'linear' },
            { time: 4 * SECOND, value: 2, easing: 'linear' },
          ],
        },
      }),
      videoClip('b', 6 * SECOND, 2 * SECOND, { keyframes: { y: [{ time: SECOND, value: 1, easing: 'linear' }] } }),
    ]),
  ])
  const clips = keyed.tracks[0]?.clips ?? []

  it('goes to the start of the next or previous frame that holds a keyframe of the set', () => {
    expect(nearestKeyframe(clips, 'position', 0, 1, FRAME)).toBe(SECOND)
    expect(nearestKeyframe(clips, 'position', SECOND, -1, FRAME)).toBe(0)
    expect(nearestKeyframe(clips, 'position', 7 * SECOND, -1, FRAME)).toBe(119 * FRAME)
    expect(nearestKeyframe(clips, 'size', 0, 1, FRAME)).toBeUndefined()
  })

  it('reaches a keyframe at the end of a clip on its last frame, and never stays where it is', () => {
    expect(nearestKeyframe(clips, 'position', SECOND, 1, FRAME)).toBe(119 * FRAME)
    expect(nearestKeyframe(clips, 'position', 119 * FRAME, 1, FRAME)).toBe(7 * SECOND)
    expect(nearestKeyframe(clips, 'position', 7 * SECOND, 1, FRAME)).toBeUndefined()
    // The keyframe before the clip starts is not one the playhead can stand on.
    expect(nearestKeyframe(clips, 'position', 0, -1, FRAME)).toBeUndefined()
  })
})

describe('motionPath', () => {
  it('follows the place of the clip between its position keyframes, with a dot on each one inside the clip', () => {
    const moving = videoClip('a', SECOND, 4 * SECOND, {
      keyframes: {
        x: [{ time: 0, value: 0, easing: 'linear' }, { time: 2 * SECOND, value: 200, easing: 'linear' }, { time: 6 * SECOND, value: 600, easing: 'linear' }],
        y: [{ time: 0, value: 0, easing: 'linear' }, { time: 2 * SECOND, value: 100, easing: 'linear' }, { time: 6 * SECOND, value: 300, easing: 'linear' }],
      },
    })
    const path = motionPath(moving)
    expect(path?.dots).toEqual([
      { time: 0, point: { x: 0, y: 0 } },
      { time: 2 * SECOND, point: { x: 200, y: 100 } },
    ])
    // Two stretches of sixteen steps and the end, which the keyframe after the clip decides.
    expect(path?.line).toHaveLength(33)
    expect(path?.line.at(-1)).toEqual({ x: 400, y: 200 })
    expect(path?.line.every((point) => Math.abs(point.y - point.x / 2) < 1e-9)).toBe(true)
  })

  it('uses the resting value of an axis without keyframes, and is not there without position keyframes', () => {
    const sliding = videoClip('a', 0, 2 * SECOND, { keyframes: { x: [{ time: 0, value: -1920, easing: 'easeOut' }, { time: SECOND, value: 960, easing: 'linear' }] } })
    const path = motionPath(sliding)
    expect(path?.dots.map((dot) => dot.point)).toEqual([
      { x: -1920, y: 540 },
      { x: 960, y: 540 },
    ])
    expect(motionPath(videoClip('b', 0, SECOND, { keyframes: { opacity: [{ time: 0, value: 1, easing: 'linear' }] } }))).toBeUndefined()
    expect(motionPath(audioClip('music', 0, SECOND))).toBeUndefined()
  })
})

describe('groups and sound', () => {
  const grouped = projectOf([track('t1', [groupClip('group', 0, 4 * SECOND, [[videoClip('m', 0, 4 * SECOND)]]), audioClip('music', 5 * SECOND, SECOND)])])

  it('scales a group by one number, whichever of the two is set', () => {
    expect(clipOf(setProperties(grouped, ['group'], { scaleY: 3 }, 0), 'group')).toMatchObject({ transform: { scaleX: 3, scaleY: 3 } })
    const keyed = setKeyframesAt(grouped, ['group'], 'size', 0, true)
    expect(reopened(keyed)).toEqual(keyed)
    const scaled = setProperties(keyed, ['group'], { scaleX: 2 }, SECOND)
    expect(clipOf(scaled, 'group').keyframes?.scaleY).toEqual(clipOf(scaled, 'group').keyframes?.scaleX)
    expect(reopened(scaled)).toEqual(scaled)
  })

  it('sets the volume and the volume fades of a group', () => {
    const quiet = setFade(setProperties(grouped, ['group'], { volume: 0.5 }, 0), ['group'], 'volumeFadeIn', SECOND)
    expect(clipOf(quiet, 'group')).toMatchObject({ volume: 0.5, volumeFadeIn: SECOND })
    expect(reopened(quiet)).toEqual(quiet)
  })

  it('switches how sound follows speed, and leaves a switch that is off out of the clip', () => {
    const switched = setSoundSwitches(grouped, ['music', 'group'], { changesPitch: true, hasFastSound: true })
    expect(clipOf(switched, 'music')).toMatchObject({ changesPitch: true, hasFastSound: true })
    expect(clipOf(switched, 'group')).toBe(clipOf(grouped, 'group'))
    expect(reopened(switched)).toEqual(switched)
    const back = setSoundSwitches(switched, ['music'], { changesPitch: false })
    expect(clipOf(reopened(back), 'music')).not.toHaveProperty('changesPitch')
    expect(clipOf(back, 'music')).toMatchObject({ hasFastSound: true })
    expect(setSoundSwitches(grouped, ['music'], { changesPitch: false })).toBe(grouped)
  })
})
