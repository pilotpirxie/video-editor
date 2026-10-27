import { describe, expect, it } from 'vitest'
import { hexInput, hexOf, partsOf } from './colors.js'

describe('partsOf and hexOf', () => {
  it('read hue, saturation, lightness and opacity from a hex colour', () => {
    expect(partsOf('#FF0000')).toEqual({ hue: 0, saturation: 100, lightness: 50, opacity: 100 })
    expect(partsOf('#00FF0080')).toMatchObject({ hue: 120, saturation: 100, lightness: 50 })
    expect(partsOf('#00FF0080').opacity).toBeCloseTo(50.2, 1)
    expect(partsOf('#808080')).toMatchObject({ hue: 0, saturation: 0 })
    const purple = partsOf('#7F3FBF')
    expect(purple.hue).toBeCloseTo(270, 0)
    expect(purple.saturation).toBeCloseTo(50, 0)
    expect(purple.lightness).toBeCloseTo(50, 0)
  })

  it('write a hex colour, with alpha only when it is not opaque', () => {
    expect(hexOf({ hue: 240, saturation: 100, lightness: 50, opacity: 100 })).toBe('#0000FF')
    expect(hexOf({ hue: 0, saturation: 0, lightness: 100, opacity: 50 })).toBe('#FFFFFF80')
    expect(hexOf({ hue: 30, saturation: 100, lightness: 50, opacity: 0 })).toBe('#FF800000')
  })

  it('round-trip every hex colour they read', () => {
    for (const hex of ['#000000', '#FFFFFF', '#12AB9C', '#FFCC9940', '#7F3FBF', '#010203']) {
      expect(hexOf(partsOf(hex))).toBe(hex)
    }
  })
})

describe('hexInput', () => {
  it('takes six hex digits with or without the hash, and nothing else', () => {
    expect(hexInput(' ff8800 ')).toBe('#FF8800')
    expect(hexInput('#a1B2c3')).toBe('#A1B2C3')
    expect(hexInput('#FFF')).toBeUndefined()
    expect(hexInput('#FF8800AA')).toBeUndefined()
    expect(hexInput('orange')).toBeUndefined()
  })
})
