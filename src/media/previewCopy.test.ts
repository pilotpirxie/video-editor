import { existsSync } from 'node:fs'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ROOT, blockColorError, bundledFfmpeg, decodeJpeg, patternFrame, pixelAt, readBarcode } from '../../test/helpers.js'
import { mediaPath } from '../../test/media/generate.js'
import { decodeFrame, type VideoSource } from './frames.js'
import { openPreviewCopy, previewSize, splitJpegFrames, type PreviewCopy } from './previewCopy.js'
import { probeMedia } from './probe.js'

const ffmpeg = bundledFfmpeg()
const scratch = await mkdtemp(join(tmpdir(), 'preview-copy-'))
const KANGAROO = join(ROOT, 'samples', 'kangaroo1920.mp4')
const REQUIRED_SPEED = 8

afterAll(() => rm(scratch, { recursive: true, force: true }))

async function sourceAt(path: string): Promise<VideoSource> {
  const info = await probeMedia(ffmpeg, path)
  if (info.kind !== 'video') throw new Error(`${path} is not a video`)
  return { path, containerStart: info.containerStart, video: info.video }
}

async function directoryFor(name: string): Promise<string> {
  return mkdtemp(join(scratch, `${name}-`))
}

async function build(name: string): Promise<{ copy: PreviewCopy; source: VideoSource; directory: string }> {
  const source = await sourceAt(mediaPath(name))
  const directory = await directoryFor(name)
  const copy = await openPreviewCopy(ffmpeg, source, directory, new AbortController().signal)
  await copy.finished
  return { copy, source, directory }
}

async function frameOrFail(copy: PreviewCopy, frame: number): Promise<Buffer> {
  const jpeg = await copy.readFrame(frame)
  if (jpeg === undefined) throw new Error(`Frame ${frame} is not prepared`)
  return jpeg
}

describe('splitJpegFrames', () => {
  const first = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9])
  const second = Buffer.from([0xff, 0xd8, 4, 0xff, 0x00, 5, 0xff, 0xd9])
  const third = Buffer.from([0xff, 0xd8, 6, 7])

  it('cuts at every seam and keeps the unfinished tail', () => {
    const { frames, rest } = splitJpegFrames(Buffer.concat([first, second, third]))
    expect(frames).toEqual([first, second])
    expect(rest).toEqual(third)
  })

  it('finds a seam that straddles two chunks, wherever the chunk boundary falls', () => {
    const stream = Buffer.concat([first, second, third])
    for (let boundary = 1; boundary < stream.length; boundary++) {
      const early = splitJpegFrames(stream.subarray(0, boundary))
      const late = splitJpegFrames(Buffer.concat([early.rest, stream.subarray(boundary)]))
      expect([...early.frames, ...late.frames], `boundary ${boundary}`).toEqual([first, second])
      expect(late.rest).toEqual(third)
    }
  })

  it('returns everything as the remainder when there is no seam', () => {
    expect(splitJpegFrames(first)).toEqual({ frames: [], rest: first })
  })
})

describe('previewSize', () => {
  it('limits the long side to 960 and never enlarges', async () => {
    expect(previewSize((await sourceAt(mediaPath('1080p.mp4'))).video)).toEqual({ width: 960, height: 540 })
    expect(previewSize((await sourceAt(mediaPath('rotated-90.mp4'))).video)).toEqual({ width: 180, height: 320 })
    expect(previewSize((await sourceAt(mediaPath('8k.mp4'))).video)).toEqual({ width: 960, height: 540 })
  })
})

describe('openPreviewCopy', () => {
  it('stores every frame as its own JPEG, in order', async () => {
    const { copy } = await build('h264.mp4')
    for (let frame = 0; frame < 60; frame++) {
      const jpeg = await frameOrFail(copy, frame)
      expect(jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]))
      expect(jpeg.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]))
      expect(readBarcode(await decodeJpeg(ffmpeg, jpeg, 320, 180)), `frame ${frame}`).toBe(frame)
    }
    expect(await copy.readFrame(60)).toBeUndefined()
    await copy.close()
  })

  it.each(['long-gop.ts', 'delayed-video.mkv', 'fps-23976.mp4', 'vp9.webm'])('numbers frames like the full-quality decoder for %s', async (name) => {
    const { copy, source } = await build(name)
    for (const frame of [0, 1, 29, 30, 47]) {
      const preview = await decodeJpeg(ffmpeg, await frameOrFail(copy, frame), 320, 180)
      expect(readBarcode(preview), `frame ${frame}`).toBe(readBarcode(await decodeFrame(ffmpeg, source, frame, 0)))
    }
    await copy.close()
  })

  it('follows a file with a hole in its timestamps the same way the decoder does', async () => {
    const { copy } = await build('mpeg4.avi')
    const pictures: number[] = []
    for (const frame of [0, 1, 2, 30]) {
      pictures.push(readBarcode(await decodeJpeg(ffmpeg, await frameOrFail(copy, frame), 320, 180)))
    }
    expect(pictures).toEqual([0, 0, 1, 29])
    await copy.close()
  })

  it('scales 1080p to 960×540', async () => {
    const { copy } = await build('1080p.mp4')
    const picture = await decodeJpeg(ffmpeg, await frameOrFail(copy, 77), 960, 540)
    expect(readBarcode(picture)).toBe(77)
    await copy.close()
  })

  it('reproduces the source colour when decoded as a JPEG', async () => {
    const { copy } = await build('h264.mp4')
    const pattern = { width: 320, height: 180, rate: '30' }
    const preview = await decodeJpeg(ffmpeg, await frameOrFail(copy, 12), 320, 180)
    // Compared by block averages: per-pixel differences are dominated by JPEG detail loss.
    const errorAgainstTruth = blockColorError(preview, await patternFrame(ffmpeg, pattern, 12, 'bt709', 'bt709'), 20)
    const errorAgainstWrongMatrix = blockColorError(preview, await patternFrame(ffmpeg, pattern, 12, 'bt709', 'bt601'), 20)
    expect(errorAgainstTruth).toBeLessThan(1.5)
    expect(errorAgainstWrongMatrix).toBeGreaterThan(4)
    await copy.close()
  })

  it('keeps alpha by stacking premultiplied colour above the alpha plane', async () => {
    const { copy } = await build('lossless-alpha.mov')
    const stacked = await decodeJpeg(ffmpeg, await frameOrFail(copy, 0), 320, 360)
    // Red bar of the card, x = 60. Alpha falls from 255 at the top row to 0 at the bottom.
    const colorTop = pixelAt(stacked, 60, 4)
    const colorMiddle = pixelAt(stacked, 60, 90)
    const colorBottom = pixelAt(stacked, 60, 175)
    expect(colorTop.red).toBeGreaterThan(225)
    expect(Math.abs(colorMiddle.red - 127)).toBeLessThan(12)
    expect(colorBottom.red).toBeLessThan(16)
    expect(colorTop.green).toBeLessThan(40)

    const alphaTop = pixelAt(stacked, 60, 180 + 4)
    const alphaMiddle = pixelAt(stacked, 60, 180 + 90)
    const alphaBottom = pixelAt(stacked, 60, 180 + 175)
    expect(alphaTop.red).toBeGreaterThan(240)
    expect(Math.abs(alphaMiddle.red - 127)).toBeLessThan(6)
    expect(alphaBottom.red).toBeLessThan(12)
    expect(Math.abs(alphaMiddle.red - alphaMiddle.green)).toBeLessThan(4)
    await copy.close()
  })

  it('serves frames while the build is still running', async () => {
    const source = await sourceAt(mediaPath('4k-long-gop.mp4'))
    const copy = await openPreviewCopy(ffmpeg, source, await directoryFor('partial'), new AbortController().signal)
    expect(await copy.readFrame(299)).toBeUndefined()

    let firstFrameSeenBeforeEnd = false
    let isFinished = false
    const finished = copy.finished.then(() => {
      isFinished = true
    })
    while (!isFinished) {
      if ((await copy.readFrame(0)) !== undefined) {
        firstFrameSeenBeforeEnd = !isFinished
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    await finished
    expect(firstFrameSeenBeforeEnd).toBe(true)
    expect(await copy.readFrame(299)).toBeDefined()
    await copy.close()
  })

  it('reuses a finished copy instead of building it again', async () => {
    const { copy, source, directory } = await build('h264.mkv')
    await copy.close()
    const builtAt = (await stat(join(directory, 'preview.mjpeg'))).mtimeMs

    const startedAt = performance.now()
    const reopened = await openPreviewCopy(ffmpeg, source, directory, new AbortController().signal)
    await reopened.finished
    expect(performance.now() - startedAt).toBeLessThan(50)
    expect((await stat(join(directory, 'preview.mjpeg'))).mtimeMs).toBe(builtAt)
    expect(readBarcode(await decodeJpeg(ffmpeg, await frameOrFail(reopened, 33), 320, 180))).toBe(33)
    await reopened.close()
  })

  it('leaves no index behind when the build is cancelled, and rebuilds next time', async () => {
    const source = await sourceAt(mediaPath('4k-long-gop.mp4'))
    const directory = await directoryFor('cancelled')
    const controller = new AbortController()
    const copy = await openPreviewCopy(ffmpeg, source, directory, controller.signal)
    setTimeout(() => controller.abort(), 100)
    await expect(copy.finished).rejects.toThrow(/cancelled/)
    await copy.close()
    expect(existsSync(join(directory, 'preview.idx'))).toBe(false)

    const rebuilt = await openPreviewCopy(ffmpeg, source, directory, new AbortController().signal)
    await rebuilt.finished
    expect(await rebuilt.readFrame(299)).toBeDefined()
    await rebuilt.close()
  })

  it.skipIf(!existsSync(KANGAROO))('prepares 1080p H.264 at 8× real time or faster', async () => {
    const info = await probeMedia(ffmpeg, KANGAROO)
    if (info.kind !== 'video') throw new Error('The sample is not a video')
    const source = { path: KANGAROO, containerStart: info.containerStart, video: info.video }
    const startedAt = performance.now()
    const copy = await openPreviewCopy(ffmpeg, source, await directoryFor('speed'), new AbortController().signal)
    await copy.finished
    const elapsedSeconds = (performance.now() - startedAt) / 1000
    const sourceSeconds = (info.video.frameCount * info.video.frameDuration) / 24_000_000
    const speed = sourceSeconds / elapsedSeconds
    console.info(`preview copy: ${sourceSeconds.toFixed(1)} s of 1080p in ${elapsedSeconds.toFixed(2)} s = ${speed.toFixed(1)}× real time`)
    expect(speed).toBeGreaterThanOrEqual(REQUIRED_SPEED)
    await copy.close()
  })
})
