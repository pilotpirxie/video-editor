import { describe, expect, it } from 'vitest'
import { FRAME, SECOND, audioClip, clipOf, projectOf, reopened, track, videoClip } from '../../test/fixtures.js'
import type { Project, Transition, VideoClip } from '../shared/project.js'
import { endOf, locateClip } from './clips.js'
import { longestTransition, setTransition, transitionSpans, transitionTargetAt } from './transitions.js'

const DISSOLVE: Transition = { type: 'crossDissolve', duration: SECOND }

// Two clips that touch at 4 s, a gap, and a third clip from 10 s.
function cutProject(first: Partial<VideoClip> = {}, second: Partial<VideoClip> = {}): Project {
  return projectOf([
    track('main', [videoClip('first', 0, 4 * SECOND, first), videoClip('second', 4 * SECOND, 4 * SECOND, second), videoClip('third', 10 * SECOND, 2 * SECOND)]),
    track('sound', [audioClip('music', 0, 12 * SECOND)]),
  ])
}

function spansOf(project: Project, clipId: string): ReturnType<typeof transitionSpans> {
  const located = locateClip(project, clipId)
  if (located === undefined || located.clip.type === 'audio') throw new Error(`No visual clip "${clipId}"`)
  const { track, clip } = located
  const before = track.clips.find((other) => endOf(other) === clip.start)
  const after = track.clips.find((other) => other.start === endOf(clip))
  return transitionSpans(clip, before, after)
}

describe('transitionTargetAt', () => {
  const project = cutProject()

  it('takes the start of a clip in its first half and its end in its second', () => {
    expect(transitionTargetAt(project, 0, 10.5 * SECOND)).toEqual({ clipId: 'third', edge: 'in' })
    expect(transitionTargetAt(project, 0, 11.5 * SECOND)).toEqual({ clipId: 'third', edge: 'out' })
    expect(transitionTargetAt(project, 0, SECOND)).toEqual({ clipId: 'first', edge: 'in' })
  })

  it('takes the cut from either side of it', () => {
    expect(transitionTargetAt(project, 0, 3 * SECOND)).toEqual({ clipId: 'second', edge: 'in' })
    expect(transitionTargetAt(project, 0, 5 * SECOND)).toEqual({ clipId: 'second', edge: 'in' })
  })

  it('finds nothing in a gap, on a sound clip, on a locked track and outside the tracks', () => {
    expect(transitionTargetAt(project, 0, 9 * SECOND)).toBeUndefined()
    expect(transitionTargetAt(project, 1, SECOND)).toBeUndefined()
    expect(transitionTargetAt(project, 4, SECOND)).toBeUndefined()
    const locked = projectOf([track('main', [videoClip('first', 0, SECOND)], { locked: true })])
    expect(transitionTargetAt(locked, 0, 0)).toBeUndefined()
  })
})

describe('transitionSpans', () => {
  it('centres a transition on a cut and keeps one at a free end inside its clip', () => {
    const project = cutProject({ transitionIn: DISSOLVE, transitionOut: DISSOLVE }, { transitionIn: DISSOLVE, transitionOut: DISSOLVE })
    expect(spansOf(project, 'first').in).toMatchObject({ from: 0, to: SECOND, isOnCut: false })
    expect(spansOf(project, 'second').in).toMatchObject({ from: 3.5 * SECOND, to: 4.5 * SECOND, isOnCut: true })
    expect(spansOf(project, 'second').out).toMatchObject({ from: 7 * SECOND, to: 8 * SECOND, isOnCut: false })
  })

  it('shows no end transition on a clip whose cut has a transition', () => {
    const project = cutProject({ transitionOut: DISSOLVE }, { transitionIn: DISSOLVE })
    expect(spansOf(project, 'first').out).toBeUndefined()
    expect(spansOf(cutProject({ transitionOut: DISSOLVE }), 'first').out).toMatchObject({ from: 3 * SECOND, to: 4 * SECOND })
  })
})

describe('setTransition', () => {
  it('sets a transition in whole frames, changes it and removes it', () => {
    const set = setTransition(cutProject(), { clipId: 'third', edge: 'out' }, { type: 'push', duration: SECOND + 1000 }, FRAME)
    expect(clipOf(set, 'third')).toMatchObject({ transitionOut: { type: 'push', duration: SECOND } })
    expect(reopened(set)).toEqual(set)
    expect(setTransition(set, { clipId: 'third', edge: 'out' }, { type: 'push', duration: SECOND }, FRAME)).toBe(set)

    const removed = setTransition(set, { clipId: 'third', edge: 'out' }, undefined, FRAME)
    expect('transitionOut' in clipOf(reopened(removed), 'third')).toBe(false)
    expect(setTransition(removed, { clipId: 'third', edge: 'out' }, undefined, FRAME)).toBe(removed)
  })

  it('keeps a transition as short as the room its clip has left', () => {
    const project = cutProject({}, {})
    const long = setTransition(project, { clipId: 'third', edge: 'in' }, { type: 'slide', duration: 60 * SECOND }, FRAME)
    expect(clipOf(long, 'third')).toMatchObject({ transitionIn: { duration: 2 * SECOND } })
    expect(setTransition(long, { clipId: 'third', edge: 'out' }, DISSOLVE, FRAME)).toBe(long)
  })

  it('gives a transition on a cut half of its length from each clip', () => {
    const project = cutProject({ transitionIn: { type: 'zoom', duration: 3 * SECOND } })
    expect(longestTransition(project, { clipId: 'second', edge: 'in' })).toBe(2 * SECOND)
    expect(longestTransition(cutProject(), { clipId: 'second', edge: 'in' })).toBe(8 * SECOND)
    expect(longestTransition(cutProject(), { clipId: 'first', edge: 'out' })).toBe(4 * SECOND)
  })

  it('leaves sound clips and locked tracks alone', () => {
    const project = cutProject()
    expect(setTransition(project, { clipId: 'music', edge: 'in' }, DISSOLVE, FRAME)).toBe(project)
    const locked = projectOf([track('main', [videoClip('first', 0, SECOND)], { locked: true })])
    expect(setTransition(locked, { clipId: 'first', edge: 'in' }, DISSOLVE, FRAME)).toBe(locked)
  })
})
