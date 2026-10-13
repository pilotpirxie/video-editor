import { useId, useRef, useState, type ChangeEvent, type KeyboardEvent, type PointerEvent, type ReactElement } from 'react'
import { Icon } from './icons.js'
import { OptionList } from './Picker.js'

const BIG_STEP_FACTOR = 10

type NumberFieldProps = {
  label: string
  // Undefined means the selected clips do not agree on a value.
  value: number | undefined
  min: number
  max: number
  step?: number
  decimals?: number
  // Ready-made values, offered in a list that opens from the arrow at the end of the field.
  presets?: readonly number[]
  testId: string
  isDisabled?: boolean
  onBegin(): void
  onChange(value: number): void
  onCommit(): void
  onCancel(): void
}

type Scrub = {
  pointerX: number
  value: number
  hasMoved: boolean
}

// A typed value, an arrow key, a scrub and a ready-made value are each one undo step; while scrubbing or pointing at a ready-made value, every intermediate value is passed on so the canvas follows.
export function NumberField(props: NumberFieldProps): ReactElement {
  const { label, value, min, max, testId, presets } = props
  const step = props.step ?? 1
  const decimals = props.decimals ?? 0
  const inputId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const [isListOpen, setIsListOpen] = useState(false)
  const isPreviewingRef = useRef(false)
  const [draft, setDraft] = useState<string | undefined>(undefined)
  // Enter applies the text and then leaves the field, which asks to apply it again; the ref makes the second request see it is already done.
  const draftRef = useRef<string | undefined>(undefined)
  const scrubRef = useRef<Scrub | undefined>(undefined)

  function setDraftText(text: string | undefined): void {
    draftRef.current = text
    setDraft(text)
  }

  function limited(next: number): number {
    return Math.min(max, Math.max(min, Number(next.toFixed(decimals))))
  }

  function applyOnce(next: number): void {
    props.onBegin()
    props.onChange(limited(next))
    props.onCommit()
  }

  function applyDraft(): void {
    const text = draftRef.current
    setDraftText(undefined)
    if (text === undefined || text.trim() === '') return
    const typed = Number(text)
    if (!Number.isFinite(typed) || limited(typed) === value) return
    applyOnce(typed)
  }

  function previewPreset(preset: string): void {
    if (!isPreviewingRef.current) props.onBegin()
    isPreviewingRef.current = true
    props.onChange(limited(Number(preset)))
  }

  function choosePreset(preset: string): void {
    previewPreset(preset)
    isPreviewingRef.current = false
    props.onCommit()
    setIsListOpen(false)
    inputRef.current?.focus()
  }

  function closePresets(isByKey: boolean): void {
    setIsListOpen(false)
    if (isPreviewingRef.current) props.onCancel()
    isPreviewingRef.current = false
    if (isByKey) inputRef.current?.focus()
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'ArrowDown' && event.altKey && presets !== undefined) {
      event.preventDefault()
      setIsListOpen(true)
      return
    }
    if (event.key === 'Enter') {
      applyDraft()
      // With the field left, the next Cmd+Z undoes the edit instead of the typing.
      event.currentTarget.blur()
    } else if (event.key === 'Escape') {
      setDraftText(undefined)
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault()
      const direction = event.key === 'ArrowUp' ? 1 : -1
      const amount = event.shiftKey ? step * BIG_STEP_FACTOR : step
      setDraftText(undefined)
      applyOnce((value ?? min) + direction * amount)
    }
  }

  function onScrubStart(event: PointerEvent<HTMLLabelElement>): void {
    if (props.isDisabled === true || value === undefined) return
    event.currentTarget.setPointerCapture(event.pointerId)
    scrubRef.current = { pointerX: event.clientX, value, hasMoved: false }
  }

  function onScrubMove(event: PointerEvent<HTMLLabelElement>): void {
    const scrub = scrubRef.current
    if (scrub === undefined) return
    const distance = event.clientX - scrub.pointerX
    if (distance === 0 && !scrub.hasMoved) return
    if (!scrub.hasMoved) props.onBegin()
    scrub.hasMoved = true
    props.onChange(limited(scrub.value + distance * step))
  }

  function endScrub(finish: () => void): void {
    const scrub = scrubRef.current
    scrubRef.current = undefined
    if (scrub?.hasMoved === true) finish()
  }

  return (
    <div className="labelled">
      <label
        className="field-label scrub"
        htmlFor={inputId}
        onPointerDown={onScrubStart}
        onPointerMove={onScrubMove}
        onPointerUp={() => endScrub(props.onCommit)}
        onPointerCancel={() => endScrub(props.onCancel)}
        onLostPointerCapture={() => endScrub(props.onCommit)}
      >
        {label}
      </label>
      <div className="field-box">
        <input
          ref={inputRef}
          id={inputId}
          className="field"
          type="text"
          inputMode="decimal"
          role={presets === undefined ? undefined : 'combobox'}
          aria-haspopup={presets === undefined ? undefined : 'listbox'}
          aria-expanded={presets === undefined ? undefined : isListOpen}
          data-testid={testId}
          disabled={props.isDisabled}
          placeholder={value === undefined ? 'Mixed' : undefined}
          value={draft ?? value?.toFixed(decimals) ?? ''}
          onChange={(event: ChangeEvent<HTMLInputElement>) => setDraftText(event.target.value)}
          onKeyDown={onKeyDown}
          onBlur={applyDraft}
        />
        {presets !== undefined && (
          <button
            type="button"
            className="field-arrow"
            tabIndex={-1}
            aria-label={`${label}: ready-made values`}
            data-testid={`${testId}-presets`}
            disabled={props.isDisabled}
            onPointerDown={(event) => {
              // The list takes the focus as it opens; a press while it is open has already closed it.
              event.preventDefault()
              if (!isListOpen) setIsListOpen(true)
            }}
          >
            <Icon name="chevronDown" />
          </button>
        )}
        {presets !== undefined && isListOpen && (
          <OptionList
            label={label}
            testId={testId}
            choices={presets.map((preset) => ({ value: String(preset), label: String(preset) }))}
            chosen={value === undefined ? undefined : String(Number(value.toFixed(decimals)))}
            onPreview={previewPreset}
            onChoose={choosePreset}
            onClose={closePresets}
          />
        )}
      </div>
    </div>
  )
}
