import type { DrawingShape, ShapeNode } from '../shared/project.js'

const FLAT = 1e-12

export type DrawingBounds = {
  left: number
  top: number
  right: number
  bottom: number
}

type Point = {
  x: number
  y: number
}

type Segment = {
  start: Point
  startControl: Point
  endControl: Point
  end: Point
  isStraight: boolean
}

function handlePoint(node: ShapeNode, handle: ShapeNode['in']): Point {
  if (handle === undefined) return { x: node.x, y: node.y }
  return { x: node.x + handle.x, y: node.y + handle.y }
}

export function segmentsOf(shape: DrawingShape): Segment[] {
  const { nodes } = shape
  const count = shape.isClosed === true ? nodes.length : nodes.length - 1
  const segments: Segment[] = []
  for (let index = 0; index < count; index++) {
    const from = nodes[index]
    const to = nodes[(index + 1) % nodes.length]
    if (from === undefined || to === undefined) continue
    const isStraight = from.out === undefined && to.in === undefined
    segments.push({ start: from, startControl: handlePoint(from, from.out), endControl: handlePoint(to, to.in), end: to, isStraight })
  }
  return segments
}

function cubicAt(start: number, startControl: number, endControl: number, end: number, progress: number): number {
  const rest = 1 - progress
  return rest * rest * rest * start + 3 * rest * rest * progress * startControl + 3 * rest * progress * progress * endControl + progress * progress * progress * end
}

// Where the curve turns back along one axis: the roots of its derivative strictly between its ends.
function turningPoints(start: number, startControl: number, endControl: number, end: number): number[] {
  const a = 3 * startControl - start - 3 * endControl + end
  const b = 2 * (start - 2 * startControl + endControl)
  const c = startControl - start
  const roots: number[] = []
  if (Math.abs(a) < FLAT) {
    if (Math.abs(b) >= FLAT) roots.push(-c / b)
  } else {
    const discriminant = b * b - 4 * a * c
    if (discriminant >= 0) {
      const root = Math.sqrt(discriminant)
      roots.push((-b + root) / (2 * a), (-b - root) / (2 * a))
    }
  }
  return roots.filter((progress) => progress > 0 && progress < 1)
}

function segmentPoints(segment: Segment): Point[] {
  const points = [segment.start, segment.end]
  if (segment.isStraight) return points
  const { start, startControl, endControl, end } = segment
  const turns = [...turningPoints(start.x, startControl.x, endControl.x, end.x), ...turningPoints(start.y, startControl.y, endControl.y, end.y)]
  for (const progress of turns) {
    points.push({ x: cubicAt(start.x, startControl.x, endControl.x, end.x, progress), y: cubicAt(start.y, startControl.y, endControl.y, end.y, progress) })
  }
  return points
}

// Clipped children stay inside their parent's fill, so only the top shapes count.
export function shapesBounds(shapes: readonly DrawingShape[], hasStrokes: boolean): DrawingBounds | undefined {
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (const shape of shapes) {
    const reach = hasStrokes && shape.stroke !== undefined ? shape.stroke.width / 2 : 0
    for (const segment of segmentsOf(shape)) {
      for (const point of segmentPoints(segment)) {
        left = Math.min(left, point.x - reach)
        top = Math.min(top, point.y - reach)
        right = Math.max(right, point.x + reach)
        bottom = Math.max(bottom, point.y + reach)
      }
    }
  }
  if (left > right) return undefined
  return { left, top, right, bottom }
}
