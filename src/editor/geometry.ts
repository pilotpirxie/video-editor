import type { Size } from '../shared/exportPresets.js'
import type { Crop, Transform } from '../shared/project.js'
import { nearestWithin, type Bounds } from './snapping.js'

const DEGREES_TO_RADIANS = Math.PI / 180
const ROTATION_STEP = 15
const MIN_DRAWN_SIZE = 4

export type Point = {
  x: number
  y: number
}

// The rectangle a layer is drawn into, in canvas pixels, exactly as the compositor places it.
export type Box = {
  centerX: number
  centerY: number
  width: number
  height: number
  rotation: number
}

export const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const
export type Handle = (typeof HANDLES)[number]

export type SizeTargets = {
  widths: readonly number[]
  heights: readonly number[]
  range: number
}

export type Resized = {
  transform: Transform
  isSnapped: boolean
}

export type Cropped = {
  crop: Crop
  transform: Transform
}

export function boxOf(natural: Size, crop: Crop, transform: Transform): Box {
  return {
    centerX: transform.x,
    centerY: transform.y,
    width: (natural.width - crop.left - crop.right) * transform.scaleX,
    height: (natural.height - crop.top - crop.bottom) * transform.scaleY,
    rotation: transform.rotation,
  }
}

function rotated(point: Point, degrees: number): Point {
  const angle = degrees * DEGREES_TO_RADIANS
  const cosine = Math.cos(angle)
  const sine = Math.sin(angle)
  return { x: point.x * cosine - point.y * sine, y: point.x * sine + point.y * cosine }
}

// Position relative to the box centre, with the box's rotation undone.
export function toLocal(box: Box, point: Point): Point {
  return rotated({ x: point.x - box.centerX, y: point.y - box.centerY }, -box.rotation)
}

export function toCanvas(box: Box, local: Point): Point {
  const turned = rotated(local, box.rotation)
  return { x: box.centerX + turned.x, y: box.centerY + turned.y }
}

export function containsPoint(box: Box, point: Point): boolean {
  const local = toLocal(box, point)
  return Math.abs(local.x) <= box.width / 2 && Math.abs(local.y) <= box.height / 2
}

// Which way a handle points from the centre: -1, 0 or 1 on each axis.
export function handleDirection(handle: Handle): Point {
  const horizontal = handle.includes('e') ? 1 : 0
  const vertical = handle.includes('s') ? 1 : 0
  return { x: handle.includes('w') ? -1 : horizontal, y: handle.includes('n') ? -1 : vertical }
}

export function handlePosition(box: Box, handle: Handle): Point {
  const direction = handleDirection(handle)
  return toCanvas(box, { x: (direction.x * box.width) / 2, y: (direction.y * box.height) / 2 })
}

export function boundsOf(box: Box): Bounds {
  const corners = [handlePosition(box, 'nw'), handlePosition(box, 'ne'), handlePosition(box, 'se'), handlePosition(box, 'sw')]
  const xs = corners.map((corner) => corner.x)
  const ys = corners.map((corner) => corner.y)
  return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) }
}

type Stretch = {
  width: number
  height: number
  anchor: Point
  direction: Point
}

// How far the pointer pulls each side, measured from the opposite side, which stays where it is.
function stretchTo(box: Box, handle: Handle, pointer: Point): Stretch {
  const direction = handleDirection(handle)
  const local = toLocal(box, pointer)
  const anchor = { x: (-direction.x * box.width) / 2, y: (-direction.y * box.height) / 2 }
  return {
    width: direction.x === 0 ? box.width : Math.max(MIN_DRAWN_SIZE, (local.x - anchor.x) * direction.x),
    height: direction.y === 0 ? box.height : Math.max(MIN_DRAWN_SIZE, (local.y - anchor.y) * direction.y),
    anchor,
    direction,
  }
}

function centerAfter(box: Box, stretch: Stretch, width: number, height: number): Point {
  const { anchor, direction } = stretch
  return toCanvas(box, { x: anchor.x + (direction.x * width) / 2, y: anchor.y + (direction.y * height) / 2 })
}

export function scaleFromHandle(natural: Size, crop: Crop, transform: Transform, handle: Handle, pointer: Point, keepsAspect: boolean, targets?: SizeTargets): Resized {
  const box = boxOf(natural, crop, transform)
  const stretch = stretchTo(box, handle, pointer)
  let { width, height } = stretch
  const isCorner = stretch.direction.x !== 0 && stretch.direction.y !== 0
  const isUniform = keepsAspect && isCorner && box.width > 0 && box.height > 0
  if (isUniform) {
    const factor = Math.max(width / box.width, height / box.height)
    width = box.width * factor
    height = box.height * factor
  }

  const snappedWidth = targets === undefined || stretch.direction.x === 0 ? undefined : nearestWithin(width, targets.widths, targets.range)
  const snappedHeight = targets === undefined || stretch.direction.y === 0 ? undefined : nearestWithin(height, targets.heights, targets.range)
  if (snappedWidth !== undefined) {
    if (isUniform) height = (height * snappedWidth) / width
    width = snappedWidth
  } else if (snappedHeight !== undefined) {
    if (isUniform) width = (width * snappedHeight) / height
    height = snappedHeight
  }
  if (snappedHeight !== undefined && !isUniform) height = snappedHeight

  const center = centerAfter(box, stretch, width, height)
  const croppedWidth = natural.width - crop.left - crop.right
  const croppedHeight = natural.height - crop.top - crop.bottom
  return {
    transform: { ...transform, x: center.x, y: center.y, scaleX: width / croppedWidth, scaleY: height / croppedHeight },
    isSnapped: snappedWidth !== undefined || snappedHeight !== undefined,
  }
}

// Dragging a handle in crop mode hides or reveals picture on that side. The centre moves with it, so the picture that stays visible does not shift.
export function cropFromHandle(natural: Size, crop: Crop, transform: Transform, handle: Handle, pointer: Point): Cropped {
  const box = boxOf(natural, crop, transform)
  const stretch = stretchTo(box, handle, pointer)
  const { direction } = stretch
  const hiddenX = direction.x > 0 ? crop.right : crop.left
  const hiddenY = direction.y > 0 ? crop.bottom : crop.top
  const width = Math.min(stretch.width, box.width + hiddenX * transform.scaleX)
  const height = Math.min(stretch.height, box.height + hiddenY * transform.scaleY)
  const cropX = transform.scaleX === 0 ? hiddenX : hiddenX + (box.width - width) / transform.scaleX
  const cropY = transform.scaleY === 0 ? hiddenY : hiddenY + (box.height - height) / transform.scaleY

  const center = centerAfter(box, stretch, width, height)
  return {
    crop: {
      left: direction.x < 0 ? cropX : crop.left,
      right: direction.x > 0 ? cropX : crop.right,
      top: direction.y < 0 ? cropY : crop.top,
      bottom: direction.y > 0 ? cropY : crop.bottom,
    },
    transform: { ...transform, x: center.x, y: center.y },
  }
}

function angleTo(box: Box, point: Point): number {
  return Math.atan2(point.y - box.centerY, point.x - box.centerX) / DEGREES_TO_RADIANS
}

// The box turns by as much as the pointer has travelled around its centre; stepped rotation lands on multiples of 15 degrees.
export function rotationFromPointer(box: Box, grabbedAt: Point, pointer: Point, isStepped: boolean): number {
  const rotation = box.rotation + angleTo(box, pointer) - angleTo(box, grabbedAt)
  return isStepped ? Math.round(rotation / ROTATION_STEP) * ROTATION_STEP : rotation
}
