import { useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent, type ReactElement } from 'react'
import { EXPORT_PRESETS, isExportPreset, type ExportPreset } from '../shared/exportPresets.js'
import type { HostCommand, JobEvent } from '../shared/mediaProtocol.js'
import type { Canvas } from '../shared/project.js'
import { frameDuration, timecode } from '../shared/time.js'
import { startEngine, type EngineHost } from './engineHost.js'
import type { WorkerEvent } from './engineWorker.js'
import { PreviewZoomButtons, keepPreviewSized, type PreviewZoom } from './previewLayout.js'
import { createTransport, onSpaceKey, type Position, type Transport } from './transport.js'

type LoadedInfo = {
  path: string
  duration: number
  canvas: Canvas
  problems: string[]
}

type ExportState = { stage: 'idle' } | { stage: 'running'; done: number; total: number } | { stage: 'finished'; message: string }

const NO_FRAME_RATE = { num: 30, den: 1 }

function exportMessage(event: JobEvent): ExportState {
  if (event.type === 'progress') return { stage: 'running', done: event.done, total: event.total }
  if (event.type === 'error') return { stage: 'finished', message: `Export failed: ${event.message}` }
  return { stage: 'finished', message: 'Export finished.' }
}

export function Harness(): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const engineRef = useRef<EngineHost | undefined>(undefined)
  const transportRef = useRef<Transport | undefined>(undefined)
  const pendingPathRef = useRef<string | undefined>(undefined)

  const [loaded, setLoaded] = useState<LoadedInfo | undefined>(undefined)
  const [position, setPosition] = useState<Position | undefined>(undefined)
  const [zoom, setZoom] = useState<PreviewZoom>('fit')
  const [preset, setPreset] = useState<ExportPreset>('1080p')
  const [exportState, setExportState] = useState<ExportState>({ stage: 'idle' })
  const [message, setMessage] = useState('Open a project file to begin.')
  const [isPrepared, setIsPrepared] = useState(false)

  const openProject = useCallback((path: string): void => {
    pendingPathRef.current = path
    setIsPrepared(false)
    setMessage(`Opening ${path}…`)
    engineRef.current?.send({ type: 'load', path })
  }, [])

  const chooseProject = useCallback(async (): Promise<void> => {
    const path = await window.host.openProjectDialog()
    if (path !== undefined) openProject(path)
  }, [openProject])

  const startExport = useCallback(async (): Promise<void> => {
    if (loaded === undefined) return
    const outputPath = await window.host.saveExportDialog('export.mp4')
    if (outputPath === undefined) return
    setExportState({ stage: 'running', done: 0, total: 1 })
    window.host.startExport({ kind: 'export', projectPath: loaded.path, outputPath, preset })
  }, [loaded, preset])

  const togglePlayback = useCallback((): void => {
    if (loaded !== undefined) void transportRef.current?.toggle()
  }, [loaded])

  const actionsRef = useRef({ openProject, chooseProject, startExport })
  actionsRef.current = { openProject, chooseProject, startExport }

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null || engineRef.current !== undefined) return
    const engine = startEngine(canvas)
    engineRef.current = engine

    const transport = createTransport(engine, setMessage)
    transportRef.current = transport
    transport.subscribe(() => setPosition(transport.position()))

    engine.onEvent((event: WorkerEvent) => {
      if (event.type === 'loaded') {
        setLoaded({ path: pendingPathRef.current ?? '', duration: event.duration, canvas: event.canvas, problems: event.problems })
        setMessage(event.problems.length === 0 ? 'Ready.' : event.problems.join(' '))
      } else if (event.type === 'prepared') {
        setIsPrepared(true)
      } else if (event.type === 'error') {
        setMessage(event.message)
      }
    })

    window.host.onCommand((command: HostCommand) => {
      const actions = actionsRef.current
      if (command.type === 'open-project') {
        actions.openProject(command.path)
      } else if (command.type === 'export-event') {
        setExportState(exportMessage(command.event))
      } else if (command.type === 'menu' && command.action === 'open-project') {
        void actions.chooseProject()
      } else if (command.type === 'menu' && command.action === 'export') {
        void actions.startExport()
      }
    })
  }, [])

  useEffect(() => {
    const stage = stageRef.current
    const canvas = canvasRef.current
    const engine = engineRef.current
    if (stage === null || canvas === null || engine === undefined || loaded === undefined) return
    return keepPreviewSized(canvas, stage, loaded.canvas, zoom, engine)
  }, [loaded, zoom])

  useEffect(() => onSpaceKey(togglePlayback), [togglePlayback])

  function onScrub(event: ChangeEvent<HTMLInputElement>): void {
    transportRef.current?.seek(Number(event.target.value))
  }

  function onPresetChange(event: ChangeEvent<HTMLSelectElement>): void {
    if (isExportPreset(event.target.value)) setPreset(event.target.value)
  }

  function onDrop(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault()
    const file = event.dataTransfer.files[0]
    if (file !== undefined) openProject(window.host.pathOfFile(file))
  }

  const frameRate = loaded?.canvas.frameRate ?? NO_FRAME_RATE
  const frameTicks = frameDuration(frameRate)
  const lastFrameStart = loaded === undefined ? 0 : Math.max(0, Math.ceil(loaded.duration / frameTicks) - 1) * frameTicks
  const isExporting = exportState.stage === 'running'
  const time = position?.time ?? 0
  const isPlaying = position?.isPlaying ?? false
  const quality = position?.fullQualityMs === undefined ? 'preview' : `full quality in ${Math.round(position.fullQualityMs)} ms`
  const preparation = loaded !== undefined && !isPrepared ? ' · preparing' : ''

  return (
    <div className="harness" onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
      <header className="toolbar">
        <button type="button" className="button" data-testid="open" onClick={() => void chooseProject()}>
          Open Project…
        </button>
        <PreviewZoomButtons zoom={zoom} onZoom={setZoom} />
        <span className="spacer" />
        <label>
          Preset{' '}
          <select className="button" value={preset} onChange={onPresetChange} disabled={isExporting}>
            {EXPORT_PRESETS.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        {isExporting ? (
          <button type="button" className="button" data-testid="cancel-export" onClick={() => {
            window.host.cancelExport()
            setExportState({ stage: 'finished', message: 'Export cancelled.' })
          }}>
            Cancel export ({Math.round((exportState.done / exportState.total) * 100)}%)
          </button>
        ) : (
          <button type="button" className="button primary" data-testid="export" disabled={loaded === undefined} onClick={() => void startExport()}>
            Export MP4…
          </button>
        )}
      </header>

      <div className="stage" ref={stageRef}>
        <canvas ref={canvasRef} data-testid="preview" aria-label="Preview" />
      </div>

      <footer className="transport">
        <button type="button" className="button primary" data-testid="play" disabled={loaded === undefined} onClick={togglePlayback}>
          {isPlaying ? 'Pause' : 'Play'}
        </button>
        <output className="timecode" data-testid="timecode" aria-label="Timecode">
          {timecode(time, frameRate)}
        </output>
        <input
          type="range"
          data-testid="scrub"
          aria-label="Playhead"
          min={0}
          max={lastFrameStart}
          step={frameTicks}
          value={time}
          disabled={loaded === undefined}
          onChange={onScrub}
        />
        <span className="status" data-testid="status">
          {exportState.stage === 'finished' ? exportState.message : message}
        </span>
        <span className="stats" data-testid="stats" data-sequence={position?.sequence ?? 0}>
          {quality} · dropped {position?.droppedFrames ?? 0}
          {preparation}
        </span>
      </footer>
    </div>
  )
}
