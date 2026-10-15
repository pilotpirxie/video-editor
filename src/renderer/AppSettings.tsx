import { useEffect, useRef, useState, type ReactElement } from 'react'
import { logError } from '../shared/log.js'
import type { CacheUsage } from '../shared/mediaProtocol.js'
import { PREVIEW_LONG_SIDES, SETTING_RANGES, type AppSettings } from '../shared/settings.js'
import { useEditorState, useSession } from './context.js'
import type { CacheOffer } from './store.js'
import { NumberField } from './NumberField.js'
import { Picker } from './Picker.js'

const BYTES_PER_GIGABYTE = 1024 ** 3
const SIZE_CHOICES = PREVIEW_LONG_SIDES.map((side) => ({ value: String(side), label: String(side) }))
const CORE_CHOICES = [
  { value: 'all', label: 'All' },
  { value: 'half', label: 'Half' },
]

type NumberKey = keyof typeof SETTING_RANGES

type SettingFieldProps = {
  label: string
  setting: NumberKey
  decimals?: number
  step?: number
  onChange(settings: AppSettings): void
}

// A number of the settings. Scrubbing shows the value as it goes; the change counts once the field lets go.
function SettingField({ label, setting, decimals = 0, step = 1, onChange }: SettingFieldProps): ReactElement {
  const settings = useEditorState((state) => state.settings)
  const [draft, setDraft] = useState<number | undefined>(undefined)
  // A typed value is begun, changed and committed in one go, before the state above is updated.
  const draftRef = useRef<number | undefined>(undefined)
  const { min, max } = SETTING_RANGES[setting]

  function show(value: number | undefined): void {
    draftRef.current = value
    setDraft(value)
  }

  function commit(): void {
    const value = draftRef.current
    show(undefined)
    if (value !== undefined && value !== settings[setting]) onChange({ ...settings, [setting]: value })
  }

  return (
    <NumberField
      label={label}
      testId={`setting-${setting}`}
      value={draft ?? settings[setting]}
      min={min}
      max={max}
      step={step}
      decimals={decimals}
      onBegin={() => show(settings[setting])}
      onChange={show}
      onCommit={commit}
      onCancel={() => show(undefined)}
    />
  )
}

function gigabytes(bytes: number): string {
  return (bytes / BYTES_PER_GIGABYTE).toFixed(1)
}

// The Performance tab of the Settings dialog. The cache in use is read when the tab opens and when the limit changes; a clear reads it again itself.
export function PerformanceSettings(): ReactElement {
  const session = useSession()
  const settings = useEditorState((state) => state.settings)
  const [usage, setUsage] = useState<CacheUsage | undefined>(undefined)
  const [isClearing, setIsClearing] = useState(false)

  async function readUsage(): Promise<void> {
    try {
      setUsage(await session.cacheUsage())
    } catch (error) {
      logError('Could not read how much of the cache is used', error)
    }
  }

  useEffect(() => {
    void readUsage()
  }, [settings.cacheLimitGb])

  async function clear(): Promise<void> {
    setIsClearing(true)
    try {
      await session.clearCache()
    } catch (error) {
      logError('Could not clear the cache', error)
      session.store.notify('Could not clear the cache.')
    }
    setIsClearing(false)
    await readUsage()
  }

  function change(next: AppSettings): void {
    session.changeSettings(next)
  }

  return (
    <>
      <SettingField label="Cache limit (GB)" setting="cacheLimitGb" onChange={change} />
      <div className="field-pair">
        <p className="hint" data-testid="cache-used">
          {usage === undefined ? 'Using …' : `Using ${gigabytes(usage.usedBytes)} GB`}
        </p>
        <button type="button" className="button" data-testid="cache-clear" disabled={isClearing} onClick={() => void clear()}>
          Clear Cache
        </button>
      </div>
      <SettingField label="Remove unused cache after (h)" setting="unusedMediaHours" onChange={change} />
      <Picker label="Playback preview (px)" testId="setting-previewLongSide" choices={SIZE_CHOICES} value={String(settings.previewLongSide)} onChoose={(value) => change({ ...settings, previewLongSide: Number(value) })} />
      <Picker
        label="Preparation cores"
        testId="setting-backgroundCores"
        choices={CORE_CHOICES}
        value={settings.backgroundCores}
        onChoose={(value) => change({ ...settings, backgroundCores: value === 'half' ? 'half' : 'all' })}
      />
    </>
  )
}

// The Editing tab of the Settings dialog.
export function EditingSettings(): ReactElement {
  const session = useSession()
  const settings = useEditorState((state) => state.settings)

  function change(next: AppSettings): void {
    session.changeSettings(next)
  }

  return (
    <>
      <SettingField label="Snap range (px)" setting="snapRangePixels" onChange={change} />
      <label className="check-field">
        <input type="checkbox" data-testid="setting-isSnappingAtLaunch" checked={settings.isSnappingAtLaunch} onChange={(event) => change({ ...settings, isSnappingAtLaunch: event.target.checked })} />
        Snapping on at launch
      </label>
      <SettingField label="Image and annotation duration (s)" setting="stillDurationSeconds" decimals={1} step={0.5} onChange={change} />
      <SettingField label="Autosave every (s)" setting="autosaveSeconds" onChange={change} />
      <SettingField label="Undo steps" setting="undoSteps" step={50} onChange={change} />
    </>
  )
}

// Asked once when a project needs more cache than the limit allows: without it, parts are prepared again each time the playhead comes back.
export function CacheLimitDialog({ neededBytes, offerGb }: CacheOffer): ReactElement {
  const session = useSession()
  const settings = useEditorState((state) => state.settings)
  const dialogRef = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    dialogRef.current?.showModal()
  }, [])

  function raise(): void {
    session.changeSettings({ ...settings, cacheLimitGb: offerGb })
    dialogRef.current?.close()
  }

  return (
    <dialog ref={dialogRef} className="dialog" aria-labelledby="cache-offer-title" data-testid="cache-offer" onClose={() => session.store.offerCacheLimit(undefined)}>
      <div className="dialog-form">
        <h2 className="dialog-title" id="cache-offer-title">
          Cache too small
        </h2>
        <p className="dialog-summary">
          This project needs about {Math.ceil(neededBytes / BYTES_PER_GIGABYTE)} GB of cache. The limit is {settings.cacheLimitGb} GB, so parts of it are prepared again as you move around.
        </p>
        <div className="dialog-buttons">
          <button type="button" className="button" data-testid="cache-offer-keep" onClick={() => dialogRef.current?.close()}>
            Keep {settings.cacheLimitGb} GB
          </button>
          <button type="button" className="button primary" data-testid="cache-offer-raise" onClick={raise}>
            Raise to {offerGb} GB
          </button>
        </div>
      </div>
    </dialog>
  )
}
