import { describe, expect, it } from 'vitest'
import type { MediaInfo } from '../shared/mediaProtocol.js'
import type { AudioClip, Clip, GroupClip, Project, Track, VideoClip } from '../shared/project.js'
import { LIMITER_CEILING, LIMITER_WINDOW, cachedAudioReader, mix, soundRanges, type AudioReader } from './mixer.js'
import type { MediaStates } from './resolve.js'

const SECOND = 24_000_000
const TICKS_PER_SAMPLE = 500
const FRAME_2997 = 800_800

const SOUND: MediaInfo = { kind: 'audio', duration: 60 * SECOND, containerStart: 0, audio: { channels: 2, sampleRate: 48_000, codec: 'pcm', seeksExactly: true } }
const MEDIA: MediaStates = {
  voice: { info: SOUND },
  music: { info: SOUND },
  loud: { info: SOUND },
  silentVideo: { info: { kind: 'video', duration: 60 * SECOND, containerStart: 0, video: { width: 16, height: 16, frameDuration: 800_000, frameCount: 1800, startOffset: 0, seekPreroll: 0, isVariableFrameRate: false, hasAlpha: false, colorMatrix: 'bt709', colorRange: 'tv', transfer: 'sdr', codec: 'h264' } } },
  broken: { error: 'unreadable', isMissing: false },
}

function sourceSample(mediaId: string, index: number, channel: number): number {
  if (index < 0) return 0
  const pitch = mediaId === 'voice' ? 0.031 : 0.0173
  const level = mediaId === 'loud' ? 0.95 : 0.3
  return Math.fround(Math.sin(index * pitch + channel) * level)
}

const readSource: AudioReader = async (mediaId, firstSample, sampleCount) => {
  const samples = new Float32Array(sampleCount * 2)
  for (let index = 0; index < sampleCount; index++) {
    samples[index * 2] = sourceSample(mediaId, firstSample + index, 0)
    samples[index * 2 + 1] = sourceSample(mediaId, firstSample + index, 1)
  }
  return samples
}

function audioClip(overrides: Partial<AudioClip> = {}): AudioClip {
  return { id: 'clip', type: 'audio', mediaId: 'voice', start: 0, duration: 2 * SECOND, sourceStart: 0, speedPercent: 100, volume: 1, ...overrides }
}

function project(...tracks: Clip[][]): Project {
  const built: Track[] = tracks.map((clips, index) => ({ id: `t${index}`, name: '', hidden: false, locked: false, muted: false, clips }))
  return { version: 1, canvas: { width: 1920, height: 1080, frameRate: { num: 30, den: 1 } }, media: [], tracks: built }
}

function mixRange(mixedProject: Project, firstSample: number, sampleCount: number): Promise<Float32Array> {
  return mix(mixedProject, MEDIA, firstSample, sampleCount, readSource)
}

async function mixInBlocks(mixedProject: Project, firstSample: number, sampleCount: number, blockSize: number): Promise<Float32Array> {
  const joined = new Float32Array(sampleCount * 2)
  for (let done = 0; done < sampleCount; done += blockSize) {
    const count = Math.min(blockSize, sampleCount - done)
    joined.set(await mixRange(mixedProject, firstSample + done, count), done * 2)
  }
  return joined
}

function sameBits(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index++) {
    if (!Object.is(a[index], b[index])) return false
  }
  return true
}

function peakOf(samples: Float32Array): number {
  let peak = 0
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample))
  return peak
}

describe('mix', () => {
  it('plays a clip sample for sample, and nothing outside it', async () => {
    const clip = audioClip({ start: 1000 * TICKS_PER_SAMPLE, duration: 2000 * TICKS_PER_SAMPLE, sourceStart: 300 * TICKS_PER_SAMPLE })
    const mixed = await mixRange(project([clip]), 990, 2030)
    for (let index = 0; index < 2030; index++) {
      const timelineSample = 990 + index
      const isInside = timelineSample >= 1000 && timelineSample < 3000
      const expected = isInside ? sourceSample('voice', timelineSample - 1000 + 300, 0) : 0
      expect(mixed[index * 2], `sample ${timelineSample}`).toBe(expected)
    }
    expect(mixed[11 * 2 + 1]).toBe(sourceSample('voice', 301, 1))
  })

  it('starts on the first sample at or after a clip start that falls between samples', async () => {
    const clip = audioClip({ start: FRAME_2997, duration: 10 * FRAME_2997 })
    const mixed = await mixRange(project([clip]), 1600, 4)
    expect([mixed[0], mixed[2]]).toEqual([0, 0])
    expect(mixed[4]).toBe(sourceSample('voice', 0, 0))
    expect(mixed[6]).toBe(sourceSample('voice', 1, 0))
  })

  it('applies volume and sample-accurate fades', async () => {
    const clip = audioClip({ duration: 4000 * TICKS_PER_SAMPLE, volume: 0.5, volumeFadeIn: 1000 * TICKS_PER_SAMPLE, volumeFadeOut: 2000 * TICKS_PER_SAMPLE })
    const mixed = await mixRange(project([clip]), 0, 4000)
    expect(mixed[0]).toBe(0)
    expect(mixed[250 * 2]).toBe(Math.fround(sourceSample('voice', 250, 0) * (0.5 * 0.25)))
    expect(mixed[1500 * 2]).toBe(Math.fround(sourceSample('voice', 1500, 0) * 0.5))
    expect(mixed[3000 * 2]).toBe(Math.fround(sourceSample('voice', 3000, 0) * (0.5 * 0.5)))
    expect(mixed[3999 * 2]).toBe(Math.fround(sourceSample('voice', 3999, 0) * (0.5 * (1 / 2000))))
  })

  it('adds any number of clips together', async () => {
    const tracks = [[audioClip({ id: 'a' })], [audioClip({ id: 'b', mediaId: 'music', volume: 0.5 })], [audioClip({ id: 'c', mediaId: 'music', sourceStart: 5000 * TICKS_PER_SAMPLE, volume: 0.25 })]]
    const mixed = await mixRange(project(...tracks), 100, 10)
    const expected = sourceSample('voice', 103, 1) + sourceSample('music', 103, 1) * 0.5 + sourceSample('music', 5103, 1) * 0.25
    expect(mixed[3 * 2 + 1]).toBe(Math.fround(expected))
  })

  it('plays the sound of a video clip and skips what cannot sound', async () => {
    const video: VideoClip = { id: 'v', type: 'video', mediaId: 'voice', start: 0, duration: SECOND, sourceStart: 0, speedPercent: 100, volume: 1, transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 }, opacity: 1 }
    expect((await mixRange(project([video]), 50, 1))[0]).toBe(sourceSample('voice', 50, 0))

    const silent = project(
      [audioClip({ id: 'fast', speedPercent: 401 })],
      [audioClip({ id: 'no-audio', mediaId: 'silentVideo' })],
      [audioClip({ id: 'failed', mediaId: 'broken' })],
      [audioClip({ id: 'unknown', mediaId: 'nowhere' })],
    )
    expect(peakOf(await mixRange(silent, 0, 2000))).toBe(0)

    const muted = project([audioClip()])
    muted.tracks[0]!.muted = true
    expect(peakOf(await mixRange(muted, 0, 2000))).toBe(0)
  })
})

describe('identical samples for playback and export', () => {
  const quiet = project([audioClip({ start: 3 * FRAME_2997, volumeFadeIn: SECOND / 2 })], [audioClip({ id: 'music', mediaId: 'music', start: 0, duration: 3 * SECOND, volume: 0.6, volumeFadeOut: SECOND })])
  const overloaded = project([audioClip({ mediaId: 'loud' })], [audioClip({ id: 'b', mediaId: 'loud', sourceStart: 777 * TICKS_PER_SAMPLE })], [audioClip({ id: 'c', mediaId: 'music', start: SECOND / 2 })])

  it.each([
    ['a quiet mix', quiet],
    ['a mix the limiter is working on', overloaded],
  ])('%s is bit-identical however it is cut into blocks', async (_label, mixedProject) => {
    const whole = await mixRange(mixedProject, 0, 60_000)
    for (const blockSize of [1, 128, 479, 2048, 4801]) {
      const sampleCount = blockSize === 1 ? 1500 : 60_000
      const blocks = await mixInBlocks(mixedProject, 0, sampleCount, blockSize)
      expect(sameBits(blocks, whole.subarray(0, sampleCount * 2)), `blocks of ${blockSize}`).toBe(true)
    }
  })

  it('is bit-identical wherever mixing starts', async () => {
    const whole = await mixRange(overloaded, 0, 60_000)
    for (const start of [1, 239, 240, 12_345, 47_999]) {
      const later = await mixRange(overloaded, start, 5000)
      expect(sameBits(later, whole.subarray(start * 2, (start + 5000) * 2)), `start ${start}`).toBe(true)
    }
  })

  it('is unchanged by splitting a clip at a frame boundary (US-22)', async () => {
    const whole = audioClip({ start: 7 * FRAME_2997, duration: 90 * FRAME_2997, sourceStart: 12_345, volume: 0.8, volumeFadeIn: 10 * FRAME_2997, volumeFadeOut: 10 * FRAME_2997 })
    const cut = whole.start + 41 * FRAME_2997
    const { volumeFadeOut: _fadeOut, ...withoutFadeOut } = whole
    const { volumeFadeIn: _fadeIn, ...withoutFadeIn } = whole
    const first: AudioClip = { ...withoutFadeOut, id: 'first', duration: cut - whole.start }
    const second: AudioClip = { ...withoutFadeIn, id: 'second', start: cut, duration: whole.start + whole.duration - cut, sourceStart: whole.sourceStart + (cut - whole.start) }

    const unsplit = await mixRange(project([whole]), 0, 170_000)
    const split = await mixRange(project([first, second]), 0, 170_000)
    expect(sameBits(split, unsplit)).toBe(true)
  })
})

describe('volume keyframes', () => {
  it('follows the keyframes sample by sample, with their easing', async () => {
    const ramp = audioClip({ keyframes: { volume: [{ time: 0, value: 0, easing: 'linear' }, { time: 1000 * TICKS_PER_SAMPLE, value: 2, easing: 'hold' }, { time: 1500 * TICKS_PER_SAMPLE, value: 0.5, easing: 'linear' }] } })
    const mixed = await mixRange(project([ramp]), 0, 2000)
    for (const sample of [0, 1, 250, 999]) {
      const expected = sourceSample('voice', sample, 0) * (2 * ((sample * TICKS_PER_SAMPLE) / (1000 * TICKS_PER_SAMPLE)))
      expect(mixed[sample * 2], `sample ${sample}`).toBe(Math.fround(expected))
    }
    expect(mixed[1200 * 2]).toBe(Math.fround(sourceSample('voice', 1200, 0) * 2))
    expect(mixed[1499 * 2]).toBe(Math.fround(sourceSample('voice', 1499, 0) * 2))
    expect(mixed[1500 * 2]).toBe(Math.fround(sourceSample('voice', 1500, 0) * 0.5))
    expect(mixed[1999 * 2 + 1]).toBe(Math.fround(sourceSample('voice', 1999, 1) * 0.5))
  })

  it('multiplies with the fades and stays the same curve after a split', async () => {
    const whole = audioClip({ start: 3 * FRAME_2997, duration: 60 * FRAME_2997, volumeFadeIn: 5 * FRAME_2997, keyframes: { volume: [{ time: 10 * FRAME_2997, value: 0.2, easing: 'easeInOut' }, { time: 50 * FRAME_2997, value: 1.6, easing: 'linear' }] } })
    const local = 27 * FRAME_2997
    const first: AudioClip = { ...whole, id: 'first', duration: local }
    const { volumeFadeIn: _fadeIn, ...withoutFadeIn } = whole
    const shifted = whole.keyframes?.volume?.map((keyframe) => ({ ...keyframe, time: keyframe.time - local })) ?? []
    const second: AudioClip = { ...withoutFadeIn, id: 'second', start: whole.start + local, duration: whole.duration - local, sourceStart: local, keyframes: { volume: shifted } }

    const unsplit = await mixRange(project([whole]), 0, 110_000)
    expect(sameBits(await mixRange(project([first, second]), 0, 110_000), unsplit)).toBe(true)
    expect(peakOf(unsplit)).toBeGreaterThan(0.3)
  })
})

// The sound at another speed, as the media process would hand it out: every sample tells its place in the stretched sound and how it was stretched.
const readStretched: AudioReader = async (mediaId, firstSample, sampleCount, stretch) => {
  if (stretch === undefined) return readSource(mediaId, firstSample, sampleCount)
  const samples = new Float32Array(sampleCount * 2)
  for (let index = 0; index < sampleCount; index++) {
    samples[index * 2] = (firstSample + index) / 1_000_000
    samples[index * 2 + 1] = (stretch.keepsPitch ? stretch.speedPercent : -stretch.speedPercent) / 1_000_000
  }
  return samples
}

describe('clip speed', () => {
  function mixStretched(mixedProject: Project, firstSample: number, sampleCount: number): Promise<Float32Array> {
    return mix(mixedProject, MEDIA, firstSample, sampleCount, readStretched)
  }

  it('reads a faster clip from the sound at that speed, counted from the start of the file', async () => {
    const fast = audioClip({ start: 100 * TICKS_PER_SAMPLE, sourceStart: 1000 * TICKS_PER_SAMPLE, speedPercent: 200, volume: 0.25 })
    const mixed = await mixStretched(project([fast]), 0, 400)
    expect(mixed[99 * 2]).toBe(0)
    expect(mixed[100 * 2]).toBe(Math.fround(Math.fround(500 / 1_000_000) * 0.25))
    expect(mixed[399 * 2]).toBe(Math.fround(Math.fround(799 / 1_000_000) * 0.25))
    expect(mixed[100 * 2 + 1]).toBe(Math.fround(Math.fround(200 / 1_000_000) * 0.25))
  })

  it('lets the pitch follow the speed when the clip says so', async () => {
    const tape = audioClip({ speedPercent: 50, changesPitch: true })
    expect((await mixStretched(project([tape]), 0, 10))[1]).toBe(Math.fround(-50 / 1_000_000))
  })

  it('is unchanged by splitting a clip that plays at another speed', async () => {
    for (const speedPercent of [25, 150, 333]) {
      const whole = audioClip({ start: 7 * FRAME_2997, duration: 90 * FRAME_2997, sourceStart: 12_300, speedPercent })
      const local = 41 * FRAME_2997
      const first: AudioClip = { ...whole, id: 'first', duration: local }
      const second: AudioClip = { ...whole, id: 'second', start: whole.start + local, duration: whole.duration - local, sourceStart: whole.sourceStart + (local / 100) * speedPercent }
      const unsplit = await mixStretched(project([whole]), 0, 170_000)
      expect(sameBits(await mixStretched(project([first, second]), 0, 170_000), unsplit), `${speedPercent} %`).toBe(true)
    }
  })

  it('is silent above four times the speed until the sound is switched on', async () => {
    expect(peakOf(await mixStretched(project([audioClip({ speedPercent: 400 })]), 0, 100))).toBeGreaterThan(0)
    expect(peakOf(await mixStretched(project([audioClip({ speedPercent: 5000 })]), 0, 100))).toBe(0)
    expect(peakOf(await mixStretched(project([audioClip({ speedPercent: 5000, hasFastSound: true })]), 0, 100))).toBeGreaterThan(0)
  })
})

describe('groups', () => {
  function group(overrides: Partial<GroupClip>, ...tracks: Clip[][]): GroupClip {
    const inner: Track[] = tracks.map((clips, index) => ({ id: `g${index}`, name: '', hidden: false, locked: false, muted: false, clips }))
    return { id: 'group', type: 'group', start: 0, duration: 4 * SECOND, transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 }, opacity: 1, volume: 1, tracks: inner, ...overrides }
  }

  it('plays its members at the time the group gives them, and only while the group is there', async () => {
    const member = audioClip({ start: 300 * TICKS_PER_SAMPLE, duration: 1000 * TICKS_PER_SAMPLE })
    const grouped = group({ start: 2000 * TICKS_PER_SAMPLE, duration: 600 * TICKS_PER_SAMPLE, contentStart: 500 * TICKS_PER_SAMPLE }, [member])
    const mixed = await mixRange(project([grouped]), 0, 4000)
    expect(mixed[1999 * 2]).toBe(0)
    // The group shows its content from sample 500 on, where the member has already played 200 samples.
    expect(mixed[2000 * 2]).toBe(sourceSample('voice', 200, 0))
    expect(mixed[2599 * 2]).toBe(sourceSample('voice', 799, 0))
    expect(mixed[2600 * 2]).toBe(0)
  })

  it('multiplies the volume, fades and keyframes of every group around a sound', async () => {
    const member = audioClip({ volume: 0.5 })
    const inner = group({ id: 'inner', volume: 0.5, keyframes: { volume: [{ time: 0, value: 0, easing: 'linear' }, { time: 1000 * TICKS_PER_SAMPLE, value: 1, easing: 'linear' }] } }, [member])
    const outer = group({ id: 'outer', volume: 2, volumeFadeIn: 2000 * TICKS_PER_SAMPLE }, [inner])
    const mixed = await mixRange(project([outer]), 0, 3000)
    expect(mixed[500 * 2]).toBe(Math.fround(sourceSample('voice', 500, 0) * 0.5 * 0.5 * (2 * 0.25)))
    expect(mixed[2500 * 2]).toBe(Math.fround(sourceSample('voice', 2500, 0) * 0.5 * 2))
  })

  it('leaves out the members on a muted track', async () => {
    const grouped = group({}, [audioClip()])
    grouped.tracks[0]!.muted = true
    expect(peakOf(await mixRange(project([grouped]), 0, 2000))).toBe(0)
  })
})

describe('master limiter', () => {
  const overloaded = project([audioClip({ mediaId: 'loud' })], [audioClip({ id: 'b', mediaId: 'loud', sourceStart: 777 * TICKS_PER_SAMPLE })], [audioClip({ id: 'c', mediaId: 'loud', sourceStart: 4321 * TICKS_PER_SAMPLE })])

  it('never lets the mix exceed the ceiling', async () => {
    const unlimitedPeak = 0.95 * 3
    const mixed = await mixRange(overloaded, 0, 96_000)
    expect(peakOf(mixed)).toBeLessThanOrEqual(LIMITER_CEILING)
    expect(peakOf(mixed)).toBeGreaterThan(LIMITER_CEILING * 0.9)
    expect(unlimitedPeak).toBeGreaterThan(1)
  })

  it('leaves a mix under the ceiling untouched', async () => {
    const mixed = await mixRange(project([audioClip({ volume: 2 })]), 0, 5000)
    for (let index = 0; index < 5000; index += 13) {
      expect(mixed[index * 2]).toBe(Math.fround(sourceSample('voice', index, 0) * 2))
    }
  })

  it('only acts close to a peak', async () => {
    const burst = audioClip({ id: 'burst', mediaId: 'loud', start: 20_000 * TICKS_PER_SAMPLE, duration: 100 * TICKS_PER_SAMPLE, volume: 2 })
    const bed = audioClip({ id: 'bed', mediaId: 'music', duration: 2 * SECOND, volume: 0.5 })
    const withBurst = await mixRange(project([bed], [burst]), 0, 40_000)
    const bedOnly = await mixRange(project([bed]), 0, 40_000)

    const reach = 2 * LIMITER_WINDOW
    expect(sameBits(withBurst.subarray(0, (20_000 - reach) * 2), bedOnly.subarray(0, (20_000 - reach) * 2))).toBe(true)
    expect(sameBits(withBurst.subarray((20_100 + reach) * 2), bedOnly.subarray((20_100 + reach) * 2))).toBe(true)
    expect(peakOf(withBurst.subarray(20_000 * 2, 20_100 * 2))).toBeLessThanOrEqual(LIMITER_CEILING)
    const before = Math.abs(withBurst[(20_000 - LIMITER_WINDOW) * 2] ?? 0)
    expect(before).toBeLessThan(Math.abs(bedOnly[(20_000 - LIMITER_WINDOW) * 2] ?? 0))
    expect(before).toBeGreaterThan(0)
  })
})

describe('cachedAudioReader', () => {
  it('returns the same samples as the reader it wraps, across chunk boundaries', async () => {
    const cached = cachedAudioReader(readSource, 4 * 48_000 * 8)
    for (const { first, count } of [
      { first: 0, count: 10 },
      { first: 47_990, count: 30 },
      { first: -20, count: 50 },
      { first: 95_000, count: 100_000 },
    ]) {
      const direct = await readSource('voice', first, count)
      const viaCache = await cached('voice', first, count)
      expect(viaCache !== undefined && direct !== undefined && sameBits(viaCache, direct), `from ${first}`).toBe(true)
    }
  })

  it('asks the source once per chunk', async () => {
    const requests: string[] = []
    const counting: AudioReader = (mediaId, firstSample, sampleCount) => {
      requests.push(`${mediaId}@${firstSample}+${sampleCount}`)
      return readSource(mediaId, firstSample, sampleCount)
    }
    const cached = cachedAudioReader(counting, 4 * 48_000 * 8)
    await cached('voice', 100, 2048)
    await cached('voice', 2148, 2048)
    await cached('voice', 47_000, 2048)
    expect(requests).toEqual(['voice@0+48000', 'voice@48000+48000'])
  })

  it('asks again for a chunk whose read failed', async () => {
    let failures = 1
    const flaky: AudioReader = async (mediaId, firstSample, sampleCount) => {
      if (failures > 0) {
        failures -= 1
        throw new Error('The media process stopped.')
      }
      return readSource(mediaId, firstSample, sampleCount)
    }
    const cached = cachedAudioReader(flaky, 4 * 48_000 * 8)
    await expect(cached('voice', 0, 100)).rejects.toThrow('The media process stopped.')
    const retried = await cached('voice', 0, 100)
    const direct = await readSource('voice', 0, 100)
    expect(retried !== undefined && direct !== undefined && sameBits(retried, direct)).toBe(true)
  })

  it('passes on that a media file has no sound', async () => {
    const cached = cachedAudioReader(async () => undefined, 1024)
    expect(await cached('voice', 0, 10)).toBeUndefined()
  })
})

describe('soundRanges', () => {
  it('lists what the mix plays, with the stretch of a clip at another speed, and leaves out what is not heard', () => {
    const muted: Track = { id: 'muted', name: '', hidden: false, locked: false, muted: true, clips: [audioClip({ id: 'quiet', mediaId: 'music' })] }
    const heard = project(
      [audioClip({ id: 'voice', start: SECOND, duration: 2 * SECOND, sourceStart: 3 * SECOND })],
      [audioClip({ id: 'fast', mediaId: 'music', speedPercent: 200 }), audioClip({ id: 'timelapse', mediaId: 'music', start: 4 * SECOND, speedPercent: 1000 })],
    )
    heard.tracks.push(muted)
    expect(soundRanges(heard, MEDIA)).toEqual([
      { mediaId: 'voice', use: 'sound', timelineStart: SECOND, timelineEnd: 3 * SECOND, sourceStart: 3 * SECOND, speedPercent: 100, isLooping: false },
      { mediaId: 'music', use: 'sound', timelineStart: 0, timelineEnd: 2 * SECOND, sourceStart: 0, speedPercent: 200, isLooping: false, stretch: { speedPercent: 200, keepsPitch: true } },
    ])
  })

  it('counts a member of a group from where the group starts showing it', () => {
    const inner = audioClip({ id: 'inner', start: 0, duration: 5 * SECOND })
    const group: GroupClip = { id: 'group', type: 'group', start: 10 * SECOND, duration: 2 * SECOND, contentStart: SECOND, transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 }, opacity: 1, volume: 1, tracks: project([inner]).tracks }
    expect(soundRanges(project([group]), MEDIA)).toEqual([{ mediaId: 'voice', use: 'sound', timelineStart: 10 * SECOND, timelineEnd: 12 * SECOND, sourceStart: SECOND, speedPercent: 100, isLooping: false }])
  })
})
