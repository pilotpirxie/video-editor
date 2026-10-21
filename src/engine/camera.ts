import { fitCanvas, type Size } from '../shared/exportPresets.js'
import { ease, type CameraKeyframe } from '../shared/project.js'

export type View = {
  x: number
  y: number
  scale: number
  largestScale: number
}

export function wholeCanvas(canvas: Size): View {
  return { x: canvas.width / 2, y: canvas.height / 2, scale: 1, largestScale: 1 }
}

function interpolatedView(from: View, to: View, progress: number): View {
  const largestScale = Math.max(from.scale, to.scale)
  if (from.scale === to.scale) {
    return { x: from.x + (to.x - from.x) * progress, y: from.y + (to.y - from.y) * progress, scale: to.scale, largestScale }
  }
  const scale = from.scale * (to.scale / from.scale) ** progress
  const travelled = (1 / scale - 1 / from.scale) / (1 / to.scale - 1 / from.scale)
  return { x: from.x + (to.x - from.x) * travelled, y: from.y + (to.y - from.y) * travelled, scale, largestScale }
}

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

export function viewAt(camera: readonly CameraKeyframe[] | undefined, time: number, canvas: Size): View {
  let previous = wholeCanvas(canvas)
  let previousTime = 0
  for (const zoom of camera ?? []) {
    if (zoom.time > time) {
      const moveStart = Math.max(zoom.time - zoom.duration, previousTime)
      if (time <= moveStart) return previous
      return interpolatedView(previous, viewOf(zoom, canvas), ease(zoom.easing, (time - moveStart) / (zoom.time - moveStart)))
    }
    previous = viewOf(zoom, canvas)
    previousTime = zoom.time
  }
  return previous
}

export function largestScaleBetween(camera: readonly CameraKeyframe[] | undefined, from: number, to: number, canvas: Size): number {
  let largest = Math.max(viewAt(camera, from, canvas).scale, viewAt(camera, to, canvas).scale)
  for (const zoom of camera ?? []) {
    if (zoom.time >= from && zoom.time <= to) largest = Math.max(largest, zoom.scale)
  }
  return largest
}

export type OutputMapping = {
  scale: number
  offsetX: number
  offsetY: number
}

export function outputMapping(canvas: Size, output: Size, view: View): OutputMapping {
  const fit = fitCanvas(canvas, output)
  return {
    scale: fit.scale * view.scale,
    offsetX: fit.offsetX + (canvas.width / 2 - view.x * view.scale) * fit.scale,
    offsetY: fit.offsetY + (canvas.height / 2 - view.y * view.scale) * fit.scale,
  }
}
