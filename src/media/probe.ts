import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import type { AudioInfo, MediaInfo, VideoInfo } from '../shared/mediaProtocol.js'
import { PROJECT_FRAME_RATES, TICKS_PER_SECOND, exactFrameDuration, frameDuration, secondsToTicks, type FrameRate } from '../shared/time.js'
import type { FfmpegRunner } from './ffmpeg.js'

const PROBE_TIMEOUT_MS = 10_000
const MAX_SOURCE_FRAME_RATE = 240
const VARIABLE_RATE_TOLERANCE = 0.001
const HD_MIN_HEIGHT = 720
const HD_MIN_WIDTH = 1280
const DEGREES_PER_QUARTER_TURN = 90

const STANDARD_RATES: readonly FrameRate[] = [
  ...PROJECT_FRAME_RATES,
  { num: 10, den: 1 },
  { num: 12, den: 1 },
  { num: 15, den: 1 },
  { num: 48, den: 1 },
  { num: 60000, den: 1001 },
  { num: 100, den: 1 },
  { num: 120000, den: 1001 },
  { num: 240, den: 1 },
].sort((a, b) => framesPerSecond(a) - framesPerSecond(b))

const IMAGE_FORMATS = /(^|,)(image2|png_pipe|jpeg_pipe|webp_pipe|webp_anim|gif|apng|bmp_pipe|tiff_pipe)(,|$)/
const TIMING_SAMPLE_PACKETS = 120
const UNEVEN_INTERVAL_TOLERANCE = 0.5
const ALPHA_PIXEL_FORMATS = /^(ya\d|pal8)|yuva|rgba|bgra|argb|abgr|gbrap/
const RATIO = /^(?<num>\d+)[/:](?<den>\d+)$/
const TRANSFERS: Record<string, VideoInfo['transfer']> = { 'arib-std-b67': 'hlg', smpte2084: 'pq' }
const DOLBY_VISION_RECORD = 'DOVI configuration record'
// Profile 5 holds its picture in a colour space only Dolby's own decoder turns back into one that can be shown.
const UNSHOWABLE_DOLBY_VISION_PROFILE = 5
const LONG_ENOUGH_TO_SAMPLE_AGAIN_SECONDS = 10
const SECONDS_BEFORE_END_SAMPLE = 5
const INDEXED_FORMATS = /(^|,)(mov|matroska|avi)(,|$)/
const INEXACT_AUDIO_SEEK_FORMATS = /(^|,)(mp3|aac)(,|$)/
const UNINDEXED_SEEK_PREROLL = 10 * TICKS_PER_SECOND

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
  side_data_list?: { rotation?: number; side_data_type?: string; dv_profile?: number }[]
}

type ProbedPacket = {
  stream_index?: number
  pts_time?: string
  duration_time?: string
}

type ProbeOutput = {
  format?: { format_name?: string; duration?: string; start_time?: string }
  streams?: ProbedStream[]
  packets?: ProbedPacket[]
}

export class ProbeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ProbeError'
  }
}

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

function hasUnevenFrameTimes(stream: ProbedStream, packets: readonly ProbedPacket[]): boolean {
  const times: number[] = []
  for (const packet of packets) {
    const time = Number(packet.pts_time)
    if (packet.stream_index === stream.index && Number.isFinite(time)) times.push(time)
  }
  times.sort((a, b) => a - b)
  // Pictures that show before the last ones read may not have been read yet.
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

function chooseFrameTiming(stream: ProbedStream, samples: readonly (readonly ProbedPacket[])[]): { frameDuration: number; isVariableFrameRate: boolean } {
  const nominal = parseRatio(stream.r_frame_rate)
  const average = parseRatio(stream.avg_frame_rate) ?? nominal
  if (nominal === undefined || average === undefined) throw new UnusableMedia('it has no usable frame rate')

  const difference = Math.abs(framesPerSecond(nominal) - framesPerSecond(average)) / framesPerSecond(average)
  let isVariableFrameRate = difference > VARIABLE_RATE_TOLERANCE
  for (const packets of samples) {
    if (hasUnevenFrameTimes(stream, packets)) isVariableFrameRate = true
  }
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
  const quarterTurns = Math.round(degrees / DEGREES_PER_QUARTER_TURN)
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

function transferOf(stream: ProbedStream): VideoInfo['transfer'] {
  for (const sideData of stream.side_data_list ?? []) {
    const isUnshowable = sideData.side_data_type === DOLBY_VISION_RECORD && sideData.dv_profile === UNSHOWABLE_DOLBY_VISION_PROFILE
    if (isUnshowable) throw new UnusableMedia('Dolby Vision profile 5 is not supported')
  }
  // Other Dolby Vision profiles carry an ordinary HLG, PQ or SDR picture, tagged as such, beneath their extra layer.
  return TRANSFERS[stream.color_transfer ?? ''] ?? 'sdr'
}

function colorMatrixOf(stream: ProbedStream): VideoInfo['colorMatrix'] {
  const tagged = stream.color_space ?? ''
  if (tagged === 'bt709') return 'bt709'
  if (tagged === 'smpte170m' || tagged === 'bt470bg') return 'bt601'
  if (tagged.startsWith('bt2020')) return 'bt2020'
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
  if (!hasAlphaTag(stream)) return undefined
  if (stream.codec_name === 'vp9') return 'libvpx-vp9'
  if (stream.codec_name === 'vp8') return 'libvpx'
  return undefined
}

function videoInfo(stream: ProbedStream, output: ProbeOutput, laterPackets: readonly (readonly ProbedPacket[])[], containerStartSeconds: number, containerDuration: number): VideoInfo {
  const { width, height } = displaySize(stream)
  const transfer = transferOf(stream)
  const timing = chooseFrameTiming(stream, [output.packets ?? [], ...laterPackets])
  const taggedStart = Number(stream.start_time)
  const streamStartSeconds = Number.isFinite(taggedStart) ? taggedStart : containerStartSeconds
  const startOffset = Math.max(0, secondsToTicks(streamStartSeconds - containerStartSeconds))

  const countedFrames = Number(stream.nb_frames)
  const canTrustCount = Number.isInteger(countedFrames) && countedFrames > 0 && !timing.isVariableFrameRate
  const estimatedFrames = Math.floor((containerDuration - startOffset) / timing.frameDuration)
  const frameCount = canTrustCount ? countedFrames : estimatedFrames

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
    hasAlpha: transfer === 'sdr' && hasAlpha(stream),
    colorMatrix: colorMatrixOf(stream),
    colorRange: isFullRange ? 'pc' : 'tv',
    transfer,
    codec: stream.codec_name ?? 'unknown',
  }
  const alphaDecoder = alphaDecoderOf(stream)
  if (alphaDecoder !== undefined) info.alphaDecoder = alphaDecoder
  return info
}

function audioInfo(stream: ProbedStream, output: ProbeOutput): AudioInfo {
  const channels = stream.channels ?? 0
  const sampleRate = Number(stream.sample_rate)
  if (channels <= 0 || !(sampleRate > 0)) throw new UnusableMedia('its sound has no channels')
  const seeksExactly = !INEXACT_AUDIO_SEEK_FORMATS.test(output.format?.format_name ?? '')
  return { channels, sampleRate, codec: stream.codec_name ?? 'unknown', seeksExactly }
}

function mainStreams(output: ProbeOutput): { video: ProbedStream | undefined; audio: ProbedStream | undefined } {
  let video: ProbedStream | undefined
  let audio: ProbedStream | undefined
  for (const stream of output.streams ?? []) {
    const isCoverArt = stream.disposition?.attached_pic === 1
    if (stream.codec_type === 'video' && !isCoverArt) video ??= stream
    if (stream.codec_type === 'audio') audio ??= stream
  }
  return { video, audio }
}

function imagePackets(output: ProbeOutput): ProbedPacket[] {
  const { video, audio } = mainStreams(output)
  const isImageFile = IMAGE_FORMATS.test(output.format?.format_name ?? '')
  if (video === undefined || audio !== undefined || !isImageFile) return []
  return (output.packets ?? []).filter((packet) => packet.stream_index === video.index)
}

function hasDuration(output: ProbeOutput): boolean {
  return Number(output.format?.duration) > 0
}

// Animated WebP and APNG files do not state how long they run; the end of their last picture does.
function endOfLastPacket(packets: readonly ProbedPacket[]): number {
  let end = 0
  for (const packet of packets) {
    const packetEnd = Number(packet.pts_time) + Number(packet.duration_time)
    if (Number.isFinite(packetEnd)) end = Math.max(end, packetEnd)
  }
  return end
}

function interpret(output: ProbeOutput, laterPackets: readonly (readonly ProbedPacket[])[]): MediaInfo {
  const { video, audio } = mainStreams(output)
  const pictures = imagePackets(output)
  if (video !== undefined && pictures.length === 1) return { kind: 'image', ...displaySize(video), hasAlpha: hasAlpha(video) }

  const isAnimatedImage = pictures.length > 1
  const durationSeconds = hasDuration(output) ? Number(output.format?.duration) : endOfLastPacket(pictures)
  if (!(durationSeconds > 0)) throw new UnusableMedia('it has no duration')
  const duration = secondsToTicks(durationSeconds)
  const statedStartSeconds = Number(output.format?.start_time ?? 0)
  const containerStartSeconds = Number.isFinite(statedStartSeconds) ? statedStartSeconds : 0
  const containerStart = secondsToTicks(containerStartSeconds)

  if (video !== undefined) {
    const info: MediaInfo = { kind: 'video', duration, containerStart, video: videoInfo(video, output, laterPackets, containerStartSeconds, duration) }
    if (audio !== undefined) info.audio = audioInfo(audio, output)
    if (isAnimatedImage) info.isAnimatedImage = true
    return info
  }
  if (audio !== undefined) return { kind: 'audio', duration, containerStart, audio: audioInfo(audio, output) }
  throw new UnusableMedia('it contains no picture and no sound')
}

async function runProbe(ffmpeg: FfmpegRunner, args: readonly string[], path: string, unreadable: string): Promise<ProbeOutput> {
  let json: Buffer
  try {
    json = await ffmpeg.runOnce('ffprobe', ['-print_format', 'json', ...args, path], { timeoutMs: PROBE_TIMEOUT_MS })
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
  return output
}

function readProbe(ffmpeg: FfmpegRunner, path: string, packets: 'first' | 'all', unreadable: string): Promise<ProbeOutput> {
  const args = ['-show_format', '-show_streams', '-show_entries', 'packet=stream_index,pts_time,duration_time']
  if (packets === 'first') args.push('-read_intervals', `%+#${TIMING_SAMPLE_PACKETS}`)
  return runProbe(ffmpeg, args, path, unreadable)
}

async function readLaterPackets(ffmpeg: FfmpegRunner, path: string, fromSeconds: number, unreadable: string): Promise<ProbedPacket[]> {
  const args = ['-select_streams', 'V:0', '-show_entries', 'packet=stream_index,pts_time', '-read_intervals', `${fromSeconds}%+#${TIMING_SAMPLE_PACKETS}`]
  const output = await runProbe(ffmpeg, args, path, unreadable)
  return output.packets ?? []
}

async function laterPacketsOf(ffmpeg: FfmpegRunner, path: string, output: ProbeOutput, unreadable: string): Promise<ProbedPacket[][]> {
  const { video } = mainStreams(output)
  const seconds = Number(output.format?.duration)
  const isWorthSampling = video !== undefined && imagePackets(output).length === 0 && seconds > LONG_ENOUGH_TO_SAMPLE_AGAIN_SECONDS
  if (!isWorthSampling) return []
  const starts = [seconds / 2, seconds - SECONDS_BEFORE_END_SAMPLE]
  return Promise.all(starts.map((start) => readLaterPackets(ffmpeg, path, start, unreadable)))
}

export async function probeMedia(ffmpeg: FfmpegRunner, path: string): Promise<MediaInfo> {
  const name = basename(path)
  const unreadable = `"${name}" could not be read: it is damaged or not a supported media file.`
  if (!existsSync(path)) throw new ProbeError(`"${name}" was not found.`)

  let output = await readProbe(ffmpeg, path, 'first', unreadable)
  const isAnimationOfUnknownLength = imagePackets(output).length > 1 && !hasDuration(output)
  if (isAnimationOfUnknownLength) output = await readProbe(ffmpeg, path, 'all', unreadable)

  const laterPackets = await laterPacketsOf(ffmpeg, path, output, unreadable)
  try {
    return interpret(output, laterPackets)
  } catch (error) {
    if (error instanceof UnusableMedia) throw new ProbeError(`"${name}" cannot be used: ${error.message}.`, { cause: error })
    throw error
  }
}
