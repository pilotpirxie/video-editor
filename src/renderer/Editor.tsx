import { useEffect, useEffectEvent, useRef, useState, useSyncExternalStore, type CSSProperties, type DragEvent, type KeyboardEvent, type PointerEvent, type ReactElement } from 'react'
import { clampLayout, parseLayout, widestSidebar, type Layout } from '../editor/layout.js'
import { actionFor, type ShortcutAction } from '../editor/shortcuts.js'
import type { Size } from '../shared/exportPresets.js'
import { logError } from '../shared/log.js'
import { CanvasPanel } from './CanvasPanel.js'
import { SessionContext, useEditorState, useSession } from './context.js'
import { EffectProperties } from './EffectProperties.js'
import { ExportDialog, ExportProgressDialog } from './ExportDialog.js'
import type { Panel, Session } from './document.js'
import { AnnotationsTab, EffectsTab, TransitionsTab } from './LibraryTabs.js'
import { MediaTab } from './MediaTab.js'
import { Properties } from './Properties.js'
import { ShortcutSettings } from './ShortcutSettings.js'
import { Timeline } from './Timeline.js'
import { installTooltips } from './tooltip.js'
import { isKeyForTheEditor, isModalOpen, isTypingTarget } from './transport.js'

const LAYOUT_KEY = 'layout'
const KEYBOARD_RESIZE_STEP = 16
const JUMP_FRAMES = 15
const SIDEBAR_TABS = ['Media', 'Effects', 'Transitions', 'Annotations'] as const
const LETTER_OR_DIGIT_KEY = /^(?:Key|Digit)/
const PREVIEW_ACTIONS = new Set<ShortcutAction | undefined>([
  'play-pause',
  'step-back',
  'step-forward',
  'jump-back',
  'jump-forward',
  'previous-edit',
  'next-edit',
  'go-to-start',
  'go-to-end',
  'shuttle-back',
  'shuttle-stop',
  'shuttle-forward',
  'preview-mode',
])

const PANEL_FLAGS: Record<Panel, 'isLeftCollapsed' | 'isRightCollapsed' | 'isTimelineCollapsed'> = {
  library: 'isLeftCollapsed',
  properties: 'isRightCollapsed',
  timeline: 'isTimelineCollapsed',
}

type SidebarTab = (typeof SIDEBAR_TABS)[number]
type SizeKey = 'leftWidth' | 'rightWidth' | 'timelineHeight'

type SplitterProps = {
  label: string
  testId: string
  sizeKey: SizeKey
  size: number
  isHidden: boolean
  // +1 when dragging right or down makes the panel larger, -1 when it makes it smaller.
  growth: 1 | -1
  onPreview(sizeKey: SizeKey, size: number): void
  onResize(sizeKey: SizeKey, size: number): void
}

function windowSize(): Size {
  return { width: window.innerWidth, height: window.innerHeight }
}

function storedLayout(): Layout {
  return parseLayout(localStorage.getItem(LAYOUT_KEY) ?? undefined)
}

function Splitter({ label, testId, sizeKey, size, isHidden, growth, onPreview, onResize }: SplitterProps): ReactElement {
  const dragRef = useRef<{ pointer: number; size: number } | undefined>(undefined)
  const isHorizontal = sizeKey === 'timelineHeight'

  function pointerOf(event: PointerEvent<HTMLDivElement>): number {
    return isHorizontal ? event.clientY : event.clientX
  }

  function sizeAt(event: PointerEvent<HTMLDivElement>): number | undefined {
    const drag = dragRef.current
    return drag === undefined ? undefined : drag.size + (pointerOf(event) - drag.pointer) * growth
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>): void {
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = { pointer: pointerOf(event), size }
  }

  // While dragging, only a CSS variable changes; the panels re-render once, on release.
  function onPointerMove(event: PointerEvent<HTMLDivElement>): void {
    const dragged = sizeAt(event)
    if (dragged !== undefined) onPreview(sizeKey, dragged)
  }

  function onPointerUp(event: PointerEvent<HTMLDivElement>): void {
    const dragged = sizeAt(event)
    dragRef.current = undefined
    if (dragged !== undefined) onResize(sizeKey, dragged)
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const larger = isHorizontal ? 'ArrowDown' : 'ArrowRight'
    const smaller = isHorizontal ? 'ArrowUp' : 'ArrowLeft'
    if (event.key !== larger && event.key !== smaller) return
    event.preventDefault()
    const direction = event.key === larger ? 1 : -1
    onResize(sizeKey, size + direction * growth * KEYBOARD_RESIZE_STEP)
  }

  return (
    <div
      className={`splitter focusable ${sizeKey}`}
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={isHorizontal ? 'horizontal' : 'vertical'}
      aria-valuenow={Math.round(size)}
      data-testid={testId}
      hidden={isHidden}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        dragRef.current = undefined
        onPreview(sizeKey, size)
      }}
      onKeyDown={onKeyDown}
    />
  )
}

function Sidebar(): ReactElement {
  const [tab, setTab] = useState<SidebarTab>('Media')

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
    event.preventDefault()
    const direction = event.key === 'ArrowRight' ? 1 : -1
    const next = SIDEBAR_TABS[(SIDEBAR_TABS.indexOf(tab) + direction + SIDEBAR_TABS.length) % SIDEBAR_TABS.length]
    if (next !== undefined) setTab(next)
  }

  return (
    <>
      <div className="tabs" role="tablist" aria-label="Library" onKeyDown={onKeyDown}>
        {SIDEBAR_TABS.map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            className="tab focusable"
            aria-selected={tab === name}
            tabIndex={tab === name ? 0 : -1}
            data-testid={`tab-${name.toLowerCase()}`}
            onClick={() => setTab(name)}
          >
            {name}
          </button>
        ))}
      </div>
      <div className="tab-panel" role="tabpanel" aria-label={tab}>
        {tab === 'Media' && <MediaTab />}
        {tab === 'Effects' && <EffectsTab />}
        {tab === 'Transitions' && <TransitionsTab />}
        {tab === 'Annotations' && <AnnotationsTab />}
      </div>
    </>
  )
}

// A message floats over the top of the canvas until it is dismissed.
function Notice(): ReactElement {
  const { store } = useSession()
  const notice = useEditorState((state) => state.notice)
  return (
    <div className="notice-area">
      {notice !== undefined && (
        <div className="notice" role="alert">
          <span data-testid="notice">{notice}</span>
          <button type="button" className="button" onClick={() => store.notify(undefined)}>
            Dismiss
          </button>
        </div>
      )}
    </div>
  )
}

// Runs the action of a shortcut and says whether it was handled here; the timeline handles its own zoom keys.
function runShortcut({ actions, transport, runMenuAction }: Session, action: ShortcutAction): boolean {
  switch (action) {
    case 'play-pause':
      void transport.toggle()
      return true
    case 'step-back':
      actions.stepFrames(-1)
      return true
    case 'step-forward':
      actions.stepFrames(1)
      return true
    case 'jump-back':
      actions.stepFrames(-JUMP_FRAMES)
      return true
    case 'jump-forward':
      actions.stepFrames(JUMP_FRAMES)
      return true
    case 'previous-edit':
      actions.jumpToEdit(-1)
      return true
    case 'next-edit':
      actions.jumpToEdit(1)
      return true
    case 'go-to-start':
      actions.jumpTo('start')
      return true
    case 'go-to-end':
      actions.jumpTo('end')
      return true
    case 'shuttle-back':
      actions.shuttle(-1)
      return true
    case 'shuttle-stop':
      transport.pause()
      return true
    case 'shuttle-forward':
      actions.shuttle(1)
      return true
    case 'timeline-zoom-in':
    case 'timeline-zoom-out':
    case 'timeline-zoom-fit':
      return false
    case 'split':
    case 'split-all':
    case 'duplicate':
    case 'delete':
    case 'ripple-delete':
    case 'group':
    case 'ungroup':
    case 'import':
    case 'export':
    case 'preview-mode':
      runMenuAction(action)
      return true
  }
}

// Plain keys belong to a text field that has the focus. A text field has no use for Cmd with a letter or a digit, except the standard keys, which are not shortcuts here.
function isShortcutFor(event: globalThis.KeyboardEvent): boolean {
  if (isKeyForTheEditor(event)) return true
  const isCommandKey = event.metaKey && LETTER_OR_DIGIT_KEY.test(event.code)
  return isCommandKey && isTypingTarget(event.target) && !isModalOpen() && !event.defaultPrevented
}

// The shortcuts, as chosen on this Mac, the Escape key and the system clipboard shortcuts work on the project, unless a text field or a dialog needs the keys.
function listenForEditingKeys(session: Session): () => void {
  const { actions, store, shortcuts } = session

  function onKeyDown(event: globalThis.KeyboardEvent): void {
    const action = actionFor(shortcuts.get(), event)
    // In preview mode the clips cannot be seen, so only the transport and leaving the mode answer to keys.
    const isAllowed = !store.getState().isPreviewing || PREVIEW_ACTIONS.has(action)
    if (action !== undefined && isAllowed && isShortcutFor(event) && runShortcut(session, action)) {
      event.preventDefault()
      return
    }
    if (!isKeyForTheEditor(event) || event.key !== 'Escape') return
    // Escape abandons a drag in progress, wherever it started; only with nothing in progress does it leave preview mode, then clear the selection.
    // After that it leaves the group that is open.
    if (store.cancel()) event.preventDefault()
    else if (store.getState().isPreviewing) store.setPreviewing(false)
    else if (store.getState().selection.length > 0) store.select([])
    else actions.closeGroup()
  }

  const abandonDrag = (): void => void store.cancel()

  function onClipboard(event: ClipboardEvent): void {
    if (isTypingTarget(document.activeElement) || isModalOpen()) return
    event.preventDefault()
    if (event.type === 'copy') actions.copy()
    else if (event.type === 'cut') actions.cut()
    else actions.paste()
  }

  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('blur', abandonDrag)
  document.addEventListener('copy', onClipboard)
  document.addEventListener('cut', onClipboard)
  document.addEventListener('paste', onClipboard)
  return () => {
    window.removeEventListener('keydown', onKeyDown)
    window.removeEventListener('blur', abandonDrag)
    document.removeEventListener('copy', onClipboard)
    document.removeEventListener('cut', onClipboard)
    document.removeEventListener('paste', onClipboard)
  }
}

function SettingsWhenOpen(): ReactElement | undefined {
  const isOpen = useEditorState((state) => state.isSettingsOpen)
  return isOpen ? <ShortcutSettings /> : undefined
}

// First the choices, then, from the moment the export starts until its result has been read, how it is going.
function ExportDialogWhenOpen(): ReactElement | undefined {
  const isChoosing = useEditorState((state) => state.isExportDialogOpen)
  const isExporting = useEditorState((state) => state.exportStatus !== undefined)
  if (isExporting) return <ExportProgressDialog />
  return isChoosing ? <ExportDialog /> : undefined
}

export function Editor({ session, preview }: { session: Session; preview: HTMLCanvasElement }): ReactElement {
  const rootRef = useRef<HTMLDivElement>(null)
  // The session is provided below this component, so its store is read directly.
  const isPreviewing = useSyncExternalStore(session.store.subscribe, () => session.store.getState().isPreviewing)
  const [stored, setStored] = useState<Layout>(storedLayout)
  const [size, setSize] = useState<Size>(windowSize)
  const layout = clampLayout(stored, size)

  useEffect(() => {
    const onResize = (): void => setSize(windowSize())
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => (rootRef.current === null ? undefined : installTooltips(rootRef.current)), [])
  useEffect(() => listenForEditingKeys(session), [session])

  const togglePanel = useEffectEvent((panel: Panel) => {
    const flag = PANEL_FLAGS[panel]
    remember({ ...layout, [flag]: !layout[flag] })
  })
  useEffect(() => session.onPanelToggle(togglePanel), [session])

  function remember(next: Layout): void {
    setStored(next)
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(next))
    } catch (error) {
      logError('Could not remember the window layout', error)
    }
  }

  // A sidebar grows at the cost of the canvas only: the other sidebar stays as wide as it is.
  function showSize(sizeKey: SizeKey, dragged: number): Layout {
    const wanted = sizeKey === 'timelineHeight' ? dragged : Math.min(dragged, widestSidebar(layout, sizeKey, size))
    const resized = clampLayout({ ...layout, [sizeKey]: wanted }, size)
    rootRef.current?.style.setProperty(`--${sizeKey}`, `${resized[sizeKey]}px`)
    return resized
  }

  function resize(sizeKey: SizeKey, dragged: number): void {
    remember(showSize(sizeKey, dragged))
  }

  function onFilesDropped(event: DragEvent<HTMLDivElement>): void {
    // The default is always prevented: a file dropped on the window would otherwise be opened in place of the editor.
    event.preventDefault()
    if (isModalOpen()) return
    const paths = [...event.dataTransfer.files].map((file) => window.host.pathOfFile(file))
    if (paths.length > 0) void session.importFiles(paths)
  }

  const variables: Record<string, string> = {
    '--leftWidth': `${layout.isLeftCollapsed ? 0 : layout.leftWidth}px`,
    '--rightWidth': `${layout.isRightCollapsed ? 0 : layout.rightWidth}px`,
    '--timelineHeight': `${layout.isTimelineCollapsed ? 0 : layout.timelineHeight}px`,
  }
  const style: CSSProperties = variables

  return (
    <SessionContext value={session}>
      <div className={isPreviewing ? 'editor previewing' : 'editor'} ref={rootRef} style={style} data-testid="editor" onDragOver={(event) => event.preventDefault()} onDrop={onFilesDropped}>
        <aside className="sidebar left" aria-label="Library" data-testid="left-sidebar" hidden={layout.isLeftCollapsed}>
          <Sidebar />
        </aside>
        <Splitter label="Resize library panel" testId="split-left" sizeKey="leftWidth" size={layout.leftWidth} isHidden={layout.isLeftCollapsed} growth={1} onPreview={showSize} onResize={resize} />
        <CanvasPanel preview={preview} />
        <Splitter label="Resize properties panel" testId="split-right" sizeKey="rightWidth" size={layout.rightWidth} isHidden={layout.isRightCollapsed} growth={-1} onPreview={showSize} onResize={resize} />
        <aside className="sidebar right" aria-label="Properties" data-testid="right-sidebar" hidden={layout.isRightCollapsed}>
          <Properties />
          <EffectProperties />
        </aside>
        <Splitter label="Resize timeline" testId="split-timeline" sizeKey="timelineHeight" size={layout.timelineHeight} isHidden={layout.isTimelineCollapsed} growth={-1} onPreview={showSize} onResize={resize} />
        <section className="timeline-panel" aria-label="Timeline" data-testid="timeline-panel" hidden={layout.isTimelineCollapsed}>
          <Timeline />
        </section>
        <Notice />
        <ExportDialogWhenOpen />
        <SettingsWhenOpen />
      </div>
    </SessionContext>
  )
}
