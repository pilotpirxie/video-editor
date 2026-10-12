// T-15: text in any installed font, with CJK and emoji, sharp at any output scale.
import { describe, expect, it } from 'vitest'
import { bundledFfmpeg, cropPicture, edgeStrength, expectGolden, halved, litFraction, psnr, renderFrames, type Picture } from '../helpers.js'

const ffmpeg = bundledFfmpeg()

async function renderText(width: number, height: number): Promise<Picture> {
  const [picture] = await renderFrames('golden-text', { via: 'paused', frames: [0], size: { width, height } })
  if (picture === undefined) throw new Error('Nothing was rendered')
  return picture
}

/** True when the region holds pixels that are clearly coloured, not white or grey. */
function hasColor(picture: Picture): boolean {
  const pixels = new Uint8Array(picture.data)
  let coloured = 0
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const red = pixels[offset] ?? 0
    const green = pixels[offset + 1] ?? 0
    const blue = pixels[offset + 2] ?? 0
    if (Math.max(red, green, blue) - Math.min(red, green, blue) > 60) coloured += 1
  }
  return coloured > 50
}

describe('text rendering', () => {
  it('matches the golden image', async () => {
    await expectGolden(ffmpeg, 'text-360p', await renderText(640, 360))
  })

  it('draws Latin, CJK and emoji glyphs', async () => {
    const picture = await renderText(640, 360)
    const latin = cropPicture(picture, 120, 45, 400, 50)
    const cjk = cropPicture(picture, 120, 135, 400, 50)
    const emoji = cropPicture(picture, 330, 215, 140, 50)
    expect(litFraction(latin)).toBeGreaterThan(0.05)
    // Real glyphs, not empty boxes: CJK strokes cover far more than a row of outlines would.
    expect(litFraction(cjk)).toBeGreaterThan(0.08)
    expect(hasColor(cjk)).toBe(true)
    // Emoji are drawn in their own colours, not in the white text colour.
    expect(hasColor(emoji)).toBe(true)
  })

  it('is re-drawn, not enlarged, at a larger output size', async () => {
    const normal = await renderText(640, 360)
    const double = await renderText(1280, 720)
    // Same layout: the large render reduced to half size is the normal render.
    expect(psnr(halved(double), normal)).toBeGreaterThan(28)
    // Twice the pixels across the same strokes keeps edges just as steep. An enlarged
    // picture would have about half the edge strength.
    expect(edgeStrength(double)).toBeGreaterThan(edgeStrength(normal) * 0.4)
    // At four times the size, strokes still go from black to white within a pixel or two.
    // A picture enlarged four times could not step by more than about a quarter of the range.
    const quadruple = await renderText(2560, 1440)
    const latinLine = cropPicture(quadruple, 600, 180, 1300, 220)
    expect(steepestEdge(latinLine)).toBeGreaterThan(120)
  })
})

/** The largest brightness step between two neighbouring pixels. */
function steepestEdge(picture: Picture): number {
  const pixels = new Uint8Array(picture.data)
  let steepest = 0
  for (let y = 0; y < picture.height; y++) {
    for (let x = 1; x < picture.width; x++) {
      const offset = (y * picture.width + x) * 4
      steepest = Math.max(steepest, Math.abs((pixels[offset] ?? 0) - (pixels[offset - 4] ?? 0)))
    }
  }
  return steepest
}
