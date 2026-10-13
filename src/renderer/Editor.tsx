import { useEffect, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type PointerEvent, type ReactElement } from 'react'
import { clampLayout, parseLayout, type Layout } from '../editor/layout.js'
import type { Size } from '../shared/exportPresets.js'
import { logError } from '../shared/log.js'
import { CanvasPanel } from './CanvasPanel.js'
import { SessionContext, useEditorState, useSession } from './context.js'
import type { Session } from './document.js'
import { IconButton } from './icons.js'
import { MediaTab } from './MediaTab.js'
import { Properties } from './Properties.js'
import { Timeline } from './Timeline.js'
import { installTooltips } from './tooltip.js'
import { isTypingTarget, onSpaceKey } from './transport.js'

const LAYOUT_KEY = 'layout'
const KEYBOARD_RESIZE_STEP = 16
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

function Sidebar(): ReactElement {
  const [tab, setTab] = useState<SidebarTab>('Media')

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
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
        {tab === 'Media' ? <MediaTab /> : <p className="empty-state">Nothing here yet.</p>}
      </div>
    </>
  )
}

function TopBar({ layout, onToggle }: { layout: Layout; onToggle(key: 'isLeftCollapsed' | 'isRightCollapsed' | 'isTimelineCollapsed'): void }): ReactElement {
  const { store } = useSession()
  const undoLabel = useEditorState((state) => state.history.done.at(-1)?.label)
  const redoLabel = useEditorState((state) => state.history.undone.at(-1)?.label)
  const notice = useEditorState((state) => state.notice)

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
      <IconButton icon="panelBottom" label="Timeline" testId="toggle-timeline" isPressed={!layout.isTimelineCollapsed} onClick={() => onToggle('isTimelineCollapsed')} />
      <IconButton icon="panelRight" label="Properties panel" testId="toggle-right" isPressed={!layout.isRightCollapsed} onClick={() => onToggle('isRightCollapsed')} />
    </header>
  )
}

// Delete keys and the system clipboard shortcuts edit clips, unless a text field has the focus and needs them for typing.
function listenForEditingKeys(session: Session): () => void {
  const { actions, store } = session

  function onKeyDown(event: globalThis.KeyboardEvent): void {
    if (isTypingTarget(event.target)) return
    if (event.key === 'Backspace' || event.key === 'Delete') {
      event.preventDefault()
      actions.deleteSelection(event.metaKey)
    } else if (event.key === 'Escape' && !event.defaultPrevented) {
      // Escape abandons a drag in progress, wherever it started; only with nothing in progress does it clear the selection.
      if (store.cancel()) event.preventDefault()
      else store.select([])
    }
  }

  const abandonDrag = (): void => void store.cancel()

  function onClipboard(event: ClipboardEvent): void {
    if (isTypingTarget(document.activeElement)) return
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
  useEffect(() => onSpaceKey(() => void session.transport.toggle()), [session])
  useEffect(() => listenForEditingKeys(session), [session])

  function remember(next: Layout): void {
    setStored(next)
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(next))
    } catch (error) {
      logError('Could not remember the window layout', error)
    }
  }

  function showSize(sizeKey: SizeKey, dragged: number): Layout {
    const resized = clampLayout({ ...layout, [sizeKey]: dragged }, size)
    rootRef.current?.style.setProperty(`--${sizeKey}`, `${resized[sizeKey]}px`)
    return resized
  }

  function resize(sizeKey: SizeKey, dragged: number): void {
    remember(showSize(sizeKey, dragged))
  }

  function onFilesDropped(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault()
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
        </aside>
        <Splitter label="Resize timeline" testId="split-timeline" sizeKey="timelineHeight" size={layout.timelineHeight} isHidden={layout.isTimelineCollapsed} growth={-1} onPreview={showSize} onResize={resize} />
        <section className="timeline-panel" aria-label="Timeline" data-testid="timeline-panel" hidden={layout.isTimelineCollapsed}>
          <Timeline />
        </section>
      </div>
    </SessionContext>
  )
}
