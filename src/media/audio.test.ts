import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { audioClip, projectOf, track } from '../../test/fixtures.js'
import { bundledFfmpeg } from '../../test/helpers.js'
import { CLICK_SAMPLE_44K, GAP_CLICK_SECONDS, LONG_CLICK_SECOND, LONG_MINUTES, mediaPath } from '../../test/media/generate.js'
import type { AudioStretch } from '../shared/mediaProtocol.js'
import { WAVEFORM_BUCKET_SAMPLES, WAVEFORM_FILE, audioSegmentPath, buildWaveform, createPeakFolder, tempoFilter, waveformLevels } from './audio.js'
import { createDiskCache } from './cache.js'
import { MediaSession } from './mediaStore.js'
import { writeProjectFile } from './projectFile.js'
import { probeMedia } from './probe.js'

const ffmpeg = bundledFfmpeg()
const scratch = await mkdtemp(join(tmpdir(), 'audio-cache-'))
const RAMP_SAMPLES = 96_000
const RAMP_PERIOD = 65_536
const QUARTER_SECOND = 12_000
const TICKS_PER_SAMPLE = 500
// One-second segments, so every two-second test file has a seam to cross.
const SHORT_SEGMENT_SECONDS = 1
const WHOLE_FILE_SEGMENT_SECONDS = 100
const PLENTY_OF_ROOM = 1024 ** 3
const CODEC_PADDING_SAMPLES = 4800
let cacheCount = 0

afterAll(() => rm(scratch, { recursive: true, force: true }))

function ramp(index: number): { left: number; right: number } {
  const left = (index % RAMP_PERIOD) - 32_768
  return { left: left / 32_768, right: (-left - 1) / 32_768 }
}

type Opened = {
  session: MediaSession
  id: string
  directory: string
  totalSamples: number
}

async function open(name: string, segmentSeconds = SHORT_SEGMENT_SECONDS): Promise<Opened> {
  cacheCount += 1
  const directory = join(scratch, `cache-${cacheCount}`)
  const session = new MediaSession(ffmpeg, createDiskCache(directory, PLENTY_OF_ROOM), segmentSeconds)
  const added = await session.addMedia(mediaPath(name))
  if (added.info.kind === 'image') throw new Error(`${name} is an image`)
  const [mediaFolder] = await readdir(directory)
  return { session, id: added.id, directory: join(directory, mediaFolder ?? ''), totalSamples: Math.ceil(added.info.duration / TICKS_PER_SAMPLE) }
}

async function window(opened: Opened, firstSample: number, sampleCount: number, stretch?: AudioStretch): Promise<Float32Array> {
  const samples = await opened.session.audio(opened.id, firstSample, sampleCount, stretch)
  if (samples === undefined) throw new Error('The media has no sound')
  return samples
}

async function allSamples(name: string, segmentSeconds = SHORT_SEGMENT_SECONDS): Promise<Float32Array> {
  const opened = await open(name, segmentSeconds)
  return window(opened, 0, opened.totalSamples)
}

function largestDifference(a: Float32Array, b: Float32Array): number {
  let largest = 0
  for (let index = 0; index < Math.min(a.length, b.length); index++) largest = Math.max(largest, Math.abs((a[index] ?? 0) - (b[index] ?? 0)))
  return largest
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

describe('prepared sound', () => {
  it('stores 48 kHz stereo samples that match the source exactly', async () => {
    const samples = await allSamples('audio.wav')
    expect(samples.length).toBe(RAMP_SAMPLES * 2)
    for (let index = 0; index < RAMP_SAMPLES; index += 37) {
      expect(samples[index * 2]).toBe(ramp(index).left)
      expect(samples[index * 2 + 1]).toBe(ramp(index).right)
    }
  })

  it.each(['audio.flac', 'audio-alac.m4a', 'audio.aiff'])('decodes lossless %s to the same samples', async (name) => {
    const reference = await allSamples('audio.wav')
    const decoded = await allSamples(name)
    expect(Buffer.from(decoded.buffer, decoded.byteOffset, decoded.byteLength).equals(Buffer.from(reference.buffer, reference.byteOffset, reference.byteLength))).toBe(true)
  })

  it.each(['audio.mp3', 'audio.m4a', 'audio.ogg', 'audio.opus'])('keeps lossy %s aligned to the sample', async (name) => {
    const samples = await allSamples(name)
    expect(Math.abs(largestDrop(samples) - RAMP_PERIOD)).toBeLessThanOrEqual(2)
  })

  // Segments made by separate decodes meet without a jump: read the second segment first, so the first is decoded on its own afterwards.
  it.each(['audio.wav', 'audio.flac', 'audio-alac.m4a', 'audio.aiff', 'audio.mp3', 'audio.m4a', 'audio.ogg', 'audio.opus', 'audio-44k-click.wav', 'audio-96k-24bit.flac', 'h264.mp4', 'vp9.webm'])('joins separately decoded segments of %s as one decode', async (name) => {
    const opened = await open(name)
    await window(opened, 48_000, 1000)
    // Lossy codecs pad their last packet; a decode that seeks may keep a little of that padding. Only the seams matter here.
    const compared = opened.totalSamples - CODEC_PADDING_SAMPLES
    const joined = await window(opened, 0, compared)
    const whole = (await allSamples(name, WHOLE_FILE_SEGMENT_SECONDS)).subarray(0, compared * 2)
    expect(largestDifference(joined, whole)).toBeLessThan(1e-3)
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
    const samples = await allSamples(name)
    const pictureStart = info.video.startOffset / 500
    expect(Math.abs(largestDrop(samples) - pictureStart - RAMP_PERIOD)).toBeLessThanOrEqual(toleranceSamples)
  })

  it('resamples 44.1 kHz without moving the sound', async () => {
    const samples = await allSamples('audio-44k-click.wav')
    const expected = Math.round((CLICK_SAMPLE_44K * 48_000) / 44_100)
    expect(Math.abs(loudestFrame(samples) - expected)).toBeLessThanOrEqual(1)
  })

  it('converts mono, surround and high-resolution sources to stereo at 48 kHz', async () => {
    const mono = await allSamples('audio-mono.wav')
    expect(mono.length).toBe(RAMP_SAMPLES * 2)
    expect(mono[2001]).toBe(mono[2000])

    const surround = await allSamples('audio-surround.wav')
    expect(surround.length).toBe(RAMP_SAMPLES * 2)
    expect(Math.abs(surround[2000] ?? 0)).toBeGreaterThan(0.01)

    const highResolution = await allSamples('audio-96k-24bit.flac')
    expect(Math.abs(largestDrop(highResolution) - RAMP_PERIOD)).toBeLessThanOrEqual(2)
  })

  it('pads audio that starts after the container start, so it stays in sync with the picture', async () => {
    const samples = await allSamples('delayed-audio.mkv')
    for (let index = 0; index < QUARTER_SECOND; index += 113) expect(samples[index * 2]).toBe(0)
    for (let index = 0; index < 50_000; index += 997) {
      expect(samples[(index + QUARTER_SECOND) * 2]).toBe(ramp(index).left)
    }
  })

  it('starts audio at sample 0 when the picture is the late stream', async () => {
    const samples = await allSamples('delayed-video.mkv')
    expect(samples[0]).toBe(ramp(0).left)
    expect(samples[40_000 * 2]).toBe(ramp(40_000).left)
  })

  it('reads prepared segments again without decoding', async () => {
    const opened = await open('audio.wav')
    await window(opened, 0, RAMP_SAMPLES)
    const builtAt = (await stat(audioSegmentPath(opened.directory, 0))).mtimeMs
    const startedAt = performance.now()
    await window(opened, 0, RAMP_SAMPLES)
    expect(performance.now() - startedAt).toBeLessThan(20)
    expect((await stat(audioSegmentPath(opened.directory, 0))).mtimeMs).toBe(builtAt)
  })

  it('leaves no unfinished file behind when the session closes during a decode', async () => {
    const opened = await open('variable-rate-gap.mp4')
    const reading = opened.session.audio(opened.id, 0, opened.totalSamples)
    await opened.session.dispose()
    await Promise.allSettled([reading])
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect((await readdir(opened.directory)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('stays in step with the picture to the end of a phone recording with a long gap', async () => {
    const opened = await open('variable-rate-gap.mp4', 30)
    const clickAt = GAP_CLICK_SECONDS * 48_000
    const around = await window(opened, clickAt - 4800, 9600)
    expect(Math.abs(loudestFrame(around) - 4800)).toBeLessThanOrEqual(48)
  })
})

describe('sound at another speed', () => {
  async function stretched(opened: Opened, speedPercent: number, keepsPitch: boolean): Promise<Float32Array> {
    return window(opened, 0, 200_000, { speedPercent, keepsPitch })
  }

  function lastSound(samples: Float32Array): number {
    for (let frame = samples.length / 2 - 1; frame >= 0; frame--) {
      if (samples[frame * 2] !== 0) return frame
    }
    return 0
  }

  it('keeps the pitch with the tempo filter, in steps where one step cannot go that slow', () => {
    expect(tempoFilter({ speedPercent: 200, keepsPitch: true })).toBe('atempo=2')
    expect(tempoFilter({ speedPercent: 10_000, keepsPitch: true })).toBe('atempo=100')
    expect(tempoFilter({ speedPercent: 25, keepsPitch: true })).toBe('atempo=0.5,atempo=0.5')
    expect(tempoFilter({ speedPercent: 150, keepsPitch: false })).toBe('asetrate=72000,aresample=48000')
  })

  it('refuses a speed that is none', () => {
    for (const speedPercent of [100, 24, 10_001, 150.5, Number.NaN]) {
      expect(() => tempoFilter({ speedPercent, keepsPitch: true }), String(speedPercent)).toThrow(/cannot be played/)
    }
  })

  // The tempo filter blends neighbouring pieces of sound, which spreads a click over some milliseconds; it must stay within a frame of where it belongs.
  it('puts a sound where it is heard at that speed, within one frame', async () => {
    const opened = await open('audio-44k-click.wav')
    const oneFrame = 1600
    for (const { speedPercent, keepsPitch } of [{ speedPercent: 200, keepsPitch: true }, { speedPercent: 150, keepsPitch: true }, { speedPercent: 50, keepsPitch: true }, { speedPercent: 200, keepsPitch: false }]) {
      const samples = await stretched(opened, speedPercent, keepsPitch)
      const expected = (24_000 * 100) / speedPercent
      expect(Math.abs(loudestFrame(samples) - expected), `${speedPercent} % ${keepsPitch}`).toBeLessThanOrEqual(oneFrame)
    }
  })

  it('is as long as the sound divided by the speed', async () => {
    const opened = await open('audio.wav')
    const tolerance = 4800
    expect(Math.abs(lastSound(await stretched(opened, 200, true)) - RAMP_SAMPLES / 2)).toBeLessThanOrEqual(tolerance)
    expect(Math.abs(lastSound(await stretched(opened, 400, false)) - RAMP_SAMPLES / 4)).toBeLessThanOrEqual(tolerance)
  })

  it('gives the same samples every time it is made', async () => {
    const first = await stretched(await open('audio.wav'), 150, true)
    const second = await stretched(await open('audio.wav'), 150, true)
    expect(Buffer.from(first.buffer).equals(Buffer.from(second.buffer))).toBe(true)
  })

  // Each stretched segment is made by its own run of the tempo filter; where two meet, a sine must go on without a jump.
  it('joins stretched segments without a jump', async () => {
    const opened = await open('audio.wav')
    for (const stretch of [{ speedPercent: 150, keepsPitch: true }, { speedPercent: 50, keepsPitch: true }, { speedPercent: 300, keepsPitch: false }]) {
      const samples = await window(opened, 40_000, 16_000, stretch)
      const seam = 48_000 - 40_000
      let largestStepAtSeam = 0
      let largestStepElsewhere = 0
      for (let frame = 1; frame < samples.length / 2; frame++) {
        const step = Math.abs((samples[frame * 2] ?? 0) - (samples[(frame - 1) * 2] ?? 0))
        // The ramp itself falls once per period; such a fall is not a seam.
        if (step > 1) continue
        if (Math.abs(frame - seam) < 600) largestStepAtSeam = Math.max(largestStepAtSeam, step)
        else largestStepElsewhere = Math.max(largestStepElsewhere, step)
      }
      expect(largestStepAtSeam, `${stretch.speedPercent} %`).toBeLessThanOrEqual(largestStepElsewhere * 4 + 0.01)
    }
  })
})

describe('reading prepared sound', () => {
  it('returns any window sample-accurately, across seams', async () => {
    const opened = await open('audio.wav')
    for (const { first, count } of [
      { first: 0, count: 1 },
      { first: 1, count: 480 },
      { first: 65_530, count: 12 },
      { first: 47_999, count: 4801 },
      { first: 95_990, count: 10 },
    ]) {
      const samples = await window(opened, first, count)
      expect(samples.length).toBe(count * 2)
      for (let index = 0; index < count; index++) {
        expect(samples[index * 2]).toBe(ramp(first + index).left)
        expect(samples[index * 2 + 1]).toBe(ramp(first + index).right)
      }
    }
  })

  it('is silent before the start and after the end', async () => {
    const opened = await open('audio.wav')
    const early = await window(opened, -5, 8)
    expect([...early.subarray(0, 10)]).toEqual(Array(10).fill(0))
    expect(early[10]).toBe(ramp(0).left)
    expect(early[14]).toBe(ramp(2).left)

    const late = await window(opened, RAMP_SAMPLES - 2, 6)
    expect(late[0]).toBe(ramp(RAMP_SAMPLES - 2).left)
    expect(late[2]).toBe(ramp(RAMP_SAMPLES - 1).left)
    expect([...late.subarray(4)]).toEqual(Array(8).fill(0))

    expect([...(await window(opened, -100, 10))]).toEqual(Array(20).fill(0))
    expect([...(await window(opened, RAMP_SAMPLES + 50, 10))]).toEqual(Array(20).fill(0))
  })
})

describe('waveform', () => {
  it('holds one lowest/highest pair per 480 samples', async () => {
    const directory = await mkdtemp(join(scratch, 'waveform-'))
    const cache = createDiskCache(directory, PLENTY_OF_ROOM)
    await buildWaveform(ffmpeg, { path: mediaPath('audio.wav'), containerStart: 0 }, directory, cache, new AbortController().signal)
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

describe('a twenty-hour project', () => {
  const SAMPLE_RATE = 48_000
  const MINUTE_SAMPLES = 60 * SAMPLE_RATE
  const SECOND_TICKS = SAMPLE_RATE * TICKS_PER_SAMPLE
  // Room for what is needed around one playhead and a little more, so seeking far has to remove what was prepared before.
  const LIMIT_BYTES = 200 * 1024 * 1024
  const PREPARED_READ_MS = 150

  async function bytesOnDisk(directory: string): Promise<number> {
    let total = 0
    for (const entry of await readdir(directory, { withFileTypes: true, recursive: true })) {
      if (entry.isFile()) total += (await stat(join(entry.parentPath, entry.name))).size
    }
    return total
  }

  it('prepares around the playhead wherever it is, and stays within the cache limit', async () => {
    const directory = join(scratch, 'long-project')
    const cache = createDiskCache(join(directory, 'cache'), LIMIT_BYTES)
    const session = new MediaSession(ffmpeg, cache)
    const duration = LONG_MINUTES * 60 * SECOND_TICKS
    const projectPath = join(directory, 'long.json')
    const reference = { id: 'long', path: mediaPath('audio-twenty-hours.mp4'), relativePath: '' }
    await writeProjectFile(projectPath, projectOf([track('sound', [audioClip('long', 0, duration, { mediaId: 'long' })])], [reference]))
    await session.loadProject(projectPath, true)
    const range = { mediaId: 'long', use: 'sound', timelineStart: 0, timelineEnd: duration, sourceStart: 0, speedPercent: 100, isLooping: false } as const

    try {
      for (const minute of [0, 600, LONG_MINUTES - 1]) {
        await session.want({ playhead: minute * 60 * SECOND_TICKS, ranges: [range] })
        await session.whenPrepared()
        expect(cache.totalBytes(), `minute ${minute}`).toBeLessThanOrEqual(LIMIT_BYTES)
        expect(await bytesOnDisk(cache.directory), `minute ${minute}`).toBeLessThanOrEqual(LIMIT_BYTES)

        const startedAt = performance.now()
        const firstSample = minute * MINUTE_SAMPLES + (LONG_CLICK_SECOND - 1) * SAMPLE_RATE
        const samples = await session.audio('long', firstSample, 2 * SAMPLE_RATE)
        expect(performance.now() - startedAt, `minute ${minute}`).toBeLessThan(PREPARED_READ_MS)
        if (samples === undefined) throw new Error('The long file has no sound')
        let click = -1
        for (let index = 0; index < samples.length / 2 && click < 0; index++) {
          if (Math.abs(samples[index * 2] ?? 0) > 0.1) click = index
        }
        expect(click, `minute ${minute}`).toBe(SAMPLE_RATE)
      }
      expect(cache.has(audioSegmentPath(join(cache.directory, (await readdir(cache.directory))[0] ?? ''), 0))).toBe(false)
    } finally {
      await session.dispose()
    }
  }, 120_000)
})

describe('a project that was never saved', () => {
  it('prepares the sound and the pictures of a file imported into it', async () => {
    const cache = createDiskCache(join(scratch, 'untitled-cache'), PLENTY_OF_ROOM)
    const session = new MediaSession(ffmpeg, cache)
    try {
      const added = await session.addMedia(mediaPath('h264.mp4'))
      if (added.info.kind === 'image') throw new Error('The test file was read as an image')
      const end = added.info.duration
      await session.want({
        playhead: 0,
        ranges: [
          { mediaId: added.id, use: 'picture', timelineStart: 0, timelineEnd: end, sourceStart: 0, speedPercent: 100, isLooping: false },
          { mediaId: added.id, use: 'sound', timelineStart: 0, timelineEnd: end, sourceStart: 0, speedPercent: 100, isLooping: false },
        ],
      })
      await session.whenPrepared()
      expect(await session.preparation()).toEqual({ [added.id]: { progress: 1, hasFailed: false } })
    } finally {
      await session.dispose()
    }
  }, 30_000)
})
