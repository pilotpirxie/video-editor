import { existsSync } from 'node:fs'
import { open, rename, rm, writeFile, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { SAMPLE_RATE, TICKS_PER_SAMPLE } from '../shared/time.js'
import type { FfmpegRunner } from './ffmpeg.js'

/** One waveform bucket covers this many samples: 100 buckets per second. */
export const WAVEFORM_BUCKET_SAMPLES = 480
export const AUDIO_FILE = 'audio.f32'
export const WAVEFORM_FILE = 'waveform.i8'

const CHANNELS = 2
const BYTES_PER_SAMPLE = 4
const BYTES_PER_FRAME = CHANNELS * BYTES_PER_SAMPLE
const READ_TIMEOUT_MS = 30_000
const INT8_PEAK = 127
const INITIAL_BUCKET_CAPACITY = 4096

/** A source FFmpeg can open, with the container's own first timestamp in ticks. */
export type AudioSource = {
  path: string
  containerStart: number
}

/** Folds a stream of interleaved stereo samples into (lowest, highest) pairs, one pair per bucket. */
export type PeakFolder = {
  add(samples: Float32Array): void
  /** The pairs as signed bytes: bucket n is at [2n] (lowest) and [2n + 1] (highest). */
  finish(): Int8Array
}

function toInt8(sample: number): number {
  const clamped = Math.max(-1, Math.min(1, sample))
  return Math.round(clamped * INT8_PEAK)
}

export function createPeakFolder(): PeakFolder {
  let peaks = new Int8Array(INITIAL_BUCKET_CAPACITY * 2)
  let bucketCount = 0
  let lowest = Infinity
  let highest = -Infinity
  let framesInBucket = 0

  function closeBucket(): void {
    if (bucketCount * 2 === peaks.length) {
      const larger = new Int8Array(peaks.length * 2)
      larger.set(peaks)
      peaks = larger
    }
    peaks[bucketCount * 2] = toInt8(lowest)
    peaks[bucketCount * 2 + 1] = toInt8(highest)
    bucketCount += 1
    lowest = Infinity
    highest = -Infinity
    framesInBucket = 0
  }

  function add(samples: Float32Array): void {
    // `samples` always holds whole stereo frames; a bucket spans both channels of its frames.
    for (let index = 0; index < samples.length; index += CHANNELS) {
      for (let channel = 0; channel < CHANNELS; channel++) {
        const sample = samples[index + channel] ?? 0
        if (sample < lowest) lowest = sample
        if (sample > highest) highest = sample
      }
      framesInBucket += 1
      if (framesInBucket === WAVEFORM_BUCKET_SAMPLES) closeBucket()
    }
  }

  function finish(): Int8Array {
    if (framesInBucket > 0) closeBucket()
    return peaks.slice(0, bucketCount * 2)
  }

  return { add, finish }
}

/** Views whole stereo frames at the start of `bytes` as samples, copying only when misaligned. */
function wholeFrames(bytes: Buffer): Float32Array {
  const frameBytes = bytes.length - (bytes.length % BYTES_PER_FRAME)
  const isAligned = bytes.byteOffset % BYTES_PER_SAMPLE === 0
  const aligned = isAligned ? bytes : Buffer.from(bytes)
  return new Float32Array(aligned.buffer, aligned.byteOffset, frameBytes / BYTES_PER_SAMPLE)
}

export function isAudioPrepared(directory: string): boolean {
  return existsSync(join(directory, AUDIO_FILE)) && existsSync(join(directory, WAVEFORM_FILE))
}

/**
 * Decodes the whole first audio stream once into `directory` as 48 kHz stereo float samples,
 * plus its waveform peaks. Sample 0 is the container start: audio that begins later is padded
 * with silence, so every window read back is aligned with the picture.
 */
export async function prepareAudio(ffmpeg: FfmpegRunner, source: AudioSource, directory: string, signal: AbortSignal): Promise<void> {
  if (isAudioPrepared(directory)) return

  const firstSample = Math.round(source.containerStart / TICKS_PER_SAMPLE)
  // -copyts keeps the file's timestamps, so first_pts pins sample 0 to the container start
  // whichever streams are mapped; async=1 fills gaps in the stream with silence.
  const filter = `aresample=${SAMPLE_RATE}:async=1:first_pts=${firstSample},aformat=sample_fmts=flt:channel_layouts=stereo`
  const job = ffmpeg.spawnJob('ffmpeg', ['-copyts', '-i', source.path, '-map', '0:a:0', '-af', filter, '-f', 'f32le', '-'], { signal })

  const temporaryPath = join(directory, `${AUDIO_FILE}.tmp`)
  const output = await open(temporaryPath, 'w')
  const peaks = createPeakFolder()
  // Chunks can end inside a stereo frame; the loose bytes wait for the next chunk.
  let loose: Buffer = Buffer.alloc(0)
  try {
    for (;;) {
      const chunk = await job.readChunk(READ_TIMEOUT_MS)
      if (chunk === undefined) break
      await output.write(chunk)
      const joined = loose.length === 0 ? chunk : Buffer.concat([loose, chunk])
      const frames = wholeFrames(joined)
      peaks.add(frames)
      loose = joined.subarray(frames.byteLength)
    }
  } catch (error) {
    await output.close()
    await rm(temporaryPath, { force: true })
    throw error
  }
  await output.close()

  await writeFile(join(directory, WAVEFORM_FILE), peaks.finish())
  // The audio file appearing is what marks the media as prepared, so it is moved in last.
  await rename(temporaryPath, join(directory, AUDIO_FILE))
}

export function openPreparedAudio(directory: string): Promise<FileHandle> {
  return open(join(directory, AUDIO_FILE), 'r')
}

/** Reads `sampleCount` stereo frames starting at `firstSample`; silence outside the file. */
export async function readAudio(audio: FileHandle, firstSample: number, sampleCount: number): Promise<Float32Array> {
  const samples = new Float32Array(sampleCount * CHANNELS)
  const framesBefore = Math.max(0, -firstSample)
  if (framesBefore >= sampleCount) return samples

  const bytes = new Uint8Array(samples.buffer, framesBefore * BYTES_PER_FRAME)
  const position = (firstSample + framesBefore) * BYTES_PER_FRAME
  // A short read at the end of the file leaves the remaining samples at zero.
  await audio.read(bytes, 0, bytes.length, position)
  return samples
}
