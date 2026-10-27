import {
  MAX_SHAPE_DEPTH,
  type DrawingClip,
  type DrawingShape,
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
import { TICKS_PER_SECOND, frameAt, frameDuration } from '../shared/time.js'
import { canvasPointToClip, clipPointToCanvas, type Point } from './annotations.js'
import { coversTime, editClips, endOf, locateClip, mapClipsDeep, nextTrackName, placeOnTrack, type NewTrack } from './clips.js'
import { shiftLater } from './moveTrim.js'
import type { Bounds } from './snapping.js'

// Four bezier quarters with handles this share of the radius long are closest to a circle.
const CIRCLE_HANDLE = 0.5523

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

// A stroke that scales with its shape grows by the geometric mean of how much the box grew across and down.
function strokeScale(from: Transform, to: Transform): number {
  const scale = Math.sqrt(Math.abs((to.scaleX * to.scaleY) / (from.scaleX * from.scaleY)))
  return Number.isFinite(scale) ? scale : 1
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
  const { stroke } = shape
  if (stroke?.scalesWithObject === true) transformed.stroke = { ...stroke, width: Math.max(MIN_STROKE_WIDTH, stroke.width * strokeScale(from, to)) }
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

// Without a stroke yet, the stroke starts as the one new shapes get.
function coloredStroke(stroke: ShapeStroke | undefined, color: string, swatchId: string | undefined): ShapeStroke {
  const { swatch: _unlinked, ...unlinkedStroke } = stroke ?? NEW_STROKE
  return swatchId === undefined ? { ...unlinkedStroke, color } : { ...unlinkedStroke, color, swatch: swatchId }
}

function coloredShape(shape: DrawingShape, part: ColorPart, color: string, swatchId: string | undefined): DrawingShape {
  if (part === 'stroke') return { ...shape, stroke: coloredStroke(shape.stroke, color, swatchId) }
  const { fillSwatch: _unlinked, ...filled } = shape
  return swatchId === undefined ? { ...filled, fill: color } : { ...filled, fill: color, fillSwatch: swatchId }
}

export function styleWithColor(style: ShapeStyle, part: ColorPart, color: string, swatchId?: string): ShapeStyle {
  if (part === 'stroke') return { ...style, stroke: coloredStroke(style.stroke, color, swatchId) }
  const { fillSwatch: _unlinked, ...filled } = style
  return swatchId === undefined ? { ...filled, fill: color } : { ...filled, fill: color, fillSwatch: swatchId }
}

// A colour of its own unlinks the shape from its swatch.
export function setShapeColor(project: Project, shapes: readonly ShapeRef[], part: ColorPart, color: string, swatchId?: string): Project {
  return editEachShape(project, shapes, (chosen) => coloredShape(chosen, part, color, swatchId))
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
  if (drop === 'inside') return siblings.map((sibling) => (sibling === target ? { ...target, children: [...(target.children ?? []), moving] } : sibling))
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

// The copy goes right after the drawing, and every later clip on its track moves later to make room.
export function duplicateDrawing(project: Project, clipId: string, copyId: string): Project {
  const located = locateClip(project, clipId)
  if (located === undefined || located.clip.type !== 'drawing' || located.track.locked) return project
  const { clip, track } = located
  const end = endOf(clip)
  const shifted = shiftLater(project, track, end, clip.duration, clip.id)
  const copy: DrawingClip = { ...clip, id: copyId, start: end }
  const tracks = shifted.tracks.map((each) => (each.id === track.id ? { ...each, clips: [...each.clips, copy] } : each))
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

export function nextSwatchName(swatches: readonly Swatch[] | undefined): string {
  const names = new Set(swatches?.map((swatch) => swatch.name))
  let number = names.size + 1
  while (names.has(`Colour ${number}`)) number += 1
  return `Colour ${number}`
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
