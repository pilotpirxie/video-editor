import { useEffect, useRef, useState, type ReactElement } from 'react'
import { projectDuration } from '../shared/project.js'
import { frameDuration, timecode } from '../shared/time.js'
import { CameraTool } from './CameraTool.js'
import { CanvasOverlay } from './CanvasOverlay.js'
import { useEditorState, usePosition, useSession, useShortcutHint } from './context.js'
import type { EditorState } from './store.js'
import { IconButton } from './icons.js'
import { Picker } from './Picker.js'
import { keepPreviewSized, type PreviewZoom } from './previewLayout.js'
import { LIBRARY_DROP_EVENT, isLibraryDrag } from './timelineController.js'

const PERCENT = 100
const MIN_ZOOM_PERCENT = 10
const MAX_ZOOM_PERCENT = 400
const PINCH_ZOOM_RATE = 0.01
const ZOOM_CHOICES = [
  { value: 'fit', label: 'Fit' },
  { value: '50', label: '50%' },
  { value: '100', label: '100%' },
  { value: '200', label: '200%' },
]

// Where the pointer was when a pinch changed the zoom: that point of the picture is to stay under it.
type PinchAnchor = {
  clientX: number
  clientY: number
  shareX: number
  shareY: number
}

function zoomKey(zoom: PreviewZoom): string {
  return zoom === 'fit' ? 'fit' : String(Math.round(zoom))
}

// The four ready-made zooms, and the one a pinch left, when it is none of them.
function zoomChoices(zoom: PreviewZoom): { value: string; label: string }[] {
  const key = zoomKey(zoom)
  if (ZOOM_CHOICES.some((choice) => choice.value === key)) return ZOOM_CHOICES
  return [...ZOOM_CHOICES, { value: key, label: `${key}%` }]
}

// A project that opens within this time shows no words, so they never flash by.
const OPENING_HINT_DELAY_MS = 200

// What the canvas says while it has nothing to show: that a project is on its way, or how to put something on it.
function canvasHintOf(state: EditorState): string | undefined {
  if (state.openingName !== undefined) return `Opening "${state.openingName}"…`
  if (projectDuration(state.wholeProject) > 0) return undefined
  if (state.wholeProject.media.length === 0) return 'Drop files here or click Import'
  return undefined
}

type CanvasPanelProps = {
  // Created once outside React: its drawing surface is handed to the engine worker and cannot be handed over twice.
  preview: HTMLCanvasElement
}

export function CanvasPanel({ preview }: CanvasPanelProps): ReactElement {
  const { engine, transport, store, actions } = useSession()
  const canvas = useEditorState((state) => state.project.canvas)
  const duration = useEditorState((state) => projectDuration(state.project))
  const shuttleRate = usePosition((position) => position.shuttleRate)
  const isPlaying = usePosition((position) => position.isPlaying)
  const time = usePosition((position) => position.time)
  const frameCount = usePosition((position) => position.sequence)
  const fullQualityMs = usePosition((position) => position.fullQualityMs)
  const isPreviewing = useEditorState((state) => state.isPreviewing)
  const hint = useEditorState(canvasHintOf)
  const isOpening = useEditorState((state) => state.openingName !== undefined)
  const [isOpeningSlowly, setIsOpeningSlowly] = useState(false)
  const stepBackKeys = useShortcutHint('step-back')
  const playKeys = useShortcutHint('play-pause')
  const stepForwardKeys = useShortcutHint('step-forward')
  const previewKeys = useShortcutHint('preview-mode')
  const areaRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const pinchRef = useRef<PinchAnchor | undefined>(undefined)
  const [zoom, setZoom] = useState<PreviewZoom>('fit')
  const [isCropping, setIsCropping] = useState(false)
  const [isZoomToolOn, setIsZoomToolOn] = useState(false)
  // The camera looks at the whole project, so it is not changed from inside a group.
  const isGroupOpen = useEditorState((state) => state.openGroups.length > 0)
  const isZooming = isZoomToolOn && !isGroupOpen
  const isBusy = isPlaying || shuttleRate !== 0

  useEffect(() => {
    setIsOpeningSlowly(false)
    if (!isOpening) return
    const timer = window.setTimeout(() => setIsOpeningSlowly(true), OPENING_HINT_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [isOpening])

  // While the zoom tool is used the paused picture is the whole canvas, so any part of it can be framed.
  useEffect(() => engine.send({ type: 'whole-canvas', isShown: isZooming }), [engine, isZooming])

  useEffect(() => {
    frameRef.current?.prepend(preview)
  }, [preview])

  useEffect(() => {
    const stage = stageRef.current
    if (stage === null) return
    return keepPreviewSized(preview, stage, canvas, zoom, engine)
  }, [preview, canvas, zoom, engine])

  // A pinch zooms from what is shown now, also from Fit, and keeps the point under the fingers where it is.
  useEffect(() => {
    const area = areaRef.current
    if (area === null) return

    function onWheel(event: WheelEvent): void {
      if (!event.ctrlKey) return
      event.preventDefault()
      const shown = preview.getBoundingClientRect()
      if (shown.width === 0 || shown.height === 0) return
      const percent = (shown.width * devicePixelRatio * PERCENT) / canvas.width
      const next = Math.min(MAX_ZOOM_PERCENT, Math.max(MIN_ZOOM_PERCENT, percent * Math.exp(-event.deltaY * PINCH_ZOOM_RATE)))
      pinchRef.current = { clientX: event.clientX, clientY: event.clientY, shareX: (event.clientX - shown.left) / shown.width, shareY: (event.clientY - shown.top) / shown.height }
      setZoom(next)
    }

    // Not passive, so that the pinch does not also zoom the whole window.
    area.addEventListener('wheel', onWheel, { passive: false })
    return () => area.removeEventListener('wheel', onWheel)
  }, [preview, canvas.width])

  // Runs after the preview has taken its new size.
  useEffect(() => {
    const anchor = pinchRef.current
    const area = areaRef.current
    pinchRef.current = undefined
    if (anchor === undefined || area === null) return
    const shown = preview.getBoundingClientRect()
    area.scrollLeft += shown.left + anchor.shareX * shown.width - anchor.clientX
    area.scrollTop += shown.top + anchor.shareY * shown.height - anchor.clientY
  }, [preview, zoom])

  // Media dropped on the canvas starts at the playhead, on the layer above everything else; several files follow one another there.
  useEffect(() => {
    const stage = stageRef.current
    if (stage === null) return

    function onMediaDrop(event: Event): void {
      if (isLibraryDrag(event) && event.detail.item.kind === 'media') actions.addMedia(event.detail.item.mediaIds)
    }

    stage.addEventListener(LIBRARY_DROP_EVENT, onMediaDrop)
    return () => stage.removeEventListener(LIBRARY_DROP_EVENT, onMediaDrop)
  }, [actions])

  return (
    <main className="canvas-panel" aria-label="Canvas">
      <div className={zoom === 'fit' ? 'canvas-area' : 'canvas-area scrollable'} ref={areaRef}>
        <div className="preview-fit" ref={stageRef}>
          <div className="preview-frame" ref={frameRef}>
            {!isPreviewing && (isZooming ? <CameraTool /> : <CanvasOverlay isCropping={isCropping} areaRef={areaRef} />)}
          </div>
        </div>
        {hint !== undefined && !isPreviewing && (!isOpening || isOpeningSlowly) && (
          <p className="canvas-hint" data-testid="canvas-hint">
            {hint}
          </p>
        )}
      </div>
      <footer className="canvas-footer">
        <IconButton icon="stepBack" label="Previous frame" testId="step-back" shortcut={stepBackKeys} onClick={() => actions.stepFrames(-1)} />
        <IconButton icon={isBusy ? 'pause' : 'play'} label={isBusy ? 'Pause' : 'Play'} testId="play" shortcut={playKeys} onClick={() => void transport.toggle()} />
        <IconButton icon="stepForward" label="Next frame" testId="step-forward" shortcut={stepForwardKeys} onClick={() => actions.stepFrames(1)} />
        <span className="timecodes">
          <output className="timecode" data-testid="timecode" aria-label="Timecode" data-frames={frameCount} data-full-quality={fullQualityMs !== undefined}>
            {timecode(time, canvas.frameRate)}
          </output>{' '}
          <span className="timecode total" data-testid="duration" aria-label="Project length">
            / {timecode(duration, canvas.frameRate)}
          </span>
        </span>
        {shuttleRate !== 0 && (
          <span className="badge" data-testid="shuttle-rate">
            {shuttleRate < 0 ? `−${-shuttleRate}×` : `${shuttleRate}×`}
          </span>
        )}
        {isPreviewing ? (
          <input
            type="range"
            className="seek-bar"
            aria-label="Playhead"
            data-testid="seek-bar"
            min={0}
            max={duration}
            step={frameDuration(canvas.frameRate)}
            value={time}
            onPointerDown={() => transport.pause()}
            onChange={(event) => transport.seek(Number(event.target.value))}
          />
        ) : (
          <>
            <span className="spacer" />
            <IconButton icon="zoom" label="Zoom and pan" testId="zoom-tool" isPressed={isZooming} isDisabled={isGroupOpen} onClick={() => setIsZoomToolOn(!isZooming)} />
            <IconButton icon="fit" label="Zoom to full" testId="zoom-to-full" isDisabled={isGroupOpen} onClick={actions.zoomToFull} />
            <IconButton icon="crop" label="Crop" testId="crop-mode" isPressed={isCropping} onClick={() => setIsCropping(!isCropping)} />
            <div className="canvas-zoom">
              <Picker label="Canvas zoom" testId="canvas-zoom" choices={zoomChoices(zoom)} value={zoomKey(zoom)} onChoose={(key) => setZoom(key === 'fit' ? 'fit' : Number(key))} />
            </div>
          </>
        )}
        <IconButton icon="preview" label={isPreviewing ? 'Leave preview mode' : 'Preview mode'} testId="preview-mode" shortcut={previewKeys} isPressed={isPreviewing} onClick={() => store.setPreviewing(!isPreviewing)} />
      </footer>
    </main>
  )
}
