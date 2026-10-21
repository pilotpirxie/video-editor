import { describe, expect, it } from 'vitest'
import { DEFAULT_LAYOUT, clampLayout, parseLayout, widestSidebar } from './layout.js'

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
    expect(clamped.rightWidth).toBe(2560 - 360 - 10 - 220)
    expect(clamped.timelineHeight).toBe(140)
  })

  it('lets a sidebar be much wider than the other when the window has the room', () => {
    const wide = { ...DEFAULT_LAYOUT, leftWidth: 1100 }
    expect(clampLayout(wide, { width: 2560, height: 1440 })).toEqual(wide)
  })

  it('shrinks the sidebars so the canvas keeps exactly its minimum width at the smallest window', () => {
    const clamped = clampLayout({ ...DEFAULT_LAYOUT, leftWidth: 900, rightWidth: 390 }, MIN_WINDOW)
    expect(MIN_WINDOW.width - clamped.leftWidth - clamped.rightWidth - 10).toBe(360)
    expect(clamped).toMatchObject({ leftWidth: 596, rightWidth: 314 })
  })

  it('does not shrink a sidebar for one that is collapsed', () => {
    const clamped = clampLayout({ ...DEFAULT_LAYOUT, leftWidth: 520, rightWidth: 520, isRightCollapsed: true }, MIN_WINDOW)
    expect(clamped).toMatchObject({ leftWidth: 520, rightWidth: 520 })
  })

  it('keeps the timeline from covering the canvas', () => {
    const clamped = clampLayout({ ...DEFAULT_LAYOUT, timelineHeight: 2000 }, MIN_WINDOW)
    expect(clamped.timelineHeight).toBe(720 - 5 - 220)
  })
})

describe('widestSidebar', () => {
  it('leaves the other sidebar and the smallest canvas alone', () => {
    expect(widestSidebar(DEFAULT_LAYOUT, 'leftWidth', MIN_WINDOW)).toBe(1280 - 360 - 10 - 300)
    expect(widestSidebar({ ...DEFAULT_LAYOUT, leftWidth: 400 }, 'rightWidth', MIN_WINDOW)).toBe(1280 - 360 - 10 - 400)
  })

  it('takes the room of a collapsed sidebar', () => {
    expect(widestSidebar({ ...DEFAULT_LAYOUT, isRightCollapsed: true }, 'leftWidth', MIN_WINDOW)).toBe(910)
  })

  it('is never narrower than the narrowest sidebar', () => {
    expect(widestSidebar({ ...DEFAULT_LAYOUT, rightWidth: 800 }, 'leftWidth', MIN_WINDOW)).toBe(220)
  })
})
