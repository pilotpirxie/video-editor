import { existsSync } from 'node:fs'
import { open, rename, rm, writeFile, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { SAMPLE_RATE, TICKS_PER_SAMPLE } from '../shared/time.js'
import type { FfmpegRunner } from './ffmpeg.js'

export const WAVEFORM_BUCKET_SAMPLES = 480
export const AUDIO_FILE = 'audio.f32'
export const WAVEFORM_FILE = 'waveform.i8'

const CHANNELS = 2
const BYTES_PER_SAMPLE = 4
const BYTES_PER_FRAME = CHANNELS * BYTES_PER_SAMPLE
const READ_TIMEOUT_MS = 30_000
const INT8_PEAK = 127
const INITIAL_BUCKET_CAPACITY = 4096

export type AudioSource = {
  path: string
  containerStart: number
}

export type PeakFolder = {
  add(samples: Float32Array): void
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

function wholeFrames(bytes: Buffer): Float32Array {
  const frameBytes = bytes.length - (bytes.length % BYTES_PER_FRAME)
  const isAligned = bytes.byteOffset % BYTES_PER_SAMPLE === 0
  const aligned = isAligned ? bytes : Buffer.from(bytes)
  return new Float32Array(aligned.buffer, aligned.byteOffset, frameBytes / BYTES_PER_SAMPLE)
}

export async function prepareAudio(ffmpeg: FfmpegRunner, source: AudioSource, directory: string, signal: AbortSignal): Promise<void> {
  const isPrepared = existsSync(join(directory, AUDIO_FILE)) && existsSync(join(directory, WAVEFORM_FILE))
  if (isPrepared) return

  const firstSample = Math.round(source.containerStart / TICKS_PER_SAMPLE)
  const filter = `aresample=${SAMPLE_RATE}:async=1:first_pts=${firstSample},aformat=sample_fmts=flt:channel_layouts=stereo`
  const job = ffmpeg.spawnJob('ffmpeg', ['-copyts', '-i', source.path, '-map', '0:a:0', '-af', filter, '-f', 'f32le', '-'], { signal })

  const temporaryPath = join(directory, `${AUDIO_FILE}.tmp`)
  const output = await open(temporaryPath, 'w')
  const peaks = createPeakFolder()
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
  await rename(temporaryPath, join(directory, AUDIO_FILE))
}

export function openPreparedAudio(directory: string): Promise<FileHandle> {
  return open(join(directory, AUDIO_FILE), 'r')
}

export async function readAudio(audio: FileHandle, firstSample: number, sampleCount: number): Promise<Float32Array> {
  const samples = new Float32Array(sampleCount * CHANNELS)
  const framesBefore = Math.max(0, -firstSample)
  if (framesBefore >= sampleCount) return samples

  const bytes = new Uint8Array(samples.buffer, framesBefore * BYTES_PER_FRAME)
  const position = (firstSample + framesBefore) * BYTES_PER_FRAME
  await audio.read(bytes, 0, bytes.length, position)
  return samples
}
