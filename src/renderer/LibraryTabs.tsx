import { useEffect, useRef, useState, type MouseEvent, type PointerEvent, type ReactElement } from 'react'
import { ANNOTATION_KINDS, ANNOTATION_NAMES } from '../editor/annotations.js'
import { EFFECT_NAMES } from '../editor/effects.js'
import { TRANSITION_NAMES } from '../editor/transitions.js'
import { logError } from '../shared/log.js'
import { EFFECT_TYPES, TRANSITION_TYPES } from '../shared/project.js'
import { useSession } from './context.js'
import { Icon, IconButton } from './icons.js'
import { ANNOTATION_PREVIEWS, EFFECT_PREVIEWS, TRANSITION_PREVIEWS } from './libraryPreviews.js'
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

const VIEW_KEY = 'library-view'

type LibraryView = 'list' | 'grid'

// One choice for all four tabs, remembered on this Mac. Tiles unless rows were chosen.
export function useLibraryView(): [LibraryView, (next: LibraryView) => void] {
  const [view, setView] = useState<LibraryView>(() => (localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid'))

  function show(next: LibraryView): void {
    setView(next)
    try {
      localStorage.setItem(VIEW_KEY, next)
    } catch (error) {
      logError('Could not remember how the library is shown', error)
    }
  }

  return [view, show]
}

type LibraryToolsProps = {
  // What the tab holds, in the plural, as in "Search effects".
  noun: string
  query: string
  onQuery(query: string): void
  view: LibraryView
  onView(view: LibraryView): void
}

export function LibraryTools({ noun, query, onQuery, view, onView }: LibraryToolsProps): ReactElement {
  return (
    <div className="library-tools">
      <div className="field-box search-box">
        <Icon name="search" />
        <input className="field" type="search" placeholder={`Search ${noun}`} aria-label={`Search ${noun}`} data-testid={`${noun}-search`} value={query} onChange={(event) => onQuery(event.target.value)} />
      </div>
      <div className="segmented" role="group" aria-label={`Show ${noun} as`}>
        <IconButton icon="list" label="List" testId={`${noun}-view-list`} isPressed={view === 'list'} onClick={() => onView('list')} />
        <IconButton icon="grid" label="Grid" testId={`${noun}-view-grid`} isPressed={view === 'grid'} onClick={() => onView('grid')} />
      </div>
    </div>
  )
}

type Entry = {
  item: LibraryItem
  label: string
  testId: string
  preview: ReactElement
  // Adds the item where it goes without a drag: to the selected clips, or at the playhead.
  onChoose(): void
}

function EntryTile({ entry }: { entry: Entry }): ReactElement {
  const drag = useLibraryDrag(entry.item, entry.label)

  // A click with the pointer adds nothing: the item is dragged where it goes. Enter, Space and VoiceOver press the button without a pointer, which `detail` 0 tells apart.
  function onClick(event: MouseEvent<HTMLButtonElement>): void {
    if (event.detail === 0) entry.onChoose()
  }

  return (
    <li>
      <button type="button" className="library-item" data-testid={entry.testId} data-tooltip={entry.label} {...drag} onClick={onClick}>
        <span className="library-thumbnail">{entry.preview}</span>
        <span className="library-text">
          <span className="library-name">{entry.label}</span>
        </span>
      </button>
    </li>
  )
}

type EntryListProps = {
  noun: string
  entries: readonly Entry[]
}

function EntryList({ noun, entries }: EntryListProps): ReactElement {
  const [query, setQuery] = useState('')
  const [view, setView] = useLibraryView()
  const wanted = query.trim().toLowerCase()
  const shown = entries.filter((entry) => entry.label.toLowerCase().includes(wanted))
  return (
    <div className="library-tab">
      <LibraryTools noun={noun} query={query} onQuery={setQuery} view={view} onView={setView} />
      <ul className={view === 'grid' ? 'library-list grid' : 'library-list'} aria-label={noun}>
        {shown.map((entry) => (
          <EntryTile key={entry.testId} entry={entry} />
        ))}
      </ul>
      {shown.length === 0 && <p className="empty-state">No matches</p>}
    </div>
  )
}

export function EffectsTab(): ReactElement {
  const { actions } = useSession()
  const entries = EFFECT_TYPES.map((effect) => ({
    item: { kind: 'effect' as const, effect },
    label: EFFECT_NAMES[effect],
    testId: `effect-${effect}`,
    preview: EFFECT_PREVIEWS[effect],
    onChoose: () => actions.addEffect(effect),
  }))
  return <EntryList noun="effects" entries={entries} />
}

export function TransitionsTab(): ReactElement {
  const { actions } = useSession()
  const entries = TRANSITION_TYPES.map((transition) => ({
    item: { kind: 'transition' as const, transition },
    label: TRANSITION_NAMES[transition],
    testId: `transition-${transition}`,
    preview: TRANSITION_PREVIEWS[transition],
    onChoose: () => actions.addTransition(transition),
  }))
  return <EntryList noun="transitions" entries={entries} />
}

export function AnnotationsTab(): ReactElement {
  const { actions } = useSession()
  const entries = ANNOTATION_KINDS.map((annotation) => ({
    item: { kind: 'annotation' as const, annotation },
    label: ANNOTATION_NAMES[annotation],
    testId: `annotation-${annotation}`,
    preview: ANNOTATION_PREVIEWS[annotation],
    onChoose: () => actions.addAnnotation(annotation),
  }))
  return <EntryList noun="annotations" entries={entries} />
}
