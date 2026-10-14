import type { Size } from '../shared/exportPresets.js'
import type { Crop } from '../shared/project.js'
import { boundsOf, type Box, type Point } from './geometry.js'
import type { Bounds } from './snapping.js'

// A picture-in-picture clip is this share of the canvas, in both directions.
const PIP_SHARE = 1 / 3

// A clip as the canvas shows it, all in canvas pixels.
export type ArrangedItem = {
  id: string
  box: Box
  // Where the clip's position puts it. Only a group has the middle of its box elsewhere.
  place: Point
  scaleX: number
  scaleY: number
  // A video or an image: the size of its whole picture, so a cell it fills can cut away what spills over.
  natural?: Size
}

// Where a clip goes, as the canvas sees it. A crop is only given to a picture that fills its cell.
export type Arranged = {
  x: number
  y: number
  scaleX?: number
  scaleY?: number
  crop?: Crop
}

// A cell keeps its size as given: worked out from its edges, the cells of one grid would differ in the last digits, and so would the clips put into them.
type Cell = {
  centerX: number
  centerY: number
  width: number
  height: number
}

function cellAt(left: number, top: number, width: number, height: number): Cell {
  return { centerX: left + width / 2, centerY: top + height / 2, width, height }
}

export type AlignEdge = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom'
export type DistributeAxis = 'across' | 'down'
export type ArrangePreset = 'grid2' | 'grid3' | 'onePlusThree' | 'pipTopLeft' | 'pipTopRight' | 'pipBottomLeft' | 'pipBottomRight'

export type ArrangeOptions = {
  // Canvas pixels between the cells and around them.
  gap: number
  // Filled, a cell is covered and a picture is cropped to it; fitted, the whole clip shows inside it.
  isFill: boolean
}

function unionOf(all: readonly Bounds[]): Bounds {
  return {
    left: Math.min(...all.map((bounds) => bounds.left)),
    top: Math.min(...all.map((bounds) => bounds.top)),
    right: Math.max(...all.map((bounds) => bounds.right)),
    bottom: Math.max(...all.map((bounds) => bounds.bottom)),
  }
}

function moved(item: ArrangedItem, dx: number, dy: number): Arranged {
  return { x: item.place.x + dx, y: item.place.y + dy }
}

// One clip lines up with the canvas, several with the box around them all.
export function align(items: readonly ArrangedItem[], edge: AlignEdge, canvas: Size): Map<string, Arranged> {
  const placed = new Map<string, Arranged>()
  if (items.length === 0) return placed
  const target = items.length === 1 ? { left: 0, top: 0, right: canvas.width, bottom: canvas.height } : unionOf(items.map((item) => boundsOf(item.box)))
  for (const item of items) {
    const bounds = boundsOf(item.box)
    let dx = 0
    let dy = 0
    if (edge === 'left') dx = target.left - bounds.left
    else if (edge === 'center') dx = (target.left + target.right - bounds.left - bounds.right) / 2
    else if (edge === 'right') dx = target.right - bounds.right
    else if (edge === 'top') dy = target.top - bounds.top
    else if (edge === 'middle') dy = (target.top + target.bottom - bounds.top - bounds.bottom) / 2
    else dy = target.bottom - bounds.bottom
    placed.set(item.id, moved(item, dx, dy))
  }
  return placed
}

// The first and the last clip stay; those between them move so that the gaps between all of them are equal.
export function distribute(items: readonly ArrangedItem[], axis: DistributeAxis): Map<string, Arranged> {
  const placed = new Map<string, Arranged>()
  if (items.length < 3) return placed
  const isAcross = axis === 'across'
  const spans = items.map((item) => {
    const bounds = boundsOf(item.box)
    return isAcross ? { item, start: bounds.left, end: bounds.right } : { item, start: bounds.top, end: bounds.bottom }
  })
  spans.sort((a, b) => a.start - b.start)
  const first = spans[0]
  const last = spans.at(-1)
  if (first === undefined || last === undefined) return placed

  let taken = 0
  for (const span of spans) taken += span.end - span.start
  const gap = (last.end - first.start - taken) / (spans.length - 1)
  let next = first.start
  for (const span of spans) {
    const shift = next - span.start
    placed.set(span.item.id, isAcross ? moved(span.item, shift, 0) : moved(span.item, 0, shift))
    next += span.end - span.start + gap
  }
  return placed
}

function gridCells(canvas: Size, gap: number, count: number): Cell[] {
  const width = (canvas.width - gap * (count + 1)) / count
  const height = (canvas.height - gap * (count + 1)) / count
  const cells: Cell[] = []
  for (let row = 0; row < count; row += 1) {
    for (let column = 0; column < count; column += 1) {
      cells.push(cellAt(gap + column * (width + gap), gap + row * (height + gap), width, height))
    }
  }
  return cells
}

// One large cell on the left, two thirds of the width, and three small ones above each other on the right.
function onePlusThreeCells(canvas: Size, gap: number): Cell[] {
  const smallWidth = (canvas.width - 3 * gap) / 3
  const smallHeight = (canvas.height - 4 * gap) / 3
  const smallLeft = canvas.width - gap - smallWidth
  const cells: Cell[] = [cellAt(gap, gap, smallLeft - 2 * gap, canvas.height - 2 * gap)]
  for (let row = 0; row < 3; row += 1) {
    cells.push(cellAt(smallLeft, gap + row * (smallHeight + gap), smallWidth, smallHeight))
  }
  return cells
}

// The first clip fills the canvas; the others go into the corner, a third of the canvas each, one after another away from it.
function pictureInPictureCells(canvas: Size, gap: number, preset: ArrangePreset, count: number): Cell[] {
  const width = canvas.width * PIP_SHARE
  const height = canvas.height * PIP_SHARE
  const isLeft = preset === 'pipTopLeft' || preset === 'pipBottomLeft'
  const isTop = preset === 'pipTopLeft' || preset === 'pipTopRight'
  const left = isLeft ? gap : canvas.width - gap - width
  const cells: Cell[] = [cellAt(0, 0, canvas.width, canvas.height)]
  for (let index = 0; index < count - 1; index += 1) {
    const offset = index * (height + gap)
    const top = isTop ? gap + offset : canvas.height - gap - height - offset
    cells.push(cellAt(left, top, width, height))
  }
  return cells
}

function cellsOf(preset: ArrangePreset, canvas: Size, gap: number, count: number): Cell[] {
  if (preset === 'grid2') return gridCells(canvas, gap, 2)
  if (preset === 'grid3') return gridCells(canvas, gap, 3)
  if (preset === 'onePlusThree') return onePlusThreeCells(canvas, gap)
  return pictureInPictureCells(canvas, gap, preset, count)
}

// A filled picture is scaled to cover the cell from its whole picture, and what spills over is cropped away evenly on both sides.
function filledPicture(item: ArrangedItem, natural: Size, cell: Cell): Arranged {
  const factor = Math.max(cell.width / (natural.width * item.scaleX), cell.height / (natural.height * item.scaleY))
  const scaleX = item.scaleX * factor
  const scaleY = item.scaleY * factor
  const spillX = (natural.width - cell.width / scaleX) / 2
  const spillY = (natural.height - cell.height / scaleY) / 2
  return {
    x: cell.centerX,
    y: cell.centerY,
    scaleX,
    scaleY,
    crop: { left: spillX, top: spillY, right: spillX, bottom: spillY },
  }
}

// The clip is scaled about the middle of its box until that box, turned as it is, fits or covers the cell, and that middle is put on the cell's.
function placedIn(item: ArrangedItem, cell: Cell, isFill: boolean): Arranged {
  const isUpright = item.box.rotation % 360 === 0
  if (isFill && isUpright && item.natural !== undefined) return filledPicture(item, item.natural, cell)
  const bounds = boundsOf(item.box)
  const width = bounds.right - bounds.left
  const height = bounds.bottom - bounds.top
  if (width <= 0 || height <= 0) return { x: item.place.x, y: item.place.y }
  const factor = isFill ? Math.max(cell.width / width, cell.height / height) : Math.min(cell.width / width, cell.height / height)
  return {
    x: cell.centerX + (item.place.x - item.box.centerX) * factor,
    y: cell.centerY + (item.place.y - item.box.centerY) * factor,
    scaleX: item.scaleX * factor,
    scaleY: item.scaleY * factor,
  }
}

// Puts the clips into the cells of a layout in the order given. Clips beyond the last cell stay where they are.
export function arrange(items: readonly ArrangedItem[], preset: ArrangePreset, canvas: Size, options: ArrangeOptions): Map<string, Arranged> {
  const placed = new Map<string, Arranged>()
  const cells = cellsOf(preset, canvas, Math.max(0, options.gap), items.length)
  for (const [index, item] of items.entries()) {
    const cell = cells[index]
    if (cell === undefined) break
    placed.set(item.id, placedIn(item, cell, options.isFill))
  }
  return placed
}
