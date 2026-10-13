import type { MediaStates } from '../engine/resolve.js'
import type { AudioClip, Clip, Keyframe, Keyframes, Project, Track, VideoClip, VisualClip } from '../shared/project.js'

export type NewTrack = {
  id: string
  name: string
}

export type ClipLocation = {
  trackIndex: number
  track: Track
  clip: Clip
}

export function endOf(clip: Clip): number {
  return clip.start + clip.duration
}

export function isVisual(clip: Clip): clip is VisualClip {
  return clip.type !== 'audio'
}

export function hasSource(clip: Clip): clip is VideoClip | AudioClip {
  return clip.type === 'video' || clip.type === 'audio'
}

// A clip that shows or plays a media file. Text, blur and highlight clips have none.
export function hasMedia(clip: Clip): clip is Extract<Clip, { mediaId: string }> {
  return clip.type === 'video' || clip.type === 'audio' || clip.type === 'image'
}

// Only the picture of a video or an image can be cropped: text is laid out to fit its words, and a shape has nothing to cut away.
export function isCroppable(clip: Clip): clip is Extract<Clip, { type: 'video' | 'image' }> {
  return clip.type === 'video' || clip.type === 'image'
}

// A video clip whose sound still belongs to it: the media has sound and it was not separated.
export function hasLinkedAudio(clip: Clip, mediaStates: MediaStates): clip is VideoClip {
  if (clip.type !== 'video' || clip.isAudioSeparated === true) return false
  const state = mediaStates[clip.mediaId]
  return state !== undefined && 'info' in state && state.info.kind === 'video' && state.info.audio !== undefined
}

export function makesSound(clip: Clip, mediaStates: MediaStates): clip is VideoClip | AudioClip {
  return clip.type === 'audio' || hasLinkedAudio(clip, mediaStates)
}

export function locateClip(project: Project, clipId: string): ClipLocation | undefined {
  for (const [trackIndex, track] of project.tracks.entries()) {
    const clip = track.clips.find((candidate) => candidate.id === clipId)
    if (clip !== undefined) return { trackIndex, track, clip }
  }
  return undefined
}

// The closest clip start or end on the given side of `time`.
export function nearestEdit(project: Project, time: number, direction: 1 | -1): number | undefined {
  let nearest: number | undefined
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      for (const edit of [clip.start, endOf(clip)]) {
        const isOnThatSide = direction === 1 ? edit > time : edit < time
        const isCloser = nearest === undefined || Math.abs(edit - time) < Math.abs(nearest - time)
        if (isOnThatSide && isCloser) nearest = edit
      }
    }
  }
  return nearest
}

// The ids of the clips on unlocked tracks that pass a test, bottom track first.
export function unlockedClipIds(project: Project, isWanted: (clip: Clip) => boolean): string[] {
  const ids: string[] = []
  for (const track of project.tracks) {
    if (track.locked) continue
    for (const clip of track.clips) {
      if (isWanted(clip)) ids.push(clip.id)
    }
  }
  return ids
}

export function emptyTrack(track: NewTrack): Track {
  return { id: track.id, name: track.name, hidden: false, locked: false, muted: false, clips: [] }
}

// An id for a new track that no track has yet, derived from `wanted` so that asking again for the same project gives the same answer.
export function freeTrackId(project: Project, wanted: string): string {
  const taken = new Set(project.tracks.map((track) => track.id))
  let id = wanted
  for (let attempt = 2; taken.has(id); attempt++) id = `${wanted}-${attempt}`
  return id
}

export function nextTrackName(project: Project): string {
  return `Track ${project.tracks.length + 1}`
}

export function shiftedKeyframes(keyframes: Keyframes | undefined, delta: number): Keyframes | undefined {
  if (keyframes === undefined || delta === 0) return keyframes
  const shifted: Keyframes = {}
  for (const [property, list] of Object.entries(keyframes)) {
    const moved: Keyframe[] = list.map((keyframe) => ({ ...keyframe, time: keyframe.time + delta }))
    Object.assign(shifted, { [property]: moved })
  }
  return shifted
}

function fadeWithin(fade: number | undefined, duration: number): number | undefined {
  return fade === undefined ? undefined : Math.min(fade, duration)
}

// A fade can never be longer than its clip, so shortening a clip shortens its fades with it.
export function withFadesWithin(clip: Clip): Clip {
  const { duration } = clip
  if (clip.type === 'audio') {
    return { ...clip, volumeFadeIn: fadeWithin(clip.volumeFadeIn, duration), volumeFadeOut: fadeWithin(clip.volumeFadeOut, duration) }
  }
  const visual = { ...clip, fadeIn: fadeWithin(clip.fadeIn, duration), fadeOut: fadeWithin(clip.fadeOut, duration) }
  if (visual.type !== 'video') return visual
  return { ...visual, volumeFadeIn: fadeWithin(visual.volumeFadeIn, duration), volumeFadeOut: fadeWithin(visual.volumeFadeOut, duration) }
}

// Applies an edit to the chosen clips on unlocked tracks; an edit that returns nothing removes the clip. Untouched tracks keep their identity.
export function editClips(project: Project, clipIds: ReadonlySet<string>, edit: (clip: Clip) => Clip | undefined): Project {
  let hasChanged = false
  const tracks = project.tracks.map((track) => {
    if (track.locked || !track.clips.some((clip) => clipIds.has(clip.id))) return track
    const clips: Clip[] = []
    for (const clip of track.clips) {
      const edited = clipIds.has(clip.id) ? edit(clip) : clip
      if (edited !== clip) hasChanged = true
      if (edited !== undefined) clips.push(edited)
    }
    return { ...track, clips }
  })
  return hasChanged ? { ...project, tracks } : project
}

function isFree(track: Track, start: number, end: number, ignoredIds: ReadonlySet<string>): boolean {
  if (track.locked) return false
  return track.clips.every((clip) => ignoredIds.has(clip.id) || endOf(clip) <= start || clip.start >= end)
}

export type Placement = {
  clips: readonly Clip[]
  // Row the clips were dropped on; rows past the top mean "above everything".
  trackIndex: number
  newTrack: NewTrack
}

// One rule for every drop: clips land on the row they were dropped on when it is free, otherwise on a new track directly above it.
export function placeOnTrack(project: Project, placement: Placement): Project {
  const { clips, newTrack } = placement
  const trackIndex = Math.max(0, placement.trackIndex)
  const target = project.tracks[trackIndex]
  const ignoredIds = new Set(clips.map((clip) => clip.id))
  const fits = target !== undefined && clips.every((clip) => isFree(target, clip.start, endOf(clip), ignoredIds))
  if (target !== undefined && fits) {
    const tracks = project.tracks.map((track) => (track === target ? { ...track, clips: [...track.clips, ...clips] } : track))
    return { ...project, tracks }
  }
  const insertAt = Math.min(trackIndex + 1, project.tracks.length)
  const tracks = [...project.tracks]
  tracks.splice(insertAt, 0, { ...emptyTrack(newTrack), clips: [...clips] })
  return { ...project, tracks }
}
