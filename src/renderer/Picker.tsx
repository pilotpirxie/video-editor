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
  heading?: string
}

type OptionListProps = {
  label: string
  testId: string
  choices: readonly Choice[]
  chosen: string | undefined
  onPreview?(value: string): void
  onChoose(value: string): void
  onClose(isByKey: boolean): void
}

export function OptionList({ label, testId, choices, chosen, onPreview, onChoose, onClose }: OptionListProps): ReactElement {
  const listRef = useRef<HTMLDivElement>(null)
  const isDoneRef = useRef(false)
  const typedRef = useRef({ text: '', at: 0 })
  const previewedRef = useRef(chosen)
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
    if (opensBelow) list.style.top = `${box.bottom + GAP}px`
    else list.style.bottom = `${window.innerHeight - box.top + GAP}px`
    const start = list.querySelector<HTMLElement>('[aria-selected="true"]') ?? list.querySelector<HTMLElement>('[role="option"]')
    previewedRef.current = start?.dataset.value
    start?.focus()
    return closeOnTurningAway(list, closeWithoutChoice)
  }, [])

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
            onPointerMove={(event) => event.currentTarget.focus({ preventScroll: true })}
            onFocus={() => preview(choice.value)}
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
  value: string | undefined
  placeholder?: string
  onPreview?(value: string): void
  onChoose(value: string): void
  onClose?(): void
}

export function Picker({ label, testId, choices, value, placeholder, onPreview, onChoose, onClose }: PickerProps): ReactElement {
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [isOpen, setIsOpen] = useState(false)
  const shown = choices.find((choice) => choice.value === value)

  function onPointerDown(event: PointerEvent<HTMLButtonElement>): void {
    if (event.button !== 0) return
    event.preventDefault()
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
