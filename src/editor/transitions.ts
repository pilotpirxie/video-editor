import type { Clip, Project, Track, Transition, TransitionType, VisualClip } from '../shared/project.js'
import { TICKS_PER_SECOND } from '../shared/time.js'
import { editClips, endOf, isVisual, locateClip } from './clips.js'

export const DEFAULT_TRANSITION = TICKS_PER_SECOND

// What each transition is called in the editor.
export const TRANSITION_NAMES: Record<TransitionType, string> = {
  crossDissolve: 'Cross-dissolve',
  fadeBlack: 'Fade through black',
  fadeWhite: 'Fade through white',
  wipeLeft: 'Wipe left',
  wipeRight: 'Wipe right',
  wipeUp: 'Wipe up',
  wipeDown: 'Wipe down',
  wipeUpLeft: 'Wipe up-left',
  wipeUpRight: 'Wipe up-right',
  wipeDownLeft: 'Wipe down-left',
  wipeDownRight: 'Wipe down-right',
  slide: 'Slide left',
  slideRight: 'Slide right',
  slideUp: 'Slide up',
  slideDown: 'Slide down',
  push: 'Push left',
  pushRight: 'Push right',
  pushUp: 'Push up',
  pushDown: 'Push down',
  zoom: 'Zoom',
  shrink: 'Shrink',
  spin: 'Spin',
  circleReveal: 'Circle reveal',
  circleClose: 'Circle close',
}

// The start of a clip or its end. A transition at the start of a clip that touches the clip before it is the transition on their cut.
export type TransitionEdge = 'in' | 'out'

export type TransitionTarget = {
  clipId: string
  edge: TransitionEdge
}

// Where a transition lies on the timeline: centred on a cut, otherwise inside its clip.
type TransitionSpan = {
  from: number
  to: number
  isOnCut: boolean
  transition: Transition
}

function touchingBefore(track: Track, clip: Clip): VisualClip | undefined {
  const before = track.clips.find((other) => endOf(other) === clip.start)
  return before !== undefined && isVisual(before) ? before : undefined
}

function touchingAfter(track: Track, clip: Clip): VisualClip | undefined {
  const after = track.clips.find((other) => other.start === endOf(clip))
  return after !== undefined && isVisual(after) ? after : undefined
}

type Spans = {
  in: TransitionSpan | undefined
  out: TransitionSpan | undefined
}

// The transitions that play at the two ends of a clip, where they lie. `before` and `after` are the clips next to it on its track, which make a cut where they touch it.
// The end has no transition of its own while the clip after it brings one to their cut.
export function transitionSpans(clip: VisualClip, before: Clip | undefined, after: Clip | undefined): Spans {
  const into = clip.transitionIn
  const isOnCut = before !== undefined && isVisual(before) && endOf(before) === clip.start
  let entering: TransitionSpan | undefined
  if (into !== undefined) {
    const lead = isOnCut ? into.duration / 2 : 0
    entering = { from: clip.start - lead, to: clip.start + into.duration - lead, isOnCut, transition: into }
  }
  const out = clip.transitionOut
  const isCutAfter = after !== undefined && isVisual(after) && after.start === endOf(clip) && after.transitionIn !== undefined
  const leaving = out === undefined || isCutAfter ? undefined : { from: endOf(clip) - out.duration, to: endOf(clip), isOnCut: false, transition: out }
  return { in: entering, out: leaving }
}

function spansOn(track: Track, clip: VisualClip): Spans {
  return transitionSpans(clip, touchingBefore(track, clip), touchingAfter(track, clip))
}

// Where a transition dropped at a time on a track goes: the start of the clip there in its first half; in its second half its end, or the cut with the clip that follows it.
export function transitionTargetAt(project: Project, trackIndex: number, time: number): TransitionTarget | undefined {
  const track = project.tracks[trackIndex]
  if (track === undefined || track.locked) return undefined
  const clip = track.clips.find((candidate) => time >= candidate.start && time < endOf(candidate))
  if (clip === undefined || !isVisual(clip)) return undefined
  if (time < clip.start + clip.duration / 2) return { clipId: clip.id, edge: 'in' }
  const next = touchingAfter(track, clip)
  return next === undefined ? { clipId: clip.id, edge: 'out' } : { clipId: next.id, edge: 'in' }
}

// How much of a clip its transition at one end takes up.
function taken(span: TransitionSpan | undefined, clip: Clip): number {
  return span === undefined ? 0 : Math.min(span.to, endOf(clip)) - Math.max(span.from, clip.start)
}

// The longest a transition at this place can be without sharing time with another transition of the clips it touches.
export function longestTransition(project: Project, target: TransitionTarget): number {
  const located = locateClip(project, target.clipId)
  if (located === undefined || !isVisual(located.clip)) return 0
  const { track, clip } = located
  const spans = spansOn(track, clip)
  if (target.edge === 'out') return clip.duration - taken(spans.in, clip)

  const next = touchingAfter(track, clip)
  const cutAfter = next?.transitionIn === undefined ? 0 : next.transitionIn.duration / 2
  const free = clip.duration - Math.max(taken(spans.out, clip), cutAfter)
  const previous = touchingBefore(track, clip)
  if (previous === undefined) return free
  // On a cut each clip gives half of the length.
  const freeBefore = previous.duration - taken(spansOn(track, previous).in, previous)
  return 2 * Math.min(free, freeBefore)
}

// Sets or removes the transition at one end of a clip. Its length is kept to whole frames and to what the place has room for; where there is no room for even one frame, nothing is set.
export function setTransition(project: Project, target: TransitionTarget, transition: Transition | undefined, frameTicks: number): Project {
  const longest = Math.floor(longestTransition(project, target) / frameTicks) * frameTicks
  if (transition !== undefined && longest < frameTicks) return project
  const key = target.edge === 'in' ? 'transitionIn' : 'transitionOut'
  return editClips(project, new Set([target.clipId]), (clip) => {
    if (!isVisual(clip)) return clip
    if (transition === undefined) return clip[key] === undefined ? clip : { ...clip, [key]: undefined }
    const duration = Math.max(frameTicks, Math.min(longest, Math.round(transition.duration / frameTicks) * frameTicks))
    const current = clip[key]
    const isUnchanged = current !== undefined && current.type === transition.type && current.duration === duration
    return isUnchanged ? clip : { ...clip, [key]: { type: transition.type, duration } }
  })
}
