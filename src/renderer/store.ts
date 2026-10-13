import { EMPTY_HISTORY, record, redo, undo, type History } from '../editor/history.js'
import type { MediaStates } from '../engine/resolve.js'
import type { LoadedProject, MediaState } from '../shared/mediaProtocol.js'
import type { Project } from '../shared/project.js'

export type Edit = (project: Project) => Project

type ExportProgress = {
  fileName: string
  done: number
  total: number
  // When the export began, on the clock of `performance.now()`.
  startedAt: number
}

export type EditorState = {
  project: Project
  mediaStates: MediaStates
  selection: readonly string[]
  history: History
  savedProject: Project
  documentPath: string | undefined
  notice: string | undefined
  // Whether the notice is about a finished export, whose file can be shown in the Finder.
  isNoticeAboutExport: boolean
  isExportDialogOpen: boolean
  // The export that is running, if one is.
  exportProgress: ExportProgress | undefined
  // Files that are being probed right now; they show as placeholders in the Media tab.
  pendingImports: readonly string[]
  isSnapping: boolean
  // Counts the documents opened in this window, so views can reset themselves for a new one.
  openCount: number
  // The text clip whose words are being typed on the canvas.
  editingTextId: string | undefined
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
  setMediaState(mediaId: string, state: MediaState): void
  markSaved(project: Project, documentPath: string): void
  notify(notice: string | undefined): void
  notifyExported(notice: string): void
  showExportDialog(isOpen: boolean): void
  setExportProgress(progress: ExportProgress | undefined): void
  setPendingImports(paths: readonly string[]): void
  setSnapping(isSnapping: boolean): void
  editText(clipId: string | undefined): void
}

// Carries an open undo step on, or opens one when there is none.
// Something else may have closed the step in the meantime, an import that finished for example; the change then simply opens the next one.
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

const EMPTY_PROJECT: Project = {
  version: 1,
  canvas: { width: 1920, height: 1080, frameRate: { num: 30, den: 1 } },
  media: [],
  tracks: [],
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

export function createEditorStore(): EditorStore {
  let state: EditorState = {
    project: EMPTY_PROJECT,
    mediaStates: {},
    selection: NO_SELECTION,
    history: EMPTY_HISTORY,
    savedProject: EMPTY_PROJECT,
    documentPath: undefined,
    notice: undefined,
    isNoticeAboutExport: false,
    isExportDialogOpen: false,
    exportProgress: undefined,
    pendingImports: [],
    isSnapping: true,
    openCount: 0,
    editingTextId: undefined,
  }
  let gesture: Gesture | undefined
  const listeners = new Set<() => void>()

  function setState(changes: Partial<EditorState>): void {
    const next = { ...state, ...changes }
    if (next.project !== state.project) {
      next.selection = withoutMissingClips(next.selection, next.project)
      if (next.editingTextId !== undefined && withoutMissingClips([next.editingTextId], next.project).length === 0) next.editingTextId = undefined
    }
    state = next
    for (const listener of listeners) listener()
  }

  function cancel(): boolean {
    if (gesture === undefined) return false
    const { base } = gesture
    gesture = undefined
    if (state.project !== base) setState({ project: base })
    return true
  }

  function commit(): void {
    if (gesture === undefined) return
    const { label, base } = gesture
    gesture = undefined
    if (state.project === base) return
    setState({ history: record(state.history, { label, before: base, after: state.project }) })
  }

  function begin(label: string): void {
    cancel()
    gesture = { label, base: state.project }
  }

  // Every update starts from the project as it was when the gesture began, so a drag is absolute and repeating an update changes nothing.
  function update(edit: Edit): boolean {
    if (gesture === undefined) return false
    const project = edit(gesture.base)
    if (project !== state.project) setState({ project })
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
    if (moved !== undefined) setState({ history: moved.history, project: moved.project })
  }

  return {
    getState: () => state,
    committedProject: () => gesture?.base ?? state.project,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    open(loaded, documentPath, isSaved) {
      gesture = undefined
      setState({
        project: loaded.project,
        mediaStates: loaded.media,
        selection: NO_SELECTION,
        history: EMPTY_HISTORY,
        savedProject: isSaved ? loaded.project : EMPTY_PROJECT,
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
    select: (clipIds) => setState({ selection: clipIds }),
    setMediaState: (mediaId, mediaState) => setState({ mediaStates: { ...state.mediaStates, [mediaId]: mediaState } }),
    markSaved: (project, documentPath) => setState({ savedProject: project, documentPath }),
    notify: (notice) => setState({ notice, isNoticeAboutExport: false }),
    notifyExported: (notice) => setState({ notice, isNoticeAboutExport: true }),
    showExportDialog: (isExportDialogOpen) => setState({ isExportDialogOpen }),
    setExportProgress: (exportProgress) => setState({ exportProgress }),
    setPendingImports: (pendingImports) => setState({ pendingImports }),
    setSnapping: (isSnapping) => setState({ isSnapping }),
    editText: (editingTextId) => setState({ editingTextId }),
  }
}
