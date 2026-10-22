import type { MediaStates } from '../engine/resolve.js'
import type { AudioClip, Clip, GroupClip, Keyframe, Keyframes, Project, Track, VideoClip, VisualClip } from '../shared/project.js'

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

export function coversTime(clip: Clip, time: number): boolean {
  return time >= clip.start && time < endOf(clip)
}

export function isVisual(clip: Clip): clip is VisualClip {
  return clip.type !== 'audio'
}

export function hasSource(clip: Clip): clip is VideoClip | AudioClip {
  return clip.type === 'video' || clip.type === 'audio'
}

export function hasVolume(clip: Clip): clip is VideoClip | AudioClip | GroupClip {
  return clip.type === 'video' || clip.type === 'audio' || clip.type === 'group'
}

export function allClips(tracks: readonly Track[]): Clip[] {
  const clips: Clip[] = []
  for (const track of tracks) {
    for (const clip of track.clips) {
      clips.push(clip)
      if (clip.type === 'group') clips.push(...allClips(clip.tracks))
    }
  }
  return clips
}

export function withMemberIds(clip: Clip, newIds: ReadonlyMap<string, string>): Clip | undefined {
  if (clip.type !== 'group') return clip
  const tracks: Track[] = []
  for (const track of clip.tracks) {
    const clips: Clip[] = []
    for (const member of track.clips) {
      const id = newIds.get(member.id)
      const renamed = withMemberIds(member, newIds)
      if (id === undefined || renamed === undefined) return undefined
      clips.push({ ...renamed, id })
    }
    tracks.push({ ...track, clips })
  }
  return { ...clip, tracks }
}

export function hasMedia(clip: Clip): clip is Extract<Clip, { mediaId: string }> {
  return clip.type === 'video' || clip.type === 'audio' || clip.type === 'image'
}

export function isCroppable(clip: Clip): clip is Extract<Clip, { type: 'video' | 'image' }> {
  return clip.type === 'video' || clip.type === 'image'
}

export function hasLinkedAudio(clip: Clip, mediaStates: MediaStates): clip is VideoClip {
  if (clip.type !== 'video' || clip.isAudioSeparated === true) return false
  const state = mediaStates[clip.mediaId]
  return state !== undefined && 'info' in state && state.info.kind === 'video' && state.info.audio !== undefined
}

export function makesSound(clip: Clip, mediaStates: MediaStates): clip is VideoClip | AudioClip | GroupClip {
  if (clip.type === 'group') return allClips(clip.tracks).some((member) => member.type !== 'group' && makesSound(member, mediaStates))
  return clip.type === 'audio' || hasLinkedAudio(clip, mediaStates)
}

export function locateClip(project: Project, clipId: string): ClipLocation | undefined {
  for (const [trackIndex, track] of project.tracks.entries()) {
    const clip = track.clips.find((candidate) => candidate.id === clipId)
    if (clip !== undefined) return { trackIndex, track, clip }
  }
  return undefined
}

export function nearestClipEdge(project: Project, time: number, direction: 1 | -1): number | undefined {
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

export function freeTrackId(project: Project, wanted: string): string {
  const taken = new Set(project.tracks.map((track) => track.id))
  let id = wanted
  for (let attempt = 2; taken.has(id); attempt++) id = `${wanted}-${attempt}`
  return id
}

export function nextTrackName(project: Project): string {
  return `Track ${project.tracks.length + 1}`
}

export function trackAboveAll(project: Project): number {
  const aboveHighestClip = project.tracks.findLastIndex((track) => track.clips.length > 0) + 1
  const track = project.tracks[aboveHighestClip]
  const isUsable = track !== undefined && !track.locked && !track.hidden
  return isUsable ? aboveHighestClip : project.tracks.length
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

export function withFadesWithin(clip: Clip): Clip {
  const { duration } = clip
  if (clip.type === 'audio') {
    return { ...clip, volumeFadeIn: fadeWithin(clip.volumeFadeIn, duration), volumeFadeOut: fadeWithin(clip.volumeFadeOut, duration) }
  }
  const visual = { ...clip, fadeIn: fadeWithin(clip.fadeIn, duration), fadeOut: fadeWithin(clip.fadeOut, duration) }
  if (visual.type !== 'video' && visual.type !== 'group') return visual
  return { ...visual, volumeFadeIn: fadeWithin(visual.volumeFadeIn, duration), volumeFadeOut: fadeWithin(visual.volumeFadeOut, duration) }
}

const END_KEYS = {
  in: { fade: 'fadeIn', transition: 'transitionIn', animation: 'animationIn' },
  out: { fade: 'fadeOut', transition: 'transitionOut', animation: 'animationOut' },
} as const

export function withOnlyAtEnd(clip: VisualClip, edge: 'in' | 'out', kept: 'fade' | 'transition' | 'animation'): VisualClip {
  let edited = clip
  for (const kind of ['fade', 'transition', 'animation'] as const) {
    const key = END_KEYS[edge][kind]
    if (kind !== kept && edited[key] !== undefined) edited = { ...edited, [key]: undefined }
  }
  return edited
}

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
  trackIndex: number
  newTrack: NewTrack
}

export function placeOnTrack(project: Project, placement: Placement): Project {
  const { clips, newTrack } = placement
  const trackIndex = Math.max(0, placement.trackIndex)
  const target = project.tracks[trackIndex]
  const ignoredIds = new Set(clips.map((clip) => clip.id))
  const fits = target !== undefined && clips.every((clip) => isFree(target, clip.start, endOf(clip), ignoredIds))
  const above = project.tracks[trackIndex + 1]
  const isAboveUsable = target !== undefined && above !== undefined && above.clips.length === 0 && !above.locked && !above.hidden && !above.muted
  let receiving: Track | undefined
  if (target !== undefined && fits) receiving = target
  else if (isAboveUsable) receiving = above
  if (receiving !== undefined) {
    const tracks = project.tracks.map((track) => (track === receiving ? { ...track, clips: [...track.clips, ...clips] } : track))
    return { ...project, tracks }
  }
  const insertAt = Math.min(trackIndex + 1, project.tracks.length)
  const tracks = [...project.tracks]
  tracks.splice(insertAt, 0, { ...emptyTrack(newTrack), clips: [...clips] })
  return { ...project, tracks }
}
