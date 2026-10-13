import type { Size } from '../shared/exportPresets.js'
import { minimumHalvings } from '../shared/limits.js'
import type { MediaState, VideoInfo } from '../shared/mediaProtocol.js'
import {
  ease,
  type AnimatableProperty,
  type Clip,
  type Crop,
  type Effect,
  type Keyframe,
  type Keyframes,
  type Project,
  type Shape,
  type TextAlign,
  type Track,
  type Transform,
  type Transition,
  type TransitionType,
  type VisualClip,
} from '../shared/project.js'
import { frameIndexAt, loopedTime, sourceTime } from '../shared/time.js'
import { largestScaleBetween } from './camera.js'

const MAX_HALVINGS = 6
const NO_CROP: Crop = { left: 0, top: 0, right: 0, bottom: 0 }
// How small the picture that zooms in starts, and how large the one that zooms out ends.
const ZOOM_IN_FROM = 0.5
const ZOOM_OUT_TO = 2
// Transitions whose two pictures are added up. Drawn one over the other, each at part strength, they would let what is beneath show through halfway.
const SUMMED: readonly TransitionType[] = ['crossDissolve', 'wipeLeft', 'wipeRight', 'wipeUp', 'wipeDown', 'zoom', 'circleReveal']

type Tint = {
  color: 'black' | 'white'
  amount: number
}

// The part of the canvas a layer shows in while a wipe or a circle passes over it, in canvas pixels.
type Reveal =
  // The side of the line through (x, y) that the normal points to.
  | { kind: 'line'; x: number; y: number; normalX: number; normalY: number }
  | { kind: 'circle'; x: number; y: number; radius: number; isInside: boolean }

// What a transition does to a layer at one moment, besides changing its opacity.
export type TransitionLook = {
  // Where the layer is drawn. The clip's own place stays in the layer's `transform`, which is what the editor's handles change.
  transform: Transform
  tint?: Tint
  reveal?: Reveal
  // Two layers next to each other with the same key are added up, then drawn as one.
  mixKey?: string
}

type LayerBase = {
  clipId: string
  transform: Transform
  opacity: number
  transition?: TransitionLook
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

export type TextLayer = PictureLayerBase & {
  kind: 'text'
  text: string
  family: string
  size: number
  color: string
  align: TextAlign
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

export type PictureLayer = VideoLayer | ImageLayer | TextLayer
export type Layer = PictureLayer | BlurLayer | HighlightLayer

export type MediaStates = Readonly<Record<string, MediaState>>

export function valueAt(keyframes: readonly Keyframe[], localTime: number): number | undefined {
  let previous: Keyframe | undefined
  for (const keyframe of keyframes) {
    if (keyframe.time > localTime) {
      if (previous === undefined) return keyframe.value
      const progress = (localTime - previous.time) / (keyframe.time - previous.time)
      return previous.value + (keyframe.value - previous.value) * ease(previous.easing, progress)
    }
    previous = keyframe
  }
  return previous?.value
}

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

// How a transition changes a layer: its opacity is multiplied, its place moved and scaled about the middle of the canvas.
export type TransitionChange = {
  opacity: number
  offsetX: number
  offsetY: number
  scale: number
  tint?: Tint
  reveal?: Reveal
}

type Wipe = 'wipeLeft' | 'wipeRight' | 'wipeUp' | 'wipeDown'

// Where the edge of a wipe is once it has come `moved` of its way, and the side the arriving picture is on.
function wipeEdge(type: Wipe, moved: number, canvas: Size): { x: number; y: number; normalX: number; normalY: number } {
  if (type === 'wipeLeft') {
    return { x: canvas.width * (1 - moved), y: 0, normalX: 1, normalY: 0 }
  } else if (type === 'wipeRight') {
    return { x: canvas.width * moved, y: 0, normalX: -1, normalY: 0 }
  } else if (type === 'wipeUp') {
    return { x: 0, y: canvas.height * (1 - moved), normalX: 0, normalY: 1 }
  } else {
    return { x: 0, y: canvas.height * moved, normalX: 0, normalY: -1 }
  }
}

// Everything is measured on the canvas, so the camera looks at a transition as at anything else.
export function transitionChange(part: TransitionPart, canvas: Size): TransitionChange {
  const { type, progress, isArriving } = part
  // How much of the layer is there: the arriving one grows from nothing, the leaving one shrinks to nothing.
  const presence = isArriving ? progress : 1 - progress
  const moved = ease('easeInOut', progress)
  const still = { opacity: 1, offsetX: 0, offsetY: 0, scale: 1 }

  if (type === 'crossDissolve') {
    return { ...still, opacity: presence }
  } else if (type === 'fadeBlack' || type === 'fadeWhite') {
    // One half of the time goes between the picture and the colour, the other between the colour and nothing.
    const tint: Tint = { color: type === 'fadeBlack' ? 'black' : 'white', amount: Math.min(1, 2 * (1 - presence)) }
    return { ...still, opacity: Math.min(1, 2 * presence), tint }
  } else if (type === 'slide' || type === 'push') {
    if (isArriving) return { ...still, offsetX: canvas.width * (1 - moved) }
    // On a cut the new picture slides over the old one, which stays where it is.
    const staysPut = type === 'slide' && part.isOnCut
    return staysPut ? still : { ...still, offsetX: -canvas.width * moved }
  } else if (type === 'zoom') {
    const scale = isArriving ? ZOOM_IN_FROM + (1 - ZOOM_IN_FROM) * moved : 1 + (ZOOM_OUT_TO - 1) * moved
    return { ...still, opacity: presence, scale }
  } else if (type === 'circleReveal') {
    const radius = (Math.hypot(canvas.width, canvas.height) / 2) * moved
    return { ...still, reveal: { kind: 'circle', x: canvas.width / 2, y: canvas.height / 2, radius, isInside: isArriving } }
  } else {
    const edge = wipeEdge(type, moved, canvas)
    const side = isArriving ? 1 : -1
    return { ...still, reveal: { kind: 'line', x: edge.x, y: edge.y, normalX: edge.normalX * side, normalY: edge.normalY * side } }
  }
}

function movedBy(transform: Transform, change: TransitionChange, canvas: Size): Transform {
  return {
    x: canvas.width / 2 + (transform.x - canvas.width / 2) * change.scale + change.offsetX,
    y: canvas.height / 2 + (transform.y - canvas.height / 2) * change.scale + change.offsetY,
    scaleX: transform.scaleX * change.scale,
    scaleY: transform.scaleY * change.scale,
    rotation: transform.rotation,
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
  time: number
  outputScale: number
}

// The largest camera scale while a clip is on screen, the halves of the transitions on its cuts included.
// It decides how large the clip's video is decoded. It must not change from frame to frame, because an export opens each clip's decoder once.
function largestZoom(clip: VisualClip, track: Track, project: Project): number {
  if (project.camera === undefined) return 1
  const end = clip.start + clip.duration
  const cutIn = cutTransition(track.clips.find((other) => other.start + other.duration === clip.start), clip)
  const cutOut = cutTransition(clip, track.clips.find((other) => other.start === end))
  const from = clip.start - (cutIn?.duration ?? 0) / 2
  const to = end + (cutOut?.duration ?? 0) / 2
  return largestScaleBetween(project.camera, from, to, project.canvas)
}

type Played = {
  part: TransitionPart
  mixKey: string | undefined
}

function layerOf(clip: VisualClip, track: Track, drawing: Drawing, played: Played | undefined): Layer | undefined {
  const { project, media, time } = drawing
  const localTime = time - clip.start
  const transform = transformAt(clip, localTime)
  const base: LayerBase = { clipId: clip.id, transform, opacity: opacityAt(clip, localTime) }
  if (played !== undefined) {
    const change = transitionChange(played.part, project.canvas)
    base.opacity *= change.opacity
    base.transition = { transform: movedBy(transform, change, project.canvas), tint: change.tint, reveal: change.reveal, mixKey: played.mixKey }
  }

  if (clip.type === 'blur') {
    return { ...base, kind: 'blur', width: clip.width, height: clip.height, shape: clip.shape, softEdge: clip.softEdge, strength: clip.strength, isPixelated: clip.isPixelated === true }
  } else if (clip.type === 'highlight') {
    return { ...base, kind: 'highlight', width: clip.width, height: clip.height, shape: clip.shape, softEdge: clip.softEdge, color: clip.color, isSpotlight: clip.isSpotlight === true }
  }

  const enabled = clip.effects?.filter((effect) => effect.isOff !== true)
  const picture: PictureLayerBase = enabled === undefined || enabled.length === 0 ? base : { ...base, effects: enabled }
  if (clip.type === 'text') {
    return { ...picture, kind: 'text', text: clip.text, family: clip.font.family, size: clip.font.size, color: clip.color, align: clip.align }
  }

  const state = media[clip.mediaId]
  if (state === undefined || 'error' in state) return undefined
  const info = state.info

  if (clip.type === 'image') {
    if (info.kind !== 'image') return undefined
    return { ...picture, kind: 'image', mediaId: clip.mediaId, width: info.width, height: info.height, crop: cropAt(clip, localTime) }
  }

  if (info.kind !== 'video') return undefined
  return {
    ...picture,
    kind: 'video',
    mediaId: clip.mediaId,
    video: info.video,
    // Before its start and past its end a clip goes on through its file where there is footage; the index stops at the first and the last frame, which is the held frame.
    frame: frameIndexAt(info.video, loopedTime(sourceTime(clip, time), info.duration, clip.loop === true)),
    halvings: sourceHalvings(info.video, clip, drawing.outputScale * largestZoom(clip, track, project)),
    crop: cropAt(clip, localTime),
  }
}

function hasPicture(clip: VisualClip): boolean {
  return clip.type !== 'blur' && clip.type !== 'highlight'
}

// The two clips of a cut while its transition plays, the leaving one first.
function cutLayers(leaving: VisualClip, arriving: VisualClip, transition: Transition, progress: number, track: Track, drawing: Drawing): Layer[] {
  const isSummed = SUMMED.includes(transition.type) && hasPicture(leaving) && hasPicture(arriving)
  const mixKey = isSummed ? arriving.id : undefined
  const layers: Layer[] = []
  for (const clip of [leaving, arriving]) {
    const part: TransitionPart = { type: transition.type, progress, isArriving: clip === arriving, isOnCut: true }
    const layer = layerOf(clip, track, drawing, { part, mixKey })
    if (layer !== undefined) layers.push(layer)
  }
  return layers
}

// What a track shows at a moment: the clip that is there, and with it its neighbour while the transition on their cut plays.
function trackLayers(track: Track, drawing: Drawing): Layer[] {
  const { time } = drawing
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
    return cutLayers(shown, next, cutOut, (cutOut.duration / 2 - untilEnd) / cutOut.duration, track, drawing)
  }
  if (isInCutIn && cutIn !== undefined && previous !== undefined && previous.type !== 'audio') {
    return cutLayers(previous, shown, cutIn, (cutIn.duration / 2 + sinceStart) / cutIn.duration, track, drawing)
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
  const layer = layerOf(shown, track, drawing, part === undefined ? undefined : { part, mixKey: undefined })
  return layer === undefined ? [] : [layer]
}

export function resolveFrame(project: Project, media: MediaStates, time: number, outputScale: number): Layer[] {
  const drawing: Drawing = { project, media, time, outputScale }
  const layers: Layer[] = []
  for (const track of project.tracks) {
    if (!track.hidden) layers.push(...trackLayers(track, drawing))
  }
  return layers
}
