import type { DrawingShape } from '../shared/project.js'
import { segmentsOf } from './curves.js'
import type { DrawingLook } from './resolve.js'
import { rasterOf, type Raster } from './text.js'

export function shapePath(shape: DrawingShape): Path2D {
  const path = new Path2D()
  const first = shape.nodes[0]
  if (first === undefined) return path
  path.moveTo(first.x, first.y)
  for (const { startControl, endControl, end, isStraight } of segmentsOf(shape)) {
    if (isStraight) path.lineTo(end.x, end.y)
    else path.bezierCurveTo(startControl.x, startControl.y, endControl.x, endControl.y, end.x, end.y)
  }
  if (shape.isClosed === true) path.closePath()
  return path
}

function drawShapes(context: OffscreenCanvasRenderingContext2D, shapes: readonly DrawingShape[]): void {
  for (const shape of shapes) {
    const path = shapePath(shape)
    if (shape.fill !== undefined) {
      context.fillStyle = shape.fill
      context.fill(path)
    }
    if (shape.children !== undefined) {
      context.save()
      context.clip(path)
      drawShapes(context, shape.children)
      context.restore()
    }
    if (shape.stroke !== undefined) {
      context.lineCap = 'round'
      context.lineJoin = 'round'
      context.lineWidth = shape.stroke.width
      context.strokeStyle = shape.stroke.color
      context.stroke(path)
    }
  }
}

export function rasterizeDrawing(look: DrawingLook, pixelsPerUnitX: number, pixelsPerUnitY: number): Raster {
  const { bounds } = look
  const raster = rasterOf(bounds.right - bounds.left, bounds.bottom - bounds.top, pixelsPerUnitX, pixelsPerUnitY)
  raster.context.translate(-bounds.left, -bounds.top)
  drawShapes(raster.context, look.shapes)
  return { canvas: raster.canvas, naturalWidth: raster.naturalWidth, naturalHeight: raster.naturalHeight }
}
