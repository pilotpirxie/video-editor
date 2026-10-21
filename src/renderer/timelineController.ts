import { ANNOTATION_NAMES, addAnnotation, type AnnotationKind } from '../editor/annotations.js'
import { moveZoom, setZoom } from '../editor/camera.js'
import { endOf, hasVolume, locateClip, makesSound, nextTrackName, type NewTrack } from '../editor/clips.js'
import { addEffect, takesEffect } from '../editor/effects.js'
import { moveClips, trimClip } from '../editor/moveTrim.js'
import { dropMedia, mediaFileName, placeableMedia } from '../editor/place.js'
import { changeKeyframe, keyframeFrame, setFade, setKeyframesAt, setProperties, type Fade } from '../editor/properties.js'
import { nearestWithin, snapDelta, timelineTargets } from '../editor/snapping.js'
import {
  RULER_HEIGHT,
  TRACKS_TOP,
  TRACK_HEIGHT,
  clipBands,
  clipsInMarquee,
  createClipIndex,
  fadeHandleAt,
  fadeHandles,
  fitZoom,
  hitClip,
  hitZoom,
  keyframeDiamondAt,
  keyframeDiamonds,
  timeToX,
  trackIndexAt,
  trackTop,
  transitionBandAt,
  transitionBands,
  volumeAtY,
  volumeChange,
  volumeLineAt,
  volumeLineNear,
  volumePointAt,
  volumePoints,
  xToTime,
  zoomAround,
  zoomBars,
  type Band,
  type ClipHit,
  type FadeHandle,
  type Marquee,
  type TimelineView,
  type TransitionBand,
  type VolumeLineSpot,
  type VolumePoint,
  type ZoomHit,
  type ZoomLimits,
} from '../editor/timelineView.js'
import { DEFAULT_TRANSITION, setTransition, transitionTargetAt, type TransitionTarget } from '../editor/transitions.js'
import type { Size } from '../shared/exportPresets.js'
import { projectDuration, type Clip, type EffectType, type MediaRef, type Project, type Track, type TransitionType } from '../shared/project.js'
import { stillDurationTicks } from '../shared/settings.js'
import { TICKS_PER_SECOND, frameDuration } from '../shared/time.js'
import type { Session } from './document.js'
import { drawContent, drawOverlay, readColors, readFonts, type DropTarget, type Landing } from './timelineDraw.js'

const DRAG_THRESHOLD = 3
const MIDDLE_BUTTON = 1
const WHEEL_ZOOM_RATE = 0.01
const FOLLOW_LEAD = 0.1
const SCROLL_PAST_END = 0.5
const START_PIXELS_PER_SECOND = 100
const FADE_LABEL_DECIMALS = 2
const PERCENT = 100

export type LibraryItem =
  | { kind: 'media'; mediaIds: readonly string[] }
  | { kind: 'effect'; effect: EffectType }
  | { kind: 'transition'; transition: TransitionType }
  | { kind: 'annotation'; annotation: AnnotationKind }

export const LIBRARY_DRAG_EVENT = 'library-drag'
export const LIBRARY_DROP_EVENT = 'library-drop'

export type LibraryDragDetail = {
  item: LibraryItem
  clientX: number
  clientY: number
}

const HELD_CLIP_ID = 'heldLibraryItem-media'
const HELD_TRACK: NewTrack = { id: 'heldLibraryItem-media-track', name: '' }

type Placement = {
  clipIds: string[]
  guide: number | undefined
  label: string
  place(project: Project): Project
}

type Point = {
  x: number
  y: number
}

export type MenuTarget = { kind: 'volume'; clipId: string; index: number } | { kind: 'zoom'; index: number }

type HeldDrop =
  | { kind: 'transition'; target: TransitionTarget; type: TransitionType; shown: DropTarget }
  | { kind: 'effect'; clipIds: readonly string[]; effect: EffectType; shown: DropTarget }

type Gesture =
  | { kind: 'scrub'; targets: number[] }
  | { kind: 'press'; hit: ClipHit; at: Point; wasSelected: boolean; hasModifier: boolean; keyframeTime: number | undefined }
  | { kind: 'zoom-press'; hit: ZoomHit; at: Point; time: number }
  | { kind: 'zoom'; hit: ZoomHit; edgeTime: number; zoomTime: number; grabOffset: number; targets: number[] }
  | { kind: 'transition'; target: TransitionTarget; type: TransitionType; anchor: number; isOnCut: boolean; grabOffset: number; targets: number[] }
  | { kind: 'move'; clipIds: readonly string[]; grabTime: number; grabbedRow: number; edges: number[]; targets: number[]; trackCount: number; newTrack: NewTrack }
  | { kind: 'trim'; clipId: string; edge: 'start' | 'end'; edgeTime: number; targets: number[] }
  | { kind: 'fade'; clipId: string; clipIds: readonly string[]; fade: Fade; clipStart: number; clipEnd: number; endTime: number; grabOffset: number; targets: number[] }
  | { kind: 'volume-point'; clipId: string; index: number; clipStart: number; pointTime: number; grabOffset: number; band: Band; targets: number[] }
  | { kind: 'volume-line'; clipId: string; indices: number[]; band: Band; from: Point }
  | { kind: 'marquee'; from: Point; kept: readonly string[] }
  | { kind: 'pan'; from: Point; scrollX: number; scrollY: number }

const EDITING_GESTURES: ReadonlySet<Gesture['kind']> = new Set(['move', 'trim', 'fade', 'zoom', 'transition', 'volume-point', 'volume-line'])

type ShownHandles = {
  handles: FadeHandle[]
  heldHandle: FadeHandle | undefined
  grips: TransitionBand[]
  heldGrip: TransitionBand | undefined
  heldPoint: VolumePoint | undefined
  heldLabel: string
}

export type TimelineElements = {
  host: HTMLElement
  content: HTMLCanvasElement
  overlay: HTMLCanvasElement
  headers: HTMLElement
  scrollbar: HTMLElement
  scrollSpan: HTMLElement
}

export type TimelineController = {
  zoomBy(factor: number): void
  zoomToFit(isNewTimeline?: boolean): void
  dispose(): void
}

class TimelineError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TimelineError'
  }
}

function contextOf(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext('2d')
  if (context === null) throw new TimelineError('The timeline cannot be drawn in this window')
  return context
}

export function isLibraryDrag(event: Event): event is CustomEvent<LibraryDragDetail> {
  return event instanceof CustomEvent && (event.type === LIBRARY_DRAG_EVENT || event.type === LIBRARY_DROP_EVENT)
}

export function createTimelineController(elements: TimelineElements, session: Session, openMenu: (at: Point, target: MenuTarget | undefined) => void): TimelineController {
  const { host, content, overlay, headers, scrollbar, scrollSpan } = elements
  const { store, transport, thumbnails, actions } = session
  const contentContext = contextOf(content)
  const overlayContext = contextOf(overlay)
  const colors = readColors(host)
  const fonts = readFonts(host)
  const inOrder = createClipIndex()

  let view: TimelineView = { pixelsPerSecond: START_PIXELS_PER_SECOND, scrollX: 0, scrollY: 0 }
  let size: Size = { width: 0, height: 0 }
  let gesture: Gesture | undefined
  let guide: number | undefined
  let heldLibraryItem: LibraryDragDetail | undefined
  let shownLanding = ''
  let shownDrop = ''
  let marquee: Marquee | undefined
  let isContentStale = true
  let isOverlayStale = true
  let isFrameRequested = false
  let isFitWanted = false
  let isLowestWanted = false
  let drawnTrackCount: number | undefined
  let shownScrollWidth = -1
  let shownScrollLeft = 0
  let wasPlaying = false
  let namedMedia: readonly MediaRef[] | undefined
  let mediaNames = new Map<string, string>()
  let selectedList: readonly string[] | undefined
  let selected = new Set<string>()
  let hoveredClipId: string | undefined

  function frameTicks(): number {
    return frameDuration(store.getState().project.canvas.frameRate)
  }

  function zoomLimits(project: Project): ZoomLimits {
    return { viewWidth: Math.max(1, size.width), duration: projectDuration(project), frameTicks: frameTicks() }
  }

  function maxScrollXOf(project: Project, pixelsPerSecond: number): number {
    const contentWidth = (projectDuration(project) / TICKS_PER_SECOND) * pixelsPerSecond
    return Math.max(0, contentWidth - size.width * SCROLL_PAST_END)
  }

  function withScrollInRange(next: TimelineView, project: Project): TimelineView {
    const maxScrollX = maxScrollXOf(project, next.pixelsPerSecond)
    const maxScrollY = Math.max(0, TRACKS_TOP + project.tracks.length * TRACK_HEIGHT - size.height)
    return {
      pixelsPerSecond: next.pixelsPerSecond,
      scrollX: Math.min(Math.max(0, next.scrollX), maxScrollX),
      scrollY: Math.min(Math.max(0, next.scrollY), maxScrollY),
    }
  }

  function draw(): void {
    isFrameRequested = false
    const state = store.getState()
    if (size.width === 0 || size.height === 0) return

    if (isContentStale) {
      isContentStale = false
      const trackCount = state.project.tracks.length
      const addedRows = drawnTrackCount === undefined || view.scrollY === 0 ? 0 : trackCount - drawnTrackCount
      drawnTrackCount = trackCount
      view = withScrollInRange({ ...view, scrollY: view.scrollY + addedRows * TRACK_HEIGHT }, state.project)
      if (namedMedia !== state.project.media) {
        namedMedia = state.project.media
        mediaNames = new Map(namedMedia.map((reference) => [reference.id, mediaFileName(reference)]))
      }
      if (selectedList !== state.selection) {
        selectedList = state.selection
        selected = new Set(selectedList)
      }
      drawContent(contentContext, {
        shown: state.scope,
        project: state.project,
        mediaStates: state.mediaStates,
        preparation: session.preparation(),
        mediaNames,
        selection: selected,
        selectedZoom: state.selectedZoom,
        view,
        size,
        colors,
        fonts,
        inOrder,
        thumbnails,
      })
      headers.style.transform = `translateY(${-view.scrollY}px)`
      showScroll(state.project)
      // Read by the UI tests.
      host.dataset.view = JSON.stringify(view)
      isOverlayStale = true
    }
    if (isOverlayStale) {
      isOverlayStale = false
      const landing = landingOfHeld()
      const drop = heldLibraryItem === undefined ? undefined : heldDropAt(heldLibraryItem)
      drawOverlay(overlayContext, { view, size, colors, fonts, playhead: transport.position().time, guide: landing?.guide ?? guide, marquee, landing, dropTarget: drop?.shown, ...shownHandles() })
      const landingText = landing === undefined ? '' : JSON.stringify(landing)
      if (landingText !== shownLanding) host.dataset.landing = landingText
      shownLanding = landingText
      const dropText = drop === undefined ? '' : JSON.stringify(drop)
      if (dropText !== shownDrop) host.dataset.drop = dropText
      shownDrop = dropText
    }
  }

  function pointIn(detail: LibraryDragDetail): Point {
    const box = overlay.getBoundingClientRect()
    return { x: detail.clientX - box.left, y: detail.clientY - box.top }
  }

  function heldDropAt(detail: LibraryDragDetail): HeldDrop | undefined {
    const { item } = detail
    if (item.kind === 'media' || item.kind === 'annotation') return undefined
    const { project, selection } = store.getState()
    const point = pointIn(detail)
    const trackCount = project.tracks.length
    if (item.kind === 'effect') {
      const hit = hitClip(project.tracks, inOrder, view, point.x, point.y)
      if (hit === undefined || hit.track.locked || !takesEffect(hit.clip, item.effect)) return undefined
      const clipIds = selection.includes(hit.clip.id) ? selection : [hit.clip.id]
      const shown = { left: timeToX(hit.clip.start, view), right: timeToX(endOf(hit.clip), view), top: trackTop(hit.trackIndex, trackCount, view) }
      return { kind: 'effect', clipIds, effect: item.effect, shown }
    }

    const trackIndex = trackIndexAt(point.y, trackCount, view)
    const target = point.y < TRACKS_TOP ? undefined : transitionTargetAt(project, trackIndex, xToTime(point.x, view))
    if (target === undefined) return undefined
    const after = setTransition(project, target, { type: item.transition, duration: DEFAULT_TRANSITION }, frameTicks())
    const located = locateClip(after, target.clipId)
    if (after === project || located === undefined) return undefined
    const rowTop = trackTop(located.trackIndex, trackCount, view)
    const band = bandsOf(located.track, located.clip, rowTop).find((candidate) => candidate.edge === target.edge)
    if (band === undefined) return undefined
    return { kind: 'transition', target, type: item.transition, shown: { left: band.left, right: band.right, top: rowTop } }
  }

  function placementAt(detail: LibraryDragDetail, newClipId: (index: number) => string, newTrack: NewTrack): Placement | undefined {
    const { item } = detail
    if (item.kind !== 'media' && item.kind !== 'annotation') return undefined
    const { project, mediaStates, isSnapping: snaps } = store.getState()
    const point = pointIn(detail)
    let start = Math.max(0, wholeFrames(xToTime(point.x, view)))
    let guide: number | undefined
    if (snaps) {
      const snap = snapDelta([start], 0, timelineTargets(project, new Set(), transport.position().time), snapRange())
      start += snap.delta
      guide = snap.guide
    }
    const trackIndex = Math.max(0, trackIndexAt(Math.max(point.y, TRACKS_TOP), project.tracks.length, view))
    const stillDuration = stillDurationTicks(store.getState().settings)
    if (item.kind === 'annotation') {
      const added = { clipId: newClipId(0), start, duration: stillDuration, trackIndex, newTrack }
      return { clipIds: [added.clipId], guide, label: `Add ${ANNOTATION_NAMES[item.annotation]}`, place: (current) => addAnnotation(current, item.annotation, added) }
    }
    const media = placeableMedia(project, mediaStates, item.mediaIds, newClipId)
    if (media.length === 0) return undefined
    const drop = { media, start, trackIndex, newTrack, stillDuration }
    const clipIds = media.map((dropped) => dropped.clipId)
    return { clipIds, guide, label: media.length === 1 ? 'Add Clip' : `Add ${media.length} Clips`, place: (current) => dropMedia(current, drop) }
  }

  function landingOfHeld(): Landing | undefined {
    const placement = heldLibraryItem === undefined ? undefined : placementAt(heldLibraryItem, (index) => `${HELD_CLIP_ID}-${index}`, HELD_TRACK)
    const firstId = placement?.clipIds[0]
    const lastId = placement?.clipIds.at(-1)
    if (placement === undefined || firstId === undefined || lastId === undefined) return undefined
    const { project } = store.getState()
    const after = placement.place(project)
    const first = locateClip(after, firstId)
    const last = locateClip(after, lastId)
    if (first === undefined || last === undefined) return undefined
    return {
      start: first.clip.start,
      end: endOf(last.clip),
      trackIndex: first.trackIndex,
      top: trackTop(first.trackIndex, after.tracks.length, view),
      isNewTrack: after.tracks.length > project.tracks.length,
      guide: placement.guide,
    }
  }

  function isFadeIn(fade: Fade): boolean {
    return fade === 'fadeIn' || fade === 'volumeFadeIn'
  }

  function fadeLength(fade: Fade, clipId: string): number {
    const clip = locateClip(store.getState().project, clipId)?.clip
    if (clip === undefined) return 0
    if (fade === 'fadeIn' || fade === 'fadeOut') return clip.type === 'audio' ? 0 : (clip[fade] ?? 0)
    return hasVolume(clip) ? (clip[fade] ?? 0) : 0
  }

  function secondsLabel(ticks: number): string {
    return `${(ticks / TICKS_PER_SECOND).toFixed(FADE_LABEL_DECIMALS)} s`
  }

  function shownHandles(): ShownHandles {
    const none: ShownHandles = { handles: [], heldHandle: undefined, grips: [], heldGrip: undefined, heldPoint: undefined, heldLabel: '' }
    if (gesture?.kind === 'volume-point') return { ...none, ...heldVolumePoint(gesture) }
    if (gesture?.kind === 'volume-line') return { ...none, ...heldVolumeLine(gesture) }
    const fading = gesture?.kind === 'fade' ? gesture : undefined
    const changing = gesture?.kind === 'transition' ? gesture : undefined
    const clipId = fading?.clipId ?? changing?.target.clipId ?? hoveredClipId
    if (clipId === undefined || (gesture !== undefined && fading === undefined && changing === undefined)) return none
    const { project, mediaStates } = store.getState()
    const shown = locateClip(project, clipId)
    if (shown === undefined || shown.track.locked) return none

    const rowTop = trackTop(shown.trackIndex, project.tracks.length, view)
    const handles = fadeHandles(shown.clip, makesSound(shown.clip, mediaStates), view, rowTop)
    const grips = bandsOf(shown.track, shown.clip, rowTop)
    if (changing !== undefined) {
      const heldGrip = grips.find((grip) => grip.edge === changing.target.edge)
      const span = heldGrip === undefined ? 0 : xToTime(heldGrip.right, view) - xToTime(heldGrip.left, view)
      return { ...none, grips, heldGrip, heldLabel: secondsLabel(span) }
    }
    if (fading === undefined) return { ...none, handles, grips }
    const heldHandle = handles.find((handle) => handle.fade === fading.fade)
    return { ...none, handles, heldHandle, heldLabel: secondsLabel(fadeLength(fading.fade, clipId)) }
  }

  function heldVolumePoint(dragging: Extract<Gesture, { kind: 'volume-point' }>): Pick<ShownHandles, 'heldPoint' | 'heldLabel'> {
    const { project, mediaStates } = store.getState()
    const shown = locateClip(project, dragging.clipId)
    const volume = shown?.clip.keyframes?.volume?.[dragging.index]?.value
    if (shown === undefined || volume === undefined) return { heldPoint: undefined, heldLabel: '' }
    const rowTop = trackTop(shown.trackIndex, project.tracks.length, view)
    const heldPoint = volumePoints(shown.clip, makesSound(shown.clip, mediaStates), view, rowTop)[dragging.index]
    return { heldPoint, heldLabel: `${Math.round(volume * PERCENT)}%` }
  }

  function heldVolumeLine(dragging: Extract<Gesture, { kind: 'volume-line' }>): Pick<ShownHandles, 'heldPoint' | 'heldLabel'> {
    const { project, mediaStates } = store.getState()
    const shown = locateClip(project, dragging.clipId)
    if (shown === undefined) return { heldPoint: undefined, heldLabel: '' }
    const rowTop = trackTop(shown.trackIndex, project.tracks.length, view)
    const spot = volumeLineAt(shown.clip, makesSound(shown.clip, mediaStates), view, rowTop, dragging.from.x)
    if (spot === undefined) return { heldPoint: undefined, heldLabel: '' }
    return { heldPoint: { index: -1, x: dragging.from.x, y: spot.y }, heldLabel: `${Math.round(volumeAtY(spot.band, spot.y) * PERCENT)}%` }
  }

  function volumeLineOn(hit: ClipHit, point: Point): VolumeLineSpot | undefined {
    const { project, mediaStates, selection } = store.getState()
    if (!selection.includes(hit.clip.id)) return undefined
    const rowTop = trackTop(hit.trackIndex, project.tracks.length, view)
    return volumeLineNear(hit.clip, makesSound(hit.clip, mediaStates), view, rowTop, point)
  }

  function startVolumeLine(hit: ClipHit, spot: VolumeLineSpot, at: Point): Gesture {
    store.begin('Change Volume')
    return { kind: 'volume-line', clipId: hit.clip.id, indices: spot.indices, band: spot.band, from: at }
  }

  function updateVolumeLine(dragging: Extract<Gesture, { kind: 'volume-line' }>, point: Point): void {
    const { clipId, indices, band, from } = dragging
    const change = volumeChange(band, from.y, point.y)
    store.update((project) => {
      const clip = locateClip(project, clipId)?.clip
      if (clip === undefined || !hasVolume(clip)) return project
      if (indices.length === 0) return setProperties(project, [clipId], { volume: clip.volume + change }, clip.start)
      let edited = project
      for (const index of indices) {
        const value = clip.keyframes?.volume?.[index]?.value
        if (value !== undefined) edited = changeKeyframe(edited, clipId, 'volume', index, { value: value + change })
      }
      return edited
    })
  }

  function volumePointOn(hit: ClipHit, point: Point): VolumePoint | undefined {
    const { project, mediaStates } = store.getState()
    const rowTop = trackTop(hit.trackIndex, project.tracks.length, view)
    return volumePointAt(volumePoints(hit.clip, makesSound(hit.clip, mediaStates), view, rowTop), point.x, point.y)
  }

  function startVolumePoint(hit: ClipHit, point: VolumePoint, at: Point): Gesture | undefined {
    const { project, selection, mediaStates } = store.getState()
    const { clip } = hit
    const keyframe = clip.keyframes?.volume?.[point.index]
    const rowTop = trackTop(hit.trackIndex, project.tracks.length, view)
    const band = clipBands(clip, makesSound(clip, mediaStates), rowTop).sound
    if (keyframe === undefined || band === undefined) return undefined
    if (!selection.includes(clip.id)) store.select([clip.id])
    const pointTime = clip.start + keyframe.time
    store.begin('Change Volume Keyframe')
    return {
      kind: 'volume-point',
      clipId: clip.id,
      index: point.index,
      clipStart: clip.start,
      pointTime,
      grabOffset: at.x - timeToX(pointTime, view),
      band,
      targets: timelineTargets(project, new Set(), transport.position().time),
    }
  }

  function updateVolumePoint(dragging: Extract<Gesture, { kind: 'volume-point' }>, event: PointerEvent, point: Point): void {
    const time = snappedTime(point.x - dragging.grabOffset, dragging.pointTime, dragging.targets, event) - dragging.clipStart
    const value = volumeAtY(dragging.band, point.y)
    const { clipId, index } = dragging
    store.update((project) => changeKeyframe(project, clipId, 'volume', index, { time, value }))
  }

  function bandsOf(track: Track, clip: Clip, rowTop: number): TransitionBand[] {
    if (clip.type === 'audio' || (clip.transitionIn === undefined && clip.transitionOut === undefined)) return []
    const ordered = inOrder(track)
    const index = ordered.indexOf(clip)
    return transitionBands(clip, ordered[index - 1], ordered[index + 1], view, rowTop)
  }

  function transitionGripOn(hit: ClipHit, point: Point): TransitionBand | undefined {
    const rowTop = trackTop(hit.trackIndex, store.getState().project.tracks.length, view)
    return transitionBandAt(bandsOf(hit.track, hit.clip, rowTop), point.x, point.y)
  }

  function keyframeDiamondOn(hit: ClipHit, point: Point): number | undefined {
    const { project, mediaStates } = store.getState()
    const rowTop = trackTop(hit.trackIndex, project.tracks.length, view)
    const picture = clipBands(hit.clip, makesSound(hit.clip, mediaStates), rowTop).picture
    return keyframeDiamondAt(keyframeDiamonds(hit.clip, picture, view), point.x, point.y)?.time
  }

  function fadeHandleOn(hit: ClipHit, point: Point): FadeHandle | undefined {
    const { project, mediaStates } = store.getState()
    const rowTop = trackTop(hit.trackIndex, project.tracks.length, view)
    return fadeHandleAt(fadeHandles(hit.clip, makesSound(hit.clip, mediaStates), view, rowTop), point.x, point.y)
  }

  function invalidate(layer: 'content' | 'overlay'): void {
    if (layer === 'content') isContentStale = true
    isOverlayStale = true
    if (isFrameRequested) return
    isFrameRequested = true
    requestAnimationFrame(draw)
  }

  function setView(next: TimelineView): void {
    view = withScrollInRange(next, store.getState().project)
    invalidate('content')
  }

  // Writes only what changed: setting the width forces a layout, setting scrollLeft fires a scroll event.
  function showScroll(project: Project): void {
    const scrollWidth = Math.round(maxScrollXOf(project, view.pixelsPerSecond) + size.width)
    if (scrollWidth !== shownScrollWidth) {
      shownScrollWidth = scrollWidth
      scrollSpan.style.width = `${scrollWidth}px`
    }
    if (Math.abs(shownScrollLeft - view.scrollX) < 1) return
    shownScrollLeft = view.scrollX
    scrollbar.scrollLeft = view.scrollX
  }

  function onScrollbar(): void {
    shownScrollLeft = scrollbar.scrollLeft
    if (Math.abs(shownScrollLeft - view.scrollX) < 1) return
    setView({ ...view, scrollX: shownScrollLeft })
  }

  function resize(): void {
    const box = host.getBoundingClientRect()
    size = { width: box.width, height: box.height }
    for (const canvas of [content, overlay]) {
      canvas.width = Math.round(box.width * devicePixelRatio)
      canvas.height = Math.round(box.height * devicePixelRatio)
    }
    contentContext.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0)
    overlayContext.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0)
    if (isFitWanted) zoomToFit()
    invalidate('content')
  }

  function zoomToFit(isNewTimeline = false): void {
    isLowestWanted ||= isNewTimeline
    isFitWanted = size.width === 0
    if (isFitWanted) return
    const { project } = store.getState()
    const scrollY = isLowestWanted ? Number.MAX_SAFE_INTEGER : view.scrollY
    isLowestWanted = false
    setView({ pixelsPerSecond: fitZoom(zoomLimits(project)), scrollX: 0, scrollY })
  }

  function pointOf(event: MouseEvent): Point {
    const box = overlay.getBoundingClientRect()
    return { x: event.clientX - box.left, y: event.clientY - box.top }
  }

  function wholeFrames(time: number): number {
    const ticks = frameTicks()
    return Math.round(time / ticks) * ticks
  }

  function snapRange(): number {
    return (store.getState().settings.snapRangePixels / view.pixelsPerSecond) * TICKS_PER_SECOND
  }

  function isSnapping(event: MouseEvent): boolean {
    return store.getState().isSnapping && !event.metaKey
  }

  function seekTo(point: Point, event: PointerEvent, targets: readonly number[]): void {
    const time = Math.max(0, xToTime(point.x, view))
    const snapped = isSnapping(event) ? nearestWithin(time, targets, snapRange()) : undefined
    transport.seek(snapped ?? time)
  }

  function startDrag(press: Extract<Gesture, { kind: 'press' }>): Gesture {
    const { project, selection } = store.getState()
    const playhead = transport.position().time
    const { clip, edge } = press.hit
    if (edge !== undefined) {
      store.begin('Trim Clip')
      const targets = timelineTargets(project, new Set([clip.id]), playhead)
      return { kind: 'trim', clipId: clip.id, edge, edgeTime: edge === 'start' ? clip.start : endOf(clip), targets }
    }

    const moving = new Set(selection)
    const edges: number[] = []
    for (const track of project.tracks) {
      for (const other of track.clips) {
        if (moving.has(other.id)) edges.push(other.start, endOf(other))
      }
    }
    store.begin(selection.length === 1 ? 'Move Clip' : 'Move Clips')
    return {
      kind: 'move',
      clipIds: selection,
      grabTime: xToTime(press.at.x, view),
      grabbedRow: locateClip(project, clip.id)?.trackIndex ?? press.hit.trackIndex,
      edges,
      targets: timelineTargets(project, moving, playhead),
      trackCount: project.tracks.length,
      newTrack: { id: crypto.randomUUID(), name: nextTrackName(project) },
    }
  }

  function startFade(hit: ClipHit, handle: FadeHandle, at: Point): Gesture {
    const { project, selection, mediaStates } = store.getState()
    const { clip } = hit
    const isSelected = selection.includes(clip.id)
    if (!isSelected) store.select([clip.id])
    const chosen = new Set(isSelected ? selection : [clip.id])
    const isVolumeFade = handle.fade === 'volumeFadeIn' || handle.fade === 'volumeFadeOut'
    const clipIds: string[] = []
    for (const track of project.tracks) {
      for (const other of track.clips) {
        if (chosen.has(other.id) && (!isVolumeFade || makesSound(other, mediaStates))) clipIds.push(other.id)
      }
    }

    const length = fadeLength(handle.fade, clip.id)
    const endTime = isFadeIn(handle.fade) ? clip.start + length : endOf(clip) - length
    store.begin('Change Fade')
    return {
      kind: 'fade',
      clipId: clip.id,
      clipIds,
      fade: handle.fade,
      clipStart: clip.start,
      clipEnd: endOf(clip),
      endTime,
      grabOffset: at.x - timeToX(endTime, view),
      targets: timelineTargets(project, new Set(), transport.position().time),
    }
  }

  function startTransition(hit: ClipHit, grip: TransitionBand, at: Point): Gesture | undefined {
    const { project, selection } = store.getState()
    const { clip } = hit
    if (clip.type === 'audio') return undefined
    const transition = grip.edge === 'in' ? clip.transitionIn : clip.transitionOut
    if (transition === undefined) return undefined
    if (!selection.includes(clip.id)) store.select([clip.id])
    store.begin('Change Transition')
    return {
      kind: 'transition',
      target: { clipId: clip.id, edge: grip.edge },
      type: transition.type,
      anchor: grip.edge === 'in' ? clip.start : endOf(clip),
      isOnCut: grip.isOnCut,
      grabOffset: at.x - grip.gripX,
      targets: timelineTargets(project, new Set(), transport.position().time),
    }
  }

  function updateTransition(changing: Extract<Gesture, { kind: 'transition' }>, event: PointerEvent, point: Point): void {
    const time = snappedTime(point.x - changing.grabOffset, changing.anchor, changing.targets, event)
    const reach = changing.target.edge === 'in' ? time - changing.anchor : changing.anchor - time
    const duration = changing.isOnCut ? 2 * reach : reach
    const { target, type } = changing
    const ticks = frameTicks()
    store.update((project) => setTransition(project, target, { type, duration }, ticks))
  }

  function startZoom(press: Extract<Gesture, { kind: 'zoom-press' }>): Gesture | undefined {
    const { project } = store.getState()
    const bar = zoomBars(project.camera ?? [])[press.hit.index]
    if (bar === undefined) return undefined
    const edgeTime = press.hit.part === 'start' ? bar.from : bar.to
    store.begin(press.hit.part === 'start' ? 'Change Zoom Length' : 'Move Zoom')
    return {
      kind: 'zoom',
      hit: press.hit,
      edgeTime,
      zoomTime: bar.to,
      grabOffset: press.at.x - timeToX(edgeTime, view),
      targets: timelineTargets(project, new Set(), transport.position().time),
    }
  }

  function updateZoom(zooming: Extract<Gesture, { kind: 'zoom' }>, event: PointerEvent, point: Point): void {
    const time = snappedTime(point.x - zooming.grabOffset, zooming.edgeTime, zooming.targets, event)
    const { hit, zoomTime } = zooming
    const ticks = frameTicks()
    if (hit.part === 'start') store.update((project) => setZoom(project, hit.index, { duration: zoomTime - time }, ticks))
    else store.update((project) => moveZoom(project, hit.index, time, ticks))
  }

  function snappedTime(x: number, edgeTime: number, targets: readonly number[], event: PointerEvent): number {
    const time = wholeFrames(xToTime(x, view))
    guide = undefined
    if (!isSnapping(event)) return time
    const snap = snapDelta([edgeTime], time - edgeTime, targets, snapRange())
    guide = snap.guide
    return edgeTime + snap.delta
  }

  function updateFade(fading: Extract<Gesture, { kind: 'fade' }>, event: PointerEvent, point: Point): void {
    let time = wholeFrames(xToTime(point.x - fading.grabOffset, view))
    guide = undefined
    if (isSnapping(event)) {
      const snap = snapDelta([fading.endTime], time - fading.endTime, fading.targets, snapRange())
      time = fading.endTime + snap.delta
      guide = snap.guide
    }
    const length = isFadeIn(fading.fade) ? time - fading.clipStart : fading.clipEnd - time
    const { clipIds, fade } = fading
    store.update((project) => setFade(project, clipIds, fade, length))
  }

  function updateMove(move: Extract<Gesture, { kind: 'move' }>, event: PointerEvent, point: Point): void {
    let deltaTime = wholeFrames(xToTime(point.x, view) - move.grabTime)
    guide = undefined
    if (isSnapping(event)) {
      const snap = snapDelta(move.edges, deltaTime, move.targets, snapRange())
      deltaTime = snap.delta
      guide = snap.guide
    }
    const row = Math.min(move.trackCount, Math.max(0, trackIndexAt(point.y, move.trackCount, view)))
    const trackShift = row - move.grabbedRow
    const { clipIds, newTrack } = move
    store.update((project) => moveClips(project, { clipIds, deltaTime, trackShift, isRipple: event.shiftKey, newTrack }))
  }

  function updateTrim(trim: Extract<Gesture, { kind: 'trim' }>, event: PointerEvent, point: Point): void {
    let time = wholeFrames(xToTime(point.x, view))
    guide = undefined
    if (isSnapping(event)) {
      const snap = snapDelta([trim.edgeTime], time - trim.edgeTime, trim.targets, snapRange())
      time = trim.edgeTime + snap.delta
      guide = snap.guide
    }
    const { clipId, edge } = trim
    const { mediaStates } = store.getState()
    const ticks = frameTicks()
    store.update((project) => trimClip(project, { clipId, edge, time, isRipple: event.shiftKey, frameTicks: ticks, mediaStates }))
  }

  function updateMarquee(drag: Extract<Gesture, { kind: 'marquee' }>, point: Point): void {
    marquee = {
      left: Math.min(drag.from.x, point.x),
      top: Math.min(drag.from.y, point.y),
      right: Math.max(drag.from.x, point.x),
      bottom: Math.max(drag.from.y, point.y),
    }
    const touched = clipsInMarquee(store.getState().project.tracks, inOrder, view, marquee)
    store.select([...new Set([...drag.kept, ...touched])])
  }

  function selectOnPress(hit: ClipHit, event: PointerEvent): void {
    const { selection } = store.getState()
    const id = hit.clip.id
    const isSelected = selection.includes(id)
    if (event.metaKey) {
      store.select(isSelected ? selection.filter((other) => other !== id) : [...selection, id])
    } else if (event.shiftKey) {
      if (!isSelected) store.select([...selection, id])
    } else if (!isSelected) {
      store.select([id])
    }
  }

  function onPointerDown(event: PointerEvent): void {
    if (event.button === MIDDLE_BUTTON) {
      event.preventDefault()
      overlay.setPointerCapture(event.pointerId)
      gesture = { kind: 'pan', from: { x: event.clientX, y: event.clientY }, scrollX: view.scrollX, scrollY: view.scrollY }
      overlay.style.cursor = 'grabbing'
      return
    }
    if (event.button !== 0) return
    overlay.setPointerCapture(event.pointerId)
    const at = pointOf(event)
    if (at.y < RULER_HEIGHT) {
      const targets = timelineTargets(store.getState().project, new Set(), 0)
      gesture = { kind: 'scrub', targets }
      seekTo(at, event, targets)
      return
    }
    if (at.y < TRACKS_TOP) {
      const camera = store.getState().project.camera ?? []
      const zoomHit = hitZoom(camera, view, at.x)
      store.selectZoom(zoomHit?.index)
      const zoom = zoomHit === undefined ? undefined : camera[zoomHit.index]
      if (zoomHit !== undefined && zoom !== undefined) gesture = { kind: 'zoom-press', hit: zoomHit, at, time: zoom.time }
      return
    }
    const hasModifier = event.shiftKey || event.metaKey
    const { project, selection } = store.getState()
    const hit = hitClip(project.tracks, inOrder, view, at.x, at.y)
    if (hit === undefined || hit.track.locked) {
      const kept = hasModifier ? selection : []
      if (!hasModifier) store.select([])
      gesture = { kind: 'marquee', from: at, kept }
      return
    }
    const grip = transitionGripOn(hit, at)
    const changing = grip === undefined ? undefined : startTransition(hit, grip, at)
    if (changing !== undefined) {
      gesture = changing
      invalidate('overlay')
      return
    }
    const volumePoint = volumePointOn(hit, at)
    const dragging = volumePoint === undefined ? undefined : startVolumePoint(hit, volumePoint, at)
    if (dragging !== undefined) {
      gesture = dragging
      overlay.style.cursor = 'grabbing'
      invalidate('overlay')
      return
    }
    const handle = fadeHandleOn(hit, at)
    if (handle !== undefined) {
      gesture = startFade(hit, handle, at)
      overlay.style.cursor = 'grabbing'
      invalidate('overlay')
      return
    }
    const volumeSpot = volumeLineOn(hit, at)
    if (volumeSpot !== undefined) {
      gesture = startVolumeLine(hit, volumeSpot, at)
      invalidate('overlay')
      return
    }
    const wasSelected = selection.includes(hit.clip.id)
    selectOnPress(hit, event)
    gesture = { kind: 'press', hit, at, wasSelected, hasModifier, keyframeTime: keyframeDiamondOn(hit, at) }
  }

  function showHover(point: Point | undefined): void {
    const { project } = store.getState()
    const found = point === undefined || point.y < TRACKS_TOP ? undefined : hitClip(project.tracks, inOrder, view, point.x, point.y)
    const hit = found === undefined || found.track.locked ? undefined : found
    const isOnLane = point !== undefined && point.y >= RULER_HEIGHT && point.y < TRACKS_TOP
    const zoomHit = isOnLane ? hitZoom(project.camera ?? [], view, point.x) : undefined
    let cursor = 'default'
    if (zoomHit !== undefined) cursor = zoomHit.part === 'start' ? 'ew-resize' : 'grab'
    else if (hit !== undefined && point !== undefined && transitionGripOn(hit, point) !== undefined) cursor = 'ew-resize'
    else if (hit !== undefined && point !== undefined && volumePointOn(hit, point) !== undefined) cursor = 'grab'
    else if (hit !== undefined && point !== undefined && fadeHandleOn(hit, point) !== undefined) cursor = 'grab'
    else if (hit !== undefined && point !== undefined && volumeLineOn(hit, point) !== undefined) cursor = 'ns-resize'
    else if (hit !== undefined && point !== undefined && keyframeDiamondOn(hit, point) !== undefined) cursor = 'pointer'
    else if (hit?.edge !== undefined) cursor = 'ew-resize'
    overlay.style.cursor = cursor

    if (hit?.clip.id === hoveredClipId) return
    hoveredClipId = hit?.clip.id
    invalidate('overlay')
  }

  function onPointerMove(event: PointerEvent): void {
    const point = pointOf(event)
    if (gesture === undefined) {
      showHover(point)
      return
    }
    if (gesture.kind === 'pan') {
      setView({ ...view, scrollX: gesture.scrollX - (event.clientX - gesture.from.x), scrollY: gesture.scrollY - (event.clientY - gesture.from.y) })
      return
    }
    if (gesture.kind === 'press') {
      const distance = Math.hypot(point.x - gesture.at.x, point.y - gesture.at.y)
      const canDrag = store.getState().selection.includes(gesture.hit.clip.id)
      if (distance < DRAG_THRESHOLD || !canDrag) return
      gesture = startDrag(gesture)
    }
    if (gesture.kind === 'zoom-press') {
      if (Math.abs(point.x - gesture.at.x) < DRAG_THRESHOLD) return
      gesture = startZoom(gesture)
      if (gesture === undefined) return
    }
    if (gesture.kind === 'scrub') {
      seekTo(point, event, gesture.targets)
    } else if (gesture.kind === 'zoom') {
      updateZoom(gesture, event, point)
    } else if (gesture.kind === 'transition') {
      updateTransition(gesture, event, point)
    } else if (gesture.kind === 'move') {
      updateMove(gesture, event, point)
    } else if (gesture.kind === 'trim') {
      updateTrim(gesture, event, point)
    } else if (gesture.kind === 'fade') {
      updateFade(gesture, event, point)
    } else if (gesture.kind === 'volume-point') {
      updateVolumePoint(gesture, event, point)
    } else if (gesture.kind === 'volume-line') {
      updateVolumeLine(gesture, point)
    } else if (gesture.kind === 'marquee') {
      updateMarquee(gesture, point)
    }
    invalidate('overlay')
  }

  function endGesture(finish: 'commit' | 'cancel'): void {
    const ended = gesture
    gesture = undefined
    guide = undefined
    marquee = undefined
    if (ended === undefined) return
    if (EDITING_GESTURES.has(ended.kind)) {
      if (finish === 'commit') store.commit()
      else store.cancel()
    }
    if (ended.kind === 'zoom-press' && finish === 'commit') {
      transport.pause()
      transport.seek(ended.time)
    }
    const isPlainClick = ended.kind === 'press' && ended.wasSelected && !ended.hasModifier && finish === 'commit'
    if (isPlainClick) store.select([ended.hit.clip.id])
    if (ended.kind === 'press' && ended.keyframeTime !== undefined && finish === 'commit') {
      const ticks = frameTicks()
      transport.pause()
      transport.seek(keyframeFrame(ended.hit.clip, ended.keyframeTime, ticks) * ticks)
    }
    invalidate('overlay')
  }

  function onWheel(event: WheelEvent): void {
    event.preventDefault()
    const { project } = store.getState()
    if (event.ctrlKey) {
      setView(zoomAround(view, Math.exp(-event.deltaY * WHEEL_ZOOM_RATE), pointOf(event).x, zoomLimits(project)))
      return
    }
    setView({ ...view, scrollX: view.scrollX + event.deltaX, scrollY: view.scrollY + event.deltaY })
  }

  function onContextMenu(event: MouseEvent): void {
    event.preventDefault()
    const point = pointOf(event)
    const at = { x: event.clientX, y: event.clientY }
    const { project, selection } = store.getState()
    if (point.y >= RULER_HEIGHT && point.y < TRACKS_TOP) {
      const zoomHit = hitZoom(project.camera ?? [], view, point.x)
      if (zoomHit === undefined) return
      store.selectZoom(zoomHit.index)
      openMenu(at, { kind: 'zoom', index: zoomHit.index })
      return
    }
    const hit = hitClip(project.tracks, inOrder, view, point.x, point.y)
    const isOpen = hit !== undefined && !hit.track.locked
    if (isOpen && !selection.includes(hit.clip.id)) store.select([hit.clip.id])
    const volumePoint = isOpen ? volumePointOn(hit, point) : undefined
    openMenu(at, volumePoint === undefined || hit === undefined ? undefined : { kind: 'volume', clipId: hit.clip.id, index: volumePoint.index })
  }

  function onDoubleClick(event: MouseEvent): void {
    const point = pointOf(event)
    const hit = hitClip(store.getState().project.tracks, inOrder, view, point.x, point.y)
    if (hit === undefined || hit.track.locked) return
    if (volumeLineOn(hit, point) !== undefined) {
      const ticks = frameTicks()
      const time = Math.round(xToTime(point.x, view) / ticks) * ticks
      store.apply('Add Volume Keyframe', (project) => setKeyframesAt(project, [hit.clip.id], 'volume', time, true))
      return
    }
    if (hit.clip.type !== 'group') return
    store.select([hit.clip.id])
    actions.openGroup()
  }

  function onLibraryDrag(event: Event): void {
    if (!isLibraryDrag(event)) return
    const isOverTimeline = event.target instanceof Node && host.contains(event.target)
    if (!isOverTimeline && heldLibraryItem === undefined) return
    heldLibraryItem = isOverTimeline ? event.detail : undefined
    invalidate('overlay')
  }

  function onLibraryDrop(event: Event): void {
    if (!isLibraryDrag(event)) return
    heldLibraryItem = undefined
    invalidate('overlay')
    const drop = heldDropAt(event.detail)
    if (drop?.kind === 'transition') {
      const ticks = frameTicks()
      store.apply('Add Transition', (current) => setTransition(current, drop.target, { type: drop.type, duration: DEFAULT_TRANSITION }, ticks))
      store.select([drop.target.clipId])
      return
    }
    if (drop?.kind === 'effect') {
      store.apply('Add Effect', (current) => addEffect(current, drop.clipIds, drop.effect))
      store.select(drop.clipIds)
      return
    }
    const placement = placementAt(event.detail, () => crypto.randomUUID(), { id: crypto.randomUUID(), name: nextTrackName(store.getState().project) })
    if (placement === undefined) return
    store.apply(placement.label, placement.place)
    store.select(placement.clipIds)
  }

  function followPlayhead(): void {
    const { isPlaying, time } = transport.position()
    if (isPlaying !== wasPlaying) {
      wasPlaying = isPlaying
      invalidate('content')
    }
    const x = timeToX(time, view)
    const isOutOfView = x < 0 || x > size.width
    if (isPlaying && isOutOfView) {
      setView({ ...view, scrollX: view.scrollX + x - size.width * FOLLOW_LEAD })
      return
    }
    invalidate('overlay')
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || gesture === undefined) return
    endGesture('cancel')
    event.preventDefault()
  }

  const cancel = (): void => endGesture('cancel')
  const commit = (): void => endGesture('commit')
  function onWindowBlur(): void {
    heldLibraryItem = undefined
    endGesture('cancel')
    invalidate('overlay')
  }
  const leave = (): void => showHover(undefined)
  const resizeObserver = new ResizeObserver(resize)
  resizeObserver.observe(host)
  const unsubscribe = [
    store.subscribe(() => invalidate('content')),
    thumbnails.subscribe(() => invalidate('content')),
    session.onPreparation(() => invalidate('content')),
    transport.subscribe(followPlayhead),
  ]
  overlay.addEventListener('pointerdown', onPointerDown)
  overlay.addEventListener('pointermove', onPointerMove)
  overlay.addEventListener('pointerup', commit)
  overlay.addEventListener('pointercancel', cancel)
  overlay.addEventListener('lostpointercapture', cancel)
  overlay.addEventListener('pointerleave', leave)
  overlay.addEventListener('wheel', onWheel, { passive: false })
  scrollbar.addEventListener('scroll', onScrollbar)
  overlay.addEventListener('contextmenu', onContextMenu)
  overlay.addEventListener('dblclick', onDoubleClick)
  host.addEventListener(LIBRARY_DROP_EVENT, onLibraryDrop)
  window.addEventListener(LIBRARY_DRAG_EVENT, onLibraryDrag)
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('blur', onWindowBlur)
  // A canvas the GPU process drew comes back blank, and without its scale, once that process has been restarted.
  content.addEventListener('contextrestored', resize)
  overlay.addEventListener('contextrestored', resize)

  return {
    zoomBy(factor) {
      const playheadX = timeToX(transport.position().time, view)
      const anchorX = playheadX >= 0 && playheadX <= size.width ? playheadX : size.width / 2
      setView(zoomAround(view, factor, anchorX, zoomLimits(store.getState().project)))
    },
    zoomToFit,
    dispose() {
      resizeObserver.disconnect()
      for (const stop of unsubscribe) stop()
      overlay.removeEventListener('pointerdown', onPointerDown)
      overlay.removeEventListener('pointermove', onPointerMove)
      overlay.removeEventListener('pointerup', commit)
      overlay.removeEventListener('pointercancel', cancel)
      overlay.removeEventListener('lostpointercapture', cancel)
      overlay.removeEventListener('pointerleave', leave)
      overlay.removeEventListener('wheel', onWheel)
      scrollbar.removeEventListener('scroll', onScrollbar)
      overlay.removeEventListener('contextmenu', onContextMenu)
      overlay.removeEventListener('dblclick', onDoubleClick)
      host.removeEventListener(LIBRARY_DROP_EVENT, onLibraryDrop)
      window.removeEventListener(LIBRARY_DRAG_EVENT, onLibraryDrag)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('blur', onWindowBlur)
      content.removeEventListener('contextrestored', resize)
      overlay.removeEventListener('contextrestored', resize)
    },
  }
}
