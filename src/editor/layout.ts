import type { Size } from '../shared/exportPresets.js'

export type Layout = {
  leftWidth: number
  rightWidth: number
  timelineHeight: number
  isLeftCollapsed: boolean
  isRightCollapsed: boolean
  isTimelineCollapsed: boolean
}

export const DEFAULT_LAYOUT: Layout = {
  leftWidth: 300,
  rightWidth: 300,
  // 280 for the tracks as before, plus 11 for the scroll bar under them.
  timelineHeight: 291,
  isLeftCollapsed: false,
  isRightCollapsed: false,
  isTimelineCollapsed: false,
}

const SPLITTER_SIZE = 5
const MIN_SIDEBAR_WIDTH = 220
const MIN_TIMELINE_HEIGHT = 140
const MIN_CANVAS = { width: 360, height: 220 }

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

function widthForSidebars(window: Size): number {
  return window.width - MIN_CANVAS.width - 2 * SPLITTER_SIZE
}

// Whatever was stored, the canvas keeps a usable size and no panel can be dragged out of the window.
// A sidebar has no largest width of its own: it may take whatever the canvas and the other sidebar leave.
export function clampLayout(layout: Layout, window: Size): Layout {
  let leftWidth = Math.max(layout.leftWidth, MIN_SIDEBAR_WIDTH)
  let rightWidth = Math.max(layout.rightWidth, MIN_SIDEBAR_WIDTH)
  const leftSpare = layout.isLeftCollapsed ? 0 : leftWidth - MIN_SIDEBAR_WIDTH
  const rightSpare = layout.isRightCollapsed ? 0 : rightWidth - MIN_SIDEBAR_WIDTH
  const shownLeft = layout.isLeftCollapsed ? 0 : leftWidth
  const shownRight = layout.isRightCollapsed ? 0 : rightWidth
  const excess = shownLeft + shownRight - widthForSidebars(window)
  const spare = leftSpare + rightSpare
  if (excess > 0 && spare > 0) {
    // Each gives up in proportion to what it has above the narrowest width, so the canvas keeps exactly its own.
    const cut = Math.min(excess, spare)
    leftWidth -= (cut * leftSpare) / spare
    rightWidth -= (cut * rightSpare) / spare
  }

  const heightForTimeline = window.height - SPLITTER_SIZE - MIN_CANVAS.height
  const timelineHeight = clamp(layout.timelineHeight, MIN_TIMELINE_HEIGHT, heightForTimeline)
  return { ...layout, leftWidth: Math.floor(leftWidth), rightWidth: Math.floor(rightWidth), timelineHeight: Math.round(timelineHeight) }
}

// How wide a sidebar can be dragged: the other one stays as it is, so only the canvas gives way, down to its smallest width.
export function widestSidebar(layout: Layout, side: 'leftWidth' | 'rightWidth', window: Size): number {
  const isOtherCollapsed = side === 'leftWidth' ? layout.isRightCollapsed : layout.isLeftCollapsed
  const otherWidth = side === 'leftWidth' ? layout.rightWidth : layout.leftWidth
  const shownOther = isOtherCollapsed ? 0 : otherWidth
  return Math.max(MIN_SIDEBAR_WIDTH, widthForSidebars(window) - shownOther)
}

function sizeFrom(stored: Record<string, unknown>, key: keyof Layout, fallback: number): number {
  const value = stored[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function flagFrom(stored: Record<string, unknown>, key: keyof Layout): boolean {
  return stored[key] === true
}

export function parseLayout(text: string | undefined): Layout {
  if (text === undefined) return DEFAULT_LAYOUT
  let stored: unknown
  try {
    stored = JSON.parse(text)
  } catch (error) {
    if (error instanceof SyntaxError) return DEFAULT_LAYOUT
    throw error
  }
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return DEFAULT_LAYOUT

  const record: Record<string, unknown> = { ...stored }
  return {
    leftWidth: sizeFrom(record, 'leftWidth', DEFAULT_LAYOUT.leftWidth),
    rightWidth: sizeFrom(record, 'rightWidth', DEFAULT_LAYOUT.rightWidth),
    timelineHeight: sizeFrom(record, 'timelineHeight', DEFAULT_LAYOUT.timelineHeight),
    isLeftCollapsed: flagFrom(record, 'isLeftCollapsed'),
    isRightCollapsed: flagFrom(record, 'isRightCollapsed'),
    isTimelineCollapsed: flagFrom(record, 'isTimelineCollapsed'),
  }
}
