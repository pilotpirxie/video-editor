// The one mixer behind playback and export. `mix` is a pure function of the project and a
// sample range: the same range always gives the same samples, however the timeline is cut
// into blocks, so what is heard is what is exported.
import type { AudioClip, Clip, Project, VideoClip } from '../shared/project.js'
import { SAMPLE_RATE, TICKS_PER_SAMPLE } from '../shared/time.js'
import { createByteLru } from './byteLru.js'
import { fadeFactor, type MediaStates } from './resolve.js'

/** The loudest sample the mix may contain, just under full scale. */
export const LIMITER_CEILING = 0.98
/** The limiter looks this many samples (5 ms) to each side of a peak. */
export const LIMITER_WINDOW = 240

const CHANNELS = 2
/** Gains inside the limiter are whole numbers out of this, so their running sums are exact. */
const UNITY_GAIN = 1 << 20
/** Samples beyond each end of a block that can still affect it. */
const LIMITER_REACH = 2 * LIMITER_WINDOW
const AUDIO_CHUNK_SAMPLES = SAMPLE_RATE
const BYTES_PER_STEREO_SAMPLE = CHANNELS * Float32Array.BYTES_PER_ELEMENT

/** Interleaved 48 kHz stereo samples of one media file; undefined when it has no sound. */
export type AudioReader = (mediaId: string, firstSample: number, sampleCount: number) => Promise<Float32Array | undefined>

type SoundClip = VideoClip | AudioClip

type Contribution = {
  /** Index of the first stereo sample this contribution covers, within the mixed range. */
  offset: number
  samples: Float64Array
}

function hasSound(clip: Clip, media: MediaStates): clip is SoundClip {
  if (clip.type !== 'video' && clip.type !== 'audio') return false
  // Sped-up and slowed-down sound arrives with pitch-preserving speed (T-58); until then it is silent.
  if (clip.speedPercent !== 100) return false
  const state = media[clip.mediaId]
  if (state === undefined || 'error' in state || state.info.kind === 'image') return false
  return state.info.audio !== undefined
}

/** What one clip adds to the samples [rangeFirst, rangeFirst + rangeCount). */
async function contributionOf(clip: SoundClip, rangeFirst: number, rangeCount: number, readAudio: AudioReader): Promise<Contribution | undefined> {
  // Output sample N plays at N·500 ticks; the clip sounds for the samples inside [start, end).
  const clipFirst = Math.ceil(clip.start / TICKS_PER_SAMPLE)
  const clipEnd = Math.ceil((clip.start + clip.duration) / TICKS_PER_SAMPLE)
  const first = Math.max(rangeFirst, clipFirst)
  const end = Math.min(rangeFirst + rangeCount, clipEnd)
  if (first >= end) return undefined

  // Whole-tick arithmetic from the clip's own anchor: both halves of a split land on the same source sample.
  const sourceFirst = Math.floor((clip.sourceStart + first * TICKS_PER_SAMPLE - clip.start) / TICKS_PER_SAMPLE)
  const source = await readAudio(clip.mediaId, sourceFirst, end - first)
  if (source === undefined) return undefined

  const samples = new Float64Array((end - first) * CHANNELS)
  for (let sample = first; sample < end; sample++) {
    const localTime = sample * TICKS_PER_SAMPLE - clip.start
    const gain = clip.volume * fadeFactor(localTime, clip.duration, clip.volumeFadeIn, clip.volumeFadeOut)
    const index = (sample - first) * CHANNELS
    samples[index] = (source[index] ?? 0) * gain
    samples[index + 1] = (source[index + 1] ?? 0) * gain
  }
  return { offset: first - rangeFirst, samples }
}

/** For every position, the smallest value within `reach` positions to either side. */
function slidingMinimum(values: Int32Array, reach: number): Int32Array {
  const minima = new Int32Array(values.length)
  // Indices whose values rise from front to back; the front is the minimum of the current window.
  const candidates = new Int32Array(values.length)
  let front = 0
  let back = 0
  let nextToEnter = 0
  for (let center = 0; center < values.length; center++) {
    const windowEnd = Math.min(values.length - 1, center + reach)
    while (nextToEnter <= windowEnd) {
      const entering = values[nextToEnter] ?? 0
      while (back > front && (values[candidates[back - 1] ?? 0] ?? 0) >= entering) back -= 1
      candidates[back] = nextToEnter
      back += 1
      nextToEnter += 1
    }
    while ((candidates[front] ?? 0) < center - reach) front += 1
    minima[center] = values[candidates[front] ?? 0] ?? 0
  }
  return minima
}

/**
 * Brick-wall limiter over a mix that carries LIMITER_REACH extra samples at each end.
 * The gain at a sample depends only on samples within LIMITER_REACH of it and is built from
 * whole numbers, so it does not depend on where the block starts.
 */
function limit(mixed: Float64Array, sampleCount: number): Float32Array {
  const totalSamples = mixed.length / CHANNELS
  const neededGain = new Int32Array(totalSamples)
  let isLimiting = false
  for (let sample = 0; sample < totalSamples; sample++) {
    const peak = Math.max(Math.abs(mixed[sample * CHANNELS] ?? 0), Math.abs(mixed[sample * CHANNELS + 1] ?? 0))
    if (peak > LIMITER_CEILING) {
      neededGain[sample] = Math.floor((LIMITER_CEILING / peak) * UNITY_GAIN)
      isLimiting = true
    } else {
      neededGain[sample] = UNITY_GAIN
    }
  }

  const output = new Float32Array(sampleCount * CHANNELS)
  if (!isLimiting) {
    for (let index = 0; index < output.length; index++) output[index] = mixed[index + LIMITER_REACH * CHANNELS] ?? 0
    return output
  }

  // Hold each reduction across the window, then average the held gain: the average is never
  // above what any sample in the window needs, and it moves smoothly.
  const heldGain = slidingMinimum(neededGain, LIMITER_WINDOW)
  const windowLength = 2 * LIMITER_WINDOW + 1
  let windowSum = 0
  for (let sample = LIMITER_REACH - LIMITER_WINDOW; sample <= LIMITER_REACH + LIMITER_WINDOW; sample++) windowSum += heldGain[sample] ?? 0

  for (let sample = 0; sample < sampleCount; sample++) {
    const center = sample + LIMITER_REACH
    const gain = windowSum / (windowLength * UNITY_GAIN)
    output[sample * CHANNELS] = (mixed[center * CHANNELS] ?? 0) * gain
    output[sample * CHANNELS + 1] = (mixed[center * CHANNELS + 1] ?? 0) * gain
    windowSum += (heldGain[center + LIMITER_WINDOW + 1] ?? 0) - (heldGain[center - LIMITER_WINDOW] ?? 0)
  }
  return output
}

/**
 * Mixes every audible clip over the samples [firstSample, firstSample + sampleCount).
 * Returns interleaved stereo, limited to LIMITER_CEILING.
 */
export async function mix(project: Project, media: MediaStates, firstSample: number, sampleCount: number, readAudio: AudioReader): Promise<Float32Array> {
  const rangeFirst = firstSample - LIMITER_REACH
  const rangeCount = sampleCount + 2 * LIMITER_REACH
  const mixed = new Float64Array(rangeCount * CHANNELS)

  // Always summed in track order, then clip order: floating-point sums depend on their order.
  for (const track of project.tracks) {
    if (track.muted) continue
    for (const clip of track.clips) {
      if (!hasSound(clip, media)) continue
      const contribution = await contributionOf(clip, rangeFirst, rangeCount, readAudio)
      if (contribution === undefined) continue
      const start = contribution.offset * CHANNELS
      for (let index = 0; index < contribution.samples.length; index++) {
        mixed[start + index] = (mixed[start + index] ?? 0) + (contribution.samples[index] ?? 0)
      }
    }
  }
  return limit(mixed, sampleCount)
}

/**
 * Wraps a reader so that repeated and overlapping requests are served from memory.
 * Audio is fetched in one-second chunks and at most `maxBytes` of them are kept.
 */
export function cachedAudioReader(read: AudioReader, maxBytes: number): AudioReader {
  const chunks = createByteLru<Promise<Float32Array | undefined>>(maxBytes, () => {})

  function chunk(mediaId: string, chunkIndex: number): Promise<Float32Array | undefined> {
    const key = `${mediaId}:${chunkIndex}`
    const cached = chunks.get(key)
    if (cached !== undefined) return cached
    const fetched = read(mediaId, chunkIndex * AUDIO_CHUNK_SAMPLES, AUDIO_CHUNK_SAMPLES)
    chunks.set(key, fetched, AUDIO_CHUNK_SAMPLES * BYTES_PER_STEREO_SAMPLE)
    return fetched
  }

  return async function readCached(mediaId: string, firstSample: number, sampleCount: number): Promise<Float32Array | undefined> {
    const samples = new Float32Array(sampleCount * CHANNELS)
    const end = firstSample + sampleCount
    for (let chunkIndex = Math.floor(firstSample / AUDIO_CHUNK_SAMPLES); chunkIndex * AUDIO_CHUNK_SAMPLES < end; chunkIndex++) {
      const data = await chunk(mediaId, chunkIndex)
      if (data === undefined) return undefined
      const chunkFirst = chunkIndex * AUDIO_CHUNK_SAMPLES
      const from = Math.max(firstSample, chunkFirst)
      const to = Math.min(end, chunkFirst + AUDIO_CHUNK_SAMPLES)
      samples.set(data.subarray((from - chunkFirst) * CHANNELS, (to - chunkFirst) * CHANNELS), (from - firstSample) * CHANNELS)
    }
    return samples
  }
}
