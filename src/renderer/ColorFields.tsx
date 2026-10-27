import { useRef, useState, type HTMLAttributes, type KeyboardEvent, type PointerEvent, type ReactElement } from 'react'
import { locateClip } from '../editor/clips.js'
import { hexInput, hexOf, partsOf, type ColorParts } from '../editor/colors.js'
import { findShape, setShapeColor, type ColorPart } from '../editor/drawings.js'
import { useEditorState, useSession } from './context.js'
import { NumberField } from './NumberField.js'

const PARTS: readonly { part: ColorPart; label: string }[] = [
  { part: 'fill', label: 'Fill' },
  { part: 'stroke', label: 'Stroke' },
]
const FULL_TURN = 360
const PERCENT = 100
const HUE_STOPS = [0, 60, 120, 180, 240, 300, 360]
const SPECTRUM = `linear-gradient(to right, ${HUE_STOPS.map((hue) => `hsl(${hue} 100% 50%)`).join(', ')})`
const OPAQUE_HEX_LENGTH = 7

type Range = {
  min: number
  max: number
}

type Drag = {
  left: number
  top: number
  width: number
  height: number
}

// The first chosen shape's colours, or the colours new shapes get when no shape is chosen.
export function useWellColors(): Record<ColorPart, string | undefined> {
  const project = useEditorState((state) => state.project)
  const selectedShapes = useEditorState((state) => state.selectedShapes)
  const drawingStyle = useEditorState((state) => state.drawingStyle)
  const first = selectedShapes[0]
  if (first === undefined) return { fill: drawingStyle.fill, stroke: drawingStyle.stroke.color }
  const clip = locateClip(project, first.clipId)?.clip
  const shape = clip?.type === 'drawing' ? findShape(clip.shapes, first.shapeId) : undefined
  return { fill: shape?.fill, stroke: shape?.stroke?.color }
}

function share(value: number, range: Range): number {
  return (value - range.min) / (range.max - range.min)
}

function hsl(parts: ColorParts, changes: Partial<ColorParts> = {}): string {
  const { hue, saturation, lightness, opacity } = { ...parts, ...changes }
  return `hsl(${hue} ${saturation}% ${lightness}% / ${opacity / PERCENT})`
}

function boxOf(element: Element): Drag {
  const box = element.getBoundingClientRect()
  return { left: box.left, top: box.top, width: Math.max(1, box.width), height: Math.max(1, box.height) }
}

function clampedShare(offset: number, length: number): number {
  return Math.min(1, Math.max(0, offset / length))
}

type GestureProps = {
  onBegin(): void
  onCommit(): void
  onCancel(): void
}

type DragHandlers = Pick<HTMLAttributes<HTMLDivElement>, 'onPointerDown' | 'onPointerMove' | 'onPointerUp' | 'onPointerCancel' | 'onLostPointerCapture'>

// A press or drag anywhere in the area is one gesture, measured against the area's box at the press.
function useAreaDrag(gesture: GestureProps, onPoint: (event: PointerEvent<HTMLDivElement>, drag: Drag) => void): DragHandlers {
  const dragRef = useRef<Drag | undefined>(undefined)

  function endDrag(finish: () => void): void {
    if (dragRef.current === undefined) return
    dragRef.current = undefined
    finish()
  }

  return {
    onPointerDown(event) {
      if (event.button !== 0) return
      event.currentTarget.setPointerCapture(event.pointerId)
      const drag = boxOf(event.currentTarget)
      dragRef.current = drag
      gesture.onBegin()
      onPoint(event, drag)
    },
    onPointerMove(event) {
      const drag = dragRef.current
      if (drag !== undefined) onPoint(event, drag)
    },
    onPointerUp: () => endDrag(gesture.onCommit),
    onPointerCancel: () => endDrag(gesture.onCancel),
    onLostPointerCapture: () => endDrag(gesture.onCommit),
  }
}

type SliderTrackProps = GestureProps & {
  testId: string
  value: number
  range: Range
  background: string
  onChange(value: number): void
}

// The number field beside it is the way in for the keyboard.
function SliderTrack({ testId, value, range, background, onChange, ...gesture }: SliderTrackProps): ReactElement {
  const handlers = useAreaDrag(gesture, (event, drag) => {
    onChange(Math.round(range.min + clampedShare(event.clientX - drag.left, drag.width) * (range.max - range.min)))
  })
  return (
    <div className="slider-track" aria-hidden="true" data-testid={testId} style={{ background }} {...handlers}>
      <span className="slider-knob" style={{ left: `${share(value, range) * PERCENT}%` }} />
    </div>
  )
}

type HslFieldProps = GestureProps & {
  parts: ColorParts
  onChange(parts: ColorParts): void
}

// Hue runs across and lightness down at full saturation, so a pick is the exact colour under the pointer; it would be all grey at the saturation of a grey.
function HslField({ parts, onChange, ...gesture }: HslFieldProps): ReactElement {
  const shades = 'linear-gradient(to bottom, hsl(0 0% 100%), hsl(0 0% 100% / 0) 50%, hsl(0 0% 0% / 0) 50%, hsl(0 0% 0%))'
  const handlers = useAreaDrag(gesture, (event, drag) => {
    const hue = Math.round(clampedShare(event.clientX - drag.left, drag.width) * FULL_TURN)
    const lightness = Math.round((1 - clampedShare(event.clientY - drag.top, drag.height)) * PERCENT)
    onChange({ ...parts, hue, saturation: PERCENT, lightness })
  })
  return (
    <div
      className="hsl-field"
      role="img"
      aria-label="Hue and lightness"
      data-testid="colour-field"
      style={{ background: `${shades}, ${SPECTRUM}` }}
      {...handlers}
    >
      <span className="slider-knob" style={{ left: `${(parts.hue / FULL_TURN) * PERCENT}%`, top: `${PERCENT - parts.lightness}%` }} />
    </div>
  )
}

// Edits the chosen shapes as one undo step per drag, and the result becomes the colour for new shapes; with no shape chosen it sets only that colour.
export function ColorFields(): ReactElement {
  const { store } = useSession()
  const part = useEditorState((state) => state.colorPart)
  const selectedShapes = useEditorState((state) => state.selectedShapes)
  const drawingStyle = useEditorState((state) => state.drawingStyle)
  const wells = useWellColors()
  const [hexDraft, setHexDraft] = useState<string | undefined>(undefined)
  const [remembered, setRemembered] = useState<ColorParts | undefined>(undefined)
  const pendingRef = useRef<string | undefined>(undefined)
  const current = part === 'fill' ? drawingStyle.fill : drawingStyle.stroke.color
  const shown = wells[part] ?? current
  // Keeps the hue and saturation a grey would lose, for as long as they still make the colour shown.
  const parts = remembered !== undefined && hexOf(remembered) === shown ? remembered : partsOf(shown)
  const isEditingShapes = selectedShapes.length > 0

  function begin(): void {
    if (isEditingShapes) store.begin(part === 'fill' ? 'Change Fill' : 'Change Stroke')
  }

  function change(next: ColorParts): void {
    setRemembered(next)
    const color = hexOf(next)
    pendingRef.current = color
    if (isEditingShapes) store.update((project) => setShapeColor(project, selectedShapes, part, color))
    else store.setDrawingColor(part, color)
  }

  function commit(): void {
    if (isEditingShapes) store.commit()
    const color = pendingRef.current
    pendingRef.current = undefined
    if (color !== undefined) store.setDrawingColor(part, color)
  }

  function cancel(): void {
    pendingRef.current = undefined
    if (isEditingShapes) store.cancel()
  }

  function applyHex(): void {
    const typed = hexDraft === undefined ? undefined : hexInput(hexDraft)
    setHexDraft(undefined)
    if (typed === undefined || typed === shown.slice(0, OPAQUE_HEX_LENGTH)) return
    begin()
    change({ ...partsOf(typed), opacity: parts.opacity })
    commit()
  }

  function onHexKey(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Enter') event.currentTarget.blur()
    if (event.key === 'Escape') setHexDraft(undefined)
  }

  const gesture: GestureProps = { onBegin: begin, onCommit: commit, onCancel: cancel }
  const sliders: readonly { key: keyof ColorParts; label: string; range: Range; background: string }[] = [
    { key: 'hue', label: 'Hue (°)', range: { min: 0, max: FULL_TURN }, background: SPECTRUM },
    { key: 'saturation', label: 'Saturation (%)', range: { min: 0, max: PERCENT }, background: `linear-gradient(to right, ${hsl(parts, { saturation: 0, opacity: PERCENT })}, ${hsl(parts, { saturation: PERCENT, opacity: PERCENT })})` },
    { key: 'lightness', label: 'Lightness (%)', range: { min: 0, max: PERCENT }, background: `linear-gradient(to right, hsl(0 0% 0%), ${hsl(parts, { lightness: PERCENT / 2, opacity: PERCENT })}, hsl(0 0% 100%))` },
    { key: 'opacity', label: 'Opacity (%)', range: { min: 0, max: PERCENT }, background: `linear-gradient(to right, ${hsl(parts, { opacity: 0 })}, ${hsl(parts, { opacity: PERCENT })})` },
  ]

  return (
    <>
      <div className="segmented wide colour-wells" role="group" aria-label="Colour of">
        {PARTS.map((each) => (
          <button key={each.part} type="button" className="button" data-testid={`colour-${each.part}`} aria-pressed={part === each.part} onClick={() => store.setColorPart(each.part)}>
            <span className={wells[each.part] === undefined ? 'colour-chip none' : 'colour-chip'} style={{ background: wells[each.part] }} />
            {each.label}
          </button>
        ))}
      </div>
      <HslField parts={parts} {...gesture} onChange={change} />
      {sliders.map(({ key, label, range, background }) => (
        <NumberField
          key={key}
          label={label}
          testId={`colour-${key}`}
          value={parts[key]}
          min={range.min}
          max={range.max}
          track={<SliderTrack testId={`colour-${key}-track`} value={parts[key]} range={range} background={background} {...gesture} onChange={(value) => change({ ...parts, [key]: value })} />}
          {...gesture}
          onChange={(value) => change({ ...parts, [key]: value })}
        />
      ))}
      <label className="labelled">
        <span className="field-label">Hex</span>
        <input
          className="field"
          type="text"
          spellCheck={false}
          data-testid="colour-hex"
          value={hexDraft ?? shown.slice(0, OPAQUE_HEX_LENGTH)}
          onChange={(event) => setHexDraft(event.target.value)}
          onKeyDown={onHexKey}
          onBlur={applyHex}
        />
      </label>
    </>
  )
}
