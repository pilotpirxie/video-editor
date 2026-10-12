import { describe, expect, it } from 'vitest'
import { MAX_EXTENSION_SAMPLES, createPlaybackClock } from './clock.js'

const TICKS_PER_SAMPLE = 500
const SAMPLE_RATE = 48_000
const QUANTUM = 128
const FRAME_30 = 800_000

describe('createPlaybackClock', () => {
  it('stays at the start until the output reports', () => {
    const clock = createPlaybackClock(1000, 0)
    expect(clock.positionAt(0)).toBe(1000 * TICKS_PER_SAMPLE)
    expect(clock.positionAt(500)).toBe(1000 * TICKS_PER_SAMPLE)
  })

  it('follows the samples the output has played, extended by elapsed time', () => {
    const clock = createPlaybackClock(1000, 0)
    clock.report(480, 10)
    expect(clock.positionAt(10)).toBe(1480 * TICKS_PER_SAMPLE)
    expect(clock.positionAt(15)).toBe((1480 + 240) * TICKS_PER_SAMPLE)
  })

  it('subtracts the output latency but never goes before the start', () => {
    const clock = createPlaybackClock(1000, 960)
    clock.report(480, 0)
    expect(clock.positionAt(0)).toBe(1000 * TICKS_PER_SAMPLE)
    clock.report(4800, 100)
    expect(clock.positionAt(100)).toBe((1000 + 4800 - 960) * TICKS_PER_SAMPLE)
  })

  it('never moves backwards when a report arrives late', () => {
    const clock = createPlaybackClock(0, 0)
    clock.report(480, 0)
    const ahead = clock.positionAt(9)
    clock.report(600, 9.5)
    expect(clock.positionAt(9.5)).toBeGreaterThanOrEqual(ahead)
  })

  it('stops when the output stops reporting', () => {
    const clock = createPlaybackClock(0, 0)
    clock.report(48_000, 1000)
    const stalled = (48_000 + MAX_EXTENSION_SAMPLES) * TICKS_PER_SAMPLE
    expect(clock.positionAt(1000 + 5000)).toBe(stalled)
    expect(clock.positionAt(1000 + 60_000)).toBe(stalled)
  })

  it('stays within one frame of the audio over 60 minutes of jittery reports', () => {
    const clock = createPlaybackClock(0, 0)
    const minutes = 60
    const quanta = (minutes * 60 * SAMPLE_RATE) / QUANTUM
    let worstError = 0
    let jitterSeed = 1
    for (let quantum = 1; quantum <= quanta; quantum++) {
      const consumed = quantum * QUANTUM
      const exactTime = (consumed / SAMPLE_RATE) * 1000
      // Reports arrive every fourth quantum, up to 4 ms late.
      if (quantum % 4 === 0) {
        jitterSeed = (jitterSeed * 1_103_515_245 + 12_345) % 2_147_483_648
        const lateness = (jitterSeed / 2_147_483_648) * 4
        clock.report(consumed, exactTime + lateness)
        // The picture is drawn somewhere before the next report.
        const drawTime = exactTime + lateness + 3
        const audioPosition = ((drawTime / 1000) * SAMPLE_RATE) * TICKS_PER_SAMPLE
        worstError = Math.max(worstError, Math.abs(clock.positionAt(drawTime) - audioPosition))
      }
    }
    expect(worstError).toBeLessThan(FRAME_30)
    // The last position is the true end of the hour, within the report jitter.
    const end = clock.positionAt((quanta * QUANTUM * 1000) / SAMPLE_RATE)
    expect(Math.abs(end - minutes * 60 * 24_000_000)).toBeLessThan(FRAME_30)
  })
})
