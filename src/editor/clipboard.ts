import type { Clip, MediaRef, Project } from '../shared/project.js'
import { editClips, endOf, hasMedia, placeOnTrack, type NewTrack } from './clips.js'

type CopiedClip = {
  clip: Clip
  trackIndex: number
}

// Holds the media references too, so a paste still works after the import that brought the media in was undone.
export type Clipboard = {
  clips: readonly CopiedClip[]
  media: readonly MediaRef[]
}

export type Paste = {
  clipboard: Clipboard
  at: number
  // One id per pasted clip, and one track per source track in case its row is taken.
  clipIds: readonly string[]
  newTracks: readonly NewTrack[]
}

export function deleteClips(project: Project, clipIds: readonly string[]): Project {
  return editClips(project, new Set(clipIds), () => undefined)
}

// Removes the clips and moves everything after each one left by its length, so no gap is left behind.
export function rippleDelete(project: Project, clipIds: readonly string[]): Project {
  const removed = new Set(clipIds)
  const tracks = project.tracks.map((track) => {
    if (track.locked || !track.clips.some((clip) => removed.has(clip.id))) return track
    const inOrder = [...track.clips].sort((a, b) => a.start - b.start)
    const clips: Clip[] = []
    let closed = 0
    for (const clip of inOrder) {
      if (removed.has(clip.id)) {
        closed += clip.duration
      } else {
        clips.push(closed === 0 ? clip : { ...clip, start: clip.start - closed })
      }
    }
    return { ...track, clips }
  })
  return { ...project, tracks }
}

export function copyClips(project: Project, clipIds: readonly string[]): Clipboard {
  const chosen = new Set(clipIds)
  const clips: CopiedClip[] = []
  const mediaIds = new Set<string>()
  for (const [trackIndex, track] of project.tracks.entries()) {
    for (const clip of track.clips) {
      if (!chosen.has(clip.id)) continue
      clips.push({ clip, trackIndex })
      if (hasMedia(clip)) mediaIds.add(clip.mediaId)
    }
  }
  return { clips, media: project.media.filter((reference) => mediaIds.has(reference.id)) }
}

export function pasteClips(project: Project, paste: Paste): Project {
  const { clipboard, at } = paste
  const firstStart = Math.min(...clipboard.clips.map((copied) => copied.clip.start))
  if (!Number.isFinite(firstStart)) return project

  const knownMedia = new Set(project.media.map((reference) => reference.id))
  const missingMedia = clipboard.media.filter((reference) => !knownMedia.has(reference.id))
  let pasted: Project = missingMedia.length === 0 ? project : { ...project, media: [...project.media, ...missingMedia] }

  const sourceRows = [...new Set(clipboard.clips.map((copied) => copied.trackIndex))].sort((a, b) => a - b)
  let nextClipId = 0
  for (const [rowNumber, sourceRow] of sourceRows.entries()) {
    const newTrack = paste.newTracks[rowNumber]
    if (newTrack === undefined) return project
    const clips: Clip[] = []
    for (const copied of clipboard.clips) {
      if (copied.trackIndex !== sourceRow) continue
      const id = paste.clipIds[nextClipId]
      if (id === undefined) return project
      nextClipId += 1
      clips.push({ ...copied.clip, id, start: copied.clip.start - firstStart + at })
    }
    // Rows inserted for earlier groups push the later source rows up by one each.
    const trackIndex = sourceRow + (pasted.tracks.length - project.tracks.length)
    pasted = placeOnTrack(pasted, { clips, trackIndex, newTrack })
  }
  return pasted
}

export function spanEnd(clipboard: Clipboard): number {
  return Math.max(0, ...clipboard.clips.map((copied) => endOf(copied.clip)))
}
