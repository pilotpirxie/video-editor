import type { RawFrame, VideoInfo } from '../shared/mediaProtocol.js'
import { frameDecoderThreads, streamDecoderThreads } from '../shared/limits.js'
import { TICKS_PER_SECOND } from '../shared/time.js'
import { FfmpegError, type FfmpegRunner, type Job } from './ffmpeg.js'

const ONE_SHOT_TIMEOUT_MS = 20_000
const STREAM_READ_TIMEOUT_MS = 20_000
const BYTES_PER_PIXEL = 4
const MAX_END_OVERSHOOT_FRAMES = 4
const STREAM_RESTART_DISTANCE_FRAMES = 150

export type FrameSize = {
  width: number
  height: number
}

export type VideoSource = {
  path: string
  containerStart: number
  video: VideoInfo
}

export type FrameStream = {
  frame(index: number): Promise<RawFrame>
  close(): void
}

export function decodedSize(video: VideoInfo, halvings: number): FrameSize {
  const divisor = 2 ** halvings
  return {
    width: Math.max(1, Math.round(video.width / divisor)),
    height: Math.max(1, Math.round(video.height / divisor)),
  }
}

function seconds(ticks: number): string {
  return (ticks / TICKS_PER_SECOND).toFixed(6)
}

export function colorToRgb(video: VideoInfo): string {
  return `scale=in_color_matrix=${video.colorMatrix}:in_range=${video.colorRange}`
}

export function timingFilters(video: VideoInfo): string[] {
  if (!video.isVariableFrameRate) return []
  return [`fps=${TICKS_PER_SECOND}/${video.frameDuration}`]
}

function videoFilters(video: VideoInfo, halvings: number): string {
  const size = decodedSize(video, halvings)
  const resizeFilter = halvings > 0 ? 'area' : 'bilinear'
  const filters = [...timingFilters(video), colorToRgb(video)]
  if (video.hasAlpha) {
    filters.push('format=gbrap', 'premultiply=inplace=1')
  } else {
    filters.push('format=gbrp')
  }
  filters.push(`scale=${size.width}:${size.height}:flags=${resizeFilter}`, 'setsar=1', 'format=rgba')
  return filters.join(',')
}

export function inputArguments(source: VideoSource, frame: number, threads: number): string[] {
  const { video } = source
  const frameStart = video.startOffset + frame * video.frameDuration
  const cut = Math.max(0, frameStart - video.frameDuration / 4)
  const seek = Math.max(0, cut - video.seekPreroll)

  const args = ['-threads', String(threads), '-copyts']
  if (video.alphaDecoder !== undefined) args.push('-c:v', video.alphaDecoder)
  if (seek > 0) args.push('-ss', seconds(seek))
  args.push(
    '-i',
    source.path,
    '-ss',
    seconds(source.containerStart + cut),
    '-map',
    '0:v:0',
    '-fps_mode',
    'passthrough',
  )
  return args
}

function decodeArguments(source: VideoSource, frame: number, halvings: number, threads: number): string[] {
  return [
    ...inputArguments(source, frame, threads),
    '-vf',
    videoFilters(source.video, halvings),
    '-thread_queue_size',
    '1',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgba',
  ]
}

export function toArrayBuffer(bytes: Buffer): ArrayBuffer {
  const owner = bytes.buffer
  const ownsWholeBuffer = owner instanceof ArrayBuffer && bytes.byteOffset === 0 && owner.byteLength === bytes.byteLength
  if (ownsWholeBuffer) return owner
  const copy = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(copy).set(bytes)
  return copy
}

async function decodeExactly(ffmpeg: FfmpegRunner, source: VideoSource, frame: number, halvings: number, signal: AbortSignal | undefined): Promise<RawFrame | undefined> {
  const size = decodedSize(source.video, halvings)
  const threads = frameDecoderThreads(source.video.width * source.video.height)
  const args = [...decodeArguments(source, frame, halvings, threads), '-frames:v', '1', '-']
  const options = signal === undefined ? { timeoutMs: ONE_SHOT_TIMEOUT_MS } : { timeoutMs: ONE_SHOT_TIMEOUT_MS, signal }
  const bytes = await ffmpeg.runOnce('ffmpeg', args, options)
  if (bytes.length !== size.width * size.height * BYTES_PER_PIXEL) return undefined
  return { ...size, data: toArrayBuffer(bytes) }
}

export async function decodeFrame(ffmpeg: FfmpegRunner, source: VideoSource, frame: number, halvings: number, signal?: AbortSignal): Promise<RawFrame> {
  const earliest = Math.max(0, frame - MAX_END_OVERSHOOT_FRAMES)
  for (let candidate = frame; candidate >= earliest; candidate--) {
    const decoded = await decodeExactly(ffmpeg, source, candidate, halvings, signal)
    if (decoded !== undefined) return decoded
  }
  throw new FfmpegError(`ffmpeg found no picture at frame ${frame} of ${source.path}`, '', undefined)
}

export function openFrameStream(ffmpeg: FfmpegRunner, source: VideoSource, firstFrame: number, halvings: number): FrameStream {
  const size = decodedSize(source.video, halvings)
  const frameBytes = size.width * size.height * BYTES_PER_PIXEL

  let job: Job | undefined
  let nextIndex = firstFrame
  let latest: { index: number; frame: RawFrame } | undefined

  function restartAt(index: number): Job {
    job?.kill()
    nextIndex = index
    const threads = streamDecoderThreads(source.video.width * source.video.height)
    job = ffmpeg.spawnJob('ffmpeg', [...decodeArguments(source, index, halvings, threads), '-'])
    return job
  }

  async function frame(index: number): Promise<RawFrame> {
    if (latest !== undefined && latest.index === index) return latest.frame

    const isBehind = index < nextIndex
    const isFarAhead = index > nextIndex + STREAM_RESTART_DISTANCE_FRAMES
    let running = job
    if (running === undefined || isBehind || isFarAhead) running = restartAt(index)

    while (nextIndex <= index) {
      const bytes = await running.readExact(frameBytes, STREAM_READ_TIMEOUT_MS)
      if (bytes === undefined) break
      latest = { index: nextIndex, frame: { ...size, data: toArrayBuffer(bytes) } }
      nextIndex += 1
    }
    if (latest === undefined) throw new FfmpegError(`ffmpeg found no picture at frame ${index} of ${source.path}`, '', undefined)
    return latest.frame
  }

  function close(): void {
    job?.kill()
    job = undefined
  }

  return { frame, close }
}
