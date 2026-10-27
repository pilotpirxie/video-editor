import type { Clip, Project } from '../shared/project.js'
import { sourceTime } from '../shared/time.js'
import { endOf, shiftedKeyframes, unlockedClipIds, withFadesWithin, withMemberIds } from './clips.js'

function isCutInside(clip: Clip, cut: number): boolean {
  return cut > clip.start && cut < endOf(clip)
}

export function clipsToSplit(project: Project, selection: readonly string[], cut: number): string[] {
  const selected = new Set(selection)
  return unlockedClipIds(project, (clip) => (selected.size === 0 || selected.has(clip.id)) && isCutInside(clip, cut))
}

export function earlierPart(clip: Clip, cut: number): Clip {
  const duration = cut - clip.start
  if (clip.type === 'drawing') return { ...clip, duration }
  if (clip.type === 'audio') return withFadesWithin({ ...clip, duration, volumeFadeOut: undefined })
  const ending = { duration, fadeOut: undefined, transitionOut: undefined, animationOut: undefined }
  if (clip.type === 'video' || clip.type === 'group' || clip.type === 'animation') return withFadesWithin({ ...clip, ...ending, volumeFadeOut: undefined })
  return withFadesWithin({ ...clip, ...ending })
}

export function laterPart(clip: Clip, cut: number): Clip {
  const local = cut - clip.start
  const timing = { start: cut, duration: clip.duration - local, keyframes: shiftedKeyframes(clip.keyframes, -local) }
  if (clip.type === 'drawing') return { ...clip, ...timing }
  if (clip.type === 'audio') return withFadesWithin({ ...clip, ...timing, sourceStart: sourceTime(clip, cut), volumeFadeIn: undefined })
  const starting = { fadeIn: undefined, transitionIn: undefined, animationIn: undefined }
  if (clip.type === 'video' || clip.type === 'animation') return withFadesWithin({ ...clip, ...timing, ...starting, sourceStart: sourceTime(clip, cut), volumeFadeIn: undefined })
  if (clip.type === 'group') return withFadesWithin({ ...clip, ...timing, ...starting, contentStart: (clip.contentStart ?? 0) + local, volumeFadeIn: undefined })
  return withFadesWithin({ ...clip, ...timing, ...starting })
}

export function splitClips(project: Project, cut: number, newIds: ReadonlyMap<string, string>): Project {
  let hasSplit = false
  const tracks = project.tracks.map((track) => {
    if (track.locked) return track
    const clips: Clip[] = []
    for (const clip of track.clips) {
      const newId = newIds.get(clip.id)
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
