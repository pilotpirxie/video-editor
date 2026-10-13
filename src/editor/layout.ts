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
  timelineHeight: 280,
  isLeftCollapsed: false,
  isRightCollapsed: false,
  isTimelineCollapsed: false,
}

const TOP_BAR_HEIGHT = 40
const SPLITTER_SIZE = 5
const MIN_SIDEBAR_WIDTH = 220
const MAX_SIDEBAR_WIDTH = 520
const MIN_TIMELINE_HEIGHT = 140
const MIN_CANVAS = { width: 360, height: 220 }

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

// Whatever was stored, the canvas keeps a usable size and no panel can be dragged out of the window.
export function clampLayout(layout: Layout, window: Size): Layout {
  const widthForSidebars = window.width - MIN_CANVAS.width - 2 * SPLITTER_SIZE
  let leftWidth = clamp(layout.leftWidth, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH)
  let rightWidth = clamp(layout.rightWidth, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH)
  const shownLeft = layout.isLeftCollapsed ? 0 : leftWidth
  const shownRight = layout.isRightCollapsed ? 0 : rightWidth
  const excess = shownLeft + shownRight - widthForSidebars
  if (excess > 0) {
    if (!layout.isLeftCollapsed) leftWidth = clamp(leftWidth - excess / 2, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH)
    if (!layout.isRightCollapsed) rightWidth = clamp(rightWidth - excess / 2, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH)
  }

  const heightForTimeline = window.height - TOP_BAR_HEIGHT - SPLITTER_SIZE - MIN_CANVAS.height
  const timelineHeight = clamp(layout.timelineHeight, MIN_TIMELINE_HEIGHT, heightForTimeline)
  return { ...layout, leftWidth: Math.round(leftWidth), rightWidth: Math.round(rightWidth), timelineHeight: Math.round(timelineHeight) }
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
