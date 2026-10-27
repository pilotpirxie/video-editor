import { describe, expect, it } from 'vitest'
import { SECOND, VIDEO_INFO } from '../../test/fixtures.js'
import type { MediaInfo, WantedRange } from '../shared/mediaProtocol.js'
import { planPreparation, type PreparableMedia, type PreparationJob } from './preparation.js'

const SEGMENT_SECONDS = 30
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const AUDIO = { channels: 2, sampleRate: 48_000, codec: 'aac', seeksExactly: true }

const LONG_RECORDING: MediaInfo = {
  kind: 'video',
  duration: 2 * HOUR,
  containerStart: 0,
  video: { ...VIDEO_INFO, frameCount: 2 * 60 * 60 * 30 },
  audio: AUDIO,
}
const RECORDING: PreparableMedia = { id: 'recording', info: LONG_RECORDING }

function rangeOf(use: WantedRange['use'], timelineStart: number, duration: number, sourceStart = 0, speedPercent = 100): WantedRange {
  return { mediaId: 'recording', use, timelineStart, timelineEnd: timelineStart + duration, sourceStart, speedPercent, isLooping: false }
}

function describeJob(job: PreparationJob): string {
  if (job.kind === 'waveform') return 'waveform'
  return `${job.kind} ${job.segment}${job.isNear ? ' near' : ''}`
}

function described(jobs: readonly PreparationJob[]): string[] {
  const names: string[] = []
  for (const job of jobs) names.push(describeJob(job))
  return names
}

describe('planPreparation', () => {
  it('prepares sound needed now, then waveforms, then pictures needed now, then the rest by distance', () => {
    const plan = planPreparation({ playhead: 0, ranges: [rangeOf('picture', 0, 8 * MINUTE), rangeOf('sound', 0, 8 * MINUTE)] }, [RECORDING], SEGMENT_SECONDS)
    expect(described(plan)).toEqual([
      ...Array.from({ length: 10 }, (_, segment) => `sound ${segment} near`),
      'waveform',
      ...Array.from({ length: 10 }, (_, segment) => `picture ${segment} near`),
      'picture 10',
      'sound 10',
      'picture 11',
      'sound 11',
      'picture 12',
      'sound 12',
      'picture 13',
      'sound 13',
      'picture 14',
      'sound 14',
      'picture 15',
      'sound 15',
    ])
  })

  it('starts at the playhead and counts what is behind it as twice as far', () => {
    const plan = planPreparation({ playhead: 60 * MINUTE + 10 * SECOND, ranges: [rangeOf('sound', 0, 2 * HOUR)] }, [RECORDING], SEGMENT_SECONDS)
    const sound: string[] = []
    for (const job of plan) {
      if (job.kind === 'sound') sound.push(describeJob(job))
    }
    const segments = [120, 119, 121, 122, 118, 123, 124, 125, 126, 127, 128, 129, 130]
    expect(sound.slice(0, 14)).toEqual([...segments.map((segment) => `sound ${segment} near`), 'sound 117'])
    expect(sound).toHaveLength(240)
  })

  it('counts no more than ten minutes of a fast clip as needed now', () => {
    const tenTimes = rangeOf('picture', 0, 6 * MINUTE, 0, 1000)
    const plan = planPreparation({ playhead: 0, ranges: [tenTimes] }, [RECORDING], SEGMENT_SECONDS)
    const near = plan.filter((job) => job.isNear)
    expect(near).toHaveLength(21)
    expect(plan).toHaveLength(120)
  })

  it('counts a fast clip with a sparse copy as needed by its time on the timeline, not by its source', () => {
    const fiftyTimes = { ...rangeOf('picture', 0, 144 * SECOND, 0, 5000), cadence: { step: 50 * LONG_RECORDING.video.frameDuration, phase: 0 } }
    const plan = planPreparation({ playhead: 0, ranges: [fiftyTimes] }, [RECORDING], SEGMENT_SECONDS)
    expect(described(plan)).toEqual(['picture 0 near', 'picture 1 near', 'picture 2 near', 'picture 3 near', 'picture 4 near'])
    expect(plan[0]).toMatchObject({ kind: 'picture', cadence: fiftyTimes.cadence })
  })

  it('keeps a segment two clips use once, at its most urgent', () => {
    const later = rangeOf('sound', 30 * MINUTE, MINUTE)
    const now = rangeOf('sound', 0, MINUTE)
    const plan = planPreparation({ playhead: 0, ranges: [later, now] }, [RECORDING], SEGMENT_SECONDS)
    expect(described(plan)).toEqual(['sound 0 near', 'sound 1 near', 'waveform'])
  })

  it('counts stretched sound in its own segments, at its speed', () => {
    const doubled: WantedRange = { ...rangeOf('sound', 0, MINUTE, 0, 200), stretch: { speedPercent: 200, keepsPitch: true } }
    const plan = planPreparation({ playhead: 0, ranges: [doubled] }, [RECORDING], SEGMENT_SECONDS)
    const stretched = plan.filter((job) => job.kind === 'sound')
    expect(stretched).toHaveLength(2)
    expect(stretched.every((job) => job.kind === 'sound' && job.stretch?.speedPercent === 200)).toBe(true)
  })

  it('prepares a file no clip uses from its start, after what the timeline needs now', () => {
    const music: PreparableMedia = { id: 'music', info: { kind: 'audio', duration: 2 * MINUTE, containerStart: 0, audio: AUDIO } }
    const plan = planPreparation({ playhead: 0, ranges: [rangeOf('sound', 0, MINUTE)] }, [RECORDING, music], SEGMENT_SECONDS)
    const names: string[] = []
    for (const job of plan) names.push(`${job.mediaId} ${describeJob(job)}`)
    expect(names).toEqual(['recording sound 0 near', 'recording sound 1 near', 'recording waveform', 'music waveform', 'music sound 0', 'music sound 1', 'music sound 2', 'music sound 3'])
  })
})

describe('animation files', () => {
  it('are never prepared, even when the timeline wants them', () => {
    const animation: PreparableMedia = { id: 'recording', info: { kind: 'animation', path: '/episode/wave.pbanim' } }
    const plan = planPreparation({ playhead: 0, ranges: [rangeOf('picture', 0, MINUTE), rangeOf('sound', 0, MINUTE)] }, [animation], SEGMENT_SECONDS)
    expect(plan).toEqual([])
  })
})
