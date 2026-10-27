import { describe, expect, it } from 'vitest'
import { MEDIA_STATES, SECOND, animationClip, audioClip, projectOf, track, videoClip } from '../../test/fixtures.js'
import { hasLinkedAudio, makesSound, nearestClipEdge, trackAboveAll } from './clips.js'

describe('nearestClipEdge', () => {
  const project = projectOf([track('t1', [videoClip('a', SECOND, 2 * SECOND)]), track('t2', [audioClip('b', 4 * SECOND, SECOND)])])

  it('finds the next clip edge after a time', () => {
    expect(nearestClipEdge(project, 0, 1)).toBe(SECOND)
    expect(nearestClipEdge(project, SECOND, 1)).toBe(3 * SECOND)
    expect(nearestClipEdge(project, 3.5 * SECOND, 1)).toBe(4 * SECOND)
  })

  it('finds the previous clip edge before a time', () => {
    expect(nearestClipEdge(project, 5 * SECOND, -1)).toBe(4 * SECOND)
    expect(nearestClipEdge(project, 3 * SECOND, -1)).toBe(SECOND)
  })

  it('finds nothing past the last edge', () => {
    expect(nearestClipEdge(project, 5 * SECOND, 1)).toBeUndefined()
    expect(nearestClipEdge(project, SECOND, -1)).toBeUndefined()
    expect(nearestClipEdge(projectOf([]), 0, 1)).toBeUndefined()
  })
})

describe('hasLinkedAudio and makesSound', () => {
  it('finds the sound of a video clip whose file has sound', () => {
    expect(hasLinkedAudio(videoClip('a', 0, SECOND, { mediaId: 'talk' }), MEDIA_STATES)).toBe(true)
    expect(makesSound(videoClip('a', 0, SECOND, { mediaId: 'talk' }), MEDIA_STATES, {})).toBe(true)
  })

  it('finds none in a silent file, a separated clip or missing media', () => {
    expect(hasLinkedAudio(videoClip('a', 0, SECOND), MEDIA_STATES)).toBe(false)
    expect(hasLinkedAudio(videoClip('a', 0, SECOND, { mediaId: 'talk', isAudioSeparated: true }), MEDIA_STATES)).toBe(false)
    expect(hasLinkedAudio(videoClip('a', 0, SECOND, { mediaId: 'gone' }), MEDIA_STATES)).toBe(false)
    expect(makesSound(videoClip('a', 0, SECOND), MEDIA_STATES, {})).toBe(false)
  })

  it('counts every audio clip as sound, and never treats it as linked', () => {
    expect(makesSound(audioClip('a', 0, SECOND), MEDIA_STATES, {})).toBe(true)
    expect(hasLinkedAudio(audioClip('a', 0, SECOND), MEDIA_STATES)).toBe(false)
  })

  it('finds the sound of an animation in its own clips, and none in one that contains itself', () => {
    const wave = '/films/wave.pbanim'
    const states = { ...MEDIA_STATES, wave: { info: { kind: 'animation' as const, path: wave } } }
    const clip = animationClip('a', 0, SECOND)
    expect(makesSound(clip, states, { [wave]: projectOf([track('t1', [audioClip('voice', 0, SECOND)])]) })).toBe(true)
    expect(makesSound(clip, states, { [wave]: projectOf([track('t1', [videoClip('silent', 0, SECOND)])]) })).toBe(false)
    expect(makesSound(clip, states, { [wave]: projectOf([track('t1', [animationClip('again', 0, SECOND)])]) })).toBe(false)
    expect(makesSound(clip, states, {})).toBe(false)
  })
})


describe('trackAboveAll', () => {
  it('fills the empty track just above the highest clip', () => {
    expect(trackAboveAll(projectOf([track('t1', []), track('t2', []), track('t3', [])]))).toBe(0)
    expect(trackAboveAll(projectOf([track('t1', [videoClip('a', 0, SECOND)]), track('t2', []), track('t3', [])]))).toBe(1)
  })

  it('makes a new track on top when none is free above the highest clip', () => {
    expect(trackAboveAll(projectOf([]))).toBe(0)
    expect(trackAboveAll(projectOf([track('t1', []), track('t2', [videoClip('a', 0, SECOND)])]))).toBe(2)
  })

  it('does not put anything on a locked or hidden track', () => {
    expect(trackAboveAll(projectOf([track('t1', [], { locked: true }), track('t2', [])]))).toBe(2)
    expect(trackAboveAll(projectOf([track('t1', [], { hidden: true }), track('t2', [])]))).toBe(2)
  })
})
