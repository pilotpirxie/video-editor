import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type PointerEvent, type ReactElement } from 'react'
import { mediaFileName } from '../editor/place.js'
import { logError } from '../shared/log.js'
import type { MediaInfo, MediaState, Preparation } from '../shared/mediaProtocol.js'
import type { MediaRef, Track } from '../shared/project.js'
import { TICKS_PER_SECOND } from '../shared/time.js'
import { useEditorState, useSession } from './context.js'
import { Icon, IconButton } from './icons.js'
import { MEDIA_DROP_EVENT, type MediaDropDetail } from './timelineController.js'

const DRAG_THRESHOLD = 4
const VIEW_KEY = 'media-view'
const SECONDS_PER_MINUTE = 60
const PERCENT = 100

type MediaView = 'list' | 'grid'

type Drag = {
  x: number
  y: number
  ghost: HTMLElement | undefined
}

function nameOf(path: string): string {
  return path.split('/').at(-1) ?? path
}

function durationLabel(info: MediaInfo): string {
  if (info.kind === 'image') return `${info.width} × ${info.height}`
  const seconds = Math.round(info.duration / TICKS_PER_SECOND)
  return `${Math.floor(seconds / SECONDS_PER_MINUTE)}:${String(seconds % SECONDS_PER_MINUTE).padStart(2, '0')}`
}

function kindLabel(info: MediaInfo): string {
  return info.kind === 'video' && info.isAnimatedImage === true ? 'image' : info.kind
}

function usedMediaIds(tracks: readonly Track[]): Set<string> {
  const used = new Set<string>()
  for (const track of tracks) {
    for (const clip of track.clips) {
      if (clip.type !== 'text') used.add(clip.mediaId)
    }
  }
  return used
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
  return <canvas ref={canvasRef} className="media-poster" aria-hidden="true" />
}

type MediaItemProps = {
  reference: MediaRef
  state: MediaState | undefined
  preparation: Preparation | undefined
  isUsed: boolean
}

function MediaItem({ reference, state, preparation, isUsed }: MediaItemProps): ReactElement {
  const session = useSession()
  const { thumbnails } = session
  const dragRef = useRef<Drag | undefined>(undefined)
  const name = mediaFileName(reference)
  const problem = state !== undefined && 'error' in state ? state : undefined
  const info = state !== undefined && 'info' in state ? state.info : undefined
  const picture = info === undefined || info.kind === 'audio' ? undefined : thumbnails.poster(reference.id, info)

  function onPointerDown(event: PointerEvent<HTMLLIElement>): void {
    if (event.button !== 0 || info === undefined) return
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = { x: event.clientX, y: event.clientY, ghost: undefined }
  }

  // The drag is drawn by a label that follows the pointer; whatever is under the pointer on release receives the drop.
  function onPointerMove(event: PointerEvent<HTMLLIElement>): void {
    const drag = dragRef.current
    if (drag === undefined) return
    if (drag.ghost === undefined) {
      if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < DRAG_THRESHOLD) return
      drag.ghost = document.createElement('div')
      drag.ghost.className = 'media-ghost'
      drag.ghost.textContent = name
      document.body.append(drag.ghost)
    }
    drag.ghost.style.left = `${event.clientX}px`
    drag.ghost.style.top = `${event.clientY}px`
  }

  function endDrag(event: PointerEvent<HTMLLIElement>, isDropped: boolean): void {
    const drag = dragRef.current
    dragRef.current = undefined
    if (drag?.ghost === undefined) return
    drag.ghost.remove()
    if (!isDropped) return
    const detail: MediaDropDetail = { mediaId: reference.id, clientX: event.clientX, clientY: event.clientY }
    document.elementFromPoint(event.clientX, event.clientY)?.dispatchEvent(new CustomEvent(MEDIA_DROP_EVENT, { bubbles: true, detail }))
  }

  const isPreparing = preparation !== undefined && preparation.progress < 1 && !preparation.hasFailed
  return (
    <li
      className="media-item"
      data-testid={`media-${name}`}
      // Rows and tiles cut a long name short.
      data-tooltip={name}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(event) => endDrag(event, true)}
      onPointerCancel={(event) => endDrag(event, false)}
    >
      <div className="media-thumbnail">
        {picture !== undefined && <Poster picture={picture} />}
        {info?.kind === 'audio' && <Icon name="music" />}
      </div>
      <div className="media-text">
        <span className="media-name">{name}</span>
        <span className="media-details">
          {info !== undefined && <span className="badge">{kindLabel(info)}</span>}
          {info !== undefined && <span>{durationLabel(info)}</span>}
          {isUsed && <span className="badge" data-testid={`used-${name}`}>used</span>}
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

export function MediaTab(): ReactElement {
  const session = useSession()
  const media = useEditorState((state) => state.project.media)
  const mediaStates = useEditorState((state) => state.mediaStates)
  const tracks = useEditorState((state) => state.project.tracks)
  const pending = useEditorState((state) => state.pendingImports)
  const preparation = useSyncExternalStore(session.onPreparation, session.preparation)
  const [query, setQuery] = useState('')
  const [view, setView] = useState<MediaView>(() => (localStorage.getItem(VIEW_KEY) === 'grid' ? 'grid' : 'list'))
  const [, setPictureCount] = useState(0)
  const used = useMemo(() => usedMediaIds(tracks), [tracks])

  // Posters arrive after the row is first shown; each arrival draws the list again.
  useEffect(() => session.thumbnails.subscribe(() => setPictureCount((count) => count + 1)), [session])

  function show(next: MediaView): void {
    setView(next)
    try {
      localStorage.setItem(VIEW_KEY, next)
    } catch (error) {
      logError('Could not remember how the media is shown', error)
    }
  }

  const wanted = query.trim().toLowerCase()
  const shown = media.filter((reference) => mediaFileName(reference).toLowerCase().includes(wanted))
  const isEmpty = media.length === 0 && pending.length === 0

  return (
    <div className="media-tab">
      <div className="media-tools">
        <input className="field" type="search" placeholder="Search media" aria-label="Search media" data-testid="media-search" value={query} onChange={(event) => setQuery(event.target.value)} />
        <div className="segmented" role="group" aria-label="Show media as">
          <IconButton icon="list" label="List" testId="media-view-list" isPressed={view === 'list'} onClick={() => show('list')} />
          <IconButton icon="grid" label="Grid" testId="media-view-grid" isPressed={view === 'grid'} onClick={() => show('grid')} />
        </div>
        {/* Importing is the first thing to do in an empty project; after that the window's one primary action is Export. */}
        <button type="button" className={media.length === 0 ? 'button primary' : 'button'} data-testid="import" onClick={() => void session.chooseAndImport()}>
          Import
        </button>
      </div>
      {isEmpty && <p className="empty-state">Import video, audio or images, or drop files here.</p>}
      <ul className={view === 'grid' ? 'media-list grid' : 'media-list'} aria-label="Media">
        {shown.map((reference) => (
          <MediaItem key={reference.id} reference={reference} state={mediaStates[reference.id]} preparation={preparation[reference.id]} isUsed={used.has(reference.id)} />
        ))}
        {pending.map((path) => (
          <li key={path} className="media-item pending" data-testid="media-pending">
            <div className="media-thumbnail" />
            <div className="media-text">
              <span className="media-name">{nameOf(path)}</span>
              <span className="media-details">Reading…</span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
