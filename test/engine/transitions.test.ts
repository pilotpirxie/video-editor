import { describe, expect, it } from 'vitest'
import { TRANSITION_TYPES, type Clip, type Transform, type TransitionType } from '../../src/shared/project.js'
import { FRAME, SECOND } from '../fixtures.js'
import { bundledFfmpeg, expectGolden, expectPixel, imageOf, pictureAt, projectOfTracks, readBarcode, renderFrames, renderProject, sameBytes, scratchDirectory, videoOf, type Picture } from '../helpers.js'

const ffmpeg = bundledFfmpeg()
const scratch = scratchDirectory('transitions')
const CANVAS = { width: 640, height: 360 }
const EARLIER = { start: 0, duration: SECOND }
const LATER = { start: SECOND, duration: SECOND }
const LENGTH = 20 * FRAME
const CUT_FRAME = 30
const RED = { red: 255, green: 0, blue: 0 }
const BLUE = { red: 0, green: 0, blue: 255 }

function at(x: number, y: number, scale: number): Transform {
  return { x, y, scaleX: scale, scaleY: scale, rotation: 0 }
}

const FILL = at(320, 180, 2)
const LOW = at(320, 270, 0.5)

function redToBlue(type: TransitionType): Clip[] {
  return [imageOf('image-red.png', 'red', EARLIER, FILL), imageOf('image-blue.png', 'blue', LATER, FILL, { transitionIn: { type, duration: LENGTH } })]
}

async function framesOf(name: string, tracks: readonly Clip[][], frames: readonly number[], via: 'paused' | 'export' = 'paused'): Promise<Picture[]> {
  return renderProject(scratch, name, projectOfTracks(CANVAS, tracks), { via, frames })
}

describe('transition arithmetic', () => {
  it.each([
    { ground: 'black', tracks: [redToBlue('crossDissolve')] },
    { ground: 'white', tracks: [[imageOf('image-white.png', 'ground', { start: 0, duration: 2 * SECOND }, FILL)], redToBlue('crossDissolve')] },
  ])('dissolves two colours through their mean, and lets nothing of a $ground ground show through', async ({ ground, tracks }) => {
    const pictures = await framesOf(`dissolve-on-${ground}`, tracks, [CUT_FRAME - 5, CUT_FRAME])
    expectPixel(pictureAt(pictures, 0), 320, 180, { red: 191, green: 0, blue: 64 })
    expectPixel(pictureAt(pictures, 1), 320, 180, { red: 128, green: 0, blue: 128 })
  })

  it('splits a wipe at the middle of the canvas, with no seam between the two pictures', async () => {
    const picture = pictureAt(await framesOf('wipe', [redToBlue('wipeLeft')], [CUT_FRAME]), 0)
    expectPixel(picture, 0, 180, RED, 0)
    expectPixel(picture, 319, 180, RED, 0)
    expectPixel(picture, 320, 180, BLUE, 0)
    expectPixel(picture, 639, 20, BLUE, 0)
  })

  it.each([
    { footage: 'that ends with the clip', sourceStart: SECOND, shown: 59 },
    { footage: 'that goes on after the clip', sourceStart: 0, shown: 35 },
  ])('shows footage $footage past the cut: frame $shown of the file', async ({ sourceStart, shown }) => {
    const tracks = [[videoOf('h264.mp4', 'old', EARLIER, FILL, { sourceStart }), imageOf('image-red.png', 'new', LATER, LOW, { transitionIn: { type: 'slide', duration: LENGTH } })]]
    const paused = await framesOf(`leaving-${shown}`, tracks, [CUT_FRAME + 5])
    const exported = await framesOf(`leaving-${shown}`, tracks, [CUT_FRAME + 5], 'export')
    expect(readBarcode(pictureAt(paused, 0))).toBe(shown)
    expect(sameBytes(pictureAt(paused, 0), pictureAt(exported, 0))).toBe(true)
  })

  it.each([
    { footage: 'that starts with the clip', sourceStart: 0, shown: 0 },
    { footage: 'from before the clip', sourceStart: SECOND, shown: 28 },
  ])('shows footage $footage ahead of the cut: frame $shown of the file', async ({ sourceStart, shown }) => {
    const tracks = [[imageOf('image-red.png', 'old', EARLIER, LOW), videoOf('h264.mp4', 'new', LATER, FILL, { sourceStart, transitionIn: { type: 'wipeDown', duration: LENGTH } })]]
    const paused = await framesOf(`arriving-${shown}`, tracks, [CUT_FRAME - 2])
    const exported = await framesOf(`arriving-${shown}`, tracks, [CUT_FRAME - 2], 'export')
    expect(readBarcode(pictureAt(paused, 0))).toBe(shown)
    expect(sameBytes(pictureAt(paused, 0), pictureAt(exported, 0))).toBe(true)
  })
})

describe('transition golden images', () => {
  const FIRST_CUTS: TransitionType[] = ['crossDissolve', 'fadeBlack', 'fadeWhite', 'wipeLeft', 'wipeRight', 'wipeUp', 'wipeDown', 'slide', 'push', 'zoom', 'circleReveal']
  const LATER_CUTS: TransitionType[] = ['wipeUpLeft', 'wipeUpRight', 'wipeDownLeft', 'wipeDownRight', 'slideRight', 'slideUp', 'slideDown', 'pushRight', 'pushUp', 'pushDown', 'shrink', 'spin', 'circleClose']
  const FIRST_LATER_CUT = 450
  const cuts = [
    ...FIRST_CUTS.map((type, index) => ({ type, frame: (index + 1) * CUT_FRAME })),
    ...LATER_CUTS.map((type, index) => ({ type, frame: FIRST_LATER_CUT + index * CUT_FRAME })),
  ]
  const ALONE_FRAMES = [370, 410]

  it('has a cut for every transition', () => {
    expect(cuts.map((cut) => cut.type).sort()).toEqual([...TRANSITION_TYPES].sort())
  })

  it('matches the golden image of every transition at its middle', async () => {
    const pictures = await renderFrames('14-transitions', { via: 'paused', frames: [...cuts.map((cut) => cut.frame), ...ALONE_FRAMES] })
    for (const [index, cut] of cuts.entries()) await expectGolden(ffmpeg, `transition-${cut.type}`, pictureAt(pictures, index))
    await expectGolden(ffmpeg, 'transition-zoom-in-alone', pictureAt(pictures, cuts.length))
    await expectGolden(ffmpeg, 'transition-slide-out-alone', pictureAt(pictures, cuts.length + 1))
  })

  it('draws a frame the same whether it comes first or after other frames', async () => {
    const zoomFrame = (FIRST_CUTS.indexOf('zoom') + 1) * CUT_FRAME
    const alone = await renderFrames('14-transitions', { via: 'paused', frames: [zoomFrame] })
    const afterOthers = await renderFrames('14-transitions', { via: 'paused', frames: [11, CUT_FRAME, zoomFrame] })
    expect(sameBytes(pictureAt(alone, 0), pictureAt(afterOthers, 2))).toBe(true)
  })
})
