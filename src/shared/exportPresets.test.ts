import { describe, expect, it } from 'vitest'
import { EXPORT_PRESETS, exportSize, fitCanvas, isExportPreset } from './exportPresets.js'

const WIDE = { width: 1920, height: 1080 }
const CLASSIC = { width: 1440, height: 1080 }
const TALL = { width: 1080, height: 1920 }

describe('exportSize', () => {
  it('gives the §9 sizes for a 16:9 project', () => {
    expect(exportSize('120p', WIDE)).toEqual({ width: 214, height: 120 })
    expect(exportSize('240p', WIDE)).toEqual({ width: 426, height: 240 })
    expect(exportSize('360p', WIDE)).toEqual({ width: 640, height: 360 })
    expect(exportSize('480p', WIDE)).toEqual({ width: 854, height: 480 })
    expect(exportSize('720p', WIDE)).toEqual({ width: 1280, height: 720 })
    expect(exportSize('1080p', WIDE)).toEqual({ width: 1920, height: 1080 })
    expect(exportSize('1440p', WIDE)).toEqual({ width: 2560, height: 1440 })
    expect(exportSize('4k', WIDE)).toEqual({ width: 3840, height: 2160 })
  })

  it('gives 640×480 for a 4:3 project', () => {
    expect(exportSize('480p', CLASSIC)).toEqual({ width: 640, height: 480 })
  })

  it('keeps portrait projects portrait', () => {
    expect(exportSize('1080p', TALL)).toEqual({ width: 1080, height: 1920 })
    expect(exportSize('480p', TALL)).toEqual({ width: 480, height: 854 })
  })

  it('has fixed sizes for the social presets', () => {
    expect(exportSize('youtube-1080p', TALL)).toEqual({ width: 1920, height: 1080 })
    expect(exportSize('vertical-1080x1920', WIDE)).toEqual({ width: 1080, height: 1920 })
    expect(exportSize('square-1080', WIDE)).toEqual({ width: 1080, height: 1080 })
  })

  it('always gives even dimensions', () => {
    const odd = { width: 1001, height: 563 }
    for (const preset of EXPORT_PRESETS) {
      const size = exportSize(preset, odd)
      expect(size.width % 2, preset).toBe(0)
      expect(size.height % 2, preset).toBe(0)
    }
  })

  it('recognises preset names', () => {
    expect(isExportPreset('480p')).toBe(true)
    expect(isExportPreset('8k')).toBe(false)
  })
})

describe('fitCanvas', () => {
  it('fills the output when the aspect matches', () => {
    expect(fitCanvas(WIDE, { width: 960, height: 540 })).toEqual({ scale: 0.5, offsetX: 0, offsetY: 0 })
  })

  it('centres with bars when the aspect differs', () => {
    expect(fitCanvas(WIDE, { width: 1080, height: 1920 })).toEqual({ scale: 0.5625, offsetX: 0, offsetY: 656.25 })
    expect(fitCanvas(TALL, { width: 1920, height: 1080 })).toEqual({ scale: 0.5625, offsetX: 656.25, offsetY: 0 })
  })
})
