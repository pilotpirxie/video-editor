import { open, readFile, rename, rm, writeFile, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import type { AudioStretch, WaveformLevel } from '../shared/mediaProtocol.js'
import { MAX_SPEED_PERCENT, MIN_SPEED_PERCENT, NORMAL_SPEED_PERCENT, SAMPLE_RATE, TICKS_PER_SAMPLE, TICKS_PER_SECOND } from '../shared/time.js'
import type { BuildClaim, DiskCache } from './cache.js'
import { writeAll, type FfmpegRunner, type Job } from './ffmpeg.js'

export const WAVEFORM_BUCKET_SAMPLES = 480
export const WAVEFORM_FILE = 'waveform.i8'
// Each segment holds this much more than its share; where two segments meet, the reader fades from the end of one into the start of the next, so two decodes that differ by a fraction of a sample never click.
const SEAM_SAMPLES = 480

const CHANNELS = 2
const BYTES_PER_SAMPLE = 4
const BYTES_PER_FRAME = CHANNELS * BYTES_PER_SAMPLE
const READ_TIMEOUT_MS = 30_000
const INT8_PEAK = 127
const INITIAL_BUCKET_CAPACITY = 4096
const WAVEFORM_LEVEL_FACTOR = 8
const SMALLEST_LEVEL_BUCKETS = 512
// FFmpeg's tempo filter goes no slower than this in one step; slower speeds take several steps.
const SLOWEST_TEMPO_STEP = 0.5
// Decoding starts a second early: the first sound a decoder gives after a seek is not yet right.
const PREROLL_SAMPLES = SAMPLE_RATE
// A stretched segment is made from a little more sound than it needs on either side, so the tempo filter has settled where the segment starts and ends.
const STRETCH_MARGIN_SAMPLES = SAMPLE_RATE
// Sound is fed to the tempo filter in pieces of this many samples, so a very fast clip does not hold an hour of sound in memory.
const STRETCH_FEED_SAMPLES = 10 * SAMPLE_RATE
// Decoding goes on a little past what a run needs, so its last segment is never cut short by rounding.
const RUN_END_MARGIN_SECONDS = 0.5

class StretchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StretchError'
  }
}

export type AudioSource = {
  path: string
  containerStart: number
}

// Sound is kept in segments of a fixed number of samples, each with its own file, so a long file is prepared around the playhead. A file whose sound
// cannot be found exactly by seeking (MP3, raw AAC) is always decoded from its start.
export type AudioLayout = {
  samplesPerSegment: number
  segmentCount: number
  seeksExactly: boolean
}

export type AudioRun = {
  ffmpeg: FfmpegRunner
  source: AudioSource
  directory: string
  layout: AudioLayout
  cache: DiskCache
  // Decoding starts at the first segment and stops after the last; only the claimed segments are written.
  firstSegment: number
  lastSegment: number
  claim: BuildClaim
  signal: AbortSignal
}

type BaseReader = (firstSample: number, sampleCount: number) => Promise<Float32Array>

export type StretchedBuild = {
  ffmpeg: FfmpegRunner
  directory: string
  layout: AudioLayout
  cache: DiskCache
  stretch: AudioStretch
  segment: number
  claim: BuildClaim
  readBase: BaseReader
  signal: AbortSignal
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

function coarserPeaks(peaks: Int8Array): Int8Array {
  const bucketCount = Math.ceil(peaks.length / 2 / WAVEFORM_LEVEL_FACTOR)
  const coarser = new Int8Array(bucketCount * 2)
  for (let bucket = 0; bucket < bucketCount; bucket++) {
    let lowest = INT8_PEAK
    let highest = -INT8_PEAK
    const firstPair = bucket * WAVEFORM_LEVEL_FACTOR
    const pairsEnd = Math.min(firstPair + WAVEFORM_LEVEL_FACTOR, peaks.length / 2)
    for (let pair = firstPair; pair < pairsEnd; pair++) {
      lowest = Math.min(lowest, peaks[pair * 2] ?? 0)
      highest = Math.max(highest, peaks[pair * 2 + 1] ?? 0)
    }
    coarser[bucket * 2] = lowest
    coarser[bucket * 2 + 1] = highest
  }
  return coarser
}

// Drawing a 20-hour waveform zoomed out must not walk 7 million buckets per frame, so each level holds an eighth of the one before.
export function waveformLevels(peaks: Int8Array): WaveformLevel[] {
  const levels: WaveformLevel[] = [{ samplesPerBucket: WAVEFORM_BUCKET_SAMPLES, peaks }]
  for (;;) {
    const finest = levels[levels.length - 1]
    if (finest === undefined || finest.peaks.length / 2 <= SMALLEST_LEVEL_BUCKETS) return levels
    levels.push({ samplesPerBucket: finest.samplesPerBucket * WAVEFORM_LEVEL_FACTOR, peaks: coarserPeaks(finest.peaks) })
  }
}

export async function readWaveform(directory: string): Promise<WaveformLevel[]> {
  const bytes = await readFile(join(directory, WAVEFORM_FILE))
  const peaks = new Int8Array(bytes.length)
  peaks.set(bytes)
  return waveformLevels(peaks)
}

// The FFmpeg filter that plays sound at another speed. The request comes from the window, so it is checked before it becomes part of a command and of a file name.
export function tempoFilter(stretch: AudioStretch): string {
  const { speedPercent } = stretch
  const isUsable = Number.isInteger(speedPercent) && speedPercent >= MIN_SPEED_PERCENT && speedPercent <= MAX_SPEED_PERCENT && speedPercent !== NORMAL_SPEED_PERCENT
  if (!isUsable || typeof stretch.keepsPitch !== 'boolean') throw new StretchError(`Sound cannot be played at "${String(speedPercent)}" percent of its speed`)

  // Samples made for one rate and played at another are faster and higher, like a tape.
  if (!stretch.keepsPitch) return `asetrate=${(SAMPLE_RATE * speedPercent) / NORMAL_SPEED_PERCENT},aresample=${SAMPLE_RATE}`

  const steps: string[] = []
  let tempo = speedPercent / NORMAL_SPEED_PERCENT
  while (tempo < SLOWEST_TEMPO_STEP) {
    steps.push(`atempo=${SLOWEST_TEMPO_STEP}`)
    tempo /= SLOWEST_TEMPO_STEP
  }
  steps.push(`atempo=${tempo}`)
  return steps.join(',')
}

export function stretchKey(stretch: AudioStretch): string {
  return `${stretch.speedPercent}${stretch.keepsPitch ? 'k' : 'c'}`
}

export function audioLayout(durationTicks: number, segmentSeconds: number, seeksExactly: boolean): AudioLayout {
  const samplesPerSegment = Math.round(segmentSeconds * SAMPLE_RATE)
  const totalSamples = Math.ceil(durationTicks / TICKS_PER_SAMPLE)
  return { samplesPerSegment, segmentCount: Math.max(1, Math.ceil(totalSamples / samplesPerSegment)), seeksExactly }
}

// Counted in the stretched sound, a file at another speed has as many segments as its length at that speed needs.
export function stretchedLayout(layout: AudioLayout, stretch: AudioStretch): AudioLayout {
  const totalSamples = (layout.segmentCount * layout.samplesPerSegment * NORMAL_SPEED_PERCENT) / stretch.speedPercent
  return { ...layout, segmentCount: Math.max(1, Math.ceil(totalSamples / layout.samplesPerSegment)) }
}

export function audioSegmentPath(directory: string, segment: number, stretch?: AudioStretch): string {
  const name = stretch === undefined ? `audio-${segment}.f32` : `audio-${stretchKey(stretch)}-${segment}.f32`
  return join(directory, name)
}

function seconds(ticks: number): string {
  return (ticks / TICKS_PER_SECOND).toFixed(6)
}

// Decodes the sound of a file from `startSample` on as 48 kHz stereo float samples, placed by the file's timestamps: sample 0 is the start of the file.
function decodeFrom(ffmpeg: FfmpegRunner, source: AudioSource, startSample: number, durationSamples: number | undefined, signal: AbortSignal): Job {
  const firstPts = Math.round(source.containerStart / TICKS_PER_SAMPLE) + startSample
  const filter = `aresample=${SAMPLE_RATE}:async=1:first_pts=${firstPts},aformat=sample_fmts=flt:channel_layouts=stereo`
  const args = ['-copyts']
  if (startSample > 0) args.push('-ss', seconds(startSample * TICKS_PER_SAMPLE))
  args.push('-i', source.path, '-map', '0:a:0', '-af', filter)
  // With the file's own timestamps kept, the end is a timestamp too: `-t` would also be counted from the start of the file.
  if (durationSamples !== undefined) args.push('-to', ((firstPts + durationSamples) / SAMPLE_RATE + RUN_END_MARGIN_SECONDS).toFixed(6))
  args.push('-f', 'f32le', '-')
  return ffmpeg.spawnJob('ffmpeg', args, { signal })
}

// Hands on the whole stereo frames of each chunk a job puts out, keeping a frame split between chunks for the next.
async function forEachFrames(job: Job, onFrames: (frames: Float32Array) => Promise<void> | void): Promise<void> {
  let loose: Buffer = Buffer.alloc(0)
  for (;;) {
    const chunk = await job.readChunk(READ_TIMEOUT_MS)
    if (chunk === undefined) break
    const joined = loose.length === 0 ? chunk : Buffer.concat([loose, chunk])
    const frames = wholeFrames(joined)
    loose = joined.subarray(frames.byteLength)
    await onFrames(frames)
  }
  await job.done
}

async function writeCacheFile(cache: DiskCache, path: string, data: Float32Array | Int8Array): Promise<void> {
  const temporaryPath = cache.temporaryPathFor(path)
  try {
    await writeFile(temporaryPath, new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
    await rename(temporaryPath, path)
  } catch (error) {
    await rm(temporaryPath, { force: true })
    throw error
  }
  await cache.added(path)
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

// Fills segments one after another from a stream of samples. Each segment is written with its seam tail, which is also the start of the next.
function createSegmentFiller(layout: AudioLayout, firstSegment: number, write: (segment: number, samples: Float32Array) => Promise<void>): { add(frames: Float32Array): Promise<void>; finish(): Promise<void>; isDone(): boolean } {
  const segmentFrames = layout.samplesPerSegment + SEAM_SAMPLES
  let segment = firstSegment
  let current = new Float32Array(segmentFrames * CHANNELS)
  let filled = 0

  async function add(frames: Float32Array): Promise<void> {
    let offset = 0
    while (offset < frames.length && segment < layout.segmentCount) {
      const taken = Math.min(frames.length - offset, (segmentFrames - filled) * CHANNELS)
      current.set(frames.subarray(offset, offset + taken), filled * CHANNELS)
      filled += taken / CHANNELS
      offset += taken
      if (filled < segmentFrames) return
      await write(segment, current)
      const next = new Float32Array(segmentFrames * CHANNELS)
      next.set(current.subarray(layout.samplesPerSegment * CHANNELS))
      current = next
      filled = SEAM_SAMPLES
      segment += 1
    }
  }

  async function finish(): Promise<void> {
    if (filled > 0 && segment < layout.segmentCount) await write(segment, current.subarray(0, filled * CHANNELS))
  }

  return { add, finish, isDone: () => segment >= layout.segmentCount }
}

// Decodes consecutive segments with one FFmpeg run, starting a second early so the decoder has settled.
// Answers the claimed segments the sound ended before: a sound track may be shorter than its file.
export async function buildAudioRun(run: AudioRun): Promise<string[]> {
  const { ffmpeg, source, directory, layout, cache, firstSegment, lastSegment, claim, signal } = run
  if (claim.paths.length === 0) return []
  const claimed = new Set(claim.paths)
  const written = new Set<string>()
  const runStart = firstSegment * layout.samplesPerSegment
  const startSample = Math.max(0, runStart - PREROLL_SAMPLES)
  const neededSamples = (lastSegment + 1) * layout.samplesPerSegment + SEAM_SAMPLES - startSample

  const filler = createSegmentFiller({ ...layout, segmentCount: Math.min(layout.segmentCount, lastSegment + 1) }, firstSegment, async (segment, samples) => {
    const path = audioSegmentPath(directory, segment)
    if (!claimed.has(path)) return
    await writeCacheFile(cache, path, samples)
    claim.written(path)
    written.add(path)
  })

  let toSkip = runStart - startSample
  try {
    const job = decodeFrom(ffmpeg, source, startSample, neededSamples, signal)
    await forEachFrames(job, async (frames) => {
      if (filler.isDone()) return
      const skipped = Math.min(toSkip, frames.length / CHANNELS)
      toSkip -= skipped
      await filler.add(frames.subarray(skipped * CHANNELS))
    })
    await filler.finish()
  } catch (error) {
    claim.giveUp(asError(error))
    throw error
  }
  claim.giveUp(new Error('The sound ended before this segment'))
  return claim.paths.filter((path) => !written.has(path))
}

// The waveform of the whole file, made by one decode that keeps nothing but the peaks.
export async function buildWaveform(ffmpeg: FfmpegRunner, source: AudioSource, directory: string, cache: DiskCache, signal: AbortSignal): Promise<void> {
  const peaks = createPeakFolder()
  await forEachFrames(decodeFrom(ffmpeg, source, 0, undefined, signal), (frames) => peaks.add(frames))
  await writeCacheFile(cache, join(directory, WAVEFORM_FILE), peaks.finish())
}

function greatestCommonDivisor(a: number, b: number): number {
  return b === 0 ? a : greatestCommonDivisor(b, a % b)
}

// One stretched segment: the sound around it is fed through the tempo filter, and the part that lands in the segment is kept.
export async function buildStretchedSegment(build: StretchedBuild): Promise<void> {
  const { ffmpeg, directory, layout, cache, stretch, segment, claim, readBase, signal } = build
  const path = audioSegmentPath(directory, segment, stretch)
  if (!claim.paths.includes(path)) return
  const speed = stretch.speedPercent
  // The source start is a whole number of samples that also lands on a whole stretched sample.
  const step = speed / greatestCommonDivisor(speed, NORMAL_SPEED_PERCENT)
  const segmentStart = segment * layout.samplesPerSegment
  const sourceStart = Math.max(0, Math.floor((segmentStart * speed) / NORMAL_SPEED_PERCENT / step - STRETCH_MARGIN_SAMPLES / step) * step)
  const outputStart = (sourceStart * NORMAL_SPEED_PERCENT) / speed
  const segmentFrames = layout.samplesPerSegment + SEAM_SAMPLES
  const sourceEnd = Math.ceil(((segmentStart + segmentFrames) * speed) / NORMAL_SPEED_PERCENT) + STRETCH_MARGIN_SAMPLES

  const kept = new Float32Array(segmentFrames * CHANNELS)
  let produced = 0
  let keptFrames = 0
  const raw = ['-f', 'f32le', '-ar', String(SAMPLE_RATE), '-ac', String(CHANNELS)]

  try {
    const job = ffmpeg.spawnJob('ffmpeg', [...raw, '-i', 'pipe:0', '-af', tempoFilter(stretch), '-f', 'f32le', '-'], { signal })
    async function feed(): Promise<void> {
      for (let first = sourceStart; first < sourceEnd; first += STRETCH_FEED_SAMPLES) {
        const samples = await readBase(first, Math.min(STRETCH_FEED_SAMPLES, sourceEnd - first))
        await writeAll(job.stdin, new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength))
      }
      job.stdin.end()
    }
    const collect = forEachFrames(job, (frames) => {
      const frameCount = frames.length / CHANNELS
      const from = Math.max(0, segmentStart - outputStart - produced)
      const to = Math.min(frameCount, segmentStart + segmentFrames - outputStart - produced)
      if (to > from) {
        kept.set(frames.subarray(from * CHANNELS, to * CHANNELS), keptFrames * CHANNELS)
        keptFrames += to - from
      }
      produced += frameCount
    })
    await Promise.all([feed(), collect])
    await writeCacheFile(cache, path, kept.subarray(0, keptFrames * CHANNELS))
    claim.written(path)
  } catch (error) {
    claim.giveUp(asError(error))
    throw error
  }
}

async function readSegmentInto(path: string, offsetFrames: number, target: Float32Array): Promise<void> {
  let handle: FileHandle
  try {
    handle = await open(path, 'r')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return
    throw error
  }
  try {
    await handle.read(new Uint8Array(target.buffer, target.byteOffset, target.byteLength), 0, target.byteLength, offsetFrames * BYTES_PER_FRAME)
  } finally {
    await handle.close()
  }
}

// Reads samples across segment files, asking for each segment to be made first. Where two segments meet, the end of one fades into the start of
// the next. Samples outside the sound are silence.
export async function readSegmentedAudio(directory: string, layout: AudioLayout, firstSample: number, sampleCount: number, ensure: (segment: number) => Promise<void>, stretch?: AudioStretch): Promise<Float32Array> {
  const samples = new Float32Array(sampleCount * CHANNELS)
  const perSegment = layout.samplesPerSegment
  const from = Math.max(0, firstSample)
  const to = Math.min(firstSample + sampleCount, layout.segmentCount * perSegment)

  for (let segment = Math.floor(from / perSegment); segment * perSegment < to; segment++) {
    const segmentStart = segment * perSegment
    const partFrom = Math.max(from, segmentStart)
    const partTo = Math.min(to, segmentStart + perSegment)
    await ensure(segment)
    const part = samples.subarray((partFrom - firstSample) * CHANNELS, (partTo - firstSample) * CHANNELS)
    await readSegmentInto(audioSegmentPath(directory, segment, stretch), partFrom - segmentStart, part)

    const seamTo = Math.min(partTo, segmentStart + SEAM_SAMPLES)
    if (segment === 0 || partFrom >= seamTo) continue
    await ensure(segment - 1)
    const tail = new Float32Array((seamTo - partFrom) * CHANNELS)
    await readSegmentInto(audioSegmentPath(directory, segment - 1, stretch), partFrom - segmentStart + perSegment, tail)
    for (let sample = partFrom; sample < seamTo; sample++) {
      const weight = (sample - segmentStart + 0.5) / SEAM_SAMPLES
      const index = (sample - firstSample) * CHANNELS
      const tailIndex = (sample - partFrom) * CHANNELS
      for (let channel = 0; channel < CHANNELS; channel++) {
        samples[index + channel] = (tail[tailIndex + channel] ?? 0) * (1 - weight) + (samples[index + channel] ?? 0) * weight
      }
    }
  }
  return samples
}
