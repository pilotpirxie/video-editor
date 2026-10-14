import { useEffect, useEffectEvent, useRef, useState, type MouseEvent, type PointerEvent, type ReactElement, type RefObject } from 'react'
import { arrowBetween, arrowEnds, intoClip, outOfClip, setArrowStyle, setCalloutStyle } from '../editor/annotations.js'
import { frameOf, type ZoomFrame } from '../editor/camera.js'
import { locateClip } from '../editor/clips.js'
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
import { intoGroup } from '../editor/groups.js'
import { motionPath, propertyAt, setProperties, type PropertyValues } from '../editor/properties.js'
import { positionTargets, snapPosition, type Bounds } from '../editor/snapping.js'
import { arrowSize } from '../engine/annotations.js'
import { viewAt } from '../engine/camera.js'
import { groupFrameAt, onCanvas, resolveFrame, type GroupFrame, type Layer, type MediaStates } from '../engine/resolve.js'
import { measureText } from '../engine/text.js'
import type { Size } from '../shared/exportPresets.js'
import type { Crop, GroupClip, Project, Transform } from '../shared/project.js'
import { useEditorState, usePosition, useSession } from './context.js'
import type { Edit } from './store.js'
import { TextEditor } from './TextEditor.js'
import { LIBRARY_DRAG_EVENT, LIBRARY_DROP_EVENT, isLibraryDrag, type LibraryDragDetail } from './timelineController.js'

const NO_CROP: Crop = { left: 0, top: 0, right: 0, bottom: 0 }
const SNAP_RANGE_PIXELS = 8
const HANDLE_PIXELS = 10
const PATH_DOT_PIXELS = 8
const ROTATE_HANDLE_OFFSET_PIXELS = 26
const ROTATE_HANDLE_MAX_REACH = 0.35
const MIN_BOX_PIXELS = 6
// The overlay reaches this far past the picture on every side, so the handles of a clip that fills the canvas are whole and can be grabbed. Must match the CSS.
export const MARGIN_PIXELS = 14

const CORNERS = ['nw', 'ne', 'se', 'sw'] as const
const TRANSFORM_KEYS = ['x', 'y', 'scaleX', 'scaleY', 'rotation'] as const
const NO_PIVOT: Point = { x: 0, y: 0 }

// One clip of the open tracks as it is drawn, with everything the handles need to change it. A closed group is one of them, whatever it has inside.
type Shown = {
  clipId: string
  // A picture is a video or an image, which can be cropped; a shape is a blur or a highlight, which has no picture for an effect to change.
  kind: 'picture' | 'text' | 'callout' | 'arrow' | 'shape' | 'group'
  natural: Size
  crop: Crop
  // The transform of the clip as seen from the canvas, also when the clip lies inside an open group.
  transform: Transform
  box: Box
  // What a press must hit to grab the clip: its box, or the box of any member of a group.
  hitBoxes: readonly Box[]
  // From the place of the clip to the middle of its box, in the clip's own units. Only a group has its box elsewhere than around its place.
  pivot: Point
  arrowLength?: number
  // The tip of a bubble's tail, in the callout's own units from its middle.
  tail?: Point
}

type Gesture =
  | { kind: 'move'; from: Point; items: readonly Shown[]; others: readonly Bounds[] }
  | { kind: 'scale' | 'crop'; item: Shown; handle: Handle; others: readonly Shown[] }
  | { kind: 'rotate'; item: Shown; from: Point }
  | { kind: 'arrow'; item: Shown; moves: 'start' | 'end'; fixed: Point }
  | { kind: 'tail'; item: Shown }
  // A dot of the motion path: the position keyframe at `time` of the open tracks, which was at `start` on the canvas.
  | { kind: 'path'; item: Shown; time: number; from: Point; start: Point }

type Guides = {
  x: number | undefined
  y: number | undefined
  isSizeSnapped: boolean
}

const NO_GUIDES: Guides = { x: undefined, y: undefined, isSizeSnapped: false }

function naturalSize(layer: Layer): Size {
  if (layer.kind === 'video') return { width: layer.video.width, height: layer.video.height }
  if (layer.kind === 'arrow') return arrowSize(layer.look)
  if (layer.kind === 'callout') return { width: layer.look.width, height: layer.look.height }
  if (layer.kind !== 'text') return { width: layer.width, height: layer.height }
  const measured = measureText(layer.look)
  return { width: measured.naturalWidth, height: measured.naturalHeight }
}

function shownLayer(layer: Layer): Shown {
  const natural = naturalSize(layer)
  const crop = layer.kind === 'video' || layer.kind === 'image' ? layer.crop : NO_CROP
  const box = boxOf(natural, crop, layer.transform)
  let kind: Shown['kind'] = 'picture'
  if (layer.kind === 'text' || layer.kind === 'callout' || layer.kind === 'arrow') kind = layer.kind
  if (layer.kind === 'blur' || layer.kind === 'highlight') kind = 'shape'
  const shown: Shown = { clipId: layer.clipId, kind, natural, crop, transform: layer.transform, box, hitBoxes: [box], pivot: NO_PIVOT }
  if (layer.kind === 'arrow') shown.arrowLength = layer.look.length
  if (layer.kind === 'callout' && layer.look.tail !== undefined) shown.tail = layer.look.tail
  return shown
}

// A closed group is grabbed by any of its members and outlined by the box around them all, turned as the group is.
function shownGroup(group: GroupClip, members: readonly Shown[], transform: Transform): Shown {
  const xs: number[] = []
  const ys: number[] = []
  for (const member of members) {
    for (const corner of CORNERS) {
      const inside = intoClip(transform, handlePosition(member.box, corner))
      xs.push(inside.x)
      ys.push(inside.y)
    }
  }
  const natural = { width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) }
  const pivot = { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 }
  const middle = outOfClip(transform, pivot)
  const box: Box = { centerX: middle.x, centerY: middle.y, width: natural.width * transform.scaleX, height: natural.height * transform.scaleY, rotation: transform.rotation }
  return { clipId: group.id, kind: 'group', natural, crop: NO_CROP, transform, box, hitBoxes: members.map((member) => member.box), pivot }
}

type Open = {
  // The tracks that are open, in their own time, and the moment of it the playhead is on.
  project: Project
  time: number
  groups: readonly string[]
  // How the innermost open group places its members on the canvas.
  frame: GroupFrame
}

// The clips of the open tracks at the playhead, bottom first, placed exactly where the compositor draws them.
// What lies outside the open group is drawn but cannot be grabbed, so it is not among them.
function shownClips(wholeProject: Project, mediaStates: MediaStates, wholeTime: number, open: Open): Shown[] {
  // Bottom first: a clip as it is shown, or the id of a closed group at the place of its lowest member.
  const order: (Shown | string)[] = []
  const membersOf = new Map<string, Shown[]>()
  for (const layer of resolveFrame(wholeProject, mediaStates, wholeTime, 1)) {
    const path = layer.groups ?? []
    if (!open.groups.every((groupId, depth) => path[depth] === groupId)) continue
    const closedGroupId = path[open.groups.length]
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

  const shown: Shown[] = []
  for (const entry of order) {
    if (typeof entry !== 'string') {
      shown.push(entry)
      continue
    }
    const group = locateClip(open.project, entry)?.clip
    const members = membersOf.get(entry)
    if (group?.type !== 'group' || members === undefined) continue
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

// How wide the picture is on screen, in CSS pixels; the overlay around it is wider by its margin on both sides.
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

// The point of the canvas under a place in the window, when the picture shows `frame` of the canvas.
export function pointOnCanvas(place: { clientX: number; clientY: number }, overlay: Element, frame: ZoomFrame, pictureWidth: number): Point {
  const box = overlay.getBoundingClientRect()
  const canvasPerPixel = frame.width / pictureWidth
  return { x: frame.left + (place.clientX - box.left - MARGIN_PIXELS) * canvasPerPixel, y: frame.top + (place.clientY - box.top - MARGIN_PIXELS) * canvasPerPixel }
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

// The place a clip must have for the middle of its box to be at `middle`, when it is scaled and turned as `transform` says.
function placeFor(item: Shown, middle: Point, transform: Transform): Point {
  const toMiddle = outOfClip({ ...transform, x: 0, y: 0 }, item.pivot)
  return { x: middle.x - toMiddle.x, y: middle.y - toMiddle.y }
}

function sizeTargets(item: Shown, others: readonly Shown[], canvas: Size, range: number): SizeTargets {
  const fullWidth = item.natural.width - item.crop.left - item.crop.right
  const fullHeight = item.natural.height - item.crop.top - item.crop.bottom
  return {
    widths: [fullWidth, canvas.width, ...others.map((other) => other.box.width)],
    heights: [fullHeight, canvas.height, ...others.map((other) => other.box.height)],
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

// Selection outlines and handles over the preview. It is a layer of its own above the picture, so nothing here can end up in an export.
export function CanvasOverlay({ isCropping }: { isCropping: boolean }): ReactElement {
  const { store, actions } = useSession()
  const project = useEditorState((state) => state.project)
  const wholeProject = useEditorState((state) => state.wholeProject)
  const openGroups = useEditorState((state) => state.openGroups)
  const offset = useEditorState((state) => state.scope?.offset ?? 0)
  const mediaStates = useEditorState((state) => state.mediaStates)
  const selection = useEditorState((state) => state.selection)
  const editingTextId = useEditorState((state) => state.editingTextId)
  const isPlaying = usePosition((position) => position.isPlaying)
  const time = usePosition((position) => position.time)
  const svgRef = useRef<SVGSVGElement>(null)
  const gestureRef = useRef<Gesture | undefined>(undefined)
  const pictureWidth = usePictureWidth(svgRef)
  const [guides, setGuides] = useState<Guides>(NO_GUIDES)
  const [dropTargetId, setDropTargetId] = useState<string | undefined>(undefined)
  const { canvas } = project
  // The picture shows what the camera shows, so the handles are laid over that part of the canvas.
  // The camera and the picture are those of the whole project, at its own time, also while a group is open.
  const wholeTime = time + offset
  const frame = frameOf(canvas, viewAt(wholeProject.camera, wholeTime, canvas))
  const canvasPerPixel = frame.width / pictureWidth
  const openFrame = groupFrameAt(wholeProject, openGroups, wholeTime)

  const shown = isPlaying ? [] : shownClips(wholeProject, mediaStates, wholeTime, { project, time, groups: openGroups, frame: openFrame })
  const selected = shown.filter((item) => selection.includes(item.clipId))
  const [only] = selected.length === 1 ? selected : []
  const editing = editingTextId === undefined ? undefined : locateClip(project, editingTextId)?.clip
  const editedText = editing?.type === 'text' || editing?.type === 'callout' ? editing : undefined
  const onlyClip = only === undefined || editingTextId !== undefined ? undefined : locateClip(project, only.clipId)?.clip
  const path = onlyClip === undefined ? undefined : motionPath(onlyClip)
  // The path is that of the clip's place; a closed group's box lies off its place, so the path is drawn moved by as much.
  const pathOffset = only === undefined ? NO_PIVOT : { x: only.box.centerX - only.transform.x, y: only.box.centerY - only.transform.y }

  // Where a place in the open tracks is on the canvas.
  function placeOnCanvas(place: Point): Point {
    const placed = onCanvas(openFrame, { x: place.x, y: place.y, scaleX: 1, scaleY: 1, rotation: 0 })
    return { x: placed.x, y: placed.y }
  }

  function shownOnPath(place: Point): Point {
    const at = placeOnCanvas(place)
    return { x: at.x + pathOffset.x, y: at.y + pathOffset.y }
  }

  function pointOf(event: MouseEvent<SVGSVGElement>): Point {
    return pointOnCanvas(event, event.currentTarget, frame, pictureWidth)
  }

  function topmostAt(point: Point): Shown | undefined {
    const locked = lockedClipIds(project)
    return shown.findLast((item) => !locked.has(item.clipId) && item.hitBoxes.some((box) => containsPoint(box, point)))
  }

  // The clip an effect held at a place in the window would go to: the topmost one there that has a picture.
  function effectTargetAt(detail: LibraryDragDetail): Shown | undefined {
    const svg = svgRef.current
    if (svg === null || detail.item.kind !== 'effect') return undefined
    const point = pointOnCanvas(detail, svg, frame, pictureWidth)
    const locked = lockedClipIds(project)
    return shown.findLast((item) => item.kind !== 'shape' && !locked.has(item.clipId) && item.hitBoxes.some((box) => containsPoint(box, point)))
  }

  // Heard for every move of a drag out of the library, wherever in the window it is: one that has left the canvas no longer has a target here.
  const onLibraryDrag = useEffectEvent((event: Event) => {
    if (!isLibraryDrag(event)) return
    const isOverCanvas = event.target instanceof Node && svgRef.current?.contains(event.target) === true
    setDropTargetId(isOverCanvas ? effectTargetAt(event.detail)?.clipId : undefined)
  })

  const onLibraryDrop = useEffectEvent((event: Event) => {
    if (!isLibraryDrag(event)) return
    const svg = svgRef.current
    const { item } = event.detail
    // An annotation lands where it was dropped, at the playhead; inside an open group the place is worked out in the group's own space.
    if (item.kind === 'annotation' && svg !== null) {
      const point = pointOnCanvas(event.detail, svg, frame, pictureWidth)
      const inside = intoGroup(openFrame, { x: point.x, y: point.y, scaleX: 1, scaleY: 1, rotation: 0 })
      actions.addAnnotation(item.annotation, { x: Math.round(inside.x), y: Math.round(inside.y) })
      return
    }
    if (item.kind !== 'effect') return
    const target = effectTargetAt(event.detail)
    if (target === undefined) return
    const { effect } = item
    // An effect dropped on one of several selected clips goes to all of them.
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

  function onPointerDown(event: PointerEvent<SVGSVGElement>): void {
    // A press inside the text being typed places the caret; it is not the start of a drag.
    if (event.button !== 0 || isPlaying || isInTextEditor(event.target)) return
    event.currentTarget.setPointerCapture(event.pointerId)
    const point = pointOf(event)
    const grabbed = event.target instanceof SVGElement ? event.target.dataset.handle : undefined

    if (only?.arrowLength !== undefined && (grabbed === 'arrow-start' || grabbed === 'arrow-end')) {
      const ends = arrowEnds(only.transform, only.arrowLength)
      store.begin('Move Arrow End')
      gestureRef.current = grabbed === 'arrow-end' ? { kind: 'arrow', item: only, moves: 'end', fixed: ends.start } : { kind: 'arrow', item: only, moves: 'start', fixed: ends.end }
      return
    }
    if (only !== undefined && grabbed === 'tail') {
      store.begin('Move Callout Tail')
      gestureRef.current = { kind: 'tail', item: only }
      return
    }
    const dot = grabbed === 'path-point' && event.target instanceof SVGElement ? path?.dots[Number(event.target.dataset.dot)] : undefined
    // A dot under the middle of the clip is a press on the clip: moving the clip is what keys the moment of the playhead, and for a keyframe at the playhead the two are the same.
    const dotAt = dot === undefined ? undefined : shownOnPath(dot.point)
    const isUnderClip = only !== undefined && dotAt !== undefined && Math.hypot(dotAt.x - only.box.centerX, dotAt.y - only.box.centerY) < PATH_DOT_PIXELS * canvasPerPixel
    if (only !== undefined && onlyClip !== undefined && dot !== undefined && !isUnderClip) {
      store.begin('Move Position Keyframe')
      gestureRef.current = { kind: 'path', item: only, time: onlyClip.start + dot.time, from: point, start: placeOnCanvas(dot.point) }
      return
    }
    if (only !== undefined && grabbed === 'rotate') {
      store.begin('Rotate Clip')
      gestureRef.current = { kind: 'rotate', item: only, from: point }
      return
    }
    if (only !== undefined && isHandle(grabbed)) {
      const kind = only.kind === 'picture' && (isCropping || event.altKey) ? 'crop' : 'scale'
      store.begin(kind === 'crop' ? 'Crop Clip' : 'Resize Clip')
      gestureRef.current = { kind, item: only, handle: grabbed, others: shown.filter((item) => item !== only) }
      return
    }

    const hit = topmostAt(point)
    if (hit === undefined) {
      store.select([])
      return
    }
    const isSelected = selection.includes(hit.clipId)
    let moving = selection
    if (event.shiftKey) moving = isSelected ? selection.filter((id) => id !== hit.clipId) : [...selection, hit.clipId]
    else if (!isSelected) moving = [hit.clipId]
    if (moving !== selection) store.select(moving)

    const items = shown.filter((item) => moving.includes(item.clipId))
    if (items.length === 0) return
    const others = shown.filter((item) => !moving.includes(item.clipId)).map((item) => boundsOf(item.box))
    store.begin(items.length === 1 ? 'Move Clip' : 'Move Clips')
    gestureRef.current = { kind: 'move', from: point, items, others }
  }

  function onDoubleClick(event: MouseEvent<SVGSVGElement>): void {
    if (isPlaying || isInTextEditor(event.target)) return
    const hit = topmostAt(pointOf(event))
    if (hit === undefined) return
    store.select([hit.clipId])
    if (hit.kind === 'text' || hit.kind === 'callout') store.editText(hit.clipId)
    if (hit.kind === 'group') actions.openGroup()
  }

  function snapRange(event: PointerEvent<SVGSVGElement>): number | undefined {
    return store.getState().isSnapping && !event.metaKey ? SNAP_RANGE_PIXELS * canvasPerPixel : undefined
  }

  // The values a clip needs to be drawn on the canvas as `placed` says. Inside an open group they are counted from that group.
  function valuesFor(item: Shown, placed: Partial<Transform>): PropertyValues {
    if (openGroups.length === 0) return placed
    const inside = intoGroup(openFrame, { ...item.transform, ...placed })
    const values: PropertyValues = {}
    for (const key of TRANSFORM_KEYS) {
      if (placed[key] !== undefined) values[key] = inside[key]
    }
    return values
  }

  function edit(item: Shown, placed: Partial<Transform>, crop: PropertyValues = {}): Edit {
    const values = { ...valuesFor(item, placed), ...crop }
    return (current) => setProperties(current, [item.clipId], values, time)
  }

  function onPointerMove(event: PointerEvent<SVGSVGElement>): void {
    const gesture = gestureRef.current
    if (gesture === undefined) return
    const point = pointOf(event)
    const range = snapRange(event)

    if (gesture.kind === 'move') {
      let dx = point.x - gesture.from.x
      let dy = point.y - gesture.from.y
      let shownGuides = NO_GUIDES
      if (range !== undefined) {
        const moving = unionOf(gesture.items.map((item) => boundsOf(item.box)))
        const snapped = snapPosition(moving, dx, dy, positionTargets(gesture.others, canvas), range)
        dx = snapped.x.delta
        dy = snapped.y.delta
        shownGuides = { x: snapped.x.guide, y: snapped.y.guide, isSizeSnapped: false }
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
      store.update((current) => setProperties(current, [item.clipId], valuesFor(item, placed), keyTime))
      return
    }

    const { item } = gesture
    const middle = { x: item.box.centerX, y: item.box.centerY }
    if (gesture.kind === 'arrow') {
      const ends = gesture.moves === 'end' ? { start: gesture.fixed, end: point } : { start: point, end: gesture.fixed }
      const { length, ...placed } = arrowBetween(ends.start, ends.end, item.transform)
      store.update((current) => setArrowStyle(edit(item, placed)(current), [item.clipId], { length }))
    } else if (gesture.kind === 'tail') {
      const tip = intoClip(item.transform, point)
      store.update((current) => setCalloutStyle(current, [item.clipId], { tail: { x: Math.round(tip.x), y: Math.round(tip.y) } }))
    } else if (gesture.kind === 'rotate') {
      const rotation = rotationFromPointer(item.box, gesture.from, point, event.shiftKey)
      // A group turns around its own place, which is not the middle of its box; it is moved so that the box turns in place.
      const placed = item.kind === 'group' ? { ...placeFor(item, middle, { ...item.transform, rotation }), rotation } : { rotation }
      store.update(edit(item, placed))
    } else if (gesture.kind === 'crop') {
      const { crop, transform } = cropFromHandle(item.natural, item.crop, item.transform, gesture.handle, point)
      store.update(edit(item, { x: transform.x, y: transform.y }, { cropLeft: crop.left, cropTop: crop.top, cropRight: crop.right, cropBottom: crop.bottom }))
    } else {
      const targets = range === undefined ? undefined : sizeTargets(item, gesture.others, canvas, range)
      // A group is scaled by one number, so it always keeps its shape.
      const keepsAspect = item.kind === 'group' || !event.shiftKey
      const { transform, isSnapped } = scaleFromHandle(item.natural, item.crop, { ...item.transform, ...middle }, gesture.handle, point, keepsAspect, targets)
      setGuides({ x: undefined, y: undefined, isSizeSnapped: isSnapped })
      store.update(edit(item, { ...placeFor(item, transform, transform), scaleX: transform.scaleX, scaleY: transform.scaleY }))
    }
  }

  function endGesture(finish: () => void): void {
    if (gestureRef.current === undefined) return
    gestureRef.current = undefined
    setGuides(NO_GUIDES)
    finish()
  }

  const handleSize = HANDLE_PIXELS * canvasPerPixel
  const minBox = MIN_BOX_PIXELS * canvasPerPixel
  const margin = MARGIN_PIXELS * canvasPerPixel
  const dropTarget = shown.find((item) => item.clipId === dropTargetId)
  const shownLine = path?.line.map(shownOnPath)
  const shownDots = path?.dots.map((dot) => shownOnPath(dot.point)) ?? []

  return (
    <svg
      ref={svgRef}
      className="canvas-overlay"
      viewBox={`${frame.left - margin} ${frame.top - margin} ${frame.width + 2 * margin} ${frame.height + 2 * margin}`}
      preserveAspectRatio="none"
      data-testid="canvas-overlay"
      data-selected={selected.length}
      data-drop-target={dropTargetId}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      onPointerMove={onPointerMove}
      onPointerUp={() => endGesture(store.commit)}
      onPointerCancel={() => endGesture(store.cancel)}
      onLostPointerCapture={() => endGesture(store.cancel)}
    >
      {guides.x !== undefined && <line className="snap-guide" x1={guides.x} y1={0} x2={guides.x} y2={canvas.height} />}
      {guides.y !== undefined && <line className="snap-guide" x1={0} y1={guides.y} x2={canvas.width} y2={guides.y} />}
      {dropTarget !== undefined && (
        <g transform={`translate(${dropTarget.box.centerX} ${dropTarget.box.centerY}) rotate(${dropTarget.box.rotation})`}>
          <rect className="selection-box" x={-dropTarget.box.width / 2} y={-dropTarget.box.height / 2} width={dropTarget.box.width} height={dropTarget.box.height} />
        </g>
      )}
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
        // An arrow is changed by its two ends, which also turn it; a group by its corners, because it keeps its shape.
        const isArrow = item.arrowLength !== undefined
        const handles = item.kind === 'group' ? HANDLES.filter(isCorner) : HANDLES
        // As in Camtasia the rotate handle sits inside the clip, above its centre: it stays reachable when the clip fills the canvas.
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
