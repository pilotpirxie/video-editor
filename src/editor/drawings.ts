import {
  MAX_SHAPE_DEPTH,
  MIN_SHAPE_NODES,
  type DrawingClip,
  type DrawingShape,
  type Easing,
  type Keyframe,
  type NodeSet,
  type NodeSetKeyframes,
  type Project,
  type ShapeNode,
  type ShapeStroke,
  type StrokeAlign,
  type StrokeCap,
  type StrokeJoin,
  type Swatch,
  type Track,
  type Transform,
} from '../shared/project.js'
import { TICKS_PER_SECOND, TIMELINE_GRID, frameAt, frameDuration } from '../shared/time.js'
import {
  NO_TURN_OR_SCALE,
  REST_SCALE,
  carriedSetIds,
  followedBy,
  keyedValueAt,
  posedNode,
  posedShapes,
  setPosesAt,
  shapesBounds,
  splitSegment,
  turnAndScaleOf,
  unturnedAndUnscaled,
  type SetPose,
  type TurnAndScale,
} from '../engine/curves.js'
import { canvasPointToClip, clipPointToCanvas, type Point } from './annotations.js'
import { coversTime, editClips, endOf, locateClip, mapClipsDeep, nextTrackName, placeOnTrack, type NewTrack } from './clips.js'
import { shiftLater } from './moveTrim.js'
import { easingIn, keyTimeIn, localGridTime, withKeyframeAt, type ClipKeyTimes, type KeyframeLists } from './properties.js'
import type { Bounds } from './snapping.js'

// Four bezier quarters with handles this share of the radius long are closest to a circle.
const CIRCLE_HANDLE = 0.5523
// Handles turned further than a degree from pointing straight away from each other make a corner.
const SMOOTH_TOLERANCE = Math.sin(Math.PI / 180)
// A new smooth handle reaches a third of the way to the neighbouring node.
const HANDLE_SHARE = 1 / 3

// The colours and stroke new shapes get; a link to a swatch is kept only where the file has that swatch.
export type ShapeStyle = {
  fill: string
  fillSwatch?: string
  stroke?: ShapeStroke
}

export type ColorPart = 'fill' | 'stroke'

export const NEW_STROKE: ShapeStroke = { color: '#000000', width: 4, scalesWithObject: true }
export const NEW_SHAPE_STYLE: ShapeStyle = { fill: '#FFFFFF', stroke: NEW_STROKE }
export const MIN_STROKE_WIDTH = 0.1

export type StrokeChange = {
  width?: number
  isDashed?: boolean
  cap?: StrokeCap
  join?: StrokeJoin
  align?: StrokeAlign
  isBehind?: boolean
  scalesWithObject?: boolean
}

export type ShapeDrop = 'front' | 'behind' | 'inside'

export type ShapeRef = {
  clipId: string
  shapeId: string
}

export type NodeRef = ShapeRef & {
  index: number
}

export type NodeType = 'sharp' | 'smooth'
export type HandleSide = 'in' | 'out'

export function dragBox(from: Point, to: Point, isEven: boolean): Bounds {
  let across = to.x - from.x
  let down = to.y - from.y
  if (isEven) {
    const side = Math.max(Math.abs(across), Math.abs(down))
    across = across < 0 ? -side : side
    down = down < 0 ? -side : side
  }
  return { left: Math.min(from.x, from.x + across), top: Math.min(from.y, from.y + down), right: Math.max(from.x, from.x + across), bottom: Math.max(from.y, from.y + down) }
}

function painted(shape: DrawingShape, style: ShapeStyle): DrawingShape {
  const result: DrawingShape = { ...shape, fill: style.fill }
  if (style.fillSwatch !== undefined) result.fillSwatch = style.fillSwatch
  if (style.stroke !== undefined) result.stroke = style.stroke
  return result
}

export function rectangleShape(id: string, box: Bounds, style: ShapeStyle): DrawingShape {
  const { left, top, right, bottom } = box
  const nodes = [{ x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom }]
  return painted({ id, name: 'Rectangle', nodes, isClosed: true }, style)
}

export function ellipseShape(id: string, box: Bounds, style: ShapeStyle): DrawingShape {
  const middleX = (box.left + box.right) / 2
  const middleY = (box.top + box.bottom) / 2
  const handleX = ((box.right - box.left) / 2) * CIRCLE_HANDLE
  const handleY = ((box.bottom - box.top) / 2) * CIRCLE_HANDLE
  const nodes: ShapeNode[] = [
    { x: middleX, y: box.top, in: { x: -handleX, y: 0 }, out: { x: handleX, y: 0 } },
    { x: box.right, y: middleY, in: { x: 0, y: -handleY }, out: { x: 0, y: handleY } },
    { x: middleX, y: box.bottom, in: { x: handleX, y: 0 }, out: { x: -handleX, y: 0 } },
    { x: box.left, y: middleY, in: { x: 0, y: handleY }, out: { x: 0, y: -handleY } },
  ]
  return painted({ id, name: 'Ellipse', nodes, isClosed: true }, style)
}

// An open path takes the fill only when open paths are filled too.
export function pathShape(id: string, nodes: readonly ShapeNode[], isClosed: boolean, style: ShapeStyle, isFillingOpenPaths: boolean): DrawingShape {
  const path: DrawingShape = { id, name: 'Path', nodes: [...nodes] }
  if (isClosed) path.isClosed = true
  const shape = painted(path, style)
  if (isClosed || isFillingOpenPaths) return shape
  const { fill: _none, fillSwatch: _unlinked, ...unfilled } = shape
  return unfilled
}

function findShape(shapes: readonly DrawingShape[], shapeId: string): DrawingShape | undefined {
  for (const shape of shapes) {
    if (shape.id === shapeId) return shape
    const inside = shape.children === undefined ? undefined : findShape(shape.children, shapeId)
    if (inside !== undefined) return inside
  }
  return undefined
}

export function shapeAt(project: Project, shape: ShapeRef): DrawingShape | undefined {
  const clip = locateClip(project, shape.clipId)?.clip
  return clip?.type === 'drawing' ? findShape(clip.shapes, shape.shapeId) : undefined
}

// A hidden or locked shape takes its clipped children along.
export function pickableShape(shapes: readonly DrawingShape[], shapeId: string): DrawingShape | undefined {
  for (const shape of shapes) {
    if (shape.hidden === true || shape.locked === true) continue
    if (shape.id === shapeId) return shape
    const inside = shape.children === undefined ? undefined : pickableShape(shape.children, shapeId)
    if (inside !== undefined) return inside
  }
  return undefined
}

export type ShapeRow = {
  shape: DrawingShape
  depth: number
  isPickable: boolean
}

function addRows(shapes: readonly DrawingShape[], depth: number, isParentPickable: boolean, rows: ShapeRow[]): void {
  for (let index = shapes.length - 1; index >= 0; index--) {
    const shape = shapes[index]
    if (shape === undefined) continue
    const isPickable = isParentPickable && shape.hidden !== true && shape.locked !== true
    rows.push({ shape, depth, isPickable })
    if (shape.children !== undefined) addRows(shape.children, depth + 1, isPickable, rows)
  }
}

// Front to back, each shape followed by the shapes clipped inside it.
export function shapeRows(shapes: readonly DrawingShape[]): ShapeRow[] {
  const rows: ShapeRow[] = []
  addRows(shapes, 0, true, rows)
  return rows
}

export function drawingAt(track: Track, time: number): DrawingClip | undefined {
  return track.clips.find((clip): clip is DrawingClip => clip.type === 'drawing' && coversTime(clip, time))
}

// Tools act on the track of the selection, or on the top track when nothing is selected.
export function targetTrackIndex(project: Project, selection: readonly string[], selectedShapes: readonly ShapeRef[]): number {
  const clipId = selection[0] ?? selectedShapes[0]?.clipId
  const located = clipId === undefined ? undefined : locateClip(project, clipId)
  if (located !== undefined) return located.trackIndex
  return Math.max(0, project.tracks.length - 1)
}

export type DrawingPlace = {
  trackIndex: number
  time: number
  newDrawing: { clipId: string; duration: number; newTrack: NewTrack }
}

// New shapes go into the drawing under the playhead on the target track, or into a new one-second drawing there.
export function drawingPlace(project: Project, time: number, selection: readonly string[], selectedShapes: readonly ShapeRef[], newIds: { clipId: string; trackId: string }): DrawingPlace {
  const frameTicks = frameDuration(project.canvas.frameRate)
  const duration = Math.max(1, Math.round(TICKS_PER_SECOND / frameTicks)) * frameTicks
  return {
    trackIndex: targetTrackIndex(project, selection, selectedShapes),
    time: frameAt(time, frameTicks) * frameTicks,
    newDrawing: { clipId: newIds.clipId, duration, newTrack: { id: newIds.trackId, name: nextTrackName(project) } },
  }
}

// Node sets belong to their drawing, so shapes landing in another one leave theirs behind.
function withKnownSets(shape: DrawingShape, setIds: ReadonlySet<string>): DrawingShape {
  const nodes = shape.nodes.map((node) => {
    if (node.sets === undefined) return node
    const kept = node.sets.filter((setId) => setIds.has(setId))
    if (kept.length === node.sets.length) return node
    const { sets: _gone, ...unset } = node
    return kept.length === 0 ? unset : { ...unset, sets: kept }
  })
  const { follows, ownsSet: _owned, ...unfollowed } = shape
  const known: DrawingShape = follows === undefined || setIds.has(follows) ? { ...shape, nodes } : { ...unfollowed, nodes }
  if (shape.children !== undefined) known.children = shape.children.map((child) => withKnownSets(child, setIds))
  return known
}

function setIdsOf(clip: DrawingClip): Set<string> {
  return new Set(clip.nodeSets?.map((set) => set.id))
}

export function addDrawingShapes(project: Project, place: DrawingPlace, shapes: readonly DrawingShape[]): Project {
  const track = project.tracks[place.trackIndex]
  const isUsable = track !== undefined && !track.locked && !track.hidden
  const drawing = isUsable ? drawingAt(track, place.time) : undefined
  if (drawing !== undefined) {
    const known = shapes.map((shape) => withKnownSets(shape, setIdsOf(drawing)))
    return editClips(project, new Set([drawing.id]), () => ({ ...drawing, shapes: [...drawing.shapes, ...known] }))
  }

  const { clipId, duration, newTrack } = place.newDrawing
  const unset = shapes.map((shape) => withKnownSets(shape, new Set()))
  const clip: DrawingClip = { id: clipId, type: 'drawing', start: place.time, duration, shapes: unset }
  // A hidden track would hide what was just drawn, so the drawing goes above it.
  const trackIndex = track?.hidden === true ? place.trackIndex + 1 : place.trackIndex
  return placeOnTrack(project, { clips: [clip], trackIndex, newTrack })
}

export function shapeRefsOf(project: Project, shapeIds: readonly string[]): ShapeRef[] {
  const refs: ShapeRef[] = []
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (clip.type !== 'drawing') continue
      for (const shapeId of shapeIds) {
        if (findShape(clip.shapes, shapeId) !== undefined) refs.push({ clipId: clip.id, shapeId })
      }
    }
  }
  return refs
}

function shapeIdsByDrawing(shapes: readonly ShapeRef[]): Map<string, Set<string>> {
  const shapeIdsByClip = new Map<string, Set<string>>()
  for (const { clipId, shapeId } of shapes) {
    const shapeIds = shapeIdsByClip.get(clipId) ?? new Set<string>()
    shapeIds.add(shapeId)
    shapeIdsByClip.set(clipId, shapeIds)
  }
  return shapeIdsByClip
}

type DrawingEdit = (drawn: readonly DrawingShape[], shapeIds: ReadonlySet<string>, clipId: string) => DrawingShape[]

function editChosenDrawings(project: Project, shapes: readonly ShapeRef[], edit: (clip: DrawingClip, shapeIds: ReadonlySet<string>) => DrawingClip): Project {
  const shapeIdsByClip = shapeIdsByDrawing(shapes)
  return editClips(project, new Set(shapeIdsByClip.keys()), (clip) => {
    const shapeIds = shapeIdsByClip.get(clip.id)
    if (clip.type !== 'drawing' || shapeIds === undefined) return clip
    return edit(clip, shapeIds)
  })
}

function editDrawings(project: Project, shapes: readonly ShapeRef[], edit: DrawingEdit): Project {
  return editChosenDrawings(project, shapes, (clip, shapeIds) => ({ ...clip, shapes: edit(clip.shapes, shapeIds, clip.id) }))
}

// The parser refuses an empty list of clipped children, so an emptied list goes.
function withChildren(shape: DrawingShape, children: DrawingShape[]): DrawingShape {
  if (children.length > 0) return { ...shape, children }
  const { children: _removed, ...childless } = shape
  return childless
}

// Runs `edit` on every list of siblings, the inner ones first.
function editSiblings(shapes: readonly DrawingShape[], edit: (siblings: DrawingShape[]) => DrawingShape[]): DrawingShape[] {
  const siblings: DrawingShape[] = []
  for (const shape of shapes) {
    siblings.push(shape.children === undefined ? shape : withChildren(shape, editSiblings(shape.children, edit)))
  }
  return edit(siblings)
}

function editEachShape(project: Project, shapes: readonly ShapeRef[], change: (shape: DrawingShape) => DrawingShape): Project {
  return editDrawings(project, shapes, (drawn, shapeIds) => editSiblings(drawn, (siblings) => siblings.map((shape) => (shapeIds.has(shape.id) ? change(shape) : shape))))
}

function mappedPoint(point: Point, from: Transform, to: Transform): Point {
  return clipPointToCanvas(to, canvasPointToClip(from, point))
}

function mappedHandle(node: ShapeNode, handle: Point, moved: Point, from: Transform, to: Transform): Point {
  const end = mappedPoint({ x: node.x + handle.x, y: node.y + handle.y }, from, to)
  return { x: end.x - moved.x, y: end.y - moved.y }
}

// A stroke that scales with its shape grows by the geometric mean of how much the box grew across and down.
function strokeScale(from: Transform, to: Transform): number {
  const scale = Math.sqrt(Math.abs((to.scaleX * to.scaleY) / (from.scaleX * from.scaleY)))
  return Number.isFinite(scale) ? scale : 1
}

function mappedVector(vector: Point, from: Transform, to: Transform): Point {
  const origin = mappedPoint({ x: 0, y: 0 }, from, to)
  const end = mappedPoint(vector, from, to)
  return { x: end.x - origin.x, y: end.y - origin.y }
}

// Offset keys are moves, so they scale and turn with the shapes but don't travel with them.
function mappedOffsets(keyframes: NodeSetKeyframes, from: Transform, to: Transform): NodeSetKeyframes {
  const { x: across, y: down } = keyframes
  const mapped: NodeSetKeyframes = { ...keyframes }
  if (across !== undefined) mapped.x = across.map((keyframe) => ({ ...keyframe, value: mappedVector({ x: keyframe.value, y: keyedValueAt(down, keyframe.time) }, from, to).x }))
  if (down !== undefined) mapped.y = down.map((keyframe) => ({ ...keyframe, value: mappedVector({ x: keyedValueAt(across, keyframe.time), y: keyframe.value }, from, to).y }))
  return mapped
}

function transformedShape(shape: DrawingShape, from: Transform, to: Transform): DrawingShape {
  const nodes = shape.nodes.map((node) => {
    const moved = mappedPoint(node, from, to)
    const mapped: ShapeNode = { ...node, x: moved.x, y: moved.y }
    if (node.in !== undefined) mapped.in = mappedHandle(node, node.in, moved, from, to)
    if (node.out !== undefined) mapped.out = mappedHandle(node, node.out, moved, from, to)
    if (node.keyframes !== undefined) mapped.keyframes = mappedOffsets(node.keyframes, from, to)
    return mapped
  })
  const transformed = { ...shape, nodes }
  const { stroke } = shape
  if (stroke?.scalesWithObject === true) {
    const width = Math.max(MIN_STROKE_WIDTH, stroke.width * strokeScale(from, to))
    transformed.stroke = { ...stroke, width }
  }
  if (shape.children !== undefined) transformed.children = shape.children.map((child) => transformedShape(child, from, to))
  return transformed
}

// A chosen shape takes its clipped children along, so a child chosen with its parent moves once.
function withShapesTransformed(shapes: readonly DrawingShape[], shapeIds: ReadonlySet<string>, from: Transform, to: Transform): DrawingShape[] {
  return shapes.map((shape) => {
    if (shapeIds.has(shape.id)) return transformedShape(shape, from, to)
    if (shape.children === undefined) return shape
    return { ...shape, children: withShapesTransformed(shape.children, shapeIds, from, to) }
  })
}

function addSetIds(shapes: readonly DrawingShape[], shapeIds: ReadonlySet<string>, isInsideMoved: boolean, moved: Set<string>, still: Set<string>): void {
  for (const shape of shapes) {
    const isMoved = isInsideMoved || shapeIds.has(shape.id)
    for (const node of shape.nodes) {
      for (const setId of node.sets ?? []) (isMoved ? moved : still).add(setId)
    }
    if (isMoved && shape.ownsSet === true && shape.follows !== undefined) moved.add(shape.follows)
    addSetIds(shape.children ?? [], shapeIds, isMoved, moved, still)
  }
}

// A set goes along only when every node it holds does.
function setsMovedWhole(shapes: readonly DrawingShape[], shapeIds: ReadonlySet<string>): Set<string> {
  const moved = new Set<string>()
  const still = new Set<string>()
  addSetIds(shapes, shapeIds, false, moved, still)
  for (const setId of still) moved.delete(setId)
  return moved
}

function transformedSet(set: NodeSet, from: Transform, to: Transform): NodeSet {
  const transformed = { ...set, pivot: mappedPoint(set.pivot, from, to) }
  if (set.keyframes !== undefined) transformed.keyframes = mappedOffsets(set.keyframes, from, to)
  return transformed
}

function withPlacesTransformed(clip: DrawingClip, shapeIds: ReadonlySet<string>, from: Transform, to: Transform): DrawingClip {
  if (shapeIds.size === 0) return clip
  const transformed: DrawingClip = { ...clip, shapes: withShapesTransformed(clip.shapes, shapeIds, from, to) }
  const carried = setsMovedWhole(clip.shapes, shapeIds)
  if (clip.nodeSets !== undefined && carried.size > 0) transformed.nodeSets = clip.nodeSets.map((set) => (carried.has(set.id) ? transformedSet(set, from, to) : set))
  return transformed
}

function addTopShapeIds(shapes: readonly DrawingShape[], shapeIds: ReadonlySet<string>, top: DrawingShape[]): void {
  for (const shape of shapes) {
    if (shapeIds.has(shape.id)) top.push(shape)
    else addTopShapeIds(shape.children ?? [], shapeIds, top)
  }
}

const NO_CHANGE = 1e-9

// The set turns and scales as the box does, and moves so its pivot shows where the box takes it.
function boxPose(clip: DrawingClip, setId: string, from: Transform, to: Transform, local: number): SetValues {
  const pose = setPoseAt(clip, setId, local)
  const shownBefore = shownPivot(clip, setId, local)
  if (pose === undefined || shownBefore === undefined) return {}
  const values: SetValues = {}
  const turn = to.rotation - from.rotation
  if (Math.abs(turn) > NO_CHANGE) values.rotation = pose.rotation + turn
  const growth = to.scaleX / from.scaleX
  if (Math.abs(growth - 1) > NO_CHANGE) values.scale = pose.scale * growth
  const shownAfter = mappedPoint(shownBefore, from, to)
  const shift = unturnedAndUnscaled({ x: shownAfter.x - shownBefore.x, y: shownAfter.y - shownBefore.y }, turnAndScaleAboveSet(clip, setId, local))
  if (Math.hypot(shift.x, shift.y) > NO_CHANGE) {
    values.x = pose.x + shift.x
    values.y = pose.y + shift.y
  }
  return values
}

// Every point goes where `to` puts the place it had in `from`, so the box around the shapes moves, scales and turns them. A keyed shape records it as keys on its own set; any other shape changes its place, with its node sets.
export function transformShapes(project: Project, shapes: readonly ShapeRef[], from: Transform, to: Transform, time: number): Project {
  const frameTicks = frameDuration(project.canvas.frameRate)
  return editChosenDrawings(project, shapes, (clip, shapeIds) => {
    const top: DrawingShape[] = []
    addTopShapeIds(clip.shapes, shapeIds, top)
    const placed = new Set<string>()
    const keyedSetIds: string[] = []
    for (const shape of top) {
      const own = ownSetOf(clip, shape)
      if (own === undefined) placed.add(shape.id)
      else keyedSetIds.push(own.id)
    }
    const local = localGridTime(clip, time)
    const posedValues = new Map(keyedSetIds.map((setId) => [setId, boxPose(clip, setId, from, to, local)]))
    const transformed = withPlacesTransformed(clip, placed, from, to)
    if (posedValues.size === 0 || transformed.nodeSets === undefined) return transformed
    const nodeSets = transformed.nodeSets.map((set) => {
      const values = posedValues.get(set.id)
      return values === undefined ? set : withPoseKeyed(set, values, local, frameTicks)
    })
    return { ...transformed, nodeSets }
  })
}

export function setShapeFlag(project: Project, shape: ShapeRef, flag: 'hidden' | 'locked', isOn: boolean): Project {
  return editEachShape(project, [shape], (chosen) => {
    if (isOn) return flag === 'hidden' ? { ...chosen, hidden: true } : { ...chosen, locked: true }
    if (flag === 'hidden') {
      const { hidden: _hidden, ...shown } = chosen
      return shown
    }
    const { locked: _locked, ...unlocked } = chosen
    return unlocked
  })
}

export function renameShape(project: Project, shape: ShapeRef, name: string): Project {
  const trimmed = name.trim()
  if (trimmed === '') return project
  return editEachShape(project, [shape], (chosen) => ({ ...chosen, name: trimmed }))
}

// Without a stroke yet, the stroke starts as the one new shapes get.
function coloredStroke(stroke: ShapeStroke | undefined, color: string, swatchId: string | undefined): ShapeStroke {
  const { swatch: _unlinked, ...unlinkedStroke } = stroke ?? NEW_STROKE
  return swatchId === undefined ? { ...unlinkedStroke, color } : { ...unlinkedStroke, color, swatch: swatchId }
}

export function styleWithColor(style: ShapeStyle, part: ColorPart, color: string, swatchId?: string): ShapeStyle {
  if (part === 'stroke') return { ...style, stroke: coloredStroke(style.stroke, color, swatchId) }
  const { fillSwatch: _unlinked, ...filled } = style
  return swatchId === undefined ? { ...filled, fill: color } : { ...filled, fill: color, fillSwatch: swatchId }
}

// A colour of its own unlinks the shape from its swatch.
export function setShapeColor(project: Project, shapes: readonly ShapeRef[], part: ColorPart, color: string, swatchId?: string): Project {
  return editEachShape(project, shapes, (chosen) => {
    if (part === 'stroke') return { ...chosen, stroke: coloredStroke(chosen.stroke, color, swatchId) }
    const { fillSwatch: _unlinked, ...filled } = chosen
    return swatchId === undefined ? { ...filled, fill: color } : { ...filled, fill: color, fillSwatch: swatchId }
  })
}

function withSwitch(stroke: ShapeStroke, key: 'isDashed' | 'isBehind' | 'scalesWithObject', isOn: boolean | undefined): ShapeStroke {
  if (isOn === undefined) return stroke
  if (isOn) return { ...stroke, [key]: true }
  const { [key]: _off, ...switchedOff } = stroke
  return switchedOff
}

// The file leaves a switch out rather than storing false.
export function strokeWith(stroke: ShapeStroke, change: StrokeChange): ShapeStroke {
  const { isDashed, isBehind, scalesWithObject, ...values } = change
  let changed: ShapeStroke = { ...stroke, ...values }
  changed = withSwitch(changed, 'isDashed', isDashed)
  changed = withSwitch(changed, 'isBehind', isBehind)
  return withSwitch(changed, 'scalesWithObject', scalesWithObject)
}

// A shape without a stroke starts from `base`.
export function setShapeStroke(project: Project, shapes: readonly ShapeRef[], change: StrokeChange | 'none', base: ShapeStroke): Project {
  return editEachShape(project, shapes, (chosen) => {
    if (change !== 'none') return { ...chosen, stroke: strokeWith(chosen.stroke ?? base, change) }
    const { stroke: _removed, ...unstroked } = chosen
    return unstroked
  })
}

function depthOf(shapes: readonly DrawingShape[], shapeId: string, depth: number): number | undefined {
  for (const shape of shapes) {
    if (shape.id === shapeId) return depth
    const inside = shape.children === undefined ? undefined : depthOf(shape.children, shapeId, depth + 1)
    if (inside !== undefined) return inside
  }
  return undefined
}

function levelsBelow(shape: DrawingShape): number {
  let levels = 0
  for (const child of shape.children ?? []) levels = Math.max(levels, 1 + levelsBelow(child))
  return levels
}

// A shape cannot go into itself or a shape clipped inside it, nor deeper than the file allows.
export function canDropShape(shapes: readonly DrawingShape[], movingId: string, targetId: string, drop: ShapeDrop): boolean {
  const moving = findShape(shapes, movingId)
  const targetDepth = depthOf(shapes, targetId, 0)
  if (moving === undefined || targetDepth === undefined || movingId === targetId) return false
  if (findShape(moving.children ?? [], targetId) !== undefined) return false
  const depth = drop === 'inside' ? targetDepth + 1 : targetDepth
  return depth + levelsBelow(moving) <= MAX_SHAPE_DEPTH
}

function placedShape(siblings: DrawingShape[], moving: DrawingShape, targetId: string, drop: ShapeDrop): DrawingShape[] {
  const index = siblings.findIndex((sibling) => sibling.id === targetId)
  const target = siblings[index]
  if (target === undefined) return siblings
  if (drop === 'inside') {
    const holder = { ...target, children: [...(target.children ?? []), moving] }
    return siblings.map((sibling) => (sibling === target ? holder : sibling))
  }
  const at = drop === 'front' ? index + 1 : index
  return [...siblings.slice(0, at), moving, ...siblings.slice(at)]
}

// Shapes are listed back to front, so in front of the target is right after it, and inside it is in front of its other children.
export function moveShape(project: Project, shape: ShapeRef, targetId: string, drop: ShapeDrop): Project {
  const clip = locateClip(project, shape.clipId)?.clip
  const moving = shapeAt(project, shape)
  if (clip?.type !== 'drawing' || moving === undefined || !canDropShape(clip.shapes, shape.shapeId, targetId, drop)) return project
  return editDrawings(project, [shape], (drawn) => {
    const without = editSiblings(drawn, (siblings) => siblings.filter((sibling) => sibling.id !== shape.shapeId))
    return editSiblings(without, (siblings) => placedShape(siblings, moving, targetId, drop))
  })
}

export type ArrangePlace = 'forward' | 'backward' | 'front' | 'back'

// Chosen siblings keep their order among themselves; shapes are listed back to front.
function arranged(siblings: DrawingShape[], shapeIds: ReadonlySet<string>, place: ArrangePlace): DrawingShape[] {
  if (place === 'front' || place === 'back') {
    const chosen = siblings.filter((shape) => shapeIds.has(shape.id))
    const others = siblings.filter((shape) => !shapeIds.has(shape.id))
    return place === 'front' ? [...others, ...chosen] : [...chosen, ...others]
  }
  const moved = [...siblings]
  const isForward = place === 'forward'
  const step = isForward ? -1 : 1
  for (let index = isForward ? moved.length - 2 : 1; index >= 0 && index < moved.length; index += step) {
    const shape = moved[index]
    const neighbour = moved[index - step]
    if (shape === undefined || neighbour === undefined || !shapeIds.has(shape.id) || shapeIds.has(neighbour.id)) continue
    moved[index] = neighbour
    moved[index - step] = shape
  }
  return moved
}

export function arrangeShapes(project: Project, shapes: readonly ShapeRef[], place: ArrangePlace): Project {
  return editDrawings(project, shapes, (drawn, shapeIds) => editSiblings(drawn, (siblings) => arranged(siblings, shapeIds, place)))
}

export function deleteShapes(project: Project, shapes: readonly ShapeRef[]): Project {
  return editDrawings(project, shapes, (drawn, shapeIds) => editSiblings(drawn, (siblings) => siblings.filter((shape) => !shapeIds.has(shape.id))))
}

// Shape ids are unique only within their drawing.
function shapeKey(clipId: string, shapeId: string): string {
  return `${clipId}/${shapeId}`
}

type ShapeNodesEdit = (shape: DrawingShape, indexes: ReadonlySet<number>, clipId: string) => DrawingShape[]

// Runs `edit` on every shape holding chosen nodes; it returns what takes the shape's place.
function editNodeShapes(project: Project, nodes: readonly NodeRef[], edit: ShapeNodesEdit): Project {
  const indexesByShape = new Map<string, Set<number>>()
  for (const { clipId, shapeId, index } of nodes) {
    const key = shapeKey(clipId, shapeId)
    const indexes = indexesByShape.get(key) ?? new Set<number>()
    indexes.add(index)
    indexesByShape.set(key, indexes)
  }
  return editDrawings(project, nodes, (drawn, _shapeIds, clipId) =>
    editSiblings(drawn, (siblings) => {
      const edited: DrawingShape[] = []
      for (const shape of siblings) {
        const indexes = indexesByShape.get(shapeKey(clipId, shape.id))
        if (indexes === undefined) edited.push(shape)
        else edited.push(...edit(shape, indexes, clipId))
      }
      return edited
    }),
  )
}

type NodeChange = (node: ShapeNode, index: number, shape: DrawingShape, clipId: string) => ShapeNode

function editChosenNodes(project: Project, nodes: readonly NodeRef[], change: NodeChange): Project {
  return editNodeShapes(project, nodes, (shape, indexes, clipId) => [{ ...shape, nodes: shape.nodes.map((node, index) => (indexes.has(index) ? change(node, index, shape, clipId) : node)) }])
}

// The playhead inside a drawing, where node edits read and record keys.
type Moment = {
  local: number
  frameTicks: number
  poses: readonly SetPose[]
  followedByShape: ReadonlyMap<string, readonly string[]>
}

function addFollowed(shapes: readonly DrawingShape[], followedAbove: readonly string[], followedByShape: Map<string, readonly string[]>): void {
  for (const shape of shapes) {
    const followed = followedBy(shape, followedAbove)
    followedByShape.set(shape.id, followed)
    addFollowed(shape.children ?? [], followed, followedByShape)
  }
}

// What each shape follows, itself or through a shape it is clipped inside.
export function followedSetIds(clip: DrawingClip): Map<string, readonly string[]> {
  const followedByShape = new Map<string, readonly string[]>()
  addFollowed(clip.shapes, [], followedByShape)
  return followedByShape
}

function followedIn(moment: Moment, shape: DrawingShape): readonly string[] {
  return moment.followedByShape.get(shape.id) ?? []
}

function momentsOf(project: Project, refs: readonly ShapeRef[], time: number): Map<string, Moment> {
  const frameTicks = frameDuration(project.canvas.frameRate)
  const moments = new Map<string, Moment>()
  for (const { clipId } of refs) {
    const clip = locateClip(project, clipId)?.clip
    if (clip?.type !== 'drawing' || moments.has(clipId)) continue
    const local = localGridTime(clip, time)
    moments.set(clipId, { local, frameTicks, poses: setPosesAt(clip.nodeSets, local), followedByShape: followedSetIds(clip) })
  }
  return moments
}

function editNodesAt(project: Project, nodes: readonly NodeRef[], time: number, change: (node: ShapeNode, moment: Moment, index: number, shape: DrawingShape) => ShapeNode): Project {
  const moments = momentsOf(project, nodes, time)
  return editChosenNodes(project, nodes, (node, index, shape, clipId) => {
    const moment = moments.get(clipId)
    return moment === undefined ? node : change(node, moment, index, shape)
  })
}

function offsetListsOf(node: ShapeNode): KeyframeLists {
  return [node.keyframes?.x, node.keyframes?.y]
}

// A keyed node records the move as offset keys at the playhead; any other node moves its place.
function withOwnMove(node: ShapeNode, own: Point, moment: Moment): ShapeNode {
  if (own.x === 0 && own.y === 0) return node
  const { keyframes } = node
  if (keyframes === undefined) return { ...node, x: node.x + own.x, y: node.y + own.y }
  const lists = offsetListsOf(node)
  const keyTime = keyTimeIn(lists, moment.local, moment.frameTicks)
  const easing = easingIn(lists, keyTime)
  const x = withKeyframeAt(keyframes.x ?? [], keyTime, keyedValueAt(keyframes.x, keyTime) + own.x, easing)
  const y = withKeyframeAt(keyframes.y ?? [], keyTime, keyedValueAt(keyframes.y, keyTime) + own.y, easing)
  return { ...node, keyframes: { x, y } }
}

// A move on screen is turned and scaled back through the node sets moving the node.
function withScreenMove(node: ShapeNode, delta: Point, moment: Moment, followed: readonly string[]): ShapeNode {
  return withOwnMove(node, unturnedAndUnscaled(delta, turnAndScaleOf(node, moment.poses, followed)), moment)
}

function lengthOf(handle: Point): number {
  return Math.hypot(handle.x, handle.y)
}

export function nodeTypeOf(node: ShapeNode): NodeType {
  const { in: before, out: after } = node
  if (before === undefined || after === undefined) return 'sharp'
  const lengths = lengthOf(before) * lengthOf(after)
  const cross = before.x * after.y - before.y * after.x
  const dot = before.x * after.x + before.y * after.y
  return lengths > 0 && dot < 0 && Math.abs(cross) <= SMOOTH_TOLERANCE * lengths ? 'smooth' : 'sharp'
}

// The time is the playhead of the open tracks; the delta is on screen, in the artboard's pixels.
export function moveNodes(project: Project, nodes: readonly NodeRef[], delta: Point, time: number): Project {
  return editNodesAt(project, nodes, time, (node, moment, _index, shape) => withScreenMove(node, delta, moment, followedIn(moment, shape)))
}

// The value is where the node shows at the playhead.
export function setNodePosition(project: Project, nodes: readonly NodeRef[], axis: 'x' | 'y', value: number, time: number): Project {
  return editNodesAt(project, nodes, time, (node, moment, _index, shape) => {
    const followed = followedIn(moment, shape)
    const shown = posedNode(node, moment.poses, moment.local, followed)
    const delta = axis === 'x' ? { x: value - shown.x, y: 0 } : { x: 0, y: value - shown.y }
    return withScreenMove(node, delta, moment, followed)
  })
}

// The moving nodes are left out, or a dragged node would catch itself.
export function nodePointsOf(clipId: string, shapes: readonly DrawingShape[], moving: readonly NodeRef[]): Point[] {
  const points: Point[] = []
  for (const shape of shapes) {
    for (const [index, node] of shape.nodes.entries()) {
      const isMoving = moving.some((ref) => ref.clipId === clipId && ref.shapeId === shape.id && ref.index === index)
      if (!isMoving) points.push({ x: node.x, y: node.y })
    }
    points.push(...nodePointsOf(clipId, shape.children ?? [], moving))
  }
  return points
}

// A smooth node turns its other handle to stay in line, keeping that handle's length; a broken drag moves only one.
export function moveHandle(project: Project, node: NodeRef, side: HandleSide, handle: Point, isBroken: boolean, time: number): Project {
  return editNodesAt(project, [node], time, (chosen, moment, _index, shape) => {
    const placed = unturnedAndUnscaled(handle, turnAndScaleOf(chosen, moment.poses, followedIn(moment, shape)))
    const moved: ShapeNode = side === 'in' ? { ...chosen, in: placed } : { ...chosen, out: placed }
    const otherSide = side === 'in' ? 'out' : 'in'
    const other = chosen[otherSide]
    const length = lengthOf(placed)
    if (isBroken || other === undefined || length === 0 || nodeTypeOf(chosen) !== 'smooth') return moved
    const otherLength = lengthOf(other)
    moved[otherSide] = { x: (-placed.x / length) * otherLength, y: (-placed.y / length) * otherLength }
    return moved
  })
}

// An open path's end has one neighbour, so it stands in for the missing one.
function neighboursOf(shape: DrawingShape, index: number): { previous: ShapeNode; next: ShapeNode } | undefined {
  const { nodes } = shape
  const node = nodes[index]
  if (node === undefined) return undefined
  const isClosed = shape.isClosed === true
  const previous = index > 0 || isClosed ? nodes[(index - 1 + nodes.length) % nodes.length] : node
  const next = index < nodes.length - 1 || isClosed ? nodes[(index + 1) % nodes.length] : node
  return { previous: previous ?? node, next: next ?? node }
}

function withHandlesAlong(node: ShapeNode, direction: Point, beforeLength: number, afterLength: number): ShapeNode {
  const length = lengthOf(direction)
  if (length === 0) return node
  const across = direction.x / length
  const down = direction.y / length
  return { ...node, in: { x: -across * beforeLength, y: -down * beforeLength }, out: { x: across * afterLength, y: down * afterLength } }
}

function smoothNode(node: ShapeNode, index: number, shape: DrawingShape): ShapeNode {
  const { in: before, out: after } = node
  if (before !== undefined && after !== undefined) return withHandlesAlong(node, { x: after.x - before.x, y: after.y - before.y }, lengthOf(before), lengthOf(after))
  const neighbours = neighboursOf(shape, index)
  if (neighbours === undefined) return node
  const { previous, next } = neighbours
  let beforeLength = Math.hypot(node.x - previous.x, node.y - previous.y) * HANDLE_SHARE
  let afterLength = Math.hypot(next.x - node.x, next.y - node.y) * HANDLE_SHARE
  if (beforeLength === 0) beforeLength = afterLength
  if (afterLength === 0) afterLength = beforeLength
  return withHandlesAlong(node, { x: next.x - previous.x, y: next.y - previous.y }, beforeLength, afterLength)
}

// Sharp drops the handles; smooth lines up the ones there are, or makes them along the line through the neighbours.
export function setNodeType(project: Project, nodes: readonly NodeRef[], type: NodeType): Project {
  return editChosenNodes(project, nodes, (node, index, shape) => {
    if (type === 'smooth') return smoothNode(node, index, shape)
    const { in: _before, out: _after, ...sharp } = node
    return sharp
  })
}

function offsetAt(node: ShapeNode, local: number): ShapeNode {
  return { ...node, x: node.x + keyedValueAt(node.keyframes?.x, local), y: node.y + keyedValueAt(node.keyframes?.y, local) }
}

// At each key of its neighbours the new node takes the split point of the segment as they are offset there, so the outline keeps its animation.
function withKeysAlong(added: ShapeNode, shape: DrawingShape, segmentIndex: number, progress: number): ShapeNode {
  const endIndex = (segmentIndex + 1) % shape.nodes.length
  const start = shape.nodes[segmentIndex]
  const end = shape.nodes[endIndex]
  if (start === undefined || end === undefined) return added
  const lists = [...offsetListsOf(start), ...offsetListsOf(end)]
  const times: number[] = []
  keyTimesIn(lists, times)
  if (times.length === 0) return added
  const x: Keyframe[] = []
  const y: Keyframe[] = []
  times.sort((a, b) => a - b)
  for (const time of new Set(times)) {
    const offsetNodes = shape.nodes.with(segmentIndex, offsetAt(start, time)).with(endIndex, offsetAt(end, time))
    const split = splitSegment({ ...shape, nodes: offsetNodes }, segmentIndex, progress)[segmentIndex + 1]
    if (split === undefined) continue
    const easing = easingIn(lists, time)
    x.push({ time, value: split.x - added.x, easing })
    y.push({ time, value: split.y - added.y, easing })
  }
  return { ...added, keyframes: { x, y } }
}

// The new node joins the sets both its neighbours are in, so it turns with them and stays on the curve.
export function insertNode(project: Project, shape: ShapeRef, segmentIndex: number, progress: number): Project {
  return editEachShape(project, [shape], (chosen) => {
    const nodes = splitSegment(chosen, segmentIndex, progress)
    const split = nodes[segmentIndex + 1]
    if (split === undefined || nodes.length === chosen.nodes.length) return chosen
    const after = nodes[(segmentIndex + 2) % nodes.length]
    const shared = nodes[segmentIndex]?.sets?.filter((setId) => after?.sets?.includes(setId) === true) ?? []
    const added = withKeysAlong(shared.length === 0 ? split : { ...split, sets: shared }, chosen, segmentIndex, progress)
    return { ...chosen, nodes: nodes.with(segmentIndex + 1, added) }
  })
}

// A shape left with too few nodes goes, with the shapes clipped inside it.
export function deleteNodes(project: Project, nodes: readonly NodeRef[]): Project {
  return editNodeShapes(project, nodes, (shape, indexes) => {
    const kept = shape.nodes.filter((_node, index) => !indexes.has(index))
    return kept.length < MIN_SHAPE_NODES ? [] : [{ ...shape, nodes: kept }]
  })
}

export function closePaths(project: Project, shapes: readonly ShapeRef[]): Project {
  return editEachShape(project, shapes, (chosen) => (chosen.isClosed === true ? chosen : { ...chosen, isClosed: true }))
}

// A closed path opens at its first chosen node, which then ends it too; the open path is cut at every chosen node inside it.
function brokenRuns(shape: DrawingShape, indexes: ReadonlySet<number>): ShapeNode[][] {
  const chosen = [...indexes].sort((a, b) => a - b)
  const first = chosen[0]
  let nodes = shape.nodes
  let cuts = chosen
  if (shape.isClosed === true && first !== undefined) {
    const opened = [...nodes.slice(first), ...nodes.slice(0, first)]
    nodes = [...opened, ...opened.slice(0, 1)]
    cuts = chosen.slice(1).map((index) => index - first)
  }
  const runs: ShapeNode[][] = []
  let runStart = 0
  for (const cut of cuts) {
    if (cut <= runStart || cut >= nodes.length - 1) continue
    runs.push(nodes.slice(runStart, cut + 1))
    runStart = cut
  }
  runs.push(nodes.slice(runStart))
  return runs
}

// The first part keeps the shape and what is clipped inside it; the later parts go right in front of it.
export function breakPaths(project: Project, nodes: readonly NodeRef[], newId: () => string): Project {
  return editNodeShapes(project, nodes, (shape, indexes) => {
    const [firstRun = shape.nodes, ...laterRuns] = brokenRuns(shape, indexes)
    if (shape.isClosed !== true && laterRuns.length === 0) return [shape]
    const { isClosed: _opened, ...open } = shape
    const { children: _kept, ownsSet: _owned, ...childless } = open
    const parts: DrawingShape[] = [{ ...open, nodes: firstRun }]
    for (const run of laterRuns) parts.push({ ...childless, id: newId(), nodes: run })
    return parts
  })
}

export type CopiedShape = {
  ref: ShapeRef
  shape: DrawingShape
}

// A chosen shape is copied with its clipped children, so a child chosen with its parent is copied once.
function addCopies(clipId: string, shapes: readonly DrawingShape[], shapeIds: ReadonlySet<string>, copies: CopiedShape[]): void {
  for (const shape of shapes) {
    if (shapeIds.has(shape.id)) copies.push({ ref: { clipId, shapeId: shape.id }, shape })
    else if (shape.children !== undefined) addCopies(clipId, shape.children, shapeIds, copies)
  }
}

export function copyShapes(project: Project, shapes: readonly ShapeRef[]): CopiedShape[] {
  const copies: CopiedShape[] = []
  for (const [clipId, shapeIds] of shapeIdsByDrawing(shapes)) {
    const clip = locateClip(project, clipId)?.clip
    if (clip?.type === 'drawing') addCopies(clipId, clip.shapes, shapeIds, copies)
  }
  return copies
}

// A copy follows what its original follows but owns no set, as a set has one owner.
export function withNewShapeIds(shape: DrawingShape, newId: () => string): DrawingShape {
  const { ownsSet: _owned, ...copied } = shape
  const renamed: DrawingShape = { ...copied, id: newId() }
  if (shape.children !== undefined) renamed.children = shape.children.map((child) => withNewShapeIds(child, newId))
  return renamed
}

// Each copy goes right in front of the shape it was made from.
export function addShapesAbove(project: Project, copies: readonly CopiedShape[]): Project {
  const copyOf = new Map<string, DrawingShape>()
  for (const { ref, shape } of copies) copyOf.set(shapeKey(ref.clipId, ref.shapeId), shape)
  const refs = copies.map((copied) => copied.ref)
  return editDrawings(project, refs, (drawn, _shapeIds, clipId) =>
    editSiblings(drawn, (siblings) => {
      const withCopies: DrawingShape[] = []
      for (const shape of siblings) {
        withCopies.push(shape)
        const copy = copyOf.get(shapeKey(clipId, shape.id))
        if (copy !== undefined) withCopies.push(copy)
      }
      return withCopies
    }),
  )
}

// The copy goes right after the drawing, and every later clip on its track moves later to make room.
export function duplicateDrawing(project: Project, clipId: string, copyId: string): Project {
  const located = locateClip(project, clipId)
  if (located === undefined || located.clip.type !== 'drawing' || located.track.locked) return project
  const { clip, track } = located
  const end = endOf(clip)
  const shifted = shiftLater(project, track, end, clip.duration, clip.id)
  const copy: DrawingClip = { ...clip, id: copyId, start: end }
  const tracks = shifted.tracks.map((shiftedTrack) => {
    if (shiftedTrack.id !== track.id) return shiftedTrack
    return { ...shiftedTrack, clips: [...shiftedTrack.clips, copy] }
  })
  return { ...shifted, tracks }
}

function swatchIn(swatches: readonly Swatch[] | undefined, swatchId: string | undefined): Swatch | undefined {
  if (swatchId === undefined) return undefined
  return swatches?.find((swatch) => swatch.id === swatchId)
}

// A link survives only into a file that has the swatch, and then takes the swatch's colour.
export function styleIn(style: ShapeStyle, swatches: readonly Swatch[] | undefined): ShapeStyle {
  const fillSwatch = swatchIn(swatches, style.fillSwatch)
  const resolved: ShapeStyle = { fill: fillSwatch?.color ?? style.fill }
  if (fillSwatch !== undefined) resolved.fillSwatch = fillSwatch.id
  if (style.stroke === undefined) return resolved
  const { swatch: _link, ...stroke } = style.stroke
  const strokeSwatch = swatchIn(swatches, style.stroke.swatch)
  resolved.stroke = strokeSwatch === undefined ? stroke : { ...stroke, color: strokeSwatch.color, swatch: strokeSwatch.id }
  return resolved
}

function unlinked(shape: DrawingShape, isKept: (swatchId: string) => boolean): DrawingShape {
  let kept = shape
  if (kept.fillSwatch !== undefined && !isKept(kept.fillSwatch)) {
    const { fillSwatch: _gone, ...rest } = kept
    kept = rest
  }
  if (kept.stroke?.swatch !== undefined && !isKept(kept.stroke.swatch)) {
    const { swatch: _gone, ...stroke } = kept.stroke
    kept = { ...kept, stroke }
  }
  return kept
}

// Pasted into another animation, a shape keeps its colours but not its links to swatches that file lacks.
export function withKnownSwatches(shape: DrawingShape, swatches: readonly Swatch[] | undefined): DrawingShape {
  const known = new Set(swatches?.map((swatch) => swatch.id))
  const [kept] = editSiblings([shape], (siblings) => siblings.map((sibling) => unlinked(sibling, (swatchId) => known.has(swatchId))))
  return kept ?? shape
}

// Every shape in every drawing of the file, groups included.
function withEveryShape(project: Project, change: (shape: DrawingShape) => DrawingShape): Project {
  const tracks = mapClipsDeep(project.tracks, (clip) => {
    if (clip.type !== 'drawing') return clip
    return { ...clip, shapes: editSiblings(clip.shapes, (siblings) => siblings.map(change)) }
  })
  return { ...project, tracks }
}

function nextNumberedName(named: readonly { name: string }[] | undefined, word: string): string {
  const names = new Set(named?.map((item) => item.name))
  let number = names.size + 1
  while (names.has(`${word} ${number}`)) number += 1
  return `${word} ${number}`
}

export function nextSwatchName(swatches: readonly Swatch[] | undefined): string {
  return nextNumberedName(swatches, 'Colour')
}

export function addSwatch(project: Project, swatch: Swatch): Project {
  return { ...project, swatches: [...(project.swatches ?? []), swatch] }
}

export function renameSwatch(project: Project, swatchId: string, name: string): Project {
  const trimmed = name.trim()
  if (trimmed === '' || project.swatches === undefined) return project
  return { ...project, swatches: project.swatches.map((swatch) => (swatch.id === swatchId ? { ...swatch, name: trimmed } : swatch)) }
}

// Linked shapes keep the swatch's hex beside the link, so every one of them is rewritten.
export function setSwatchColor(project: Project, swatchId: string, color: string): Project {
  if (project.swatches === undefined) return project
  const swatches = project.swatches.map((swatch) => (swatch.id === swatchId ? { ...swatch, color } : swatch))
  const recolored = withEveryShape(project, (shape) => {
    let changed = shape
    if (changed.fillSwatch === swatchId) changed = { ...changed, fill: color }
    if (changed.stroke?.swatch === swatchId) changed = { ...changed, stroke: { ...changed.stroke, color } }
    return changed
  })
  return { ...recolored, swatches }
}

// Shapes keep the swatch's last colour as their own.
export function deleteSwatch(project: Project, swatchId: string): Project {
  const unlinkedProject = withEveryShape(project, (shape) => unlinked(shape, (linkedId) => linkedId !== swatchId))
  const swatches = project.swatches?.filter((swatch) => swatch.id !== swatchId) ?? []
  if (swatches.length > 0) return { ...unlinkedProject, swatches }
  const { swatches: _none, ...withoutSwatches } = unlinkedProject
  return withoutSwatches
}

export function posedShapeAt(project: Project, shape: ShapeRef, time: number): DrawingShape | undefined {
  const clip = locateClip(project, shape.clipId)?.clip
  if (clip?.type !== 'drawing') return undefined
  return findShape(posedShapes(clip, time - clip.start), shape.shapeId)
}

type KeyName = 'rotation' | 'scale' | 'x' | 'y'
const KEY_NAMES: readonly KeyName[] = ['rotation', 'scale', 'x', 'y']
type ListEdit = (list: readonly Keyframe[], name: KeyName) => readonly Keyframe[]

function withoutKeyAt(list: readonly Keyframe[], time: number): readonly Keyframe[] {
  return list.some((keyframe) => keyframe.time === time) ? list.filter((keyframe) => keyframe.time !== time) : list
}

// Edits only ever remove the keys of one moment, so a list left empty had just the one key, which `onEmptied` hears of.
function editedLists(keyframes: NodeSetKeyframes, edit: ListEdit, onEmptied?: (name: KeyName, removed: Keyframe) => void): NodeSetKeyframes | undefined {
  const kept: NodeSetKeyframes = {}
  let isChanged = false
  let hasLists = false
  for (const name of KEY_NAMES) {
    const list = keyframes[name]
    if (list === undefined) continue
    const edited = edit(list, name)
    if (edited !== list) isChanged = true
    const removed = list[0]
    if (edited.length === 0 && removed !== undefined) {
      onEmptied?.(name, removed)
      continue
    }
    kept[name] = [...edited]
    hasLists = true
  }
  if (!isChanged) return keyframes
  return hasLists ? kept : undefined
}

// Without its last key a node keeps that offset as its own place, as a clip keeps its last keyed value.
function withNodeLists(node: ShapeNode, edit: ListEdit): ShapeNode {
  if (node.keyframes === undefined) return node
  const place = { x: node.x, y: node.y }
  const kept = editedLists(node.keyframes, edit, (name, removed) => {
    if (name === 'x' || name === 'y') place[name] += removed.value
  })
  if (kept === node.keyframes) return node
  const { keyframes: _old, ...unkeyed } = node
  const edited: ShapeNode = { ...unkeyed, x: place.x, y: place.y }
  if (kept !== undefined) edited.keyframes = kept
  return edited
}

// A set has no resting place, so without keys it neither turns nor moves.
function withSetLists(set: NodeSet, edit: ListEdit): NodeSet {
  if (set.keyframes === undefined) return set
  const kept = editedLists(set.keyframes, edit)
  if (kept === set.keyframes) return set
  const { keyframes: _old, ...unkeyed } = set
  return kept === undefined ? unkeyed : { ...unkeyed, keyframes: kept }
}

function withOffsetKeysAt(node: ShapeNode, moment: Moment): ShapeNode {
  const lists = offsetListsOf(node)
  const keyTime = keyTimeIn(lists, moment.local, moment.frameTicks)
  const easing = easingIn(lists, keyTime)
  const x = withKeyframeAt(node.keyframes?.x ?? [], keyTime, keyedValueAt(node.keyframes?.x, keyTime), easing)
  const y = withKeyframeAt(node.keyframes?.y ?? [], keyTime, keyedValueAt(node.keyframes?.y, keyTime), easing)
  return { ...node, keyframes: { x, y } }
}

function withoutOffsetKeysAt(node: ShapeNode, moment: Moment): ShapeNode {
  const keyTime = keyTimeIn(offsetListsOf(node), moment.local, moment.frameTicks)
  return withNodeLists(node, (list) => withoutKeyAt(list, keyTime))
}

export function setNodeKeys(project: Project, nodes: readonly NodeRef[], time: number, isKeyed: boolean): Project {
  return editNodesAt(project, nodes, time, (node, moment) => (isKeyed ? withOffsetKeysAt(node, moment) : withoutOffsetKeysAt(node, moment)))
}

function isKeyedAt(lists: KeyframeLists, local: number, frameTicks: number): boolean {
  const keyTime = keyTimeIn(lists, local, frameTicks)
  return lists.every((list) => list?.some((keyframe) => keyframe.time === keyTime) === true)
}

export function hasNodeKeysAt(project: Project, nodes: readonly NodeRef[], time: number): boolean {
  if (nodes.length === 0) return false
  const moments = momentsOf(project, nodes, time)
  for (const ref of nodes) {
    const node = shapeAt(project, ref)?.nodes[ref.index]
    const moment = moments.get(ref.clipId)
    if (node === undefined || moment === undefined || !isKeyedAt(offsetListsOf(node), moment.local, moment.frameTicks)) return false
  }
  return true
}

function keyTimesIn(lists: KeyframeLists, times: number[]): void {
  for (const list of lists) {
    for (const keyframe of list ?? []) times.push(keyframe.time)
  }
}

function clipKeyTimes(project: Project, timesByClip: ReadonlyMap<string, number[]>): ClipKeyTimes[] {
  const entries: ClipKeyTimes[] = []
  for (const [clipId, times] of timesByClip) {
    const clip = locateClip(project, clipId)?.clip
    if (clip !== undefined) entries.push({ clip, times })
  }
  return entries
}

export function nodeKeyTimes(project: Project, nodes: readonly NodeRef[]): ClipKeyTimes[] {
  const timesByClip = new Map<string, number[]>()
  for (const ref of nodes) {
    const times = timesByClip.get(ref.clipId) ?? []
    const node = shapeAt(project, ref)?.nodes[ref.index]
    if (node !== undefined) keyTimesIn(offsetListsOf(node), times)
    timesByClip.set(ref.clipId, times)
  }
  return clipKeyTimes(project, timesByClip)
}

export type SetRef = {
  clipId: string
  setId: string
}

export type SetPart = 'rotation' | 'scale' | 'position'
const PART_KEYS = { rotation: ['rotation'], scale: ['scale'], position: ['x', 'y'] } as const satisfies Record<SetPart, readonly KeyName[]>

export type SetValues = {
  rotation?: number
  scale?: number
  x?: number
  y?: number
}

function editDrawing(project: Project, clipId: string, change: (clip: DrawingClip) => DrawingClip): Project {
  return editClips(project, new Set([clipId]), (clip) => (clip.type === 'drawing' ? change(clip) : clip))
}

function editSet(project: Project, ref: SetRef, change: (set: NodeSet, clip: DrawingClip) => NodeSet): Project {
  return editDrawing(project, ref.clipId, (clip) => {
    if (clip.nodeSets === undefined) return clip
    return { ...clip, nodeSets: clip.nodeSets.map((set) => (set.id === ref.setId ? change(set, clip) : set)) }
  })
}

function addSetNodes(clipId: string, shapes: readonly DrawingShape[], setId: string, nodes: NodeRef[]): void {
  for (const shape of shapes) {
    for (const [index, node] of shape.nodes.entries()) {
      if (node.sets?.includes(setId) === true) nodes.push({ clipId, shapeId: shape.id, index })
    }
    addSetNodes(clipId, shape.children ?? [], setId, nodes)
  }
}

export function nodesInSet(clip: DrawingClip, setId: string): NodeRef[] {
  const nodes: NodeRef[] = []
  addSetNodes(clip.id, clip.shapes, setId, nodes)
  return nodes
}

export function nodeSetOf(clip: DrawingClip, setId: string): NodeSet | undefined {
  return clip.nodeSets?.find((set) => set.id === setId)
}

export function setPoseAt(clip: DrawingClip, setId: string, local: number): SetPose | undefined {
  return setPosesAt(clip.nodeSets, local).find((pose) => pose.set.id === setId)
}

// The pivot moves with the set and its parents, so it shows where they put it.
export function shownPivot(clip: DrawingClip, setId: string, local: number): Point | undefined {
  const poses = setPosesAt(clip.nodeSets, local)
  const pose = poses.find((each) => each.set.id === setId)
  if (pose === undefined) return undefined
  const moved = { x: pose.set.pivot.x + pose.x, y: pose.set.pivot.y + pose.y }
  const { parent } = pose.set
  if (parent === undefined) return moved
  return posedNode({ ...moved, sets: [parent] }, poses, local, [])
}

// What the set's parents add to its own turn and scale on screen.
export function turnAndScaleAboveSet(clip: DrawingClip, setId: string, local: number): TurnAndScale {
  const parent = nodeSetOf(clip, setId)?.parent
  if (parent === undefined) return NO_TURN_OR_SCALE
  return turnAndScaleOf({ x: 0, y: 0, sets: [parent] }, setPosesAt(clip.nodeSets, local), [])
}

function addShapesMovedBy(shapes: readonly DrawingShape[], movedSetIds: ReadonlySet<string>, isFollowing: boolean, moved: Set<string>): void {
  for (const shape of shapes) {
    const isShapeFollowing = isFollowing || (shape.follows !== undefined && movedSetIds.has(shape.follows))
    const hasMovedNode = shape.nodes.some((node) => node.sets?.some((nodeSetId) => movedSetIds.has(nodeSetId)) === true)
    if (isShapeFollowing || hasMovedNode) moved.add(shape.id)
    addShapesMovedBy(shape.children ?? [], movedSetIds, isShapeFollowing, moved)
  }
}

// The shapes the set moves through their nodes or by following it or a set below it.
export function shapeIdsMovedBy(clip: DrawingClip, setId: string): Set<string> {
  const moved = new Set<string>()
  addShapesMovedBy(clip.shapes, carriedSetIds(clip.nodeSets).get(setId) ?? new Set(), false, moved)
  return moved
}

// The new set holds the chosen nodes, and its pivot starts in the middle of where they show.
export function addNodeSet(project: Project, nodes: readonly NodeRef[], setId: string, time: number): Project {
  const first = nodes[0]
  const clip = first === undefined ? undefined : locateClip(project, first.clipId)?.clip
  if (first === undefined || clip?.type !== 'drawing') return project
  const posed = posedShapes(clip, time - clip.start)
  const xs: number[] = []
  const ys: number[] = []
  for (const ref of nodes) {
    const node = findShape(posed, ref.shapeId)?.nodes[ref.index]
    if (node === undefined || ref.clipId !== clip.id) continue
    xs.push(node.x)
    ys.push(node.y)
  }
  if (xs.length === 0) return project
  const pivot = { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 }
  const set: NodeSet = { id: setId, name: nextNumberedName(clip.nodeSets, 'Set'), pivot }
  const withSet = editDrawing(project, clip.id, (drawing) => ({ ...drawing, nodeSets: [...(drawing.nodeSets ?? []), set] }))
  const inClip = nodes.filter((ref) => ref.clipId === clip.id)
  return editChosenNodes(withSet, inClip, (node) => ({ ...node, sets: [...(node.sets ?? []), setId] }))
}

export function renameNodeSet(project: Project, ref: SetRef, name: string): Project {
  const trimmed = name.trim()
  if (trimmed === '') return project
  return editSet(project, ref, (set) => ({ ...set, name: trimmed }))
}

function withParent(set: NodeSet, parentId: string | undefined): NodeSet {
  const { parent: _old, ...orphan } = set
  return parentId === undefined ? orphan : { ...orphan, parent: parentId }
}

// The deleted set's children take its parent, so the rest of the chain still carries them.
export function deleteNodeSet(project: Project, ref: SetRef): Project {
  return editDrawing(project, ref.clipId, (clip) => {
    const deleted = nodeSetOf(clip, ref.setId)
    const kept: NodeSet[] = []
    for (const set of clip.nodeSets ?? []) {
      if (set.id === ref.setId) continue
      kept.push(set.parent === ref.setId ? withParent(set, deleted?.parent) : set)
    }
    const { nodeSets: _old, ...unset } = clip
    const edited: DrawingClip = { ...unset, shapes: clip.shapes.map((shape) => withKnownSets(shape, new Set(kept.map((set) => set.id)))) }
    if (kept.length > 0) edited.nodeSets = kept
    return edited
  })
}

export function setNodeSetPivot(project: Project, ref: SetRef, pivot: Point): Project {
  return editSet(project, ref, (set) => ({ ...set, pivot: { x: pivot.x, y: pivot.y } }))
}

// A set can't sit below itself, so it and the sets it carries are left out.
export function parentChoices(clip: DrawingClip, setId: string): NodeSet[] {
  const carried = carriedSetIds(clip.nodeSets).get(setId) ?? new Set([setId])
  return clip.nodeSets?.filter((set) => !carried.has(set.id)) ?? []
}

export function setNodeSetParent(project: Project, ref: SetRef, parentId: string | undefined): Project {
  return editSet(project, ref, (set, clip) => {
    const isOffered = parentId === undefined || parentChoices(clip, set.id).some((choice) => choice.id === parentId)
    return isOffered ? withParent(set, parentId) : set
  })
}

function withFollow(shape: DrawingShape, setId: string | undefined): DrawingShape {
  const { follows: _old, ...unfollowed } = shape
  return setId === undefined ? unfollowed : { ...unfollowed, follows: setId }
}

// A keyed shape follows its own set, so what it follows is that set's parent.
export function followedSetOf(clip: DrawingClip, shape: DrawingShape): string | undefined {
  const own = ownSetOf(clip, shape)
  return own === undefined ? shape.follows : own.parent
}

// A keyed shape can't follow its own set or a set inside it.
export function followChoices(clip: DrawingClip, shapes: readonly DrawingShape[]): NodeSet[] {
  const carried = carriedSetIds(clip.nodeSets)
  const excluded = new Set<string>()
  for (const shape of shapes) {
    const own = ownSetOf(clip, shape)
    for (const setId of own === undefined ? [] : (carried.get(own.id) ?? [])) excluded.add(setId)
  }
  return clip.nodeSets?.filter((set) => !excluded.has(set.id)) ?? []
}

// Only sets of the shape's own drawing can be followed; a keyed shape's own set takes the new one as its parent.
export function setShapesFollow(project: Project, shapes: readonly ShapeRef[], setId: string | undefined): Project {
  let followed = project
  const unkeyed: ShapeRef[] = []
  for (const set of ownSetRefs(project, shapes)) followed = setNodeSetParent(followed, set, setId)
  for (const ref of shapes) {
    if (shapeAt(project, ref)?.ownsSet !== true) unkeyed.push(ref)
  }
  return editChosenDrawings(followed, unkeyed, (clip, shapeIds) => {
    if (setId !== undefined && nodeSetOf(clip, setId) === undefined) return clip
    return { ...clip, shapes: editSiblings(clip.shapes, (siblings) => siblings.map((shape) => (shapeIds.has(shape.id) ? withFollow(shape, setId) : shape))) }
  })
}

function restValueOf(name: KeyName): number {
  return name === 'scale' ? REST_SCALE : 0
}

function withPartKeyed(set: NodeSet, part: SetPart, local: number, frameTicks: number, values: SetValues): NodeSet {
  const names = PART_KEYS[part]
  const lists = names.map((name) => set.keyframes?.[name])
  const keyTime = keyTimeIn(lists, local, frameTicks)
  const easing = easingIn(lists, keyTime)
  const keyframes: NodeSetKeyframes = { ...set.keyframes }
  for (const name of names) {
    const value = values[name] ?? keyedValueAt(set.keyframes?.[name], keyTime, restValueOf(name))
    keyframes[name] = withKeyframeAt(set.keyframes?.[name] ?? [], keyTime, value, easing)
  }
  return { ...set, keyframes }
}

function withPoseKeyed(set: NodeSet, values: SetValues, local: number, frameTicks: number): NodeSet {
  let posed = set
  if (values.rotation !== undefined) posed = withPartKeyed(posed, 'rotation', local, frameTicks, values)
  if (values.scale !== undefined) posed = withPartKeyed(posed, 'scale', local, frameTicks, values)
  if (values.x !== undefined || values.y !== undefined) posed = withPartKeyed(posed, 'position', local, frameTicks, values)
  return posed
}

// A set has no resting place, so turning, scaling or moving it always records keys at the playhead: rotation and scale alone, x and y together.
export function setNodeSetPose(project: Project, ref: SetRef, values: SetValues, time: number): Project {
  const frameTicks = frameDuration(project.canvas.frameRate)
  return editSet(project, ref, (set, clip) => withPoseKeyed(set, values, localGridTime(clip, time), frameTicks))
}

export function setNodeSetKeys(project: Project, ref: SetRef, part: SetPart, time: number, isKeyed: boolean): Project {
  const frameTicks = frameDuration(project.canvas.frameRate)
  return editSet(project, ref, (set, clip) => {
    const local = localGridTime(clip, time)
    if (isKeyed) return withPartKeyed(set, part, local, frameTicks, {})
    const names: readonly KeyName[] = PART_KEYS[part]
    const keyTime = keyTimeIn(names.map((name) => set.keyframes?.[name]), local, frameTicks)
    return withSetLists(set, (list, name) => (names.includes(name) ? withoutKeyAt(list, keyTime) : list))
  })
}

function hasSetKeyAt(project: Project, ref: SetRef, part: SetPart, time: number): boolean {
  const clip = locateClip(project, ref.clipId)?.clip
  const set = clip?.type === 'drawing' ? nodeSetOf(clip, ref.setId) : undefined
  if (clip === undefined || set === undefined) return false
  const lists = PART_KEYS[part].map((name) => set.keyframes?.[name])
  return isKeyedAt(lists, localGridTime(clip, time), frameDuration(project.canvas.frameRate))
}

export function hasSetKeysAt(project: Project, sets: readonly SetRef[], part: SetPart, time: number): boolean {
  return sets.length > 0 && sets.every((ref) => hasSetKeyAt(project, ref, part, time))
}

function addSetKeyTimes(project: Project, sets: readonly SetRef[], part: SetPart, timesByClip: Map<string, number[]>): void {
  for (const ref of sets) {
    const clip = locateClip(project, ref.clipId)?.clip
    const set = clip?.type === 'drawing' ? nodeSetOf(clip, ref.setId) : undefined
    const times = timesByClip.get(ref.clipId) ?? []
    if (set !== undefined) keyTimesIn(PART_KEYS[part].map((name) => set.keyframes?.[name]), times)
    timesByClip.set(ref.clipId, times)
  }
}

export function setKeyTimes(project: Project, sets: readonly SetRef[], part: SetPart): ClipKeyTimes[] {
  const timesByClip = new Map<string, number[]>()
  addSetKeyTimes(project, sets, part, timesByClip)
  return clipKeyTimes(project, timesByClip)
}

function ownSetOf(clip: DrawingClip, shape: DrawingShape): NodeSet | undefined {
  if (shape.ownsSet !== true || shape.follows === undefined) return undefined
  return nodeSetOf(clip, shape.follows)
}

function ownSetRefs(project: Project, shapes: readonly ShapeRef[]): SetRef[] {
  const refs: SetRef[] = []
  for (const ref of shapes) {
    const shape = shapeAt(project, ref)
    if (shape?.ownsSet === true && shape.follows !== undefined) refs.push({ clipId: ref.clipId, setId: shape.follows })
  }
  return refs
}

// Where a point shown at `shown` sits before the given sets move it; the sets turn, scale and move evenly, so one step back is enough.
function restPlace(shown: Point, setIds: readonly string[], poses: readonly SetPose[]): Point {
  if (setIds.length === 0) return shown
  const moved = posedNode({ ...shown, sets: [...setIds] }, poses, 0, [])
  const back = unturnedAndUnscaled({ x: shown.x - moved.x, y: shown.y - moved.y }, turnAndScaleOf({ x: 0, y: 0, sets: [...setIds] }, poses, []))
  return { x: shown.x + back.x, y: shown.y + back.y }
}

function ownSetFor(shape: DrawingShape, posed: DrawingShape | undefined, followed: readonly string[], poses: readonly SetPose[], setId: string): NodeSet | undefined {
  const bounds = posed === undefined ? undefined : shapesBounds([posed], false)
  if (bounds === undefined) return undefined
  const parent = followed.at(-1)
  const parentChain = parent === undefined ? [] : [parent]
  const pivot = restPlace({ x: (bounds.left + bounds.right) / 2, y: (bounds.top + bounds.bottom) / 2 }, parentChain, poses)
  const set: NodeSet = { id: setId, name: shape.name ?? 'Shape', pivot }
  if (parent !== undefined) set.parent = parent
  return set
}

// A keyed shape follows a set of its own, named after it, turning around its middle at the playhead and sitting inside the set it followed closest.
function withOwnSets(project: Project, shapes: readonly ShapeRef[], time: number, newId: () => string): Project {
  return editChosenDrawings(project, shapes, (clip, shapeIds) => {
    const local = time - clip.start
    const posed = posedShapes(clip, local)
    const poses = setPosesAt(clip.nodeSets, local)
    const followedByShape = followedSetIds(clip)
    const added: NodeSet[] = []
    const owners = new Map<string, string>()
    for (const shapeId of shapeIds) {
      const shape = findShape(clip.shapes, shapeId)
      if (shape === undefined || shape.ownsSet === true) continue
      const set = ownSetFor(shape, findShape(posed, shapeId), followedByShape.get(shapeId) ?? [], poses, newId())
      if (set === undefined) continue
      added.push(set)
      owners.set(shapeId, set.id)
    }
    if (added.length === 0) return clip
    const owned = editSiblings(clip.shapes, (siblings) =>
      siblings.map((shape) => {
        const setId = owners.get(shape.id)
        return setId === undefined ? shape : { ...shape, follows: setId, ownsSet: true }
      }),
    )
    return { ...clip, shapes: owned, nodeSets: [...(clip.nodeSets ?? []), ...added] }
  })
}

export type ShapePose = {
  rotation: number
  scale: number
  x: number
  y: number
}

const REST_POSE: ShapePose = { rotation: 0, scale: REST_SCALE, x: 0, y: 0 }

export function shapePoseAt(project: Project, ref: ShapeRef, time: number): ShapePose {
  const clip = locateClip(project, ref.clipId)?.clip
  const shape = shapeAt(project, ref)
  const own = clip?.type === 'drawing' && shape !== undefined ? ownSetOf(clip, shape) : undefined
  const pose = clip === undefined || own === undefined || clip.type !== 'drawing' ? undefined : setPoseAt(clip, own.id, time - clip.start)
  if (pose === undefined) return REST_POSE
  return { rotation: pose.rotation, scale: pose.scale, x: pose.x, y: pose.y }
}

// Typed values always key, as a set has no resting place.
export function setShapesPose(project: Project, shapes: readonly ShapeRef[], values: SetValues, time: number, newId: () => string): Project {
  const owned = withOwnSets(project, shapes, time, newId)
  let posed = owned
  for (const set of ownSetRefs(owned, shapes)) posed = setNodeSetPose(posed, set, values, time)
  return posed
}

export function setShapesKeys(project: Project, shapes: readonly ShapeRef[], part: SetPart, time: number, isKeyed: boolean, newId: () => string): Project {
  const owned = isKeyed ? withOwnSets(project, shapes, time, newId) : project
  let keyed = owned
  for (const set of ownSetRefs(owned, shapes)) keyed = setNodeSetKeys(keyed, set, part, time, isKeyed)
  return keyed
}

export function hasShapeKeysAt(project: Project, shapes: readonly ShapeRef[], part: SetPart, time: number): boolean {
  const sets = ownSetRefs(project, shapes)
  return sets.length === shapes.length && hasSetKeysAt(project, sets, part, time)
}

// Every chosen shape's drawing is listed, so a shape without keys yet can take its first.
export function shapeKeyTimes(project: Project, shapes: readonly ShapeRef[], part: SetPart): ClipKeyTimes[] {
  const timesByClip = new Map<string, number[]>(shapes.map((ref) => [ref.clipId, []]))
  addSetKeyTimes(project, ownSetRefs(project, shapes), part, timesByClip)
  return clipKeyTimes(project, timesByClip)
}

// Without a shape, every key of the drawing; with one, its own nodes' keys and those of the sets holding any of them.
export type KeyScope = {
  clipId: string
  shapeId?: string
}

// The sets moving the shape: its nodes' sets, the sets it follows, and every parent of those.
function setIdsOfShape(clip: DrawingClip, shape: DrawingShape): Set<string> {
  const own = new Set(followedSetIds(clip).get(shape.id))
  for (const node of shape.nodes) {
    for (const setId of node.sets ?? []) own.add(setId)
  }
  const setIds = new Set<string>()
  for (const [setId, carried] of carriedSetIds(clip.nodeSets)) {
    for (const ownId of own) {
      if (carried.has(ownId)) setIds.add(setId)
    }
  }
  return setIds
}

type ScopeKeys = {
  shapes: readonly DrawingShape[]
  sets: readonly NodeSet[]
}

function addEveryShape(shapes: readonly DrawingShape[], every: DrawingShape[]): void {
  for (const shape of shapes) {
    every.push(shape)
    addEveryShape(shape.children ?? [], every)
  }
}

function keysIn(clip: DrawingClip, shapeId: string | undefined): ScopeKeys {
  if (shapeId === undefined) {
    const shapes: DrawingShape[] = []
    addEveryShape(clip.shapes, shapes)
    return { shapes, sets: clip.nodeSets ?? [] }
  }
  const shape = findShape(clip.shapes, shapeId)
  if (shape === undefined) return { shapes: [], sets: [] }
  const setIds = setIdsOfShape(clip, shape)
  return { shapes: [shape], sets: clip.nodeSets?.filter((set) => setIds.has(set.id)) ?? [] }
}

function addLists(keyframes: NodeSetKeyframes | undefined, lists: (readonly Keyframe[])[]): void {
  for (const name of KEY_NAMES) {
    const list = keyframes?.[name]
    if (list !== undefined) lists.push(list)
  }
}

function scopeLists(clip: DrawingClip, shapeId: string | undefined): (readonly Keyframe[])[] {
  const { shapes, sets } = keysIn(clip, shapeId)
  const lists: (readonly Keyframe[])[] = []
  for (const shape of shapes) {
    for (const node of shape.nodes) addLists(node.keyframes, lists)
  }
  for (const set of sets) addLists(set.keyframes, lists)
  return lists
}

export function drawingKeyTimes(clip: DrawingClip, shapeId?: string): number[] {
  const times = new Set<number>()
  for (const list of scopeLists(clip, shapeId)) {
    for (const keyframe of list) times.add(keyframe.time)
  }
  return [...times].sort((a, b) => a - b)
}

function withScopeKeys(clip: DrawingClip, shapeId: string | undefined, edit: ListEdit): DrawingClip {
  const { sets } = keysIn(clip, shapeId)
  const shapes = editSiblings(clip.shapes, (siblings) =>
    siblings.map((shape) => {
      if (shapeId !== undefined && shape.id !== shapeId) return shape
      return { ...shape, nodes: shape.nodes.map((node) => withNodeLists(node, edit)) }
    }),
  )
  const edited: DrawingClip = { ...clip, shapes }
  if (clip.nodeSets !== undefined) edited.nodeSets = clip.nodeSets.map((set) => (sets.includes(set) ? withSetLists(set, edit) : set))
  return edited
}

export function setKeysEasing(project: Project, scope: KeyScope, local: number, easing: Easing): Project {
  return editDrawing(project, scope.clipId, (clip) =>
    withScopeKeys(clip, scope.shapeId, (list) => {
      const isChanged = list.some((keyframe) => keyframe.time === local && keyframe.easing !== easing)
      return isChanged ? list.map((keyframe) => (keyframe.time === local ? { ...keyframe, easing } : keyframe)) : list
    }),
  )
}

export function deleteKeysAt(project: Project, scope: KeyScope, local: number): Project {
  return editDrawing(project, scope.clipId, (clip) => withScopeKeys(clip, scope.shapeId, (list) => withoutKeyAt(list, local)))
}

// Keys stay inside the drawing and in their order: they stop a grid step short of the next key of any list they are in.
export function moveKeysAt(project: Project, scope: KeyScope, from: number, to: number): Project {
  return editDrawing(project, scope.clipId, (clip) => {
    let earliest = 0
    let latest = clip.duration
    for (const list of scopeLists(clip, scope.shapeId)) {
      if (!list.some((keyframe) => keyframe.time === from)) continue
      for (const keyframe of list) {
        if (keyframe.time < from) earliest = Math.max(earliest, keyframe.time + TIMELINE_GRID)
        if (keyframe.time > from) latest = Math.min(latest, keyframe.time - TIMELINE_GRID)
      }
    }
    const target = Math.min(latest, Math.max(earliest, Math.round(to / TIMELINE_GRID) * TIMELINE_GRID))
    if (target === from) return clip
    return withScopeKeys(clip, scope.shapeId, (list) => {
      if (!list.some((keyframe) => keyframe.time === from)) return list
      return list.map((keyframe) => (keyframe.time === from ? { ...keyframe, time: target } : keyframe)).sort((a, b) => a.time - b.time)
    })
  })
}

type KeyCopy = {
  value: number
  easing: Easing
}

type KeyCopies = {
  rotation?: KeyCopy
  scale?: KeyCopy
  x?: KeyCopy
  y?: KeyCopy
}

type CopiedNodeKeys = KeyCopies & {
  shapeId: string
  index: number
}

type CopiedSetKeys = KeyCopies & {
  setId: string
}

export type CopiedKeys = {
  nodes: CopiedNodeKeys[]
  sets: CopiedSetKeys[]
}

function copiesAt(keyframes: NodeSetKeyframes | undefined, local: number): KeyCopies | undefined {
  const copies: KeyCopies = {}
  let hasCopies = false
  for (const name of KEY_NAMES) {
    const keyframe = keyframes?.[name]?.find((each) => each.time === local)
    if (keyframe === undefined) continue
    copies[name] = { value: keyframe.value, easing: keyframe.easing }
    hasCopies = true
  }
  return hasCopies ? copies : undefined
}

export function copyKeysAt(clip: DrawingClip, shapeId: string | undefined, local: number): CopiedKeys {
  const { shapes, sets } = keysIn(clip, shapeId)
  const copied: CopiedKeys = { nodes: [], sets: [] }
  for (const shape of shapes) {
    for (const [index, node] of shape.nodes.entries()) {
      const copies = copiesAt(node.keyframes, local)
      if (copies !== undefined) copied.nodes.push({ ...copies, shapeId: shape.id, index })
    }
  }
  for (const set of sets) {
    const copies = copiesAt(set.keyframes, local)
    if (copies !== undefined) copied.sets.push({ ...copies, setId: set.id })
  }
  return copied
}

function withPastedKeys(keyframes: NodeSetKeyframes | undefined, copies: KeyCopies, local: number, frameTicks: number): NodeSetKeyframes {
  const names = KEY_NAMES.filter((name) => copies[name] !== undefined)
  const keyTime = keyTimeIn(names.map((name) => keyframes?.[name]), local, frameTicks)
  const pasted: NodeSetKeyframes = { ...keyframes }
  for (const name of names) {
    const copy = copies[name]
    if (copy === undefined) continue
    const others = (keyframes?.[name] ?? []).filter((keyframe) => keyframe.time !== keyTime)
    pasted[name] = withKeyframeAt(others, keyTime, copy.value, copy.easing)
  }
  return pasted
}

// Keys land on the nodes and sets of the drawing that match what was copied, at the playhead.
export function pasteKeys(project: Project, clipId: string, copied: CopiedKeys, time: number): Project {
  const frameTicks = frameDuration(project.canvas.frameRate)
  return editDrawing(project, clipId, (clip) => {
    const local = localGridTime(clip, time)
    const nodeCopies = new Map(copied.nodes.map((entry) => [`${entry.shapeId}/${entry.index}`, entry]))
    const shapes = editSiblings(clip.shapes, (siblings) =>
      siblings.map((shape) => {
        const nodes = shape.nodes.map((node, index) => {
          const copies = nodeCopies.get(`${shape.id}/${index}`)
          return copies === undefined ? node : { ...node, keyframes: withPastedKeys(node.keyframes, copies, local, frameTicks) }
        })
        return { ...shape, nodes }
      }),
    )
    const pasted: DrawingClip = { ...clip, shapes }
    if (clip.nodeSets !== undefined) {
      pasted.nodeSets = clip.nodeSets.map((set) => {
        const copies = copied.sets.find((entry) => entry.setId === set.id)
        return copies === undefined ? set : { ...set, keyframes: withPastedKeys(set.keyframes, copies, local, frameTicks) }
      })
    }
    return pasted
  })
}
