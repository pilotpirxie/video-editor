import { describe, expect, it } from 'vitest'
import type { DrawingShape } from '../shared/project.js'
import { shapesBounds, svgPathOf } from './curves.js'

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
