import { useEffect, useRef, useState, useSyncExternalStore, type MouseEvent, type PointerEvent, type ReactElement } from 'react'
import { mediaFileName } from '../editor/place.js'
import type { MediaInfo, MediaState, Preparation } from '../shared/mediaProtocol.js'
import type { MediaRef } from '../shared/project.js'
import { TICKS_PER_SECOND } from '../shared/time.js'
import { useEditorState, useSession } from './context.js'
import { Icon } from './icons.js'
import { LibraryTools, useLibraryDrag, useLibraryView } from './LibraryTabs.js'

const SECONDS_PER_MINUTE = 60
const PERCENT = 100

function nameOf(path: string): string {
  return path.split('/').at(-1) ?? path
}

function durationLabel(info: MediaInfo): string {
  if (info.kind === 'image') return `${info.width} × ${info.height}`
  const seconds = Math.round(info.duration / TICKS_PER_SECOND)
  return `${Math.floor(seconds / SECONDS_PER_MINUTE)}:${String(seconds % SECONDS_PER_MINUTE).padStart(2, '0')}`
}

function Poster({ picture }: { picture: ImageBitmap }): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) return
    canvas.width = picture.width
    canvas.height = picture.height
    canvas.getContext('2d')?.drawImage(picture, 0, 0)
  }, [picture])
  return <canvas ref={canvasRef} className="library-poster" aria-hidden="true" />
}

type MediaItemProps = {
  reference: MediaRef
  state: MediaState | undefined
  preparation: Preparation | undefined
  isSelected: boolean
  // What a drag that starts on this file takes along: the whole selection when the file is part of it.
  draggedIds: readonly string[]
  onPress(mediaId: string, event: PointerEvent<HTMLElement>): void
  onChoose(mediaId: string, event: MouseEvent<HTMLElement>): void
}

function MediaItem({ reference, state, preparation, isSelected, draggedIds, onPress, onChoose }: MediaItemProps): ReactElement {
  const session = useSession()
  const { thumbnails } = session
  const name = mediaFileName(reference)
  const problem = state !== undefined && 'error' in state ? state : undefined
  const info = state !== undefined && 'info' in state ? state.info : undefined
  const picture = info === undefined || info.kind === 'audio' ? undefined : thumbnails.poster(reference.id, info)
  // Media that could not be read cannot be placed, so it cannot be dragged.
  const drag = useLibraryDrag(info === undefined ? undefined : { kind: 'media', mediaIds: draggedIds }, draggedIds.length > 1 ? `${draggedIds.length} files` : name)

  const isPreparing = preparation !== undefined && preparation.progress < 1 && !preparation.hasFailed
  return (
    <li
      className={isSelected ? 'library-item selected' : 'library-item'}
      data-testid={`media-${name}`}
      data-selected={isSelected}
      // Rows and tiles cut a long name short.
      data-tooltip={name}
      {...drag}
      onPointerDown={(event) => {
        if (event.button === 0) onPress(reference.id, event)
        drag.onPointerDown(event)
      }}
      onClick={(event) => onChoose(reference.id, event)}
    >
      <div className="library-thumbnail">
        {picture !== undefined && <Poster picture={picture} />}
        {info?.kind === 'audio' && <Icon name="music" />}
      </div>
      <div className="library-text">
        <span className="library-name">{name}</span>
        <span className="library-details">
          {info !== undefined && <span>{durationLabel(info)}</span>}
          {isPreparing && <span className="badge warning">preparing {Math.floor(preparation.progress * PERCENT)}%</span>}
          {preparation?.hasFailed === true && <span className="badge danger">media error</span>}
          {problem !== undefined && (
            <span className="badge danger" data-tooltip={problem.error}>
              {problem.isMissing ? 'media missing' : 'media error'}
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

// The files from `from` to `to`, both included, in the order shown.
function run(shownIds: readonly string[], from: string, to: string): string[] {
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
  const preparation = useSyncExternalStore(session.onPreparation, session.preparation)
  const [query, setQuery] = useState('')
  const [view, setView] = useLibraryView()
  const [selectedIds, setSelectedIds] = useState<readonly string[]>([])
  // The file a Shift press measures its run from.
  const [anchorId, setAnchorId] = useState<string | undefined>(undefined)
  const [, setPictureCount] = useState(0)

  // Posters arrive after the row is first shown; each arrival draws the list again.
  useEffect(() => session.thumbnails.subscribe(() => setPictureCount((count) => count + 1)), [session])

  const wanted = query.trim().toLowerCase()
  const shown = media.filter((reference) => mediaFileName(reference).toLowerCase().includes(wanted))
  const shownIds = shown.map((reference) => reference.id)
  const isEmpty = media.length === 0 && pending.length === 0
  const selected = new Set(selectedIds)
  // A drag takes the selected files that can be placed, in the order they are listed.
  const draggedSelection: string[] = []
  for (const reference of media) {
    const state = mediaStates[reference.id]
    if (selected.has(reference.id) && state !== undefined && 'info' in state) draggedSelection.push(reference.id)
  }

  // A press decides what a drag from it takes: Shift picks the run from the last file pressed, Cmd adds or takes away one file,
  // and a plain press on a file that is not selected picks it alone. A plain press on a selected file keeps the selection, so all of it can be dragged.
  function press(mediaId: string, event: PointerEvent<HTMLElement>): void {
    if (event.shiftKey && anchorId !== undefined) {
      setSelectedIds(run(shownIds, anchorId, mediaId))
      return
    }
    setAnchorId(mediaId)
    if (event.metaKey) {
      setSelectedIds(selected.has(mediaId) ? selectedIds.filter((id) => id !== mediaId) : [...selectedIds, mediaId])
    } else if (!selected.has(mediaId)) {
      setSelectedIds([mediaId])
    }
  }

  // A plain click that did not become a drag picks that file alone.
  function choose(mediaId: string, event: MouseEvent<HTMLElement>): void {
    if (!hasModifier(event)) setSelectedIds([mediaId])
  }

  // A press on the empty part of the tab picks nothing.
  function pressOutside(event: PointerEvent<HTMLElement>): void {
    const isOnFile = event.target instanceof Element && event.target.closest('.library-item, .library-tools') !== null
    if (!isOnFile) setSelectedIds([])
  }

  return (
    <div className="library-tab" onPointerDown={pressOutside}>
      <LibraryTools noun="media" query={query} onQuery={setQuery} view={view} onView={setView}>
        {/* Importing is the first thing to do in an empty project; after that the window's one primary action is Export. */}
        <button type="button" className={media.length === 0 ? 'button primary' : 'button'} data-testid="import" onClick={() => void session.chooseAndImport()}>
          Import
        </button>
      </LibraryTools>
      {isEmpty && <p className="empty-state">Import video, audio or images, or drop files here.</p>}
      <ul className={view === 'grid' ? 'library-list grid' : 'library-list'} aria-label="Media">
        {shown.map((reference) => (
          <MediaItem
            key={reference.id}
            reference={reference}
            state={mediaStates[reference.id]}
            preparation={preparation[reference.id]}
            isSelected={selected.has(reference.id)}
            draggedIds={selected.has(reference.id) ? draggedSelection : [reference.id]}
            onPress={press}
            onChoose={choose}
          />
        ))}
        {pending.map((path) => (
          <li key={path} className="library-item pending" data-testid="media-pending">
            <div className="library-thumbnail" />
            <div className="library-text">
              <span className="library-name">{nameOf(path)}</span>
              <span className="library-details">Reading…</span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
