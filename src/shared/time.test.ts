import { describe, expect, it } from 'vitest'
import { PROJECT_FRAME_RATES, SAMPLE_RATE, TICKS_PER_SAMPLE, TICKS_PER_SECOND, TIMELINE_GRID, exactFrameDuration, frameAt, frameDuration, frameIndexAt, isOnTimelineGrid, loopedTime, sampleAt, sourceTime, timecode } from './time.js'

const TWENTY_HOURS_SECONDS = 20 * 60 * 60

describe('frame durations', () => {
  it('are whole ticks on the timeline grid for every project frame rate', () => {
    const durations = PROJECT_FRAME_RATES.map(frameDuration)
    expect(durations).toEqual([1_001_000, 1_000_000, 960_000, 800_800, 800_000, 480_000, 400_000, 200_000, 150_000])
    for (const duration of durations) expect(isOnTimelineGrid(duration)).toBe(true)
  })

  it('are whole ticks for common source rates', () => {
    for (const rate of [{ num: 60000, den: 1001 }, { num: 120, den: 1 }, { num: 240, den: 1 }, { num: 15, den: 1 }, { num: 100, den: 1 }]) {
      expect(exactFrameDuration(rate)).toBeTypeOf('number')
    }
  })

  it('reports rates that do not fit whole ticks', () => {
    expect(exactFrameDuration({ num: 59, den: 2 })).toBeUndefined()
    expect(exactFrameDuration({ num: 0, den: 1 })).toBeUndefined()
    expect(() => frameDuration({ num: 59, den: 2 })).toThrow(/59\/2/)
  })

  it('one sample is a whole number of ticks', () => {
    expect(TICKS_PER_SAMPLE).toBe(500)
    expect(TICKS_PER_SAMPLE * SAMPLE_RATE).toBe(TICKS_PER_SECOND)
  })
})

describe('no drift over 20 hours', () => {
  it.each(PROJECT_FRAME_RATES)('frame boundaries are exact at $num/$den', (rate) => {
    const duration = frameDuration(rate)
    const lastFrame = Math.floor((TWENTY_HOURS_SECONDS * rate.num) / rate.den)
    for (let frame = 0; frame <= lastFrame; frame += 997) {
      const start = frame * duration
      expect(frameAt(start, duration)).toBe(frame)
      expect(frameAt(start - 1, duration)).toBe(frame - 1)
      expect(frameAt(start + duration - 1, duration)).toBe(frame)
    }
    expect(lastFrame * duration * rate.num).toBe(lastFrame * rate.den * TICKS_PER_SECOND)
  })

  it('sample boundaries are exact', () => {
    const lastSample = TWENTY_HOURS_SECONDS * SAMPLE_RATE
    for (let sample = 0; sample <= lastSample; sample += 1_000_003) {
      const start = sample * TICKS_PER_SAMPLE
      expect(sampleAt(start)).toBe(sample)
      expect(sampleAt(start - 1)).toBe(sample - 1)
    }
    expect(sampleAt(TWENTY_HOURS_SECONDS * TICKS_PER_SECOND)).toBe(lastSample)
  })

  it('stays inside safe integers at the extremes', () => {
    const twentyHours = TWENTY_HOURS_SECONDS * TICKS_PER_SECOND
    const mapped = sourceTime({ start: 0, sourceStart: 0, speedPercent: 10_000 }, twentyHours)
    expect(Number.isSafeInteger(mapped)).toBe(true)
    expect(mapped).toBe(twentyHours * 100)
  })
})

describe('sourceTime', () => {
  it('is a whole tick for every grid time and integer-percent speed', () => {
    for (const speedPercent of [25, 33, 100, 137, 250, 5000, 10_000]) {
      const clip = { start: 800_800 * 7, sourceStart: 12_345, speedPercent }
      for (let step = 0; step < 500; step++) {
        const time = clip.start + step * 800_800
        expect(Number.isInteger(sourceTime(clip, time))).toBe(true)
      }
    }
  })

  it('is unchanged by a split at any grid time (US-22)', () => {
    for (const speedPercent of [25, 77, 100, 150, 333, 10_000]) {
      const whole = { start: 4_800_000, sourceStart: 999, speedPercent }
      for (const cutOffset of [TIMELINE_GRID, 800_800, 1_001_000 * 3, 480_000 * 11 + TIMELINE_GRID]) {
        const cut = whole.start + cutOffset
        const second = { start: cut, sourceStart: sourceTime(whole, cut), speedPercent }
        expect(Number.isInteger(second.sourceStart)).toBe(true)
        for (let step = 0; step < 200; step++) {
          const time = cut + step * 400_000
          expect(sourceTime(second, time)).toBe(sourceTime(whole, time))
        }
      }
    }
  })
})

describe('frameIndexAt', () => {
  const video = { startOffset: 0, frameDuration: 800_800, frameCount: 100 }

  it('picks the frame at or before the time', () => {
    expect(frameIndexAt(video, 0)).toBe(0)
    expect(frameIndexAt(video, 800_799)).toBe(0)
    expect(frameIndexAt(video, 800_800)).toBe(1)
    expect(frameIndexAt(video, 800_800 * 42 + 5)).toBe(42)
  })

  it('clamps to the first and last frame', () => {
    expect(frameIndexAt(video, -5)).toBe(0)
    expect(frameIndexAt(video, 800_800 * 500)).toBe(99)
  })

  it('accounts for a video stream that starts after the container', () => {
    const delayed = { ...video, startOffset: 2_002_000 }
    expect(frameIndexAt(delayed, 0)).toBe(0)
    expect(frameIndexAt(delayed, 2_002_000)).toBe(0)
    expect(frameIndexAt(delayed, 2_002_000 + 800_800)).toBe(1)
  })
})

describe('loopedTime', () => {
  it('starts over each time the source ends', () => {
    expect(loopedTime(0, 1000, true)).toBe(0)
    expect(loopedTime(999, 1000, true)).toBe(999)
    expect(loopedTime(1000, 1000, true)).toBe(0)
    expect(loopedTime(2750, 1000, true)).toBe(750)
  })

  it('leaves the time alone without a loop or without a source length', () => {
    expect(loopedTime(2750, 1000, false)).toBe(2750)
    expect(loopedTime(2750, 0, true)).toBe(2750)
  })
})

describe('timecode', () => {
  it('counts whole frames', () => {
    const thirty = { num: 30, den: 1 }
    expect(timecode(0, thirty)).toBe('00:00:00:00')
    expect(timecode(800_000 * 29, thirty)).toBe('00:00:00:29')
    expect(timecode(800_000 * 30, thirty)).toBe('00:00:01:00')
    expect(timecode(3_725 * TICKS_PER_SECOND + 800_000 * 12, thirty)).toBe('01:02:05:12')
  })

  it('uses the nominal rate for fractional frame rates', () => {
    const ntsc = { num: 30000, den: 1001 }
    expect(timecode(800_800 * 30, ntsc)).toBe('00:00:01:00')
    expect(timecode(1_001_000 * 23, { num: 24000, den: 1001 })).toBe('00:00:00:23')
  })
})
