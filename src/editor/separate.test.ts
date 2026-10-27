import { describe, expect, it } from 'vitest'
import { MEDIA_STATES, SECOND, ALL_MEDIA, audioClip, clipIds, clipOf, projectOf, reopened, track, videoClip } from '../../test/fixtures.js'
import type { Project, Track } from '../shared/project.js'
import { mix, type AudioReader } from '../engine/mixer.js'
import { clipsToSeparate, separateAudio } from './separate.js'

function talkProject(tracks: Track[]): Project {
  return projectOf(tracks, ALL_MEDIA)
}

const NEW_TRACKS = [
  { id: 'new-1', name: 'Track 3' },
  { id: 'new-2', name: 'Track 4' },
]

const talking = videoClip('talk', SECOND, 4 * SECOND, {
  mediaId: 'talk',
  sourceStart: SECOND / 2,
  volume: 0.5,
  fadeIn: SECOND,
  volumeFadeIn: SECOND,
  volumeFadeOut: SECOND / 2,
  keyframes: {
    x: [{ time: 0, value: 100, easing: 'linear' }],
    volume: [{ time: 0, value: 0.2, easing: 'linear' }],
  },
})

const readTone: AudioReader = async (_mediaId, firstSample, sampleCount) => {
  const samples = new Float32Array(sampleCount * 2)
  for (let index = 0; index < sampleCount; index++) {
    const value = Math.fround(Math.sin((firstSample + index) * 0.02) * 0.4)
    samples[index * 2] = value
    samples[index * 2 + 1] = value
  }
  return samples
}

describe('clipsToSeparate', () => {
  const project = talkProject([track('t1', [talking, videoClip('mute', 6 * SECOND, SECOND)]), track('t2', [audioClip('music', 0, SECOND)]), track('t3', [videoClip('locked', 0, SECOND, { mediaId: 'talk' })], { locked: true })])

  it('keeps the selected video clips that carry sound', () => {
    expect(clipsToSeparate(project, ['talk', 'mute', 'music', 'locked'], MEDIA_STATES)).toEqual(['talk'])
  })

  it('finds nothing in a clip that was separated before', () => {
    const separated = separateAudio(project, MEDIA_STATES, new Map([['talk', 'talk-sound']]), NEW_TRACKS)
    expect(clipsToSeparate(separated, ['talk'], MEDIA_STATES)).toEqual([])
  })
})

describe('separateAudio', () => {
  const project = talkProject([track('t1', [talking]), track('t2', [audioClip('music', 0, SECOND)])])
  const separated = separateAudio(project, MEDIA_STATES, new Map([['talk', 'talk-sound']]), NEW_TRACKS)

  it('puts the sound on a new track directly above the video clip', () => {
    expect(clipIds(separated)).toEqual([['talk'], ['talk-sound'], ['music']])
    expect(separated.tracks[1]).toMatchObject({ id: 'new-1', name: 'Track 3' })
  })

  it('moves volume, volume fades and volume keyframes to the audio clip', () => {
    expect(clipOf(separated, 'talk-sound')).toEqual({
      id: 'talk-sound',
      type: 'audio',
      mediaId: 'talk',
      start: SECOND,
      duration: 4 * SECOND,
      sourceStart: SECOND / 2,
      speedPercent: 100,
      volume: 0.5,
      volumeFadeIn: SECOND,
      volumeFadeOut: SECOND / 2,
      keyframes: { volume: [{ time: 0, value: 0.2, easing: 'linear' }] },
    })
    const picture = clipOf(separated, 'talk')
    expect(picture).toMatchObject({ isAudioSeparated: true, fadeIn: SECOND, keyframes: { x: [{ time: 0, value: 100, easing: 'linear' }] } })
    expect(picture).not.toHaveProperty('volumeFadeIn')
    expect(picture).not.toHaveProperty('keyframes.volume')
  })

  it('sounds exactly as before', async () => {
    const before = await mix(project, MEDIA_STATES, {}, 0, 6 * 48_000, readTone)
    const after = await mix(separated, MEDIA_STATES, {}, 0, 6 * 48_000, readTone)
    expect(Array.from(after)).toEqual(Array.from(before))
  })

  it('gives a project the file format accepts', () => {
    expect(reopened(separated)).toEqual(separated)
  })

  it('gives the clips of one track a shared track, and each track its own', () => {
    const two = talkProject([track('t1', [talking, videoClip('later', 6 * SECOND, SECOND, { mediaId: 'talk' })]), track('t2', [videoClip('above', 0, SECOND, { mediaId: 'talk' })])])
    const ids = new Map([
      ['talk', 's1'],
      ['later', 's2'],
      ['above', 's3'],
    ])
    expect(clipIds(separateAudio(two, MEDIA_STATES, ids, NEW_TRACKS))).toEqual([['talk', 'later'], ['s1', 's2'], ['above'], ['s3']])
  })

  it('leaves locked tracks and clips without sound alone', () => {
    const locked = talkProject([track('t1', [talking], { locked: true }), track('t2', [videoClip('mute', 0, SECOND)])])
    const ids = new Map([
      ['talk', 's1'],
      ['mute', 's2'],
    ])
    expect(separateAudio(locked, MEDIA_STATES, ids, NEW_TRACKS)).toBe(locked)
  })
})
