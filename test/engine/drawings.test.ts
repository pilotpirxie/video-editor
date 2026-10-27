import { describe, expect, it } from 'vitest'
import { NEW_SHAPE_STYLE, ellipseShape, rectangleShape } from '../../src/editor/drawings.js'
import type { CameraKeyframe, DrawingShape } from '../../src/shared/project.js'
import { FRAME, SECOND, drawingClip } from '../fixtures.js'
import { at, FIRST_SECOND, RED, WHITE, WHITE_GROUND, animationOf, bundledFfmpeg, cropPicture, episodeOf, expectGolden, expectPixel, pictureAt, renderProject, scratchDirectory, steepestEdge, writeAnimation, type Picture } from '../helpers.js'

const ffmpeg = bundledFfmpeg()
const scratch = scratchDirectory('drawings')
const ARTBOARD = { width: 320, height: 180 }
const BLACK = { red: 0, green: 0, blue: 0 }
const BLUE = { red: 0, green: 0, blue: 255 }
const ORANGE = { red: 255, green: 136, blue: 0 }
const HALF_YELLOW_ON_WHITE = { red: 255, green: 255, blue: 127 }

const SHAPES: DrawingShape[] = [
  { ...rectangleShape('box', { left: 20, top: 20, right: 120, bottom: 80 }, NEW_SHAPE_STYLE), fill: '#FF0000', stroke: { color: '#000000', width: 6 } },
  { ...ellipseShape('sun', { left: 180, top: 20, right: 260, bottom: 100 }, NEW_SHAPE_STYLE), fill: '#0000FF', stroke: undefined },
  { ...rectangleShape('glass', { left: 240, top: 10, right: 300, bottom: 70 }, NEW_SHAPE_STYLE), fill: '#FFFF0080', stroke: undefined },
  { id: 'wave', nodes: [{ x: 20, y: 150, out: { x: 40, y: -40 } }, { x: 150, y: 150, in: { x: -40, y: -40 } }], stroke: { color: '#00FF00', width: 4 } },
  {
    ...rectangleShape('body', { left: 160, top: 110, right: 300, bottom: 170 }, NEW_SHAPE_STYLE),
    children: [{ ...rectangleShape('belt', { left: 140, top: 125, right: 230, bottom: 145 }, NEW_SHAPE_STYLE), fill: '#FF8800', stroke: undefined }],
  },
]

// The clip doubles the artboard onto the whole 640x360 canvas, so canvas pixels are twice the shapes' coordinates.
async function frameOf(name: string, size?: { width: number; height: number }, camera?: CameraKeyframe[]): Promise<Picture> {
  const path = writeAnimation(scratch, name, ARTBOARD, [[drawingClip('art', 0, SECOND, SHAPES)]])
  const episode = episodeOf([[WHITE_GROUND], [animationOf(name, name, FIRST_SECOND, at(320, 180, 2))]], { [name]: path }, camera)
  return pictureAt(await renderProject(scratch, name, episode, { via: 'paused', frames: [0], size }), 0)
}

describe('drawings', () => {
  it('fill their shapes and draw strokes on the outline, half inside and half outside', async () => {
    const picture = await frameOf('look')
    expectPixel(picture, 140, 100, RED)
    expectPixel(picture, 40, 100, BLACK)
    expectPixel(picture, 20, 100, WHITE)
    expectPixel(picture, 400, 120, BLUE)
    expectPixel(picture, 560, 30, HALF_YELLOW_ON_WHITE, 2)
  })

  it('show clipped shapes only inside their parent, under its stroke', async () => {
    const picture = await frameOf('clipped')
    expectPixel(picture, 400, 270, ORANGE)
    expectPixel(picture, 300, 270, WHITE)
    expectPixel(picture, 320, 270, BLACK)
  })

  it('stay sharp under a camera zoom', async () => {
    const camera: CameraKeyframe[] = [{ time: 0, duration: FRAME, easing: 'hold', x: 100, y: 80, scale: 4 }]
    const zoomed = await frameOf('zoomed', undefined, camera)
    expect(steepestEdge(cropPicture(zoomed, 40, 60, 100, 200))).toBeGreaterThan(150)
  })

  it('match the golden images, small and at 4K', async () => {
    await expectGolden(ffmpeg, 'drawing-360p', await frameOf('golden'))
    const large = await frameOf('golden-4k', { width: 3840, height: 2160 })
    await expectGolden(ffmpeg, 'drawing-4K', large)
    expect(steepestEdge(cropPicture(large, 0, 0, 900, 600))).toBeGreaterThan(150)
  })
})
