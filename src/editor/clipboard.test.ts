import { describe, expect, it } from 'vitest'
import { SAMPLE_MEDIA, SECOND, audioClip, clipIds, clipOf, groupClip, projectOf, reopened, track, videoClip } from '../../test/fixtures.js'
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
    memberIds: new Map(),
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

  it('pastes a clip with its effects and transitions, and a clip without media', () => {
    const dressed = videoClip('a', 0, SECOND, { effects: [{ type: 'clipBlur', strength: 5 }], transitionIn: { type: 'slide', duration: SECOND / 2 } })
    const spotlight = { id: 'spot', type: 'highlight' as const, start: SECOND, duration: SECOND, transform: dressed.transform, opacity: 1, width: 300, height: 200, shape: 'ellipse' as const, softEdge: 10, color: '#404040', isSpotlight: true as const }
    const project = projectOf([track('t1', [dressed, spotlight])])
    const pasted = reopened(pasteClips(project, paste(project, ['a', 'spot'], 4 * SECOND)))
    expect(clipOf(pasted, 'p1')).toMatchObject({ effects: dressed.effects, transitionIn: dressed.transitionIn })
    expect(clipOf(pasted, 'p2')).toMatchObject({ type: 'highlight', start: 5 * SECOND, color: '#404040', isSpotlight: true })
    expect(pasted.media).toEqual(project.media)
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

  it('pastes a group with copies of its members, and brings back the media they use', () => {
    const inner = groupClip('inner', SECOND, SECOND, [[audioClip('music', 0, SECOND)]])
    const project = projectOf([track('t1', [groupClip('group', 0, 2 * SECOND, [[videoClip('m', 0, SECOND), inner]])])])
    const clipboard = copyClips(project, ['group'])
    expect(clipboard.media.map((entry) => entry.id).sort()).toEqual(['music', 'video'])
    const memberIds = new Map([
      ['m', 'm-2'],
      ['inner', 'inner-2'],
      ['music', 'music-2'],
    ])
    const emptied = { ...project, media: [] }
    const pasted = reopened(pasteClips(emptied, { ...paste(project, ['group'], 4 * SECOND), memberIds }))
    expect(clipIds(pasted)).toEqual([['group', 'p1']])
    const copy = clipOf(pasted, 'p1')
    expect(copy.type === 'group' && copy.tracks[0]?.clips.map((clip) => clip.id)).toEqual(['m-2', 'inner-2'])
    expect(pasted.media.map((entry) => entry.id).sort()).toEqual(['music', 'video'])
    expect(pasteClips(emptied, paste(project, ['group'], 4 * SECOND))).toBe(emptied)
  })

  it('does nothing with an empty clipboard', () => {
    const project = sample()
    expect(pasteClips(project, paste(project, [], 0))).toBe(project)
  })

  it('reports where the copied clips end, for a duplicate placed right after them', () => {
    expect(spanEnd(copyClips(sample(), ['a', 'music']))).toBe(4 * SECOND)
  })
})
