import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseProject } from '../shared/project.js'
import { TICKS_PER_SECOND } from '../shared/time.js'
import { PageError, selector } from './page.js'
import { RULER_HEIGHT, canvasPoint, centerOf, dragMedia, fullQualityFrame, mediaFile, type Driver, type Point, type Scenario, type UiTestReport } from './uiDriver.js'
import { isPlaying, openExportDialog, pick, splitFirstTrackAtOneSecond, startExport, submitExport, untilExported, untilTextEditor } from './uiScenarios.js'

const BYTES_PER_PIXEL = 4

type Captured = {
  width: number
  height: number
  file: string
}

async function capturePreview(driver: Driver, name: string): Promise<Captured> {
  if (driver.options.outputDirectory === undefined) throw new PageError('This UI test needs --out <directory>')
  const box = await driver.rect('preview')
  const scale = Number(await driver.page.evaluate('devicePixelRatio'))
  const around = { x: Math.floor(box.x), y: Math.floor(box.y), width: Math.ceil(box.x + box.width) - Math.floor(box.x), height: Math.ceil(box.y + box.height) - Math.floor(box.y) }
  await driver.page.evaluate(`(() => {
    ${selector('canvas-overlay')}.style.visibility = 'hidden'
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  })()`)
  const image = await driver.window.webContents.capturePage(around)
  await driver.page.evaluate(`${selector('canvas-overlay')}.style.visibility = ''`)
  const capturedWidth = image.getSize(scale).width
  const bgra = image.toBitmap({ scaleFactor: scale })
  const left = Math.round((box.x - around.x) * scale)
  const top = Math.round((box.y - around.y) * scale)
  const width = Math.round(box.width * scale)
  const height = Math.round(box.height * scale)
  const rgba = Buffer.alloc(width * height * BYTES_PER_PIXEL)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const from = ((top + y) * capturedWidth + left + x) * BYTES_PER_PIXEL
      const to = (y * width + x) * BYTES_PER_PIXEL
      rgba[to] = bgra[from + 2] ?? 0
      rgba[to + 1] = bgra[from + 1] ?? 0
      rgba[to + 2] = bgra[from] ?? 0
      rgba[to + 3] = bgra[from + 3] ?? 0
    }
  }
  await mkdir(driver.options.outputDirectory, { recursive: true })
  const file = join(driver.options.outputDirectory, `${name}.rgba`)
  await writeFile(file, rgba)
  return { width, height, file }
}

const SCRUB_POINTS = [0.23, 0.51, 0.77]
const SAMPLE_INTERVAL_MS = 60
const PLAYTHROUGH_INTERVAL_MS = 200
const PLAYTHROUGH_MIN_SAMPLES = 12
const MILLISECONDS = 1000
const PERCENT = 100

type PlaybackLimits = {
  samples: number
  longestMs: number
  intervalMs: number
}

const WYSIWYG_PLAYBACK: PlaybackLimits = { samples: 24, longestMs: 3000, intervalMs: SAMPLE_INTERVAL_MS }

async function timecodeText(driver: Driver): Promise<string> {
  return driver.page.text('timecode')
}

async function framesDrawn(driver: Driver): Promise<number> {
  return Number(await driver.page.evaluate(`${selector('timecode')}.dataset.frames`))
}

async function projectSeconds(driver: Driver): Promise<number> {
  const [hours = 0, minutes = 0, seconds = 0, frames = 0] = (await driver.page.text('duration')).replace('/', '').trim().split(':').map(Number)
  return (hours * 60 + minutes) * 60 + seconds + frames / 30
}

async function pausedAfter(driver: Driver, act: () => Promise<void>): Promise<string> {
  const drawnBefore = await framesDrawn(driver)
  await act()
  await fullQualityFrame(driver, drawnBefore)
  return timecodeText(driver)
}

type PausedCapture = Captured & { timecode: string }

type PlayingCapture = Captured & { timecodeBefore: string; timecodeAfter: string }

async function capturePlayback(driver: Driver, limits: PlaybackLimits): Promise<PlayingCapture[]> {
  const samples: PlayingCapture[] = []
  const startedAt = Date.now()
  await driver.press('Space')
  await driver.until(`${selector('play')}.getAttribute('aria-label') === 'Pause'`, 'playback to start')
  while (samples.length < limits.samples && Date.now() - startedAt < limits.longestMs && (await isPlaying(driver))) {
    const timecodeBefore = await timecodeText(driver)
    const captured = await capturePreview(driver, `playing-${samples.length}`)
    const timecodeAfter = await timecodeText(driver)
    samples.push({ ...captured, timecodeBefore, timecodeAfter })
    await sleep(limits.intervalMs)
  }
  if (await isPlaying(driver)) await driver.press('Space')
  await driver.until(`${selector('play')}.getAttribute('aria-label') === 'Play'`, 'playback to stop')
  return samples
}

function playthroughLimits(seconds: number): PlaybackLimits {
  const longestMs = (seconds + 1) * MILLISECONDS
  return { samples: Infinity, longestMs, intervalMs: Math.min(PLAYTHROUGH_INTERVAL_MS, (seconds * MILLISECONDS) / PLAYTHROUGH_MIN_SAMPLES) }
}

async function canvasSize(driver: Driver): Promise<{ width: number; height: number }> {
  return { width: Number(await driver.value('canvas-width')), height: Number(await driver.value('canvas-height')) }
}

async function showAtZoom(driver: Driver, zoom: string): Promise<void> {
  const canvas = await canvasSize(driver)
  await pick(driver, 'canvas-zoom', zoom)
  const isAtZoom = zoom === 'fit' ? 'true' : `Math.round(${selector('preview')}.getBoundingClientRect().width * devicePixelRatio) === ${(canvas.width * Number(zoom)) / PERCENT}`
  await driver.until(`${isAtZoom} && ${selector('timecode')}.dataset.fullQuality === 'true'`, `the picture at ${zoom}`)
}

async function untilMediaPrepared(driver: Driver): Promise<void> {
  await driver.until(`document.querySelector('.library-item .badge.warning') === null`, 'the media to be prepared')
}

async function pausedCaptures(driver: Driver): Promise<PausedCapture[]> {
  const seconds = await projectSeconds(driver)
  const paused: PausedCapture[] = []
  const ruler = await driver.rect('timeline')
  for (const point of SCRUB_POINTS) {
    const where = await driver.timelinePoint(point * seconds * TICKS_PER_SECOND, 0, 1)
    const timecode = await pausedAfter(driver, () => driver.clickAt({ x: where.x, y: ruler.y + RULER_HEIGHT / 2 }))
    paused.push({ ...(await capturePreview(driver, `paused-${paused.length}`)), timecode })
  }
  const atEnd = await pausedAfter(driver, () => driver.press('Return', ['meta', 'shift']))
  paused.push({ ...(await capturePreview(driver, `paused-${paused.length}`)), timecode: atEnd })
  const atStart = await pausedAfter(driver, () => driver.press('Return', ['meta']))
  paused.push({ ...(await capturePreview(driver, `paused-${paused.length}`)), timecode: atStart })
  return paused
}

async function testWysiwyg(driver: Driver, zoom = '100'): Promise<UiTestReport> {
  await fullQualityFrame(driver, 0)
  await untilMediaPrepared(driver)
  const canvas = await canvasSize(driver)
  await showAtZoom(driver, zoom)
  await driver.page.click('timeline-zoom-fit')
  const paused = await pausedCaptures(driver)
  if (zoom !== '100') return { canvas, zoom, paused, playing: await capturePlayback(driver, WYSIWYG_PLAYBACK) }

  await openExportDialog(driver)
  await pick(driver, 'export-format', 'png')
  const still = await submitExport(driver, 'still.png')
  await untilExported(driver, 'still.png')

  await openExportDialog(driver)
  const movie = await startExport(driver, { fileName: 'movie.mp4', preset: `${canvas.height}p`, quality: 'high', hasAudio: true })
  await untilExported(driver, 'movie.mp4')

  const playing = await capturePlayback(driver, WYSIWYG_PLAYBACK)
  return { canvas, zoom, paused, still, movie, playing }
}

async function testPlaythrough(driver: Driver): Promise<UiTestReport> {
  await fullQualityFrame(driver, 0)
  await untilMediaPrepared(driver)
  const canvas = await canvasSize(driver)
  await showAtZoom(driver, '100')
  await driver.page.click('timeline-zoom-fit')
  const ruler = await driver.rect('timeline')
  // While the zoom picker has the keyboard focus, Space does not reach playback.
  await pausedAfter(driver, () => driver.clickAt({ x: ruler.x + ruler.width / 2, y: ruler.y + RULER_HEIGHT / 2 }))
  await pausedAfter(driver, () => driver.press('Return', ['meta']))
  const playing = await capturePlayback(driver, playthroughLimits(await projectSeconds(driver)))
  return { canvas, playing }
}

type Exported = Record<string, string>

async function exportAs(driver: Driver, exported: Exported, fileName: string, preset = '360p'): Promise<void> {
  await openExportDialog(driver)
  const format = fileName.slice(fileName.lastIndexOf('.') + 1)
  if (format === 'mp4') {
    exported[fileName] = await startExport(driver, { fileName, preset, quality: 'high', hasAudio: true })
  } else {
    await pick(driver, 'export-format', format)
    if ((await driver.page.evaluate(`${selector('export-preset')} !== null`)) === true) await pick(driver, 'export-preset', preset)
    exported[fileName] = await submitExport(driver, fileName)
  }
  await untilExported(driver, fileName)
}

const TRACKS_AT_START = 6
const CANVAS_WIDTH = 640
const HALF_SECOND_FRAMES = 15

async function selectVideo(driver: Driver): Promise<void> {
  await driver.clickAt(await driver.timelinePoint(TICKS_PER_SECOND / 4, 0, TRACKS_AT_START))
  await driver.until(`${selector('clip-opacity')} !== null`, 'the video to be selected')
}

async function playheadAtHalfSecond(driver: Driver): Promise<void> {
  await driver.press('Return', ['meta'])
  await driver.press('.', ['control', 'shift'])
  await driver.until(`${selector('timecode')}.textContent === '00:00:00:${HALF_SECOND_FRAMES}'`, 'the playhead at half a second')
}

async function undoTo(driver: Driver, label: string): Promise<void> {
  driver.menu('undo')
  await driver.untilUndoLabel(label)
}

async function importPrepared(driver: Driver, name: string): Promise<void> {
  driver.options.answers.importMedia = [mediaFile(driver, name)]
  driver.menu('import')
  await driver.until(`${selector(`media-${name}`)} !== null && document.querySelector('.library-item .badge.warning') === null`, `${name} to be prepared`)
}

async function placeDoubledVideo(driver: Driver): Promise<void> {
  await importPrepared(driver, 'h264.mp4')
  await dragMedia(driver, 'h264.mp4', await driver.timelinePoint(0, 0, TRACKS_AT_START))
  await driver.untilUndoLabel('Undo Add Clip')
  await driver.press('Escape')
  await driver.until(`${selector('canvas-width')} !== null`, 'the project settings')
  await driver.typeInto('canvas-width', '640')
  await driver.until(`${selector('canvas-height')}.value === '360'`, 'the height to follow the width')
}

async function addTitle(driver: Driver): Promise<void> {
  await driver.page.click('tab-annotations')
  await driver.page.click('annotation-text')
  await untilTextEditor(driver, true)
  await driver.typeKeys('Hi')
  await driver.press('Escape')
  await untilTextEditor(driver, false)
  await driver.untilUndoLabel('Undo Edit Text')
}

async function testEditsToOutput(driver: Driver): Promise<UiTestReport> {
  const exported: Exported = {}
  await placeDoubledVideo(driver)
  await exportAs(driver, exported, 'placed.mp4')
  await exportAs(driver, exported, 'placed.wav')
  await playheadAtHalfSecond(driver)
  await exportAs(driver, exported, 'full.png')

  await selectVideo(driver)
  await driver.typeInto('clip-opacity', '50')
  await driver.untilUndoLabel('Undo Change Opacity')
  await exportAs(driver, exported, 'half-opacity.png')
  await undoTo(driver, 'Undo Change Canvas Size')

  await driver.clickAt(centerOf(await driver.rect('track-hidden-0')))
  await driver.untilUndoLabel('Undo Hide Track')
  await exportAs(driver, exported, 'hidden.png')
  await undoTo(driver, 'Undo Change Canvas Size')

  await driver.clickAt(centerOf(await driver.rect('track-muted-0')))
  await driver.untilUndoLabel('Undo Mute Track')
  await exportAs(driver, exported, 'muted.wav')
  await undoTo(driver, 'Undo Change Canvas Size')

  await selectVideo(driver)
  await driver.typeInto('clip-volume', '50')
  await driver.untilUndoLabel('Undo Change Volume')
  await exportAs(driver, exported, 'half-volume.wav')
  await undoTo(driver, 'Undo Change Canvas Size')

  await selectVideo(driver)
  await pick(driver, 'clip-in', 'fade')
  await driver.until(`${selector('clip-in-length')} !== null`, 'the length of the fade')
  await driver.typeInto('clip-in-length', '1')
  await driver.until(`${selector('clip-in-length')}.value === '1.000'`, 'the fade to last a second')
  await exportAs(driver, exported, 'faded.mp4')
  await undoTo(driver, 'Undo Change Clip In')
  await undoTo(driver, 'Undo Change Canvas Size')

  await selectVideo(driver)
  await driver.typeInto('clip-speed', '200')
  await driver.untilUndoLabel('Undo Change Speed')
  await exportAs(driver, exported, 'fast.mp4')
  await undoTo(driver, 'Undo Change Canvas Size')

  await driver.press('Return', ['meta'])
  await driver.press('.', ['control', 'shift'])
  await driver.press('.', ['control', 'shift'])
  await driver.until(`${selector('timecode')}.textContent === '00:00:01:00'`, 'the playhead at one second')
  await selectVideo(driver)
  await driver.page.click('split')
  await driver.untilUndoLabel('Undo Split Clip')
  await selectVideo(driver)
  await driver.press('Backspace', ['meta'])
  await driver.untilUndoLabel('Undo Ripple Delete Clip')
  await exportAs(driver, exported, 'cut.mp4')
  await exportAs(driver, exported, 'cut.wav')

  await driver.press('Escape')
  await driver.press('Return', ['meta'])
  await addTitle(driver)
  await driver.press('Return', ['meta'])
  await exportAs(driver, exported, 'title.png')
  await exportAs(driver, exported, 'title-480p.mp4', '480p')
  await exportAs(driver, exported, 'vertical.mp4', 'vertical-1080x1920')
  await exportAs(driver, exported, 'title.webm')
  await exportAs(driver, exported, 'title.gif', '120p')
  const project = await driver.savedProject('final.json')
  return { exported, project }
}

const GIF_WAIT_MS = 20_000
const GIF_EXPORTS = [
  { rate: '10/1', preset: '120p' },
  { rate: '20/1', preset: '360p' },
  { rate: '25/1', preset: '240p' },
]

async function testGifExport(driver: Driver): Promise<UiTestReport> {
  await fullQualityFrame(driver, 0)
  const gifs: Record<string, string> = {}
  for (const { rate, preset } of GIF_EXPORTS) {
    await openExportDialog(driver)
    await pick(driver, 'export-format', 'gif')
    await pick(driver, 'export-frame-rate', rate)
    await pick(driver, 'export-preset', preset)
    const fileName = `movie-${rate.replace('/1', '')}fps.gif`
    gifs[rate] = await submitExport(driver, fileName)
    await untilExported(driver, fileName, GIF_WAIT_MS)
  }
  return { gifs }
}

const SECOND = TICKS_PER_SECOND
const EDGE_GRAB_PIXELS = 2

type Saved = Record<string, string>

async function saveAs(driver: Driver, saved: Saved, name: string): Promise<void> {
  await driver.savedProject(name)
  saved[name] = join(driver.options.outputDirectory ?? '', name)
}

async function dragOnBottomTrack(driver: Driver, from: Point, toTime: number, label: string): Promise<void> {
  await driver.drag(from, await driver.timelinePoint(toTime, 0, TRACKS_AT_START))
  await driver.untilUndoLabel(label)
}

async function bottomTrackAt(driver: Driver, time: number, nudge = 0): Promise<Point> {
  const point = await driver.timelinePoint(time, 0, TRACKS_AT_START)
  return { x: point.x + nudge, y: point.y }
}

async function testArrangeToOutput(driver: Driver): Promise<UiTestReport> {
  const exported: Exported = {}
  const saved: Saved = {}
  await importPrepared(driver, 'image-red.png')
  await placeDoubledVideo(driver)
  await saveAs(driver, saved, 'base.json')
  await exportAs(driver, exported, 'base.mp4')
  await exportAs(driver, exported, 'base.wav')
  await playheadAtHalfSecond(driver)
  await exportAs(driver, exported, 'base.png')

  await dragOnBottomTrack(driver, await bottomTrackAt(driver, SECOND / 4), (5 * SECOND) / 4, 'Undo Move Clip')
  await saveAs(driver, saved, 'moved.json')
  await exportAs(driver, exported, 'moved.mp4')
  await exportAs(driver, exported, 'moved.wav')
  await undoTo(driver, 'Undo Change Canvas Size')

  await dragOnBottomTrack(driver, await bottomTrackAt(driver, 0, EDGE_GRAB_PIXELS), SECOND / 2, 'Undo Trim Clip')
  await saveAs(driver, saved, 'trimmed-start.json')
  await exportAs(driver, exported, 'trimmed-start.mp4')
  await undoTo(driver, 'Undo Change Canvas Size')
  await dragOnBottomTrack(driver, await bottomTrackAt(driver, 2 * SECOND, -EDGE_GRAB_PIXELS), SECOND, 'Undo Trim Clip')
  await saveAs(driver, saved, 'trimmed-end.json')
  await exportAs(driver, exported, 'trimmed-end.mp4')
  await undoTo(driver, 'Undo Change Canvas Size')

  await selectVideo(driver)
  driver.window.webContents.copy()
  await sleep(SAMPLE_INTERVAL_MS)
  const ruler = await driver.rect('timeline')
  await driver.clickAt({ x: (await bottomTrackAt(driver, SECOND)).x, y: ruler.y + RULER_HEIGHT / 2 })
  await driver.until(`${selector('timecode')}.textContent === '00:00:01:00'`, 'the playhead at one second')
  driver.window.webContents.paste()
  await driver.untilUndoLabel('Undo Paste Clip')
  await saveAs(driver, saved, 'pasted.json')
  await exportAs(driver, exported, 'pasted.mp4')
  await exportAs(driver, exported, 'pasted.wav')
  await undoTo(driver, 'Undo Change Canvas Size')
  await playheadAtHalfSecond(driver)

  await dragMedia(driver, 'image-red.png', await driver.timelinePoint(0, 1, TRACKS_AT_START))
  await driver.untilUndoLabel('Undo Add Clip')
  await saveAs(driver, saved, 'on-top.json')
  await exportAs(driver, exported, 'on-top.png')
  await undoTo(driver, 'Undo Change Canvas Size')

  await selectVideo(driver)
  await driver.typeInto('clip-rotation', '180')
  await driver.untilUndoLabel('Undo Rotate Clip')
  await exportAs(driver, exported, 'turned.png')
  await undoTo(driver, 'Undo Change Canvas Size')

  await selectVideo(driver)
  await driver.typeInto('clip-crop-left', '160')
  await driver.untilUndoLabel('Undo Crop Clip')
  await exportAs(driver, exported, 'cropped.png')
  await undoTo(driver, 'Undo Change Canvas Size')

  await driver.drag(await canvasPoint(driver, CANVAS_WIDTH, { x: 320, y: 180 }), await canvasPoint(driver, CANVAS_WIDTH, { x: 400, y: 180 }))
  await driver.untilUndoLabel('Undo Move Clip')
  await saveAs(driver, saved, 'dragged.json')
  await exportAs(driver, exported, 'dragged.png')
  await undoTo(driver, 'Undo Change Canvas Size')

  await splitFirstTrackAtOneSecond(driver, TRACKS_AT_START)
  await driver.page.click('tab-transitions')
  await driver.drag(centerOf(await driver.rect('transition-fadeBlack')), await bottomTrackAt(driver, 0.8 * SECOND))
  await driver.untilUndoLabel('Undo Add Transition')
  await saveAs(driver, saved, 'through-black.json')
  await exportAs(driver, exported, 'through-black.mp4')
  await undoTo(driver, 'Undo Split Clip')
  await undoTo(driver, 'Undo Change Canvas Size')
  await driver.page.click('tab-media')
  await playheadAtHalfSecond(driver)

  await driver.rightClickAt(await bottomTrackAt(driver, SECOND / 4))
  await driver.until(`${selector('menu-separate-audio')} !== null`, 'the clip menu')
  await driver.page.click('menu-separate-audio')
  await driver.untilUndoLabel('Undo Separate Video and Audio')
  await saveAs(driver, saved, 'separated.json')
  const parsed = parseProject(await readFile(saved['separated.json'] ?? '', 'utf8'))
  if (!parsed.ok) throw new PageError(`separated.json could not be read back: ${parsed.message}`)
  const soundTrack = parsed.project.tracks.findIndex((track) => track.clips.some((clip) => clip.type === 'audio'))
  if (soundTrack < 0) throw new PageError('The separated project has no audio clip')
  await driver.clickAt(await driver.timelinePoint(SECOND / 4, soundTrack, parsed.project.tracks.length))
  await driver.press('Backspace')
  await driver.untilUndoLabel('Undo Delete Clip')
  await exportAs(driver, exported, 'separated.mp4')
  await exportAs(driver, exported, 'separated.wav')
  await undoTo(driver, 'Undo Separate Video and Audio')
  await undoTo(driver, 'Undo Change Canvas Size')

  await selectVideo(driver)
  await driver.typeInto('clip-volumeFadeIn', '1')
  await driver.untilUndoLabel('Undo Change Fade')
  await exportAs(driver, exported, 'sound-fade.wav')
  await undoTo(driver, 'Undo Change Canvas Size')

  await selectVideo(driver)
  await driver.typeInto('clip-speed', '50')
  await driver.untilUndoLabel('Undo Change Speed')
  await exportAs(driver, exported, 'slow.mp4')
  await undoTo(driver, 'Undo Change Canvas Size')
  return { exported, saved }
}

const CANVAS_CENTRE = { x: 320, y: 180 }
const MOVED_TO = { x: 380, y: 210 }
const KEYED_TO = { x: 290, y: 150 }

type StageCapture = PausedCapture & { project: string }

async function seekOnRuler(driver: Driver, time: number, timecode: string): Promise<void> {
  const ruler = await driver.rect('timeline')
  const where = await driver.timelinePoint(time, 0, TRACKS_AT_START)
  await driver.clickAt({ x: where.x, y: ruler.y + RULER_HEIGHT / 2 })
  await driver.until(`${selector('timecode')}.textContent === '${timecode}'`, `the playhead at ${timecode}`)
}

async function playToEnd(driver: Driver): Promise<void> {
  await driver.press('Space')
  await driver.until(`${selector('play')}.getAttribute('aria-label') === 'Pause'`, 'playback to start')
  await driver.until(`${selector('play')}.getAttribute('aria-label') === 'Play'`, 'playback to reach the end')
}

async function dragOnCanvas(driver: Driver, from: Point, to: Point): Promise<void> {
  await driver.drag(await canvasPoint(driver, CANVAS_WIDTH, from), await canvasPoint(driver, CANVAS_WIDTH, to))
  await driver.untilUndoLabel('Undo Move Clip')
}

async function capturedStage(driver: Driver, saved: Saved, stage: string, edit: () => Promise<void>): Promise<StageCapture> {
  const timecode = await pausedAfter(driver, edit)
  const captured = await capturePreview(driver, stage)
  await saveAs(driver, saved, `${stage}.json`)
  return { ...captured, timecode, project: saved[`${stage}.json`] ?? '' }
}

async function testEditsToPlayback(driver: Driver): Promise<UiTestReport> {
  const saved: Saved = {}
  const exported: Exported = {}
  const stages: StageCapture[] = []
  await importPrepared(driver, 'image-alpha.png')
  await placeDoubledVideo(driver)
  const canvas = await canvasSize(driver)
  await showAtZoom(driver, '100')
  await seekOnRuler(driver, SECOND, '00:00:01:00')
  await driver.press('Return', ['meta'])
  await playToEnd(driver)
  await driver.press('Return', ['meta'])

  stages.push(await capturedStage(driver, saved, 'moved', () => dragOnCanvas(driver, CANVAS_CENTRE, MOVED_TO)))

  stages.push(
    await capturedStage(driver, saved, 'properties', async () => {
      await selectVideo(driver)
      await driver.typeInto('clip-scale', '80')
      await driver.untilUndoLabel('Undo Resize Clip')
      await driver.typeInto('clip-rotation', '12')
      await driver.untilUndoLabel('Undo Rotate Clip')
      await driver.typeInto('clip-opacity', '85')
      await driver.untilUndoLabel('Undo Change Opacity')
    }),
  )

  await seekOnRuler(driver, 0, '00:00:00:00')
  await driver.page.click('clip-position-keyframe')
  await driver.untilUndoLabel('Undo Add Position Keyframe')
  await seekOnRuler(driver, SECOND, '00:00:01:00')
  stages.push(await capturedStage(driver, saved, 'keyframed', () => dragOnCanvas(driver, MOVED_TO, KEYED_TO)))

  stages.push(
    await capturedStage(driver, saved, 'overlay', async () => {
      await dragMedia(driver, 'image-alpha.png', await driver.timelinePoint(0, 1, TRACKS_AT_START))
      await driver.untilUndoLabel('Undo Add Clip')
      await driver.clickAt(await driver.timelinePoint(SECOND / 4, 1, TRACKS_AT_START))
      await driver.until(`${selector('clip-opacity')} !== null`, 'the picture to be selected')
      await driver.typeInto('clip-opacity', '50')
      await driver.untilUndoLabel('Undo Change Opacity')
    }),
  )

  await splitFirstTrackAtOneSecond(driver, TRACKS_AT_START)
  await driver.page.click('tab-transitions')
  stages.push(
    await capturedStage(driver, saved, 'transition', async () => {
      await driver.drag(centerOf(await driver.rect('transition-crossDissolve')), await bottomTrackAt(driver, 0.8 * SECOND))
      await driver.untilUndoLabel('Undo Add Transition')
    }),
  )
  await driver.page.click('tab-media')

  await seekOnRuler(driver, 0, '00:00:00:00')
  stages.push(await capturedStage(driver, saved, 'titled', () => addTitle(driver)))

  await saveAs(driver, saved, 'final.json')
  await seekOnRuler(driver, SECOND, '00:00:01:00')
  await driver.press('Return', ['meta'])
  const playing = await capturePlayback(driver, playthroughLimits(await projectSeconds(driver)))
  await exportAs(driver, exported, 'final.mp4')
  return { canvas, stages, playing, final: saved['final.json'], movie: exported['final.mp4'] }
}

export const OUTPUT_SCENARIOS: Record<string, Scenario> = {
  'arrange-to-output': testArrangeToOutput,
  'gif-export': testGifExport,
  wysiwyg: (driver) => testWysiwyg(driver),
  'wysiwyg-50': (driver) => testWysiwyg(driver, '50'),
  'wysiwyg-fit': (driver) => testWysiwyg(driver, 'fit'),
  playthrough: testPlaythrough,
  'edits-to-output': testEditsToOutput,
  'edits-to-playback': testEditsToPlayback,
}
