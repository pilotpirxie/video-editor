import type { DrawingClip, DrawingShape, Project, ShapeNode, ShapeStroke, Track, Transform } from '../shared/project.js'
import { TICKS_PER_SECOND, frameAt, frameDuration } from '../shared/time.js'
import { canvasPointToClip, clipPointToCanvas, type Point } from './annotations.js'
import { coversTime, editClips, locateClip, nextTrackName, placeOnTrack, type NewTrack } from './clips.js'
import type { Bounds } from './snapping.js'

// Four bezier quarters with handles this share of the radius long are closest to a circle.
const CIRCLE_HANDLE = 0.5523

export type ShapeStyle = {
  fill: string
  stroke: ShapeStroke
}

export type ColorPart = 'fill' | 'stroke'

export const NEW_SHAPE_STYLE: ShapeStyle = { fill: '#FFFFFF', stroke: { color: '#000000', width: 4 } }

export type ShapeRef = {
  clipId: string
  shapeId: string
}

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

export function rectangleShape(id: string, box: Bounds, style: ShapeStyle): DrawingShape {
  const { left, top, right, bottom } = box
  const nodes = [{ x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom }]
  return { id, name: 'Rectangle', nodes, isClosed: true, fill: style.fill, stroke: style.stroke }
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
  return { id, name: 'Ellipse', nodes, isClosed: true, fill: style.fill, stroke: style.stroke }
}

export function findShape(shapes: readonly DrawingShape[], shapeId: string): DrawingShape | undefined {
  for (const shape of shapes) {
    if (shape.id === shapeId) return shape
    const inside = shape.children === undefined ? undefined : findShape(shape.children, shapeId)
    if (inside !== undefined) return inside
  }
  return undefined
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

export function addDrawingShapes(project: Project, place: DrawingPlace, shapes: readonly DrawingShape[]): Project {
  const track = project.tracks[place.trackIndex]
  const isUsable = track !== undefined && !track.locked && !track.hidden
  const drawing = isUsable ? drawingAt(track, place.time) : undefined
  if (drawing !== undefined) return editClips(project, new Set([drawing.id]), () => ({ ...drawing, shapes: [...drawing.shapes, ...shapes] }))

  const { clipId, duration, newTrack } = place.newDrawing
  const clip: DrawingClip = { id: clipId, type: 'drawing', start: place.time, duration, shapes: [...shapes] }
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

function editDrawings(project: Project, shapes: readonly ShapeRef[], edit: DrawingEdit): Project {
  const shapeIdsByClip = shapeIdsByDrawing(shapes)
  return editClips(project, new Set(shapeIdsByClip.keys()), (clip) => {
    const shapeIds = shapeIdsByClip.get(clip.id)
    if (clip.type !== 'drawing' || shapeIds === undefined) return clip
    return { ...clip, shapes: edit(clip.shapes, shapeIds, clip.id) }
  })
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

function transformedShape(shape: DrawingShape, from: Transform, to: Transform): DrawingShape {
  const nodes = shape.nodes.map((node) => {
    const moved = mappedPoint(node, from, to)
    const mapped: ShapeNode = { x: moved.x, y: moved.y }
    if (node.in !== undefined) mapped.in = mappedHandle(node, node.in, moved, from, to)
    if (node.out !== undefined) mapped.out = mappedHandle(node, node.out, moved, from, to)
    return mapped
  })
  const transformed = { ...shape, nodes }
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

// Every point goes where `to` puts the place it had in `from`, so the box around the shapes moves, scales and turns them.
export function transformShapes(project: Project, shapes: readonly ShapeRef[], from: Transform, to: Transform): Project {
  return editDrawings(project, shapes, (drawn, shapeIds) => withShapesTransformed(drawn, shapeIds, from, to))
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

export function setShapeColor(project: Project, shapes: readonly ShapeRef[], part: ColorPart, color: string): Project {
  return editEachShape(project, shapes, (chosen) => {
    if (part === 'fill') return { ...chosen, fill: color }
    return { ...chosen, stroke: { color, width: chosen.stroke?.width ?? NEW_SHAPE_STYLE.stroke.width } }
  })
}

// The shape takes the place of the sibling at `targetShapeId`, or of the sibling that holds it.
export function reorderShape(project: Project, shape: ShapeRef, targetShapeId: string): Project {
  return editDrawings(project, [shape], (drawn) =>
    editSiblings(drawn, (siblings) => {
      const from = siblings.findIndex((sibling) => sibling.id === shape.shapeId)
      const to = siblings.findIndex((sibling) => sibling.id === targetShapeId || findShape(sibling.children ?? [], targetShapeId) !== undefined)
      const moving = siblings[from]
      if (moving === undefined || to < 0 || from === to) return siblings
      const reordered = siblings.filter((sibling) => sibling !== moving)
      reordered.splice(to, 0, moving)
      return reordered
    }),
  )
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

export function withNewShapeIds(shape: DrawingShape, newId: () => string): DrawingShape {
  const renamed = { ...shape, id: newId() }
  if (shape.children !== undefined) renamed.children = shape.children.map((child) => withNewShapeIds(child, newId))
  return renamed
}

// Each copy goes right in front of the shape it was made from.
export function addShapesAbove(project: Project, copies: readonly CopiedShape[]): Project {
  const copyOf = new Map<string, DrawingShape>()
  for (const { ref, shape } of copies) copyOf.set(`${ref.clipId}/${ref.shapeId}`, shape)
  const refs = copies.map((copied) => copied.ref)
  return editDrawings(project, refs, (drawn, _shapeIds, clipId) =>
    editSiblings(drawn, (siblings) => {
      const withCopies: DrawingShape[] = []
      for (const shape of siblings) {
        withCopies.push(shape)
        const copy = copyOf.get(`${clipId}/${shape.id}`)
        if (copy !== undefined) withCopies.push(copy)
      }
      return withCopies
    }),
  )
}
