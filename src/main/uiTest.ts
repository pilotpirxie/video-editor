import { existsSync } from 'node:fs'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { app, type BrowserWindow } from 'electron'
import { SHAPE_ROW_HEIGHT } from '../editor/timelineView.js'
import { parseProject, serializeProject, type Clip } from '../shared/project.js'
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
import { OUTPUT_SCENARIOS } from './uiOutputScenarios.js'
import { FEATURE_SCENARIOS, framesShown, pick, rowInView, seekDelays, splitFirstTrackAtOneSecond, timelinePointInView, untilPrepared } from './uiScenarios.js'

const AUTOSAVE_TIMEOUT_MS = 20_000
const MS_PER_SECOND = 1000
const RELOAD_WAIT_MS = 6000
const FILE_TAKEN_IN_MS = 1000

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

  await dragMedia(driver, 'h264.mp4', await driver.timelinePoint(0, 0, 6))
  await driver.untilUndoLabel('Undo Add Clip')
  await dragMedia(driver, 'audio.wav', await driver.timelinePoint(second / 2, 0, 6))
  await driver.until(`${selector('duration')}.textContent.includes('00:00:02:15')`, 'the sound to make the project longer')
  await dragMedia(driver, 'image.jpg', await driver.timelinePoint(3 * second, 0, 6))
  await driver.until(`${selector('duration')}.textContent.includes('00:00:08:00')`, 'the image to make the project longer')
  const placed = await driver.savedProject('placed.json')

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
  await driver.clickAt(await driver.timelinePoint(second / 2, 0, 7))
  await driver.press('Backspace', ['meta'])
  await driver.untilUndoLabel('Undo Ripple Delete Clip')
  const final = await driver.savedProject('final.json')
  return { posterMilliseconds, importNotice, hasBrokenItem, placed, movedAndTrimmed, split, redoLabel, afterUndo, pasted, final }
}

async function testCanvas(driver: Driver): Promise<UiTestReport> {
  const canvasWidth = 640
  const at = (x: number, y: number): Promise<Point> => canvasPoint(driver, canvasWidth, { x, y })
  await fullQualityFrame(driver, 0)

  await driver.clickAt(await at(160, 90))
  await driver.until(`${selector('canvas-overlay')}.dataset.selected === '1'`, 'the clicked clip to be selected')
  const selectedX = await driver.value('clip-x')

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

  await rowInView(driver, 0, 4, 5)
  await driver.doubleClickAt(centerOf(await driver.rect('track-name-4')))
  await driver.until(`${selector('track-name-input')} !== null`, 'the track name to become editable')
  await driver.typeInto('track-name-input', 'Titles')
  await driver.untilUndoLabel('Undo Rename Track')

  await driver.page.click('track-locked-0')
  await driver.page.click('track-hidden-1')
  await driver.page.click('track-muted-2')
  await driver.untilUndoLabel('Undo Mute Track')
  await driver.clickAt(await canvasPoint(driver, 640, { x: 160, y: 90 }))
  await sleep(POLL_INTERVAL_MS)
  const selectedOnLockedTrack = await driver.page.evaluate(`${selector('canvas-overlay')}.dataset.selected`)

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

async function testDocuments(driver: Driver): Promise<UiTestReport> {
  const { answers, outputDirectory } = driver.options
  if (outputDirectory === undefined) throw new PageError('This UI test needs --out <directory>')
  const firstPath = join(outputDirectory, 'first.json')
  const secondPath = join(outputDirectory, 'second.json')
  const start = documentShown(driver)

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

  answers.openProject = firstPath
  other.menu('open-project')
  await untilWidth(other, '1280')
  const afterOpenInPlace = { windows: editorWindows().length, other: await documentWith(other) }

  answers.openProject = secondPath
  other.menu('open-project')
  await sleep(10 * POLL_INTERVAL_MS)
  const afterOpenOfOpen = { windows: editorWindows().length, other: documentShown(other) }

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

async function untilRecoveryFiles(count: number, extension = '.json'): Promise<void> {
  const deadline = Date.now() + AUTOSAVE_TIMEOUT_MS
  for (;;) {
    const files = existsSync(recoveryDirectory()) ? await readdir(recoveryDirectory()) : []
    if (files.filter((name) => name.endsWith(extension)).length === count) return
    if (Date.now() > deadline) throw new PageError('Timed out waiting for the autosave')
    await sleep(POLL_INTERVAL_MS)
  }
}

async function testCrash(driver: Driver): Promise<UiTestReport> {
  await driver.typeInto('canvas-width', '1280')
  await untilEdited(driver, true)
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

async function testRestore(driver: Driver): Promise<UiTestReport> {
  const other = await driverOfNewWindow(driver, [driver.window])
  await untilEdited(driver, true)
  await untilEdited(other, true)
  const width = await driver.value('canvas-width')
  const widths = [width, await other.value('canvas-width')].sort()
  return { ...documentShown(driver), windows: editorWindows().length, width, widths, saved: await driver.savedProject('restored.json') }
}

// The episode has a ground track under one animation clip, whose file holds one card on one track.
async function openCardAnimation(driver: Driver): Promise<void> {
  await fullQualityFrame(driver, 0)
  await driver.doubleClickAt(await driver.timelinePoint(TICKS_PER_SECOND / 2, 1, 2))
  await driver.until(`${selector('group-path')} !== null`, 'the animation to open')
}

async function fadeCardInsideAnimation(driver: Driver): Promise<void> {
  await openCardAnimation(driver)
  await driver.clickAt(await driver.timelinePoint(TICKS_PER_SECOND / 2, 0, 1))
  await driver.until(`${selector('clip-opacity')} !== null`, 'the card inside to be selected')
  await driver.typeInto('clip-opacity', '40')
  await driver.untilUndoLabel('Undo Change Opacity')
}

async function testAnimationFiles(driver: Driver): Promise<UiTestReport> {
  if (driver.options.outputDirectory === undefined) throw new PageError('This UI test needs --out <directory>')
  await fadeCardInsideAnimation(driver)
  const inside = await driver.page.evaluate(`({
    path: ${selector('group-path')}.textContent,
    timecode: ${selector('timecode')}.textContent,
    duration: ${selector('duration')}.textContent,
    isTimingInFrames: document.body.textContent.includes('Start (frames)'),
  })`)
  await driver.picture('animation-open')
  driver.menu('undo')
  await driver.untilRedoLabel('Redo Change Opacity')
  driver.menu('redo')
  await driver.untilUndoLabel('Undo Change Opacity')
  const isEditedByAnimation = driver.window.isDocumentEdited()
  driver.menu('save')
  await untilEdited(driver, false)

  await driver.press('Escape')
  await driver.press('Escape')
  await driver.until(`${selector('group-path')} === null`, 'the animation to close')
  driver.options.answers.newAnimation = join(driver.options.outputDirectory, 'new.pbanim')
  driver.menu('new-animation')
  await driver.until(`${selector('group-path')}?.textContent.includes('new') === true`, 'the new animation to open')
  return { inside, isEditedByAnimation, newPath: await driver.page.evaluate(`${selector('group-path')}.textContent`) }
}

function isPressed(testId: string): string {
  return `${selector(testId)}?.getAttribute('aria-pressed') === 'true'`
}

// The card also holds a shape with a clipped child, which is moved from the inside; then a rectangle and a circle are drawn and the rectangle is moved.
// The report holds the preview's place so the test can find the points.
async function testDrawingTools(driver: Driver): Promise<UiTestReport> {
  await openCardAnimation(driver)
  await driver.until(`${selector('tool-strip')} !== null`, 'the drawing tools to show')
  const tools = await driver.page.evaluate(`[...${selector('tool-strip')}.querySelectorAll(':scope > button')].map((button) => button.getAttribute('aria-label'))`)
  const preview = await driver.rect('preview')
  const pointAt = (shareX: number, shareY: number): Point => ({ x: preview.x + preview.width * shareX, y: preview.y + preview.height * shareY })

  await driver.doubleClickAt(pointAt(0.6875, 0.6875))
  await driver.until(`${selector('canvas-overlay')}.dataset.selectedShapes === '1'`, 'the clipped child to be selected')
  await driver.drag(pointAt(0.6875, 0.6875), pointAt(0.6375, 0.6875), ['meta'])
  await driver.untilUndoLabel('Undo Move Shape')
  await driver.press('Escape')
  await driver.until(`${selector('canvas-overlay')}.dataset.selectedShapes === '0'`, 'the child to be let go')

  await driver.press('M')
  await driver.until(isPressed('tool-rectangle'), 'the rectangle tool to be chosen')
  await driver.drag(pointAt(0.3, 0.3), pointAt(0.45, 0.45))
  await driver.untilUndoLabel('Undo Add Rectangle')
  await driver.press('M')
  await driver.until(isPressed('tool-ellipse'), 'the ellipse tool to be chosen')
  await driver.drag(pointAt(0.55, 0.55), pointAt(0.7, 0.6), ['shift'])
  await driver.untilUndoLabel('Undo Add Ellipse')

  await driver.press('V')
  await driver.until(isPressed('tool-move'), 'the move tool to be chosen')
  await driver.clickAt(pointAt(0.375, 0.375))
  await driver.until(`${selector('canvas-overlay')}.dataset.selectedShapes === '1'`, 'the rectangle to be selected')
  await driver.drag(pointAt(0.375, 0.375), pointAt(0.425, 0.375), ['meta'])
  await driver.untilUndoLabel('Undo Move Shape')
  await driver.picture('drawing-tools')

  const corner = centerOf(await driver.rect('handle-se'))
  await driver.drag(corner, { x: corner.x + 40, y: corner.y + 40 }, ['meta'])
  await driver.untilUndoLabel('Undo Resize Shape')
  const turn = centerOf(await driver.rect('handle-rotate'))
  await driver.drag(turn, { x: turn.x + 60, y: turn.y + 20 })
  await driver.untilUndoLabel('Undo Rotate Shape')
  driver.menu('undo')
  await driver.untilUndoLabel('Undo Resize Shape')
  driver.menu('undo')
  await driver.untilUndoLabel('Undo Move Shape')
  driver.menu('save')
  await untilEdited(driver, false)
  return { tools, preview }
}

const CHOSEN_SHAPES = `${selector('canvas-overlay')}.dataset.selectedShapes`
// From the middle of a shape row down into its bottom quarter, which drops behind that shape.
const BEHIND_ROW_SHARE = 0.4

// The card's 320x180 artboard sits in the middle of the 640x360 episode at full size.
async function artboardPointer(driver: Driver): Promise<(x: number, y: number) => Point> {
  const preview = await driver.rect('preview')
  return (x, y) => ({ x: preview.x + (preview.width * (x + 160)) / 640, y: preview.y + (preview.height * (y + 90)) / 360 })
}

async function openShapeRows(driver: Driver): Promise<void> {
  await openCardAnimation(driver)
  await driver.clickAt(centerOf(await driver.rect('track-expand-0')))
  await driver.until(`${selector('shape-row-coat')} !== null`, 'the shapes of the drawing to show')
}

function shownRows(driver: Driver): Promise<unknown> {
  return driver.page.evaluate(`[...document.querySelectorAll('.shape-row')].map((row) => row.querySelector('.shape-name')?.textContent)`)
}

// Shape rows sit under the track header, so the bottom ones can be below the timeline until it scrolls.
async function shapeRowPoint(driver: Driver, testId: string): Promise<Point> {
  return timelinePointInView(driver, async () => centerOf(await driver.rect(testId)), SHAPE_ROW_HEIGHT, `The "${testId}" row`)
}

async function chooseRow(driver: Driver, shapeId: string): Promise<void> {
  await driver.clickAt(await shapeRowPoint(driver, `shape-row-${shapeId}`))
  await driver.until(`${selector(`shape-row-${shapeId}`)}?.dataset.selected === 'true'`, `the ${shapeId} row to be chosen`)
}

async function shapesPickedAt(driver: Driver, point: Point): Promise<unknown> {
  await driver.clickAt(point)
  await sleep(POLL_INTERVAL_MS)
  return driver.page.evaluate(CHOSEN_SHAPES)
}

// The card's drawing holds, back to front, Left, Coat (with an unnamed pocket clipped inside) and Right.
async function testShapeRows(driver: Driver): Promise<UiTestReport> {
  await openShapeRows(driver)
  const pointAt = await artboardPointer(driver)
  const rowsAtFirst = await shownRows(driver)

  await driver.doubleClickAt(await shapeRowPoint(driver, 'shape-name-coat'))
  await driver.until(`${selector('shape-name-input')} !== null`, 'the name field')
  await driver.typeInto('shape-name-input', 'Big coat')
  await driver.untilUndoLabel('Undo Rename Shape')

  await chooseRow(driver, 'pocket')
  await driver.clickAt(await shapeRowPoint(driver, 'shape-name-left'), ['shift'])
  await driver.until(`${CHOSEN_SHAPES} === '2'`, 'a second shape to be added')
  await driver.page.click('shape-hidden-left')
  await driver.untilUndoLabel('Undo Hide Shape')
  await driver.until(`${CHOSEN_SHAPES} === '1'`, 'the hidden shape to be let go')
  const pickedWhereHidden = await shapesPickedAt(driver, pointAt(40, 40))
  await driver.page.click('shape-locked-coat')
  await driver.untilUndoLabel('Undo Lock Shape')
  const pickedWhereLocked = await shapesPickedAt(driver, pointAt(255, 145))

  const lowestRow = await shapeRowPoint(driver, 'shape-row-left')
  await driver.drag(await shapeRowPoint(driver, 'shape-row-right'), { x: lowestRow.x, y: lowestRow.y + SHAPE_ROW_HEIGHT * BEHIND_ROW_SHARE })
  await driver.untilUndoLabel('Undo Reorder Shapes')
  const rowsAfter = await shownRows(driver)
  driver.menu('save')
  await untilEdited(driver, false)
  await driver.picture('shape-rows')
  return { rowsAtFirst, pickedWhereHidden, pickedWhereLocked, rowsAfter }
}

async function testShapeEdits(driver: Driver): Promise<UiTestReport> {
  await openShapeRows(driver)
  const pointAt = await artboardPointer(driver)

  await chooseRow(driver, 'left')
  await driver.press('Backspace')
  await driver.untilUndoLabel('Undo Delete Shape')
  driver.menu('undo')
  await driver.untilRedoLabel('Redo Delete Shape')
  await chooseRow(driver, 'left')
  driver.window.webContents.copy()
  driver.window.webContents.paste()
  await driver.untilUndoLabel('Undo Paste Shape')
  await driver.press('D', ['meta'])
  await driver.untilUndoLabel('Undo Duplicate Shape')
  const rowsWithCopies = await shownRows(driver)

  await chooseRow(driver, 'left')
  await driver.press(']', ['meta', 'shift'])
  await driver.untilUndoLabel('Undo Bring to Front')
  await driver.press('[', ['meta'])
  await driver.untilUndoLabel('Undo Send Backward')

  await chooseRow(driver, 'coat')
  await driver.clickAt(centerOf(await driver.rect('colour-stroke')))
  await driver.until(isPressed('colour-stroke'), 'the stroke colour to be chosen')
  const hue = await driver.rect('colour-hue-track')
  await driver.drag({ x: hue.x + 1, y: hue.y + hue.height / 2 }, { x: hue.x + hue.width / 3, y: hue.y + hue.height / 2 })
  await driver.untilUndoLabel('Undo Change Stroke')
  await driver.clickAt(centerOf(await driver.rect('colour-fill')))
  await driver.until(isPressed('colour-fill'), 'the fill colour to be chosen')
  await driver.typeInto('colour-hex', '#336699')
  await driver.untilUndoLabel('Undo Change Fill')

  await driver.press('Escape')
  await driver.until(`${CHOSEN_SHAPES} === '0'`, 'the coat to be let go')
  await driver.typeInto('colour-hex', 'ff8800')
  await driver.until(`${selector('tool-well-fill')}?.getAttribute('aria-label') === 'Fill #FF8800'`, 'the colour for new shapes to change')
  await driver.press('M')
  await driver.until(isPressed('tool-rectangle'), 'the rectangle tool to be chosen')
  await driver.drag(pointAt(150, 100), pointAt(200, 130))
  await driver.untilUndoLabel('Undo Add Rectangle')
  driver.menu('save')
  await untilEdited(driver, false)
  await driver.picture('shape-colours')

  await driver.press('Escape')
  await driver.press('Escape')
  await driver.until(`${selector('group-path')} === null`, 'the animation to close')
  driver.window.webContents.paste()
  await driver.until(`${selector('notice')} !== null`, 'the paste to be refused')
  return { rowsWithCopies, notice: await driver.page.text('notice') }
}

async function clickTestId(driver: Driver, testId: string): Promise<void> {
  await driver.clickAt(centerOf(await driver.rect(testId)))
}

// Back to front the card's drawing holds Left (red), Coat (white, with a blue pocket clipped inside) and Right (green).
async function testShapePaint(driver: Driver): Promise<UiTestReport> {
  await openShapeRows(driver)
  const pointAt = await artboardPointer(driver)

  await driver.typeInto('colour-hex', '00AAFF')
  await driver.until(`${selector('tool-well-fill')}?.getAttribute('aria-label') === 'Fill #00AAFF'`, 'the colour for new shapes to change')
  await driver.press('G')
  await driver.until(isPressed('tool-fill'), 'the fill tool to be chosen')
  await driver.hover(pointAt(40, 40))
  await driver.until(`${selector('fill-target')}?.dataset.shape === 'left'`, 'the left square to be outlined')
  await driver.clickAt(pointAt(40, 40))
  await driver.untilUndoLabel('Undo Fill Shape')
  await driver.hover(pointAt(278, 158))
  await driver.until(`${selector('fill-target')}?.dataset.shape === 'pocket'`, 'the pocket to be outlined')
  await driver.clickAt(pointAt(278, 158))
  await chooseRow(driver, 'pocket')
  await driver.until(`${selector('tool-well-fill')}?.getAttribute('aria-label') === 'Fill #00AAFF'`, 'the pocket to be filled')

  await driver.press('I')
  await driver.until(isPressed('tool-picker'), 'the colour picker to be chosen')
  await chooseRow(driver, 'coat')
  await driver.clickAt(pointAt(120, 30))
  await driver.untilUndoLabel('Undo Pick Fill Colour')
  await driver.clickAt(pointAt(40, 40), ['shift'])
  await driver.untilUndoLabel('Undo Pick Stroke Colour')

  await clickTestId(driver, 'swatch-add')
  await driver.untilUndoLabel('Undo Add Swatch')
  await clickTestId(driver, 'swatch-0')
  await driver.until(isPressed('swatch-0'), 'the coat to use the swatch')
  await chooseRow(driver, 'right')
  await clickTestId(driver, 'swatch-0')
  await driver.until(isPressed('swatch-0'), 'the right square to use the swatch')
  await driver.typeInto('swatch-name', 'Skin')
  await driver.untilUndoLabel('Undo Rename Swatch')
  await driver.typeInto('colour-hex', '884400')
  await driver.untilUndoLabel('Undo Change Swatch')
  const swatchName = await driver.page.evaluate(`${selector('swatch-0')}?.getAttribute('aria-label')`)
  await chooseRow(driver, 'coat')
  const coatFill = await driver.page.evaluate(`${selector('tool-well-fill')}?.getAttribute('aria-label')`)
  const isCoatLinked = await driver.page.evaluate(isPressed('swatch-0'))
  await driver.picture('swatches')

  await driver.rightClickAt(centerOf(await driver.rect('swatch-0')))
  await driver.until(`${selector('menu-delete-swatch')} !== null`, 'the swatch menu')
  await driver.page.click('menu-delete-swatch')
  await driver.untilUndoLabel('Undo Delete Swatch')
  driver.menu('save')
  await untilEdited(driver, false)
  return { swatchName, coatFill, isCoatLinked }
}

async function testShapeStrokes(driver: Driver): Promise<UiTestReport> {
  await openShapeRows(driver)
  const pointAt = await artboardPointer(driver)

  await chooseRow(driver, 'coat')
  for (const choice of ['stroke-style-dashed', 'stroke-cap-butt', 'stroke-align-outside', 'stroke-order-behind']) {
    await driver.page.click(choice)
    await driver.until(isPressed(choice), `${choice} to be chosen`)
  }
  await driver.typeInto('stroke-width', '6')
  await driver.until(`Number(${selector('stroke-width')}?.value) === 6`, 'the stroke to be 6 px wide')
  await driver.page.click('stroke-scales')
  await driver.until(`${selector('stroke-scales')}?.checked === true`, 'the stroke to scale with the coat')
  await driver.picture('stroke-panel')

  await driver.press('Escape')
  await driver.until(`${CHOSEN_SHAPES} === '0'`, 'the coat to be let go')
  await driver.page.click('stroke-style-none')
  await driver.until(isPressed('stroke-style-none'), 'new shapes to have no stroke')
  await driver.press('M')
  await driver.until(isPressed('tool-rectangle'), 'the rectangle tool to be chosen')
  await driver.drag(pointAt(150, 100), pointAt(200, 130))
  await driver.untilUndoLabel('Undo Add Rectangle')
  await driver.press('V')

  await shapeRowPoint(driver, 'shape-row-coat')
  const rightRow = await shapeRowPoint(driver, 'shape-row-right')
  await driver.drag(rightRow, centerOf(await driver.rect('shape-row-coat')))
  await driver.untilUndoLabel('Undo Clip Inside')
  const rows = await shownRows(driver)

  await driver.clickAt(await driver.timelinePoint(TICKS_PER_SECOND / 2, 0, 3))
  await driver.until(`${selector('clip-duration')} !== null && ${selector('clip-x')} === null`, 'the drawing to be selected')
  await driver.press('D', ['meta'])
  await driver.untilUndoLabel('Undo Duplicate Drawing')
  driver.menu('save')
  await untilEdited(driver, false)
  return { rows }
}

const PEN_PATH = selector('pen-path')
const CHOSEN_NODES = `${selector('canvas-overlay')}.dataset.selectedNodes`

function nodesShown(shapeId: string): string {
  return `document.querySelectorAll('[data-testid^="node-${shapeId}-"]').length`
}

// A closed path with a smooth node and a broken one, then an open path without a fill and one with it.
async function testPenTool(driver: Driver): Promise<UiTestReport> {
  await openCardAnimation(driver)
  const pointAt = await artboardPointer(driver)
  await driver.press('P')
  await driver.until(isPressed('tool-pen'), 'the pen to be chosen')

  await driver.clickAt(pointAt(160, 30))
  await driver.clickAt(pointAt(200, 30))
  await driver.drag(pointAt(200, 70), pointAt(220, 70))
  await driver.drag(pointAt(160, 70), pointAt(160, 90), ['alt'])
  await driver.hover(pointAt(170, 50))
  await driver.until(`${selector('pen-preview')} !== null`, 'the next segment to show')
  const nodesWhileDrawing = await driver.page.evaluate(`${PEN_PATH}.dataset.nodes`)
  await driver.picture('pen-drawing')
  await driver.clickAt(pointAt(160, 30))
  await driver.untilUndoLabel('Undo Add Path')
  await driver.until(`${PEN_PATH} === null`, 'the closed path to end')
  driver.menu('undo')
  await driver.untilUndoLabel('Undo')
  driver.menu('redo')
  await driver.untilUndoLabel('Undo Add Path')

  await driver.clickAt(pointAt(240, 30))
  await driver.clickAt(pointAt(280, 40))
  await driver.until(`${PEN_PATH}?.dataset.nodes === '2'`, 'the open path to have two nodes')
  await driver.press('Enter')
  await driver.until(`${PEN_PATH} === null`, 'Enter to end the path')

  await driver.page.click('pen-fill-open')
  await driver.until(`${selector('pen-fill-open')}?.checked === true`, 'open paths to be filled')
  await driver.clickAt(pointAt(240, 100))
  await driver.clickAt(pointAt(280, 110))
  await driver.until(`${PEN_PATH}?.dataset.nodes === '2'`, 'the filled path to have two nodes')
  await driver.press('Escape')
  await driver.until(`${PEN_PATH} === null`, 'Esc to end the path')
  const isAnimationOpen = await driver.page.evaluate(`${selector('group-path')} !== null`)
  driver.menu('save')
  await untilEdited(driver, false)
  return { nodesWhileDrawing, isAnimationOpen }
}

async function chooseRightSquare(driver: Driver): Promise<(x: number, y: number) => Point> {
  await openCardAnimation(driver)
  const pointAt = await artboardPointer(driver)
  await driver.press('A')
  await driver.until(isPressed('tool-node'), 'the node tool to be chosen')
  await driver.clickAt(pointAt(120, 40))
  await driver.until(`${nodesShown('right')} === 4`, 'the nodes of the right square')
  return pointAt
}

// Right's nodes are moved, boxed, nudged and smoothed; then Left gets a node, loses it, and is broken in two.
async function testNodeTool(driver: Driver): Promise<UiTestReport> {
  const pointAt = await chooseRightSquare(driver)
  const corner = centerOf(await driver.rect('node-right-0'))
  await driver.drag(corner, { x: corner.x - 10, y: corner.y - 10 })
  await driver.untilUndoLabel('Undo Move Node')
  await clickTestId(driver, 'node-right-2')
  await driver.until(`${CHOSEN_NODES} === '1'`, 'one node to be chosen')
  await driver.clickAt(centerOf(await driver.rect('node-right-1')), ['shift'])
  await driver.until(`${CHOSEN_NODES} === '2'`, 'a second node to be added')

  driver.holdAt(pointAt(85, 50))
  await driver.dragOn(pointAt(85, 50), pointAt(150, 70))
  await driver.until(`${selector('marquee')} !== null`, 'the box to show')
  await driver.picture('node-box')
  await driver.releaseAt(pointAt(150, 70))
  const isBoxed = `${selector('node-right-3')}?.classList.contains('chosen') === true && ${selector('node-right-1')}?.classList.contains('chosen') === false`
  await driver.until(`${CHOSEN_NODES} === '2' && ${isBoxed}`, 'the bottom nodes to be boxed')

  const timecode = `${selector('timecode')}.textContent`
  const timeBefore = await driver.page.evaluate(timecode)
  await driver.press('Up', ['shift'])
  await driver.untilUndoLabel('Undo Nudge Nodes')
  await driver.press('Right')
  await sleep(POLL_INTERVAL_MS)
  const timeAfter = await driver.page.evaluate(timecode)
  await driver.page.click('node-type-smooth')
  await driver.untilUndoLabel('Undo Change Node Type')
  await driver.typeInto('node-y', '55')
  await driver.untilUndoLabel('Undo Move Nodes')

  await driver.clickAt(pointAt(85, 50))
  await driver.until(`${CHOSEN_SHAPES} === '0'`, 'a click on nothing to let go')
  await driver.clickAt(pointAt(120, 40))
  await driver.until(`${nodesShown('right')} === 4`, 'the right square to be chosen again')
  await clickTestId(driver, 'node-right-2')
  await driver.until(`${selector('node-out-right-2')} !== null`, 'the handles of the smooth node')
  const handle = centerOf(await driver.rect('node-out-right-2'))
  await driver.drag(handle, { x: handle.x, y: handle.y + 20 })
  await driver.untilUndoLabel('Undo Move Handle')
  await driver.picture('node-handles')

  await driver.clickAt(pointAt(40, 40))
  await driver.until(`${nodesShown('left')} === 4`, 'the nodes of the left square')
  await driver.clickAt(pointAt(40, 20))
  await driver.untilUndoLabel('Undo Add Node')
  const nodesAfterAdding = await driver.page.evaluate(nodesShown('left'))
  await driver.press('Backspace')
  await driver.untilUndoLabel('Undo Delete Node')

  await clickTestId(driver, 'node-left-0')
  await driver.page.click('node-break')
  await driver.until(`${nodesShown('left')} === 5`, 'the left square to open')
  await clickTestId(driver, 'node-left-2')
  await driver.page.click('node-break')
  await driver.until(`${nodesShown('left')} === 3`, 'the left path to split')
  await driver.page.click('node-close')
  await driver.untilUndoLabel('Undo Close Path')
  driver.menu('save')
  await untilEdited(driver, false)
  return { timeBefore, timeAfter, nodesAfterAdding }
}

const SNAP_GUIDES = `document.querySelectorAll('.snap-guide').length`

async function dragNodeHeld(driver: Driver, testId: string, to: Point, guides: number): Promise<void> {
  const from = centerOf(await driver.rect(testId))
  driver.holdAt(from)
  await driver.dragOn(from, to)
  await driver.until(`${SNAP_GUIDES} === ${guides}`, `${guides} snap guides`)
}

// Right's corners snap onto Left's corner, then the top edge, and not with ⌘; a pen path and a rectangle snap the same way.
async function testNodeSnapping(driver: Driver): Promise<UiTestReport> {
  const pointAt = await chooseRightSquare(driver)

  await dragNodeHeld(driver, 'node-right-0', pointAt(63, 22), 2)
  await driver.picture('node-snap-guides')
  await driver.releaseAt(pointAt(63, 22))
  await driver.untilUndoLabel('Undo Move Node')
  await driver.until(`${SNAP_GUIDES} === 0`, 'the guides to go')
  await dragNodeHeld(driver, 'node-right-1', pointAt(150, 3), 1)
  await driver.releaseAt(pointAt(150, 3))
  await driver.until(`${SNAP_GUIDES} === 0`, 'the edge guide to go')
  const corner = centerOf(await driver.rect('node-right-3'))
  await driver.drag(corner, pointAt(63, 62), ['meta'])
  await driver.until(`${SNAP_GUIDES} === 0`, 'no guides without snapping')

  await driver.press('P')
  await driver.until(isPressed('tool-pen'), 'the pen to be chosen')
  await driver.clickAt(pointAt(22, 62))
  await driver.clickAt(pointAt(200, 100))
  await driver.until(`${PEN_PATH}?.dataset.nodes === '2'`, 'the path to have two nodes')
  await driver.press('Enter')
  await driver.untilUndoLabel('Undo Add Path')

  await driver.press('M')
  await driver.until(isPressed('tool-rectangle'), 'the rectangle tool to be chosen')
  await driver.drag(pointAt(3, 150), pointAt(40, 177))
  await driver.untilUndoLabel('Undo Add Rectangle')
  driver.menu('save')
  await untilEdited(driver, false)
  const preview = await driver.rect('preview')
  return { previewWidth: preview.width }
}

const CARD_TRACKS = 2
const CLIP_DIAMOND_BELOW_MIDDLE = TRACK_HEIGHT / 2 - 8

// Inside the 12 fps card the timecode shows frame numbers; even ones start on a frame of the 30 fps episode, where the playhead lands.
async function seekToFrame(driver: Driver, frame: number): Promise<void> {
  const timeline = await driver.rect('timeline')
  const onTrack = await driver.timelinePoint((frame * TICKS_PER_SECOND) / 12, 0, CARD_TRACKS)
  await driver.clickAt({ x: onTrack.x, y: timeline.y + RULER_HEIGHT / 2 })
  await driver.until(`${selector('timecode')}.textContent === '${frame}'`, `the playhead at frame ${frame}`)
}

async function clipDiamondPoint(driver: Driver, time: number): Promise<Point> {
  const onTrack = await driver.timelinePoint(time, 0, CARD_TRACKS)
  return { x: onTrack.x, y: onTrack.y + CLIP_DIAMOND_BELOW_MIDDLE }
}

async function chooseMenuItem(driver: Driver, testId: string): Promise<void> {
  await driver.until(`${selector(testId)} !== null`, `the ${testId} menu item`)
  await driver.page.click(testId)
}

const ONION_OUTLINES = `[...document.querySelectorAll('.onion')].map((outline) => ({ testId: outline.dataset.testid, opacity: outline.getAttribute('opacity') }))`

// The card's bottom track holds four drawings of half a second; the third one is at the playhead and chosen.
async function testOnionSkin(driver: Driver): Promise<UiTestReport> {
  await openCardAnimation(driver)
  await seekToFrame(driver, 14)
  await driver.clickAt(await driver.timelinePoint((5 * TICKS_PER_SECOND) / 4, 0, CARD_TRACKS))
  await driver.page.click('onion-skin-button')
  await driver.until(`document.querySelectorAll('.onion').length === 3`, 'the outlines of the drawings around the playhead')
  const outlines = await driver.page.evaluate(ONION_OUTLINES)
  await driver.picture('onion-skin')
  await driver.page.click('onion-skin-button')
  await driver.until(`document.querySelectorAll('.onion').length === 0`, 'the outlines to go')
  return { outlines }
}

// Right's top right corner is keyed at frame 0 and moved at frame 12, where its keys are eased, copied and pasted at frame 18; the frame 18 keys are then dragged to frame 21 on Right's row.
async function testNodeKeys(driver: Driver): Promise<UiTestReport> {
  await chooseRightSquare(driver)
  await clickTestId(driver, 'node-right-1')
  await driver.until(`${CHOSEN_NODES} === '1'`, 'the corner to be chosen')
  await driver.page.click('node-position-keyframe')
  await driver.untilUndoLabel('Undo Add Node Keyframe')
  await seekToFrame(driver, 12)
  const corner = centerOf(await driver.rect('node-right-1'))
  await driver.drag(corner, { x: corner.x + 20, y: corner.y })
  await driver.untilUndoLabel('Undo Move Node')
  const unkeyed = centerOf(await driver.rect('node-right-0'))
  await driver.drag(unkeyed, { x: unkeyed.x, y: unkeyed.y - 10 })
  await driver.untilUndoLabel('Undo Move Node')

  await driver.rightClickAt(await clipDiamondPoint(driver, TICKS_PER_SECOND))
  await chooseMenuItem(driver, 'menu-easing-easeIn')
  await driver.untilUndoLabel('Undo Change Keys Easing')
  await driver.rightClickAt(await clipDiamondPoint(driver, TICKS_PER_SECOND))
  await chooseMenuItem(driver, 'menu-copy-keys')
  await seekToFrame(driver, 18)
  await driver.rightClickAt(await driver.timelinePoint((7 * TICKS_PER_SECOND) / 4, 0, CARD_TRACKS))
  await chooseMenuItem(driver, 'menu-paste-keys')
  await driver.untilUndoLabel('Undo Paste Keys')

  await driver.clickAt(centerOf(await driver.rect('track-expand-0')))
  await driver.until(`${selector('shape-row-right')} !== null`, 'the shape rows')
  const row = await shapeRowPoint(driver, 'shape-row-right')
  const from = { x: (await driver.timelinePoint((3 * TICKS_PER_SECOND) / 2, 0, CARD_TRACKS)).x, y: row.y }
  const to = { x: (await driver.timelinePoint((7 * TICKS_PER_SECOND) / 4, 0, CARD_TRACKS)).x, y: row.y }
  await driver.drag(from, to)
  await driver.untilUndoLabel('Undo Move Keys')
  await driver.picture('node-keys')
  driver.menu('save')
  await untilEdited(driver, false)
  return {}
}

async function saveBoxedCorners(driver: Driver, from: Point, to: Point, shapeName: string): Promise<void> {
  await driver.drag(from, to)
  await driver.until(`${CHOSEN_NODES} === '4'`, `the corners of ${shapeName} to be boxed`)
  await driver.page.click('node-set-save')
  await driver.untilUndoLabel('Undo Save Node Set')
}

// Right's four corners become a set that is turned at frame 0, typed to 90° and moved at frame 12, and whose pivot is then dragged.
async function testNodeSets(driver: Driver): Promise<UiTestReport> {
  const pointAt = await chooseRightSquare(driver)
  await saveBoxedCorners(driver, pointAt(90, 10), pointAt(150, 70), 'Right')
  await driver.until(isPressed('node-set-Set 1'), 'the new set to be selected')
  await driver.typeInto('node-set-name', 'Arm')
  await driver.untilUndoLabel('Undo Rename Node Set')
  await driver.until(isPressed('node-set-Arm'), 'the renamed set')

  const turn = centerOf(await driver.rect('set-turn'))
  const pivot = centerOf(await driver.rect('set-pivot'))
  await driver.drag(turn, { x: turn.x - (turn.y - pivot.y), y: turn.y + (turn.x - pivot.x) })
  await driver.untilUndoLabel('Undo Rotate Node Set')
  const isGhostShownAtFirstKey = await driver.page.evaluate(`${selector('set-ghost')} !== null`)
  await seekToFrame(driver, 12)
  await driver.typeInto('node-set-rotation', '90')
  await driver.untilUndoLabel('Undo Rotate Node Set')
  await driver.until(`${selector('set-ghost')} !== null`, 'the outline at the previous key')
  await driver.picture('node-set-ghost')

  const corner = centerOf(await driver.rect('node-right-0'))
  await driver.drag(corner, { x: corner.x + 20, y: corner.y })
  await driver.untilUndoLabel('Undo Move Node Set')
  const movedPivot = centerOf(await driver.rect('set-pivot'))
  await driver.drag(movedPivot, { x: movedPivot.x - 50, y: movedPivot.y + 50 })
  await driver.untilUndoLabel('Undo Move Pivot')
  driver.menu('save')
  await untilEdited(driver, false)
  const preview = await driver.rect('preview')
  return { isGhostShownAtFirstKey, previewWidth: preview.width }
}

// Set choices carry the set's random id, so the option is found by the set's name.
async function pickSetNamed(driver: Driver, testId: string, name: string): Promise<void> {
  await clickTestId(driver, testId)
  const options = `[...document.querySelectorAll('[data-testid="${testId}-options"] [role="option"]')]`
  await driver.until(`${options}.length > 0`, `the choices of ${testId}`)
  const option = await driver.page.evaluate(`${options}.find((option) => option.textContent === '${name}')?.dataset.testid`)
  if (typeof option !== 'string') throw new Error(`${testId} offers no "${name}"`)
  await clickTestId(driver, option)
  await driver.until(`${options}.length === 0`, `the choices of ${testId} to close`)
}

// Right's corners make Set 1, which Left follows; Left's corners make Set 2 under Set 1, which is then turned to -30° at frame 0.
async function testFollowAndParent(driver: Driver): Promise<UiTestReport> {
  const pointAt = await chooseRightSquare(driver)
  await saveBoxedCorners(driver, pointAt(90, 10), pointAt(150, 70), 'Right')
  await driver.clickAt(pointAt(40, 40))
  await driver.until(`${nodesShown('left')} === 4`, 'the nodes of Left')
  await pickSetNamed(driver, 'shape-follow', 'Set 1')
  await driver.untilUndoLabel('Undo Follow Node Set')

  await saveBoxedCorners(driver, pointAt(10, 10), pointAt(70, 70), 'Left')
  await pickSetNamed(driver, 'node-set-parent', 'Set 1')
  await driver.untilUndoLabel('Undo Change Parent Set')
  const pivotBefore = centerOf(await driver.rect('set-pivot'))
  const cornerBefore = centerOf(await driver.rect('node-left-0'))

  await driver.page.click('node-set-Set 1')
  await driver.until(isPressed('node-set-Set 1'), 'Set 1 to be selected')
  await driver.typeInto('node-set-rotation', '-30')
  await driver.untilUndoLabel('Undo Rotate Node Set')
  await driver.page.click('node-set-Set 2')
  await driver.until(isPressed('node-set-Set 2'), 'Set 2 to be selected')
  const pivotAfter = centerOf(await driver.rect('set-pivot'))
  const cornerAfter = centerOf(await driver.rect('node-left-0'))
  driver.menu('save')
  await untilEdited(driver, false)
  const preview = await driver.rect('preview')
  return { pivotBefore, pivotAfter, cornerBefore, cornerAfter, previewWidth: preview.width }
}

// Right gets a rotation key at frame 0 in the Transform group; at frame 12 the box turns it a quarter and its bottom right corner grows it.
async function testShapeKeys(driver: Driver): Promise<UiTestReport> {
  await openCardAnimation(driver)
  const pointAt = await artboardPointer(driver)
  await driver.press('V')
  await driver.until(isPressed('tool-move'), 'the move tool to be chosen')
  const middle = pointAt(120, 40)
  await driver.clickAt(middle)
  await driver.until(`${CHOSEN_SHAPES} === '1'`, 'Right to be selected')
  await driver.page.click('shape-rotation-keyframe')
  await driver.untilUndoLabel('Undo Add Rotation Keyframe')
  const hasSideHandles = await driver.page.evaluate(`${selector('handle-e')} !== null`)

  await seekToFrame(driver, 12)
  const turn = centerOf(await driver.rect('handle-rotate'))
  await driver.drag(turn, { x: middle.x + (middle.y - turn.y), y: middle.y })
  await driver.untilUndoLabel('Undo Rotate Shape')
  const corner = centerOf(await driver.rect('handle-se'))
  await driver.drag(corner, { x: corner.x + (corner.x - middle.x) / 2, y: corner.y + (corner.y - middle.y) / 2 })
  await driver.untilUndoLabel('Undo Resize Shape')
  driver.menu('save')
  await untilEdited(driver, false)
  return { hasSideHandles }
}

async function pickHeldFrame(driver: Driver, frame: number): Promise<void> {
  await driver.page.click(`held-frame-${frame}`)
  await driver.until(isPressed(`held-frame-${frame}`), `frame ${frame} to be chosen`)
}

// The Mouths animation has six frames at 12 fps, placed as one played clip on the top of two tracks.
async function testHoldFrame(driver: Driver): Promise<UiTestReport> {
  await fullQualityFrame(driver, 0)
  await driver.clickAt(await driver.timelinePoint(TICKS_PER_SECOND / 4, 1, 2))
  await driver.until(`${selector('clip-mode-hold')} !== null`, 'the clip mode to show')
  await driver.page.click('clip-mode-hold')
  await driver.untilUndoLabel('Undo Hold Frame')
  await driver.until(`${selector('held-frame-5')} !== null`, 'the frames to show')
  await driver.until(`${selector('held-frame-5')}.querySelector('canvas') !== null`, 'the thumbnail of a frame')
  const isSpeedShownWhileHeld = await driver.page.evaluate(`${selector('clip-speed')} !== null`)

  await driver.typeInto('clip-duration', '2')
  await driver.untilUndoLabel('Undo Trim Clip')
  await pickHeldFrame(driver, 3)
  await driver.picture('hold-frame-picker')

  const timeline = await driver.rect('timeline')
  const onTrack = await driver.timelinePoint(TICKS_PER_SECOND, 1, 2)
  await driver.clickAt({ x: onTrack.x, y: timeline.y + RULER_HEIGHT / 2 })
  await driver.until(`${selector('timecode')}.textContent === '00:00:01:00'`, 'the playhead at one second')
  driver.menu('split')
  await driver.untilUndoLabel('Undo Split Clip')
  await pickHeldFrame(driver, 5)
  driver.menu('save')
  await untilEdited(driver, false)

  await driver.page.click('clip-mode-play')
  await driver.untilUndoLabel('Undo Play Clip')
  const playedDuration = await driver.value('clip-duration')
  const isSpeedShownWhenPlayed = await driver.page.evaluate(`${selector('clip-speed')} !== null`)
  return { isSpeedShownWhileHeld, playedDuration, isSpeedShownWhenPlayed }
}

// Kenta (on track 1) and Bob (on track 2) each hold a frame of Mouths; Kenta starts at one second.
async function testSharedParts(driver: Driver): Promise<UiTestReport> {
  await fullQualityFrame(driver, 0)
  const preview = await driver.rect('preview')
  const pointAt = (x: number, y: number): Point => ({ x: preview.x + (preview.width * x) / 640, y: preview.y + (preview.height * y) / 360 })

  await driver.doubleClickAt(await driver.timelinePoint(1.5 * TICKS_PER_SECOND, 1, 3))
  await driver.until(`${selector('group-path')}?.textContent.includes('kenta') === true`, 'Kenta to open')
  await driver.doubleClickAt(await driver.timelinePoint(TICKS_PER_SECOND / 2, 0, 1))
  await driver.until(`${selector('group-path')}?.textContent.includes('mouths') === true`, 'Mouths to open')
  const path = await driver.page.evaluate(`${selector('group-path')}.textContent`)
  await driver.until(`${selector('timecode')}.textContent === '2'`, 'the playhead on the held frame')
  const duration = await driver.page.evaluate(`${selector('duration')}.textContent`)

  await driver.press('Right')
  await driver.until(`${selector('timecode')}.textContent === '3'`, 'the odd frame, which the episode has no frame for')
  await driver.press('Right')
  await driver.until(`${selector('timecode')}.textContent === '4'`, 'the frame Bob holds')
  await driver.picture('shared-parts-open')

  await driver.press('V')
  await driver.until(isPressed('tool-move'), 'the move tool to be chosen')
  await driver.drag(pointAt(195, 175), pointAt(235, 175), ['meta'])
  await driver.untilUndoLabel('Undo Move Shape')
  driver.menu('save')
  await untilEdited(driver, false)

  await closeAnimations(driver)
  await driver.until(`${selector('timecode')}.textContent === '00:00:01:00'`, 'the playhead back where the clip starts')

  await driver.clickAt(await driver.timelinePoint(TICKS_PER_SECOND / 2, 2, 3))
  await driver.until(`${selector('group-animation')} !== null`, 'the groups of the selected clip')
  await driver.page.evaluate(`[...document.querySelectorAll('[data-testid="group-animation"]')].at(-1).click()`)
  await driver.until(`${selector('animation-open')} !== null`, 'the button that opens the selected clip')
  await driver.page.click('animation-open')
  await driver.until(`${selector('group-path')}?.textContent.includes('bob') === true`, 'Bob to open from Properties')
  await driver.press('Escape')
  await driver.until(`${selector('group-path')} === null`, 'Bob to close')

  await driver.until(`${selector('timecode')}.textContent === '00:00:01:00'`, 'the playhead where it was')
  await driver.doubleClickAt(pointAt(555, 175))
  await driver.until(`${selector('group-path')}?.textContent.includes('bob') === true`, 'Bob to open from the canvas')
  await driver.doubleClickAt(pointAt(555, 175))
  await driver.until(`${selector('group-path')}?.textContent.includes('mouths') === true`, 'Mouths to open from the canvas')
  await driver.until(`${selector('timecode')}.textContent === '4'`, 'the frame Bob holds')
  return { path, duration }
}

async function makeUniqueAt(driver: Driver, point: Point): Promise<void> {
  await driver.rightClickAt(point)
  await chooseMenuItem(driver, 'menu-make-unique')
}

// Two played clips of Mouths lie on tracks 1 and 2; an edit to the first frame of Mouths stays unsaved until the end.
async function testMakeUnique(driver: Driver): Promise<UiTestReport> {
  const { outputDirectory } = driver.options
  if (outputDirectory === undefined) throw new PageError('This UI test needs --out <directory>')
  await fullQualityFrame(driver, 0)
  await driver.doubleClickAt(await driver.timelinePoint(TICKS_PER_SECOND / 4, 1, 3))
  await driver.until(`${selector('group-path')} !== null`, 'Mouths to open')
  await driver.press('V')
  await driver.until(isPressed('tool-move'), 'the move tool to be chosen')
  const preview = await driver.rect('preview')
  const pointAt = (x: number, y: number): Point => ({ x: preview.x + (preview.width * x) / 640, y: preview.y + (preview.height * y) / 360 })
  await driver.drag(pointAt(35, 175), pointAt(55, 175), ['meta'])
  await driver.untilUndoLabel('Undo Move Shape')
  await closeAnimations(driver)

  await makeUniqueAt(driver, await driver.timelinePoint(TICKS_PER_SECOND / 4, 1, 3))
  await driver.untilUndoLabel('Undo Make Unique')
  await driver.until(`${selector('media-mouths 2.pbanim')} !== null`, 'the copy in Media')
  const copyPath = join(outputDirectory, 'mouths 2.pbanim')
  const copyAtFirst = await readFile(copyPath, 'utf8')
  const originalAtFirst = await readFile(join(outputDirectory, 'mouths.pbanim'), 'utf8')

  driver.menu('undo')
  await driver.untilRedoLabel('Redo Make Unique')
  await driver.until(`${selector('media-mouths 2.pbanim')} === null`, 'the copy to leave Media')
  const isCopyKeptAfterUndo = existsSync(copyPath)
  driver.menu('redo')
  await driver.untilUndoLabel('Undo Make Unique')

  await makeUniqueAt(driver, await driver.timelinePoint(TICKS_PER_SECOND / 4, 2, 3))
  await driver.until(`${selector('media-mouths 3.pbanim')} !== null`, 'the second copy in Media')
  driver.menu('save')
  await untilEdited(driver, false)
  return { copyAtFirst, originalAtFirst, isCopyKeptAfterUndo }
}

async function closeAnimations(driver: Driver): Promise<void> {
  await driver.page.click('group-path-0')
  await driver.until(`${selector('group-path')} === null`, 'the animations to close')
}

async function openAnimationOnTrack(driver: Driver, trackIndex: number, name: string): Promise<void> {
  await driver.doubleClickAt(await driver.timelinePoint(TICKS_PER_SECOND / 2, trackIndex, 3))
  await driver.until(`${selector('group-path')}?.textContent.includes('${name}') === true`, `${name} to open`)
}

// First (on track 1) holds a drawing whose shape uses a swatch and follows a set with a parent; second (on track 2) holds a drawing of its own.
async function testPasteBetween(driver: Driver): Promise<UiTestReport> {
  await fullQualityFrame(driver, 0)
  const preview = await driver.rect('preview')
  await openAnimationOnTrack(driver, 1, 'first')
  await driver.press('V')
  await driver.until(isPressed('tool-move'), 'the move tool to be chosen')
  await driver.clickAt({ x: preview.x + (preview.width * 35) / 640, y: preview.y + (preview.height * 175) / 360 })
  await driver.until(`${CHOSEN_SHAPES} === '1'`, 'the shape to be selected')
  driver.window.webContents.copy()
  await closeAnimations(driver)

  await openAnimationOnTrack(driver, 2, 'second')
  driver.window.webContents.paste()
  await driver.untilUndoLabel('Undo Paste Shape')
  await closeAnimations(driver)

  await openAnimationOnTrack(driver, 1, 'first')
  await driver.clickAt(await driver.timelinePoint(TICKS_PER_SECOND / 2, 0, 1))
  await driver.until(`${selector('clip-start')} !== null`, 'the drawing to be selected')
  driver.window.webContents.copy()
  await closeAnimations(driver)

  await openAnimationOnTrack(driver, 2, 'second')
  driver.window.webContents.paste()
  await driver.untilUndoLabel('Undo Paste Clip')
  driver.menu('save')
  await untilEdited(driver, false)
  return {}
}

function isOfLength(frames: number): string {
  return `${selector('duration')}?.textContent === '/ ${frames}'`
}

async function writeFramesOf(text: string, path: string, frames: number): Promise<void> {
  const parsed = parseProject(text, 'animation')
  if (!parsed.ok) throw new PageError(`The animation could not be read: ${parsed.message}`)
  const [track] = parsed.project.tracks
  const [first] = track?.clips ?? []
  if (track === undefined || first === undefined) throw new PageError('The animation has no frames')
  const clips: Clip[] = []
  for (let frame = 0; frame < frames; frame++) clips.push({ ...first, id: `written-${frame}`, start: frame * first.duration })
  await writeFile(path, serializeProject({ ...parsed.project, tracks: [{ ...track, clips }] }))
}

// One played clip of Mouths (six frames at 12 fps) is open throughout; what the file holds shows in the animation's length.
async function testAnimationReload(driver: Driver): Promise<UiTestReport> {
  const { outputDirectory, answers } = driver.options
  if (outputDirectory === undefined) throw new PageError('This UI test needs --out <directory>')
  const path = join(outputDirectory, 'mouths.pbanim')
  const text = await readFile(path, 'utf8')
  await fullQualityFrame(driver, 0)
  await driver.doubleClickAt(await driver.timelinePoint(TICKS_PER_SECOND / 4, 1, 2))
  await driver.until(isOfLength(6), 'Mouths to open')

  await writeFramesOf(text, path, 7)
  await driver.until(isOfLength(7), 'a clean window to take in the file')
  const isEditedAfterReload = driver.window.isDocumentEdited()

  await driver.press('V')
  await driver.until(isPressed('tool-move'), 'the move tool to be chosen')
  const preview = await driver.rect('preview')
  const center = { x: preview.x + (preview.width * 195) / 640, y: preview.y + (preview.height * 175) / 360 }
  await driver.drag(center, { x: center.x + 20, y: center.y }, ['meta'])
  await driver.untilUndoLabel('Undo Move Shape')
  await untilEdited(driver, true)

  answers.animationChanged = 'mine'
  await writeFramesOf(text, path, 8)
  await sleep(FILE_TAKEN_IN_MS)
  const afterKeepingMine = await driver.page.evaluate(`${selector('duration')}.textContent`)
  const undoAfterKeepingMine = driver.menuLabel('undo')
  const isEditedAfterKeepingMine = driver.window.isDocumentEdited()

  answers.animationChanged = 'saved'
  await writeFramesOf(text, path, 9)
  await driver.until(isOfLength(9), 'the saved file to replace the unsaved one')
  await untilEdited(driver, false)
  const undoAfterUsingSaved = driver.menuLabel('undo')

  await writeFile(path, '{ "this is": "not an animation"')
  await driver.until(`${selector('notice')}?.textContent.includes('could not be read') === true`, 'the notice about the broken file')
  const afterBrokenFile = await driver.page.evaluate(`${selector('duration')}.textContent`)
  await writeFramesOf(text, path, 9)

  driver.menu('new')
  const other = await driverOfNewWindow(driver, [driver.window])
  answers.importMedia = [path]
  other.menu('import')
  await other.until(`${selector('media-mouths.pbanim')} !== null`, 'Mouths in the other window')
  await dragMedia(other, 'mouths.pbanim', await other.timelinePoint(0, 0, 6))
  await other.untilUndoLabel('Undo Add Clip')
  await other.doubleClickAt(await other.timelinePoint(TICKS_PER_SECOND / 4, 0, 6))
  await other.until(isOfLength(9), 'Mouths to open in the other window')

  // The menu acts on the newest window, so the save comes from there and the first window takes it in.
  await other.clickAt(await other.timelinePoint(TICKS_PER_SECOND / 8, 0, 1))
  other.menu('duplicate')
  await other.untilUndoLabel('Undo Duplicate Drawing')
  await other.until(isOfLength(10), 'the copied drawing')
  answers.saveProject = join(outputDirectory, 'second.json')
  other.menu('save')
  await untilEdited(other, false)
  await driver.until(isOfLength(10), 'the first window to take in the save')
  const isFirstWindowEdited = driver.window.isDocumentEdited()
  return { isEditedAfterReload, afterKeepingMine, undoAfterKeepingMine, isEditedAfterKeepingMine, undoAfterUsingSaved, afterBrokenFile, isFirstWindowEdited }
}

async function testAnimationCrash(driver: Driver): Promise<UiTestReport> {
  await fadeCardInsideAnimation(driver)
  await untilRecoveryFiles(1, '.animations')
  process.kill(process.pid, 'SIGKILL')
  return {}
}

async function testAnimationRestore(driver: Driver): Promise<UiTestReport> {
  await untilEdited(driver, true)
  driver.menu('save')
  await untilEdited(driver, false)
  return { title: driver.window.getTitle() }
}

const PREPARED_SEEK_HOURS = [3, 17, 9, 14, 1, 19]
const SECONDS_PER_HOUR = 3600
const PROJECT_HOURS = 20

async function testBudgets(driver: Driver): Promise<UiTestReport> {
  await driver.until(`Number(${selector('timecode')}?.dataset.frames ?? 0) > 0 && ${selector('timeline')}?.dataset.view !== undefined`, 'the project to be shown')
  const openSeconds = process.uptime()
  const longTasks = await watchLongTasks(driver)
  await fullQualityFrame(driver, 0)

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
  const picture = await driver.rect('preview')
  const grab = { x: picture.x + picture.width * 0.3, y: picture.y + picture.height * 0.3 }
  await driver.clickAt(grab)
  for (let pass = 0; pass < 4; pass++) await driver.drag(grab, { x: grab.x + 120, y: grab.y + 60 })
  await driver.untilUndoLabel('Undo Move Clip')
  const dragDelays = numbersIn(await driver.page.evaluate('window.dragDelays'))

  const undoMilliseconds = await delayUntilShown(driver, { shown: 'any frame' }, () => driver.menu('undo'))
  const redoMilliseconds = await delayUntilShown(driver, { shown: 'any frame' }, () => driver.menu('redo'))

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
  'animation-files': testAnimationFiles,
  'drawing-tools': testDrawingTools,
  'shape-rows': testShapeRows,
  'shape-edits': testShapeEdits,
  'shape-paint': testShapePaint,
  'shape-strokes': testShapeStrokes,
  'pen-tool': testPenTool,
  'node-tool': testNodeTool,
  'node-snapping': testNodeSnapping,
  'onion-skin': testOnionSkin,
  'node-keys': testNodeKeys,
  'node-sets': testNodeSets,
  'follow-and-parent': testFollowAndParent,
  'shape-keys': testShapeKeys,
  'hold-frame': testHoldFrame,
  'shared-parts': testSharedParts,
  'make-unique': testMakeUnique,
  'animation-reload': testAnimationReload,
  'paste-between': testPasteBetween,
  'animation-crash': testAnimationCrash,
  'animation-restore': testAnimationRestore,
  budgets: testBudgets,
  'open-and-save': testOpenAndSave,
  ...FEATURE_SCENARIOS,
  ...OUTPUT_SCENARIOS,
}

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
    await driver.picture(options.scenario)
  }
}
