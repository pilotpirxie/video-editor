import { copyClips, deleteClips, pasteClips, rippleDelete, spanEnd, type Clipboard } from '../editor/clipboard.js'
import { nearestEdit, nextTrackName, unlockedClipIds, type NewTrack } from '../editor/clips.js'
import { clipsToSeparate, separateAudio } from '../editor/separate.js'
import { clipsToSplit, splitClips } from '../editor/split.js'
import { addText } from '../editor/text.js'
import { addTrack } from '../editor/tracks.js'
import { projectDuration } from '../shared/project.js'
import { frameAt, frameDuration } from '../shared/time.js'
import type { EditorStore } from './store.js'
import type { TimelineLimits, Transport } from './transport.js'

export type Actions = {
  split(): void
  splitAll(): void
  selectAll(): void
  canSeparateAudio(): boolean
  separateAudio(): void
  addText(): void
  stepFrames(count: number): void
  jumpTo(end: 'start' | 'end'): void
  jumpToEdit(direction: 1 | -1): void
  shuttle(direction: 1 | -1): void
  deleteSelection(isRipple: boolean): void
  copy(): boolean
  cut(): boolean
  paste(): void
  duplicate(): void
  addTrack(): void
}

function plural(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`
}

// The editing commands that the menu, the keyboard, the timeline toolbar and the context menus all share.
export function createActions(store: EditorStore, transport: Transport): Actions {
  let clipboard: Clipboard | undefined
  let stepped: { time: number; sequence: number } | undefined

  function limits(): TimelineLimits {
    const { project } = store.getState()
    return { duration: projectDuration(project), frameTicks: frameDuration(project.canvas.frameRate) }
  }

  function lastFrameStart({ duration, frameTicks }: TimelineLimits): number {
    return Math.max(0, Math.ceil(duration / frameTicks) - 1) * frameTicks
  }

  function splitAt(selection: readonly string[]): void {
    const { project } = store.getState()
    const cut = transport.position().time
    const newIds = new Map<string, string>()
    for (const clipId of clipsToSplit(project, selection, cut)) newIds.set(clipId, crypto.randomUUID())
    if (newIds.size > 0) store.apply(`Split ${plural(newIds.size, 'Clip')}`, (current) => splitClips(current, cut, newIds))
  }

  function pasteAt(copied: Clipboard, at: number, label: string): void {
    const { project } = store.getState()
    const clipIds = copied.clips.map(() => crypto.randomUUID())
    const newTracks: NewTrack[] = copied.clips.map((_clip, index) => ({ id: crypto.randomUUID(), name: `Track ${project.tracks.length + index + 1}` }))
    store.apply(label, (current) => pasteClips(current, { clipboard: copied, at, clipIds, newTracks }))
    store.select(clipIds)
  }

  function copy(): boolean {
    const { project, selection } = store.getState()
    if (selection.length === 0) return false
    clipboard = copyClips(project, selection)
    return true
  }

  function deleteSelection(isRipple: boolean): void {
    const { selection } = store.getState()
    if (selection.length === 0) return
    const noun = plural(selection.length, 'Clip')
    if (isRipple) {
      store.apply(`Ripple Delete ${noun}`, (project) => rippleDelete(project, selection))
    } else {
      store.apply(`Delete ${noun}`, (project) => deleteClips(project, selection))
    }
  }

  return {
    split: () => splitAt(store.getState().selection),
    splitAll: () => splitAt([]),
    selectAll: () => store.select(unlockedClipIds(store.getState().project, () => true)),
    canSeparateAudio() {
      const { project, selection, mediaStates } = store.getState()
      return clipsToSeparate(project, selection, mediaStates).length > 0
    },
    separateAudio() {
      const { project, selection, mediaStates } = store.getState()
      const newIds = new Map<string, string>()
      for (const clipId of clipsToSeparate(project, selection, mediaStates)) newIds.set(clipId, crypto.randomUUID())
      if (newIds.size === 0) return
      // At most every track gets a track for its sound above it.
      const newTracks: NewTrack[] = project.tracks.map((_track, index) => ({ id: crypto.randomUUID(), name: `Track ${project.tracks.length + index + 1}` }))
      store.apply('Separate Video and Audio', (current) => separateAudio(current, mediaStates, newIds, newTracks))
    },
    // The new title opens for typing at once, so the usual next step needs no extra click.
    addText() {
      const { project } = store.getState()
      const { frameTicks } = limits()
      const clipId = crypto.randomUUID()
      const newTrack = { id: crypto.randomUUID(), name: nextTrackName(project) }
      const start = frameAt(transport.position().time, frameTicks) * frameTicks
      transport.pause()
      store.apply('Add Text', (current) => addText(current, { clipId, start, newTrack }))
      store.select([clipId])
      store.editText(clipId)
    },
    stepFrames(count) {
      const timeline = limits()
      const position = transport.position()
      // Key repeat is faster than the engine answers, so a step taken before the last one was shown counts on from where that one aimed.
      const from = stepped !== undefined && stepped.sequence === position.sequence ? stepped.time : position.time
      const frame = frameAt(from, timeline.frameTicks) + count
      const time = Math.min(lastFrameStart(timeline), Math.max(0, frame * timeline.frameTicks))
      stepped = { time, sequence: position.sequence }
      transport.pause()
      transport.seek(time)
    },
    jumpTo(end) {
      transport.pause()
      transport.seek(end === 'start' ? 0 : lastFrameStart(limits()))
    },
    jumpToEdit(direction) {
      const edit = nearestEdit(store.getState().project, transport.position().time, direction)
      if (edit === undefined) return
      transport.pause()
      transport.seek(Math.min(edit, lastFrameStart(limits())))
    },
    shuttle: (direction) => transport.shuttle(direction, limits()),
    deleteSelection,
    copy,
    cut() {
      if (!copy()) return false
      const { selection } = store.getState()
      store.apply(`Cut ${plural(selection.length, 'Clip')}`, (project) => deleteClips(project, selection))
      return true
    },
    paste() {
      if (clipboard !== undefined) pasteAt(clipboard, transport.position().time, `Paste ${plural(clipboard.clips.length, 'Clip')}`)
    },
    duplicate() {
      const { project, selection } = store.getState()
      if (selection.length === 0) return
      const copied = copyClips(project, selection)
      pasteAt(copied, spanEnd(copied), `Duplicate ${plural(selection.length, 'Clip')}`)
    },
    addTrack() {
      const track = { id: crypto.randomUUID(), name: nextTrackName(store.getState().project) }
      store.apply('Add Track', (project) => addTrack(project, track))
    },
  }
}
