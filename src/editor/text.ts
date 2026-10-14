import type { Clip, Project, TextAlign, TextSettings } from '../shared/project.js'
import { editClips, placeOnTrack } from './clips.js'
import { centredStill, type NewStill } from './place.js'

const DEFAULT_TEXT = 'Text'
export const DEFAULT_FAMILY = 'Helvetica Neue'
const DEFAULT_COLOR = '#ffffff'
// A new title is one twelfth of the canvas high, so it reads the same on a small and on a 4K canvas.
const LINES_PER_CANVAS_HEIGHT = 12
const MIN_FONT_SIZE = 1
const MAX_FONT_SIZE = 2000
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/
const REGULAR_WEIGHT = 400
const WEIGHT_STEP = 100
const LIGHTEST_WEIGHT = 100
const HEAVIEST_WEIGHT = 900
const TIGHTEST_LINES = 0.5
const WIDEST_LINES = 3
const SMALLEST_LENGTH = 0.1
const NARROWEST_BOX = 1
// A new outline and a new shadow are sized to the letters, so they show on a small title and do not drown a large one.
const OUTLINE_PER_FONT_SIZE = 1 / 20
const SHADOW_PER_FONT_SIZE = 1 / 16
const DEFAULT_LINE_COLOR = '#000000'
const DEFAULT_SHADE = '#000000aa'


export type TextStyle = {
  text?: string
  family?: string
  size?: number
  // Whole hundreds from 100 to 900; 400 is the regular weight.
  weight?: number
  color?: string
  align?: TextAlign
  // Line height as a share of the font's own; 1 is the font's.
  lineSpacing?: number
  hasOutline?: boolean
  outlineColor?: string
  outlineWidth?: number
  hasShadow?: boolean
  shadowColor?: string
  shadowOffsetX?: number
  shadowOffsetY?: number
  shadowBlur?: number
  // The two below are for text clips only; a callout has its own shape and size.
  hasBackground?: boolean
  backgroundColor?: string
  // 'auto' lets the box follow the longest line again.
  boxWidth?: number | 'auto'
}

type Outline = NonNullable<TextSettings['outline']>
type Shadow = NonNullable<TextSettings['shadow']>

// A new text clip sits in the middle of the canvas, on a new layer above everything else.
export function addText(project: Project, added: NewStill): Project {
  const { canvas } = project
  const clip: Clip = {
    ...centredStill(project, added),
    type: 'text',
    text: DEFAULT_TEXT,
    font: { family: DEFAULT_FAMILY, size: Math.round(canvas.height / LINES_PER_CANVAS_HEIGHT) },
    color: DEFAULT_COLOR,
    align: 'center',
  }
  return placeOnTrack(project, { clips: [clip], trackIndex: added.trackIndex ?? project.tracks.length, newTrack: added.newTrack })
}

export function validColor(wanted: string | undefined, current: string): string {
  return wanted !== undefined && COLOR_PATTERN.test(wanted) ? wanted : current
}

function fontWith(font: TextSettings['font'], style: TextStyle): TextSettings['font'] {
  const family = style.family === undefined || style.family === '' ? font.family : style.family
  const size = style.size === undefined ? font.size : Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, style.size))
  let weight = font.weight
  if (style.weight !== undefined) {
    const hundreds = Math.round(style.weight / WEIGHT_STEP) * WEIGHT_STEP
    const within = Math.min(HEAVIEST_WEIGHT, Math.max(LIGHTEST_WEIGHT, hundreds))
    // The regular weight is left out of the clip, so a title that was never made bold stays as it was saved.
    weight = within === REGULAR_WEIGHT ? undefined : within
  }
  const isUnchanged = family === font.family && size === font.size && weight === font.weight
  if (isUnchanged) return font
  return weight === undefined ? { family, size } : { family, size, weight }
}

function outlineWith(current: Outline | undefined, style: TextStyle, fontSize: number): Outline | undefined {
  const isOn = style.hasOutline ?? current !== undefined
  if (!isOn) return undefined
  const base = current ?? { color: DEFAULT_LINE_COLOR, width: Math.max(1, Math.round(fontSize * OUTLINE_PER_FONT_SIZE)) }
  const color = validColor(style.outlineColor, base.color)
  const width = style.outlineWidth === undefined ? base.width : Math.max(SMALLEST_LENGTH, style.outlineWidth)
  return color === base.color && width === base.width ? base : { color, width }
}

function shadowWith(current: Shadow | undefined, style: TextStyle, fontSize: number): Shadow | undefined {
  const isOn = style.hasShadow ?? current !== undefined
  if (!isOn) return undefined
  const reach = Math.max(1, Math.round(fontSize * SHADOW_PER_FONT_SIZE))
  const base = current ?? { color: DEFAULT_SHADE, offsetX: reach, offsetY: reach, blur: reach }
  const shadow: Shadow = {
    color: validColor(style.shadowColor, base.color),
    offsetX: style.shadowOffsetX ?? base.offsetX,
    offsetY: style.shadowOffsetY ?? base.offsetY,
    blur: Math.max(0, style.shadowBlur ?? base.blur),
  }
  const isUnchanged = shadow.color === base.color && shadow.offsetX === base.offsetX && shadow.offsetY === base.offsetY && shadow.blur === base.blur
  return isUnchanged ? base : shadow
}

// The settings every clip with words has, with the wanted ones changed. Parts that stay the same keep their identity.
function settingsWith(clip: TextSettings, style: TextStyle): TextSettings {
  const font = fontWith(clip.font, style)
  let lineSpacing = clip.lineSpacing
  if (style.lineSpacing !== undefined) {
    const within = Math.min(WIDEST_LINES, Math.max(TIGHTEST_LINES, style.lineSpacing))
    lineSpacing = within === 1 ? undefined : within
  }
  return {
    text: style.text ?? clip.text,
    font,
    color: validColor(style.color, clip.color),
    align: style.align ?? clip.align,
    outline: outlineWith(clip.outline, style, font.size),
    shadow: shadowWith(clip.shadow, style, font.size),
    lineSpacing,
  }
}

function backgroundWith(current: { color: string } | undefined, style: TextStyle): { color: string } | undefined {
  const isOn = style.hasBackground ?? current !== undefined
  if (!isOn) return undefined
  const base = current ?? { color: DEFAULT_SHADE }
  const color = validColor(style.backgroundColor, base.color)
  return color === base.color ? base : { color }
}

function boxWidthWith(current: number | undefined, wanted: TextStyle['boxWidth']): number | undefined {
  if (wanted === undefined) return current
  return wanted === 'auto' ? undefined : Math.max(NARROWEST_BOX, wanted)
}

// Changes the words or the look of the chosen text clips and callouts. A family or colour the file format would refuse is ignored.
// Empty text is accepted so that typing can pass through it; whoever ends the edit must not keep it in a text clip, because it cannot be saved there.
export function setTextStyle(project: Project, clipIds: readonly string[], style: TextStyle): Project {
  return editClips(project, new Set(clipIds), (clip) => {
    if (clip.type !== 'text' && clip.type !== 'callout') return clip
    const settings = settingsWith(clip, style)
    let isUnchanged = true
    for (const key of ['text', 'font', 'color', 'align', 'outline', 'shadow', 'lineSpacing'] as const) {
      if (settings[key] !== clip[key]) isUnchanged = false
    }
    if (clip.type === 'callout') return isUnchanged ? clip : { ...clip, ...settings }
    const background = backgroundWith(clip.background, style)
    const boxWidth = boxWidthWith(clip.boxWidth, style.boxWidth)
    if (isUnchanged && background === clip.background && boxWidth === clip.boxWidth) return clip
    return { ...clip, ...settings, background, boxWidth }
  })
}
