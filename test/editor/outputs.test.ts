import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { exportSize } from '../../src/shared/exportPresets.js'
import { parseProject, type Project } from '../../src/shared/project.js'
import { MEDIA_DIRECTORY, blockColorError, bundledFfmpeg, decodedAudio, pictureAt, pixelAt, probeExport, projectPath, readBarcode, renderFrames, sameBytes, scratchDirectory, uiTest, type Picture, type Size } from '../helpers.js'

const ffmpeg = bundledFfmpeg()
const scratch = scratchDirectory('outputs')
const BYTES_PER_PIXEL = 4
// The screen of a Mac converts colours to its display; the tests read the pixels the editor drew, before that conversion.
const SRGB_SCREEN = '--force-color-profile=srgb'
// Averaged over 8×8 blocks, the export differs from the screen by its compression only: the colour of fine detail, not what is where.
const BLOCK = 8
const MAX_PAUSED_BLOCK_ERROR = 2
const MAX_CHANNEL_BIAS = 1.5
// Playback draws from MJPEG preview copies, whose colour detail is softer (§7); a camera zoomed to 300% magnifies that to about 5 levels.
// Which frame is shown is checked apart from this, against the neighbouring frames.
const PLAYING_BLOCK = 16
const MAX_PLAYING_BLOCK_ERROR = 6
const MIN_PLAYING_SAMPLES = 10
// How far either side of the timecode a playing picture is matched against the export, to tell which frame it is.
const NEIGHBOUR_FRAMES = 3
const TIE = 0.05

type Captured = Size & { file: string }
type PausedCapture = Captured & { timecode: string }
type PlayingCapture = Captured & { timecodeBefore: string; timecodeAfter: string }

type WysiwygReport = {
  canvas: Size
  paused: PausedCapture[]
  still: string
  movie: string
  playing: PlayingCapture[]
}

function isWysiwygReport(value: Record<string, unknown>): value is WysiwygReport & Record<string, unknown> {
  return Array.isArray(value.paused) && Array.isArray(value.playing) && typeof value.still === 'string' && typeof value.movie === 'string'
}

function pictureOf(bytes: Buffer, size: Size): Picture {
  const data = new ArrayBuffer(bytes.length)
  new Uint8Array(data).set(bytes)
  return { ...size, data }
}

function captureOf(captured: Captured): Picture {
  return pictureOf(readFileSync(captured.file), captured)
}

async function decodedVideo(path: string, size: Size): Promise<Picture[]> {
  const raw = await ffmpeg.runOnce('ffmpeg', ['-i', path, '-map', '0:v:0', '-vf', 'scale=in_color_matrix=bt709:in_range=tv,format=rgba', '-f', 'rawvideo', '-'], { timeoutMs: 120_000 })
  const frameBytes = size.width * size.height * BYTES_PER_PIXEL
  const frames: Picture[] = []
  for (let start = 0; start + frameBytes <= raw.length; start += frameBytes) frames.push(pictureOf(raw.subarray(start, start + frameBytes), size))
  return frames
}

async function decodedPng(path: string, size: Size): Promise<Picture> {
  return pictureOf(await ffmpeg.runOnce('ffmpeg', ['-i', path, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { timeoutMs: 30_000 }), size)
}

// The average signed difference of each colour channel: a shift of the whole picture that block errors would hide in the noise.
function channelBias(a: Picture, b: Picture): number[] {
  const first = new Uint8Array(a.data)
  const second = new Uint8Array(b.data)
  const sums = [0, 0, 0]
  for (let offset = 0; offset < first.length; offset += BYTES_PER_PIXEL) {
    for (let channel = 0; channel < 3; channel++) sums[channel] = (sums[channel] ?? 0) + (first[offset + channel] ?? 0) - (second[offset + channel] ?? 0)
  }
  const pixels = first.length / BYTES_PER_PIXEL
  return sums.map((sum) => Math.abs(sum / pixels))
}

function framesPerSecond(project: Project): number {
  return Math.round(project.canvas.frameRate.num / project.canvas.frameRate.den)
}

// "00:00:01:15" as a frame number; timecodes count whole frames per second, so 23.976 fps counts 24.
function frameOf(timecode: string, perSecond: number): number {
  const [hours = 0, minutes = 0, seconds = 0, frames = 0] = timecode.split(':').map(Number)
  return ((hours * 60 + minutes) * 60 + seconds) * perSecond + frames
}

function loadProject(name: string): Project {
  const parsed = parseProject(readFileSync(projectPath(name), 'utf8'))
  if (!parsed.ok) throw new Error(`${name} is not a valid project: ${parsed.message}`)
  return parsed.project
}

const reports = new Map<string, Promise<WysiwygReport>>()

// Each project is opened, scrubbed, exported and played once; its checks share what that run saw.
function wysiwyg(name: string): Promise<WysiwygReport> {
  let report = reports.get(name)
  if (report === undefined) {
    report = uiTest('wysiwyg', [SRGB_SCREEN, '--project', projectPath(name), '--out', join(scratch, name)]).then((found) => {
      if (!isWysiwygReport(found)) throw new Error(`Unexpected report: ${JSON.stringify(found)}`)
      return found
    })
    reports.set(name, report)
  }
  return report
}

// Which exported frame a picture shown while playing is: the closest of the frames around its timecode.
function closestFrames(picture: Picture, exported: readonly Picture[], from: number, to: number): { inRange: number; elsewhere: number } {
  let inRange = Infinity
  let elsewhere = Infinity
  for (let frame = Math.max(0, from - NEIGHBOUR_FRAMES); frame <= Math.min(exported.length - 1, to + NEIGHBOUR_FRAMES); frame++) {
    const candidate = exported[frame]
    if (candidate === undefined) continue
    const error = blockColorError(picture, candidate, PLAYING_BLOCK)
    if (frame >= from && frame <= to) inRange = Math.min(inRange, error)
    else elsewhere = Math.min(elsewhere, error)
  }
  return { inRange, elsewhere }
}

async function expectPlaybackLikeExport(name: string): Promise<void> {
  const report = await wysiwyg(name)
  const perSecond = framesPerSecond(loadProject(name))
  const exported = await decodedVideo(report.movie, report.canvas)
  expect(report.playing.length).toBeGreaterThanOrEqual(MIN_PLAYING_SAMPLES)
  const firstFrame = frameOf(report.playing[0]?.timecodeBefore ?? '', perSecond)
  const lastFrame = frameOf(report.playing.at(-1)?.timecodeAfter ?? '', perSecond)
  expect(lastFrame - firstFrame, 'frames played').toBeGreaterThanOrEqual(MIN_PLAYING_SAMPLES)

  for (const sample of report.playing) {
    const from = frameOf(sample.timecodeBefore, perSecond)
    const to = frameOf(sample.timecodeAfter, perSecond)
    if (from >= exported.length) continue
    const { inRange, elsewhere } = closestFrames(captureOf(sample), exported, from, to)
    const where = `${sample.file} at ${sample.timecodeBefore}–${sample.timecodeAfter}`
    expect(inRange, `${where} shows another frame`).toBeLessThanOrEqual(elsewhere + TIE)
    expect(inRange, `${where} differs from the export`).toBeLessThanOrEqual(MAX_PLAYING_BLOCK_ERROR)
  }
}

const PROJECTS = [
  '01-single-clip',
  '02-mosaic',
  '03-rotation-opacity',
  '04-crop',
  '05-fades',
  '06-keyframes',
  '07-speeds',
  '08-mixed-rates',
  '09-text',
  '11-tiny-canvas',
  '13-camera',
  '14-transitions',
  '16-effects',
  '17-callouts-arrows',
  '18-text-styles',
  '19-presets',
  '20-groups',
  '23-weird',
  // Four typewriter titles and four videos under a tenfold zoom: what is read ahead overflows the cache of pictures on every frame.
  '24-cache-pressure',
]

describe('what is on screen is what is exported', () => {
  it.each(PROJECTS)('%s: the paused preview equals the PNG and the engine, and matches the MP4', async (name) => {
    const report = await wysiwyg(name)
    const project = loadProject(name)
    const perSecond = framesPerSecond(project)
    expect(report.canvas).toEqual({ width: project.canvas.width, height: project.canvas.height })

    // The PNG of the current frame is exactly what the screen showed there, the first frame.
    const atStart = report.paused.at(-1)
    if (atStart === undefined) throw new Error('Nothing was captured')
    expect(atStart.timecode).toBe('00:00:00:00')
    expect(sameBytes(await decodedPng(report.still, report.canvas), captureOf(atStart)), 'the PNG equals the screen').toBe(true)

    // The window draws what the headless engine draws, pixel for pixel.
    const frames = report.paused.map((capture) => frameOf(capture.timecode, perSecond))
    const engine = await renderFrames(name, { via: 'paused', frames })
    for (const [index, capture] of report.paused.entries()) {
      const drawn = engine[index]
      if (drawn === undefined) throw new Error(`The engine drew nothing at ${capture.timecode}`)
      expect(sameBytes(captureOf(capture), drawn), `the screen at ${capture.timecode} equals the engine`).toBe(true)
    }

    // The MP4 has the project's size and length, and at every captured moment it shows what the screen showed.
    const probed = await probeExport(report.movie)
    expect(probed.video).toMatchObject({ width: String(project.canvas.width), height: String(project.canvas.height) })
    const exported = await decodedVideo(report.movie, report.canvas)
    expect(exported.length).toBe(frameOf(report.paused.at(-2)?.timecode ?? '', perSecond) + 1)
    for (const capture of report.paused) {
      const frame = exported[frameOf(capture.timecode, perSecond)]
      if (frame === undefined) throw new Error(`The MP4 has no frame at ${capture.timecode}`)
      const shown = captureOf(capture)
      expect(blockColorError(shown, frame, BLOCK), `the MP4 at ${capture.timecode}`).toBeLessThanOrEqual(MAX_PAUSED_BLOCK_ERROR)
      for (const bias of channelBias(shown, frame)) expect(bias, `the colour of the MP4 at ${capture.timecode}`).toBeLessThanOrEqual(MAX_CHANNEL_BIAS)
    }
  })

  it.each(PROJECTS)('%s: playback shows the frame of its timecode, as exported', expectPlaybackLikeExport)

  it('01-single-clip: the frame number burnt into the video matches the timecode while playing', async () => {
    const report = await wysiwyg('01-single-clip')
    for (const sample of report.playing) {
      const shown = readBarcode(captureOf(sample))
      expect(shown, sample.file).toBeGreaterThanOrEqual(frameOf(sample.timecodeBefore, 30))
      expect(shown, sample.file).toBeLessThanOrEqual(frameOf(sample.timecodeAfter, 30))
    }
  })
})

const CANVAS = { width: 640, height: 360 }
const SAMPLE_RATE = 48_000
const FRAMES_PER_SECOND = 30
const MAX_HALF_OPACITY_ERROR = 1
// Where the title "Hi" is drawn, in the middle of the 640 x 360 canvas.
const TITLE_AREA = { left: 290, top: 160, width: 60, height: 40 }
const NEAR_WHITE = 230
const MIN_TITLE_PIXELS = 50

function meanBrightness(picture: Picture): number {
  const pixels = new Uint8Array(picture.data)
  let sum = 0
  for (let offset = 0; offset < pixels.length; offset += BYTES_PER_PIXEL) sum += ((pixels[offset] ?? 0) + (pixels[offset + 1] ?? 0) + (pixels[offset + 2] ?? 0)) / 3
  return sum / (pixels.length / BYTES_PER_PIXEL)
}

function rootMeanSquare(samples: Float32Array): number {
  let sumOfSquares = 0
  for (const sample of samples) sumOfSquares += sample * sample
  return Math.sqrt(sumOfSquares / samples.length)
}

function nearWhiteIn(picture: Picture, area: typeof TITLE_AREA): number {
  let count = 0
  for (let y = area.top; y < area.top + area.height; y++) {
    for (let x = area.left; x < area.left + area.width; x++) {
      const pixel = pixelAt(picture, x, y)
      if (Math.min(pixel.red, pixel.green, pixel.blue) > NEAR_WHITE) count += 1
    }
  }
  return count
}

describe('every edit made in the window reaches the exported file', () => {
  let exported: Record<string, string> = {}
  let finalProject: Project | undefined

  function file(name: string): string {
    const path = exported[name]
    if (path === undefined) throw new Error(`${name} was not exported`)
    return path
  }

  it('edits a project in the panels and exports after each edit', async () => {
    const report = await uiTest('edits-to-output', [SRGB_SCREEN, '--media', MEDIA_DIRECTORY, '--out', join(scratch, 'edits')])
    const files = report.exported
    if (typeof files !== 'object' || files === null) throw new Error('The scenario did not report its files')
    exported = Object.fromEntries(Object.entries(files).map(([name, path]) => [name, String(path)]))
    const parsed = parseProject(JSON.stringify(report.project))
    if (!parsed.ok) throw new Error(parsed.message)
    finalProject = parsed.project
    // The undo after each edit took it back out: what is left is the cut video and the title.
    expect(finalProject.tracks.map((track) => track.clips.map((clip) => clip.type))).toEqual([['video'], ['text'], [], [], [], []])
  })

  it('places the video and doubles it with the canvas: every frame in order, two seconds of sound', async () => {
    const frames = await decodedVideo(file('placed.mp4'), CANVAS)
    expect(frames.map(readBarcode)).toEqual(Array.from({ length: 2 * FRAMES_PER_SECOND }, (_, frame) => frame))
    const sound = await decodedAudio(file('placed.wav'))
    expect(sound.length / 2).toBe(2 * SAMPLE_RATE)
    expect(rootMeanSquare(sound)).toBeGreaterThan(0.3)
  })

  it('halves the picture at 50% opacity, over the black beneath', async () => {
    const full = await decodedPng(file('full.png'), CANVAS)
    const half = await decodedPng(file('half-opacity.png'), CANVAS)
    const fullPixels = new Uint8Array(full.data)
    const halfPixels = new Uint8Array(half.data)
    let largest = 0
    for (let offset = 0; offset < fullPixels.length; offset++) {
      if (offset % BYTES_PER_PIXEL === 3) continue
      largest = Math.max(largest, Math.abs((halfPixels[offset] ?? 0) - Math.round((fullPixels[offset] ?? 0) / 2)))
    }
    expect(largest).toBeLessThanOrEqual(MAX_HALF_OPACITY_ERROR)
  })

  it('leaves out a hidden track and silences a muted one', async () => {
    const hidden = await decodedPng(file('hidden.png'), CANVAS)
    expect(meanBrightness(hidden)).toBe(0)
    const muted = await decodedAudio(file('muted.wav'))
    expect(muted.length / 2).toBe(2 * SAMPLE_RATE)
    expect(rootMeanSquare(muted)).toBe(0)
  })

  it('halves the sound at 50% volume', async () => {
    const full = rootMeanSquare(await decodedAudio(file('placed.wav')))
    const half = rootMeanSquare(await decodedAudio(file('half-volume.wav')))
    expect(half / full).toBeCloseTo(0.5, 2)
  })

  it('fades the picture in over the second it was given', async () => {
    const faded = await decodedVideo(file('faded.mp4'), CANVAS)
    const placed = await decodedVideo(file('placed.mp4'), CANVAS)
    expect(meanBrightness(pictureAt(faded, 0))).toBeLessThan(1)
    expect(meanBrightness(pictureAt(faded, 15)) / meanBrightness(pictureAt(placed, 15))).toBeCloseTo(0.5, 1)
    expect(meanBrightness(pictureAt(faded, 45)) / meanBrightness(pictureAt(placed, 45))).toBeCloseTo(1, 1)
  })

  it('plays at 200% in half the time, showing every other frame', async () => {
    const frames = await decodedVideo(file('fast.mp4'), CANVAS)
    expect(frames.map(readBarcode)).toEqual(Array.from({ length: FRAMES_PER_SECOND }, (_, frame) => 2 * frame))
  })

  it('cuts the first second away: the rest starts at source frame 30 and its sound is that of the uncut export, sample for sample', async () => {
    const frames = await decodedVideo(file('cut.mp4'), CANVAS)
    expect(frames.map(readBarcode)).toEqual(Array.from({ length: FRAMES_PER_SECOND }, (_, frame) => FRAMES_PER_SECOND + frame))
    const cut = await decodedAudio(file('cut.wav'))
    const uncut = await decodedAudio(file('placed.wav'))
    expect(cut.length / 2).toBe(SAMPLE_RATE)
    expect(cut).toEqual(uncut.subarray(2 * SAMPLE_RATE))
  })

  it('draws the typed title over the video', async () => {
    const titled = await decodedPng(file('title.png'), CANVAS)
    const untitled = pictureAt(await decodedVideo(file('cut.mp4'), CANVAS), 0)
    expect(nearWhiteIn(untitled, TITLE_AREA)).toBe(0)
    expect(nearWhiteIn(titled, TITLE_AREA)).toBeGreaterThan(MIN_TITLE_PIXELS)
  })

  it('exports 480p, vertical, WebM and GIF at their sizes and for the five seconds of the title', async () => {
    const wide = await probeExport(file('title-480p.mp4'))
    expect(wide.video).toMatchObject({ codec_name: 'h264', width: '854', height: '480', nb_frames: '150' })
    expect(wide.audio).toMatchObject({ codec_name: 'aac' })
    const tall = await probeExport(file('vertical.mp4'))
    expect(tall.video).toMatchObject({ width: '1080', height: '1920', nb_frames: '150' })
    const webm = await probeExport(file('title.webm'))
    expect(webm.video).toMatchObject({ codec_name: 'vp9', width: '640', height: '360' })
    expect(webm.audio).toMatchObject({ codec_name: 'opus' })
    expect(webm.duration).toBeCloseTo(5, 1)
    const gif = await probeExport(file('title.gif'))
    expect(gif.video).toMatchObject({ codec_name: 'gif', height: '120', r_frame_rate: '10/1', nb_frames: '50' })
  })
})

describe('GIF from the export dialog', () => {
  const SOURCE_FRAMES_PER_SECOND = 30
  const GIFS = [
    { rate: 10, preset: '120p' },
    { rate: 20, preset: '360p' },
    { rate: 25, preset: '240p' },
  ] as const
  let gifs: Record<string, unknown> = {}

  it('exports at each frame rate the dialog offers', async () => {
    const report = await uiTest('gif-export', ['--project', projectPath('01-single-clip'), '--out', join(scratch, 'gif')])
    if (typeof report.gifs !== 'object' || report.gifs === null) throw new Error('The scenario did not report its GIFs')
    gifs = { ...report.gifs }
    expect(Object.keys(gifs)).toEqual(['10/1', '20/1', '25/1'])
  })

  it.each(GIFS)('at $rate fps and $preset: its size, two seconds of frames, each the source frame at or before its time', async ({ rate, preset }) => {
    const path = String(gifs[`${rate}/1`])
    const size = exportSize(preset, CANVAS)
    const probed = await probeExport(path)
    expect(probed.video).toMatchObject({ codec_name: 'gif', width: String(size.width), height: String(size.height), r_frame_rate: `${rate}/1`, nb_frames: String(2 * rate) })
    const frames = await decodedVideo(path, size)
    expect(frames.map(readBarcode)).toEqual(Array.from({ length: 2 * rate }, (_, frame) => Math.floor((frame * SOURCE_FRAMES_PER_SECOND) / rate)))
  })
})
