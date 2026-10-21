import { useEffect, useEffectEvent, useRef, useState, type MouseEvent, type PointerEvent, type ReactElement, type RefObject } from 'react'
import { arrowBetween, arrowEnds, canvasPointToClip, clipPointToCanvas, setArrowStyle, setCalloutStyle } from '../editor/annotations.js'
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
const HANDLE_PIXELS = 10
const PATH_DOT_PIXELS = 8
const ROTATE_HANDLE_OFFSET_PIXELS = 26
const ROTATE_HANDLE_MAX_REACH = 0.35
const MIN_BOX_PIXELS = 6
// The overlay reaches at least this far past the picture on every side, so the handles of a clip that fills the canvas are whole and can be grabbed. Must match the CSS.
export const MARGIN_PIXELS = 14
const EDGE_TOLERANCE_CANVAS_PIXELS = 0.5

const CORNERS = ['nw', 'ne', 'se', 'sw'] as const
const TRANSFORM_KEYS = ['x', 'y', 'scaleX', 'scaleY', 'rotation'] as const
const NO_PIVOT: Point = { x: 0, y: 0 }

type ShownClip = {
  clipId: string
  kind: 'picture' | 'text' | 'callout' | 'arrow' | 'shape' | 'group'
  natural: Size
  crop: Crop
  transform: Transform
  box: Box
  hitBoxes: readonly Box[]
  pivot: Point
  arrowLength?: number
  tail?: Point
}

type Gesture =
  | { kind: 'move'; from: Point; items: readonly ShownClip[]; others: readonly Bounds[] }
  | { kind: 'scale' | 'crop'; item: ShownClip; handle: Handle; others: readonly ShownClip[] }
  | { kind: 'rotate'; item: ShownClip; from: Point }
  | { kind: 'arrow'; item: ShownClip; moves: 'start' | 'end'; fixed: Point }
  | { kind: 'tail'; item: ShownClip }
  | { kind: 'path'; item: ShownClip; time: number; from: Point; start: Point }

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

function shownGroup(group: GroupClip, members: readonly ShownClip[], transform: Transform): ShownClip {
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

type Open = {
  project: Project
  time: number
  groups: readonly string[]
  frame: GroupFrame
}

function shownClips(wholeProject: Project, mediaStates: MediaStates, wholeTime: number, open: Open): ShownClip[] {
  const order: (ShownClip | string)[] = []
  const membersOf = new Map<string, ShownClip[]>()
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

  const shown: ShownClip[] = []
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

function valuesInOpenTracks(openGroups: readonly string[], openFrame: GroupFrame, item: ShownClip, placed: Partial<Transform>): PropertyValues {
  if (openGroups.length === 0) return placed
  const inside = intoGroup(openFrame, { ...item.transform, ...placed })
  const values: PropertyValues = {}
  for (const key of TRANSFORM_KEYS) {
    if (placed[key] !== undefined) values[key] = inside[key]
  }
  return values
}

export function CanvasOverlay({ isCropping, areaRef }: { isCropping: boolean; areaRef: RefObject<HTMLElement | null> }): ReactElement {
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
  const { reach, pictureWidth } = useOverlayReach(svgRef, areaRef)
  const [guides, setGuides] = useState<Guides>(NO_GUIDES)
  const [dropTargetId, setDropTargetId] = useState<string | undefined>(undefined)
  const { canvas } = project
  const wholeTime = time + offset
  const frame = frameOf(canvas, viewAt(wholeProject.camera, wholeTime, canvas))
  const canvasPerPixel = frame.width / pictureWidth
  const openFrame = groupFrameAt(wholeProject, openGroups, wholeTime)

  const shown = isPlaying ? [] : shownClips(wholeProject, mediaStates, wholeTime, { project, time, groups: openGroups, frame: openFrame })
  const selected = shown.filter((item) => selection.includes(item.clipId))
  const locked = lockedClipIds(project)
  const outside = shown.filter((item) => !selection.includes(item.clipId) && !locked.has(item.clipId) && isPastFrame(item.box, frame))
  const pictureOffset = { x: reach.left, y: reach.top }
  const [only] = selected.length === 1 ? selected : []
  const editing = editingTextId === undefined ? undefined : locateClip(project, editingTextId)?.clip
  const editedText = editing?.type === 'text' || editing?.type === 'callout' ? editing : undefined
  const onlyClip = only === undefined || editingTextId !== undefined ? undefined : locateClip(project, only.clipId)?.clip
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

  function topmostAt(point: Point): ShownClip | undefined {
    return shown.findLast((item) => !locked.has(item.clipId) && item.hitBoxes.some((box) => containsPoint(box, point)))
  }

  function effectTargetAt(detail: LibraryDragDetail): ShownClip | undefined {
    const svg = svgRef.current
    if (svg === null || detail.item.kind !== 'effect') return undefined
    const point = pointOnCanvas(detail, svg, frame, pictureWidth, pictureOffset)
    const isFitting = (item: ShownClip): boolean => (detail.item.kind === 'effect' && detail.item.effect === 'blurFill' ? item.kind === 'picture' : item.kind !== 'shape')
    return shown.findLast((item) => isFitting(item) && !locked.has(item.clipId) && item.hitBoxes.some((box) => containsPoint(box, point)))
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

  function onPointerDown(event: PointerEvent<SVGSVGElement>): void {
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
    const { isSnapping, settings } = store.getState()
    return isSnapping && !event.metaKey ? settings.snapRangePixels * canvasPerPixel : undefined
  }

  function edit(item: ShownClip, placed: Partial<Transform>, crop: PropertyValues = {}): Edit {
    const values = { ...valuesInOpenTracks(openGroups, openFrame, item, placed), ...crop }
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
      store.update((current) => setProperties(current, [item.clipId], valuesInOpenTracks(openGroups, openFrame, item, placed), keyTime))
      return
    }

    const { item } = gesture
    const middle = { x: item.box.centerX, y: item.box.centerY }
    if (gesture.kind === 'arrow') {
      const ends = gesture.moves === 'end' ? { start: gesture.fixed, end: point } : { start: point, end: gesture.fixed }
      const { length, ...placed } = arrowBetween(ends.start, ends.end, item.transform)
      store.update((current) => setArrowStyle(edit(item, placed)(current), [item.clipId], { length }))
    } else if (gesture.kind === 'tail') {
      const tip = canvasPointToClip(item.transform, point)
      store.update((current) => setCalloutStyle(current, [item.clipId], { tail: { x: Math.round(tip.x), y: Math.round(tip.y) } }))
    } else if (gesture.kind === 'rotate') {
      const rotation = rotationFromPointer(item.box, gesture.from, point, event.shiftKey)
      const placed = item.kind === 'group' ? { ...placeFor(item, middle, { ...item.transform, rotation }), rotation } : { rotation }
      store.update(edit(item, placed))
    } else if (gesture.kind === 'crop') {
      const { crop, transform } = cropFromHandle(item.natural, item.crop, item.transform, gesture.handle, point)
      store.update(edit(item, { x: transform.x, y: transform.y }, { cropLeft: crop.left, cropTop: crop.top, cropRight: crop.right, cropBottom: crop.bottom }))
    } else {
      const targets = range === undefined ? undefined : sizeTargets(item, gesture.others, canvas, range)
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
  const dropTarget = shown.find((item) => item.clipId === dropTargetId)
  const shownLine = path?.line.map(shownOnPath)
  const shownDots = path?.dots.map((dot) => shownOnPath(dot.point)) ?? []

  return (
    <svg
      ref={svgRef}
      className="canvas-overlay"
      viewBox={`${frame.left - reach.left * canvasPerPixel} ${frame.top - reach.top * canvasPerPixel} ${frame.width + (reach.left + reach.right) * canvasPerPixel} ${frame.height + (reach.top + reach.bottom) * canvasPerPixel}`}
      preserveAspectRatio="none"
      style={{ left: -reach.left, top: -reach.top, width: `calc(100% + ${reach.left + reach.right}px)`, height: `calc(100% + ${reach.top + reach.bottom}px)` }}
      data-testid="canvas-overlay"
      data-selected={selected.length}
      data-outside={outside.length}
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
        const handles = item.kind === 'group' ? HANDLES.filter(isCorner) : HANDLES
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
