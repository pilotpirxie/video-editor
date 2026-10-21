import { describe, expect, it } from 'vitest'
import type { ArrowClip, CalloutClip, Clip, TextClip, Transform } from '../../src/shared/project.js'
import { SECOND } from '../fixtures.js'
import { at, BLUE, FIRST_SECOND, frameOfTracks, RED, WHITE, WHITE_GROUND, bundledFfmpeg, cropPicture, expectGolden, expectPixel, imageOf, litFraction, pictureAt, pixelAt, projectOfTracks, renderFrames, renderProject, sameBytes, scratchDirectory, type Picture } from '../helpers.js'

const ffmpeg = bundledFfmpeg()
const scratch = scratchDirectory('annotations')
const BLACK = { red: 0, green: 0, blue: 0 }

function calloutOf(id: string, transform: Transform, settings: Partial<CalloutClip> = {}): CalloutClip {
  const words = { text: '', font: { family: 'Helvetica Neue', size: 24 }, color: '#000000', align: 'center' as const }
  return { id, type: 'callout', ...FIRST_SECOND, transform, opacity: 1, ...words, width: 200, height: 100, shape: 'rectangle', fill: '#FF0000', borderColor: '#0000FF', borderWidth: 10, ...settings }
}

function arrowOf(id: string, transform: Transform, settings: Partial<ArrowClip> = {}): ArrowClip {
  return { id, type: 'arrow', ...FIRST_SECOND, transform, opacity: 1, length: 200, thickness: 10, color: '#FF0000', startHead: 'none', endHead: 'none', ...settings }
}

function textOf(id: string, text: string, transform: Transform, settings: Partial<TextClip> = {}): TextClip {
  return { id, type: 'text', ...FIRST_SECOND, transform, opacity: 1, text, font: { family: 'Helvetica Neue', size: 40 }, color: '#FF0000', align: 'left', ...settings }
}

function frameOf(name: string, tracks: readonly Clip[][], frame = 0): Promise<Picture> {
  return frameOfTracks(scratch, name, tracks, frame)
}

async function referenceFrame(project: string, frame: number, size: { width: number; height: number }): Promise<Picture> {
  return pictureAt(await renderFrames(project, { via: 'paused', frames: [frame], size }), 0)
}

function steepestEdge(picture: Picture): number {
  const pixels = new Uint8Array(picture.data)
  let steepest = 0
  for (let offset = 4; offset < pixels.length; offset += 4) {
    if ((offset / 4) % picture.width !== 0) steepest = Math.max(steepest, Math.abs((pixels[offset] ?? 0) - (pixels[offset - 4] ?? 0)))
  }
  return steepest
}

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
    const picture = await frameOf('box', [[WHITE_GROUND], [calloutOf('box', at(320, 180))]])
    expectPixel(picture, 320, 180, RED)
    expectPixel(picture, 225, 135, RED)
    expectPixel(picture, 215, 180, BLUE)
    expectPixel(picture, 320, 125, BLUE)
    expectPixel(picture, 205, 180, WHITE)
    expectPixel(picture, 320, 115, WHITE)
  })

  it('does not show its border through a fill that lets light through', async () => {
    const picture = await frameOf('clear', [[WHITE_GROUND], [calloutOf('box', at(320, 180), { fill: '#FF000080' })]])
    const { red, green, blue } = pixelAt(picture, 320, 180)
    expect(red).toBe(255)
    expect(Math.abs(green - 127)).toBeLessThanOrEqual(2)
    expect(Math.abs(blue - 127)).toBeLessThanOrEqual(2)
  })

  it('points its tail at the tip, and has none as another shape', async () => {
    const bubble = calloutOf('bubble', at(320, 140), { shape: 'speechBubble', borderWidth: 0, tail: { x: 0, y: 120 } })
    const picture = await frameOf('tail', [[WHITE_GROUND], [bubble]])
    expectPixel(picture, 320, 225, RED)
    expectPixel(picture, 320, 240, RED)
    expectPixel(picture, 290, 250, WHITE)
    expectPixel(picture, 320, 265, WHITE)
    const box = await frameOf('no-tail', [[WHITE_GROUND], [calloutOf('box', at(320, 140), { borderWidth: 0 })]])
    expectPixel(box, 320, 225, WHITE)
  })

  it('wraps its words inside the shape and draws them in their colour', async () => {
    const worded = calloutOf('worded', at(320, 180), { text: 'several words that have to wrap', fill: '#FFFFFF', borderWidth: 0, width: 160, height: 140 })
    const picture = await frameOf('words', [[imageOf('image-white.png', 'ground', FIRST_SECOND, at(320, 180, 2))], [worded]])
    const inside = cropPicture(picture, 240, 110, 160, 140)
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
    expect(steepestEdge(cropPicture(large, 100, 150, 900, 500))).toBeGreaterThan(150)
  })

  it('draws a stretched callout the same on every run', async () => {
    const words = { text: 'Callout', font: { family: 'Helvetica Neue', size: 108 }, color: '#14171D', fill: '#FFFFFF', borderColor: '#14171D', borderWidth: 8 }
    const stretched = calloutOf('stretched', { ...at(640, 300), scaleX: 2.36 }, { ...words, shape: 'speechBubble', width: 470, height: 432, tail: { x: -141, y: 389 } })
    const project = projectOfTracks({ width: 1280, height: 720 }, [[stretched]])
    const first = await renderProject(scratch, 'stretched-first', project, { via: 'paused', frames: [0] })
    const second = await renderProject(scratch, 'stretched-second', project, { via: 'paused', frames: [0] })
    expect(sameBytes(pictureAt(first, 0), pictureAt(second, 0))).toBe(true)
  })
})

describe('arrows and lines', () => {
  it('draws a line of its length and thickness through its middle', async () => {
    const picture = await frameOf('line', [[WHITE_GROUND], [arrowOf('line', at(320, 180))]])
    expectPixel(picture, 225, 180, RED)
    expectPixel(picture, 415, 180, RED)
    expectPixel(picture, 320, 177, RED)
    expectPixel(picture, 320, 183, RED)
    expectPixel(picture, 215, 180, WHITE)
    expectPixel(picture, 425, 180, WHITE)
    expectPixel(picture, 320, 172, WHITE)
  })

  it('turns with its clip', async () => {
    const picture = await frameOf('turned', [[WHITE_GROUND], [arrowOf('line', at(320, 180, 1, 90))]])
    expectPixel(picture, 320, 85, RED)
    expectPixel(picture, 320, 275, RED)
    expectPixel(picture, 225, 180, WHITE)
  })

  it('draws a head wider than the line at the ends that have one', async () => {
    const picture = await frameOf('heads', [[WHITE_GROUND], [arrowOf('arrow', at(320, 180), { endHead: 'triangle', startHead: 'dot' })]])
    expectPixel(picture, 385, 195, RED)
    expectPixel(picture, 385, 165, RED)
    expectPixel(picture, 415, 180, RED)
    expectPixel(picture, 415, 190, WHITE)
    expectPixel(picture, 370, 195, WHITE)
    expectPixel(picture, 220, 190, RED)
    expectPixel(picture, 210, 180, RED)
    expectPixel(picture, 220, 200, WHITE)
  })
})

describe('text styles', () => {
  it('fills the box behind the words and keeps the middle of the text where it was', async () => {
    const plain = await frameOf('plain', [[WHITE_GROUND], [textOf('t', 'Mg', at(320, 180))]])
    const boxed = await frameOf('boxed', [[WHITE_GROUND], [textOf('t', 'Mg', at(320, 180), { background: { color: '#0000FF' }, shadow: { color: '#000000', offsetX: 30, offsetY: 0, blur: 0 } })]])
    expectPixel(boxed, 290, 160, BLUE, 2)
    const before = inkBounds(plain)
    const after = inkBounds(boxed)
    for (const side of ['left', 'top', 'right', 'bottom'] as const) expect(Math.abs(after[side] - before[side]), side).toBeLessThanOrEqual(1)
  })

  it('draws an outline around the letters and a shadow beside them', async () => {
    const outlined = await frameOf('outlined', [[WHITE_GROUND], [textOf('t', 'I', at(320, 180), { font: { family: 'Helvetica Neue', size: 200, weight: 700 }, outline: { color: '#0000FF', width: 8 } })]])
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

    const shadowed = await frameOf('shadowed', [[WHITE_GROUND], [textOf('t', 'I', at(320, 180), { font: { family: 'Helvetica Neue', size: 200, weight: 700 }, shadow: { color: '#000000', offsetX: 60, offsetY: 0, blur: 0 } })]])
    expectPixel(shadowed, 320, 180, RED, 3)
    expectPixel(shadowed, 380, 180, BLACK, 3)
  })

  it('wraps words at the width of a fixed box and spaces the lines', async () => {
    const dark = (picture: Picture): number => 1 - litFraction(picture)
    const wrapped = textOf('t', 'one two three four five six', at(320, 180), { boxWidth: 200, color: '#000000' })
    const picture = await frameOf('wrapped', [[WHITE_GROUND], [wrapped]])
    expect(dark(cropPicture(picture, 0, 0, 218, 360))).toBe(0)
    expect(dark(cropPicture(picture, 422, 0, 218, 360))).toBe(0)
    expect(dark(cropPicture(picture, 220, 60, 200, 240))).toBeGreaterThan(0.02)

    const lines = textOf('t', 'A\nA', at(320, 180), { color: '#000000', font: { family: 'Helvetica Neue', size: 60 } })
    const single = await frameOf('single', [[WHITE_GROUND], [lines]])
    const spaced = await frameOf('spaced', [[WHITE_GROUND], [{ ...lines, lineSpacing: 2 }]])
    const darkRows = (shown: Picture): number => {
      let rows = 0
      for (let y = 0; y < shown.height; y++) {
        if (dark(cropPicture(shown, 0, y, shown.width, 1)) > 0) rows += 1
      }
      return rows
    }
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
    const start = await frameOf('typed-0', [[WHITE_GROUND], [typed]], 0)
    const half = await frameOf('typed-15', [[WHITE_GROUND], [typed]], 15)
    const whole = await frameOf('typed-29', [[WHITE_GROUND], [{ ...typed, duration: 2 * SECOND }]], 45)
    expect(dark(start)).toBe(0)
    expect(dark(cropPicture(half, 0, 0, 320, 360))).toBeGreaterThan(0.005)
    expect(dark(cropPicture(half, 330, 0, 310, 360))).toBe(0)
    expect(dark(cropPicture(whole, 330, 0, 310, 360))).toBeGreaterThan(0.005)
    expect(sameBytes(cropPicture(half, 0, 0, 300, 360), cropPicture(whole, 0, 0, 300, 360))).toBe(true)
  })

  it('slides a clip in from outside the canvas', async () => {
    const sliding = calloutOf('box', at(320, 180), { borderWidth: 0, animationIn: { type: 'slideLeft', duration: SECOND } })
    const start = await frameOf('slide-0', [[WHITE_GROUND], [sliding]], 0)
    const end = await frameOf('slide-29', [[WHITE_GROUND], [{ ...sliding, duration: 2 * SECOND }]], 30)
    expectPixel(start, 320, 180, WHITE)
    expectPixel(end, 320, 180, RED)
  })

  it('matches the golden image in the middle of the moves', async () => {
    await expectGolden(ffmpeg, 'presets-720p', await referenceFrame('19-presets', 14, { width: 1280, height: 720 }))
  })
})
