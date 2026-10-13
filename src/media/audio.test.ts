import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { bundledFfmpeg } from '../../test/helpers.js'
import { CLICK_SAMPLE_44K, mediaPath } from '../../test/media/generate.js'
import { AUDIO_FILE, WAVEFORM_BUCKET_SAMPLES, WAVEFORM_FILE, createPeakFolder, openPreparedAudio, prepareAudio, readAudio, waveformLevels } from './audio.js'
import { probeMedia } from './probe.js'

const ffmpeg = bundledFfmpeg()
const scratch = await mkdtemp(join(tmpdir(), 'audio-cache-'))
const RAMP_SAMPLES = 96_000
const RAMP_PERIOD = 65_536
const QUARTER_SECOND = 12_000

afterAll(() => rm(scratch, { recursive: true, force: true }))

function ramp(index: number): { left: number; right: number } {
  const left = (index % RAMP_PERIOD) - 32_768
  return { left: left / 32_768, right: (-left - 1) / 32_768 }
}

async function prepare(name: string): Promise<string> {
  const info = await probeMedia(ffmpeg, mediaPath(name))
  if (info.kind === 'image') throw new Error(`${name} is an image`)
  const directory = await mkdtemp(join(scratch, 'media-'))
  await prepareAudio(ffmpeg, { path: mediaPath(name), containerStart: info.containerStart }, directory, new AbortController().signal)
  return directory
}

async function allSamples(directory: string): Promise<Float32Array> {
  const bytes = await readFile(join(directory, AUDIO_FILE))
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4)
}

async function window(directory: string, firstSample: number, sampleCount: number): Promise<Float32Array> {
  const audio = await openPreparedAudio(directory)
  const samples = await readAudio(audio, firstSample, sampleCount)
  await audio.close()
  return samples
}

function largestDrop(samples: Float32Array): number {
  let position = 0
  let drop = 0
  for (let frame = 1; frame < samples.length / 2; frame++) {
    const fall = (samples[(frame - 1) * 2] ?? 0) - (samples[frame * 2] ?? 0)
    if (fall > drop) {
      drop = fall
      position = frame
    }
  }
  return position
}

function loudestFrame(samples: Float32Array): number {
  let position = 0
  let peak = 0
  for (let frame = 0; frame < samples.length / 2; frame++) {
    const level = Math.abs(samples[frame * 2] ?? 0)
    if (level > peak) {
      peak = level
      position = frame
    }
  }
  return position
}

describe('prepareAudio', () => {
  it('stores 48 kHz stereo samples that match the source exactly', async () => {
    const samples = await allSamples(await prepare('audio.wav'))
    expect(samples.length).toBe(RAMP_SAMPLES * 2)
    for (let index = 0; index < RAMP_SAMPLES; index += 37) {
      expect(samples[index * 2]).toBe(ramp(index).left)
      expect(samples[index * 2 + 1]).toBe(ramp(index).right)
    }
  })

  it.each(['audio.flac', 'audio-alac.m4a', 'audio.aiff'])('decodes lossless %s to the same samples', async (name) => {
    const reference = await allSamples(await prepare('audio.wav'))
    const decoded = await allSamples(await prepare(name))
    expect(Buffer.from(decoded.buffer, decoded.byteOffset, decoded.byteLength).equals(Buffer.from(reference.buffer, reference.byteOffset, reference.byteLength))).toBe(true)
  })

  it.each(['audio.mp3', 'audio.m4a', 'audio.ogg', 'audio.opus'])('keeps lossy %s aligned to the sample', async (name) => {
    const samples = await allSamples(await prepare(name))
    expect(Math.abs(largestDrop(samples) - RAMP_PERIOD)).toBeLessThanOrEqual(2)
    expect(Math.abs(samples.length / 2 - RAMP_SAMPLES)).toBeLessThan(4800)
  })

  it.each([
    { name: 'h264.mp4', toleranceSamples: 2 },
    { name: 'h264.mkv', toleranceSamples: 48 },
    { name: 'vp9.webm', toleranceSamples: 48 },
    { name: 'h264.ts', toleranceSamples: 2 },
    { name: 'h264.flv', toleranceSamples: 48 },
    { name: 'mpeg4.avi', toleranceSamples: 1600 },
  ])('keeps the sound of $name in sync with its picture', async ({ name, toleranceSamples }) => {
    const info = await probeMedia(ffmpeg, mediaPath(name))
    if (info.kind !== 'video') throw new Error(`${name} is not a video`)
    const samples = await allSamples(await prepare(name))
    const pictureStart = info.video.startOffset / 500
    expect(Math.abs(largestDrop(samples) - pictureStart - RAMP_PERIOD)).toBeLessThanOrEqual(toleranceSamples)
  })

  it('resamples 44.1 kHz without moving the sound', async () => {
    const samples = await allSamples(await prepare('audio-44k-click.wav'))
    const expected = Math.round((CLICK_SAMPLE_44K * 48_000) / 44_100)
    expect(Math.abs(loudestFrame(samples) - expected)).toBeLessThanOrEqual(1)
    expect(Math.abs(samples.length / 2 - 48_000)).toBeLessThanOrEqual(2)
  })

  it('converts mono, surround and high-resolution sources to stereo at 48 kHz', async () => {
    const mono = await allSamples(await prepare('audio-mono.wav'))
    expect(mono.length).toBe(RAMP_SAMPLES * 2)
    expect(mono[2001]).toBe(mono[2000])

    const surround = await allSamples(await prepare('audio-surround.wav'))
    expect(surround.length).toBe(RAMP_SAMPLES * 2)
    expect(Math.abs(surround[2000] ?? 0)).toBeGreaterThan(0.01)

    const highResolution = await allSamples(await prepare('audio-96k-24bit.flac'))
    expect(Math.abs(highResolution.length / 2 - RAMP_SAMPLES)).toBeLessThanOrEqual(2)
  })

  it('pads audio that starts after the container start, so it stays in sync with the picture', async () => {
    const samples = await allSamples(await prepare('delayed-audio.mkv'))
    for (let index = 0; index < QUARTER_SECOND; index += 113) expect(samples[index * 2]).toBe(0)
    for (let index = 0; index < 50_000; index += 997) {
      expect(samples[(index + QUARTER_SECOND) * 2]).toBe(ramp(index).left)
    }
  })

  it('starts audio at sample 0 when the picture is the late stream', async () => {
    const samples = await allSamples(await prepare('delayed-video.mkv'))
    expect(samples[0]).toBe(ramp(0).left)
    expect(samples[40_000 * 2]).toBe(ramp(40_000).left)
  })

  it('does nothing when the audio is already prepared', async () => {
    const directory = await prepare('audio.wav')
    const builtAt = (await stat(join(directory, AUDIO_FILE))).mtimeMs
    const startedAt = performance.now()
    await prepareAudio(ffmpeg, { path: mediaPath('audio.wav'), containerStart: 0 }, directory, new AbortController().signal)
    expect(performance.now() - startedAt).toBeLessThan(20)
    expect((await stat(join(directory, AUDIO_FILE))).mtimeMs).toBe(builtAt)
  })

  it('leaves nothing behind when cancelled', async () => {
    const directory = await mkdtemp(join(scratch, 'cancelled-'))
    const rejected = prepareAudio(ffmpeg, { path: mediaPath('audio.wav'), containerStart: 0 }, directory, AbortSignal.abort())
    await expect(rejected).rejects.toThrow(/cancelled/)
    expect(existsSync(join(directory, AUDIO_FILE))).toBe(false)
    expect(existsSync(join(directory, `${AUDIO_FILE}.tmp`))).toBe(false)
  })
})

describe('readAudio', () => {
  it('returns any window sample-accurately', async () => {
    const directory = await prepare('audio.wav')
    for (const { first, count } of [
      { first: 0, count: 1 },
      { first: 1, count: 480 },
      { first: 65_530, count: 12 },
      { first: 47_999, count: 4801 },
      { first: 95_990, count: 10 },
    ]) {
      const samples = await window(directory, first, count)
      expect(samples.length).toBe(count * 2)
      for (let index = 0; index < count; index++) {
        expect(samples[index * 2]).toBe(ramp(first + index).left)
        expect(samples[index * 2 + 1]).toBe(ramp(first + index).right)
      }
    }
  })

  it('is silent before the start and after the end', async () => {
    const directory = await prepare('audio.wav')
    const early = await window(directory, -5, 8)
    expect([...early.subarray(0, 10)]).toEqual(Array(10).fill(0))
    expect(early[10]).toBe(ramp(0).left)
    expect(early[14]).toBe(ramp(2).left)

    const late = await window(directory, RAMP_SAMPLES - 2, 6)
    expect(late[0]).toBe(ramp(RAMP_SAMPLES - 2).left)
    expect(late[2]).toBe(ramp(RAMP_SAMPLES - 1).left)
    expect([...late.subarray(4)]).toEqual(Array(8).fill(0))

    expect([...(await window(directory, -100, 10))]).toEqual(Array(20).fill(0))
    expect([...(await window(directory, RAMP_SAMPLES + 50, 10))]).toEqual(Array(20).fill(0))
  })
})

describe('waveform', () => {
  it('holds one lowest/highest pair per 480 samples', async () => {
    const directory = await prepare('audio.wav')
    const peaks = new Int8Array(await readFile(join(directory, WAVEFORM_FILE)))
    expect(peaks.length).toBe((RAMP_SAMPLES / WAVEFORM_BUCKET_SAMPLES) * 2)

    const leftAtStart = ramp(4800).left
    const leftAtEnd = ramp(5279).left
    expect(peaks[20]).toBe(Math.round(Math.min(leftAtStart, ramp(5279).right) * 127))
    expect(peaks[21]).toBe(Math.round(Math.max(leftAtEnd, ramp(4800).right) * 127))
  })

  it('gives the same result however the stream is chunked', () => {
    const samples = new Float32Array(48_000 * 2 + 1234 * 2)
    for (let index = 0; index < samples.length; index++) samples[index] = Math.sin(index * 0.013) * Math.cos(index * 0.00071)

    const whole = createPeakFolder()
    whole.add(samples)
    const expected = whole.finish()

    for (const chunkFrames of [1, 7, 479, 480, 481, 4096]) {
      const pieces = createPeakFolder()
      for (let start = 0; start < samples.length; start += chunkFrames * 2) {
        pieces.add(samples.subarray(start, start + chunkFrames * 2))
      }
      expect(Buffer.from(pieces.finish()).equals(Buffer.from(expected)), `chunks of ${chunkFrames} frames`).toBe(true)
    }
  })

  it('folds the peaks into levels an eighth the size, keeping the extremes of every bucket', () => {
    const bucketCount = 10_000
    const peaks = new Int8Array(bucketCount * 2)
    for (let bucket = 0; bucket < bucketCount; bucket++) {
      peaks[bucket * 2] = -(bucket % 100)
      peaks[bucket * 2 + 1] = bucket % 50
    }

    const levels = waveformLevels(peaks)
    expect(levels.map((level) => level.samplesPerBucket)).toEqual([480, 3840, 30_720])
    expect(levels.map((level) => level.peaks.length / 2)).toEqual([10_000, 1250, 157])
    expect(levels[0]?.peaks).toBe(peaks)

    const second = levels[1]?.peaks ?? new Int8Array()
    expect([second[0], second[1]]).toEqual([-7, 7])
    expect([second[2 * 12], second[2 * 12 + 1]]).toEqual([-99, 49])
    const last = levels[2]?.peaks ?? new Int8Array()
    expect([last[2 * 156], last[2 * 156 + 1]]).toEqual([-99, 49])
  })

  it('needs 14.4 MB for a 20-hour file', () => {
    const twentyHoursOfSamples = 20 * 60 * 60 * 48_000
    const bytes = Math.ceil(twentyHoursOfSamples / WAVEFORM_BUCKET_SAMPLES) * 2
    expect(bytes).toBe(14_400_000)
    expect(bytes).toBeLessThanOrEqual(20 * 1024 * 1024)

    const folder = createPeakFolder()
    folder.add(new Float32Array(WAVEFORM_BUCKET_SAMPLES * 2 * 1000))
    expect(folder.finish().length).toBe(2000)
  })
})
