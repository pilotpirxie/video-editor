import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactElement, type SyntheticEvent } from 'react'
import { DEFAULT_BINDINGS, MAX_KEYS, SHORTCUT_ACTIONS, bindingOf, conflictsOf, hintOf, isSameBinding, reservedBy, type Binding, type ShortcutAction } from '../editor/shortcuts.js'
import { DEFAULT_SETTINGS } from '../shared/settings.js'
import { useSession } from './context.js'
import { EditingSettings, PerformanceSettings } from './AppSettings.js'
import { IconButton } from './icons.js'

const SECTIONS = ['Playback', 'Timeline', 'Editing', 'Drawing', 'File and view'] as const
const TABS = ['Performance', 'Editing', 'Shortcuts'] as const

type SettingsTab = (typeof TABS)[number]

type Section = (typeof SECTIONS)[number]

type Recording = {
  action: ShortcutAction
  slot: number
}

function nameOf(action: ShortcutAction): string {
  return SHORTCUT_ACTIONS.find((entry) => entry.action === action)?.name ?? action
}

export function ShortcutSettings(): ReactElement {
  const { store, shortcuts, changeSettings } = useSession()
  const bindings = useSyncExternalStore(shortcuts.subscribe, shortcuts.get)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [recording, setRecording] = useState<Recording | undefined>(undefined)
  const [refusal, setRefusal] = useState<{ action: ShortcutAction; text: string } | undefined>(undefined)
  const [tab, setTab] = useState<SettingsTab>('Performance')
  const isReleasingRef = useRef(false)
  const conflicts = conflictsOf(bindings)

  useEffect(() => {
    dialogRef.current?.showModal()
  }, [])

  function restoreDefaults(): void {
    shortcuts.set(DEFAULT_BINDINGS)
    changeSettings(DEFAULT_SETTINGS)
  }

  function setKeys(action: ShortcutAction, keys: readonly Binding[]): void {
    shortcuts.set({ ...bindings, [action]: keys })
  }

  function record(next: Recording | undefined): void {
    setRecording(next)
    setRefusal(undefined)
  }

  function showTab(next: SettingsTab): void {
    setTab(next)
    record(undefined)
  }

  function onTabKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
    event.preventDefault()
    const direction = event.key === 'ArrowRight' ? 1 : -1
    const wrappedIndex = (TABS.indexOf(tab) + direction + TABS.length) % TABS.length
    const next = TABS[wrappedIndex]
    if (next !== undefined) showTab(next)
  }

  function onKeyDown(event: KeyboardEvent<HTMLDialogElement>): void {
    if (recording === undefined) return
    event.preventDefault()
    event.stopPropagation()
    if (event.key === 'Escape') {
      record(undefined)
      return
    }
    const pressed = bindingOf(event)
    if (pressed === undefined) return
    const owner = reservedBy(pressed)
    if (owner !== undefined) {
      setRefusal({ action: recording.action, text: `${hintOf(pressed)} belongs to ${owner}.` })
      return
    }
    const keys: Binding[] = []
    for (const [slot, binding] of bindings[recording.action].entries()) {
      if (slot === recording.slot) continue
      if (!isSameBinding(binding, pressed)) keys.push(binding)
    }
    keys.splice(recording.slot, 0, pressed)
    setKeys(recording.action, keys.slice(0, MAX_KEYS))
    record(undefined)
    isReleasingRef.current = true
  }

  function onKeyUp(event: KeyboardEvent<HTMLDialogElement>): void {
    if (!isReleasingRef.current) return
    isReleasingRef.current = false
    event.preventDefault()
  }

  function onCancel(event: SyntheticEvent<HTMLDialogElement>): void {
    if (recording === undefined) return
    event.preventDefault()
    record(undefined)
  }

  function keyButton(action: ShortcutAction, slot: number, binding: Binding | undefined): ReactElement {
    const isRecording = recording?.action === action && recording.slot === slot
    let text = '+ Add keys'
    if (isRecording) text = 'Press keys…'
    else if (binding !== undefined) text = hintOf(binding)
    const change = binding === undefined ? 'add keys' : `change ${hintOf(binding)}`

    function toggleRecording(): void {
      if (isRecording) record(undefined)
      else record({ action, slot })
    }

    function removeKeys(): void {
      const kept = bindings[action].filter((_, index) => index !== slot)
      setKeys(action, kept)
    }

    return (
      <span key={slot} className="shortcut-key">
        <button type="button" className="button" data-testid={`shortcut-${action}-${slot}`} aria-pressed={isRecording} aria-label={`${nameOf(action)}: ${change}`} onClick={toggleRecording}>
          {text}
        </button>
        {binding !== undefined && <IconButton icon="minus" label={`Remove ${hintOf(binding)} from ${nameOf(action)}`} testId={`shortcut-${action}-${slot}-remove`} onClick={removeKeys} />}
      </span>
    )
  }

  function shortcutRows(section: Section): ReactElement[] {
    const rows: ReactElement[] = []
    for (const entry of SHORTCUT_ACTIONS) {
      if (entry.section !== section) continue
      const { action, name } = entry
      const keys = bindings[action]
      const shared = conflicts.get(action)
      const slots = keys.length < MAX_KEYS ? [...keys, undefined] : keys
      rows.push(
        <div key={action} className="shortcut-row" data-testid={`shortcut-${action}`}>
          <span className="shortcut-name">
            {name}
            {shared !== undefined && (
              <span className="badge warning" data-testid={`shortcut-${action}-conflict`}>
                Also {shared.map(nameOf).join(', ')}
              </span>
            )}
          </span>
          <span className="shortcut-keys">{slots.map((binding, slot) => keyButton(action, slot, binding))}</span>
          {refusal?.action === action && (
            <p className="hint" role="alert">
              {refusal.text}
            </p>
          )}
        </div>,
      )
    }
    return rows
  }

  return (
    <dialog ref={dialogRef} className="dialog settings" aria-labelledby="settings-title" data-testid="settings-dialog" onKeyDown={onKeyDown} onKeyUp={onKeyUp} onCancel={onCancel} onClose={() => store.showSettings(false)}>
      <div className="dialog-form">
        <h2 className="dialog-title" id="settings-title">
          Settings
        </h2>
        <div className="tabs" role="tablist" aria-label="Settings" onKeyDown={onTabKeyDown}>
          {TABS.map((name) => (
            <button
              key={name}
              type="button"
              role="tab"
              className="tab focusable"
              aria-selected={tab === name}
              tabIndex={tab === name ? 0 : -1}
              data-testid={`settings-tab-${name.toLowerCase()}`}
              onClick={() => showTab(name)}
            >
              {name}
            </button>
          ))}
        </div>
        <div className="settings-body" role="tabpanel" aria-label={tab}>
          {tab === 'Performance' && <PerformanceSettings />}
          {tab === 'Editing' && <EditingSettings />}
          {tab === 'Shortcuts' && (
            <div className="shortcut-list">
              {SECTIONS.map((section) => (
                <section key={section} aria-label={section}>
                  <h3 className="field-label">{section}</h3>
                  {shortcutRows(section)}
                </section>
              ))}
            </div>
          )}
        </div>
        <div className="dialog-buttons">
          <button type="button" className="button" data-testid="shortcuts-defaults" onClick={restoreDefaults}>
            Restore Defaults
          </button>
          <button type="button" className="button primary" data-testid="settings-done" onClick={() => dialogRef.current?.close()}>
            Done
          </button>
        </div>
      </div>
    </dialog>
  )
}
