import type { Size } from '../shared/exportPresets.js'
import type { ArrowHead } from '../shared/project.js'
import type { ArrowLook, CalloutLook, TextLook } from './resolve.js'
import { drawText, measureText, rasterOf, type Raster } from './text.js'

const ROUNDING_PER_SHORT_SIDE = 0.2
const TAIL_BASE_PER_SHORT_SIDE = 0.3
const BURST_POINTS = 12
const BURST_INNER = 0.78
const ARROW_TIP_PER_HEIGHT = 0.5
const BANNER_NOTCH_PER_HEIGHT = 0.35
// The puffs of a thought bubble: how far along the way to the tip each sits, and how large it is, as shares of the bubble's short side.
const THOUGHT_PUFFS = [
  { along: 0.45, radius: 0.09 },
  { along: 0.75, radius: 0.06 },
  { along: 1, radius: 0.035 },
]
// The share of the box, around its middle, that the words of a round shape may fill without touching its edge.
const ROUND_TEXT_SHARE = 0.7
// An arrow's box is this many times as high as its line is thick, so there is something to grab, and its heads are that wide.
const ARROW_HEIGHT_PER_THICKNESS = 4
const OPEN_HEAD_ANGLE = Math.PI / 6
const DOT_RADIUS_PER_THICKNESS = 1.5
// The dot of an arrow reaches past its end, and round line ends do too.
const ARROW_BLEED_PER_THICKNESS = 2

type Point = {
  x: number
  y: number
}

function polygon(path: Path2D, points: readonly Point[]): void {
  for (const [index, point] of points.entries()) {
    if (index === 0) path.moveTo(point.x, point.y)
    else path.lineTo(point.x, point.y)
  }
  path.closePath()
}

// The tail of a speech bubble: a triangle from the tip to a base that lies across the way from the middle of the box to the tip, inside the box.
function speechTail(path: Path2D, tip: Point, shortSide: number): void {
  const reach = Math.hypot(tip.x, tip.y)
  if (reach === 0) return
  const half = (shortSide * TAIL_BASE_PER_SHORT_SIDE) / 2
  const acrossX = (-tip.y / reach) * half
  const acrossY = (tip.x / reach) * half
  polygon(path, [tip, { x: acrossX, y: acrossY }, { x: -acrossX, y: -acrossY }])
}

function thoughtTail(path: Path2D, tip: Point, shortSide: number): void {
  for (const puff of THOUGHT_PUFFS) {
    path.moveTo(tip.x * puff.along + shortSide * puff.radius, tip.y * puff.along)
    path.arc(tip.x * puff.along, tip.y * puff.along, shortSide * puff.radius, 0, 2 * Math.PI)
  }
}

// The outline of a callout around the middle of its box. Its parts may overlap; filled together they are one shape.
function calloutOutline(look: Pick<CalloutLook, 'width' | 'height' | 'shape' | 'tail'>): Path2D {
  const { width, height, shape } = look
  const left = -width / 2
  const top = -height / 2
  const shortSide = Math.min(width, height)
  const tail = look.tail ?? { x: 0, y: 0 }
  const path = new Path2D()
  if (shape === 'rectangle') {
    path.rect(left, top, width, height)
  } else if (shape === 'roundedBox') {
    path.roundRect(left, top, width, height, shortSide * ROUNDING_PER_SHORT_SIDE)
  } else if (shape === 'ellipse') {
    path.ellipse(0, 0, width / 2, height / 2, 0, 0, 2 * Math.PI)
  } else if (shape === 'speechBubble') {
    path.roundRect(left, top, width, height, shortSide * ROUNDING_PER_SHORT_SIDE)
    speechTail(path, tail, shortSide)
  } else if (shape === 'thoughtBubble') {
    path.ellipse(0, 0, width / 2, height / 2, 0, 0, 2 * Math.PI)
    thoughtTail(path, tail, shortSide)
  } else if (shape === 'arrowBox') {
    const tip = Math.min(width / 2, height * ARROW_TIP_PER_HEIGHT)
    polygon(path, [{ x: left, y: top }, { x: -left - tip, y: top }, { x: -left, y: 0 }, { x: -left - tip, y: -top }, { x: left, y: -top }])
  } else if (shape === 'banner') {
    const notch = Math.min(width / 4, height * BANNER_NOTCH_PER_HEIGHT)
    polygon(path, [{ x: left, y: top }, { x: -left, y: top }, { x: -left - notch, y: 0 }, { x: -left, y: -top }, { x: left, y: -top }, { x: left + notch, y: 0 }])
  } else {
    const points: Point[] = []
    for (let index = 0; index < 2 * BURST_POINTS; index++) {
      const reach = index % 2 === 0 ? 1 : BURST_INNER
      const angle = (index * Math.PI) / BURST_POINTS
      points.push({ x: (Math.cos(angle) * reach * width) / 2, y: (Math.sin(angle) * reach * height) / 2 })
    }
    polygon(path, points)
  }
  return path
}

// The part of the box the words are laid out in, around a middle that an arrow box moves away from its point.
export function calloutTextArea(look: Pick<CalloutLook, 'width' | 'height' | 'shape'>): { centerX: number; width: number; height: number } {
  const { width, height, shape } = look
  if (shape === 'ellipse' || shape === 'thoughtBubble' || shape === 'burst') return { centerX: 0, width: width * ROUND_TEXT_SHARE, height: height * ROUND_TEXT_SHARE }
  if (shape === 'arrowBox') {
    const tip = Math.min(width / 2, height * ARROW_TIP_PER_HEIGHT)
    return { centerX: -tip / 2, width: width - tip, height }
  }
  if (shape === 'banner') return { centerX: 0, width: width - 2 * Math.min(width / 4, height * BANNER_NOTCH_PER_HEIGHT), height }
  return { centerX: 0, width, height }
}

// A callout is drawn around the middle of its box. The picture reaches as far to every side as its tail and border do on any, so the middle of the picture is the middle of the box.
export function rasterizeCallout(look: CalloutLook, pixelsPerUnitX: number, pixelsPerUnitY: number): Raster {
  const halfWidth = Math.max(look.width / 2, Math.abs(look.tail?.x ?? 0)) + look.borderWidth
  const halfHeight = Math.max(look.height / 2, Math.abs(look.tail?.y ?? 0)) + look.borderWidth
  const raster = rasterOf(2 * halfWidth, 2 * halfHeight, pixelsPerUnitX, pixelsPerUnitY)
  const { context } = raster
  context.translate(halfWidth, halfHeight)

  const outline = calloutOutline(look)
  if (look.borderWidth > 0) {
    // The border lies around the shape. Its inner half is taken away again, so a fill that lets light through does not show it.
    context.lineJoin = 'round'
    context.lineWidth = 2 * look.borderWidth
    context.strokeStyle = look.borderColor
    context.stroke(outline)
    context.globalCompositeOperation = 'destination-out'
    context.fillStyle = '#000000'
    context.fill(outline)
    context.globalCompositeOperation = 'source-over'
  }
  context.fillStyle = look.fill
  context.fill(outline)

  if (look.text.text !== '') {
    const area = calloutTextArea(look)
    const words: TextLook = { ...look.text, boxWidth: area.width }
    const measure = measureText(words)
    context.translate(area.centerX - area.width / 2, -measure.naturalHeight / 2)
    drawText(raster, words, measure, undefined)
  }
  return { canvas: raster.canvas, naturalWidth: raster.naturalWidth, naturalHeight: raster.naturalHeight }
}

// The box an arrow is grabbed by: as long as the arrow, and as high as its heads.
export function arrowSize(look: Pick<ArrowLook, 'length' | 'thickness'>): Size {
  return { width: look.length, height: look.thickness * ARROW_HEIGHT_PER_THICKNESS }
}

// Draws the head at the end of an arrow that points along +x and ends at the origin. Returns how much of the line the head replaces.
function drawHead(context: OffscreenCanvasRenderingContext2D, head: ArrowHead, thickness: number): number {
  const size = thickness * ARROW_HEIGHT_PER_THICKNESS
  if (head === 'triangle') {
    context.beginPath()
    context.moveTo(0, 0)
    context.lineTo(-size, -size / 2)
    context.lineTo(-size, size / 2)
    context.closePath()
    context.fill()
    return size
  }
  if (head === 'open') {
    // The two strokes meet in a point at the very end of the arrow, so they start as far back as a mitre of this angle is long.
    const back = thickness / 2 / Math.sin(OPEN_HEAD_ANGLE)
    context.lineJoin = 'miter'
    context.beginPath()
    context.moveTo(-back - size * Math.cos(OPEN_HEAD_ANGLE), -size * Math.sin(OPEN_HEAD_ANGLE))
    context.lineTo(-back, 0)
    context.lineTo(-back - size * Math.cos(OPEN_HEAD_ANGLE), size * Math.sin(OPEN_HEAD_ANGLE))
    context.stroke()
    return back
  }
  if (head === 'dot') {
    context.beginPath()
    context.arc(0, 0, thickness * DOT_RADIUS_PER_THICKNESS, 0, 2 * Math.PI)
    context.fill()
  }
  return 0
}

export function rasterizeArrow(look: ArrowLook, pixelsPerUnitX: number, pixelsPerUnitY: number): Raster {
  const box = arrowSize(look)
  const bleed = look.thickness * ARROW_BLEED_PER_THICKNESS
  const raster = rasterOf(box.width + 2 * bleed, box.height + 2 * bleed, pixelsPerUnitX, pixelsPerUnitY)
  const { context } = raster
  context.translate(raster.naturalWidth / 2, raster.naturalHeight / 2)
  context.fillStyle = look.color
  context.strokeStyle = look.color
  context.lineWidth = look.thickness
  context.lineCap = 'butt'

  const half = look.length / 2
  context.save()
  context.translate(half, 0)
  const endTaken = drawHead(context, look.endHead, look.thickness)
  context.restore()
  context.save()
  context.translate(-half, 0)
  context.scale(-1, 1)
  const startTaken = drawHead(context, look.startHead, look.thickness)
  context.restore()

  // A head never takes more than its half of a short arrow.
  context.beginPath()
  context.moveTo(-half + Math.min(startTaken, half), 0)
  context.lineTo(half - Math.min(endTaken, half), 0)
  context.stroke()
  return { canvas: raster.canvas, naturalWidth: raster.naturalWidth, naturalHeight: raster.naturalHeight }
}
