import { useCallback, useRef, useState, type HTMLAttributes, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactElement } from 'react'
import { hexInput, hexOf, partsOf, type ColorParts } from '../editor/colors.js'
import { NEW_STROKE, addSwatch, deleteSwatch, nextSwatchName, renameSwatch, setShapeColor, setSwatchColor, shapeAt, styleIn, type ColorPart } from '../editor/drawings.js'
import type { Swatch } from '../shared/project.js'
import { useEditorState, useSession } from './context.js'
import { IconButton } from './icons.js'
import { PopupMenu } from './Menu.js'
import { NumberField } from './NumberField.js'
import type { Edit } from './store.js'

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

type ShownColors = Record<ColorPart, string | undefined> & {
  swatchIds: Record<ColorPart, string | undefined>
}

// The first chosen shape's colours, or the colours new shapes get when no shape is chosen, with the swatches they use.
function useShownColors(): ShownColors {
  const project = useEditorState((state) => state.project)
  const selectedShapes = useEditorState((state) => state.selectedShapes)
  const drawingStyle = useEditorState((state) => state.drawingStyle)
  const first = selectedShapes[0]
  if (first === undefined) {
    const style = styleIn(drawingStyle, project.swatches)
    return { fill: style.fill, stroke: style.stroke?.color, swatchIds: { fill: style.fillSwatch, stroke: style.stroke?.swatch } }
  }
  const shape = shapeAt(project, first)
  return { fill: shape?.fill, stroke: shape?.stroke?.color, swatchIds: { fill: shape?.fillSwatch, stroke: shape?.stroke?.swatch } }
}

export function useWellColors(): Record<ColorPart, string | undefined> {
  const { fill, stroke } = useShownColors()
  return { fill, stroke }
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

type DraftFieldProps = {
  label: string
  testId: string
  value: string
  onApply(text: string): void
}

// Applies what was typed on Enter or on leaving the field; Escape puts the value back.
export function DraftField({ label, testId, value, onApply }: DraftFieldProps): ReactElement {
  const [draft, setDraft] = useState<string | undefined>(undefined)

  function apply(): void {
    setDraft(undefined)
    if (draft !== undefined && draft !== value) onApply(draft)
  }

  function onKey(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Enter') event.currentTarget.blur()
    if (event.key === 'Escape') setDraft(undefined)
  }

  return (
    <label className="labelled">
      <span className="field-label">{label}</span>
      <input className="field" type="text" spellCheck={false} data-testid={testId} value={draft ?? value} onChange={(event) => setDraft(event.target.value)} onKeyDown={onKey} onBlur={apply} />
    </label>
  )
}

type SwatchMenu = {
  at: { x: number; y: number }
  swatchId: string
}

// Edits the chosen shapes as one undo step per drag, and the result becomes the colour for new shapes; with no shape chosen it sets only that colour.
// A colour linked to a swatch edits the swatch, and with it every shape of the file that uses it.
export function ColorFields(): ReactElement {
  const { store } = useSession()
  const part = useEditorState((state) => state.colorPart)
  const selectedShapes = useEditorState((state) => state.selectedShapes)
  const swatches = useEditorState((state) => state.project.swatches)
  const drawingStyle = useEditorState((state) => state.drawingStyle)
  const shownColors = useShownColors()
  const [remembered, setRemembered] = useState<ColorParts | undefined>(undefined)
  const [menu, setMenu] = useState<SwatchMenu | undefined>(undefined)
  const pendingRef = useRef<string | undefined>(undefined)
  const current = part === 'fill' ? drawingStyle.fill : (drawingStyle.stroke?.color ?? NEW_STROKE.color)
  const shown = shownColors[part] ?? current
  const linked = swatches?.find((swatch) => swatch.id === shownColors.swatchIds[part])
  // Keeps the hue and saturation a grey would lose, for as long as they still make the colour shown.
  const parts = remembered !== undefined && hexOf(remembered) === shown ? remembered : partsOf(shown)
  const isEditingShapes = selectedShapes.length > 0
  const isStep = linked !== undefined || isEditingShapes
  const closeMenu = useCallback(() => setMenu(undefined), [])

  function applyToFile(label: string, edit: Edit): void {
    store.begin(label)
    store.updateFile(edit)
    store.commit()
  }

  function begin(): void {
    if (linked !== undefined) store.begin('Change Swatch')
    else if (isEditingShapes) store.begin(part === 'fill' ? 'Change Fill' : 'Change Stroke')
  }

  function change(next: ColorParts): void {
    setRemembered(next)
    const color = hexOf(next)
    pendingRef.current = color
    if (linked !== undefined) store.updateFile((project) => setSwatchColor(project, linked.id, color))
    else if (isEditingShapes) store.update((project) => setShapeColor(project, selectedShapes, part, color))
    else store.setDrawingColor(part, color)
  }

  function commit(): void {
    if (isStep) store.commit()
    const color = pendingRef.current
    pendingRef.current = undefined
    if (color !== undefined) store.setDrawingColor(part, color, linked?.id)
  }

  function cancel(): void {
    pendingRef.current = undefined
    if (isStep) store.cancel()
  }

  function applyHex(text: string): void {
    const typed = hexInput(text)
    if (typed === undefined || typed === shown.slice(0, OPAQUE_HEX_LENGTH)) return
    begin()
    change({ ...partsOf(typed), opacity: parts.opacity })
    commit()
  }

  // The chosen swatch again unlinks, keeping its colour.
  function chooseSwatch(swatch: Swatch): void {
    const swatchId = swatch.id === linked?.id ? undefined : swatch.id
    const label = swatchId === undefined ? 'Unlink Swatch' : 'Apply Swatch'
    if (isEditingShapes) store.apply(label, (project) => setShapeColor(project, selectedShapes, part, swatch.color, swatchId))
    store.setDrawingColor(part, swatch.color, swatchId)
  }

  function addShownSwatch(): void {
    const swatch = { id: crypto.randomUUID(), name: nextSwatchName(swatches), color: shown }
    applyToFile('Add Swatch', (project) => addSwatch(project, swatch))
  }

  function openSwatchMenu(event: MouseEvent<HTMLButtonElement>, swatchId: string): void {
    event.preventDefault()
    setMenu({ at: { x: event.clientX, y: event.clientY }, swatchId })
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
            <span className={shownColors[each.part] === undefined ? 'colour-chip none' : 'colour-chip'} style={{ background: shownColors[each.part] }} />
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
      <DraftField label="Hex" testId="colour-hex" value={shown.slice(0, OPAQUE_HEX_LENGTH)} onApply={applyHex} />
      <div className="swatches" role="group" aria-label="Swatches">
        {swatches?.map((swatch, index) => (
          <button
            key={swatch.id}
            type="button"
            className="swatch"
            title={swatch.name}
            aria-label={swatch.name}
            aria-pressed={swatch.id === linked?.id}
            data-testid={`swatch-${index}`}
            style={{ background: swatch.color }}
            onClick={() => chooseSwatch(swatch)}
            onContextMenu={(event) => openSwatchMenu(event, swatch.id)}
          />
        ))}
        <IconButton icon="plus" label="Add swatch" testId="swatch-add" onClick={addShownSwatch} />
      </div>
      {linked !== undefined && (
        <DraftField key={linked.id} label="Swatch" testId="swatch-name" value={linked.name} onApply={(name) => applyToFile('Rename Swatch', (project) => renameSwatch(project, linked.id, name))} />
      )}
      {menu !== undefined && (
        <PopupMenu
          label="Swatch"
          items={[{ label: 'Delete Swatch', testId: 'menu-delete-swatch', onSelect: () => applyToFile('Delete Swatch', (project) => deleteSwatch(project, menu.swatchId)) }]}
          at={menu.at}
          onClose={closeMenu}
        />
      )}
    </>
  )
}
