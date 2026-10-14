import { describe, expect, it } from 'vitest'
import { align, arrange, distribute, type ArrangedItem } from './arrange.js'

const CANVAS = { width: 1920, height: 1080 }

// A clip whose box is `width` by `height` around (x, y), at scale 1 unless told otherwise.
function item(id: string, x: number, y: number, width: number, height: number, settings: Partial<ArrangedItem> = {}): ArrangedItem {
  return { id, box: { centerX: x, centerY: y, width, height, rotation: 0 }, place: { x, y }, scaleX: 1, scaleY: 1, ...settings }
}

describe('align', () => {
  it('lines one clip up with the canvas', () => {
    const placed = align([item('a', 500, 500, 200, 100)], 'right', CANVAS)
    expect(placed.get('a')).toEqual({ x: 1820, y: 500 })
    expect(align([item('a', 500, 500, 200, 100)], 'middle', CANVAS).get('a')).toEqual({ x: 500, y: 540 })
  })

  it('lines several clips up with the box around them all, turned boxes by their outline', () => {
    const turned = { ...item('b', 900, 300, 200, 100), box: { centerX: 900, centerY: 300, width: 200, height: 100, rotation: 90 } }
    const placed = align([item('a', 300, 500, 200, 100), turned], 'left', CANVAS)
    expect(placed.get('a')).toEqual({ x: 300, y: 500 })
    // Turned a quarter, the second box is 100 wide, so its middle goes 50 to the right of the left edge at 200.
    expect(placed.get('b')?.x).toBeCloseTo(250)
  })
})

describe('distribute', () => {
  it('keeps the outer clips and makes the gaps between all of them equal', () => {
    const placed = distribute([item('c', 1500, 0, 200, 50), item('a', 100, 0, 200, 50), item('b', 400, 0, 100, 50)], 'across')
    expect(placed.get('a')).toEqual({ x: 100, y: 0 })
    expect(placed.get('c')).toEqual({ x: 1500, y: 0 })
    // From 0 to 1600 there are 500 pixels of clips, so each of the two gaps is 550.
    expect(placed.get('b')).toEqual({ x: 800, y: 0 })
  })

  it('needs three clips', () => {
    expect(distribute([item('a', 0, 0, 10, 10), item('b', 50, 0, 10, 10)], 'down').size).toBe(0)
  })
})

describe('arrange', () => {
  const clips = [item('a', 960, 540, 1920, 1080), item('b', 960, 540, 1920, 1080), item('c', 960, 540, 1920, 1080), item('d', 960, 540, 1920, 1080), item('e', 0, 0, 10, 10)]

  it('gives every clip of a 3x3 grid exactly the same size, whatever row it is in', () => {
    const mosaic = [item('a', 160, 90, 320, 180), item('b', 480, 90, 320, 180), item('c', 160, 270, 320, 180), item('d', 480, 270, 320, 180)]
    const placed = arrange(mosaic, 'grid3', { width: 640, height: 360 }, { gap: 20, isFill: false })
    const scales = new Set([...placed.values()].map((arranged) => arranged.scaleX))
    expect(scales.size).toBe(1)
  })

  it('fits clips into a 2x2 grid with the gap between the cells and around them, leaving the rest', () => {
    const placed = arrange(clips, 'grid2', CANVAS, { gap: 20, isFill: false })
    // Each cell is (1920 - 60) / 2 = 930 wide and (1080 - 60) / 2 = 510 high; the 16:9 clip is as wide as 510 lets it be.
    const scale = 510 / 1080
    expect(placed.get('a')).toEqual({ x: 20 + 465, y: 20 + 255, scaleX: scale, scaleY: scale })
    expect(placed.get('d')).toEqual({ x: 970 + 465, y: 550 + 255, scaleX: scale, scaleY: scale })
    expect(placed.has('e')).toBe(false)
  })

  it('crops a picture that fills its cell and fits any other clip', () => {
    const picture = item('a', 960, 540, 1920, 1080, { natural: { width: 1920, height: 1080 } })
    const title = item('t', 960, 540, 400, 100)
    const placed = arrange([picture, title], 'onePlusThree', CANVAS, { gap: 0, isFill: true })
    // The large cell is 1280 by 1080, so the picture keeps its height and loses 320 source pixels on each side.
    expect(placed.get('a')).toEqual({ x: 640, y: 540, scaleX: 1, scaleY: 1, crop: { left: 320, top: 0, right: 320, bottom: 0 } })
    // The first small cell is 640 by 360: the title covers it at 3.6 times its size.
    expect(placed.get('t')).toEqual({ x: 1600, y: 180, scaleX: 3.6, scaleY: 3.6 })
  })

  it('keeps a group around the middle of its box, which lies away from its place', () => {
    const group = { ...item('g', 100, 100, 200, 100), place: { x: 0, y: 0 } }
    const placed = arrange([group], 'grid2', CANVAS, { gap: 0, isFill: false })
    // Scaled 4.8 times into the 960 by 540 cell, its place stays 100 up and left of the box's middle, now 480.
    expect(placed.get('g')).toEqual({ x: 480 - 480, y: 270 - 480, scaleX: 4.8, scaleY: 4.8 })
  })

  it('puts the first clip on the whole canvas and the others into the corner, one under the other', () => {
    const placed = arrange(clips.slice(0, 3), 'pipBottomRight', CANVAS, { gap: 10, isFill: false })
    expect(placed.get('a')).toEqual({ x: 960, y: 540, scaleX: 1, scaleY: 1 })
    expect(placed.get('b')).toEqual({ x: 1920 - 10 - 320, y: 1080 - 10 - 180, scaleX: 1 / 3, scaleY: 1 / 3 })
    expect(placed.get('c')).toEqual({ x: 1920 - 10 - 320, y: 1080 - 10 - 360 - 10 - 180, scaleX: 1 / 3, scaleY: 1 / 3 })
  })
})
