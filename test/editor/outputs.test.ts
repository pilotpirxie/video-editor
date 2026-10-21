import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { exportSize } from '../../src/shared/exportPresets.js'
import { parseProject, projectDuration, type Clip, type Project, type VideoClip } from '../../src/shared/project.js'
import { TICKS_PER_SAMPLE, TICKS_PER_SECOND } from '../../src/shared/time.js'
import { MEDIA_DIRECTORY, blockColorError, bundledFfmpeg, cropPicture, decodedAudio, pictureAt, pixelAt, probeExport, projectPath, readBarcode, renderFrames, runApp, sameBytes, scratchDirectory, uiTest, type Picture, type Size } from '../helpers.js'

const ffmpeg = bundledFfmpeg()
const scratch = scratchDirectory('outputs')
const BYTES_PER_PIXEL = 4
// The screen of a Mac converts colours to its display; the tests read the pixels the editor drew, before that conversion.
const SRGB_SCREEN = '--force-color-profile=srgb'
// Averaged over 8×8 blocks, the export differs from the screen by its compression only: the colour of fine detail, not what is where.
const BLOCK = 8
const MAX_PAUSED_BLOCK_ERROR = 2
const MAX_CHANNEL_BIAS = 1.5
// Playback draws from MJPEG preview copies, whose colour detail is softer; a camera zoomed to 300% magnifies that to about 5 levels.
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

// 12-4k-canvas, 15-blur-highlight and 22-timelapse are not here: at 100% their canvas is larger than the canvas panel, so panels cover
// part of the capture. test/engine/parity.test.ts checks them.
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
  '21-difficult-sources',
  '23-weird',
  // Four typewriter titles and four videos under a tenfold zoom: what is read ahead overflows the cache of pictures on every frame.
  '24-cache-pressure',
]

// A third of a second of layers with alpha: too short to sample while it plays, so only the paused preview is checked.
const PAUSED_ONLY = ['10-alpha']

describe('what is on screen is what is exported', () => {
  it.each([...PROJECTS, ...PAUSED_ONLY])('%s: the paused preview equals the PNG and the engine, and matches the MP4', async (name) => {
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

const FRAME_TICKS = TICKS_PER_SECOND / FRAMES_PER_SECOND
const CHANNELS = 2
// Where a drag let go is a pixel or two off on the timeline; a clip lands on a whole frame within this of where it was aimed.
const DROP_TOLERANCE_TICKS = 2 * FRAME_TICKS
const CANVAS_DRAG = 80
const CANVAS_DRAG_TOLERANCE = 4
const MAX_TURNED_ERROR = 1
const MAX_RED_ERROR = 2
// The fade through black is at its darkest on the cut, and the picture there is all but gone.
const MAX_DARKEST_FRACTION = 0.05
// A linear fade over a second: through its first tenth of a second the sound is under a tenth as loud, and half way it is half as loud.
const FIRST_TENTH = 0.1
const MAX_FIRST_TENTH_FRACTION = 0.1
const FADE_CHECK = { start: 0.45, end: 0.55 }
const IMAGE_SIZE = { width: 320, height: 180 }
const BLACK = { red: 0, green: 0, blue: 0, alpha: 255 }

type Shown = number | 'black'

function strings(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null) throw new Error('The scenario did not report its files')
  return Object.fromEntries(Object.entries(value).map(([name, path]) => [name, String(path)]))
}

function savedClips(project: Project, type: Clip['type']): Clip[] {
  const clips: Clip[] = []
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (clip.type === type) clips.push(clip)
    }
  }
  return clips
}

function onlyVideoClip(project: Project): VideoClip {
  const [clip, ...others] = savedClips(project, 'video')
  if (clip?.type !== 'video' || others.length > 0) throw new Error('The project should hold one video clip')
  return clip
}

// What each exported frame must show of the test video, worked out from the saved project: the source frame of the topmost video clip, or black.
function expectedShown(project: Project): Shown[] {
  const shown: Shown[] = []
  for (let time = 0; time < projectDuration(project); time += FRAME_TICKS) {
    let frame: Shown = 'black'
    for (const track of project.tracks) {
      for (const clip of track.clips) {
        if (clip.type !== 'video' || time < clip.start || time >= clip.start + clip.duration) continue
        frame = Math.floor((clip.sourceStart + ((time - clip.start) * clip.speedPercent) / 100) / FRAME_TICKS)
      }
    }
    shown.push(frame)
  }
  return shown
}

function shownIn(frames: readonly Picture[]): Shown[] {
  return frames.map((frame) => (meanBrightness(frame) < 1 ? 'black' : readBarcode(frame)))
}

// The largest difference of any colour channel between a picture and what each pixel should be, over the pixels `isChecked` takes.
function largestDifference(picture: Picture, expectedAt: (x: number, y: number) => ReturnType<typeof pixelAt>, isChecked: (x: number, y: number) => boolean): number {
  let largest = 0
  for (let y = 0; y < picture.height; y++) {
    for (let x = 0; x < picture.width; x++) {
      if (!isChecked(x, y)) continue
      const shown = pixelAt(picture, x, y)
      const wanted = expectedAt(x, y)
      largest = Math.max(largest, Math.abs(shown.red - wanted.red), Math.abs(shown.green - wanted.green), Math.abs(shown.blue - wanted.blue))
    }
  }
  return largest
}

describe('moves, trims, pastes, layers, canvas edits and the sound, made in the window, reach the exported file', () => {
  let exported: Record<string, string> = {}
  let saved: Record<string, string> = {}

  function file(name: string): string {
    const path = exported[name]
    if (path === undefined) throw new Error(`${name} was not exported`)
    return path
  }

  function project(name: string): Project {
    const path = saved[name]
    if (path === undefined) throw new Error(`${name} was not saved`)
    const parsed = parseProject(readFileSync(path, 'utf8'))
    if (!parsed.ok) throw new Error(`${name} is not a valid project: ${parsed.message}`)
    return parsed.project
  }

  it('edits on the timeline, on the canvas and in Properties, and exports after each edit', async () => {
    const report = await uiTest('arrange-to-output', ['--media', MEDIA_DIRECTORY, '--out', join(scratch, 'arrange')])
    exported = strings(report.exported)
    saved = strings(report.saved)
    expect(Object.keys(exported)).toHaveLength(18)
  })

  it('moves the clip a second later: black until it starts, then every frame, and the sound as late, sample for sample', async () => {
    const moved = project('moved.json')
    const clip = onlyVideoClip(moved)
    expect(Math.abs(clip.start - TICKS_PER_SECOND)).toBeLessThanOrEqual(DROP_TOLERANCE_TICKS)
    expect(clip.start % FRAME_TICKS, 'the clip starts on a whole frame').toBe(0)
    expect(shownIn(await decodedVideo(file('moved.mp4'), CANVAS))).toEqual(expectedShown(moved))
    const sound = await decodedAudio(file('moved.wav'))
    const lead = (clip.start / TICKS_PER_SAMPLE) * CHANNELS
    expect(rootMeanSquare(sound.subarray(0, lead))).toBe(0)
    expect(sound.subarray(lead)).toEqual(await decodedAudio(file('base.wav')))
  })

  it('trims the start onto the playhead and the end to one second, leaving every frame where it was', async () => {
    const trimmedStart = project('trimmed-start.json')
    const startClip = onlyVideoClip(trimmedStart)
    expect(startClip.start, 'the trim snapped to the playhead at half a second').toBe(TICKS_PER_SECOND / 2)
    expect(startClip.sourceStart).toBe(startClip.start)
    expect(startClip.start + startClip.duration).toBe(2 * TICKS_PER_SECOND)
    const fromHalfSecond = shownIn(await decodedVideo(file('trimmed-start.mp4'), CANVAS))
    expect(fromHalfSecond).toEqual(expectedShown(trimmedStart))
    expect(fromHalfSecond).toEqual(Array.from({ length: 2 * FRAMES_PER_SECOND }, (_, frame) => (frame < FRAMES_PER_SECOND / 2 ? 'black' : frame)))

    const trimmedEnd = project('trimmed-end.json')
    const endClip = onlyVideoClip(trimmedEnd)
    expect(Math.abs(endClip.duration - TICKS_PER_SECOND)).toBeLessThanOrEqual(DROP_TOLERANCE_TICKS)
    expect(endClip.start).toBe(0)
    const toEnd = shownIn(await decodedVideo(file('trimmed-end.mp4'), CANVAS))
    expect(toEnd).toEqual(expectedShown(trimmedEnd))
    expect(toEnd).toEqual(Array.from({ length: endClip.duration / FRAME_TICKS }, (_, frame) => frame))
  })

  it('pastes the copy at the playhead, on the track above: it covers the clip from there, and its sound plays from there, sample for sample', async () => {
    const pasted = project('pasted.json')
    expect(pasted.tracks.map((track) => track.clips.map((clip) => clip.start))).toEqual([[0], [TICKS_PER_SECOND], [], [], [], []])
    const frames = shownIn(await decodedVideo(file('pasted.mp4'), CANVAS))
    expect(frames).toEqual(expectedShown(pasted))
    const firstSecond = Array.from({ length: FRAMES_PER_SECOND }, (_, frame) => frame)
    const copy = Array.from({ length: 2 * FRAMES_PER_SECOND }, (_, frame) => frame)
    expect(frames).toEqual([...firstSecond, ...copy])
    // Where the two overlap the sounds are mixed; before it the clip plays alone, after it the copy.
    const sound = await decodedAudio(file('pasted.wav'))
    const base = await decodedAudio(file('base.wav'))
    const oneSecond = SAMPLE_RATE * CHANNELS
    expect(sound.length).toBe(3 * oneSecond)
    expect(sound.subarray(0, oneSecond)).toEqual(base.subarray(0, oneSecond))
    expect(sound.subarray(2 * oneSecond)).toEqual(base.subarray(oneSecond))
  })

  it('draws a picture dropped on the track above over the video, and leaves the video around it as it was', async () => {
    const [image] = savedClips(project('on-top.json'), 'image')
    if (image?.type !== 'image') throw new Error('The picture was not placed')
    const { x, y, scaleX, scaleY } = image.transform
    const left = x - (IMAGE_SIZE.width * scaleX) / 2
    const right = x + (IMAGE_SIZE.width * scaleX) / 2
    const top = y - (IMAGE_SIZE.height * scaleY) / 2
    const bottom = y + (IMAGE_SIZE.height * scaleY) / 2
    const onTop = await decodedPng(file('on-top.png'), CANVAS)
    const base = await decodedPng(file('base.png'), CANVAS)
    // A pixel's centre is half a pixel in; the one pixel on each edge that the picture only partly covers is left out.
    const isInside = (px: number, py: number): boolean => px > left && px + 1 < right && py > top && py + 1 < bottom
    const isOutside = (px: number, py: number): boolean => px + 1 < left || px > right || py + 1 < top || py > bottom
    expect(largestDifference(onTop, () => ({ red: 255, green: 0, blue: 0, alpha: 255 }), isInside)).toBeLessThanOrEqual(MAX_RED_ERROR)
    expect(largestDifference(onTop, (px, py) => pixelAt(base, px, py), isOutside)).toBe(0)
  })

  it('turns the picture upside down at 180° about its centre', async () => {
    const turned = await decodedPng(file('turned.png'), CANVAS)
    const base = await decodedPng(file('base.png'), CANVAS)
    const turnedBack = (px: number, py: number): ReturnType<typeof pixelAt> => pixelAt(base, CANVAS.width - 1 - px, CANVAS.height - 1 - py)
    expect(largestDifference(turned, turnedBack, () => true)).toBeLessThanOrEqual(MAX_TURNED_ERROR)
  })

  it('crops the left half of the source away, leaving the right half where it was', async () => {
    const cropped = await decodedPng(file('cropped.png'), CANVAS)
    const base = await decodedPng(file('base.png'), CANVAS)
    const middle = CANVAS.width / 2
    expect(largestDifference(cropped, () => BLACK, (px) => px < middle)).toBe(0)
    // The column on the edge of the crop no longer blends in the colour cropped away beside it, so it alone may differ.
    expect(largestDifference(cropped, (px, py) => pixelAt(base, px, py), (px) => px > middle)).toBe(0)
  })

  it('moves the picture on the canvas as far as it was dragged', async () => {
    const shift = onlyVideoClip(project('dragged.json')).transform.x - CANVAS.width / 2
    expect(Math.abs(shift - CANVAS_DRAG)).toBeLessThanOrEqual(CANVAS_DRAG_TOLERANCE)
    const dragged = await decodedPng(file('dragged.png'), CANVAS)
    const base = await decodedPng(file('base.png'), CANVAS)
    const whole = Math.round(shift)
    expect(largestDifference(dragged, () => BLACK, (px) => px + 1 < shift)).toBe(0)
    const width = CANVAS.width - whole
    expect(blockColorError(cropPicture(dragged, whole, 0, width, CANVAS.height), cropPicture(base, 0, 0, width, CANVAS.height), BLOCK)).toBeLessThanOrEqual(MAX_PAUSED_BLOCK_ERROR)
  })

  it('fades through black on the cut, darkest at the cut, and keeps the length and every frame outside the transition', async () => {
    const throughBlack = project('through-black.json')
    const [first, second] = savedClips(throughBlack, 'video')
    if (first?.type !== 'video' || second?.type !== 'video') throw new Error('The clip was not cut in two')
    expect(second.start).toBe(TICKS_PER_SECOND)
    const transition = second.transitionIn ?? first.transitionOut
    expect(transition?.type).toBe('fadeBlack')
    const halfFrames = (transition?.duration ?? 0) / FRAME_TICKS / 2
    const cut = FRAMES_PER_SECOND
    const frames = await decodedVideo(file('through-black.mp4'), CANVAS)
    const base = await decodedVideo(file('base.mp4'), CANVAS)
    expect(frames).toHaveLength(base.length)
    expect(meanBrightness(pictureAt(frames, cut)) / meanBrightness(pictureAt(base, cut))).toBeLessThan(MAX_DARKEST_FRACTION)
    for (const [index, frame] of frames.entries()) {
      if (Math.abs(index - cut) < halfFrames) continue
      expect(readBarcode(frame), `frame ${index}`).toBe(index)
      expect(blockColorError(frame, pictureAt(base, index), BLOCK), `frame ${index}`).toBeLessThanOrEqual(MAX_PAUSED_BLOCK_ERROR)
    }
  })

  it('separates the sound and deletes it: every frame stays, the sound is gone', async () => {
    expect(savedClips(project('separated.json'), 'audio')).toHaveLength(1)
    expect(shownIn(await decodedVideo(file('separated.mp4'), CANVAS))).toEqual(Array.from({ length: 2 * FRAMES_PER_SECOND }, (_, frame) => frame))
    const sound = await decodedAudio(file('separated.wav'))
    expect(sound.length / CHANNELS).toBe(2 * SAMPLE_RATE)
    expect(rootMeanSquare(sound)).toBe(0)
  })

  it('fades the sound in over a second, from silence to the sound as it was, sample for sample after the fade', async () => {
    const faded = await decodedAudio(file('sound-fade.wav'))
    const base = await decodedAudio(file('base.wav'))
    const at = (seconds: number): number => Math.round(seconds * SAMPLE_RATE) * CHANNELS
    expect(faded.subarray(at(1))).toEqual(base.subarray(at(1)))
    expect(rootMeanSquare(faded.subarray(0, at(FIRST_TENTH))) / rootMeanSquare(base.subarray(0, at(FIRST_TENTH)))).toBeLessThan(MAX_FIRST_TENTH_FRACTION)
    const halfWay = rootMeanSquare(faded.subarray(at(FADE_CHECK.start), at(FADE_CHECK.end))) / rootMeanSquare(base.subarray(at(FADE_CHECK.start), at(FADE_CHECK.end)))
    expect(halfWay).toBeCloseTo(0.5, 1)
  })

  it('plays at 50% in twice the time, showing each frame twice', async () => {
    expect(shownIn(await decodedVideo(file('slow.mp4'), CANVAS))).toEqual(Array.from({ length: 4 * FRAMES_PER_SECOND }, (_, frame) => Math.floor(frame / 2)))
  })

  it('exports from the command line, from the saved project, what the dialog exported from the window', async () => {
    const path = join(scratch, 'arrange', 'command-line.mp4')
    const result = await runApp(['--export', saved['base.json'] ?? '', '--out', path, '--preset', '360p'])
    expect(result.exitCode, result.stderr).toBe(0)
    const fromWindow = await decodedVideo(file('base.mp4'), CANVAS)
    const fromCommandLine = await decodedVideo(path, CANVAS)
    expect(shownIn(fromCommandLine)).toEqual(shownIn(fromWindow))
    for (const [index, frame] of fromCommandLine.entries()) expect(blockColorError(frame, pictureAt(fromWindow, index), BLOCK), `frame ${index}`).toBeLessThanOrEqual(MAX_PAUSED_BLOCK_ERROR)
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
