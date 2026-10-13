import { endOf, locateClip, makesSound, nextTrackName, type NewTrack } from '../editor/clips.js'
import { moveClips, trimClip } from '../editor/moveTrim.js'
import { dropMedia, mediaFileName } from '../editor/place.js'
import { setFade, type Fade } from '../editor/properties.js'
import { snapDelta, timelineTargets } from '../editor/snapping.js'
import {
  RULER_HEIGHT,
  TRACK_HEIGHT,
  clipsInMarquee,
  createClipIndex,
  fadeHandleAt,
  fadeHandles,
  fitZoom,
  hitClip,
  timeToX,
  trackIndexAt,
  trackTop,
  xToTime,
  zoomAround,
  type ClipHit,
  type FadeHandle,
  type Marquee,
  type TimelineView,
  type ZoomLimits,
} from '../editor/timelineView.js'
import type { Size } from '../shared/exportPresets.js'
import { projectDuration, type MediaRef, type Project } from '../shared/project.js'
import { TICKS_PER_SECOND, frameDuration } from '../shared/time.js'
import type { Session } from './document.js'
import { drawContent, drawOverlay, readColors, readFonts } from './timelineDraw.js'

const DRAG_THRESHOLD = 3
const SNAP_RANGE_PIXELS = 8
const WHEEL_ZOOM_RATE = 0.01
const FOLLOW_LEAD = 0.1
const SCROLL_PAST_END = 0.5
const START_PIXELS_PER_SECOND = 100
const FADE_LABEL_DECIMALS = 2

export const MEDIA_DROP_EVENT = 'media-drop'

export type MediaDropDetail = {
  mediaId: string
  clientX: number
  clientY: number
}

type Point = {
  x: number
  y: number
}

type Gesture =
  | { kind: 'scrub' }
  | { kind: 'press'; hit: ClipHit; at: Point; wasSelected: boolean; hasModifier: boolean }
  | { kind: 'move'; clipIds: readonly string[]; grabTime: number; edges: number[]; targets: number[]; trackCount: number; newTrack: NewTrack }
  | { kind: 'trim'; clipId: string; edge: 'start' | 'end'; edgeTime: number; targets: number[] }
  | { kind: 'fade'; clipId: string; clipIds: readonly string[]; fade: Fade; clipStart: number; clipEnd: number; endTime: number; grabOffset: number; targets: number[] }
  | { kind: 'marquee'; from: Point; kept: readonly string[] }

export type TimelineElements = {
  host: HTMLElement
  content: HTMLCanvasElement
  overlay: HTMLCanvasElement
  headers: HTMLElement
}

export type TimelineController = {
  zoomBy(factor: number): void
  zoomToFit(): void
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

export function isMediaDrop(event: Event): event is CustomEvent<MediaDropDetail> {
  return event instanceof CustomEvent && event.type === MEDIA_DROP_EVENT
}

// Draws the timeline and turns pointer input into commands. React only supplies the elements; nothing here re-renders components while dragging, scrolling or playing.
export function createTimelineController(elements: TimelineElements, session: Session, openMenu: (at: Point) => void): TimelineController {
  const { host, content, overlay, headers } = elements
  const { store, transport, thumbnails } = session
  const contentContext = contextOf(content)
  const overlayContext = contextOf(overlay)
  const colors = readColors(host)
  const fonts = readFonts(host)
  const inOrder = createClipIndex()

  let view: TimelineView = { pixelsPerSecond: START_PIXELS_PER_SECOND, scrollX: 0, scrollY: 0 }
  let size: Size = { width: 0, height: 0 }
  let gesture: Gesture | undefined
  let guide: number | undefined
  let marquee: Marquee | undefined
  let isContentStale = true
  let isOverlayStale = true
  let isFrameRequested = false
  let isFitWanted = false
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

  function withScrollInRange(next: TimelineView, project: Project): TimelineView {
    const contentWidth = (projectDuration(project) / TICKS_PER_SECOND) * next.pixelsPerSecond
    const maxScrollX = Math.max(0, contentWidth - size.width * SCROLL_PAST_END)
    const maxScrollY = Math.max(0, RULER_HEIGHT + project.tracks.length * TRACK_HEIGHT - size.height)
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
      view = withScrollInRange(view, state.project)
      if (namedMedia !== state.project.media) {
        namedMedia = state.project.media
        mediaNames = new Map(namedMedia.map((reference) => [reference.id, mediaFileName(reference)]))
      }
      if (selectedList !== state.selection) {
        selectedList = state.selection
        selected = new Set(selectedList)
      }
      drawContent(contentContext, {
        project: state.project,
        mediaStates: state.mediaStates,
        preparation: session.preparation(),
        mediaNames,
        selection: selected,
        view,
        size,
        colors,
        fonts,
        inOrder,
        thumbnails,
      })
      headers.style.transform = `translateY(${-view.scrollY}px)`
      // Tests read this to find where a time and a track are on screen.
      host.dataset.view = JSON.stringify(view)
      isOverlayStale = true
    }
    if (isOverlayStale) {
      isOverlayStale = false
      drawOverlay(overlayContext, { view, size, colors, fonts, playhead: transport.position().time, guide, marquee, ...shownHandles() })
    }
  }

  function isFadeIn(fade: Fade): boolean {
    return fade === 'fadeIn' || fade === 'volumeFadeIn'
  }

  function fadeLength(fade: Fade, clipId: string): number {
    const clip = locateClip(store.getState().project, clipId)?.clip
    if (clip === undefined) return 0
    if (fade === 'fadeIn' || fade === 'fadeOut') return clip.type === 'audio' ? 0 : (clip[fade] ?? 0)
    return clip.type === 'audio' || clip.type === 'video' ? (clip[fade] ?? 0) : 0
  }

  // The fade handles are shown for one clip at a time: the one being changed, or else the one under the pointer.
  function shownHandles(): { handles: FadeHandle[]; heldHandle: FadeHandle | undefined; heldLabel: string } {
    const none = { handles: [], heldHandle: undefined, heldLabel: '' }
    const fading = gesture?.kind === 'fade' ? gesture : undefined
    const clipId = fading?.clipId ?? hoveredClipId
    if (clipId === undefined || (gesture !== undefined && fading === undefined)) return none
    const { project, mediaStates } = store.getState()
    const shown = locateClip(project, clipId)
    if (shown === undefined || shown.track.locked) return none

    const rowTop = trackTop(shown.trackIndex, project.tracks.length, view)
    const handles = fadeHandles(shown.clip, makesSound(shown.clip, mediaStates), view, rowTop)
    if (fading === undefined) return { handles, heldHandle: undefined, heldLabel: '' }
    const heldHandle = handles.find((handle) => handle.fade === fading.fade)
    const seconds = fadeLength(fading.fade, clipId) / TICKS_PER_SECOND
    return { handles, heldHandle, heldLabel: `${seconds.toFixed(FADE_LABEL_DECIMALS)} s` }
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

  // Before the timeline has a width there is nothing to fit into, so the request waits for the first layout.
  function zoomToFit(): void {
    isFitWanted = size.width === 0
    if (isFitWanted) return
    const { project } = store.getState()
    setView({ pixelsPerSecond: fitZoom(zoomLimits(project)), scrollX: 0, scrollY: view.scrollY })
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
    return (SNAP_RANGE_PIXELS / view.pixelsPerSecond) * TICKS_PER_SECOND
  }

  function isSnapping(event: MouseEvent): boolean {
    return store.getState().isSnapping && !event.metaKey
  }

  function seekTo(point: Point): void {
    transport.seek(Math.max(0, xToTime(point.x, view)))
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
      edges,
      targets: timelineTargets(project, moving, playhead),
      trackCount: project.tracks.length,
      newTrack: { id: crypto.randomUUID(), name: nextTrackName(project) },
    }
  }

  // A handle of a selected clip changes the fade of every selected clip that has that kind of fade.
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
      // The handle is drawn a little inside the clip when the fade is short; the fade end still follows the pointer one to one from where it was.
      grabOffset: at.x - timeToX(endTime, view),
      targets: timelineTargets(project, new Set(), transport.position().time),
    }
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
    // Rows are counted in the project as it was when the drag began: a track created by this very drag must not shift the rows under the pointer.
    const row = Math.min(move.trackCount, Math.max(0, trackIndexAt(point.y, move.trackCount, view)))
    const targetTrackIndex = move.clipIds.length === 1 ? row : undefined
    const { clipIds, newTrack } = move
    store.update((project) => moveClips(project, { clipIds, deltaTime, targetTrackIndex, isRipple: event.shiftKey, newTrack }))
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
    if (event.button !== 0) return
    overlay.setPointerCapture(event.pointerId)
    const at = pointOf(event)
    if (at.y < RULER_HEIGHT) {
      gesture = { kind: 'scrub' }
      seekTo(at)
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
    const handle = fadeHandleOn(hit, at)
    if (handle !== undefined) {
      gesture = startFade(hit, handle, at)
      overlay.style.cursor = 'grabbing'
      invalidate('overlay')
      return
    }
    const wasSelected = selection.includes(hit.clip.id)
    selectOnPress(hit, event)
    gesture = { kind: 'press', hit, at, wasSelected, hasModifier }
  }

  // The cursor says what a press here would do, and the clip under it shows its fade handles.
  function showHover(point: Point | undefined): void {
    const { project } = store.getState()
    const found = point === undefined || point.y < RULER_HEIGHT ? undefined : hitClip(project.tracks, inOrder, view, point.x, point.y)
    const hit = found === undefined || found.track.locked ? undefined : found
    let cursor = 'default'
    if (hit !== undefined && point !== undefined && fadeHandleOn(hit, point) !== undefined) cursor = 'grab'
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
    if (gesture.kind === 'press') {
      const distance = Math.hypot(point.x - gesture.at.x, point.y - gesture.at.y)
      const canDrag = store.getState().selection.includes(gesture.hit.clip.id)
      if (distance < DRAG_THRESHOLD || !canDrag) return
      gesture = startDrag(gesture)
    }
    if (gesture.kind === 'scrub') {
      seekTo(point)
    } else if (gesture.kind === 'move') {
      updateMove(gesture, event, point)
    } else if (gesture.kind === 'trim') {
      updateTrim(gesture, event, point)
    } else if (gesture.kind === 'fade') {
      updateFade(gesture, event, point)
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
    if (ended.kind === 'move' || ended.kind === 'trim' || ended.kind === 'fade') {
      if (finish === 'commit') store.commit()
      else store.cancel()
    }
    // A plain click on one clip of a larger selection narrows the selection to that clip.
    const isPlainClick = ended.kind === 'press' && ended.wasSelected && !ended.hasModifier && finish === 'commit'
    if (isPlainClick) store.select([ended.hit.clip.id])
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
    const { project, selection } = store.getState()
    const hit = hitClip(project.tracks, inOrder, view, point.x, point.y)
    if (hit !== undefined && !hit.track.locked && !selection.includes(hit.clip.id)) store.select([hit.clip.id])
    openMenu({ x: event.clientX, y: event.clientY })
  }

  function onMediaDrop(event: Event): void {
    if (!isMediaDrop(event)) return
    const { project, mediaStates, isSnapping: snaps } = store.getState()
    const { mediaId } = event.detail
    const reference = project.media.find((candidate) => candidate.id === mediaId)
    const state = mediaStates[mediaId]
    if (reference === undefined || state === undefined || 'error' in state) return

    const box = overlay.getBoundingClientRect()
    const point = { x: event.detail.clientX - box.left, y: event.detail.clientY - box.top }
    let start = Math.max(0, wholeFrames(xToTime(point.x, view)))
    if (snaps) {
      const snap = snapDelta([start], 0, timelineTargets(project, new Set(), transport.position().time), snapRange())
      start += snap.delta
    }
    const clipId = crypto.randomUUID()
    const newTrack = { id: crypto.randomUUID(), name: nextTrackName(project) }
    const trackIndex = Math.max(0, trackIndexAt(Math.max(point.y, RULER_HEIGHT), project.tracks.length, view))
    store.apply('Add Clip', (current) => dropMedia(current, { reference, info: state.info, clipId, start, trackIndex, newTrack }))
    store.select([clipId])
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

  // Marks the key as handled, so Escape during a drag does not also clear the selection.
  function onKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || gesture === undefined) return
    endGesture('cancel')
    event.preventDefault()
  }

  const cancel = (): void => endGesture('cancel')
  const commit = (): void => endGesture('commit')
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
  overlay.addEventListener('contextmenu', onContextMenu)
  host.addEventListener(MEDIA_DROP_EVENT, onMediaDrop)
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('blur', cancel)

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
      overlay.removeEventListener('contextmenu', onContextMenu)
      host.removeEventListener(MEDIA_DROP_EVENT, onMediaDrop)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('blur', cancel)
    },
  }
}
