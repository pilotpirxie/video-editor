import { describe, expect, it } from 'vitest'
import type { DrawingShape } from '../shared/project.js'
import { shapesBounds } from './curves.js'

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

  it('takes every shape and leaves out the ones clipped inside', () => {
    const inside: DrawingShape = { ...WEDGE, stroke: undefined, children: [{ id: 'far', nodes: [{ x: -500, y: -500 }, { x: 500, y: 500 }] }] }
    expect(shapesBounds([ARCH, inside], true)).toEqual({ left: 0, top: -30, right: 100, bottom: 60 })
  })

  it('has nothing to fit without shapes', () => {
    expect(shapesBounds([], true)).toBeUndefined()
  })
})
