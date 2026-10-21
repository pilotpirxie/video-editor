import { useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react'
import { exportFrameRates, parseRememberedChoices, selectionRange, startingChoices, durationText, timeLeftMs, withFormat, type ExportChoices, type RememberedChoices } from '../editor/export.js'
import { unlinkedMedia } from '../editor/place.js'
import {
  EXPORT_ENCODERS,
  EXPORT_FORMATS,
  EXPORT_PRESETS,
  EXPORT_QUALITIES,
  exportSize,
  hasMovingPicture,
  isExportEncoder,
  isExportFormat,
  isExportPreset,
  shortSideOf,
  type ExportEncoder,
  type ExportFormat,
  type ExportPreset,
  type ExportQuality,
} from '../shared/exportPresets.js'
import { logError } from '../shared/log.js'
import { projectDuration } from '../shared/project.js'
import { TICKS_PER_SECOND, timecode, type FrameRate } from '../shared/time.js'
import { useEditorState, useSession } from './context.js'
import { Picker, type Choice } from './Picker.js'

const CHOICES_KEY = 'export-choices'
const FRAME_RATE_DECIMALS = 3
const MS_PER_SECOND = 1000

const PRESET_NAMES: Record<ExportPreset, string> = {
  '120p': '120p',
  '240p': '240p',
  '360p': '360p',
  '480p': '480p',
  '720p': '720p',
  '1080p': '1080p',
  '1440p': '1440p',
  '4k': '4K',
  'youtube-1080p': 'YouTube 1080p',
  'vertical-1080x1920': 'Vertical',
  'square-1080': 'Square',
}

const QUALITY_NAMES: Record<ExportQuality, string> = { low: 'Low', medium: 'Medium', high: 'High' }

const FORMAT_NAMES: Record<ExportFormat, string> = {
  mp4: 'MP4 video',
  webm: 'WebM video',
  gif: 'Animated GIF',
  m4a: 'M4A sound',
  mp3: 'MP3 sound',
  wav: 'WAV sound',
  png: 'PNG of this frame',
}

const SUMMARY_NAMES: Record<ExportFormat, string> = { mp4: 'MP4', webm: 'WebM', gif: 'GIF', m4a: 'M4A sound', mp3: 'MP3 sound', wav: 'WAV sound', png: 'PNG' }

const ENCODER_NAMES: Record<ExportEncoder, string> = { hardware: 'Apple hardware (fast)', x264: 'x264 (smallest files)' }

function rateKey(rate: FrameRate): string {
  return `${rate.num}/${rate.den}`
}

function ticksText(ticks: number): string {
  return durationText((ticks / TICKS_PER_SECOND) * MS_PER_SECOND)
}

export function ExportDialog(): ReactElement {
  const session = useSession()
  const { store } = session
  const project = useEditorState((state) => state.project)
  const selection = useEditorState((state) => state.selection)
  const mediaStates = useEditorState((state) => state.mediaStates)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [choices, setChoices] = useState<ExportChoices>(() => startingChoices(project, parseRememberedChoices(localStorage.getItem(CHOICES_KEY) ?? undefined), session.hasSmallMemory))
  const [playheadTime] = useState(() => session.transport.position().time)

  useEffect(() => {
    dialogRef.current?.showModal()
  }, [])

  const { canvas } = project
  const { format } = choices
  const isMovingPicture = hasMovingPicture(format)
  const isVideo = format === 'mp4' || format === 'webm'
  const size = format === 'png' ? canvas : exportSize(choices.preset, canvas)
  const rates = exportFrameRates(format)
  const selected = selectionRange(project, selection)
  const range = choices.isSelectionOnly && selected !== undefined ? selected : { start: 0, end: projectDuration(project) }
  const missingCount = unlinkedMedia(project, mediaStates).length

  function presetChoices(isShaped: boolean, heading: string): Choice[] {
    const presets = EXPORT_PRESETS.filter((preset) => (shortSideOf(preset) !== undefined) === isShaped)
    return presets.map((preset, index) => {
      const pixels = exportSize(preset, canvas)
      const label = `${PRESET_NAMES[preset]} (${pixels.width}x${pixels.height})`
      return index === 0 ? { value: preset, label, heading } : { value: preset, label }
    })
  }

  function rateLabel(rate: FrameRate): string {
    const framesPerSecond = Number((rate.num / rate.den).toFixed(FRAME_RATE_DECIMALS))
    return rateKey(rate) === rateKey(canvas.frameRate) ? `${framesPerSecond} fps (project)` : `${framesPerSecond} fps`
  }

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    const remembered: RememberedChoices = { format, preset: choices.preset, quality: choices.quality, encoder: choices.encoder, hasAudio: choices.hasAudio }
    try {
      localStorage.setItem(CHOICES_KEY, JSON.stringify(remembered))
    } catch (error) {
      logError('Could not remember the export choices', error)
    }
    dialogRef.current?.close()
    void session.exportVideo(choices)
  }

  function summary(): string {
    const name = SUMMARY_NAMES[format]
    if (format === 'png') return `${name}, ${size.width}x${size.height}, the frame at ${timecode(playheadTime, canvas.frameRate)}`
    const length = `${ticksText(range.end - range.start)} long`
    if (!isMovingPicture) return `${name}, ${length}`
    return `${name}, ${size.width}x${size.height}, ${length}`
  }

  return (
    <dialog ref={dialogRef} className="dialog" aria-labelledby="export-title" data-testid="export-dialog" onClose={() => store.showExportDialog(false)}>
      <form className="dialog-form" onSubmit={onSubmit}>
        <h2 className="dialog-title" id="export-title">
          Export
        </h2>
        <div className="labelled">
          <span className="field-label">Format</span>
          <Picker
            label="Format"
            testId="export-format"
            choices={EXPORT_FORMATS.map((value) => ({ value, label: FORMAT_NAMES[value] }))}
            value={format}
            onChoose={(chosen) => {
              if (isExportFormat(chosen)) setChoices(withFormat(choices, chosen, canvas.frameRate))
            }}
          />
        </div>
        {isMovingPicture && (
          <div className="labelled">
            <span className="field-label">Size</span>
            <Picker
              label="Size"
              testId="export-preset"
              choices={[...presetChoices(true, 'Shape of this project'), ...presetChoices(false, 'Fixed shapes')]}
              value={choices.preset}
              onChoose={(preset) => {
                if (isExportPreset(preset)) setChoices({ ...choices, preset })
              }}
            />
          </div>
        )}
        {isMovingPicture && (
          <div className="labelled">
            <span className="field-label">Frame rate</span>
            <Picker
              label="Frame rate"
              testId="export-frame-rate"
              choices={rates.map((rate) => ({ value: rateKey(rate), label: rateLabel(rate) }))}
              value={rateKey(choices.frameRate)}
              onChoose={(key) => {
                const frameRate = rates.find((rate) => rateKey(rate) === key)
                if (frameRate !== undefined) setChoices({ ...choices, frameRate })
              }}
            />
          </div>
        )}
        {isVideo && (
          <div className="labelled">
            <span className="field-label" id="export-quality-label">
              Quality
            </span>
            <div className="segmented wide" role="group" aria-labelledby="export-quality-label">
              {EXPORT_QUALITIES.map((quality) => (
                <button key={quality} type="button" className="button" data-testid={`export-quality-${quality}`} aria-pressed={choices.quality === quality} onClick={() => setChoices({ ...choices, quality })}>
                  {QUALITY_NAMES[quality]}
                </button>
              ))}
            </div>
          </div>
        )}
        {format === 'mp4' && (
          <div className="labelled">
            <span className="field-label">Encoder</span>
            <Picker
              label="Encoder"
              testId="export-encoder"
              choices={EXPORT_ENCODERS.map((value) => ({ value, label: ENCODER_NAMES[value] }))}
              value={choices.encoder}
              onChoose={(encoder) => {
                if (isExportEncoder(encoder)) setChoices({ ...choices, encoder })
              }}
            />
          </div>
        )}
        {format !== 'png' && (
          <fieldset className="labelled">
            <legend className="field-label">Range</legend>
            <label className="check-field">
              <input type="radio" name="export-range" data-testid="export-range-whole" checked={!choices.isSelectionOnly} onChange={() => setChoices({ ...choices, isSelectionOnly: false })} />
              Whole timeline
            </label>
            <label className="check-field">
              <input
                type="radio"
                name="export-range"
                data-testid="export-range-selection"
                checked={choices.isSelectionOnly}
                disabled={selected === undefined}
                onChange={() => setChoices({ ...choices, isSelectionOnly: true })}
              />
              Selected clips
            </label>
          </fieldset>
        )}
        {isVideo && (
          <div className="labelled">
            <span className="field-label">Sound</span>
            <label className="check-field">
              <input type="checkbox" data-testid="export-audio" checked={choices.hasAudio} onChange={(event) => setChoices({ ...choices, hasAudio: event.target.checked })} />
              Include sound
            </label>
          </div>
        )}
        <p className="dialog-summary" data-testid="export-summary">
          {summary()}
          {missingCount > 0 && `. ${missingCount} media ${missingCount === 1 ? 'file is' : 'files are'} missing; clips that use ${missingCount === 1 ? 'it' : 'them'} will be left out.`}
        </p>
        <div className="dialog-buttons">
          <button type="button" className="button" data-testid="export-cancel-dialog" onClick={() => dialogRef.current?.close()}>
            Cancel
          </button>
          <button type="submit" className="button primary" data-testid="export-start">
            Export
          </button>
        </div>
      </form>
    </dialog>
  )
}

export function ExportProgressDialog(): ReactElement | undefined {
  const session = useSession()
  const status = useEditorState((state) => state.exportStatus)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const phase = status?.phase

  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog === null) return
    dialog.showModal()
    // The focus starts on the dialog, not on Cancel: a key pressed out of habit must not stop a long export.
    dialog.focus()
  }, [])

  useEffect(() => {
    if (phase !== 'running') closeRef.current?.focus()
  }, [phase])

  if (status === undefined) return undefined
  const left = status.phase === 'running' ? timeLeftMs(status.done, status.total, performance.now() - status.startedAt) : undefined
  return (
    <dialog
      ref={dialogRef}
      className="dialog"
      tabIndex={-1}
      closedby={status.phase === 'running' ? 'none' : 'closerequest'}
      aria-labelledby="export-progress-title"
      data-testid="export-progress-dialog"
      onClose={() => session.store.setExportStatus(undefined)}
    >
      <div className="dialog-form">
        <h2 className="dialog-title" id="export-progress-title" data-testid="export-title" aria-live="polite">
          {status.phase === 'running' && `Exporting "${status.fileName}"`}
          {status.phase === 'done' && `Exported "${status.fileName}"`}
          {status.phase === 'failed' && `"${status.fileName}" was not exported`}
        </h2>
        {status.phase === 'running' && (
          <>
            <progress className="export-bar" value={status.done} max={status.total} aria-label="Frames exported" />
            <p className="dialog-summary" data-testid="export-progress">
              Frame {status.done.toLocaleString('en')} of {status.total.toLocaleString('en')}
              {left !== undefined && `, ${durationText(left)} left`}
            </p>
          </>
        )}
        {status.phase === 'failed' && (
          <p className="dialog-summary" data-testid="export-problem">
            {status.message}
          </p>
        )}
        <div className="dialog-buttons">
          {status.phase === 'running' && (
            <button type="button" className="button" data-testid="export-cancel" onClick={session.cancelExport}>
              Cancel
            </button>
          )}
          {status.phase === 'done' && (
            <button type="button" className="button" data-testid="show-export" onClick={() => window.host.showLastExport()}>
              Show in Finder
            </button>
          )}
          {status.phase !== 'running' && (
            <button ref={closeRef} type="button" className="button primary" data-testid="export-done" onClick={() => dialogRef.current?.close()}>
              {status.phase === 'done' ? 'Done' : 'Close'}
            </button>
          )}
        </div>
      </div>
    </dialog>
  )
}
