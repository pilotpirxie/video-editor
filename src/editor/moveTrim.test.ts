import { describe, expect, it } from 'vitest'
import { FRAME, MEDIA_STATES, SECOND, audioClip, clipIds, clipOf, groupClip, projectOf, reopened, track, videoClip } from '../../test/fixtures.js'
import type { Clip, Project } from '../shared/project.js'
import { moveClips, trimClip, type Move, type Trim } from './moveTrim.js'

const NEW_TRACK = { id: 'new-track', name: 'Track 3' }

function sample(): Project {
  return projectOf([
    track('t1', [videoClip('a', 0, 2 * SECOND), videoClip('b', 4 * SECOND, 2 * SECOND), videoClip('c', 8 * SECOND, SECOND)]),
    track('t2', [audioClip('music', SECOND, 3 * SECOND)]),
  ])
}

function move(overrides: Partial<Move>): Move {
  return { clipIds: ['b'], deltaTime: 0, trackShift: 0, isRipple: false, newTrack: NEW_TRACK, ...overrides }
}

function trim(overrides: Partial<Trim>): Trim {
  return { clipId: 'b', edge: 'end', time: 0, isRipple: false, frameTicks: FRAME, mediaStates: MEDIA_STATES, ...overrides }
}

describe('moveClips', () => {
  it('moves a clip in time on its track, leaving a gap', () => {
    const project = sample()
    const moved = moveClips(project, move({ deltaTime: SECOND }))
    expect(clipOf(moved, 'b').start).toBe(5 * SECOND)
    expect(moved.tracks[1]).toBe(project.tracks[1])
    reopened(moved)
  })

  it('does not move before the start of the timeline', () => {
    expect(clipOf(moveClips(sample(), move({ clipIds: ['a'], deltaTime: -5 * SECOND })), 'a').start).toBe(0)
  })

  it('moves a clip to another track when the space there is free', () => {
    const moved = moveClips(sample(), move({ deltaTime: SECOND, trackShift: 1 }))
    expect(clipIds(moved)).toEqual([['a', 'c'], ['music', 'b']])
    reopened(moved)
  })

  it('puts a clip dropped onto occupied space on a new track directly above', () => {
    const onNeighbour = moveClips(sample(), move({ deltaTime: 3 * SECOND + SECOND / 2 }))
    expect(clipIds(onNeighbour)).toEqual([['a', 'c'], ['b'], ['music']])
    expect(onNeighbour.tracks[1]).toMatchObject(NEW_TRACK)
    reopened(onNeighbour)

    const onOtherTrack = moveClips(sample(), move({ deltaTime: -2 * SECOND, trackShift: 1 }))
    expect(clipIds(onOtherTrack)).toEqual([['a', 'c'], ['music'], ['b']])
  })

  it('creates a track on top when dragged above the highest track', () => {
    expect(clipIds(moveClips(sample(), move({ trackShift: 2 })))).toEqual([['a', 'c'], ['music'], ['b']])
  })

  it('returns the same project when nothing changes', () => {
    const project = sample()
    expect(moveClips(project, move({}))).toBe(project)
    expect(moveClips(project, move({ clipIds: ['missing'], deltaTime: SECOND }))).toBe(project)
  })

  it('moves several clips together and stops them at the first clip in the way', () => {
    const together = moveClips(sample(), move({ clipIds: ['a', 'music'], deltaTime: SECOND }))
    expect(clipOf(together, 'a').start).toBe(SECOND)
    expect(clipOf(together, 'music').start).toBe(2 * SECOND)

    const stopped = moveClips(sample(), move({ clipIds: ['a', 'music'], deltaTime: 5 * SECOND }))
    expect(clipOf(stopped, 'a').start).toBe(2 * SECOND)
    expect(clipOf(stopped, 'music').start).toBe(3 * SECOND)
    reopened(stopped)

    const backwards = moveClips(sample(), move({ clipIds: ['b', 'c'], deltaTime: -9 * SECOND }))
    expect(clipOf(backwards, 'b').start).toBe(2 * SECOND)
    expect(clipOf(backwards, 'c').start).toBe(6 * SECOND)
  })

  it('moves several clips up and down by whole tracks, keeping them together', () => {
    const project = projectOf([track('t1', [videoClip('a', 0, 2 * SECOND), videoClip('b', 4 * SECOND, 2 * SECOND)]), track('t2', [audioClip('music', SECOND, 3 * SECOND)]), track('t3', []), track('t4', [videoClip('c', 0, SECOND)])])
    const up = moveClips(project, move({ clipIds: ['a', 'music'], deltaTime: SECOND, trackShift: 1 }))
    expect(clipIds(up)).toEqual([['b'], ['a'], ['music'], ['c']])
    expect(clipOf(up, 'a').start).toBe(SECOND)
    expect(clipOf(up, 'music').start).toBe(2 * SECOND)
    expect(up.tracks[3]).toBe(project.tracks[3])
    reopened(up)

    const down = moveClips(up, move({ clipIds: ['a', 'music'], trackShift: -1 }))
    expect(clipIds(down)).toEqual([['b', 'a'], ['music'], [], ['c']])
    // Below the bottom track there is nowhere to go: the group keeps its tracks.
    expect(moveClips(down, move({ clipIds: ['a', 'music'], trackShift: -1 }))).toBe(down)
  })

  it('takes the nearest tracks toward the pointer on which the group fits', () => {
    const project = projectOf([track('t1', [videoClip('a', 0, 2 * SECOND), videoClip('b', 4 * SECOND, SECOND)]), track('t2', []), track('t3', [videoClip('c', SECOND, SECOND)])])
    const nearest = moveClips(project, move({ clipIds: ['a', 'b'], trackShift: 2 }))
    expect(clipIds(nearest)).toEqual([[], ['a', 'b'], ['c']])

    // With room beside the clip in the way, the wanted track is taken.
    const beside = moveClips(project, move({ clipIds: ['a', 'b'], deltaTime: 2 * SECOND, trackShift: 2 }))
    expect(clipIds(beside)).toEqual([[], [], ['c', 'a', 'b']])
    reopened(beside)
  })

  it('gives a group dragged above the top track one new track', () => {
    const lifted = moveClips(sample(), move({ clipIds: ['a', 'music'], trackShift: 5 }))
    expect(clipIds(lifted)).toEqual([['b', 'c'], ['a'], ['music']])
    expect(lifted.tracks[2]).toMatchObject(NEW_TRACK)
    reopened(lifted)
  })

  it('keeps a group on its tracks when it fits nowhere else, on a locked track or while rippling', () => {
    const taken = projectOf([track('t1', [videoClip('a', 0, 2 * SECOND), videoClip('b', 4 * SECOND, SECOND)]), track('t2', [videoClip('c', SECOND, 4 * SECOND)]), track('t3', [], { locked: true })])
    const slid = moveClips(taken, move({ clipIds: ['a', 'b'], deltaTime: SECOND, trackShift: 2 }))
    expect(clipIds(slid)).toEqual([['a', 'b'], ['c'], []])
    expect(clipOf(slid, 'a').start).toBe(SECOND)

    const rippled = moveClips(sample(), move({ clipIds: ['a', 'music'], deltaTime: SECOND, trackShift: 1, isRipple: true }))
    expect(clipIds(rippled)).toEqual([['a', 'b', 'c'], ['music']])
    expect(clipOf(rippled, 'b').start).toBe(5 * SECOND)
  })

  it('ripples: every later clip on the track moves along', () => {
    const rippled = moveClips(sample(), move({ deltaTime: SECOND, isRipple: true }))
    expect(clipOf(rippled, 'a').start).toBe(0)
    expect(clipOf(rippled, 'b').start).toBe(5 * SECOND)
    expect(clipOf(rippled, 'c').start).toBe(9 * SECOND)
    expect(clipOf(rippled, 'music').start).toBe(SECOND)
  })

  it('leaves clips on locked tracks where they are', () => {
    const locked = projectOf([track('t1', [videoClip('a', 0, SECOND)], { locked: true })])
    expect(moveClips(locked, move({ clipIds: ['a'], deltaTime: SECOND }))).toBe(locked)
  })
})

describe('trimClip', () => {
  it('trims the end and keeps the start, source offset and keyframes', () => {
    const trimmed = trimClip(sample(), trim({ time: 5 * SECOND }))
    expect(clipOf(trimmed, 'b')).toMatchObject({ start: 4 * SECOND, duration: SECOND, sourceStart: 0 })
    reopened(trimmed)
  })

  it('cannot extend the end past the next clip or the end of the source', () => {
    expect(clipOf(trimClip(sample(), trim({ time: 20 * SECOND })), 'b').duration).toBe(4 * SECOND)
    const last = trimClip(sample(), trim({ clipId: 'c', time: 60 * SECOND }))
    expect(clipOf(last, 'c').duration).toBe(10 * SECOND)
  })

  it('counts the source offset and speed when limiting the end', () => {
    const fast = projectOf([track('t1', [videoClip('a', 0, SECOND, { sourceStart: 4 * SECOND, speedPercent: 200 })])])
    expect(clipOf(trimClip(fast, trim({ clipId: 'a', time: 60 * SECOND })), 'a').duration).toBe(3 * SECOND)
  })

  it('keeps at least one frame', () => {
    expect(clipOf(trimClip(sample(), trim({ time: 0 })), 'b').duration).toBe(FRAME)
    expect(clipOf(trimClip(sample(), trim({ edge: 'start', time: 60 * SECOND })), 'b')).toMatchObject({ start: 6 * SECOND - FRAME, duration: FRAME })
  })

  it('trims the start: the picture that stays keeps its place on the timeline', () => {
    const keyframed = projectOf([
      track('t1', [
        videoClip('a', 4 * SECOND, 2 * SECOND, {
          sourceStart: 3 * SECOND,
          speedPercent: 150,
          fadeIn: SECOND,
          keyframes: { x: [{ time: 0, value: 0, easing: 'easeInOut' }, { time: 2 * SECOND, value: 100, easing: 'linear' }] },
        }),
      ]),
    ])
    const trimmed = trimClip(keyframed, trim({ clipId: 'a', edge: 'start', time: 5 * SECOND }))
    expect(clipOf(trimmed, 'a')).toMatchObject({
      start: 5 * SECOND,
      duration: SECOND,
      sourceStart: 3 * SECOND + 1.5 * SECOND,
      fadeIn: SECOND,
      keyframes: { x: [{ time: -SECOND, value: 0, easing: 'easeInOut' }, { time: SECOND, value: 100, easing: 'linear' }] },
    })
    reopened(trimmed)
  })

  it('cannot extend the start past the previous clip or the start of the source', () => {
    expect(clipOf(trimClip(sample(), trim({ edge: 'start', time: 0 })), 'b').start).toBe(4 * SECOND)
    const offset = projectOf([track('t1', [videoClip('a', 5 * SECOND, SECOND, { sourceStart: 3 * SECOND, speedPercent: 200 })])])
    expect(clipOf(trimClip(offset, trim({ clipId: 'a', edge: 'start', time: 0 })), 'a')).toMatchObject({ start: 3.5 * SECOND, sourceStart: 0 })
  })

  it('shortens a fade that no longer fits', () => {
    const faded = projectOf([track('t1', [videoClip('a', 0, 4 * SECOND, { fadeOut: 2 * SECOND, volumeFadeIn: 3 * SECOND })])])
    const trimmed = trimClip(faded, trim({ clipId: 'a', time: SECOND }))
    expect(clipOf(trimmed, 'a')).toMatchObject({ duration: SECOND, fadeOut: SECOND, volumeFadeIn: SECOND })
    reopened(trimmed)
  })

  it('stretches a still image or a text to any length', () => {
    const placed = { start: 0, duration: 5 * SECOND, opacity: 1, transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 } }
    const still: Clip = { ...placed, id: 'still', type: 'image', mediaId: 'logo' }
    const title: Clip = { ...placed, id: 'title', type: 'text', text: 'Title', font: { family: 'Helvetica Neue', size: 48 }, color: '#ffffff', align: 'center' }
    const project = projectOf([track('t1', [still]), track('t2', [title])])
    expect(clipOf(trimClip(project, trim({ clipId: 'still', time: 3600 * SECOND })), 'still').duration).toBe(3600 * SECOND)
    expect(clipOf(trimClip(project, trim({ clipId: 'title', time: 3600 * SECOND })), 'title').duration).toBe(3600 * SECOND)
  })

  it('lets a looping clip run past the end of its source', () => {
    const looping = projectOf([track('t1', [videoClip('gif', 0, SECOND, { mediaId: 'sticker', loop: true })])])
    expect(clipOf(trimClip(looping, trim({ clipId: 'gif', time: 30 * SECOND })), 'gif').duration).toBe(30 * SECOND)
    const once = projectOf([track('t1', [videoClip('gif', 0, SECOND, { mediaId: 'sticker' })])])
    expect(clipOf(trimClip(once, trim({ clipId: 'gif', time: 30 * SECOND })), 'gif').duration).toBe(1.2 * SECOND)
  })

  it('has no source limit for media that is missing', () => {
    const lost = trimClip(sample(), trim({ clipId: 'c', time: 60 * SECOND, mediaStates: { video: { error: 'missing', isMissing: true } } }))
    expect(clipOf(lost, 'c').duration).toBe(52 * SECOND)
  })

  it('ripple-trims the end: later clips follow the new end', () => {
    const rippled = trimClip(sample(), trim({ time: 5 * SECOND, isRipple: true }))
    expect(clipOf(rippled, 'b').duration).toBe(SECOND)
    expect(clipOf(rippled, 'c').start).toBe(7 * SECOND)
    expect(clipOf(rippled, 'a').start).toBe(0)
    reopened(rippled)
  })

  it('ripple-trims the start: the clip stays put and later clips close up', () => {
    const rippled = trimClip(sample(), trim({ edge: 'start', time: 5 * SECOND, isRipple: true }))
    expect(clipOf(rippled, 'b')).toMatchObject({ start: 4 * SECOND, duration: SECOND, sourceStart: SECOND })
    expect(clipOf(rippled, 'c').start).toBe(7 * SECOND)
    reopened(rippled)
  })

  it('does nothing on a locked track', () => {
    const locked = projectOf([track('t1', [videoClip('a', 0, 2 * SECOND)], { locked: true })])
    expect(trimClip(locked, trim({ clipId: 'a', time: SECOND }))).toBe(locked)
  })
})

describe('trimming a group', () => {
  const grouped = projectOf([track('t1', [groupClip('group', 4 * SECOND, 4 * SECOND, [[videoClip('m', 0, 6 * SECOND)]], { contentStart: SECOND })])])

  it('shows its members from later on, or from earlier as far as their time reaches back, without touching them', () => {
    const later = trimClip(grouped, trim({ clipId: 'group', edge: 'start', time: 5 * SECOND }))
    expect(clipOf(later, 'group')).toMatchObject({ start: 5 * SECOND, duration: 3 * SECOND, contentStart: 2 * SECOND })
    const earliest = trimClip(grouped, trim({ clipId: 'group', edge: 'start', time: 0 }))
    expect(clipOf(earliest, 'group')).toMatchObject({ start: 3 * SECOND, duration: 5 * SECOND })
    expect(clipOf(reopened(earliest), 'group')).not.toHaveProperty('contentStart')
    expect(clipOf(earliest, 'group')).toMatchObject({ tracks: [{ clips: [{ id: 'm', start: 0, duration: 6 * SECOND }] }] })
    expect(reopened(later)).toEqual(later)
  })

  it('can be made as long as wanted at its end', () => {
    const longer = trimClip(grouped, trim({ clipId: 'group', edge: 'end', time: 60 * SECOND }))
    expect(clipOf(longer, 'group')).toMatchObject({ start: 4 * SECOND, duration: 56 * SECOND, contentStart: SECOND })
  })
})
