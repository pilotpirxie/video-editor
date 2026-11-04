import { useEffect, useEffectEvent, useMemo, useRef, useState, type MouseEvent, type PointerEvent, type ReactElement, type RefObject } from 'react'
import { arrowBetween, arrowEnds, canvasPointToClip, clipPointToCanvas, setArrowStyle, setCalloutStyle } from '../editor/annotations.js'
import { frameOf, type ZoomFrame } from '../editor/camera.js'
import { isContainer, locateClip } from '../editor/clips.js'
import { hexOfChannels } from '../editor/colors.js'
import {
  addDrawingShapes,
  dragBox,
  drawingPlace,
  ellipseShape,
  followedSetIds,
  insertNode,
  moveHandle,
  moveNodes,
  nodePointsOf,
  nodeSetOf,
  pathShape,
  pickableShape,
  posedShapeAt,
  rectangleShape,
  setNodeSetPivot,
  setNodeSetPose,
  setPoseAt,
  setShapeColor,
  shapeAt,
  shapeIdsMovedBy,
  shapeRefsOf,
  shownPivot,
  styleIn,
  targetTrackIndex,
  turnAndScaleAboveSet,
  transformShapes,
  type ColorPart,
  type DrawingPlace,
  type HandleSide,
  type NodeRef,
  type SetRef,
  type ShapeRef,
} from '../editor/drawings.js'
import { addEffect } from '../editor/effects.js'
import {
  HANDLES,
  boundsOf,
  boxOf,
  containsPoint,
  cropFromHandle,
  handleDirection,
  handlePosition,
  rotationFromPointer,
  scaleFromHandle,
  type Box,
  type Handle,
  type Point,
  type SizeTargets,
} from '../editor/geometry.js'
import { episodeTimeOf, intoGroup, resolveScope } from '../editor/groups.js'
import { motionPath, propertyAt, setProperties, type PropertyValues } from '../editor/properties.js'
import { positionTargets, snapPoint, snapPosition, sortedTargets, type Bounds, type PointTargets } from '../editor/snapping.js'
import { arrowSize } from '../engine/annotations.js'
import { viewAt } from '../engine/camera.js'
import { NO_TURN_OR_SCALE, nearestOnOutline, posedShapes, setPosesAt, shapesBounds, svgPathOf, turnAndScaleOf, turned, unturnedAndUnscaled, type OutlinePoint, type TurnAndScale } from '../engine/curves.js'
import type { PixelColor } from '../engine/engine.js'
import { shapePath } from '../engine/drawings.js'
import { onCanvas, resolveFrame, scopeFrameAt, shownShapes, worldTimeOf, type GroupFrame, type HeldLevel, type Layer, type MediaStates } from '../engine/resolve.js'
import { measureText } from '../engine/text.js'
import type { Size } from '../shared/exportPresets.js'
import type { Documents } from '../shared/mediaProtocol.js'
import { logError } from '../shared/log.js'
import { MIN_SHAPE_NODES, type AnimationClip, type Clip, type Crop, type DrawingClip, type DrawingShape, type GroupClip, type Project, type ShapeNode, type Transform } from '../shared/project.js'
import { frameDuration } from '../shared/time.js'
import { useEditorState, usePosition, useSession } from './context.js'
import type { Edit } from './store.js'
import { TextEditor } from './TextEditor.js'
import { isKeyForTheEditor } from './transport.js'
import { LIBRARY_DRAG_EVENT, LIBRARY_DROP_EVENT, isLibraryDrag, type LibraryDragDetail } from './timelineController.js'

const NO_CROP: Crop = { left: 0, top: 0, right: 0, bottom: 0 }
const HANDLE_PIXELS = 10
const PATH_DOT_PIXELS = 8
const ROTATE_HANDLE_OFFSET_PIXELS = 26
const ROTATE_HANDLE_MAX_REACH = 0.35
const MIN_BOX_PIXELS = 6
// Must match `inset: -14px` in editor.css.
export const MARGIN_PIXELS = 14
const EDGE_TOLERANCE_CANVAS_PIXELS = 0.5
const STROKE_HIT_PIXELS = 6
const NODE_PIXELS = 7
// A drag shorter than this is a click: a pen node stays sharp, and a chosen node stays put.
const MIN_HANDLE_PIXELS = 3
const HANDLE_SIDES: readonly HandleSide[] = ['in', 'out']
const SET_ROTATE_PIXELS = 44
const PIVOT_PIXELS = 10
const ONION_OPACITIES = [0.6, 0.3]
const ONION_DRAWINGS = ONION_OPACITIES.length
// The box around the chosen shapes is not a clip, so it takes an id no clip has.
const SHAPES_BOX_ID = ''

const CORNERS = ['nw', 'ne', 'se', 'sw'] as const
const TRANSFORM_KEYS = ['x', 'y', 'scaleX', 'scaleY', 'rotation'] as const
const NO_PIVOT: Point = { x: 0, y: 0 }

type ShownClip = {
  clipId: string
  kind: 'picture' | 'text' | 'callout' | 'arrow' | 'shape' | 'group' | 'shapes'
  natural: Size
  crop: Crop
  transform: Transform
  box: Box
  hitBoxes: readonly Box[]
  pivot: Point
  arrowLength?: number
  tail?: Point
  shapes?: readonly ShapeRef[]
}

// One shape of a drawing on the open tracks, picked by its outline rather than a box.
type ShownShape = {
  kind: 'drawn'
  clipId: string
  shape: DrawingShape
  path: Path2D
}

type Pickable = ShownClip | ShownShape

type DrawnShape = {
  clipId: string
  shape: DrawingShape
}

// A path still being drawn with the Pen; it joins the drawing only once it ends.
type PenPath = {
  nodes: readonly ShapeNode[]
  place: DrawingPlace
  shapeId: string
  openGroups: readonly string[]
}

type OutlineHit = OutlinePoint & {
  drawn: DrawnShape
}

function isSameNode(first: NodeRef, second: NodeRef): boolean {
  return first.clipId === second.clipId && first.shapeId === second.shapeId && first.index === second.index
}

function isClipItem(item: Pickable): item is ShownClip {
  return item.kind !== 'drawn'
}

type Gesture =
  | { kind: 'move'; from: Point; items: readonly ShownClip[]; others: readonly Bounds[] }
  | { kind: 'scale' | 'crop'; item: ShownClip; handle: Handle; others: readonly ShownClip[] }
  | { kind: 'rotate'; item: ShownClip; from: Point }
  | { kind: 'arrow'; item: ShownClip; moves: 'start' | 'end'; fixed: Point }
  | { kind: 'tail'; item: ShownClip }
  | { kind: 'path'; item: ShownClip; time: number; from: Point; start: Point }
  | { kind: 'draw'; tool: 'rectangle' | 'ellipse'; from: Point; place: DrawingPlace; shapeId: string; targets: PointTargets }
  | { kind: 'pen'; index: number; from: Point; isClosing: boolean }
  | { kind: 'nodes'; from: Point; nodes: readonly NodeRef[]; grabbed: Point; targets: PointTargets; prepare?: Edit }
  | { kind: 'handle'; node: NodeRef; side: HandleSide; at: Point }
  | { kind: 'pivot'; set: SetRef; from: Point; start: Point; pivot: Point; above: TurnAndScale; targets: PointTargets }
  | { kind: 'set-turn'; set: SetRef; from: Point; pivot: Point; rotation: number }
  | { kind: 'set-move'; set: SetRef; from: Point; grabbed: Point; start: Point; after: TurnAndScale; targets: PointTargets }
  | { kind: 'marquee'; from: Point; isAdding: boolean }

type Guides = {
  x: number | undefined
  y: number | undefined
  isSizeSnapped: boolean
  isOnArtboard: boolean
}

const NO_GUIDES: Guides = { x: undefined, y: undefined, isSizeSnapped: false, isOnArtboard: false }

function naturalSize(layer: Layer): Size {
  if (layer.kind === 'video') return { width: layer.video.width, height: layer.video.height }
  if (layer.kind === 'arrow') return arrowSize(layer.look)
  if (layer.kind === 'callout') return { width: layer.look.width, height: layer.look.height }
  if (layer.kind === 'drawing') return { width: layer.look.bounds.right - layer.look.bounds.left, height: layer.look.bounds.bottom - layer.look.bounds.top }
  if (layer.kind !== 'text') return { width: layer.width, height: layer.height }
  const measured = measureText(layer.look)
  return { width: measured.naturalWidth, height: measured.naturalHeight }
}

function shownLayer(layer: Layer): ShownClip {
  const natural = naturalSize(layer)
  const crop = layer.kind === 'video' || layer.kind === 'image' ? layer.crop : NO_CROP
  const box = boxOf(natural, crop, layer.transform)
  let kind: ShownClip['kind'] = 'picture'
  if (layer.kind === 'text' || layer.kind === 'callout' || layer.kind === 'arrow') kind = layer.kind
  if (layer.kind === 'blur' || layer.kind === 'highlight') kind = 'shape'
  const shown: ShownClip = { clipId: layer.clipId, kind, natural, crop, transform: layer.transform, box, hitBoxes: [box], pivot: NO_PIVOT }
  if (layer.kind === 'arrow') shown.arrowLength = layer.look.length
  if (layer.kind === 'callout' && layer.look.tail !== undefined) shown.tail = layer.look.tail
  return shown
}

function shownGroup(group: GroupClip | AnimationClip, members: readonly ShownClip[], transform: Transform): ShownClip {
  const xs: number[] = []
  const ys: number[] = []
  for (const member of members) {
    for (const corner of CORNERS) {
      const inside = canvasPointToClip(transform, handlePosition(member.box, corner))
      xs.push(inside.x)
      ys.push(inside.y)
    }
  }
  const natural = { width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) }
  const pivot = { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 }
  const middle = clipPointToCanvas(transform, pivot)
  const box: Box = { centerX: middle.x, centerY: middle.y, width: natural.width * transform.scaleX, height: natural.height * transform.scaleY, rotation: transform.rotation }
  return { clipId: group.id, kind: 'group', natural, crop: NO_CROP, transform, box, hitBoxes: members.map((member) => member.box), pivot }
}

type Onion = {
  clipId: string
  side: 'before' | 'after'
  distance: number
  path: string
}

function outlinesOf(shapes: readonly DrawingShape[]): string {
  const paths: string[] = []
  for (const shape of shapes) {
    paths.push(svgPathOf(shape))
    if (shape.children !== undefined) paths.push(outlinesOf(shape.children))
  }
  return paths.join(' ')
}

// The drawings nearest the playhead on either side: earlier ones as they end, later ones as they start.
function onionsOf(project: Project, trackIndex: number, time: number): Onion[] {
  const track = project.tracks[trackIndex]
  if (track === undefined || track.hidden) return []
  const frameTicks = frameDuration(project.canvas.frameRate)
  const drawings = track.clips.filter((clip): clip is DrawingClip => clip.type === 'drawing').sort((a, b) => a.start - b.start)
  const shown = drawings.find((clip) => time >= clip.start && time < clip.start + clip.duration)
  const before = drawings.filter((clip) => clip.start + clip.duration <= (shown?.start ?? time)).reverse()
  const after = drawings.filter((clip) => clip.start >= (shown === undefined ? time : shown.start + shown.duration))
  const onions: Onion[] = []
  for (const [distance, clip] of before.slice(0, ONION_DRAWINGS).entries()) {
    const path = outlinesOf(shownShapes(posedShapes(clip, Math.max(0, clip.duration - frameTicks))))
    onions.push({ clipId: clip.id, side: 'before', distance, path })
  }
  for (const [distance, clip] of after.slice(0, ONION_DRAWINGS).entries()) {
    onions.push({ clipId: clip.id, side: 'after', distance, path: outlinesOf(shownShapes(posedShapes(clip, 0))) })
  }
  return onions
}

function everyShape(shapes: readonly DrawingShape[]): DrawingShape[] {
  const every: DrawingShape[] = []
  for (const shape of shapes) {
    every.push(shape)
    every.push(...everyShape(shape.children ?? []))
  }
  return every
}

// The shapes a set moves, as they were at its last key before the playhead's frame.
function ghostOf(clip: DrawingClip, setId: string, local: number): string | undefined {
  const set = nodeSetOf(clip, setId)
  if (set === undefined) return undefined
  let previous: number | undefined
  for (const list of [set.keyframes?.rotation, set.keyframes?.x, set.keyframes?.y]) {
    for (const keyframe of list ?? []) {
      if (keyframe.time < local && (previous === undefined || keyframe.time > previous)) previous = keyframe.time
    }
  }
  if (previous === undefined) return undefined
  const moved = shapeIdsMovedBy(clip, setId)
  const ghosts = everyShape(posedShapes(clip, previous)).filter((shape) => moved.has(shape.id))
  return ghosts.map((shape) => svgPathOf(shape)).join(' ')
}

type Open = {
  project: Project
  time: number
  groups: readonly string[]
  frame: GroupFrame
}

function shownClips(wholeProject: Project, mediaStates: MediaStates, documents: Documents, wholeTime: number, holds: readonly HeldLevel[] | undefined, open: Open): Pickable[] {
  const order: (Pickable | string)[] = []
  const membersOf = new Map<string, ShownClip[]>()
  for (const layer of resolveFrame(wholeProject, mediaStates, documents, wholeTime, 1, holds)) {
    const path = layer.groups ?? []
    if (!open.groups.every((groupId, depth) => path[depth] === groupId)) continue
    const closedGroupId = path[open.groups.length]
    if (closedGroupId === undefined && layer.kind === 'drawing') {
      for (const shape of layer.look.shapes) order.push({ kind: 'drawn', clipId: layer.clipId, shape, path: shapePath(shape) })
      continue
    }
    if (closedGroupId === undefined) {
      order.push(shownLayer(layer))
      continue
    }
    const members = membersOf.get(closedGroupId)
    if (members === undefined) {
      membersOf.set(closedGroupId, [shownLayer(layer)])
      order.push(closedGroupId)
    } else {
      members.push(shownLayer(layer))
    }
  }

  const shown: Pickable[] = []
  for (const entry of order) {
    if (typeof entry !== 'string') {
      shown.push(entry)
      continue
    }
    const group = locateClip(open.project, entry)?.clip
    const members = membersOf.get(entry)
    if (group === undefined || !isContainer(group) || members === undefined) continue
    const own: Transform = {
      x: propertyAt(group, 'x', open.time) ?? group.transform.x,
      y: propertyAt(group, 'y', open.time) ?? group.transform.y,
      scaleX: propertyAt(group, 'scaleX', open.time) ?? group.transform.scaleX,
      scaleY: propertyAt(group, 'scaleY', open.time) ?? group.transform.scaleY,
      rotation: propertyAt(group, 'rotation', open.time) ?? group.transform.rotation,
    }
    shown.push(shownGroup(group, members, onCanvas(open.frame, own)))
  }
  return shown
}

export function usePictureWidth(svgRef: RefObject<SVGSVGElement | null>): number {
  const [pictureWidth, setPictureWidth] = useState(1)

  useEffect(() => {
    const svg = svgRef.current
    if (svg === null) return
    const measure = (): void => setPictureWidth(Math.max(1, svg.clientWidth - 2 * MARGIN_PIXELS))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(svg)
    return () => observer.disconnect()
  }, [svgRef])

  return pictureWidth
}

type Reach = {
  left: number
  top: number
  right: number
  bottom: number
}

const HANDLE_REACH: Reach = { left: MARGIN_PIXELS, top: MARGIN_PIXELS, right: MARGIN_PIXELS, bottom: MARGIN_PIXELS }

function useOverlayReach(svgRef: RefObject<SVGSVGElement | null>, areaRef: RefObject<HTMLElement | null>): { reach: Reach; pictureWidth: number } {
  const [layout, setLayout] = useState({ reach: HANDLE_REACH, pictureWidth: 1 })

  useEffect(() => {
    const picture = svgRef.current?.parentElement ?? null
    const area = areaRef.current
    if (picture === null || area === null) return
    const measure = (): void => {
      const shown = picture.getBoundingClientRect()
      const panel = area.getBoundingClientRect()
      const panelLeft = panel.left + area.clientLeft
      const panelTop = panel.top + area.clientTop
      setLayout({
        pictureWidth: Math.max(1, shown.width),
        reach: {
          left: Math.max(MARGIN_PIXELS, shown.left - panelLeft),
          top: Math.max(MARGIN_PIXELS, shown.top - panelTop),
          right: Math.max(MARGIN_PIXELS, panelLeft + area.clientWidth - shown.right),
          bottom: Math.max(MARGIN_PIXELS, panelTop + area.clientHeight - shown.bottom),
        },
      })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(area)
    observer.observe(picture)
    return () => observer.disconnect()
  }, [svgRef, areaRef])

  return layout
}

export function pointOnCanvas(place: { clientX: number; clientY: number }, overlay: Element, frame: ZoomFrame, pictureWidth: number, offset: Point = { x: MARGIN_PIXELS, y: MARGIN_PIXELS }): Point {
  const box = overlay.getBoundingClientRect()
  const canvasPerPixel = frame.width / pictureWidth
  return { x: frame.left + (place.clientX - box.left - offset.x) * canvasPerPixel, y: frame.top + (place.clientY - box.top - offset.y) * canvasPerPixel }
}

function isPastFrame(box: Box, frame: ZoomFrame): boolean {
  const bounds = boundsOf(box)
  const isPastSide = bounds.left < frame.left - EDGE_TOLERANCE_CANVAS_PIXELS || bounds.right > frame.left + frame.width + EDGE_TOLERANCE_CANVAS_PIXELS
  return isPastSide || bounds.top < frame.top - EDGE_TOLERANCE_CANVAS_PIXELS || bounds.bottom > frame.top + frame.height + EDGE_TOLERANCE_CANVAS_PIXELS
}

function lockedClipIds(project: Project): Set<string> {
  const locked = new Set<string>()
  for (const track of project.tracks) {
    if (!track.locked) continue
    for (const clip of track.clips) locked.add(clip.id)
  }
  return locked
}

function isHandle(value: string | undefined): value is Handle {
  return HANDLES.some((handle) => handle === value)
}

function isCorner(handle: Handle): boolean {
  return CORNERS.some((corner) => corner === handle)
}

function placeFor(item: ShownClip, middle: Point, transform: Transform): Point {
  const toMiddle = clipPointToCanvas({ ...transform, x: 0, y: 0 }, item.pivot)
  return { x: middle.x - toMiddle.x, y: middle.y - toMiddle.y }
}

function sizeTargets(item: ShownClip, others: readonly ShownClip[], canvas: Size, range: number): SizeTargets {
  const fullWidth = item.natural.width - item.crop.left - item.crop.right
  const fullHeight = item.natural.height - item.crop.top - item.crop.bottom
  return {
    widths: sortedTargets([fullWidth, canvas.width, ...others.map((other) => other.box.width)]),
    heights: sortedTargets([fullHeight, canvas.height, ...others.map((other) => other.box.height)]),
    range,
  }
}

function unionOf(boxes: readonly Bounds[]): Bounds {
  return {
    left: Math.min(...boxes.map((box) => box.left)),
    top: Math.min(...boxes.map((box) => box.top)),
    right: Math.max(...boxes.map((box) => box.right)),
    bottom: Math.max(...boxes.map((box) => box.bottom)),
  }
}

function valuesInOpenTracks(openGroups: readonly string[], openFrame: GroupFrame, item: ShownClip, placed: Partial<Transform>): PropertyValues {
  if (openGroups.length === 0) return placed
  const inside = intoGroup(openFrame, { ...item.transform, ...placed })
  const values: PropertyValues = {}
  for (const key of TRANSFORM_KEYS) {
    if (placed[key] !== undefined) values[key] = inside[key]
  }
  return values
}

type OverlayProps = {
  isCropping: boolean
  isOnionSkinOn: boolean
  areaRef: RefObject<HTMLElement | null>
}

export function CanvasOverlay({ isCropping, isOnionSkinOn, areaRef }: OverlayProps): ReactElement {
  const { store, actions, engine } = useSession()
  const project = useEditorState((state) => state.project)
  const wholeProject = useEditorState((state) => state.wholeProject)
  const openGroups = useEditorState((state) => state.openGroups)
  const scope = useEditorState((state) => state.scope)
  const mediaStates = useEditorState((state) => state.mediaStates)
  const documents = useEditorState((state) => state.documents)
  const selection = useEditorState((state) => state.selection)
  const selectedShapes = useEditorState((state) => state.selectedShapes)
  const selectedNodes = useEditorState((state) => state.selectedNodes)
  const selectedSet = useEditorState((state) => state.selectedSet)
  const tool = useEditorState((state) => state.tool)
  const drawingStyle = useEditorState((state) => state.drawingStyle)
  const isFillingOpenPaths = useEditorState((state) => state.isFillingOpenPaths)
  const isInAnimation = useEditorState((state) => state.openChain.length > 0)
  const editingTextId = useEditorState((state) => state.editingTextId)
  const isPlaying = usePosition((position) => position.isPlaying)
  const time = usePosition((position) => position.time)
  const svgRef = useRef<SVGSVGElement>(null)
  const gestureRef = useRef<Gesture | undefined>(undefined)
  const { reach, pictureWidth } = useOverlayReach(svgRef, areaRef)
  const [guides, setGuides] = useState<Guides>(NO_GUIDES)
  const [dropTargetId, setDropTargetId] = useState<string | undefined>(undefined)
  const [fillTarget, setFillTarget] = useState<DrawnShape | undefined>(undefined)
  // The ref is what handlers read, so a release right after a drag sees the drag's last handles.
  const penRef = useRef<PenPath | undefined>(undefined)
  const [penPath, setPenPath] = useState<PenPath | undefined>(undefined)
  const [penPointer, setPenPointer] = useState<Point | undefined>(undefined)
  const [marquee, setMarquee] = useState<Bounds | undefined>(undefined)
  const { canvas } = wholeProject
  const wholeTime = episodeTimeOf(scope, time)
  const holds = scope?.holds
  const frame = frameOf(canvas, viewAt(wholeProject.camera, worldTimeOf(holds, wholeTime), canvas))
  const canvasPerPixel = frame.width / pictureWidth
  const openFrame = useMemo(() => scopeFrameAt(wholeProject, mediaStates, documents, openGroups, wholeTime, holds), [wholeProject, mediaStates, documents, openGroups, wholeTime, holds])
  // A group opened inside the animation has its own space, whose edges aren't the artboard's.
  const isArtboardOpen = useMemo(() => resolveScope(wholeProject, documents, mediaStates, openGroups).groupsInDocument.length === 0, [wholeProject, documents, mediaStates, openGroups])

  const pickables = useMemo(
    () => (isPlaying ? [] : shownClips(wholeProject, mediaStates, documents, wholeTime, holds, { project, time, groups: openGroups, frame: openFrame })),
    [isPlaying, wholeProject, mediaStates, documents, wholeTime, holds, project, time, openGroups, openFrame],
  )
  const hitContext = useMemo(() => {
    const context = new OffscreenCanvas(1, 1).getContext('2d')
    if (context === null) return undefined
    context.lineCap = 'round'
    context.lineJoin = 'round'
    return context
  }, [])
  const shown = pickables.filter(isClipItem)
  const isDrawingTool = isInAnimation && tool !== 'move' && tool !== 'node'
  const isPenTool = isInAnimation && tool === 'pen'
  const isNodeTool = isInAnimation && tool === 'node'
  const pen = penPath?.openGroups === openGroups ? penPath : undefined
  const nodeShapes = isNodeTool && !isPlaying ? drawnShapesOf(selectedShapes) : []
  const setClip = selectedSet === undefined || !isNodeTool || isPlaying ? undefined : locateClip(project, selectedSet.clipId)?.clip
  const setDrawing = setClip?.type === 'drawing' ? setClip : undefined
  const setPose = setDrawing === undefined || selectedSet === undefined ? undefined : setPoseAt(setDrawing, selectedSet.setId, time - setDrawing.start)
  const setOwnPivot = setPose?.set.pivot
  const setPivot = setDrawing === undefined || selectedSet === undefined ? undefined : shownPivot(setDrawing, selectedSet.setId, time - setDrawing.start)
  const setRotation = setPose?.rotation ?? 0
  const setAbove = setDrawing === undefined || selectedSet === undefined ? NO_TURN_OR_SCALE : turnAndScaleAboveSet(setDrawing, selectedSet.setId, time - setDrawing.start)
  const pivotOnCanvas = setPivot === undefined ? undefined : placeOnCanvas(setPivot)
  const turnDirection = turned({ x: 0, y: -1 }, setRotation + setAbove.rotation + openFrame.rotation)
  const shapesBox = isPlaying || isNodeTool ? undefined : shapesBoxOf(selectedShapes)
  const selected = shapesBox === undefined ? shown.filter((item) => selection.includes(item.clipId)) : [shapesBox]
  const locked = lockedClipIds(project)
  const outside: ShownClip[] = []
  for (const item of shown) {
    if (selection.includes(item.clipId) || locked.has(item.clipId)) continue
    if (isPastFrame(item.box, frame)) outside.push(item)
  }
  const pictureOffset = { x: reach.left, y: reach.top }
  const only = selected.length === 1 ? selected[0] : undefined
  const editing = editingTextId === undefined ? undefined : locateClip(project, editingTextId)?.clip
  const editedText = editing?.type === 'text' || editing?.type === 'callout' ? editing : undefined
  let onlyClip: Clip | undefined
  if (only !== undefined && editingTextId === undefined) onlyClip = locateClip(project, only.clipId)?.clip
  const path = onlyClip === undefined ? undefined : motionPath(onlyClip)
  const pathOffset = only === undefined ? NO_PIVOT : { x: only.box.centerX - only.transform.x, y: only.box.centerY - only.transform.y }

  function placeOnCanvas(place: Point): Point {
    const placed = onCanvas(openFrame, { x: place.x, y: place.y, scaleX: 1, scaleY: 1, rotation: 0 })
    return { x: placed.x, y: placed.y }
  }

  function shownOnPath(place: Point): Point {
    const at = placeOnCanvas(place)
    return { x: at.x + pathOffset.x, y: at.y + pathOffset.y }
  }

  function pointOf(event: MouseEvent<SVGSVGElement>): Point {
    return pointOnCanvas(event, event.currentTarget, frame, pictureWidth, pictureOffset)
  }

  function artboardPoint(point: Point): Point {
    const inside = intoGroup(openFrame, { x: point.x, y: point.y, scaleX: 1, scaleY: 1, rotation: 0 })
    return { x: inside.x, y: inside.y }
  }

  function drawnShapesOf(shapes: readonly ShapeRef[]): DrawnShape[] {
    const drawn: DrawnShape[] = []
    for (const ref of shapes) {
      const shape = posedShapeAt(project, ref, time)
      if (shape !== undefined) drawn.push({ clipId: ref.clipId, shape })
    }
    return drawn
  }

  function shapesBoxOf(shapes: readonly ShapeRef[]): ShownClip | undefined {
    const bounds = shapesBounds(drawnShapesOf(shapes).map((drawn) => drawn.shape), false)
    if (bounds === undefined) return undefined
    // A straight line has no height, which the handles cannot scale from.
    const natural = { width: Math.max(1, bounds.right - bounds.left), height: Math.max(1, bounds.bottom - bounds.top) }
    const transform = onCanvas(openFrame, { x: (bounds.left + bounds.right) / 2, y: (bounds.top + bounds.bottom) / 2, scaleX: 1, scaleY: 1, rotation: 0 })
    const box = boxOf(natural, NO_CROP, transform)
    return { clipId: SHAPES_BOX_ID, kind: 'shapes', natural, crop: NO_CROP, transform, box, hitBoxes: [box], pivot: NO_PIVOT, shapes }
  }

  function shapeContains(shape: DrawingShape, path: Path2D, at: Point): boolean {
    if (hitContext === undefined) return false
    if (shape.fill !== undefined && hitContext.isPointInPath(path, at.x, at.y)) return true
    if (shape.stroke === undefined) return false
    hitContext.lineWidth = Math.max(shape.stroke.width, (STROKE_HIT_PIXELS * canvasPerPixel) / openFrame.scale)
    return hitContext.isPointInStroke(path, at.x, at.y)
  }

  function isUnlockedAt(item: ShownClip, point: Point): boolean {
    if (locked.has(item.clipId)) return false
    return item.hitBoxes.some((box) => containsPoint(box, point))
  }

  function topmostAt(point: Point): Pickable | undefined {
    const at = artboardPoint(point)
    return pickables.findLast((item) => {
      if (isClipItem(item)) return isUnlockedAt(item, point)
      return !locked.has(item.clipId) && item.shape.locked !== true && shapeContains(item.shape, item.path, at)
    })
  }

  // Groups and keyed shapes scale evenly, so they have no side handles.
  function scalesEvenly(item: ShownClip): boolean {
    if (item.kind === 'group') return true
    return item.shapes?.some((ref) => shapeAt(project, ref)?.ownsSet === true) === true
  }

  function nounOf(item: ShownClip): string {
    if (item.kind !== 'shapes') return 'Clip'
    return item.shapes?.length === 1 ? 'Shape' : 'Shapes'
  }

  function effectTargetAt(detail: LibraryDragDetail): ShownClip | undefined {
    const svg = svgRef.current
    if (svg === null || detail.item.kind !== 'effect') return undefined
    const point = pointOnCanvas(detail, svg, frame, pictureWidth, pictureOffset)
    const isBlurFill = detail.item.effect === 'blurFill'
    return shown.findLast((item) => {
      const takesEffect = isBlurFill ? item.kind === 'picture' : item.kind !== 'shape'
      return takesEffect && isUnlockedAt(item, point)
    })
  }

  const onLibraryDrag = useEffectEvent((event: Event) => {
    if (!isLibraryDrag(event)) return
    const isOverCanvas = event.target instanceof Node && svgRef.current?.contains(event.target) === true
    setDropTargetId(isOverCanvas ? effectTargetAt(event.detail)?.clipId : undefined)
  })

  const onLibraryDrop = useEffectEvent((event: Event) => {
    if (!isLibraryDrag(event)) return
    const svg = svgRef.current
    const { item } = event.detail
    if (item.kind === 'annotation' && svg !== null) {
      const point = pointOnCanvas(event.detail, svg, frame, pictureWidth, pictureOffset)
      const inside = intoGroup(openFrame, { x: point.x, y: point.y, scaleX: 1, scaleY: 1, rotation: 0 })
      actions.addAnnotation(item.annotation, { x: Math.round(inside.x), y: Math.round(inside.y) })
      return
    }
    if (item.kind !== 'effect') return
    const target = effectTargetAt(event.detail)
    if (target === undefined) return
    const { effect } = item
    const clipIds = selection.includes(target.clipId) ? selection : [target.clipId]
    store.apply('Add Effect', (current) => addEffect(current, clipIds, effect))
    store.select(clipIds)
  })

  useEffect(() => {
    const svg = svgRef.current
    if (svg === null) return
    window.addEventListener(LIBRARY_DRAG_EVENT, onLibraryDrag)
    svg.addEventListener(LIBRARY_DROP_EVENT, onLibraryDrop)
    return () => {
      window.removeEventListener(LIBRARY_DRAG_EVENT, onLibraryDrag)
      svg.removeEventListener(LIBRARY_DROP_EVENT, onLibraryDrop)
    }
  }, [])

  function isInTextEditor(target: EventTarget): boolean {
    return target instanceof Element && target.closest('foreignObject') !== null
  }

  // The topmost shape whose inside holds the point, then the deepest unlocked shape clipped inside it there; a clip on top hides them.
  function fillTargetAt(point: Point): DrawnShape | undefined {
    const at = artboardPoint(point)
    const hit = pickables.findLast((item) => {
      if (isClipItem(item)) return isUnlockedAt(item, point)
      return !locked.has(item.clipId) && item.shape.locked !== true && hitContext?.isPointInPath(item.path, at.x, at.y) === true
    })
    if (hit === undefined || isClipItem(hit)) return undefined
    let { shape } = hit
    while (true) {
      const inside = shape.children?.findLast((child) => child.locked !== true && hitContext?.isPointInPath(shapePath(child), at.x, at.y) === true)
      if (inside === undefined) return { clipId: hit.clipId, shape }
      shape = inside
    }
  }

  function fillAt(point: Point): void {
    const target = fillTargetAt(point)
    if (target === undefined) return
    const { fill, fillSwatch } = styleIn(drawingStyle, project.swatches)
    const shapes = [{ clipId: target.clipId, shapeId: target.shape.id }]
    store.apply('Fill Shape', (current) => setShapeColor(current, shapes, 'fill', fill, fillSwatch))
  }

  function showFillTarget(point: Point): void {
    const target = tool === 'fill' && isInAnimation ? fillTargetAt(point) : undefined
    if (target?.clipId === fillTarget?.clipId && target?.shape === fillTarget?.shape) return
    setFillTarget(target)
  }

  // A picked colour is the shape's own, and becomes the colour new shapes get.
  async function pickColorAt(point: Point, part: ColorPart): Promise<void> {
    const share = { x: (point.x - frame.left) / frame.width, y: (point.y - frame.top) / frame.height }
    if (share.x < 0 || share.x >= 1 || share.y < 0 || share.y >= 1) return
    let picked: PixelColor | undefined
    try {
      picked = await engine.colorAt(share)
    } catch (error) {
      logError('Could not pick a colour', error, { share })
      return
    }
    if (picked === undefined) return
    const color = hexOfChannels(picked.red, picked.green, picked.blue)
    const chosen = store.getState().selectedShapes
    const label = part === 'fill' ? 'Pick Fill Colour' : 'Pick Stroke Colour'
    if (chosen.length > 0) store.apply(label, (current) => setShapeColor(current, chosen, part, color))
    store.setDrawingColor(part, color)
  }

  function newShapePlace(): DrawingPlace {
    const { selection: chosenClips, selectedShapes: chosenShapes } = store.getState()
    return drawingPlace(project, time, chosenClips, chosenShapes, { clipId: crypto.randomUUID(), trackId: crypto.randomUUID() })
  }

  function snapTargets(moving: readonly NodeRef[], extraPoints: readonly Point[] = []): PointTargets {
    const points = [...extraPoints]
    for (const item of pickables) {
      if (!isClipItem(item)) points.push(...nodePointsOf(item.clipId, [item.shape], moving))
    }
    if (!isArtboardOpen) return { points, x: [], y: [] }
    return { points, x: [0, project.canvas.width], y: [0, project.canvas.height] }
  }

  function snappedPoint(at: Point, targets: PointTargets, event: PointerEvent<SVGSVGElement>): Point {
    const range = snapRange(event)
    if (range === undefined) {
      setGuides(NO_GUIDES)
      return at
    }
    const snapped = snapPoint(at, targets, range / openFrame.scale)
    setGuides(isArtboardOpen ? { x: snapped.guideX, y: snapped.guideY, isSizeSnapped: false, isOnArtboard: true } : NO_GUIDES)
    return snapped.point
  }

  function startDrawing(shapeTool: 'rectangle' | 'ellipse', point: Point, event: PointerEvent<SVGSVGElement>): void {
    const place = newShapePlace()
    const targets = snapTargets([])
    const from = snappedPoint(artboardPoint(point), targets, event)
    store.begin(shapeTool === 'rectangle' ? 'Add Rectangle' : 'Add Ellipse')
    gestureRef.current = { kind: 'draw', tool: shapeTool, from, place, shapeId: crypto.randomUUID(), targets }
  }

  function selectDrawn(shapeId: string): void {
    const drawn = shapeRefsOf(store.getState().project, [shapeId])
    if (drawn.length > 0) store.selectShapes(drawn)
  }

  // A path started in another open animation or group would land in the wrong file.
  function openPen(): PenPath | undefined {
    const path = penRef.current
    return path?.openGroups === openGroups ? path : undefined
  }

  function showPen(path: PenPath | undefined): void {
    penRef.current = path
    setPenPath(path)
  }

  function endPath(isClosed: boolean): void {
    const path = openPen()
    showPen(undefined)
    setPenPointer(undefined)
    setGuides(NO_GUIDES)
    if (path === undefined || path.nodes.length < MIN_SHAPE_NODES) return
    const shape = pathShape(path.shapeId, path.nodes, isClosed, styleIn(drawingStyle, project.swatches), isFillingOpenPaths)
    store.apply('Add Path', (current) => addDrawingShapes(current, path.place, [shape]))
    selectDrawn(path.shapeId)
  }

  function isClickOnly(from: Point, to: Point): boolean {
    return Math.hypot(to.x - from.x, to.y - from.y) < MIN_HANDLE_PIXELS * canvasPerPixel
  }

  // Where a place in the artboard goes when the pointer drags it from one point on the canvas to another.
  function draggedPlace(place: Point, from: Point, to: Point): Point {
    const start = artboardPoint(from)
    const at = artboardPoint(to)
    return { x: place.x + at.x - start.x, y: place.y + at.y - start.y }
  }

  function isNearOnScreen(place: Point, point: Point): boolean {
    const at = placeOnCanvas(place)
    return Math.hypot(at.x - point.x, at.y - point.y) <= NODE_PIXELS * canvasPerPixel
  }

  // Each press adds a node, or on the first node closes the path; a drag then pulls the node's handles.
  function penDown(point: Point, event: PointerEvent<SVGSVGElement>): void {
    setPenPointer(undefined)
    const path = openPen()
    const at = snappedPoint(artboardPoint(point), snapTargets([], path?.nodes), event)
    if (path === undefined) {
      showPen({ nodes: [at], place: newShapePlace(), shapeId: crypto.randomUUID(), openGroups })
      gestureRef.current = { kind: 'pen', index: 0, from: point, isClosing: false }
      return
    }
    const first = path.nodes[0]
    // Snapped onto the first node, a press closes the path rather than stacking a node there.
    const isOnFirst = first !== undefined && (isNearOnScreen(first, point) || (at.x === first.x && at.y === first.y))
    if (path.nodes.length >= MIN_SHAPE_NODES && isOnFirst) {
      gestureRef.current = { kind: 'pen', index: 0, from: point, isClosing: true }
      return
    }
    showPen({ ...path, nodes: [...path.nodes, at] })
    gestureRef.current = { kind: 'pen', index: path.nodes.length, from: point, isClosing: false }
  }

  // Handles pull both ways from the node; with ⌥ only the outgoing one follows.
  function pullHandles(index: number, from: Point, point: Point, isBroken: boolean): void {
    const path = openPen()
    const node = path?.nodes[index]
    if (path === undefined || node === undefined) return
    if (isClickOnly(from, point)) return
    const pulled = artboardPoint(point)
    const out = { x: pulled.x - node.x, y: pulled.y - node.y }
    const pulledNode = isBroken ? { ...node, out } : { ...node, in: { x: -out.x, y: -out.y }, out }
    showPen({ ...path, nodes: path.nodes.map((each, eachIndex) => (eachIndex === index ? pulledNode : each)) })
  }

  const onPenKey = useEffectEvent((event: KeyboardEvent) => {
    if (openPen() === undefined || !isKeyForTheEditor(event)) return
    if (event.key !== 'Enter' && event.key !== 'Escape') return
    event.preventDefault()
    endPath(false)
  })

  // Caught before the editor's keys, so Esc ends the path instead of closing the animation.
  useEffect(() => {
    window.addEventListener('keydown', onPenKey, true)
    return () => window.removeEventListener('keydown', onPenKey, true)
  }, [])

  const onToolChange = useEffectEvent(() => {
    if (tool !== 'pen') endPath(false)
  })

  useEffect(() => onToolChange(), [tool])

  function nodeRefOf(target: EventTarget, kind: 'node' | 'node-in' | 'node-out'): NodeRef | undefined {
    if (!(target instanceof SVGElement) || target.dataset.handle !== kind) return undefined
    const drawn = nodeShapes[Number(target.dataset.shape)]
    if (drawn === undefined) return undefined
    return { clipId: drawn.clipId, shapeId: drawn.shape.id, index: Number(target.dataset.node) }
  }

  function outlineAt(point: Point): OutlineHit | undefined {
    const at = artboardPoint(point)
    const reach = (STROKE_HIT_PIXELS * canvasPerPixel) / openFrame.scale
    let nearest: OutlineHit | undefined
    for (const drawn of nodeShapes) {
      const found = nearestOnOutline(drawn.shape, at)
      if (found === undefined || found.distance > reach) continue
      if (nearest === undefined || found.distance < nearest.distance) nearest = { ...found, drawn }
    }
    return nearest
  }

  // The grabbed node snaps, and the move is turned back through the sets after this one that turn the node.
  function startSetMove(set: SetRef, node: NodeRef, point: Point): void {
    const clip = locateClip(project, set.clipId)?.clip
    const grabbed = posedShapeAt(project, node, time)?.nodes[node.index]
    const own = shapeAt(project, node)?.nodes[node.index]
    if (clip?.type !== 'drawing' || grabbed === undefined || own === undefined) return
    const poses = setPosesAt(clip.nodeSets, time - clip.start)
    const order = poses.findIndex((pose) => pose.set.id === set.setId)
    const pose = poses[order]
    if (pose === undefined) return
    store.begin('Move Node Set')
    const after = turnAndScaleOf(own, poses.slice(order + 1), followedSetIds(clip).get(node.shapeId) ?? [])
    gestureRef.current = { kind: 'set-move', set, from: point, grabbed, start: { x: pose.x, y: pose.y }, after, targets: snapTargets(selectedNodes) }
  }

  function pressNode(node: NodeRef, point: Point, isAdding: boolean): void {
    const isChosen = selectedNodes.some((chosen) => isSameNode(chosen, node))
    if (isAdding && isChosen) {
      store.selectNodes(selectedNodes.filter((chosen) => !isSameNode(chosen, node)))
      return
    }
    if (selectedSet !== undefined && isChosen && !isAdding) {
      startSetMove(selectedSet, node, point)
      return
    }
    let moving = selectedNodes
    if (isAdding) moving = [...selectedNodes, node]
    else if (!isChosen) moving = [node]
    if (moving !== selectedNodes) store.selectNodes(moving)
    const grabbed = posedShapeAt(project, node, time)?.nodes[node.index]
    if (grabbed === undefined) return
    store.begin(moving.length === 1 ? 'Move Node' : 'Move Nodes')
    gestureRef.current = { kind: 'nodes', from: point, nodes: moving, grabbed, targets: snapTargets(moving) }
  }

  // The new node is chosen, and a drag goes on to move it in the same step.
  function addNodeAt(hit: OutlineHit, point: Point): void {
    const shape = { clipId: hit.drawn.clipId, shapeId: hit.drawn.shape.id }
    const node = { ...shape, index: hit.segmentIndex + 1 }
    const prepare: Edit = (current) => insertNode(current, shape, hit.segmentIndex, hit.progress)
    const grabbed = posedShapeAt(prepare(project), node, time)?.nodes[node.index]
    if (grabbed === undefined) return
    store.begin('Add Node')
    store.update(prepare)
    store.selectNodes([node])
    gestureRef.current = { kind: 'nodes', from: point, nodes: [node], grabbed, targets: snapTargets([]), prepare }
  }

  function chooseShape(hit: ShownShape, point: Point, isAdding: boolean): void {
    const picked = { clipId: hit.clipId, shapeId: shapeUnder(hit, artboardPoint(point)).id }
    const isPicked = (shape: ShapeRef): boolean => shape.clipId === picked.clipId && shape.shapeId === picked.shapeId
    if (!isAdding) store.selectShapes([picked])
    else if (selectedShapes.some(isPicked)) store.selectShapes(selectedShapes.filter((shape) => !isPicked(shape)))
    else store.selectShapes([...selectedShapes, picked])
  }

  function startSetHandle(grabbed: string | undefined, point: Point): boolean {
    if (selectedSet === undefined || setPivot === undefined || setOwnPivot === undefined || pivotOnCanvas === undefined) return false
    if (grabbed === 'set-pivot') {
      store.begin('Move Pivot')
      gestureRef.current = { kind: 'pivot', set: selectedSet, from: point, start: setPivot, pivot: setOwnPivot, above: setAbove, targets: snapTargets([]) }
      return true
    }
    if (grabbed !== 'set-turn') return false
    store.begin('Rotate Node Set')
    gestureRef.current = { kind: 'set-turn', set: selectedSet, from: point, pivot: pivotOnCanvas, rotation: setRotation }
    return true
  }

  // Set handles first, then node handles, nodes, the outlines of the chosen shapes, then any shape; clips are left alone.
  function nodeToolDown(event: PointerEvent<SVGSVGElement>, point: Point): void {
    const grabbed = event.target instanceof SVGElement ? event.target.dataset.handle : undefined
    if (startSetHandle(grabbed, point)) return
    for (const side of HANDLE_SIDES) {
      const node = nodeRefOf(event.target, side === 'in' ? 'node-in' : 'node-out')
      const at = node === undefined ? undefined : posedShapeAt(project, node, time)?.nodes[node.index]
      if (node === undefined || at === undefined) continue
      store.begin('Move Handle')
      gestureRef.current = { kind: 'handle', node, side, at }
      return
    }
    const node = nodeRefOf(event.target, 'node')
    if (node !== undefined) {
      pressNode(node, point, event.shiftKey)
      return
    }
    const onOutline = outlineAt(point)
    if (onOutline !== undefined) {
      addNodeAt(onOutline, point)
      return
    }
    const hit = topmostAt(point)
    if (hit !== undefined && !isClipItem(hit)) {
      chooseShape(hit, point, event.shiftKey)
      return
    }
    gestureRef.current = { kind: 'marquee', from: point, isAdding: event.shiftKey }
  }

  function addNodesInBox(clipId: string, shapes: readonly DrawingShape[], box: Bounds, chosenShapes: ShapeRef[], chosenNodes: NodeRef[]): void {
    for (const shape of shapes) {
      if (shape.hidden === true || shape.locked === true) continue
      const ref = { clipId, shapeId: shape.id }
      let isInBox = false
      for (const [index, node] of shape.nodes.entries()) {
        const at = placeOnCanvas(node)
        if (at.x < box.left || at.x > box.right || at.y < box.top || at.y > box.bottom) continue
        isInBox = true
        const inside = { ...ref, index }
        if (!chosenNodes.some((chosen) => isSameNode(chosen, inside))) chosenNodes.push(inside)
      }
      const isChosen = chosenShapes.some((chosen) => chosen.clipId === clipId && chosen.shapeId === shape.id)
      if (isInBox && !isChosen) chosenShapes.push(ref)
      if (shape.children !== undefined) addNodesInBox(clipId, shape.children, box, chosenShapes, chosenNodes)
    }
  }

  // A box picks the nodes inside it from every shape that can be picked; a click without a drag lets go of everything.
  function endMarquee(from: Point, to: Point, isAdding: boolean): void {
    setMarquee(undefined)
    if (isClickOnly(from, to)) {
      if (!isAdding) store.select([])
      return
    }
    const box = { left: Math.min(from.x, to.x), top: Math.min(from.y, to.y), right: Math.max(from.x, to.x), bottom: Math.max(from.y, to.y) }
    const chosenShapes = isAdding ? [...selectedShapes] : []
    const chosenNodes = isAdding ? [...selectedNodes] : []
    for (const item of pickables) {
      if (isClipItem(item) || locked.has(item.clipId)) continue
      addNodesInBox(item.clipId, [item.shape], box, chosenShapes, chosenNodes)
    }
    store.selectShapes(chosenShapes)
    store.selectNodes(chosenNodes)
  }

  // A clipped child chosen by a double-click stays the one a press on it picks.
  function shapeUnder(hit: ShownShape, at: Point): DrawingShape {
    for (const chosen of selectedShapes) {
      if (chosen.clipId !== hit.clipId) continue
      const inside = pickableShape(hit.shape.children ?? [], chosen.shapeId)
      if (inside !== undefined && shapeContains(inside, shapePath(inside), at)) return inside
    }
    return hit.shape
  }

  function pickShape(hit: ShownShape, point: Point, isAdding: boolean): void {
    const picked = { clipId: hit.clipId, shapeId: shapeUnder(hit, artboardPoint(point)).id }
    const isPicked = (shape: ShapeRef): boolean => shape.clipId === picked.clipId && shape.shapeId === picked.shapeId
    const isSelected = selectedShapes.some(isPicked)
    let moving = selectedShapes
    if (isAdding && isSelected) moving = selectedShapes.filter((shape) => !isPicked(shape))
    else if (isAdding) moving = [...selectedShapes, picked]
    else if (!isSelected) moving = [picked]
    if (moving !== selectedShapes) store.selectShapes(moving)
    const box = shapesBoxOf(moving)
    if (box === undefined) return
    store.begin(`Move ${nounOf(box)}`)
    gestureRef.current = { kind: 'move', from: point, items: [box], others: shown.map((item) => boundsOf(item.box)) }
  }

  function onPointerDown(event: PointerEvent<SVGSVGElement>): void {
    if (event.button !== 0 || isPlaying || isInTextEditor(event.target)) return
    event.currentTarget.setPointerCapture(event.pointerId)
    const point = pointOf(event)
    if (isDrawingTool) {
      if (tool === 'fill') fillAt(point)
      else if (tool === 'picker') void pickColorAt(point, event.shiftKey ? 'stroke' : 'fill')
      else if (tool === 'pen') penDown(point, event)
      else startDrawing(tool, point, event)
      return
    }
    if (isNodeTool) {
      nodeToolDown(event, point)
      return
    }
    const grabbed = event.target instanceof SVGElement ? event.target.dataset.handle : undefined

    if (only?.arrowLength !== undefined && (grabbed === 'arrow-start' || grabbed === 'arrow-end')) {
      const ends = arrowEnds(only.transform, only.arrowLength)
      store.begin('Move Arrow End')
      if (grabbed === 'arrow-end') gestureRef.current = { kind: 'arrow', item: only, moves: 'end', fixed: ends.start }
      else gestureRef.current = { kind: 'arrow', item: only, moves: 'start', fixed: ends.end }
      return
    }
    if (only !== undefined && grabbed === 'tail') {
      store.begin('Move Callout Tail')
      gestureRef.current = { kind: 'tail', item: only }
      return
    }
    const grabbedDot = grabbed === 'path-point' && event.target instanceof SVGElement ? event.target.dataset.dot : undefined
    const dot = grabbedDot === undefined ? undefined : path?.dots[Number(grabbedDot)]
    const dotAt = dot === undefined ? undefined : shownOnPath(dot.point)
    let isUnderClip = false
    if (only !== undefined && dotAt !== undefined) {
      const distance = Math.hypot(dotAt.x - only.box.centerX, dotAt.y - only.box.centerY)
      isUnderClip = distance < PATH_DOT_PIXELS * canvasPerPixel
    }
    if (only !== undefined && onlyClip !== undefined && dot !== undefined && !isUnderClip) {
      store.begin('Move Position Keyframe')
      gestureRef.current = { kind: 'path', item: only, time: onlyClip.start + dot.time, from: point, start: placeOnCanvas(dot.point) }
      return
    }
    if (only !== undefined && grabbed === 'rotate') {
      store.begin(`Rotate ${nounOf(only)}`)
      gestureRef.current = { kind: 'rotate', item: only, from: point }
      return
    }
    if (only !== undefined && isHandle(grabbed)) {
      const kind = only.kind === 'picture' && (isCropping || event.altKey) ? 'crop' : 'scale'
      store.begin(kind === 'crop' ? 'Crop Clip' : `Resize ${nounOf(only)}`)
      gestureRef.current = { kind, item: only, handle: grabbed, others: shown.filter((item) => item !== only) }
      return
    }

    const hit = topmostAt(point)
    if (hit === undefined) {
      store.select([])
      return
    }
    if (!isClipItem(hit)) {
      pickShape(hit, point, event.shiftKey)
      return
    }
    const isSelected = selection.includes(hit.clipId)
    let moving = selection
    if (event.shiftKey && isSelected) moving = selection.filter((id) => id !== hit.clipId)
    else if (event.shiftKey) moving = [...selection, hit.clipId]
    else if (!isSelected) moving = [hit.clipId]
    if (moving !== selection) store.select(moving)

    const items: ShownClip[] = []
    const others: Bounds[] = []
    for (const item of shown) {
      if (moving.includes(item.clipId)) items.push(item)
      else others.push(boundsOf(item.box))
    }
    if (items.length === 0) return
    store.begin(items.length === 1 ? 'Move Clip' : 'Move Clips')
    gestureRef.current = { kind: 'move', from: point, items, others }
  }

  function onDoubleClick(event: MouseEvent<SVGSVGElement>): void {
    if (isPlaying || isInTextEditor(event.target) || isPenTool) return
    const point = pointOf(event)
    const hit = topmostAt(point)
    if (hit === undefined) return
    if (!isClipItem(hit)) {
      const at = artboardPoint(point)
      const child = hit.shape.children?.findLast((candidate) => candidate.locked !== true && shapeContains(candidate, shapePath(candidate), at))
      if (child !== undefined) store.selectShapes([{ clipId: hit.clipId, shapeId: child.id }])
      return
    }
    if (isNodeTool) return
    store.select([hit.clipId])
    if (hit.kind === 'text' || hit.kind === 'callout') store.editText(hit.clipId)
    if (hit.kind === 'group') actions.openGroup()
  }

  function snapRange(event: PointerEvent<SVGSVGElement>): number | undefined {
    const { isSnapping, settings } = store.getState()
    return isSnapping && !event.metaKey ? settings.snapRangePixels * canvasPerPixel : undefined
  }

  function edit(item: ShownClip, placed: Partial<Transform>, crop: PropertyValues = {}): Edit {
    const { shapes } = item
    if (shapes !== undefined) {
      const from = intoGroup(openFrame, item.transform)
      const to = intoGroup(openFrame, { ...item.transform, ...placed })
      return (current) => transformShapes(current, shapes, from, to, time)
    }
    const values = { ...valuesInOpenTracks(openGroups, openFrame, item, placed), ...crop }
    return (current) => setProperties(current, [item.clipId], values, time)
  }

  function onPointerMove(event: PointerEvent<SVGSVGElement>): void {
    const gesture = gestureRef.current
    const point = pointOf(event)
    if (gesture === undefined) {
      showFillTarget(point)
      const path = isPenTool ? openPen() : undefined
      if (path !== undefined) setPenPointer(snappedPoint(artboardPoint(point), snapTargets([], path.nodes), event))
      return
    }
    const range = snapRange(event)

    if (gesture.kind === 'pen') {
      pullHandles(gesture.index, gesture.from, point, event.altKey)
      return
    }

    if (gesture.kind === 'marquee') {
      const { from } = gesture
      setMarquee({ left: Math.min(from.x, point.x), top: Math.min(from.y, point.y), right: Math.max(from.x, point.x), bottom: Math.max(from.y, point.y) })
      return
    }

    if (gesture.kind === 'nodes') {
      const { nodes, prepare, grabbed } = gesture
      let placed = grabbed
      if (isClickOnly(gesture.from, point)) setGuides(NO_GUIDES)
      else placed = snappedPoint(draggedPlace(grabbed, gesture.from, point), gesture.targets, event)
      const delta = { x: placed.x - grabbed.x, y: placed.y - grabbed.y }
      store.update((current) => moveNodes(prepare === undefined ? current : prepare(current), nodes, delta, time))
      return
    }

    if (gesture.kind === 'handle') {
      const at = artboardPoint(point)
      const { node, side } = gesture
      const handle = { x: at.x - gesture.at.x, y: at.y - gesture.at.y }
      store.update((current) => moveHandle(current, node, side, handle, event.altKey, time))
      return
    }

    if (gesture.kind === 'pivot' || gesture.kind === 'set-move') {
      const { set } = gesture
      if (isClickOnly(gesture.from, point)) {
        setGuides(NO_GUIDES)
        store.update((current) => current)
        return
      }
      if (gesture.kind === 'pivot') {
        const shown = snappedPoint(draggedPlace(gesture.start, gesture.from, point), gesture.targets, event)
        const shift = unturnedAndUnscaled({ x: shown.x - gesture.start.x, y: shown.y - gesture.start.y }, gesture.above)
        const pivot = { x: gesture.pivot.x + shift.x, y: gesture.pivot.y + shift.y }
        store.update((current) => setNodeSetPivot(current, set, pivot))
        return
      }
      const { grabbed, start } = gesture
      const placed = snappedPoint(draggedPlace(grabbed, gesture.from, point), gesture.targets, event)
      const own = unturnedAndUnscaled({ x: placed.x - grabbed.x, y: placed.y - grabbed.y }, gesture.after)
      store.update((current) => setNodeSetPose(current, set, { x: start.x + own.x, y: start.y + own.y }, time))
      return
    }

    if (gesture.kind === 'set-turn') {
      const { set, pivot } = gesture
      const turn: Box = { centerX: pivot.x, centerY: pivot.y, width: 0, height: 0, rotation: gesture.rotation }
      const rotation = rotationFromPointer(turn, gesture.from, point, event.shiftKey)
      store.update((current) => setNodeSetPose(current, set, { rotation }, time))
      return
    }

    if (gesture.kind === 'draw') {
      const box = dragBox(gesture.from, snappedPoint(artboardPoint(point), gesture.targets, event), event.shiftKey)
      const longSidePixels = (Math.max(box.right - box.left, box.bottom - box.top) * openFrame.scale) / canvasPerPixel
      if (longSidePixels < MIN_BOX_PIXELS) {
        store.update((current) => current)
        return
      }
      const style = styleIn(drawingStyle, project.swatches)
      const shape = gesture.tool === 'rectangle' ? rectangleShape(gesture.shapeId, box, style) : ellipseShape(gesture.shapeId, box, style)
      const { place } = gesture
      store.update((current) => addDrawingShapes(current, place, [shape]))
      return
    }

    if (gesture.kind === 'move') {
      let dx = point.x - gesture.from.x
      let dy = point.y - gesture.from.y
      let shownGuides = NO_GUIDES
      if (range !== undefined) {
        const moving = unionOf(gesture.items.map((item) => boundsOf(item.box)))
        const snapped = snapPosition(moving, dx, dy, positionTargets(gesture.others, canvas), range)
        dx = snapped.x.delta
        dy = snapped.y.delta
        shownGuides = { x: snapped.x.guide, y: snapped.y.guide, isSizeSnapped: false, isOnArtboard: false }
      }
      setGuides(shownGuides)
      const { items } = gesture
      store.update((current) => {
        let moved = current
        for (const item of items) moved = edit(item, { x: item.transform.x + dx, y: item.transform.y + dy })(moved)
        return moved
      })
      return
    }

    if (gesture.kind === 'path') {
      const { item, time: keyTime } = gesture
      const placed = { x: gesture.start.x + point.x - gesture.from.x, y: gesture.start.y + point.y - gesture.from.y }
      const values = valuesInOpenTracks(openGroups, openFrame, item, placed)
      store.update((current) => setProperties(current, [item.clipId], values, keyTime))
      return
    }

    const { item } = gesture
    const middle = { x: item.box.centerX, y: item.box.centerY }
    if (gesture.kind === 'arrow') {
      const ends = gesture.moves === 'end' ? { start: gesture.fixed, end: point } : { start: point, end: gesture.fixed }
      const { length, ...placed } = arrowBetween(ends.start, ends.end, item.transform)
      const moveArrow = edit(item, placed)
      store.update((current) => setArrowStyle(moveArrow(current), [item.clipId], { length }))
    } else if (gesture.kind === 'tail') {
      const tip = canvasPointToClip(item.transform, point)
      const tail = { x: Math.round(tip.x), y: Math.round(tip.y) }
      store.update((current) => setCalloutStyle(current, [item.clipId], { tail }))
    } else if (gesture.kind === 'rotate') {
      const rotation = rotationFromPointer(item.box, gesture.from, point, event.shiftKey)
      let placed: Partial<Transform> = { rotation }
      if (item.kind === 'group') placed = { ...placeFor(item, middle, { ...item.transform, rotation }), rotation }
      store.update(edit(item, placed))
    } else if (gesture.kind === 'crop') {
      const { crop, transform } = cropFromHandle(item.natural, item.crop, item.transform, gesture.handle, point)
      const cropValues = { cropLeft: crop.left, cropTop: crop.top, cropRight: crop.right, cropBottom: crop.bottom }
      store.update(edit(item, { x: transform.x, y: transform.y }, cropValues))
    } else {
      const targets = range === undefined ? undefined : sizeTargets(item, gesture.others, canvas, range)
      const keepsAspect = scalesEvenly(item) || !event.shiftKey
      const pivoted = { ...item.transform, ...middle }
      const { transform, isSnapped } = scaleFromHandle(item.natural, item.crop, pivoted, gesture.handle, point, keepsAspect, targets)
      setGuides({ x: undefined, y: undefined, isSizeSnapped: isSnapped, isOnArtboard: false })
      const placed = { ...placeFor(item, transform, transform), scaleX: transform.scaleX, scaleY: transform.scaleY }
      store.update(edit(item, placed))
    }
  }

  function endGesture(finish: () => void): void {
    if (gestureRef.current === undefined) return
    gestureRef.current = undefined
    setGuides(NO_GUIDES)
    setMarquee(undefined)
    finish()
  }

  function onPointerUp(event: PointerEvent<SVGSVGElement>): void {
    const gesture = gestureRef.current
    endGesture(store.commit)
    if (gesture?.kind === 'marquee') endMarquee(gesture.from, pointOf(event), gesture.isAdding)
    else if (gesture?.kind === 'pen' && gesture.isClosing) endPath(true)
    else if (gesture?.kind === 'draw') selectDrawn(gesture.shapeId)
  }

  // Squares for nodes, with lines out to dots for the handles of the chosen ones.
  function nodeMarks(shapeIndex: number, shapeId: string, nodes: readonly ShapeNode[], chosen: ReadonlySet<number>): ReactElement[] {
    const size = NODE_PIXELS * canvasPerPixel
    const marks: ReactElement[] = []
    for (const [index, node] of nodes.entries()) {
      const at = placeOnCanvas(node)
      const isChosen = chosen.has(index)
      for (const side of isChosen ? HANDLE_SIDES : []) {
        const handle = node[side]
        if (handle === undefined) continue
        const end = placeOnCanvas({ x: node.x + handle.x, y: node.y + handle.y })
        marks.push(<line key={`${side}-line-${index}`} className="node-handle-line" x1={at.x} y1={at.y} x2={end.x} y2={end.y} />)
        marks.push(
          <circle
            key={`${side}-${index}`}
            className="canvas-handle"
            data-handle={`node-${side}`}
            data-shape={shapeIndex}
            data-node={index}
            data-testid={`node-${side}-${shapeId}-${index}`}
            cx={end.x}
            cy={end.y}
            r={size / 2}
          />,
        )
      }
      marks.push(
        <rect
          key={`node-${index}`}
          className={isChosen ? 'canvas-handle chosen' : 'canvas-handle'}
          data-handle="node"
          data-shape={shapeIndex}
          data-node={index}
          data-testid={`node-${shapeId}-${index}`}
          x={at.x - size / 2}
          y={at.y - size / 2}
          width={size}
          height={size}
        />,
      )
    }
    return marks
  }

  function chosenIndexesOf(drawn: DrawnShape): Set<number> {
    const indexes = new Set<number>()
    for (const node of selectedNodes) {
      if (node.clipId === drawn.clipId && node.shapeId === drawn.shape.id) indexes.add(node.index)
    }
    return indexes
  }

  const handleSize = HANDLE_PIXELS * canvasPerPixel
  const minBox = MIN_BOX_PIXELS * canvasPerPixel
  const ghostPath = setDrawing === undefined || selectedSet === undefined ? undefined : ghostOf(setDrawing, selectedSet.setId, time - setDrawing.start)
  const onions = isOnionSkinOn && isInAnimation && !isPlaying ? onionsOf(project, targetTrackIndex(project, selection, selectedShapes), time) : []
  const pivotReach = PIVOT_PIXELS * canvasPerPixel
  const turnReach = SET_ROTATE_PIXELS * canvasPerPixel
  const artboardTransform = `translate(${openFrame.x} ${openFrame.y}) rotate(${openFrame.rotation}) scale(${openFrame.scale})`
  const guideArea = guides.isOnArtboard ? project.canvas : canvas
  const lastPenNode = pen?.nodes.at(-1)
  const dropTarget = shown.find((item) => item.clipId === dropTargetId)
  const shownLine = path?.line.map(shownOnPath)
  const shownDots = path?.dots.map((dot) => shownOnPath(dot.point)) ?? []
  const viewLeft = frame.left - reach.left * canvasPerPixel
  const viewTop = frame.top - reach.top * canvasPerPixel
  const viewWidth = frame.width + (reach.left + reach.right) * canvasPerPixel
  const viewHeight = frame.height + (reach.top + reach.bottom) * canvasPerPixel

  return (
    <svg
      ref={svgRef}
      className={isDrawingTool ? 'canvas-overlay drawing' : 'canvas-overlay'}
      viewBox={`${viewLeft} ${viewTop} ${viewWidth} ${viewHeight}`}
      preserveAspectRatio="none"
      style={{ left: -reach.left, top: -reach.top, width: `calc(100% + ${reach.left + reach.right}px)`, height: `calc(100% + ${reach.top + reach.bottom}px)` }}
      data-testid="canvas-overlay"
      data-selected={selected.length}
      data-selected-shapes={selectedShapes.length}
      data-outside={outside.length}
      data-selected-nodes={selectedNodes.length}
      data-drop-target={dropTargetId}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => {
        setFillTarget(undefined)
        setPenPointer(undefined)
        if (gestureRef.current === undefined) setGuides(NO_GUIDES)
      }}
      onPointerCancel={() => endGesture(store.cancel)}
      onLostPointerCapture={() => endGesture(store.cancel)}
    >
      {onions.length > 0 && (
        <g transform={artboardTransform} data-testid="onion-skin">
          {onions.map((onion) => (
            <path key={onion.clipId} className={`onion ${onion.side}`} opacity={ONION_OPACITIES[onion.distance]} data-testid={`onion-${onion.side}-${onion.distance}`} d={onion.path} />
          ))}
        </g>
      )}
      <g transform={guides.isOnArtboard ? artboardTransform : undefined}>
        {guides.x !== undefined && <line className="snap-guide" x1={guides.x} y1={0} x2={guides.x} y2={guideArea.height} />}
        {guides.y !== undefined && <line className="snap-guide" x1={0} y1={guides.y} x2={guideArea.width} y2={guides.y} />}
      </g>
      {dropTarget !== undefined && (
        <g transform={`translate(${dropTarget.box.centerX} ${dropTarget.box.centerY}) rotate(${dropTarget.box.rotation})`}>
          <rect className="selection-box" x={-dropTarget.box.width / 2} y={-dropTarget.box.height / 2} width={dropTarget.box.width} height={dropTarget.box.height} />
        </g>
      )}
      {fillTarget !== undefined && tool === 'fill' && (
        <g transform={artboardTransform}>
          <path className="selection-box" data-testid="fill-target" data-shape={fillTarget.shape.id} d={svgPathOf(fillTarget.shape)} />
        </g>
      )}
      {nodeShapes.map((drawn, shapeIndex) => (
        <g key={`${drawn.clipId}/${drawn.shape.id}`} data-testid={`nodes-${drawn.shape.id}`}>
          <g transform={artboardTransform}>
            <path className="selection-box" d={svgPathOf(drawn.shape)} />
          </g>
          {nodeMarks(shapeIndex, drawn.shape.id, drawn.shape.nodes, chosenIndexesOf(drawn))}
        </g>
      ))}
      {ghostPath !== undefined && (
        <g transform={artboardTransform}>
          <path className="set-ghost" data-testid="set-ghost" d={ghostPath} />
        </g>
      )}
      {pivotOnCanvas !== undefined && (
        <g data-testid="set-handles">
          <line className="node-handle-line" x1={pivotOnCanvas.x} y1={pivotOnCanvas.y} x2={pivotOnCanvas.x + turnDirection.x * turnReach} y2={pivotOnCanvas.y + turnDirection.y * turnReach} />
          <circle
            className="canvas-handle rotate"
            data-handle="set-turn"
            data-testid="set-turn"
            cx={pivotOnCanvas.x + turnDirection.x * turnReach}
            cy={pivotOnCanvas.y + turnDirection.y * turnReach}
            r={handleSize / 2}
          />
          <line className="node-handle-line" x1={pivotOnCanvas.x - pivotReach} y1={pivotOnCanvas.y} x2={pivotOnCanvas.x + pivotReach} y2={pivotOnCanvas.y} />
          <line className="node-handle-line" x1={pivotOnCanvas.x} y1={pivotOnCanvas.y - pivotReach} x2={pivotOnCanvas.x} y2={pivotOnCanvas.y + pivotReach} />
          <circle className="canvas-handle pivot" data-handle="set-pivot" data-testid="set-pivot" cx={pivotOnCanvas.x} cy={pivotOnCanvas.y} r={pivotReach / 2} />
        </g>
      )}
      {pen !== undefined && (
        <g data-testid="pen-path" data-nodes={pen.nodes.length}>
          <g transform={artboardTransform}>
            <path className="selection-box" d={svgPathOf({ id: pen.shapeId, nodes: [...pen.nodes] })} />
            {lastPenNode !== undefined && penPointer !== undefined && (
              <path className="selection-box preview" data-testid="pen-preview" d={svgPathOf({ id: 'next', nodes: [lastPenNode, penPointer] })} />
            )}
          </g>
          {nodeMarks(0, pen.shapeId, pen.nodes, new Set([pen.nodes.length - 1]))}
        </g>
      )}
      {marquee !== undefined && (
        <rect className="selection-box preview" data-testid="marquee" x={marquee.left} y={marquee.top} width={marquee.right - marquee.left} height={marquee.bottom - marquee.top} />
      )}
      {outside.map((item) => (
        <g key={item.clipId} transform={`translate(${item.box.centerX} ${item.box.centerY}) rotate(${item.box.rotation})`}>
          <rect className="outside-box" x={-item.box.width / 2} y={-item.box.height / 2} width={item.box.width} height={item.box.height} />
        </g>
      ))}
      {shownLine !== undefined && (
        <g data-testid="motion-path" data-dots={shownDots.length}>
          <polyline className="motion-path" points={shownLine.map((at) => `${at.x},${at.y}`).join(' ')} />
          {shownDots.map((at, index) => (
            <circle
              key={index}
              className="canvas-handle path-point"
              data-handle="path-point"
              data-dot={index}
              data-testid={`path-point-${index}`}
              cx={at.x}
              cy={at.y}
              r={(PATH_DOT_PIXELS * canvasPerPixel) / 2}
            />
          ))}
        </g>
      )}
      {selected.map((item) => {
        const width = Math.max(minBox, item.box.width)
        const height = Math.max(minBox, item.box.height)
        const isEdited = item.clipId === editedText?.id
        const isOnly = item === only && !isEdited
        const isArrow = item.arrowLength !== undefined
        const handles = scalesEvenly(item) ? HANDLES.filter(isCorner) : HANDLES
        const rotateReach = Math.min(ROTATE_HANDLE_OFFSET_PIXELS * canvasPerPixel, height * ROTATE_HANDLE_MAX_REACH)
        return (
          <g key={item.clipId} transform={`translate(${item.box.centerX} ${item.box.centerY}) rotate(${item.box.rotation})`}>
            <rect className={guides.isSizeSnapped ? 'selection-box snapped' : 'selection-box'} x={-width / 2} y={-height / 2} width={width} height={height} />
            {isEdited && editedText !== undefined && (
              <g transform={`scale(${item.transform.scaleX} ${item.transform.scaleY})`}>
                <TextEditor key={editedText.id} clip={editedText} />
              </g>
            )}
            {isOnly && isArrow && <circle className="canvas-handle end" data-handle="arrow-start" data-testid="handle-arrow-start" cx={-item.box.width / 2} cy={0} r={handleSize / 2} />}
            {isOnly && isArrow && <circle className="canvas-handle end" data-handle="arrow-end" data-testid="handle-arrow-end" cx={item.box.width / 2} cy={0} r={handleSize / 2} />}
            {isOnly && item.tail !== undefined && (
              <circle className="canvas-handle end" data-handle="tail" data-testid="handle-tail" cx={item.tail.x * item.transform.scaleX} cy={item.tail.y * item.transform.scaleY} r={handleSize / 2} />
            )}
            {isOnly && !isArrow && <line className="selection-box" x1={0} y1={0} x2={0} y2={-rotateReach} />}
            {isOnly && !isArrow && <circle className="canvas-handle rotate" data-handle="rotate" data-testid="handle-rotate" cx={0} cy={-rotateReach} r={handleSize / 2} />}
            {isOnly &&
              !isArrow &&
              handles.map((handle) => {
                const direction = handleDirection(handle)
                return (
                  <rect
                    key={handle}
                    className={`canvas-handle ${handle}`}
                    data-handle={handle}
                    data-testid={`handle-${handle}`}
                    x={(direction.x * width) / 2 - handleSize / 2}
                    y={(direction.y * height) / 2 - handleSize / 2}
                    width={handleSize}
                    height={handleSize}
                  />
                )
              })}
          </g>
        )
      })}
    </svg>
  )
}
