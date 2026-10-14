import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactElement, type SyntheticEvent } from 'react'
import { DEFAULT_BINDINGS, MAX_KEYS, SHORTCUT_ACTIONS, bindingOf, conflictsOf, hintOf, isSameBinding, reservedBy, type Binding, type ShortcutAction } from '../editor/shortcuts.js'
import { useSession } from './context.js'
import { IconButton } from './icons.js'

const SECTIONS = ['Playback', 'Timeline', 'Editing', 'File and view'] as const

// The key of an action that is waiting for its new keys: an existing one, or, at the end of the list, a new one.
type Recording = {
  action: ShortcutAction
  slot: number
}

function nameOf(action: ShortcutAction): string {
  return SHORTCUT_ACTIONS.find((entry) => entry.action === action)?.name ?? action
}

// Every action that can be given keys, with up to two keys each. A key is changed by pressing its button and then the new keys; changes count at once and are kept on this Mac.
export function ShortcutSettings(): ReactElement {
  const { store, shortcuts } = useSession()
  const bindings = useSyncExternalStore(shortcuts.subscribe, shortcuts.get)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [recording, setRecording] = useState<Recording | undefined>(undefined)
  const [refusal, setRefusal] = useState<{ action: ShortcutAction; text: string } | undefined>(undefined)
  // A key that was just recorded is also let go: Space and Enter would then press the focused button and start recording again.
  const isReleasingRef = useRef(false)
  const conflicts = conflictsOf(bindings)

  useEffect(() => {
    dialogRef.current?.showModal()
  }, [])

  function setKeys(action: ShortcutAction, keys: readonly Binding[]): void {
    shortcuts.set({ ...bindings, [action]: keys })
  }

  function record(next: Recording | undefined): void {
    setRecording(next)
    setRefusal(undefined)
  }

  function onKeyDown(event: KeyboardEvent<HTMLDialogElement>): void {
    if (recording === undefined) return
    event.preventDefault()
    event.stopPropagation()
    if (event.key === 'Escape') {
      record(undefined)
      return
    }
    // A modifier on its own is the start of the keys, not all of them.
    const pressed = bindingOf(event)
    if (pressed === undefined) return
    const owner = reservedBy(pressed)
    if (owner !== undefined) {
      setRefusal({ action: recording.action, text: `${hintOf(pressed)} belongs to ${owner}.` })
      return
    }
    const current = bindings[recording.action]
    const others = current.filter((binding, slot) => slot !== recording.slot && !isSameBinding(binding, pressed))
    const keys = [...others.slice(0, recording.slot), pressed, ...others.slice(recording.slot)]
    setKeys(recording.action, keys.slice(0, MAX_KEYS))
    record(undefined)
    isReleasingRef.current = true
  }

  function onKeyUp(event: KeyboardEvent<HTMLDialogElement>): void {
    if (!isReleasingRef.current) return
    isReleasingRef.current = false
    event.preventDefault()
  }

  // Escape stops the recording, and only without one does it close the dialog.
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
    return (
      <span key={slot} className="shortcut-key">
        <button type="button" className="button" data-testid={`shortcut-${action}-${slot}`} aria-pressed={isRecording} aria-label={`${nameOf(action)}: ${binding === undefined ? 'add keys' : `change ${hintOf(binding)}`}`} onClick={() => record(isRecording ? undefined : { action, slot })}>
          {text}
        </button>
        {binding !== undefined && (
          <IconButton icon="minus" label={`Remove ${hintOf(binding)} from ${nameOf(action)}`} testId={`shortcut-${action}-${slot}-remove`} onClick={() => setKeys(action, bindings[action].filter((_, index) => index !== slot))} />
        )}
      </span>
    )
  }

  return (
    <dialog ref={dialogRef} className="dialog settings" aria-labelledby="settings-title" data-testid="settings-dialog" onKeyDown={onKeyDown} onKeyUp={onKeyUp} onCancel={onCancel} onClose={() => store.showSettings(false)}>
      <div className="dialog-form">
        <h2 className="dialog-title" id="settings-title">
          Keyboard Shortcuts
        </h2>
        <p className="dialog-summary">Press a key to change it, then press the new keys. Two actions can share keys, but only the first in the list answers to them.</p>
        <div className="shortcut-list">
          {SECTIONS.map((section) => (
            <section key={section} aria-label={section}>
              <h3 className="field-label">{section}</h3>
              {SHORTCUT_ACTIONS.filter((entry) => entry.section === section).map(({ action, name }) => {
                const keys = bindings[action]
                const shared = conflicts.get(action)
                const slots = keys.length < MAX_KEYS ? [...keys, undefined] : keys
                return (
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
                  </div>
                )
              })}
            </section>
          ))}
        </div>
        <div className="dialog-buttons">
          <button type="button" className="button" data-testid="shortcuts-defaults" onClick={() => shortcuts.set(DEFAULT_BINDINGS)}>
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
