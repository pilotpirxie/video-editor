import { rename, rm } from 'node:fs/promises'
import { encoderLimits, type EncoderLimits } from '../shared/limits.js'
import { hasMovingPicture, hasSound, pixelLayoutOf, type ExportQuality } from '../shared/exportPresets.js'
import type { ExportTarget } from '../shared/mediaProtocol.js'
import { SAMPLE_RATE } from '../shared/time.js'
import { FfmpegError, writeAll, type FfmpegRunner } from './ffmpeg.js'

const AUDIO_PIPE = 'pipe:3'
// x264's constant rate factor: lower keeps more detail and makes larger files.
const X264_QUALITY: Record<ExportQuality, number> = { low: 30, medium: 25, high: 20 }
// The media engine's constant quality, 1 to 100: higher keeps more detail. Chosen to give files of about the size x264 makes.
const HARDWARE_QUALITY: Record<ExportQuality, number> = { low: 45, medium: 55, high: 65 }
// VP9's constant quality, 0 to 63: lower keeps more detail.
const VP9_QUALITY: Record<ExportQuality, number> = { low: 40, medium: 34, high: 28 }
const AAC_BITRATE = '192k'
const OPUS_BITRATE = '128k'
const MP3_BITRATE = '192k'
// A palette of its own for every picture, so nothing is held back until the end of the export.
const GIF_FILTER = 'split[pictures][stats];[stats]palettegen=stats_mode=single[palette];[pictures][palette]paletteuse=new=1'
// The engine sends video pictures already in BT.709 TV range; this only labels them so players read the colours right.
const VIDEO_COLOR_TAGS = 'setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv'

export class EncoderError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'EncoderError'
  }
}

export type Encoder = {
  write(pixels: ArrayBuffer, audio: Float32Array): Promise<void>
  finish(): Promise<void>
  cancel(): Promise<void>
}

export function temporaryPathFor(path: string): string {
  return `${path}.part`
}

function soundArguments(target: ExportTarget): string[] {
  if (target.format === 'webm') return ['-c:a', 'libopus', '-b:a', OPUS_BITRATE]
  if (target.format === 'mp3') return ['-c:a', 'libmp3lame', '-b:a', MP3_BITRATE]
  // A WAV over 4 GB becomes RF64, which keeps its length readable.
  if (target.format === 'wav') return ['-c:a', 'pcm_s16le', '-rf64', 'auto']
  return ['-c:a', 'aac', '-b:a', AAC_BITRATE]
}

function h264Arguments(target: ExportTarget, limits: EncoderLimits): string[] {
  if (target.encoder === 'hardware') return ['-c:v', 'h264_videotoolbox', '-q:v', String(HARDWARE_QUALITY[target.quality]), '-profile:v', 'high']
  return [
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    String(X264_QUALITY[target.quality]),
    '-profile:v',
    'high',
    '-threads',
    String(limits.threads),
    '-x264-params',
    `rc-lookahead=${limits.lookahead}:ref=${limits.references}`,
  ]
}

// The picture codec and the container, named outright: the file being written ends in .part, which says nothing of its format.
function formatArguments(target: ExportTarget, limits: EncoderLimits): string[] {
  if (target.format === 'webm') {
    return ['-vf', VIDEO_COLOR_TAGS, '-c:v', 'libvpx-vp9', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '4', '-crf', String(VP9_QUALITY[target.quality]), '-b:v', '0', '-threads', String(limits.threads), '-f', 'webm']
  }
  if (target.format === 'gif') return ['-vf', GIF_FILTER, '-loop', '0', '-f', 'gif']
  if (target.format === 'png') return ['-frames:v', '1', '-pix_fmt', 'rgb24', '-c:v', 'png', '-update', '1', '-f', 'image2']
  if (target.format === 'm4a') return ['-movflags', '+faststart', '-f', 'ipod']
  if (target.format === 'mp3') return ['-f', 'mp3']
  if (target.format === 'wav') return ['-f', 'wav']
  return ['-vf', VIDEO_COLOR_TAGS, ...h264Arguments(target, limits), '-movflags', '+faststart', '-f', 'mp4']
}

export function startEncoder(ffmpeg: FfmpegRunner, target: ExportTarget): Encoder {
  const layout = pixelLayoutOf(target.format)
  const hasEvenSize = target.width > 0 && target.height > 0 && target.width % 2 === 0 && target.height % 2 === 0
  if (layout === 'yuv420p' && !hasEvenSize) throw new EncoderError(`${target.format.toUpperCase()} video needs an even picture size, not ${target.width}x${target.height}`)

  const limits = encoderLimits(target.width * target.height)
  const temporaryPath = temporaryPathFor(target.path)
  const hasPicture = hasMovingPicture(target.format) || target.format === 'png'
  const isHeard = target.hasAudio && hasSound(target.format)
  const pictureBytes = layout === 'yuv420p' ? (target.width * target.height * 3) / 2 : target.width * target.height * 4
  const inputs: string[] = []
  if (hasPicture) inputs.push('-thread_queue_size', '1', '-f', 'rawvideo', '-pix_fmt', layout, '-s', `${target.width}x${target.height}`, '-framerate', `${target.frameRate.num}/${target.frameRate.den}`, '-i', 'pipe:0')
  // Sound alone comes in on the standard input; beside pictures it has a pipe of its own.
  if (isHeard) inputs.push('-f', 'f32le', '-ar', String(SAMPLE_RATE), '-ch_layout', 'stereo', '-i', hasPicture ? AUDIO_PIPE : 'pipe:0')
  const maps: string[] = []
  if (hasPicture) maps.push('-map', '0:v')
  if (isHeard) maps.push('-map', hasPicture ? '1:a' : '0:a', ...soundArguments(target))
  const args = [...inputs, ...maps, ...formatArguments(target, limits), '-y', temporaryPath]
  const hasAudioPipe = hasPicture && isHeard
  const job = ffmpeg.spawnJob('ffmpeg', args, { extraInputPipes: hasAudioPipe ? 1 : 0 })
  const audioPipe = job.pipes[0]
  if (hasAudioPipe && audioPipe === undefined) throw new EncoderError('The encoder was started without an audio input')

  async function write(pixels: ArrayBuffer, audio: Float32Array): Promise<void> {
    // A picture of the wrong size would not fail: FFmpeg would cut the bytes into frames that are not the ones sent.
    if (hasPicture && pixels.byteLength !== pictureBytes) throw new EncoderError(`A picture of ${pixels.byteLength} bytes was sent where ${layout} at ${target.width}×${target.height} takes ${pictureBytes}`)
    const sound = new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength)
    if (hasAudioPipe) audioPipe?.write(sound)
    try {
      await writeAll(job.stdin, hasPicture ? new Uint8Array(pixels) : sound)
    } catch (error) {
      await job.done
      throw new EncoderError('The encoder stopped accepting frames', { cause: error })
    }
  }

  async function finish(): Promise<void> {
    job.stdin.end()
    audioPipe?.end()
    await job.done
    await rename(temporaryPath, target.path)
  }

  async function cancel(): Promise<void> {
    job.kill()
    try {
      await job.done
    } catch (error) {
      if (!(error instanceof FfmpegError)) throw error
    }
    await rm(temporaryPath, { force: true })
  }

  return { write, finish, cancel }
}
