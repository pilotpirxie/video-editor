import { describe, expect, it } from 'vitest'
import { bundledFfmpeg, expectGolden, pixelAt, renderFrames, type Picture } from '../helpers.js'

const ffmpeg = bundledFfmpeg()

async function renderLayers(width: number, height: number): Promise<Picture> {
  const [picture] = await renderFrames('golden-layers', { via: 'paused', frames: [0], size: { width, height } })
  if (picture === undefined) throw new Error('Nothing was rendered')
  return picture
}

describe('compositor golden images', () => {
  it.each([
    { label: '120p', width: 214, height: 120 },
    { label: '1080p', width: 1920, height: 1080 },
    { label: '4K', width: 3840, height: 2160 },
  ])('matches the golden image at $label', async ({ label, width, height }) => {
    await expectGolden(ffmpeg, `layers-${label}`, await renderLayers(width, height))
  })
})

describe('compositor arithmetic', () => {
  it('blends a premultiplied layer over what is beneath it', async () => {
    const picture = await renderLayers(1920, 1080)

    const background = pixelAt(picture, 900, 60)
    expect(Math.abs(background.blue - 241)).toBeLessThanOrEqual(2)
    expect(background.red + background.green).toBeLessThanOrEqual(2)
    expect(background.alpha).toBe(255)

    const blended = pixelAt(picture, 440, 250)
    expect(Math.abs(blended.red - 225)).toBeLessThanOrEqual(3)
    expect(Math.abs(blended.green - 127)).toBeLessThanOrEqual(3)
    expect(blended.blue).toBeLessThanOrEqual(2)
    expect(blended.alpha).toBe(255)
  })

  it('draws a pixel-aligned layer with exact edges', async () => {
    const picture = await renderLayers(1920, 1080)
    expect(pixelAt(picture, 80, 70)).toEqual({ red: 255, green: 255, blue: 255, alpha: 255 })
    const outside = pixelAt(picture, 79, 70)
    expect(outside.red).toBeLessThan(245)
    expect(outside.red).toBe(outside.green)
    expect(outside.red).toBe(outside.blue)
  })

  it('applies opacity and draws higher tracks on top', async () => {
    const picture = await renderLayers(1920, 1080)
    const top = pixelAt(picture, 1650, 850)
    expect(top.red).toBeGreaterThan(120)
    expect(top.green).toBeGreaterThan(120)
  })

  it('renders the same picture at every size, apart from detail', async () => {
    const small = await renderLayers(214, 120)
    const large = await renderLayers(1920, 1080)
    const scale = 120 / 1080
    const smallPixel = pixelAt(small, Math.round(440 * scale), Math.round(250 * scale))
    const largePixel = pixelAt(large, 440, 250)
    expect(Math.abs(smallPixel.red - largePixel.red)).toBeLessThan(25)
    expect(Math.abs(smallPixel.green - largePixel.green)).toBeLessThan(25)
  })
})
