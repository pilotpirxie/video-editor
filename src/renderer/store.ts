import { emptyTrack } from '../editor/clips.js'
import { scopeOf, scopedProject, withScopedProject, type Scope } from '../editor/groups.js'
import { EMPTY_HISTORY, record, redo, undo, type History } from '../editor/history.js'
import type { MediaStates } from '../engine/resolve.js'
import type { LoadedProject, MediaState } from '../shared/mediaProtocol.js'
import { PROJECT_VERSION, type Canvas, type Project, type Track } from '../shared/project.js'
import { DEFAULT_SETTINGS, type AppSettings } from '../shared/settings.js'

export type Edit = (project: Project) => Project

type ExportStatus =
  | { phase: 'running'; fileName: string; done: number; total: number; startedAt: number }
  | { phase: 'done'; fileName: string }
  | { phase: 'failed'; fileName: string; message: string }

export type EditorState = {
  project: Project
  wholeProject: Project
  openGroups: readonly string[]
  scope: Scope | undefined
  mediaStates: MediaStates
  selection: readonly string[]
  selectedZoom: number | undefined
  history: History
  savedProject: Project
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
  subscribe(listener: () => void): () => void
  open(loaded: LoadedProject, documentPath: string | undefined, isSaved: boolean): void
  apply(label: string, edit: Edit): void
  begin(label: string): void
  update(edit: Edit): boolean
  commit(): void
  cancel(): boolean
  undo(): void
  redo(): void
  select(clipIds: readonly string[]): void
  openGroup(groupId: string): void
  closeGroups(depth: number): void
  selectZoom(index: number | undefined): void
  setMediaState(mediaId: string, state: MediaState): void
  setMediaStates(states: MediaStates): void
  markSaved(project: Project, documentPath: string): void
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
}

const NO_SELECTION: readonly string[] = []

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

export function createEditorStore(settings: AppSettings = DEFAULT_SETTINGS): EditorStore {
  const blank = blankProject()
  let state: EditorState = {
    project: blank,
    wholeProject: blank,
    openGroups: NO_SELECTION,
    scope: undefined,
    mediaStates: {},
    selection: NO_SELECTION,
    selectedZoom: undefined,
    history: EMPTY_HISTORY,
    savedProject: blank,
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

  function openTracksOf(wholeProject: Project, wantedGroups: readonly string[]): Pick<EditorState, 'openGroups' | 'scope' | 'project'> {
    let openGroups = wantedGroups
    let scoped = scopedProject(wholeProject, openGroups)
    while (scoped === undefined) {
      openGroups = openGroups.slice(0, -1)
      scoped = scopedProject(wholeProject, openGroups)
    }
    const { project } = state
    const hasSameContent = scoped.tracks === project.tracks && scoped.media === project.media && scoped.canvas === project.canvas
    const isSameInside = openGroups.length > 0 && hasSameContent && project.camera === undefined
    return { openGroups, scope: scopeOf(wholeProject, openGroups), project: isSameInside ? project : scoped }
  }

  function setState(changes: Partial<Omit<EditorState, 'project' | 'scope'>>): void {
    let next = { ...state, ...changes }
    if (next.wholeProject !== state.wholeProject || next.openGroups !== state.openGroups) {
      next = { ...next, ...openTracksOf(next.wholeProject, next.openGroups) }
    }
    if (next.project !== state.project) {
      next.selection = withoutMissingClips(next.selection, next.project)
      const isEditedTextGone = next.editingTextId !== undefined && withoutMissingClips([next.editingTextId], next.project).length === 0
      if (isEditedTextGone) next.editingTextId = undefined
      const isZoomGone = next.selectedZoom !== undefined && next.project.camera?.[next.selectedZoom] === undefined
      if (isZoomGone) next.selectedZoom = undefined
    }
    state = next
    for (const listener of listeners) listener()
  }

  function cancel(): boolean {
    if (gesture === undefined) return false
    const { base } = gesture
    gesture = undefined
    if (state.wholeProject !== base) setState({ wholeProject: base })
    return true
  }

  function commit(): void {
    if (gesture === undefined) return
    const { label, base } = gesture
    gesture = undefined
    if (state.wholeProject === base) return
    setState({ history: record(state.history, { label, before: base, after: state.wholeProject }, state.settings.undoSteps) })
  }

  function begin(label: string): void {
    cancel()
    gesture = { label, base: state.wholeProject }
  }

  function update(edit: Edit): boolean {
    if (gesture === undefined) return false
    const { base } = gesture
    const { openGroups } = state
    const open = scopedProject(base, openGroups)
    const wholeProject = open === undefined ? base : withScopedProject(base, openGroups, edit(open))
    if (wholeProject !== state.wholeProject) setState({ wholeProject })
    return true
  }

  function apply(label: string, edit: Edit): void {
    begin(label)
    update(edit)
    commit()
  }

  function travel(move: (history: History) => { history: History; project: Project } | undefined): void {
    cancel()
    const moved = move(state.history)
    if (moved !== undefined) setState({ history: moved.history, wholeProject: moved.project })
  }

  return {
    getState: () => state,
    committedProject: () => gesture?.base ?? state.wholeProject,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    open(loaded, documentPath, isSaved) {
      gesture = undefined
      setState({
        wholeProject: loaded.project,
        openGroups: NO_SELECTION,
        mediaStates: loaded.media,
        selection: NO_SELECTION,
        selectedZoom: undefined,
        history: EMPTY_HISTORY,
        savedProject: isSaved ? loaded.project : blank,
        documentPath,
        openCount: state.openCount + 1,
        editingTextId: undefined,
      })
    },
    apply,
    begin,
    update,
    commit,
    cancel,
    undo: () => travel(undo),
    redo: () => travel(redo),
    select: (clipIds) => setState({ selection: clipIds, selectedZoom: undefined }),
    openGroup(groupId) {
      commit()
      setState({ openGroups: [...state.openGroups, groupId], selection: NO_SELECTION, selectedZoom: undefined, editingTextId: undefined })
    },
    closeGroups(depth) {
      const left = state.openGroups[depth]
      if (left === undefined) return
      commit()
      setState({ openGroups: state.openGroups.slice(0, depth), selection: [left], editingTextId: undefined })
    },
    selectZoom: (selectedZoom) => setState({ selectedZoom, selection: selectedZoom === undefined ? state.selection : NO_SELECTION }),
    setMediaState: (mediaId, mediaState) => setState({ mediaStates: { ...state.mediaStates, [mediaId]: mediaState } }),
    setMediaStates: (mediaStates) => setState({ mediaStates }),
    markSaved: (project, documentPath) => setState({ savedProject: project, documentPath }),
    notify: (notice) => setState({ notice }),
    showExportDialog(isExportDialogOpen) {
      const isInsideGroup = isExportDialogOpen && state.openGroups.length > 0
      setState(isInsideGroup ? { isExportDialogOpen, openGroups: NO_SELECTION, selection: NO_SELECTION } : { isExportDialogOpen })
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
