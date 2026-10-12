import { existsSync } from 'node:fs'
import { open, readFile, rename, rm, stat, writeFile, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import type { VideoInfo } from '../shared/mediaProtocol.js'
import type { FfmpegRunner } from './ffmpeg.js'
import { colorToRgb, inputArguments, timingFilters, type FrameSize, type VideoSource } from './frames.js'

/** Long side of a preview copy in pixels; smaller sources keep their own size. */
export const PREVIEW_LONG_SIDE = 960
/** FFmpeg's JPEG scale: 2 is best, 31 worst. Chosen for small files that still look clean at preview size. */
const JPEG_QUALITY = 10
const READ_TIMEOUT_MS = 30_000
const DATA_FILE = 'preview.mjpeg'
const INDEX_FILE = 'preview.idx'
/** End-of-image followed by start-of-image: the seam between two JPEGs in the stream. */
const FRAME_SEAM = Buffer.from([0xff, 0xd9, 0xff, 0xd8])
const END_OF_IMAGE_BYTES = 2
/** 0 lets FFmpeg use every core: the build runs alone, in the background. */
const BUILD_THREADS = 0
const INDEX_FIELDS_PER_FRAME = 2
const BYTES_PER_INDEX_FIELD = 8

/** Every frame of a video as a separately decodable JPEG, readable while it is still being built. */
export type PreviewCopy = {
  /** JPEG bytes of one frame, or undefined while that frame is not prepared. */
  readFrame(frame: number): Promise<Buffer | undefined>
  /** Resolves when every frame is prepared; rejects when the build fails or is cancelled. */
  finished: Promise<void>
  close(): Promise<void>
}

type FrameLocation = {
  offset: number
  length: number
}

/** Size of the preview picture; an alpha source stores its alpha below it at the same size. */
export function previewSize(video: VideoInfo): FrameSize {
  const scale = Math.min(1, PREVIEW_LONG_SIDE / Math.max(video.width, video.height))
  return {
    width: Math.max(2, Math.round((video.width * scale) / 2) * 2),
    height: Math.max(2, Math.round((video.height * scale) / 2) * 2),
  }
}

/** Splits a run of concatenated JPEGs into whole pictures and the unfinished remainder. */
export function splitJpegFrames(data: Buffer): { frames: Buffer[]; rest: Buffer } {
  const frames: Buffer[] = []
  let start = 0
  for (;;) {
    const seam = data.indexOf(FRAME_SEAM, start)
    if (seam === -1) break
    const end = seam + END_OF_IMAGE_BYTES
    frames.push(data.subarray(start, end))
    start = end
  }
  return { frames, rest: data.subarray(start) }
}

function previewFilters(video: VideoInfo): string {
  const size = previewSize(video)
  // JPEG decoders assume full-range BT.601, so the copy is written that way whatever the source uses.
  const jpegColor = 'out_color_matrix=bt601:out_range=pc'
  const timing = timingFilters(video)
  if (!video.hasAlpha) {
    const resize = `scale=${size.width}:${size.height}:flags=area:in_color_matrix=${video.colorMatrix}:in_range=${video.colorRange}:${jpegColor}`
    return [...timing, resize, 'setsar=1', 'format=yuvj420p'].join(',')
  }
  // JPEG has no alpha: premultiplied colour goes on top and alpha, as grey, below it.
  // The pixel format is pinned before the split; left open, FFmpeg cannot settle the alpha branch.
  const resize = `scale=${size.width}:${size.height}:flags=area`
  const premultiplied = [...timing, colorToRgb(video), 'format=gbrap', 'premultiply=inplace=1', resize, 'setsar=1', 'format=gbrap']
  return [
    `${premultiplied.join(',')},split[color][alpha]`,
    `[color]scale=${jpegColor},format=yuvj420p[top]`,
    '[alpha]alphaextract,format=gray,scale=out_range=pc,format=yuvj420p[bottom]',
    '[top][bottom]vstack',
  ].join(';')
}

/** True when `directory` already holds a finished preview copy. */
export function isPreviewComplete(directory: string): boolean {
  return existsSync(join(directory, INDEX_FILE))
}

async function loadIndex(directory: string): Promise<FrameLocation[] | undefined> {
  const indexPath = join(directory, INDEX_FILE)
  const dataPath = join(directory, DATA_FILE)
  if (!existsSync(indexPath) || !existsSync(dataPath)) return undefined

  const bytes = await readFile(indexPath)
  const dataSize = (await stat(dataPath)).size
  const locations: FrameLocation[] = []
  for (let position = 0; position + INDEX_FIELDS_PER_FRAME * BYTES_PER_INDEX_FIELD <= bytes.length; position += INDEX_FIELDS_PER_FRAME * BYTES_PER_INDEX_FIELD) {
    locations.push({ offset: bytes.readDoubleLE(position), length: bytes.readDoubleLE(position + BYTES_PER_INDEX_FIELD) })
  }
  const last = locations[locations.length - 1]
  const isComplete = last !== undefined && last.offset + last.length <= dataSize
  return isComplete ? locations : undefined
}

async function saveIndex(directory: string, locations: readonly FrameLocation[]): Promise<void> {
  const bytes = Buffer.alloc(locations.length * INDEX_FIELDS_PER_FRAME * BYTES_PER_INDEX_FIELD)
  for (const [frame, location] of locations.entries()) {
    const position = frame * INDEX_FIELDS_PER_FRAME * BYTES_PER_INDEX_FIELD
    bytes.writeDoubleLE(location.offset, position)
    bytes.writeDoubleLE(location.length, position + BYTES_PER_INDEX_FIELD)
  }
  // The index appearing is what marks the copy complete, so it must appear whole.
  const temporaryPath = join(directory, `${INDEX_FILE}.tmp`)
  await writeFile(temporaryPath, bytes)
  await rename(temporaryPath, join(directory, INDEX_FILE))
}

/**
 * Opens the preview copy kept in `directory`, building it with FFmpeg when it is missing or
 * incomplete. Aborting `signal` stops the build.
 */
export async function openPreviewCopy(ffmpeg: FfmpegRunner, source: VideoSource, directory: string, signal: AbortSignal): Promise<PreviewCopy> {
  const dataPath = join(directory, DATA_FILE)
  const existing = await loadIndex(directory)
  const locations: FrameLocation[] = existing ?? []

  let writer: FileHandle | undefined
  if (existing === undefined) {
    await rm(join(directory, INDEX_FILE), { force: true })
    writer = await open(dataPath, 'w')
  }
  const reader = await open(dataPath, 'r')

  async function build(output: FileHandle): Promise<void> {
    const args = [...inputArguments(source, 0, BUILD_THREADS), '-vf', previewFilters(source.video), '-c:v', 'mjpeg', '-q:v', String(JPEG_QUALITY), '-f', 'mjpeg', '-']
    const job = ffmpeg.spawnJob('ffmpeg', args, { signal, isBackground: true })
    let pending: Buffer = Buffer.alloc(0)
    let writtenBytes = 0

    async function append(picture: Buffer): Promise<void> {
      await output.write(picture)
      // Published only after the bytes are on disk, so a reader never sees a frame it cannot read.
      locations.push({ offset: writtenBytes, length: picture.length })
      writtenBytes += picture.length
    }

    for (;;) {
      const chunk = await job.readChunk(READ_TIMEOUT_MS)
      if (chunk === undefined) break
      const split = splitJpegFrames(Buffer.concat([pending, chunk]))
      for (const picture of split.frames) await append(picture)
      pending = split.rest
    }
    if (pending.length > 0) await append(pending)
    await saveIndex(directory, locations)
  }

  async function buildAndClose(output: FileHandle): Promise<void> {
    try {
      await build(output)
    } finally {
      await output.close()
    }
  }

  const finished = writer === undefined ? Promise.resolve() : buildAndClose(writer)

  async function readFrame(frame: number): Promise<Buffer | undefined> {
    const location = locations[frame]
    if (location === undefined) return undefined
    const picture = Buffer.allocUnsafeSlow(location.length)
    await reader.read(picture, 0, location.length, location.offset)
    return picture
  }

  async function close(): Promise<void> {
    await reader.close()
  }

  return { readFrame, finished, close }
}
