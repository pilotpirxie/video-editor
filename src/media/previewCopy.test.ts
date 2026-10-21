import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { FRAME, SECOND, VIDEO_INFO, projectOf, track, videoClip } from '../../test/fixtures.js'
import { ROOT, blockColorError, bundledFfmpeg, decodeJpeg, patternFrame, pixelAt, psnr, readBarcode, type Picture } from '../../test/helpers.js'
import { GAP_END_FRAME, GAP_START_FRAME, LATE_JITTER_FRAME, mediaPath } from '../../test/media/generate.js'
import { createDiskCache, type DiskCache } from './cache.js'
import { writeAll } from './ffmpeg.js'
import { decodeFrame, type VideoSource } from './frames.js'
import { pictureRanges, type MediaStates } from '../engine/resolve.js'
import type { Cadence } from '../shared/mediaProtocol.js'
import { frameDuration, frameIndexAt, sourceTime, type FrameRate } from '../shared/time.js'
import {
  buildPreviewRun,
  createPreviewReader,
  isPreviewSegmentReady,
  pictureIndexOf,
  previewLayout,
  previewSegmentFiles,
  previewSize,
  sourceFrameOf,
  splitJpegFrames,
  type PreviewLayout,
  type SegmentInProgress,
} from './previewCopy.js'
import { probeMedia } from './probe.js'

const ffmpeg = bundledFfmpeg()
const scratch = await mkdtemp(join(tmpdir(), 'preview-copy-'))
const KANGAROO = join(ROOT, 'samples', 'kangaroo1920.mp4')
const REQUIRED_SPEED = 8
const WHOLE_FILE_SEGMENT_SECONDS = 1000
const PLENTY_OF_ROOM = 1024 ** 3
const never = new AbortController().signal

afterAll(() => rm(scratch, { recursive: true, force: true }))

async function sourceAt(path: string): Promise<VideoSource> {
  const info = await probeMedia(ffmpeg, path)
  if (info.kind !== 'video') throw new Error(`${path} is not a video`)
  return { path, containerStart: info.containerStart, video: info.video }
}

type Built = {
  source: VideoSource
  directory: string
  layout: PreviewLayout
  cache: DiskCache
  readFrame(frame: number): Promise<Buffer | undefined>
}

async function prepared(path: string, segmentSeconds: number, cadence?: Cadence): Promise<Built> {
  const source = await sourceAt(path)
  const directory = await mkdtemp(join(scratch, 'media-'))
  const cache = createDiskCache(directory, PLENTY_OF_ROOM)
  const layout = previewLayout(source.video, segmentSeconds, cadence)
  const reader = createPreviewReader(cache)
  return { source, directory, layout, cache, readFrame: (frame) => reader.read(directory, layout, frame, undefined) }
}

async function buildSegments(built: Built, first: number, count: number, signal = never, onFrame: (inProgress: SegmentInProgress | undefined) => void = () => {}): Promise<void> {
  const paths: string[] = []
  for (let segment = first; segment < Math.min(built.layout.segmentCount, first + count); segment++) paths.push(previewSegmentFiles(built.directory, segment, built.layout).index)
  const claim = built.cache.claim(paths)
  await buildPreviewRun({ ffmpeg, source: built.source, directory: built.directory, layout: built.layout, cache: built.cache, firstSegment: first, claim, threads: 0, signal, onFrame })
}

async function build(name: string, segmentSeconds = WHOLE_FILE_SEGMENT_SECONDS): Promise<Built> {
  const built = await prepared(mediaPath(name), segmentSeconds)
  await buildSegments(built, 0, built.layout.segmentCount)
  return built
}

async function frameOrFail(built: Built, frame: number): Promise<Buffer> {
  const jpeg = await built.readFrame(frame)
  if (jpeg === undefined) throw new Error(`Frame ${frame} is not prepared`)
  return jpeg
}

async function previewBarcode(built: Built, frame: number): Promise<number> {
  const size = previewSize(built.source.video)
  return readBarcode(await decodeJpeg(ffmpeg, await frameOrFail(built, frame), size.width, size.height))
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

describe('sparse layout', () => {
  const LONG_VIDEO = { ...VIDEO_INFO, frameCount: 5 * 60 * 60 * 30 }
  const states: MediaStates = { video: { info: { kind: 'video', duration: LONG_VIDEO.frameCount * FRAME, containerStart: 0, video: LONG_VIDEO } } }

  it.each([
    { speedPercent: 5000, rate: { num: 30, den: 1 } },
    { speedPercent: 1234, rate: { num: 30, den: 1 } },
    { speedPercent: 800, rate: { num: 60, den: 1 } },
    { speedPercent: 2500, rate: { num: 30_000, den: 1001 } },
  ])('holds every frame a clip at $speedPercent% shows in a project at $rate.num/$rate.den fps', ({ speedPercent, rate }: { speedPercent: number; rate: FrameRate }) => {
    const clip = videoClip('fast', 7 * SECOND + 300, 20 * SECOND, { speedPercent, sourceStart: 3 * SECOND + 1700 })
    const project = { ...projectOf([track('t1', [clip])]), canvas: { width: 1920, height: 1080, frameRate: rate } }
    const [range] = pictureRanges(project, states)
    const cadence = range?.cadence
    if (cadence === undefined) throw new Error('A fast clip gets a cadence')
    const layout = previewLayout(LONG_VIDEO, 30, cadence)
    const ticks = frameDuration(rate)
    for (let frame = Math.ceil(clip.start / ticks); frame * ticks < clip.start + clip.duration; frame++) {
      const shown = frameIndexAt(LONG_VIDEO, sourceTime(clip, frame * ticks))
      expect(pictureIndexOf(layout, shown), `project frame ${frame}`).toBeDefined()
    }
  })

  it('gives no cadence to a clip that shows most of its frames', () => {
    const project = projectOf([track('t1', [videoClip('slow', 0, SECOND, { speedPercent: 300 })])])
    expect(pictureRanges(project, states)[0]?.cadence).toBeUndefined()
  })
})

describe('previewSize', () => {
  it('limits the long side to 960 and never enlarges', async () => {
    expect(previewSize((await sourceAt(mediaPath('1080p.mp4'))).video)).toEqual({ width: 960, height: 540 })
    expect(previewSize((await sourceAt(mediaPath('rotated-90.mp4'))).video)).toEqual({ width: 180, height: 320 })
    expect(previewSize((await sourceAt(mediaPath('8k.mp4'))).video)).toEqual({ width: 960, height: 540 })
  })
})

describe('preview segments', () => {
  it('stores every frame as its own JPEG, in order, across segments', async () => {
    const built = await build('h264.mp4', 1)
    expect(built.layout).toEqual({ framesPerSegment: 30, segmentCount: 2, longSide: 960 })
    for (let frame = 0; frame < 60; frame++) {
      const jpeg = await frameOrFail(built, frame)
      expect(jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]))
      expect(jpeg.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]))
      expect(readBarcode(await decodeJpeg(ffmpeg, jpeg, 320, 180)), `frame ${frame}`).toBe(frame)
    }
    expect(await built.readFrame(60)).toBeUndefined()
  })

  it.each(['long-gop.ts', 'delayed-video.mkv', 'fps-23976.mp4', 'vp9.webm', 'fps-240.mp4', 'variable-rate-late.mp4'])('numbers frames like the full-quality decoder for %s, built as one run or segment by segment', async (name) => {
    const source = await sourceAt(mediaPath(name))
    const lastFrame = source.video.frameCount - 1
    const frames = [0, 1, 29, 30, 47, Math.min(lastFrame, LATE_JITTER_FRAME + 1), lastFrame].filter((frame) => frame <= lastFrame)
    const oneRun = await build(name, 1)
    const separately = await prepared(mediaPath(name), 1)
    for (let segment = separately.layout.segmentCount - 1; segment >= 0; segment--) await buildSegments(separately, segment, 1)
    for (const frame of frames) {
      const truth = readBarcode(await decodeFrame(ffmpeg, source, frame, 0))
      expect(await previewBarcode(oneRun, frame), `frame ${frame}, one run`).toBe(truth)
      expect(await previewBarcode(separately, frame), `frame ${frame}, segment by segment`).toBe(truth)
    }
  })

  it.each([
    { name: 'a whole number of frames', cadence: { step: 7 * FRAME, phase: 2 * FRAME + FRAME / 3 } },
    { name: 'a fraction of a frame', cadence: { step: 2.5 * FRAME, phase: 0 } },
  ])('keeps only the frames of a fast clip, a step of $name apart, across segments', async ({ cadence }) => {
    const built = await prepared(mediaPath('h264.mp4'), 0.2, cadence)
    for (let segment = built.layout.segmentCount - 1; segment >= 0; segment -= 2) await buildSegments(built, Math.max(0, segment - 1), 2)
    const kept: number[] = []
    for (let frame = 0; frame < built.source.video.frameCount; frame++) {
      const jpeg = await built.readFrame(frame)
      if (jpeg === undefined) continue
      kept.push(frame)
      expect(readBarcode(await decodeJpeg(ffmpeg, jpeg, 320, 180)), `frame ${frame}`).toBe(frame)
    }
    const expected: number[] = []
    for (let index = 0; sourceFrameOf(built.layout, index) < built.source.video.frameCount; index++) expected.push(sourceFrameOf(built.layout, index))
    expect(kept).toEqual(expected)
  })

  it('shows the last picture before a long gap, whichever segment it starts in', async () => {
    const built = await prepared(mediaPath('variable-rate-gap.mp4'), 1)
    for (let segment = built.layout.segmentCount - 1; segment >= 0; segment--) await buildSegments(built, segment, 1)
    const lastBefore = GAP_START_FRAME - 1
    for (const [frame, picture] of [[lastBefore, lastBefore], [GAP_START_FRAME, lastBefore], [500, lastBefore], [GAP_END_FRAME - 1, lastBefore], [GAP_END_FRAME, GAP_END_FRAME]]) {
      expect(await previewBarcode(built, frame ?? 0), `frame ${frame}`).toBe(picture)
    }
  })

  it('follows a file with a hole in its timestamps the same way the decoder does', async () => {
    const built = await build('mjpeg-mp3.avi')
    const pictures: number[] = []
    for (const frame of [0, 1, 2, 30]) {
      pictures.push(readBarcode(await decodeJpeg(ffmpeg, await frameOrFail(built, frame), 320, 180)))
    }
    expect(pictures).toEqual([0, 0, 1, 29])
  })

  it('scales 1080p to 960×540', async () => {
    const built = await build('1080p.mp4')
    const picture = await decodeJpeg(ffmpeg, await frameOrFail(built, 77), 960, 540)
    expect(readBarcode(picture)).toBe(77)
  })

  it.each([
    ['rotated-180.mp4', 320, 180],
    ['rotated-90.mp4', 180, 320],
    ['8k.mp4', 960, 540],
    ['anamorphic.mp4', 428, 180],
  ])('shows %s turned and sized like the full-quality decoder', async (name, width, height) => {
    const built = await build(name)
    const preview = await decodeJpeg(ffmpeg, await frameOrFail(built, 2), width, height)
    const full = await decodeFrame(ffmpeg, built.source, 2, 0)
    expect(psnr(preview, await scaledTo(full, width, height))).toBeGreaterThan(28)
  })

  it.each(['hlg.mov', 'pq.mov'])('tone-maps %s like the full-quality decoder', async (name) => {
    const built = await build(name)
    const preview = await decodeJpeg(ffmpeg, await frameOrFail(built, 3), 320, 180)
    const full = await decodeFrame(ffmpeg, built.source, 3, 0)
    expect(blockColorError(preview, full, 20)).toBeLessThan(3)
  })

  it('reproduces the source colour when decoded as a JPEG', async () => {
    const built = await build('h264.mp4')
    const pattern = { width: 320, height: 180, rate: '30' }
    const preview = await decodeJpeg(ffmpeg, await frameOrFail(built, 12), 320, 180)
    const errorAgainstTruth = blockColorError(preview, await patternFrame(ffmpeg, pattern, 12, 'bt709', 'bt709'), 20)
    const errorAgainstWrongMatrix = blockColorError(preview, await patternFrame(ffmpeg, pattern, 12, 'bt709', 'bt601'), 20)
    expect(errorAgainstTruth).toBeLessThan(1.5)
    expect(errorAgainstWrongMatrix).toBeGreaterThan(4)
  })

  it('keeps alpha by stacking premultiplied colour above the alpha plane', async () => {
    const built = await build('lossless-alpha.mov')
    const stacked = await decodeJpeg(ffmpeg, await frameOrFail(built, 0), 320, 360)
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
  })

  it('serves frames of the segment being written', async () => {
    const built = await prepared(mediaPath('4k-long-gop.mp4'), WHOLE_FILE_SEGMENT_SECONDS)
    const reader = createPreviewReader(built.cache)
    let firstFrameSeenBeforeEnd = false
    let isFinished = false
    const run = buildSegments(built, 0, 1, never, (inProgress) => {
      if (inProgress === undefined || firstFrameSeenBeforeEnd || isFinished) return
      void reader.read(built.directory, built.layout, 0, inProgress).then((jpeg) => {
        if (jpeg !== undefined && !isFinished) firstFrameSeenBeforeEnd = true
      })
    })
    await run
    isFinished = true
    expect(firstFrameSeenBeforeEnd).toBe(true)
    expect(await built.readFrame(299)).toBeDefined()
  })

  it('leaves no index and no unfinished file behind when cancelled', async () => {
    const built = await prepared(mediaPath('4k-long-gop.mp4'), WHOLE_FILE_SEGMENT_SECONDS)
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 100)
    await expect(buildSegments(built, 0, 1, controller.signal)).rejects.toThrow(/cancelled/)
    expect(isPreviewSegmentReady(built.directory, 0)).toBe(false)
    expect((await readdir(built.directory)).filter((name) => name.endsWith('.tmp'))).toEqual([])

    await buildSegments(built, 0, 1)
    expect(await built.readFrame(299)).toBeDefined()
  })

  it.skipIf(!existsSync(KANGAROO))('prepares 1080p H.264 at 8× real time or faster', async () => {
    const built = await prepared(KANGAROO, 30)
    const startedAt = performance.now()
    for (let segment = 0; segment < built.layout.segmentCount; segment += 4) await buildSegments(built, segment, 4)
    const elapsedSeconds = (performance.now() - startedAt) / 1000
    const sourceSeconds = (built.source.video.frameCount * built.source.video.frameDuration) / 24_000_000
    const speed = sourceSeconds / elapsedSeconds
    console.info(`preview copy: ${sourceSeconds.toFixed(1)} s of 1080p in ${elapsedSeconds.toFixed(2)} s = ${speed.toFixed(1)}× real time`)
    expect(speed).toBeGreaterThanOrEqual(REQUIRED_SPEED)
  })
})

async function scaledTo(picture: Picture, width: number, height: number): Promise<Picture> {
  const job = ffmpeg.spawnJob('ffmpeg', ['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${picture.width}x${picture.height}`, '-i', 'pipe:0', '-vf', `scale=${width}:${height}:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'])
  await writeAll(job.stdin, new Uint8Array(picture.data))
  job.stdin.end()
  const pixels = await job.readExact(width * height * 4, 60_000)
  await job.done
  if (pixels === undefined) throw new Error(`The picture did not scale to ${width}×${height}`)
  const data = new ArrayBuffer(pixels.length)
  new Uint8Array(data).set(pixels)
  return { width, height, data }
}
