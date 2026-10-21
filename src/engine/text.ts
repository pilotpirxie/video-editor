import { lettersOf, type TextLook } from './resolve.js'

const PADDING_PER_FONT_SIZE = 0.25
const MAX_RASTER_SIDE = 8192
const MAX_RASTER_PIXELS = 4096 * 4096
const FALLBACK_FAMILY = 'sans-serif'
const SHADOW_REACH_PER_BLUR = 2

export type Raster = {
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

// The CPU canvas gives the same pixels on every run and the GPU canvas does not, which preview and export parity needs.
function contextOf(canvas: OffscreenCanvas): OffscreenCanvasRenderingContext2D {
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (context === null) throw new TextError('This environment cannot draw text')
  return context
}

function wantedPixels(units: number, pixelsPerUnit: number): number {
  const pixels = units * pixelsPerUnit
  if (Number.isNaN(pixels)) return 1
  return Math.min(Number.MAX_VALUE, Math.max(1, pixels))
}

export function rasterSize(naturalWidth: number, naturalHeight: number, pixelsPerUnitX: number, pixelsPerUnitY: number): { width: number; height: number } {
  const wantedWidth = wantedPixels(naturalWidth, pixelsPerUnitX)
  const wantedHeight = wantedPixels(naturalHeight, pixelsPerUnitY)
  // Separate square roots, so the product of the two sides cannot overflow.
  const shrink = Math.min(1, MAX_RASTER_SIDE / wantedWidth, MAX_RASTER_SIDE / wantedHeight, Math.sqrt(MAX_RASTER_PIXELS) / Math.sqrt(wantedWidth) / Math.sqrt(wantedHeight))
  return { width: Math.max(1, Math.ceil(wantedWidth * shrink)), height: Math.max(1, Math.ceil(wantedHeight * shrink)) }
}

export function rasterOf(naturalWidth: number, naturalHeight: number, pixelsPerUnitX: number, pixelsPerUnitY: number): Raster & { context: OffscreenCanvasRenderingContext2D } {
  const size = rasterSize(naturalWidth, naturalHeight, pixelsPerUnitX, pixelsPerUnitY)
  const rasterWidth = size.width
  const rasterHeight = size.height
  const canvas = new OffscreenCanvas(rasterWidth, rasterHeight)
  const context = contextOf(canvas)
  context.scale(rasterWidth / naturalWidth, rasterHeight / naturalHeight)
  return { canvas, context, naturalWidth, naturalHeight }
}

type TextMeasure = {
  font: string
  lines: string[]
  lineWidths: number[]
  ascent: number
  lineHeight: number
  lineStep: number
  padding: number
  naturalWidth: number
  naturalHeight: number
}

const words = new Intl.Segmenter(undefined, { granularity: 'word' })

function wrapLine(line: string, width: number, widthOf: (text: string) => number): string[] {
  const lines: string[] = []
  let current = ''
  function place(piece: string): void {
    if (widthOf(current + piece) <= width) {
      current += piece
      return
    }
    if (current.trim() !== '') {
      lines.push(current.trimEnd())
      current = ''
      if (piece.trim() === '') return
      place(piece)
      return
    }
    const parts = lettersOf(piece)
    if (parts.length <= 1) {
      current += piece
      return
    }
    for (const part of parts) place(part)
  }
  for (const piece of words.segment(line)) place(piece.segment)
  lines.push(current.trimEnd())
  return lines
}

export function measureText(look: TextLook): TextMeasure {
  const family = look.font.family.replaceAll('"', '\\"')
  const weight = look.font.weight === undefined ? '' : `${look.font.weight} `
  const font = `${weight}${look.font.size}px "${family}", ${FALLBACK_FAMILY}`

  const measuring = contextOf(new OffscreenCanvas(1, 1))
  measuring.font = font
  const reference = measuring.measureText('M')
  const ascent = reference.fontBoundingBoxAscent
  const lineHeight = ascent + reference.fontBoundingBoxDescent
  const padding = Math.ceil(look.font.size * PADDING_PER_FONT_SIZE)
  const widthOf = (text: string): number => measuring.measureText(text).width

  let lines = look.text.split('\n')
  if (look.boxWidth !== undefined) {
    const room = Math.max(1, look.boxWidth - 2 * padding)
    lines = lines.flatMap((line) => wrapLine(line, room, widthOf))
  }
  const lineWidths = lines.map(widthOf)
  const lineStep = lineHeight * (look.lineSpacing ?? 1)
  return {
    font,
    lines,
    lineWidths,
    ascent,
    lineHeight,
    lineStep,
    padding,
    naturalWidth: look.boxWidth ?? Math.max(...lineWidths) + 2 * padding,
    naturalHeight: (lines.length - 1) * lineStep + lineHeight + 2 * padding,
  }
}

function bleedOf(look: TextLook): number {
  const outline = look.outline?.width ?? 0
  const { shadow } = look
  if (shadow === undefined) return Math.ceil(outline)
  return Math.ceil(outline + Math.max(Math.abs(shadow.offsetX), Math.abs(shadow.offsetY)) + SHADOW_REACH_PER_BLUR * shadow.blur)
}

function drawLetters(context: OffscreenCanvasRenderingContext2D, look: TextLook, measure: TextMeasure, shownLetters: number | undefined): void {
  const { lines, lineWidths, ascent, lineStep, padding, naturalWidth } = measure
  context.font = measure.font
  context.textBaseline = 'alphabetic'
  context.lineJoin = 'round'
  let left = shownLetters ?? Infinity
  for (const [index, line] of lines.entries()) {
    if (left <= 0) return
    const lineWidth = lineWidths[index] ?? 0
    let x = padding
    if (look.align === 'center') x = (naturalWidth - lineWidth) / 2
    if (look.align === 'right') x = naturalWidth - padding - lineWidth
    const y = padding + ascent + index * lineStep

    let shown = line
    if (left !== Infinity) {
      const parts = lettersOf(line)
      shown = parts.slice(0, left).join('')
      left -= parts.length
    }
    if (look.outline !== undefined) {
      context.lineWidth = 2 * look.outline.width
      context.strokeStyle = look.outline.color
      context.strokeText(shown, x, y)
    }
    context.fillStyle = look.color
    context.fillText(shown, x, y)
  }
}

export function drawText(target: Raster & { context: OffscreenCanvasRenderingContext2D }, look: TextLook, measure: TextMeasure, shownLetters: number | undefined): void {
  const { shadow } = look
  if (shadow === undefined) {
    drawLetters(target.context, look, measure, shownLetters)
    return
  }
  const sheet = new OffscreenCanvas(target.canvas.width, target.canvas.height)
  const sheetContext = contextOf(sheet)
  sheetContext.setTransform(target.context.getTransform())
  drawLetters(sheetContext, look, measure, shownLetters)

  const pixelsPerUnitX = target.canvas.width / target.naturalWidth
  const pixelsPerUnitY = target.canvas.height / target.naturalHeight
  const { context } = target
  context.save()
  context.resetTransform()
  context.shadowColor = shadow.color
  context.shadowOffsetX = shadow.offsetX * pixelsPerUnitX
  context.shadowOffsetY = shadow.offsetY * pixelsPerUnitY
  context.shadowBlur = shadow.blur * Math.min(pixelsPerUnitX, pixelsPerUnitY)
  context.drawImage(sheet, 0, 0)
  context.restore()
}

export function rasterizeText(look: TextLook, shownLetters: number | undefined, pixelsPerUnitX: number, pixelsPerUnitY: number): Raster {
  const measure = measureText(look)
  const bleed = bleedOf(look)
  const raster = rasterOf(measure.naturalWidth + 2 * bleed, measure.naturalHeight + 2 * bleed, pixelsPerUnitX, pixelsPerUnitY)
  raster.context.translate(bleed, bleed)
  if (look.background !== undefined) {
    raster.context.fillStyle = look.background.color
    raster.context.fillRect(0, 0, measure.naturalWidth, measure.naturalHeight)
  }
  drawText(raster, look, measure, shownLetters)
  return { canvas: raster.canvas, naturalWidth: raster.naturalWidth, naturalHeight: raster.naturalHeight }
}
