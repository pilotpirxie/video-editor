import { useEffectEvent, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactElement } from 'react'
import { Icon } from './icons.js'
import { closeOnTurningAway } from './Menu.js'

const GAP = 2
const EDGE_GAP = 8
const MAX_HEIGHT = 320
const TYPE_AHEAD_MS = 700

export type Choice = {
  value: string
  label: string
  // Printed above this option when it starts a new part of the list.
  heading?: string
}

type OptionListProps = {
  label: string
  testId: string
  choices: readonly Choice[]
  chosen: string | undefined
  // The option under the pointer or reached with the arrow keys: the caller may show what choosing it would do.
  onPreview?(value: string): void
  onChoose(value: string): void
  // Closed without a choice. `isByKey` tells the caller to take the focus back.
  onClose(isByKey: boolean): void
}

// The list of a drop-down, on the browser's top layer so no panel or dialog cuts it off. It opens under the element that holds it.
// Pointing at an option and moving to it with the arrow keys are the same thing: both give it the focus.
export function OptionList({ label, testId, choices, chosen, onPreview, onChoose, onClose }: OptionListProps): ReactElement {
  const listRef = useRef<HTMLDivElement>(null)
  const isDoneRef = useRef(false)
  const typedRef = useRef({ text: '', at: 0 })
  const previewedRef = useRef(chosen)
  // The mark stays on the value the list opened with while previews change the value around it.
  const [chosenAtOpen] = useState(chosen)

  // A choice or a close is reported once: a release on an option is followed by its click, and whatever closes the list may happen twice.
  function finish(report: () => void): void {
    if (isDoneRef.current) return
    isDoneRef.current = true
    report()
  }

  const closeWithoutChoice = useEffectEvent(() => finish(() => onClose(false)))

  useLayoutEffect(() => {
    const list = listRef.current
    const anchor = list?.parentElement
    if (list === null || anchor === null || anchor === undefined) return
    list.showPopover()
    const box = anchor.getBoundingClientRect()
    const roomBelow = window.innerHeight - box.bottom - GAP - EDGE_GAP
    const roomAbove = box.top - GAP - EDGE_GAP
    const opensBelow = Math.min(MAX_HEIGHT, list.scrollHeight) <= roomBelow || roomBelow >= roomAbove
    list.style.minWidth = `${box.width}px`
    list.style.maxHeight = `${Math.min(MAX_HEIGHT, opensBelow ? roomBelow : roomAbove)}px`
    list.style.left = `${Math.max(EDGE_GAP, Math.min(box.left, window.innerWidth - list.offsetWidth - EDGE_GAP))}px`
    // Held by the edge next to the field, so a list that fills up after it opened grows away from the field.
    if (opensBelow) list.style.top = `${box.bottom + GAP}px`
    else list.style.bottom = `${window.innerHeight - box.top + GAP}px`
    const start = list.querySelector<HTMLElement>('[aria-selected="true"]') ?? list.querySelector<HTMLElement>('[role="option"]')
    // Opening the list is not yet pointing at anything in it.
    previewedRef.current = start?.dataset.value
    start?.focus()
    return closeOnTurningAway(list, closeWithoutChoice)
  }, [])

  // A list that fills up after it opened, as the list of fonts may, keeps the option it opened on in view.
  useLayoutEffect(() => {
    const focused = document.activeElement
    const isInList = focused instanceof HTMLElement && listRef.current?.contains(focused) === true
    if (isInList) focused.scrollIntoView({ block: 'nearest' })
  }, [choices.length])

  function preview(value: string): void {
    if (value === previewedRef.current) return
    previewedRef.current = value
    onPreview?.(value)
  }

  // Letters typed quickly one after another find the first option that starts with them, as in the system's menus.
  function optionTyped(options: readonly HTMLElement[], event: KeyboardEvent<HTMLDivElement>): HTMLElement | undefined {
    const typed = typedRef.current
    const isContinuing = event.timeStamp - typed.at < TYPE_AHEAD_MS
    typed.text = isContinuing ? typed.text + event.key : event.key
    typed.at = event.timeStamp
    const wanted = typed.text.toLowerCase()
    return options.find((option) => option.textContent.toLowerCase().startsWith(wanted))
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape' || event.key === 'Tab') {
      // Handled here, so Escape closes this list and not the dialog around it.
      event.preventDefault()
      finish(() => onClose(true))
      return
    }
    const options = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="option"]')]
    const index = options.findIndex((option) => option === document.activeElement)
    const isLetter = event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey
    const isMidWord = event.timeStamp - typedRef.current.at < TYPE_AHEAD_MS
    let target: HTMLElement | undefined
    if (event.key === 'ArrowDown') target = options[Math.min(index + 1, options.length - 1)]
    else if (event.key === 'ArrowUp') target = options[Math.max(index - 1, 0)]
    else if (event.key === 'Home') target = options[0]
    else if (event.key === 'End') target = options.at(-1)
    else if (isLetter && (event.key !== ' ' || isMidWord)) target = optionTyped(options, event)
    else return
    event.preventDefault()
    target?.focus()
  }

  return (
    <div ref={listRef} popover="manual" className="options" role="listbox" aria-label={label} data-testid={`${testId}-options`} onKeyDown={onKeyDown}>
      {choices.map((choice) => (
        <div key={choice.value} role="presentation">
          {choice.heading !== undefined && <div className="options-heading">{choice.heading}</div>}
          <button
            type="button"
            role="option"
            className="option"
            aria-selected={choice.value === chosenAtOpen}
            data-value={choice.value}
            data-testid={`${testId}-option-${choice.value}`}
            // Hovering an option that is half out of view must not scroll the list under the pointer.
            onPointerMove={(event) => event.currentTarget.focus({ preventScroll: true })}
            onFocus={() => preview(choice.value)}
            // A press on the field, a drag down the list and a release choose in one movement; a click does so for the keyboard.
            onPointerUp={(event) => {
              if (event.button === 0) finish(() => onChoose(choice.value))
            }}
            onClick={() => finish(() => onChoose(choice.value))}
          >
            <Icon name="check" />
            {choice.label}
          </button>
        </div>
      ))}
    </div>
  )
}

type PickerProps = {
  label: string
  testId: string
  choices: readonly Choice[]
  // Undefined means the selected clips do not agree on a value.
  value: string | undefined
  // Shown instead of "Mixed" for a list that picks an action rather than a value.
  placeholder?: string
  onPreview?(value: string): void
  onChoose(value: string): void
  // Closed without a choice: whatever was previewed is to be put back.
  onClose?(): void
}

// One value out of a list. It opens on the press, not on the release, and looks the same wherever it is used.
export function Picker({ label, testId, choices, value, placeholder, onPreview, onChoose, onClose }: PickerProps): ReactElement {
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [isOpen, setIsOpen] = useState(false)
  const shown = choices.find((choice) => choice.value === value)

  function onPointerDown(event: PointerEvent<HTMLButtonElement>): void {
    if (event.button !== 0) return
    // The list takes the focus as it opens; the press must not hand it back to this button.
    event.preventDefault()
    // A press while the list is open has already closed it, as any press outside the list does.
    if (!isOpen) setIsOpen(true)
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'ArrowDown') return
    event.preventDefault()
    setIsOpen(true)
  }

  return (
    <div className="field-box">
      <button
        ref={buttonRef}
        type="button"
        className="field picker"
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        data-testid={testId}
        value={value ?? ''}
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
      >
        <span className="picker-value">{shown?.label ?? value ?? placeholder ?? 'Mixed'}</span>
        <Icon name="chevronDown" />
      </button>
      {isOpen && (
        <OptionList
          label={label}
          testId={testId}
          choices={choices}
          chosen={value}
          onPreview={onPreview}
          onChoose={(chosen) => {
            setIsOpen(false)
            buttonRef.current?.focus()
            onChoose(chosen)
          }}
          onClose={(isByKey) => {
            setIsOpen(false)
            if (isByKey) buttonRef.current?.focus()
            onClose?.()
          }}
        />
      )}
    </div>
  )
}
