import { describe, expect, it } from 'vitest'
import type { ArrowClip, CalloutClip, Clip, TextClip, Transform } from '../../src/shared/project.js'
import { SECOND } from '../fixtures.js'
import { bundledFfmpeg, cropPicture, expectGolden, expectPixel, imageOf, litFraction, pictureAt, pixelAt, projectOfTracks, renderFrames, renderProject, sameBytes, scratchDirectory, type Picture } from '../helpers.js'

const ffmpeg = bundledFfmpeg()
const scratch = scratchDirectory('annotations')
const CANVAS = { width: 640, height: 360 }
const SPAN = { start: 0, duration: SECOND }
const WHITE = { red: 255, green: 255, blue: 255 }
const RED = { red: 255, green: 0, blue: 0 }
const BLUE = { red: 0, green: 0, blue: 255 }
const BLACK = { red: 0, green: 0, blue: 0 }

function at(x: number, y: number, scale = 1, rotation = 0): Transform {
  return { x, y, scaleX: scale, scaleY: scale, rotation }
}

const GROUND = imageOf('image-white.png', 'ground', { start: 0, duration: 2 * SECOND }, at(320, 180, 2))

function calloutOf(id: string, transform: Transform, settings: Partial<CalloutClip> = {}): CalloutClip {
  const words = { text: '', font: { family: 'Helvetica Neue', size: 24 }, color: '#000000', align: 'center' as const }
  return { id, type: 'callout', ...SPAN, transform, opacity: 1, ...words, width: 200, height: 100, shape: 'rectangle', fill: '#FF0000', borderColor: '#0000FF', borderWidth: 10, ...settings }
}

function arrowOf(id: string, transform: Transform, settings: Partial<ArrowClip> = {}): ArrowClip {
  return { id, type: 'arrow', ...SPAN, transform, opacity: 1, length: 200, thickness: 10, color: '#FF0000', startHead: 'none', endHead: 'none', ...settings }
}

function textOf(id: string, text: string, transform: Transform, settings: Partial<TextClip> = {}): TextClip {
  return { id, type: 'text', ...SPAN, transform, opacity: 1, text, font: { family: 'Helvetica Neue', size: 40 }, color: '#FF0000', align: 'left', ...settings }
}

async function frameOf(name: string, tracks: readonly Clip[][], frame = 0): Promise<Picture> {
  return pictureAt(await renderProject(scratch, name, projectOfTracks(CANVAS, tracks), { via: 'paused', frames: [frame] }), 0)
}

async function referenceFrame(project: string, frame: number, size: { width: number; height: number }): Promise<Picture> {
  return pictureAt(await renderFrames(project, { via: 'paused', frames: [frame], size }), 0)
}

// The steepest step between two neighbouring pixels of a row: high for a sharp edge, low for an enlarged one.
function steepestEdge(picture: Picture): number {
  const pixels = new Uint8Array(picture.data)
  let steepest = 0
  for (let offset = 4; offset < pixels.length; offset += 4) {
    if ((offset / 4) % picture.width !== 0) steepest = Math.max(steepest, Math.abs((pixels[offset] ?? 0) - (pixels[offset - 4] ?? 0)))
  }
  return steepest
}

// The box around the pixels that are fully the red of the letters.
function inkBounds(picture: Picture): { left: number; top: number; right: number; bottom: number } {
  const bounds = { left: picture.width, top: picture.height, right: -1, bottom: -1 }
  for (let y = 0; y < picture.height; y++) {
    for (let x = 0; x < picture.width; x++) {
      const { red, green, blue } = pixelAt(picture, x, y)
      if (red < 250 || green > 5 || blue > 5) continue
      bounds.left = Math.min(bounds.left, x)
      bounds.top = Math.min(bounds.top, y)
      bounds.right = Math.max(bounds.right, x)
      bounds.bottom = Math.max(bounds.bottom, y)
    }
  }
  return bounds
}

describe('callouts', () => {
  it('fills its box and lays its border around it', async () => {
    const picture = await frameOf('box', [[GROUND], [calloutOf('box', at(320, 180))]])
    expectPixel(picture, 320, 180, RED)
    expectPixel(picture, 225, 135, RED)
    // The border is 10 wide and lies outside the 200 by 100 box.
    expectPixel(picture, 215, 180, BLUE)
    expectPixel(picture, 320, 125, BLUE)
    expectPixel(picture, 205, 180, WHITE)
    expectPixel(picture, 320, 115, WHITE)
  })

  it('does not show its border through a fill that lets light through', async () => {
    const picture = await frameOf('clear', [[GROUND], [calloutOf('box', at(320, 180), { fill: '#FF000080' })]])
    const { red, green, blue } = pixelAt(picture, 320, 180)
    expect(red).toBe(255)
    expect(Math.abs(green - 127)).toBeLessThanOrEqual(2)
    expect(Math.abs(blue - 127)).toBeLessThanOrEqual(2)
  })

  it('points its tail at the tip, and has none as another shape', async () => {
    const bubble = calloutOf('bubble', at(320, 140), { shape: 'speechBubble', borderWidth: 0, tail: { x: 0, y: 120 } })
    const picture = await frameOf('tail', [[GROUND], [bubble]])
    expectPixel(picture, 320, 225, RED)
    expectPixel(picture, 320, 240, RED)
    expectPixel(picture, 290, 250, WHITE)
    expectPixel(picture, 320, 265, WHITE)
    const box = await frameOf('no-tail', [[GROUND], [calloutOf('box', at(320, 140), { borderWidth: 0 })]])
    expectPixel(box, 320, 225, WHITE)
  })

  it('wraps its words inside the shape and draws them in their colour', async () => {
    const worded = calloutOf('worded', at(320, 180), { text: 'several words that have to wrap', fill: '#FFFFFF', borderWidth: 0, width: 160, height: 140 })
    const picture = await frameOf('words', [[imageOf('image-white.png', 'ground', SPAN, at(320, 180, 2))], [worded]])
    const inside = cropPicture(picture, 240, 110, 160, 140)
    // Black letters on white: something is dark inside the box, on more than one line, and nothing outside it.
    const dark = (area: Picture): number => 1 - litFraction(area)
    expect(dark(cropPicture(inside, 0, 20, 160, 40))).toBeGreaterThan(0.01)
    expect(dark(cropPicture(inside, 0, 80, 160, 40))).toBeGreaterThan(0.01)
    expect(dark(cropPicture(picture, 0, 0, 236, 360))).toBe(0)
    expect(dark(cropPicture(picture, 404, 0, 236, 360))).toBe(0)
  })

  it('matches the golden images, small and at 4K', async () => {
    await expectGolden(ffmpeg, 'callouts-360p', await referenceFrame('17-callouts-arrows', 30, { width: 640, height: 360 }))
    const large = await referenceFrame('17-callouts-arrows', 30, { width: 3840, height: 2160 })
    await expectGolden(ffmpeg, 'callouts-4K', large)
    // Drawn at the size of the output, not enlarged: the edge of a shape and of a letter is a step of one pixel.
    expect(steepestEdge(cropPicture(large, 100, 150, 900, 500))).toBeGreaterThan(150)
  })
})

describe('arrows and lines', () => {
  it('draws a line of its length and thickness through its middle', async () => {
    const picture = await frameOf('line', [[GROUND], [arrowOf('line', at(320, 180))]])
    expectPixel(picture, 225, 180, RED)
    expectPixel(picture, 415, 180, RED)
    expectPixel(picture, 320, 177, RED)
    expectPixel(picture, 320, 183, RED)
    expectPixel(picture, 215, 180, WHITE)
    expectPixel(picture, 425, 180, WHITE)
    expectPixel(picture, 320, 172, WHITE)
  })

  it('turns with its clip', async () => {
    const picture = await frameOf('turned', [[GROUND], [arrowOf('line', at(320, 180, 1, 90))]])
    expectPixel(picture, 320, 85, RED)
    expectPixel(picture, 320, 275, RED)
    expectPixel(picture, 225, 180, WHITE)
  })

  it('draws a head wider than the line at the ends that have one', async () => {
    const picture = await frameOf('heads', [[GROUND], [arrowOf('arrow', at(320, 180), { endHead: 'triangle', startHead: 'dot' })]])
    // The triangle is 40 long and 40 high and ends in a point at the end of the arrow.
    expectPixel(picture, 385, 195, RED)
    expectPixel(picture, 385, 165, RED)
    expectPixel(picture, 415, 180, RED)
    expectPixel(picture, 415, 190, WHITE)
    expectPixel(picture, 370, 195, WHITE)
    // The dot is 30 across, around the start.
    expectPixel(picture, 220, 190, RED)
    expectPixel(picture, 210, 180, RED)
    expectPixel(picture, 220, 200, WHITE)
  })
})

describe('text styles', () => {
  it('fills the box behind the words and keeps the middle of the text where it was', async () => {
    const plain = await frameOf('plain', [[GROUND], [textOf('t', 'Mg', at(320, 180))]])
    const boxed = await frameOf('boxed', [[GROUND], [textOf('t', 'Mg', at(320, 180), { background: { color: '#0000FF' }, shadow: { color: '#000000', offsetX: 30, offsetY: 0, blur: 0 } })]])
    expectPixel(boxed, 290, 160, BLUE, 2)
    // The shadow reaches out of the box on one side only; the letters stay where they are without it.
    // The picture of the text is larger with a shadow, so its edges fall on other fractions of a pixel: one pixel is the most that can show.
    const before = inkBounds(plain)
    const after = inkBounds(boxed)
    for (const side of ['left', 'top', 'right', 'bottom'] as const) expect(Math.abs(after[side] - before[side]), side).toBeLessThanOrEqual(1)
  })

  it('draws an outline around the letters and a shadow beside them', async () => {
    const outlined = await frameOf('outlined', [[GROUND], [textOf('t', 'I', at(320, 180), { font: { family: 'Helvetica Neue', size: 200, weight: 700 }, outline: { color: '#0000FF', width: 8 } })]])
    const row = cropPicture(outlined, 250, 180, 140, 1)
    const colours = new Uint8Array(row.data)
    const kinds: string[] = []
    for (let offset = 0; offset < colours.length; offset += 4) {
      const red = colours[offset] ?? 0
      const blue = colours[offset + 2] ?? 0
      const green = colours[offset + 1] ?? 0
      let kind = 'white'
      if (red > 200 && green < 60) kind = 'red'
      if (blue > 200 && green < 60) kind = 'blue'
      if (kinds.at(-1) !== kind) kinds.push(kind)
    }
    expect(kinds.filter((kind) => kind !== 'white')).toEqual(['blue', 'red', 'blue'])

    const shadowed = await frameOf('shadowed', [[GROUND], [textOf('t', 'I', at(320, 180), { font: { family: 'Helvetica Neue', size: 200, weight: 700 }, shadow: { color: '#000000', offsetX: 60, offsetY: 0, blur: 0 } })]])
    expectPixel(shadowed, 320, 180, RED, 3)
    expectPixel(shadowed, 380, 180, BLACK, 3)
  })

  it('wraps words at the width of a fixed box and spaces the lines', async () => {
    const dark = (picture: Picture): number => 1 - litFraction(picture)
    const wrapped = textOf('t', 'one two three four five six', at(320, 180), { boxWidth: 200, color: '#000000' })
    const picture = await frameOf('wrapped', [[GROUND], [wrapped]])
    expect(dark(cropPicture(picture, 0, 0, 218, 360))).toBe(0)
    expect(dark(cropPicture(picture, 422, 0, 218, 360))).toBe(0)
    expect(dark(cropPicture(picture, 220, 60, 200, 240))).toBeGreaterThan(0.02)

    const lines = textOf('t', 'A\nA', at(320, 180), { color: '#000000', font: { family: 'Helvetica Neue', size: 60 } })
    const single = await frameOf('single', [[GROUND], [lines]])
    const spaced = await frameOf('spaced', [[GROUND], [{ ...lines, lineSpacing: 2 }]])
    const darkRows = (shown: Picture): number => {
      let rows = 0
      for (let y = 0; y < shown.height; y++) {
        if (dark(cropPicture(shown, 0, y, shown.width, 1)) > 0) rows += 1
      }
      return rows
    }
    // The same two letters, further apart: as many rows with ink, in a taller picture.
    expect(darkRows(spaced)).toBe(darkRows(single))
    const lowestInk = (shown: Picture): number => {
      for (let y = shown.height - 1; y >= 0; y--) {
        if (dark(cropPicture(shown, 0, y, shown.width, 1)) > 0) return y
      }
      return -1
    }
    expect(lowestInk(spaced) - lowestInk(single)).toBeGreaterThan(25)
  })

  it('matches the golden image', async () => {
    await expectGolden(ffmpeg, 'text-styles-720p', await referenceFrame('18-text-styles', 0, { width: 1280, height: 720 }))
  })
})

describe('animations', () => {
  it('shows a typewriter text letter by letter, each where it will stay', async () => {
    const typed = textOf('t', 'MMMMMMMM', at(320, 180), { color: '#000000', animationIn: { type: 'typewriter', duration: SECOND } })
    const dark = (picture: Picture): number => 1 - litFraction(picture)
    const start = await frameOf('typed-0', [[GROUND], [typed]], 0)
    const half = await frameOf('typed-15', [[GROUND], [typed]], 15)
    const whole = await frameOf('typed-29', [[GROUND], [{ ...typed, duration: 2 * SECOND }]], 45)
    expect(dark(start)).toBe(0)
    expect(dark(cropPicture(half, 0, 0, 320, 360))).toBeGreaterThan(0.005)
    expect(dark(cropPicture(half, 330, 0, 310, 360))).toBe(0)
    expect(dark(cropPicture(whole, 330, 0, 310, 360))).toBeGreaterThan(0.005)
    // The letters that are there are the ones of the finished text, in the same place.
    expect(sameBytes(cropPicture(half, 0, 0, 300, 360), cropPicture(whole, 0, 0, 300, 360))).toBe(true)
  })

  it('slides a clip in from outside the canvas', async () => {
    const sliding = calloutOf('box', at(320, 180), { borderWidth: 0, animationIn: { type: 'slideLeft', duration: SECOND } })
    const start = await frameOf('slide-0', [[GROUND], [sliding]], 0)
    const end = await frameOf('slide-29', [[GROUND], [{ ...sliding, duration: 2 * SECOND }]], 30)
    expectPixel(start, 320, 180, WHITE)
    expectPixel(end, 320, 180, RED)
  })

  it('matches the golden image in the middle of the moves', async () => {
    await expectGolden(ffmpeg, 'presets-720p', await referenceFrame('19-presets', 14, { width: 1280, height: 720 }))
  })
})
