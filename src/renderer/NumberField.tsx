import { useRef, useState, type ChangeEvent, type KeyboardEvent, type PointerEvent, type ReactElement } from 'react'

const BIG_STEP_FACTOR = 10

type NumberFieldProps = {
  label: string
  // Undefined means the selected clips do not agree on a value.
  value: number | undefined
  min: number
  max: number
  step?: number
  decimals?: number
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

// A typed value, an arrow key and a scrub are each one undo step; while scrubbing, every intermediate value is passed on so the canvas follows.
export function NumberField(props: NumberFieldProps): ReactElement {
  const { label, value, min, max, testId } = props
  const step = props.step ?? 1
  const decimals = props.decimals ?? 0
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

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
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

  function onScrubStart(event: PointerEvent<HTMLSpanElement>): void {
    if (props.isDisabled === true || value === undefined) return
    event.currentTarget.setPointerCapture(event.pointerId)
    scrubRef.current = { pointerX: event.clientX, value, hasMoved: false }
  }

  function onScrubMove(event: PointerEvent<HTMLSpanElement>): void {
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
    <label className="number-field">
      <span
        className="number-field-label"
        onPointerDown={onScrubStart}
        onPointerMove={onScrubMove}
        onPointerUp={() => endScrub(props.onCommit)}
        onPointerCancel={() => endScrub(props.onCancel)}
        onLostPointerCapture={() => endScrub(props.onCommit)}
      >
        {label}
      </span>
      <input
        className="field"
        type="text"
        inputMode="decimal"
        data-testid={testId}
        disabled={props.isDisabled}
        placeholder={value === undefined ? 'Mixed' : undefined}
        value={draft ?? value?.toFixed(decimals) ?? ''}
        onChange={(event: ChangeEvent<HTMLInputElement>) => setDraftText(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={applyDraft}
      />
    </label>
  )
}
