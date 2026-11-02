import { valueAt, type DrawingClip, type DrawingShape, type Keyframe, type NodeSet, type ShapeNode, type ShapeStroke } from '../shared/project.js'

const FLAT = 1e-12
const DEGREES_TO_RADIANS = Math.PI / 180
// Canvas2D and SVG cut a mitre longer than this many stroke widths down to a bevel.
export const MITER_LIMIT = 4
const OUTLINE_SAMPLES = 32
const REFINE_ROUNDS = 12

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

function segmentsOf(shape: DrawingShape): Segment[] {
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

// The same outline as SVG path data, which Path2D also reads.
export function svgPathOf(shape: DrawingShape): string {
  const first = shape.nodes[0]
  if (first === undefined) return ''
  const commands = [`M${first.x} ${first.y}`]
  for (const { startControl, endControl, end, isStraight } of segmentsOf(shape)) {
    if (isStraight) commands.push(`L${end.x} ${end.y}`)
    else commands.push(`C${startControl.x} ${startControl.y} ${endControl.x} ${endControl.y} ${end.x} ${end.y}`)
  }
  if (shape.isClosed === true) commands.push('Z')
  return commands.join(' ')
}

// Only a closed outline has an inside and an outside to align a stroke to.
export function strokeAlignOf(shape: DrawingShape): 'inside' | 'center' | 'outside' {
  if (shape.isClosed !== true) return 'center'
  return shape.stroke?.align ?? 'center'
}

// How far past the outline the stroke can reach.
function strokeReach(shape: DrawingShape, stroke: ShapeStroke): number {
  const align = strokeAlignOf(shape)
  let reach = stroke.width / 2
  if (align === 'inside') reach = 0
  else if (align === 'outside') reach = stroke.width
  if (stroke.join === 'miter') return reach * MITER_LIMIT
  if (stroke.cap === 'square') return reach * Math.SQRT2
  return reach
}

function cubicAt(start: number, startControl: number, endControl: number, end: number, progress: number): number {
  const rest = 1 - progress
  return rest * rest * rest * start + 3 * rest * rest * progress * startControl + 3 * rest * progress * progress * endControl + progress * progress * progress * end
}

function distanceAlong(segment: Segment, progress: number, point: Point): number {
  const { start, startControl, endControl, end } = segment
  const x = cubicAt(start.x, startControl.x, endControl.x, end.x, progress)
  const y = cubicAt(start.y, startControl.y, endControl.y, end.y, progress)
  return Math.hypot(x - point.x, y - point.y)
}

export type OutlinePoint = {
  segmentIndex: number
  progress: number
  distance: number
}

// The closest of evenly spaced samples, then halving the step around it.
export function nearestOnOutline(shape: DrawingShape, point: Point): OutlinePoint | undefined {
  let nearest: OutlinePoint | undefined
  for (const [segmentIndex, segment] of segmentsOf(shape).entries()) {
    let progress = 0
    let distance = distanceAlong(segment, 0, point)
    for (let sample = 1; sample <= OUTLINE_SAMPLES; sample++) {
      const sampled = distanceAlong(segment, sample / OUTLINE_SAMPLES, point)
      if (sampled >= distance) continue
      progress = sample / OUTLINE_SAMPLES
      distance = sampled
    }
    let step = 1 / OUTLINE_SAMPLES
    for (let round = 0; round < REFINE_ROUNDS; round++) {
      step /= 2
      for (const candidate of [progress - step, progress + step]) {
        if (candidate < 0 || candidate > 1) continue
        const sampled = distanceAlong(segment, candidate, point)
        if (sampled >= distance) continue
        progress = candidate
        distance = sampled
      }
    }
    if (nearest === undefined || distance < nearest.distance) nearest = { segmentIndex, progress, distance }
  }
  return nearest
}

function between(from: Point, to: Point, progress: number): Point {
  return { x: from.x + (to.x - from.x) * progress, y: from.y + (to.y - from.y) * progress }
}

function handleFrom(node: Point, end: Point): Point {
  return { x: end.x - node.x, y: end.y - node.y }
}

// De Casteljau: the two halves trace the same curve, so the outline stays as it was. A side without a handle keeps none.
export function splitSegment(shape: DrawingShape, segmentIndex: number, progress: number): ShapeNode[] {
  const { nodes } = shape
  const endIndex = (segmentIndex + 1) % nodes.length
  const startNode = nodes[segmentIndex]
  const endNode = nodes[endIndex]
  const segment = segmentsOf(shape)[segmentIndex]
  if (startNode === undefined || endNode === undefined || segment === undefined) return nodes
  const { start, startControl, endControl, end } = segment
  const firstControl = between(start, startControl, progress)
  const middleControl = between(startControl, endControl, progress)
  const lastControl = between(endControl, end, progress)
  const beforeSplit = between(firstControl, middleControl, progress)
  const afterSplit = between(middleControl, lastControl, progress)
  const at = between(beforeSplit, afterSplit, progress)
  const added: ShapeNode = { x: at.x, y: at.y }
  if (!segment.isStraight) {
    added.in = handleFrom(at, beforeSplit)
    added.out = handleFrom(at, afterSplit)
  }
  const split = [...nodes]
  if (startNode.out !== undefined) split[segmentIndex] = { ...startNode, out: handleFrom(start, firstControl) }
  if (endNode.in !== undefined) split[endIndex] = { ...endNode, in: handleFrom(end, lastControl) }
  return [...split.slice(0, segmentIndex + 1), added, ...split.slice(segmentIndex + 1)]
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
    const reach = hasStrokes && shape.stroke !== undefined ? strokeReach(shape, shape.stroke) : 0
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

export type SetPose = {
  set: NodeSet
  rotation: number
  scale: number
  x: number
  y: number
  carried: ReadonlySet<string>
}

export const REST_SCALE = 1

export function keyedValueAt(keyframes: readonly Keyframe[] | undefined, local: number, restValue = 0): number {
  if (keyframes === undefined) return restValue
  return valueAt(keyframes, local) ?? restValue
}

// Each set with itself and every set below it, at any depth.
export function carriedSetIds(sets: readonly NodeSet[] | undefined): Map<string, Set<string>> {
  const carried = new Map<string, Set<string>>()
  for (const set of sets ?? []) carried.set(set.id, new Set([set.id]))
  const parents = new Map(sets?.map((set) => [set.id, set.parent]))
  for (const set of sets ?? []) {
    let parent = set.parent
    while (parent !== undefined) {
      carried.get(parent)?.add(set.id)
      parent = parents.get(parent)
    }
  }
  return carried
}

function depthOf(set: NodeSet, carried: ReadonlyMap<string, ReadonlySet<string>>): number {
  let depth = 0
  for (const below of carried.values()) {
    if (below.has(set.id)) depth++
  }
  return depth
}

// Children come before their parents, so a parent turns its children where they already are; otherwise list order.
export function setPosesAt(sets: readonly NodeSet[] | undefined, local: number): SetPose[] {
  const carried = carriedSetIds(sets)
  const poses: SetPose[] = []
  for (const set of sets ?? []) {
    const keyframes = set.keyframes
    const rotation = keyedValueAt(keyframes?.rotation, local)
    const scale = keyedValueAt(keyframes?.scale, local, REST_SCALE)
    poses.push({ set, rotation, scale, x: keyedValueAt(keyframes?.x, local), y: keyedValueAt(keyframes?.y, local), carried: carried.get(set.id) ?? new Set([set.id]) })
  }
  const depths = new Map(poses.map((pose) => [pose.set.id, depthOf(pose.set, carried)]))
  return poses.sort((a, b) => (depths.get(b.set.id) ?? 0) - (depths.get(a.set.id) ?? 0))
}

// Degrees, clockwise on screen, where y grows downwards.
export function turned(point: Point, degrees: number): Point {
  if (degrees === 0) return point
  const angle = degrees * DEGREES_TO_RADIANS
  const cosine = Math.cos(angle)
  const sine = Math.sin(angle)
  return { x: point.x * cosine - point.y * sine, y: point.x * sine + point.y * cosine }
}

// A node moves with its own sets and the sets its shape follows, and with every parent of those.
function isMovedBy(node: ShapeNode, followed: readonly string[], pose: SetPose): boolean {
  for (const setId of node.sets ?? []) {
    if (pose.carried.has(setId)) return true
  }
  for (const setId of followed) {
    if (pose.carried.has(setId)) return true
  }
  return false
}

export type TurnAndScale = {
  rotation: number
  scale: number
}

export const NO_TURN_OR_SCALE: TurnAndScale = { rotation: 0, scale: REST_SCALE }

export function turnAndScaleOf(node: ShapeNode, poses: readonly SetPose[], followed: readonly string[]): TurnAndScale {
  let { rotation, scale } = NO_TURN_OR_SCALE
  for (const pose of poses) {
    if (!isMovedBy(node, followed, pose)) continue
    rotation += pose.rotation
    scale *= pose.scale
  }
  return { rotation, scale }
}

function turnedAndScaled(vector: Point, change: TurnAndScale): Point {
  return turned({ x: vector.x * change.scale, y: vector.y * change.scale }, change.rotation)
}

export function unturnedAndUnscaled(vector: Point, change: TurnAndScale): Point {
  const unturned = turned(vector, -change.rotation)
  return { x: unturned.x / change.scale, y: unturned.y / change.scale }
}

// The node's own offset first, then every set moving it in pose order, each scaling and turning around its pivot and then moving.
export function posedNode(node: ShapeNode, poses: readonly SetPose[], local: number, followed: readonly string[]): ShapeNode {
  let x = node.x + keyedValueAt(node.keyframes?.x, local)
  let y = node.y + keyedValueAt(node.keyframes?.y, local)
  for (const pose of poses) {
    if (!isMovedBy(node, followed, pose)) continue
    const { pivot } = pose.set
    const around = turnedAndScaled({ x: x - pivot.x, y: y - pivot.y }, pose)
    x = pivot.x + around.x + pose.x
    y = pivot.y + around.y + pose.y
  }
  const posed: ShapeNode = { x, y }
  const change = turnAndScaleOf(node, poses, followed)
  if (node.in !== undefined) posed.in = turnedAndScaled(node.in, change)
  if (node.out !== undefined) posed.out = turnedAndScaled(node.out, change)
  return posed
}

function isPosable(shapes: readonly DrawingShape[]): boolean {
  for (const shape of shapes) {
    if (shape.follows !== undefined) return true
    if (shape.nodes.some((node) => node.keyframes !== undefined || node.sets !== undefined)) return true
    if (shape.children !== undefined && isPosable(shape.children)) return true
  }
  return false
}

export function followedBy(shape: DrawingShape, followedAbove: readonly string[]): readonly string[] {
  if (shape.follows === undefined) return followedAbove
  return [...followedAbove, shape.follows]
}

// A stroke that scales with the object grows with the sets the shape follows; sets holding single nodes bend the outline instead.
function posedStroke(stroke: ShapeStroke | undefined, poses: readonly SetPose[], followed: readonly string[]): ShapeStroke | undefined {
  if (stroke?.scalesWithObject !== true || followed.length === 0) return stroke
  const { scale } = turnAndScaleOf({ x: 0, y: 0 }, poses, followed)
  return scale === REST_SCALE ? stroke : { ...stroke, width: stroke.width * scale }
}

function posedList(shapes: readonly DrawingShape[], poses: readonly SetPose[], local: number, followedAbove: readonly string[]): DrawingShape[] {
  return shapes.map((shape) => {
    const followed = followedBy(shape, followedAbove)
    const posed: DrawingShape = { ...shape, nodes: shape.nodes.map((node) => posedNode(node, poses, local, followed)) }
    const stroke = posedStroke(shape.stroke, poses, followed)
    if (stroke !== undefined) posed.stroke = stroke
    if (shape.children !== undefined) posed.children = posedList(shape.children, poses, local, followed)
    return posed
  })
}

// A drawing without keys, sets or followers keeps its own list, so its raster stays cached.
export function posedShapes(clip: DrawingClip, local: number): DrawingShape[] {
  if (!isPosable(clip.shapes)) return clip.shapes
  return posedList(clip.shapes, setPosesAt(clip.nodeSets, local), local, [])
}
