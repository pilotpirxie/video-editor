import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { BrowserWindow, Menu } from 'electron'
import type { MenuAction, UnsavedChoice } from '../shared/mediaProtocol.js'
import { TICKS_PER_SECOND } from '../shared/time.js'
import { PageError, pageOf, selector, type Page } from './page.js'

export const STEP_TIMEOUT_MS = 30_000
export const POLL_INTERVAL_MS = 50
const DRAG_STEPS = 8
const INPUT_SETTLE_MS = 30
const WHEEL_INTERVAL_MS = 8
export const P95 = 0.95
export const RULER_HEIGHT = 24
// The lane of the camera's zooms lies between the ruler and the first track.
export const CAMERA_LANE_HEIGHT = 22
export const TRACK_HEIGHT = 56

// Answers the tests give in place of the dialogs a person would see.
export type DialogAnswers = {
  openProject?: string
  saveProject?: string
  importMedia?: string[]
  relinkMedia?: string
  exportPath?: string
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

export type Scenario = (driver: Driver) => Promise<UiTestReport>

export type Point = {
  x: number
  y: number
}

type Rect = Point & {
  width: number
  height: number
}

type Modifier = 'shift' | 'meta' | 'control' | 'alt'

export type Driver = {
  page: Page
  window: BrowserWindow
  options: UiTestOptions
  until(script: string, what: string, timeoutMs?: number): Promise<void>
  untilUndoLabel(label: string): Promise<void>
  untilRedoLabel(label: string): Promise<void>
  // Waits for a menu item to show these keys, as an Electron accelerator.
  untilMenuKeys(action: MenuAction, accelerator: string): Promise<void>
  rect(testId: string): Promise<Rect>
  hover(point: Point): Promise<void>
  drag(from: Point, to: Point, modifiers?: readonly Modifier[]): Promise<void>
  // The three parts of a drag, for looking at the window while the button is still held.
  holdAt(point: Point): void
  dragOn(from: Point, to: Point, modifiers?: readonly Modifier[]): Promise<void>
  releaseAt(point: Point): Promise<void>
  clickAt(point: Point, modifiers?: readonly Modifier[]): Promise<void>
  doubleClickAt(point: Point): Promise<void>
  rightClickAt(point: Point): Promise<void>
  scrollAt(point: Point, deltaX: number, deltaY: number, isPinch: boolean): Promise<void>
  press(keyCode: string, modifiers?: readonly Modifier[]): Promise<void>
  typeInto(testId: string, text: string): Promise<void>
  // Types into whatever has the focus, one key at a time, as a person would.
  typeKeys(text: string): Promise<void>
  value(testId: string): Promise<string>
  menu(action: MenuAction): void
  menuLabel(action: MenuAction): string
  timelinePoint(time: number, trackIndex: number, trackCount: number): Promise<Point>
  savedProject(name: string): Promise<unknown>
  // Saves a picture of the window in the output folder, when the test was given one.
  picture(name: string): Promise<void>
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

export function centerOf(rect: Rect): Point {
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

  async function until(script: string, what: string, timeoutMs = STEP_TIMEOUT_MS): Promise<void> {
    const deadline = Date.now() + timeoutMs
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

  async function hover(point: Point): Promise<void> {
    window.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(point.x), y: Math.round(point.y) })
    await sleep(INPUT_SETTLE_MS)
  }

  async function dragOn(from: Point, to: Point, modifiers: readonly Modifier[] = []): Promise<void> {
    for (let step = 1; step <= DRAG_STEPS; step++) {
      const progress = step / DRAG_STEPS
      mouse('mouseMove', { x: from.x + (to.x - from.x) * progress, y: from.y + (to.y - from.y) * progress }, modifiers)
      await sleep(INPUT_SETTLE_MS)
    }
  }

  async function releaseAt(point: Point, modifiers: readonly Modifier[] = []): Promise<void> {
    mouse('mouseUp', point, modifiers)
    await sleep(INPUT_SETTLE_MS)
  }

  async function drag(from: Point, to: Point, modifiers: readonly Modifier[] = []): Promise<void> {
    mouse('mouseDown', from, modifiers)
    await dragOn(from, to, modifiers)
    await releaseAt(to, modifiers)
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
    // A focused button is pressed by the character the Return key types, not by the key going down.
    if (keyCode === 'Return' && modifiers.length === 0) window.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
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

  async function typeKeys(text: string): Promise<void> {
    for (const character of text) {
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: character })
      window.webContents.sendInputEvent({ type: 'char', keyCode: character })
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode: character })
      await sleep(INPUT_SETTLE_MS)
    }
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

  // Chosen with this window in front, as a person would choose it.
  function clickMenu(action: MenuAction): void {
    menuItem(action).click(undefined, window, window.webContents)
  }

  // Waits for the menu item of `action` to show `expected`, as read by `shown`: its label or its keys.
  async function untilMenuShows(action: MenuAction, expected: string, shown: (item: Electron.MenuItem) => string): Promise<void> {
    const deadline = Date.now() + STEP_TIMEOUT_MS
    while (shown(menuItem(action)) !== expected) {
      if (Date.now() > deadline) throw new PageError(`Timed out waiting for the menu to show "${expected}" for ${action}; it shows "${shown(menuItem(action))}"`)
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
      y: box.y + RULER_HEIGHT + CAMERA_LANE_HEIGHT + (trackCount - 1 - trackIndex) * TRACK_HEIGHT - view.scrollY + TRACK_HEIGHT / 2,
    }
  }

  async function savedProject(name: string): Promise<unknown> {
    if (options.outputDirectory === undefined) throw new PageError('This UI test needs --out <directory>')
    const path = join(options.outputDirectory, name)
    await rm(path, { force: true })
    options.answers.saveProject = path
    clickMenu('save-as')
    const deadline = Date.now() + STEP_TIMEOUT_MS
    while (!existsSync(path) || window.isDocumentEdited()) {
      if (Date.now() > deadline) throw new PageError(`Timed out waiting for ${name} to be saved`)
      await sleep(POLL_INTERVAL_MS)
    }
    return JSON.parse(await readFile(path, 'utf8'))
  }

  async function picture(name: string): Promise<void> {
    // A test may close the window it started with.
    if (options.outputDirectory === undefined || window.isDestroyed()) return
    const captured = await window.webContents.capturePage()
    await mkdir(options.outputDirectory, { recursive: true })
    await writeFile(join(options.outputDirectory, `${name}.png`), captured.toPNG())
  }

  return {
    page,
    window,
    options,
    until,
    untilUndoLabel: (label) => untilMenuShows('undo', label, (item) => item.label),
    untilRedoLabel: (label) => untilMenuShows('redo', label, (item) => item.label),
    untilMenuKeys: (action, accelerator) => untilMenuShows(action, accelerator, (item) => item.accelerator ?? ''),
    rect,
    hover,
    drag,
    holdAt: (point) => mouse('mouseDown', point, []),
    dragOn,
    releaseAt,
    clickAt,
    doubleClickAt,
    rightClickAt,
    scrollAt,
    press,
    typeInto,
    typeKeys,
    value,
    menu: clickMenu,
    menuLabel: (action) => menuItem(action).label,
    timelinePoint,
    savedProject,
    picture,
  }
}

// The test window is shown without taking focus from whoever runs the tests; the page must still behave as a focused one.
export async function attachedDriver(window: BrowserWindow, options: UiTestOptions): Promise<Driver> {
  window.webContents.debugger.attach()
  await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
  const driver = driverOf(window, options)
  await driver.until(`${selector('editor')} !== null`, 'the editor to appear')
  return driver
}

export function editorWindows(): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed() && window.webContents.getURL().includes('mode=editor'))
}

export async function untilWindowCount(count: number): Promise<void> {
  const deadline = Date.now() + STEP_TIMEOUT_MS
  while (editorWindows().length !== count) {
    if (Date.now() > deadline) throw new PageError(`Timed out waiting for ${count} editor windows; there are ${editorWindows().length}`)
    await sleep(POLL_INTERVAL_MS)
  }
}

// Drives the editor window that opened after `known`, set up as the first one is.
export async function driverOfNewWindow(driver: Driver, known: readonly BrowserWindow[]): Promise<Driver> {
  const deadline = Date.now() + STEP_TIMEOUT_MS
  let found = editorWindows().find((window) => !known.includes(window))
  while (found === undefined) {
    if (Date.now() > deadline) throw new PageError('Timed out waiting for a new editor window')
    await sleep(POLL_INTERVAL_MS)
    found = editorWindows().find((window) => !known.includes(window))
  }
  return attachedDriver(found, driver.options)
}

export async function fullQualityFrame(driver: Driver, sinceFrames: number): Promise<void> {
  const shown = `(() => {
    const timecode = ${selector('timecode')}
    return Number(timecode?.dataset.frames ?? 0) > ${sinceFrames} && timecode?.dataset.fullQuality === 'true'
  })()`
  await driver.until(shown, 'a full-quality frame')
}

export function mediaFile(driver: Driver, name: string): string {
  if (driver.options.mediaDirectory === undefined) throw new PageError('This UI test needs --media <directory>')
  return join(driver.options.mediaDirectory, name)
}

export async function dragMedia(driver: Driver, name: string, to: Point): Promise<void> {
  await driver.drag(centerOf(await driver.rect(`media-${name}`)), to)
}

// Where a point of the project canvas is on screen.
export async function canvasPoint(driver: Driver, canvasWidth: number, point: Point): Promise<Point> {
  const picture = await driver.rect('preview')
  const pixelsPerUnit = picture.width / canvasWidth
  return { x: picture.x + point.x * pixelsPerUnit, y: picture.y + point.y * pixelsPerUnit }
}

export function percentile(values: readonly number[], fraction: number): number {
  const inOrder = [...values].sort((a, b) => a - b)
  return inOrder[Math.min(inOrder.length - 1, Math.floor(inOrder.length * fraction))] ?? Number.NaN
}

export function numbersIn(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((entry): entry is number => typeof entry === 'number') : []
}
