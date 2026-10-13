import { useEffect, useEffectEvent, useRef, useState, type MouseEvent, type PointerEvent, type ReactElement, type RefObject } from 'react'
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
  rotationFromPointer,
  scaleFromHandle,
  type Box,
  type Handle,
  type Point,
  type SizeTargets,
} from '../editor/geometry.js'
import { setProperties, type PropertyValues } from '../editor/properties.js'
import { positionTargets, snapPosition, type Bounds } from '../editor/snapping.js'
import { viewAt } from '../engine/camera.js'
import { resolveFrame, type Layer, type MediaStates } from '../engine/resolve.js'
import { measureText } from '../engine/text.js'
import type { Size } from '../shared/exportPresets.js'
import type { Crop, Project, Transform } from '../shared/project.js'
import { useEditorState, usePosition, useSession } from './context.js'
import type { Edit } from './store.js'
import { TextEditor } from './TextEditor.js'
import { LIBRARY_DRAG_EVENT, LIBRARY_DROP_EVENT, isLibraryDrag, type LibraryDragDetail } from './timelineController.js'

const NO_CROP: Crop = { left: 0, top: 0, right: 0, bottom: 0 }
const SNAP_RANGE_PIXELS = 8
const HANDLE_PIXELS = 10
const ROTATE_HANDLE_OFFSET_PIXELS = 26
const ROTATE_HANDLE_MAX_REACH = 0.35
const MIN_BOX_PIXELS = 6
// The overlay reaches this far past the picture on every side, so the handles of a clip that fills the canvas are whole and can be grabbed. Must match the CSS.
export const MARGIN_PIXELS = 14

// One drawn layer with everything the handles need to change it.
type Shown = {
  clipId: string
  isText: boolean
  // Blur and highlight clips have no picture for an effect to change, and nothing to crop.
  hasPicture: boolean
  natural: Size
  crop: Crop
  transform: Transform
  box: Box
}

type Gesture =
  | { kind: 'move'; from: Point; items: readonly Shown[]; others: readonly Bounds[] }
  | { kind: 'scale' | 'crop'; item: Shown; handle: Handle; others: readonly Shown[] }
  | { kind: 'rotate'; item: Shown; from: Point }

type Guides = {
  x: number | undefined
  y: number | undefined
  isSizeSnapped: boolean
}

const NO_GUIDES: Guides = { x: undefined, y: undefined, isSizeSnapped: false }

function naturalSize(layer: Layer): Size {
  if (layer.kind === 'video') return { width: layer.video.width, height: layer.video.height }
  if (layer.kind !== 'text') return { width: layer.width, height: layer.height }
  const measured = measureText(layer)
  return { width: measured.naturalWidth, height: measured.naturalHeight }
}

// The layers at the playhead, bottom first, placed exactly where the compositor draws them.
function shownLayers(project: Project, mediaStates: MediaStates, time: number): Shown[] {
  const shown: Shown[] = []
  for (const layer of resolveFrame(project, mediaStates, time, 1)) {
    const natural = naturalSize(layer)
    const crop = layer.kind === 'video' || layer.kind === 'image' ? layer.crop : NO_CROP
    const hasPicture = layer.kind !== 'blur' && layer.kind !== 'highlight'
    shown.push({ clipId: layer.clipId, isText: layer.kind === 'text', hasPicture, natural, crop, transform: layer.transform, box: boxOf(natural, crop, layer.transform) })
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
  const { store } = useSession()
  const project = useEditorState((state) => state.project)
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
  const frame = frameOf(canvas, viewAt(project.camera, time, canvas))
  const canvasPerPixel = frame.width / pictureWidth

  const shown = isPlaying ? [] : shownLayers(project, mediaStates, time)
  const selected = shown.filter((item) => selection.includes(item.clipId))
  const [only] = selected.length === 1 ? selected : []
  const editing = editingTextId === undefined ? undefined : locateClip(project, editingTextId)?.clip
  const editedText = editing?.type === 'text' ? editing : undefined

  function pointOf(event: MouseEvent<SVGSVGElement>): Point {
    return pointOnCanvas(event, event.currentTarget, frame, pictureWidth)
  }

  function topmostAt(point: Point): Shown | undefined {
    const locked = lockedClipIds(project)
    return shown.findLast((item) => !locked.has(item.clipId) && containsPoint(item.box, point))
  }

  // The clip an effect held at a place in the window would go to: the topmost one there that has a picture.
  function effectTargetAt(detail: LibraryDragDetail): Shown | undefined {
    const svg = svgRef.current
    if (svg === null || detail.item.kind !== 'effect') return undefined
    const point = pointOnCanvas(detail, svg, frame, pictureWidth)
    const locked = lockedClipIds(project)
    return shown.findLast((item) => item.hasPicture && !locked.has(item.clipId) && containsPoint(item.box, point))
  }

  // Heard for every move of a drag out of the library, wherever in the window it is: one that has left the canvas no longer has a target here.
  const onLibraryDrag = useEffectEvent((event: Event) => {
    if (!isLibraryDrag(event)) return
    const isOverCanvas = event.target instanceof Node && svgRef.current?.contains(event.target) === true
    setDropTargetId(isOverCanvas ? effectTargetAt(event.detail)?.clipId : undefined)
  })

  const onLibraryDrop = useEffectEvent((event: Event) => {
    if (!isLibraryDrag(event) || event.detail.item.kind !== 'effect') return
    const target = effectTargetAt(event.detail)
    if (target === undefined) return
    const { effect } = event.detail.item
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

    if (only !== undefined && grabbed === 'rotate') {
      store.begin('Rotate Clip')
      gestureRef.current = { kind: 'rotate', item: only, from: point }
      return
    }
    if (only !== undefined && isHandle(grabbed)) {
      const kind = only.hasPicture && (isCropping || event.altKey) ? 'crop' : 'scale'
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
    if (hit === undefined || !hit.isText) return
    store.select([hit.clipId])
    store.editText(hit.clipId)
  }

  function snapRange(event: PointerEvent<SVGSVGElement>): number | undefined {
    return store.getState().isSnapping && !event.metaKey ? SNAP_RANGE_PIXELS * canvasPerPixel : undefined
  }

  function edit(clipId: string, values: PropertyValues): Edit {
    return (current) => setProperties(current, [clipId], values, time)
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
        for (const item of items) moved = setProperties(moved, [item.clipId], { x: item.transform.x + dx, y: item.transform.y + dy }, time)
        return moved
      })
      return
    }

    const { item } = gesture
    if (gesture.kind === 'rotate') {
      store.update(edit(item.clipId, { rotation: rotationFromPointer(item.box, gesture.from, point, event.shiftKey) }))
    } else if (gesture.kind === 'crop') {
      const { crop, transform } = cropFromHandle(item.natural, item.crop, item.transform, gesture.handle, point)
      store.update(edit(item.clipId, { x: transform.x, y: transform.y, cropLeft: crop.left, cropTop: crop.top, cropRight: crop.right, cropBottom: crop.bottom }))
    } else {
      const targets = range === undefined ? undefined : sizeTargets(item, gesture.others, canvas, range)
      const { transform, isSnapped } = scaleFromHandle(item.natural, item.crop, item.transform, gesture.handle, point, !event.shiftKey, targets)
      setGuides({ x: undefined, y: undefined, isSizeSnapped: isSnapped })
      store.update(edit(item.clipId, { x: transform.x, y: transform.y, scaleX: transform.scaleX, scaleY: transform.scaleY }))
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
      {selected.map((item) => {
        const width = Math.max(minBox, item.box.width)
        const height = Math.max(minBox, item.box.height)
        const isEdited = item.clipId === editedText?.id
        const isOnly = item === only && !isEdited
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
            {isOnly && <line className="selection-box" x1={0} y1={0} x2={0} y2={-rotateReach} />}
            {isOnly && <circle className="canvas-handle rotate" data-handle="rotate" data-testid="handle-rotate" cx={0} cy={-rotateReach} r={handleSize / 2} />}
            {isOnly &&
              HANDLES.map((handle) => {
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
