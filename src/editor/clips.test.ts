import { describe, expect, it } from 'vitest'
import { MEDIA_STATES, SECOND, audioClip, projectOf, track, videoClip } from '../../test/fixtures.js'
import { hasLinkedAudio, makesSound, nearestEdit } from './clips.js'

describe('nearestEdit', () => {
  const project = projectOf([track('t1', [videoClip('a', SECOND, 2 * SECOND)]), track('t2', [audioClip('b', 4 * SECOND, SECOND)])])

  it('finds the next clip edge after a time', () => {
    expect(nearestEdit(project, 0, 1)).toBe(SECOND)
    expect(nearestEdit(project, SECOND, 1)).toBe(3 * SECOND)
    expect(nearestEdit(project, 3.5 * SECOND, 1)).toBe(4 * SECOND)
  })

  it('finds the previous clip edge before a time', () => {
    expect(nearestEdit(project, 5 * SECOND, -1)).toBe(4 * SECOND)
    expect(nearestEdit(project, 3 * SECOND, -1)).toBe(SECOND)
  })

  it('finds nothing past the last edge', () => {
    expect(nearestEdit(project, 5 * SECOND, 1)).toBeUndefined()
    expect(nearestEdit(project, SECOND, -1)).toBeUndefined()
    expect(nearestEdit(projectOf([]), 0, 1)).toBeUndefined()
  })
})

describe('hasLinkedAudio and makesSound', () => {
  it('finds the sound of a video clip whose file has sound', () => {
    expect(hasLinkedAudio(videoClip('a', 0, SECOND, { mediaId: 'talk' }), MEDIA_STATES)).toBe(true)
    expect(makesSound(videoClip('a', 0, SECOND, { mediaId: 'talk' }), MEDIA_STATES)).toBe(true)
  })

  it('finds none in a silent file, a separated clip or missing media', () => {
    expect(hasLinkedAudio(videoClip('a', 0, SECOND), MEDIA_STATES)).toBe(false)
    expect(hasLinkedAudio(videoClip('a', 0, SECOND, { mediaId: 'talk', isAudioSeparated: true }), MEDIA_STATES)).toBe(false)
    expect(hasLinkedAudio(videoClip('a', 0, SECOND, { mediaId: 'gone' }), MEDIA_STATES)).toBe(false)
    expect(makesSound(videoClip('a', 0, SECOND), MEDIA_STATES)).toBe(false)
  })

  it('counts every audio clip as sound, and never treats it as linked', () => {
    expect(makesSound(audioClip('a', 0, SECOND), MEDIA_STATES)).toBe(true)
    expect(hasLinkedAudio(audioClip('a', 0, SECOND), MEDIA_STATES)).toBe(false)
  })
})

