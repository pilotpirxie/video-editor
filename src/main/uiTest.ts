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
  canvasPoint,
  centerOf,
  dragMedia,
  driverOf,
  fullQualityFrame,
  mediaFile,
  numbersIn,
  percentile,
  type Driver,
  type Point,
  type Scenario,
  type UiTestOptions,
  type UiTestReport,
} from './uiDriver.js'
import { FEATURE_SCENARIOS } from './uiScenarios.js'

const AUTOSAVE_TIMEOUT_MS = 20_000

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
  await driver.page.click('toggle-right')
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
  await driver.page.click('import')
  await driver.until(`Boolean(${selector('media-h264.mp4')}?.querySelector('.media-poster'))`, 'the poster of the imported video')
  const posterMilliseconds = Date.now() - importStartedAt
  await driver.until(`${selector('media-image.jpg')} !== null && ${selector('notice')} !== null`, 'the import to finish')
  const importNotice = await driver.page.text('notice')
  const hasBrokenItem = (await driver.page.evaluate(`${selector('media-broken-garbage.mp4')} !== null`)) === true

  await dragMedia(driver, 'h264.mp4', await driver.timelinePoint(0, 0, 1))
  await driver.until(`${selector('track-0')} !== null`, 'the first track')
  await dragMedia(driver, 'audio.wav', await driver.timelinePoint(second / 2, 0, 1))
  await driver.until(`${selector('track-1')} !== null`, 'a second track for the clip dropped on occupied space')
  await dragMedia(driver, 'image.jpg', await driver.timelinePoint(3 * second, 0, 2))
  await driver.untilUndoLabel('Undo Add Clip')
  await driver.until(`${selector('used-image.jpg')} !== null`, 'the image to be marked as used')
  const placed = await driver.savedProject('placed.json')

  // The image clip is dragged a little short of the end of the video clip and snaps onto it.
  const grab = await driver.timelinePoint(4 * second, 0, 2)
  const nearVideoEnd = await driver.timelinePoint(3 * second, 0, 2)
  await driver.drag(grab, { x: nearVideoEnd.x + 5, y: grab.y })
  await driver.untilUndoLabel('Undo Move Clip')
  const imageEnd = await driver.timelinePoint(7 * second, 0, 2)
  const trimTo = await driver.timelinePoint(5 * second, 0, 2)
  await driver.drag({ x: imageEnd.x - 2, y: imageEnd.y }, trimTo)
  await driver.untilUndoLabel('Undo Trim Clip')
  const movedAndTrimmed = await driver.savedProject('moved.json')

  const ruler = await driver.rect('timeline')
  const oneSecond = await driver.timelinePoint(second, 0, 2)
  await driver.clickAt({ x: oneSecond.x, y: ruler.y + RULER_HEIGHT / 2 })
  await driver.until(`${selector('timecode')}.textContent === '00:00:01:00'`, 'the playhead at one second')
  await driver.clickAt(await driver.timelinePoint(second / 2, 0, 2))
  await driver.page.click('split')
  await driver.untilUndoLabel('Undo Split Clip')
  const split = await driver.savedProject('split.json')

  driver.menu('undo')
  await driver.untilUndoLabel('Undo Trim Clip')
  const redoLabel = driver.menuLabel('redo')
  const afterUndo = await driver.savedProject('undone.json')
  driver.menu('redo')
  await driver.untilUndoLabel('Undo Split Clip')

  await driver.clickAt(await driver.timelinePoint(second / 2, 0, 2))
  driver.window.webContents.copy()
  await sleep(POLL_INTERVAL_MS)
  driver.window.webContents.paste()
  await driver.untilUndoLabel('Undo Paste Clip')
  const pasted = await driver.savedProject('pasted.json')

  await driver.press('Backspace')
  await driver.untilUndoLabel('Undo Delete Clip')
  // The paste landed on occupied space, so it made a third track; that track stays when its clip is deleted.
  await driver.clickAt(await driver.timelinePoint(second / 2, 0, 3))
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
  await driver.typeInto('clip-fadeIn', '0.5')
  await driver.untilUndoLabel('Undo Change Fade')
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

// New, Open and Save with every answer to "save your changes?".
async function testDocuments(driver: Driver): Promise<UiTestReport> {
  const { answers, outputDirectory } = driver.options
  if (outputDirectory === undefined) throw new PageError('This UI test needs --out <directory>')
  const firstPath = join(outputDirectory, 'first.json')
  const start = documentShown(driver)

  await driver.typeInto('canvas-width', '1280')
  await untilEdited(driver, true)
  answers.unsavedChanges = 'cancel'
  driver.menu('new')
  await sleep(10 * POLL_INTERVAL_MS)
  const afterCancel = { ...documentShown(driver), width: await driver.value('canvas-width') }

  answers.unsavedChanges = 'save'
  answers.saveProject = firstPath
  driver.menu('new')
  await untilWidth(driver, '1920')
  const afterSaveAndNew = { ...documentShown(driver), wasSaved: existsSync(firstPath) }

  answers.openProject = firstPath
  driver.menu('open-project')
  await untilWidth(driver, '1280')
  const afterOpen = documentShown(driver)

  await driver.typeInto('canvas-width', '1000')
  await untilEdited(driver, true)
  answers.unsavedChanges = 'discard'
  driver.menu('new')
  await untilWidth(driver, '1920')
  const savedAfterDiscard: unknown = JSON.parse(await readFile(firstPath, 'utf8'))

  await driver.typeInto('canvas-width', '800')
  await untilEdited(driver, true)
  answers.saveProject = join(outputDirectory, 'second.json')
  driver.menu('save')
  await untilEdited(driver, false)
  const afterSave = documentShown(driver)
  const recoveryFiles = existsSync(recoveryDirectory()) ? (await readdir(recoveryDirectory())).filter((name) => name.endsWith('.json')) : []

  // Closing the window with unsaved changes asks too; Cancel keeps the window and the work.
  await driver.typeInto('canvas-width', '700')
  await untilEdited(driver, true)
  answers.unsavedChanges = 'cancel'
  driver.window.close()
  await sleep(10 * POLL_INTERVAL_MS)
  const afterCancelledClose = { isOpen: !driver.window.isDestroyed(), width: await driver.value('canvas-width') }
  return { start, afterCancel, afterSaveAndNew, afterOpen, savedAfterDiscard, afterSave, recoveryFiles, afterCancelledClose }
}

function recoveryDirectory(): string {
  return join(app.getPath('userData'), 'recovery')
}

// Makes an edit, waits for the autosave and then dies the hard way, as a crash or a power cut would.
async function testCrash(driver: Driver): Promise<UiTestReport> {
  await driver.typeInto('canvas-width', '1280')
  await untilEdited(driver, true)
  const deadline = Date.now() + AUTOSAVE_TIMEOUT_MS
  for (;;) {
    const files = existsSync(recoveryDirectory()) ? await readdir(recoveryDirectory()) : []
    if (files.some((name) => name.endsWith('.json'))) break
    if (Date.now() > deadline) throw new PageError('Timed out waiting for the autosave')
    await sleep(POLL_INTERVAL_MS)
  }
  process.kill(process.pid, 'SIGKILL')
  return {}
}

async function testRestore(driver: Driver): Promise<UiTestReport> {
  await untilWidth(driver, '1280')
  await untilEdited(driver, true)
  return { ...documentShown(driver), width: await driver.value('canvas-width'), saved: await driver.savedProject('restored.json') }
}

// Measures the §3 budgets on whatever project is open; the test opens a 20-hour project with 4,096 clips.
async function testBudgets(driver: Driver): Promise<UiTestReport> {
  await driver.until(`Number(${selector('timecode')}?.dataset.frames ?? 0) > 0 && ${selector('timeline')}?.dataset.view !== undefined`, 'the project to be shown')
  const openSeconds = process.uptime()
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
  const overlay = await driver.rect('canvas-overlay')
  const grab = { x: overlay.x + overlay.width * 0.3, y: overlay.y + overlay.height * 0.3 }
  await driver.clickAt(grab)
  for (let pass = 0; pass < 4; pass++) await driver.drag(grab, { x: grab.x + 120, y: grab.y + 60 })
  await driver.untilUndoLabel('Undo Move Clip')
  const dragDelays = numbersIn(await driver.page.evaluate('window.dragDelays'))

  // Time from Undo to the frame that shows the project as it was.
  const undoDelay = driver.page.evaluate(`new Promise((resolve) => {
    const startedAt = performance.now()
    new MutationObserver((_changes, observer) => {
      observer.disconnect()
      resolve(performance.now() - startedAt)
    }).observe(${selector('timecode')}, { attributes: true, attributeFilter: ['data-frames'] })
  })`)
  driver.menu('undo')
  const undoMilliseconds = await undoDelay

  return {
    openSeconds,
    frameCount: frameIntervals.length,
    frameIntervalP95: percentile(frameIntervals, P95),
    dragSamples: dragDelays.length,
    dragToFrameP95: percentile(dragDelays, P95),
    undoMilliseconds,
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
  restore: testRestore,
  budgets: testBudgets,
  'open-and-save': testOpenAndSave,
  ...FEATURE_SCENARIOS,
}

export async function runUiTest(window: BrowserWindow, options: UiTestOptions): Promise<UiTestReport> {
  const scenario = SCENARIOS[options.scenario]
  if (scenario === undefined) throw new PageError(`There is no UI test "${options.scenario}"; use one of ${Object.keys(SCENARIOS).join(', ')}`)
  // The test window is shown without taking focus from whoever runs the tests; the page must still behave as a focused one.
  window.webContents.debugger.attach()
  await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
  const driver = driverOf(window, options)
  await driver.until(`${selector('editor')} !== null`, 'the editor to appear')
  try {
    return await scenario(driver)
  } finally {
    // A picture of the window as the test left it: the first thing to look at when a UI test fails.
    await driver.picture(options.scenario)
  }
}
