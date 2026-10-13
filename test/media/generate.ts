import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeAll, type FfmpegRunner } from '../../src/media/ffmpeg.js'

const GENERATOR_VERSION = '4'
const JOB_TIMEOUT_MS = 300_000

const MEDIA_DIRECTORY = join(import.meta.dirname, 'generated')
export const BARCODE_BITS = 16
export const BARCODE_HEIGHT_FRACTION = 8

const RAMP_SAMPLE_RATE = 48_000
const RAMP_SECONDS = 2
export const CLICK_SAMPLE_44K = 22_050

export type VideoPattern = {
  width: number
  height: number
  rate: string
}

const SMALL: VideoPattern = { width: 320, height: 180, rate: '30' }
const SMALL_FRAMES = 60

export function mediaPath(name: string): string {
  return join(MEDIA_DIRECTORY, name)
}

export function barcodeSource(pattern: VideoPattern): string {
  const boxWidth = pattern.width / BARCODE_BITS
  const boxHeight = Math.round(pattern.height / BARCODE_HEIGHT_FRACTION)
  const filters = [
    `testsrc2=size=${pattern.width}x${pattern.height}:rate=${pattern.rate}`,
    `drawbox=x=0:y=0:w=iw:h=${boxHeight}:color=black:t=fill`,
  ]
  for (let bit = 0; bit < BARCODE_BITS; bit++) {
    const isSet = `eq(mod(floor(n/${2 ** bit}),2),1)`
    filters.push(`drawbox=x=${bit * boxWidth}:y=0:w=${boxWidth}:h=${boxHeight}:color=white:t=fill:enable='${isSet}'`)
  }
  return filters.join(',')
}

function rampWav(): Buffer {
  const sampleCount = RAMP_SAMPLE_RATE * RAMP_SECONDS
  const samples = Buffer.alloc(sampleCount * 4)
  for (let index = 0; index < sampleCount; index++) {
    const left = (index % 65_536) - 32_768
    samples.writeInt16LE(left, index * 4)
    samples.writeInt16LE(-left - 1, index * 4 + 2)
  }
  return wavFile(samples, RAMP_SAMPLE_RATE, 2)
}

function clickWav(): Buffer {
  const samples = Buffer.alloc(44_100 * 2)
  samples.writeInt16LE(32_767, CLICK_SAMPLE_44K * 2)
  return wavFile(samples, 44_100, 1)
}

function wavFile(samples: Buffer, sampleRate: number, channels: number): Buffer {
  const header = Buffer.alloc(44)
  const bytesPerFrame = channels * 2
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + samples.length, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * bytesPerFrame, 28)
  header.writeUInt16LE(bytesPerFrame, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(samples.length, 40)
  return Buffer.concat([header, samples])
}

export function alphaCard(width: number, height: number): Buffer {
  const pixels = Buffer.alloc(width * height * 4)
  const barColors = [
    [255, 255, 255],
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
    [255, 255, 0],
    [0, 255, 255],
    [255, 0, 255],
    [32, 32, 32],
  ]
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const color = barColors[Math.floor((x * barColors.length) / width)] ?? [0, 0, 0]
      const offset = (y * width + x) * 4
      pixels[offset] = color[0] ?? 0
      pixels[offset + 1] = color[1] ?? 0
      pixels[offset + 2] = color[2] ?? 0
      pixels[offset + 3] = Math.round(255 * (1 - y / (height - 1)))
    }
  }
  return pixels
}

type Color = {
  red: number
  green: number
  blue: number
}

const BLACK: Color = { red: 0, green: 0, blue: 0 }
const WHITE: Color = { red: 255, green: 255, blue: 255 }
export const KEY_GREEN: Color = { red: 0, green: 177, blue: 64 }
export const SUBJECT_MAGENTA: Color = { red: 200, green: 40, blue: 160 }

// An opaque card whose every pixel is painted by a rule, for checks that work a pixel out by hand.
function paintedCard(width: number, height: number, colorAt: (x: number, y: number) => Color): Buffer {
  const pixels = Buffer.alloc(width * height * 4, 255)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const color = colorAt(x, y)
      const offset = (y * width + x) * 4
      pixels[offset] = color.red
      pixels[offset + 1] = color.green
      pixels[offset + 2] = color.blue
    }
  }
  return pixels
}

function solidCard(color: Color): (width: number, height: number) => Buffer {
  return (width, height) => paintedCard(width, height, () => color)
}

// Black on the left half, white on the right: one hard edge down the middle.
function edgeCard(width: number, height: number): Buffer {
  return paintedCard(width, height, (x) => (x < width / 2 ? BLACK : WHITE))
}

// A magenta subject in the middle of a green screen: the middle three eighths of the width and four ninths of the height.
function greenScreenCard(width: number, height: number): Buffer {
  return paintedCard(width, height, (x, y) => {
    const isSubject = x >= width * 0.3125 && x < width * 0.6875 && y >= height * (5 / 18) && y < height * (13 / 18)
    return isSubject ? SUBJECT_MAGENTA : KEY_GREEN
  })
}

const ALPHA_CLIP_FRAMES = 10

function repeatedCard(): Buffer {
  const card = alphaCard(320, 180)
  return Buffer.concat(Array<Buffer>(ALPHA_CLIP_FRAMES).fill(card))
}

type Recipe = {
  name: string
  build(tools: Tools): Promise<void>
}

type Tools = {
  ffmpeg(args: readonly string[]): Promise<void>
  ffmpegWithInput(args: readonly string[], input: Buffer): Promise<void>
}

const TO_BT709 = 'scale=out_color_matrix=bt709:out_range=tv'
const TO_BT601 = 'scale=out_color_matrix=bt601:out_range=tv'
const TO_JPEG_RANGE = 'scale=out_color_matrix=bt601:out_range=pc'
const H264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-pix_fmt', 'yuv420p', '-g', '30']
const BT709_TAGS = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv']
const AAC = ['-c:a', 'aac', '-b:a', '128k']

function lavfi(pattern: VideoPattern): string[] {
  return ['-f', 'lavfi', '-i', barcodeSource(pattern)]
}

function ramp(): string[] {
  return ['-i', mediaPath('audio.wav')]
}

type ClipOptions = {
  pattern?: VideoPattern
  frames?: number
  filter?: string
}

function clip(name: string, codec: readonly string[], options: ClipOptions = {}): Recipe {
  return encodedClip(name, codec, options, ramp())
}

function alphaClip(name: string, encoding: readonly string[]): Recipe {
  return {
    name,
    build: (tools) =>
      tools.ffmpegWithInput(['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', '320x180', '-framerate', '30', '-i', 'pipe:0', ...encoding, mediaPath(name)], repeatedCard()),
  }
}

function silentClip(name: string, codec: readonly string[], options: ClipOptions = {}): Recipe {
  return encodedClip(name, codec, options, [])
}

function encodedClip(name: string, codec: readonly string[], options: ClipOptions, audioInput: readonly string[]): Recipe {
  const pattern = options.pattern ?? SMALL
  const frames = options.frames ?? SMALL_FRAMES
  const filter = options.filter ?? TO_BT709
  const shortest = audioInput.length > 0 ? ['-shortest'] : []
  return {
    name,
    build: (tools) =>
      tools.ffmpeg([...lavfi(pattern), ...audioInput, '-frames:v', String(frames), ...shortest, '-vf', filter, ...codec, mediaPath(name)]),
  }
}

function remux(name: string, from: string, extra: readonly string[] = []): Recipe {
  return {
    name,
    build: (tools) => tools.ffmpeg(['-i', mediaPath(from), '-c', 'copy', ...extra, mediaPath(name)]),
  }
}

function audio(name: string, codec: readonly string[], from = 'audio.wav'): Recipe {
  return {
    name,
    build: (tools) => tools.ffmpeg(['-i', mediaPath(from), ...codec, mediaPath(name)]),
  }
}

function rawImage(name: string, width: number, height: number, codec: readonly string[] = [], card: (width: number, height: number) => Buffer = alphaCard): Recipe {
  return {
    name,
    build: (tools) =>
      tools.ffmpegWithInput(
        ['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-i', 'pipe:0', ...codec, mediaPath(name)],
        card(width, height),
      ),
  }
}

function damaged(name: string, from: string, damage: (original: Buffer) => Buffer): Recipe {
  return {
    name,
    build: async () => {
      await writeFile(mediaPath(name), damage(await readFile(mediaPath(from))))
    },
  }
}

function withFlippedBytes(original: Buffer): Buffer {
  const corrupted = Buffer.from(original)
  for (let offset = 1024; offset < corrupted.length - 1024; offset += 211) {
    corrupted[offset] = (corrupted[offset] ?? 0) ^ 0xff
  }
  return corrupted
}

const RATE_VARIANTS: readonly { name: string; rate: string }[] = [
  { name: 'fps-23976.mp4', rate: '24000/1001' },
  { name: 'fps-24.mp4', rate: '24' },
  { name: 'fps-25.mp4', rate: '25' },
  { name: 'fps-2997.mp4', rate: '30000/1001' },
  { name: 'fps-50.mp4', rate: '50' },
  { name: 'fps-5994.mp4', rate: '60000/1001' },
  { name: 'fps-60.mp4', rate: '60' },
  { name: 'fps-120.mp4', rate: '120' },
]

const RECIPES: readonly Recipe[] = [
  { name: 'audio.wav', build: () => writeFile(mediaPath('audio.wav'), rampWav()) },
  { name: 'audio-44k-click.wav', build: () => writeFile(mediaPath('audio-44k-click.wav'), clickWav()) },

  clip('h264.mp4', [...H264, ...BT709_TAGS, ...AAC, '-movflags', '+faststart']),
  remux('h264.m4v', 'h264.mp4'),
  remux('h264.mov', 'h264.mp4'),
  remux('h264.mkv', 'h264.mp4'),
  remux('h264.flv', 'h264.mp4'),
  remux('h264.ts', 'h264.mp4'),
  remux('h264.mts', 'h264.mp4', ['-f', 'mpegts']),
  remux('h264.3gp', 'h264.mp4'),
  clip('hevc.mp4', ['-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1', ...BT709_TAGS, ...AAC]),
  clip('prores.mov', ['-c:v', 'prores_ks', '-profile:v', '2', '-pix_fmt', 'yuv422p10le', ...BT709_TAGS, '-c:a', 'pcm_s16le']),
  clip('vp8.webm', ['-c:v', 'libvpx', '-b:v', '1M', '-deadline', 'realtime', '-c:a', 'libvorbis']),
  clip('vp9.webm', ['-c:v', 'libvpx-vp9', '-b:v', '1M', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus']),
  clip('av1.mp4', ['-c:v', 'libsvtav1', '-preset', '12', '-pix_fmt', 'yuv420p', ...AAC]),
  clip('mpeg4.avi', ['-c:v', 'mpeg4', '-q:v', '3', '-c:a', 'libmp3lame']),
  clip('mjpeg.avi', ['-c:v', 'mjpeg', '-q:v', '3', '-pix_fmt', 'yuvj420p', '-c:a', 'pcm_s16le'], { filter: TO_JPEG_RANGE }),
  clip('dnxhr.mov', ['-c:v', 'dnxhd', '-profile:v', 'dnxhr_lb', '-pix_fmt', 'yuv422p', '-c:a', 'pcm_s16le'], { pattern: { width: 640, height: 360, rate: '30' }, frames: 30 }),

  silentClip('h264-untagged-hd.mp4', H264, { pattern: { width: 1280, height: 720, rate: '30' }, frames: 30 }),
  silentClip('h264-untagged-sd.mp4', H264, { filter: TO_BT601 }),
  silentClip('anamorphic.mp4', [...H264, ...BT709_TAGS], { filter: `${TO_BT709},setsar=4/3` }),
  { name: 'rotated-90.mp4', build: (tools) => tools.ffmpeg(['-display_rotation', '90', '-i', mediaPath('h264.mp4'), '-c', 'copy', mediaPath('rotated-90.mp4')]) },
  { name: 'rotated-270.mp4', build: (tools) => tools.ffmpeg(['-display_rotation', '270', '-i', mediaPath('h264.mp4'), '-c', 'copy', mediaPath('rotated-270.mp4')]) },
  ...RATE_VARIANTS.map((variant) =>
    silentClip(variant.name, [...H264, ...BT709_TAGS], { pattern: { width: 320, height: 180, rate: variant.rate }, frames: 48 }),
  ),
  silentClip('long-gop.mp4', ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', '90', '-bf', '3', ...BT709_TAGS], { frames: 200 }),
  remux('long-gop.mkv', 'long-gop.mp4'),
  remux('long-gop.ts', 'long-gop.mp4'),
  {
    name: 'delayed-video.mkv',
    build: (tools) =>
      tools.ffmpeg(['-itsoffset', '0.1', '-i', mediaPath('h264.mp4'), '-i', mediaPath('audio.wav'), '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'flac', mediaPath('delayed-video.mkv')]),
  },
  {
    name: 'delayed-audio.mkv',
    build: (tools) =>
      tools.ffmpeg(['-i', mediaPath('h264.mp4'), '-itsoffset', '0.25', '-i', mediaPath('audio.wav'), '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'flac', mediaPath('delayed-audio.mkv')]),
  },
  {
    name: 'variable-rate.mkv',
    build: (tools) =>
      tools.ffmpeg([
        ...lavfi({ width: 320, height: 180, rate: '60' }),
        '-frames:v',
        '90',
        '-vf',
        `select='not(mod(n,3))+gt(mod(n,7),4)',${TO_BT709}`,
        '-fps_mode',
        'vfr',
        ...H264,
        ...BT709_TAGS,
        mediaPath('variable-rate.mkv'),
      ]),
  },
  {
    name: 'hevc-hlg-portrait.mov',
    build: async (tools) => {
      const upright = mediaPath('hevc-hlg-upright.mov')
      await tools.ffmpeg([
        ...lavfi(SMALL),
        '-frames:v',
        '30',
        '-c:v',
        'libx265',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p10le',
        '-tag:v',
        'hvc1',
        '-x265-params',
        'colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc',
        upright,
      ])
      await tools.ffmpeg(['-display_rotation', '90', '-i', upright, '-c', 'copy', mediaPath('hevc-hlg-portrait.mov')])
      await rm(upright)
    },
  },
  silentClip('8k.mp4', ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', ...BT709_TAGS], { pattern: { width: 7680, height: 4320, rate: '30' }, frames: 4 }),
  silentClip('4k-long-gop.mp4', ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-pix_fmt', 'yuv420p', '-g', '250', ...BT709_TAGS], { pattern: { width: 3840, height: 2160, rate: '30' }, frames: 300 }),
  silentClip('1080p.mp4', ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '26', '-pix_fmt', 'yuv420p', '-g', '60', ...BT709_TAGS], { pattern: { width: 1920, height: 1080, rate: '30' }, frames: 150 }),

  alphaClip('prores4444-alpha.mov', ['-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', ...BT709_TAGS]),
  alphaClip('vp9-alpha.webm', ['-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '1M', '-deadline', 'realtime', '-cpu-used', '8']),
  alphaClip('lossless-alpha.mov', ['-c:v', 'png', '-pix_fmt', 'rgba']),

  audio('audio.mp3', ['-c:a', 'libmp3lame', '-b:a', '192k']),
  audio('audio.m4a', AAC),
  audio('audio-alac.m4a', ['-c:a', 'alac']),
  audio('audio.aiff', ['-c:a', 'pcm_s16be']),
  audio('audio.flac', ['-c:a', 'flac']),
  audio('audio.ogg', ['-c:a', 'libvorbis']),
  audio('audio.opus', ['-c:a', 'libopus']),
  audio('audio-mono.wav', ['-ac', '1']),
  audio('audio-surround.wav', ['-ac', '6']),
  audio('audio-96k-24bit.flac', ['-ar', '96000', '-c:a', 'flac', '-sample_fmt', 's32']),

  rawImage('image-alpha.png', 320, 180),
  rawImage('image.jpg', 320, 180, ['-q:v', '3']),
  rawImage('image.webp', 320, 180, ['-c:v', 'libwebp', '-lossless', '1']),
  rawImage('image.gif', 320, 180),
  rawImage('image-red.png', 320, 180, [], solidCard({ red: 255, green: 0, blue: 0 })),
  rawImage('image-blue.png', 320, 180, [], solidCard({ red: 0, green: 0, blue: 255 })),
  rawImage('image-white.png', 320, 180, [], solidCard(WHITE)),
  rawImage('image-edge.png', 320, 180, [], edgeCard),
  rawImage('image-green-screen.png', 320, 180, [], greenScreenCard),
  silentClip('animated.gif', [], { pattern: { width: 160, height: 90, rate: '10' }, frames: 12, filter: 'null' }),
  silentClip('animated.webp', ['-c:v', 'libwebp_anim', '-loop', '0'], { pattern: { width: 160, height: 90, rate: '10' }, frames: 12, filter: 'null' }),
  silentClip('animated.apng', ['-f', 'apng', '-plays', '0'], { pattern: { width: 160, height: 90, rate: '10' }, frames: 12, filter: 'null' }),

  damaged('broken-no-index.mp4', 'long-gop.mp4', (original) => original.subarray(0, Math.floor(original.length * 0.6))),
  damaged('broken-truncated.mp4', 'h264.mp4', (original) => original.subarray(0, Math.floor(original.length * 0.5))),
  damaged('broken-bitflips.mp4', 'h264.mp4', withFlippedBytes),
  damaged('broken-garbage.mp4', 'h264.mp4', (original) => Buffer.alloc(original.length, 0x5a)),
  { name: 'broken-empty.mp4', build: () => writeFile(mediaPath('broken-empty.mp4'), '') },
  { name: 'broken-text.mp3', build: () => writeFile(mediaPath('broken-text.mp3'), 'This is not an MP3 file.\n') },
]

export const MEDIA_NAMES: readonly string[] = RECIPES.map((recipe) => recipe.name)

export async function generateTestMedia(ffmpeg: FfmpegRunner): Promise<void> {
  const versionPath = mediaPath('VERSION')
  const isCurrent = existsSync(versionPath) && (await readFile(versionPath, 'utf8')) === GENERATOR_VERSION
  if (!isCurrent) await rm(MEDIA_DIRECTORY, { recursive: true, force: true })
  await mkdir(MEDIA_DIRECTORY, { recursive: true })

  const tools: Tools = {
    async ffmpeg(args) {
      await ffmpeg.runOnce('ffmpeg', ['-y', ...args], { timeoutMs: JOB_TIMEOUT_MS })
    },
    async ffmpegWithInput(args, input) {
      const job = ffmpeg.spawnJob('ffmpeg', ['-y', ...args])
      await writeAll(job.stdin, input)
      job.stdin.end()
      await job.done
    },
  }

  for (const recipe of RECIPES) {
    if (existsSync(mediaPath(recipe.name))) continue
    try {
      await recipe.build(tools)
    } catch (error) {
      await rm(mediaPath(recipe.name), { force: true })
      throw new Error(`Could not generate test media ${recipe.name}`, { cause: error })
    }
  }
  await writeFile(versionPath, GENERATOR_VERSION)
}
