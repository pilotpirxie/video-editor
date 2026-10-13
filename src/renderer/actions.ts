import { copyClips, deleteClips, pasteClips, rippleDelete, spanEnd, type Clipboard } from '../editor/clipboard.js'
import { nextTrackName, type NewTrack } from '../editor/clips.js'
import { clipsToSplit, splitClips } from '../editor/split.js'
import { addTrack } from '../editor/tracks.js'
import type { EditorStore } from './store.js'
import type { Transport } from './transport.js'

export type Actions = {
  split(): void
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
    split() {
      const { project, selection } = store.getState()
      const cut = transport.position().time
      const newIds = new Map<string, string>()
      for (const clipId of clipsToSplit(project, selection, cut)) newIds.set(clipId, crypto.randomUUID())
      if (newIds.size > 0) store.apply(`Split ${plural(newIds.size, 'Clip')}`, (current) => splitClips(current, cut, newIds))
    },
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
