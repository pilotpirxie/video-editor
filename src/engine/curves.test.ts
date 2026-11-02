import { describe, expect, it } from 'vitest'
import type { DrawingClip, DrawingShape, Keyframe, NodeSet } from '../shared/project.js'
import { nearestOnOutline, posedShapes, shapesBounds, splitSegment, svgPathOf } from './curves.js'

const ARCH: DrawingShape = { id: 'arch', nodes: [{ x: 0, y: 0, out: { x: 0, y: -40 } }, { x: 100, y: 0, in: { x: 0, y: -40 } }] }
const WEDGE: DrawingShape = { id: 'wedge', nodes: [{ x: 10, y: 10 }, { x: 50, y: 10 }, { x: 30, y: 60 }], isClosed: true, stroke: { color: '#000000', width: 6 } }

describe('shapesBounds', () => {
  it('fits a curve where it turns, not its handles', () => {
    expect(shapesBounds([ARCH], true)).toEqual({ left: 0, top: -30, right: 100, bottom: 0 })
  })

  it('adds half the stroke only when asked', () => {
    expect(shapesBounds([WEDGE], false)).toEqual({ left: 10, top: 10, right: 50, bottom: 60 })
    expect(shapesBounds([WEDGE], true)).toEqual({ left: 7, top: 7, right: 53, bottom: 63 })
  })

  it('reaches as far as the stroke can: none inside, all of it outside, further at mitres and square caps', () => {
    const stroke = { color: '#000000', width: 6 }
    expect(shapesBounds([{ ...WEDGE, stroke: { ...stroke, align: 'inside' } }], true)).toEqual({ left: 10, top: 10, right: 50, bottom: 60 })
    expect(shapesBounds([{ ...WEDGE, stroke: { ...stroke, align: 'outside' } }], true)).toEqual({ left: 4, top: 4, right: 56, bottom: 66 })
    expect(shapesBounds([{ ...WEDGE, isClosed: undefined, stroke: { ...stroke, align: 'outside' } }], true)).toEqual({ left: 7, top: 7, right: 53, bottom: 63 })
    expect(shapesBounds([{ ...WEDGE, stroke: { ...stroke, join: 'miter' } }], true)).toEqual({ left: -2, top: -2, right: 62, bottom: 72 })
    expect(shapesBounds([{ ...ARCH, stroke: { ...stroke, cap: 'square' } }], true)?.left).toBeCloseTo(-3 * Math.SQRT2, 10)
  })

  it('takes every shape and leaves out the ones clipped inside', () => {
    const inside: DrawingShape = { ...WEDGE, stroke: undefined, children: [{ id: 'far', nodes: [{ x: -500, y: -500 }, { x: 500, y: 500 }] }] }
    expect(shapesBounds([ARCH, inside], true)).toEqual({ left: 0, top: -30, right: 100, bottom: 60 })
  })

  it('has nothing to fit without shapes', () => {
    expect(shapesBounds([], true)).toBeUndefined()
  })
})

describe('svgPathOf', () => {
  it('writes lines, curves and the closing as SVG path data', () => {
    expect(svgPathOf(ARCH)).toBe('M0 0 C0 -40 100 -40 100 0')
    expect(svgPathOf(WEDGE)).toBe('M10 10 L50 10 L30 60 L10 10 Z')
  })
})

describe('nearestOnOutline', () => {
  it('finds the closest place on lines, on curves and on the closing line', () => {
    expect(nearestOnOutline(WEDGE, { x: 30, y: 4 })).toMatchObject({ segmentIndex: 0, progress: 0.5, distance: 6 })
    const onClosing = nearestOnOutline(WEDGE, { x: 10, y: 30 })
    expect(onClosing?.segmentIndex).toBe(2)
    const onArch = nearestOnOutline(ARCH, { x: 50, y: -40 })
    expect(onArch?.segmentIndex).toBe(0)
    expect(onArch?.progress).toBeCloseTo(0.5, 6)
    expect(onArch?.distance).toBeCloseTo(10, 6)
  })

  it('has no place on a shape without segments', () => {
    expect(nearestOnOutline({ id: 'dot', nodes: [{ x: 0, y: 0 }] }, { x: 1, y: 1 })).toBeUndefined()
  })
})

describe('splitSegment', () => {
  function distancesFrom(shape: DrawingShape): number[] {
    const distances: number[] = []
    for (let x = -10; x <= 110; x += 10) {
      for (let y = -50; y <= 20; y += 10) distances.push(nearestOnOutline(shape, { x, y })?.distance ?? Number.NaN)
    }
    return distances
  }

  it('adds a node on a curve without changing the curve', () => {
    const split = { ...ARCH, nodes: splitSegment(ARCH, 0, 0.25) }
    expect(split.nodes[1]).toMatchObject({ x: 15.625, y: -22.5 })
    const before = distancesFrom(ARCH)
    for (const [index, distance] of distancesFrom(split).entries()) expect(distance).toBeCloseTo(before[index] ?? Number.NaN, 2)
  })

  it('adds a sharp node on a line, and appends one on the closing line', () => {
    expect(splitSegment(WEDGE, 0, 0.5)[1]).toEqual({ x: 30, y: 10 })
    const split = splitSegment(WEDGE, 2, 0.5)
    expect(split).toHaveLength(4)
    expect(split[3]).toEqual({ x: 20, y: 35 })
  })

  it('leaves a side without a handle without one', () => {
    const halfCurved: DrawingShape = { id: 'half', nodes: [{ x: 0, y: 0 }, { x: 100, y: 0, in: { x: 0, y: -40 } }] }
    expect(splitSegment(halfCurved, 0, 0.5)).toEqual([
      { x: 0, y: 0 },
      { x: 50, y: -15, in: { x: -25, y: 5 }, out: { x: 25, y: -5 } },
      { x: 100, y: 0, in: { x: 0, y: -20 } },
    ])
  })
})

describe('posedShapes', () => {
  const SECOND = 1_000_000
  const ramp = (from: number, to: number): Keyframe[] => [
    { time: 0, value: from, easing: 'linear' },
    { time: SECOND, value: to, easing: 'linear' },
  ]
  const arm: DrawingShape = {
    id: 'arm',
    nodes: [
      { x: 0, y: 0 },
      { x: 10, y: 0, sets: ['elbow'] },
      { x: 20, y: 0, out: { x: 5, y: 0 }, sets: ['elbow', 'lift'] },
    ],
  }
  const drawing = (shapes: DrawingShape[], nodeSets?: DrawingClip['nodeSets']): DrawingClip => {
    const clip: DrawingClip = { id: 'd', type: 'drawing', start: 0, duration: SECOND, shapes }
    if (nodeSets !== undefined) clip.nodeSets = nodeSets
    return clip
  }

  it('keeps the very list of a drawing without keys or sets', () => {
    const still = drawing([WEDGE])
    expect(posedShapes(still, SECOND / 2)).toBe(still.shapes)
  })

  it('moves nodes by their offset keys, eased between keys', () => {
    const keyed: DrawingShape = { ...WEDGE, nodes: [{ x: 10, y: 10, keyframes: { x: ramp(0, 20), y: [{ time: 0, value: -4, easing: 'hold' }] } }, { x: 50, y: 10 }] }
    const [posed] = posedShapes(drawing([keyed]), SECOND / 2)
    expect(posed?.nodes).toEqual([
      { x: 20, y: 6 },
      { x: 50, y: 10 },
    ])
  })

  it('turns set nodes and their handles around the pivot along the arc, then applies later sets in order', () => {
    const elbow = { id: 'elbow', name: 'Elbow', pivot: { x: 0, y: 0 }, keyframes: { rotation: ramp(0, 90) } }
    const lift = { id: 'lift', name: 'Lift', pivot: { x: 0, y: 0 }, keyframes: { y: ramp(0, -10) } }
    const [half] = posedShapes(drawing([arm], [elbow, lift]), SECOND / 2)
    const [tip, joint, hand] = half?.nodes ?? []
    expect(tip).toEqual({ x: 0, y: 0 })
    expect(joint?.x).toBeCloseTo(10 * Math.SQRT1_2, 10)
    expect(joint?.y).toBeCloseTo(10 * Math.SQRT1_2, 10)
    expect(Math.hypot(joint?.x ?? 0, joint?.y ?? 0)).toBeCloseTo(10, 10)
    expect(hand?.x).toBeCloseTo(20 * Math.SQRT1_2, 10)
    expect(hand?.y).toBeCloseTo(20 * Math.SQRT1_2 - 5, 10)
    expect(hand?.out?.x).toBeCloseTo(5 * Math.SQRT1_2, 10)
    expect(hand?.out?.y).toBeCloseTo(5 * Math.SQRT1_2, 10)
    expect(hand).not.toHaveProperty('sets')
  })

  it('poses clipped children too', () => {
    const shoved = { id: 'shove', name: 'Shove', pivot: { x: 0, y: 0 }, keyframes: { x: ramp(10, 10) } }
    const parent: DrawingShape = { ...WEDGE, children: [{ id: 'inner', nodes: [{ x: 1, y: 1, sets: ['shove'] }, { x: 2, y: 2 }] }] }
    const [posed] = posedShapes(drawing([parent], [shoved]), 0)
    expect(posed?.children?.[0]?.nodes[0]).toEqual({ x: 11, y: 1 })
  })

  function quarterTurn(id: string, pivot: { x: number; y: number }, parent?: string): NodeSet {
    const set: NodeSet = { id, name: id, pivot, keyframes: { rotation: [{ time: 0, value: 90, easing: 'linear' }] } }
    return parent === undefined ? set : { ...set, parent }
  }

  function expectNear(node: { x: number; y: number } | undefined, x: number, y: number): void {
    expect(node?.x).toBeCloseTo(x, 10)
    expect(node?.y).toBeCloseTo(y, 10)
  }

  it('moves a shape that follows a set, with its handles and the shapes clipped inside it', () => {
    const hand: DrawingShape = { id: 'hand', follows: 'elbow', nodes: [{ x: 20, y: 0, out: { x: 5, y: 0 } }, { x: 30, y: 0 }], children: [{ id: 'nail', nodes: [{ x: 25, y: 0 }, { x: 26, y: 0 }] }] }
    const [posed] = posedShapes(drawing([hand], [quarterTurn('elbow', { x: 0, y: 0 })]), 0)
    expectNear(posed?.nodes[0], 0, 20)
    expectNear(posed?.nodes[0]?.out, 0, 5)
    expectNear(posed?.children?.[0]?.nodes[0], 0, 25)
  })

  it('scales nodes and handles around the pivot before turning, and the stroke of a shape following the set when it scales with the object', () => {
    const grow: NodeSet = { ...quarterTurn('grow', { x: 10, y: 0 }), keyframes: { rotation: [{ time: 0, value: 90, easing: 'linear' }], scale: [{ time: 0, value: 2, easing: 'linear' }] } }
    const leaf: DrawingShape = { id: 'leaf', follows: 'grow', nodes: [{ x: 20, y: 0, out: { x: 5, y: 0 } }, { x: 10, y: 0 }], stroke: { color: '#000000', width: 3, scalesWithObject: true } }
    const [posed, fixed] = posedShapes(drawing([leaf, { ...leaf, id: 'fixed', stroke: { color: '#000000', width: 3 } }], [grow]), 0)
    expectNear(posed?.nodes[0], 10, 20)
    expectNear(posed?.nodes[0]?.out, 0, 10)
    expect(posed?.stroke?.width).toBe(6)
    expect(fixed?.stroke?.width).toBe(3)
  })

  it('turns a child set first and then carries it, its pivot and its nodes with its parent, once each', () => {
    const limb: DrawingShape = { id: 'limb', nodes: [{ x: 0, y: 0 }, { x: 10, y: 0, sets: ['upper', 'fore'] }, { x: 20, y: 0, sets: ['fore'] }] }
    const [posed] = posedShapes(drawing([limb], [quarterTurn('upper', { x: 0, y: 0 }), quarterTurn('fore', { x: 10, y: 0 }, 'upper')]), 0)
    const [shoulder, elbow, wrist] = posed?.nodes ?? []
    expectNear(shoulder, 0, 0)
    expectNear(elbow, 0, 10)
    expectNear(wrist, -10, 10)
  })
})
