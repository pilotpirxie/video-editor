import { hasTail, type ArrowHead, type CalloutClip, type CalloutShape, type Clip, type Project, type Transform } from '../shared/project.js'
import { editClips, placeOnTrack, type NewTrack } from './clips.js'
import { centredStill } from './place.js'
import { DEFAULT_FAMILY, validColor } from './text.js'

// New annotations are sized as parts of the canvas, so they are as easy to read and to grab on a small canvas as on a 4K one.
const CALLOUT_WIDTH_SHARE = 0.3
const CALLOUT_HEIGHT_SHARE = 0.2
const CALLOUT_TEXT_PER_HEIGHT = 1 / 20
const BORDER_PER_HEIGHT = 1 / 270
const ARROW_LENGTH_SHARE = 0.25
const THICKNESS_PER_HEIGHT = 1 / 135
const CALLOUT_FILL = '#ffffff'
const CALLOUT_INK = '#14171d'
const ARROW_RED = '#e5484d'
// A new tail points down and to the left of its bubble, these shares of the box away from its middle.
const TAIL_SHARE = { x: -0.3, y: 0.9 }
const SMALLEST_LENGTH = 1
const DEGREES_PER_RADIAN = 180 / Math.PI
const FULL_TURN = 360

// What each callout shape is called in the editor.
export const CALLOUT_NAMES: Record<CalloutShape, string> = {
  rectangle: 'Box',
  roundedBox: 'Rounded box',
  ellipse: 'Ellipse',
  speechBubble: 'Speech bubble',
  thoughtBubble: 'Thought bubble',
  arrowBox: 'Arrow box',
  banner: 'Banner',
  burst: 'Burst',
}

export type Point = {
  x: number
  y: number
}

export type NewAnnotation = {
  clipId: string
  start: number
  newTrack: NewTrack
}

export type CalloutStyle = {
  shape?: CalloutShape
  width?: number
  height?: number
  fill?: string
  borderColor?: string
  borderWidth?: number
  // The tip of a bubble's tail, measured from the middle of the box. Ignored by shapes without a tail.
  tail?: Point
}

export type ArrowStyle = {
  length?: number
  thickness?: number
  color?: string
  startHead?: ArrowHead
  endHead?: ArrowHead
}

function newTail(width: number, height: number): Point {
  return { x: Math.round(width * TAIL_SHARE.x), y: Math.round(height * TAIL_SHARE.y) }
}

// A new callout is a speech bubble in the middle of the canvas, on a new layer above everything else.
export function addCallout(project: Project, added: NewAnnotation): Project {
  const { canvas } = project
  const width = Math.round(canvas.width * CALLOUT_WIDTH_SHARE)
  const height = Math.round(canvas.height * CALLOUT_HEIGHT_SHARE)
  const clip: Clip = {
    ...centredStill(project, added),
    type: 'callout',
    text: 'Callout',
    font: { family: DEFAULT_FAMILY, size: Math.max(1, Math.round(canvas.height * CALLOUT_TEXT_PER_HEIGHT)) },
    color: CALLOUT_INK,
    align: 'center',
    width,
    height,
    shape: 'speechBubble',
    fill: CALLOUT_FILL,
    borderColor: CALLOUT_INK,
    borderWidth: Math.max(1, Math.round(canvas.height * BORDER_PER_HEIGHT)),
    tail: newTail(width, height),
  }
  return placeOnTrack(project, { clips: [clip], trackIndex: project.tracks.length, newTrack: added.newTrack })
}

// A new arrow lies level in the middle of the canvas and points to the right; a line is the same without a head.
export function addArrow(project: Project, added: NewAnnotation & { kind: 'arrow' | 'line' }): Project {
  const { canvas } = project
  const clip: Clip = {
    ...centredStill(project, added),
    type: 'arrow',
    length: Math.round(canvas.width * ARROW_LENGTH_SHARE),
    thickness: Math.max(1, Math.round(canvas.height * THICKNESS_PER_HEIGHT)),
    color: ARROW_RED,
    startHead: 'none',
    endHead: added.kind === 'arrow' ? 'triangle' : 'none',
  }
  return placeOnTrack(project, { clips: [clip], trackIndex: project.tracks.length, newTrack: added.newTrack })
}

// A bubble always has a tail and no other shape has one, as the file format wants it.
function tailWith(clip: CalloutClip, shape: CalloutShape, width: number, height: number, wanted: Point | undefined): Point | undefined {
  if (!hasTail(shape)) return undefined
  if (wanted === undefined) return clip.tail ?? newTail(width, height)
  const isUnchanged = clip.tail !== undefined && clip.tail.x === wanted.x && clip.tail.y === wanted.y
  return isUnchanged ? clip.tail : { x: wanted.x, y: wanted.y }
}

// Changes the shape of the chosen callouts. Their words are styled as those of a text clip.
export function setCalloutStyle(project: Project, clipIds: readonly string[], style: CalloutStyle): Project {
  return editClips(project, new Set(clipIds), (clip) => {
    if (clip.type !== 'callout') return clip
    const shape = style.shape ?? clip.shape
    const width = style.width === undefined ? clip.width : Math.max(SMALLEST_LENGTH, style.width)
    const height = style.height === undefined ? clip.height : Math.max(SMALLEST_LENGTH, style.height)
    const fill = validColor(style.fill, clip.fill)
    const borderColor = validColor(style.borderColor, clip.borderColor)
    const borderWidth = style.borderWidth === undefined ? clip.borderWidth : Math.max(0, style.borderWidth)
    const tail = tailWith(clip, shape, width, height, style.tail)
    const isSameBox = shape === clip.shape && width === clip.width && height === clip.height && tail === clip.tail
    const isSameInk = fill === clip.fill && borderColor === clip.borderColor && borderWidth === clip.borderWidth
    return isSameBox && isSameInk ? clip : { ...clip, shape, width, height, fill, borderColor, borderWidth, tail }
  })
}

export function setArrowStyle(project: Project, clipIds: readonly string[], style: ArrowStyle): Project {
  return editClips(project, new Set(clipIds), (clip) => {
    if (clip.type !== 'arrow') return clip
    const length = style.length === undefined ? clip.length : Math.max(SMALLEST_LENGTH, style.length)
    const thickness = style.thickness === undefined ? clip.thickness : Math.max(SMALLEST_LENGTH, style.thickness)
    const color = validColor(style.color, clip.color)
    const startHead = style.startHead ?? clip.startHead
    const endHead = style.endHead ?? clip.endHead
    const isUnchanged = length === clip.length && thickness === clip.thickness && color === clip.color && startHead === clip.startHead && endHead === clip.endHead
    return isUnchanged ? clip : { ...clip, length, thickness, color, startHead, endHead }
  })
}

// Where a point given in a clip's own units, from its middle, lies on the canvas.
export function outOfClip(transform: Transform, point: Point): Point {
  const angle = transform.rotation / DEGREES_PER_RADIAN
  const x = point.x * transform.scaleX
  const y = point.y * transform.scaleY
  return { x: transform.x + x * Math.cos(angle) - y * Math.sin(angle), y: transform.y + x * Math.sin(angle) + y * Math.cos(angle) }
}

// The opposite of `outOfClip`. A clip scaled to nothing has no inside; its middle is returned.
export function intoClip(transform: Transform, onCanvas: Point): Point {
  if (transform.scaleX === 0 || transform.scaleY === 0) return { x: 0, y: 0 }
  const angle = transform.rotation / DEGREES_PER_RADIAN
  const x = onCanvas.x - transform.x
  const y = onCanvas.y - transform.y
  return { x: (x * Math.cos(angle) + y * Math.sin(angle)) / transform.scaleX, y: (y * Math.cos(angle) - x * Math.sin(angle)) / transform.scaleY }
}

// The two ends of an arrow on the canvas.
export function arrowEnds(transform: Transform, length: number): { start: Point; end: Point } {
  return { start: outOfClip(transform, { x: -length / 2, y: 0 }), end: outOfClip(transform, { x: length / 2, y: 0 }) }
}

// The place, turn and length an arrow needs to run between two points on the canvas. Its scale stays as it is.
// The turn is the one nearest to the arrow's own, so an animated arrow does not spin the long way round.
export function arrowBetween(start: Point, end: Point, transform: Transform): { x: number; y: number; rotation: number; length: number } {
  const across = end.x - start.x
  const down = end.y - start.y
  const turn = Math.atan2(down, across) * DEGREES_PER_RADIAN
  const rotation = turn + Math.round((transform.rotation - turn) / FULL_TURN) * FULL_TURN
  const length = transform.scaleX === 0 ? 0 : Math.hypot(across, down) / transform.scaleX
  return { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2, rotation, length: Math.max(SMALLEST_LENGTH, length) }
}
