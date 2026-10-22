import { Component, useEffect, useEffectEvent, useRef, useState, useSyncExternalStore, type CSSProperties, type DragEvent, type ErrorInfo, type KeyboardEvent, type PointerEvent, type ReactElement, type ReactNode } from 'react'
import { clampLayout, parseLayout, widestSidebar, type Layout } from '../editor/layout.js'
import { actionFor, type ShortcutAction } from '../editor/shortcuts.js'
import type { Size } from '../shared/exportPresets.js'
import { describeErrorAsSentence, logError } from '../shared/log.js'
import { CacheLimitDialog } from './AppSettings.js'
import { CanvasPanel } from './CanvasPanel.js'
import { DebugInfo } from './DebugInfo.js'
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
    const wrappedIndex = (SIDEBAR_TABS.indexOf(tab) + direction + SIDEBAR_TABS.length) % SIDEBAR_TABS.length
    const next = SIDEBAR_TABS[wrappedIndex]
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

type PanelBoundaryProps = {
  panel: string
  children: ReactNode
}

type PanelBoundaryState = {
  error: unknown
  hasFailed: boolean
}

class PanelBoundary extends Component<PanelBoundaryProps, PanelBoundaryState> {
  override state: PanelBoundaryState = { error: undefined, hasFailed: false }

  static getDerivedStateFromError(error: unknown): PanelBoundaryState {
    return { error, hasFailed: true }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    logError('A panel stopped working', error, { panel: this.props.panel, componentStack: info.componentStack })
  }

  override render(): ReactNode {
    if (!this.state.hasFailed) return this.props.children
    return (
      <div className="panel-failed" role="alert" data-testid="panel-failed">
        <p>
          This panel stopped working: {describeErrorAsSentence(this.state.error)} Your work is safe; save with ⌘S.
        </p>
        <button type="button" className="button" onClick={() => this.setState({ error: undefined, hasFailed: false })}>
          Show Again
        </button>
      </div>
    )
  }
}

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

function isShortcutFor(event: globalThis.KeyboardEvent): boolean {
  if (isKeyForTheEditor(event)) return true
  const isCommandKey = event.metaKey && LETTER_OR_DIGIT_KEY.test(event.code)
  return isCommandKey && isTypingTarget(event.target) && !isModalOpen() && !event.defaultPrevented
}

function listenForEditingKeys(session: Session): () => void {
  const { actions, store, shortcuts } = session

  function onKeyDown(event: globalThis.KeyboardEvent): void {
    const action = actionFor(shortcuts.get(), event)
    const isAllowed = !store.getState().isPreviewing || PREVIEW_ACTIONS.has(action)
    const isShortcut = action !== undefined && isAllowed && isShortcutFor(event)
    if (isShortcut) {
      const isHandled = runShortcut(session, action)
      if (isHandled) {
        event.preventDefault()
        return
      }
    }
    if (!isKeyForTheEditor(event) || event.key !== 'Escape') return
    const hasCancelledGesture = store.cancel()
    if (hasCancelledGesture) event.preventDefault()
    else if (store.getState().isPreviewing) store.setPreviewing(false)
    else if (store.getState().selection.length > 0) store.select([])
    else actions.closeGroup()
  }

  function abandonDrag(): void {
    store.cancel()
  }

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

function CacheOfferWhenAsked(): ReactElement | undefined {
  const offer = useEditorState((state) => state.cacheOffer)
  return offer === undefined ? undefined : <CacheLimitDialog {...offer} />
}

function ExportDialogWhenOpen(): ReactElement | undefined {
  const isChoosing = useEditorState((state) => state.isExportDialogOpen)
  const isExporting = useEditorState((state) => state.exportStatus !== undefined)
  if (isExporting) return <ExportProgressDialog />
  return isChoosing ? <ExportDialog /> : undefined
}

export function Editor({ session, preview }: { session: Session; preview: HTMLCanvasElement }): ReactElement {
  const rootRef = useRef<HTMLDivElement>(null)
  const isPreviewing = useSyncExternalStore(session.store.subscribe, () => session.store.getState().isPreviewing)
  const isDebugShown = useSyncExternalStore(session.store.subscribe, () => session.store.getState().isDebugShown)
  const isOpening = useSyncExternalStore(session.store.subscribe, () => session.store.getState().openingName !== undefined)
  const [stored, setStored] = useState<Layout>(storedLayout)
  const [size, setSize] = useState<Size>(windowSize)
  const layout = clampLayout(stored, size)

  useEffect(() => {
    function onResize(): void {
      setSize(windowSize())
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    const root = rootRef.current
    if (root === null) return
    return installTooltips(root)
  }, [])
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
      <div className={isPreviewing ? 'editor previewing' : 'editor'} ref={rootRef} style={style} aria-busy={isOpening} data-testid="editor" onDragOver={(event) => event.preventDefault()} onDrop={onFilesDropped}>
        <aside className="sidebar left" aria-label="Library" data-testid="left-sidebar" hidden={layout.isLeftCollapsed}>
          <PanelBoundary panel="library">
            <Sidebar />
          </PanelBoundary>
        </aside>
        <Splitter label="Resize library panel" testId="split-left" sizeKey="leftWidth" size={layout.leftWidth} isHidden={layout.isLeftCollapsed} growth={1} onPreview={showSize} onResize={resize} />
        <PanelBoundary panel="canvas">
          <CanvasPanel preview={preview} />
        </PanelBoundary>
        <Splitter label="Resize properties panel" testId="split-right" sizeKey="rightWidth" size={layout.rightWidth} isHidden={layout.isRightCollapsed} growth={-1} onPreview={showSize} onResize={resize} />
        <aside className="sidebar right" aria-label="Properties" data-testid="right-sidebar" hidden={layout.isRightCollapsed}>
          <PanelBoundary panel="properties">
            <Properties />
            <EffectProperties />
            {isDebugShown && <DebugInfo />}
          </PanelBoundary>
        </aside>
        <Splitter label="Resize timeline" testId="split-timeline" sizeKey="timelineHeight" size={layout.timelineHeight} isHidden={layout.isTimelineCollapsed} growth={-1} onPreview={showSize} onResize={resize} />
        <section className="timeline-panel" aria-label="Timeline" data-testid="timeline-panel" hidden={layout.isTimelineCollapsed}>
          <PanelBoundary panel="timeline">
            <Timeline />
          </PanelBoundary>
        </section>
        <Notice />
        <PanelBoundary panel="dialog">
          <ExportDialogWhenOpen />
          <SettingsWhenOpen />
          <CacheOfferWhenAsked />
        </PanelBoundary>
      </div>
    </SessionContext>
  )
}
