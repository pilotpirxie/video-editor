import { rename, rm } from 'node:fs/promises'
import { encoderLimits } from '../shared/limits.js'
import type { ExportTarget } from '../shared/mediaProtocol.js'
import { SAMPLE_RATE } from '../shared/time.js'
import { FfmpegError, writeAll, type FfmpegRunner } from './ffmpeg.js'

const AUDIO_PIPE = 'pipe:3'
const X264_QUALITY = 20
const AAC_BITRATE = '192k'
const TO_VIDEO_COLOR = [
  'scale=out_color_matrix=bt709:out_range=tv',
  'format=yuv420p',
  'setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv',
].join(',')

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

export function startEncoder(ffmpeg: FfmpegRunner, target: ExportTarget): Encoder {
  const hasEvenSize = target.width > 0 && target.height > 0 && target.width % 2 === 0 && target.height % 2 === 0
  if (!hasEvenSize) throw new EncoderError(`H.264 needs an even picture size, not ${target.width}×${target.height}`)

  const limits = encoderLimits(target.width * target.height)
  const temporaryPath = temporaryPathFor(target.path)
  const args = [
    '-thread_queue_size',
    '1',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgba',
    '-s',
    `${target.width}x${target.height}`,
    '-framerate',
    `${target.frameRate.num}/${target.frameRate.den}`,
    '-i',
    'pipe:0',
    '-f',
    'f32le',
    '-ar',
    String(SAMPLE_RATE),
    '-ch_layout',
    'stereo',
    '-i',
    AUDIO_PIPE,
    '-map',
    '0:v',
    '-map',
    '1:a',
    '-vf',
    TO_VIDEO_COLOR,
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    String(X264_QUALITY),
    '-profile:v',
    'high',
    '-threads',
    String(limits.threads),
    '-x264-params',
    `rc-lookahead=${limits.lookahead}:ref=${limits.references}`,
    '-c:a',
    'aac',
    '-b:a',
    AAC_BITRATE,
    '-movflags',
    '+faststart',
    '-f',
    'mp4',
    '-y',
    temporaryPath,
  ]
  const job = ffmpeg.spawnJob('ffmpeg', args, { extraInputPipes: 1 })
  const audioPipe = job.pipes[0]
  if (audioPipe === undefined) throw new EncoderError('The encoder was started without an audio input')

  async function write(pixels: ArrayBuffer, audio: Float32Array): Promise<void> {
    audioPipe?.write(Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength))
    try {
      await writeAll(job.stdin, new Uint8Array(pixels))
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
