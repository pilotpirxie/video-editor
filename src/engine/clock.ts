import { SAMPLE_RATE, TICKS_PER_SAMPLE } from '../shared/time.js'

const MILLISECONDS_PER_SECOND = 1000

export const MAX_EXTENSION_SAMPLES = SAMPLE_RATE / 20

export type PlaybackClock = {
  report(consumedSamples: number, now: number): void
  positionAt(now: number): number
}

export function createPlaybackClock(startSample: number, outputLatencySamples: number): PlaybackClock {
  let consumedSamples = 0
  let reportedAt: number | undefined
  let latestPosition = startSample * TICKS_PER_SAMPLE

  function report(consumed: number, now: number): void {
    if (consumed <= consumedSamples && reportedAt !== undefined) return
    consumedSamples = consumed
    reportedAt = now
  }

  function positionAt(now: number): number {
    if (reportedAt === undefined) return latestPosition
    const elapsedSamples = ((now - reportedAt) / MILLISECONDS_PER_SECOND) * SAMPLE_RATE
    const extension = Math.min(Math.max(elapsedSamples, 0), MAX_EXTENSION_SAMPLES)
    const heardSample = startSample + consumedSamples + extension - outputLatencySamples
    const position = Math.max(startSample, heardSample) * TICKS_PER_SAMPLE
    latestPosition = Math.max(latestPosition, position)
    return latestPosition
  }

  return { report, positionAt }
}
