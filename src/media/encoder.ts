import { rename, rm, stat } from 'node:fs/promises'
import { hasMovingPicture, hasSound, pixelLayoutOf, temporaryPathFor, type ExportQuality } from '../shared/exportPresets.js'
import type { ExportTarget } from '../shared/mediaProtocol.js'
import { SAMPLE_RATE } from '../shared/time.js'
import { FfmpegError, writeAll, type FfmpegRunner } from './ffmpeg.js'

const AUDIO_PIPE = 'pipe:3'
const VIDEOTOOLBOX_QUALITY: Record<ExportQuality, number> = { low: 45, medium: 55, high: 65 }
const VP9_CRF: Record<ExportQuality, number> = { low: 40, medium: 34, high: 28 }
const VP9_THREADS = 4
const AAC_BITRATE = '192k'
const OPUS_BITRATE = '128k'
const MP3_BITRATE = '192k'
const GIF_FILTER = 'split[pictures][stats];[stats]palettegen=stats_mode=single[palette];[pictures][palette]paletteuse=new=1'
const VIDEO_COLOR_TAGS = 'setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv'
const FINISH_BASE_MS = 60_000
const SLOWEST_REWRITE_BYTES_PER_MS = 20_000
const MS_PER_SECOND = 1000

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

function soundArguments(target: ExportTarget): string[] {
  if (target.format === 'webm') return ['-c:a', 'libopus', '-b:a', OPUS_BITRATE]
  if (target.format === 'mp3') return ['-c:a', 'libmp3lame', '-b:a', MP3_BITRATE]
  if (target.format === 'wav') return ['-c:a', 'pcm_s16le', '-rf64', 'auto']
  return ['-c:a', 'aac_at', '-b:a', AAC_BITRATE]
}

function formatArguments(target: ExportTarget): string[] {
  if (target.format === 'webm') {
    return ['-vf', VIDEO_COLOR_TAGS, '-c:v', 'libvpx-vp9', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '4', '-crf', String(VP9_CRF[target.quality]), '-b:v', '0', '-threads', String(VP9_THREADS), '-f', 'webm']
  }
  if (target.format === 'gif') return ['-vf', GIF_FILTER, '-loop', '0', '-f', 'gif']
  if (target.format === 'png') return ['-frames:v', '1', '-pix_fmt', 'rgb24', '-c:v', 'png', '-update', '1', '-f', 'image2']
  if (target.format === 'm4a') return ['-movflags', '+faststart', '-f', 'ipod']
  if (target.format === 'mp3') return ['-f', 'mp3']
  if (target.format === 'wav') return ['-f', 'wav']
  return ['-vf', VIDEO_COLOR_TAGS, '-c:v', 'h264_videotoolbox', '-q:v', String(VIDEOTOOLBOX_QUALITY[target.quality]), '-profile:v', 'high', '-movflags', '+faststart', '-f', 'mp4']
}

export function startEncoder(ffmpeg: FfmpegRunner, target: ExportTarget): Encoder {
  const layout = pixelLayoutOf(target.format)
  const hasEvenSize = target.width > 0 && target.height > 0 && target.width % 2 === 0 && target.height % 2 === 0
  if (layout === 'yuv420p' && !hasEvenSize) throw new EncoderError(`${target.format.toUpperCase()} video needs an even picture size, not ${target.width}x${target.height}`)

  const temporaryPath = temporaryPathFor(target.path)
  const hasPicture = hasMovingPicture(target.format) || target.format === 'png'
  const isHeard = target.hasAudio && hasSound(target.format)
  const pictureBytes = layout === 'yuv420p' ? (target.width * target.height * 3) / 2 : target.width * target.height * 4
  const inputs: string[] = []
  if (hasPicture) inputs.push('-thread_queue_size', '1', '-f', 'rawvideo', '-pix_fmt', layout, '-s', `${target.width}x${target.height}`, '-framerate', `${target.frameRate.num}/${target.frameRate.den}`, '-i', 'pipe:0')
  if (isHeard) inputs.push('-f', 'f32le', '-ar', String(SAMPLE_RATE), '-ch_layout', 'stereo', '-i', hasPicture ? AUDIO_PIPE : 'pipe:0')
  const maps: string[] = []
  if (hasPicture) maps.push('-map', '0:v')
  if (isHeard) maps.push('-map', hasPicture ? '1:a' : '0:a', ...soundArguments(target))
  const args = [...inputs, ...maps, ...formatArguments(target), '-y', temporaryPath]
  const hasAudioPipe = hasPicture && isHeard
  const job = ffmpeg.spawnJob('ffmpeg', args, { extraInputPipes: hasAudioPipe ? 1 : 0 })
  const audioPipe = job.pipes[0]
  if (hasAudioPipe && audioPipe === undefined) throw new EncoderError('The encoder was started without an audio input')

  async function write(pixels: ArrayBuffer, audio: Float32Array): Promise<void> {
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
    // On macOS ending an extra pipe does not always wake FFmpeg's read of it; destroying it does.
    if (audioPipe !== undefined) audioPipe.end(() => audioPipe.destroy())
    let writtenBytes = 0
    try {
      writtenBytes = (await stat(temporaryPath)).size
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
    const limitMs = FINISH_BASE_MS + writtenBytes / SLOWEST_REWRITE_BYTES_PER_MS
    let timer: NodeJS.Timeout | undefined
    const limitSeconds = Math.round(limitMs / MS_PER_SECOND)
    const timedOut = new Promise<never>((_resolve, reject) => {
      const tooSlow = new EncoderError(`The encoder did not finish the file within ${limitSeconds} s of the last frame`)
      timer = setTimeout(() => reject(tooSlow), limitMs)
    })
    try {
      await Promise.race([job.done, timedOut])
    } catch (error) {
      job.kill()
      await rm(temporaryPath, { force: true })
      throw error
    } finally {
      clearTimeout(timer)
    }
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
