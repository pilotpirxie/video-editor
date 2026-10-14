import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactElement } from 'react'
import { deleteZoom, setZoom } from '../editor/camera.js'
import { locateClip } from '../editor/clips.js'
import { changeKeyframe, removeKeyframe } from '../editor/properties.js'
import { shortcutFor, shortcutHint } from '../editor/shortcuts.js'
import { TRACK_HEIGHT } from '../editor/timelineView.js'
import { addTrack, deleteTrack, moveTrack, renameTrack, setTrackFlag, type TrackFlag } from '../editor/tracks.js'
import type { Easing, Track } from '../shared/project.js'
import { frameDuration } from '../shared/time.js'
import { useEditorState, useSession } from './context.js'
import { Icon, IconButton, type IconName } from './icons.js'
import { PopupMenu, type MenuItem } from './Menu.js'
import { createTimelineController, type MenuTarget, type TimelineController } from './timelineController.js'
import { isKeyForTheEditor } from './transport.js'

const ZOOM_STEP = 1.5

type Point = {
  x: number
  y: number
}

// The menu of the timeline, and the volume keyframe or zoom it was opened on, if any.
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

const FLAGS: readonly { flag: TrackFlag; icon: IconName; on: string; off: string }[] = [
  { flag: 'locked', icon: 'lock', on: 'Unlock Track', off: 'Lock Track' },
  { flag: 'hidden', icon: 'eye', on: 'Show Track', off: 'Hide Track' },
  { flag: 'muted', icon: 'speaker', on: 'Unmute Track', off: 'Mute Track' },
]

function TrackHeader({ track, index }: { track: Track; index: number }): ReactElement {
  const { store } = useSession()
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

  // Dragging a header up by one row moves the track one layer up; the top row is the top layer.
  function onGripUp(event: PointerEvent<HTMLDivElement>): void {
    const from = dragFromRef.current
    dragFromRef.current = undefined
    if (from === undefined) return
    const rows = Math.round((event.clientY - from) / TRACK_HEIGHT)
    if (rows !== 0) store.apply('Reorder Tracks', (project) => moveTrack(project, track.id, index - rows))
  }

  const menuItems: MenuItem[] = [
    { label: 'Add Track Above', testId: 'track-add-above', onSelect: () => store.apply('Add Track', (project) => addTrack(project, { id: crypto.randomUUID(), name: `Track ${project.tracks.length + 1}` }, index + 1)) },
    { label: 'Move Up', testId: 'track-move-up', onSelect: () => store.apply('Reorder Tracks', (project) => moveTrack(project, track.id, index + 1)) },
    { label: 'Move Down', testId: 'track-move-down', isDisabled: index === 0, onSelect: () => store.apply('Reorder Tracks', (project) => moveTrack(project, track.id, index - 1)) },
    { label: 'Rename', testId: 'track-rename', onSelect: () => setDraftName(track.name) },
    { label: 'Delete Track', testId: 'track-delete', onSelect: () => store.apply('Delete Track', (project) => deleteTrack(project, track.id)) },
  ]

  return (
    <div
      className="track-header"
      data-testid={`track-${index}`}
      onContextMenu={(event) => {
        event.preventDefault()
        setMenuAt({ x: event.clientX, y: event.clientY })
      }}
    >
      <div className="track-grip" onPointerDown={onGripDown} onPointerUp={onGripUp} onPointerCancel={() => (dragFromRef.current = undefined)} onDoubleClick={() => setDraftName(track.name)}>
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
      {FLAGS.map(({ flag, icon, on, off }) => (
        <IconButton
          key={flag}
          icon={icon}
          label={track[flag] ? on : off}
          testId={`track-${flag}-${index}`}
          isPressed={track[flag]}
          onClick={() => store.apply(track[flag] ? on : off, (project) => setTrackFlag(project, track.id, flag, !track[flag]))}
        />
      ))}
      {menuAt !== undefined && <PopupMenu label="Track" items={menuItems} at={menuAt} onClose={closeMenu} />}
    </div>
  )
}

// The way into the open group, from the project down. Each step before the last closes the groups after it.
function GroupPath({ openGroups }: { openGroups: readonly string[] }): ReactElement {
  const { store } = useSession()
  const wholeProject = useEditorState((state) => state.wholeProject)
  const steps: { label: string; depth: number }[] = [{ label: 'Project', depth: 0 }]
  let project = wholeProject
  for (const [index, groupId] of openGroups.entries()) {
    const group = locateClip(project, groupId)?.clip
    if (group?.type !== 'group') break
    steps.push({ label: openGroups.length === 1 ? 'Group' : `Group ${index + 1}`, depth: index + 1 })
    project = { ...project, tracks: group.tracks }
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
  const tracks = useEditorState((state) => state.project.tracks)
  const isSnapping = useEditorState((state) => state.isSnapping)
  const hasSelection = useEditorState((state) => state.selection.length > 0)
  const openCount = useEditorState((state) => state.openCount)
  const openGroups = useEditorState((state) => state.openGroups)
  const hostRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLCanvasElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const headersRef = useRef<HTMLDivElement>(null)
  const controllerRef = useRef<TimelineController | undefined>(undefined)
  const [menu, setMenu] = useState<OpenMenu | undefined>(undefined)
  const closeMenu = useCallback(() => setMenu(undefined), [])

  useEffect(() => {
    const host = hostRef.current
    const content = contentRef.current
    const overlay = overlayRef.current
    const headers = headersRef.current
    if (host === null || content === null || overlay === null || headers === null) return
    const controller = createTimelineController({ host, content, overlay, headers }, session, (at, target) => setMenu({ at, target }))
    controllerRef.current = controller
    return () => controller.dispose()
  }, [session])

  // A new document and another group are another timeline, which is shown whole.
  useEffect(() => controllerRef.current?.zoomToFit(), [openCount, openGroups])

  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent): void {
      if (!isKeyForTheEditor(event)) return
      const shortcut = shortcutFor(event)
      if (shortcut === 'timeline-zoom-in') controllerRef.current?.zoomBy(ZOOM_STEP)
      else if (shortcut === 'timeline-zoom-out') controllerRef.current?.zoomBy(1 / ZOOM_STEP)
      else if (shortcut === 'timeline-zoom-fit') controllerRef.current?.zoomToFit()
      else return
      event.preventDefault()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // Worked out only while the menu is open: it looks at every selected clip.
  const canSeparateAudio = menu !== undefined && actions.canSeparateAudio()
  const clipMenu: MenuItem[] = [
    { label: 'Split at Playhead', testId: 'menu-split', onSelect: actions.split },
    { label: 'Separate Video and Audio', testId: 'menu-separate-audio', isDisabled: !canSeparateAudio, onSelect: actions.separateAudio },
    { label: 'Group', testId: 'menu-group', isDisabled: !hasSelection, onSelect: actions.group },
    { label: 'Ungroup', testId: 'menu-ungroup', isDisabled: !hasSelection, onSelect: actions.ungroup },
    { label: 'Copy', testId: 'menu-copy', isDisabled: !hasSelection, onSelect: actions.copy },
    { label: 'Paste', testId: 'menu-paste', onSelect: actions.paste },
    { label: 'Duplicate', testId: 'menu-duplicate', isDisabled: !hasSelection, onSelect: actions.duplicate },
    { label: 'Delete', testId: 'menu-delete', isDisabled: !hasSelection, onSelect: () => actions.deleteSelection(false) },
    { label: 'Ripple Delete', testId: 'menu-ripple-delete', isDisabled: !hasSelection, onSelect: () => actions.deleteSelection(true) },
  ]

  // The menu of a volume keyframe: how the volume gets from it to the next one, and a way to take it out.
  // The menu of a zoom: how the camera moves to it, and a way to take it out.
  const { target } = menu ?? {}
  let targetMenu: MenuItem[] = []
  if (target?.kind === 'volume') {
    targetMenu = [
      ...easingItems((easing) => store.apply('Change Keyframe Easing', (project) => changeKeyframe(project, target.clipId, 'volume', target.index, { easing }))),
      { label: 'Delete Keyframe', testId: 'menu-keyframe-delete', onSelect: () => store.apply('Delete Volume Keyframe', (project) => removeKeyframe(project, target.clipId, 'volume', target.index)) },
    ]
  } else if (target?.kind === 'zoom') {
    targetMenu = [
      ...easingItems((easing) => store.apply('Change Zoom Easing', (project) => setZoom(project, target.index, { easing }, frameDuration(project.canvas.frameRate)))),
      { label: 'Delete Zoom', testId: 'menu-zoom-delete', onSelect: () => store.apply('Delete Zoom', (project) => deleteZoom(project, target.index)) },
    ]
  }
  const menuLabel = target?.kind === 'zoom' ? 'Zoom' : 'Volume keyframe'

  return (
    <div className="timeline">
      <div className="timeline-toolbar" role="toolbar" aria-label="Timeline tools">
        <IconButton icon="plus" label="Add track" testId="add-track" onClick={actions.addTrack} />
        <IconButton icon="scissors" label="Split at playhead" testId="split" shortcut="⌘T" onClick={actions.split} />
        <IconButton icon="magnet" label="Snapping" testId="snapping" isPressed={isSnapping} onClick={() => store.setSnapping(!isSnapping)} />
        {openGroups.length > 0 && <GroupPath openGroups={openGroups} />}
        <span className="spacer" />
        <IconButton icon="minus" label="Zoom out" testId="timeline-zoom-out" shortcut={shortcutHint('timeline-zoom-out')} onClick={() => controllerRef.current?.zoomBy(1 / ZOOM_STEP)} />
        <IconButton icon="fit" label="Show the whole project" testId="timeline-zoom-fit" shortcut={shortcutHint('timeline-zoom-fit')} onClick={() => controllerRef.current?.zoomToFit()} />
        <IconButton icon="plus" label="Zoom in" testId="timeline-zoom-in" shortcut={shortcutHint('timeline-zoom-in')} onClick={() => controllerRef.current?.zoomBy(ZOOM_STEP)} />
      </div>
      <div className="timeline-body">
        <div className="track-headers-viewport">
          <div className="camera-lane-header">
            <Icon name="zoom" />
            Camera
          </div>
          <div className="track-headers" ref={headersRef}>
            {tracks.map((track, index) => <TrackHeader key={track.id} track={track} index={index} />).reverse()}
          </div>
        </div>
        <div className="timeline-canvases" ref={hostRef} data-testid="timeline">
          <canvas ref={contentRef} aria-hidden="true" />
          <canvas ref={overlayRef} aria-label="Timeline" />
        </div>
      </div>
      {menu !== undefined && <PopupMenu label={target === undefined ? 'Clip' : menuLabel} items={target === undefined ? clipMenu : targetMenu} at={menu.at} onClose={closeMenu} />}
    </div>
  )
}
