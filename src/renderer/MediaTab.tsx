import { useEffect, useEffectEvent, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactElement } from 'react'
import { mediaFileName } from '../editor/place.js'
import type { MediaInfo, MediaState, Preparation } from '../shared/mediaProtocol.js'
import type { MediaRef } from '../shared/project.js'
import type { MediaSort } from '../shared/settings.js'
import { TICKS_PER_SECOND } from '../shared/time.js'
import { useEditorState, useSession } from './context.js'
import { DELETE_EVENT, SELECT_ALL_EVENT } from './document.js'
import { Icon } from './icons.js'
import { LibraryTools, useLibraryDrag, useLibraryView } from './LibraryTabs.js'

const SECONDS_PER_MINUTE = 60
const PERCENT = 100
const NAME_ORDER = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
const UNKNOWN_DATE = Number.MAX_SAFE_INTEGER
const UNKNOWN_DURATION = -1

function createdAtOf(state: MediaState | undefined): number {
  if (state === undefined || !('info' in state)) return UNKNOWN_DATE
  return state.createdAt ?? UNKNOWN_DATE
}

function durationOf(state: MediaState | undefined): number {
  if (state === undefined || !('info' in state) || state.info.kind === 'image') return UNKNOWN_DURATION
  return state.info.duration
}

function sortedMedia(media: readonly MediaRef[], mediaStates: Readonly<Record<string, MediaState>>, sort: MediaSort): readonly MediaRef[] {
  if (sort === 'name') return [...media].sort((first, second) => NAME_ORDER.compare(mediaFileName(first), mediaFileName(second)))
  if (sort === 'duration') return [...media].sort((first, second) => durationOf(mediaStates[second.id]) - durationOf(mediaStates[first.id]))
  return [...media].sort((first, second) => createdAtOf(mediaStates[first.id]) - createdAtOf(mediaStates[second.id]))
}

function nameOf(path: string): string {
  return path.split('/').at(-1) ?? path
}

function durationLabel(info: MediaInfo): string {
  if (info.kind === 'image') return `${info.width}x${info.height}`
  const seconds = Math.round(info.duration / TICKS_PER_SECOND)
  return `${Math.floor(seconds / SECONDS_PER_MINUTE)}:${String(seconds % SECONDS_PER_MINUTE).padStart(2, '0')}`
}

function Poster({ picture }: { picture: ImageBitmap }): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) return
    const draw = (): void => {
      canvas.width = picture.width
      canvas.height = picture.height
      canvas.getContext('2d')?.drawImage(picture, 0, 0)
    }
    draw()
    canvas.addEventListener('contextrestored', draw)
    return () => canvas.removeEventListener('contextrestored', draw)
  }, [picture])
  return <canvas ref={canvasRef} className="library-poster" aria-hidden="true" />
}

type MediaItemProps = {
  reference: MediaRef
  state: MediaState | undefined
  preparation: Preparation | undefined
  isSelected: boolean
  isTabStop: boolean
  draggedIds: readonly string[]
  onPress(mediaId: string, event: PointerEvent<HTMLElement>): void
  onChoose(mediaId: string, event: MouseEvent<HTMLElement>): void
}

function MediaItem({ reference, state, preparation, isSelected, isTabStop, draggedIds, onPress, onChoose }: MediaItemProps): ReactElement {
  const session = useSession()
  const { thumbnails } = session
  const name = mediaFileName(reference)
  const problem = state !== undefined && 'error' in state ? state : undefined
  const info = state !== undefined && 'info' in state ? state.info : undefined
  const picture = info === undefined || info.kind === 'audio' ? undefined : thumbnails.poster(reference.id, info)
  const drag = useLibraryDrag(info === undefined ? undefined : { kind: 'media', mediaIds: draggedIds }, draggedIds.length > 1 ? `${draggedIds.length} files` : name)

  const isPreparing = preparation !== undefined && preparation.progress < 1 && !preparation.hasFailed
  const percent = Math.floor((preparation?.progress ?? 0) * PERCENT)
  return (
    <li
      className={isSelected ? 'library-item selected' : 'library-item'}
      role="option"
      aria-selected={isSelected}
      tabIndex={isTabStop ? 0 : -1}
      data-testid={`media-${name}`}
      data-media-id={reference.id}
      data-selected={isSelected}
      data-tooltip={name}
      {...drag}
      onPointerDown={(event) => {
        if (event.button === 0) onPress(reference.id, event)
        drag.onPointerDown(event)
      }}
      // A click leaves the keys with the editor, so Space still plays; Tab is what brings them into the list.
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => onChoose(reference.id, event)}
    >
      <div className={isPreparing ? 'library-thumbnail preparing' : 'library-thumbnail'}>
        {picture !== undefined && <Poster picture={picture} />}
        {info?.kind === 'audio' && <Icon name="music" />}
        {isPreparing && (
          <span className="badge warning thumbnail-progress" role="img" aria-label={`Preparing ${percent}%`}>
            {percent}%
          </span>
        )}
      </div>
      <div className="library-text">
        <span className="library-name">{name}</span>
        <span className="library-details">
          {info !== undefined && <span>{durationLabel(info)}</span>}
          {preparation?.hasFailed === true && (
            <span className="badge danger" data-tooltip="Getting it ready for playback failed, so it may stutter or be silent while editing. Its clips can still be edited.">
              Media error
            </span>
          )}
          {problem !== undefined && (
            <span className="badge danger" data-tooltip={problem.error}>
              {problem.isMissing ? 'Media missing' : 'Media error'}
            </span>
          )}
        </span>
      </div>
      {problem !== undefined && (
        <button type="button" className="button" data-testid={`relink-${name}`} onPointerDown={(event) => event.stopPropagation()} onClick={() => void session.relink(reference.id)}>
          Relink…
        </button>
      )}
    </li>
  )
}

function hasModifier(event: { metaKey: boolean; shiftKey: boolean }): boolean {
  return event.metaKey || event.shiftKey
}

function columnsOf(list: HTMLElement): number {
  const options = list.querySelectorAll<HTMLElement>('[role="option"]')
  const firstTop = options[0]?.offsetTop
  let columns = 0
  for (const option of options) {
    if (option.offsetTop !== firstTop) break
    columns += 1
  }
  return Math.max(1, columns)
}

function movedTo(key: string, index: number, count: number, columns: number): number | undefined {
  let target: number
  if (key === 'ArrowRight') target = index + 1
  else if (key === 'ArrowLeft') target = index - 1
  else if (key === 'ArrowDown') target = index + columns
  else if (key === 'ArrowUp') target = index - columns
  else if (key === 'Home') target = 0
  else if (key === 'End') target = count - 1
  else return undefined
  return Math.min(count - 1, Math.max(0, target))
}

type Place = {
  x: number
  y: number
}

type Rect = {
  left: number
  top: number
  right: number
  bottom: number
}

type BoxSelect = {
  from: Place
  base: readonly string[]
  files: readonly { mediaId: string; shown: Rect }[]
}

function rectBetween(from: Place, to: Place): Rect {
  return { left: Math.min(from.x, to.x), top: Math.min(from.y, to.y), right: Math.max(from.x, to.x), bottom: Math.max(from.y, to.y) }
}

function filesShownIn(list: HTMLElement): BoxSelect['files'] {
  const files: { mediaId: string; shown: Rect }[] = []
  for (const option of list.querySelectorAll<HTMLElement>('[data-media-id]')) {
    const mediaId = option.dataset.mediaId
    if (mediaId !== undefined) files.push({ mediaId, shown: option.getBoundingClientRect() })
  }
  return files
}

function crosses(first: Rect, second: Rect): boolean {
  return first.left < second.right && first.right > second.left && first.top < second.bottom && first.bottom > second.top
}

function filesBetween(shownIds: readonly string[], from: string, to: string): string[] {
  const start = shownIds.indexOf(from)
  const end = shownIds.indexOf(to)
  if (start === -1 || end === -1) return [to]
  return shownIds.slice(Math.min(start, end), Math.max(start, end) + 1)
}

export function MediaTab(): ReactElement {
  const session = useSession()
  const media = useEditorState((state) => state.project.media)
  const mediaStates = useEditorState((state) => state.mediaStates)
  const pending = useEditorState((state) => state.pendingImports)
  const sort = useEditorState((state) => state.settings.mediaSort)
  const isOpening = useEditorState((state) => state.openingName !== undefined)
  const preparation = useSyncExternalStore(session.onPreparation, session.preparation)
  const [query, setQuery] = useState('')
  const [view, setView] = useLibraryView()
  const [selectedIds, setSelectedIds] = useState<readonly string[]>([])
  const [anchorId, setAnchorId] = useState<string | undefined>(undefined)
  const [focusedId, setFocusedId] = useState<string | undefined>(undefined)
  const [, setPictureCount] = useState(0)
  const [boxShown, setBoxShown] = useState<Rect | undefined>(undefined)
  const boxRef = useRef<BoxSelect | undefined>(undefined)
  const tabRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const wasPressedLastRef = useRef(false)

  useEffect(() => {
    let redraw: number | undefined
    const unsubscribe = session.thumbnails.subscribe(() => {
      redraw ??= requestAnimationFrame(() => {
        redraw = undefined
        setPictureCount((count) => count + 1)
      })
    })
    return () => {
      unsubscribe()
      if (redraw !== undefined) cancelAnimationFrame(redraw)
    }
  }, [session])

  const sorted = useMemo(() => sortedMedia(media, mediaStates, sort), [media, mediaStates, sort])
  const wanted = query.trim().toLowerCase()
  const shown = sorted.filter((reference) => mediaFileName(reference).toLowerCase().includes(wanted))
  const shownIds = shown.map((reference) => reference.id)
  const isEmpty = media.length === 0 && pending.length === 0
  const selected = new Set(selectedIds)
  const draggedSelection: string[] = []
  for (const reference of sorted) {
    const state = mediaStates[reference.id]
    if (selected.has(reference.id) && state !== undefined && 'info' in state) draggedSelection.push(reference.id)
  }
  let tabStopId = focusedId !== undefined && shownIds.includes(focusedId) ? focusedId : shownIds.find((id) => selected.has(id))
  tabStopId ??= shownIds[0]

  function press(mediaId: string, event: PointerEvent<HTMLElement>): void {
    setFocusedId(mediaId)
    if (event.currentTarget.parentElement?.contains(document.activeElement) === true) event.currentTarget.focus()
    if (event.shiftKey && anchorId !== undefined) {
      setSelectedIds(filesBetween(shownIds, anchorId, mediaId))
      return
    }
    setAnchorId(mediaId)
    if (event.metaKey) {
      setSelectedIds(selected.has(mediaId) ? selectedIds.filter((id) => id !== mediaId) : [...selectedIds, mediaId])
    } else if (!selected.has(mediaId)) {
      setSelectedIds([mediaId])
    }
  }

  function choose(mediaId: string, event: MouseEvent<HTMLElement>): void {
    if (!hasModifier(event)) setSelectedIds([mediaId])
  }

  function onListKeyDown(event: KeyboardEvent<HTMLUListElement>): void {
    const option = event.target
    const mediaId = option instanceof HTMLElement && option.getAttribute('role') === 'option' ? option.dataset.mediaId : undefined
    if (mediaId === undefined) return
    const index = shownIds.indexOf(mediaId)
    const target = movedTo(event.key, index, shownIds.length, columnsOf(event.currentTarget))
    if (event.key === 'Enter') {
      session.actions.addMedia(selected.has(mediaId) ? draggedSelection : [mediaId])
    } else if (event.key === ' ') {
      setAnchorId(mediaId)
      setSelectedIds(selected.has(mediaId) ? selectedIds.filter((id) => id !== mediaId) : [...selectedIds, mediaId])
    } else if (target !== undefined) {
      const targetId = shownIds[target] ?? mediaId
      if (event.shiftKey) {
        setSelectedIds(filesBetween(shownIds, anchorId ?? mediaId, targetId))
      } else if (!event.metaKey) {
        setAnchorId(targetId)
        setSelectedIds([targetId])
      }
      setFocusedId(targetId)
      event.currentTarget.querySelector<HTMLElement>(`[data-media-id="${CSS.escape(targetId)}"]`)?.focus()
    } else {
      return
    }
    event.preventDefault()
    event.stopPropagation()
  }

  function isInUse(): boolean {
    return wasPressedLastRef.current || tabRef.current?.contains(document.activeElement) === true
  }

  const onSelectAll = useEffectEvent((event: Event) => {
    if (!isInUse()) return
    event.preventDefault()
    setSelectedIds(shownIds)
  })

  const onDelete = useEffectEvent((event: Event) => {
    if (!isInUse() || selectedIds.length === 0) return
    event.preventDefault()
    session.actions.removeMedia(selectedIds)
    setSelectedIds([])
  })

  useEffect(() => {
    function onAnyPress(event: globalThis.PointerEvent): void {
      wasPressedLastRef.current = event.target instanceof Node && tabRef.current?.contains(event.target) === true
    }
    window.addEventListener('pointerdown', onAnyPress, true)
    window.addEventListener(SELECT_ALL_EVENT, onSelectAll)
    window.addEventListener(DELETE_EVENT, onDelete)
    return () => {
      window.removeEventListener('pointerdown', onAnyPress, true)
      window.removeEventListener(SELECT_ALL_EVENT, onSelectAll)
      window.removeEventListener(DELETE_EVENT, onDelete)
    }
  }, [])

  function startBox(event: PointerEvent<HTMLElement>): void {
    const isOnFile = event.target instanceof Element && event.target.closest('.library-item, .library-tools') !== null
    const list = listRef.current
    if (isOnFile || event.button !== 0 || list === null) return
    event.currentTarget.setPointerCapture(event.pointerId)
    const base = hasModifier(event) ? selectedIds : []
    boxRef.current = { from: { x: event.clientX, y: event.clientY }, base, files: filesShownIn(list) }
    setSelectedIds(base)
  }

  function moveBox(event: PointerEvent<HTMLElement>): void {
    const box = boxRef.current
    if (box === undefined) return
    const shownBox = rectBetween(box.from, { x: event.clientX, y: event.clientY })
    setBoxShown(shownBox)
    const picked = [...box.base]
    for (const file of box.files) {
      if (crosses(file.shown, shownBox) && !box.base.includes(file.mediaId)) picked.push(file.mediaId)
    }
    setSelectedIds(picked)
  }

  function endBox(): void {
    boxRef.current = undefined
    setBoxShown(undefined)
  }

  return (
    <div ref={tabRef} className="library-tab" onPointerDown={startBox} onPointerMove={moveBox} onPointerUp={endBox} onPointerCancel={endBox} onLostPointerCapture={endBox}>
      <LibraryTools noun="media" query={query} onQuery={setQuery} view={view} onView={setView} />
      {isEmpty && !isOpening && <p className="empty-state">Drop files here</p>}
      {!isEmpty && shown.length === 0 && pending.length === 0 && <p className="empty-state">No matches</p>}
      <ul ref={listRef} className={view === 'grid' ? 'library-list grid' : 'library-list'} role="listbox" aria-multiselectable="true" aria-label="Media" onKeyDown={onListKeyDown}>
        {shown.map((reference) => (
          <MediaItem
            key={reference.id}
            reference={reference}
            state={mediaStates[reference.id]}
            preparation={preparation[reference.id]}
            isSelected={selected.has(reference.id)}
            isTabStop={reference.id === tabStopId}
            draggedIds={selected.has(reference.id) ? draggedSelection : [reference.id]}
            onPress={press}
            onChoose={choose}
          />
        ))}
        {pending.map((path) => (
          <li key={path} className="library-item pending" role="option" aria-selected={false} aria-disabled="true" data-testid="media-pending">
            <div className="library-thumbnail" />
            <div className="library-text">
              <span className="library-name">{nameOf(path)}</span>
              <span className="library-details">Reading…</span>
            </div>
          </li>
        ))}
      </ul>
      {boxShown !== undefined && (
        <div
          className="select-box"
          data-testid="media-select-box"
          style={{ left: boxShown.left, top: boxShown.top, width: boxShown.right - boxShown.left, height: boxShown.bottom - boxShown.top }}
        />
      )}
    </div>
  )
}
