import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createFfmpegRunner, writeAll, type FfmpegRunner } from '../src/media/ffmpeg.js'
import { BARCODE_BITS, BARCODE_HEIGHT_FRACTION, barcodeSource, type VideoPattern } from './media/generate.js'

export const ROOT = join(import.meta.dirname, '..')
export const FFMPEG_DIR = join(ROOT, 'vendor', 'ffmpeg')

const BYTES_PER_PIXEL = 4
const WHITE_THRESHOLD = 128
const PEAK_SQUARED = 255 * 255

/** RGBA pixels, top row first. */
export type Picture = {
  width: number
  height: number
  data: ArrayBuffer
}

export function bundledFfmpeg(): FfmpegRunner {
  return createFfmpegRunner(FFMPEG_DIR)
}

/** Reads the frame number a generated test clip drew along its top edge. */
export function readBarcode(picture: Picture): number {
  const pixels = new Uint8Array(picture.data)
  const row = Math.floor(picture.height / BARCODE_HEIGHT_FRACTION / 2)
  let frameNumber = 0
  for (let bit = 0; bit < BARCODE_BITS; bit++) {
    const column = Math.floor(((bit + 0.5) * picture.width) / BARCODE_BITS)
    const red = pixels[(row * picture.width + column) * BYTES_PER_PIXEL] ?? 0
    if (red >= WHITE_THRESHOLD) frameNumber += 2 ** bit
  }
  return frameNumber
}

/** Peak signal-to-noise ratio over the colour channels, in dB. Identical pictures give Infinity. */
export function psnr(a: Picture, b: Picture): number {
  if (a.width !== b.width || a.height !== b.height) throw new Error(`Cannot compare ${a.width}×${a.height} with ${b.width}×${b.height}`)
  const first = new Uint8Array(a.data)
  const second = new Uint8Array(b.data)
  let squaredError = 0
  let count = 0
  for (let offset = 0; offset < first.length; offset += BYTES_PER_PIXEL) {
    for (let channel = 0; channel < 3; channel++) {
      const difference = (first[offset + channel] ?? 0) - (second[offset + channel] ?? 0)
      squaredError += difference * difference
      count += 1
    }
  }
  if (squaredError === 0) return Infinity
  return 10 * Math.log10(PEAK_SQUARED / (squaredError / count))
}

export type ColorMatrix = 'bt709' | 'bt601'

/**
 * Frame `index` of a generated clip's pattern as it looks when its 4:2:0 picture was written
 * with one colour matrix and is read back with another. The same matrix twice is the true picture.
 */
export async function patternFrame(ffmpeg: FfmpegRunner, pattern: VideoPattern, index: number, writtenWith: ColorMatrix, readWith: ColorMatrix): Promise<Picture> {
  const frameBytes = pattern.width * pattern.height * BYTES_PER_PIXEL
  const filter = [
    `scale=out_color_matrix=${writtenWith}:out_range=tv`,
    'format=yuv420p',
    `scale=in_color_matrix=${readWith}:in_range=tv`,
    'format=rgba',
  ].join(',')
  const frames = await ffmpeg.runOnce(
    'ffmpeg',
    ['-f', 'lavfi', '-i', barcodeSource(pattern), '-frames:v', String(index + 1), '-vf', filter, '-f', 'rawvideo', '-'],
    { timeoutMs: 60_000 },
  )
  const wanted = frames.subarray(index * frameBytes, (index + 1) * frameBytes)
  const data = new ArrayBuffer(frameBytes)
  new Uint8Array(data).set(wanted)
  return { width: pattern.width, height: pattern.height, data }
}

/** The picture turned a quarter turn counter-clockwise. */
export function rotatedCounterClockwise(picture: Picture): Picture {
  const source = new Uint32Array(picture.data)
  const width = picture.height
  const height = picture.width
  const target = new Uint32Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sourceX = picture.width - 1 - y
      const sourceY = x
      target[y * width + x] = source[sourceY * picture.width + sourceX] ?? 0
    }
  }
  return { width, height, data: target.buffer }
}

export function pixelAt(picture: Picture, x: number, y: number): { red: number; green: number; blue: number; alpha: number } {
  const pixels = new Uint8Array(picture.data)
  const offset = (y * picture.width + x) * BYTES_PER_PIXEL
  return {
    red: pixels[offset] ?? 0,
    green: pixels[offset + 1] ?? 0,
    blue: pixels[offset + 2] ?? 0,
    alpha: pixels[offset + 3] ?? 0,
  }
}

/** Decodes one JPEG the way a browser does: full-range BT.601. */
export async function decodeJpeg(ffmpeg: FfmpegRunner, jpeg: Buffer, width: number, height: number): Promise<Picture> {
  const job = ffmpeg.spawnJob('ffmpeg', ['-f', 'mjpeg', '-i', 'pipe:0', '-vf', 'scale=in_color_matrix=bt601:in_range=pc,format=rgba', '-f', 'rawvideo', '-'])
  await writeAll(job.stdin, jpeg)
  job.stdin.end()
  const pixels = await job.readExact(width * height * BYTES_PER_PIXEL, 30_000)
  await job.done
  if (pixels === undefined) throw new Error(`The JPEG did not decode to ${width}×${height}`)
  const data = new ArrayBuffer(pixels.length)
  new Uint8Array(data).set(pixels)
  return { width, height, data }
}

/**
 * Mean absolute colour difference between two pictures after averaging each over square blocks.
 * Averaging hides compression noise and fine detail, leaving differences of overall colour.
 */
export function blockColorError(a: Picture, b: Picture, blockSize: number): number {
  if (a.width !== b.width || a.height !== b.height) throw new Error(`Cannot compare ${a.width}×${a.height} with ${b.width}×${b.height}`)
  const first = new Uint8Array(a.data)
  const second = new Uint8Array(b.data)
  let totalError = 0
  let blockCount = 0
  for (let top = 0; top + blockSize <= a.height; top += blockSize) {
    for (let left = 0; left + blockSize <= a.width; left += blockSize) {
      const difference = [0, 0, 0]
      for (let y = top; y < top + blockSize; y++) {
        for (let x = left; x < left + blockSize; x++) {
          const offset = (y * a.width + x) * BYTES_PER_PIXEL
          for (let channel = 0; channel < 3; channel++) {
            difference[channel] = (difference[channel] ?? 0) + (first[offset + channel] ?? 0) - (second[offset + channel] ?? 0)
          }
        }
      }
      for (const sum of difference) totalError += Math.abs(sum) / (blockSize * blockSize)
      blockCount += 3
    }
  }
  return totalError / blockCount
}

// ---- Driving the built app ----

const ELECTRON_BINARY = join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
const PROJECTS_DIRECTORY = join(ROOT, 'test', 'projects')
const GOLDEN_DIRECTORY = join(ROOT, 'test', 'golden')
const OUTPUT_DIRECTORY = join(ROOT, 'test', 'output')
const APP_TIMEOUT_MS = 180_000
/** Golden pictures may differ by this much per channel, to survive GPU driver updates… */
const GOLDEN_CHANNEL_TOLERANCE = 3
/** …and a few pixels in a thousand may differ by more (edges). */
const GOLDEN_OUTLIER_FRACTION = 0.002

export type AppResult = {
  stdout: string
  stderr: string
  exitCode: number | undefined
}

export type Size = {
  width: number
  height: number
}

export function projectPath(name: string): string {
  return join(PROJECTS_DIRECTORY, `${name}.json`)
}

/** Runs the built app with these command-line arguments and waits for it to exit. */
export function runApp(args: readonly string[], timeoutMs = APP_TIMEOUT_MS): Promise<AppResult> {
  return new Promise((resolve, reject) => {
    // A private profile keeps test runs away from the user's caches and from each other.
    const profile = mkdtempSync(join(tmpdir(), 'video-editor-test-'))
    const child = spawn(ELECTRON_BINARY, [ROOT, `--user-data-dir=${profile}`, ...args])
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (text: Buffer) => (stdout += text.toString()))
    child.stderr.on('data', (text: Buffer) => (stderr += text.toString()))
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`The app did not finish within ${timeoutMs} ms.\nstdout: ${stdout}\nstderr: ${stderr}`))
    }, timeoutMs)
    child.on('close', (code) => {
      clearTimeout(timer)
      rmSync(profile, { recursive: true, force: true })
      resolve({ stdout, stderr, exitCode: code ?? undefined })
    })
  })
}

export type FrameRequest = {
  /** Read originals by seeking (as the paused preview does) or in order (as an export does). */
  via: 'paused' | 'export'
  frames: readonly number[]
  /** Output size; the project canvas when left out. */
  size?: Size
}

/** Renders frames of a reference project with the built app; pictures come back in the order asked. */
export async function renderFrames(project: string, request: FrameRequest): Promise<Picture[]> {
  const directory = mkdtempSync(join(tmpdir(), 'video-editor-frames-'))
  const args = ['--frames', projectPath(project), '--via', request.via, '--at', request.frames.join(','), '--out', directory]
  if (request.size !== undefined) args.push('--size', `${request.size.width}x${request.size.height}`)
  try {
    const result = await runApp(args)
    if (result.exitCode !== 0) throw new Error(`Rendering ${project} failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`)
    const summary: unknown = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '')
    if (!isSize(summary)) throw new Error(`Unexpected render summary: ${result.stdout}`)

    const pictures: Picture[] = []
    for (const frame of request.frames) {
      const bytes = readFileSync(join(directory, `frame-${String(frame).padStart(6, '0')}.rgba`))
      const data = new ArrayBuffer(bytes.length)
      new Uint8Array(data).set(bytes)
      pictures.push({ width: summary.width, height: summary.height, data })
    }
    return pictures
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

function isSize(value: unknown): value is Size {
  return typeof value === 'object' && value !== null && 'width' in value && typeof value.width === 'number' && 'height' in value && typeof value.height === 'number'
}

export function sameBytes(a: Picture, b: Picture): boolean {
  return a.width === b.width && a.height === b.height && Buffer.from(a.data).equals(Buffer.from(b.data))
}

async function writePng(ffmpeg: FfmpegRunner, picture: Picture, path: string): Promise<void> {
  mkdirSync(dirname(path), { recursive: true })
  const job = ffmpeg.spawnJob('ffmpeg', ['-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${picture.width}x${picture.height}`, '-i', 'pipe:0', '-frames:v', '1', path])
  await writeAll(job.stdin, new Uint8Array(picture.data))
  job.stdin.end()
  await job.done
}

async function readPng(ffmpeg: FfmpegRunner, path: string, size: Size): Promise<Picture | undefined> {
  const bytes = await ffmpeg.runOnce('ffmpeg', ['-i', path, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { timeoutMs: 60_000 })
  if (bytes.length !== size.width * size.height * BYTES_PER_PIXEL) return undefined
  const data = new ArrayBuffer(bytes.length)
  new Uint8Array(data).set(bytes)
  return { ...size, data }
}

/**
 * Compares a picture with the stored golden image of that name. Run with UPDATE_GOLDEN=1 to
 * store the picture as the new golden. On a mismatch the actual picture is saved to test/output.
 */
export async function expectGolden(ffmpeg: FfmpegRunner, name: string, picture: Picture): Promise<void> {
  const goldenPath = join(GOLDEN_DIRECTORY, `${name}.png`)
  if (process.env.UPDATE_GOLDEN === '1') {
    await writePng(ffmpeg, picture, goldenPath)
    return
  }
  if (!existsSync(goldenPath)) throw new Error(`There is no golden image ${name}.png yet. Create it with UPDATE_GOLDEN=1 npm run test:engine`)

  const golden = await readPng(ffmpeg, goldenPath, picture)
  const actualPath = join(OUTPUT_DIRECTORY, `${name}.actual.png`)
  if (golden === undefined) {
    await writePng(ffmpeg, picture, actualPath)
    throw new Error(`${name}: the picture is ${picture.width}×${picture.height} but the golden image has another size. Actual saved to ${actualPath}`)
  }

  const actual = new Uint8Array(picture.data)
  const expected = new Uint8Array(golden.data)
  let outliers = 0
  let largest = 0
  for (let offset = 0; offset < actual.length; offset += BYTES_PER_PIXEL) {
    let pixelDifference = 0
    for (let channel = 0; channel < BYTES_PER_PIXEL; channel++) {
      pixelDifference = Math.max(pixelDifference, Math.abs((actual[offset + channel] ?? 0) - (expected[offset + channel] ?? 0)))
    }
    largest = Math.max(largest, pixelDifference)
    if (pixelDifference > GOLDEN_CHANNEL_TOLERANCE) outliers += 1
  }
  const allowedOutliers = picture.width * picture.height * GOLDEN_OUTLIER_FRACTION
  if (outliers > allowedOutliers) {
    await writePng(ffmpeg, picture, actualPath)
    throw new Error(`${name}: ${outliers} pixels differ from the golden image by more than ${GOLDEN_CHANNEL_TOLERANCE} (largest difference ${largest}). Actual saved to ${actualPath}`)
  }
}

/** Fraction of pixels that are not black. */
export function litFraction(picture: Picture): number {
  const pixels = new Uint8Array(picture.data)
  let lit = 0
  for (let offset = 0; offset < pixels.length; offset += BYTES_PER_PIXEL) {
    const brightness = (pixels[offset] ?? 0) + (pixels[offset + 1] ?? 0) + (pixels[offset + 2] ?? 0)
    if (brightness > 0) lit += 1
  }
  return lit / (picture.width * picture.height)
}

/** The part of `picture` inside the given rectangle. */
export function cropPicture(picture: Picture, left: number, top: number, width: number, height: number): Picture {
  const source = new Uint8Array(picture.data)
  const data = new ArrayBuffer(width * height * BYTES_PER_PIXEL)
  const target = new Uint8Array(data)
  for (let row = 0; row < height; row++) {
    const start = ((top + row) * picture.width + left) * BYTES_PER_PIXEL
    target.set(source.subarray(start, start + width * BYTES_PER_PIXEL), row * width * BYTES_PER_PIXEL)
  }
  return { width, height, data }
}

/** Mean absolute difference between horizontally neighbouring pixels: higher means crisper edges. */
export function edgeStrength(picture: Picture): number {
  const pixels = new Uint8Array(picture.data)
  let total = 0
  for (let y = 0; y < picture.height; y++) {
    for (let x = 1; x < picture.width; x++) {
      const offset = (y * picture.width + x) * BYTES_PER_PIXEL
      total += Math.abs((pixels[offset + 1] ?? 0) - (pixels[offset + 1 - BYTES_PER_PIXEL] ?? 0))
    }
  }
  return total / (picture.width * picture.height)
}

/** The picture reduced to half size by averaging 2×2 blocks. */
export function halved(picture: Picture): Picture {
  const source = new Uint8Array(picture.data)
  const width = picture.width / 2
  const height = picture.height / 2
  const data = new ArrayBuffer(width * height * BYTES_PER_PIXEL)
  const target = new Uint8Array(data)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let channel = 0; channel < BYTES_PER_PIXEL; channel++) {
        const topLeft = ((y * 2) * picture.width + x * 2) * BYTES_PER_PIXEL + channel
        const bottomLeft = topLeft + picture.width * BYTES_PER_PIXEL
        const sum = (source[topLeft] ?? 0) + (source[topLeft + BYTES_PER_PIXEL] ?? 0) + (source[bottomLeft] ?? 0) + (source[bottomLeft + BYTES_PER_PIXEL] ?? 0)
        target[(y * width + x) * BYTES_PER_PIXEL + channel] = Math.round(sum / 4)
      }
    }
  }
  return { width, height, data }
}
