import type { RawFrame, VideoInfo } from '../shared/mediaProtocol.js'
import { frameDecoderThreads, streamDecoderThreads } from '../shared/limits.js'
import { TICKS_PER_SECOND } from '../shared/time.js'
import { FfmpegError, type FfmpegRunner, type Job } from './ffmpeg.js'

const ONE_SHOT_TIMEOUT_MS = 20_000
const STREAM_READ_TIMEOUT_MS = 20_000
const BYTES_PER_PIXEL = 4
const MAX_END_OVERSHOOT_FRAMES = 4
// A stride longer than this is not decoded through: a stream sought anew for each frame costs less.
const STREAM_RESTART_DISTANCE_FRAMES = 150
// Pictures nobody asked for that a stream reads through before it starts anew at the frame asked for. A restart cost about as much as five 720p pictures read through (measured).
const MAX_SKIPPED_PICTURES = 5
// BT.2408 puts the white of paper and faces at 203 nits in HDR video; it becomes SDR white. Highlights up to 1,000 nits are rolled off above 80 % of SDR white.
const HDR_REFERENCE_WHITE_NITS = 203
const HDR_PEAK_NITS = 1000
const HDR_ROLL_OFF_START = 0.8
const HDR_TRANSFER_NAMES: Record<'hlg' | 'pq', string> = { hlg: 'arib-std-b67', pq: 'smpte2084' }
const ZSCALE_MATRIX_NAMES: Record<VideoInfo['colorMatrix'], string> = { bt709: 'bt709', bt601: '170m', bt2020: '2020_ncl' }

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

// Light made linear, colours brought into BT.709, highlights rolled off, then BT.709 gamma again, as full-range RGB.
function toneMapFilters(video: VideoInfo, transfer: 'hlg' | 'pq'): string[] {
  const range = video.colorRange === 'pc' ? 'full' : 'limited'
  const peak = (HDR_PEAK_NITS / HDR_REFERENCE_WHITE_NITS).toFixed(4)
  return [
    `zscale=tin=${HDR_TRANSFER_NAMES[transfer]}:pin=bt2020:min=${ZSCALE_MATRIX_NAMES[video.colorMatrix]}:rin=${range}:t=linear:npl=${HDR_REFERENCE_WHITE_NITS}`,
    'format=gbrpf32le',
    'zscale=p=bt709',
    `tonemap=mobius:param=${HDR_ROLL_OFF_START}:peak=${peak}:desat=0`,
    'zscale=t=bt709:m=bt709:r=full',
    'format=gbrp',
  ]
}

// Tone mapping is the costly step, so an HDR picture is made smaller first. Chroma is kept whole, as a halved size may be odd.
export function shrinkBeforeToneMapping(size: FrameSize, resizeFilter: string): string[] {
  return [`scale=${size.width}:${size.height}:flags=${resizeFilter}`, 'format=yuv444p16le']
}

// Every decode of a source turns its pictures into full-range BT.709 RGB the same way, so the preview, the paused frame and the export agree.
export function sourceColorFilters(video: VideoInfo): string[] {
  if (video.transfer === 'sdr') return [colorToRgb(video)]
  return toneMapFilters(video, video.transfer)
}

function frameStartOf(video: VideoInfo, frame: number): number {
  return video.startOffset + frame * video.frameDuration
}

// Where a decode that starts at `frame` cuts in: a quarter frame early, so a frame whose time is rounded a little early is not lost.
function cutOf(video: VideoInfo, frame: number): number {
  return Math.max(0, frameStartOf(video, frame) - video.frameDuration / 4)
}

// Uneven frame times are put on the even grid of the frame rate, laid from the frame asked for, so the n-th picture out is frame `frame + n` even when the seek landed later than asked.
export function timingFilters(source: VideoSource, frame: number): string[] {
  const { video } = source
  if (!video.isVariableFrameRate) return []
  return [`fps=${TICKS_PER_SECOND}/${video.frameDuration}:start_time=${seconds(source.containerStart + frameStartOf(video, frame))}`]
}

function pictureFilters(video: VideoInfo, halvings: number): string[] {
  const size = decodedSize(video, halvings)
  const resizeFilter = halvings > 0 ? 'area' : 'bilinear'
  const filters: string[] = []
  if (video.transfer !== 'sdr' && halvings > 0) filters.push(...shrinkBeforeToneMapping(size, resizeFilter))
  filters.push(...sourceColorFilters(video))
  if (video.hasAlpha) {
    filters.push('format=gbrap', 'premultiply=inplace=1')
  } else {
    filters.push('format=gbrp')
  }
  filters.push(`scale=${size.width}:${size.height}:flags=${resizeFilter}`, 'setsar=1', 'format=rgba')
  return filters
}

// A fast clip asks for every `step`-th frame. The ones between are dropped right after decoding, before their colour is converted and they are piped. The trim makes the count start at the frame asked for.
function stepFilters(source: VideoSource, frame: number, step: number): string[] {
  if (step === 1) return []
  return [`trim=start=${seconds(source.containerStart + cutOf(source.video, frame))}`, `select='not(mod(n,${step}))'`]
}

function videoFilters(source: VideoSource, frame: number, halvings: number, step: number): string {
  return [...timingFilters(source, frame), ...stepFilters(source, frame, step), ...pictureFilters(source.video, halvings)].join(',')
}

export function inputArguments(source: VideoSource, frame: number, threads: number): string[] {
  const { video } = source
  const cut = cutOf(video, frame)
  const seek = Math.max(0, cut - video.seekPreroll)

  const args = ['-threads', String(threads), '-copyts']
  // A recording with uneven frame times may hold no frame for many seconds. The frame shown through such a gap lies before the place sought to, so decoding starts at the keyframe before it and the frame-rate filter sees that frame too.
  if (video.isVariableFrameRate) args.push('-noaccurate_seek')
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

function decodeArguments(source: VideoSource, frame: number, halvings: number, threads: number, step: number): string[] {
  return [
    ...inputArguments(source, frame, threads),
    '-vf',
    videoFilters(source, frame, halvings, step),
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
  const args = [...decodeArguments(source, frame, halvings, threads, 1), '-frames:v', '1', '-']
  const options = signal === undefined ? { timeoutMs: ONE_SHOT_TIMEOUT_MS } : { timeoutMs: ONE_SHOT_TIMEOUT_MS, signal }
  const bytes = await ffmpeg.runOnce('ffmpeg', args, options)
  if (bytes.length !== size.width * size.height * BYTES_PER_PIXEL) return undefined
  return { ...size, data: toArrayBuffer(bytes) }
}

// The keyframe at or before `frame`, decoded on its own: a quick, rough picture for a timeline thumbnail whose preview copy is not made yet.
export async function decodeKeyframe(ffmpeg: FfmpegRunner, source: VideoSource, frame: number, halvings: number): Promise<RawFrame> {
  const { video } = source
  const size = decodedSize(video, halvings)
  const args = ['-threads', '1', '-skip_frame', 'nokey', '-noaccurate_seek']
  if (video.alphaDecoder !== undefined) args.push('-c:v', video.alphaDecoder)
  args.push('-ss', seconds(frameStartOf(video, frame)), '-i', source.path, '-map', '0:v:0', '-fps_mode', 'passthrough', '-frames:v', '1', '-vf', pictureFilters(video, halvings).join(','), '-f', 'rawvideo', '-pix_fmt', 'rgba', '-')
  const bytes = await ffmpeg.runOnce('ffmpeg', args, { timeoutMs: ONE_SHOT_TIMEOUT_MS })
  if (bytes.length !== size.width * size.height * BYTES_PER_PIXEL) throw new FfmpegError(`ffmpeg found no keyframe before frame ${frame} of ${source.path}`, '', undefined)
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
  // Frames from one picture FFmpeg hands over to the next. It follows the stride the stream is asked at, so a fast clip gets only the frames it shows.
  let step = 1
  let latest: { index: number; frame: RawFrame } | undefined

  function restartAt(index: number, newStep: number): Job {
    job?.kill()
    nextIndex = index
    step = newStep
    const threads = streamDecoderThreads(source.video.width * source.video.height, step)
    // One frame is decoded ahead, while the last one is on its way to the compositor.
    job = ffmpeg.spawnJob('ffmpeg', [...decodeArguments(source, index, halvings, threads, step), '-'], { readAheadBytes: frameBytes })
    return job
  }

  async function readUpTo(running: Job, index: number): Promise<void> {
    while (nextIndex <= index) {
      const bytes = await running.readExact(frameBytes, STREAM_READ_TIMEOUT_MS)
      if (bytes === undefined) return
      latest = { index: nextIndex, frame: { ...size, data: toArrayBuffer(bytes) } }
      nextIndex += step
    }
  }

  async function frame(index: number): Promise<RawFrame> {
    if (latest !== undefined && latest.index === index) return latest.frame

    const distance = index - nextIndex
    const isOnTheWay = distance >= 0 && distance % step === 0 && distance / step <= MAX_SKIPPED_PICTURES
    let running = job
    if (running === undefined || !isOnTheWay) {
      const stride = latest === undefined ? 1 : index - latest.index
      const isSteppable = stride > 1 && stride <= STREAM_RESTART_DISTANCE_FRAMES
      running = restartAt(index, isSteppable ? stride : 1)
    }

    await readUpTo(running, index)
    if (latest === undefined) throw new FfmpegError(`ffmpeg found no picture at frame ${index} of ${source.path}`, '', undefined)
    // A stepped stream that ran out passed the end of the file: the frames after its last picture are read one by one, so the held frame is the file's last, as in a plain stream.
    const hasRunOutStepping = latest.index !== index && step > 1
    if (hasRunOutStepping) await readUpTo(restartAt(latest.index + 1, 1), index)
    return latest.frame
  }

  function close(): void {
    job?.kill()
    job = undefined
  }

  return { frame, close }
}
