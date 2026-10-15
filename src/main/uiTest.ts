import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { app, type BrowserWindow } from 'electron'
import { TICKS_PER_SECOND } from '../shared/time.js'
import { PageError, selector } from './page.js'
import {
  P95,
  POLL_INTERVAL_MS,
  RULER_HEIGHT,
  STEP_TIMEOUT_MS,
  TRACK_HEIGHT,
  attachedDriver,
  canvasPoint,
  centerOf,
  delayUntilShown,
  watchLongTasks,
  dragMedia,
  driverOfNewWindow,
  editorWindows,
  fullQualityFrame,
  mediaFile,
  numbersIn,
  percentile,
  type Driver,
  type Point,
  type Scenario,
  type UiTestOptions,
  type UiTestReport,
  untilWindowCount,
} from './uiDriver.js'
import { FEATURE_SCENARIOS, framesShown, pick, seekDelays, splitFirstTrackAtOneSecond, untilPrepared } from './uiScenarios.js'

const AUTOSAVE_TIMEOUT_MS = 20_000
const MS_PER_SECOND = 1000
// Long enough for a window that would load again to have done so.
const RELOAD_WAIT_MS = 6000

async function panelSizes(driver: Driver): Promise<Record<string, number>> {
  const left = await driver.rect('left-sidebar')
  const right = await driver.rect('right-sidebar')
  const timeline = await driver.rect('timeline-panel')
  return { left: Math.round(left.width), right: Math.round(right.width), timeline: Math.round(timeline.height) }
}

async function testLayout(driver: Driver): Promise<UiTestReport> {
  const before = await panelSizes(driver)
  const leftSplitter = centerOf(await driver.rect('split-left'))
  await driver.drag(leftSplitter, { x: leftSplitter.x + 60, y: leftSplitter.y })
  const timelineSplitter = centerOf(await driver.rect('split-timeline'))
  await driver.drag(timelineSplitter, { x: timelineSplitter.x, y: timelineSplitter.y - 40 })
  driver.menu('toggle-properties')
  await driver.until(`${selector('right-sidebar')}.hidden === true`, 'the properties panel to collapse')
  return { before, after: await panelSizes(driver) }
}

async function testCommands(driver: Driver): Promise<UiTestReport> {
  const widthAtStart = await driver.value('canvas-width')
  await driver.typeInto('canvas-width', '1280')
  await driver.until(`${selector('canvas-width')}.value === '1280'`, 'the canvas width to change')
  await sleep(POLL_INTERVAL_MS)
  const undoLabel = driver.menuLabel('undo')

  driver.menu('undo')
  await driver.until(`${selector('canvas-width')}.value === '${widthAtStart}'`, 'undo to restore the canvas width')
  await sleep(POLL_INTERVAL_MS)
  const redoLabel = driver.menuLabel('redo')
  const undoLabelAfterUndo = driver.menuLabel('undo')

  driver.menu('redo')
  await driver.until(`${selector('canvas-width')}.value === '1280'`, 'redo to apply the canvas width again')
  return { widthAtStart, undoLabel, redoLabel, undoLabelAfterUndo, widthAfterRedo: await driver.value('canvas-width') }
}

async function testOpen(driver: Driver): Promise<UiTestReport> {
  await fullQualityFrame(driver, 0)
  return { canvasWidth: await driver.value('canvas-width'), timecode: await driver.page.text('timecode') }
}

// Builds a small project by hand, the way a user would, and reports the saved file after each stage.
async function testEdit(driver: Driver): Promise<UiTestReport> {
  const second = TICKS_PER_SECOND
  const names = ['h264.mp4', 'audio.wav', 'image.jpg', 'broken-garbage.mp4']
  driver.options.answers.importMedia = names.map((name) => mediaFile(driver, name))
  const importStartedAt = Date.now()
  driver.menu('import')
  await driver.until(`Boolean(${selector('media-h264.mp4')}?.querySelector('.library-poster'))`, 'the poster of the imported video')
  const posterMilliseconds = Date.now() - importStartedAt
  await driver.until(`${selector('media-image.jpg')} !== null && ${selector('notice')} !== null`, 'the import to finish')
  const importNotice = await driver.page.text('notice')
  const hasBrokenItem = (await driver.page.evaluate(`${selector('media-broken-garbage.mp4')} !== null`)) === true

  // A new project has six empty tracks. The sound, dropped on occupied space, goes onto the empty track above.
  await dragMedia(driver, 'h264.mp4', await driver.timelinePoint(0, 0, 6))
  await driver.untilUndoLabel('Undo Add Clip')
  await dragMedia(driver, 'audio.wav', await driver.timelinePoint(second / 2, 0, 6))
  await driver.until(`${selector('duration')}.textContent.includes('00:00:02:15')`, 'the sound to make the project longer')
  await dragMedia(driver, 'image.jpg', await driver.timelinePoint(3 * second, 0, 6))
  await driver.until(`${selector('duration')}.textContent.includes('00:00:08:00')`, 'the image to make the project longer')
  const placed = await driver.savedProject('placed.json')

  // The image clip is dragged a little short of the end of the video clip and snaps onto it.
  const grab = await driver.timelinePoint(4 * second, 0, 6)
  const nearVideoEnd = await driver.timelinePoint(3 * second, 0, 6)
  await driver.drag(grab, { x: nearVideoEnd.x + 5, y: grab.y })
  await driver.untilUndoLabel('Undo Move Clip')
  const imageEnd = await driver.timelinePoint(7 * second, 0, 6)
  const trimTo = await driver.timelinePoint(5 * second, 0, 6)
  await driver.drag({ x: imageEnd.x - 2, y: imageEnd.y }, trimTo)
  await driver.untilUndoLabel('Undo Trim Clip')
  const movedAndTrimmed = await driver.savedProject('moved.json')

  await splitFirstTrackAtOneSecond(driver, 6)
  const split = await driver.savedProject('split.json')

  driver.menu('undo')
  await driver.untilUndoLabel('Undo Trim Clip')
  const redoLabel = driver.menuLabel('redo')
  const afterUndo = await driver.savedProject('undone.json')
  driver.menu('redo')
  await driver.untilUndoLabel('Undo Split Clip')

  await driver.clickAt(await driver.timelinePoint(second / 2, 0, 6))
  driver.window.webContents.copy()
  await sleep(POLL_INTERVAL_MS)
  driver.window.webContents.paste()
  await driver.untilUndoLabel('Undo Paste Clip')
  const pasted = await driver.savedProject('pasted.json')

  await driver.press('Backspace')
  await driver.untilUndoLabel('Undo Delete Clip')
  // The paste landed on occupied space below the sound, so it made a seventh track; that track stays when its clip is deleted.
  await driver.clickAt(await driver.timelinePoint(second / 2, 0, 7))
  await driver.press('Backspace', ['meta'])
  await driver.untilUndoLabel('Undo Ripple Delete Clip')
  const final = await driver.savedProject('final.json')
  return { posterMilliseconds, importNotice, hasBrokenItem, placed, movedAndTrimmed, split, redoLabel, afterUndo, pasted, final }
}

// Works on the 640x360 mosaic of four 320x180 clips: selects the top-left one on the canvas and moves, scales, crops and rotates it with the handles.
async function testCanvas(driver: Driver): Promise<UiTestReport> {
  const canvasWidth = 640
  const at = (x: number, y: number): Promise<Point> => canvasPoint(driver, canvasWidth, { x, y })
  await fullQualityFrame(driver, 0)

  await driver.clickAt(await at(160, 90))
  await driver.until(`${selector('canvas-overlay')}.dataset.selected === '1'`, 'the clicked clip to be selected')
  const selectedX = await driver.value('clip-x')

  // Dropped three pixels short of the canvas centre, the clip snaps onto it.
  await driver.drag(await at(160, 90), await at(317, 90))
  await driver.untilUndoLabel('Undo Move Clip')
  const moved = await driver.savedProject('canvas-moved.json')
  const xAfterMove = await driver.value('clip-x')

  await driver.drag(centerOf(await driver.rect('handle-se')), await at(640, 270))
  await driver.untilUndoLabel('Undo Resize Clip')
  const scaled = await driver.savedProject('canvas-scaled.json')

  await driver.page.click('crop-mode')
  const eastHandle = centerOf(await driver.rect('handle-e'))
  const cropTo = await at(520, 135)
  await driver.drag(eastHandle, { x: cropTo.x, y: eastHandle.y })
  await driver.untilUndoLabel('Undo Crop Clip')
  await driver.page.click('crop-mode')
  const cropped = await driver.savedProject('canvas-cropped.json')

  // The rotate handle sits straight above the clip's centre; dragging it to the upper right with Shift turns the clip by 45 degrees.
  const rotateHandle = centerOf(await driver.rect('handle-rotate'))
  const center = await at(340, 135)
  const reach = center.y - rotateHandle.y
  await driver.drag(rotateHandle, { x: center.x + reach * 0.7, y: center.y - reach * 0.7 }, ['shift'])
  await driver.untilUndoLabel('Undo Rotate Clip')

  await driver.typeInto('clip-opacity', '50')
  await driver.untilUndoLabel('Undo Change Opacity')
  await pick(driver, 'clip-in', 'fade')
  await driver.untilUndoLabel('Undo Change Clip In')
  const final = await driver.savedProject('canvas-final.json')

  await driver.clickAt(await at(630, 350), ['shift'])
  await driver.until(`${selector('canvas-overlay')}.dataset.selected === '2'`, 'a second clip to join the selection')
  const sharedOpacity = await driver.page.evaluate(`${selector('clip-opacity')}.placeholder`)
  await driver.typeInto('clip-opacity', '25')
  await driver.untilUndoLabel('Undo Change Opacity')
  const both = await driver.savedProject('canvas-both.json')

  // Media dropped on the canvas becomes a clip on a new top track; a marquee over the top three rows of the timeline then selects their clips.
  await dragMedia(driver, 'h264.mp4', await at(320, 180))
  await driver.until(`${selector('track-4')} !== null`, 'a fifth track for the clip dropped on the canvas')
  const dropped = await driver.savedProject('canvas-dropped.json')
  const topRow = await driver.timelinePoint(TICKS_PER_SECOND / 2, 4, 5)
  const thirdRow = await driver.timelinePoint(5 * TICKS_PER_SECOND, 2, 5)
  await driver.drag(thirdRow, topRow)
  await driver.until(`${selector('canvas-overlay')}.dataset.selected === '3'`, 'the marquee to select the three clips it covers')
  return { selectedX, xAfterMove, moved, scaled, cropped, final, sharedOpacity, both, dropped }
}

async function testTracks(driver: Driver): Promise<UiTestReport> {
  await fullQualityFrame(driver, 0)
  await driver.page.click('add-track')
  await driver.until(`${selector('track-4')} !== null`, 'the added track')
  const addedName = await driver.page.text('track-name-4')

  await driver.doubleClickAt(centerOf(await driver.rect('track-name-4')))
  await driver.until(`${selector('track-name-input')} !== null`, 'the track name to become editable')
  await driver.typeInto('track-name-input', 'Titles')
  await driver.untilUndoLabel('Undo Rename Track')

  await driver.page.click('track-locked-0')
  await driver.page.click('track-hidden-1')
  await driver.page.click('track-muted-2')
  await driver.untilUndoLabel('Undo Mute Track')
  // The top-left clip is on the locked track, so a click on it selects nothing.
  await driver.clickAt(await canvasPoint(driver, 640, { x: 160, y: 90 }))
  await sleep(POLL_INTERVAL_MS)
  const selectedOnLockedTrack = await driver.page.evaluate(`${selector('canvas-overlay')}.dataset.selected`)

  // The new track is in the top row; dragging its header two rows down puts it two layers lower.
  const header = centerOf(await driver.rect('track-name-4'))
  await driver.drag(header, { x: header.x, y: header.y + 2 * TRACK_HEIGHT })
  await driver.untilUndoLabel('Undo Reorder Tracks')
  const reordered = await driver.savedProject('tracks-reordered.json')

  await driver.rightClickAt(centerOf(await driver.rect('track-name-2')))
  await driver.until(`${selector('track-delete')} !== null`, 'the track menu')
  await driver.page.click('track-delete')
  await driver.untilUndoLabel('Undo Delete Track')
  return { addedName, selectedOnLockedTrack, reordered, final: await driver.savedProject('tracks-final.json') }
}

async function untilWidth(driver: Driver, width: string): Promise<void> {
  await driver.until(`${selector('canvas-width')}?.value === '${width}'`, `a document with a ${width} wide canvas`)
}

function documentShown(driver: Driver): { title: string; isEdited: boolean } {
  return { title: driver.window.getTitle(), isEdited: driver.window.isDocumentEdited() }
}

async function untilEdited(driver: Driver, isEdited: boolean): Promise<void> {
  const deadline = Date.now() + STEP_TIMEOUT_MS
  while (driver.window.isDocumentEdited() !== isEdited) {
    if (Date.now() > deadline) throw new PageError(`Timed out waiting for the window to ${isEdited ? 'show' : 'lose'} its unsaved-changes mark`)
    await sleep(POLL_INTERVAL_MS)
  }
}

async function documentWith(driver: Driver): Promise<{ title: string; isEdited: boolean; width: string }> {
  return { ...documentShown(driver), width: await driver.value('canvas-width') }
}

// One project per window: New and Open with several windows, and every answer to "save your changes?" when one closes.
async function testDocuments(driver: Driver): Promise<UiTestReport> {
  const { answers, outputDirectory } = driver.options
  if (outputDirectory === undefined) throw new PageError('This UI test needs --out <directory>')
  const firstPath = join(outputDirectory, 'first.json')
  const secondPath = join(outputDirectory, 'second.json')
  const start = documentShown(driver)

  // New opens a window of its own; the first keeps its unsaved change.
  await driver.typeInto('canvas-width', '1280')
  await untilEdited(driver, true)
  driver.menu('new')
  const other = await driverOfNewWindow(driver, [driver.window])
  await untilWidth(other, '1920')
  const afterNew = { windows: editorWindows().length, first: await documentWith(driver), other: await documentWith(other) }

  answers.saveProject = firstPath
  driver.menu('save')
  await untilEdited(driver, false)
  await driver.typeInto('canvas-width', '1000')
  await untilEdited(driver, true)
  answers.saveProject = secondPath
  driver.menu('save-as')
  await untilEdited(driver, false)
  const afterSaveAs = documentShown(driver)

  // Opened from the untitled window without changes, a project takes that window over.
  answers.openProject = firstPath
  other.menu('open-project')
  await untilWidth(other, '1280')
  const afterOpenInPlace = { windows: editorWindows().length, other: await documentWith(other) }

  // A project that is open already is not opened twice.
  answers.openProject = secondPath
  other.menu('open-project')
  await sleep(10 * POLL_INTERVAL_MS)
  const afterOpenOfOpen = { windows: editorWindows().length, other: documentShown(other) }

  // Closing a window with unsaved changes asks: Cancel keeps it, Don't Save closes it and leaves the file as it was.
  await driver.typeInto('canvas-width', '700')
  await untilEdited(driver, true)
  answers.unsavedChanges = 'cancel'
  driver.window.close()
  await sleep(10 * POLL_INTERVAL_MS)
  const afterCancelledClose = { isOpen: !driver.window.isDestroyed(), width: await driver.value('canvas-width') }
  answers.unsavedChanges = 'discard'
  driver.window.close()
  await untilWindowCount(1)
  const secondAfterDiscard: unknown = JSON.parse(await readFile(secondPath, 'utf8'))

  // Opened from a window that holds a project, a project gets a window of its own; Save on closing writes it.
  other.menu('open-project')
  const third = await driverOfNewWindow(other, [other.window])
  await untilWidth(third, '1000')
  const afterOpenInNew = { windows: editorWindows().length, third: await documentWith(third) }
  await third.typeInto('canvas-width', '640')
  await untilEdited(third, true)
  answers.unsavedChanges = 'save'
  third.window.close()
  await untilWindowCount(1)
  const secondAfterSave: unknown = JSON.parse(await readFile(secondPath, 'utf8'))
  const recoveryFiles = existsSync(recoveryDirectory()) ? (await readdir(recoveryDirectory())).filter((name) => name.endsWith('.json')) : []
  return { start, afterNew, afterSaveAs, afterOpenInPlace, afterOpenOfOpen, afterCancelledClose, secondAfterDiscard, afterOpenInNew, secondAfterSave, recoveryFiles }
}

function recoveryDirectory(): string {
  return join(app.getPath('userData'), 'recovery')
}

async function untilRecoveryFiles(count: number): Promise<void> {
  const deadline = Date.now() + AUTOSAVE_TIMEOUT_MS
  for (;;) {
    const files = existsSync(recoveryDirectory()) ? await readdir(recoveryDirectory()) : []
    if (files.filter((name) => name.endsWith('.json')).length === count) return
    if (Date.now() > deadline) throw new PageError('Timed out waiting for the autosave')
    await sleep(POLL_INTERVAL_MS)
  }
}

// Makes an edit, waits for the autosave and then dies the hard way, as a crash or a power cut would.
async function testCrash(driver: Driver): Promise<UiTestReport> {
  await driver.typeInto('canvas-width', '1280')
  await untilEdited(driver, true)
  // A second window has unsaved work of its own.
  driver.menu('new')
  const other = await driverOfNewWindow(driver, [driver.window])
  await other.typeInto('canvas-width', '800')
  await untilEdited(other, true)
  await untilRecoveryFiles(2)
  process.kill(process.pid, 'SIGKILL')
  return {}
}

async function crashLogEntries(): Promise<unknown[]> {
  const path = join(app.getPath('userData'), 'logs', 'crash.log')
  if (!existsSync(path)) return []
  const lines = (await readFile(path, 'utf8')).trim().split('\n')
  return lines.map((line): unknown => JSON.parse(line))
}

// Seconds from a crash until the window shows the autosaved work again.
// A promise to a page that died is never kept, so the page is not asked anything until the window has loaded it again.
async function secondsToReturn(driver: Driver, crash: () => void): Promise<number> {
  const crashedAt = Date.now()
  const reloaded = new Promise<void>((resolve) => driver.window.webContents.once('did-finish-load', () => resolve()))
  crash()
  const isReloaded = await Promise.race([reloaded.then(() => true), sleep(STEP_TIMEOUT_MS).then(() => false)])
  if (!isReloaded) throw new PageError('The window did not load its page again after the crash')
  await driver.until(`${selector('canvas-width')}?.value === '1280'`, 'the window to come back with its work')
  return (Date.now() - crashedAt) / MS_PER_SECOND
}

function killProcess(type: string, name?: string): void {
  const found = app.getAppMetrics().find((metric) => metric.type === type && (name === undefined || metric.name === name))
  if (found === undefined) throw new PageError(`There is no ${name ?? type} process to stop`)
  process.kill(found.pid, 'SIGKILL')
}

function countReloads(driver: Driver): () => number {
  let reloads = 0
  driver.window.webContents.on('did-finish-load', () => {
    reloads += 1
  })
  return () => reloads
}

// The page dies, then the GPU process does. After the page, the window loads again with the work of its last autosave; after the GPU process, it stays as it is, with its undo, and draws again. The crash log says what happened.
async function testPageCrash(driver: Driver): Promise<UiTestReport> {
  await driver.typeInto('canvas-width', '1280')
  await untilEdited(driver, true)
  await untilRecoveryFiles(1)
  const afterPageCrash = await secondsToReturn(driver, () => driver.window.webContents.forcefullyCrashRenderer())
  await driver.typeInto('canvas-width', '1000')
  await driver.untilUndoLabel('Undo Change Canvas Size')
  const reloads = countReloads(driver)
  const sinceFrames = await framesShown(driver)
  const crashedAt = Date.now()
  killProcess('GPU')
  await fullQualityFrame(driver, sinceFrames)
  const afterGpuCrash = (Date.now() - crashedAt) / MS_PER_SECOND
  await sleep(RELOAD_WAIT_MS)
  return {
    afterPageCrash,
    afterGpuCrash,
    reloadsAfterGpuCrash: reloads(),
    widthAfterGpuCrash: await driver.value('canvas-width'),
    undoLabelAfterGpuCrash: driver.menuLabel('undo'),
    crashLog: await crashLogEntries(),
  }
}

// The media process dies under a window with unsaved work. The window is not loaded again: it keeps its work and its undo, a new media process decodes for it, and it saves.
async function testMediaCrash(driver: Driver): Promise<UiTestReport> {
  await fullQualityFrame(driver, 0)
  await driver.typeInto('canvas-width', '1280')
  await untilEdited(driver, true)
  const undoLabel = driver.menuLabel('undo')
  const reloads = countReloads(driver)
  const crashedAt = Date.now()
  killProcess('Utility', 'Media')
  await driver.until(`${selector('notice')}?.textContent.includes('Nothing was lost') === true`, 'the media process to be restarted')
  const secondsToRestart = (Date.now() - crashedAt) / MS_PER_SECOND
  // A frame no cache holds yet, so only the new media process can have decoded it.
  const sinceFrames = await framesShown(driver)
  const timeline = await driver.rect('timeline')
  await driver.clickAt({ x: timeline.x + timeline.width / 2, y: timeline.y + RULER_HEIGHT / 2 })
  await fullQualityFrame(driver, sinceFrames)
  await sleep(RELOAD_WAIT_MS)
  return {
    secondsToRestart,
    reloads: reloads(),
    width: await driver.value('canvas-width'),
    undoLabel,
    undoLabelAfter: driver.menuLabel('undo'),
    saved: await driver.savedProject('after-media-crash.json'),
    crashLog: await crashLogEntries(),
  }
}

// Every window that had unsaved work comes back with it.
async function testRestore(driver: Driver): Promise<UiTestReport> {
  const other = await driverOfNewWindow(driver, [driver.window])
  await untilEdited(driver, true)
  await untilEdited(other, true)
  const width = await driver.value('canvas-width')
  const widths = [width, await other.value('canvas-width')].sort()
  return { ...documentShown(driver), windows: editorWindows().length, width, widths, saved: await driver.savedProject('restored.json') }
}

// Measures the §3 budgets on whatever project is open; the test opens a 20-hour project with 4,096 clips.
// Hours into the 4,096-clip project, each far from the last.
const PREPARED_SEEK_HOURS = [3, 17, 9, 14, 1, 19]
const SECONDS_PER_HOUR = 3600
const PROJECT_HOURS = 20

async function testBudgets(driver: Driver): Promise<UiTestReport> {
  await driver.until(`Number(${selector('timecode')}?.dataset.frames ?? 0) > 0 && ${selector('timeline')}?.dataset.view !== undefined`, 'the project to be shown')
  const openSeconds = process.uptime()
  const longTasks = await watchLongTasks(driver)
  await fullQualityFrame(driver, 0)

  // Frame pacing while the timeline is zoomed and scrolled with the trackpad.
  const timeline = centerOf(await driver.rect('timeline'))
  await driver.page.evaluate(`(() => {
    window.frameTimes = []
    const record = (now) => {
      window.frameTimes.push(now)
      if (window.frameTimes.length < 600) requestAnimationFrame(record)
    }
    requestAnimationFrame(record)
  })()`)
  for (let step = 0; step < 60; step++) await driver.scrollAt(timeline, 0, -12, true)
  for (let step = 0; step < 60; step++) await driver.scrollAt(timeline, 240, 0, false)
  for (let step = 0; step < 60; step++) await driver.scrollAt(timeline, 0, 12, true)
  const frameTimes = numbersIn(await driver.page.evaluate('window.frameTimes'))
  const frameIntervals = frameTimes.slice(1).map((time, index) => time - (frameTimes[index] ?? time))

  // Time from a pointer movement on the canvas to the frame that shows it.
  await driver.page.evaluate(`(() => {
    window.dragDelays = []
    let movedAt
    addEventListener('pointermove', () => { movedAt ??= performance.now() }, true)
    new MutationObserver(() => {
      if (movedAt === undefined) return
      window.dragDelays.push(performance.now() - movedAt)
      movedAt = undefined
    }).observe(${selector('timecode')}, { attributes: true, attributeFilter: ['data-frames'] })
  })()`)
  // On the picture itself: the overlay also covers the space around it.
  const picture = await driver.rect('preview')
  const grab = { x: picture.x + picture.width * 0.3, y: picture.y + picture.height * 0.3 }
  await driver.clickAt(grab)
  for (let pass = 0; pass < 4; pass++) await driver.drag(grab, { x: grab.x + 120, y: grab.y + 60 })
  await driver.untilUndoLabel('Undo Move Clip')
  const dragDelays = numbersIn(await driver.page.evaluate('window.dragDelays'))

  // Time from Undo to the frame that shows the project as it was.
  const undoMilliseconds = await delayUntilShown(driver, { shown: 'any frame' }, () => driver.menu('undo'))
  const redoMilliseconds = await delayUntilShown(driver, { shown: 'any frame' }, () => driver.menu('redo'))

  // §12: seeking anywhere in the twenty hours, once the media is prepared.
  await driver.page.click('timeline-zoom-fit')
  const timelineWidth = (await driver.rect('timeline')).width
  await driver.until(`JSON.parse(${selector('timeline')}.dataset.view).pixelsPerSecond * ${PROJECT_HOURS * SECONDS_PER_HOUR} < ${timelineWidth + 1}`, 'the timeline to fit the whole project')
  await untilPrepared(driver)
  const seeks = await seekDelays(driver, PREPARED_SEEK_HOURS.map((hours) => hours * SECONDS_PER_HOUR))

  return {
    openSeconds,
    frameCount: frameIntervals.length,
    frameIntervalP95: percentile(frameIntervals, P95),
    dragSamples: dragDelays.length,
    dragToFrameP95: percentile(dragDelays, P95),
    undoMilliseconds,
    redoMilliseconds,
    seekP95: percentile(seeks, P95),
    longTasks: await longTasks.read(),
  }
}

async function testOpenAndSave(driver: Driver): Promise<UiTestReport> {
  await fullQualityFrame(driver, 0)
  return { saved: await driver.savedProject('reopened.json'), title: driver.window.getTitle() }
}

const SCENARIOS: Record<string, Scenario> = {
  layout: testLayout,
  'layout-kept': async (driver) => ({ after: await panelSizes(driver) }),
  commands: testCommands,
  open: testOpen,
  edit: testEdit,
  canvas: testCanvas,
  tracks: testTracks,
  documents: testDocuments,
  crash: testCrash,
  'page-crash': testPageCrash,
  'media-crash': testMediaCrash,
  restore: testRestore,
  budgets: testBudgets,
  'open-and-save': testOpenAndSave,
  ...FEATURE_SCENARIOS,
}

// Properties starts with only Transform and Timing unfolded. The scenarios work in the other groups as someone would who unfolded them once;
// `controls` looks at the folding itself. Set before anything is selected, so the groups are read as they first show.
const GROUPS_TO_UNFOLD = ['Crop', 'Group', 'Callout', 'Arrow', 'Text', 'Blur', 'Highlight', 'Opacity', 'In and out', 'Volume']
const SCENARIOS_WITH_GROUPS_AS_AT_FIRST = new Set(['controls', 'controls-kept'])

export async function runUiTest(window: BrowserWindow, options: UiTestOptions): Promise<UiTestReport> {
  const scenario = SCENARIOS[options.scenario]
  if (scenario === undefined) throw new PageError(`There is no UI test "${options.scenario}"; use one of ${Object.keys(SCENARIOS).join(', ')}`)
  const driver = await attachedDriver(window, options)
  if (!SCENARIOS_WITH_GROUPS_AS_AT_FIRST.has(options.scenario)) {
    await driver.page.evaluate(`for (const title of ${JSON.stringify(GROUPS_TO_UNFOLD)}) sessionStorage.setItem('group-' + title, 'open')`)
  }
  try {
    return await scenario(driver)
  } finally {
    // A picture of the window as the test left it: the first thing to look at when a UI test fails.
    await driver.picture(options.scenario)
  }
}
