import type { Size } from '../shared/exportPresets.js'
import type { Project } from '../shared/project.js'
import { endOf } from './clips.js'

export type Snap = {
  delta: number
  guide: number | undefined
}

export type Bounds = {
  left: number
  top: number
  right: number
  bottom: number
}

export function sortedTargets(targets: Iterable<number>): number[] {
  return [...targets].sort((a, b) => a - b)
}

// Targets are sorted ascending; on a tie the lower one wins.
export function nearestWithin(value: number, targets: readonly number[], range: number): number | undefined {
  let low = 0
  let high = targets.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if ((targets[middle] ?? Infinity) < value) low = middle + 1
    else high = middle
  }
  const above = targets[low]
  const below = targets[low - 1]
  const aboveDistance = above === undefined ? Infinity : above - value
  const belowDistance = below === undefined ? Infinity : value - below
  if (aboveDistance > range && belowDistance > range) return undefined
  return belowDistance <= aboveDistance ? below : above
}

export function snapDelta(edges: readonly number[], delta: number, targets: readonly number[], range: number): Snap {
  let best: Snap = { delta, guide: undefined }
  let bestDistance = Infinity
  for (const edge of edges) {
    const target = nearestWithin(edge + delta, targets, range)
    if (target === undefined) continue
    const distance = Math.abs(target - (edge + delta))
    if (distance < bestDistance) {
      bestDistance = distance
      best = { delta: target - edge, guide: target }
    }
  }
  return best
}

export function timelineTargets(project: Project, movingIds: ReadonlySet<string>, playhead: number): number[] {
  const targets = new Set<number>([0, playhead])
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (movingIds.has(clip.id)) continue
      targets.add(clip.start)
      targets.add(endOf(clip))
      for (const keyframes of Object.values(clip.keyframes ?? {})) {
        for (const keyframe of keyframes) {
          const time = clip.start + keyframe.time
          if (time > clip.start && time < endOf(clip)) targets.add(time)
        }
      }
    }
  }
  return sortedTargets(targets)
}

function edgesAndCentre(low: number, high: number): number[] {
  return [low, (low + high) / 2, high]
}

export type PositionTargets = {
  x: number[]
  y: number[]
}

export function positionTargets(others: readonly Bounds[], canvas: Size): PositionTargets {
  const x = edgesAndCentre(0, canvas.width)
  const y = edgesAndCentre(0, canvas.height)
  for (const other of others) {
    x.push(...edgesAndCentre(other.left, other.right))
    y.push(...edgesAndCentre(other.top, other.bottom))
  }
  return { x: sortedTargets(x), y: sortedTargets(y) }
}

export type PositionSnap = {
  x: Snap
  y: Snap
}

export function snapPosition(moving: Bounds, dx: number, dy: number, targets: PositionTargets, range: number): PositionSnap {
  return {
    x: snapDelta(edgesAndCentre(moving.left, moving.right), dx, targets.x, range),
    y: snapDelta(edgesAndCentre(moving.top, moving.bottom), dy, targets.y, range),
  }
}
