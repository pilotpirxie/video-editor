import { CALLOUT_NAMES } from '../editor/annotations.js'
import { endOf, hasMedia, hasVolume, makesSound } from '../editor/clips.js'
import { takesEffects } from '../editor/effects.js'
import {
  CAMERA_LANE_HEIGHT,
  CLIP_INSET,
  RULER_HEIGHT,
  TRACKS_TOP,
  TRACK_HEIGHT,
  clipBands,
  keyframeDiamonds,
  rulerStep,
  timeToX,
  trackTop,
  transitionBands,
  visibleRange,
  volumeLineAt,
  volumePoints,
  xToTime,
  zoomBars,
  type Band,
  type ClipIndex,
  type FadeHandle,
  type Marquee,
  type TimelineView,
  type TransitionBand,
  type VolumePoint,
} from '../editor/timelineView.js'
import type { MediaStates } from '../engine/resolve.js'
import type { Size } from '../shared/exportPresets.js'
import type { MediaInfo, Preparation, WaveformLevel } from '../shared/mediaProtocol.js'
import type { AudioClip, Clip, GroupClip, Project, Track, VideoClip } from '../shared/project.js'
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
const WAVEFORM_BAR_STEP = 3
const WAVEFORM_BAR_WIDTH = 2
const RAMP_SHADE_OPACITY = 0.6
const HANDLE_RADIUS = 4.5
const HANDLE_LABEL_GAP = 9
const LANDING_FILL_OPACITY = 0.25
const LANDING_DASH = [6, 4]
const CHIP_PADDING = 3
const CHIP_HEIGHT = 16
const EFFECTS_MARK = 'fx'
const TRANSITION_SHADE_OPACITY = 0.45
const MIN_WIDTH_FOR_TRANSITION_LINES = 6
const GRIP_WIDTH = 4
const GRIP_HEIGHT = 16
const ZOOM_BAR_HEIGHT = 6
const ZOOM_BAR_OPACITY = 0.5
const ZOOM_DIAMOND = 5
const KEYFRAME_DIAMOND = 4
const VOLUME_LINE_WIDTH = 1.5
const VOLUME_POINT_RADIUS = 3
const OUTSIDE_GROUP_OPACITY = 0.6

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
  blur: string
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
  selectedZoom: number | undefined
  view: TimelineView
  size: Size
  colors: TimelineColors
  fonts: TimelineFonts
  inOrder: ClipIndex
  thumbnails: Thumbnails
  shown: { from: number; to: number } | undefined
}

export type DropTarget = {
  left: number
  right: number
  top: number
}

export type Landing = {
  start: number
  end: number
  trackIndex: number
  top: number
  isNewTrack: boolean
  guide: number | undefined
}

export type OverlayScene = {
  view: TimelineView
  size: Size
  colors: TimelineColors
  fonts: TimelineFonts
  playhead: number
  guide: number | undefined
  marquee: Marquee | undefined
  landing: Landing | undefined
  dropTarget: DropTarget | undefined
  handles: readonly FadeHandle[]
  heldHandle: FadeHandle | undefined
  grips: readonly TransitionBand[]
  heldGrip: TransitionBand | undefined
  heldPoint: VolumePoint | undefined
  heldLabel: string
}

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
    blur: token('--clip-blur'),
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

function clipColor(clip: Clip, scene: ContentScene): string {
  const { colors } = scene
  if (clip.type === 'video') return videoOf(clip, scene.mediaStates)?.isAnimatedImage === true ? colors.image : colors.video
  if (clip.type === 'audio') return colors.audio
  if (clip.type === 'image') return colors.image
  if (clip.type === 'blur' || clip.type === 'group') return colors.blur
  return colors.annotation
}

function memberCount(group: GroupClip): number {
  let count = 0
  for (const track of group.tracks) count += track.clips.length
  return count
}

function clipName(clip: Clip, mediaNames: ReadonlyMap<string, string>): string {
  if (clip.type === 'text') return clip.text.split('\n')[0] ?? ''
  if (clip.type === 'blur') return clip.isPixelated === true ? 'Pixelate' : 'Blur'
  if (clip.type === 'highlight') return clip.isSpotlight === true ? 'Spotlight' : 'Highlight'
  if (clip.type === 'callout') return clip.text.split('\n')[0] || CALLOUT_NAMES[clip.shape]
  if (clip.type === 'arrow') return clip.startHead === 'none' && clip.endHead === 'none' ? 'Line' : 'Arrow'
  if (clip.type === 'group') return `Group of ${memberCount(clip)}`
  return mediaNames.get(clip.mediaId) ?? clip.mediaId
}

function badgeOf(clip: Clip, scene: ContentScene): { text: string; color: string } | undefined {
  if (!hasMedia(clip)) return undefined
  const state = scene.mediaStates[clip.mediaId]
  if (state === undefined || ('error' in state && state.isMissing)) return { text: 'Media missing', color: scene.colors.danger }
  if ('error' in state) return { text: 'Media error', color: scene.colors.danger }
  const preparation = scene.preparation[clip.mediaId]
  if (preparation?.hasFailed === true) return { text: 'Media error', color: scene.colors.danger }
  if (preparation !== undefined && preparation.progress < 1) return { text: 'Preparing', color: scene.colors.warning }
  return undefined
}

function drawThumbnail(context: CanvasRenderingContext2D, clip: VideoClip, media: VideoMedia, scene: ContentScene, left: number, band: Band): void {
  const { video } = media
  const pictureWidth = Math.max(1, (band.height * video.width) / video.height)
  if (left + pictureWidth < 0) return
  const frame = frameIndexAt(video, loopedTime(clip.sourceStart, media.duration, clip.loop === true))
  const picture = scene.thumbnails.videoFrame(clip.mediaId, video, frame)
  if (picture !== undefined) context.drawImage(picture, left, band.top, pictureWidth, band.height)
}

function levelFor(levels: readonly WaveformLevel[], samplesPerBar: number): WaveformLevel | undefined {
  let chosen = levels[0]
  for (const level of levels) {
    if (level.samplesPerBucket <= samplesPerBar) chosen = level
  }
  return chosen
}

function drawWaveform(context: CanvasRenderingContext2D, clip: AudioClip | VideoClip, scene: ContentScene, top: number, height: number): void {
  const levels = scene.thumbnails.waveform(clip.mediaId)
  if (levels === undefined) return
  const { view } = scene
  const ticksPerBar = (WAVEFORM_BAR_STEP / view.pixelsPerSecond) * TICKS_PER_SECOND
  const samplesPerBar = (sourceTime(clip, ticksPerBar) - sourceTime(clip, 0)) / TICKS_PER_SAMPLE
  const level = levelFor(levels, samplesPerBar)
  if (level === undefined) return

  const scrolled = Math.round(view.scrollX)
  const firstBar = Math.ceil(Math.max(scrolled, timeToX(clip.start, view) + scrolled) / WAVEFORM_BAR_STEP)
  const endX = Math.min(scene.size.width, timeToX(endOf(clip), view))
  const middle = top + height / 2
  const reach = (height / 2 - 1) / INT8_PEAK
  const bucketCount = level.peaks.length / 2
  const bars = new Path2D()
  for (let bar = firstBar; bar * WAVEFORM_BAR_STEP - scrolled < endX; bar++) {
    const firstSample = sourceTime(clip, bar * ticksPerBar) / TICKS_PER_SAMPLE
    const firstBucket = Math.max(0, Math.floor(firstSample / level.samplesPerBucket))
    const endBucket = Math.min(bucketCount, Math.max(firstBucket + 1, Math.ceil((firstSample + samplesPerBar) / level.samplesPerBucket)))
    let lowest = 0
    let highest = 0
    for (let bucket = firstBucket; bucket < endBucket; bucket++) {
      lowest = Math.min(lowest, level.peaks[bucket * 2] ?? 0)
      highest = Math.max(highest, level.peaks[bucket * 2 + 1] ?? 0)
    }
    bars.rect(bar * WAVEFORM_BAR_STEP - scrolled, middle - highest * reach, WAVEFORM_BAR_WIDTH, Math.max(1, (highest - lowest) * reach))
  }
  context.fillStyle = scene.colors.textPrimary
  context.fill(bars)
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
  if (takesEffects(clip) && clip.effects !== undefined) {
    context.fillStyle = colors.textSecondary
    context.fillText(EFFECTS_MARK, textX, top + LABEL_HEIGHT / 2)
    textX += context.measureText(EFFECTS_MARK).width + LABEL_PADDING
  }
  context.fillStyle = colors.textPrimary
  context.fillText(clipName(clip, scene.mediaNames), textX, top + LABEL_HEIGHT / 2, Math.max(0, left + width - textX - LABEL_PADDING))
}

function drawTransitionBand(context: CanvasRenderingContext2D, band: TransitionBand, rowTop: number, scene: ContentScene): void {
  const top = rowTop + CLIP_INSET
  const height = TRACK_HEIGHT - 2 * CLIP_INSET
  const width = band.right - band.left
  const opacity = context.globalAlpha
  context.globalAlpha = opacity * TRANSITION_SHADE_OPACITY
  context.fillStyle = scene.colors.background
  context.fillRect(band.left, top, width, height)
  context.globalAlpha = opacity
  if (width < MIN_WIDTH_FOR_TRANSITION_LINES) return

  context.beginPath()
  context.moveTo(band.left, top)
  context.lineTo(band.right, top + height)
  context.moveTo(band.left, top + height)
  context.lineTo(band.right, top)
  context.strokeStyle = scene.colors.textPrimary
  context.lineWidth = 1
  context.stroke()
}

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
  const soundFades = hasVolume(clip) && (clip.volumeFadeIn !== undefined || clip.volumeFadeOut !== undefined)
  return pictureFades || soundFades
}

function drawVolumeLine(context: CanvasRenderingContext2D, shape: ClipShape, scene: ContentScene, rowTop: number): void {
  const { clip } = shape
  const makesSound = shape.sound !== undefined
  const points = volumePoints(clip, makesSound, scene.view, rowTop)
  const level = volumeLineAt(clip, makesSound, scene.view, rowTop, timeToX(clip.start, scene.view))?.y
  const firstY = points[0]?.y ?? level
  const lastY = points.at(-1)?.y ?? level
  if (firstY === undefined || lastY === undefined) return
  context.beginPath()
  context.moveTo(shape.left, firstY)
  for (const point of points) context.lineTo(point.x, point.y)
  context.lineTo(shape.left + shape.width, lastY)
  context.strokeStyle = scene.colors.primary
  context.lineWidth = VOLUME_LINE_WIDTH
  context.stroke()
  context.fillStyle = scene.colors.textPrimary
  for (const point of points) {
    context.beginPath()
    context.arc(point.x, point.y, VOLUME_POINT_RADIUS, 0, 2 * Math.PI)
    context.fill()
    context.stroke()
  }
}

function drawClipDetails(context: CanvasRenderingContext2D, shape: ClipShape, scene: ContentScene): void {
  const { clip, left, top, width, height, radius, picture, sound } = shape
  const isWide = width >= MIN_WIDTH_FOR_PICTURES
  if (!isWide && !hasFades(clip) && clip.keyframes?.volume === undefined) return

  context.save()
  context.beginPath()
  context.roundRect(left, top, width, height, radius)
  context.clip()
  if (isWide) {
    const media = clip.type === 'video' ? videoOf(clip, scene.mediaStates) : undefined
    if (clip.type === 'video' && media !== undefined && picture !== undefined) drawThumbnail(context, clip, media, scene, left, picture)
    const state = hasMedia(clip) ? scene.mediaStates[clip.mediaId] : undefined
    const isAvailable = state !== undefined && 'info' in state
    if ((clip.type === 'audio' || clip.type === 'video') && sound !== undefined && isAvailable) drawWaveform(context, clip, scene, sound.top, sound.height)
  }
  if (clip.type !== 'audio' && picture !== undefined) {
    drawRamp(context, picture, left, clip.fadeIn, 1, scene)
    drawRamp(context, picture, left + width, clip.fadeOut, -1, scene)
  }
  if (hasVolume(clip) && sound !== undefined) {
    drawRamp(context, sound, left, clip.volumeFadeIn, 1, scene)
    drawRamp(context, sound, left + width, clip.volumeFadeOut, -1, scene)
  }
  if (hasVolume(clip) && sound !== undefined) drawVolumeLine(context, shape, scene, top - CLIP_INSET)
  drawLabel(context, clip, scene, left, top, width)
  context.restore()
}

function traceDiamond(context: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  context.beginPath()
  context.moveTo(x, y - size)
  context.lineTo(x + size, y)
  context.lineTo(x, y + size)
  context.lineTo(x - size, y)
  context.closePath()
}

function drawKeyframeDiamonds(context: CanvasRenderingContext2D, shape: ClipShape, scene: ContentScene): void {
  context.fillStyle = scene.colors.textPrimary
  context.strokeStyle = scene.colors.background
  context.lineWidth = 1
  for (const diamond of keyframeDiamonds(shape.clip, shape.picture, scene.view)) {
    traceDiamond(context, diamond.x, diamond.y, KEYFRAME_DIAMOND)
    context.fill()
    context.stroke()
  }
}

function drawSelection(context: CanvasRenderingContext2D, shape: ClipShape, scene: ContentScene): void {
  context.strokeStyle = scene.colors.primary
  context.lineWidth = SELECTION_WIDTH
  context.beginPath()
  context.roundRect(shape.left + 1, shape.top + 1, Math.max(0, shape.width - 2), shape.height - 2, shape.radius)
  context.stroke()
}

function drawTrack(context: CanvasRenderingContext2D, track: Track, scene: ContentScene, rowTop: number): void {
  const { view, size, colors } = scene
  context.fillStyle = colors.divider
  context.fillRect(0, rowTop + TRACK_HEIGHT - 1, size.width, 1)

  const clips = scene.inOrder(track)
  const range = visibleRange(clips, xToTime(0, view), xToTime(size.width, view))
  const shapes: ClipShape[] = []
  const bodies = new Map<string, Path2D>()
  const soundBands = new Path2D()
  const bands: TransitionBand[] = []
  for (let index = range.first; index <= range.end; index++) {
    const clip = clips[index]
    if (clip === undefined) continue
    bands.push(...transitionBands(clip, clips[index - 1], clips[index + 1], view, rowTop))
    if (index === range.end) continue
    const shape = shapeOf(clip, scene, rowTop)
    shapes.push(shape)
    const color = clipColor(clip, scene)
    const body = bodies.get(color) ?? new Path2D()
    bodies.set(color, body)
    body.roundRect(shape.left, shape.top, shape.width, shape.height, shape.radius)
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
  for (const band of bands) drawTransitionBand(context, band, rowTop, scene)
  for (const shape of shapes) drawKeyframeDiamonds(context, shape, scene)
  context.globalAlpha = 1
}

function drawCameraLane(context: CanvasRenderingContext2D, scene: ContentScene): void {
  const { view, size, colors, project } = scene
  context.fillStyle = colors.panel
  context.fillRect(0, RULER_HEIGHT, size.width, CAMERA_LANE_HEIGHT)
  context.fillStyle = colors.divider
  context.fillRect(0, TRACKS_TOP - 1, size.width, 1)

  const middle = RULER_HEIGHT + CAMERA_LANE_HEIGHT / 2
  for (const bar of zoomBars(project.camera ?? [])) {
    const left = timeToX(bar.from, view)
    const right = timeToX(bar.to, view)
    if (right < -ZOOM_DIAMOND || left > size.width) continue
    context.fillStyle = bar.index === scene.selectedZoom ? colors.primary : colors.textSecondary
    context.globalAlpha = ZOOM_BAR_OPACITY
    context.fillRect(left, middle - ZOOM_BAR_HEIGHT / 2, right - left, ZOOM_BAR_HEIGHT)
    context.globalAlpha = 1
    traceDiamond(context, right, middle, ZOOM_DIAMOND)
    context.fill()
  }
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
    const isVisible = rowTop + TRACK_HEIGHT > TRACKS_TOP && rowTop < size.height
    if (isVisible) drawTrack(context, track, scene, rowTop)
  }
  if (scene.shown !== undefined) {
    const from = Math.max(0, timeToX(scene.shown.from, view))
    const to = Math.min(size.width, timeToX(scene.shown.to, view))
    context.globalAlpha = OUTSIDE_GROUP_OPACITY
    context.fillStyle = colors.background
    context.fillRect(0, TRACKS_TOP, from, size.height - TRACKS_TOP)
    context.fillRect(to, TRACKS_TOP, Math.max(0, size.width - to), size.height - TRACKS_TOP)
    context.globalAlpha = 1
  }
  drawRuler(context, scene)
  drawCameraLane(context, scene)
}

function drawChip(context: CanvasRenderingContext2D, scene: OverlayScene, text: string, left: number, middle: number): void {
  context.font = scene.fonts.small
  context.textBaseline = 'middle'
  const width = context.measureText(text).width
  context.fillStyle = scene.colors.background
  context.fillRect(left - CHIP_PADDING, middle - CHIP_HEIGHT / 2, width + 2 * CHIP_PADDING, CHIP_HEIGHT)
  context.fillStyle = scene.colors.textPrimary
  context.fillText(text, left, middle)
}

function drawLanding(context: CanvasRenderingContext2D, scene: OverlayScene, landing: Landing): void {
  const { view, colors } = scene
  const left = timeToX(landing.start, view)
  const width = Math.max(SELECTION_WIDTH, timeToX(landing.end, view) - left)
  const top = landing.top + CLIP_INSET
  const height = TRACK_HEIGHT - 2 * CLIP_INSET
  context.beginPath()
  context.roundRect(left + 1, top + 1, width - 2, height - 2, Math.min(CLIP_RADIUS, width / 2))
  context.fillStyle = colors.primary
  context.globalAlpha = LANDING_FILL_OPACITY
  context.fill()
  context.globalAlpha = 1
  context.strokeStyle = colors.primary
  context.lineWidth = SELECTION_WIDTH
  context.setLineDash(landing.isNewTrack ? LANDING_DASH : [])
  context.stroke()
  context.setLineDash([])
  if (landing.isNewTrack) drawChip(context, scene, 'New track', Math.max(left, 0) + LABEL_PADDING + CHIP_PADDING, top + height / 2)
}

export function drawOverlay(context: CanvasRenderingContext2D, scene: OverlayScene): void {
  const { view, size, colors, marquee } = scene
  context.clearRect(0, 0, size.width, size.height)

  if (scene.landing !== undefined) drawLanding(context, scene, scene.landing)

  if (scene.dropTarget !== undefined) {
    const { left, right, top } = scene.dropTarget
    context.strokeStyle = colors.primary
    context.lineWidth = SELECTION_WIDTH
    context.strokeRect(left + 1, top + CLIP_INSET + 1, Math.max(SELECTION_WIDTH, right - left - 2), TRACK_HEIGHT - 2 * CLIP_INSET - 2)
  }

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
  for (const grip of scene.grips) {
    context.beginPath()
    context.roundRect(grip.gripX - GRIP_WIDTH / 2, grip.gripY - GRIP_HEIGHT / 2, GRIP_WIDTH, GRIP_HEIGHT, GRIP_WIDTH / 2)
    context.fillStyle = grip === scene.heldGrip ? colors.primary : colors.textPrimary
    context.fill()
    context.strokeStyle = colors.background
    context.lineWidth = 1
    context.stroke()
  }
  if (scene.heldGrip !== undefined) {
    context.font = scene.fonts.small
    const labelWidth = context.measureText(scene.heldLabel).width
    const { gripX, gripY, edge } = scene.heldGrip
    drawChip(context, scene, scene.heldLabel, edge === 'in' ? gripX - HANDLE_LABEL_GAP - labelWidth : gripX + HANDLE_LABEL_GAP, gripY)
  }

  if (scene.heldPoint !== undefined) {
    const { x, y } = scene.heldPoint
    context.beginPath()
    context.arc(x, y, HANDLE_RADIUS, 0, 2 * Math.PI)
    context.fillStyle = colors.primary
    context.fill()
    context.font = scene.fonts.small
    drawChip(context, scene, scene.heldLabel, x + HANDLE_LABEL_GAP, y)
  }

  if (scene.heldHandle !== undefined) {
    const { x, y } = scene.heldHandle
    context.font = scene.fonts.small
    const labelWidth = context.measureText(scene.heldLabel).width
    const isFadeIn = scene.heldHandle.fade === 'fadeIn' || scene.heldHandle.fade === 'volumeFadeIn'
    drawChip(context, scene, scene.heldLabel, isFadeIn ? x + HANDLE_LABEL_GAP : x - HANDLE_LABEL_GAP - labelWidth, y)
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
