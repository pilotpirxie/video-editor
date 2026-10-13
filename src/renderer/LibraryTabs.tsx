import { useEffect, useRef, useState, type MouseEvent, type PointerEvent, type ReactElement } from 'react'
import { EFFECT_NAMES } from '../editor/effects.js'
import { TRANSITION_NAMES } from '../editor/transitions.js'
import { EFFECT_TYPES, TRANSITION_TYPES } from '../shared/project.js'
import { useSession } from './context.js'
import { Icon, type IconName } from './icons.js'
import { LIBRARY_DRAG_EVENT, LIBRARY_DROP_EVENT, type LibraryDragDetail, type LibraryItem } from './timelineController.js'

const DRAG_THRESHOLD = 4

type Drag = {
  x: number
  y: number
  ghost: HTMLElement | undefined
  onKeyDown(event: KeyboardEvent): void
}

type Place = {
  clientX: number
  clientY: number
}

type DragHandlers = {
  onPointerDown(event: PointerEvent<HTMLElement>): void
  onPointerMove(event: PointerEvent<HTMLElement>): void
  onPointerUp(event: PointerEvent<HTMLElement>): void
  onPointerCancel(event: PointerEvent<HTMLElement>): void
  onLostPointerCapture(event: PointerEvent<HTMLElement>): void
  onClickCapture(event: MouseEvent<HTMLElement>): void
}

// Lets an element of the library be dragged out of it. The drag is drawn by a label that follows the pointer; whatever is under the pointer hears of every move, and of the drop on release.
// Nothing is dragged while there is no item, as for media that is still being read.
export function useLibraryDrag(item: LibraryItem | undefined, label: string): DragHandlers {
  const dragRef = useRef<Drag | undefined>(undefined)
  const wasDraggedRef = useRef(false)

  function tell(type: string, target: EventTarget, at: Place): void {
    if (item === undefined) return
    const detail: LibraryDragDetail = { item, clientX: at.clientX, clientY: at.clientY }
    target.dispatchEvent(new CustomEvent(type, { bubbles: true, detail }))
  }

  function endDrag(at: Place, isDropped: boolean): void {
    const drag = dragRef.current
    dragRef.current = undefined
    if (drag === undefined) return
    window.removeEventListener('keydown', drag.onKeyDown, true)
    if (drag.ghost === undefined) return
    wasDraggedRef.current = true
    drag.ghost.remove()
    const under = isDropped ? document.elementFromPoint(at.clientX, at.clientY) : null
    // Whatever showed where the item would go hears where the drag ended before the drop itself; an abandoned drag ends over no panel.
    tell(LIBRARY_DRAG_EVENT, under ?? document, at)
    if (under !== null) tell(LIBRARY_DROP_EVENT, under, at)
  }

  // An element that goes away in the middle of its drag, with its media undone for example, takes the drag with it.
  useEffect(() => () => endDrag({ clientX: 0, clientY: 0 }, false), [])

  return {
    onPointerDown(event) {
      if (event.button !== 0 || item === undefined) return
      wasDraggedRef.current = false
      event.currentTarget.setPointerCapture(event.pointerId)
      const start = { clientX: event.clientX, clientY: event.clientY }
      // Escape abandons the drag. It is marked as handled so it does not also clear the selection.
      function onKeyDown(pressed: KeyboardEvent): void {
        if (pressed.key !== 'Escape' || dragRef.current?.ghost === undefined) return
        pressed.preventDefault()
        endDrag(start, false)
      }
      window.addEventListener('keydown', onKeyDown, true)
      dragRef.current = { x: event.clientX, y: event.clientY, ghost: undefined, onKeyDown }
    },
    onPointerMove(event) {
      const drag = dragRef.current
      if (drag === undefined) return
      if (drag.ghost === undefined) {
        if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < DRAG_THRESHOLD) return
        drag.ghost = document.createElement('div')
        drag.ghost.className = 'drag-ghost'
        drag.ghost.textContent = label
        document.body.append(drag.ghost)
      }
      drag.ghost.style.left = `${event.clientX}px`
      drag.ghost.style.top = `${event.clientY}px`
      tell(LIBRARY_DRAG_EVENT, document.elementFromPoint(event.clientX, event.clientY) ?? document, event)
    },
    onPointerUp: (event) => endDrag(event, true),
    onPointerCancel: (event) => endDrag(event, false),
    onLostPointerCapture: (event) => endDrag(event, false),
    // The release that ends a drag is followed by a click on the element the drag began on; that click is not a choice.
    onClickCapture(event) {
      if (!wasDraggedRef.current) return
      wasDraggedRef.current = false
      event.preventDefault()
      event.stopPropagation()
    },
  }
}

type Entry = {
  item: LibraryItem
  label: string
  testId: string
  onChoose(): void
}

function EntryButton({ entry, icon }: { entry: Entry; icon: IconName }): ReactElement {
  const drag = useLibraryDrag(entry.item, entry.label)
  return (
    <li>
      <button type="button" className="button library-entry" data-testid={entry.testId} {...drag} onClick={entry.onChoose}>
        <Icon name={icon} />
        {entry.label}
      </button>
    </li>
  )
}

type EntryListProps = {
  // What the entries are, in the plural, as in "Search effects".
  noun: string
  hint: string
  icon: IconName
  entries: readonly Entry[]
}

function EntryList({ noun, hint, icon, entries }: EntryListProps): ReactElement {
  const [query, setQuery] = useState('')
  const wanted = query.trim().toLowerCase()
  const shown = entries.filter((entry) => entry.label.toLowerCase().includes(wanted))
  return (
    <div className="library-tab">
      <input className="field" type="search" placeholder={`Search ${noun}`} aria-label={`Search ${noun}`} data-testid={`${noun}-search`} value={query} onChange={(event) => setQuery(event.target.value)} />
      <p className="hint">{hint}</p>
      <ul className="library-list" aria-label={noun}>
        {shown.map((entry) => (
          <EntryButton key={entry.testId} entry={entry} icon={icon} />
        ))}
      </ul>
      {shown.length === 0 && <p className="empty-state">Nothing here is called that.</p>}
    </div>
  )
}

export function EffectsTab(): ReactElement {
  const { actions } = useSession()
  const entries = EFFECT_TYPES.map((effect) => ({ item: { kind: 'effect' as const, effect }, label: EFFECT_NAMES[effect], testId: `effect-${effect}`, onChoose: () => actions.addEffect(effect) }))
  return <EntryList noun="effects" hint="Click one to add it to the selected clips, or drag it onto a clip." icon="wand" entries={entries} />
}

export function TransitionsTab(): ReactElement {
  const { actions } = useSession()
  const entries = TRANSITION_TYPES.map((transition) => ({
    item: { kind: 'transition' as const, transition },
    label: TRANSITION_NAMES[transition],
    testId: `transition-${transition}`,
    onChoose: () => actions.addTransition(transition),
  }))
  return <EntryList noun="transitions" hint="Drag one onto the start or the end of a clip, or onto a cut. A click adds it at the start of the selected clips." icon="transition" entries={entries} />
}
