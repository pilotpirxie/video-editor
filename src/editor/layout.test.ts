import { describe, expect, it } from 'vitest'
import { DEFAULT_LAYOUT, clampLayout, parseLayout } from './layout.js'

const MIN_WINDOW = { width: 1280, height: 720 }

describe('parseLayout', () => {
  it('reads back what was stored', () => {
    const layout = { ...DEFAULT_LAYOUT, leftWidth: 350, isRightCollapsed: true }
    expect(parseLayout(JSON.stringify(layout))).toEqual(layout)
  })

  it.each([
    ['nothing stored', undefined],
    ['text that is not JSON', '{ left'],
    ['a list', '[1, 2]'],
    ['a number', '12'],
  ])('falls back to the default layout for %s', (_label, text) => {
    expect(parseLayout(text)).toEqual(DEFAULT_LAYOUT)
  })

  it('replaces only the values that are not usable', () => {
    const parsed = parseLayout('{"leftWidth":"wide","rightWidth":400,"timelineHeight":null,"isLeftCollapsed":"yes"}')
    expect(parsed).toEqual({ ...DEFAULT_LAYOUT, rightWidth: 400 })
  })
})

describe('clampLayout', () => {
  it('leaves a layout that fits untouched', () => {
    expect(clampLayout(DEFAULT_LAYOUT, { width: 1440, height: 900 })).toEqual(DEFAULT_LAYOUT)
  })

  it('keeps panels within their limits', () => {
    const clamped = clampLayout({ ...DEFAULT_LAYOUT, leftWidth: 50, rightWidth: 5000, timelineHeight: 20 }, { width: 2560, height: 1440 })
    expect(clamped.leftWidth).toBe(220)
    expect(clamped.rightWidth).toBe(520)
    expect(clamped.timelineHeight).toBe(140)
  })

  it('shrinks the sidebars so the canvas keeps its minimum width at the smallest window', () => {
    const clamped = clampLayout({ ...DEFAULT_LAYOUT, leftWidth: 520, rightWidth: 520 }, MIN_WINDOW)
    expect(MIN_WINDOW.width - clamped.leftWidth - clamped.rightWidth - 10).toBeGreaterThanOrEqual(360)
  })

  it('does not shrink a sidebar for one that is collapsed', () => {
    const clamped = clampLayout({ ...DEFAULT_LAYOUT, leftWidth: 520, rightWidth: 520, isRightCollapsed: true }, MIN_WINDOW)
    expect(clamped.leftWidth).toBe(520)
  })

  it('keeps the timeline from covering the canvas', () => {
    const clamped = clampLayout({ ...DEFAULT_LAYOUT, timelineHeight: 2000 }, MIN_WINDOW)
    expect(clamped.timelineHeight).toBe(720 - 40 - 5 - 220)
  })
})
