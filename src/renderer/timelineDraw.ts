import { endOf, makesSound } from '../editor/clips.js'
import {
  CLIP_INSET,
  RULER_HEIGHT,
  TRACK_HEIGHT,
  clipBands,
  rulerStep,
  timeToX,
  trackTop,
  visibleRange,
  xToTime,
  type Band,
  type ClipIndex,
  type FadeHandle,
  type Marquee,
  type TimelineView,
} from '../editor/timelineView.js'
import type { MediaStates } from '../engine/resolve.js'
import type { Size } from '../shared/exportPresets.js'
import type { MediaInfo, Preparation, WaveformLevel } from '../shared/mediaProtocol.js'
import type { AudioClip, Clip, Project, Track, VideoClip } from '../shared/project.js'
import { TICKS_PER_SAMPLE, TICKS_PER_SECOND, frameDuration, frameIndexAt, loopedTime, sourceTime, timecode } from '../shared/time.js'
import type { Thumbnails } from './thumbnails.js'

const CLIP_RADIUS = 4
const LABEL_PADDING = 6
const LABEL_HEIGHT = 16
const MIN_WIDTH_FOR_LABEL = 28
const MIN_WIDTH_FOR_PICTURES = 40
const HIDDEN_TRACK_OPACITY = 0.4
const LABEL_BACKDROP_OPACITY = 0.55
const MARQUEE_FILL_OPACITY = 0.15
const SELECTION_WIDTH = 2
const TICK_HEIGHT = 6
const PLAYHEAD_HEAD = 5
const INT8_PEAK = 127
const RAMP_SHADE_OPACITY = 0.6
const HANDLE_RADIUS = 4.5
const HANDLE_LABEL_GAP = 9

export type TimelineColors = {
  background: string
  panel: string
  divider: string
  textPrimary: string
  textSecondary: string
  textOnPrimary: string
  primary: string
  snapGuide: string
  danger: string
  warning: string
  video: string
  audio: string
  image: string
  annotation: string
}

export type TimelineFonts = {
  label: string
  small: string
}

export type ContentScene = {
  project: Project
  mediaStates: MediaStates
  preparation: Readonly<Record<string, Preparation>>
  mediaNames: ReadonlyMap<string, string>
  selection: ReadonlySet<string>
  view: TimelineView
  size: Size
  colors: TimelineColors
  fonts: TimelineFonts
  inOrder: ClipIndex
  thumbnails: Thumbnails
}

export type OverlayScene = {
  view: TimelineView
  size: Size
  colors: TimelineColors
  fonts: TimelineFonts
  playhead: number
  guide: number | undefined
  marquee: Marquee | undefined
  // Fade handles of the clip under the pointer or being changed, and which of them is held.
  handles: readonly FadeHandle[]
  heldHandle: FadeHandle | undefined
  heldLabel: string
}

// The canvas cannot use CSS variables, so the design tokens are read once from the page.
export function readColors(element: Element): TimelineColors {
  const style = getComputedStyle(element)
  const token = (name: string): string => style.getPropertyValue(name).trim()
  return {
    background: token('--window-background'),
    panel: token('--panel-background'),
    divider: token('--divider'),
    textPrimary: token('--text-primary'),
    textSecondary: token('--text-secondary'),
    textOnPrimary: token('--text-on-primary'),
    primary: token('--primary'),
    snapGuide: token('--snap-guide'),
    danger: token('--danger'),
    warning: token('--warning'),
    video: token('--clip-video'),
    audio: token('--clip-audio'),
    image: token('--clip-image'),
    annotation: token('--clip-annotation'),
  }
}

export function readFonts(element: Element): TimelineFonts {
  const style = getComputedStyle(element)
  const family = style.getPropertyValue('--font-family').trim()
  return {
    label: `${style.getPropertyValue('--text-label').trim()} ${family}`,
    small: `${style.getPropertyValue('--text-small').trim()} ${family}`,
  }
}

type VideoMedia = Extract<MediaInfo, { kind: 'video' }>

function videoOf(clip: VideoClip, mediaStates: MediaStates): VideoMedia | undefined {
  const state = mediaStates[clip.mediaId]
  if (state === undefined || 'error' in state || state.info.kind !== 'video') return undefined
  return state.info
}

// An animated image is a moving clip, but to its user it is still an image.
function clipColor(clip: Clip, scene: ContentScene): string {
  const { colors } = scene
  if (clip.type === 'video') return videoOf(clip, scene.mediaStates)?.isAnimatedImage === true ? colors.image : colors.video
  if (clip.type === 'audio') return colors.audio
  if (clip.type === 'image') return colors.image
  return colors.annotation
}

function clipName(clip: Clip, mediaNames: ReadonlyMap<string, string>): string {
  if (clip.type === 'text') return clip.text.split('\n')[0] ?? ''
  return mediaNames.get(clip.mediaId) ?? clip.mediaId
}

function badgeOf(clip: Clip, scene: ContentScene): { text: string; color: string } | undefined {
  if (clip.type === 'text') return undefined
  const state = scene.mediaStates[clip.mediaId]
  if (state === undefined || ('error' in state && state.isMissing)) return { text: 'media missing', color: scene.colors.danger }
  if ('error' in state) return { text: 'media error', color: scene.colors.danger }
  const preparation = scene.preparation[clip.mediaId]
  if (preparation?.hasFailed === true) return { text: 'media error', color: scene.colors.danger }
  if (preparation !== undefined && preparation.progress < 1) return { text: 'preparing', color: scene.colors.warning }
  return undefined
}

// One small picture at the start of a video clip shows what it is. It scrolls away with the start of the clip.
function drawThumbnail(context: CanvasRenderingContext2D, clip: VideoClip, media: VideoMedia, scene: ContentScene, left: number, band: Band): void {
  const { video } = media
  const pictureWidth = Math.max(1, (band.height * video.width) / video.height)
  if (left + pictureWidth < 0) return
  const frame = frameIndexAt(video, loopedTime(clip.sourceStart, media.duration, clip.loop === true))
  const picture = scene.thumbnails.videoFrame(clip.mediaId, video, frame)
  if (picture !== undefined) context.drawImage(picture, left, band.top, pictureWidth, band.height)
}

function levelFor(levels: readonly WaveformLevel[], samplesPerPixel: number): WaveformLevel | undefined {
  let chosen = levels[0]
  for (const level of levels) {
    if (level.samplesPerBucket <= samplesPerPixel) chosen = level
  }
  return chosen
}

function drawWaveform(context: CanvasRenderingContext2D, clip: AudioClip | VideoClip, scene: ContentScene, top: number, height: number): void {
  const levels = scene.thumbnails.waveform(clip.mediaId)
  if (levels === undefined) return
  const { view } = scene
  const firstX = Math.max(0, Math.ceil(timeToX(clip.start, view)))
  const lastX = Math.min(scene.size.width, timeToX(endOf(clip), view))
  const samplesPerPixel = (sourceTime(clip, xToTime(1, view)) - sourceTime(clip, xToTime(0, view))) / TICKS_PER_SAMPLE
  const level = levelFor(levels, samplesPerPixel)
  if (level === undefined) return

  const middle = top + height / 2
  const reach = (height / 2 - 1) / INT8_PEAK
  const bucketCount = level.peaks.length / 2
  context.fillStyle = scene.colors.textPrimary
  for (let x = firstX; x < lastX; x++) {
    const firstSample = sourceTime(clip, xToTime(x, view)) / TICKS_PER_SAMPLE
    const firstBucket = Math.max(0, Math.floor(firstSample / level.samplesPerBucket))
    const endBucket = Math.min(bucketCount, Math.max(firstBucket + 1, Math.ceil((firstSample + samplesPerPixel) / level.samplesPerBucket)))
    let lowest = 0
    let highest = 0
    for (let bucket = firstBucket; bucket < endBucket; bucket++) {
      lowest = Math.min(lowest, level.peaks[bucket * 2] ?? 0)
      highest = Math.max(highest, level.peaks[bucket * 2 + 1] ?? 0)
    }
    context.fillRect(x, middle - highest * reach, 1, Math.max(1, (highest - lowest) * reach))
  }
}

function drawLabel(context: CanvasRenderingContext2D, clip: Clip, scene: ContentScene, left: number, top: number, width: number): void {
  const { colors, fonts } = scene
  const textLeft = Math.max(left, 0) + LABEL_PADDING
  const available = left + width - textLeft - LABEL_PADDING
  if (available < MIN_WIDTH_FOR_LABEL) return

  const opacity = context.globalAlpha
  context.globalAlpha = opacity * LABEL_BACKDROP_OPACITY
  context.fillStyle = colors.background
  context.fillRect(left, top, width, LABEL_HEIGHT)
  context.globalAlpha = opacity

  context.font = fonts.small
  context.textBaseline = 'middle'
  let textX = textLeft
  const badge = badgeOf(clip, scene)
  if (badge !== undefined) {
    const badgeWidth = context.measureText(badge.text).width + 2 * LABEL_PADDING
    context.fillStyle = badge.color
    context.fillRect(textX - LABEL_PADDING / 2, top + 1, badgeWidth, LABEL_HEIGHT - 2)
    context.fillStyle = colors.textOnPrimary
    context.fillText(badge.text, textX + LABEL_PADDING / 2, top + LABEL_HEIGHT / 2)
    textX += badgeWidth + LABEL_PADDING / 2
  }
  context.fillStyle = colors.textPrimary
  context.fillText(clipName(clip, scene.mediaNames), textX, top + LABEL_HEIGHT / 2, Math.max(0, left + width - textX - LABEL_PADDING))
}

// Shades what a fade takes away: a wedge that is widest at the clip edge and gone where the fade ends.
function drawRamp(context: CanvasRenderingContext2D, band: Band, edgeX: number, fade: number | undefined, direction: 1 | -1, scene: ContentScene): void {
  if (fade === undefined) return
  const endX = edgeX + direction * (fade / TICKS_PER_SECOND) * scene.view.pixelsPerSecond
  const opacity = context.globalAlpha
  context.beginPath()
  context.moveTo(edgeX, band.top)
  context.lineTo(endX, band.top)
  context.lineTo(edgeX, band.top + band.height)
  context.closePath()
  context.globalAlpha = opacity * RAMP_SHADE_OPACITY
  context.fillStyle = scene.colors.background
  context.fill()
  context.globalAlpha = opacity

  context.beginPath()
  context.moveTo(edgeX, band.top + band.height)
  context.lineTo(endX, band.top)
  context.strokeStyle = scene.colors.textPrimary
  context.lineWidth = 1
  context.stroke()
}

type ClipShape = {
  clip: Clip
  left: number
  top: number
  width: number
  height: number
  radius: number
  picture: Band | undefined
  sound: Band | undefined
}

function shapeOf(clip: Clip, scene: ContentScene, rowTop: number): ClipShape {
  const left = timeToX(clip.start, scene.view)
  const width = Math.max(1, timeToX(endOf(clip), scene.view) - left)
  const bands = clipBands(clip, makesSound(clip, scene.mediaStates), rowTop)
  return { clip, left, top: rowTop + CLIP_INSET, width, height: TRACK_HEIGHT - 2 * CLIP_INSET, radius: Math.min(CLIP_RADIUS, width / 2), ...bands }
}

function hasFades(clip: Clip): boolean {
  const pictureFades = clip.type !== 'audio' && (clip.fadeIn !== undefined || clip.fadeOut !== undefined)
  const soundFades = (clip.type === 'audio' || clip.type === 'video') && (clip.volumeFadeIn !== undefined || clip.volumeFadeOut !== undefined)
  return pictureFades || soundFades
}

// What is drawn inside a clip: its thumbnail, waveform, fade ramps and name. A clip too narrow for a name has none of the first two either.
function drawClipDetails(context: CanvasRenderingContext2D, shape: ClipShape, scene: ContentScene): void {
  const { clip, left, top, width, height, radius, picture, sound } = shape
  const isWide = width >= MIN_WIDTH_FOR_PICTURES
  if (!isWide && !hasFades(clip)) return

  context.save()
  context.beginPath()
  context.roundRect(left, top, width, height, radius)
  context.clip()
  if (isWide) {
    const media = clip.type === 'video' ? videoOf(clip, scene.mediaStates) : undefined
    if (clip.type === 'video' && media !== undefined && picture !== undefined) drawThumbnail(context, clip, media, scene, left, picture)
    // Media that is missing has no waveform to ask for.
    const state = clip.type === 'text' ? undefined : scene.mediaStates[clip.mediaId]
    const isAvailable = state !== undefined && 'info' in state
    if ((clip.type === 'audio' || clip.type === 'video') && sound !== undefined && isAvailable) drawWaveform(context, clip, scene, sound.top, sound.height)
  }
  if (clip.type !== 'audio' && picture !== undefined) {
    drawRamp(context, picture, left, clip.fadeIn, 1, scene)
    drawRamp(context, picture, left + width, clip.fadeOut, -1, scene)
  }
  if ((clip.type === 'audio' || clip.type === 'video') && sound !== undefined) {
    drawRamp(context, sound, left, clip.volumeFadeIn, 1, scene)
    drawRamp(context, sound, left + width, clip.volumeFadeOut, -1, scene)
  }
  drawLabel(context, clip, scene, left, top, width)
  context.restore()
}

function drawSelection(context: CanvasRenderingContext2D, shape: ClipShape, scene: ContentScene): void {
  context.strokeStyle = scene.colors.primary
  context.lineWidth = SELECTION_WIDTH
  context.beginPath()
  context.roundRect(shape.left + 1, shape.top + 1, Math.max(0, shape.width - 2), shape.height - 2, shape.radius)
  context.stroke()
}

// Thousands of clips can be in view at once, so their bodies are not drawn one by one: every body of one colour goes into one shape that is filled once.
function drawTrack(context: CanvasRenderingContext2D, track: Track, scene: ContentScene, rowTop: number): void {
  const { view, size, colors } = scene
  context.fillStyle = colors.divider
  context.fillRect(0, rowTop + TRACK_HEIGHT - 1, size.width, 1)

  const clips = scene.inOrder(track)
  const range = visibleRange(clips, xToTime(0, view), xToTime(size.width, view))
  const shapes: ClipShape[] = []
  const bodies = new Map<string, Path2D>()
  const soundBands = new Path2D()
  for (let index = range.first; index < range.end; index++) {
    const clip = clips[index]
    if (clip === undefined) continue
    const shape = shapeOf(clip, scene, rowTop)
    shapes.push(shape)
    const color = clipColor(clip, scene)
    const body = bodies.get(color) ?? new Path2D()
    bodies.set(color, body)
    body.roundRect(shape.left, shape.top, shape.width, shape.height, shape.radius)
    // The sound of a linked clip has the colour of an audio clip, under its picture.
    if (clip.type === 'video' && shape.sound !== undefined) soundBands.roundRect(shape.left, shape.sound.top, shape.width, shape.sound.height, [0, 0, shape.radius, shape.radius])
  }

  context.globalAlpha = track.hidden ? HIDDEN_TRACK_OPACITY : 1
  for (const [color, body] of bodies) {
    context.fillStyle = color
    context.fill(body)
  }
  context.fillStyle = colors.audio
  context.fill(soundBands)
  for (const shape of shapes) {
    drawClipDetails(context, shape, scene)
    if (scene.selection.has(shape.clip.id)) drawSelection(context, shape, scene)
  }
  context.globalAlpha = 1
}

function drawRuler(context: CanvasRenderingContext2D, scene: ContentScene): void {
  const { view, size, colors, fonts, project } = scene
  context.fillStyle = colors.panel
  context.fillRect(0, 0, size.width, RULER_HEIGHT)
  context.fillStyle = colors.divider
  context.fillRect(0, RULER_HEIGHT - 1, size.width, 1)

  const step = rulerStep(view.pixelsPerSecond, frameDuration(project.canvas.frameRate))
  const firstTime = Math.max(0, Math.floor(xToTime(0, view) / step) * step)
  const lastTime = xToTime(size.width, view)
  context.font = fonts.small
  context.textBaseline = 'middle'
  for (let time = firstTime; time <= lastTime; time += step) {
    const x = Math.round(timeToX(time, view))
    context.fillStyle = colors.divider
    context.fillRect(x, RULER_HEIGHT - TICK_HEIGHT, 1, TICK_HEIGHT)
    context.fillStyle = colors.textSecondary
    context.fillText(timecode(time, project.canvas.frameRate), x + 4, RULER_HEIGHT / 2 - 1)
  }
}

export function drawContent(context: CanvasRenderingContext2D, scene: ContentScene): void {
  const { project, view, size, colors } = scene
  context.fillStyle = colors.background
  context.fillRect(0, 0, size.width, size.height)
  for (const [trackIndex, track] of project.tracks.entries()) {
    const rowTop = trackTop(trackIndex, project.tracks.length, view)
    const isVisible = rowTop + TRACK_HEIGHT > RULER_HEIGHT && rowTop < size.height
    if (isVisible) drawTrack(context, track, scene, rowTop)
  }
  drawRuler(context, scene)
}

export function drawOverlay(context: CanvasRenderingContext2D, scene: OverlayScene): void {
  const { view, size, colors, marquee } = scene
  context.clearRect(0, 0, size.width, size.height)

  if (marquee !== undefined) {
    const width = marquee.right - marquee.left
    const height = marquee.bottom - marquee.top
    context.fillStyle = colors.primary
    context.globalAlpha = MARQUEE_FILL_OPACITY
    context.fillRect(marquee.left, marquee.top, width, height)
    context.globalAlpha = 1
    context.strokeStyle = colors.primary
    context.lineWidth = 1
    context.strokeRect(marquee.left + 0.5, marquee.top + 0.5, width, height)
  }

  if (scene.guide !== undefined) {
    context.fillStyle = colors.snapGuide
    context.fillRect(Math.round(timeToX(scene.guide, view)), RULER_HEIGHT, 1, size.height - RULER_HEIGHT)
  }

  for (const handle of scene.handles) {
    context.beginPath()
    context.arc(handle.x, handle.y, HANDLE_RADIUS, 0, 2 * Math.PI)
    context.fillStyle = handle === scene.heldHandle ? colors.primary : colors.textPrimary
    context.fill()
    context.strokeStyle = colors.background
    context.lineWidth = 1
    context.stroke()
  }
  if (scene.heldHandle !== undefined) {
    const { x, y } = scene.heldHandle
    context.font = scene.fonts.small
    context.textBaseline = 'middle'
    const labelWidth = context.measureText(scene.heldLabel).width
    // The length is written on the side of the handle that points into the clip, where there is room for it.
    const isFadeIn = scene.heldHandle.fade === 'fadeIn' || scene.heldHandle.fade === 'volumeFadeIn'
    const labelX = isFadeIn ? x + HANDLE_LABEL_GAP : x - HANDLE_LABEL_GAP - labelWidth
    context.fillStyle = colors.background
    context.fillRect(labelX - 3, y - 8, labelWidth + 6, 16)
    context.fillStyle = colors.textPrimary
    context.fillText(scene.heldLabel, labelX, y)
  }

  const playheadX = Math.round(timeToX(scene.playhead, view))
  context.fillStyle = colors.primary
  context.fillRect(playheadX, 0, 1, size.height)
  context.beginPath()
  context.moveTo(playheadX - PLAYHEAD_HEAD, 0)
  context.lineTo(playheadX + PLAYHEAD_HEAD + 1, 0)
  context.lineTo(playheadX + 0.5, 2 * PLAYHEAD_HEAD)
  context.closePath()
  context.fill()
}
