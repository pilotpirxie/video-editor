import type { Animation, AnimationType, Clip, Project } from '../shared/project.js'
import { TICKS_PER_SECOND, TIMELINE_GRID } from '../shared/time.js'
import { editClips, isVisual, withOnlyAtEnd } from './clips.js'

export type AnimationEdge = 'in' | 'out'

export const DEFAULT_ANIMATION = TICKS_PER_SECOND / 2

// What each animation is called in the editor. A slide comes in from the side it is named after, and goes out to that side.
export const ANIMATION_NAMES: Record<AnimationType, string> = {
  fade: 'Fade',
  pop: 'Pop',
  slideLeft: 'Slide, left side',
  slideRight: 'Slide, right side',
  slideUp: 'Slide, top',
  slideDown: 'Slide, bottom',
  zoom: 'Zoom',
  typewriter: 'Typewriter',
}

// Only a text clip has letters to show one after the other.
export function takesAnimation(clip: Clip, type: AnimationType): boolean {
  if (!isVisual(clip)) return false
  return type !== 'typewriter' || clip.type === 'text'
}

// Sets, changes or (with no animation) takes away how the chosen clips come in or go out. An animation is never longer than its clip.
export function setAnimation(project: Project, clipIds: readonly string[], edge: AnimationEdge, animation: Animation | undefined): Project {
  const key = edge === 'in' ? 'animationIn' : 'animationOut'
  return editClips(project, new Set(clipIds), (clip) => {
    if (!isVisual(clip)) return clip
    const current = clip[key]
    if (animation === undefined) return current === undefined ? clip : { ...clip, [key]: undefined }
    if (!takesAnimation(clip, animation.type)) return clip
    const onGrid = Math.round(animation.duration / TIMELINE_GRID) * TIMELINE_GRID
    const duration = Math.min(clip.duration, Math.max(TIMELINE_GRID, onGrid))
    const isUnchanged = current !== undefined && current.type === animation.type && current.duration === duration
    return withOnlyAtEnd(isUnchanged ? clip : { ...clip, [key]: { type: animation.type, duration } }, edge, 'animation')
  })
}
