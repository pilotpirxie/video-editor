import { describe, expect, it } from 'vitest'
import { projectOf, track } from '../../test/fixtures.js'
import { EMPTY_HISTORY, MAX_UNDO_STEPS, record, redo, undo, type History } from './history.js'

const first = projectOf([])
const second = projectOf([track('t1', [])])
const third = projectOf([track('t1', []), track('t2', [])])

function twoSteps(): History {
  const afterOne = record(EMPTY_HISTORY, { label: 'Add Track', before: first, after: second })
  return record(afterOne, { label: 'Add Track', before: second, after: third })
}

describe('history', () => {
  it('has nothing to undo or redo when empty', () => {
    expect(undo(EMPTY_HISTORY)).toBeUndefined()
    expect(redo(EMPTY_HISTORY)).toBeUndefined()
  })

  it('undoes the latest step first and redoes it again', () => {
    const undone = undo(twoSteps())
    expect(undone?.project).toBe(second)
    expect(undone?.history.done.map((step) => step.after)).toEqual([second])

    const undoneTwice = undo(undone?.history ?? EMPTY_HISTORY)
    expect(undoneTwice?.project).toBe(first)

    const redone = redo(undoneTwice?.history ?? EMPTY_HISTORY)
    expect(redone?.project).toBe(second)
    expect(redone?.history.undone).toHaveLength(1)
  })

  it('drops the redo steps when a new command is recorded', () => {
    const undone = undo(twoSteps())
    const recorded = record(undone?.history ?? EMPTY_HISTORY, { label: 'Rename Track', before: second, after: first })
    expect(recorded.undone).toEqual([])
    expect(recorded.done.map((step) => step.label)).toEqual(['Add Track', 'Rename Track'])
  })

  it('keeps the newest 500 steps', () => {
    let history = EMPTY_HISTORY
    for (let index = 0; index < MAX_UNDO_STEPS + 20; index++) {
      history = record(history, { label: `Step ${index}`, before: first, after: second })
    }
    expect(history.done).toHaveLength(MAX_UNDO_STEPS)
    expect(history.done[0]?.label).toBe('Step 20')
    expect(history.done.at(-1)?.label).toBe(`Step ${MAX_UNDO_STEPS + 19}`)
  })

  it('never changes the history it was given', () => {
    const history = twoSteps()
    undo(history)
    record(history, { label: 'Other', before: third, after: first })
    expect(history.done).toHaveLength(2)
    expect(history.undone).toHaveLength(0)
  })
})
