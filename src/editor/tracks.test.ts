import { describe, expect, it } from 'vitest'
import { SECOND, projectOf, reopened, track, videoClip } from '../../test/fixtures.js'
import { addTrack, deleteTrack, moveTrack, renameTrack, setTrackFlag } from './tracks.js'

const project = projectOf([track('bottom', [videoClip('a', 0, SECOND)]), track('middle', []), track('top', [])])

function order(tracks: readonly { id: string }[]): string[] {
  return tracks.map((entry) => entry.id)
}

describe('tracks', () => {
  it('adds a track on top by default, or at a given layer', () => {
    expect(order(addTrack(project, { id: 'new', name: 'Track 4' }).tracks)).toEqual(['bottom', 'middle', 'top', 'new'])
    expect(order(addTrack(project, { id: 'new', name: 'Track 4' }, 1).tracks)).toEqual(['bottom', 'new', 'middle', 'top'])
    expect(reopened(addTrack(project, { id: 'new', name: 'Track 4' })).tracks[3]).toEqual({ id: 'new', name: 'Track 4', hidden: false, locked: false, muted: false, clips: [] })
  })

  it('deletes a track with its clips', () => {
    expect(order(deleteTrack(project, 'bottom').tracks)).toEqual(['middle', 'top'])
    expect(deleteTrack(project, 'missing')).toBe(project)
  })

  it('reorders tracks, clamping to the stack', () => {
    expect(order(moveTrack(project, 'bottom', 2).tracks)).toEqual(['middle', 'top', 'bottom'])
    expect(order(moveTrack(project, 'top', -5).tracks)).toEqual(['top', 'bottom', 'middle'])
    expect(moveTrack(project, 'middle', 1)).toBe(project)
  })

  it('renames a track and sets its lock, hide and mute flags', () => {
    expect(renameTrack(project, 'middle', 'Titles').tracks[1]?.name).toBe('Titles')
    const flagged = setTrackFlag(setTrackFlag(setTrackFlag(project, 'top', 'locked', true), 'top', 'hidden', true), 'top', 'muted', true)
    expect(flagged.tracks[2]).toMatchObject({ locked: true, hidden: true, muted: true })
    expect(flagged.tracks[0]).toBe(project.tracks[0])
  })

  it('never changes the project it was given', () => {
    const before = JSON.stringify(project)
    addTrack(project, { id: 'new', name: 'x' })
    moveTrack(project, 'bottom', 2)
    renameTrack(project, 'top', 'x')
    expect(JSON.stringify(project)).toBe(before)
  })
})
