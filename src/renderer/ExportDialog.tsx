import { useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react'
import { exportFrameRates, parseRememberedChoices, selectionRange, startingChoices, durationText, type ExportChoices, type RememberedChoices } from '../editor/export.js'
import { unlinkedMedia } from '../editor/place.js'
import { EXPORT_PRESETS, EXPORT_QUALITIES, exportSize, isExportPreset, shortSideOf, type ExportPreset, type ExportQuality } from '../shared/exportPresets.js'
import { logError } from '../shared/log.js'
import { projectDuration } from '../shared/project.js'
import { TICKS_PER_SECOND, type FrameRate } from '../shared/time.js'
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

function rateKey(rate: FrameRate): string {
  return `${rate.num}/${rate.den}`
}

function ticksText(ticks: number): string {
  return durationText((ticks / TICKS_PER_SECOND) * MS_PER_SECOND)
}

// The one place where a video is made: size, frame rate, quality, range and sound, then where to save it.
export function ExportDialog(): ReactElement {
  const session = useSession()
  const { store } = session
  const project = useEditorState((state) => state.project)
  const selection = useEditorState((state) => state.selection)
  const mediaStates = useEditorState((state) => state.mediaStates)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [choices, setChoices] = useState<ExportChoices>(() => startingChoices(project, parseRememberedChoices(localStorage.getItem(CHOICES_KEY) ?? undefined)))

  useEffect(() => {
    dialogRef.current?.showModal()
  }, [])

  const { canvas } = project
  const size = exportSize(choices.preset, canvas)
  const rates = exportFrameRates(canvas.frameRate)
  const selected = selectionRange(project, selection)
  const range = choices.isSelectionOnly && selected !== undefined ? selected : { start: 0, end: projectDuration(project) }
  const missingCount = unlinkedMedia(project, mediaStates).length

  // The sizes that keep the shape of the project come first, then the ones with a shape of their own.
  function presetChoices(isShaped: boolean, heading: string): Choice[] {
    const presets = EXPORT_PRESETS.filter((preset) => (shortSideOf(preset) !== undefined) === isShaped)
    return presets.map((preset, index) => {
      const pixels = exportSize(preset, canvas)
      const label = `${PRESET_NAMES[preset]} · ${pixels.width} × ${pixels.height}`
      return index === 0 ? { value: preset, label, heading } : { value: preset, label }
    })
  }

  function rateLabel(rate: FrameRate): string {
    const framesPerSecond = Number((rate.num / rate.den).toFixed(FRAME_RATE_DECIMALS))
    return rateKey(rate) === rateKey(canvas.frameRate) ? `${framesPerSecond} fps (project)` : `${framesPerSecond} fps`
  }

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    const remembered: RememberedChoices = { preset: choices.preset, quality: choices.quality, hasAudio: choices.hasAudio }
    try {
      localStorage.setItem(CHOICES_KEY, JSON.stringify(remembered))
    } catch (error) {
      logError('Could not remember the export choices', error)
    }
    dialogRef.current?.close()
    void session.exportVideo(choices)
  }

  return (
    <dialog ref={dialogRef} className="dialog" aria-labelledby="export-title" data-testid="export-dialog" onClose={() => store.showExportDialog(false)}>
      <form className="dialog-form" onSubmit={onSubmit}>
        <h2 className="dialog-title" id="export-title">
          Export video
        </h2>
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
            {selected === undefined ? 'Selected clips (select clips on the timeline first)' : 'Selected clips'}
          </label>
        </fieldset>
        <div className="labelled">
          <span className="field-label">Sound</span>
          <label className="check-field">
            <input type="checkbox" data-testid="export-audio" checked={choices.hasAudio} onChange={(event) => setChoices({ ...choices, hasAudio: event.target.checked })} />
            Include sound
          </label>
        </div>
        <p className="dialog-summary" data-testid="export-summary">
          MP4, {size.width} × {size.height}, {ticksText(range.end - range.start)} long.
          {missingCount > 0 && ` ${missingCount} media ${missingCount === 1 ? 'file is' : 'files are'} missing; clips that use ${missingCount === 1 ? 'it' : 'them'} will be left out.`}
        </p>
        <div className="dialog-buttons">
          <button type="button" className="button" data-testid="export-cancel-dialog" onClick={() => dialogRef.current?.close()}>
            Cancel
          </button>
          <button type="submit" className="button primary" data-testid="export-start">
            Export…
          </button>
        </div>
      </form>
    </dialog>
  )
}
