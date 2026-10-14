import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { bundledFfmpeg } from '../../test/helpers.js'
import { createDiskCache } from './cache.js'
import { pixelLayoutOf, type ExportFormat, type Size } from '../shared/exportPresets.js'
import { CACHE_LIMIT_BYTES } from '../shared/limits.js'
import { EncoderError, startEncoder, temporaryPathFor } from './encoder.js'
import { MediaSession } from './mediaStore.js'
import { probeMedia } from './probe.js'

const ffmpeg = bundledFfmpeg()
const scratch = await mkdtemp(join(tmpdir(), 'encoder-'))
const SIZE = { width: 64, height: 36 }
const FRAME_RATE = { num: 30, den: 1 }
const DEFAULTS = { format: 'mp4', encoder: 'x264', frameRate: FRAME_RATE, quality: 'high', hasAudio: true } as const
const SAMPLES_PER_FRAME = 1600

afterAll(() => rm(scratch, { recursive: true, force: true }))

// Video formats take YUV 4:2:0 pictures, a GIF and a PNG take RGBA.
function picture(format: ExportFormat, size: Size, level: number): ArrayBuffer {
  const bytesPerPixel = pixelLayoutOf(format) === 'yuv420p' ? 1.5 : 4
  return new Uint8Array(size.width * size.height * bytesPerPixel).fill(level).buffer
}

function grayFrame(level: number): ArrayBuffer {
  return picture('mp4', SIZE, level)
}

describe('startEncoder', () => {
  it('writes the file under its final name only when finished', async () => {
    const path = join(scratch, 'finished.mp4')
    const encoder = startEncoder(ffmpeg, { path, ...SIZE, ...DEFAULTS })
    for (let frame = 0; frame < 45; frame++) {
      await encoder.write(grayFrame(frame * 5), new Float32Array(SAMPLES_PER_FRAME * 2))
      expect(existsSync(path)).toBe(false)
    }
    expect(existsSync(temporaryPathFor(path))).toBe(true)
    await encoder.finish()
    expect(existsSync(path)).toBe(true)
    expect(existsSync(temporaryPathFor(path))).toBe(false)

    const info = await probeMedia(ffmpeg, path)
    expect(info).toMatchObject({ kind: 'video', video: { width: 64, height: 36, frameCount: 45, codec: 'h264' }, audio: { channels: 2, sampleRate: 48_000, codec: 'aac' } })
  })

  it('leaves no file behind when cancelled', async () => {
    const path = join(scratch, 'cancelled.mp4')
    const encoder = startEncoder(ffmpeg, { path, ...SIZE, ...DEFAULTS })
    for (let frame = 0; frame < 10; frame++) await encoder.write(grayFrame(128), new Float32Array(SAMPLES_PER_FRAME * 2))
    await encoder.cancel()
    expect(existsSync(path)).toBe(false)
    expect(existsSync(temporaryPathFor(path))).toBe(false)
    await encoder.cancel()
  })

  it.each([
    { format: 'webm', encoder: 'x264', expected: { kind: 'video', video: { width: 64, height: 36, codec: 'vp9' }, audio: { channels: 2, codec: 'opus' } } },
    { format: 'mp4', encoder: 'hardware', expected: { kind: 'video', video: { width: 64, height: 36, codec: 'h264' }, audio: { codec: 'aac' } } },
    { format: 'gif', encoder: 'x264', expected: { kind: 'video', video: { width: 65, height: 37, codec: 'gif' } } },
    { format: 'm4a', encoder: 'x264', expected: { kind: 'audio', audio: { channels: 2, sampleRate: 48_000, codec: 'aac' } } },
    { format: 'mp3', encoder: 'x264', expected: { kind: 'audio', audio: { channels: 2, codec: 'mp3' } } },
    { format: 'wav', encoder: 'x264', expected: { kind: 'audio', audio: { channels: 2, sampleRate: 48_000, codec: 'pcm_s16le' } } },
  ] as const)('writes $format files by $encoder', async ({ format, encoder: encodedBy, expected }) => {
    const path = join(scratch, `formats.${format}`)
    const size = format === 'gif' ? { width: 65, height: 37 } : SIZE
    const encoder = startEncoder(ffmpeg, { path, ...size, ...DEFAULTS, format, encoder: encodedBy })
    for (let frame = 0; frame < 30; frame++) {
      await encoder.write(picture(format, size, frame * 8), new Float32Array(SAMPLES_PER_FRAME * 2).fill(0.25))
    }
    await encoder.finish()
    expect(await probeMedia(ffmpeg, path)).toMatchObject(expected)
  })

  it('writes the picture of a PNG at its own size, which may be odd', async () => {
    const path = join(scratch, 'still.png')
    const encoder = startEncoder(ffmpeg, { path, width: 65, height: 37, ...DEFAULTS, format: 'png', hasAudio: false })
    await encoder.write(picture('png', { width: 65, height: 37 }, 200), new Float32Array(0))
    await encoder.finish()
    expect(await probeMedia(ffmpeg, path)).toEqual({ kind: 'image', width: 65, height: 37, hasAlpha: false })
  })

  it('refuses a picture whose size is not the one it was started with', async () => {
    const encoder = startEncoder(ffmpeg, { path: join(scratch, 'wrong-size.mp4'), ...SIZE, ...DEFAULTS })
    await expect(encoder.write(picture('png', SIZE, 0), new Float32Array(SAMPLES_PER_FRAME * 2))).rejects.toThrow(EncoderError)
    await encoder.cancel()
  })

  it('refuses a picture size H.264 cannot hold', () => {
    expect(() => startEncoder(ffmpeg, { path: join(scratch, 'odd.mp4'), width: 65, height: 36, ...DEFAULTS })).toThrow(EncoderError)
  })

  it('reports why FFmpeg stopped when the target cannot be written', async () => {
    const encoder = startEncoder(ffmpeg, { path: '/nonexistent-directory/out.mp4', ...SIZE, ...DEFAULTS })
    async function writeUntilFailure(): Promise<void> {
      for (let frame = 0; frame < 500; frame++) await encoder.write(grayFrame(128), new Float32Array(SAMPLES_PER_FRAME * 2))
    }
    await expect(writeUntilFailure()).rejects.toThrow(/No such file or directory/)
    await encoder.cancel()
  })
})

describe('MediaSession exports', () => {
  it('removes a running export when its window goes away', async () => {
    const path = join(scratch, 'abandoned.mp4')
    const session = new MediaSession(ffmpeg, createDiskCache(join(scratch, 'cache'), CACHE_LIMIT_BYTES))
    const jobId = await session.exportStart({ path, ...SIZE, ...DEFAULTS })
    for (let frame = 0; frame < 10; frame++) await session.exportWrite(jobId, grayFrame(64), new Float32Array(SAMPLES_PER_FRAME * 2))
    await session.dispose()
    expect(existsSync(path)).toBe(false)
    expect(existsSync(temporaryPathFor(path))).toBe(false)
  })
})
