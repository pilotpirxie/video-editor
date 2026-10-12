import { useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent, type ReactElement } from 'react'
import { EXPORT_PRESETS, isExportPreset, type ExportPreset } from '../shared/exportPresets.js'
import { describeError } from '../shared/log.js'
import type { HostCommand, JobEvent } from '../shared/mediaProtocol.js'
import type { Canvas } from '../shared/project.js'
import { frameDuration, timecode } from '../shared/time.js'
import { createAudioOutput, type AudioOutput } from './audioOutput.js'
import { startEngine, type EngineHost } from './engineHost.js'
import type { WorkerEvent } from './engineWorker.js'

type Zoom = 'fit' | 'actual'

type LoadedInfo = {
  path: string
  duration: number
  canvas: Canvas
  problems: string[]
}

type Position = {
  time: number
  isPlaying: boolean
  droppedFrames: number
  fullQualityMs: number | undefined
  sequence: number
}

type ExportState = { stage: 'idle' } | { stage: 'running'; done: number; total: number } | { stage: 'finished'; message: string }

const START_POSITION: Position = { time: 0, isPlaying: false, droppedFrames: 0, fullQualityMs: undefined, sequence: 0 }
const NO_FRAME_RATE = { num: 30, den: 1 }

function exportMessage(event: JobEvent): ExportState {
  if (event.type === 'progress') return { stage: 'running', done: event.done, total: event.total }
  if (event.type === 'error') return { stage: 'finished', message: `Export failed: ${event.message}` }
  return { stage: 'finished', message: 'Export finished.' }
}

function previewSize(canvas: Canvas, stage: DOMRect, zoom: Zoom): { width: number; height: number } {
  if (zoom === 'actual') return { width: canvas.width / devicePixelRatio, height: canvas.height / devicePixelRatio }
  const scale = Math.min(stage.width / canvas.width, stage.height / canvas.height)
  return { width: canvas.width * scale, height: canvas.height * scale }
}

export function Harness(): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const engineRef = useRef<EngineHost | undefined>(undefined)
  const audioRef = useRef<AudioOutput | undefined>(undefined)
  const pendingPathRef = useRef<string | undefined>(undefined)

  const [loaded, setLoaded] = useState<LoadedInfo | undefined>(undefined)
  const [position, setPosition] = useState<Position>(START_POSITION)
  const [zoom, setZoom] = useState<Zoom>('fit')
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

  const togglePlayback = useCallback(async (): Promise<void> => {
    const engine = engineRef.current
    if (engine === undefined || loaded === undefined) return
    if (position.isPlaying) {
      engine.send({ type: 'pause' })
      return
    }
    try {
      if (audioRef.current === undefined) {
        audioRef.current = await createAudioOutput()
        engine.send({ type: 'audio-port' }, [audioRef.current.enginePort])
      }
      await audioRef.current.resume()
      engine.send({ type: 'play', outputLatency: audioRef.current.latency() })
    } catch (error) {
      setMessage(`The sound output could not be started: ${describeError(error)}`)
    }
  }, [loaded, position.isPlaying])

  const actionsRef = useRef({ openProject, chooseProject, startExport })
  actionsRef.current = { openProject, chooseProject, startExport }

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null || engineRef.current !== undefined) return
    const engine = startEngine(canvas)
    engineRef.current = engine

    engine.onEvent((event: WorkerEvent) => {
      if (event.type === 'loaded') {
        setLoaded({ path: pendingPathRef.current ?? '', duration: event.duration, canvas: event.canvas, problems: event.problems })
        setMessage(event.problems.length === 0 ? 'Ready.' : event.problems.join(' '))
      } else if (event.type === 'position') {
        setPosition((previous) => ({ ...event, sequence: previous.sequence + 1 }))
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
    if (stage === null || canvas === null || loaded === undefined) return

    function layOut(): void {
      if (stage === null || canvas === null || loaded === undefined) return
      const size = previewSize(loaded.canvas, stage.getBoundingClientRect(), zoom)
      canvas.style.width = `${size.width}px`
      canvas.style.height = `${size.height}px`
      engineRef.current?.send({ type: 'resize', width: size.width * devicePixelRatio, height: size.height * devicePixelRatio })
    }
    layOut()
    const observer = new ResizeObserver(layOut)
    observer.observe(stage)
    return () => observer.disconnect()
  }, [loaded, zoom])

  useEffect(() => {
    if (position.isPlaying) return

    async function suspendSound(): Promise<void> {
      try {
        await audioRef.current?.suspend()
      } catch (error) {
        setMessage(`The sound output could not be paused: ${describeError(error)}`)
      }
    }
    void suspendSound()
  }, [position.isPlaying])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.code !== 'Space' || event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return
      event.preventDefault()
      void togglePlayback()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [togglePlayback])

  function onScrub(event: ChangeEvent<HTMLInputElement>): void {
    engineRef.current?.send({ type: 'seek', time: Number(event.target.value) })
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
  const quality = position.fullQualityMs === undefined ? 'preview' : `full quality in ${Math.round(position.fullQualityMs)} ms`
  const preparation = loaded !== undefined && !isPrepared ? ' · preparing' : ''

  return (
    <div className="harness" onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
      <header className="toolbar">
        <button type="button" data-testid="open" onClick={() => void chooseProject()}>
          Open Project…
        </button>
        <div className="segmented" role="group" aria-label="Preview zoom">
          <button type="button" data-testid="zoom-fit" aria-pressed={zoom === 'fit'} onClick={() => setZoom('fit')}>
            Fit
          </button>
          <button type="button" data-testid="zoom-actual" aria-pressed={zoom === 'actual'} onClick={() => setZoom('actual')}>
            100%
          </button>
        </div>
        <span className="spacer" />
        <label>
          Preset{' '}
          <select value={preset} onChange={onPresetChange} disabled={isExporting}>
            {EXPORT_PRESETS.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        {isExporting ? (
          <button type="button" data-testid="cancel-export" onClick={() => {
            window.host.cancelExport()
            setExportState({ stage: 'finished', message: 'Export cancelled.' })
          }}>
            Cancel export ({Math.round((exportState.done / exportState.total) * 100)}%)
          </button>
        ) : (
          <button type="button" className="primary" data-testid="export" disabled={loaded === undefined} onClick={() => void startExport()}>
            Export MP4…
          </button>
        )}
      </header>

      <div className="stage" ref={stageRef}>
        <canvas ref={canvasRef} data-testid="preview" aria-label="Preview" />
      </div>

      <footer className="transport">
        <button type="button" className="primary" data-testid="play" disabled={loaded === undefined} onClick={() => void togglePlayback()}>
          {position.isPlaying ? 'Pause' : 'Play'}
        </button>
        <output className="timecode" data-testid="timecode" aria-label="Timecode">
          {timecode(position.time, frameRate)}
        </output>
        <input
          type="range"
          data-testid="scrub"
          aria-label="Playhead"
          min={0}
          max={lastFrameStart}
          step={frameTicks}
          value={position.time}
          disabled={loaded === undefined}
          onChange={onScrub}
        />
        <span className="status" data-testid="status">
          {exportState.stage === 'finished' ? exportState.message : message}
        </span>
        <span className="stats" data-testid="stats" data-sequence={position.sequence}>
          {quality} · dropped {position.droppedFrames}
          {preparation}
        </span>
      </footer>
    </div>
  )
}
