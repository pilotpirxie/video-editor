import { describe, expect, it } from 'vitest'
import { fitCanvas } from '../shared/exportPresets.js'
import type { CameraKeyframe, Easing } from '../shared/project.js'
import { largestScaleBetween, outputMapping, viewAt, wholeCanvas, type View } from './camera.js'

const SECOND = 24_000_000
const CANVAS = { width: 1920, height: 1080 }
const EASINGS: readonly Easing[] = ['linear', 'easeIn', 'easeOut', 'easeInOut']

function zoom(time: number, x: number, y: number, scale: number, settings: Partial<CameraKeyframe> = {}): CameraKeyframe {
  return { time, duration: SECOND, easing: 'linear', x, y, scale, ...settings }
}

function onScreen(view: View, point: { x: number; y: number }): { x: number; y: number } {
  return { x: (point.x - view.x) * view.scale, y: (point.y - view.y) * view.scale }
}

const IN = zoom(2 * SECOND, 400, 300, 3)
const OUT = zoom(5 * SECOND, 1200, 700, 1.5)
const CAMERA = [IN, OUT]

describe('viewAt', () => {
  it('shows the whole canvas when there is no camera and before the first move starts', () => {
    expect(viewAt(undefined, SECOND, CANVAS)).toEqual(wholeCanvas(CANVAS))
    expect(viewAt(CAMERA, 0, CANVAS)).toEqual({ x: 960, y: 540, scale: 1, largestScale: 1 })
    expect(viewAt(CAMERA, SECOND, CANVAS)).toEqual(wholeCanvas(CANVAS))
  })

  it('reaches each zoom at its time and rests there until the next move starts', () => {
    const reached = { x: 400, y: 300, scale: 3, largestScale: 3 }
    expect(viewAt(CAMERA, 2 * SECOND, CANVAS)).toEqual(reached)
    expect(viewAt(CAMERA, 4 * SECOND, CANVAS)).toEqual(reached)
    expect(viewAt(CAMERA, 5 * SECOND, CANVAS)).toEqual({ x: 1200, y: 700, scale: 1.5, largestScale: 1.5 })
    expect(viewAt(CAMERA, 60 * SECOND, CANVAS)).toEqual({ x: 1200, y: 700, scale: 1.5, largestScale: 1.5 })
  })

  it('keeps one point of the picture still on screen through the whole move', () => {
    const from = wholeCanvas(CANVAS)
    const still = {
      x: (IN.x * IN.scale - from.x * from.scale) / (IN.scale - from.scale),
      y: (IN.y * IN.scale - from.y * from.scale) / (IN.scale - from.scale),
    }
    const atStart = onScreen(from, still)
    for (let step = 0; step <= 20; step++) {
      const place = onScreen(viewAt(CAMERA, SECOND + (step / 20) * SECOND, CANVAS), still)
      expect(place.x).toBeCloseTo(atStart.x, 6)
      expect(place.y).toBeCloseTo(atStart.y, 6)
    }
  })

  it('moves the centre along the straight line between the two views', () => {
    for (let step = 1; step < 20; step++) {
      const view = viewAt(CAMERA, 4 * SECOND + (step / 20) * SECOND, CANVAS)
      const along = (view.x - IN.x) / (OUT.x - IN.x)
      expect(along).toBeGreaterThan(0)
      expect(along).toBeLessThan(1)
      expect(view.y).toBeCloseTo(IN.y + (OUT.y - IN.y) * along, 6)
    }
  })

  it('zooms by the same ratio in every equal step of a linear move', () => {
    const ratios: number[] = []
    for (let step = 0; step < 10; step++) {
      const before = viewAt(CAMERA, SECOND + (step / 10) * SECOND, CANVAS)
      const after = viewAt(CAMERA, SECOND + ((step + 1) / 10) * SECOND, CANVAS)
      ratios.push(after.scale / before.scale)
    }
    for (const ratio of ratios) expect(ratio).toBeCloseTo(3 ** 0.1, 9)
  })

  it.each(EASINGS)('never leaves the range between the two views with %s', (easing) => {
    const camera = [zoom(2 * SECOND, 400, 300, 3, { easing })]
    let previousScale = 1
    for (let step = 0; step <= 50; step++) {
      const view = viewAt(camera, SECOND + (step / 50) * SECOND, CANVAS)
      expect(view.scale).toBeGreaterThanOrEqual(previousScale - 1e-12)
      expect(view.scale).toBeLessThanOrEqual(3 + 1e-12)
      expect(view.x).toBeLessThanOrEqual(960 + 1e-9)
      expect(view.x).toBeGreaterThanOrEqual(400 - 1e-9)
      previousScale = view.scale
    }
  })

  it('pans in a straight line at an even speed when the scale stays the same', () => {
    const camera = [zoom(SECOND, 500, 400, 2), zoom(3 * SECOND, 900, 600, 2, { duration: 2 * SECOND })]
    expect(viewAt(camera, 1.5 * SECOND, CANVAS)).toEqual({ x: 600, y: 450, scale: 2, largestScale: 2 })
    expect(viewAt(camera, 2 * SECOND, CANVAS)).toEqual({ x: 700, y: 500, scale: 2, largestScale: 2 })
  })

  it('holds the view before it and jumps at its time when the easing is hold', () => {
    const camera = [zoom(2 * SECOND, 400, 300, 3, { easing: 'hold' })]
    expect(viewAt(camera, 2 * SECOND - 100, CANVAS)).toEqual({ x: 960, y: 540, scale: 1, largestScale: 3 })
    expect(viewAt(camera, 2 * SECOND, CANVAS)).toEqual({ x: 400, y: 300, scale: 3, largestScale: 3 })
  })

  it('starts a move no earlier than the zoom before it was reached', () => {
    const camera = [zoom(SECOND, 600, 400, 2), zoom(1.5 * SECOND, 800, 500, 4, { duration: 5 * SECOND })]
    expect(viewAt(camera, SECOND, CANVAS)).toEqual({ x: 600, y: 400, scale: 2, largestScale: 2 })
    expect(viewAt(camera, 1.25 * SECOND, CANVAS).scale).toBeCloseTo(2 * 2 ** 0.5, 9)
  })

  it('moves a view that reaches past the edge of the canvas back inside', () => {
    expect(viewAt([zoom(0, 0, 2000, 2)], SECOND, CANVAS)).toEqual({ x: 480, y: 810, scale: 2, largestScale: 2 })
    expect(viewAt([zoom(0, 3000, -50, 4)], SECOND, CANVAS)).toEqual({ x: 1680, y: 135, scale: 4, largestScale: 4 })
    expect(viewAt([zoom(0, 100, 100, 1)], SECOND, CANVAS)).toEqual(wholeCanvas(CANVAS))
  })

  it('names the largest scale of the move it is in, so pictures can be made ready for the whole move', () => {
    expect(viewAt(CAMERA, 1.5 * SECOND, CANVAS).largestScale).toBe(3)
    expect(viewAt(CAMERA, 4.5 * SECOND, CANVAS).largestScale).toBe(3)
    expect(viewAt(CAMERA, 3 * SECOND, CANVAS).largestScale).toBe(3)
    expect(viewAt(CAMERA, 6 * SECOND, CANVAS).largestScale).toBe(1.5)
  })
})

describe('largestScaleBetween', () => {
  it('is 1 without a camera', () => {
    expect(largestScaleBetween(undefined, 0, 10 * SECOND, CANVAS)).toBe(1)
  })

  it('finds a zoom that is reached and left again inside the span', () => {
    expect(largestScaleBetween(CAMERA, 0, 10 * SECOND, CANVAS)).toBe(3)
    expect(largestScaleBetween(CAMERA, 5 * SECOND, 10 * SECOND, CANVAS)).toBe(1.5)
    expect(largestScaleBetween(CAMERA, 0, SECOND, CANVAS)).toBe(1)
  })

  it('counts the part of a move that the span ends in', () => {
    expect(largestScaleBetween(CAMERA, 0, 1.5 * SECOND, CANVAS)).toBeCloseTo(3 ** 0.5, 9)
  })
})

describe('outputMapping', () => {
  it('is the fitted canvas when the camera shows the whole canvas', () => {
    const output = { width: 1080, height: 1920 }
    const fit = fitCanvas(CANVAS, output)
    expect(outputMapping(CANVAS, output, wholeCanvas(CANVAS))).toEqual({ scale: fit.scale, offsetX: fit.offsetX, offsetY: fit.offsetY })
  })

  it('puts the centre of the view in the middle of the output, enlarged by the scale', () => {
    const output = { width: 960, height: 540 }
    const mapping = outputMapping(CANVAS, output, { x: 400, y: 300, scale: 3, largestScale: 3 })
    expect(mapping.scale).toBe(1.5)
    expect(mapping.offsetX + 400 * mapping.scale).toBe(480)
    expect(mapping.offsetY + 300 * mapping.scale).toBe(270)
  })
})
