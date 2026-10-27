import { emptyTrack, locateClip } from '../editor/clips.js'
import { NEW_SHAPE_STYLE, pickableShape, type ColorPart, type ShapeRef, type ShapeStyle } from '../editor/drawings.js'
import { resolveScope, withScopedProject, type Scope } from '../editor/groups.js'
import { EMPTY_HISTORY, changedDocuments, record, redo, undo, type History, type Step, type Travel } from '../editor/history.js'
import type { MediaStates } from '../engine/resolve.js'
import type { Documents, LoadedAnimations, LoadedProject, MediaState } from '../shared/mediaProtocol.js'
import { PROJECT_VERSION, type Canvas, type Project, type Track } from '../shared/project.js'
import { DEFAULT_SETTINGS, type AppSettings } from '../shared/settings.js'

export type Edit = (project: Project) => Project

type DrawingTool = 'move' | 'rectangle' | 'ellipse'

type ExportStatus =
  | { phase: 'running'; fileName: string; done: number; total: number; startedAt: number }
  | { phase: 'done'; fileName: string }
  | { phase: 'failed'; fileName: string; message: string }

export type EditorState = {
  project: Project
  wholeProject: Project
  documents: Documents
  openGroups: readonly string[]
  openChain: readonly string[]
  openDocument: string | undefined
  scope: Scope | undefined
  mediaStates: MediaStates
  selection: readonly string[]
  selectedShapes: readonly ShapeRef[]
  tool: DrawingTool
  drawingStyle: ShapeStyle
  colorPart: ColorPart
  expandedTracks: ReadonlySet<string>
  selectedZoom: number | undefined
  history: History
  savedProject: Project
  savedDocuments: Documents
  documentPath: string | undefined
  notice: string | undefined
  isExportDialogOpen: boolean
  exportStatus: ExportStatus | undefined
  pendingImports: readonly string[]
  isSnapping: boolean
  isPreviewing: boolean
  isSettingsOpen: boolean
  isDebugShown: boolean
  settings: AppSettings
  cacheOffer: CacheOffer | undefined
  openCount: number
  editingTextId: string | undefined
  openingName: string | undefined
}

export type CacheOffer = {
  neededBytes: number
  offerGb: number
}

export type EditorStore = {
  getState(): EditorState
  committedProject(): Project
  committedDocuments(): Documents
  subscribe(listener: () => void): () => void
  open(loaded: LoadedProject, documentPath: string | undefined, isSaved: boolean, recoveredAnimations: readonly string[]): void
  apply(label: string, edit: Edit): void
  applyToFiles(label: string, editEpisode: Edit, editDocument?: Edit): void
  begin(label: string): void
  update(edit: Edit): boolean
  commit(): void
  cancel(): boolean
  undo(): void
  redo(): void
  select(clipIds: readonly string[]): void
  selectShapes(shapes: readonly ShapeRef[]): void
  setTool(tool: DrawingTool): void
  setDrawingColor(part: ColorPart, color: string): void
  setColorPart(part: ColorPart): void
  expandTrack(trackId: string, isExpanded: boolean): void
  openGroup(groupId: string): void
  closeGroups(depth: number): void
  selectZoom(index: number | undefined): void
  setMediaState(mediaId: string, state: MediaState): void
  setMediaStates(states: MediaStates): void
  addDocuments(loaded: LoadedAnimations): void
  markSaved(project: Project, documentPath: string): void
  markDocumentsSaved(documents: Documents): void
  notify(notice: string | undefined): void
  showExportDialog(isOpen: boolean): void
  setExportStatus(status: ExportStatus | undefined): void
  setPendingImports(paths: readonly string[]): void
  setSnapping(isSnapping: boolean): void
  setPreviewing(isPreviewing: boolean): void
  showSettings(isOpen: boolean): void
  showDebug(isShown: boolean): void
  setSettings(settings: AppSettings): void
  offerCacheLimit(offer: CacheOffer | undefined): void
  editText(clipId: string | undefined): void
  setOpening(name: string | undefined): void
}

export function updateStep(store: EditorStore, label: string, edit: Edit, isStepOpen: boolean): void {
  const hasReachedTheStep = isStepOpen && store.update(edit)
  if (hasReachedTheStep) return
  store.begin(label)
  store.update(edit)
}

type Gesture = {
  label: string
  base: Project
  baseDocuments: Documents
}

const NO_SELECTION: readonly string[] = []
const NO_SHAPES: readonly ShapeRef[] = []
const NO_DOCUMENTS: Documents = {}

const STARTING_TRACKS = 6
const STARTING_CANVAS: Canvas = { width: 1920, height: 1080, frameRate: { num: 30, den: 1 } }

function blankProject(): Project {
  const tracks: Track[] = []
  for (let index = 0; index < STARTING_TRACKS; index++) {
    tracks.push(emptyTrack({ id: crypto.randomUUID(), name: `Track ${index + 1}` }))
  }
  return { version: PROJECT_VERSION, canvas: STARTING_CANVAS, media: [], tracks }
}

function withoutMissingClips(selection: readonly string[], project: Project): readonly string[] {
  if (selection.length === 0) return selection
  const clipIds = new Set<string>()
  for (const track of project.tracks) {
    for (const clip of track.clips) clipIds.add(clip.id)
  }
  const kept = selection.filter((id) => clipIds.has(id))
  return kept.length === selection.length ? selection : kept
}

// Hiding or locking a chosen shape unselects it.
function withoutUnpickableShapes(selected: readonly ShapeRef[], project: Project): readonly ShapeRef[] {
  if (selected.length === 0) return selected
  const kept = selected.filter((shape) => {
    const clip = locateClip(project, shape.clipId)?.clip
    return clip?.type === 'drawing' && pickableShape(clip.shapes, shape.shapeId) !== undefined
  })
  return kept.length === selected.length ? selected : kept
}

export function createEditorStore(settings: AppSettings = DEFAULT_SETTINGS): EditorStore {
  const blank = blankProject()
  let state: EditorState = {
    project: blank,
    wholeProject: blank,
    documents: NO_DOCUMENTS,
    openGroups: NO_SELECTION,
    openChain: NO_SELECTION,
    openDocument: undefined,
    scope: undefined,
    mediaStates: {},
    selection: NO_SELECTION,
    selectedShapes: NO_SHAPES,
    tool: 'move',
    drawingStyle: NEW_SHAPE_STYLE,
    colorPart: 'fill',
    expandedTracks: new Set(),
    selectedZoom: undefined,
    history: EMPTY_HISTORY,
    savedProject: blank,
    savedDocuments: NO_DOCUMENTS,
    documentPath: undefined,
    notice: undefined,
    isExportDialogOpen: false,
    exportStatus: undefined,
    pendingImports: [],
    isSnapping: settings.isSnappingAtLaunch,
    isPreviewing: false,
    isSettingsOpen: false,
    isDebugShown: false,
    settings,
    cacheOffer: undefined,
    openCount: 0,
    editingTextId: undefined,
    openingName: undefined,
  }
  let gesture: Gesture | undefined
  const listeners = new Set<() => void>()

  function openTracksOf(next: EditorState): Pick<EditorState, 'openGroups' | 'openChain' | 'openDocument' | 'scope' | 'project'> {
    const opened = resolveScope(next.wholeProject, next.documents, next.mediaStates, next.openGroups)
    const scoped = opened.project
    const { project } = state
    const hasSameContent = scoped.tracks === project.tracks && scoped.media === project.media && scoped.canvas === project.canvas
    const isSameInside = opened.openGroups.length > 0 && hasSameContent && project.camera === undefined
    const openGroups = opened.openGroups.length === next.openGroups.length ? next.openGroups : opened.openGroups
    const openChain = opened.chain.join('/') === state.openChain.join('/') ? state.openChain : opened.chain
    return { openGroups, openChain, openDocument: opened.documentPath, scope: opened.scope, project: isSameInside ? project : scoped }
  }

  function setState(changes: Partial<Omit<EditorState, 'project' | 'scope' | 'openChain' | 'openDocument'>>): void {
    let next = { ...state, ...changes }
    const isRescoped = next.wholeProject !== state.wholeProject || next.documents !== state.documents || next.mediaStates !== state.mediaStates || next.openGroups !== state.openGroups
    if (isRescoped) next = { ...next, ...openTracksOf(next) }
    if (next.project !== state.project) {
      next.selection = withoutMissingClips(next.selection, next.project)
      next.selectedShapes = withoutUnpickableShapes(next.selectedShapes, next.project)
      const isEditedTextGone = next.editingTextId !== undefined && withoutMissingClips([next.editingTextId], next.project).length === 0
      if (isEditedTextGone) next.editingTextId = undefined
      const isZoomGone = next.selectedZoom !== undefined && next.project.camera?.[next.selectedZoom] === undefined
      if (isZoomGone) next.selectedZoom = undefined
    }
    state = next
    for (const listener of listeners) listener()
  }

  // Animations loaded during a gesture are not part of it, so they are kept.
  function documentsBefore(open: Gesture): Documents {
    const changed = changedDocuments(open.baseDocuments, state.documents)
    if (Object.keys(changed).length === 0) return state.documents
    const documents = { ...state.documents }
    for (const [path, change] of Object.entries(changed)) documents[path] = change.before
    return documents
  }

  function cancel(): boolean {
    if (gesture === undefined) return false
    const open = gesture
    gesture = undefined
    const documents = documentsBefore(open)
    if (state.wholeProject !== open.base || documents !== state.documents) setState({ wholeProject: open.base, documents })
    return true
  }

  function commit(): void {
    if (gesture === undefined) return
    const { label, base, baseDocuments } = gesture
    gesture = undefined
    const documents = changedDocuments(baseDocuments, state.documents)
    const hasChangedDocuments = Object.keys(documents).length > 0
    if (state.wholeProject === base && !hasChangedDocuments) return
    const step: Step = { label, before: base, after: state.wholeProject }
    if (hasChangedDocuments) step.documents = documents
    setState({ history: record(state.history, step, state.settings.undoSteps) })
  }

  function begin(label: string): void {
    cancel()
    gesture = { label, base: state.wholeProject, baseDocuments: state.documents }
  }

  function update(edit: Edit): boolean {
    if (gesture === undefined) return false
    const { base, baseDocuments } = gesture
    const opened = resolveScope(base, baseDocuments, state.mediaStates, state.openGroups)
    const edited = edit(opened.project)
    const path = opened.documentPath
    const document = path === undefined ? undefined : baseDocuments[path]
    if (path === undefined || document === undefined) {
      const wholeProject = withScopedProject(base, opened.groupsInDocument, edited)
      if (wholeProject !== state.wholeProject) setState({ wholeProject })
      return true
    }
    const changed = withScopedProject(document, opened.groupsInDocument, edited)
    if (changed !== state.documents[path]) setState({ documents: { ...state.documents, [path]: changed } })
    return true
  }

  function apply(label: string, edit: Edit): void {
    begin(label)
    update(edit)
    commit()
  }

  // Edits the episode, and every loaded animation file when editDocument is given, whatever is open.
  function applyToFiles(label: string, editEpisode: Edit, editDocument?: Edit): void {
    begin(label)
    let documents = state.documents
    for (const [path, document] of Object.entries(state.documents)) {
      const edited = editDocument?.(document) ?? document
      if (edited !== document) documents = { ...documents, [path]: edited }
    }
    setState({ wholeProject: editEpisode(state.wholeProject), documents })
    commit()
  }

  function travel(move: (history: History) => Travel | undefined): void {
    cancel()
    const moved = move(state.history)
    if (moved === undefined) return
    const hasDocuments = Object.keys(moved.documents).length > 0
    const documents = hasDocuments ? { ...state.documents, ...moved.documents } : state.documents
    setState({ history: moved.history, wholeProject: moved.project, documents })
  }

  return {
    getState: () => state,
    committedProject: () => gesture?.base ?? state.wholeProject,
    committedDocuments: () => (gesture === undefined ? state.documents : documentsBefore(gesture)),
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    open(loaded, documentPath, isSaved, recoveredAnimations) {
      gesture = undefined
      const savedDocuments: Record<string, Project> = {}
      for (const [path, document] of Object.entries(loaded.documents)) {
        if (!recoveredAnimations.includes(path)) savedDocuments[path] = document
      }
      setState({
        wholeProject: loaded.project,
        documents: loaded.documents,
        openGroups: NO_SELECTION,
        mediaStates: loaded.media,
        selection: NO_SELECTION,
        selectedShapes: NO_SHAPES,
        selectedZoom: undefined,
        history: EMPTY_HISTORY,
        savedProject: isSaved ? loaded.project : blank,
        savedDocuments,
        documentPath,
        openCount: state.openCount + 1,
        editingTextId: undefined,
      })
    },
    apply,
    applyToFiles,
    begin,
    update,
    commit,
    cancel,
    undo: () => travel(undo),
    redo: () => travel(redo),
    select: (clipIds) => setState({ selection: clipIds, selectedShapes: NO_SHAPES, selectedZoom: undefined }),
    selectShapes: (selectedShapes) => setState({ selectedShapes, selection: NO_SELECTION, selectedZoom: undefined }),
    setTool: (tool) => setState({ tool }),
    setDrawingColor(part, color) {
      const { drawingStyle } = state
      const changed = part === 'fill' ? { ...drawingStyle, fill: color } : { ...drawingStyle, stroke: { ...drawingStyle.stroke, color } }
      setState({ drawingStyle: changed })
    },
    setColorPart: (colorPart) => setState({ colorPart }),
    expandTrack(trackId, isExpanded) {
      if (state.expandedTracks.has(trackId) === isExpanded) return
      const expandedTracks = new Set(state.expandedTracks)
      if (isExpanded) expandedTracks.add(trackId)
      else expandedTracks.delete(trackId)
      setState({ expandedTracks })
    },
    openGroup(groupId) {
      commit()
      setState({ openGroups: [...state.openGroups, groupId], selection: NO_SELECTION, selectedShapes: NO_SHAPES, selectedZoom: undefined, editingTextId: undefined })
    },
    closeGroups(depth) {
      const left = state.openGroups[depth]
      if (left === undefined) return
      commit()
      setState({ openGroups: state.openGroups.slice(0, depth), selection: [left], selectedShapes: NO_SHAPES, editingTextId: undefined })
    },
    selectZoom: (selectedZoom) => setState({ selectedZoom, selection: selectedZoom === undefined ? state.selection : NO_SELECTION }),
    setMediaState: (mediaId, mediaState) => setState({ mediaStates: { ...state.mediaStates, [mediaId]: mediaState } }),
    setMediaStates: (mediaStates) => setState({ mediaStates }),
    addDocuments(loaded) {
      setState({
        documents: { ...state.documents, ...loaded.documents },
        savedDocuments: { ...state.savedDocuments, ...loaded.documents },
        mediaStates: { ...state.mediaStates, ...loaded.media },
      })
    },
    markSaved: (project, documentPath) => setState({ savedProject: project, documentPath }),
    markDocumentsSaved: (documents) => setState({ savedDocuments: { ...state.savedDocuments, ...documents } }),
    notify: (notice) => setState({ notice }),
    showExportDialog(isExportDialogOpen) {
      const isInsideGroup = isExportDialogOpen && state.openGroups.length > 0
      setState(isInsideGroup ? { isExportDialogOpen, openGroups: NO_SELECTION, selection: NO_SELECTION, selectedShapes: NO_SHAPES } : { isExportDialogOpen })
    },
    setExportStatus: (exportStatus) => setState({ exportStatus }),
    setPendingImports: (pendingImports) => setState({ pendingImports }),
    setSnapping: (isSnapping) => setState({ isSnapping }),
    setPreviewing: (isPreviewing) => setState({ isPreviewing }),
    showSettings: (isSettingsOpen) => setState({ isSettingsOpen }),
    showDebug: (isDebugShown) => setState({ isDebugShown }),
    setSettings: (next) => setState({ settings: next }),
    offerCacheLimit: (cacheOffer) => setState({ cacheOffer }),
    editText: (editingTextId) => setState({ editingTextId }),
    setOpening: (openingName) => setState({ openingName }),
  }
}
