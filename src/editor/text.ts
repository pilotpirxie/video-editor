import type { Clip, Project, TextAlign } from '../shared/project.js'
import { editClips, placeOnTrack, type NewTrack } from './clips.js'
import { STILL_DURATION } from './place.js'

const DEFAULT_TEXT = 'Text'
const DEFAULT_FAMILY = 'Helvetica Neue'
const DEFAULT_COLOR = '#ffffff'
// A new title is one twelfth of the canvas high, so it reads the same on a small and on a 4K canvas.
const LINES_PER_CANVAS_HEIGHT = 12
const MIN_FONT_SIZE = 1
const MAX_FONT_SIZE = 2000
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/

export type NewText = {
  clipId: string
  start: number
  newTrack: NewTrack
}

export type TextStyle = {
  text?: string
  family?: string
  size?: number
  color?: string
  align?: TextAlign
}

// A new text clip sits in the middle of the canvas, on a new layer above everything else.
export function addText(project: Project, added: NewText): Project {
  const { canvas } = project
  const clip: Clip = {
    id: added.clipId,
    type: 'text',
    start: added.start,
    duration: STILL_DURATION,
    transform: { x: canvas.width / 2, y: canvas.height / 2, scaleX: 1, scaleY: 1, rotation: 0 },
    opacity: 1,
    text: DEFAULT_TEXT,
    font: { family: DEFAULT_FAMILY, size: Math.round(canvas.height / LINES_PER_CANVAS_HEIGHT) },
    color: DEFAULT_COLOR,
    align: 'center',
  }
  return placeOnTrack(project, { clips: [clip], trackIndex: project.tracks.length, newTrack: added.newTrack })
}

// Changes the words or the look of the chosen text clips. A family or colour the file format would refuse is ignored.
// Empty text is accepted so that typing can pass through it; whoever ends the edit must not keep it, because it cannot be saved.
export function setTextStyle(project: Project, clipIds: readonly string[], style: TextStyle): Project {
  return editClips(project, new Set(clipIds), (clip) => {
    if (clip.type !== 'text') return clip
    const text = style.text ?? clip.text
    const family = style.family === undefined || style.family === '' ? clip.font.family : style.family
    const size = style.size === undefined ? clip.font.size : Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, style.size))
    const color = style.color !== undefined && COLOR_PATTERN.test(style.color) ? style.color : clip.color
    const align = style.align ?? clip.align
    const isUnchanged = text === clip.text && family === clip.font.family && size === clip.font.size && color === clip.color && align === clip.align
    return isUnchanged ? clip : { ...clip, text, font: { family, size }, color, align }
  })
}
