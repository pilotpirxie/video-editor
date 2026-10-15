import { emptyTrack } from '../editor/clips.js'
import { scopeOf, scopedProject, withScopedProject, type Scope } from '../editor/groups.js'
import { EMPTY_HISTORY, record, redo, undo, type History } from '../editor/history.js'
import type { MediaStates } from '../engine/resolve.js'
import type { LoadedProject, MediaState } from '../shared/mediaProtocol.js'
import type { Project, Track } from '../shared/project.js'
import { DEFAULT_SETTINGS, type AppSettings } from '../shared/settings.js'

export type Edit = (project: Project) => Project

// An export from its first frame until its result has been read. `startedAt` is on the clock of `performance.now()`.
type ExportStatus =
  | { phase: 'running'; fileName: string; done: number; total: number; startedAt: number }
  | { phase: 'done'; fileName: string }
  | { phase: 'failed'; fileName: string; message: string }

export type EditorState = {
  // What is being edited: the whole project, or, while groups are open, the tracks of the innermost open group in that group's own time.
  project: Project
  // Everything, as it is saved, played and exported.
  wholeProject: Project
  // The groups that are open, the outermost first.
  openGroups: readonly string[]
  // Where the open tracks lie in the time of the whole project; undefined while no group is open.
  scope: Scope | undefined
  mediaStates: MediaStates
  selection: readonly string[]
  // The zoom of the camera that is selected, by its place in the list. Selecting clips unselects it, and selecting it unselects the clips.
  selectedZoom: number | undefined
  history: History
  savedProject: Project
  documentPath: string | undefined
  notice: string | undefined
  isExportDialogOpen: boolean
  // The export that is running or has just ended, if there is one. While it is set, a dialog holds the window.
  exportStatus: ExportStatus | undefined
  // Files that are being probed right now; they show as placeholders in the Media tab.
  pendingImports: readonly string[]
  isSnapping: boolean
  // The panels are hidden and the canvas has the window to itself, with the transport only.
  isPreviewing: boolean
  isSettingsOpen: boolean
  // The debug panel under the properties, off at every launch.
  isDebugShown: boolean
  settings: AppSettings
  // The project needs more cache than the limit allows, and a larger limit is offered once.
  cacheOffer: CacheOffer | undefined
  // Counts the documents opened in this window, so views can reset themselves for a new one.
  openCount: number
  // The text clip whose words are being typed on the canvas.
  editingTextId: string | undefined
  // The name of the project file being read, while the window waits for it.
  openingName: string | undefined
}

export type CacheOffer = {
  neededBytes: number
  offerGb: number
}

export type EditorStore = {
  getState(): EditorState
  // The project without the changes of a drag that is still in progress.
  committedProject(): Project
  subscribe(listener: () => void): () => void
  open(loaded: LoadedProject, documentPath: string | undefined, isSaved: boolean): void
  apply(label: string, edit: Edit): void
  begin(label: string): void
  // Says whether a step was open to take the edit; without one nothing changes.
  update(edit: Edit): boolean
  commit(): void
  // Abandons the drag in progress and says whether there was one.
  cancel(): boolean
  undo(): void
  redo(): void
  select(clipIds: readonly string[]): void
  // Goes into a group of the tracks that are open, to edit its members.
  openGroup(groupId: string): void
  // Leaves the innermost open groups, down to `depth` of them, and selects the outermost one that was left.
  closeGroups(depth: number): void
  selectZoom(index: number | undefined): void
  setMediaState(mediaId: string, state: MediaState): void
  // Replaces what is known of every file, as a media process that was started again reports it.
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

// Carries an open undo step on, or opens one when there is none.
// Something else may have closed the step in the meantime, an import that finished for example; the change then simply opens the next one.
export function updateStep(store: EditorStore, label: string, edit: Edit, isStepOpen: boolean): void {
  const hasReachedTheStep = isStepOpen && store.update(edit)
  if (hasReachedTheStep) return
  store.begin(label)
  store.update(edit)
}

// `base` is the whole project as it was when the gesture began.
type Gesture = {
  label: string
  base: Project
}

const NO_SELECTION: readonly string[] = []

const STARTING_TRACKS = 6

// What a new window starts with: empty tracks to drop onto, so the first clips need no track of their own.
function blankProject(): Project {
  const tracks: Track[] = []
  for (let index = 0; index < STARTING_TRACKS; index++) tracks.push(emptyTrack({ id: crypto.randomUUID(), name: `Track ${index + 1}` }))
  return { version: 1, canvas: { width: 1920, height: 1080, frameRate: { num: 30, den: 1 } }, media: [], tracks }
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
  // Also the saved project of a window that has not been saved, so the untouched blank project counts as unchanged.
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

  // The tracks that are open follow the whole project. A group that is gone, after an undo for example, is no longer open, nor are the groups inside it.
  function withOpenTracks(next: EditorState): void {
    let openGroups = next.openGroups
    let scoped = scopedProject(next.wholeProject, openGroups)
    while (scoped === undefined) {
      openGroups = openGroups.slice(0, -1)
      scoped = scopedProject(next.wholeProject, openGroups)
    }
    if (openGroups.length !== next.openGroups.length) next.openGroups = openGroups
    next.scope = scopeOf(next.wholeProject, openGroups)
    // Inside a group every change of the whole project gives a new object for the open tracks; views must only see one when something they show has changed.
    const { project } = state
    const isSameInside = openGroups.length > 0 && scoped.tracks === project.tracks && scoped.media === project.media && scoped.canvas === project.canvas && project.camera === undefined
    next.project = isSameInside ? project : scoped
  }

  function setState(changes: Partial<Omit<EditorState, 'project' | 'scope'>>): void {
    const next = { ...state, ...changes }
    if (next.wholeProject !== state.wholeProject || next.openGroups !== state.openGroups) withOpenTracks(next)
    if (next.project !== state.project) {
      next.selection = withoutMissingClips(next.selection, next.project)
      if (next.editingTextId !== undefined && withoutMissingClips([next.editingTextId], next.project).length === 0) next.editingTextId = undefined
      if (next.selectedZoom !== undefined && next.project.camera?.[next.selectedZoom] === undefined) next.selectedZoom = undefined
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

  // Every update starts from the project as it was when the gesture began, so a drag is absolute and repeating an update changes nothing.
  function update(edit: Edit): boolean {
    if (gesture === undefined) return false
    const { base } = gesture
    const { openGroups } = state
    const open = scopedProject(base, openGroups)
    // An edit is made to the tracks that are open, and what it gives is put back into the whole project.
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
    // An export is of the whole project, so the dialog is opened on that.
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
