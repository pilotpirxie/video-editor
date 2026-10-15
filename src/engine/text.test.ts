import { describe, expect, it } from 'vitest'
import { rasterSize } from './text.js'

const MAX_PIXELS = 4096 * 4096

describe('rasterSize', () => {
  it('keeps the exact size of an ordinary drawing', () => {
    expect(rasterSize(320.5, 90, 2, 2)).toEqual({ width: 641, height: 180 })
  })

  it('never makes a raster of less than one pixel', () => {
    expect(rasterSize(0.001, 0.001, 1, 1)).toEqual({ width: 1, height: 1 })
  })

  it('shrinks a heading zoomed in a hundred times to the pixel budget, keeping its shape', () => {
    const size = rasterSize(400, 200, 100, 100)
    expect(size.width * size.height).toBeLessThanOrEqual(MAX_PIXELS + size.width + size.height)
    expect(size.width / size.height).toBeCloseTo(2, 2)
  })

  it('lets a long thin banner stay wider than the square budget', () => {
    const size = rasterSize(8000, 100, 1, 1)
    expect(size).toEqual({ width: 8000, height: 100 })
  })

  it('keeps the shape of a drawing that is too long on one side', () => {
    const size = rasterSize(40_000, 100, 1, 1)
    expect(size).toEqual({ width: 8192, height: 21 })
  })

  it('stays finite for absurd sizes from a hand-edited file', () => {
    for (const size of [rasterSize(1e300, 1e300, 10, 10), rasterSize(Infinity, 5, 1, 1), rasterSize(NaN, NaN, 1, 1)]) {
      expect(Number.isFinite(size.width) && Number.isFinite(size.height)).toBe(true)
      expect(size.width * size.height).toBeLessThanOrEqual(MAX_PIXELS + size.width + size.height)
    }
  })

  it('makes the most-zoomed text no larger than 64 MB of pixels', () => {
    const size = rasterSize(2000, 2000, 10, 10)
    expect(size.width * size.height).toBeLessThanOrEqual(MAX_PIXELS + size.width + size.height)
  })
})
