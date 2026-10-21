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

export function nearestWithin(value: number, targets: readonly number[], range: number): number | undefined {
  let nearest: number | undefined
  for (const target of targets) {
    const distance = Math.abs(target - value)
    if (distance <= range && (nearest === undefined || distance < Math.abs(nearest - value))) nearest = target
  }
  return nearest
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
  return [...targets]
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
  return { x, y }
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
