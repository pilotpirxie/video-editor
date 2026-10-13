import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { Menu, app, type BrowserWindow } from 'electron'
import type { MenuAction, UnsavedChoice } from '../shared/mediaProtocol.js'
import { TICKS_PER_SECOND } from '../shared/time.js'
import { PageError, pageOf, selector, type Page } from './page.js'

const STEP_TIMEOUT_MS = 30_000
const POLL_INTERVAL_MS = 50
const DRAG_STEPS = 8
const INPUT_SETTLE_MS = 30
const WHEEL_INTERVAL_MS = 8
const AUTOSAVE_TIMEOUT_MS = 20_000
const P95 = 0.95
const RULER_HEIGHT = 24
const TRACK_HEIGHT = 56

// Answers the tests give in place of the dialogs a person would see.
export type DialogAnswers = {
  openProject?: string
  saveProject?: string
  importMedia?: string[]
  unsavedChanges?: UnsavedChoice
  restore?: boolean
}

export type UiTestOptions = {
  scenario: string
  outputDirectory: string | undefined
  mediaDirectory: string | undefined
  answers: DialogAnswers
}

export type UiTestReport = Record<string, unknown>

type Point = {
  x: number
  y: number
}

type Rect = Point & {
  width: number
  height: number
}

type Modifier = 'shift' | 'meta'

type Driver = {
  page: Page
  window: BrowserWindow
  options: UiTestOptions
  until(script: string, what: string): Promise<void>
  untilUndoLabel(label: string): Promise<void>
  rect(testId: string): Promise<Rect>
  drag(from: Point, to: Point, modifiers?: readonly Modifier[]): Promise<void>
  clickAt(point: Point, modifiers?: readonly Modifier[]): Promise<void>
  doubleClickAt(point: Point): Promise<void>
  rightClickAt(point: Point): Promise<void>
  scrollAt(point: Point, deltaX: number, deltaY: number, isPinch: boolean): Promise<void>
  press(keyCode: string, modifiers?: readonly Modifier[]): Promise<void>
  typeInto(testId: string, text: string): Promise<void>
  value(testId: string): Promise<string>
  menu(action: MenuAction): void
  menuLabel(action: MenuAction): string
  timelinePoint(time: number, trackIndex: number, trackCount: number): Promise<Point>
  savedProject(name: string): Promise<unknown>
}

type TimelineView = {
  pixelsPerSecond: number
  scrollX: number
  scrollY: number
}

function isTimelineView(value: unknown): value is TimelineView {
  if (typeof value !== 'object' || value === null) return false
  if (!('pixelsPerSecond' in value) || !('scrollX' in value) || !('scrollY' in value)) return false
  return typeof value.pixelsPerSecond === 'number' && typeof value.scrollX === 'number' && typeof value.scrollY === 'number'
}

function isRect(value: unknown): value is Rect {
  if (typeof value !== 'object' || value === null) return false
  if (!('x' in value) || !('y' in value) || !('width' in value) || !('height' in value)) return false
  return typeof value.x === 'number' && typeof value.y === 'number' && typeof value.width === 'number' && typeof value.height === 'number'
}

function centerOf(rect: Rect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
}

function driverOf(window: BrowserWindow, options: UiTestOptions): Driver {
  const page = pageOf(window)

  // The page reloads when a document is replaced; a check that lands in the middle of that simply counts as "not yet".
  async function holds(script: string): Promise<boolean> {
    try {
      return (await page.evaluate(script)) === true
    } catch (error) {
      if (error instanceof Error) return false
      throw error
    }
  }

  async function until(script: string, what: string): Promise<void> {
    const deadline = Date.now() + STEP_TIMEOUT_MS
    while (!(await holds(script))) {
      if (Date.now() > deadline) throw new PageError(`Timed out waiting for ${what}`)
      await sleep(POLL_INTERVAL_MS)
    }
  }

  async function rect(testId: string): Promise<Rect> {
    const found = await page.evaluate(`(() => {
      const box = ${selector(testId)}?.getBoundingClientRect()
      return box === undefined ? undefined : { x: box.x, y: box.y, width: box.width, height: box.height }
    })()`)
    if (!isRect(found)) throw new PageError(`There is no "${testId}" on the page`)
    return found
  }

  function mouse(type: 'mouseDown' | 'mouseMove' | 'mouseUp', point: Point, modifiers: readonly Modifier[]): void {
    const x = Math.round(point.x)
    const y = Math.round(point.y)
    if (type === 'mouseMove') {
      window.webContents.sendInputEvent({ type, x, y, button: 'left', modifiers: ['leftbuttondown', ...modifiers] })
    } else {
      window.webContents.sendInputEvent({ type, x, y, button: 'left', clickCount: 1, modifiers: [...modifiers] })
    }
  }

  async function drag(from: Point, to: Point, modifiers: readonly Modifier[] = []): Promise<void> {
    mouse('mouseDown', from, modifiers)
    for (let step = 1; step <= DRAG_STEPS; step++) {
      const progress = step / DRAG_STEPS
      mouse('mouseMove', { x: from.x + (to.x - from.x) * progress, y: from.y + (to.y - from.y) * progress }, modifiers)
      await sleep(INPUT_SETTLE_MS)
    }
    mouse('mouseUp', to, modifiers)
    await sleep(INPUT_SETTLE_MS)
  }

  async function clickAt(point: Point, modifiers: readonly Modifier[] = []): Promise<void> {
    mouse('mouseDown', point, modifiers)
    mouse('mouseUp', point, modifiers)
    await sleep(INPUT_SETTLE_MS)
  }

  async function doubleClickAt(point: Point): Promise<void> {
    await clickAt(point)
    const x = Math.round(point.x)
    const y = Math.round(point.y)
    window.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 2 })
    window.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 2 })
    await sleep(INPUT_SETTLE_MS)
  }

  async function rightClickAt(point: Point): Promise<void> {
    const x = Math.round(point.x)
    const y = Math.round(point.y)
    window.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'right', clickCount: 1 })
    window.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'right', clickCount: 1 })
    await sleep(INPUT_SETTLE_MS)
  }

  async function scrollAt(point: Point, deltaX: number, deltaY: number, isPinch: boolean): Promise<void> {
    const modifiers: ('control')[] = isPinch ? ['control'] : []
    window.webContents.sendInputEvent({ type: 'mouseWheel', x: Math.round(point.x), y: Math.round(point.y), deltaX, deltaY, canScroll: true, modifiers })
    await sleep(WHEEL_INTERVAL_MS)
  }

  async function press(keyCode: string, modifiers: readonly Modifier[] = []): Promise<void> {
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers: [...modifiers] })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers: [...modifiers] })
    await sleep(INPUT_SETTLE_MS)
  }

  async function typeInto(testId: string, text: string): Promise<void> {
    await page.evaluate(`(() => {
      const field = ${selector(testId)}
      field.focus()
      field.select()
    })()`)
    await window.webContents.insertText(text)
    await press('Enter')
  }

  async function value(testId: string): Promise<string> {
    const content = await page.evaluate(`${selector(testId)}?.value ?? ''`)
    return typeof content === 'string' ? content : ''
  }

  function menuItem(action: MenuAction): Electron.MenuItem {
    const item = Menu.getApplicationMenu()?.getMenuItemById(action)
    if (item === null || item === undefined) throw new PageError(`The menu has no "${action}" item`)
    return item
  }

  async function untilUndoLabel(label: string): Promise<void> {
    const deadline = Date.now() + STEP_TIMEOUT_MS
    while (menuItem('undo').label !== label) {
      if (Date.now() > deadline) throw new PageError(`Timed out waiting for the Edit menu to offer "${label}"; it offers "${menuItem('undo').label}"`)
      await sleep(POLL_INTERVAL_MS)
    }
  }

  // Where a moment on a track is on screen. Track 0 is the bottom layer, shown in the bottom row.
  async function timelinePoint(time: number, trackIndex: number, trackCount: number): Promise<Point> {
    const box = await rect('timeline')
    const view: unknown = JSON.parse(String(await page.evaluate(`${selector('timeline')}.dataset.view`)))
    if (!isTimelineView(view)) throw new PageError('The timeline does not report its view')
    return {
      x: box.x + (time / TICKS_PER_SECOND) * view.pixelsPerSecond - view.scrollX,
      y: box.y + RULER_HEIGHT + (trackCount - 1 - trackIndex) * TRACK_HEIGHT - view.scrollY + TRACK_HEIGHT / 2,
    }
  }

  async function savedProject(name: string): Promise<unknown> {
    if (options.outputDirectory === undefined) throw new PageError('This UI test needs --out <directory>')
    const path = join(options.outputDirectory, name)
    await rm(path, { force: true })
    options.answers.saveProject = path
    menuItem('save-as').click()
    const deadline = Date.now() + STEP_TIMEOUT_MS
    while (!existsSync(path) || window.isDocumentEdited()) {
      if (Date.now() > deadline) throw new PageError(`Timed out waiting for ${name} to be saved`)
      await sleep(POLL_INTERVAL_MS)
    }
    return JSON.parse(await readFile(path, 'utf8'))
  }

  return {
    page,
    window,
    options,
    until,
    untilUndoLabel,
    rect,
    drag,
    clickAt,
    doubleClickAt,
    rightClickAt,
    scrollAt,
    press,
    typeInto,
    value,
    menu: (action) => menuItem(action).click(),
    menuLabel: (action) => menuItem(action).label,
    timelinePoint,
    savedProject,
  }
}

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

// A picture of the window as the test left it: the first thing to look at when a UI test fails.
async function savePicture(window: BrowserWindow, directory: string, name: string): Promise<void> {
  const picture = await window.webContents.capturePage()
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, `${name}.png`), picture.toPNG())
}

async function fullQualityFrame(driver: Driver, sinceFrames: number): Promise<void> {
  const shown = `(() => {
    const timecode = ${selector('timecode')}
    return Number(timecode?.dataset.frames ?? 0) > ${sinceFrames} && timecode?.dataset.fullQuality === 'true'
  })()`
  await driver.until(shown, 'a full-quality frame')
}

async function testOpen(driver: Driver): Promise<UiTestReport> {
  await fullQualityFrame(driver, 0)
  return { canvasWidth: await driver.value('canvas-width'), timecode: await driver.page.text('timecode') }
}

function mediaFile(driver: Driver, name: string): string {
  if (driver.options.mediaDirectory === undefined) throw new PageError('This UI test needs --media <directory>')
  return join(driver.options.mediaDirectory, name)
}

async function dragMedia(driver: Driver, name: string, to: Point): Promise<void> {
  await driver.drag(centerOf(await driver.rect(`media-${name}`)), to)
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

// Where a point of the project canvas is on screen.
async function canvasPoint(driver: Driver, canvasWidth: number, point: Point): Promise<Point> {
  const picture = await driver.rect('preview')
  const pixelsPerUnit = picture.width / canvasWidth
  return { x: picture.x + point.x * pixelsPerUnit, y: picture.y + point.y * pixelsPerUnit }
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

function percentile(values: readonly number[], fraction: number): number {
  const inOrder = [...values].sort((a, b) => a - b)
  return inOrder[Math.min(inOrder.length - 1, Math.floor(inOrder.length * fraction))] ?? Number.NaN
}

function numbersIn(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((entry): entry is number => typeof entry === 'number') : []
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

const SCENARIOS: Record<string, (driver: Driver) => Promise<UiTestReport>> = {
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
    if (options.outputDirectory !== undefined) await savePicture(window, options.outputDirectory, options.scenario)
  }
}
