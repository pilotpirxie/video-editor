import type { Documents } from '../shared/mediaProtocol.js'
import type { Project } from '../shared/project.js'

export type DocumentChange = {
  before: Project
  after: Project
}

export type Step = {
  label: string
  before: Project
  after: Project
  documents?: Readonly<Record<string, DocumentChange>>
}

export type History = {
  done: readonly Step[]
  undone: readonly Step[]
}

// Only the documents the step changed: animations loaded since then stay loaded.
export type Travel = {
  history: History
  project: Project
  documents: Documents
}

export const EMPTY_HISTORY: History = { done: [], undone: [] }

export function record(history: History, step: Step, maxSteps: number): History {
  const done = [...history.done, step].slice(-maxSteps)
  return { done, undone: [] }
}

function documentsAt(step: Step, side: 'before' | 'after'): Documents {
  const documents: Record<string, Project> = {}
  for (const [path, change] of Object.entries(step.documents ?? {})) documents[path] = change[side]
  return documents
}

export function undo(history: History): Travel | undefined {
  const step = history.done.at(-1)
  if (step === undefined) return undefined
  return { history: { done: history.done.slice(0, -1), undone: [...history.undone, step] }, project: step.before, documents: documentsAt(step, 'before') }
}

export function redo(history: History): Travel | undefined {
  const step = history.undone.at(-1)
  if (step === undefined) return undefined
  return { history: { done: [...history.done, step], undone: history.undone.slice(0, -1) }, project: step.after, documents: documentsAt(step, 'after') }
}

export function changedDocuments(before: Documents, after: Documents): Record<string, DocumentChange> {
  const changed: Record<string, DocumentChange> = {}
  for (const [path, document] of Object.entries(before)) {
    const now = after[path]
    if (now !== undefined && now !== document) changed[path] = { before: document, after: now }
  }
  return changed
}
