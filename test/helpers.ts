import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { afterAll, expect, onTestFinished } from 'vitest'
import { allClips } from '../src/editor/clips.js'
import { createFfmpegRunner, writeAll, type FfmpegRunner } from '../src/media/ffmpeg.js'
import { parseProject, serializeProject, type CameraKeyframe, type Clip, type MediaRef, type Project, type Transform, type VideoClip } from '../src/shared/project.js'
import { SECOND } from './fixtures.js'
import { BARCODE_BITS, BARCODE_HEIGHT_FRACTION, barcodeSource, type VideoPattern } from './media/generate.js'

export const ROOT = join(import.meta.dirname, '..')
export const HAS_SAMPLES = existsSync(join(ROOT, 'samples', 'kangaroo1920.mp4'))
const FFMPEG_DIR = join(ROOT, 'vendor', 'ffmpeg')

const BYTES_PER_PIXEL = 4
const WHITE_THRESHOLD = 128
const PEAK_SQUARED = 255 * 255

export type Picture = {
  width: number
  height: number
  data: ArrayBuffer
}

export function scratchDirectory(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), `video-editor-${name}-`))
  afterAll(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

export function lastJsonLine(output: string): unknown {
  const lastLine = output.trim().split('\n').at(-1) ?? ''
  try {
    return JSON.parse(lastLine)
  } catch (error) {
    throw new Error(`The app did not end its output with JSON: ${output}`, { cause: error })
  }
}

export function bundledFfmpeg(): FfmpegRunner {
  return createFfmpegRunner(FFMPEG_DIR)
}

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

function comparablePixels(a: Picture, b: Picture): { first: Uint8Array; second: Uint8Array } {
  if (a.width !== b.width || a.height !== b.height) throw new Error(`Cannot compare ${a.width}×${a.height} with ${b.width}×${b.height}`)
  return { first: new Uint8Array(a.data), second: new Uint8Array(b.data) }
}

export function psnr(a: Picture, b: Picture): number {
  const { first, second } = comparablePixels(a, b)
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

export function blockColorError(a: Picture, b: Picture, blockSize: number): number {
  const { first, second } = comparablePixels(a, b)
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

export const ELECTRON_BINARY = join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
const PROJECTS_DIRECTORY = join(ROOT, 'test', 'projects')
const GOLDEN_DIRECTORY = join(ROOT, 'test', 'golden')
const OUTPUT_DIRECTORY = join(ROOT, 'test', 'output')
const APP_TIMEOUT_MS = 180_000
const GOLDEN_CHANNEL_TOLERANCE = 3
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

// A reference project by name, or any project file by its full path.
export function projectPath(name: string): string {
  return isAbsolute(name) ? name : join(PROJECTS_DIRECTORY, `${name}.json`)
}

// A test that launches the app twice passes the same profile, so the second launch sees what the first one stored.
export function runApp(args: readonly string[], timeoutMs = APP_TIMEOUT_MS, keptProfile?: string): Promise<AppResult> {
  return new Promise((resolve, reject) => {
    const profile = keptProfile ?? mkdtempSync(join(tmpdir(), 'video-editor-test-'))
    const child = spawn(ELECTRON_BINARY, [ROOT, `--user-data-dir=${profile}`, ...args])
    // A test that vitest times out leaves running what it started; the app would export on unseen and slow down the tests after it.
    onTestFinished(() => {
      child.kill('SIGKILL')
    })
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
      if (keptProfile === undefined) rmSync(profile, { recursive: true, force: true })
      resolve({ stdout, stderr, exitCode: code ?? undefined })
    })
  })
}

export type FrameRequest = {
  via: 'paused' | 'export'
  frames: readonly number[]
  size?: Size
}

export async function renderFrames(project: string, request: FrameRequest): Promise<Picture[]> {
  const directory = mkdtempSync(join(tmpdir(), 'video-editor-frames-'))
  const args = ['--frames', projectPath(project), '--via', request.via, '--at', request.frames.join(','), '--out', directory]
  if (request.size !== undefined) args.push('--size', `${request.size.width}x${request.size.height}`)
  try {
    const result = await runApp(args)
    if (result.exitCode !== 0) throw new Error(`Rendering ${project} failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`)
    const summary = lastJsonLine(result.stdout)
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

// The clips a test draws, one list per track with the bottom track first. Each clip names its media by its file in the generated test media.
export function projectOfTracks(canvas: Size, tracks: readonly (readonly Clip[])[], camera?: CameraKeyframe[]): Project {
  const projectTracks = tracks.map((clips, index) => ({ id: `track-${index}`, name: `Track ${index + 1}`, hidden: false, locked: false, muted: false, clips: [...clips] }))
  const media = new Map<string, MediaRef>()
  // The members of groups use media too.
  for (const clip of allClips(projectTracks)) {
    if ('mediaId' in clip) media.set(clip.mediaId, { id: clip.mediaId, path: join(ROOT, 'test', 'media', 'generated', clip.mediaId), relativePath: '' })
  }
  const project: Project = {
    version: 1,
    canvas: { ...canvas, frameRate: { num: 30, den: 1 } },
    media: [...media.values()],
    tracks: projectTracks,
  }
  if (camera !== undefined) project.camera = camera
  return project
}

type Span = {
  start: number
  duration: number
}

export function imageOf(file: string, id: string, span: Span, transform: Transform, settings: Partial<Extract<Clip, { type: 'image' }>> = {}): Clip {
  return { id, type: 'image', mediaId: file, ...span, transform, opacity: 1, ...settings }
}

export function videoOf(file: string, id: string, span: Span, transform: Transform, settings: Partial<VideoClip> = {}): Clip {
  return { id, type: 'video', mediaId: file, ...span, sourceStart: 0, speedPercent: 100, volume: 1, transform, opacity: 1, ...settings }
}

// Frames of a project that a test made up; it is written into `directory` first, as the editor would save it.
export function renderProject(directory: string, name: string, project: Project, request: FrameRequest): Promise<Picture[]> {
  const path = join(directory, `${name}.json`)
  writeFileSync(path, serializeProject(project))
  return renderFrames(path, request)
}

// What the tests that work pixels out by hand share: a small canvas, clips that last its first second, and a white picture that fills it.
export const SMALL_CANVAS = { width: 640, height: 360 }
export const FIRST_SECOND = { start: 0, duration: SECOND }
export const WHITE = { red: 255, green: 255, blue: 255 }
export const RED = { red: 255, green: 0, blue: 0 }
export const BLUE = { red: 0, green: 0, blue: 255 }

export function at(x: number, y: number, scale = 1, rotation = 0): Transform {
  return { x, y, scaleX: scale, scaleY: scale, rotation }
}

export const WHITE_GROUND = imageOf('image-white.png', 'ground', { start: 0, duration: 2 * SECOND }, at(320, 180, 2))

// One frame of the given tracks on the small canvas, the lowest track first, as the paused preview shows it.
export async function frameOfTracks(directory: string, name: string, tracks: readonly Clip[][], frame: number): Promise<Picture> {
  return pictureAt(await renderProject(directory, name, projectOfTracks(SMALL_CANVAS, tracks), { via: 'paused', frames: [frame] }), 0)
}

export function pictureAt(pictures: readonly Picture[], index: number): Picture {
  const picture = pictures[index]
  if (picture === undefined) throw new Error(`Picture ${index} was not rendered`)
  return picture
}

export type Rgb = {
  red: number
  green: number
  blue: number
}

export function expectPixel(picture: Picture, x: number, y: number, expected: Rgb, tolerance = 1): void {
  const actual = pixelAt(picture, x, y)
  const furthest = Math.max(Math.abs(actual.red - expected.red), Math.abs(actual.green - expected.green), Math.abs(actual.blue - expected.blue))
  expect(furthest, `pixel ${x},${y} is ${actual.red},${actual.green},${actual.blue}`).toBeLessThanOrEqual(tolerance)
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

export function litFraction(picture: Picture): number {
  const pixels = new Uint8Array(picture.data)
  let lit = 0
  for (let offset = 0; offset < pixels.length; offset += BYTES_PER_PIXEL) {
    const brightness = (pixels[offset] ?? 0) + (pixels[offset + 1] ?? 0) + (pixels[offset + 2] ?? 0)
    if (brightness > 0) lit += 1
  }
  return lit / (picture.width * picture.height)
}

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

const UI_TEST_TIMEOUT_MS = 300_000

// Runs one scenario of the in-app UI tests and gives back what it reported.
export async function uiTest(scenario: string, extraArgs: readonly string[] = [], profile?: string, timeoutMs = UI_TEST_TIMEOUT_MS): Promise<Record<string, unknown>> {
  const result = await runApp(['--uitest', scenario, ...extraArgs], timeoutMs, profile)
  if (result.exitCode !== 0) throw new Error(`The UI test "${scenario}" failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`)
  const report = lastJsonLine(result.stdout)
  if (typeof report !== 'object' || report === null) throw new Error(`Unexpected UI test report: ${result.stdout}`)
  return { ...report }
}

export function projectIn(report: Record<string, unknown>, stage: string): Project {
  const parsed = parseProject(JSON.stringify(report[stage]))
  if (!parsed.ok) throw new Error(`The project saved at "${stage}" is not valid: ${parsed.message}`)
  return parsed.project
}

export type ProbedExport = {
  video: Record<string, string>
  audio: Record<string, string>
  duration: number
}

function fieldsOf(line: string): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const pair of line.split('|').slice(1)) {
    const separator = pair.indexOf('=')
    fields[pair.slice(0, separator)] = pair.slice(separator + 1)
  }
  return fields
}

// What ffprobe says about an exported file; a stream that is not there gives an empty record.
// The first sound of a file as interleaved 32-bit floats.
export async function decodedAudio(path: string): Promise<Float32Array> {
  const raw = await bundledFfmpeg().runOnce('ffmpeg', ['-i', path, '-map', '0:a:0', '-f', 'f32le', '-'], { timeoutMs: 60_000 })
  const samples = new Float32Array(raw.length / 4)
  for (let index = 0; index < samples.length; index++) samples[index] = raw.readFloatLE(index * 4)
  return samples
}

export async function probeExport(path: string): Promise<ProbedExport> {
  const ffmpeg = bundledFfmpeg()
  const entries = 'stream=codec_type,codec_name,profile,pix_fmt,width,height,r_frame_rate,nb_frames,color_space,color_primaries,color_transfer,color_range,sample_rate,channels:format=duration'
  const output = (await ffmpeg.runOnce('ffprobe', ['-show_entries', entries, '-of', 'compact', path], { timeoutMs: 30_000 })).toString()
  const lines = output.trim().split('\n')
  const video = fieldsOf(lines.find((line) => line.includes('codec_type=video')) ?? '')
  const audio = fieldsOf(lines.find((line) => line.includes('codec_type=audio')) ?? '')
  const format = fieldsOf(lines.find((line) => line.startsWith('format')) ?? '')
  return { video, audio, duration: Number(format.duration) }
}
