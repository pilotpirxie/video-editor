import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { bundledFfmpeg } from '../../test/helpers.js'
import { EncoderError, startEncoder, temporaryPathFor } from './encoder.js'
import { MediaSession } from './mediaStore.js'
import { probeMedia } from './probe.js'

const ffmpeg = bundledFfmpeg()
const scratch = await mkdtemp(join(tmpdir(), 'encoder-'))
const SIZE = { width: 64, height: 36 }
const FRAME_RATE = { num: 30, den: 1 }
const SAMPLES_PER_FRAME = 1600

afterAll(() => rm(scratch, { recursive: true, force: true }))

function grayFrame(level: number): ArrayBuffer {
  const pixels = new Uint8Array(SIZE.width * SIZE.height * 4).fill(level)
  return pixels.buffer
}

describe('startEncoder', () => {
  it('writes the file under its final name only when finished', async () => {
    const path = join(scratch, 'finished.mp4')
    const encoder = startEncoder(ffmpeg, { path, ...SIZE, frameRate: FRAME_RATE })
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
    const encoder = startEncoder(ffmpeg, { path, ...SIZE, frameRate: FRAME_RATE })
    for (let frame = 0; frame < 10; frame++) await encoder.write(grayFrame(128), new Float32Array(SAMPLES_PER_FRAME * 2))
    await encoder.cancel()
    expect(existsSync(path)).toBe(false)
    expect(existsSync(temporaryPathFor(path))).toBe(false)
    // Cancelling again, as the session does when its window closes, is harmless.
    await encoder.cancel()
  })

  it('refuses a picture size H.264 cannot hold', () => {
    expect(() => startEncoder(ffmpeg, { path: join(scratch, 'odd.mp4'), width: 65, height: 36, frameRate: FRAME_RATE })).toThrow(EncoderError)
  })

  it('reports why FFmpeg stopped when the target cannot be written', async () => {
    const encoder = startEncoder(ffmpeg, { path: '/nonexistent-directory/out.mp4', ...SIZE, frameRate: FRAME_RATE })
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
    const session = new MediaSession(ffmpeg, join(scratch, 'cache'))
    const jobId = await session.exportStart({ path, ...SIZE, frameRate: FRAME_RATE })
    for (let frame = 0; frame < 10; frame++) await session.exportWrite(jobId, grayFrame(64), new Float32Array(SAMPLES_PER_FRAME * 2))
    await session.dispose()
    expect(existsSync(path)).toBe(false)
    expect(existsSync(temporaryPathFor(path))).toBe(false)
  })
})
