import { fitCanvas, type Size } from '../shared/exportPresets.js'
import { ease, type CameraKeyframe } from '../shared/project.js'

export type View = {
  // Centre of what the camera shows, in canvas pixels.
  x: number
  y: number
  scale: number
  // The largest scale of the move the camera is in, or its own scale while it rests. Text is drawn for this size, so a zoom does not draw it anew on every frame.
  largestScale: number
}

export function wholeCanvas(canvas: Size): View {
  return { x: canvas.width / 2, y: canvas.height / 2, scale: 1, largestScale: 1 }
}

// The zoom grows by the same ratio in every equal step, and the centre travels with the width of the view.
// That keeps one point of the picture where it is on screen, so everything else moves straight toward it or away from it: no wobble and no overshoot.
function between(from: View, to: View, progress: number): View {
  const largestScale = Math.max(from.scale, to.scale)
  if (from.scale === to.scale) {
    return { x: from.x + (to.x - from.x) * progress, y: from.y + (to.y - from.y) * progress, scale: to.scale, largestScale }
  }
  const scale = from.scale * (to.scale / from.scale) ** progress
  const travelled = (1 / scale - 1 / from.scale) / (1 / to.scale - 1 / from.scale)
  return { x: from.x + (to.x - from.x) * travelled, y: from.y + (to.y - from.y) * travelled, scale, largestScale }
}

// The view of a zoom. It never shows anything outside the canvas: a centre too close to an edge is moved in.
// A canvas that was made smaller after the zoom was set therefore shows its edge, not black.
function viewOf(zoom: CameraKeyframe, canvas: Size): View {
  const halfWidth = canvas.width / (2 * zoom.scale)
  const halfHeight = canvas.height / (2 * zoom.scale)
  return {
    x: Math.min(canvas.width - halfWidth, Math.max(halfWidth, zoom.x)),
    y: Math.min(canvas.height - halfHeight, Math.max(halfHeight, zoom.y)),
    scale: zoom.scale,
    largestScale: zoom.scale,
  }
}

// What the camera shows at a time. Each zoom is reached at its time, after a move from the view before it; until that move starts the camera rests.
export function viewAt(camera: readonly CameraKeyframe[] | undefined, time: number, canvas: Size): View {
  let previous = wholeCanvas(canvas)
  let previousTime = 0
  for (const zoom of camera ?? []) {
    if (zoom.time > time) {
      // A move never starts before the zoom before it has been reached.
      const moveStart = Math.max(zoom.time - zoom.duration, previousTime)
      if (time <= moveStart) return previous
      return between(previous, viewOf(zoom, canvas), ease(zoom.easing, (time - moveStart) / (zoom.time - moveStart)))
    }
    previous = viewOf(zoom, canvas)
    previousTime = zoom.time
  }
  return previous
}

// The largest scale the camera has anywhere from `from` to `to`. Within one move the scale only rises or only falls, so the two ends and the zooms between them are enough.
export function largestScaleBetween(camera: readonly CameraKeyframe[] | undefined, from: number, to: number, canvas: Size): number {
  let largest = Math.max(viewAt(camera, from, canvas).scale, viewAt(camera, to, canvas).scale)
  for (const zoom of camera ?? []) {
    if (zoom.time >= from && zoom.time <= to) largest = Math.max(largest, zoom.scale)
  }
  return largest
}

// Where a canvas pixel lands in the output: `offset + pixel * scale`.
export type OutputMapping = {
  scale: number
  offsetX: number
  offsetY: number
}

// The canvas fitted into the output and seen through the camera. Every layer is drawn through this, so a zoom draws text and video at the zoomed size instead of enlarging a finished picture.
export function outputMapping(canvas: Size, output: Size, view: View): OutputMapping {
  const fit = fitCanvas(canvas, output)
  return {
    scale: fit.scale * view.scale,
    offsetX: fit.offsetX + (canvas.width / 2 - view.x * view.scale) * fit.scale,
    offsetY: fit.offsetY + (canvas.height / 2 - view.y * view.scale) * fit.scale,
  }
}
