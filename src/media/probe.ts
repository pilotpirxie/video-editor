import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import type { AudioInfo, MediaInfo, VideoInfo } from '../shared/mediaProtocol.js'
import { TICKS_PER_SECOND, exactFrameDuration, frameDuration, secondsToTicks, type FrameRate } from '../shared/time.js'
import type { FfmpegRunner } from './ffmpeg.js'

const PROBE_TIMEOUT_MS = 10_000
const MAX_SOURCE_FRAME_RATE = 240
const VARIABLE_RATE_TOLERANCE = 0.001
const HD_MIN_HEIGHT = 720
const HD_MIN_WIDTH = 1280

/** Rates a source is conformed to when its own rate does not fit whole ticks. */
const STANDARD_RATES: readonly FrameRate[] = [
  { num: 10, den: 1 },
  { num: 12, den: 1 },
  { num: 15, den: 1 },
  { num: 24000, den: 1001 },
  { num: 24, den: 1 },
  { num: 25, den: 1 },
  { num: 30000, den: 1001 },
  { num: 30, den: 1 },
  { num: 48, den: 1 },
  { num: 50, den: 1 },
  { num: 60000, den: 1001 },
  { num: 60, den: 1 },
  { num: 100, den: 1 },
  { num: 120000, den: 1001 },
  { num: 120, den: 1 },
  { num: 240, den: 1 },
]

const IMAGE_FORMATS = /(^|,)(image2|png_pipe|jpeg_pipe|webp_pipe|webp_anim|gif|apng|bmp_pipe|tiff_pipe)(,|$)/
/** FFmpeg only reports these formats for files that hold an animation. */
const ANIMATION_FORMATS = /(^|,)(webp_anim|apng)(,|$)/
/** Packets read from the start of the file to see whether frames are evenly spaced. */
const TIMING_SAMPLE_PACKETS = 120
/** Frame intervals may differ by this fraction of the typical interval before the rate counts as variable. */
const UNEVEN_INTERVAL_TOLERANCE = 0.5
const ALPHA_PIXEL_FORMATS = /^(ya\d|pal8)|yuva|rgba|bgra|argb|abgr|gbrap/
const RATIO = /^(?<num>\d+)[/:](?<den>\d+)$/
const HDR_TRANSFERS = ['smpte2084', 'arib-std-b67']
/** Containers whose index leads a seek to the keyframe at or before the target. */
const INDEXED_FORMATS = /(^|,)(mov|matroska|avi)(,|$)/
/**
 * Without such an index (MPEG-TS, FLV…) a seek lands mid-GOP and decoding only starts at the
 * next keyframe, so decoding must begin at least one GOP early. Longer GOPs than this are not
 * handled exactly until keyframes are indexed at import (T-60).
 */
const UNINDEXED_SEEK_PREROLL = 10 * TICKS_PER_SECOND

/** The subset of ffprobe's JSON this module reads. Every field may be absent. */
type ProbedStream = {
  index?: number
  codec_type?: string
  codec_name?: string
  width?: number
  height?: number
  pix_fmt?: string
  sample_aspect_ratio?: string
  r_frame_rate?: string
  avg_frame_rate?: string
  nb_frames?: string
  start_time?: string
  has_b_frames?: number
  color_space?: string
  color_range?: string
  color_transfer?: string
  channels?: number
  sample_rate?: string
  disposition?: { attached_pic?: number }
  tags?: Record<string, string>
  side_data_list?: { rotation?: number }[]
}

type ProbedPacket = {
  stream_index?: number
  pts_time?: string
}

type ProbeOutput = {
  format?: { format_name?: string; duration?: string; start_time?: string }
  streams?: ProbedStream[]
  packets?: ProbedPacket[]
}

/** A file the editor cannot use. The message is one plain sentence for the user. */
export class ProbeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ProbeError'
  }
}

/** Why a file cannot be used, phrased to follow `"name" cannot be used: `. */
class UnusableMedia extends Error {}

function isProbeOutput(value: unknown): value is ProbeOutput {
  return typeof value === 'object' && value !== null
}

function parseRatio(text: string | undefined): FrameRate | undefined {
  const groups = RATIO.exec(text ?? '')?.groups
  if (groups === undefined) return undefined
  const rate = { num: Number(groups.num), den: Number(groups.den) }
  if (rate.num <= 0 || rate.den <= 0) return undefined
  return rate
}

function framesPerSecond(rate: FrameRate): number {
  return rate.num / rate.den
}

function nearestStandardRate(target: number): FrameRate {
  let nearest = STANDARD_RATES[0]
  for (const candidate of STANDARD_RATES) {
    const isCloser = nearest === undefined || Math.abs(framesPerSecond(candidate) - target) < Math.abs(framesPerSecond(nearest) - target)
    if (isCloser) nearest = candidate
  }
  if (nearest === undefined) throw new UnusableMedia('it has no usable frame rate')
  return nearest
}

/** True when the first frames of the stream are not evenly spaced in time. */
function hasUnevenFrameTimes(stream: ProbedStream, packets: readonly ProbedPacket[]): boolean {
  const times: number[] = []
  for (const packet of packets) {
    const time = Number(packet.pts_time)
    if (packet.stream_index === stream.index && Number.isFinite(time)) times.push(time)
  }
  times.sort((a, b) => a - b)
  // Packets arrive in decode order, so the sample ends with frames whose earlier
  // neighbours were not read yet. Those holes are not uneven timing.
  const incompleteTail = 2 * ((stream.has_b_frames ?? 0) + 1)
  times.length = Math.max(0, times.length - incompleteTail)

  const intervals: number[] = []
  let previous: number | undefined
  for (const time of times) {
    if (previous !== undefined) intervals.push(time - previous)
    previous = time
  }
  intervals.sort((a, b) => a - b)
  const shortest = intervals[0]
  const longest = intervals[intervals.length - 1]
  const typical = intervals[Math.floor(intervals.length / 2)]
  if (shortest === undefined || longest === undefined || typical === undefined || typical <= 0) return false
  return (longest - shortest) / typical > UNEVEN_INTERVAL_TOLERANCE
}

function chooseFrameTiming(stream: ProbedStream, packets: readonly ProbedPacket[]): { frameDuration: number; isVariableFrameRate: boolean } {
  const nominal = parseRatio(stream.r_frame_rate)
  const average = parseRatio(stream.avg_frame_rate) ?? nominal
  if (nominal === undefined || average === undefined) throw new UnusableMedia('it has no usable frame rate')

  const difference = Math.abs(framesPerSecond(nominal) - framesPerSecond(average)) / framesPerSecond(average)
  const isVariableFrameRate = difference > VARIABLE_RATE_TOLERANCE || hasUnevenFrameTimes(stream, packets)
  const exact = exactFrameDuration(nominal)
  const isUsableAsIs = exact !== undefined && framesPerSecond(nominal) <= MAX_SOURCE_FRAME_RATE
  if (isUsableAsIs) return { frameDuration: exact, isVariableFrameRate }
  return { frameDuration: frameDuration(nearestStandardRate(framesPerSecond(average))), isVariableFrameRate }
}

function isSideways(stream: ProbedStream): boolean {
  let degrees = Number(stream.tags?.rotate ?? 0)
  for (const sideData of stream.side_data_list ?? []) {
    if (sideData.rotation !== undefined) degrees = sideData.rotation
  }
  const quarterTurns = Math.round(degrees / 90)
  return quarterTurns % 2 !== 0
}

function displaySize(stream: ProbedStream): { width: number; height: number } {
  const pixelAspect = parseRatio(stream.sample_aspect_ratio)
  const widthScale = pixelAspect === undefined ? 1 : pixelAspect.num / pixelAspect.den
  const width = Math.round((stream.width ?? 0) * widthScale)
  const height = stream.height ?? 0
  if (width <= 0 || height <= 0) throw new UnusableMedia('its picture has no size')
  if (isSideways(stream)) return { width: height, height: width }
  return { width, height }
}

function colorMatrixOf(stream: ProbedStream): VideoInfo['colorMatrix'] {
  const tagged = stream.color_space ?? ''
  if (tagged === 'bt709') return 'bt709'
  if (tagged === 'smpte170m' || tagged === 'bt470bg') return 'bt601'
  if (tagged.startsWith('bt2020')) return 'bt2020'
  // Untagged: the convention every player follows is HD → 709, SD → 601.
  const isHighDefinition = (stream.height ?? 0) >= HD_MIN_HEIGHT || (stream.width ?? 0) >= HD_MIN_WIDTH
  return isHighDefinition ? 'bt709' : 'bt601'
}

function hasAlphaTag(stream: ProbedStream): boolean {
  for (const [key, value] of Object.entries(stream.tags ?? {})) {
    if (key.toLowerCase() === 'alpha_mode' && value === '1') return true
  }
  return false
}

function hasAlpha(stream: ProbedStream): boolean {
  return ALPHA_PIXEL_FORMATS.test(stream.pix_fmt ?? '') || hasAlphaTag(stream)
}

function alphaDecoderOf(stream: ProbedStream): string | undefined {
  // FFmpeg's own VP8/VP9 decoders ignore the WebM alpha plane; libvpx reads it.
  if (!hasAlphaTag(stream)) return undefined
  if (stream.codec_name === 'vp9') return 'libvpx-vp9'
  if (stream.codec_name === 'vp8') return 'libvpx'
  return undefined
}

function videoInfo(stream: ProbedStream, output: ProbeOutput, containerStartSeconds: number, containerDuration: number): VideoInfo {
  const { width, height } = displaySize(stream)
  const timing = chooseFrameTiming(stream, output.packets ?? [])
  const streamStartSeconds = Number(stream.start_time ?? containerStartSeconds)
  const startOffset = Math.max(0, secondsToTicks(streamStartSeconds - containerStartSeconds))

  const countedFrames = Number(stream.nb_frames)
  const canTrustCount = Number.isInteger(countedFrames) && countedFrames > 0 && !timing.isVariableFrameRate
  const estimatedFrames = Math.floor((containerDuration - startOffset) / timing.frameDuration)
  const frameCount = canTrustCount ? countedFrames : estimatedFrames

  // A frame can be reached from the keyframe before it only if the seek lands on that keyframe
  // and the decoder has seen every frame it reorders. Uneven streams also need earlier frames
  // to hold across gaps.
  const canSeekToKeyframe = INDEXED_FORMATS.test(output.format?.format_name ?? '') && !timing.isVariableFrameRate
  const reorderPreroll = ((stream.has_b_frames ?? 0) + 1) * timing.frameDuration
  const seekPreroll = canSeekToKeyframe ? reorderPreroll : UNINDEXED_SEEK_PREROLL

  const isFullRange = stream.color_range === 'pc' || (stream.pix_fmt ?? '').startsWith('yuvj')
  const info: VideoInfo = {
    width,
    height,
    frameDuration: timing.frameDuration,
    frameCount: Math.max(1, frameCount),
    startOffset,
    seekPreroll,
    isVariableFrameRate: timing.isVariableFrameRate,
    hasAlpha: hasAlpha(stream),
    colorMatrix: colorMatrixOf(stream),
    colorRange: isFullRange ? 'pc' : 'tv',
    isHdr: HDR_TRANSFERS.includes(stream.color_transfer ?? ''),
    codec: stream.codec_name ?? 'unknown',
  }
  const alphaDecoder = alphaDecoderOf(stream)
  if (alphaDecoder !== undefined) info.alphaDecoder = alphaDecoder
  return info
}

function audioInfo(stream: ProbedStream): AudioInfo {
  const channels = stream.channels ?? 0
  const sampleRate = Number(stream.sample_rate)
  if (channels <= 0 || !(sampleRate > 0)) throw new UnusableMedia('its sound has no channels')
  return { channels, sampleRate, codec: stream.codec_name ?? 'unknown' }
}

function imageInfo(stream: ProbedStream, output: ProbeOutput): MediaInfo {
  const isAnimationFormat = ANIMATION_FORMATS.test(output.format?.format_name ?? '')
  const isAnimated = isAnimationFormat || Number(stream.nb_frames) > 1
  return { kind: 'image', ...displaySize(stream), hasAlpha: hasAlpha(stream), isAnimated }
}

function interpret(output: ProbeOutput): MediaInfo {
  let video: ProbedStream | undefined
  let audio: ProbedStream | undefined
  for (const stream of output.streams ?? []) {
    const isCoverArt = stream.disposition?.attached_pic === 1
    if (stream.codec_type === 'video' && !isCoverArt) video ??= stream
    if (stream.codec_type === 'audio') audio ??= stream
  }

  const isImageFile = IMAGE_FORMATS.test(output.format?.format_name ?? '')
  if (video !== undefined && audio === undefined && isImageFile) return imageInfo(video, output)

  const durationSeconds = Number(output.format?.duration)
  if (!(durationSeconds > 0)) throw new UnusableMedia('it has no duration')
  const duration = secondsToTicks(durationSeconds)
  const containerStartSeconds = Number(output.format?.start_time ?? 0) || 0
  const containerStart = secondsToTicks(containerStartSeconds)

  if (video !== undefined) {
    const info: MediaInfo = { kind: 'video', duration, containerStart, video: videoInfo(video, output, containerStartSeconds, duration) }
    if (audio !== undefined) info.audio = audioInfo(audio)
    return info
  }
  if (audio !== undefined) return { kind: 'audio', duration, containerStart, audio: audioInfo(audio) }
  throw new UnusableMedia('it contains no picture and no sound')
}

/**
 * Reads what the editor needs to know about a media file.
 * Rejects with a ProbeError whose message is one plain sentence.
 */
export async function probeMedia(ffmpeg: FfmpegRunner, path: string): Promise<MediaInfo> {
  const name = basename(path)
  const unreadable = `"${name}" could not be read: it is damaged or not a supported media file.`
  if (!existsSync(path)) throw new ProbeError(`"${name}" was not found.`)

  let json: Buffer
  try {
    const args = [
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      '-show_entries',
      'packet=stream_index,pts_time',
      '-read_intervals',
      `%+#${TIMING_SAMPLE_PACKETS}`,
      path,
    ]
    json = await ffmpeg.runOnce('ffprobe', args, { timeoutMs: PROBE_TIMEOUT_MS })
  } catch (error) {
    throw new ProbeError(unreadable, { cause: error })
  }

  let output: unknown
  try {
    output = JSON.parse(json.toString('utf8'))
  } catch (error) {
    throw new ProbeError(unreadable, { cause: error })
  }
  if (!isProbeOutput(output)) throw new ProbeError(unreadable)

  try {
    return interpret(output)
  } catch (error) {
    if (error instanceof UnusableMedia) throw new ProbeError(`"${name}" cannot be used: ${error.message}.`, { cause: error })
    throw error
  }
}
