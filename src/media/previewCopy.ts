import { existsSync } from 'node:fs'
import { open, readFile, rename, rm, writeFile, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import type { Cadence, VideoInfo } from '../shared/mediaProtocol.js'
import { DEFAULT_PREVIEW_LONG_SIDE } from '../shared/settings.js'
import { TICKS_PER_SECOND } from '../shared/time.js'
import type { BuildClaim, DiskCache } from './cache.js'
import type { FfmpegRunner } from './ffmpeg.js'
import { colorToRgb, inputArguments, shrinkBeforeToneMapping, sourceColorFilters, timingFilters, trimToFrame, type FrameSize, type VideoSource } from './frames.js'

const JPEG_QUALITY = 10
const READ_TIMEOUT_MS = 30_000
const FRAME_SEAM = Buffer.from([0xff, 0xd9, 0xff, 0xd8])
const END_OF_IMAGE_BYTES = 2
const BYTES_PER_INDEX_FIELD = 8
const BYTES_PER_INDEX_ENTRY = 2 * BYTES_PER_INDEX_FIELD
// Indexes of the segments read last, kept so playback does not read one from disk for every frame.
const REMEMBERED_INDEXES = 64

type FrameLocation = {
  offset: number
  length: number
}

// The frames a copy for a fast clip holds: its picture `index` is the source frame `phase + index * step` ticks after the first frame.
type SparseFrames = Cadence & {
  frameDuration: number
}

// A preview copy is cut into segments of a fixed number of frames, each built and removed on its own, so a long source is prepared around the playhead.
// A sparse copy holds only the frames of its cadence, so the same number of pictures covers many times as much of the source.
export type PreviewLayout = {
  framesPerSegment: number
  segmentCount: number
  // The long side of the pictures, in pixels.
  longSide: number
  sparse?: SparseFrames
}

// The segment being written: its first frames can be shown before it is done. `index` is where its index file will be.
export type SegmentInProgress = {
  index: string
  dataPath: string
  locations: readonly FrameLocation[]
}

export type PreviewReader = {
  read(directory: string, layout: PreviewLayout, frame: number, inProgress: SegmentInProgress | undefined): Promise<Buffer | undefined>
}

export type PreviewRun = {
  ffmpeg: FfmpegRunner
  source: VideoSource
  directory: string
  layout: PreviewLayout
  cache: DiskCache
  firstSegment: number
  // The index files of the segments this run writes, from `firstSegment` on.
  claim: BuildClaim
  // FFmpeg's threads for the build; 0 lets it use every core.
  threads: number
  signal: AbortSignal
  onFrame(inProgress: SegmentInProgress | undefined): void
}

export function previewSize(video: VideoInfo, longSide = DEFAULT_PREVIEW_LONG_SIDE): FrameSize {
  const scale = Math.min(1, longSide / Math.max(video.width, video.height))
  return {
    width: Math.max(2, Math.round((video.width * scale) / 2) * 2),
    height: Math.max(2, Math.round((video.height * scale) / 2) * 2),
  }
}

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

// Picture n after the first is kept when a whole number of steps from the phase lands within its frame; the numbers are whole ticks, so the arithmetic is exact.
function sparseFilters(source: VideoSource, firstFrame: number, sparse: SparseFrames | undefined): string[] {
  if (sparse === undefined) return []
  const { step, phase, frameDuration } = sparse
  const sinceFirst = `((n+${firstFrame})*${frameDuration}-${phase})`
  return [trimToFrame(source, firstFrame), `select='lt(ceil(${sinceFirst}/${step})*${step}-${sinceFirst},${frameDuration})'`]
}

function previewFilters(source: VideoSource, firstFrame: number, layout: PreviewLayout): string {
  const { video } = source
  const size = previewSize(video, layout.longSide)
  const { sparse } = layout
  const jpegColor = 'out_color_matrix=bt601:out_range=pc'
  const timing = [...timingFilters(source, firstFrame), ...sparseFilters(source, firstFrame, sparse)]
  if (video.transfer !== 'sdr') {
    return [...timing, ...shrinkBeforeToneMapping(size, 'area'), ...sourceColorFilters(video), `scale=${jpegColor}`, 'setsar=1', 'format=yuvj420p'].join(',')
  }
  if (!video.hasAlpha) {
    const resize = `scale=${size.width}:${size.height}:flags=area:in_color_matrix=${video.colorMatrix}:in_range=${video.colorRange}:${jpegColor}`
    return [...timing, resize, 'setsar=1', 'format=yuvj420p'].join(',')
  }
  const resize = `scale=${size.width}:${size.height}:flags=area`
  const premultiplied = [...timing, colorToRgb(video), 'format=gbrap', 'premultiply=inplace=1', resize, 'setsar=1', 'format=gbrap']
  return [
    `${premultiplied.join(',')},split[color][alpha]`,
    `[color]scale=${jpegColor},format=yuvj420p[top]`,
    '[alpha]alphaextract,format=gray,scale=out_range=pc,format=yuvj420p[bottom]',
    '[top][bottom]vstack',
  ].join(';')
}

export function previewLayout(video: VideoInfo, segmentSeconds: number, cadence?: Cadence, longSide = DEFAULT_PREVIEW_LONG_SIDE): PreviewLayout {
  const framesPerSegment = Math.max(1, Math.ceil((segmentSeconds * TICKS_PER_SECOND) / video.frameDuration))
  if (cadence === undefined) return { framesPerSegment, segmentCount: Math.max(1, Math.ceil(video.frameCount / framesPerSegment)), longSide }
  const pictureCount = Math.ceil((video.frameCount * video.frameDuration - cadence.phase) / cadence.step)
  const sparse = { step: cadence.step, phase: cadence.phase, frameDuration: video.frameDuration }
  return { framesPerSegment, segmentCount: Math.max(1, Math.ceil(pictureCount / framesPerSegment)), longSide, sparse }
}

// The source frame a copy holds as its picture `index`.
export function sourceFrameOf(layout: PreviewLayout, index: number): number {
  const { sparse } = layout
  if (sparse === undefined) return index
  return Math.floor((sparse.phase + index * sparse.step) / sparse.frameDuration)
}

// Which picture of a copy a source frame is; undefined when a sparse copy leaves it out.
export function pictureIndexOf(layout: PreviewLayout, frame: number): number | undefined {
  const { sparse } = layout
  if (sparse === undefined) return frame
  const index = Math.max(0, Math.ceil((frame * sparse.frameDuration - sparse.phase) / sparse.step))
  return sourceFrameOf(layout, index) === frame ? index : undefined
}

// Copies of the default size keep the names they had before the size could be chosen, so those already made stay in use.
export function previewSegmentFiles(directory: string, segment: number, layout?: Pick<PreviewLayout, 'longSide' | 'sparse'>): { data: string; index: string } {
  const longSide = layout?.longSide ?? DEFAULT_PREVIEW_LONG_SIDE
  const prefix = longSide === DEFAULT_PREVIEW_LONG_SIDE ? 'preview' : `preview${longSide}`
  const sparse = layout?.sparse
  const name = sparse === undefined ? `${prefix}-${segment}` : `${prefix}-${sparse.step}-${sparse.phase}-${segment}`
  return { data: join(directory, `${name}.mjpeg`), index: join(directory, `${name}.idx`) }
}

// An index is written last, so a segment with one is whole.
export function isPreviewSegmentReady(directory: string, segment: number): boolean {
  return existsSync(previewSegmentFiles(directory, segment).index)
}

function encodeIndex(locations: readonly FrameLocation[]): Buffer {
  const bytes = Buffer.alloc(locations.length * BYTES_PER_INDEX_ENTRY)
  for (const [frame, location] of locations.entries()) {
    bytes.writeDoubleLE(location.offset, frame * BYTES_PER_INDEX_ENTRY)
    bytes.writeDoubleLE(location.length, frame * BYTES_PER_INDEX_ENTRY + BYTES_PER_INDEX_FIELD)
  }
  return bytes
}

function decodeIndex(bytes: Buffer): FrameLocation[] {
  const locations: FrameLocation[] = []
  for (let position = 0; position + BYTES_PER_INDEX_ENTRY <= bytes.length; position += BYTES_PER_INDEX_ENTRY) {
    locations.push({ offset: bytes.readDoubleLE(position), length: bytes.readDoubleLE(position + BYTES_PER_INDEX_FIELD) })
  }
  return locations
}

async function readAt(path: string, location: FrameLocation): Promise<Buffer> {
  const handle = await open(path, 'r')
  try {
    const picture = Buffer.allocUnsafeSlow(location.length)
    await handle.read(picture, 0, location.length, location.offset)
    return picture
  } finally {
    await handle.close()
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

export function createPreviewReader(cache: DiskCache): PreviewReader {
  const indexes = new Map<string, FrameLocation[]>()

  async function indexOf(path: string): Promise<FrameLocation[]> {
    const known = indexes.get(path)
    if (known !== undefined) return known
    const locations = decodeIndex(await readFile(path))
    indexes.set(path, locations)
    const oldest = indexes.keys().next()
    if (indexes.size > REMEMBERED_INDEXES && oldest.done !== true) indexes.delete(oldest.value)
    return locations
  }

  async function read(directory: string, layout: PreviewLayout, frame: number, inProgress: SegmentInProgress | undefined): Promise<Buffer | undefined> {
    const pictureIndex = pictureIndexOf(layout, frame)
    if (pictureIndex === undefined) return undefined
    const segment = Math.floor(pictureIndex / layout.framesPerSegment)
    const position = pictureIndex - segment * layout.framesPerSegment
    const files = previewSegmentFiles(directory, segment, layout)
    if (inProgress?.index === files.index) {
      const location = inProgress.locations[position]
      if (location === undefined) return undefined
      try {
        return await readAt(inProgress.dataPath, location)
      } catch (error) {
        // The segment was finished and moved under its own name meanwhile.
        if (!isMissingFile(error)) throw error
      }
    }

    try {
      const location = (await indexOf(files.index))[position]
      if (location === undefined) return undefined
      const picture = await readAt(files.data, location)
      cache.used(files.index)
      return picture
    } catch (error) {
      // A segment that is not built yet, or was just removed to make room, is simply not there.
      if (!isMissingFile(error)) throw error
      indexes.delete(files.index)
      return undefined
    }
  }

  return { read }
}

async function discard(output: FileHandle | undefined, path: string | undefined): Promise<void> {
  await output?.close()
  if (path !== undefined) await rm(path, { force: true })
}

// Builds consecutive segments with one FFmpeg run, so the seek before the first is paid once.
export async function buildPreviewRun(run: PreviewRun): Promise<void> {
  const { ffmpeg, source, directory, layout, cache, firstSegment, claim, threads, signal } = run
  const segmentCount = claim.paths.length
  if (segmentCount === 0) return
  const firstFrame = sourceFrameOf(layout, firstSegment * layout.framesPerSegment)
  const frameCount = segmentCount * layout.framesPerSegment
  const args = [
    ...inputArguments(source, firstFrame, threads),
    '-vf',
    previewFilters(source, firstFrame, layout),
    '-frames:v',
    String(frameCount),
    '-c:v',
    'mjpeg',
    '-q:v',
    String(JPEG_QUALITY),
    '-f',
    'mjpeg',
    '-',
  ]

  let segment = firstSegment
  let output: FileHandle | undefined
  let temporaryPath: string | undefined
  let locations: FrameLocation[] = []
  let writtenBytes = 0

  async function finishSegment(): Promise<void> {
    if (output === undefined || temporaryPath === undefined) return
    await output.close()
    output = undefined
    const files = previewSegmentFiles(directory, segment, layout)
    await rename(temporaryPath, files.data)
    temporaryPath = undefined
    const indexTemporary = cache.temporaryPathFor(files.index)
    await writeFile(indexTemporary, encodeIndex(locations))
    await rename(indexTemporary, files.index)
    await cache.added(files.data)
    await cache.added(files.index)
    claim.written(files.index)
    segment += 1
    locations = []
    writtenBytes = 0
    run.onFrame(undefined)
  }

  async function append(picture: Buffer): Promise<void> {
    const files = previewSegmentFiles(directory, segment, layout)
    temporaryPath ??= cache.temporaryPathFor(files.data)
    output ??= await open(temporaryPath, 'w')
    await output.write(picture)
    locations.push({ offset: writtenBytes, length: picture.length })
    writtenBytes += picture.length
    run.onFrame({ index: files.index, dataPath: temporaryPath, locations })
    if (locations.length === layout.framesPerSegment) await finishSegment()
  }

  try {
    const job = ffmpeg.spawnJob('ffmpeg', args, { signal, isBackground: true })
    let pending: Buffer = Buffer.alloc(0)
    for (;;) {
      const chunk = await job.readChunk(READ_TIMEOUT_MS)
      if (chunk === undefined) break
      const split = splitJpegFrames(Buffer.concat([pending, chunk]))
      for (const picture of split.frames) await append(picture)
      pending = split.rest
    }
    if (pending.length > 0) await append(pending)
    await job.done
    // The source ended inside this segment: it is its last.
    await finishSegment()
    claim.giveUp(new Error('The source ended before this preview segment'))
  } catch (error) {
    run.onFrame(undefined)
    await discard(output, temporaryPath)
    claim.giveUp(error instanceof Error ? error : new Error(String(error)))
    throw error
  }
}
