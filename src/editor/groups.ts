import { onCanvas, openedAnimation, scaledEffect, type GroupFrame, type MediaStates } from '../engine/resolve.js'
import type { Documents } from '../shared/mediaProtocol.js'
import { isVisual, valueAt, type Clip, type GroupClip, type Keyframe, type Keyframes, type Project, type Track, type Transform } from '../shared/project.js'
import { NORMAL_SPEED_PERCENT, TIMELINE_GRID } from '../shared/time.js'
import { emptyTrack, endOf, hasVolume, placeOnTrack, type NewTrack } from './clips.js'
import { earlierPart, laterPart } from './split.js'

const DEGREES_TO_RADIANS = Math.PI / 180
const MAX_VOLUME = 2

export type NewGroup = {
  clipIds: readonly string[]
  groupId: string
  newTrack: NewTrack
}

export type Ungrouping = {
  groupIds: readonly string[]
  newTracks: readonly NewTrack[]
}

// Episode time = offset + time on the open tracks × timeScale; from and to are what the opened clip shows of them.
export type Scope = {
  offset: number
  timeScale: number
  from: number
  to: number
}

export type OpenScope = {
  openGroups: readonly string[]
  chain: readonly string[]
  documentPath: string | undefined
  groupsInDocument: readonly string[]
  project: Project
  scope: Scope | undefined
}

function movedKeyframes(keyframes: Keyframes | undefined, x: number, y: number): Keyframes | undefined {
  if (keyframes?.x === undefined && keyframes?.y === undefined) return keyframes
  return {
    ...keyframes,
    x: keyframes.x?.map((keyframe) => ({ ...keyframe, value: keyframe.value + x })),
    y: keyframes.y?.map((keyframe) => ({ ...keyframe, value: keyframe.value + y })),
  }
}

function asMember(clip: Clip, start: number, x: number, y: number): Clip {
  if (!isVisual(clip)) return { ...clip, start: clip.start - start }
  const transform = { ...clip.transform, x: clip.transform.x - x, y: clip.transform.y - y }
  return { ...clip, start: clip.start - start, transform, keyframes: movedKeyframes(clip.keyframes, -x, -y) }
}

export function groupClips(project: Project, grouping: NewGroup): Project {
  const wanted = new Set(grouping.clipIds)
  const members: Clip[] = []
  let topRow = -1
  for (const [row, track] of project.tracks.entries()) {
    if (track.locked) continue
    for (const clip of track.clips) {
      if (!wanted.has(clip.id)) continue
      members.push(clip)
      topRow = row
    }
  }
  if (members.length === 0) return project

  const start = Math.min(...members.map((clip) => clip.start))
  const end = Math.max(...members.map(endOf))
  const placed = members.filter(isVisual)
  let x = project.canvas.width / 2
  let y = project.canvas.height / 2
  if (placed.length > 0) {
    const xs = placed.map((clip) => clip.transform.x)
    const ys = placed.map((clip) => clip.transform.y)
    x = (Math.min(...xs) + Math.max(...xs)) / 2
    y = (Math.min(...ys) + Math.max(...ys)) / 2
  }

  const inner: Track[] = []
  const tracks: Track[] = []
  for (const track of project.tracks) {
    const taken = track.locked ? [] : track.clips.filter((clip) => wanted.has(clip.id))
    if (taken.length === 0) {
      tracks.push(track)
      continue
    }
    const innerClips = taken.map((clip) => asMember(clip, start, x, y))
    inner.push({ ...emptyTrack({ id: `track-${inner.length + 1}`, name: track.name }), clips: innerClips })
    tracks.push({ ...track, clips: track.clips.filter((clip) => !wanted.has(clip.id)) })
  }
  const group: GroupClip = {
    id: grouping.groupId,
    type: 'group',
    start,
    duration: end - start,
    transform: { x, y, scaleX: 1, scaleY: 1, rotation: 0 },
    opacity: 1,
    volume: 1,
    tracks: inner,
  }
  return placeOnTrack({ ...project, tracks }, { clips: [group], trackIndex: topRow, newTrack: grouping.newTrack })
}

function scaledKeyframes(list: Keyframe[] | undefined, factor: number, added: number, most: number): Keyframe[] | undefined {
  return list?.map((keyframe) => ({ ...keyframe, value: Math.min(most, keyframe.value * factor + added) }))
}

function placeKeyframes(keyframes: Keyframes, own: Transform, frame: GroupFrame): Pick<Keyframes, 'x' | 'y'> {
  if (keyframes.x === undefined && keyframes.y === undefined) return {}
  if (frame.rotation === 0) {
    return {
      x: scaledKeyframes(keyframes.x, frame.scale, frame.x, Infinity),
      y: scaledKeyframes(keyframes.y, frame.scale, frame.y, Infinity),
    }
  }
  const across = keyframes.x ?? []
  const down = keyframes.y ?? []
  const times = new Set<number>()
  for (const keyframe of [...across, ...down]) times.add(keyframe.time)
  const x: Keyframe[] = []
  const y: Keyframe[] = []
  for (const time of [...times].sort((a, b) => a - b)) {
    const at = onCanvas(frame, { ...own, x: valueAt(across, time) ?? own.x, y: valueAt(down, time) ?? own.y })
    const keyed = across.find((keyframe) => keyframe.time === time) ?? down.find((keyframe) => keyframe.time === time)
    const easing = keyed?.easing ?? 'linear'
    x.push({ time, value: at.x, easing })
    y.push({ time, value: at.y, easing })
  }
  return { x, y }
}

function outOfGroup(member: Clip, group: GroupClip): Clip {
  const volume = group.volume
  let freed = member
  if (hasVolume(freed) && volume !== 1) {
    let keyframes = freed.keyframes
    const volumeKeys = freed.keyframes?.volume
    if (volumeKeys !== undefined) keyframes = { ...freed.keyframes, volume: scaledKeyframes(volumeKeys, volume, 0, MAX_VOLUME) }
    freed = { ...freed, volume: Math.min(MAX_VOLUME, freed.volume * volume), keyframes }
  }
  if (!isVisual(freed)) return freed

  const frame: GroupFrame = { x: group.transform.x, y: group.transform.y, scale: group.transform.scaleX, rotation: group.transform.rotation }
  const own = freed.transform
  let keyframes = freed.keyframes
  if (keyframes !== undefined) {
    keyframes = {
      ...keyframes,
      ...placeKeyframes(keyframes, own, frame),
      scaleX: scaledKeyframes(keyframes.scaleX, frame.scale, 0, Infinity),
      scaleY: scaledKeyframes(keyframes.scaleY, frame.scale, 0, Infinity),
      rotation: scaledKeyframes(keyframes.rotation, 1, frame.rotation, Infinity),
    }
  }
  const placed = { ...freed, transform: onCanvas(frame, own), keyframes }
  if (placed.type === 'blur') {
    return { ...placed, strength: placed.strength * frame.scale, softEdge: placed.softEdge * frame.scale }
  }
  if (placed.type === 'highlight') return { ...placed, softEdge: placed.softEdge * frame.scale }
  if (placed.effects === undefined) return placed
  return { ...placed, effects: placed.effects.map((effect) => scaledEffect(effect, frame.scale)) }
}

function shownPart(member: Clip, group: GroupClip): Clip | undefined {
  const shift = group.start - (group.contentStart ?? 0)
  const moved = { ...member, start: member.start + shift }
  if (endOf(moved) <= group.start || moved.start >= endOf(group)) return undefined
  const fromStart = moved.start < group.start ? laterPart(moved, group.start) : moved
  return endOf(fromStart) > endOf(group) ? earlierPart(fromStart, endOf(group)) : fromStart
}

function isFree(track: Track, clips: readonly Clip[]): boolean {
  for (const clip of clips) {
    for (const other of track.clips) {
      const overlaps = endOf(other) > clip.start && other.start < endOf(clip)
      if (overlaps) return false
    }
  }
  return true
}

function freedMembers(inner: Track, group: GroupClip): Clip[] {
  const freed: Clip[] = []
  for (const member of inner.clips) {
    const shown = shownPart(member, group)
    if (shown !== undefined) freed.push(outOfGroup(shown, group))
  }
  return freed
}

export function ungroupClips(project: Project, ungrouping: Ungrouping): Project {
  const wanted = new Set(ungrouping.groupIds)
  const names = [...ungrouping.newTracks]
  const tracks: Track[] = []
  let hasChanged = false
  for (const track of project.tracks) {
    if (track.locked) {
      tracks.push(track)
      continue
    }
    const above: Track[] = []
    let clips = track.clips
    for (const group of track.clips) {
      if (group.type !== 'group' || !wanted.has(group.id)) continue
      if (names.length < group.tracks.length) continue
      hasChanged = true
      clips = clips.filter((clip) => clip !== group)
      for (const inner of group.tracks) {
        const freed = freedMembers(inner, group)
        const name = names.shift()
        if (freed.length === 0 || name === undefined) continue
        const isSameKind = inner.hidden === track.hidden && inner.muted === track.muted
        const fitsOnTrack = inner === group.tracks[0] && isSameKind && isFree({ ...track, clips }, freed)
        if (fitsOnTrack) clips = [...clips, ...freed]
        else above.push({ ...emptyTrack(name), hidden: inner.hidden, muted: inner.muted, clips: freed })
      }
    }
    tracks.push(clips === track.clips ? track : { ...track, clips }, ...above)
  }
  return hasChanged ? { ...project, tracks } : project
}

function groupIn(tracks: readonly Track[], groupId: string): GroupClip | undefined {
  for (const track of tracks) {
    const found = track.clips.find((clip) => clip.id === groupId)
    if (found?.type === 'group') return found
  }
  return undefined
}

function openedGroups(project: Project, openGroups: readonly string[]): GroupClip[] | undefined {
  const groups: GroupClip[] = []
  let tracks: readonly Track[] = project.tracks
  for (const groupId of openGroups) {
    const group = groupIn(tracks, groupId)
    if (group === undefined) return undefined
    groups.push(group)
    tracks = group.tracks
  }
  return groups
}

function scopedProject(project: Project, openGroups: readonly string[]): Project | undefined {
  const innermost = openedGroups(project, openGroups)?.at(-1)
  if (openGroups.length === 0) return project
  if (innermost === undefined) return undefined
  return { ...project, tracks: innermost.tracks, camera: undefined }
}

function clipIn(tracks: readonly Track[], clipId: string): Clip | undefined {
  for (const track of tracks) {
    const found = track.clips.find((clip) => clip.id === clipId)
    if (found !== undefined) return found
  }
  return undefined
}

// Walks the opened clips as far as they still exist; an animation clip opens the tracks of its own file.
export function resolveScope(wholeProject: Project, documents: Documents, mediaStates: MediaStates, wanted: readonly string[]): OpenScope {
  const openGroups: string[] = []
  const chain: string[] = []
  let owner = wholeProject
  let documentPath: string | undefined
  let groupsInDocument: string[] = []
  let tracks = wholeProject.tracks
  let scope: Scope | undefined
  let offset = 0
  let timeScale = 1
  for (const clipId of wanted) {
    const clip = clipIn(tracks, clipId)
    if (clip?.type === 'group') {
      const from = clip.contentStart ?? 0
      offset += (clip.start - from) * timeScale
      scope = { offset, timeScale, from, to: from + clip.duration }
      groupsInDocument.push(clipId)
      tracks = clip.tracks
    } else if (clip?.type === 'animation') {
      const opened = openedAnimation(clip, mediaStates, documents, chain)
      if (opened === undefined) break
      const innerScale = (timeScale * NORMAL_SPEED_PERCENT) / clip.speedPercent
      offset += clip.start * timeScale - clip.sourceStart * innerScale
      timeScale = innerScale
      scope = { offset, timeScale, from: clip.sourceStart, to: clip.sourceStart + (clip.duration * clip.speedPercent) / NORMAL_SPEED_PERCENT }
      chain.push(opened.path)
      owner = opened.project
      documentPath = opened.path
      groupsInDocument = []
      tracks = owner.tracks
    } else {
      break
    }
    openGroups.push(clipId)
  }
  const project = groupsInDocument.length === 0 ? owner : { ...owner, tracks, camera: undefined }
  return { openGroups, chain, documentPath, groupsInDocument, project, scope }
}

function onGrid(time: number): number {
  return Math.round(time / TIMELINE_GRID) * TIMELINE_GRID
}

export function episodeTimeOf(scope: Scope | undefined, time: number): number {
  if (scope === undefined) return time
  return onGrid(scope.offset + time * scope.timeScale)
}

export function scopeTimeOf(scope: Scope | undefined, episodeTime: number): number {
  if (scope === undefined) return episodeTime
  return onGrid((episodeTime - scope.offset) / scope.timeScale)
}

function withTracksAt(tracks: readonly Track[], openGroups: readonly string[], edited: Track[]): Track[] {
  const [groupId, ...deeper] = openGroups
  if (groupId === undefined) return edited
  return tracks.map((track) => {
    if (!track.clips.some((clip) => clip.id === groupId)) return track
    const clips = track.clips.map((clip) => {
      if (clip.id !== groupId || clip.type !== 'group') return clip
      return { ...clip, tracks: withTracksAt(clip.tracks, deeper, edited) }
    })
    return { ...track, clips }
  })
}

export function withScopedProject(project: Project, openGroups: readonly string[], edited: Project): Project {
  if (openGroups.length === 0) return edited
  const scoped = scopedProject(project, openGroups)
  if (scoped === undefined) return project
  if (edited.tracks === scoped.tracks && edited.media === project.media) return project
  return { ...project, media: edited.media, tracks: withTracksAt(project.tracks, openGroups, edited.tracks) }
}

export function intoGroup(frame: GroupFrame, transform: Transform): Transform {
  if (frame.scale === 0) return transform
  const angle = frame.rotation * DEGREES_TO_RADIANS
  const x = transform.x - frame.x
  const y = transform.y - frame.y
  return {
    x: (x * Math.cos(angle) + y * Math.sin(angle)) / frame.scale,
    y: (y * Math.cos(angle) - x * Math.sin(angle)) / frame.scale,
    scaleX: transform.scaleX / frame.scale,
    scaleY: transform.scaleY / frame.scale,
    rotation: transform.rotation - frame.rotation,
  }
}
