import { useEffect, useRef, useState, type PointerEvent, type ReactElement } from 'react'
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
import { resolveFrame, type Layer, type MediaStates } from '../engine/resolve.js'
import { measureText } from '../engine/text.js'
import type { Size } from '../shared/exportPresets.js'
import type { Crop, Project, Transform } from '../shared/project.js'
import { useEditorState, usePosition, useSession } from './context.js'
import type { Edit } from './store.js'

const NO_CROP: Crop = { left: 0, top: 0, right: 0, bottom: 0 }
const SNAP_RANGE_PIXELS = 8
const HANDLE_PIXELS = 10
const ROTATE_HANDLE_OFFSET_PIXELS = 26
const ROTATE_HANDLE_MAX_REACH = 0.35
const MIN_BOX_PIXELS = 6
// The overlay reaches this far past the picture on every side, so the handles of a clip that fills the canvas are whole and can be grabbed. Must match the CSS.
const MARGIN_PIXELS = 14

// One drawn layer with everything the handles need to change it.
type Shown = {
  clipId: string
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
  if (layer.kind === 'image') return { width: layer.width, height: layer.height }
  const measured = measureText(layer)
  return { width: measured.naturalWidth, height: measured.naturalHeight }
}

// The layers at the playhead, bottom first, placed exactly where the compositor draws them.
function shownLayers(project: Project, mediaStates: MediaStates, time: number): Shown[] {
  const shown: Shown[] = []
  for (const layer of resolveFrame(project, mediaStates, time, 1)) {
    const natural = naturalSize(layer)
    const crop = layer.kind === 'text' ? NO_CROP : layer.crop
    shown.push({ clipId: layer.clipId, natural, crop, transform: layer.transform, box: boxOf(natural, crop, layer.transform) })
  }
  return shown
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
  const isPlaying = usePosition((position) => position.isPlaying)
  const time = usePosition((position) => position.time)
  const svgRef = useRef<SVGSVGElement>(null)
  const gestureRef = useRef<Gesture | undefined>(undefined)
  const [canvasPerPixel, setCanvasPerPixel] = useState(1)
  const [guides, setGuides] = useState<Guides>(NO_GUIDES)
  const { canvas } = project

  useEffect(() => {
    const svg = svgRef.current
    if (svg === null) return
    const measure = (): void => {
      const pictureWidth = svg.clientWidth - 2 * MARGIN_PIXELS
      setCanvasPerPixel(pictureWidth > 0 ? canvas.width / pictureWidth : 1)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(svg)
    return () => observer.disconnect()
  }, [canvas.width])

  const shown = isPlaying ? [] : shownLayers(project, mediaStates, time)
  const selected = shown.filter((item) => selection.includes(item.clipId))
  const [only] = selected.length === 1 ? selected : []

  function pointOf(event: PointerEvent<SVGSVGElement>): Point {
    const box = event.currentTarget.getBoundingClientRect()
    return { x: (event.clientX - box.left - MARGIN_PIXELS) * canvasPerPixel, y: (event.clientY - box.top - MARGIN_PIXELS) * canvasPerPixel }
  }

  function topmostAt(point: Point): Shown | undefined {
    const locked = lockedClipIds(project)
    return shown.findLast((item) => !locked.has(item.clipId) && containsPoint(item.box, point))
  }

  function onPointerDown(event: PointerEvent<SVGSVGElement>): void {
    if (event.button !== 0 || isPlaying) return
    event.currentTarget.setPointerCapture(event.pointerId)
    const point = pointOf(event)
    const grabbed = event.target instanceof SVGElement ? event.target.dataset.handle : undefined

    if (only !== undefined && grabbed === 'rotate') {
      store.begin('Rotate Clip')
      gestureRef.current = { kind: 'rotate', item: only, from: point }
      return
    }
    if (only !== undefined && isHandle(grabbed)) {
      const kind = isCropping || event.altKey ? 'crop' : 'scale'
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

  return (
    <svg
      ref={svgRef}
      className="canvas-overlay"
      viewBox={`${-margin} ${-margin} ${canvas.width + 2 * margin} ${canvas.height + 2 * margin}`}
      preserveAspectRatio="none"
      data-testid="canvas-overlay"
      data-selected={selected.length}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => endGesture(store.commit)}
      onPointerCancel={() => endGesture(store.cancel)}
      onLostPointerCapture={() => endGesture(store.cancel)}
    >
      {guides.x !== undefined && <line className="snap-guide" x1={guides.x} y1={0} x2={guides.x} y2={canvas.height} />}
      {guides.y !== undefined && <line className="snap-guide" x1={0} y1={guides.y} x2={canvas.width} y2={guides.y} />}
      {selected.map((item) => {
        const width = Math.max(minBox, item.box.width)
        const height = Math.max(minBox, item.box.height)
        const isOnly = item === only
        // As in Camtasia the rotate handle sits inside the clip, above its centre: it stays reachable when the clip fills the canvas.
        const rotateReach = Math.min(ROTATE_HANDLE_OFFSET_PIXELS * canvasPerPixel, height * ROTATE_HANDLE_MAX_REACH)
        return (
          <g key={item.clipId} transform={`translate(${item.box.centerX} ${item.box.centerY}) rotate(${item.box.rotation})`}>
            <rect className={guides.isSizeSnapped ? 'selection-box snapped' : 'selection-box'} x={-width / 2} y={-height / 2} width={width} height={height} />
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
