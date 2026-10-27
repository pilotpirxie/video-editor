import { describe, expect, it } from 'vitest'
import { FRAME, MEDIA_STATES, SECOND, animationClip, audioClip, clipIds, clipOf, drawingClip, groupClip, projectOf, reopened, textClip, track, videoClip } from '../../test/fixtures.js'
import { mix, type AudioReader } from '../engine/mixer.js'
import { resolveFrame, type Layer, type MediaStates } from '../engine/resolve.js'
import type { Project } from '../shared/project.js'
import { clipsToSplit, splitClips } from './split.js'

const SAMPLES_PER_SECOND = 48_000

const animated = videoClip('a', 2 * SECOND, 6 * SECOND, {
  sourceStart: 12_345,
  speedPercent: 137,
  opacity: 0.8,
  crop: { left: 10, top: 0, right: 0, bottom: 4 },
  keyframes: {
    x: [{ time: 0, value: 100, easing: 'easeInOut' }, { time: 4 * SECOND, value: 900, easing: 'easeOut' }, { time: 6 * SECOND, value: 300, easing: 'linear' }],
    scaleX: [{ time: SECOND, value: 0.5, easing: 'easeIn' }, { time: 5 * SECOND, value: 1.5, easing: 'hold' }],
    opacity: [{ time: 0, value: 0.2, easing: 'hold' }, { time: 3 * SECOND, value: 1, easing: 'linear' }],
    cropLeft: [{ time: 0, value: 0, easing: 'linear' }, { time: 6 * SECOND, value: 200, easing: 'linear' }],
  },
})

function withoutClipIds(layers: Layer[]): unknown[] {
  return layers.map((layer) => ({ ...layer, clipId: '', key: '' }))
}

function split(project: Project, cut: number, selection: readonly string[] = []): Project {
  const newIds = new Map(clipsToSplit(project, selection, cut).map((id) => [id, `${id}-2`]))
  return splitClips(project, cut, newIds)
}

const readSource: AudioReader = async (_mediaId, firstSample, sampleCount) => {
  const samples = new Float32Array(sampleCount * 2)
  for (let index = 0; index < sampleCount; index++) {
    samples[index * 2] = Math.fround(Math.sin((firstSample + index) * 0.031) * 0.3)
    samples[index * 2 + 1] = Math.fround(Math.cos((firstSample + index) * 0.017) * 0.3)
  }
  return samples
}

describe('clipsToSplit', () => {
  const project = projectOf([
    track('t1', [videoClip('a', 0, 4 * SECOND), videoClip('b', 4 * SECOND, 4 * SECOND)]),
    track('t2', [audioClip('music', 0, 10 * SECOND)]),
    track('t3', [videoClip('locked', 0, 10 * SECOND)], { locked: true }),
  ])

  it('takes every clip under the playhead on unlocked tracks when nothing is selected', () => {
    expect(clipsToSplit(project, [], 2 * SECOND)).toEqual(['a', 'music'])
  })

  it('takes only the selected clips when there is a selection', () => {
    expect(clipsToSplit(project, ['music', 'b'], 2 * SECOND)).toEqual(['music'])
  })

  it('takes nothing at a clip edge', () => {
    expect(clipsToSplit(project, [], 4 * SECOND)).toEqual(['music'])
    expect(clipsToSplit(project, ['a'], 0)).toEqual([])
  })
})

describe('splitClips', () => {
  it('makes two clips that meet at the cut, the second continuing in the source', () => {
    const project = projectOf([track('t1', [videoClip('a', 2 * SECOND, 6 * SECOND, { sourceStart: 12_345, speedPercent: 137 })])])
    const cut = 2 * SECOND + 77 * FRAME
    const after = split(project, cut)
    expect(clipIds(after)).toEqual([['a', 'a-2']])
    expect(clipOf(after, 'a')).toMatchObject({ start: 2 * SECOND, duration: 77 * FRAME, sourceStart: 12_345 })
    expect(clipOf(after, 'a-2')).toMatchObject({ start: cut, duration: 6 * SECOND - 77 * FRAME, sourceStart: 12_345 + ((77 * FRAME) / 100) * 137 })
    reopened(after)
  })

  it('keeps the fade-in on the first part and moves the fade-out to the second', () => {
    const faded = videoClip('a', 0, 6 * SECOND, { fadeIn: SECOND, fadeOut: 2 * SECOND, volumeFadeIn: SECOND, volumeFadeOut: SECOND })
    const after = reopened(split(projectOf([track('t1', [faded])]), 3 * SECOND))
    expect(clipOf(after, 'a')).toMatchObject({ fadeIn: SECOND, volumeFadeIn: SECOND })
    expect(clipOf(after, 'a')).not.toHaveProperty('fadeOut')
    expect(clipOf(after, 'a')).not.toHaveProperty('volumeFadeOut')
    expect(clipOf(after, 'a-2')).toMatchObject({ fadeOut: 2 * SECOND, volumeFadeOut: SECOND })
    expect(clipOf(after, 'a-2')).not.toHaveProperty('fadeIn')
  })

  it('keeps the transition at the start on the first part, moves the one at the end to the second, and keeps the effects on both', () => {
    const effects = [{ type: 'border' as const, width: 4, color: '#ffffff' }]
    const dressed = videoClip('a', 0, 6 * SECOND, { transitionIn: { type: 'zoom', duration: SECOND }, transitionOut: { type: 'push', duration: 2 * SECOND }, effects })
    const after = reopened(split(projectOf([track('t1', [dressed])]), 3 * SECOND))
    expect(clipOf(after, 'a')).toMatchObject({ transitionIn: { type: 'zoom', duration: SECOND }, effects })
    expect(clipOf(after, 'a')).not.toHaveProperty('transitionOut')
    expect(clipOf(after, 'a-2')).toMatchObject({ transitionOut: { type: 'push', duration: 2 * SECOND }, effects })
    expect(clipOf(after, 'a-2')).not.toHaveProperty('transitionIn')
  })

  it('does not shorten a transition when the cut makes its clip shorter than it', () => {
    const long = videoClip('a', 0, 6 * SECOND, { transitionIn: { type: 'crossDissolve', duration: 4 * SECOND } })
    const after = reopened(split(projectOf([track('t1', [long])]), SECOND))
    expect(clipOf(after, 'a')).toMatchObject({ duration: SECOND, transitionIn: { type: 'crossDissolve', duration: 4 * SECOND } })
  })

  it('shortens a fade that the cut lands inside', () => {
    const faded = videoClip('a', 0, 6 * SECOND, { fadeIn: 2 * SECOND, fadeOut: 2 * SECOND })
    const after = reopened(split(projectOf([track('t1', [faded])]), SECOND))
    expect(clipOf(after, 'a')).toMatchObject({ duration: SECOND, fadeIn: SECOND })
    expect(clipOf(after, 'a-2')).toMatchObject({ fadeOut: 2 * SECOND })
  })

  it.each([
    ['a quarter in', 2 * SECOND + 45 * FRAME],
    ['inside an eased segment', 2 * SECOND + 100 * FRAME],
    ['one frame before the end', 8 * SECOND - FRAME],
  ])('draws every frame exactly as before when cut %s', (_label, cut) => {
    const before = projectOf([track('t1', [animated])])
    const after = reopened(split(before, cut))
    expect(clipIds(after)).toEqual([['a', 'a-2']])
    for (let time = 0; time < 9 * SECOND; time += FRAME) {
      expect(withoutClipIds(resolveFrame(after, MEDIA_STATES, {}, time, 0.5)), `frame at ${time}`).toEqual(withoutClipIds(resolveFrame(before, MEDIA_STATES, {}, time, 0.5)))
    }
  })

  it('mixes exactly the same samples as before the split', async () => {
    const sounding: MediaStates = { ...MEDIA_STATES, video: MEDIA_STATES.music ?? { error: 'fixture', isMissing: false } }
    const before = projectOf([
      track('t1', [videoClip('a', SECOND / 2, 3 * SECOND, { sourceStart: 7_000_000, volume: 0.7, volumeFadeIn: SECOND / 2, volumeFadeOut: SECOND })]),
      track('t2', [audioClip('music', 0, 4 * SECOND, { volume: 0.5 })]),
    ])
    const after = reopened(split(before, 2 * SECOND + 3 * FRAME))
    expect(clipIds(after)).toEqual([['a', 'a-2'], ['music', 'music-2']])

    const expected = await mix(before, sounding, {}, 0, 4 * SAMPLES_PER_SECOND, readSource)
    const actual = await mix(after, sounding, {}, 0, 4 * SAMPLES_PER_SECOND, readSource)
    expect(Buffer.from(actual.buffer).equals(Buffer.from(expected.buffer))).toBe(true)
  })

  it('leaves clips alone that the cut does not pass through, and locked tracks', () => {
    const project = projectOf([track('t1', [videoClip('a', 0, 2 * SECOND)]), track('t2', [videoClip('b', 0, 4 * SECOND)], { locked: true })])
    expect(splitClips(project, 3 * SECOND, new Map([['a', 'a-2']]))).toBe(project)
    expect(splitClips(project, SECOND, new Map([['b', 'b-2']]))).toBe(project)
  })
})

describe('splitting groups and animated clips', () => {
  const members = [[videoClip('m', 0, 4 * SECOND, { fadeOut: SECOND }), videoClip('n', 4 * SECOND, 2 * SECOND)], [audioClip('music', SECOND, 5 * SECOND)]]
  const grouped = projectOf([track('t1', [groupClip('group', 2 * SECOND, 6 * SECOND, members, { volume: 0.5, volumeFadeOut: SECOND })])])
  const newIds = new Map([
    ['group', 'group-2'],
    ['m', 'm-2'],
    ['n', 'n-2'],
    ['music', 'music-2'],
  ])

  it('shows the same members from the cut on in the second part, as copies with ids of their own', () => {
    const parts = splitClips(grouped, 5 * SECOND, newIds)
    expect(clipIds(parts)).toEqual([['group', 'group-2']])
    expect(clipOf(parts, 'group')).toMatchObject({ start: 2 * SECOND, duration: 3 * SECOND })
    expect(clipOf(parts, 'group')).not.toMatchObject({ volumeFadeOut: SECOND })
    const second = clipOf(parts, 'group-2')
    expect(second).toMatchObject({ start: 5 * SECOND, duration: 3 * SECOND, contentStart: 3 * SECOND, volumeFadeOut: SECOND })
    expect(second.type === 'group' && second.tracks.map((inner) => inner.clips.map((clip) => clip.id))).toEqual([['m-2', 'n-2'], ['music-2']])
    expect(reopened(parts)).toEqual(parts)
  })

  it('draws and sounds the same before and after', async () => {
    const parts = splitClips(grouped, 5 * SECOND, newIds)
    const reader: AudioReader = (_mediaId, firstSample, sampleCount) => {
      const samples = new Float32Array(sampleCount * 2)
      for (let index = 0; index < sampleCount; index++) samples[index * 2] = ((firstSample + index) % 977) / 4000
      return Promise.resolve(samples)
    }
    expect(await mix(parts, MEDIA_STATES, {}, 0, 9 * SAMPLES_PER_SECOND, reader)).toEqual(await mix(grouped, MEDIA_STATES, {}, 0, 9 * SAMPLES_PER_SECOND, reader))
    for (let time = 0; time < 9 * SECOND; time += FRAME * 7) {
      const before = resolveFrame(grouped, MEDIA_STATES, {}, time, 1).map((layer) => ({ ...layer, clipId: layer.clipId.replace('-2', ''), key: layer.key.replace('-2', ''), groups: [] }))
      const after = resolveFrame(parts, MEDIA_STATES, {}, time, 1).map((layer) => ({ ...layer, clipId: layer.clipId.replace('-2', ''), key: layer.key.replace('-2', ''), groups: [] }))
      expect(after).toEqual(before)
    }
  })

  it('does not split a group without ids for all of its members', () => {
    expect(splitClips(grouped, 5 * SECOND, new Map([['group', 'group-2']]))).toBe(grouped)
  })

  it('leaves the animation in with the first part and the animation out with the second', () => {
    const animated = textClip('title', 0, 4 * SECOND, { animationIn: { type: 'typewriter', duration: SECOND }, animationOut: { type: 'pop', duration: SECOND } })
    const parts = reopened(splitClips(projectOf([track('t1', [animated])]), 2 * SECOND, new Map([['title', 'title-2']])))
    expect(clipOf(parts, 'title')).toMatchObject({ animationIn: animated.animationIn })
    expect(clipOf(parts, 'title')).not.toHaveProperty('animationOut')
    expect(clipOf(parts, 'title-2')).toMatchObject({ animationOut: animated.animationOut })
    expect(clipOf(parts, 'title-2')).not.toHaveProperty('animationIn')
  })
})

describe('splitting animation clips', () => {
  it('starts the second part where the first one stopped in the animation', () => {
    const project = projectOf([track('t1', [animationClip('wave', 2 * SECOND, 6 * SECOND, { speedPercent: 200, loop: true })])], [{ id: 'wave', path: '/episode/wave.pbanim', relativePath: '' }])
    const parts = splitClips(project, 5 * SECOND, new Map([['wave', 'wave-2']]))
    expect(clipOf(parts, 'wave')).toMatchObject({ start: 2 * SECOND, duration: 3 * SECOND, sourceStart: 0 })
    expect(clipOf(parts, 'wave-2')).toMatchObject({ start: 5 * SECOND, duration: 3 * SECOND, sourceStart: 6 * SECOND, loop: true })
    expect(reopened(parts)).toEqual(parts)
  })
})

describe('splitting drawing clips', () => {
  it('keeps every shape in both parts', () => {
    const shapes = [{ id: 'dot', nodes: [{ x: 0, y: 0 }, { x: 4, y: 4 }] }]
    const parts = splitClips(projectOf([track('t1', [drawingClip('sketch', 0, 2 * SECOND, shapes)])]), SECOND, new Map([['sketch', 'sketch-2']]))
    expect(clipOf(parts, 'sketch')).toEqual(drawingClip('sketch', 0, SECOND, shapes))
    expect(clipOf(parts, 'sketch-2')).toEqual(drawingClip('sketch-2', SECOND, SECOND, shapes))
  })
})
