import { describe, expect, it } from 'vitest'
import { NEW_SHAPE_STYLE, ellipseShape, rectangleShape } from '../../src/editor/drawings.js'
import type { CameraKeyframe, DrawingClip, DrawingShape, Keyframe, NodeSet, ShapeNode, ShapeStroke } from '../../src/shared/project.js'
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

type FrameOptions = {
  size?: { width: number; height: number }
  camera?: CameraKeyframe[]
  shapes?: DrawingShape[]
  nodeSets?: NodeSet[]
  frame?: number
}

// The clip doubles the artboard onto the whole 640x360 canvas, so canvas pixels are twice the shapes' coordinates.
async function frameOf(name: string, options: FrameOptions = {}): Promise<Picture> {
  const drawing: DrawingClip = drawingClip('art', 0, SECOND, options.shapes ?? SHAPES)
  if (options.nodeSets !== undefined) drawing.nodeSets = options.nodeSets
  const path = writeAnimation(scratch, name, ARTBOARD, [[drawing]])
  const episode = episodeOf([[WHITE_GROUND], [animationOf(name, name, FIRST_SECOND, at(320, 180, 2))]], { [name]: path }, options.camera)
  const frame = options.frame ?? 0
  return pictureAt(await renderProject(scratch, name, episode, { via: 'paused', frames: [frame], size: options.size }), 0)
}

// 30 fps, so frame 15 is half-way through the keys at 0 and 1 s.
const HALF_WAY = 15

function linearKeys(from: number, to: number): Keyframe[] {
  return [
    { time: 0, value: from, easing: 'linear' },
    { time: SECOND, value: to, easing: 'linear' },
  ]
}

function redBox(id: string, bounds: { left: number; top: number; right: number; bottom: number }, everyNode: Partial<ShapeNode>): DrawingShape {
  const shape = rectangleShape(id, bounds, NEW_SHAPE_STYLE)
  const nodes = shape.nodes.map((node) => ({ ...node, ...everyNode }))
  return { ...shape, nodes, fill: '#FF0000', stroke: undefined }
}

const SLIDING = [redBox('slide', { left: 20, top: 70, right: 60, bottom: 110 }, { keyframes: { x: linearKeys(0, 200) } })]

// A 100 px arm from the pivot, turning a quarter clockwise over the second.
const ARM_PIVOT = { x: 160, y: 90 }
const ARM = [redBox('arm', { left: 160, top: 85, right: 260, bottom: 95 }, { sets: ['turn'] })]
const TURN: NodeSet[] = [{ id: 'turn', name: 'Turn', pivot: ARM_PIVOT, keyframes: { rotation: linearKeys(0, 90) } }]

function onArm(distance: number, degrees: number): { x: number; y: number } {
  const angle = (degrees * Math.PI) / 180
  return { x: Math.round(2 * (ARM_PIVOT.x + distance * Math.cos(angle))), y: Math.round(2 * (ARM_PIVOT.y + distance * Math.sin(angle))) }
}

function square(id: string, left: number, top: number, stroke: ShapeStroke): DrawingShape {
  return { ...rectangleShape(id, { left, top, right: left + 40, bottom: top + 40 }, NEW_SHAPE_STYLE), fill: '#FF0000', stroke }
}

function line(id: string, points: readonly { x: number; y: number }[], stroke: ShapeStroke): DrawingShape {
  return { id, nodes: points.map((point) => ({ ...point })), stroke }
}

const THICK = { color: '#000000', width: 10 }
const STROKE_STYLES: Record<string, DrawingShape[]> = {
  dash: [line('dashed', [{ x: 20, y: 40 }, { x: 300, y: 40 }], { ...THICK, isDashed: true }), { ...square('box', 140, 90, { ...THICK, width: 6, isDashed: true, cap: 'butt' }) }],
  cap: (['butt', 'round', 'square'] as const).map((cap, index) => line(cap, [{ x: 40, y: 40 + 50 * index }, { x: 280, y: 40 + 50 * index }], { ...THICK, width: 16, cap })),
  join: (['miter', 'round', 'bevel'] as const).map((join, index) => line(join, [{ x: 30 + 100 * index, y: 140 }, { x: 70 + 100 * index, y: 40 }, { x: 110 + 100 * index, y: 140 }], { ...THICK, width: 14, cap: 'butt', join })),
  align: (['inside', 'center', 'outside'] as const).map((align, index) => square(align, 40 + 100 * index, 70, { ...THICK, align })),
  order: [square('front', 60, 70, { ...THICK, width: 12 }), square('behind', 220, 70, { ...THICK, width: 12, isBehind: true })],
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
    const zoomed = await frameOf('zoomed', { camera })
    expect(steepestEdge(cropPicture(zoomed, 40, 60, 100, 200))).toBeGreaterThan(150)
  })

  it('align strokes inside, on or outside the outline, and draw them behind or in front of the fill', async () => {
    const aligned = await frameOf('stroke-align', { shapes: STROKE_STYLES.align })
    expectPixel(aligned, 2 * 43, 2 * 90, BLACK)
    expectPixel(aligned, 2 * 37, 2 * 90, WHITE)
    expectPixel(aligned, 2 * 143, 2 * 90, BLACK)
    expectPixel(aligned, 2 * 137, 2 * 90, BLACK)
    expectPixel(aligned, 2 * 243, 2 * 90, RED)
    expectPixel(aligned, 2 * 237, 2 * 90, BLACK)
    const ordered = await frameOf('stroke-order', { shapes: STROKE_STYLES.order })
    expectPixel(ordered, 2 * 63, 2 * 90, BLACK)
    expectPixel(ordered, 2 * 223, 2 * 90, RED)
    expectPixel(ordered, 2 * 217, 2 * 90, BLACK)
  })

  it('match a golden image for each stroke setting', async () => {
    for (const [setting, shapes] of Object.entries(STROKE_STYLES)) {
      await expectGolden(ffmpeg, `stroke-${setting}`, await frameOf(`stroke-${setting}-golden`, { shapes }))
    }
  })

  it('match the golden images, small and at 4K', async () => {
    await expectGolden(ffmpeg, 'drawing-360p', await frameOf('golden'))
    const large = await frameOf('golden-4k', { size: { width: 3840, height: 2160 } })
    await expectGolden(ffmpeg, 'drawing-4K', large)
    expect(steepestEdge(cropPicture(large, 0, 0, 900, 600))).toBeGreaterThan(150)
  })

  it('move keyed nodes by their offset between keys', async () => {
    const picture = await frameOf('node-keys', { shapes: SLIDING, frame: HALF_WAY })
    expectPixel(picture, 2 * 140, 2 * 90, RED)
    expectPixel(picture, 2 * 40, 2 * 90, WHITE)
    await expectGolden(ffmpeg, 'node-keys-half-way', picture)
  })

  it('turn a node set around its pivot along the arc between rotation keys', async () => {
    const picture = await frameOf('node-set-turn', { shapes: ARM, nodeSets: TURN, frame: HALF_WAY })
    const tip = onArm(95, 45)
    const pastTip = onArm(110, 45)
    expectPixel(picture, tip.x, tip.y, RED)
    expectPixel(picture, pastTip.x, pastTip.y, WHITE)
    const start = onArm(80, 0)
    expectPixel(picture, start.x, start.y, WHITE)
    await expectGolden(ffmpeg, 'node-set-turn-half-way', picture)
  })
})
