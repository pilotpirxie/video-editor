import type { MediaStates } from '../engine/resolve.js'
import type { AudioClip, Project, VideoClip } from '../shared/project.js'
import { hasLinkedAudio, placeOnTrack, unlockedClipIds, type NewTrack } from './clips.js'

export function clipsToSeparate(project: Project, selection: readonly string[], mediaStates: MediaStates): string[] {
  const selected = new Set(selection)
  return unlockedClipIds(project, (clip) => selected.has(clip.id) && hasLinkedAudio(clip, mediaStates))
}

function soundOf(clip: VideoClip, id: string): AudioClip {
  const sound: AudioClip = {
    id,
    type: 'audio',
    mediaId: clip.mediaId,
    start: clip.start,
    duration: clip.duration,
    sourceStart: clip.sourceStart,
    speedPercent: clip.speedPercent,
    volume: clip.volume,
  }
  if (clip.volumeFadeIn !== undefined) sound.volumeFadeIn = clip.volumeFadeIn
  if (clip.volumeFadeOut !== undefined) sound.volumeFadeOut = clip.volumeFadeOut
  if (clip.keyframes?.volume !== undefined) sound.keyframes = { volume: clip.keyframes.volume }
  return sound
}

function pictureOf(clip: VideoClip): VideoClip {
  const { volumeFadeIn: _fadeIn, volumeFadeOut: _fadeOut, keyframes, ...rest } = clip
  const picture: VideoClip = { ...rest, isAudioSeparated: true }
  if (keyframes === undefined) return picture
  const { volume: _volume, ...pictureKeyframes } = keyframes
  if (Object.keys(pictureKeyframes).length > 0) picture.keyframes = pictureKeyframes
  return picture
}

export function separateAudio(project: Project, mediaStates: MediaStates, newIds: ReadonlyMap<string, string>, newTracks: readonly NewTrack[]): Project {
  let separated = project
  let usedTracks = 0
  // Top track first, so an inserted track does not shift the rows still to come.
  for (let trackIndex = project.tracks.length - 1; trackIndex >= 0; trackIndex--) {
    const track = project.tracks[trackIndex]
    const newTrack = newTracks[usedTracks]
    if (track === undefined || track.locked || newTrack === undefined) continue

    const sounds: AudioClip[] = []
    const clips = track.clips.map((clip) => {
      const newId = newIds.get(clip.id)
      if (newId === undefined || !hasLinkedAudio(clip, mediaStates)) return clip
      sounds.push(soundOf(clip, newId))
      return pictureOf(clip)
    })
    if (sounds.length === 0) continue

    usedTracks += 1
    const tracks = separated.tracks.map((other) => (other === track ? { ...track, clips } : other))
    separated = placeOnTrack({ ...separated, tracks }, { clips: sounds, trackIndex, newTrack })
  }
  return separated
}
