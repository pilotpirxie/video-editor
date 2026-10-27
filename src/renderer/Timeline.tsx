import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type PointerEvent, type ReactElement } from 'react'
import { deleteZoom, setZoom } from '../editor/camera.js'
import { hasSource, locateClip } from '../editor/clips.js'
import { drawingAt, renameShape, reorderShape, setShapeFlag, shapeRows, type ShapeRef, type ShapeRow } from '../editor/drawings.js'
import { resolveScope } from '../editor/groups.js'
import { changeKeyframe, removeKeyframe, setSpeed, sharedValue } from '../editor/properties.js'
import { actionFor } from '../editor/shortcuts.js'
import { SHAPE_ROW_HEIGHT, TRACK_HEIGHT, trackIndexAtOffset, trackRowsOf, type TrackRows } from '../editor/timelineView.js'
import { addTrack, deleteTrack, moveTrack, renameTrack, setTrackFlag, type TrackFlag } from '../editor/tracks.js'
import { projectDuration, type Easing, type Project, type Track } from '../shared/project.js'
import { MAX_SPEED_PERCENT, MIN_SPEED_PERCENT, frameDuration } from '../shared/time.js'
import { useEditorState, usePosition, useSession, useShortcutHint } from './context.js'
import { Icon, IconButton, type IconName } from './icons.js'
import { PopupMenu, type MenuItem } from './Menu.js'
import { createTimelineController, type MenuTarget, type TimelineController } from './timelineController.js'
import { isKeyForTheEditor } from './transport.js'

const ZOOM_STEP = 1.5
const DRAG_THRESHOLD = 3
const SHAPE_ROW_PADDING = 8
const SHAPE_INDENT = 14
const UNNAMED_SHAPE = 'Shape'

type Point = {
  x: number
  y: number
}

type OpenMenu = {
  at: Point
  target: MenuTarget | undefined
}

const EASINGS: readonly { easing: Easing; label: string }[] = [
  { easing: 'linear', label: 'Linear' },
  { easing: 'easeIn', label: 'Ease In' },
  { easing: 'easeOut', label: 'Ease Out' },
  { easing: 'easeInOut', label: 'Ease In and Out' },
  { easing: 'hold', label: 'Hold' },
]

function easingItems(choose: (easing: Easing) => void): MenuItem[] {
  return EASINGS.map(({ easing, label }) => ({ label, testId: `menu-easing-${easing}`, onSelect: () => choose(easing) }))
}

const FLAGS: readonly { flag: TrackFlag; icon: IconName; onIcon: IconName; isDanger: boolean; on: string; off: string }[] = [
  { flag: 'locked', icon: 'lock', onIcon: 'lock', isDanger: false, on: 'Unlock Track', off: 'Lock Track' },
  { flag: 'hidden', icon: 'eye', onIcon: 'eye', isDanger: false, on: 'Show Track', off: 'Hide Track' },
  { flag: 'muted', icon: 'speaker', onIcon: 'speakerMuted', isDanger: true, on: 'Unmute Track', off: 'Mute Track' },
]

type ShapePress = {
  row: ShapeRow
  fromY: number
  listTop: number
}

function ShapeRows({ track, height }: { track: Track; height: number }): ReactElement {
  const { store } = useSession()
  const drawingId = usePosition((position) => drawingAt(track, position.time)?.id)
  const selectedShapes = useEditorState((state) => state.selectedShapes)
  const [renaming, setRenaming] = useState<{ shapeId: string; name: string } | undefined>(undefined)
  const listRef = useRef<HTMLDivElement>(null)
  const pressRef = useRef<ShapePress | undefined>(undefined)
  const drawing = track.clips.find((clip) => clip.id === drawingId)
  if (drawing?.type !== 'drawing') {
    return (
      <div className="shape-rows" style={{ height }}>
        <div className="shape-row empty">No drawing at the playhead</div>
      </div>
    )
  }
  const clipId = drawing.id
  const rows = shapeRows(drawing.shapes)

  function refOf(row: ShapeRow): ShapeRef {
    return { clipId, shapeId: row.shape.id }
  }

  function isChosen(row: ShapeRow): boolean {
    return selectedShapes.some((chosen) => chosen.clipId === clipId && chosen.shapeId === row.shape.id)
  }

  function choose(row: ShapeRow, isAdding: boolean): void {
    if (!row.isPickable) return
    if (!isAdding) store.selectShapes([refOf(row)])
    else if (isChosen(row)) store.selectShapes(selectedShapes.filter((chosen) => chosen.clipId !== clipId || chosen.shapeId !== row.shape.id))
    else store.selectShapes([...selectedShapes, refOf(row)])
  }

  function onRowDown(event: PointerEvent<HTMLDivElement>, row: ShapeRow): void {
    const isOnControl = event.target instanceof Element && event.target.closest('button, input') !== null
    const list = listRef.current
    if (event.button !== 0 || isOnControl || list === null) return
    pressRef.current = { row, fromY: event.clientY, listTop: list.getBoundingClientRect().top }
  }

  // Without pointer capture, so a double-click still reaches the name; letting go outside the list does nothing.
  function onListUp(event: PointerEvent<HTMLDivElement>): void {
    const press = pressRef.current
    pressRef.current = undefined
    if (press === undefined) return
    if (Math.abs(event.clientY - press.fromY) < DRAG_THRESHOLD) {
      choose(press.row, event.shiftKey)
      return
    }
    const target = rows[Math.floor((event.clientY - press.listTop) / SHAPE_ROW_HEIGHT)]
    if (target === undefined || target === press.row) return
    store.apply('Reorder Shapes', (project) => reorderShape(project, refOf(press.row), target.shape.id))
  }

  function switchFlag(row: ShapeRow, flag: 'hidden' | 'locked', label: string): void {
    const isOn = row.shape[flag] === true
    store.apply(label, (project) => setShapeFlag(project, refOf(row), flag, !isOn))
  }

  function rename(row: ShapeRow): void {
    const name = renaming?.name
    setRenaming(undefined)
    if (name !== undefined && name !== row.shape.name) store.apply('Rename Shape', (project) => renameShape(project, refOf(row), name))
  }

  function onNameKey(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Enter') event.currentTarget.blur()
    if (event.key === 'Escape') setRenaming(undefined)
  }

  return (
    <div className="shape-rows" style={{ height }} ref={listRef} aria-label="Shapes" onPointerUp={onListUp} onPointerLeave={() => (pressRef.current = undefined)}>
      {rows.map((row) => {
        const { shape } = row
        const isHidden = shape.hidden === true
        const isLocked = shape.locked === true
        const name = shape.name ?? UNNAMED_SHAPE
        let className = 'shape-row'
        if (isChosen(row)) className += ' selected'
        if (!row.isPickable) className += ' muted'
        return (
          <div
            key={shape.id}
            className={className}
            style={{ paddingLeft: SHAPE_ROW_PADDING + row.depth * SHAPE_INDENT }}
            data-testid={`shape-row-${shape.id}`}
            data-selected={isChosen(row)}
            onPointerDown={(event) => onRowDown(event, row)}
          >
            {renaming?.shapeId === shape.id ? (
              <input
                className="field"
                aria-label="Shape name"
                data-testid="shape-name-input"
                autoFocus
                value={renaming.name}
                onChange={(event) => setRenaming({ shapeId: shape.id, name: event.target.value })}
                onKeyDown={onNameKey}
                onBlur={() => rename(row)}
              />
            ) : (
              <span className="shape-name" data-testid={`shape-name-${shape.id}`} onDoubleClick={() => setRenaming({ shapeId: shape.id, name })}>
                {name}
              </span>
            )}
            <IconButton icon="eye" label={isHidden ? 'Show Shape' : 'Hide Shape'} testId={`shape-hidden-${shape.id}`} isPressed={isHidden} onClick={() => switchFlag(row, 'hidden', isHidden ? 'Show Shape' : 'Hide Shape')} />
            <IconButton icon="lock" label={isLocked ? 'Unlock Shape' : 'Lock Shape'} testId={`shape-locked-${shape.id}`} isPressed={isLocked} onClick={() => switchFlag(row, 'locked', isLocked ? 'Unlock Shape' : 'Lock Shape')} />
          </div>
        )
      })}
    </div>
  )
}

function TrackHeader({ track, index, rows }: { track: Track; index: number; rows: TrackRows }): ReactElement {
  const { store } = useSession()
  const isExpanded = useEditorState((state) => state.expandedTracks.has(track.id))
  const holdsDrawing = track.clips.some((clip) => clip.type === 'drawing')
  const [draftName, setDraftName] = useState<string | undefined>(undefined)
  const [menuAt, setMenuAt] = useState<Point | undefined>(undefined)
  const dragFromRef = useRef<number | undefined>(undefined)
  const closeMenu = useCallback(() => setMenuAt(undefined), [])

  function rename(): void {
    const name = draftName
    setDraftName(undefined)
    if (name !== undefined && name !== track.name) store.apply('Rename Track', (project) => renameTrack(project, track.id, name))
  }

  function onNameKey(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Enter') event.currentTarget.blur()
    if (event.key === 'Escape') setDraftName(undefined)
  }

  function onGripDown(event: PointerEvent<HTMLDivElement>): void {
    if (event.button !== 0 || draftName !== undefined) return
    event.currentTarget.setPointerCapture(event.pointerId)
    dragFromRef.current = event.clientY
  }

  function onGripUp(event: PointerEvent<HTMLDivElement>): void {
    const from = dragFromRef.current
    dragFromRef.current = undefined
    if (from === undefined) return
    const grabbed = (rows.tops[index] ?? 0) + TRACK_HEIGHT / 2
    const target = trackIndexAtOffset(grabbed + event.clientY - from, rows)
    if (target !== index) store.apply('Reorder Tracks', (project) => moveTrack(project, track.id, target))
  }

  function cancelGrip(): void {
    dragFromRef.current = undefined
  }

  function moveBy(rows: number): void {
    store.apply('Reorder Tracks', (project) => moveTrack(project, track.id, index + rows))
  }

  function addTrackAbove(): void {
    store.apply('Add Track', (project) => {
      const newTrack = { id: crypto.randomUUID(), name: `Track ${project.tracks.length + 1}` }
      return addTrack(project, newTrack, index + 1)
    })
  }

  function removeTrack(): void {
    store.apply('Delete Track', (project) => deleteTrack(project, track.id))
  }

  function switchFlag(flag: TrackFlag, label: string): void {
    store.apply(label, (project) => setTrackFlag(project, track.id, flag, !track[flag]))
  }

  const menuItems: MenuItem[] = [
    { label: 'Add Track Above', testId: 'track-add-above', onSelect: addTrackAbove },
    { label: 'Move Up', testId: 'track-move-up', onSelect: () => moveBy(1) },
    { label: 'Move Down', testId: 'track-move-down', isDisabled: index === 0, onSelect: () => moveBy(-1) },
    { label: 'Rename', testId: 'track-rename', onSelect: () => setDraftName(track.name) },
    { label: 'Delete Track', testId: 'track-delete', onSelect: removeTrack },
  ]

  const rowHeight = rows.heights[index] ?? TRACK_HEIGHT
  return (
    <>
    <div
      className="track-header"
      data-testid={`track-${index}`}
      onContextMenu={(event) => {
        event.preventDefault()
        setMenuAt({ x: event.clientX, y: event.clientY })
      }}
    >
      {holdsDrawing && (
        <button
          type="button"
          className="button icon"
          aria-label={isExpanded ? 'Hide shapes' : 'Show shapes'}
          aria-expanded={isExpanded}
          data-tooltip={isExpanded ? 'Hide shapes' : 'Show shapes'}
          data-testid={`track-expand-${index}`}
          onClick={() => store.expandTrack(track.id, !isExpanded)}
        >
          <Icon name={isExpanded ? 'chevronDown' : 'chevronRight'} />
        </button>
      )}
      <div className="track-grip" onPointerDown={onGripDown} onPointerUp={onGripUp} onPointerCancel={cancelGrip} onDoubleClick={() => setDraftName(track.name)}>
        {draftName === undefined ? (
          <span className="track-name" data-testid={`track-name-${index}`}>
            {track.name}
          </span>
        ) : (
          <input
            className="field"
            aria-label="Track name"
            data-testid="track-name-input"
            autoFocus
            value={draftName}
            onChange={(event) => setDraftName(event.target.value)}
            onKeyDown={onNameKey}
            onBlur={rename}
          />
        )}
      </div>
      {FLAGS.map(({ flag, icon, onIcon, isDanger, on, off }) => {
        const isOn = track[flag]
        const label = isOn ? on : off
        return (
          <IconButton
            key={flag}
            icon={isOn ? onIcon : icon}
            label={label}
            testId={`track-${flag}-${index}`}
            isPressed={isOn}
            isDanger={isDanger}
            onClick={() => switchFlag(flag, label)}
          />
        )
      })}
      {menuAt !== undefined && <PopupMenu label="Track" items={menuItems} at={menuAt} onClose={closeMenu} />}
    </div>
    {rowHeight > TRACK_HEIGHT && <ShapeRows track={track} height={rowHeight - TRACK_HEIGHT} />}
    </>
  )
}

function clipsWithSpeed(project: Project, selection: readonly string[]): string[] {
  return selection.filter((clipId) => {
    const clip = locateClip(project, clipId)?.clip
    return clip !== undefined && hasSource(clip)
  })
}

function SpeedDialog({ clipIds, onClose }: { clipIds: readonly string[]; onClose(): void }): ReactElement {
  const { store } = useSession()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState(() => {
    const { project } = store.getState()
    const speeds: number[] = []
    for (const clipId of clipIds) {
      const clip = locateClip(project, clipId)?.clip
      if (clip !== undefined && hasSource(clip)) speeds.push(clip.speedPercent)
    }
    return String(sharedValue(speeds) ?? '')
  })
  const typed = Number(draft)
  const isTypedValid = draft.trim() !== '' && Number.isFinite(typed)

  useEffect(() => {
    dialogRef.current?.showModal()
    inputRef.current?.select()
  }, [])

  function apply(percent: number): void {
    store.apply('Change Speed', (project) => setSpeed(project, clipIds, percent))
    dialogRef.current?.close()
  }

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (isTypedValid) apply(typed)
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key !== 'Enter') return
    event.preventDefault()
    if (isTypedValid) apply(typed)
  }

  return (
    <dialog ref={dialogRef} className="dialog speed-dialog" aria-labelledby="speed-title" data-testid="speed-dialog" onClose={onClose}>
      <form className="dialog-form" onSubmit={onSubmit}>
        <h2 className="dialog-title" id="speed-title">
          Speed
        </h2>
        <div className="labelled">
          <label className="field-label" htmlFor="speed-value">
            Speed %
          </label>
          <input
            ref={inputRef}
            id="speed-value"
            className="field"
            type="text"
            inputMode="decimal"
            data-testid="speed-value"
            placeholder="Mixed"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
          />
        </div>
        <p className="dialog-summary">
          From {MIN_SPEED_PERCENT}% to {MAX_SPEED_PERCENT}%.
        </p>
        <div className="dialog-buttons">
          <button type="button" className="button" data-testid="speed-cancel" onClick={() => dialogRef.current?.close()}>
            Cancel
          </button>
          <button type="submit" className="button primary" data-testid="speed-apply" disabled={!isTypedValid}>
            Apply
          </button>
        </div>
      </form>
    </dialog>
  )
}

function animationName(path: string): string {
  const fileName = path.split('/').at(-1) ?? path
  return fileName.replace(/\.pbanim$/i, '')
}

function GroupPath({ openGroups }: { openGroups: readonly string[] }): ReactElement {
  const { store } = useSession()
  const wholeProject = useEditorState((state) => state.wholeProject)
  const documents = useEditorState((state) => state.documents)
  const mediaStates = useEditorState((state) => state.mediaStates)
  const steps: { label: string; depth: number }[] = [{ label: 'Project', depth: 0 }]
  let documentPath: string | undefined
  for (const depth of openGroups.keys()) {
    const opened = resolveScope(wholeProject, documents, mediaStates, openGroups.slice(0, depth + 1))
    let label = openGroups.length === 1 ? 'Group' : `Group ${depth + 1}`
    if (opened.documentPath !== undefined && opened.documentPath !== documentPath) label = animationName(opened.documentPath)
    documentPath = opened.documentPath
    steps.push({ label, depth: depth + 1 })
  }
  return (
    <nav className="group-path" aria-label="Open group" data-testid="group-path">
      {steps.map((step) =>
        step.depth === openGroups.length ? (
          <span key={step.depth} className="group-path-here" aria-current="location">
            {step.label}
          </span>
        ) : (
          <button key={step.depth} type="button" className="button" data-testid={`group-path-${step.depth}`} onClick={() => store.closeGroups(step.depth)}>
            <Icon name="chevronLeft" />
            {step.label}
          </button>
        ),
      )}
    </nav>
  )
}

export function Timeline(): ReactElement {
  const session = useSession()
  const { store, actions } = session
  const zoomOutKeys = useShortcutHint('timeline-zoom-out')
  const zoomFitKeys = useShortcutHint('timeline-zoom-fit')
  const zoomInKeys = useShortcutHint('timeline-zoom-in')
  const splitKeys = useShortcutHint('split')
  const exportKeys = useShortcutHint('export')
  const tracks = useEditorState((state) => state.project.tracks)
  const expandedTracks = useEditorState((state) => state.expandedTracks)
  const rows = useMemo(() => trackRowsOf(tracks, expandedTracks), [tracks, expandedTracks])
  const isSnapping = useEditorState((state) => state.isSnapping)
  const hasSelection = useEditorState((state) => state.selection.length > 0)
  const openCount = useEditorState((state) => state.openCount)
  const openGroups = useEditorState((state) => state.openGroups)
  const hasContent = useEditorState((state) => projectDuration(state.wholeProject) > 0)
  let exportTooltip = 'Add something to the timeline first'
  if (hasContent) exportTooltip = exportKeys === undefined ? 'Export' : `Export (${exportKeys})`
  const hostRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLCanvasElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const headersRef = useRef<HTMLDivElement>(null)
  const scrollbarRef = useRef<HTMLDivElement>(null)
  const scrollSpanRef = useRef<HTMLDivElement>(null)
  const controllerRef = useRef<TimelineController | undefined>(undefined)
  const [menu, setMenu] = useState<OpenMenu | undefined>(undefined)
  const closeMenu = useCallback(() => setMenu(undefined), [])
  const [speedClipIds, setSpeedClipIds] = useState<readonly string[] | undefined>(undefined)

  useEffect(() => {
    const host = hostRef.current
    const content = contentRef.current
    const overlay = overlayRef.current
    const headers = headersRef.current
    const scrollbar = scrollbarRef.current
    const scrollSpan = scrollSpanRef.current
    if (host === null || content === null || overlay === null || headers === null || scrollbar === null || scrollSpan === null) return
    const controller = createTimelineController({ host, content, overlay, headers, scrollbar, scrollSpan }, session, (at, target) => setMenu({ at, target }))
    controllerRef.current = controller
    return () => controller.dispose()
  }, [session])

  useEffect(() => controllerRef.current?.zoomToFit(true), [openCount, openGroups])

  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent): void {
      if (!isKeyForTheEditor(event)) return
      const shortcut = actionFor(session.shortcuts.get(), event)
      if (shortcut === 'timeline-zoom-in') controllerRef.current?.zoomBy(ZOOM_STEP)
      else if (shortcut === 'timeline-zoom-out') controllerRef.current?.zoomBy(1 / ZOOM_STEP)
      else if (shortcut === 'timeline-zoom-fit') controllerRef.current?.zoomToFit()
      else return
      event.preventDefault()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [session])

  const canSeparateAudio = menu !== undefined && actions.canSeparateAudio()
  const withSpeed = menu === undefined ? [] : clipsWithSpeed(store.getState().project, store.getState().selection)
  const clipMenu: MenuItem[] = [
    { label: 'Split at Playhead', testId: 'menu-split', onSelect: actions.split },
    { label: 'Speed…', testId: 'menu-speed', isDisabled: withSpeed.length === 0, onSelect: () => setSpeedClipIds(withSpeed) },
    { label: 'Separate Video and Audio', testId: 'menu-separate-audio', isDisabled: !canSeparateAudio, onSelect: actions.separateAudio },
    { label: 'Group', testId: 'menu-group', isDisabled: !hasSelection, onSelect: actions.group },
    { label: 'Ungroup', testId: 'menu-ungroup', isDisabled: !hasSelection, onSelect: actions.ungroup },
    { label: 'Copy', testId: 'menu-copy', isDisabled: !hasSelection, onSelect: actions.copy },
    { label: 'Paste', testId: 'menu-paste', onSelect: actions.paste },
    { label: 'Duplicate', testId: 'menu-duplicate', isDisabled: !hasSelection, onSelect: actions.duplicate },
    { label: 'Delete', testId: 'menu-delete', isDisabled: !hasSelection, onSelect: () => actions.deleteSelection(false) },
    { label: 'Ripple Delete', testId: 'menu-ripple-delete', isDisabled: !hasSelection, onSelect: () => actions.deleteSelection(true) },
  ]

  const target = menu?.target
  let menuLabel = 'Clip'
  let menuItems = clipMenu
  if (target?.kind === 'volume') {
    const { clipId, index } = target
    menuLabel = 'Volume keyframe'
    menuItems = [
      ...easingItems((easing) => {
        store.apply('Change Keyframe Easing', (project) => changeKeyframe(project, clipId, 'volume', index, { easing }))
      }),
      {
        label: 'Delete Keyframe',
        testId: 'menu-keyframe-delete',
        onSelect: () => store.apply('Delete Volume Keyframe', (project) => removeKeyframe(project, clipId, 'volume', index)),
      },
    ]
  } else if (target?.kind === 'zoom') {
    const { index } = target
    menuLabel = 'Zoom'
    menuItems = [
      ...easingItems((easing) => {
        store.apply('Change Zoom Easing', (project) => setZoom(project, index, { easing }, frameDuration(project.canvas.frameRate)))
      }),
      { label: 'Delete Zoom', testId: 'menu-zoom-delete', onSelect: () => store.apply('Delete Zoom', (project) => deleteZoom(project, index)) },
    ]
  }

  return (
    <div className="timeline">
      <div className="timeline-toolbar" role="toolbar" aria-label="Timeline tools">
        <IconButton icon="plus" label="Add track" testId="add-track" onClick={actions.addTrack} />
        <IconButton icon="scissors" label="Split at playhead" testId="split" shortcut={splitKeys} onClick={actions.split} />
        <IconButton icon="magnet" label="Snapping" testId="snapping" isPressed={isSnapping} onClick={() => store.setSnapping(!isSnapping)} />
        {openGroups.length > 0 && <GroupPath openGroups={openGroups} />}
        <span className="spacer" />
        <IconButton icon="minus" label="Zoom out" testId="timeline-zoom-out" shortcut={zoomOutKeys} onClick={() => controllerRef.current?.zoomBy(1 / ZOOM_STEP)} />
        <IconButton icon="fit" label="Show the whole project" testId="timeline-zoom-fit" shortcut={zoomFitKeys} onClick={() => controllerRef.current?.zoomToFit()} />
        <IconButton icon="plus" label="Zoom in" testId="timeline-zoom-in" shortcut={zoomInKeys} onClick={() => controllerRef.current?.zoomBy(ZOOM_STEP)} />
        <button
          type="button"
          className="button primary with-icon"
          data-testid="export"
          data-tooltip={exportTooltip}
          disabled={!hasContent}
          onClick={() => store.showExportDialog(true)}
        >
          <Icon name="export" />
          Export
        </button>
      </div>
      <div className="timeline-body">
        <div className="track-headers-viewport">
          <div className="camera-lane-header">
            <Icon name="zoom" />
            Camera
          </div>
          <div className="track-headers" ref={headersRef}>
            {tracks.map((track, index) => <TrackHeader key={track.id} track={track} index={index} rows={rows} />).reverse()}
          </div>
        </div>
        <div className="timeline-canvases" ref={hostRef} data-testid="timeline">
          <canvas ref={contentRef} aria-hidden="true" />
          <canvas ref={overlayRef} aria-label="Timeline" />
        </div>
      </div>
      <div className="timeline-scrollbar" ref={scrollbarRef} data-testid="timeline-scrollbar">
        <div ref={scrollSpanRef} />
      </div>
      {menu !== undefined && <PopupMenu label={menuLabel} items={menuItems} at={menu.at} onClose={closeMenu} />}
      {speedClipIds !== undefined && <SpeedDialog clipIds={speedClipIds} onClose={() => setSpeedClipIds(undefined)} />}
    </div>
  )
}
