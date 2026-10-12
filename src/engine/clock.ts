// The playback clock. Audio is the master: the timeline position is "how many samples the
// output has actually played", so the picture can only ever follow the sound, never drift from it.
import { SAMPLE_RATE, TICKS_PER_SAMPLE } from '../shared/time.js'

const MILLISECONDS_PER_SECOND = 1000

/**
 * The output reports in bursts. Between reports the position is extended by elapsed time, but
 * never further than this, so the clock stops when the output stops reporting (it starved).
 */
export const MAX_EXTENSION_SAMPLES = SAMPLE_RATE / 20

export type PlaybackClock = {
  /** Records that the output has played `consumedSamples` in total since playback started, as of `now` ms. */
  report(consumedSamples: number, now: number): void
  /** Timeline position in ticks of what is being heard at `now` ms. Never moves backwards. */
  positionAt(now: number): number
}

/**
 * `startSample` is the timeline sample where playback began; `outputLatencySamples` is how long
 * a sample takes from being handed to the device until it is heard.
 */
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
