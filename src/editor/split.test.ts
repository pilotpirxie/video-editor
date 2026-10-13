import { describe, expect, it } from 'vitest'
import { FRAME, MEDIA_STATES, SECOND, audioClip, clipIds, clipOf, projectOf, reopened, track, videoClip } from '../../test/fixtures.js'
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
  return layers.map((layer) => ({ ...layer, clipId: '' }))
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
      expect(withoutClipIds(resolveFrame(after, MEDIA_STATES, time, 0.5)), `frame at ${time}`).toEqual(withoutClipIds(resolveFrame(before, MEDIA_STATES, time, 0.5)))
    }
  })

  it('mixes exactly the same samples as before the split', async () => {
    const sounding: MediaStates = { ...MEDIA_STATES, video: MEDIA_STATES.music ?? { error: 'fixture' } }
    const before = projectOf([
      track('t1', [videoClip('a', SECOND / 2, 3 * SECOND, { sourceStart: 7_000_000, volume: 0.7, volumeFadeIn: SECOND / 2, volumeFadeOut: SECOND })]),
      track('t2', [audioClip('music', 0, 4 * SECOND, { volume: 0.5 })]),
    ])
    const after = reopened(split(before, 2 * SECOND + 3 * FRAME))
    expect(clipIds(after)).toEqual([['a', 'a-2'], ['music', 'music-2']])

    const expected = await mix(before, sounding, 0, 4 * SAMPLES_PER_SECOND, readSource)
    const actual = await mix(after, sounding, 0, 4 * SAMPLES_PER_SECOND, readSource)
    expect(Buffer.from(actual.buffer).equals(Buffer.from(expected.buffer))).toBe(true)
  })

  it('leaves clips alone that the cut does not pass through, and locked tracks', () => {
    const project = projectOf([track('t1', [videoClip('a', 0, 2 * SECOND)]), track('t2', [videoClip('b', 0, 4 * SECOND)], { locked: true })])
    expect(splitClips(project, 3 * SECOND, new Map([['a', 'a-2']]))).toBe(project)
    expect(splitClips(project, SECOND, new Map([['b', 'b-2']]))).toBe(project)
  })
})
