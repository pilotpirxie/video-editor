import type { DrawingShape, ShapeStroke } from '../shared/project.js'
import { MITER_LIMIT, strokeAlignOf, svgPathOf, type DrawingBounds } from './curves.js'
import type { DrawingLook } from './resolve.js'
import { rasterOf, type Raster } from './text.js'

// Each dash and each gap is this many stroke widths long.
const DASH_WIDTHS = 2

export function shapePath(shape: DrawingShape): Path2D {
  return new Path2D(svgPathOf(shape))
}

function outsideOf(path: Path2D, bounds: DrawingBounds): Path2D {
  const outside = new Path2D()
  outside.rect(bounds.left, bounds.top, bounds.right - bounds.left, bounds.bottom - bounds.top)
  outside.addPath(path)
  return outside
}

// Canvas2D strokes on the centre of the outline, so an inside or outside stroke is drawn twice as wide and half of it is clipped away.
function drawStroke(context: OffscreenCanvasRenderingContext2D, shape: DrawingShape, stroke: ShapeStroke, path: Path2D, bounds: DrawingBounds): void {
  const align = strokeAlignOf(shape)
  const width = align === 'center' ? stroke.width : 2 * stroke.width
  context.save()
  if (align === 'inside') context.clip(path)
  else if (align === 'outside') context.clip(outsideOf(path, bounds), 'evenodd')
  context.lineCap = stroke.cap ?? 'round'
  context.lineJoin = stroke.join ?? 'round'
  context.miterLimit = MITER_LIMIT
  context.lineWidth = width
  context.setLineDash(stroke.isDashed === true ? [DASH_WIDTHS * stroke.width, DASH_WIDTHS * stroke.width] : [])
  context.strokeStyle = stroke.color
  context.stroke(path)
  context.restore()
}

function drawShapes(context: OffscreenCanvasRenderingContext2D, shapes: readonly DrawingShape[], bounds: DrawingBounds): void {
  for (const shape of shapes) {
    const path = shapePath(shape)
    const { stroke } = shape
    if (stroke?.isBehind === true) drawStroke(context, shape, stroke, path, bounds)
    if (shape.fill !== undefined) {
      context.fillStyle = shape.fill
      context.fill(path)
    }
    if (shape.children !== undefined) {
      context.save()
      context.clip(path)
      drawShapes(context, shape.children, bounds)
      context.restore()
    }
    if (stroke !== undefined && stroke.isBehind !== true) drawStroke(context, shape, stroke, path, bounds)
  }
}

export function rasterizeDrawing(look: DrawingLook, pixelsPerUnitX: number, pixelsPerUnitY: number): Raster {
  const { bounds } = look
  const raster = rasterOf(bounds.right - bounds.left, bounds.bottom - bounds.top, pixelsPerUnitX, pixelsPerUnitY)
  raster.context.translate(-bounds.left, -bounds.top)
  drawShapes(raster.context, look.shapes, bounds)
  return { canvas: raster.canvas, naturalWidth: raster.naturalWidth, naturalHeight: raster.naturalHeight }
}
