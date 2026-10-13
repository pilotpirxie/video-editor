import type { Clip, Project } from '../shared/project.js'
import { sourceTime } from '../shared/time.js'
import { endOf, shiftedKeyframes, withFadesWithin } from './clips.js'

function isCutInside(clip: Clip, cut: number): boolean {
  return cut > clip.start && cut < endOf(clip)
}

// The clips a split at `cut` applies to: the selected ones, or every clip under the playhead when nothing is selected.
export function clipsToSplit(project: Project, selection: readonly string[], cut: number): string[] {
  const selected = new Set(selection)
  const ids: string[] = []
  for (const track of project.tracks) {
    if (track.locked) continue
    for (const clip of track.clips) {
      const isChosen = selected.size === 0 || selected.has(clip.id)
      if (isChosen && isCutInside(clip, cut)) ids.push(clip.id)
    }
  }
  return ids
}

function firstPart(clip: Clip, local: number): Clip {
  if (clip.type === 'audio') return withFadesWithin({ ...clip, duration: local, volumeFadeOut: undefined })
  if (clip.type === 'video') return withFadesWithin({ ...clip, duration: local, fadeOut: undefined, volumeFadeOut: undefined })
  return withFadesWithin({ ...clip, duration: local, fadeOut: undefined })
}

// Both parts keep every keyframe, also those now outside their own range, so an eased curve stays exactly the curve it was.
function secondPart(clip: Clip, cut: number, id: string): Clip {
  const local = cut - clip.start
  const timing = { id, start: cut, duration: clip.duration - local, keyframes: shiftedKeyframes(clip.keyframes, -local) }
  if (clip.type === 'audio') return withFadesWithin({ ...clip, ...timing, sourceStart: sourceTime(clip, cut), volumeFadeIn: undefined })
  if (clip.type === 'video') {
    return withFadesWithin({ ...clip, ...timing, sourceStart: sourceTime(clip, cut), fadeIn: undefined, volumeFadeIn: undefined })
  }
  return withFadesWithin({ ...clip, ...timing, fadeIn: undefined })
}

// `newIds` maps each clip to split to the id of its second part.
export function splitClips(project: Project, cut: number, newIds: ReadonlyMap<string, string>): Project {
  let hasSplit = false
  const tracks = project.tracks.map((track) => {
    if (track.locked) return track
    const clips: Clip[] = []
    for (const clip of track.clips) {
      const newId = newIds.get(clip.id)
      if (newId === undefined || !isCutInside(clip, cut)) {
        clips.push(clip)
        continue
      }
      hasSplit = true
      clips.push(firstPart(clip, cut - clip.start), secondPart(clip, cut, newId))
    }
    return clips.length === track.clips.length ? track : { ...track, clips }
  })
  return hasSplit ? { ...project, tracks } : project
}
