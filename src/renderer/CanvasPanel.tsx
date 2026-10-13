import { useEffect, useRef, useState, type ReactElement } from 'react'
import { nextTrackName } from '../editor/clips.js'
import { dropMedia } from '../editor/place.js'
import { shortcutHint } from '../editor/shortcuts.js'
import { projectDuration } from '../shared/project.js'
import { timecode } from '../shared/time.js'
import { CanvasOverlay } from './CanvasOverlay.js'
import { useEditorState, usePosition, useSession } from './context.js'
import { IconButton } from './icons.js'
import { PreviewZoomButtons, keepPreviewSized, type PreviewZoom } from './previewLayout.js'
import { MEDIA_DROP_EVENT, isMediaDrop } from './timelineController.js'

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
  const stageRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState<PreviewZoom>('fit')
  const [isCropping, setIsCropping] = useState(false)
  const isBusy = isPlaying || shuttleRate !== 0

  useEffect(() => {
    frameRef.current?.prepend(preview)
  }, [preview])

  useEffect(() => {
    const stage = stageRef.current
    if (stage === null) return
    return keepPreviewSized(preview, stage, canvas, zoom, engine)
  }, [preview, canvas, zoom, engine])

  // Media dropped on the canvas starts at the playhead, on a new layer above everything else.
  useEffect(() => {
    const stage = stageRef.current
    if (stage === null) return

    function onMediaDrop(event: Event): void {
      if (!isMediaDrop(event)) return
      const { project, mediaStates } = store.getState()
      const reference = project.media.find((candidate) => candidate.id === event.detail.mediaId)
      const state = mediaStates[event.detail.mediaId]
      if (reference === undefined || state === undefined || 'error' in state) return
      const clipId = crypto.randomUUID()
      const newTrack = { id: crypto.randomUUID(), name: nextTrackName(project) }
      const start = transport.position().time
      store.apply('Add Clip', (current) => dropMedia(current, { reference, info: state.info, clipId, start, trackIndex: current.tracks.length, newTrack }))
      store.select([clipId])
    }

    stage.addEventListener(MEDIA_DROP_EVENT, onMediaDrop)
    return () => stage.removeEventListener(MEDIA_DROP_EVENT, onMediaDrop)
  }, [store, transport])

  return (
    <main className="canvas-panel" aria-label="Canvas">
      <div className={zoom === 'fit' ? 'canvas-area' : 'canvas-area scrollable'}>
        <div className="preview-fit" ref={stageRef}>
          <div className="preview-frame" ref={frameRef}>
            <CanvasOverlay isCropping={isCropping} />
          </div>
        </div>
      </div>
      <footer className="canvas-footer">
        <IconButton icon="stepBack" label="Previous frame" testId="step-back" shortcut={shortcutHint('step-back')} onClick={() => actions.stepFrames(-1)} />
        <IconButton icon={isBusy ? 'pause' : 'play'} label={isBusy ? 'Pause' : 'Play'} testId="play" shortcut={shortcutHint('play-pause')} onClick={() => void transport.toggle()} />
        <IconButton icon="stepForward" label="Next frame" testId="step-forward" shortcut={shortcutHint('step-forward')} onClick={() => actions.stepFrames(1)} />
        <output className="timecode" data-testid="timecode" aria-label="Timecode" data-frames={frameCount} data-full-quality={fullQualityMs !== undefined}>
          {timecode(time, canvas.frameRate)}
        </output>
        <span className="timecode total" data-testid="duration" aria-label="Project length">
          / {timecode(duration, canvas.frameRate)}
        </span>
        {shuttleRate !== 0 && (
          <span className="badge" data-testid="shuttle-rate">
            {shuttleRate < 0 ? `−${-shuttleRate}×` : `${shuttleRate}×`}
          </span>
        )}
        <span className="spacer" />
        <IconButton icon="crop" label="Crop with the handles" testId="crop-mode" isPressed={isCropping} onClick={() => setIsCropping(!isCropping)} />
        <PreviewZoomButtons zoom={zoom} onZoom={setZoom} />
      </footer>
    </main>
  )
}
