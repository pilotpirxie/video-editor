import type { Size } from '../shared/exportPresets.js'
import { minimumHalvings } from '../shared/limits.js'
import type { Cadence, MediaState, VideoInfo, WantedRange } from '../shared/mediaProtocol.js'
import {
  ease,
  valueAt,
  type AnimatableProperty,
  type ArrowHead,
  type CalloutShape,
  type Clip,
  type Crop,
  type Effect,
  type GroupClip,
  type Keyframes,
  type Project,
  type Shape,
  type TextClip,
  type TextSettings,
  type Track,
  type Transform,
  type Transition,
  type TransitionType,
  type VideoClip,
  type VisualClip,
} from '../shared/project.js'
import { TIMELINE_GRID, frameDuration, frameIndexAt, loopedTime, sourceTime } from '../shared/time.js'
import { largestScaleBetween } from './camera.js'
import { animationChangeAt, largestAnimationScale } from './presets.js'

const MAX_HALVINGS = 6
const NO_CROP: Crop = { left: 0, top: 0, right: 0, bottom: 0 }
// How small the picture that zooms in starts, and how large the one that zooms out ends.
const ZOOM_IN_FROM = 0.5
const ZOOM_OUT_TO = 2
// Transitions whose two pictures are added up. Drawn one over the other, each at part strength, they would let what is beneath show through halfway.
const SUMMED: readonly TransitionType[] = [
  'crossDissolve',
  'wipeLeft',
  'wipeRight',
  'wipeUp',
  'wipeDown',
  'wipeUpLeft',
  'wipeUpRight',
  'wipeDownLeft',
  'wipeDownRight',
  'zoom',
  'circleReveal',
  'circleClose',
]
// Transitions on a cut whose leaving picture moves away over the arriving one, which waits beneath it.
const LEAVING_ON_TOP: readonly TransitionType[] = ['shrink', 'spin']
const FULL_TURN = 360
const DEGREES_TO_RADIANS = Math.PI / 180

type Tint = {
  color: 'black' | 'white'
  amount: number
}

// The part of the canvas a layer shows in while a wipe or a circle passes over it, in canvas pixels.
type Reveal =
  // The side of the line through (x, y) that the normal points to.
  | { kind: 'line'; x: number; y: number; normalX: number; normalY: number }
  | { kind: 'circle'; x: number; y: number; radius: number; isInside: boolean }

// What a transition does to a layer at one moment, besides moving it and changing its opacity.
export type TransitionLook = {
  tint?: Tint
  reveal?: Reveal
  // Two layers next to each other with the same key are added up, then drawn as one.
  mixKey?: string
}

type LayerBase = {
  clipId: string
  // The clip's own place on the canvas, which is what the editor's handles change.
  transform: Transform
  // Where the layer is drawn while an animation or a transition moves it.
  placed?: Transform
  opacity: number
  transition?: TransitionLook
  // The groups the clip is in, the outermost first.
  groups?: readonly string[]
}

type PictureLayerBase = LayerBase & {
  // The effects that are switched on, first to last.
  effects?: readonly Effect[]
}

export type VideoLayer = PictureLayerBase & {
  kind: 'video'
  mediaId: string
  video: VideoInfo
  frame: number
  halvings: number
  crop: Crop
}

export type ImageLayer = PictureLayerBase & {
  kind: 'image'
  mediaId: string
  width: number
  height: number
  crop: Crop
}

// Everything that decides how words look. `boxWidth` wraps them; without it the box is as wide as the longest line.
export type TextLook = TextSettings & {
  background?: { color: string }
  boxWidth?: number
}

export type CalloutLook = {
  width: number
  height: number
  shape: CalloutShape
  fill: string
  borderColor: string
  borderWidth: number
  tail: { x: number; y: number } | undefined
  text: TextLook
}

export type ArrowLook = {
  length: number
  thickness: number
  color: string
  startHead: ArrowHead
  endHead: ArrowHead
}

const letters = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

// The letters of a text as a reader counts them: an emoji or an accented letter is one.
export function lettersOf(text: string): string[] {
  const pieces: string[] = []
  for (const piece of letters.segment(text)) pieces.push(piece.segment)
  return pieces
}

// A layer that is drawn from its description. Its picture is made once, for the largest scale the clip reaches while it is shown, so an animation does not draw it anew on every frame.
type DrawnLayerBase = PictureLayerBase & {
  sharpScaleX: number
  sharpScaleY: number
}

type TextLayer = DrawnLayerBase & {
  kind: 'text'
  look: TextLook
  // How many letters a typewriter has written so far; left out when all are there.
  shownLetters?: number
}

type CalloutLayer = DrawnLayerBase & {
  kind: 'callout'
  look: CalloutLook
}

type ArrowLayer = DrawnLayerBase & {
  kind: 'arrow'
  look: ArrowLook
}

type ShapeLayerBase = LayerBase & {
  width: number
  height: number
  shape: Shape
  softEdge: number
}

export type BlurLayer = ShapeLayerBase & {
  kind: 'blur'
  strength: number
  isPixelated: boolean
}

export type HighlightLayer = ShapeLayerBase & {
  kind: 'highlight'
  color: string
  isSpotlight: boolean
}

export type DrawnLayer = TextLayer | CalloutLayer | ArrowLayer
export type PictureLayer = VideoLayer | ImageLayer | DrawnLayer
export type Layer = PictureLayer | BlurLayer | HighlightLayer

export type MediaStates = Readonly<Record<string, MediaState>>

function animated(keyframes: Keyframes | undefined, property: AnimatableProperty, localTime: number, fallback: number): number {
  const track = keyframes?.[property]
  if (track === undefined) return fallback
  return valueAt(track, localTime) ?? fallback
}

export function fadeFactor(localTime: number, duration: number, fadeIn: number | undefined, fadeOut: number | undefined): number {
  let factor = 1
  if (fadeIn !== undefined && localTime < fadeIn) factor *= localTime / fadeIn
  const remaining = duration - localTime
  if (fadeOut !== undefined && remaining < fadeOut) factor *= remaining / fadeOut
  return factor
}

function transformAt(clip: VisualClip, localTime: number): Transform {
  return {
    x: animated(clip.keyframes, 'x', localTime, clip.transform.x),
    y: animated(clip.keyframes, 'y', localTime, clip.transform.y),
    scaleX: animated(clip.keyframes, 'scaleX', localTime, clip.transform.scaleX),
    scaleY: animated(clip.keyframes, 'scaleY', localTime, clip.transform.scaleY),
    rotation: animated(clip.keyframes, 'rotation', localTime, clip.transform.rotation),
  }
}

function cropAt(clip: { crop?: Crop; keyframes?: Keyframes }, localTime: number): Crop {
  const base = clip.crop ?? NO_CROP
  return {
    left: animated(clip.keyframes, 'cropLeft', localTime, base.left),
    top: animated(clip.keyframes, 'cropTop', localTime, base.top),
    right: animated(clip.keyframes, 'cropRight', localTime, base.right),
    bottom: animated(clip.keyframes, 'cropBottom', localTime, base.bottom),
  }
}

function opacityAt(clip: VisualClip, localTime: number): number {
  const opacity = animated(clip.keyframes, 'opacity', localTime, clip.opacity)
  // A clip that a transition draws before its start or past its end is as faded as it is at that end.
  const inside = Math.min(Math.max(localTime, 0), clip.duration)
  return opacity * fadeFactor(inside, clip.duration, clip.fadeIn, clip.fadeOut)
}

function largestValue(keyframes: Keyframes | undefined, property: AnimatableProperty, fallback: number): number {
  const track = keyframes?.[property]
  if (track === undefined) return fallback
  let largest = -Infinity
  for (const keyframe of track) largest = Math.max(largest, keyframe.value)
  return largest
}

export function sourceHalvings(video: VideoInfo, clip: VisualClip, outputScale: number): number {
  const largestScale = Math.max(
    largestValue(clip.keyframes, 'scaleX', clip.transform.scaleX),
    largestValue(clip.keyframes, 'scaleY', clip.transform.scaleY),
  )
  const drawnScale = largestScale * outputScale
  const required = minimumHalvings(video.width, video.height)
  if (drawnScale <= 0) return Math.max(required, MAX_HALVINGS)
  const affordable = Math.floor(Math.log2(1 / drawnScale))
  return Math.min(MAX_HALVINGS, Math.max(required, affordable))
}

// One clip's share of a transition at one moment.
export type TransitionPart = {
  type: TransitionType
  // How far the transition has run, from 0 to 1.
  progress: number
  isArriving: boolean
  // On a cut two clips share the transition; at the start or the end of a clip the clip has it to itself.
  isOnCut: boolean
}

// How a transition changes a layer: its opacity is multiplied, its place moved, scaled and turned (in degrees) about the middle of the canvas.
export type TransitionChange = {
  opacity: number
  offsetX: number
  offsetY: number
  scale: number
  rotation: number
  tint?: Tint
  reveal?: Reveal
}

// The side of the canvas a wipe, a slide or a push comes from, in canvas widths and heights: a wipe to the left comes from the right.
type Side = {
  x: number
  y: number
}

const WIPE_FROM: Partial<Record<TransitionType, Side>> = {
  wipeLeft: { x: 1, y: 0 },
  wipeRight: { x: -1, y: 0 },
  wipeUp: { x: 0, y: 1 },
  wipeDown: { x: 0, y: -1 },
  wipeUpLeft: { x: 1, y: 1 },
  wipeUpRight: { x: -1, y: 1 },
  wipeDownLeft: { x: 1, y: -1 },
  wipeDownRight: { x: -1, y: -1 },
}

const SLIDE_FROM: Partial<Record<TransitionType, Side>> = {
  slide: { x: 1, y: 0 },
  slideRight: { x: -1, y: 0 },
  slideUp: { x: 0, y: 1 },
  slideDown: { x: 0, y: -1 },
}

const PUSH_FROM: Partial<Record<TransitionType, Side>> = {
  push: { x: 1, y: 0 },
  pushRight: { x: -1, y: 0 },
  pushUp: { x: 0, y: 1 },
  pushDown: { x: 0, y: -1 },
}

// The edge of a wipe once it has come `moved` of its way. It starts on the side or corner the wipe comes from and sweeps the whole canvas; the arriving picture is on the side it has passed.
function wipeReveal(from: Side, moved: number, isArriving: boolean, canvas: Size): Reveal {
  const length = Math.hypot(from.x, from.y)
  const normalX = from.x / length
  const normalY = from.y / length
  const sweep = (Math.abs(normalX) * canvas.width + Math.abs(normalY) * canvas.height) * moved
  const startX = from.x > 0 ? canvas.width : 0
  const startY = from.y > 0 ? canvas.height : 0
  const side = isArriving ? 1 : -1
  return { kind: 'line', x: startX - normalX * sweep, y: startY - normalY * sweep, normalX: normalX * side, normalY: normalY * side }
}

// Everything is measured on the canvas, so the camera looks at a transition as at anything else.
export function transitionChange(part: TransitionPart, canvas: Size): TransitionChange {
  const { type, progress, isArriving } = part
  // How much of the layer is there: the arriving one grows from nothing, the leaving one shrinks to nothing.
  const presence = isArriving ? progress : 1 - progress
  const moved = ease('easeInOut', progress)
  const still = { opacity: 1, offsetX: 0, offsetY: 0, scale: 1, rotation: 0 }
  const wipeFrom = WIPE_FROM[type]
  const slideFrom = SLIDE_FROM[type]
  const movesFrom = slideFrom ?? PUSH_FROM[type]

  if (type === 'crossDissolve') {
    return { ...still, opacity: presence }
  } else if (type === 'fadeBlack' || type === 'fadeWhite') {
    // One half of the time goes between the picture and the colour, the other between the colour and nothing.
    const tint: Tint = { color: type === 'fadeBlack' ? 'black' : 'white', amount: Math.min(1, 2 * (1 - presence)) }
    return { ...still, opacity: Math.min(1, 2 * presence), tint }
  } else if (movesFrom !== undefined) {
    if (isArriving) return { ...still, offsetX: movesFrom.x * canvas.width * (1 - moved), offsetY: movesFrom.y * canvas.height * (1 - moved) }
    // On a cut the new picture slides over the old one, which stays where it is.
    const staysPut = slideFrom !== undefined && part.isOnCut
    return staysPut ? still : { ...still, offsetX: -movesFrom.x * canvas.width * moved, offsetY: -movesFrom.y * canvas.height * moved }
  } else if (type === 'zoom') {
    const scale = isArriving ? ZOOM_IN_FROM + (1 - ZOOM_IN_FROM) * moved : 1 + (ZOOM_OUT_TO - 1) * moved
    return { ...still, opacity: presence, scale }
  } else if (type === 'shrink' || type === 'spin') {
    const turn = type === 'spin' ? FULL_TURN : 0
    if (!isArriving) return { ...still, scale: 1 - moved, rotation: turn * moved }
    // On its own an arriving picture grows in, or spins in. On a cut it waits beneath the leaving one, and a spin fades it in meanwhile.
    if (!part.isOnCut) return { ...still, scale: moved, rotation: turn * (moved - 1) }
    return type === 'spin' ? { ...still, opacity: presence } : still
  } else if (type === 'circleReveal' || type === 'circleClose') {
    // A reveal opens a circle on the arriving picture; a close shuts one on the leaving picture.
    const isOpening = type === 'circleReveal'
    const radius = (Math.hypot(canvas.width, canvas.height) / 2) * (isOpening ? moved : 1 - moved)
    return { ...still, reveal: { kind: 'circle', x: canvas.width / 2, y: canvas.height / 2, radius, isInside: isArriving === isOpening } }
  } else if (wipeFrom !== undefined) {
    return { ...still, reveal: wipeReveal(wipeFrom, moved, isArriving, canvas) }
  }
  return still
}

function movedBy(transform: Transform, change: TransitionChange, canvas: Size): Transform {
  const angle = change.rotation * DEGREES_TO_RADIANS
  const cosine = Math.cos(angle)
  const sine = Math.sin(angle)
  const fromMiddleX = (transform.x - canvas.width / 2) * change.scale
  const fromMiddleY = (transform.y - canvas.height / 2) * change.scale
  return {
    x: canvas.width / 2 + fromMiddleX * cosine - fromMiddleY * sine + change.offsetX,
    y: canvas.height / 2 + fromMiddleX * sine + fromMiddleY * cosine + change.offsetY,
    scaleX: transform.scaleX * change.scale,
    scaleY: transform.scaleY * change.scale,
    rotation: transform.rotation + change.rotation,
  }
}

// The transition on the cut between two clips that touch on one track. It is the later clip's transition in.
function cutTransition(earlier: Clip | undefined, later: Clip | undefined): Transition | undefined {
  if (earlier === undefined || later === undefined || earlier.type === 'audio' || later.type === 'audio') return undefined
  return earlier.start + earlier.duration === later.start ? later.transitionIn : undefined
}

type Drawing = {
  project: Project
  media: MediaStates
  outputScale: number
}

// What the groups around a clip do to it at one moment. A member's place (x, y) is drawn at `(x, y) + scale * turned(member)`.
type Frame = {
  x: number
  y: number
  scale: number
  rotation: number
  opacity: number
  // The largest scale the groups reach while they are shown.
  largestScale: number
  // The effects of the groups, the innermost group's first.
  effects: readonly Effect[]
  // The tint and the wipe of a transition that a group around the clip is in.
  look: TransitionLook | undefined
  // Project time minus the time of the tracks inside.
  shift: number
  groups: readonly string[]
}

// How a group places its members on the canvas.
export type GroupFrame = Pick<Frame, 'x' | 'y' | 'scale' | 'rotation'>

const NO_FRAME: Frame = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, largestScale: 1, effects: [], look: undefined, shift: 0, groups: [] }

// Outside groups a transform is returned as it is, so nothing that was drawn before groups existed moves by a rounding.
export function onCanvas(frame: GroupFrame, transform: Transform): Transform {
  if (frame === NO_FRAME) return transform
  const angle = frame.rotation * DEGREES_TO_RADIANS
  const cosine = Math.cos(angle)
  const sine = Math.sin(angle)
  return {
    x: frame.x + frame.scale * (transform.x * cosine - transform.y * sine),
    y: frame.y + frame.scale * (transform.x * sine + transform.y * cosine),
    scaleX: transform.scaleX * frame.scale,
    scaleY: transform.scaleY * frame.scale,
    rotation: transform.rotation + frame.rotation,
  }
}

// The lengths of an effect are canvas pixels; inside a scaled group they scale with everything else.
export function scaledEffect(effect: Effect, factor: number): Effect {
  if (factor === 1) return effect
  if (effect.type === 'dropShadow') return { ...effect, offsetX: effect.offsetX * factor, offsetY: effect.offsetY * factor, softness: effect.softness * factor }
  if (effect.type === 'border') return { ...effect, width: effect.width * factor }
  if (effect.type === 'roundedCorners') return { ...effect, radius: effect.radius * factor }
  if (effect.type === 'clipBlur') return { ...effect, strength: effect.strength * factor }
  return effect
}

// The effects of a clip that are switched on, followed by those of the groups it is in.
function effectsOf(clip: { effects?: Effect[] }, frame: Frame): Effect[] {
  const effects: Effect[] = []
  for (const effect of clip.effects ?? []) {
    if (effect.isOff !== true) effects.push(scaledEffect(effect, frame.scale))
  }
  effects.push(...frame.effects)
  return effects
}

// The largest camera scale while a clip is on screen, the halves of the transitions on its cuts included.
// It decides how large the clip's video is decoded. It must not change from frame to frame, because an export opens each clip's decoder once.
function largestZoom(clip: VisualClip, track: Track, project: Project, shift: number): number {
  if (project.camera === undefined) return 1
  const end = clip.start + clip.duration
  const cutIn = cutTransition(track.clips.find((other) => other.start + other.duration === clip.start), clip)
  const cutOut = cutTransition(clip, track.clips.find((other) => other.start === end))
  const from = clip.start + shift - (cutIn?.duration ?? 0) / 2
  const to = end + shift + (cutOut?.duration ?? 0) / 2
  return largestScaleBetween(project.camera, from, to, project.canvas)
}

type Played = {
  part: TransitionPart
  mixKey: string | undefined
}

// Where a clip is and how strongly it is drawn at one moment, with its animations, its transition and the groups around it worked in.
type Placement = {
  transform: Transform
  placed: Transform | undefined
  opacity: number
  look: TransitionLook | undefined
  // The share of a text's letters a typewriter shows; undefined when all are shown.
  letters: number | undefined
}

function placementOf(clip: VisualClip, localTime: number, frame: Frame, canvas: Size, played: Played | undefined): Placement {
  const own = transformAt(clip, localTime)
  let opacity = opacityAt(clip, localTime) * frame.opacity
  let moved = own
  const animation = animationChangeAt(clip, localTime, canvas)
  if (animation !== undefined) {
    opacity *= animation.opacity
    moved = { ...own, x: own.x + animation.offsetX, y: own.y + animation.offsetY, scaleX: own.scaleX * animation.scale, scaleY: own.scaleY * animation.scale }
  }

  let drawn = onCanvas(frame, moved)
  let look = frame.look
  if (played !== undefined) {
    const change = transitionChange(played.part, canvas)
    opacity *= change.opacity
    drawn = movedBy(drawn, change, canvas)
    look = { tint: change.tint ?? frame.look?.tint, reveal: change.reveal ?? frame.look?.reveal, mixKey: played.mixKey }
  }
  const isMoved = animation !== undefined || played !== undefined
  return { transform: onCanvas(frame, own), placed: isMoved ? drawn : undefined, opacity, look, letters: animation?.letters }
}

// The frame for the members of a group: the group's place on the canvas is where their places are measured from.
function frameInside(group: GroupClip, frame: Frame, placement: Placement): Frame {
  const at = placement.placed ?? placement.transform
  const groupEffects: Effect[] = []
  for (const effect of group.effects ?? []) {
    if (effect.isOff !== true) groupEffects.push(scaledEffect(effect, frame.scale))
  }
  const { tint, reveal } = placement.look ?? {}
  return {
    x: at.x,
    y: at.y,
    scale: at.scaleX,
    rotation: at.rotation,
    opacity: placement.opacity,
    largestScale: frame.largestScale * largestValue(group.keyframes, 'scaleX', group.transform.scaleX) * largestAnimationScale(group),
    effects: [...groupEffects, ...frame.effects],
    look: tint === undefined && reveal === undefined ? undefined : { tint, reveal },
    shift: frame.shift + group.start - (group.contentStart ?? 0),
    groups: [...frame.groups, group.id],
  }
}

function textLookOf(clip: TextSettings): TextLook {
  const look: TextLook = { text: clip.text, font: clip.font, color: clip.color, align: clip.align }
  if (clip.outline !== undefined) look.outline = clip.outline
  if (clip.shadow !== undefined) look.shadow = clip.shadow
  if (clip.lineSpacing !== undefined) look.lineSpacing = clip.lineSpacing
  return look
}

function textClipLook(clip: TextClip): TextLook {
  const look = textLookOf(clip)
  if (clip.background !== undefined) look.background = clip.background
  if (clip.boxWidth !== undefined) look.boxWidth = clip.boxWidth
  return look
}

// The layers of one clip at a moment of its track's time: one, or those of its members when it is a group.
function layersOf(clip: VisualClip, track: Track, drawing: Drawing, frame: Frame, time: number, played: Played | undefined): Layer[] {
  const { project, media } = drawing
  const localTime = time - clip.start
  const placement = placementOf(clip, localTime, frame, project.canvas, played)

  if (clip.type === 'group') {
    const inside = frameInside(clip, frame, placement)
    const innerTime = localTime + (clip.contentStart ?? 0)
    const layers: Layer[] = []
    for (const innerTrack of clip.tracks) {
      if (!innerTrack.hidden) layers.push(...trackLayers(innerTrack, drawing, inside, innerTime))
    }
    return layers
  }

  const base: LayerBase = { clipId: clip.id, transform: placement.transform, opacity: placement.opacity }
  if (placement.placed !== undefined) base.placed = placement.placed
  if (placement.look !== undefined) base.transition = placement.look
  if (frame.groups.length > 0) base.groups = frame.groups

  if (clip.type === 'blur') {
    return [{ ...base, kind: 'blur', width: clip.width, height: clip.height, shape: clip.shape, softEdge: clip.softEdge * frame.scale, strength: clip.strength * frame.scale, isPixelated: clip.isPixelated === true }]
  } else if (clip.type === 'highlight') {
    return [{ ...base, kind: 'highlight', width: clip.width, height: clip.height, shape: clip.shape, softEdge: clip.softEdge * frame.scale, color: clip.color, isSpotlight: clip.isSpotlight === true }]
  }

  const effects = effectsOf(clip, frame)
  const picture: PictureLayerBase = effects.length === 0 ? base : { ...base, effects }
  const largestAnimated = largestAnimationScale(clip) * frame.largestScale
  if (clip.type === 'text' || clip.type === 'callout' || clip.type === 'arrow') {
    const drawn: DrawnLayerBase = {
      ...picture,
      sharpScaleX: largestValue(clip.keyframes, 'scaleX', clip.transform.scaleX) * largestAnimated,
      sharpScaleY: largestValue(clip.keyframes, 'scaleY', clip.transform.scaleY) * largestAnimated,
    }
    if (clip.type === 'arrow') {
      return [{ ...drawn, kind: 'arrow', look: { length: clip.length, thickness: clip.thickness, color: clip.color, startHead: clip.startHead, endHead: clip.endHead } }]
    }
    if (clip.type === 'callout') {
      const { width, height, shape, fill, borderColor, borderWidth, tail } = clip
      return [{ ...drawn, kind: 'callout', look: { width, height, shape, fill, borderColor, borderWidth, tail, text: textLookOf(clip) } }]
    }
    const text: TextLayer = { ...drawn, kind: 'text', look: textClipLook(clip) }
    if (placement.letters !== undefined) text.shownLetters = Math.floor(placement.letters * lettersOf(clip.text.replaceAll('\n', '')).length)
    return [text]
  }

  const state = media[clip.mediaId]
  if (state === undefined || 'error' in state) return []
  const info = state.info

  if (clip.type === 'image') {
    if (info.kind !== 'image') return []
    return [{ ...picture, kind: 'image', mediaId: clip.mediaId, width: info.width, height: info.height, crop: cropAt(clip, localTime) }]
  }

  if (info.kind !== 'video') return []
  return [
    {
      ...picture,
      kind: 'video',
      mediaId: clip.mediaId,
      video: info.video,
      // Before its start and past its end a clip goes on through its file where there is footage; the index stops at the first and the last frame, which is the held frame.
      frame: frameIndexAt(info.video, loopedTime(sourceTime(clip, time), info.duration, clip.loop === true)),
      halvings: sourceHalvings(info.video, clip, drawing.outputScale * largestZoom(clip, track, project, frame.shift) * largestAnimated),
      crop: cropAt(clip, localTime),
    },
  ]
}

// Two clips with a picture each can be added up by a transition; a blur, a highlight and a group cannot.
function hasPicture(clip: VisualClip): boolean {
  return clip.type !== 'blur' && clip.type !== 'highlight' && clip.type !== 'group'
}

// The two clips of a cut while its transition plays, the leaving one first.
function cutLayers(leaving: VisualClip, arriving: VisualClip, transition: Transition, progress: number, track: Track, drawing: Drawing, frame: Frame, time: number): Layer[] {
  const isSummed = SUMMED.includes(transition.type) && hasPicture(leaving) && hasPicture(arriving)
  const mixKey = isSummed ? arriving.id : undefined
  const layers: Layer[] = []
  const inDrawingOrder = LEAVING_ON_TOP.includes(transition.type) ? [arriving, leaving] : [leaving, arriving]
  for (const clip of inDrawingOrder) {
    const part: TransitionPart = { type: transition.type, progress, isArriving: clip === arriving, isOnCut: true }
    layers.push(...layersOf(clip, track, drawing, frame, time, { part, mixKey }))
  }
  return layers
}

// What a track shows at a moment of its time: the clip that is there, and with it its neighbour while the transition on their cut plays.
function trackLayers(track: Track, drawing: Drawing, frame: Frame, time: number): Layer[] {
  const shown = track.clips.find((clip) => time >= clip.start && time < clip.start + clip.duration)
  if (shown === undefined || shown.type === 'audio') return []

  const end = shown.start + shown.duration
  const previous = track.clips.find((clip) => clip.start + clip.duration === shown.start)
  const next = track.clips.find((clip) => clip.start === end)
  const cutIn = cutTransition(previous, shown)
  const cutOut = cutTransition(shown, next)
  const sinceStart = time - shown.start
  const untilEnd = end - time
  const isInCutIn = cutIn !== undefined && sinceStart < cutIn.duration / 2
  const isInCutOut = cutOut !== undefined && untilEnd <= cutOut.duration / 2
  // A clip shorter than its two transitions is in both at once; the nearer cut is the one that plays.
  const playsCutOut = isInCutOut && (!isInCutIn || untilEnd < sinceStart)
  if (playsCutOut && cutOut !== undefined && next !== undefined && next.type !== 'audio') {
    return cutLayers(shown, next, cutOut, (cutOut.duration / 2 - untilEnd) / cutOut.duration, track, drawing, frame, time)
  }
  if (isInCutIn && cutIn !== undefined && previous !== undefined && previous.type !== 'audio') {
    return cutLayers(previous, shown, cutIn, (cutIn.duration / 2 + sinceStart) / cutIn.duration, track, drawing, frame, time)
  }

  // A transition that sits on a cut is not also played at the edge of the clip.
  const out = cutOut === undefined ? shown.transitionOut : undefined
  const into = cutIn === undefined ? shown.transitionIn : undefined
  let part: TransitionPart | undefined
  if (out !== undefined && untilEnd <= out.duration) {
    part = { type: out.type, progress: (out.duration - untilEnd) / out.duration, isArriving: false, isOnCut: false }
  } else if (into !== undefined && sinceStart < into.duration) {
    part = { type: into.type, progress: sinceStart / into.duration, isArriving: true, isOnCut: false }
  }
  return layersOf(shown, track, drawing, frame, time, part === undefined ? undefined : { part, mixKey: undefined })
}

export function resolveFrame(project: Project, media: MediaStates, time: number, outputScale: number): Layer[] {
  const drawing: Drawing = { project, media, outputScale }
  const layers: Layer[] = []
  for (const track of project.tracks) {
    if (!track.hidden) layers.push(...trackLayers(track, drawing, NO_FRAME, time))
  }
  return layers
}

// A group around a clip, and how far the time of the track the group is on lies behind project time.
export type Enclosing = {
  group: GroupClip
  shift: number
}

// A clip that plays somewhere in a window of project time.
export type PlacedClip = {
  clip: Exclude<Clip, GroupClip>
  // Project time minus the time of the track the clip is on; 0 outside groups.
  shift: number
  // The part of the window in which the clip, and every group around it, plays.
  from: number
  to: number
  groups: readonly Enclosing[]
}

// Walks into groups: a member plays only while its group is there.
export function forEachPlacedClip(tracks: readonly Track[], window: { from: number; to: number }, isLeftOut: (track: Track) => boolean, visit: (placed: PlacedClip) => void, shift = 0, groups: readonly Enclosing[] = []): void {
  for (const track of tracks) {
    if (isLeftOut(track)) continue
    for (const clip of track.clips) {
      const from = Math.max(window.from, clip.start + shift)
      const to = Math.min(window.to, clip.start + clip.duration + shift)
      if (from >= to) continue
      if (clip.type === 'group') {
        forEachPlacedClip(clip.tracks, { from, to }, isLeftOut, visit, shift + clip.start - (clip.contentStart ?? 0), [...groups, { group: clip, shift }])
      } else {
        visit({ clip, shift, from, to, groups })
      }
    }
  }
}

// A clip that shows at most one of this many frames of its source gets a preview copy of only the frames it shows.
const SPARSE_FROM_FRAMES = 4

// Which frames of its source a clip shows at the frames of the project, when it skips enough of them to be worth a copy of its own.
function cadenceOf(clip: VideoClip, shift: number, video: VideoInfo, frameTicks: number): Cadence | undefined {
  if (clip.loop === true) return undefined
  const step = (frameTicks / TIMELINE_GRID) * clip.speedPercent
  if (step < SPARSE_FROM_FRAMES * video.frameDuration) return undefined
  // The source time the clip would show at project time 0: every frame it shows is a whole number of steps from there.
  const origin = sourceTime(clip, -shift) - video.startOffset
  return { step, phase: ((origin % step) + step) % step }
}

// The parts of video files the visible tracks show, and where in project time, so the media process prepares what is nearest the playhead first.
export function pictureRanges(project: Project, media: MediaStates): WantedRange[] {
  const found: WantedRange[] = []
  const frameTicks = frameDuration(project.canvas.frameRate)
  forEachPlacedClip(project.tracks, { from: 0, to: Infinity }, (track) => track.hidden, ({ clip, shift, from, to }) => {
    if (clip.type !== 'video') return
    const state = media[clip.mediaId]
    if (state === undefined || 'error' in state || state.info.kind !== 'video') return
    const range: WantedRange = { mediaId: clip.mediaId, use: 'picture', timelineStart: from, timelineEnd: to, sourceStart: sourceTime(clip, from - shift), speedPercent: clip.speedPercent, isLooping: clip.loop === true }
    const cadence = cadenceOf(clip, shift, state.info.video, frameTicks)
    if (cadence !== undefined) range.cadence = cadence
    found.push(range)
  })
  return found
}

// How the group reached by going into `groupIds` one after the other places its members at a moment of project time.
// The editor needs it to turn a place on the canvas into a place inside the group.
export function groupFrameAt(project: Project, groupIds: readonly string[], time: number): GroupFrame {
  let frame = NO_FRAME
  let tracks: readonly Track[] = project.tracks
  let trackTime = time
  for (const groupId of groupIds) {
    let group: GroupClip | undefined
    for (const track of tracks) {
      const found = track.clips.find((clip) => clip.id === groupId)
      if (found?.type === 'group') group = found
    }
    if (group === undefined) break
    const localTime = trackTime - group.start
    frame = frameInside(group, frame, placementOf(group, localTime, frame, project.canvas, undefined))
    trackTime = localTime + (group.contentStart ?? 0)
    tracks = group.tracks
  }
  return frame
}
