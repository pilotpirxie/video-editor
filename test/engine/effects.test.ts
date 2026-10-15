import { describe, expect, it } from 'vitest'
import type { BlurClip, Clip, Effect, HighlightClip, Transform } from '../../src/shared/project.js'
import { SECOND } from '../fixtures.js'
import { KEY_GREEN, SUBJECT_MAGENTA } from '../media/generate.js'
import {
  at,
  BLUE,
  FIRST_SECOND,
  frameOfTracks,
  RED,
  SMALL_CANVAS,
  WHITE,
  WHITE_GROUND,
  bundledFfmpeg,
  cropPicture,
  expectGolden,
  expectPixel,
  halved,
  imageOf,
  pictureAt,
  pixelAt,
  projectOfTracks,
  psnr,
  renderFrames,
  renderProject,
  sameBytes,
  scratchDirectory,
  type Picture,
} from '../helpers.js'

const ffmpeg = bundledFfmpeg()
const scratch = scratchDirectory('effects')
const GREY = { red: 128, green: 128, blue: 128 }

type Area = {
  transform: Transform
  width: number
  height: number
}

function blurOf(id: string, area: Area, settings: Partial<BlurClip>): Clip {
  return { id, type: 'blur', ...FIRST_SECOND, ...area, opacity: 1, shape: 'rectangle', softEdge: 0, strength: 8, ...settings }
}

function highlightOf(id: string, area: Area, settings: Partial<HighlightClip> = {}): Clip {
  return { id, type: 'highlight', ...FIRST_SECOND, ...area, opacity: 1, shape: 'rectangle', softEdge: 0, color: '#FFE94D', ...settings }
}

function frameOf(name: string, tracks: readonly Clip[][], frame = 0): Promise<Picture> {
  return frameOfTracks(scratch, name, tracks, frame)
}

// The share of a bell curve that lies below `deviations` standard deviations from its middle (Abramowitz and Stegun 26.2.17).
function shareBelow(deviations: number): number {
  const reach = 1 / (1 + 0.2316419 * Math.abs(deviations))
  const tail = 0.3989423 * Math.exp((-deviations * deviations) / 2) * reach * (0.3193815 + reach * (-0.3565638 + reach * (1.781478 + reach * (-1.821256 + reach * 1.330274))))
  return deviations >= 0 ? 1 - tail : tail
}

describe('blur and pixelate clips', () => {
  it('blurs a hard edge into the ramp its strength stands for, the same on both sides', async () => {
    // Black on the left, white on the right, cut at x = 160, at the size the card has: enlarged, its edge would be soft before any blur. The upper half is blurred by 2, the lower by 8.
    const tracks = [
      [imageOf('image-edge.png', 'edge', FIRST_SECOND, at(160, 90, 1))],
      [blurOf('slight', { transform: at(160, 45, 1), width: 320, height: 90 }, { strength: 2 })],
      [blurOf('strong', { transform: at(160, 135, 1), width: 320, height: 90 }, { strength: 8 })],
    ]
    const picture = pictureAt(await renderProject(scratch, 'ramp', projectOfTracks({ width: 320, height: 180 }, tracks), { via: 'paused', frames: [0] }), 0)
    for (const { row, strength, tolerance } of [{ row: 45, strength: 2, tolerance: 3 }, { row: 135, strength: 8, tolerance: 8 }]) {
      let previous = 0
      for (let x = 160 - 3 * strength; x <= 160 + 3 * strength; x++) {
        const { red } = pixelAt(picture, x, row)
        const expected = 255 * shareBelow((x + 0.5 - 160) / strength)
        expect(Math.abs(red - expected), `strength ${strength}, x ${x}: ${red} for ${expected.toFixed(1)}`).toBeLessThanOrEqual(tolerance)
        expect(red).toBeGreaterThanOrEqual(previous)
        expect(Math.abs(red + pixelAt(picture, 319 - x, row).red - 255)).toBeLessThanOrEqual(2)
        previous = red
      }
    }
  })

  it('looks the same at 4K as at a sixteenth of that size', async () => {
    const large = pictureAt(await renderFrames('15-blur-highlight', { via: 'paused', frames: [0], size: { width: 3840, height: 2160 } }), 0)
    const small = pictureAt(await renderFrames('15-blur-highlight', { via: 'paused', frames: [0], size: { width: 240, height: 135 } }), 0)
    const reduced = halved(halved(halved(halved(large))))
    // The inside of the blurred rectangle, which spans 200 to 800 by 250 to 550 on the 1920 wide canvas.
    expect(psnr(cropPicture(reduced, 33, 39, 60, 22), cropPicture(small, 33, 39, 60, 22))).toBeGreaterThan(32)
  })

  it('fills every block of a pixelated clip with the mean of what is beneath it', async () => {
    // The magenta subject spans 200 to 440 by 100 to 260; blocks of 40 start at the corner of the canvas.
    const tracks = [[imageOf('image-green-screen.png', 'picture', FIRST_SECOND, at(320, 180, 2))], [blurOf('blocks', { transform: at(320, 180, 1), width: 640, height: 360 }, { strength: 40, isPixelated: true })]]
    const picture = await frameOf('blocks', tracks)
    expectPixel(picture, 20, 20, KEY_GREEN, 2)
    expectPixel(picture, 300, 180, SUBJECT_MAGENTA, 2)
    const mixed = { red: 100, green: 109, blue: 112 }
    expectPixel(picture, 225, 85, mixed, 10)
    expectPixel(picture, 225, 115, pixelAt(picture, 225, 85), 1)
    expectPixel(picture, 205, 100, pixelAt(picture, 235, 100), 1)
  })

  it('matches the golden images at 120p and at 4K', async () => {
    for (const { label, width, height } of [{ label: '120p', width: 214, height: 120 }, { label: '4K', width: 3840, height: 2160 }]) {
      const pictures = await renderFrames('15-blur-highlight', { via: 'paused', frames: [0], size: { width, height } })
      await expectGolden(ffmpeg, `blur-${label}`, pictureAt(pictures, 0))
    }
  })
})

describe('highlight and spotlight clips', () => {
  it('multiplies what is beneath by the colour: inside the shape for a highlight, outside it for a spotlight', async () => {
    const tracks = [
      [WHITE_GROUND],
      [
        highlightOf('marker', { transform: at(160, 180, 1), width: 200, height: 200 }),
        highlightOf('spot', { transform: at(320, 180, 1), width: 300, height: 200 }, { start: SECOND, shape: 'ellipse', color: '#404040', isSpotlight: true }),
      ],
      [highlightOf('faint', { transform: at(480, 180, 1), width: 200, height: 200 }, { opacity: 0.5 })],
    ]
    const pictures = await renderProject(scratch, 'marker', projectOfTracks(SMALL_CANVAS, tracks), { via: 'paused', frames: [0, 30] })
    const marked = pictureAt(pictures, 0)
    expectPixel(marked, 160, 180, { red: 255, green: 233, blue: 77 })
    expectPixel(marked, 480, 180, { red: 255, green: 244, blue: 166 })
    expectPixel(marked, 320, 180, WHITE, 0)
    expectPixel(marked, 320, 20, WHITE, 0)

    const lit = pictureAt(pictures, 1)
    expectPixel(lit, 320, 180, WHITE, 0)
    expectPixel(lit, 20, 20, { red: 64, green: 64, blue: 64 })
    expectPixel(lit, 620, 340, { red: 64, green: 64, blue: 64 })
  })

  it('matches the golden image of a spotlight, and draws it the same after other frames', async () => {
    const size = { width: 640, height: 360 }
    const alone = await renderFrames('15-blur-highlight', { via: 'paused', frames: [30], size })
    const afterBlur = await renderFrames('15-blur-highlight', { via: 'paused', frames: [0, 30], size })
    await expectGolden(ffmpeg, 'spotlight-360p', pictureAt(alone, 0))
    expect(sameBytes(pictureAt(alone, 0), pictureAt(afterBlur, 1))).toBe(true)
  })
})

describe('effects', () => {
  // Tiles of 160 by 90 on white. The magenta subject of the green-screen card is the middle 60 by 40 of its tile.
  function tile(file: string, id: string, x: number, y: number, effects: Effect[], rotation = 0): Clip[] {
    return [imageOf(file, id, FIRST_SECOND, at(x, y, 0.5, rotation), effects.length === 0 ? {} : { effects })]
  }

  it('changes each pixel as its settings say', async () => {
    const shadow: Effect = { type: 'dropShadow', offsetX: 20, offsetY: 0, softness: 0, color: '#000000', opacity: 0.5 }
    const tracks = [
      [WHITE_GROUND],
      tile('image-red.png', 'grey', 100, 60, [{ type: 'blackAndWhite', amount: 1 }]),
      tile('image-green-screen.png', 'brighter', 300, 60, [{ type: 'colorAdjust', brightness: 0.2, contrast: 0, saturation: 0 }]),
      tile('image-green-screen.png', 'colourless', 500, 60, [{ type: 'colorAdjust', brightness: 0, contrast: 0, saturation: -1 }]),
      tile('image-green-screen.png', 'keyed', 100, 180, [{ type: 'chromaKey', color: '#00B140', tolerance: 0.4, softness: 0.1, spill: 0.5 }]),
      tile('image-red.png', 'bordered', 300, 180, [{ type: 'border', width: 10, color: '#0000FF' }]),
      tile('image-red.png', 'rounded', 500, 180, [{ type: 'roundedCorners', radius: 30 }]),
      tile('image-red.png', 'shadowed', 100, 300, [shadow]),
      tile('image-red.png', 'blurred', 300, 300, [{ type: 'clipBlur', strength: 5 }]),
      tile('image-red.png', 'turned', 500, 300, [shadow], 180),
    ]
    const picture = await frameOf('each-effect', tracks)

    expectPixel(picture, 100, 60, { red: 54, green: 54, blue: 54 })
    expectPixel(picture, 300, 60, { red: 251, green: 91, blue: 211 })
    expectPixel(picture, 500, 60, { red: 83, green: 83, blue: 83 })

    expectPixel(picture, 100, 180, SUBJECT_MAGENTA, 2)
    expectPixel(picture, 30, 145, WHITE, 0)

    expectPixel(picture, 225, 180, BLUE, 0)
    expectPixel(picture, 300, 139, BLUE, 0)
    expectPixel(picture, 300, 180, RED, 0)

    expectPixel(picture, 422, 137, WHITE, 0)
    expectPixel(picture, 500, 180, RED, 0)
    expectPixel(picture, 500, 137, RED, 0)

    // The shadow lies 20 to the right whichever way the clip is turned: half black over white beside the right edge, nothing beside the left.
    for (const centre of [100, 500]) {
      expectPixel(picture, centre + 90, 300, GREY)
      expectPixel(picture, centre - 90, 300, WHITE, 0)
      expectPixel(picture, centre, 300, RED, 0)
    }

    expectPixel(picture, 300, 300, RED, 0)
    // Right at the edge the blur has mixed a little more red than white into the pixel.
    expectPixel(picture, 220, 300, { red: 255, green: 117, blue: 117 }, 10)
    expectPixel(picture, 405, 300, WHITE, 1)
  })

  it('tones each pixel with the colour effects as their settings say', async () => {
    const tracks = [
      [WHITE_GROUND],
      tile('image-red.png', 'sepia', 100, 60, [{ type: 'sepia', amount: 1 }]),
      tile('image-red.png', 'inverted', 300, 60, [{ type: 'invert', amount: 1 }]),
      tile('image-red.png', 'tinted', 500, 60, [{ type: 'tint', color: '#3D7BE6', amount: 1 }]),
      tile('image-red.png', 'vignetted', 300, 180, [{ type: 'vignette', amount: 1, size: 0 }]),
    ]
    const picture = await frameOf('colour-effects', tracks)
    expectPixel(picture, 100, 60, { red: 100, green: 89, blue: 69 })
    expectPixel(picture, 300, 60, { red: 0, green: 255, blue: 255 })
    // The tint colour at the brightness of red.
    expectPixel(picture, 500, 60, { red: 13, green: 26, blue: 49 })
    // Clear in the middle, black in the corners.
    expectPixel(picture, 300, 180, RED, 0)
    expectPixel(picture, 300 + 76, 180 + 42, { red: 0, green: 0, blue: 0 })
  })

  it('applies effects in their order: a border follows corners rounded before it and is cut by corners rounded after it', async () => {
    const corners: Effect = { type: 'roundedCorners', radius: 40 }
    const border: Effect = { type: 'border', width: 6, color: '#0000FF' }
    const tracks = [[WHITE_GROUND], [imageOf('image-red.png', 'followed', FIRST_SECOND, at(160, 180, 0.9), { effects: [corners, border] })], [imageOf('image-red.png', 'cut', FIRST_SECOND, at(480, 180, 0.9), { effects: [border, corners] })]]
    const picture = await frameOf('order', tracks)
    // Fourteen pixels in from the top left corner of each tile: on the rounded border of the first, inside the square border of the second.
    expectPixel(picture, 16 + 14, 99 + 14, BLUE, 0)
    expectPixel(picture, 336 + 14, 99 + 14, RED, 0)
    expectPixel(picture, 16 + 2, 99 + 2, WHITE, 0)
    expectPixel(picture, 336 + 2, 99 + 2, WHITE, 0)
  })

  it('leaves the picture untouched by an effect that is switched off', async () => {
    const plain = await frameOf('plain', [[WHITE_GROUND], tile('image-green-screen.png', 'tile', 320, 180, [])])
    const switchedOff = await frameOf('switched-off', [[WHITE_GROUND], tile('image-green-screen.png', 'tile', 320, 180, [{ type: 'clipBlur', strength: 9, isOff: true }])])
    expect(sameBytes(plain, switchedOff)).toBe(true)
  })

  it('matches the golden image of all effects', async () => {
    const pictures = await renderFrames('16-effects', { via: 'paused', frames: [0, 30] })
    await expectGolden(ffmpeg, 'effects-720p', pictureAt(pictures, 0))
    await expectGolden(ffmpeg, 'effects-colour-720p', pictureAt(pictures, 1))
  })
})
