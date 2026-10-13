import type { Project, Track } from '../shared/project.js'
import { emptyTrack, type NewTrack } from './clips.js'

export type TrackFlag = 'hidden' | 'locked' | 'muted'

function editTrack(project: Project, trackId: string, edit: (track: Track) => Track): Project {
  const tracks = project.tracks.map((track) => (track.id === trackId ? edit(track) : track))
  return { ...project, tracks }
}

// Without an index the track goes on top, where a new layer is expected to appear.
export function addTrack(project: Project, track: NewTrack, index = project.tracks.length): Project {
  const tracks = [...project.tracks]
  tracks.splice(Math.min(Math.max(index, 0), tracks.length), 0, emptyTrack(track))
  return { ...project, tracks }
}

export function deleteTrack(project: Project, trackId: string): Project {
  const tracks = project.tracks.filter((track) => track.id !== trackId)
  return tracks.length === project.tracks.length ? project : { ...project, tracks }
}

export function moveTrack(project: Project, trackId: string, toIndex: number): Project {
  const fromIndex = project.tracks.findIndex((track) => track.id === trackId)
  const moved = project.tracks[fromIndex]
  const target = Math.min(Math.max(toIndex, 0), project.tracks.length - 1)
  if (moved === undefined || target === fromIndex) return project
  const tracks = project.tracks.filter((track) => track !== moved)
  tracks.splice(target, 0, moved)
  return { ...project, tracks }
}

export function renameTrack(project: Project, trackId: string, name: string): Project {
  return editTrack(project, trackId, (track) => (track.name === name ? track : { ...track, name }))
}

export function setTrackFlag(project: Project, trackId: string, flag: TrackFlag, isOn: boolean): Project {
  return editTrack(project, trackId, (track) => (track[flag] === isOn ? track : { ...track, [flag]: isOn }))
}
