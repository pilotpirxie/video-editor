import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ROOT, bundledFfmpeg, patternFrame, pixelAt, psnr, readBarcode, rotatedCounterClockwise } from '../../test/helpers.js'
import { GAP_END_FRAME, GAP_START_FRAME, LATE_JITTER_FRAME, alphaCard, hdrCard, mediaPath } from '../../test/media/generate.js'
import type { RawFrame } from '../shared/mediaProtocol.js'
import { FfmpegError } from './ffmpeg.js'
import { decodeFrame, decodeKeyframe, decodedSize, openFrameStream, type VideoSource } from './frames.js'
import { probeMedia } from './probe.js'

const ffmpeg = bundledFfmpeg()
const SMALL = { width: 320, height: 180, rate: '30' }

async function sourceOf(name: string): Promise<VideoSource> {
  const info = await probeMedia(ffmpeg, mediaPath(name))
  if (info.kind !== 'video') throw new Error(`${name} is not a video`)
  return { path: mediaPath(name), containerStart: info.containerStart, video: info.video }
}

async function frameOf(name: string, index: number, halvings = 0): Promise<RawFrame> {
  return decodeFrame(ffmpeg, await sourceOf(name), index, halvings)
}

async function expectBarcodes(name: string, indexes: readonly number[]): Promise<void> {
  const source = await sourceOf(name)
  for (const index of indexes) {
    expect(readBarcode(await decodeFrame(ffmpeg, source, index, 0)), `frame ${index}`).toBe(index)
  }
}

function sameBytes(a: RawFrame, b: RawFrame): boolean {
  return Buffer.from(a.data).equals(Buffer.from(b.data))
}

describe('decodeFrame returns exactly the requested frame', () => {
  it.each([
    'h264.mp4',
    'h264.m4v',
    'h264.mov',
    'h264.mkv',
    'h264.flv',
    'h264.ts',
    'h264.mts',
    'h264.3gp',
    'hevc.mp4',
    'prores.mov',
    'vp8.webm',
    'vp9.webm',
    'av1.mp4',
    'mjpeg.avi',
    'delayed-video.mkv',
    'anamorphic.mp4',
  ])('%s', async (name) => {
    await expectBarcodes(name, [0, 1, 2, 29, 30, 31, 58, 59])
  })

  it.each(['fps-23976.mp4', 'fps-24.mp4', 'fps-25.mp4', 'fps-2997.mp4', 'fps-50.mp4', 'fps-5994.mp4', 'fps-60.mp4', 'fps-120.mp4', 'fps-240.mp4'])('%s', async (name) => {
    await expectBarcodes(name, [0, 1, 29, 30, 31, 47])
  })

  it.each(['long-gop.mp4', 'long-gop.mkv', 'long-gop.ts'])('around every keyframe of %s', async (name) => {
    await expectBarcodes(name, [0, 1, 88, 89, 90, 91, 92, 178, 179, 180, 181, 198, 199])
  })

  it('dnxhr.mov', async () => {
    await expectBarcodes('dnxhr.mov', [0, 1, 15, 29])
  })

  it('follows the timestamps of a file with a hole in them (AVI with MP3 delay)', async () => {
    const source = await sourceOf('mpeg4.avi')
    expect(source.video.isVariableFrameRate).toBe(true)
    const shownAt = [
      { time: 0, picture: 0 },
      { time: 1, picture: 0 },
      { time: 2, picture: 1 },
      { time: 30, picture: 29 },
      { time: 59, picture: 58 },
    ]
    for (const { time, picture } of shownAt) {
      expect(readBarcode(await decodeFrame(ffmpeg, source, time, 0)), `time ${time}`).toBe(picture)
    }
  })

  it('maps frame times that turn uneven late in a file onto the even ones', async () => {
    await expectBarcodes('variable-rate-late.mp4', [0, LATE_JITTER_FRAME - 1, LATE_JITTER_FRAME, LATE_JITTER_FRAME + 1, 400, 449])
  })

  it('shows the last picture before a long gap through the whole gap', async () => {
    const source = await sourceOf('variable-rate-gap.mp4')
    const lastBefore = GAP_START_FRAME - 1
    const shownAt = [
      { frame: 100, picture: 100 },
      { frame: lastBefore, picture: lastBefore },
      { frame: GAP_START_FRAME, picture: lastBefore },
      { frame: 500, picture: lastBefore },
      { frame: GAP_END_FRAME - 1, picture: lastBefore },
      { frame: GAP_END_FRAME, picture: GAP_END_FRAME },
      { frame: 719, picture: 719 },
    ]
    for (const { frame, picture } of shownAt) {
      expect(readBarcode(await decodeFrame(ffmpeg, source, frame, 0)), `frame ${frame}`).toBe(picture)
    }

    const stream = openFrameStream(ffmpeg, source, 500, 0)
    expect(readBarcode(await stream.frame(500))).toBe(lastBefore)
    expect(readBarcode(await stream.frame(GAP_END_FRAME))).toBe(GAP_END_FRAME)
    stream.close()
  })

  it('holds the last frame when asked for one past the end', async () => {
    expect(readBarcode(await frameOf('h264.mp4', 61))).toBe(59)
  })
})

describe('decodeFrame applies colour, rotation, size and alpha', () => {
  it('uses BT.709 for a tagged file and matches the generator', async () => {
    const decoded = await frameOf('h264.mp4', 12)
    const truePicture = psnr(decoded, await patternFrame(ffmpeg, SMALL, 12, 'bt709', 'bt709'))
    const wrongMatrix = psnr(decoded, await patternFrame(ffmpeg, SMALL, 12, 'bt709', 'bt601'))
    expect(truePicture).toBeGreaterThan(35)
    expect(truePicture).toBeGreaterThan(wrongMatrix + 6)
  })

  it('uses BT.601 for untagged SD and BT.709 for untagged HD', async () => {
    const standard = await frameOf('h264-untagged-sd.mp4', 12)
    const standardTrue = psnr(standard, await patternFrame(ffmpeg, SMALL, 12, 'bt601', 'bt601'))
    const standardWrong = psnr(standard, await patternFrame(ffmpeg, SMALL, 12, 'bt601', 'bt709'))
    expect(standardTrue).toBeGreaterThan(35)
    expect(standardTrue).toBeGreaterThan(standardWrong + 6)

    const pattern = { width: 1280, height: 720, rate: '30' }
    const highDefinition = await frameOf('h264-untagged-hd.mp4', 12)
    const highTrue = psnr(highDefinition, await patternFrame(ffmpeg, pattern, 12, 'bt709', 'bt709'))
    const highWrong = psnr(highDefinition, await patternFrame(ffmpeg, pattern, 12, 'bt709', 'bt601'))
    expect(highTrue).toBeGreaterThan(35)
    expect(highTrue).toBeGreaterThan(highWrong + 6)
  })

  it('applies rotation metadata', async () => {
    const upright = await frameOf('h264.mp4', 5)
    const quarterTurn = rotatedCounterClockwise(upright)
    const halfTurn = rotatedCounterClockwise(quarterTurn)
    const threeQuarterTurn = rotatedCounterClockwise(halfTurn)

    const rotated90 = await frameOf('rotated-90.mp4', 5)
    expect(rotated90).toMatchObject({ width: 180, height: 320 })
    expect(psnr(rotated90, quarterTurn)).toBeGreaterThan(35)
    expect(psnr(rotated90, threeQuarterTurn)).toBeLessThan(20)

    const rotated270 = await frameOf('rotated-270.mp4', 5)
    expect(psnr(rotated270, threeQuarterTurn)).toBeGreaterThan(35)

    const rotated180 = await frameOf('rotated-180.mp4', 5)
    expect(rotated180).toMatchObject({ width: 320, height: 180 })
    expect(psnr(rotated180, halfTurn)).toBeGreaterThan(35)
  })

  it('stretches non-square pixels to the display size', async () => {
    const frame = await frameOf('anamorphic.mp4', 3)
    expect(frame).toMatchObject({ width: 427, height: 180 })
  })

  it('halves on request and keeps the frame identity', async () => {
    const source = await sourceOf('1080p.mp4')
    expect(decodedSize(source.video, 1)).toEqual({ width: 960, height: 540 })
    const half = await decodeFrame(ffmpeg, source, 7, 1)
    expect(half).toMatchObject({ width: 960, height: 540 })
    expect(readBarcode(half)).toBe(7)

    const quarter = await decodeFrame(ffmpeg, source, 100, 2)
    expect(quarter).toMatchObject({ width: 480, height: 270 })
    expect(readBarcode(quarter)).toBe(100)
  })

  it('decodes an 8K source at a capped size', async () => {
    const frame = await frameOf('8k.mp4', 2, 1)
    expect(frame).toMatchObject({ width: 3840, height: 2160 })
    expect(readBarcode(frame)).toBe(2)
  })

  it('premultiplies alpha exactly for a lossless source', async () => {
    const frame = await frameOf('lossless-alpha.mov', 0)
    const card = alphaCard(320, 180)
    const decoded = new Uint8Array(frame.data)
    let largestError = 0
    for (let offset = 0; offset < card.length; offset += 4) {
      const alpha = card[offset + 3] ?? 0
      expect(decoded[offset + 3]).toBe(alpha)
      for (let channel = 0; channel < 3; channel++) {
        const expected = ((card[offset + channel] ?? 0) * alpha) / 255
        largestError = Math.max(largestError, Math.abs((decoded[offset + channel] ?? 0) - expected))
      }
    }
    expect(largestError).toBeLessThanOrEqual(1)
  })

  it.each(['prores4444-alpha.mov', 'vp9-alpha.webm'])('keeps the alpha channel of %s', async (name) => {
    const frame = await frameOf(name, 3)
    const top = pixelAt(frame, 60, 2)
    const middle = pixelAt(frame, 60, 90)
    const bottom = pixelAt(frame, 60, 177)
    expect(top.alpha).toBeGreaterThan(245)
    expect(Math.abs(middle.alpha - 127)).toBeLessThan(8)
    expect(bottom.alpha).toBeLessThan(10)
    expect(top.red).toBeGreaterThan(200)
    expect(Math.abs(middle.red - middle.alpha)).toBeLessThan(40)
    expect(bottom.red).toBeLessThan(12)
  })

  it('decodes HDR, 120 fps and variable-rate sources without failing', async () => {
    expect(await frameOf('hevc-hlg-portrait.mov', 10)).toMatchObject({ width: 180, height: 320 })
    expect(readBarcode(await frameOf('fps-120.mp4', 40))).toBe(40)
    expect(await frameOf('variable-rate.mkv', 20)).toMatchObject({ width: 320, height: 180 })
  })

  it.each([
    ['hlg.mov', 0],
    ['pq.mov', 0],
    ['hlg.mov', 1],
  ])('tone-maps %s (halved %i times) back to the SDR picture', async (name, halvings) => {
    const frame = await frameOf(name, 3, halvings)
    const card = hdrCard(320, 180)
    const scale = 2 ** halvings
    let previous = -1
    let errorSum = 0
    const rampY = Math.round(45 / scale)
    for (let x = 0; x < frame.width; x++) {
      const decoded = pixelAt(frame, x, rampY).red
      expect(decoded, `ramp at ${x}`).toBeGreaterThanOrEqual(previous)
      previous = decoded
      errorSum += Math.abs(decoded - (card[(45 * 320 + x * scale) * 4] ?? 0))
    }
    expect(errorSum / frame.width).toBeLessThan(3)

    const barsY = Math.round(135 / scale)
    const bars = [pixelAt(frame, Math.round(50 / scale), barsY), pixelAt(frame, Math.round(160 / scale), barsY), pixelAt(frame, Math.round(270 / scale), barsY)]
    const channels = ['red', 'green', 'blue'] as const
    for (const [index, bar] of bars.entries()) {
      for (const [channelIndex, channel] of channels.entries()) {
        if (channelIndex === index) expect(bar[channel], `bar ${index} ${channel}`).toBeGreaterThan(230)
        else expect(bar[channel], `bar ${index} ${channel}`).toBeLessThan(32)
      }
    }
  })
})

describe('openFrameStream', () => {
  it('gives the same bytes as single-frame decoding', async () => {
    for (const name of ['h264.mp4', 'long-gop.mkv', 'hevc.mp4', 'lossless-alpha.mov']) {
      const source = await sourceOf(name)
      const stream = openFrameStream(ffmpeg, source, 0, 0)
      for (const index of [0, 1, 2, 5, 9]) {
        const streamed = await stream.frame(index)
        const single = await decodeFrame(ffmpeg, source, index, 0)
        expect(sameBytes(streamed, single), `${name} frame ${index}`).toBe(true)
      }
      stream.close()
    }
  })

  it('starts mid-file, skips, repeats, jumps back and far ahead', async () => {
    const source = await sourceOf('long-gop.mp4')
    const stream = openFrameStream(ffmpeg, source, 89, 0)
    for (const index of [89, 90, 90, 93, 100, 20, 21, 199]) {
      expect(readBarcode(await stream.frame(index)), `frame ${index}`).toBe(index)
    }
    stream.close()
  })

  it('holds the last frame past the end of the file', async () => {
    const source = await sourceOf('h264.mp4')
    const stream = openFrameStream(ffmpeg, source, 57, 0)
    expect(readBarcode(await stream.frame(59))).toBe(59)
    expect(readBarcode(await stream.frame(60))).toBe(59)
    expect(readBarcode(await stream.frame(75))).toBe(59)
    stream.close()
  })

  it('hands over only every n-th frame of a fast clip, exactly', async () => {
    const source = await sourceOf('long-gop.mp4')
    const stream = openFrameStream(ffmpeg, source, 10, 0)
    for (const index of [10, 30, 50, 70, 90, 95, 40, 41]) {
      expect(readBarcode(await stream.frame(index)), `frame ${index}`).toBe(index)
    }
    for (const index of [130, 150]) {
      const streamed = await stream.frame(index)
      expect(sameBytes(streamed, await decodeFrame(ffmpeg, source, index, 0)), `frame ${index}`).toBe(true)
    }
    stream.close()
  })

  it('holds the last frame when a stepped stream passes the end of the file', async () => {
    const source = await sourceOf('h264.mp4')
    const stream = openFrameStream(ffmpeg, source, 0, 0)
    for (const { frame, picture } of [
      { frame: 0, picture: 0 },
      { frame: 20, picture: 20 },
      { frame: 40, picture: 40 },
      { frame: 60, picture: 59 },
      { frame: 75, picture: 59 },
    ]) {
      expect(readBarcode(await stream.frame(frame)), `frame ${frame}`).toBe(picture)
    }
    stream.close()
  })

  it('matches single-frame decoding when halved', async () => {
    const source = await sourceOf('1080p.mp4')
    const stream = openFrameStream(ffmpeg, source, 30, 1)
    const streamed = await stream.frame(33)
    expect(sameBytes(streamed, await decodeFrame(ffmpeg, source, 33, 1))).toBe(true)
    stream.close()
  })
})

describe('damaged sources', () => {
  it('fails cleanly or returns a picture, but never hangs', async () => {
    const source = await sourceOf('broken-truncated.mp4')
    expect(readBarcode(await decodeFrame(ffmpeg, source, 3, 0))).toBe(3)
    const late = decodeFrame(ffmpeg, source, 59, 0)
    await expect(late).rejects.toThrow(FfmpegError)
  })
})

const REAL_DIRECTORY = join(ROOT, 'test', 'media', 'real')
const realRecordings = existsSync(REAL_DIRECTORY) ? readdirSync(REAL_DIRECTORY).filter((name) => !name.startsWith('.')) : []

describe.skipIf(realRecordings.length === 0)('real recordings', () => {
  it.each(realRecordings)('%s probes in under a second and decodes its first, middle and last frame', async (name) => {
    const path = join(REAL_DIRECTORY, name)
    const startedAt = performance.now()
    const info = await probeMedia(ffmpeg, path)
    expect(performance.now() - startedAt).toBeLessThan(1000)
    if (info.kind !== 'video') return

    const source = { path, containerStart: info.containerStart, video: info.video }
    for (const frame of [0, Math.floor(info.video.frameCount / 2), info.video.frameCount - 1]) {
      const picture = await decodeFrame(ffmpeg, source, frame, 0)
      expect(picture.width).toBe(info.video.width)
      expect(picture.height).toBe(info.video.height)
    }
  })
})

describe('decodeKeyframe', () => {
  it('shows the keyframe at or before the frame asked for', async () => {
    const source = await sourceOf('long-gop.mp4')
    const pictures: number[] = []
    for (const frame of [0, 47, 90, 150]) pictures.push(readBarcode(await decodeKeyframe(ffmpeg, source, frame, 0)))
    expect(pictures).toEqual([0, 0, 90, 90])
  })

  it('turns, sizes and tone-maps like the full-quality decoder', async () => {
    const rotated = await decodeKeyframe(ffmpeg, await sourceOf('rotated-90.mp4'), 0, 1)
    expect({ width: rotated.width, height: rotated.height }).toEqual({ width: 90, height: 160 })
    const hlg = await sourceOf('hlg.mov')
    expect(psnr(await decodeKeyframe(ffmpeg, hlg, 0, 0), await decodeFrame(ffmpeg, hlg, 0, 0))).toBeGreaterThan(40)
  })
})
