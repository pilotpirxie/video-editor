import type { Project } from '../shared/project.js'

export type Step = {
  label: string
  before: Project
  after: Project
}

export type History = {
  done: readonly Step[]
  undone: readonly Step[]
}

export type Travel = {
  history: History
  project: Project
}

export const EMPTY_HISTORY: History = { done: [], undone: [] }

export function record(history: History, step: Step, maxSteps: number): History {
  const done = [...history.done, step].slice(-maxSteps)
  return { done, undone: [] }
}

export function undo(history: History): Travel | undefined {
  const step = history.done.at(-1)
  if (step === undefined) return undefined
  return { history: { done: history.done.slice(0, -1), undone: [...history.undone, step] }, project: step.before }
}

export function redo(history: History): Travel | undefined {
  const step = history.undone.at(-1)
  if (step === undefined) return undefined
  return { history: { done: [...history.done, step], undone: history.undone.slice(0, -1) }, project: step.after }
}
