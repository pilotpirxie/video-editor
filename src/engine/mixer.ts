import type { AudioStretch, WantedRange } from '../shared/mediaProtocol.js'
import { valueAt, type AudioClip, type Clip, type GroupClip, type Project, type Track, type VideoClip } from '../shared/project.js'
import { FAST_SOUND_ABOVE_PERCENT, NORMAL_SPEED_PERCENT, SAMPLE_RATE, TICKS_PER_SAMPLE, sourceTime } from '../shared/time.js'
import { createByteLru } from './byteLru.js'
import { fadeFactor, forEachPlacedClip, type MediaStates, type PlacedClip } from './resolve.js'

export const LIMITER_CEILING = 0.98
export const LIMITER_WINDOW = 240

const CHANNELS = 2
const UNITY_GAIN = 1 << 20
const LIMITER_REACH = 2 * LIMITER_WINDOW
const AUDIO_CHUNK_SAMPLES = SAMPLE_RATE
const BYTES_PER_STEREO_SAMPLE = CHANNELS * Float32Array.BYTES_PER_ELEMENT
// Sounds read at the same time: after a seek their reads wait on the media process together instead of one after another,
// and a project with hundreds of sounds at one moment still holds only this many windows of samples.
const READS_IN_FLIGHT = 8

// With a `stretch`, the samples are counted in the sound as it is at that speed.
export type AudioReader = (mediaId: string, firstSample: number, sampleCount: number, stretch?: AudioStretch) => Promise<Float32Array | undefined>

type SoundClip = VideoClip | AudioClip

// A clip that is heard in the range being mixed.
type Sounding = PlacedClip & { clip: SoundClip }

type Contribution = {
  offset: number
  samples: Float64Array
}

function hasSound(clip: Clip, media: MediaStates): clip is SoundClip {
  if (clip.type !== 'video' && clip.type !== 'audio') return false
  if (clip.type === 'video' && clip.isAudioSeparated === true) return false
  if (clip.speedPercent > FAST_SOUND_ABOVE_PERCENT && clip.hasFastSound !== true) return false
  const state = media[clip.mediaId]
  if (state === undefined || 'error' in state || state.info.kind === 'image') return false
  return state.info.audio !== undefined
}

// The sound of members of groups is mixed like any other, inside the time the group is there.
function collectSounds(tracks: readonly Track[], media: MediaStates, window: { from: number; to: number }, found: Sounding[]): void {
  forEachPlacedClip(tracks, window, (track) => track.muted, (placed) => {
    const { clip } = placed
    if (hasSound(clip, media)) found.push({ ...placed, clip })
  })
}

function stretchOf(clip: SoundClip): AudioStretch | undefined {
  if (clip.speedPercent === NORMAL_SPEED_PERCENT) return undefined
  return { speedPercent: clip.speedPercent, keepsPitch: clip.changesPitch !== true }
}

// The parts of files the mix plays, and where in project time, so the media process prepares what is nearest the playhead first.
export function soundRanges(project: Project, media: MediaStates): WantedRange[] {
  const found: Sounding[] = []
  collectSounds(project.tracks, media, { from: 0, to: Infinity }, found)
  const ranges: WantedRange[] = []
  for (const sounding of found) {
    const { clip, shift, from, to } = sounding
    const range: WantedRange = { mediaId: clip.mediaId, use: 'sound', timelineStart: from, timelineEnd: to, sourceStart: sourceTime(clip, from - shift), speedPercent: clip.speedPercent, isLooping: false }
    const stretch = stretchOf(clip)
    if (stretch !== undefined) range.stretch = stretch
    ranges.push(range)
  }
  return ranges
}

// How loud a clip or a group is at a moment of its own time: its volume, which keyframes may move, shaped by its fades.
function gainAt(sound: SoundClip | GroupClip, localTime: number): number {
  const keyframes = sound.keyframes?.volume
  const volume = keyframes === undefined ? sound.volume : (valueAt(keyframes, localTime) ?? sound.volume)
  return volume * fadeFactor(localTime, sound.duration, sound.volumeFadeIn, sound.volumeFadeOut)
}

async function contributionOf(sounding: Sounding, rangeFirst: number, readAudio: AudioReader): Promise<Contribution | undefined> {
  const { clip, shift, groups } = sounding
  const first = Math.ceil(sounding.from / TICKS_PER_SAMPLE)
  const end = Math.ceil(sounding.to / TICKS_PER_SAMPLE)
  if (first >= end) return undefined

  // At another speed the samples come from the sound as it is at that speed. Counted from the start of the file, the place in it
  // does not depend on where the clip begins, so both halves of a split read the same samples.
  const speed = clip.speedPercent
  const stretch = stretchOf(clip)
  const localTime = first * TICKS_PER_SAMPLE - shift - clip.start
  const sourceFirst = Math.floor((clip.sourceStart * NORMAL_SPEED_PERCENT + localTime * speed) / (speed * TICKS_PER_SAMPLE))
  const source = await readAudio(clip.mediaId, sourceFirst, end - first, stretch)
  if (source === undefined) return undefined

  const samples = new Float64Array((end - first) * CHANNELS)
  for (let sample = first; sample < end; sample++) {
    const time = sample * TICKS_PER_SAMPLE
    let gain = gainAt(clip, time - shift - clip.start)
    for (const enclosing of groups) gain *= gainAt(enclosing.group, time - enclosing.shift - enclosing.group.start)
    const index = (sample - first) * CHANNELS
    samples[index] = (source[index] ?? 0) * gain
    samples[index + 1] = (source[index + 1] ?? 0) * gain
  }
  return { offset: first - rangeFirst, samples }
}

function slidingMinimum(values: Int32Array, reach: number): Int32Array {
  const minima = new Int32Array(values.length)
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

export async function mix(project: Project, media: MediaStates, firstSample: number, sampleCount: number, readAudio: AudioReader): Promise<Float32Array> {
  const rangeFirst = firstSample - LIMITER_REACH
  const rangeCount = sampleCount + 2 * LIMITER_REACH
  const mixed = new Float64Array(rangeCount * CHANNELS)

  const sounds: Sounding[] = []
  const range = { from: rangeFirst * TICKS_PER_SAMPLE, to: (rangeFirst + rangeCount) * TICKS_PER_SAMPLE }
  collectSounds(project.tracks, media, range, sounds)
  for (let batchStart = 0; batchStart < sounds.length; batchStart += READS_IN_FLIGHT) {
    const batch = sounds.slice(batchStart, batchStart + READS_IN_FLIGHT)
    const contributions = await Promise.all(batch.map((sounding) => contributionOf(sounding, rangeFirst, readAudio)))
    // Added in the order of the sounds, so the sum is the same to the last bit however the reads finished.
    for (const contribution of contributions) {
      if (contribution === undefined) continue
      const start = contribution.offset * CHANNELS
      for (let index = 0; index < contribution.samples.length; index++) {
        mixed[start + index] = (mixed[start + index] ?? 0) + (contribution.samples[index] ?? 0)
      }
    }
  }
  return limit(mixed, sampleCount)
}

export function cachedAudioReader(read: AudioReader, maxBytes: number): AudioReader {
  const chunks = createByteLru<Promise<Float32Array | undefined>>(maxBytes, () => {})

  function chunk(mediaId: string, chunkIndex: number, stretch: AudioStretch | undefined): Promise<Float32Array | undefined> {
    const speed = stretch === undefined ? '' : `${stretch.speedPercent}:${stretch.keepsPitch}`
    const key = `${mediaId}:${speed}:${chunkIndex}`
    const cached = chunks.get(key)
    if (cached !== undefined) return cached
    const fetched = read(mediaId, chunkIndex * AUDIO_CHUNK_SAMPLES, AUDIO_CHUNK_SAMPLES, stretch)
    chunks.set(key, fetched, AUDIO_CHUNK_SAMPLES * BYTES_PER_STEREO_SAMPLE)
    // A read that failed, for example while the media process was restarted, is asked for again next time. The caller still gets the failure.
    fetched.catch(() => {
      if (chunks.get(key) === fetched) chunks.delete(key)
    })
    return fetched
  }

  return async function readCached(mediaId: string, firstSample: number, sampleCount: number, stretch?: AudioStretch): Promise<Float32Array | undefined> {
    const samples = new Float32Array(sampleCount * CHANNELS)
    const end = firstSample + sampleCount
    for (let chunkIndex = Math.floor(firstSample / AUDIO_CHUNK_SAMPLES); chunkIndex * AUDIO_CHUNK_SAMPLES < end; chunkIndex++) {
      const chunkSamples = await chunk(mediaId, chunkIndex, stretch)
      if (chunkSamples === undefined) return undefined
      const chunkFirst = chunkIndex * AUDIO_CHUNK_SAMPLES
      const from = Math.max(firstSample, chunkFirst)
      const to = Math.min(end, chunkFirst + AUDIO_CHUNK_SAMPLES)
      samples.set(chunkSamples.subarray((from - chunkFirst) * CHANNELS, (to - chunkFirst) * CHANNELS), (from - firstSample) * CHANNELS)
    }
    return samples
  }
}
