import { useRef, type PointerEvent, type ReactElement } from 'react'
import { fittedView, frameOf, setViewAt, viewFromCorner, zoomIndexAt, type ZoomFrame, type ZoomView } from '../editor/camera.js'
import type { Point } from '../editor/geometry.js'
import { viewAt } from '../engine/camera.js'
import { MARGIN_PIXELS, pointOnCanvas, usePictureWidth } from './CanvasOverlay.js'
import { useEditorState, usePosition, useSession } from './context.js'

const HANDLE_PIXELS = 10
const CORNERS = ['nw', 'ne', 'se', 'sw'] as const

type Corner = (typeof CORNERS)[number]

type Gesture =
  // The frame grows from a corner that stays where it is: the corner opposite the one that was grabbed, or the point where a new frame was started.
  | { kind: 'corner'; anchor: Point }
  | { kind: 'move'; from: Point; view: ZoomView }

function isCorner(value: string | undefined): value is Corner {
  return CORNERS.some((corner) => corner === value)
}

function cornerPoint(frame: ZoomFrame, corner: Corner): Point {
  return { x: corner.includes('w') ? frame.left : frame.left + frame.width, y: corner.includes('n') ? frame.top : frame.top + frame.height }
}

function oppositeOf(corner: Corner): Corner {
  const vertical = corner.includes('n') ? 's' : 'n'
  return corner.includes('w') ? `${vertical}e` : `${vertical}w`
}

// The zoom tool: over the whole canvas it shows the frame the camera has at the playhead and lets it be drawn, moved and sized.
// Every drag sets the zoom at the playhead, adding one there if there is none.
export function CameraTool(): ReactElement {
  const svgRef = useRef<SVGSVGElement>(null)
  const gestureRef = useRef<Gesture | undefined>(undefined)
  const pictureWidth = usePictureWidth(svgRef)
  const { store } = useSession()
  const time = usePosition((position) => position.time)
  const isPlaying = usePosition((position) => position.isPlaying)
  const project = useEditorState((state) => state.project)
  const { canvas } = project
  const whole: ZoomFrame = { left: 0, top: 0, width: canvas.width, height: canvas.height }
  const canvasPerPixel = canvas.width / pictureWidth
  const margin = MARGIN_PIXELS * canvasPerPixel
  const handleSize = HANDLE_PIXELS * canvasPerPixel
  const view = viewAt(project.camera, time, canvas)
  const frame = frameOf(canvas, view)

  function onPointerDown(event: PointerEvent<SVGSVGElement>): void {
    if (event.button !== 0 || isPlaying) return
    event.currentTarget.setPointerCapture(event.pointerId)
    const point = pointOnCanvas(event, event.currentTarget, whole, pictureWidth)
    const grabbed = event.target instanceof SVGElement ? event.target.dataset.corner : undefined
    const isInside = point.x >= frame.left && point.x <= frame.left + frame.width && point.y >= frame.top && point.y <= frame.top + frame.height
    store.begin('Zoom and Pan')
    if (isCorner(grabbed)) {
      gestureRef.current = { kind: 'corner', anchor: cornerPoint(frame, oppositeOf(grabbed)) }
    } else if (isInside && view.scale > 1) {
      gestureRef.current = { kind: 'move', from: point, view }
    } else {
      // A frame that is the whole canvas has nowhere to move to, so a drag inside it draws a new one.
      gestureRef.current = { kind: 'corner', anchor: point }
    }
  }

  function onPointerMove(event: PointerEvent<SVGSVGElement>): void {
    const gesture = gestureRef.current
    if (gesture === undefined) return
    const point = pointOnCanvas(event, event.currentTarget, whole, pictureWidth)
    let next: ZoomView
    if (gesture.kind === 'corner') {
      next = viewFromCorner(canvas, gesture.anchor, point)
    } else {
      next = fittedView(canvas, { ...gesture.view, x: gesture.view.x + point.x - gesture.from.x, y: gesture.view.y + point.y - gesture.from.y })
    }
    store.update((current) => setViewAt(current, time, next))
  }

  function endGesture(finish: () => void): void {
    if (gestureRef.current === undefined) return
    gestureRef.current = undefined
    finish()
    // The zoom that was set is the selected one, so its length and easing are at hand in Properties.
    const set = zoomIndexAt(store.getState().project, time)
    if (set !== undefined) store.selectZoom(set)
  }

  return (
    <svg
      ref={svgRef}
      className="canvas-overlay camera-tool"
      viewBox={`${-margin} ${-margin} ${canvas.width + 2 * margin} ${canvas.height + 2 * margin}`}
      preserveAspectRatio="none"
      data-testid="camera-tool"
      data-frame={JSON.stringify(frame)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => endGesture(store.commit)}
      onPointerCancel={() => endGesture(store.cancel)}
      onLostPointerCapture={() => endGesture(store.cancel)}
    >
      {!isPlaying && (
        <>
          <path className="camera-dim" fillRule="evenodd" d={`M0 0H${canvas.width}V${canvas.height}H0ZM${frame.left} ${frame.top}h${frame.width}v${frame.height}h${-frame.width}Z`} />
          <rect className="selection-box" x={frame.left} y={frame.top} width={frame.width} height={frame.height} />
          {CORNERS.map((corner) => {
            const at = cornerPoint(frame, corner)
            return (
              <rect key={corner} className={`canvas-handle ${corner}`} data-corner={corner} data-testid={`zoom-${corner}`} x={at.x - handleSize / 2} y={at.y - handleSize / 2} width={handleSize} height={handleSize} />
            )
          })}
        </>
      )}
    </svg>
  )
}
