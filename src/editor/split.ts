import type { Clip, Project } from '../shared/project.js'
import { sourceTime } from '../shared/time.js'
import { endOf, shiftedKeyframes, unlockedClipIds, withFadesWithin, withMemberIds } from './clips.js'

function isCutInside(clip: Clip, cut: number): boolean {
  return cut > clip.start && cut < endOf(clip)
}

// The clips a split at `cut` applies to: the selected ones, or every clip under the playhead when nothing is selected.
export function clipsToSplit(project: Project, selection: readonly string[], cut: number): string[] {
  const selected = new Set(selection)
  return unlockedClipIds(project, (clip) => (selected.size === 0 || selected.has(clip.id)) && isCutInside(clip, cut))
}

// What plays at the end of a clip goes to the later part and what plays at its start stays with the earlier one: fades, transitions and animations alike.
export function earlierPart(clip: Clip, cut: number): Clip {
  const duration = cut - clip.start
  if (clip.type === 'audio') return withFadesWithin({ ...clip, duration, volumeFadeOut: undefined })
  const ending = { duration, fadeOut: undefined, transitionOut: undefined, animationOut: undefined }
  if (clip.type === 'video' || clip.type === 'group') return withFadesWithin({ ...clip, ...ending, volumeFadeOut: undefined })
  return withFadesWithin({ ...clip, ...ending })
}

// Both parts keep every keyframe, also those now outside their own range, so an eased curve stays exactly the curve it was.
// The later part of a group shows the same members from later on.
export function laterPart(clip: Clip, cut: number): Clip {
  const local = cut - clip.start
  const timing = { start: cut, duration: clip.duration - local, keyframes: shiftedKeyframes(clip.keyframes, -local) }
  if (clip.type === 'audio') return withFadesWithin({ ...clip, ...timing, sourceStart: sourceTime(clip, cut), volumeFadeIn: undefined })
  const starting = { fadeIn: undefined, transitionIn: undefined, animationIn: undefined }
  if (clip.type === 'video') return withFadesWithin({ ...clip, ...timing, ...starting, sourceStart: sourceTime(clip, cut), volumeFadeIn: undefined })
  if (clip.type === 'group') return withFadesWithin({ ...clip, ...timing, ...starting, contentStart: (clip.contentStart ?? 0) + local, volumeFadeIn: undefined })
  return withFadesWithin({ ...clip, ...timing, ...starting })
}

// `newIds` maps each clip to split to the id of its second part, and every clip inside a group that is split to the id of its copy there.
export function splitClips(project: Project, cut: number, newIds: ReadonlyMap<string, string>): Project {
  let hasSplit = false
  const tracks = project.tracks.map((track) => {
    if (track.locked) return track
    const clips: Clip[] = []
    for (const clip of track.clips) {
      const newId = newIds.get(clip.id)
      // The members of the second part of a group are copies. Without ids for all of them the group is not split.
      const copy = newId === undefined || !isCutInside(clip, cut) ? undefined : withMemberIds(clip, newIds)
      if (newId === undefined || copy === undefined) {
        clips.push(clip)
        continue
      }
      hasSplit = true
      clips.push(earlierPart(clip, cut), { ...laterPart(copy, cut), id: newId })
    }
    return clips.length === track.clips.length ? track : { ...track, clips }
  })
  return hasSplit ? { ...project, tracks } : project
}
