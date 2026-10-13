import type { BlurClip, Clip, HighlightClip, Project, Shape, ShapeClip } from '../shared/project.js'
import { editClips, placeOnTrack, type NewTrack } from './clips.js'
import { centredStill } from './place.js'

const OPAQUE_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/
const SMALLEST_STRENGTH = 0.1
// New shapes are sized as parts of the canvas, so they are as easy to grab on a small canvas as on a 4K one.
const WIDTH_SHARE = 0.3
const HEIGHT_SHARE = 0.2
const BLUR_PER_HEIGHT = 1 / 45
const BLOCK_PER_HEIGHT = 1 / 27
const SOFT_EDGE_PER_HEIGHT = 1 / 36
const MARKER_YELLOW = '#ffe94d'
const DIMMED_GREY = '#404040'

export type ShapeKind = 'blur' | 'pixelate' | 'highlight' | 'spotlight'

export type NewShape = {
  kind: ShapeKind
  clipId: string
  start: number
  newTrack: NewTrack
}

export type ShapeStyle = {
  shape?: Shape
  softEdge?: number
  strength?: number
  isPixelated?: boolean
  color?: string
  isSpotlight?: boolean
}

export function isShape(clip: Clip): clip is ShapeClip {
  return clip.type === 'blur' || clip.type === 'highlight'
}

// A new blur, pixelate, highlight or spotlight sits in the middle of the canvas, on a new layer above everything else, so it acts on all that is there.
export function addShape(project: Project, added: NewShape): Project {
  const { canvas } = project
  const base = {
    ...centredStill(project, added),
    width: Math.round(canvas.width * WIDTH_SHARE),
    height: Math.round(canvas.height * HEIGHT_SHARE),
    softEdge: 0,
  }
  let clip: Clip
  if (added.kind === 'blur') {
    clip = { ...base, type: 'blur', shape: 'rectangle', strength: Math.max(1, Math.round(canvas.height * BLUR_PER_HEIGHT)) }
  } else if (added.kind === 'pixelate') {
    clip = { ...base, type: 'blur', shape: 'rectangle', strength: Math.max(1, Math.round(canvas.height * BLOCK_PER_HEIGHT)), isPixelated: true }
  } else if (added.kind === 'highlight') {
    clip = { ...base, type: 'highlight', shape: 'rectangle', color: MARKER_YELLOW }
  } else {
    const softEdge = Math.round(canvas.height * SOFT_EDGE_PER_HEIGHT)
    clip = { ...base, type: 'highlight', shape: 'ellipse', height: Math.round(canvas.height * WIDTH_SHARE), softEdge, color: DIMMED_GREY, isSpotlight: true }
  }
  return placeOnTrack(project, { clips: [clip], trackIndex: project.tracks.length, newTrack: added.newTrack })
}

// A switch that is off is left out of the clip, as the file format wants it.
function switchValue(wanted: boolean | undefined, current: true | undefined): true | undefined {
  const isOn = wanted ?? current === true
  return isOn ? true : undefined
}

function styledBlur(clip: BlurClip, style: ShapeStyle): BlurClip {
  const strength = style.strength === undefined ? clip.strength : Math.max(SMALLEST_STRENGTH, style.strength)
  const isPixelated = switchValue(style.isPixelated, clip.isPixelated)
  const isUnchanged = strength === clip.strength && isPixelated === clip.isPixelated
  return isUnchanged ? clip : { ...clip, strength, isPixelated }
}

function styledHighlight(clip: HighlightClip, style: ShapeStyle): HighlightClip {
  const color = style.color !== undefined && OPAQUE_COLOR_PATTERN.test(style.color) ? style.color : clip.color
  const isSpotlight = switchValue(style.isSpotlight, clip.isSpotlight)
  const isUnchanged = color === clip.color && isSpotlight === clip.isSpotlight
  return isUnchanged ? clip : { ...clip, color, isSpotlight }
}

// Changes the look of the chosen blur and highlight clips. A setting a clip does not have, a colour for a blur for example, is ignored for that clip.
export function setShapeStyle(project: Project, clipIds: readonly string[], style: ShapeStyle): Project {
  return editClips(project, new Set(clipIds), (clip) => {
    if (!isShape(clip)) return clip
    const styled = clip.type === 'blur' ? styledBlur(clip, style) : styledHighlight(clip, style)
    const shape = style.shape ?? clip.shape
    const softEdge = style.softEdge === undefined ? clip.softEdge : Math.max(0, style.softEdge)
    const isUnchanged = shape === clip.shape && softEdge === clip.softEdge
    return isUnchanged ? styled : { ...styled, shape, softEdge }
  })
}
