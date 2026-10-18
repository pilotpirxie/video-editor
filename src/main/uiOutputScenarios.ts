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

// What the preview shows on screen, as a person sees it, saved as raw RGBA in the output folder.
// The preview may start half way into a point; the capture takes whole points around it and cuts the picture out on device pixels.
async function capturePreview(driver: Driver, name: string): Promise<Captured> {
  if (driver.options.outputDirectory === undefined) throw new PageError('This UI test needs --out <directory>')
  const box = await driver.rect('preview')
  const scale = Number(await driver.page.evaluate('devicePixelRatio'))
  const around = { x: Math.floor(box.x), y: Math.floor(box.y), width: Math.ceil(box.x + box.width) - Math.floor(box.x), height: Math.ceil(box.y + box.height) - Math.floor(box.y) }
  // Handles and the outlines of clips off the canvas are drawn over the picture and never exported; they are left out of the capture.
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

// Where on the ruler the playhead is put, as parts of the length of the project.
const SCRUB_POINTS = [0.23, 0.51, 0.77]
const PLAYING_SAMPLES = 24
const SAMPLE_INTERVAL_MS = 60
const LONGEST_PLAY_MS = 3000

async function timecodeText(driver: Driver): Promise<string> {
  return driver.page.text('timecode')
}

async function framesDrawn(driver: Driver): Promise<number> {
  return Number(await driver.page.evaluate(`${selector('timecode')}.dataset.frames`))
}

// The frames of the timecode are counted at 30 a second: near enough to pick places on the ruler at any rate.
async function projectSeconds(driver: Driver): Promise<number> {
  const [hours = 0, minutes = 0, seconds = 0, frames = 0] = (await driver.page.text('duration')).replace('/', '').trim().split(':').map(Number)
  return (hours * 60 + minutes) * 60 + seconds + frames / 30
}

// Moves the playhead as `act` does and waits for the paused preview to show that moment at full quality.
async function pausedAfter(driver: Driver, act: () => Promise<void>): Promise<string> {
  const drawnBefore = await framesDrawn(driver)
  await act()
  await fullQualityFrame(driver, drawnBefore)
  return timecodeText(driver)
}

type PausedCapture = Captured & { timecode: string }

type PlayingCapture = Captured & { timecodeBefore: string; timecodeAfter: string }

// Captures what the playing preview shows, with the timecode just before and just after each capture.
async function capturePlayback(driver: Driver): Promise<PlayingCapture[]> {
  const samples: PlayingCapture[] = []
  const startedAt = Date.now()
  await driver.press('Space')
  await driver.until(`${selector('play')}.getAttribute('aria-label') === 'Pause'`, 'playback to start')
  while (samples.length < PLAYING_SAMPLES && Date.now() - startedAt < LONGEST_PLAY_MS && (await isPlaying(driver))) {
    const timecodeBefore = await timecodeText(driver)
    const captured = await capturePreview(driver, `playing-${samples.length}`)
    const timecodeAfter = await timecodeText(driver)
    samples.push({ ...captured, timecodeBefore, timecodeAfter })
    await sleep(SAMPLE_INTERVAL_MS)
  }
  if (await isPlaying(driver)) await driver.press('Space')
  await driver.until(`${selector('play')}.getAttribute('aria-label') === 'Play'`, 'playback to stop')
  return samples
}

// What you see is what you export, checked on the screen: the paused preview at 100% at the start, at three places
// the ruler was clicked and at the end; the PNG of the current frame and the MP4 exported from the dialog; then what the preview shows while it plays.
async function testWysiwyg(driver: Driver): Promise<UiTestReport> {
  await fullQualityFrame(driver, 0)
  // Playback is checked on prepared media; a project of titles and shapes alone has nothing to prepare.
  await driver.until(`document.querySelector('.library-item .badge.warning') === null`, 'the media to be prepared')
  const canvas = { width: Number(await driver.value('canvas-width')), height: Number(await driver.value('canvas-height')) }
  await pick(driver, 'canvas-zoom', '100')
  await driver.until(`Math.round(${selector('preview')}.getBoundingClientRect().width * devicePixelRatio) === ${canvas.width} && ${selector('timecode')}.dataset.fullQuality === 'true'`, 'the picture at 100%')
  await driver.page.click('timeline-zoom-fit')
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

  // The PNG is of the frame under the playhead, which is now the first one.
  await openExportDialog(driver)
  await pick(driver, 'export-format', 'png')
  const still = await submitExport(driver, 'still.png')
  await untilExported(driver, 'still.png')

  await openExportDialog(driver)
  const movie = await startExport(driver, { fileName: 'movie.mp4', preset: `${canvas.height}p`, quality: 'high', hasAudio: true })
  await untilExported(driver, 'movie.mp4')

  const playing = await capturePlayback(driver)
  return { canvas, paused, still, movie, playing }
}

type Exported = Record<string, string>

// Exports what the project is now from the dialog, as a person would, and keeps where the file went under `name`.
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

// Half a second in: the start, then the jump forward that moves 15 frames.
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

// The two-second test video on the bottom track. It sets the canvas to its own 320 x 180; doubling the width doubles the height and the clip with it.
async function placeDoubledVideo(driver: Driver): Promise<void> {
  await importPrepared(driver, 'h264.mp4')
  await dragMedia(driver, 'h264.mp4', await driver.timelinePoint(0, 0, TRACKS_AT_START))
  await driver.untilUndoLabel('Undo Add Clip')
  await driver.press('Escape')
  await driver.until(`${selector('canvas-width')} !== null`, 'the project settings')
  await driver.typeInto('canvas-width', '640')
  await driver.until(`${selector('canvas-height')}.value === '360'`, 'the height to follow the width')
}

// Edits a project the way a person does, in the panels and with the mouse, and exports after each edit, so a test can check
// in the files that every edit really reached the output: placing, canvas size, opacity, hiding and muting a track, volume,
// fades, speed, a cut with ripple delete, a title, and the export sizes and formats, GIF included.
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

  // The first second is cut away: split at one second, then ripple delete the first part.
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

  // A title typed over the first frame.
  await driver.press('Escape')
  await driver.press('Return', ['meta'])
  await driver.page.click('tab-annotations')
  await driver.page.click('annotation-text')
  await untilTextEditor(driver, true)
  await driver.typeKeys('Hi')
  await driver.press('Escape')
  await untilTextEditor(driver, false)
  await driver.untilUndoLabel('Undo Edit Text')
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

// Exports a GIF from the dialog at each frame rate it offers, each at another size; two seconds take well under a second.
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
// A grab this far inside a clip's edge takes the edge, not the clip.
const EDGE_GRAB_PIXELS = 2

type Saved = Record<string, string>

// Saves the project as it is under `name` in the output folder and keeps where it went, so a test reads the timing the edit really made.
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

// More edits made with the mouse and the keyboard, each exported and then undone, so a test can check the files: moving and
// trimming on the timeline, pasting at the playhead, a picture on a higher track, rotating, cropping and dragging on the canvas,
// a transition on a cut, separating the sound and deleting it, a fade of the sound and half speed. The project is saved after
// each timeline edit, so the test can work out from it what each frame must show.
async function testArrangeToOutput(driver: Driver): Promise<UiTestReport> {
  const exported: Exported = {}
  const saved: Saved = {}
  // Imported first, so that every edit below is undone back to the canvas size.
  await importPrepared(driver, 'image-red.png')
  await placeDoubledVideo(driver)
  await saveAs(driver, saved, 'base.json')
  await exportAs(driver, exported, 'base.mp4')
  await exportAs(driver, exported, 'base.wav')
  await playheadAtHalfSecond(driver)
  await exportAs(driver, exported, 'base.png')

  // The clip is grabbed a quarter second in and dropped a second later.
  await dragOnBottomTrack(driver, await bottomTrackAt(driver, SECOND / 4), (5 * SECOND) / 4, 'Undo Move Clip')
  await saveAs(driver, saved, 'moved.json')
  await exportAs(driver, exported, 'moved.mp4')
  await exportAs(driver, exported, 'moved.wav')
  await undoTo(driver, 'Undo Change Canvas Size')

  // Each edge is dragged half way in: the start onto the playhead at half a second, the end to one second.
  await dragOnBottomTrack(driver, await bottomTrackAt(driver, 0, EDGE_GRAB_PIXELS), SECOND / 2, 'Undo Trim Clip')
  await saveAs(driver, saved, 'trimmed-start.json')
  await exportAs(driver, exported, 'trimmed-start.mp4')
  await undoTo(driver, 'Undo Change Canvas Size')
  await dragOnBottomTrack(driver, await bottomTrackAt(driver, 2 * SECOND, -EDGE_GRAB_PIXELS), SECOND, 'Undo Trim Clip')
  await saveAs(driver, saved, 'trimmed-end.json')
  await exportAs(driver, exported, 'trimmed-end.mp4')
  await undoTo(driver, 'Undo Change Canvas Size')

  // Copied, then pasted with the playhead put at one second on the ruler: the clip is there, so the copy goes on the track above.
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

  // A red picture dropped at the start of the track above draws over the video.
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

  // Half of the 320-pixel source cropped away on the left.
  await selectVideo(driver)
  await driver.typeInto('clip-crop-left', '160')
  await driver.untilUndoLabel('Undo Crop Clip')
  await exportAs(driver, exported, 'cropped.png')
  await undoTo(driver, 'Undo Change Canvas Size')

  // Dragged from the centre of the canvas 80 canvas pixels to the right.
  await driver.drag(await canvasPoint(driver, CANVAS_WIDTH, { x: 320, y: 180 }), await canvasPoint(driver, CANVAS_WIDTH, { x: 400, y: 180 }))
  await driver.untilUndoLabel('Undo Move Clip')
  await saveAs(driver, saved, 'dragged.json')
  await exportAs(driver, exported, 'dragged.png')
  await undoTo(driver, 'Undo Change Canvas Size')

  // Cut at one second, with a fade through black dropped on the cut.
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

  // The sound separated from the clip's menu, then selected on its own track and deleted.
  await driver.rightClickAt(await bottomTrackAt(driver, SECOND / 4))
  await driver.until(`${selector('menu-separate-audio')} !== null`, 'the clip menu')
  await driver.page.click('menu-separate-audio')
  await driver.untilUndoLabel('Undo Separate Video and Audio')
  // The sound went to a track of its own; which one is read back from the saved project.
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

export const OUTPUT_SCENARIOS: Record<string, Scenario> = {
  'arrange-to-output': testArrangeToOutput,
  'gif-export': testGifExport,
  wysiwyg: testWysiwyg,
  'edits-to-output': testEditsToOutput,
}
