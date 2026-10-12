// T-13: layers, transforms, crop, opacity and alpha, drawn bottom to top, checked against
// golden images at 120p, 1080p and 4K, plus a few pixels worked out by hand.
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
  // The card is eight colour bars (white, red, green, blue, yellow, cyan, magenta, dark grey)
  // whose alpha falls from 255 on the top row to 0 on the bottom row.
  it('blends a premultiplied layer over what is beneath it', async () => {
    const picture = await renderLayers(1920, 1080)

    // Background only, at (900, 60): the lossless card scaled 6×. Card pixel (150, 10) is the blue
    // bar with alpha 241; over black that is blue at 241.
    const background = pixelAt(picture, 900, 60)
    expect(Math.abs(background.blue - 241)).toBeLessThanOrEqual(2)
    expect(background.red + background.green).toBeLessThanOrEqual(2)
    expect(background.alpha).toBe(255)

    // Inside the "plain" image (centre 400, 250, drawn at 2×) at (440, 250): card pixel (180, 90)
    // is yellow with alpha 127. Beneath it the background is the red bar with alpha 196.
    // Result = 127 + 196 × (1 − 127/255) ≈ 225 red, 127 green, 0 blue.
    const blended = pixelAt(picture, 440, 250)
    expect(Math.abs(blended.red - 225)).toBeLessThanOrEqual(3)
    expect(Math.abs(blended.green - 127)).toBeLessThanOrEqual(3)
    expect(blended.blue).toBeLessThanOrEqual(2)
    expect(blended.alpha).toBe(255)
  })

  it('draws a pixel-aligned layer with exact edges', async () => {
    const picture = await renderLayers(1920, 1080)
    // The "plain" image covers x 80…719, y 70…429. Its top-left card pixel is opaque white.
    expect(pixelAt(picture, 80, 70)).toEqual({ red: 255, green: 255, blue: 255, alpha: 255 })
    // One pixel outside is untouched background: the white bar of the background (x < 240) at alpha ≈ 238.
    const outside = pixelAt(picture, 79, 70)
    expect(outside.red).toBeLessThan(245)
    expect(outside.red).toBe(outside.green)
    expect(outside.red).toBe(outside.blue)
  })

  it('applies opacity and draws higher tracks on top', async () => {
    const picture = await renderLayers(1920, 1080)
    // "small" (track 6) sits on top of everything at (1650, 850), scale 0.3: card pixel (160, 90),
    // yellow at alpha 127, so red and green are raised by at least 127 × (share not covered below).
    const top = pixelAt(picture, 1650, 850)
    expect(top.red).toBeGreaterThan(120)
    expect(top.green).toBeGreaterThan(120)
  })

  it('renders the same picture at every size, apart from detail', async () => {
    const small = await renderLayers(214, 120)
    const large = await renderLayers(1920, 1080)
    // Same canvas point (440, 250) in both: positions and sizes are in canvas units.
    const scale = 120 / 1080
    const smallPixel = pixelAt(small, Math.round(440 * scale), Math.round(250 * scale))
    const largePixel = pixelAt(large, 440, 250)
    expect(Math.abs(smallPixel.red - largePixel.red)).toBeLessThan(25)
    expect(Math.abs(smallPixel.green - largePixel.green)).toBeLessThan(25)
  })
})
