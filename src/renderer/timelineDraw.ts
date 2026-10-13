import { endOf } from '../editor/clips.js'
import { RULER_HEIGHT, TRACK_HEIGHT, rulerStep, timeToX, trackTop, visibleRange, xToTime, type ClipIndex, type Marquee, type TimelineView } from '../editor/timelineView.js'
import type { MediaStates } from '../engine/resolve.js'
import type { Size } from '../shared/exportPresets.js'
import type { Preparation, VideoInfo, WaveformLevel } from '../shared/mediaProtocol.js'
import type { AudioClip, Clip, Project, Track, VideoClip } from '../shared/project.js'
import { TICKS_PER_SAMPLE, frameDuration, frameIndexAt, sourceTime, timecode } from '../shared/time.js'
import type { Thumbnails } from './thumbnails.js'

const CLIP_INSET = 2
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
  playhead: number
  guide: number | undefined
  marquee: Marquee | undefined
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

function clipColor(clip: Clip, colors: TimelineColors): string {
  if (clip.type === 'video') return colors.video
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
  if (state === undefined || 'error' in state) return { text: 'media missing', color: scene.colors.danger }
  const preparation = scene.preparation[clip.mediaId]
  if (preparation?.hasFailed === true) return { text: 'media error', color: scene.colors.danger }
  if (preparation !== undefined && preparation.progress < 1) return { text: 'preparing', color: scene.colors.warning }
  return undefined
}

function videoOf(clip: VideoClip, mediaStates: MediaStates): VideoInfo | undefined {
  const state = mediaStates[clip.mediaId]
  if (state === undefined || 'error' in state || state.info.kind !== 'video') return undefined
  return state.info.video
}

// One small picture per tile, each showing the source frame at the tile's left edge.
function drawFilmstrip(context: CanvasRenderingContext2D, clip: VideoClip, video: VideoInfo, scene: ContentScene, left: number, top: number, height: number): void {
  const tileWidth = Math.max(1, (height * video.width) / video.height)
  const firstTile = Math.max(0, Math.floor(-left / tileWidth))
  const right = Math.min(timeToX(endOf(clip), scene.view), scene.size.width)
  for (let tile = firstTile; left + tile * tileWidth < right; tile++) {
    const x = left + tile * tileWidth
    const time = Math.max(clip.start, xToTime(x, scene.view))
    const frame = frameIndexAt(video, sourceTime(clip, time))
    const picture = scene.thumbnails.filmstripFrame(clip.mediaId, video, frame)
    if (picture !== undefined) context.drawImage(picture, x, top, tileWidth, height)
  }
}

function levelFor(levels: readonly WaveformLevel[], samplesPerPixel: number): WaveformLevel | undefined {
  let chosen = levels[0]
  for (const level of levels) {
    if (level.samplesPerBucket <= samplesPerPixel) chosen = level
  }
  return chosen
}

function drawWaveform(context: CanvasRenderingContext2D, clip: AudioClip, scene: ContentScene, top: number, height: number): void {
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

function drawClip(context: CanvasRenderingContext2D, clip: Clip, scene: ContentScene, rowTop: number): void {
  const left = timeToX(clip.start, scene.view)
  const width = Math.max(1, timeToX(endOf(clip), scene.view) - left)
  const top = rowTop + CLIP_INSET
  const height = TRACK_HEIGHT - 2 * CLIP_INSET

  context.save()
  context.beginPath()
  context.roundRect(left, top, width, height, Math.min(CLIP_RADIUS, width / 2))
  context.clip()
  context.fillStyle = clipColor(clip, scene.colors)
  context.fillRect(left, top, width, height)
  if (width >= MIN_WIDTH_FOR_PICTURES) {
    const video = clip.type === 'video' ? videoOf(clip, scene.mediaStates) : undefined
    if (clip.type === 'video' && video !== undefined) drawFilmstrip(context, clip, video, scene, left, top, height)
    if (clip.type === 'audio') drawWaveform(context, clip, scene, top, height)
  }
  drawLabel(context, clip, scene, left, top, width)
  context.restore()

  if (!scene.selection.has(clip.id)) return
  context.strokeStyle = scene.colors.primary
  context.lineWidth = SELECTION_WIDTH
  context.beginPath()
  context.roundRect(left + 1, top + 1, Math.max(0, width - 2), height - 2, Math.min(CLIP_RADIUS, width / 2))
  context.stroke()
}

function drawTrack(context: CanvasRenderingContext2D, track: Track, scene: ContentScene, rowTop: number): void {
  const { view, size, colors } = scene
  context.fillStyle = colors.divider
  context.fillRect(0, rowTop + TRACK_HEIGHT - 1, size.width, 1)

  const clips = scene.inOrder(track)
  const range = visibleRange(clips, xToTime(0, view), xToTime(size.width, view))
  context.globalAlpha = track.hidden ? HIDDEN_TRACK_OPACITY : 1
  for (let index = range.first; index < range.end; index++) {
    const clip = clips[index]
    if (clip !== undefined) drawClip(context, clip, scene, rowTop)
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
