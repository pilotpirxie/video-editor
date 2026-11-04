import type { Clip, DrawingShape, MediaRef, Project, Swatch } from '../shared/project.js'
import { allClips, editClips, endOf, hasMedia, placeOnTrack, withMemberIds, type NewTrack } from './clips.js'
import { withArrivingSwatches, withKnownSwatches } from './drawings.js'

type CopiedClip = {
  clip: Clip
  trackIndex: number
}

export type Clipboard = {
  clips: readonly CopiedClip[]
  media: readonly MediaRef[]
  swatches?: readonly Swatch[]
}

export type Paste = {
  clipboard: Clipboard
  at: number
  clipIds: readonly string[]
  memberIds: ReadonlyMap<string, string>
  newTracks: readonly NewTrack[]
}

export function holdsDrawings(clipboard: Clipboard): boolean {
  for (const { clip } of clipboard.clips) {
    if (clip.type === 'drawing') return true
    if (clip.type === 'group' && allClips(clip.tracks).some((member) => member.type === 'drawing')) return true
  }
  return false
}

// Only drawings carry everything they need, so only they can be pasted outside the place they were copied from.
export function holdsOnlyDrawings(clipboard: Clipboard): boolean {
  return clipboard.clips.every(({ clip }) => clip.type === 'drawing')
}

export function deleteClips(project: Project, clipIds: readonly string[]): Project {
  return editClips(project, new Set(clipIds), () => undefined)
}

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
      for (const copied of allClips([{ ...track, clips: [clip] }])) {
        if (hasMedia(copied)) mediaIds.add(copied.mediaId)
      }
    }
  }
  const copied: Clipboard = { clips, media: project.media.filter((reference) => mediaIds.has(reference.id)) }
  if (project.swatches !== undefined) copied.swatches = project.swatches
  return copied
}

function shapesOnClipboard(clipboard: Clipboard): DrawingShape[] {
  const shapes: DrawingShape[] = []
  for (const { clip } of clipboard.clips) {
    if (clip.type === 'drawing') shapes.push(...clip.shapes)
  }
  return shapes
}

export function pasteClips(project: Project, paste: Paste): Project {
  const { clipboard, at } = paste
  const firstStart = Math.min(...clipboard.clips.map((copied) => copied.clip.start))
  if (!Number.isFinite(firstStart)) return project

  const knownMedia = new Set(project.media.map((reference) => reference.id))
  const missingMedia = clipboard.media.filter((reference) => !knownMedia.has(reference.id))
  const withMissingMedia: Project = missingMedia.length === 0 ? project : { ...project, media: [...project.media, ...missingMedia] }
  let pasted = withArrivingSwatches(withMissingMedia, shapesOnClipboard(clipboard), clipboard.swatches)
  const { swatches } = pasted

  const sourceRows = [...new Set(clipboard.clips.map((copied) => copied.trackIndex))].sort((a, b) => a - b)
  let nextClipId = 0
  for (const [rowNumber, sourceRow] of sourceRows.entries()) {
    const newTrack = paste.newTracks[rowNumber]
    if (newTrack === undefined) return project
    const clips: Clip[] = []
    for (const copied of clipboard.clips) {
      if (copied.trackIndex !== sourceRow) continue
      const id = paste.clipIds[nextClipId]
      const copy = withMemberIds(copied.clip, paste.memberIds)
      if (id === undefined || copy === undefined) return project
      nextClipId += 1
      const placed = copy.type === 'drawing' ? { ...copy, shapes: copy.shapes.map((shape) => withKnownSwatches(shape, swatches)) } : copy
      clips.push({ ...placed, id, start: copied.clip.start - firstStart + at })
    }
    const rowsInsertedSoFar = pasted.tracks.length - project.tracks.length
    const trackIndex = sourceRow + rowsInsertedSoFar
    pasted = placeOnTrack(pasted, { clips, trackIndex, newTrack })
  }
  return pasted
}

export function spanEnd(clipboard: Clipboard): number {
  return Math.max(0, ...clipboard.clips.map((copied) => endOf(copied.clip)))
}
