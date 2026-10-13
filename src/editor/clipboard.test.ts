import { describe, expect, it } from 'vitest'
import { SAMPLE_MEDIA, SECOND, audioClip, clipIds, clipOf, projectOf, reopened, track, videoClip } from '../../test/fixtures.js'
import type { Project } from '../shared/project.js'
import { copyClips, deleteClips, pasteClips, rippleDelete, spanEnd, type Paste } from './clipboard.js'

function sample(): Project {
  return projectOf([
    track('t1', [videoClip('a', 0, 2 * SECOND), videoClip('b', 2 * SECOND, SECOND), videoClip('c', 5 * SECOND, SECOND)]),
    track('t2', [audioClip('music', SECOND, 3 * SECOND)]),
  ])
}

function paste(project: Project, ids: readonly string[], at: number): Paste {
  return {
    clipboard: copyClips(project, ids),
    at,
    clipIds: ['p1', 'p2', 'p3'],
    newTracks: [
      { id: 'n1', name: 'Track 3' },
      { id: 'n2', name: 'Track 4' },
    ],
  }
}

describe('deleteClips', () => {
  it('removes the clips and leaves a gap', () => {
    const deleted = deleteClips(sample(), ['b', 'music'])
    expect(clipIds(deleted)).toEqual([['a', 'c'], []])
    expect(clipOf(deleted, 'c').start).toBe(5 * SECOND)
  })

  it('keeps clips on locked tracks', () => {
    const locked = projectOf([track('t1', [videoClip('a', 0, SECOND)], { locked: true })])
    expect(deleteClips(locked, ['a'])).toBe(locked)
  })
})

describe('rippleDelete', () => {
  it('closes the gap each removed clip leaves on its track', () => {
    const rippled = rippleDelete(sample(), ['a', 'b'])
    expect(clipIds(rippled)).toEqual([['c'], ['music']])
    expect(clipOf(rippled, 'c').start).toBe(2 * SECOND)
    expect(clipOf(rippled, 'music').start).toBe(SECOND)
    reopened(rippled)
  })

  it('moves only the clips after the removed one', () => {
    const rippled = rippleDelete(sample(), ['b'])
    expect(clipOf(rippled, 'a').start).toBe(0)
    expect(clipOf(rippled, 'c').start).toBe(4 * SECOND)
  })
})

describe('copy and paste', () => {
  it('pastes at the playhead with new ids, keeping the spacing between clips', () => {
    const project = sample()
    const pasted = pasteClips(project, paste(project, ['b', 'c'], 10 * SECOND))
    expect(clipIds(pasted)).toEqual([['a', 'b', 'c', 'p1', 'p2'], ['music']])
    expect(clipOf(pasted, 'p1').start).toBe(10 * SECOND)
    expect(clipOf(pasted, 'p2').start).toBe(13 * SECOND)
    reopened(pasted)
  })

  it('keeps clips from different tracks on different tracks', () => {
    const project = sample()
    const pasted = pasteClips(project, paste(project, ['a', 'music'], 10 * SECOND))
    expect(clipIds(pasted)).toEqual([['a', 'b', 'c', 'p1'], ['music', 'p2']])
    expect(clipOf(pasted, 'p2').start).toBe(11 * SECOND)
  })

  it('pastes onto a new track above when the space is taken', () => {
    const project = sample()
    const pasted = pasteClips(project, paste(project, ['a', 'music'], 0))
    expect(clipIds(pasted)).toEqual([['a', 'b', 'c'], ['p1'], ['music'], ['p2']])
    expect(pasted.tracks[1]).toMatchObject({ id: 'n1', name: 'Track 3' })
    expect(pasted.tracks[3]).toMatchObject({ id: 'n2', name: 'Track 4' })
    reopened(pasted)
  })

  it('brings back media that is no longer in the project', () => {
    const project = sample()
    const clipboard = copyClips(project, ['music'])
    expect(clipboard.media).toEqual([SAMPLE_MEDIA[1]])
    const withoutMusic: Project = { ...deleteClips(project, ['music']), media: project.media.filter((reference) => reference.id !== 'music') }
    const pasted = pasteClips(withoutMusic, { ...paste(project, [], 0), clipboard, at: 20 * SECOND })
    expect(pasted.media.map((reference) => reference.id)).toEqual(['video', 'logo', 'music'])
    reopened(pasted)
  })

  it('does nothing with an empty clipboard', () => {
    const project = sample()
    expect(pasteClips(project, paste(project, [], 0))).toBe(project)
  })

  it('reports where the copied clips end, for a duplicate placed right after them', () => {
    expect(spanEnd(copyClips(sample(), ['a', 'music']))).toBe(4 * SECOND)
  })
})
