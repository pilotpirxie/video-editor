import { onCanvas, scaledEffect, type GroupFrame } from '../engine/resolve.js'
import { valueAt, type Clip, type GroupClip, type Keyframe, type Keyframes, type Project, type Track, type Transform } from '../shared/project.js'
import { emptyTrack, endOf, hasVolume, isVisual, placeOnTrack, type NewTrack } from './clips.js'
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
  // One for every track inside the groups; a group whose tracks cannot all be named stays a group.
  newTracks: readonly NewTrack[]
}

// What is open when groups are edited from the inside: project time is the time of the open tracks plus `offset`,
// and the innermost group shows its tracks from `from` to `to`.
export type Scope = {
  offset: number
  from: number
  to: number
}

function movedKeyframes(keyframes: Keyframes | undefined, x: number, y: number): Keyframes | undefined {
  if (keyframes?.x === undefined && keyframes?.y === undefined) return keyframes
  return {
    ...keyframes,
    x: keyframes.x?.map((keyframe) => ({ ...keyframe, value: keyframe.value + x })),
    y: keyframes.y?.map((keyframe) => ({ ...keyframe, value: keyframe.value + y })),
  }
}

// A member as it lies inside a new group that starts at `start` and has its middle at (x, y).
function asMember(clip: Clip, start: number, x: number, y: number): Clip {
  if (!isVisual(clip)) return { ...clip, start: clip.start - start }
  const transform = { ...clip.transform, x: clip.transform.x - x, y: clip.transform.y - y }
  return { ...clip, start: clip.start - start, transform, keyframes: movedKeyframes(clip.keyframes, -x, -y) }
}

// Makes one clip of the chosen ones. Inside, they keep their tracks, their order and their timing; the group lies where the topmost of them was,
// or on a new track above it when other clips are in the way. Its middle is the middle of the places of its members, so turning it turns them around that.
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
    x = (Math.min(...placed.map((clip) => clip.transform.x)) + Math.max(...placed.map((clip) => clip.transform.x))) / 2
    y = (Math.min(...placed.map((clip) => clip.transform.y)) + Math.max(...placed.map((clip) => clip.transform.y))) / 2
  }

  const inner: Track[] = []
  const tracks = project.tracks.map((track) => {
    if (track.locked || !track.clips.some((clip) => wanted.has(clip.id))) return track
    const taken = track.clips.filter((clip) => wanted.has(clip.id))
    inner.push({ ...emptyTrack({ id: `track-${inner.length + 1}`, name: track.name }), clips: taken.map((clip) => asMember(clip, start, x, y)) })
    return { ...track, clips: track.clips.filter((clip) => !wanted.has(clip.id)) }
  })
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

// The x and y keyframes of a member, as they are on the canvas. A turned group mixes the two, so both get a keyframe wherever either had one.
function placeKeyframes(keyframes: Keyframes, own: Transform, frame: GroupFrame): Pick<Keyframes, 'x' | 'y'> {
  if (keyframes.x === undefined && keyframes.y === undefined) return {}
  if (frame.rotation === 0) {
    return { x: scaledKeyframes(keyframes.x, frame.scale, frame.x, Infinity), y: scaledKeyframes(keyframes.y, frame.scale, frame.y, Infinity) }
  }
  const across = keyframes.x ?? []
  const down = keyframes.y ?? []
  const times = new Set<number>()
  for (const keyframe of [...across, ...down]) times.add(keyframe.time)
  const x: Keyframe[] = []
  const y: Keyframe[] = []
  for (const time of [...times].sort((a, b) => a - b)) {
    const at = onCanvas(frame, { ...own, x: valueAt(across, time) ?? own.x, y: valueAt(down, time) ?? own.y })
    const easing = across.find((keyframe) => keyframe.time === time)?.easing ?? down.find((keyframe) => keyframe.time === time)?.easing ?? 'linear'
    x.push({ time, value: at.x, easing })
    y.push({ time, value: at.y, easing })
  }
  return { x, y }
}

// A member as it is drawn while its group stands still at its own place, written as a clip that needs no group.
function outOfGroup(member: Clip, group: GroupClip): Clip {
  const volume = group.volume
  let freed = member
  if (hasVolume(freed) && volume !== 1) {
    const keyframes = freed.keyframes?.volume === undefined ? freed.keyframes : { ...freed.keyframes, volume: scaledKeyframes(freed.keyframes.volume, volume, 0, MAX_VOLUME) }
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
  if (placed.type === 'blur') return { ...placed, strength: placed.strength * frame.scale, softEdge: placed.softEdge * frame.scale }
  if (placed.type === 'highlight') return { ...placed, softEdge: placed.softEdge * frame.scale }
  if (placed.effects === undefined) return placed
  return { ...placed, effects: placed.effects.map((effect) => scaledEffect(effect, frame.scale)) }
}

// The part of a member its group shows, at the time it has in the tracks around the group; undefined when the group shows none of it.
// A member the group cuts into is cut as a split would cut it, so what it does at the end that is cut off does not happen at the cut.
function shownPart(member: Clip, group: GroupClip): Clip | undefined {
  const shift = group.start - (group.contentStart ?? 0)
  const moved = { ...member, start: member.start + shift }
  if (endOf(moved) <= group.start || moved.start >= endOf(group)) return undefined
  const fromStart = moved.start < group.start ? laterPart(moved, group.start) : moved
  return endOf(fromStart) > endOf(group) ? earlierPart(fromStart, endOf(group)) : fromStart
}

function isFree(track: Track, clips: readonly Clip[]): boolean {
  return clips.every((clip) => track.clips.every((other) => endOf(other) <= clip.start || other.start >= endOf(clip)))
}

// Puts the members of the chosen groups back on tracks of their own, where and as they were shown while the group stood at its own place.
// What the group itself did is given up: its opacity, fades, effects, animations, transitions and keyframes.
// The lowest track of a group goes where the group was when there is room; the others become new tracks directly above, in their order.
export function ungroupClips(project: Project, ungrouping: Ungrouping): Project {
  const wanted = new Set(ungrouping.groupIds)
  const names = [...ungrouping.newTracks]
  const tracks: Track[] = []
  let hasChanged = false
  for (const track of project.tracks) {
    const above: Track[] = []
    let clips = track.clips
    for (const group of track.clips) {
      if (track.locked || group.type !== 'group' || !wanted.has(group.id) || names.length < group.tracks.length) continue
      hasChanged = true
      clips = clips.filter((clip) => clip !== group)
      for (const inner of group.tracks) {
        const freed: Clip[] = []
        for (const member of inner.clips) {
          const shown = shownPart(member, group)
          if (shown !== undefined) freed.push(outOfGroup(shown, group))
        }
        const name = names.shift()
        if (freed.length === 0 || name === undefined) continue
        const isSameKind = inner.hidden === track.hidden && inner.muted === track.muted
        if (inner === group.tracks[0] && isSameKind && isFree({ ...track, clips }, freed)) clips = [...clips, ...freed]
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

// The groups reached by going into `openGroups` one after the other; undefined when one of them is not there (any more).
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

// The project as it is edited while groups are open: the tracks of the innermost open group, in that group's own time.
// The camera is left out, because it lives in the time of the whole project. Undefined when a group of the path is gone.
export function scopedProject(project: Project, openGroups: readonly string[]): Project | undefined {
  const innermost = openedGroups(project, openGroups)?.at(-1)
  if (openGroups.length === 0) return project
  if (innermost === undefined) return undefined
  return { ...project, tracks: innermost.tracks, camera: undefined }
}

export function scopeOf(project: Project, openGroups: readonly string[]): Scope | undefined {
  const groups = openedGroups(project, openGroups)
  const innermost = groups?.at(-1)
  if (groups === undefined || innermost === undefined) return undefined
  let offset = 0
  for (const group of groups) offset += group.start - (group.contentStart ?? 0)
  const from = innermost.contentStart ?? 0
  return { offset, from, to: from + innermost.duration }
}

function withTracksAt(tracks: readonly Track[], openGroups: readonly string[], edited: Track[]): Track[] {
  const [groupId, ...deeper] = openGroups
  if (groupId === undefined) return edited
  return tracks.map((track) => {
    if (!track.clips.some((clip) => clip.id === groupId)) return track
    const clips = track.clips.map((clip) => (clip.id === groupId && clip.type === 'group' ? { ...clip, tracks: withTracksAt(clip.tracks, deeper, edited) } : clip))
    return { ...track, clips }
  })
}

// The whole project after the open tracks were edited. Media added while a group is open belongs to the whole project;
// the canvas and the camera cannot be changed from inside a group.
export function withScopedProject(project: Project, openGroups: readonly string[], edited: Project): Project {
  if (openGroups.length === 0) return edited
  const scoped = scopedProject(project, openGroups)
  if (scoped === undefined) return project
  if (edited.tracks === scoped.tracks && edited.media === project.media) return project
  return { ...project, media: edited.media, tracks: withTracksAt(project.tracks, openGroups, edited.tracks) }
}

// The transform a member needs so that, inside a group placed by `frame`, it is drawn with the given transform on the canvas. The opposite of `onCanvas`.
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
