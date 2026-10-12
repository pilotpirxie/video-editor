import type { TextLayer } from './resolve.js'

const PADDING_PER_FONT_SIZE = 0.25
const MAX_RASTER_SIDE = 8192
const FALLBACK_FAMILY = 'sans-serif'

export type TextRaster = {
  canvas: OffscreenCanvas
  naturalWidth: number
  naturalHeight: number
}

class TextError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TextError'
  }
}

function contextOf(canvas: OffscreenCanvas): OffscreenCanvasRenderingContext2D {
  const context = canvas.getContext('2d')
  if (context === null) throw new TextError('This environment cannot draw text')
  return context
}

export function rasterizeText(layer: TextLayer, pixelsPerUnitX: number, pixelsPerUnitY: number): TextRaster {
  const lines = layer.text.split('\n')
  const family = layer.family.replaceAll('"', '\\"')
  const font = `${layer.size}px "${family}", ${FALLBACK_FAMILY}`

  const measuring = contextOf(new OffscreenCanvas(1, 1))
  measuring.font = font
  const reference = measuring.measureText('M')
  const ascent = reference.fontBoundingBoxAscent
  const lineHeight = ascent + reference.fontBoundingBoxDescent
  const lineWidths = lines.map((line) => measuring.measureText(line).width)
  const widestLine = Math.max(...lineWidths)

  const padding = Math.ceil(layer.size * PADDING_PER_FONT_SIZE)
  const naturalWidth = widestLine + 2 * padding
  const naturalHeight = lines.length * lineHeight + 2 * padding

  const rasterWidth = Math.min(MAX_RASTER_SIDE, Math.max(1, Math.ceil(naturalWidth * pixelsPerUnitX)))
  const rasterHeight = Math.min(MAX_RASTER_SIDE, Math.max(1, Math.ceil(naturalHeight * pixelsPerUnitY)))
  const canvas = new OffscreenCanvas(rasterWidth, rasterHeight)
  const context = contextOf(canvas)
  context.scale(rasterWidth / naturalWidth, rasterHeight / naturalHeight)
  context.font = font
  context.fillStyle = layer.color
  context.textBaseline = 'alphabetic'

  for (const [index, line] of lines.entries()) {
    const lineWidth = lineWidths[index] ?? 0
    let x = padding
    if (layer.align === 'center') x = (naturalWidth - lineWidth) / 2
    if (layer.align === 'right') x = naturalWidth - padding - lineWidth
    context.fillText(line, x, padding + ascent + index * lineHeight)
  }
  return { canvas, naturalWidth, naturalHeight }
}
