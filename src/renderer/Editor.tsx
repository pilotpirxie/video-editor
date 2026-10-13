import { useEffect, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type PointerEvent, type ReactElement } from 'react'
import { clampLayout, parseLayout, widestSidebar, type Layout } from '../editor/layout.js'
import type { ShapeKind } from '../editor/shapes.js'
import { shortcutFor, type ShortcutAction } from '../editor/shortcuts.js'
import type { Size } from '../shared/exportPresets.js'
import { logError } from '../shared/log.js'
import { projectDuration } from '../shared/project.js'
import { CanvasPanel } from './CanvasPanel.js'
import { SessionContext, useEditorState, useSession } from './context.js'
import { EffectProperties } from './EffectProperties.js'
import { ExportDialog, ExportProgressDialog } from './ExportDialog.js'
import type { Session } from './document.js'
import { Icon, IconButton, type IconName } from './icons.js'
import { EffectsTab, TransitionsTab } from './LibraryTabs.js'
import { MediaTab } from './MediaTab.js'
import { Properties } from './Properties.js'
import { Timeline } from './Timeline.js'
import { installTooltips } from './tooltip.js'
import { isKeyForTheEditor, isModalOpen, isTypingTarget } from './transport.js'

const LAYOUT_KEY = 'layout'
const KEYBOARD_RESIZE_STEP = 16
const JUMP_FRAMES = 15
const SIDEBAR_TABS = ['Media', 'Effects', 'Transitions', 'Annotations'] as const

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

const SHAPES: readonly { kind: ShapeKind; icon: IconName; label: string }[] = [
  { kind: 'blur', icon: 'blur', label: 'Blur' },
  { kind: 'pixelate', icon: 'grid', label: 'Pixelate' },
  { kind: 'highlight', icon: 'marker', label: 'Highlight' },
  { kind: 'spotlight', icon: 'spotlight', label: 'Spotlight' },
]

// Callouts and arrows join these later; each is added at the playhead, on a layer of its own.
function AnnotationsTab(): ReactElement {
  const { actions } = useSession()
  return (
    <div className="annotations-tab">
      <button type="button" className="button annotation-item" data-testid="add-text" onClick={actions.addText}>
        <Icon name="text" />
        Text
      </button>
      <p className="hint">Adds a title at the playhead. Double-click it on the canvas to change the words.</p>
      {SHAPES.map(({ kind, icon, label }) => (
        <button key={kind} type="button" className="button annotation-item" data-testid={`add-${kind}`} onClick={() => actions.addShape(kind)}>
          <Icon name={icon} />
          {label}
        </button>
      ))}
      <p className="hint">Each acts on everything beneath it, inside its shape. Move and size it on the canvas; its look is in Properties.</p>
    </div>
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

function TopBar({ layout, onToggle }: { layout: Layout; onToggle(key: 'isLeftCollapsed' | 'isRightCollapsed' | 'isTimelineCollapsed'): void }): ReactElement {
  const { store } = useSession()
  const undoLabel = useEditorState((state) => state.history.done.at(-1)?.label)
  const redoLabel = useEditorState((state) => state.history.undone.at(-1)?.label)
  const notice = useEditorState((state) => state.notice)
  const hasContent = useEditorState((state) => projectDuration(state.project) > 0)

  return (
    <header className="top-bar">
      <IconButton icon="panelLeft" label="Library panel" testId="toggle-left" isPressed={!layout.isLeftCollapsed} onClick={() => onToggle('isLeftCollapsed')} />
      <IconButton icon="undo" label={undoLabel === undefined ? 'Undo' : `Undo ${undoLabel}`} testId="undo" isDisabled={undoLabel === undefined} onClick={store.undo} />
      <IconButton icon="redo" label={redoLabel === undefined ? 'Redo' : `Redo ${redoLabel}`} testId="redo" isDisabled={redoLabel === undefined} onClick={store.redo} />
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
      <button
        type="button"
        className="button primary"
        data-testid="export"
        data-tooltip={hasContent ? 'Export (⌘E)' : 'Add something to the timeline first'}
        disabled={!hasContent}
        onClick={() => store.showExportDialog(true)}
      >
        Export…
      </button>
      <IconButton icon="panelBottom" label="Timeline" testId="toggle-timeline" isPressed={!layout.isTimelineCollapsed} onClick={() => onToggle('isTimelineCollapsed')} />
      <IconButton icon="panelRight" label="Properties panel" testId="toggle-right" isPressed={!layout.isRightCollapsed} onClick={() => onToggle('isRightCollapsed')} />
    </header>
  )
}

// Says whether the shortcut was one of the transport's; the timeline handles its own zoom keys.
function runTransportShortcut({ actions, transport }: Session, action: ShortcutAction): boolean {
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
  }
}

// The transport keys, the delete keys and the system clipboard shortcuts work on the project, unless a text field has the focus and needs them for typing.
function listenForEditingKeys(session: Session): () => void {
  const { actions, store } = session

  function onKeyDown(event: globalThis.KeyboardEvent): void {
    if (!isKeyForTheEditor(event)) return
    const shortcut = shortcutFor(event)
    if (shortcut !== undefined && runTransportShortcut(session, shortcut)) {
      event.preventDefault()
    } else if (event.key === 'Backspace' || event.key === 'Delete') {
      event.preventDefault()
      actions.deleteSelection(event.metaKey)
    } else if (event.key === 'Escape') {
      // Escape abandons a drag in progress, wherever it started; only with nothing in progress does it clear the selection.
      if (store.cancel()) event.preventDefault()
      else store.select([])
    }
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

// First the choices, then, from the moment the export starts until its result has been read, how it is going.
function ExportDialogWhenOpen(): ReactElement | undefined {
  const isChoosing = useEditorState((state) => state.isExportDialogOpen)
  const isExporting = useEditorState((state) => state.exportStatus !== undefined)
  if (isExporting) return <ExportProgressDialog />
  return isChoosing ? <ExportDialog /> : undefined
}

export function Editor({ session, preview }: { session: Session; preview: HTMLCanvasElement }): ReactElement {
  const rootRef = useRef<HTMLDivElement>(null)
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
      <div className="editor" ref={rootRef} style={style} data-testid="editor" onDragOver={(event) => event.preventDefault()} onDrop={onFilesDropped}>
        <TopBar layout={layout} onToggle={(key) => remember({ ...layout, [key]: !layout[key] })} />
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
        <ExportDialogWhenOpen />
      </div>
    </SessionContext>
  )
}
