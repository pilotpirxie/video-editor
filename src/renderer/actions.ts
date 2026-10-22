import { ANNOTATION_NAMES, addAnnotation, type AnnotationKind } from '../editor/annotations.js'
import { deleteZoom, setViewAt, zoomIndexAt } from '../editor/camera.js'
import { copyClips, deleteClips, pasteClips, rippleDelete, spanEnd, type Clipboard } from '../editor/clipboard.js'
import { allClips, isVisual, locateClip, nearestClipEdge, nextTrackName, trackAboveAll, unlockedClipIds, type NewTrack } from '../editor/clips.js'
import { addEffect, takesEffect } from '../editor/effects.js'
import { groupClips, ungroupClips } from '../editor/groups.js'
import { dropMedia, placeableMedia, withoutMedia } from '../editor/place.js'
import { clipsToSeparate, separateAudio } from '../editor/separate.js'
import { clipsToSplit, splitClips } from '../editor/split.js'
import { addTrack } from '../editor/tracks.js'
import { DEFAULT_TRANSITION, setTransition } from '../editor/transitions.js'
import { projectDuration, type Clip, type EffectType, type Project, type TransitionType } from '../shared/project.js'
import { stillDurationTicks } from '../shared/settings.js'
import { frameAt, frameDuration } from '../shared/time.js'
import type { EditorStore } from './store.js'
import type { TimelineLimits, Transport } from './transport.js'

export type Actions = {
  split(): void
  splitAll(): void
  selectAll(): void
  canSeparateAudio(): boolean
  separateAudio(): void
  addAnnotation(kind: AnnotationKind, centre?: { x: number; y: number }): void
  addMedia(mediaIds: readonly string[]): void
  removeMedia(mediaIds: readonly string[]): void
  group(): void
  ungroup(): void
  openGroup(): void
  closeGroup(): void
  addEffect(type: EffectType): void
  addTransition(type: TransitionType): void
  zoomToFull(): void
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

function nextNumberedTracks(project: Project, count: number): NewTrack[] {
  const tracks: NewTrack[] = []
  for (let index = 0; index < count; index++) {
    tracks.push({ id: crypto.randomUUID(), name: `Track ${project.tracks.length + index + 1}` })
  }
  return tracks
}

export function createActions(store: EditorStore, transport: Transport): Actions {
  let clipboard: Clipboard | undefined
  let clipboardPlace = ''
  let stepped: { time: number; sequence: number } | undefined

  function limits(): TimelineLimits {
    const { project } = store.getState()
    return { duration: projectDuration(project), frameTicks: frameDuration(project.canvas.frameRate) }
  }

  function lastFrameStart({ duration, frameTicks }: TimelineLimits): number {
    return Math.max(0, Math.ceil(duration / frameTicks) - 1) * frameTicks
  }

  function addMemberIds(clip: Clip | undefined, newIds: Map<string, string>): void {
    if (clip?.type !== 'group') return
    for (const member of allClips(clip.tracks)) newIds.set(member.id, crypto.randomUUID())
  }

  function splitAt(selection: readonly string[]): void {
    const { project } = store.getState()
    const cut = transport.position().time
    const splitIds = clipsToSplit(project, selection, cut)
    const newIds = new Map<string, string>()
    for (const clipId of splitIds) {
      newIds.set(clipId, crypto.randomUUID())
      addMemberIds(locateClip(project, clipId)?.clip, newIds)
    }
    if (splitIds.length === 0) return
    store.apply(`Split ${plural(splitIds.length, 'Clip')}`, (current) => splitClips(current, cut, newIds))
    const laterParts = new Map(splitIds.map((clipId) => [clipId, newIds.get(clipId) ?? clipId]))
    store.select(store.getState().selection.map((clipId) => laterParts.get(clipId) ?? clipId))
  }

  function pasteAt(copied: Clipboard, at: number, label: string): void {
    const { project } = store.getState()
    const clipIds = copied.clips.map(() => crypto.randomUUID())
    const memberIds = new Map<string, string>()
    for (const { clip } of copied.clips) addMemberIds(clip, memberIds)
    const newTracks = nextNumberedTracks(project, copied.clips.length)
    store.apply(label, (current) => pasteClips(current, { clipboard: copied, at, clipIds, memberIds, newTracks }))
    store.select(clipIds)
  }

  function copy(): boolean {
    const { project, selection } = store.getState()
    if (selection.length === 0) return false
    clipboard = copyClips(project, selection)
    clipboardPlace = store.getState().openGroups.join('/')
    return true
  }

  function selectedClipIds(isWanted: (clip: Clip) => boolean): string[] {
    const { project, selection } = store.getState()
    const clipIds: string[] = []
    for (const clipId of selection) {
      const located = locateClip(project, clipId)
      if (located === undefined || located.track.locked) continue
      if (isWanted(located.clip)) clipIds.push(clipId)
    }
    return clipIds
  }

  function playheadFrame(): number {
    const { frameTicks } = limits()
    transport.pause()
    return frameAt(transport.position().time, frameTicks) * frameTicks
  }

  function deleteSelection(isRipple: boolean): void {
    const { selection, selectedZoom } = store.getState()
    if (selectedZoom !== undefined) {
      store.apply('Delete Zoom', (project) => deleteZoom(project, selectedZoom))
      return
    }
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
      const newTracks = nextNumberedTracks(project, project.tracks.length)
      store.apply('Separate Video and Audio', (current) => separateAudio(current, mediaStates, newIds, newTracks))
    },
    addAnnotation(kind, centre) {
      const { project } = store.getState()
      const duration = stillDurationTicks(store.getState().settings)
      const start = playheadFrame()
      const newTrack = { id: crypto.randomUUID(), name: nextTrackName(project) }
      const added = { clipId: crypto.randomUUID(), start, duration, trackIndex: trackAboveAll(project), newTrack, centre }
      store.apply(`Add ${ANNOTATION_NAMES[kind]}`, (current) => addAnnotation(current, kind, added))
      store.select([added.clipId])
      if (kind === 'text' || kind === 'callout') store.editText(added.clipId)
    },
    addMedia(mediaIds) {
      const { project, mediaStates, settings } = store.getState()
      const media = placeableMedia(project, mediaStates, mediaIds, () => crypto.randomUUID())
      if (media.length === 0) return
      const newTrack = { id: crypto.randomUUID(), name: nextTrackName(project) }
      const start = transport.position().time
      const stillDuration = stillDurationTicks(settings)
      const label = media.length === 1 ? 'Add Clip' : `Add ${media.length} Clips`
      store.apply(label, (current) => {
        const drop = { media, start, trackIndex: trackAboveAll(current), newTrack, stillDuration }
        return dropMedia(current, drop)
      })
      store.select(media.map((dropped) => dropped.clipId))
    },
    removeMedia(mediaIds) {
      if (mediaIds.length === 0) return
      store.closeGroups(0)
      store.apply(`Remove ${plural(mediaIds.length, 'File')}`, (project) => withoutMedia(project, mediaIds))
    },
    group() {
      const { project } = store.getState()
      const clipIds = selectedClipIds(() => true)
      if (clipIds.length === 0) return
      const groupId = crypto.randomUUID()
      const newTrack = { id: crypto.randomUUID(), name: nextTrackName(project) }
      store.apply(`Group ${plural(clipIds.length, 'Clip')}`, (current) => groupClips(current, { clipIds, groupId, newTrack }))
      store.select([groupId])
    },
    ungroup() {
      const { project } = store.getState()
      const groupIds = selectedClipIds((clip) => clip.type === 'group')
      if (groupIds.length === 0) return
      const memberIds: string[] = []
      let innerTrackCount = 0
      for (const groupId of groupIds) {
        const group = locateClip(project, groupId)?.clip
        if (group?.type !== 'group') continue
        for (const inner of group.tracks) {
          innerTrackCount += 1
          for (const clip of inner.clips) memberIds.push(clip.id)
        }
      }
      const newTracks = nextNumberedTracks(project, innerTrackCount)
      store.apply(`Ungroup ${plural(groupIds.length, 'Clip')}`, (current) => ungroupClips(current, { groupIds, newTracks }))
      store.select(memberIds)
    },
    openGroup() {
      const [groupId] = selectedClipIds((clip) => clip.type === 'group')
      if (groupId === undefined) return
      transport.pause()
      store.openGroup(groupId)
      const { scope } = store.getState()
      const { time } = transport.position()
      if (scope !== undefined && (time < scope.from || time >= scope.to)) transport.seek(scope.from)
    },
    closeGroup() {
      const { openGroups } = store.getState()
      if (openGroups.length > 0) store.closeGroups(openGroups.length - 1)
    },
    addEffect(type) {
      const clipIds = selectedClipIds((clip) => takesEffect(clip, type))
      if (clipIds.length === 0) {
        let hint = 'Select a video, an image or a text first, or drag the effect onto one.'
        if (type === 'blurFill') hint = 'Select a video or an image first, or drag the effect onto one.'
        store.notify(hint)
        return
      }
      store.apply('Add Effect', (project) => addEffect(project, clipIds, type))
    },
    addTransition(type) {
      const clipIds = selectedClipIds(isVisual)
      if (clipIds.length === 0) {
        store.notify('Select a clip first, or drag the transition onto the start or the end of one.')
        return
      }
      const { frameTicks } = limits()
      const transition = { type, duration: DEFAULT_TRANSITION }
      store.apply('Add Transition', (project) => {
        let edited = project
        for (const clipId of clipIds) edited = setTransition(edited, { clipId, edge: 'in' }, transition, frameTicks)
        return edited
      })
    },
    zoomToFull() {
      const { canvas } = store.getState().project
      const time = playheadFrame()
      store.apply('Zoom to Full', (project) => setViewAt(project, time, { x: canvas.width / 2, y: canvas.height / 2, scale: 1 }))
      store.selectZoom(zoomIndexAt(store.getState().project, time))
    },
    stepFrames(count) {
      const timeline = limits()
      const position = transport.position()
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
      const edit = nearestClipEdge(store.getState().project, transport.position().time, direction)
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
      if (clipboard === undefined) return
      if (clipboardPlace !== store.getState().openGroups.join('/')) {
        store.notify('Clips copied inside a group can only be pasted in that group, and clips copied outside it only there.')
        return
      }
      pasteAt(clipboard, transport.position().time, `Paste ${plural(clipboard.clips.length, 'Clip')}`)
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
