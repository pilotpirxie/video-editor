import { describe, expect, it } from 'vitest'
import type { Crop, Transform } from '../shared/project.js'
import { boundsOf, boxOf, containsPoint, cropFromHandle, cropFromValue, handlePosition, rotationFromPointer, scaleFromHandle, toCanvas, toLocal, type Box, type Point } from './geometry.js'

const NATURAL = { width: 400, height: 200 }
const NO_CROP: Crop = { left: 0, top: 0, right: 0, bottom: 0 }
const UPRIGHT: Transform = { x: 500, y: 300, scaleX: 1, scaleY: 1, rotation: 0 }
const TURNED: Transform = { x: 500, y: 300, scaleX: 0.5, scaleY: 0.5, rotation: 90 }

function expectPoint(actual: Point, expected: Point): void {
  expect(actual.x).toBeCloseTo(expected.x, 6)
  expect(actual.y).toBeCloseTo(expected.y, 6)
}

function sourcePointOnCanvas(source: Point, crop: Crop, transform: Transform): Point {
  const box = boxOf(NATURAL, crop, transform)
  const croppedWidth = NATURAL.width - crop.left - crop.right
  const croppedHeight = NATURAL.height - crop.top - crop.bottom
  return toCanvas(box, { x: (source.x - crop.left - croppedWidth / 2) * transform.scaleX, y: (source.y - crop.top - croppedHeight / 2) * transform.scaleY })
}

describe('boxOf', () => {
  it('is the cropped picture, scaled, around the transform position', () => {
    const box = boxOf(NATURAL, { left: 100, top: 0, right: 0, bottom: 50 }, { ...UPRIGHT, scaleX: 2, scaleY: 0.5, rotation: 30 })
    expect(box).toEqual({ centerX: 500, centerY: 300, width: 600, height: 75, rotation: 30 })
  })
})

describe('containsPoint', () => {
  it('follows the rotation: a quarter turn clockwise swaps the sides', () => {
    const box = boxOf(NATURAL, NO_CROP, TURNED)
    expect(containsPoint(box, { x: 500, y: 395 })).toBe(true)
    expect(containsPoint(box, { x: 595, y: 300 })).toBe(false)
    expect(containsPoint(box, { x: 545, y: 300 })).toBe(true)
  })

  it('puts the corners where the compositor draws them', () => {
    const box = boxOf(NATURAL, NO_CROP, { ...UPRIGHT, rotation: 90 })
    expectPoint(handlePosition(box, 'nw'), { x: 600, y: 100 })
    expectPoint(handlePosition(box, 'se'), { x: 400, y: 500 })
    expect(boundsOf(box).left).toBeCloseTo(400, 6)
    expect(boundsOf(box).bottom).toBeCloseTo(500, 6)
  })

  it('converts to the local frame and back', () => {
    const box: Box = { centerX: 10, centerY: 20, width: 100, height: 50, rotation: 37 }
    expectPoint(toCanvas(box, toLocal(box, { x: 123, y: -45 })), { x: 123, y: -45 })
  })
})

describe('scaleFromHandle', () => {
  it('keeps the opposite corner in place and the aspect ratio by default', () => {
    const before = boxOf(NATURAL, NO_CROP, UPRIGHT)
    const { transform } = scaleFromHandle(NATURAL, NO_CROP, UPRIGHT, 'se', { x: 900, y: 450 }, true)
    expect(transform.scaleX).toBeCloseTo(1.5, 6)
    expect(transform.scaleY).toBeCloseTo(1.5, 6)
    expectPoint(handlePosition(boxOf(NATURAL, NO_CROP, transform), 'nw'), handlePosition(before, 'nw'))
  })

  it('stretches freely when the aspect ratio is released', () => {
    const { transform } = scaleFromHandle(NATURAL, NO_CROP, UPRIGHT, 'se', { x: 900, y: 450 }, false)
    expect(transform.scaleX).toBeCloseTo(1.5, 6)
    expect(transform.scaleY).toBeCloseTo(1.25, 6)
  })

  it('stretches one axis from an edge handle', () => {
    const { transform } = scaleFromHandle(NATURAL, NO_CROP, UPRIGHT, 'w', { x: 200, y: 999 }, true)
    expect(transform).toMatchObject({ scaleX: 1.25, scaleY: 1, y: 300 })
    expect(transform.x).toBeCloseTo(450, 6)
  })

  it('works in the frame of a rotated, cropped clip', () => {
    const crop: Crop = { left: 100, top: 0, right: 0, bottom: 0 }
    const before = boxOf(NATURAL, crop, TURNED)
    const pointer = toCanvas(before, { x: 225, y: 150 })
    const { transform } = scaleFromHandle(NATURAL, crop, TURNED, 'se', pointer, true)
    expect(transform.scaleX).toBeCloseTo(1, 6)
    expect(transform.scaleY).toBeCloseTo(1, 6)
    expectPoint(handlePosition(boxOf(NATURAL, crop, transform), 'nw'), handlePosition(before, 'nw'))
  })

  it('never collapses to nothing', () => {
    const { transform } = scaleFromHandle(NATURAL, NO_CROP, UPRIGHT, 'se', { x: 0, y: 0 }, false)
    expect(transform.scaleX).toBeGreaterThan(0)
    expect(transform.scaleY).toBeGreaterThan(0)
  })

  it('snaps the size to a target and keeps the aspect ratio', () => {
    const targets = { widths: [800], heights: [1080], range: 10 }
    const resized = scaleFromHandle(NATURAL, NO_CROP, UPRIGHT, 'se', { x: 1094, y: 400 }, true, targets)
    expect(resized.isSnapped).toBe(true)
    expect(resized.transform.scaleX).toBeCloseTo(2, 6)
    expect(resized.transform.scaleY).toBeCloseTo(2, 6)
    expect(scaleFromHandle(NATURAL, NO_CROP, UPRIGHT, 'se', { x: 1000, y: 400 }, true, targets).isSnapped).toBe(false)
  })
})

describe('cropFromHandle', () => {
  it('hides picture on the dragged side without moving the picture that stays', () => {
    const transform: Transform = { x: 500, y: 300, scaleX: 2, scaleY: 2, rotation: 30 }
    const before = boxOf(NATURAL, NO_CROP, transform)
    const pointer = toCanvas(before, { x: 300, y: 0 })
    const cropped = cropFromHandle(NATURAL, NO_CROP, transform, 'e', pointer)
    expect(cropped.crop).toEqual({ left: 0, top: 0, right: 50, bottom: 0 })
    const stays = { x: 120, y: 80 }
    expectPoint(sourcePointOnCanvas(stays, cropped.crop, cropped.transform), sourcePointOnCanvas(stays, NO_CROP, transform))
  })

  it('reveals picture again, but never more than the source has', () => {
    const crop: Crop = { left: 40, top: 10, right: 0, bottom: 0 }
    const before = boxOf(NATURAL, crop, UPRIGHT)
    const far = toCanvas(before, { x: -5000, y: -5000 })
    const revealed = cropFromHandle(NATURAL, crop, UPRIGHT, 'nw', far)
    expect(revealed.crop.left).toBeCloseTo(0, 6)
    expect(revealed.crop.top).toBeCloseTo(0, 6)
    const stays = { x: 300, y: 150 }
    expectPoint(sourcePointOnCanvas(stays, revealed.crop, revealed.transform), sourcePointOnCanvas(stays, crop, UPRIGHT))
  })
})

describe('cropFromValue', () => {
  const transform: Transform = { x: 500, y: 300, scaleX: 2, scaleY: 0.5, rotation: 30 }
  const crop: Crop = { left: 10, top: 20, right: 30, bottom: 40 }

  it('hides picture on each side without moving the picture that stays', () => {
    const stays = { x: 200, y: 100 }
    for (const side of ['left', 'top', 'right', 'bottom'] as const) {
      const cropped = cropFromValue(NATURAL, crop, transform, side, 60)
      expect(cropped.crop).toEqual({ ...crop, [side]: 60 })
      expectPoint(sourcePointOnCanvas(stays, cropped.crop, cropped.transform), sourcePointOnCanvas(stays, crop, transform))
    }
  })

  it('gives what dragging the handle to the same crop gives', () => {
    const before = boxOf(NATURAL, crop, transform)
    const dragged = cropFromHandle(NATURAL, crop, transform, 'w', toCanvas(before, { x: -200, y: 0 }))
    const typed = cropFromValue(NATURAL, crop, transform, 'left', dragged.crop.left)
    expect(typed.crop.left).toBeCloseTo(dragged.crop.left, 6)
    expectPoint(typed.transform, dragged.transform)
  })

  it('leaves at least one pixel of the picture and never goes below nothing', () => {
    expect(cropFromValue(NATURAL, crop, UPRIGHT, 'left', 5000).crop.left).toBe(400 - 30 - 1)
    expect(cropFromValue(NATURAL, crop, UPRIGHT, 'bottom', 5000).crop.bottom).toBe(200 - 20 - 1)
    const none = cropFromValue(NATURAL, crop, UPRIGHT, 'top', -50)
    expect(none.crop.top).toBe(0)
    expect(none.transform.y).toBe(300 - 10)
  })
})

describe('rotationFromPointer', () => {
  const box = boxOf(NATURAL, NO_CROP, UPRIGHT)

  it('turns the box by the angle the pointer travelled around the centre', () => {
    expect(rotationFromPointer(box, { x: 500, y: 100 }, { x: 700, y: 300 }, false)).toBeCloseTo(90, 6)
    expect(rotationFromPointer({ ...box, rotation: 20 }, { x: 500, y: 100 }, { x: 700, y: 300 }, false)).toBeCloseTo(110, 6)
  })

  it('steps by 15 degrees when asked', () => {
    expect(rotationFromPointer(box, { x: 500, y: 100 }, { x: 560, y: 100 }, true)).toBe(15)
    expect(rotationFromPointer(box, { x: 500, y: 100 }, { x: 510, y: 100 }, true)).toBe(0)
  })
})
