import { describe, expect, it } from 'vitest'
import { MEDIA_STATES, SECOND, audioClip, clipIds, clipOf, groupClip, projectOf, reopened, textClip, track, videoClip } from '../../test/fixtures.js'
import { mix, type AudioReader } from '../engine/mixer.js'
import { groupFrameAt, onCanvas, resolveFrame } from '../engine/resolve.js'
import type { Clip, GroupClip, Project } from '../shared/project.js'
import { groupClips, intoGroup, scopeOf, scopedProject, ungroupClips, withScopedProject } from './groups.js'
import { setProperties } from './properties.js'

const NEW_TRACK = { id: 'new', name: 'Track 9' }
const NEW_TRACKS = [
  { id: 'n1', name: 'Track 4' },
  { id: 'n2', name: 'Track 5' },
  { id: 'n3', name: 'Track 6' },
]

function sample(): Project {
  return projectOf([
    track('t1', [videoClip('a', SECOND, 3 * SECOND, { transform: { x: 400, y: 300, scaleX: 0.5, scaleY: 0.5, rotation: 0 } }), videoClip('b', 6 * SECOND, SECOND)]),
    track('t2', [audioClip('music', 2 * SECOND, 4 * SECOND)]),
    track('t3', [textClip('title', 2 * SECOND, 3 * SECOND, { transform: { x: 1000, y: 700, scaleX: 1, scaleY: 1, rotation: 15 } })]),
  ])
}

function groupOf(project: Project, id: string): GroupClip {
  const clip = clipOf(project, id)
  if (clip.type !== 'group') throw new Error(`"${id}" is not a group`)
  return clip
}

// What is drawn at a number of moments, without the names of the groups around each layer and with the numbers rounded.
function drawn(project: Project): unknown[] {
  const pictures: unknown[] = []
  for (let time = 0; time < 13 * SECOND; time += SECOND / 4) {
    const layers = resolveFrame(project, MEDIA_STATES, time, 1)
    pictures.push(layers.map((layer) => ({ id: layer.clipId, opacity: layer.opacity, x: layer.transform.x.toFixed(6), y: layer.transform.y.toFixed(6), turn: layer.transform.rotation.toFixed(6), scale: layer.transform.scaleX.toFixed(6) })))
  }
  return pictures
}

const readAudio: AudioReader = (mediaId, firstSample, sampleCount) => {
  const samples = new Float32Array(sampleCount * 2)
  for (let index = 0; index < sampleCount; index++) samples[index * 2] = (((firstSample + index) % 4800) / 4800) * 0.5
  return Promise.resolve(mediaId === 'music' ? samples : new Float32Array(sampleCount * 2))
}

async function heard(project: Project): Promise<Float32Array> {
  return mix(project, MEDIA_STATES, 0, 8 * 48_000, readAudio)
}

describe('groupClips', () => {
  const grouped = groupClips(sample(), { clipIds: ['a', 'music', 'title'], groupId: 'group', newTrack: NEW_TRACK })

  it('makes one clip that spans its members, where the topmost of them was', () => {
    expect(clipIds(grouped)).toEqual([['b'], [], ['group']])
    const group = groupOf(grouped, 'group')
    expect(group).toMatchObject({ start: SECOND, duration: 5 * SECOND, opacity: 1, volume: 1, transform: { x: 700, y: 500, scaleX: 1, scaleY: 1, rotation: 0 } })
    expect(group.tracks.map((inner) => inner.clips.map((clip) => clip.id))).toEqual([['a'], ['music'], ['title']])
    expect(group.tracks.map((inner) => inner.name)).toEqual(['t1', 't2', 't3'])
    expect(reopened(grouped)).toEqual(grouped)
  })

  it('keeps the timing of its members, counted from its own start, and their places, counted from its middle', () => {
    const group = groupOf(grouped, 'group')
    expect(group.tracks[0]?.clips[0]).toMatchObject({ start: 0, duration: 3 * SECOND, transform: { x: -300, y: -200, scaleX: 0.5 } })
    expect(group.tracks[1]?.clips[0]).toMatchObject({ start: SECOND, duration: 4 * SECOND })
    expect(group.tracks[2]?.clips[0]).toMatchObject({ start: SECOND, transform: { x: 300, y: 200, rotation: 15 } })
  })

  it('draws and sounds as before', async () => {
    expect(drawn(grouped)).toEqual(drawn(sample()))
    expect(await heard(grouped)).toEqual(await heard(sample()))
  })

  it('moves position keyframes with their clip', () => {
    const moving = setProperties(setProperties(sample(), ['a'], { x: 100 }, SECOND), ['a'], { x: 800 }, 3 * SECOND)
    const keyed = projectOf(moving.tracks.map((entry) => ({ ...entry, clips: entry.clips.map((clip): Clip => (clip.id === 'a' ? { ...clip, keyframes: { x: [{ time: 0, value: 100, easing: 'easeIn' }, { time: 2 * SECOND, value: 800, easing: 'linear' }] } } : clip)) })))
    const together = groupClips(keyed, { clipIds: ['a', 'title'], groupId: 'group', newTrack: NEW_TRACK })
    expect(drawn(together)).toEqual(drawn(keyed))
  })

  it('goes on a new track above when other clips are in the way', () => {
    const crowded = projectOf([track('t1', [videoClip('a', 0, SECOND), videoClip('between', SECOND, SECOND), videoClip('c', 2 * SECOND, SECOND)]), track('t2', [])])
    const together = groupClips(crowded, { clipIds: ['a', 'c'], groupId: 'group', newTrack: NEW_TRACK })
    expect(clipIds(together)).toEqual([['between'], ['group'], []])
    expect(together.tracks[1]).toMatchObject(NEW_TRACK)
  })

  it('groups a group, and leaves locked tracks and unknown clips alone', () => {
    const nested = groupClips(grouped, { clipIds: ['group', 'b'], groupId: 'outer', newTrack: NEW_TRACK })
    expect(drawn(nested)).toEqual(drawn(sample()))
    expect(reopened(nested)).toEqual(nested)
    const locked = projectOf([track('t1', [videoClip('a', 0, SECOND)], { locked: true })])
    expect(groupClips(locked, { clipIds: ['a', 'missing'], groupId: 'group', newTrack: NEW_TRACK })).toBe(locked)
  })

  it('puts a group of sounds in the middle of the canvas', () => {
    const sounds = groupClips(sample(), { clipIds: ['music'], groupId: 'group', newTrack: NEW_TRACK })
    expect(groupOf(sounds, 'group').transform).toMatchObject({ x: 960, y: 540 })
  })
})

describe('ungroupClips', () => {
  const grouped = groupClips(sample(), { clipIds: ['a', 'music', 'title'], groupId: 'group', newTrack: NEW_TRACK })

  it('puts the members back, the lowest track where the group was and the others above it', async () => {
    const freed = ungroupClips(grouped, { groupIds: ['group'], newTracks: NEW_TRACKS })
    expect(clipIds(freed)).toEqual([['b'], [], ['a'], ['music'], ['title']])
    expect(freed.tracks.map((entry) => entry.id)).toEqual(['t1', 't2', 't3', 'n2', 'n3'])
    expect(drawn(freed)).toEqual(drawn(sample()))
    expect(await heard(freed)).toEqual(await heard(sample()))
    expect(reopened(freed)).toEqual(freed)
  })

  it('bakes the place, turn, size and volume of the group into its members', async () => {
    const moved = setProperties(grouped, ['group'], { x: 900, y: 400, scaleX: 2, rotation: 90, volume: 0.5 }, 0)
    expect(groupOf(moved, 'group').transform).toMatchObject({ scaleX: 2, scaleY: 2 })
    const freed = ungroupClips(moved, { groupIds: ['group'], newTracks: NEW_TRACKS })
    expect(drawn(freed)).toEqual(drawn(moved))
    expect(await heard(freed)).toEqual(await heard(moved))
    expect(clipOf(freed, 'music')).toMatchObject({ volume: 0.5 })
  })

  it('bakes the group into the keyframes of its members', () => {
    const keyed = videoClip('m', 0, 4 * SECOND, {
      transform: { x: 10, y: 20, scaleX: 1, scaleY: 1, rotation: 0 },
      keyframes: {
        x: [{ time: 0, value: 0, easing: 'easeOut' }, { time: 2 * SECOND, value: 200, easing: 'linear' }],
        y: [{ time: 0, value: 50, easing: 'easeOut' }, { time: 2 * SECOND, value: -50, easing: 'linear' }],
        scaleX: [{ time: 0, value: 1, easing: 'linear' }, { time: 4 * SECOND, value: 3, easing: 'linear' }],
        rotation: [{ time: 0, value: 0, easing: 'linear' }, { time: 4 * SECOND, value: 45, easing: 'linear' }],
      },
    })
    for (const rotation of [0, 30]) {
      const group = groupClip('group', SECOND, 4 * SECOND, [[keyed]], { transform: { x: 500, y: 400, scaleX: 0.5, scaleY: 0.5, rotation } })
      const project = projectOf([track('t1', [group])])
      const freed = ungroupClips(project, { groupIds: ['group'], newTracks: NEW_TRACKS })
      expect(drawn(freed)).toEqual(drawn(project))
      expect(reopened(freed)).toEqual(freed)
    }
  })

  it('scales effects and blurs that are measured in canvas pixels', () => {
    const shadowed = videoClip('m', 0, SECOND, { effects: [{ type: 'border', width: 4, color: '#ffffff' }] })
    const blur: Clip = { id: 'blur', type: 'blur', start: 0, duration: SECOND, transform: shadowed.transform, opacity: 1, width: 100, height: 50, shape: 'rectangle', softEdge: 6, strength: 10 }
    const group = groupClip('group', 0, SECOND, [[shadowed], [blur]], { transform: { x: 0, y: 0, scaleX: 2, scaleY: 2, rotation: 0 } })
    const freed = ungroupClips(projectOf([track('t1', [group])]), { groupIds: ['group'], newTracks: NEW_TRACKS })
    expect(clipOf(freed, 'm')).toMatchObject({ effects: [{ type: 'border', width: 8 }] })
    expect(clipOf(freed, 'blur')).toMatchObject({ strength: 20, softEdge: 12 })
  })

  it('keeps only the part of each member the group shows', () => {
    const group = groupClip('group', 10 * SECOND, 2 * SECOND, [[videoClip('early', 0, 2 * SECOND), videoClip('cut', 2 * SECOND, 4 * SECOND, { fadeIn: SECOND }), videoClip('late', 7 * SECOND, SECOND)]], { contentStart: 3 * SECOND })
    const project = projectOf([track('t1', [group])])
    const freed = ungroupClips(project, { groupIds: ['group'], newTracks: NEW_TRACKS })
    expect(clipIds(freed)).toEqual([['cut']])
    expect(clipOf(freed, 'cut')).toMatchObject({ start: 10 * SECOND, duration: 2 * SECOND, sourceStart: SECOND })
    expect(drawn(freed)).toEqual(drawn(project))
    expect(resolveFrame(freed, MEDIA_STATES, 11 * SECOND, 1)[0]).toMatchObject({ clipId: 'cut', frame: 60 })
    expect(resolveFrame(project, MEDIA_STATES, 11 * SECOND, 1)[0]).toMatchObject({ clipId: 'cut', frame: 60 })
  })

  it('keeps hidden and muted tracks as they were, on tracks of their own', () => {
    const group = groupClip('group', 0, SECOND, [[videoClip('m', 0, SECOND)]])
    const hidden = { ...group, tracks: group.tracks.map((inner) => ({ ...inner, hidden: true })) }
    const freed = ungroupClips(projectOf([track('t1', [hidden])]), { groupIds: ['group'], newTracks: NEW_TRACKS })
    expect(clipIds(freed)).toEqual([[], ['m']])
    expect(freed.tracks[1]).toMatchObject({ id: 'n1', hidden: true })
  })

  it('leaves alone what is not a group, is locked, or has more tracks than there are names for', () => {
    expect(ungroupClips(grouped, { groupIds: ['b', 'missing'], newTracks: NEW_TRACKS })).toBe(grouped)
    expect(ungroupClips(grouped, { groupIds: ['group'], newTracks: NEW_TRACKS.slice(0, 2) })).toBe(grouped)
    const locked = { ...grouped, tracks: grouped.tracks.map((entry) => ({ ...entry, locked: true })) }
    expect(ungroupClips(locked, { groupIds: ['group'], newTracks: NEW_TRACKS })).toBe(locked)
  })
})

describe('editing inside a group', () => {
  const inner = groupClip('inner', SECOND, 2 * SECOND, [[videoClip('deep', 0, 2 * SECOND)]], { contentStart: SECOND / 2 })
  const outer = groupClip('outer', 4 * SECOND, 6 * SECOND, [[videoClip('m', 0, SECOND), inner], [audioClip('music', 0, 6 * SECOND)]], { contentStart: SECOND })
  const project: Project = { ...projectOf([track('t1', [videoClip('a', 0, SECOND), outer])]), camera: [{ time: 0, duration: SECOND, x: 960, y: 540, scale: 1, easing: 'linear' }] }

  it('shows the tracks of the innermost open group, without the camera', () => {
    expect(scopedProject(project, [])).toBe(project)
    const scoped = scopedProject(project, ['outer'])
    expect(scoped?.tracks).toBe(outer.tracks)
    expect(scoped?.camera).toBeUndefined()
    expect(scoped?.canvas).toBe(project.canvas)
    expect(scopedProject(project, ['outer', 'inner'])?.tracks).toBe(inner.tracks)
  })

  it('knows nothing of a group that is gone or not open in that order', () => {
    expect(scopedProject(project, ['inner'])).toBeUndefined()
    expect(scopedProject(project, ['outer', 'a'])).toBeUndefined()
    expect(scopeOf(project, ['a'])).toBeUndefined()
    expect(scopeOf(project, [])).toBeUndefined()
  })

  it('tells where the time of the open tracks lies in the project, and what of it the group shows', () => {
    expect(scopeOf(project, ['outer'])).toEqual({ offset: 3 * SECOND, from: SECOND, to: 7 * SECOND })
    expect(scopeOf(project, ['outer', 'inner'])).toEqual({ offset: 3.5 * SECOND, from: SECOND / 2, to: 2.5 * SECOND })
  })

  it('writes an edit of the open tracks back into the whole project', () => {
    const scoped = scopedProject(project, ['outer', 'inner'])
    if (scoped === undefined) throw new Error('The group is not there')
    const edited = setProperties(scoped, ['deep'], { opacity: 0.25 }, 0)
    const whole = withScopedProject(project, ['outer', 'inner'], edited)
    expect(scopedProject(whole, ['outer', 'inner'])?.tracks).toBe(edited.tracks)
    expect(whole.camera).toBe(project.camera)
    expect(whole.tracks[0]?.clips[0]).toBe(project.tracks[0]?.clips[0])
    expect(reopened(whole)).toEqual(whole)
  })

  it('takes media added inside a group into the whole project, and nothing when nothing changed', () => {
    const scoped = scopedProject(project, ['outer'])
    if (scoped === undefined) throw new Error('The group is not there')
    expect(withScopedProject(project, ['outer'], scoped)).toBe(project)
    const media = [...project.media, { id: 'new', path: '/footage/new.mp4', relativePath: '' }]
    expect(withScopedProject(project, ['outer'], { ...scoped, media }).media).toBe(media)
    expect(withScopedProject(project, [], scoped)).toBe(scoped)
    expect(withScopedProject(project, ['gone'], scoped)).toBe(project)
  })

  it('turns a place on the canvas into a place inside the open group', () => {
    const turned = { ...project, tracks: [track('t1', [{ ...outer, transform: { x: 300, y: 200, scaleX: 2, scaleY: 2, rotation: 40 } }])] }
    const frame = groupFrameAt(turned, ['outer'], 5 * SECOND)
    const member = { x: 120, y: -40, scaleX: 0.5, scaleY: 0.75, rotation: 10 }
    const back = intoGroup(frame, onCanvas(frame, member))
    expect(back.x).toBeCloseTo(120)
    expect(back.y).toBeCloseTo(-40)
    expect(back).toMatchObject({ scaleX: 0.5, scaleY: 0.75, rotation: 10 })
  })
})
