import { app } from 'electron'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { describeError } from '../shared/log.js'
import { TICKS_PER_SECOND } from '../shared/time.js'
import { cpuSecondsOf, footprintNow } from './memory.js'
import { PageError, selector } from './page.js'
import {
  CAMERA_LANE_HEIGHT,
  P95,
  POLL_INTERVAL_MS,
  RULER_HEIGHT,
  TRACK_HEIGHT,
  canvasPoint,
  centerOf,
  delayUntilShown,
  dragMedia,
  watchLongTasks,
  driverOfNewWindow,
  editorWindows,
  fullQualityFrame,
  mediaFile,
  numbersIn,
  percentile,
  type Driver,
  type Point,
  TIMECODE_CHANGES,
  type Scenario,
  type Shown,
  type UiTestReport,
} from './uiDriver.js'

const SHUTTLE_WATCH_MS = 400
const STEPS_TO_TIME = 20
const PICTURES_SETTLE_MS = 1500
const HANDLE_INSET = 7
const CLEAR_OF_VOLUME_LINE = 10
// A short pinch outwards, which the page sees as a wheel delta of -20: the zoom grows by e^0.2, about a fifth. Electron's wheel input counts the other way.
const PINCH_DELTA = 20
const HANDLE_FROM_ROW_MIDDLE = 19
const DIAMOND_FROM_ROW_MIDDLE = 1
const NEAR_SNAP_PIXELS = 7
const DIALOG_TAB_STOPS = 14
const CANCEL_SETTLE_MS = 1500
const LONG_EXPORT_TIMEOUT_MS = 30 * 60 * 1000
const MS_PER_SECOND = 1000
const FRAMES_PER_SECOND = 30
const JUMP_FRAMES = 15
const CUT_SECONDS = 10
const TALLER_TIMELINE = 170
const FONT_LIST_TURNS = 5
const HELD_PASSES = 4
const HELD_FRAMES = 240
const SECONDS_PER_HOUR = 3600

async function watchDelays(driver: Driver, eventType: string, shown: Shown): Promise<{ read(): Promise<number[]> }> {
  const store = `delays_${eventType}`
  await driver.page.evaluate(`(() => {
    window.${store} = []
    let startedAt
    addEventListener('${eventType}', () => { startedAt ??= performance.now() }, true)
    new MutationObserver(() => {
      if (startedAt === undefined) return
      window.${store}.push(performance.now() - startedAt)
      startedAt = undefined
    }).observe(${selector('timecode')}, ${TIMECODE_CHANGES[shown]})
  })()`)
  return { read: async () => numbersIn(await driver.page.evaluate(`window.${store}`)) }
}

export async function untilPrepared(driver: Driver): Promise<void> {
  await driver.until(`document.querySelector('.library-item[data-testid^="media-"]') !== null && document.querySelector('.library-item .badge.warning') === null`, 'the media to be prepared')
}

async function untilTimecode(driver: Driver, timecode: string): Promise<void> {
  await driver.until(`${selector('timecode')}.textContent === '${timecode}'`, `the playhead at ${timecode}`)
}

async function testTransport(driver: Driver): Promise<UiTestReport> {
  await fullQualityFrame(driver, 0)
  await untilPrepared(driver)
  const stepDelays = await watchDelays(driver, 'keydown', 'another timecode')
  for (let step = 0; step < 3; step++) await driver.press('.')
  await untilTimecode(driver, '00:00:00:03')
  await driver.press(',')
  await untilTimecode(driver, '00:00:00:02')
  await driver.press('Right')
  await untilTimecode(driver, '00:00:00:03')
  for (let step = 0; step < STEPS_TO_TIME; step++) {
    await driver.press('.')
    await sleep(POLL_INTERVAL_MS)
  }
  for (let step = 0; step < STEPS_TO_TIME; step++) {
    await driver.press(',')
    await sleep(POLL_INTERVAL_MS)
  }
  await untilTimecode(driver, '00:00:00:03')
  const steps = await stepDelays.read()
  const stepMilliseconds = percentile(steps, P95)

  await driver.press('Return', ['meta', 'shift'])
  await untilTimecode(driver, '00:00:01:29')
  await driver.press('Return', ['meta'])
  await untilTimecode(driver, '00:00:00:00')
  await driver.press('.', ['control'])
  await untilTimecode(driver, '00:00:01:29')
  await driver.press(',', ['control'])
  await untilTimecode(driver, '00:00:00:00')
  await driver.press('.', ['control', 'shift'])
  await untilTimecode(driver, '00:00:00:15')
  const duration = await driver.page.text('duration')

  await driver.press('L')
  await driver.until(`${selector('play')}.getAttribute('aria-label') === 'Pause'`, 'L to start playback')
  await driver.press('L')
  await driver.until(`${selector('shuttle-rate')}?.textContent === '2×'`, 'a second L to double the speed')
  await driver.press('K')
  await driver.until(`${selector('play')}.getAttribute('aria-label') === 'Play' && ${selector('shuttle-rate')} === null`, 'K to stop')
  const timecodeAfterForward = await driver.page.text('timecode')

  await driver.press('Return', ['meta', 'shift'])
  await untilTimecode(driver, '00:00:01:29')
  await driver.press('J')
  await driver.until(`${selector('shuttle-rate')}?.textContent === '−1×'`, 'J to play backwards')
  await sleep(SHUTTLE_WATCH_MS)
  const timecodeWhileReversing = await driver.page.text('timecode')
  await driver.press('J')
  await driver.until(`${selector('shuttle-rate')}?.textContent === '−2×'`, 'a second J to double the speed')
  await driver.until(`${selector('shuttle-rate')} === null`, 'the shuttle to stop at the start')
  await sleep(POLL_INTERVAL_MS)
  return { stepSamples: steps.length, stepMilliseconds, duration, timecodeAfterForward, timecodeWhileReversing, timecodeAtStart: await driver.page.text('timecode') }
}

async function testBlocks(driver: Driver): Promise<UiTestReport> {
  const second = TICKS_PER_SECOND
  await fullQualityFrame(driver, 0)
  const at = (time: number): Promise<Point> => driver.timelinePoint(time, 0, 1)
  const clipStart = await at(0)
  const clipEnd = await at(2 * second)
  const pictureHandle = { x: clipStart.x + HANDLE_INSET, y: clipStart.y - HANDLE_FROM_ROW_MIDDLE }
  const soundHandle = { x: clipEnd.x - HANDLE_INSET, y: clipEnd.y + HANDLE_FROM_ROW_MIDDLE }

  await driver.hover(pictureHandle)
  const cursorOverHandle = await driver.page.evaluate(`document.querySelector('[data-testid="timeline"] canvas:last-child').style.cursor`)
  const dragDelays = await watchDelays(driver, 'pointermove', 'any frame')
  const halfSecond = await at(second / 2)
  await driver.drag(pictureHandle, { x: halfSecond.x + HANDLE_INSET, y: pictureHandle.y })
  await driver.untilUndoLabel('Undo Change Fade')
  const delays = await dragDelays.read()

  const oneSecond = await at(second)
  await driver.drag(soundHandle, { x: oneSecond.x - HANDLE_INSET, y: soundHandle.y })
  const faded = await driver.savedProject('faded.json')
  await untilPrepared(driver)
  await driver.hover(await at(second))
  await sleep(PICTURES_SETTLE_MS)
  await driver.picture('blocks-linked')

  driver.menu('undo')
  await driver.untilRedoLabel('Redo Change Fade')
  const afterUndo = await driver.savedProject('one-fade.json')
  driver.menu('redo')
  await driver.untilRedoLabel('Redo')

  await driver.rightClickAt(await at(second))
  await driver.until(`${selector('menu-separate-audio')} !== null`, 'the clip menu')
  await driver.page.click('menu-separate-audio')
  await driver.untilUndoLabel('Undo Separate Video and Audio')
  const separated = await driver.savedProject('separated.json')

  await driver.rightClickAt(await driver.timelinePoint(second, 0, 2))
  await driver.until(`${selector('menu-separate-audio')} !== null`, 'the clip menu')
  const canSeparateAgain = (await driver.page.evaluate(`${selector('menu-separate-audio')}.disabled`)) === false
  return { cursorOverHandle, dragSamples: delays.length, dragToFrameP95: percentile(delays, P95), faded, afterUndo, separated, canSeparateAgain }
}

async function choose(driver: Driver, testId: string, value: string): Promise<void> {
  await driver.page.evaluate(`(() => {
    const control = ${selector(testId)}
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(control, ${JSON.stringify(value)})
    control.dispatchEvent(new Event('input', { bubbles: true }))
    control.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
}

function isListOpen(testId: string): string {
  return `${selector(`${testId}-options`)} !== null`
}

// A panel that scrolls to bring a control into view tells the page so with its next frame. A person could not press sooner, and a list that opened sooner would take the scroll for a reason to close.
const ONCE_THE_SCROLL_IS_HEARD = `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`

async function centerInView(driver: Driver, testId: string): Promise<Point> {
  await driver.page.evaluate(`(() => {
    ${selector(testId)}.scrollIntoView({ block: 'nearest' })
    return ${ONCE_THE_SCROLL_IS_HEARD}
  })()`)
  return centerOf(await driver.rect(testId))
}

async function clickOn(driver: Driver, testId: string): Promise<void> {
  await driver.clickAt(await centerInView(driver, testId))
}

async function openList(driver: Driver, pressed: string, testId: string): Promise<void> {
  await clickOn(driver, pressed)
  await driver.until(isListOpen(testId), `the list of ${testId} to open`)
}

async function optionPoint(driver: Driver, testId: string, value: string): Promise<Point> {
  const option = `${testId}-option-${value}`
  await driver.page.evaluate(`${selector(option)}.scrollIntoView({ block: 'nearest' })`)
  return centerOf(await driver.rect(option))
}

export async function pick(driver: Driver, testId: string, value: string): Promise<void> {
  await openList(driver, testId, testId)
  await driver.clickAt(await optionPoint(driver, testId, value))
  await driver.until(`!(${isListOpen(testId)})`, `the list of ${testId} to close`)
}

export async function untilTextEditor(driver: Driver, isOpen: boolean): Promise<void> {
  const state = isOpen ? 'document.activeElement?.dataset.testid === "text-editor"' : `${selector('text-editor')} === null`
  await driver.until(state, isOpen ? 'the text to open for typing' : 'the text to close')
}

async function testText(driver: Driver): Promise<UiTestReport> {
  const canvasWidth = 1920
  const middle = await canvasPoint(driver, canvasWidth, { x: 960, y: 540 })
  const corner = await canvasPoint(driver, canvasWidth, { x: 60, y: 60 })

  await driver.page.click('tab-annotations')
  await driver.page.click('annotation-text')
  await untilTextEditor(driver, true)
  const framesBeforeTyping = Number(await driver.page.evaluate(`${selector('timecode')}.dataset.frames`))
  const typingDelays = await watchDelays(driver, 'input', 'any frame')
  await driver.typeKeys('Hello')
  await driver.until(`${selector('text-words')}?.value === 'Hello'`, 'the typed words in the properties panel')
  await fullQualityFrame(driver, framesBeforeTyping)
  const delays = await typingDelays.read()
  await driver.page.evaluate(`${selector('text-editor')}.select()`)
  await driver.picture('text-typing')
  await driver.press('Escape')
  await untilTextEditor(driver, false)
  await driver.untilUndoLabel('Undo Edit Text')
  const typed = await driver.savedProject('typed.json')

  await driver.doubleClickAt(middle)
  await untilTextEditor(driver, true)
  await driver.window.webContents.insertText('Two\nlines')
  await driver.clickAt(corner)
  await untilTextEditor(driver, false)

  await driver.clickAt(middle)
  await driver.until(`${selector('text-size')} !== null`, 'the text properties')

  const fontOptions = `document.querySelectorAll('[data-testid="text-font-options"] [role="option"]').length`
  await openList(driver, 'text-font', 'text-font')
  await driver.until(`${fontOptions} > 20`, 'the installed fonts to be listed')
  const fontCount = await driver.page.evaluate(fontOptions)
  const fontDelays = await watchDelays(driver, 'pointermove', 'any frame')
  for (const family of ['Menlo', 'Georgia', 'Courier New', 'Menlo', 'Georgia']) {
    await driver.hover(await optionPoint(driver, 'text-font', family))
    await driver.until(`${selector('text-font')}.value === '${family}'`, `${family} to be shown while pointed at`)
    await fullQualityFrame(driver, 0)
  }
  const fontHoverDelays = await fontDelays.read()
  await driver.press('Escape')
  await driver.until(`!(${isListOpen('text-font')})`, 'Escape to close the font list')
  const fontAfterEscape = await driver.value('text-font')
  const focusAfterEscape = await driver.page.evaluate(`document.activeElement?.dataset.testid`)
  const undoLabelAfterEscape = driver.menuLabel('undo')

  await driver.press('Down')
  await driver.until(isListOpen('text-font'), 'the font list to open from the keyboard')
  await driver.typeKeys('menlo')
  await driver.until(`${selector('text-font')}.value === 'Menlo'`, 'the typed font to be found')
  await driver.press('Return')
  await driver.untilUndoLabel('Undo Change Font')

  await openList(driver, 'text-size-presets', 'text-size')
  await driver.hover(await optionPoint(driver, 'text-size', '200'))
  await driver.until(`${selector('text-size')}.value === '200'`, 'the size pointed at to be shown')
  await driver.clickAt(await optionPoint(driver, 'text-size', '144'))
  await driver.untilUndoLabel('Undo Change Text Size')
  const sizeFromList = await driver.value('text-size')

  await driver.typeInto('text-size', '120')
  await choose(driver, 'text-color', '#ffcc00')
  await driver.page.click('text-align-left')
  await driver.untilUndoLabel('Undo Change Alignment')
  const styled = await driver.savedProject('styled.json')

  await driver.doubleClickAt(middle)
  await untilTextEditor(driver, true)
  await driver.press('Backspace')
  await driver.until(`${selector('text-words')}?.value === ''`, 'the words to be deleted')
  await driver.press('Escape')
  await untilTextEditor(driver, false)
  const wordsAfterEmptying = await driver.value('text-words')
  return {
    typingSamples: delays.length,
    typingToFrameP95: percentile(delays, P95),
    typed,
    fontCount,
    fontHoverSamples: fontHoverDelays.length,
    fontHoverToFrameP95: percentile(fontHoverDelays, P95),
    fontAfterEscape,
    focusAfterEscape,
    undoLabelAfterEscape,
    sizeFromList,
    styled,
    wordsAfterEmptying,
    undoLabel: driver.menuLabel('undo'),
  }
}

async function testAnimated(driver: Driver): Promise<UiTestReport> {
  const second = TICKS_PER_SECOND
  driver.options.answers.importMedia = [mediaFile(driver, 'animated.gif')]
  driver.menu('import')
  await driver.until(`${selector('media-animated.gif')} !== null`, 'the animated image in the Media tab')

  await dragMedia(driver, 'animated.gif', await driver.timelinePoint(0, 0, 6))
  await driver.untilUndoLabel('Undo Add Clip')
  const placed = await driver.savedProject('placed.json')

  const end = await driver.timelinePoint(5 * second, 0, 6)
  const later = await driver.timelinePoint(8 * second, 0, 6)
  await driver.drag({ x: end.x - 2, y: end.y }, later)
  await driver.untilUndoLabel('Undo Trim Clip')
  const stretched = await driver.savedProject('stretched.json')

  await driver.page.click('clip-loop')
  await driver.untilUndoLabel('Undo Stop Looping')
  const once = await driver.savedProject('once.json')
  driver.menu('undo')
  await driver.untilUndoLabel('Undo Trim Clip')
  await untilPrepared(driver)
  await sleep(PICTURES_SETTLE_MS)
  return { placed, stretched, once, isLoopingAfterUndo: await driver.page.evaluate(`${selector('clip-loop')}.checked`) }
}

async function testRelink(driver: Driver): Promise<UiTestReport> {
  const missingBadgeCount = `document.querySelectorAll('.library-item .badge.danger').length`
  await driver.until(`${selector('notice')} !== null`, 'the notice about missing media')
  const openNotice = await driver.page.text('notice')
  const missingAtOpen = await driver.page.evaluate(missingBadgeCount)

  driver.options.answers.relinkMedia = mediaFile(driver, 'audio.wav')
  await driver.page.click('relink-h264.mp4')
  await driver.until(`${selector('notice')}.textContent !== ${JSON.stringify(openNotice)}`, 'a file of the wrong kind to be refused')
  const refusal = await driver.page.text('notice')
  const missingAfterRefusal = await driver.page.evaluate(missingBadgeCount)

  driver.options.answers.relinkMedia = mediaFile(driver, 'h264.mp4')
  await driver.page.click('relink-h264.mp4')
  await driver.until(`${missingBadgeCount} === 0`, 'every missing file to be found')
  await driver.untilUndoLabel('Undo Relink Media')
  const foundNotice = await driver.page.text('notice')
  await fullQualityFrame(driver, 0)
  return { openNotice, missingAtOpen, refusal, missingAfterRefusal, foundNotice, relinked: await driver.savedProject('relinked.json') }
}

export async function openExportDialog(driver: Driver): Promise<void> {
  await driver.page.click('export')
  await driver.until(`${selector('export-dialog')}?.open === true`, 'the export dialog')
}

type ExportSetup = {
  fileName: string
  preset: string
  quality: 'low' | 'medium' | 'high'
  hasAudio: boolean
}

export async function submitExport(driver: Driver, fileName: string): Promise<string> {
  if (driver.options.outputDirectory === undefined) throw new PageError('This UI test needs --out <directory>')
  await mkdir(driver.options.outputDirectory, { recursive: true })
  const path = join(driver.options.outputDirectory, fileName)
  driver.options.answers.exportPath = path
  await driver.page.evaluate(`${selector('export-start')}.focus()`)
  await driver.press('Return')
  await driver.until(`${selector('export-dialog')} === null`, 'the export dialog to close')
  return path
}

export async function startExport(driver: Driver, setup: ExportSetup): Promise<string> {
  await pick(driver, 'export-format', 'mp4')
  await pick(driver, 'export-preset', setup.preset)
  await driver.page.click(`export-quality-${setup.quality}`)
  const hasAudio = (await driver.page.evaluate(`${selector('export-audio')}.checked`)) === true
  if (hasAudio !== setup.hasAudio) await driver.page.click('export-audio')
  return submitExport(driver, setup.fileName)
}

const EXPORT_FIELDS = ['export-preset', 'export-frame-rate', 'export-quality-high', 'export-encoder', 'export-range-whole', 'export-audio']

async function shownExportFields(driver: Driver): Promise<unknown> {
  return driver.page.evaluate(`${JSON.stringify(EXPORT_FIELDS)}.filter((id) => document.querySelector('[data-testid="' + id + '"]') !== null)`)
}

export async function untilExported(driver: Driver, fileName: string, timeoutMs?: number): Promise<void> {
  try {
    await driver.until(`${selector('export-done')} !== null`, `the export of ${fileName} to end`, timeoutMs)
  } catch (error) {
    const shown = await driver.page.evaluate(`document.querySelector('dialog[open]')?.innerText ?? 'no dialog open'`)
    throw new PageError(`${error instanceof Error ? error.message : String(error)}; the window showed: ${JSON.stringify(shown)}`)
  }
  const result = await driver.page.text('export-title')
  if (result !== `Exported "${fileName}"`) throw new PageError(`${result}: ${String(await driver.page.evaluate(`${selector('export-problem')}?.textContent`))}`)
  await driver.clickAt(centerOf(await driver.rect('export-done')))
  await driver.until(`${selector('export-progress-dialog')} === null`, 'the export dialog to close')
}

function isShown(testId: string): string {
  return `${selector(testId)}?.checkVisibility() === true`
}

async function testPreview(driver: Driver): Promise<UiTestReport> {
  await fullQualityFrame(driver, 0)
  const previewWidth = `Math.round(${selector('preview')}.getBoundingClientRect().width * devicePixelRatio)`
  const widths: Record<string, unknown> = {}
  for (const zoom of ['50', '100', '200']) {
    await pick(driver, 'canvas-zoom', zoom)
    await driver.until(`${previewWidth} === ${(640 * Number(zoom)) / 100}`, `the picture at ${zoom}%`)
    widths[zoom] = await driver.page.evaluate(previewWidth)
  }
  const renderingAt200 = await driver.page.evaluate(`${selector('preview')}.style.imageRendering`)
  await driver.picture('preview-200')

  await pick(driver, 'canvas-zoom', '100')
  await driver.scrollAt(centerOf(await driver.rect('preview')), 0, PINCH_DELTA, true)
  await driver.until(`${selector('canvas-zoom')}.value !== '100'`, 'the pinch to zoom in')
  const pinchedZoom = await driver.value('canvas-zoom')
  await pick(driver, 'canvas-zoom', 'fit')

  await clickOn(driver, 'preview-mode')
  await driver.until(isShown('seek-bar'), 'preview mode')
  const panels = `({ left: ${isShown('left-sidebar')}, right: ${isShown('right-sidebar')}, timeline: ${isShown('timeline-panel')}, overlay: ${isShown('canvas-overlay')}, zoomTool: ${isShown('zoom-tool')} })`
  const shownInPreview = await driver.page.evaluate(panels)
  await driver.picture('preview-mode')
  await driver.clickAt(centerOf(await driver.rect('seek-bar')))
  await driver.until(`${selector('timecode')}.textContent !== '00:00:00:00'`, 'the seek bar to move the playhead')
  const timecodeAfterSeek = await driver.page.text('timecode')
  await driver.press('Escape')
  await driver.until(`!(${isShown('seek-bar')})`, 'Escape to leave preview mode')
  const shownAfterEscape = await driver.page.evaluate(panels)
  await driver.press('F', ['meta', 'shift'])
  await driver.until(isShown('seek-bar'), 'the keys to enter preview mode')
  await clickOn(driver, 'preview-mode')
  await driver.until(`!(${isShown('seek-bar')})`, 'the button to leave preview mode')
  return { widths, renderingAt200, pinchedZoom, shownInPreview, timecodeAfterSeek, shownAfterEscape }
}

async function testShortcuts(driver: Driver): Promise<UiTestReport> {
  await fullQualityFrame(driver, 0)
  const settingsOpen = `${selector('settings-dialog')}?.open === true`
  driver.menu('settings')
  await driver.until(settingsOpen, 'the settings')
  await clickOn(driver, 'settings-tab-shortcuts')
  await clickOn(driver, 'shortcut-split-0')
  await driver.press('S')
  await driver.until(`${selector('shortcut-split-0')}.textContent === 'S'`, 'S to be the key of Split')
  await driver.untilMenuKeys('split', 'S')
  const splitHint = await driver.page.evaluate(`${selector('split')}.dataset.tooltip`)

  const refusal = `${selector('shortcut-duplicate')}.querySelector('[role="alert"]')`
  await clickOn(driver, 'shortcut-duplicate-1')
  await driver.press('S', ['meta'])
  await driver.until(`${refusal} !== null`, 'the key of Save to be refused')
  const refusalText = await driver.page.evaluate(`${refusal}.textContent`)
  await driver.press('Escape')
  await driver.until(`${selector('shortcut-duplicate-1')}.getAttribute('aria-pressed') === 'false'`, 'Escape to stop the recording')
  const isOpenAfterEscape = (await driver.page.evaluate(settingsOpen)) === true

  await clickOn(driver, 'shortcut-group-1')
  await driver.press('K')
  await driver.until(`${selector('shortcut-group-conflict')} !== null`, 'the shared key to be flagged')
  const conflicts = { group: await driver.page.text('shortcut-group-conflict'), stop: await driver.page.text('shortcut-shuttle-stop-conflict') }
  await driver.picture('shortcut-settings')
  await clickOn(driver, 'settings-done')
  await driver.until(`${selector('settings-dialog')} === null`, 'the settings to close')

  await seekOnRuler(driver, TICKS_PER_SECOND, '00:00:01:00')
  await driver.press('S')
  await driver.untilUndoLabel('Undo Split Clip')
  const split = await driver.savedProject('split.json')

  driver.menu('settings')
  await driver.until(settingsOpen, 'the settings again')
  await clickOn(driver, 'settings-tab-shortcuts')
  await clickOn(driver, 'shortcuts-defaults')
  await driver.until(`${selector('shortcut-split-0')}.textContent === '⌘T'`, 'the default key of Split')
  await driver.untilMenuKeys('split', 'Cmd+T')
  const conflictsAfterDefaults = await driver.page.evaluate(`document.querySelectorAll('[data-testid$="-conflict"]').length`)
  return { splitHint, refusalText, isOpenAfterEscape, conflicts, split, conflictsAfterDefaults }
}

async function testWindows(driver: Driver): Promise<UiTestReport> {
  if (driver.options.mediaDirectory === undefined) throw new PageError('This UI test needs --media <directory>')
  await fullQualityFrame(driver, 0)
  driver.options.answers.openProject = join(driver.options.mediaDirectory, '..', '..', 'projects', '01-single-clip.json')
  driver.menu('open-project')
  const other = await driverOfNewWindow(driver, [driver.window])
  await fullQualityFrame(other, 0)
  const titles = { first: driver.window.getTitle(), other: other.window.getTitle() }

  await other.typeInto('canvas-width', '1280')
  await other.until(`${selector('canvas-width')}?.value === '1280'`, 'the second canvas to change')
  const first = { width: await driver.value('canvas-width'), isEdited: driver.window.isDocumentEdited() }

  await openExportDialog(driver)
  await startExport(driver, { fileName: 'first.mp4', preset: '4k', quality: 'high', hasAudio: true })
  await driver.until(`${selector('export-progress')} !== null`, 'the first export to run')
  await openExportDialog(other)
  await submitExport(other, 'second.mp4')
  await other.until(`${selector('export-problem')} !== null`, 'the second export to be refused')
  const refusal = await other.page.text('export-problem')
  const isFirstRunning = (await driver.page.evaluate(`${selector('export-cancel')} !== null`)) === true
  await driver.page.click('export-cancel')
  await driver.until(`${selector('export-progress-dialog')} === null`, 'the first export to stop')
  return { titles, first, refusal, isFirstRunning, windows: editorWindows().length }
}

async function testExport(driver: Driver): Promise<UiTestReport> {
  const second = TICKS_PER_SECOND
  await fullQualityFrame(driver, 0)

  driver.menu('export')
  await driver.until(`${selector('export-dialog')}?.open === true`, 'the export dialog')
  const defaultPreset = await driver.value('export-preset')
  const summaryAtOpen = await driver.page.text('export-summary')
  const canChooseSelection = (await driver.page.evaluate(`${selector('export-range-selection')}.disabled`)) === false
  const tabStops: unknown[] = []
  for (let stop = 0; stop < DIALOG_TAB_STOPS; stop++) {
    await driver.press('Tab')
    tabStops.push(await driver.page.evaluate(`document.activeElement?.closest('dialog') === null ? 'outside the dialog' : document.activeElement?.dataset.testid`))
  }
  await driver.picture('export-dialog')
  await openList(driver, 'export-preset', 'export-preset')
  await driver.picture('export-sizes')
  await driver.press('Escape')
  await driver.until(`!(${isListOpen('export-preset')})`, 'Escape to close the list of sizes')
  const isDialogOpenAfterListEscape = (await driver.page.evaluate(`${selector('export-dialog')}?.open === true`)) === true
  await driver.press('Escape')
  await driver.until(`${selector('export-dialog')} === null`, 'Escape to close the dialog')

  await driver.clickAt(await driver.timelinePoint(2.5 * second, 1, 3))
  await driver.until(`${selector('clip-start')}?.value === '1.000'`, 'the clip to be selected')
  await openExportDialog(driver)
  await pick(driver, 'export-frame-rate', '25/1')
  await driver.page.click('export-range-selection')
  const range = await startExport(driver, { fileName: 'range.mp4', preset: '240p', quality: 'low', hasAudio: false })
  await driver.until(`${selector('export-done')} !== null`, 'the export of the range to end')
  const canShowInFinder = (await driver.page.evaluate(`${selector('show-export')} !== null`)) === true
  const focusOnResult = await driver.page.evaluate(`document.activeElement?.dataset.testid`)
  await driver.picture('export-finished')
  driver.menu('duplicate')
  driver.window.webContents.paste()
  await driver.clickAt(await driver.timelinePoint(second / 2, 0, 3))
  await sleep(POLL_INTERVAL_MS)
  const behindResult = { undoLabel: driver.menuLabel('undo'), selectedStart: await driver.value('clip-start') }
  await untilExported(driver, 'range.mp4')
  await driver.typeInto('clip-opacity', '50')
  await driver.untilUndoLabel('Undo Change Opacity')

  await openExportDialog(driver)
  const rememberedPreset = await driver.value('export-preset')
  const cancelled = await startExport(driver, { fileName: 'cancelled.mp4', preset: '4k', quality: 'high', hasAudio: true })
  await driver.until(`/Frame [1-9]\\d/.test(${selector('export-progress')}?.textContent ?? '')`, 'the export to be well under way')
  const progressText = await driver.page.text('export-progress')
  const hadUnfinishedFile = existsSync(`${cancelled}.part`)
  await driver.picture('export-running')
  const focusWhileRunning = await driver.page.evaluate(`document.activeElement?.dataset.testid`)
  const timecodeBefore = await driver.page.text('timecode')
  await driver.press('Backspace')
  await driver.press('Space')
  driver.menu('duplicate')
  await driver.clickAt(await driver.timelinePoint(second / 2, 0, 3))
  // A file dropped on the window is not imported either. The page cannot be handed a real file, so the drop carries one without a place on disk: were it let through, the import would complain about it.
  await driver.page.evaluate(`(() => {
    const files = new DataTransfer()
    files.items.add(new File(['x'], 'dropped.mp4'))
    ${selector('editor')}.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: files }))
  })()`)
  await driver.press('Escape')
  await driver.press('Escape')
  driver.window.close()
  await sleep(POLL_INTERVAL_MS)
  const whileRunning = {
    undoLabel: driver.menuLabel('undo'),
    selectedStart: await driver.value('clip-start'),
    notice: await noticeShown(driver),
    hasPlayheadMoved: (await driver.page.text('timecode')) !== timecodeBefore,
    isStillRunning: !driver.window.isDestroyed() && (await driver.page.evaluate(`${selector('export-cancel')} !== null && ${selector('export-progress-dialog')}.open`)) === true,
  }
  await driver.clickAt(centerOf(await driver.rect('export-cancel')))
  await driver.until(`${selector('export-progress-dialog')} === null`, 'the export to stop')
  await sleep(CANCEL_SETTLE_MS)
  const leftBehind = [cancelled, `${cancelled}.part`].filter((path) => existsSync(path))

  const resultsClosedByKeys: string[] = []
  await openExportDialog(driver)
  const low = await startExport(driver, { fileName: 'whole-low.mp4', preset: '240p', quality: 'low', hasAudio: true })
  await driver.until(`${selector('export-done')} !== null`, 'the low-quality export to end')
  resultsClosedByKeys.push(await driver.page.text('export-title'))
  await driver.press('Return')
  await driver.until(`${selector('export-progress-dialog')} === null`, 'Return to close the result')
  await openExportDialog(driver)
  const high = await startExport(driver, { fileName: 'whole-high.mp4', preset: '240p', quality: 'high', hasAudio: true })
  await driver.until(`${selector('export-done')} !== null`, 'the high-quality export to end')
  resultsClosedByKeys.push(await driver.page.text('export-title'))
  await driver.press('Escape')
  await driver.until(`${selector('export-progress-dialog')} === null`, 'Escape to close the result')

  await openExportDialog(driver)
  const fieldsByFormat: Record<string, unknown> = {}
  for (const format of ['webm', 'gif', 'wav', 'png', 'mp4']) {
    await pick(driver, 'export-format', format)
    fieldsByFormat[format] = await shownExportFields(driver)
  }
  await pick(driver, 'export-format', 'wav')
  const sound = await submitExport(driver, 'sound.wav')
  await untilExported(driver, 'sound.wav')
  await openExportDialog(driver)
  await pick(driver, 'export-format', 'png')
  const stillSummary = await driver.page.text('export-summary')
  const still = await submitExport(driver, 'still.png')
  await untilExported(driver, 'still.png')

  await openExportDialog(driver)
  const reloaded = await startExport(driver, { fileName: 'reloaded.mp4', preset: '4k', quality: 'high', hasAudio: true })
  await driver.until(`/Frame [1-9]/.test(${selector('export-progress')}?.textContent ?? '')`, 'the last export to be under way')
  driver.window.webContents.reload()
  await driver.until(`${selector('editor')} !== null && ${selector('export-progress-dialog')} === null`, 'the window to load again')
  await sleep(CANCEL_SETTLE_MS)
  const leftAfterReload = [reloaded, `${reloaded}.part`].filter((path) => existsSync(path))
  return {
    defaultPreset,
    summaryAtOpen,
    canChooseSelection,
    tabStops,
    isDialogOpenAfterListEscape,
    behindResult,
    canShowInFinder,
    focusOnResult,
    rememberedPreset,
    progressText,
    hadUnfinishedFile,
    focusWhileRunning,
    whileRunning,
    resultsClosedByKeys,
    leftBehind,
    range,
    low,
    high,
    fieldsByFormat,
    sound,
    still,
    stillSummary,
    leftAfterReload,
  }
}

async function playheadTime(driver: Driver): Promise<number> {
  const [hours = 0, minutes = 0, seconds = 0, frames = 0] = (await driver.page.text('timecode')).split(':').map(Number)
  return (((hours * 60 + minutes) * 60 + seconds) * FRAMES_PER_SECOND + frames) * (TICKS_PER_SECOND / FRAMES_PER_SECOND)
}

async function untilPlayhead(driver: Driver, time: number): Promise<void> {
  const frames = Math.round(time / (TICKS_PER_SECOND / FRAMES_PER_SECOND))
  const shown = `(() => {
    const [hours, minutes, seconds, frames] = ${selector('timecode')}.textContent.split(':').map(Number)
    return ((hours * 60 + minutes) * 60 + seconds) * ${FRAMES_PER_SECOND} + frames === ${frames}
  })()`
  await driver.until(shown, `the playhead at frame ${frames}`)
}

async function noticeShown(driver: Driver): Promise<string> {
  return (await driver.page.evaluate(`${selector('notice')} !== null`)) === true ? driver.page.text('notice') : ''
}

async function testTutorial(driver: Driver): Promise<UiTestReport> {
  const second = TICKS_PER_SECOND
  const splitter = centerOf(await driver.rect('split-timeline'))
  await driver.drag(splitter, { x: splitter.x, y: splitter.y - TALLER_TIMELINE })
  const names = ['screen.mp4', 'voice.m4a', 'music.mp3', 'logo.png']
  driver.options.answers.importMedia = names.map((name) => mediaFile(driver, name))
  driver.menu('import')
  await driver.until(names.map((name) => `${selector(`media-${name}`)} !== null`).join(' && '), 'the four files in the Media tab')

  await dragMedia(driver, 'screen.mp4', await driver.timelinePoint(0, 0, 6))
  await driver.untilUndoLabel('Undo Add Clip')
  for (const [name, row] of [['voice.m4a', 0], ['music.mp3', 1]] as const) {
    await driver.press('Escape')
    await driver.until(`${selector('clip-volume')} === null`, 'nothing selected')
    await dragMedia(driver, name, await driver.timelinePoint(0, row, 6))
    await driver.until(`${selector('clip-volume')} !== null`, `${name} on the track above`)
  }
  await driver.page.click('timeline-zoom-fit')

  await driver.clickAt(await driver.timelinePoint(300 * second, 2, 6))
  await driver.until(`${selector('clip-volume')} !== null`, 'the music to be selected')
  await driver.typeInto('clip-volume', '30')
  await driver.typeInto('clip-volumeFadeOut', '3')
  await driver.untilUndoLabel('Undo Change Fade')

  await driver.press('Return', ['meta'])
  await driver.page.click('tab-annotations')
  await driver.page.click('annotation-text')
  await untilTextEditor(driver, true)
  await driver.window.webContents.insertText('How to export a video')
  await driver.press('Escape')
  await untilTextEditor(driver, false)
  await driver.typeInto('text-size', '120')
  await pick(driver, 'clip-out', 'fade')
  await driver.typeInto('clip-out-length', '1')

  await driver.page.click('tab-media')
  await driver.until(`${selector('media-logo.png')} !== null`, 'the Media tab')
  await dragMedia(driver, 'logo.png', centerOf(await driver.rect('preview')))
  await driver.untilUndoLabel('Undo Add Clip')
  await driver.typeInto('clip-scale', '25')
  await driver.typeInto('clip-x', '1760')
  await driver.typeInto('clip-y', '100')
  await driver.typeInto('clip-duration', '30')
  await driver.untilUndoLabel('Undo Trim Clip')

  const ruler = await driver.rect('timeline')
  const middle = await driver.timelinePoint(300 * second, 0, 6)
  await driver.clickAt({ x: middle.x, y: ruler.y + RULER_HEIGHT / 2 })
  await driver.until(`${selector('timecode')}.textContent.startsWith('00:0')  && ${selector('timecode')}.textContent !== '00:00:00:00'`, 'the playhead in the middle')
  const cutStart = await playheadTime(driver)
  await driver.clickAt(await driver.timelinePoint(100 * second, 0, 6))
  await driver.page.click('split')
  await driver.untilUndoLabel('Undo Split Clip')
  const cutEnd = cutStart + CUT_SECONDS * second
  for (let jump = 0; jump < (CUT_SECONDS * FRAMES_PER_SECOND) / JUMP_FRAMES; jump++) await driver.press('.', ['control', 'shift'])
  await untilPlayhead(driver, cutEnd)
  await driver.clickAt(await driver.timelinePoint(cutEnd + 100 * second, 0, 6))
  await driver.page.click('split')
  await driver.clickAt(await driver.timelinePoint((cutStart + cutEnd) / 2, 0, 6))
  await driver.press('Backspace', ['meta'])
  await driver.untilUndoLabel('Undo Ripple Delete Clip')
  const noticeBeforeExport = await noticeShown(driver)
  const project = await driver.savedProject('tutorial.json')

  await openExportDialog(driver)
  const presetOffered = await driver.value('export-preset')
  const startedAt = Date.now()
  const exported = await startExport(driver, { fileName: 'tutorial.mp4', preset: '1080p', quality: 'high', hasAudio: true })
  await untilExported(driver, 'tutorial.mp4', LONG_EXPORT_TIMEOUT_MS)
  const exportSeconds = (Date.now() - startedAt) / MS_PER_SECOND
  return { cutSeconds: (cutEnd - cutStart) / second, noticeBeforeExport, project, presetOffered, exported, exportSeconds }
}

function timelineZoom(driver: Driver): Promise<unknown> {
  return driver.page.evaluate(`JSON.parse(${selector('timeline')}.dataset.view).pixelsPerSecond`)
}

async function isPressed(driver: Driver, testId: string): Promise<boolean> {
  return (await driver.page.evaluate(`${selector(testId)}?.getAttribute('aria-pressed')`)) === 'true'
}

async function isExpanded(driver: Driver, testId: string): Promise<boolean> {
  return (await driver.page.evaluate(`${selector(testId)}?.getAttribute('aria-expanded')`)) === 'true'
}

async function testControls(driver: Driver): Promise<UiTestReport> {
  await driver.page.evaluate(`(() => {
    window.listDelays = []
    window.groupDelays = []
    addEventListener('pointerdown', () => {
      const startedAt = performance.now()
      requestAnimationFrame(() => {
        if (document.querySelector('.options[role="listbox"]') !== null) window.listDelays.push(performance.now() - startedAt)
      })
    }, true)
    addEventListener('click', (event) => {
      if (event.target.closest('.group-toggle') === null) return
      const startedAt = performance.now()
      const bodies = document.querySelectorAll('.group-body').length
      requestAnimationFrame(() => {
        if (document.querySelectorAll('.group-body').length !== bodies) window.groupDelays.push(performance.now() - startedAt)
      })
    }, true)
  })()`)

  await clickOn(driver, 'group-project')
  await driver.until(`${selector('canvas-width')} === null`, 'the project settings to fold away')

  driver.menu('sort-duration')
  driver.options.answers.importMedia = ['h264.mp4', 'audio.wav', 'image.jpg'].map((name) => mediaFile(driver, name))
  driver.menu('import')
  await driver.until(`${selector('media-image.jpg')} !== null`, 'the import to finish')
  await untilPrepared(driver)

  const search = await driver.rect('media-search')
  const gridSwitch = await driver.rect('media-view-grid')
  const isSwitchBesideSearch = Math.abs(centerOf(search).y - centerOf(gridSwitch).y) < 1 && gridSwitch.x > search.x + search.width
  const isGridByDefault = await isPressed(driver, 'media-view-grid')
  const firstTile = await driver.rect('media-h264.mp4')
  const secondTile = await driver.rect('media-audio.wav')
  await sleep(PICTURES_SETTLE_MS)
  await driver.picture('media-grid')
  await clickOn(driver, 'media-view-list')
  await driver.until(`${selector('media-h264.mp4')}.getBoundingClientRect().top !== ${selector('media-audio.wav')}.getBoundingClientRect().top`, 'the media to be shown as a list')
  const firstInList = await driver.rect('media-h264.mp4')
  const secondInList = await driver.rect('media-audio.wav')
  await clickOn(driver, 'media-view-grid')
  await driver.until(`${selector('media-h264.mp4')}.getBoundingClientRect().top === ${selector('media-audio.wav')}.getBoundingClientRect().top`, 'the media to be shown as tiles again')

  await dragMedia(driver, 'h264.mp4', await driver.timelinePoint(0, 0, 6))
  await driver.untilUndoLabel('Undo Add Clip')
  await driver.until(`${selector('clip-x')} !== null`, 'the properties of the new clip')
  const groupsOpenAtFirst = await driver.page.evaluate(`[...document.querySelectorAll('.group-toggle[aria-expanded="true"]')].map((toggle) => toggle.textContent)`)

  const sidebar = await driver.rect('right-sidebar')
  const field = await driver.rect('clip-x')
  const lineEnd = await driver.rect('clip-position-next-keyframe')
  const labelBottom = await driver.page.evaluate(`document.querySelector('label[for="' + ${selector('clip-x')}.id + '"]').getBoundingClientRect().bottom`)
  const fieldInset = { left: field.x - sidebar.x, right: sidebar.x + sidebar.width - lineEnd.x - lineEnd.width }
  const isLabelAbove = typeof labelBottom === 'number' && labelBottom <= field.y
  await driver.picture('properties')

  await clickOn(driver, 'group-opacity')
  await clickOn(driver, 'group-volume')
  await driver.until(`${selector('clip-opacity')} !== null && ${selector('clip-volume')} !== null`, 'the opacity and volume groups to open')

  for (const testId of ['clip-scale', 'clip-rotation', 'clip-opacity', 'clip-speed', 'clip-volume']) {
    await openList(driver, `${testId}-presets`, testId)
    await driver.press('Escape')
    await driver.until(`!(${isListOpen(testId)})`, `the list of ${testId} to close`)
  }
  const focusAfterList = await driver.page.evaluate(`document.activeElement?.dataset.testid`)
  await openList(driver, 'clip-rotation-presets', 'clip-rotation')
  await driver.hover(await optionPoint(driver, 'clip-rotation', '90'))
  await driver.until(`${selector('clip-rotation')}.value === '90.0'`, 'the rotation pointed at to be shown')
  await driver.picture('ready-made-values')
  await clickOn(driver, 'timecode')
  await driver.until(`!(${isListOpen('clip-rotation')})`, 'a press elsewhere to close the list')
  const rotationAfterPressElsewhere = await driver.value('clip-rotation')
  const undoLabelAfterLists = driver.menuLabel('undo')

  await driver.page.click('tab-annotations')
  await driver.page.click('annotation-text')
  await untilTextEditor(driver, true)
  await driver.press('Escape')
  await untilTextEditor(driver, false)
  await driver.page.click('tab-media')
  await clickOn(driver, 'group-text')
  const fontOptions = `document.querySelectorAll('[data-testid="text-font-options"] [role="option"]').length`
  await openList(driver, 'text-font', 'text-font')
  await driver.until(`${fontOptions} > 20`, 'the installed fonts to be listed')
  await driver.picture('font-list')
  const listsBeforeFonts = numbersIn(await driver.page.evaluate('window.listDelays')).length
  for (let turn = 0; turn < FONT_LIST_TURNS; turn++) {
    await driver.press('Escape')
    await driver.until(`!(${isListOpen('text-font')})`, 'the font list to close')
    await openList(driver, 'text-font', 'text-font')
  }
  await driver.press('Escape')
  await driver.until(`!(${isListOpen('text-font')})`, 'the font list to close')

  await driver.page.evaluate(`(() => {
    ${selector('clip-opacity')}.focus()
    return ${ONCE_THE_SCROLL_IS_HEARD}
  })()`)
  await driver.press('Down', ['alt'])
  await driver.until(isListOpen('clip-opacity'), 'Alt+Down to open the list of opacities')
  await driver.press('Up')
  await driver.until(`${selector('clip-opacity')}.value === '75'`, 'the opacity above to be shown')
  await driver.press('Return')
  await driver.untilUndoLabel('Undo Change Opacity')
  const opacityFromKeys = await driver.value('clip-opacity')
  const focusAfterKeys = await driver.page.evaluate(`document.activeElement?.dataset.testid`)

  await clickOn(driver, 'group-transform')
  await driver.until(`${selector('clip-x')} === null`, 'the transform fields to fold away')
  const isLockShownWhenFolded = (await driver.page.evaluate(`${selector('aspect-lock')} !== null`)) === true
  await driver.picture('folded')
  await driver.page.evaluate(`${selector('group-transform')}.focus()`)
  await driver.press('Return')
  await driver.until(`${selector('clip-x')} !== null`, 'Return to open the group again')

  const rightBefore = await driver.rect('right-sidebar')
  const leftSplitter = centerOf(await driver.rect('split-left'))
  await driver.drag(leftSplitter, { x: leftSplitter.x + 1200, y: leftSplitter.y })
  const leftWide = await driver.rect('left-sidebar')
  const rightAfter = await driver.rect('right-sidebar')
  const canvasWhenWide = await driver.page.evaluate(`document.querySelector('.canvas-panel').getBoundingClientRect().width`)
  const windowWidth = await driver.page.evaluate('window.innerWidth')
  const tilesAcrossWhenWide = await driver.page.evaluate(`new Set([...document.querySelectorAll('.library-item')].map((item) => item.getBoundingClientRect().left)).size`)
  await driver.picture('wide-sidebar')
  const rightSplitter = centerOf(await driver.rect('split-right'))
  await driver.drag(rightSplitter, { x: rightSplitter.x + 400, y: rightSplitter.y })
  const rightNarrow = await driver.rect('right-sidebar')
  await driver.picture('narrow-properties')

  const timeline = await driver.rect('timeline')
  const zoomAtFit = await timelineZoom(driver)
  for (let step = 0; step < 24; step++) await driver.page.click('timeline-zoom-out')
  await driver.until(`JSON.parse(${selector('timeline')}.dataset.view).pixelsPerSecond * ${SECONDS_PER_HOUR} < ${timeline.width + 1}`, 'the timeline to zoom out as far as it goes')
  const zoomedOut = await timelineZoom(driver)
  await driver.picture('zoomed-out')
  await driver.page.click('timeline-zoom-fit')
  await driver.until(`JSON.parse(${selector('timeline')}.dataset.view).pixelsPerSecond > 1`, 'the timeline to fit the project again')
  const zoomAfterFit = await timelineZoom(driver)
  await clickOn(driver, 'media-view-list')

  const listDelays = numbersIn(await driver.page.evaluate('window.listDelays'))
  const fontListDelays = listDelays.slice(listsBeforeFonts)
  const groupDelays = numbersIn(await driver.page.evaluate('window.groupDelays'))
  return {
    windowWidth,
    isSwitchBesideSearch,
    isGridByDefault,
    groupsOpenAtFirst,
    isListStacked: firstInList.x === secondInList.x && secondInList.y > firstInList.y,
    areTilesSideBySide: firstTile.y === secondTile.y && secondTile.x > firstTile.x,
    fieldInset,
    isLabelAbove,
    focusAfterList,
    rotationAfterPressElsewhere,
    undoLabelAfterLists,
    opacityFromKeys,
    focusAfterKeys,
    isLockShownWhenFolded,
    leftWide: leftWide.width,
    rightBefore: rightBefore.width,
    rightAfter: rightAfter.width,
    canvasWhenWide,
    tilesAcrossWhenWide,
    rightNarrow: rightNarrow.width,
    timelineWidth: timeline.width,
    zoomAtFit,
    zoomedOut,
    zoomAfterFit,
    listSamples: listDelays.length,
    listOpenP95: percentile(listDelays, P95),
    fontListSamples: fontListDelays.length,
    fontListOpenP95: percentile(fontListDelays, P95),
    groupSamples: groupDelays.length,
    groupToggleP95: percentile(groupDelays, P95),
  }
}

async function testControlsKept(driver: Driver): Promise<UiTestReport> {
  await driver.until(`${selector('group-project')} !== null`, 'the project settings')
  return {
    isProjectOpen: await isExpanded(driver, 'group-project'),
    isGridChosen: await isPressed(driver, 'media-view-grid'),
    isListChosen: await isPressed(driver, 'media-view-list'),
  }
}

type ShownLanding = {
  start: number
  trackIndex: number
  isNewTrack: boolean
}

function isShownLanding(value: unknown): value is ShownLanding {
  if (typeof value !== 'object' || value === null) return false
  if (!('start' in value) || !('trackIndex' in value) || !('isNewTrack' in value)) return false
  return typeof value.start === 'number' && typeof value.trackIndex === 'number' && typeof value.isNewTrack === 'boolean'
}

const LANDING = `(${selector('timeline')}.dataset.landing ?? '')`

async function untilLanding(driver: Driver): Promise<ShownLanding> {
  await driver.until(`${LANDING} !== ''`, 'the outline of where the held media would land')
  const landing: unknown = JSON.parse(String(await driver.page.evaluate(LANDING)))
  if (!isShownLanding(landing)) throw new PageError('The timeline does not say where the held media would land')
  return { start: landing.start, trackIndex: landing.trackIndex, isNewTrack: landing.isNewTrack }
}

async function trackCount(driver: Driver): Promise<unknown> {
  return driver.page.evaluate(`document.querySelectorAll('.track-header').length`)
}

export async function isPlaying(driver: Driver): Promise<boolean> {
  return (await driver.page.evaluate(`${selector('play')}.getAttribute('aria-label')`)) === 'Pause'
}

function clearOfVolumeLine(point: Point): Point {
  return { x: point.x, y: point.y - CLEAR_OF_VOLUME_LINE }
}

// Sorted by duration the files are listed in the order they are imported: the video and the sound are both 2 s long and keep that order, and the image has no length.
// The dates the test files were created on would give an order that changes when they are made again.
async function importThreeFiles(driver: Driver): Promise<void> {
  const names = ['h264.mp4', 'audio.wav', 'image.jpg']
  driver.menu('sort-duration')
  driver.options.answers.importMedia = names.map((name) => mediaFile(driver, name))
  driver.menu('import')
  await driver.until(names.map((name) => `${selector(`media-${name}`)} !== null`).join(' && '), 'the three files in the Media tab')
  await untilPrepared(driver)
}

async function testArrange(driver: Driver): Promise<UiTestReport> {
  const second = TICKS_PER_SECOND
  await importThreeFiles(driver)
  const mediaDetails = await driver.page.evaluate(`[...document.querySelectorAll('.library-item .library-details')].map((details) => details.textContent)`)

  const video = centerOf(await driver.rect('media-h264.mp4'))
  const oneSecond = await driver.timelinePoint(second, 0, 6)
  const fourSeconds = await driver.timelinePoint(4 * second, 0, 6)
  const undoBefore = driver.menuLabel('undo')
  driver.holdAt(video)
  await driver.dragOn(video, oneSecond)
  await untilLanding(driver)
  await driver.page.evaluate(`(() => {
    window.heldFrames = []
    const note = (now) => {
      window.heldFrames.push(now)
      if (window.heldFrames.length < ${HELD_FRAMES}) requestAnimationFrame(note)
    }
    requestAnimationFrame(note)
  })()`)
  for (let pass = 0; pass < HELD_PASSES; pass++) {
    await driver.dragOn(oneSecond, fourSeconds)
    await driver.dragOn(fourSeconds, oneSecond)
  }
  const drawnAt = numbersIn(await driver.page.evaluate('window.heldFrames'))
  const heldIntervals = drawnAt.slice(1).map((time, index) => time - (drawnAt[index] ?? time))
  const heldOverEmpty = await untilLanding(driver)
  const whileHeld = { tracks: await trackCount(driver), undoLabel: driver.menuLabel('undo') === undoBefore ? 'unchanged' : driver.menuLabel('undo') }
  await driver.picture('arrange-held')

  await driver.dragOn(oneSecond, video)
  await driver.until(`${LANDING} === ''`, 'the outline to go when the pointer leaves the timeline')
  await driver.dragOn(video, oneSecond)
  await untilLanding(driver)
  await driver.press('Escape')
  await driver.until(`${LANDING} === ''`, 'Escape to abandon the drag')
  await driver.releaseAt(oneSecond)
  await sleep(POLL_INTERVAL_MS)
  const afterEscape = { tracks: await trackCount(driver), undoLabel: driver.menuLabel('undo') === undoBefore ? 'unchanged' : driver.menuLabel('undo') }

  driver.holdAt(video)
  await driver.dragOn(video, oneSecond)
  await untilLanding(driver)
  await driver.releaseAt(oneSecond)
  await driver.untilUndoLabel('Undo Add Clip')
  const placed = await driver.savedProject('placed.json')

  await driver.press('Return', ['meta'])
  await driver.press('Space')
  await driver.until(`${selector('play')}.getAttribute('aria-label') === 'Pause'`, 'playback to start')
  const sound = centerOf(await driver.rect('media-audio.wav'))
  const onTheVideo = await driver.timelinePoint(1.5 * second, 0, 6)
  driver.holdAt(sound)
  await driver.dragOn(sound, onTheVideo)
  const heldOverTaken = await untilLanding(driver)
  const isPlayingWhileHeld = await isPlaying(driver)
  await driver.picture('arrange-new-track')
  await driver.releaseAt(onTheVideo)
  await driver.until(`${selector('clip-x')} === null && ${selector('clip-volume')} !== null`, 'the sound on the track above')
  const stacked = await driver.savedProject('stacked.json')
  const ruler = await driver.rect('timeline')
  await driver.clickAt({ x: ruler.x + 8, y: ruler.y + RULER_HEIGHT / 2 })

  await driver.clickAt(await driver.timelinePoint(1.25 * second, 0, 6))
  const onTheSound = clearOfVolumeLine(await driver.timelinePoint(2.5 * second, 1, 6))
  const aboveTheSound = clearOfVolumeLine(await driver.timelinePoint(3.5 * second, 2, 6))
  await driver.clickAt(onTheSound, ['shift'])
  const moveDelays = await watchDelays(driver, 'pointermove', 'any frame')
  driver.holdAt(onTheSound)
  await driver.dragOn(onTheSound, aboveTheSound)
  await driver.picture('arrange-group')
  await driver.releaseAt(aboveTheSound)
  await driver.untilUndoLabel('Undo Move Clips')
  const groupDelays = await moveDelays.read()
  const lifted = await driver.savedProject('lifted.json')

  await driver.drag(clearOfVolumeLine(await driver.timelinePoint(3.5 * second, 2, 6)), clearOfVolumeLine(await driver.timelinePoint(3.5 * second, 1, 6)))
  await sleep(POLL_INTERVAL_MS)
  const lowered = await driver.savedProject('lowered.json')
  await driver.drag(clearOfVolumeLine(await driver.timelinePoint(3.5 * second, 1, 6)), clearOfVolumeLine(await driver.timelinePoint(3.5 * second, 0, 6)))
  await sleep(POLL_INTERVAL_MS)
  const kept = await driver.savedProject('kept.json')

  const inTheVideo = await driver.timelinePoint(2.25 * second, 0, 6)
  await driver.clickAt({ x: inTheVideo.x, y: ruler.y + RULER_HEIGHT / 2 })
  await driver.clickAt(inTheVideo)
  await driver.until(`${selector('clip-crop-left')} !== null && ${selector('clip-start')}?.value === '2.000'`, 'the video alone to be selected')
  await fullQualityFrame(driver, 0)
  await driver.picture('arrange-uncropped')
  const groupIcons = await driver.page.evaluate(`[...document.querySelectorAll('.group-toggle')].map((toggle) => toggle.textContent + ' ' + toggle.querySelectorAll('svg').length)`)
  await driver.typeInto('clip-crop-left', '100')
  await driver.untilUndoLabel('Undo Crop Clip')
  const cropped = await driver.savedProject('cropped.json')
  const widthAfterCrop = await driver.value('clip-width')
  await sleep(PICTURES_SETTLE_MS)
  await driver.picture('arrange-cropped')

  await driver.clickAt(centerOf(await driver.rect('media-audio.wav')))
  await driver.clickAt(centerOf(await driver.rect('media-image.jpg')), ['meta'])
  const focusAfterClicks = await driver.page.evaluate(`document.activeElement?.getAttribute('role') ?? 'none'`)
  const selectedFiles = await driver.page.evaluate(`[...document.querySelectorAll('.library-item.selected')].map((item) => item.dataset.testid)`)
  const image = centerOf(await driver.rect('media-image.jpg'))
  const onTheTopTrack = await driver.timelinePoint(0.5 * second, 2, 6)
  driver.holdAt(image)
  await driver.dragOn(image, onTheTopTrack)
  const heldTogether = await untilLanding(driver)
  await driver.picture('arrange-held-together')
  await driver.releaseAt(onTheTopTrack)
  await driver.untilUndoLabel('Undo Add 2 Clips')
  const droppedTogether = await driver.savedProject('dropped-together.json')

  const listRole = await driver.page.evaluate(`(() => { const list = document.querySelector('ul[aria-label="Media"]'); return list.getAttribute('role') + ' ' + list.getAttribute('aria-multiselectable') })()`)
  const timecodeBeforeKeys = await driver.page.text('timecode')
  await driver.page.evaluate(`${selector('media-h264.mp4')}.focus()`)
  await driver.press('Right')
  await driver.press('Right', ['shift'])
  const pickedByKeys = await driver.page.evaluate(`[...document.querySelectorAll('[role="option"][aria-selected="true"]')].map((option) => option.dataset.testid)`)
  const focusAfterKeys = await driver.page.evaluate(`document.activeElement?.dataset.testid`)
  await driver.press('Return')
  await driver.untilUndoLabel('Undo Add 2 Clips')
  const addedByKeys = await driver.savedProject('added-by-keys.json')
  const timecodeAfterKeys = await driver.page.text('timecode')

  await driver.hover(centerOf(await driver.rect('split')))
  await driver.until(`document.querySelector('.tooltip:not([hidden])') !== null`, 'the hint of the split button')
  const hintSize = await driver.page.evaluate(`getComputedStyle(document.querySelector('.tooltip')).fontSize`)
  await driver.picture('arrange-hint')
  return {
    mediaDetails,
    focusAfterClicks,
    listRole,
    pickedByKeys,
    focusAfterKeys,
    addedByKeys,
    timecodeBeforeKeys,
    timecodeAfterKeys,
    heldFrameP95: percentile(heldIntervals, P95),
    heldFrames: heldIntervals.length,
    heldOverEmpty,
    whileHeld,
    afterEscape,
    placed,
    heldOverTaken,
    isPlayingWhileHeld,
    stacked,
    groupSamples: groupDelays.length,
    groupToFrameP95: percentile(groupDelays, P95),
    lifted,
    lowered,
    kept,
    groupIcons,
    cropped,
    widthAfterCrop,
    selectedFiles,
    heldTogether,
    droppedTogether,
    hintSize,
  }
}

const DROP = `(${selector('timeline')}.dataset.drop ?? '')`
const CANVAS_WIDTH = 640

async function untilDrop(driver: Driver): Promise<unknown> {
  await driver.until(`${DROP} !== ''`, 'the mark of where the held item would go')
  return JSON.parse(String(await driver.page.evaluate(DROP)))
}

async function onCanvas(driver: Driver, x: number, y: number): Promise<Point> {
  return canvasPoint(driver, CANVAS_WIDTH, { x, y })
}

async function untilField(driver: Driver, testId: string, value: string): Promise<void> {
  await driver.until(`${selector(testId)}?.value === ${JSON.stringify(value)}`, `${testId} to show ${value}`)
}

async function pressWithKeyboard(driver: Driver, testId: string): Promise<void> {
  await driver.page.evaluate(`${selector(testId)}.focus()`)
  await driver.press('Return')
}

async function testCanvasSize(driver: Driver): Promise<UiTestReport> {
  await fullQualityFrame(driver, 0)
  const before = await driver.savedProject('before.json')
  await driver.until(`${selector('canvas-width')} !== null`, 'the project settings')
  await driver.typeInto('canvas-width', '1280')
  await driver.untilUndoLabel('Undo Change Canvas Size')
  return { before, doubled: await driver.savedProject('doubled.json') }
}

async function testShapes(driver: Driver): Promise<UiTestReport> {
  await fullQualityFrame(driver, 0)
  await driver.page.click('tab-annotations')
  await driver.page.click('annotation-blur')
  await driver.untilUndoLabel('Undo Add Blur')
  await driver.until(`${selector('blur-strength')} !== null`, 'the new blur to be selected')
  const added = await driver.savedProject('blur.json')

  await driver.drag(centerOf(await driver.rect('handle-se')), await onCanvas(driver, 608, 288))
  await driver.untilUndoLabel('Undo Resize Clip')
  await driver.typeInto('blur-strength', '20')
  await driver.untilUndoLabel('Undo Change Blur')
  await driver.page.click('shape-ellipse')
  await driver.untilUndoLabel('Undo Change Shape')
  await driver.typeInto('shape-soft-edge', '6')
  await driver.untilUndoLabel('Undo Change Soft Edge')
  await driver.page.click('blur-pixelate')
  await driver.untilUndoLabel('Undo Pixelate')
  const strengthLabel = await driver.page.evaluate(`${selector('blur-strength')}.closest('.labelled').querySelector('.field-label').textContent`)
  const styled = await driver.savedProject('styled.json')
  await fullQualityFrame(driver, 0)
  await driver.picture('shapes-pixelate')

  await driver.page.click('annotation-highlight')
  await driver.untilUndoLabel('Undo Add Highlight')
  await choose(driver, 'highlight-color', '#00ff00')
  await driver.untilUndoLabel('Undo Change Highlight Colour')
  await driver.page.click('highlight-spotlight')
  await driver.untilUndoLabel('Undo Make Spotlight')
  const spotlight = await driver.savedProject('spotlight.json')
  await fullQualityFrame(driver, 0)
  await driver.picture('shapes-spotlight')

  await pressWithKeyboard(driver, 'annotation-pixelate')
  await driver.untilUndoLabel('Undo Add Pixelate')
  await driver.page.click('annotation-spotlight')
  await driver.untilUndoLabel('Undo Add Spotlight')
  const all = await driver.savedProject('all.json')

  driver.menu('undo')
  await driver.untilUndoLabel('Undo Add Pixelate')
  await driver.clickAt(await driver.timelinePoint(TICKS_PER_SECOND / 2, 3, 4))
  await driver.until(`${selector('blur-strength')} !== null`, 'the pixelate clip to be selected')
  await driver.press('Backspace')
  await driver.untilUndoLabel('Undo Delete Clip')
  return { added, strengthLabel, styled, spotlight, all, afterDelete: await driver.savedProject('deleted.json') }
}

async function testEffects(driver: Driver): Promise<UiTestReport> {
  const second = TICKS_PER_SECOND
  await fullQualityFrame(driver, 0)
  await driver.page.click('tab-effects')
  await driver.page.click('effect-border')
  const noticeWithoutSelection = await driver.page.waitFor('notice', (text) => text !== '', POLL_INTERVAL_MS * STEPS_TO_TIME, 'a notice that nothing is selected')

  await driver.clickAt(await driver.timelinePoint(second / 2, 0, 4))
  await driver.clickAt(await driver.timelinePoint(second / 2, 1, 4), ['shift'])
  const undoBeforeClick = driver.menuLabel('undo')
  await driver.clickAt(await centerInView(driver, 'effect-border'))
  await sleep(POLL_INTERVAL_MS)
  const isUnchangedByClick = driver.menuLabel('undo') === undoBeforeClick
  await driver.page.click('effect-border')
  await driver.untilUndoLabel('Undo Add Effect')
  const hintForTwo = await driver.page.waitFor('effects-hint', (text) => text !== '', POLL_INTERVAL_MS * STEPS_TO_TIME, 'the hint to select one clip')
  const bordered = await driver.savedProject('bordered.json')

  const shadow = await centerInView(driver, 'effect-dropShadow')
  const onThird = await driver.timelinePoint(second, 2, 4)
  driver.holdAt(shadow)
  await driver.dragOn(shadow, onThird)
  const heldOverTimeline = await untilDrop(driver)
  const undoWhileHeld = driver.menuLabel('undo')
  await driver.picture('effects-held')
  await driver.releaseAt(onThird)
  await driver.until(`${selector('effect-dropShadow-offsetX')} !== null`, 'the shadow of the third clip in Properties')

  const adjust = centerOf(await driver.rect('effect-colorAdjust'))
  const onFourth = await onCanvas(driver, 480, 270)
  driver.holdAt(adjust)
  await driver.dragOn(adjust, onFourth)
  await driver.until(`${selector('canvas-overlay')}.dataset.dropTarget === 'd'`, 'the clip under the held effect to be marked')
  await driver.releaseAt(onFourth)
  await driver.until(`${selector('effect-colorAdjust-brightness')} !== null`, 'the colour adjustment of the fourth clip in Properties')
  const dropped = await driver.savedProject('dropped.json')

  await driver.page.click('effect-border')
  await driver.until(`${selector('effect-border-width')} !== null`, 'the border of the fourth clip in Properties')
  await driver.typeInto('effect-border-width', '12')
  await driver.untilUndoLabel('Undo Change Effect')
  await driver.typeInto('effect-colorAdjust-saturation', '-100')
  await untilField(driver, 'effect-colorAdjust-saturation', '-100.0')
  await driver.page.click('effect-border-earlier')
  await driver.untilUndoLabel('Undo Reorder Effects')
  await driver.page.click('effect-border-switch')
  await driver.untilUndoLabel('Undo Switch Effect Off')
  const changed = await driver.savedProject('changed.json')

  await pressWithKeyboard(driver, 'effect-chromaKey')
  await driver.until(`${selector('effect-chromaKey-pick')} !== null`, 'the chroma key in Properties')
  await driver.page.evaluate(`void (window.EyeDropper = class { open() { return Promise.resolve({ sRGBHex: '#123456' }) } })`)
  await driver.page.click('effect-chromaKey-pick')
  await driver.untilUndoLabel('Undo Pick Key Colour')
  const keyed = await driver.savedProject('keyed.json')

  await driver.page.click('effect-border-remove')
  await driver.untilUndoLabel('Undo Remove Effect')
  const removed = await driver.savedProject('removed.json')

  await pressWithKeyboard(driver, 'effect-look')
  await driver.until(`${selector('effect-look-preset')} !== null`, 'the look of the fourth clip in Properties')
  await pick(driver, 'effect-look-preset', 'cinematic')
  await untilField(driver, 'effect-look-contrast', '15.0')
  const graded = await driver.savedProject('graded.json')
  await driver.typeInto('effect-look-contrast', '50')
  await untilField(driver, 'effect-look-contrast', '50.0')
  const lookAfterEdit = await driver.page.evaluate(`${selector('effect-look-preset')}.textContent`)
  driver.menu('undo')
  await untilField(driver, 'effect-look-contrast', '15.0')
  const lookAfterUndo = await driver.page.evaluate(`${selector('effect-look-preset')}.textContent`)

  await fullQualityFrame(driver, 0)
  await driver.picture('effects-applied')
  return { noticeWithoutSelection, isUnchangedByClick, hintForTwo, bordered, heldOverTimeline, undoWhileHeld, dropped, changed, keyed, removed, graded, lookAfterEdit, lookAfterUndo }
}

async function testTransitions(driver: Driver): Promise<UiTestReport> {
  const second = TICKS_PER_SECOND
  await fullQualityFrame(driver, 0)
  await driver.page.click('tab-transitions')
  const dissolve = centerOf(await driver.rect('transition-crossDissolve'))
  const beforeCut = await driver.timelinePoint(0.8 * second, 0, 1)
  const undoBefore = driver.menuLabel('undo')

  driver.holdAt(dissolve)
  await driver.dragOn(dissolve, beforeCut)
  const heldOnCut = await untilDrop(driver)
  const isUnchangedWhileHeld = driver.menuLabel('undo') === undoBefore
  await driver.picture('transitions-held')
  await driver.press('Escape')
  await driver.until(`${DROP} === ''`, 'Escape to abandon the drag')
  await driver.releaseAt(beforeCut)
  await sleep(POLL_INTERVAL_MS)
  const isUnchangedAfterEscape = driver.menuLabel('undo') === undoBefore
  await driver.clickAt(dissolve)
  await sleep(POLL_INTERVAL_MS)
  const isUnchangedByClick = driver.menuLabel('undo') === undoBefore

  await driver.drag(dissolve, beforeCut)
  await driver.untilUndoLabel('Undo Add Transition')
  const onCut = await driver.savedProject('cut.json')

  const gripDelays = await watchDelays(driver, 'pointermove', 'any frame')
  await driver.drag(await driver.timelinePoint(1.5 * second, 0, 1), await driver.timelinePoint(1.2 * second, 0, 1))
  await driver.untilUndoLabel('Undo Change Transition')
  const gripToFrame = await gripDelays.read()
  const shortened = await driver.savedProject('shortened.json')

  await driver.drag(await centerInView(driver, 'transition-zoom'), await driver.timelinePoint(0.2 * second, 0, 1))
  await untilField(driver, 'clip-in', 'zoom')
  await driver.drag(await centerInView(driver, 'transition-push'), await driver.timelinePoint(1.8 * second, 0, 1))
  await untilField(driver, 'clip-out', 'push')
  const withEnds = await driver.savedProject('ends.json')
  await sleep(PICTURES_SETTLE_MS)
  await driver.picture('transitions-three')

  await pick(driver, 'clip-in', 'wipeLeft')
  await driver.untilUndoLabel('Undo Change Clip In')
  await driver.typeInto('clip-in-length', '0.3')
  await untilField(driver, 'clip-in-length', '0.300')
  await pick(driver, 'clip-out', 'none')
  await driver.untilUndoLabel('Undo Change Clip Out')
  const viaProperties = await driver.savedProject('properties.json')

  await pressWithKeyboard(driver, 'transition-circleReveal')
  await untilField(driver, 'clip-in', 'circleReveal')
  return {
    heldOnCut,
    isUnchangedWhileHeld,
    isUnchangedAfterEscape,
    isUnchangedByClick,
    onCut,
    gripSamples: gripToFrame.length,
    gripToFrameP95: percentile(gripToFrame, P95),
    shortened,
    withEnds,
    viaProperties,
    clicked: await driver.savedProject('clicked.json'),
  }
}

async function lanePoint(driver: Driver, time: number): Promise<Point> {
  const onTrack = await driver.timelinePoint(time, 0, 1)
  const timeline = await driver.rect('timeline')
  return { x: onTrack.x, y: timeline.y + RULER_HEIGHT + CAMERA_LANE_HEIGHT / 2 }
}

async function seekOnRuler(driver: Driver, time: number, timecode: string): Promise<void> {
  const timeline = await driver.rect('timeline')
  await driver.clickAt({ x: (await driver.timelinePoint(time, 0, 1)).x, y: timeline.y + RULER_HEIGHT / 2 })
  await untilTimecode(driver, timecode)
}

async function testZoom(driver: Driver): Promise<UiTestReport> {
  const second = TICKS_PER_SECOND
  await fullQualityFrame(driver, 0)
  await driver.page.click('zoom-tool')
  await driver.until(`${selector('camera-tool')} !== null`, 'the zoom tool')
  await seekOnRuler(driver, second, '00:00:01:00')

  const frameDelays = await watchDelays(driver, 'pointermove', 'any frame')
  await driver.drag(await onCanvas(driver, 160, 90), await onCanvas(driver, 480, 270))
  await driver.untilUndoLabel('Undo Zoom and Pan')
  await driver.until(`${selector('zoom-scale')} !== null`, 'the new zoom in Properties')
  const frameToFrame = await frameDelays.read()
  const drawn = await driver.savedProject('drawn.json')
  await driver.picture('zoom-drawn')

  const drawnAt = await driver.value('zoom-x')
  await driver.drag(await onCanvas(driver, 320, 180), await onCanvas(driver, 400, 220))
  await driver.until(`${selector('zoom-x')}?.value !== '${drawnAt}'`, 'the frame to have moved')
  const moved = await driver.savedProject('moved-frame.json')
  const movedAt = await driver.value('zoom-x')
  await driver.drag(centerOf(await driver.rect('zoom-se')), await onCanvas(driver, 480, 265))
  await driver.until(`${selector('zoom-x')}?.value !== '${movedAt}'`, 'the frame to have changed size')
  const shaped = await driver.savedProject('shaped.json')

  await seekOnRuler(driver, 1.5 * second, '00:00:01:15')
  await pressWithKeyboard(driver, 'zoom-to-full')
  await driver.untilUndoLabel('Undo Zoom to Full')
  const withFull = await driver.savedProject('full.json')

  await driver.drag(await lanePoint(driver, second), await lanePoint(driver, 0.8 * second))
  await driver.untilUndoLabel('Undo Move Zoom')
  const barStart = await lanePoint(driver, 0)
  await driver.drag({ x: barStart.x + 2, y: barStart.y }, await lanePoint(driver, 0.4 * second))
  await driver.untilUndoLabel('Undo Change Zoom Length')
  const onLane = await driver.savedProject('lane.json')
  await sleep(PICTURES_SETTLE_MS)
  await driver.picture('zoom-lane')

  await driver.clickAt(await lanePoint(driver, 0.8 * second))
  await untilTimecode(driver, '00:00:00:24')
  await driver.typeInto('zoom-duration', '0.5')
  await untilField(driver, 'zoom-duration', '0.500')
  await pick(driver, 'zoom-easing', 'linear')
  await driver.untilUndoLabel('Undo Change Zoom Easing')
  const viaProperties = await driver.savedProject('properties.json')

  await driver.clickAt(await lanePoint(driver, 1.5 * second))
  await untilTimecode(driver, '00:00:01:15')
  await driver.press('Backspace')
  await driver.untilUndoLabel('Undo Delete Zoom')
  const afterDelete = await driver.savedProject('deleted.json')

  await driver.page.click('zoom-tool')
  await driver.until(`${selector('canvas-overlay')} !== null`, 'the clip handles')
  await driver.clickAt(await lanePoint(driver, 0.8 * second))
  await untilTimecode(driver, '00:00:00:24')
  await fullQualityFrame(driver, 0)
  const preview = await driver.rect('preview')
  const middle = centerOf(preview)
  const pulled = 60
  await driver.drag(middle, { x: middle.x + pulled, y: middle.y })
  await driver.untilUndoLabel('Undo Move Clip')
  await driver.picture('zoom-handles')
  const movedClip = await driver.savedProject('moved.json')

  await driver.rightClickAt(await lanePoint(driver, 0.8 * second))
  await driver.page.click('menu-easing-hold')
  await driver.untilUndoLabel('Undo Change Zoom Easing')
  const menuEased = await driver.savedProject('menu-eased.json')
  await driver.rightClickAt(await lanePoint(driver, 0.8 * second))
  await driver.page.click('menu-zoom-delete')
  await driver.untilUndoLabel('Undo Delete Zoom')
  return {
    menuEased,
    menuDeleted: await driver.savedProject('menu-deleted.json'),
    frameSamples: frameToFrame.length,
    frameToFrameP95: percentile(frameToFrame, P95),
    drawn,
    movedFrame: moved,
    shaped,
    withFull,
    onLane,
    viaProperties,
    afterDelete,
    canvasPerPixel: CANVAS_WIDTH / preview.width,
    pulled,
    moved: movedClip,
  }
}

const VOLUME_POINT_AT_UNITY = 15.5
const VOLUME_POINT_AT_HALF = 20.75
const NEAR_TOP_OF_SOUND = 6
const LINE_DRAG_PIXELS = 5.25

async function timelineCursor(driver: Driver): Promise<unknown> {
  return driver.page.evaluate(`document.querySelector('[data-testid="timeline"] canvas:last-child').style.cursor`)
}

async function testAnnotations(driver: Driver): Promise<UiTestReport> {
  await fullQualityFrame(driver, 0)
  await driver.page.click('tab-annotations')
  await driver.page.click('annotation-callout')
  await driver.untilUndoLabel('Undo Add Callout')
  await untilTextEditor(driver, true)
  await driver.typeKeys('Look here')
  await driver.press('Escape')
  await untilTextEditor(driver, false)
  await driver.untilUndoLabel('Undo Edit Text')
  const added = await driver.savedProject('callout.json')

  await driver.drag(centerOf(await driver.rect('handle-tail')), await onCanvas(driver, 560, 320))
  await driver.untilUndoLabel('Undo Move Callout Tail')
  await pick(driver, 'callout-shape', 'thoughtBubble')
  await driver.untilUndoLabel('Undo Change Callout Shape')
  await driver.typeInto('callout-width', '240')
  await driver.untilUndoLabel('Undo Resize Callout')
  await choose(driver, 'callout-fill', '#ffee00')
  await driver.untilUndoLabel('Undo Change Callout Fill')
  await driver.typeInto('callout-border-width', '6')
  await driver.untilUndoLabel('Undo Change Callout Border')
  const shaped = await driver.savedProject('shaped.json')
  await pick(driver, 'callout-shape', 'banner')
  await driver.untilUndoLabel('Undo Change Callout Shape')
  const banner = await driver.savedProject('banner.json')

  await driver.page.click('annotation-arrow')
  await driver.untilUndoLabel('Undo Add Arrow')
  await driver.until(`${selector('arrow-length')} !== null`, 'the new arrow to be selected')
  const arrowAdded = await driver.savedProject('arrow-added.json')
  await driver.drag(centerOf(await driver.rect('handle-arrow-end')), await onCanvas(driver, 600, 40))
  await driver.untilUndoLabel('Undo Move Arrow End')
  await pick(driver, 'arrow-startHead', 'dot')
  await driver.untilUndoLabel('Undo Change Arrow Head')
  await driver.typeInto('arrow-thickness', '8')
  await driver.untilUndoLabel('Undo Change Arrow Thickness')
  const pointed = await driver.savedProject('pointed.json')
  await fullQualityFrame(driver, 0)
  await driver.picture('annotations')

  await driver.drag(centerOf(await driver.rect('annotation-line')), await onCanvas(driver, 160, 90))
  await driver.untilUndoLabel('Undo Add Line')
  const withLine = await driver.savedProject('line.json')
  await driver.clickAt(centerOf(await driver.rect('annotation-highlight')))
  await sleep(POLL_INTERVAL_MS)
  const undoAfterClick = driver.menuLabel('undo')

  const titleTile = centerOf(await driver.rect('annotation-text'))
  const onTheVideo = await driver.timelinePoint(TICKS_PER_SECOND, 0, 4)
  driver.holdAt(titleTile)
  await driver.dragOn(titleTile, onTheVideo)
  const titleHeld = await untilLanding(driver)
  await driver.releaseAt(onTheVideo)
  await driver.untilUndoLabel('Undo Add Text')
  return { added, shaped, banner, arrowAdded, pointed, withLine, undoAfterClick, titleHeld, withTitle: await driver.savedProject('title.json') }
}

async function testTextStyle(driver: Driver): Promise<UiTestReport> {
  await driver.page.click('tab-annotations')
  await driver.page.click('annotation-text')
  await untilTextEditor(driver, true)
  await driver.typeKeys('Two words')
  await driver.press('Escape')
  await untilTextEditor(driver, false)

  await pick(driver, 'text-weight', '700')
  await driver.untilUndoLabel('Undo Change Weight')
  await driver.typeInto('text-line-spacing', '1.5')
  await driver.untilUndoLabel('Undo Change Line Spacing')
  await clickOn(driver, 'text-outline')
  await driver.untilUndoLabel('Undo Add Outline')
  await driver.typeInto('text-outline-width', '4')
  await driver.untilUndoLabel('Undo Change Outline')
  await clickOn(driver, 'text-shadow')
  await driver.untilUndoLabel('Undo Add Shadow')
  await driver.typeInto('text-shadow-blur', '0')
  await driver.untilUndoLabel('Undo Change Shadow')
  await clickOn(driver, 'text-background')
  await driver.untilUndoLabel('Undo Add Background')
  await choose(driver, 'text-background-color', '#3c5a88')
  await driver.untilUndoLabel('Undo Change Background')
  const styled = await driver.savedProject('styled.json')

  await clickOn(driver, 'text-wrap')
  await driver.untilUndoLabel('Undo Wrap Text')
  const heightOnOneLine = await driver.value('clip-height')
  await driver.typeInto('text-box-width', '300')
  await driver.untilUndoLabel('Undo Change Box Width')
  const heightOnTwoLines = await driver.value('clip-height')
  const wrapped = await driver.savedProject('wrapped.json')
  await fullQualityFrame(driver, 0)
  await driver.picture('text-style')

  await clickOn(driver, 'text-wrap')
  await driver.untilUndoLabel('Undo Stop Wrapping Text')
  await clickOn(driver, 'text-outline')
  await driver.untilUndoLabel('Undo Remove Outline')
  return { styled, wrapped, heightOnOneLine, heightOnTwoLines, plain: await driver.savedProject('plain.json') }
}

async function testMissingFont(driver: Driver): Promise<UiTestReport> {
  await driver.until(`${selector('notice')} !== null`, 'the notice about the font')
  const openNotice = await driver.page.text('notice')
  await driver.clickAt(await canvasPoint(driver, 640, { x: 190, y: 70 }))
  await driver.until(`${selector('text-font-missing')} !== null`, 'the warning in the Text group')
  const warning = await driver.page.text('text-font-missing')
  const fontShown = await driver.page.text('text-font')
  await driver.picture('missing-font')
  return { openNotice, warning, fontShown, saved: await driver.savedProject('saved.json') }
}

async function testAnimations(driver: Driver): Promise<UiTestReport> {
  const second = TICKS_PER_SECOND
  await fullQualityFrame(driver, 0)
  await driver.clickAt(await driver.timelinePoint(second, 0, 1))
  await driver.until(`${selector('clip-in')} !== null`, 'the clip to be selected')
  const offersTypewriter = await (async () => {
    await openList(driver, 'clip-in', 'clip-in')
    const isOffered = await driver.page.evaluate(`${selector('clip-in-option-animation-typewriter')} !== null`)
    await driver.press('Escape')
    return isOffered
  })()

  await pick(driver, 'clip-in', 'animation-pop')
  await driver.untilUndoLabel('Undo Change Clip In')
  await driver.typeInto('clip-in-length', '1')
  await pick(driver, 'clip-out', 'fade')
  await driver.untilUndoLabel('Undo Change Clip Out')
  const animated = await driver.savedProject('animated.json')

  await pick(driver, 'clip-out', 'slideRight')
  await driver.until(`${selector('clip-out')}?.value === 'slideRight'`, 'the slide to replace the fade')
  const replaced = await driver.savedProject('replaced.json')
  await pick(driver, 'clip-in', 'none')
  await driver.until(`${selector('clip-in')}?.value === 'none'`, 'the pop to be taken away')
  return { offersTypewriter, animated, replaced, removed: await driver.savedProject('removed.json') }
}

async function testGroups(driver: Driver): Promise<UiTestReport> {
  const second = TICKS_PER_SECOND
  await fullQualityFrame(driver, 0)
  await driver.clickAt(await driver.timelinePoint(second, 0, 4))
  driver.menu('select-all')
  driver.menu('group')
  await driver.untilUndoLabel('Undo Group Clips')
  await driver.until(`${selector('group-open')} !== null`, 'the group to be selected')
  const grouped = await driver.savedProject('grouped.json')

  await driver.drag(await onCanvas(driver, 160, 90), await onCanvas(driver, 200, 110))
  await driver.untilUndoLabel('Undo Move Clip')
  await driver.typeInto('clip-scale', '50')
  await driver.untilUndoLabel('Undo Resize Clip')
  const moved = await driver.savedProject('moved.json')
  await fullQualityFrame(driver, 0)
  await driver.picture('groups-closed')

  await driver.doubleClickAt(await driver.timelinePoint(second, 3, 4))
  await driver.until(`${selector('group-path')} !== null`, 'the group to open')
  const tracksInside = await driver.page.evaluate(`document.querySelectorAll('.track-header').length`)
  const isCameraToolOff = await driver.page.evaluate(`${selector('zoom-tool')}.disabled`)
  await driver.clickAt(await driver.timelinePoint(second, 3, 4))
  await driver.until(`${selector('clip-opacity')} !== null`, 'a member to be selected')
  await driver.typeInto('clip-opacity', '40')
  await driver.untilUndoLabel('Undo Change Opacity')
  await driver.drag(await onCanvas(driver, 280, 195), await onCanvas(driver, 300, 215))
  await driver.untilUndoLabel('Undo Move Clip')
  const inside = await driver.savedProject('inside.json')
  await driver.picture('groups-open')

  await driver.press('Escape')
  await driver.press('Escape')
  await driver.until(`${selector('group-path')} === null && ${selector('group-open')} !== null`, 'the group to close')

  driver.menu('ungroup')
  await driver.untilUndoLabel('Undo Ungroup Clip')
  const ungrouped = await driver.savedProject('ungrouped.json')
  for (const label of ['Undo Move Clip', 'Undo Change Opacity', 'Undo Resize Clip', 'Undo Move Clip', 'Undo Group Clips']) {
    driver.menu('undo')
    await driver.untilUndoLabel(label)
  }
  driver.menu('undo')
  await driver.until(`${selector('group-open')} === null`, 'the group to be gone')
  return { grouped, moved, tracksInside, isCameraToolOff, inside, ungrouped, undone: await driver.savedProject('undone.json') }
}

async function testSound(driver: Driver): Promise<UiTestReport> {
  const second = TICKS_PER_SECOND
  await fullQualityFrame(driver, 0)
  await untilPrepared(driver)
  await driver.clickAt(await driver.timelinePoint(second / 2, 0, 1))
  await driver.until(`${selector('clip-volume-keyframe')} !== null`, 'the clip to be selected')

  const onLine = await driver.timelinePoint(0.75 * second, 0, 1)
  await driver.hover({ x: onLine.x, y: onLine.y + VOLUME_POINT_AT_UNITY })
  const cursorOverLine = await timelineCursor(driver)
  await driver.drag({ x: onLine.x, y: onLine.y + VOLUME_POINT_AT_UNITY }, { x: onLine.x, y: onLine.y + VOLUME_POINT_AT_HALF })
  await driver.untilUndoLabel('Undo Change Volume')
  const lineVolume = await driver.value('clip-volume')
  driver.menu('undo')
  await driver.until(`${selector('clip-volume')}?.value === '100'`, 'undo to put the volume back')

  await clickOn(driver, 'clip-volume-keyframe')
  await driver.untilUndoLabel('Undo Add Volume Keyframe')
  await seekOnRuler(driver, second, '00:00:01:00')
  await driver.typeInto('clip-volume', '50')
  await driver.untilUndoLabel('Undo Change Volume')
  const keyed = await driver.savedProject('keyed.json')

  const point = await driver.timelinePoint(second, 0, 1)
  const later = await driver.timelinePoint(1.5 * second, 0, 1)
  await driver.hover({ x: point.x, y: point.y + VOLUME_POINT_AT_HALF })
  const cursorOverPoint = await timelineCursor(driver)
  await driver.drag({ x: point.x, y: point.y + VOLUME_POINT_AT_HALF }, { x: later.x, y: later.y + NEAR_TOP_OF_SOUND })
  await driver.untilUndoLabel('Undo Change Volume Keyframe')
  const dragged = await driver.savedProject('dragged.json')
  await driver.picture('sound-keyframes')

  const first = await driver.timelinePoint(0, 0, 1)
  await driver.rightClickAt({ x: first.x + 1, y: first.y + VOLUME_POINT_AT_UNITY })
  await driver.page.click('menu-easing-easeIn')
  await driver.untilUndoLabel('Undo Change Keyframe Easing')
  const eased = await driver.savedProject('eased.json')
  await driver.rightClickAt({ x: first.x + 1, y: first.y + VOLUME_POINT_AT_UNITY })
  await driver.page.click('menu-keyframe-delete')
  await driver.untilUndoLabel('Undo Delete Volume Keyframe')
  const deleted = await driver.savedProject('deleted.json')

  const early = await driver.timelinePoint(second / 2, 0, 1)
  await driver.doubleClickAt({ x: early.x, y: early.y + NEAR_TOP_OF_SOUND })
  await driver.untilUndoLabel('Undo Add Volume Keyframe')
  const pointAdded = await driver.savedProject('point-added.json')
  const between = await driver.timelinePoint(second, 0, 1)
  await driver.drag({ x: between.x, y: between.y + NEAR_TOP_OF_SOUND }, { x: between.x, y: between.y + NEAR_TOP_OF_SOUND + LINE_DRAG_PIXELS })
  await driver.untilUndoLabel('Undo Change Volume')
  const lineDragged = await driver.savedProject('line-dragged.json')

  const offersFastSoundAtFirst = await driver.page.evaluate(`${selector('clip-fast-sound')} !== null`)
  await clickOn(driver, 'clip-keep-pitch')
  await driver.untilUndoLabel('Undo Let Pitch Follow Speed')
  await driver.typeInto('clip-speed', '800')
  await driver.untilUndoLabel('Undo Change Speed')
  await driver.until(`${selector('clip-fast-sound')} !== null`, 'the switch for fast sound')
  await clickOn(driver, 'clip-fast-sound')
  await driver.untilUndoLabel('Undo Play Fast Sound')
  return { cursorOverLine, lineVolume, keyed, cursorOverPoint, dragged, eased, deleted, pointAdded, lineDragged, offersFastSoundAtFirst, fast: await driver.savedProject('fast.json') }
}

async function testKeyframes(driver: Driver): Promise<UiTestReport> {
  const second = TICKS_PER_SECOND
  await fullQualityFrame(driver, 0)
  await driver.clickAt(await driver.timelinePoint(second / 2, 0, 1))
  await driver.until(`${selector('clip-position-keyframe')} !== null`, 'the clip to be selected')

  await clickOn(driver, 'clip-position-keyframe')
  await driver.untilUndoLabel('Undo Add Position Keyframe')
  const keyed = await driver.savedProject('keyed.json')
  const isPositionPressed = await isPressed(driver, 'clip-position-keyframe')

  await seekOnRuler(driver, second, '00:00:01:00')
  await driver.drag(await onCanvas(driver, 320, 180), await onCanvas(driver, 420, 230))
  await driver.untilUndoLabel('Undo Move Clip')
  await driver.until(`${selector('motion-path')}?.dataset.dots === '2'`, 'a motion path with two dots')
  const moved = await driver.savedProject('moved.json')

  await driver.drag(centerOf(await driver.rect('path-point-0')), await onCanvas(driver, 200, 120))
  await driver.untilUndoLabel('Undo Move Position Keyframe')
  const dotMoved = await driver.savedProject('dot-moved.json')
  await driver.picture('motion-path')

  await clickOn(driver, 'clip-position-previous-keyframe')
  await untilTimecode(driver, '00:00:00:00')
  await clickOn(driver, 'clip-position-next-keyframe')
  await untilTimecode(driver, '00:00:01:00')

  await clickOn(driver, 'clip-scale-keyframe')
  await driver.untilUndoLabel('Undo Add Size Keyframe')
  const isSizePressed = await isPressed(driver, 'clip-size-keyframe')
  const sized = await driver.savedProject('sized.json')

  await seekOnRuler(driver, 1.5 * second, '00:00:01:15')
  await driver.typeInto('clip-x', '500')
  await driver.untilUndoLabel('Undo Move Clip')
  const typed = await driver.savedProject('typed.json')
  await clickOn(driver, 'clip-position-keyframe')
  await driver.untilUndoLabel('Undo Remove Position Keyframe')
  const removed = await driver.savedProject('removed.json')

  await seekOnRuler(driver, second / 2, '00:00:00:15')
  const diamond = await driver.timelinePoint(second, 0, 1)
  await driver.clickAt({ x: diamond.x, y: diamond.y - DIAMOND_FROM_ROW_MIDDLE })
  await untilTimecode(driver, '00:00:01:00')
  const jumpedTo = await playheadTime(driver)

  const ruler = (await driver.rect('timeline')).y + RULER_HEIGHT / 2
  async function scrubNear(time: number, pixels: number, modifiers: readonly ('meta' | 'shift')[] = []): Promise<number> {
    await seekOnRuler(driver, second / 2, '00:00:00:15')
    const from = await driver.timelinePoint(second / 2, 0, 1)
    const to = await driver.timelinePoint(time, 0, 1)
    await driver.drag({ x: from.x, y: ruler }, { x: to.x + pixels, y: ruler }, modifiers)
    await driver.until(`${selector('timecode')}.textContent !== '00:00:00:15'`, 'the playhead to move')
    return playheadTime(driver)
  }
  const snappedToKeyframe = await scrubNear(second, NEAR_SNAP_PIXELS)
  const snappedToEnd = await scrubNear(2 * second, -NEAR_SNAP_PIXELS)
  const freeOfSnapping = await scrubNear(second, NEAR_SNAP_PIXELS, ['meta'])
  return { keyed, isPositionPressed, moved, dotMoved, isSizePressed, sized, typed, removed, jumpedTo, snappedToKeyframe, snappedToEnd, freeOfSnapping }
}

const FAR_SEEK_SECONDS = [200, 350, 500, 120, 420]
const NEAR_SEEK_SECONDS = [1, 3, 4, 2, 1.5, 3.5, 0.5]
const SPACE_PASSES = 5
const PLAY_WATCH_MS = 300
const DRAG_PASSES = 4
const DRAG_PIXELS = 150
const LONG_CLIP_START_SECONDS = 10
const PREPARE_TIMEOUT_MS = 120_000

export async function framesShown(driver: Driver): Promise<number> {
  return Number(await driver.page.evaluate(`${selector('timecode')}.dataset.frames`))
}

export async function seekDelays(driver: Driver, positions: readonly number[]): Promise<number[]> {
  const ruler = await driver.rect('timeline')
  const delays: number[] = []
  for (const seconds of positions) {
    const at = await driver.timelinePoint(seconds * TICKS_PER_SECOND, 0, 1)
    const sinceFrames = await framesShown(driver)
    delays.push(await delayUntilShown(driver, { event: 'pointerdown', shown: 'any frame' }, () => driver.clickAt({ x: at.x, y: ruler.y + RULER_HEIGHT / 2 })))
    await fullQualityFrame(driver, sinceFrames)
  }
  return delays
}

async function watchTimelineDrags(driver: Driver): Promise<{ read(): Promise<number[]> }> {
  await driver.page.evaluate(`(() => {
    window.timelineDelays = []
    let movedAt
    ${selector('timeline')}.addEventListener('pointermove', (event) => {
      if (event.buttons === 0 || movedAt !== undefined) return
      movedAt = performance.now()
      requestAnimationFrame(() => {
        const channel = new MessageChannel()
        channel.port1.onmessage = () => {
          window.timelineDelays.push(performance.now() - movedAt)
          movedAt = undefined
        }
        channel.port2.postMessage(undefined)
      })
    }, true)
  })()`)
  return { read: async () => numbersIn(await driver.page.evaluate('window.timelineDelays')) }
}

async function testResponsiveness(driver: Driver): Promise<UiTestReport> {
  await driver.until(`Number(${selector('timecode')}?.dataset.frames ?? 0) > 0 && ${selector('timeline')}?.dataset.view !== undefined`, 'the project to be shown')
  const launchSeconds = process.uptime()
  const longTasks = await watchLongTasks(driver)
  await fullQualityFrame(driver, 0)

  const uncachedSeeks = await seekDelays(driver, FAR_SEEK_SECONDS)
  await driver.until(`${selector('media-1080p.mp4')}?.querySelector('.badge.warning') === null`, 'the short clip to be prepared', PREPARE_TIMEOUT_MS)
  const cachedSeeks = await seekDelays(driver, NEAR_SEEK_SECONDS)

  const spaceDelays: number[] = []
  for (let pass = 0; pass < SPACE_PASSES; pass++) {
    spaceDelays.push(await delayUntilShown(driver, { event: 'keydown', shown: 'another timecode' }, () => driver.press('Space')))
    await sleep(PLAY_WATCH_MS)
    const sinceFrames = await framesShown(driver)
    await driver.press('Space')
    await driver.until(`${selector('play')}.getAttribute('aria-label') === 'Play'`, 'Space to pause')
    await fullQualityFrame(driver, sinceFrames)
  }

  const drags = await watchTimelineDrags(driver)
  const start = await driver.timelinePoint(LONG_CLIP_START_SECONDS * TICKS_PER_SECOND, 0, 1)
  await driver.drag({ x: start.x + 2, y: start.y }, { x: start.x + DRAG_PIXELS, y: start.y })
  await driver.untilUndoLabel('Undo Trim Clip')
  const grab = await driver.timelinePoint(300 * TICKS_PER_SECOND, 0, 1)
  for (let pass = 0; pass < DRAG_PASSES; pass++) {
    const from = { x: grab.x + pass * DRAG_PIXELS, y: grab.y }
    await driver.drag(from, { x: from.x + DRAG_PIXELS, y: from.y })
    await driver.untilUndoLabel('Undo Move Clip')
  }
  const timelineDelays = await drags.read()

  const undoMilliseconds = await delayUntilShown(driver, { shown: 'any frame' }, () => driver.menu('undo'))
  await driver.untilRedoLabel('Redo Move Clip')
  const redoMilliseconds = await delayUntilShown(driver, { shown: 'any frame' }, () => driver.menu('redo'))

  const tasks = await longTasks.read()
  return {
    launchSeconds,
    uncachedSeekP95: percentile(uncachedSeeks, P95),
    cachedSeekP95: percentile(cachedSeeks, P95),
    spaceToMotionP95: percentile(spaceDelays, P95),
    timelineDragSamples: timelineDelays.length,
    timelineDragP95: percentile(timelineDelays, P95),
    undoMilliseconds,
    redoMilliseconds,
    longestTaskMs: Math.max(0, ...tasks),
  }
}

const IDLE_SETTLE_MS = 3000
const IDLE_WATCH_SECONDS = 10
const PERCENT = 100

async function testIdle(driver: Driver): Promise<UiTestReport> {
  await fullQualityFrame(driver, 0)
  await untilPrepared(driver)
  await sleep(IDLE_SETTLE_MS)
  const secondsBefore = await cpuSecondsOf(process.pid)
  await sleep(IDLE_WATCH_SECONDS * MS_PER_SECOND)
  const secondsAfter = await cpuSecondsOf(process.pid)
  return { cpuPercent: ((secondsAfter - secondsBefore) / IDLE_WATCH_SECONDS) * PERCENT }
}

const OPERABLE_ROLES = new Set(['button', 'checkbox', 'radio', 'textbox', 'searchbox', 'combobox', 'slider', 'spinbutton', 'tab', 'option', 'menuitem', 'listbox', 'switch', 'separator'])
const MAX_TAB_STOPS = 400

type AxValue = { value?: unknown }
type AxProperty = { name: string; value: AxValue }
type AxNode = { ignored: boolean; role?: AxValue; name?: AxValue; properties?: AxProperty[]; backendDOMNodeId?: number }

function isAxNode(value: unknown): value is AxNode {
  return typeof value === 'object' && value !== null && 'ignored' in value
}

function axNodesOf(answer: unknown): AxNode[] {
  if (typeof answer !== 'object' || answer === null || !('nodes' in answer) || !Array.isArray(answer.nodes)) return []
  return answer.nodes.filter(isAxNode)
}

function isOperable(node: AxNode): boolean {
  const role = String(node.role?.value ?? '')
  if (!OPERABLE_ROLES.has(role)) return false
  if (role !== 'separator') return true
  return node.properties?.some((property) => property.name === 'focusable' && property.value.value === true) === true
}

async function describeNode(driver: Driver, backendNodeId: number | undefined): Promise<string> {
  if (backendNodeId === undefined) return 'a node outside the page'
  const described: unknown = await driver.window.webContents.debugger.sendCommand('DOM.describeNode', { backendNodeId })
  const node = typeof described === 'object' && described !== null && 'node' in described ? described.node : undefined
  if (typeof node !== 'object' || node === null || !('attributes' in node) || !Array.isArray(node.attributes)) return 'an unknown node'
  const attributes = node.attributes.map(String)
  const valueOf = (name: string): string | undefined => {
    const index = attributes.indexOf(name)
    return index === -1 ? undefined : attributes[index + 1]
  }
  const name = 'localName' in node ? String(node.localName) : 'element'
  return valueOf('data-testid') ?? `${name}.${valueOf('class') ?? ''}`
}

async function unnamedControls(driver: Driver): Promise<string[]> {
  const cdp = driver.window.webContents.debugger
  await cdp.sendCommand('DOM.enable')
  await cdp.sendCommand('Accessibility.enable')
  const unnamed: string[] = []
  for (const node of axNodesOf(await cdp.sendCommand('Accessibility.getFullAXTree'))) {
    if (node.ignored || !isOperable(node)) continue
    if (String(node.name?.value ?? '').trim() !== '') continue
    unnamed.push(`${String(node.role?.value)} ${await describeNode(driver, node.backendDOMNodeId)}`)
  }
  return unnamed
}

type TabStop = {
  id: string
  region: string
  hasRing: boolean
}

function isTabStop(value: unknown): value is TabStop {
  return typeof value === 'object' && value !== null && 'id' in value && 'region' in value && 'hasRing' in value
}

async function tabStops(driver: Driver): Promise<TabStop[]> {
  const stops: TabStop[] = []
  for (let press = 0; press < MAX_TAB_STOPS; press++) {
    await driver.press('Tab')
    const stop: unknown = await driver.page.evaluate(`(() => {
      const element = document.activeElement
      if (element === null || element === document.body) return { id: 'body', region: '', hasRing: false }
      const style = getComputedStyle(element)
      const hasOutline = style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0
      const label = element.dataset.testid ?? element.getAttribute('aria-label') ?? element.textContent?.trim().slice(0, 30) ?? element.localName
      const panel = element.closest('aside, main, [data-testid="timeline-panel"]')
      const region = element.closest('dialog') === null ? panel?.getAttribute('aria-label') ?? 'window' : 'dialog'
      return { id: label, region, hasRing: hasOutline || style.boxShadow !== 'none' }
    })()`)
    if (!isTabStop(stop)) throw new PageError('Could not read where the focus is')
    if (stops.length > 0 && stop.id === stops[0]?.id && stop.region === stops[0]?.region) return stops
    stops.push(stop)
  }
  return stops
}

function regionsOf(stops: readonly TabStop[]): string[] {
  return [...new Set(stops.map((stop) => stop.region))].sort()
}

function withoutRing(stops: readonly TabStop[]): string[] {
  return stops.filter((stop) => !stop.hasRing).map((stop) => `${stop.region}: ${stop.id}`)
}

async function testAccessibility(driver: Driver): Promise<UiTestReport> {
  await fullQualityFrame(driver, 0)
  const unnamed = new Set(await unnamedControls(driver))
  const project = await driver.savedProject('accessibility.json')
  const tracks = isProjectLike(project) ? project.tracks : []
  const seenKinds = new Set<string>()
  for (const [index, track] of tracks.entries()) {
    const clip = track.clips[0]
    if (clip === undefined || seenKinds.has(clip.type)) continue
    seenKinds.add(clip.type)
    await driver.press('Escape')
    await driver.until(`${selector('canvas-width')} !== null`, 'the selection to be let go')
    await driver.clickAt(await rowInView(driver, clip.start + clip.duration / 2, index, tracks.length))
    await driver.until(`${selector('canvas-width')} === null`, `the ${clip.type} clip on track ${index + 1} to be selected`)
    for (const control of await unnamedControls(driver)) unnamed.add(control)
  }

  const windowStops = await tabStops(driver)

  driver.menu('export')
  await driver.until(`document.querySelector('dialog[open]') !== null`, 'the Export dialog')
  for (const control of await unnamedControls(driver)) unnamed.add(control)
  const exportStops = await tabStops(driver)
  await driver.press('Escape')
  await driver.until(`document.querySelector('dialog[open]') === null`, 'Escape to close the Export dialog')

  driver.menu('settings')
  await driver.until(`document.querySelector('dialog[open]') !== null`, 'the Settings dialog')
  for (const control of await unnamedControls(driver)) unnamed.add(control)
  const settingsStops = await tabStops(driver)
  await driver.press('Escape')
  await driver.until(`document.querySelector('dialog[open]') === null`, 'Escape to close Settings')

  return {
    unnamed: [...unnamed].sort(),
    windowRegions: regionsOf(windowStops),
    windowStopCount: windowStops.length,
    exportRegions: regionsOf(exportStops),
    settingsRegions: regionsOf(settingsStops),
    withoutRing: [...withoutRing(windowStops), ...withoutRing(exportStops), ...withoutRing(settingsStops)],
  }
}

type ClipPlace = { type: string; start: number; duration: number }

const ROW_SCROLL_PIXELS = 40
const MAX_ROW_SCROLLS = 50

export async function rowInView(driver: Driver, time: number, trackIndex: number, trackCount: number): Promise<Point> {
  const area = await driver.rect('timeline')
  const lowest = area.y + RULER_HEIGHT + CAMERA_LANE_HEIGHT + TRACK_HEIGHT / 2
  const highest = area.y + area.height - TRACK_HEIGHT / 2
  for (let scroll = 0; scroll < MAX_ROW_SCROLLS; scroll++) {
    const point = await driver.timelinePoint(time, trackIndex, trackCount)
    if (point.y >= lowest && point.y <= highest) return point
    // Electron's wheel input counts the other way from the page: a negative delta scrolls the tracks up.
    await driver.scrollAt(centerOf(area), 0, point.y > highest ? -ROW_SCROLL_PIXELS : ROW_SCROLL_PIXELS, false)
  }
  throw new PageError(`Track ${trackIndex + 1} could not be scrolled into view`)
}

function isProjectLike(value: unknown): value is { tracks: { clips: ClipPlace[] }[] } {
  return typeof value === 'object' && value !== null && 'tracks' in value && Array.isArray(value.tracks)
}

const LONG_STEP_TIMEOUT_MS = 120_000

async function testBrokenMedia(driver: Driver): Promise<UiTestReport> {
  const { mediaDirectory } = driver.options
  if (mediaDirectory === undefined) throw new PageError('This UI test needs --media <directory>')
  const names = (await readdir(mediaDirectory)).filter((name) => name.startsWith('broken-')).sort()
  driver.options.answers.importMedia = names.map((name) => mediaFile(driver, name))
  driver.menu('import')
  await driver.until(`${selector('notice')} !== null && ${selector('media-pending')} === null`, 'every broken file to be read', LONG_STEP_TIMEOUT_MS)
  const notice = await driver.page.text('notice')
  const listed = names.filter((name) => notice.includes(`"${name}"`) === false)
  const listedShown: unknown = await driver.page.evaluate(`${JSON.stringify(listed)}.filter((name) => document.querySelector('[data-testid="media-' + name + '"]') !== null)`)

  driver.options.answers.importMedia = [mediaFile(driver, 'h264.mp4')]
  driver.menu('import')
  await driver.until(`Boolean(${selector('media-h264.mp4')}?.querySelector('.library-poster'))`, 'the good file after the broken ones')
  await dragMedia(driver, 'h264.mp4', await driver.timelinePoint(0, 0, 6))
  await driver.untilUndoLabel('Undo Add Clip')
  await driver.press('Space')
  await sleep(MS_PER_SECOND)
  await driver.press('Space')
  await driver.until(`${selector('play')}.getAttribute('aria-label') === 'Play'`, 'playback to pause')
  return { names, notice, listed, listedShown, timecodeAfterPlaying: await driver.page.text('timecode') }
}

const SOAK_MEDIA = ['h264.mp4', '1080p.mp4', 'audio.wav', 'audio.mp3', 'image.jpg', 'animated.gif']
const SOAK_ACTIONS = ['place', 'place', 'move', 'move', 'trim', 'split', 'text', 'opacity', 'undo', 'undo', 'redo', 'play', 'scrub', 'save'] as const
const SOAK_TIMELINE_SECONDS = 20
const SOAK_MAX_CLIPS = 40
const SOAK_SAMPLE_INTERVAL_MS = 60_000
const SOAK_EXPORT_INTERVAL_MS = 20 * 60_000
const SOAK_EXPORT_TIMEOUT_MS = 10 * 60_000
const SOAK_STEP_LIMIT_MS = 15 * 60_000
const SOAK_LOG_LENGTH = 200
const SOAK_PLAY_MS = 2000
const SOAK_SETTLE_MS = 100
const MAX_UNDO_RUN = 5
const MAX_DRAG_PIXELS = 120
const MIN_TRIM_PIXELS = 10
const MAX_TRIM_PIXELS = 60
const MIN_OPACITY = 10
const BYTES_PER_MEGABYTE = 1024 * 1024
const MS_PER_MINUTE = 60_000

type SoakAction = (typeof SOAK_ACTIONS)[number]

type SoakClip = ClipPlace & { trackIndex: number }

function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 2 ** 32
  }
}

async function withinTime<T>(work: Promise<T>, limitMs: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const limit = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new PageError(`${what} took longer than ${limitMs / MS_PER_SECOND} s`)), limitMs)
  })
  try {
    return await Promise.race([work, limit])
  } finally {
    clearTimeout(timer)
  }
}

type Soak = {
  driver: Driver
  random(): number
}

function pickOf<T>(soak: Soak, items: readonly T[]): T | undefined {
  return items[Math.floor(soak.random() * items.length)]
}

async function soakClips(soak: Soak): Promise<{ clips: SoakClip[]; trackCount: number }> {
  const project = await soak.driver.savedProject('soak.json')
  if (!isProjectLike(project)) throw new PageError('The saved project has no tracks')
  const clips: SoakClip[] = []
  for (const [trackIndex, track] of project.tracks.entries()) {
    for (const clip of track.clips) clips.push({ ...clip, trackIndex })
  }
  return { clips, trackCount: project.tracks.length }
}

async function soakClipPoint(soak: Soak, clip: SoakClip, trackCount: number, share: number): Promise<Point> {
  const point = await rowInView(soak.driver, clip.start + clip.duration * share, clip.trackIndex, trackCount)
  return clearOfVolumeLine(point)
}

async function soakPlace(soak: Soak): Promise<void> {
  const { driver } = soak
  await driver.page.click('tab-media')
  const tracks = Number(await trackCount(driver))
  const time = soak.random() * SOAK_TIMELINE_SECONDS * TICKS_PER_SECOND
  const target = tracks === 0 ? centerOf(await driver.rect('timeline')) : await rowInView(driver, time, Math.floor(soak.random() * tracks), tracks)
  await dragMedia(driver, pickOf(soak, SOAK_MEDIA) ?? 'h264.mp4', target)
}

async function soakMove(soak: Soak): Promise<void> {
  const { clips, trackCount: tracks } = await soakClips(soak)
  const clip = pickOf(soak, clips)
  if (clip === undefined) return
  const from = await soakClipPoint(soak, clip, tracks, 0.5)
  await soak.driver.drag(from, { x: from.x + (soak.random() * 2 - 1) * MAX_DRAG_PIXELS, y: from.y })
}

async function soakTrim(soak: Soak): Promise<void> {
  const { clips, trackCount: tracks } = await soakClips(soak)
  const clip = pickOf(soak, clips)
  if (clip === undefined) return
  const end = await soakClipPoint(soak, clip, tracks, 1)
  const pixels = MIN_TRIM_PIXELS + soak.random() * (MAX_TRIM_PIXELS - MIN_TRIM_PIXELS)
  await soak.driver.drag({ x: end.x - 2, y: end.y }, { x: end.x - pixels, y: end.y })
}

async function soakSelect(soak: Soak, clip: SoakClip, trackCount: number): Promise<void> {
  await soak.driver.clickAt(await soakClipPoint(soak, clip, trackCount, 0.5))
}

async function soakSplit(soak: Soak): Promise<void> {
  const { clips, trackCount: tracks } = await soakClips(soak)
  const clip = pickOf(soak, clips)
  if (clip === undefined) return
  await soakScrubTo(soak, clip.start + clip.duration * (0.2 + soak.random() * 0.6))
  await soakSelect(soak, clip, tracks)
  soak.driver.menu('split')
}

async function soakText(soak: Soak): Promise<void> {
  const { driver } = soak
  await driver.page.click('tab-annotations')
  const picture = await driver.rect('preview')
  const drop = { x: picture.x + picture.width * (0.2 + soak.random() * 0.6), y: picture.y + picture.height * (0.2 + soak.random() * 0.6) }
  await driver.drag(centerOf(await driver.rect('annotation-text')), drop)
  await untilTextEditor(driver, true)
  await driver.typeKeys('Soak')
  await driver.press('Escape')
  await untilTextEditor(driver, false)
  await driver.page.click('tab-media')
}

async function soakOpacity(soak: Soak): Promise<void> {
  const { clips, trackCount: tracks } = await soakClips(soak)
  const clip = pickOf(soak, clips.filter((each) => each.type !== 'audio'))
  if (clip === undefined) return
  await soakSelect(soak, clip, tracks)
  await soak.driver.until(`${selector('clip-opacity')} !== null`, 'the opacity of the clip')
  await soak.driver.typeInto('clip-opacity', String(Math.round(MIN_OPACITY + soak.random() * (100 - MIN_OPACITY))))
}

async function soakHistory(soak: Soak, action: 'undo' | 'redo'): Promise<void> {
  const steps = 1 + Math.floor(soak.random() * MAX_UNDO_RUN)
  for (let step = 0; step < steps; step++) {
    soak.driver.menu(action)
    await sleep(SOAK_SETTLE_MS)
  }
}

async function soakPlay(soak: Soak): Promise<void> {
  const { driver } = soak
  if (!(await isPlaying(driver))) await driver.press('Space')
  await sleep(SOAK_PLAY_MS)
  if (await isPlaying(driver)) await driver.press('Space')
  await driver.until(`${selector('play')}.getAttribute('aria-label') === 'Play'`, 'playback to pause')
}

async function soakScrubTo(soak: Soak, time: number): Promise<void> {
  const ruler = await soak.driver.rect('timeline')
  const at = await soak.driver.timelinePoint(time, 0, 1)
  await soak.driver.clickAt({ x: at.x, y: ruler.y + RULER_HEIGHT / 2 })
}

async function soakExport(soak: Soak): Promise<void> {
  const { driver } = soak
  if ((await driver.page.evaluate(`${selector('export')}.disabled`)) === true) return
  await openExportDialog(driver)
  await startExport(driver, { fileName: 'soak.mp4', preset: '120p', quality: 'low', hasAudio: true })
  await untilExported(driver, 'soak.mp4', SOAK_EXPORT_TIMEOUT_MS)
}

async function soakTrimProject(soak: Soak): Promise<void> {
  const { clips } = await soakClips(soak)
  if (clips.length <= SOAK_MAX_CLIPS) return
  soak.driver.menu('select-all')
  await sleep(SOAK_SETTLE_MS)
  await soak.driver.press('Backspace')
}

async function runSoakAction(soak: Soak, action: SoakAction): Promise<void> {
  switch (action) {
    case 'place':
      return soakPlace(soak)
    case 'move':
      return soakMove(soak)
    case 'trim':
      return soakTrim(soak)
    case 'split':
      return soakSplit(soak)
    case 'text':
      return soakText(soak)
    case 'opacity':
      return soakOpacity(soak)
    case 'undo':
    case 'redo':
      return soakHistory(soak, action)
    case 'play':
      return soakPlay(soak)
    case 'scrub':
      return soakScrubTo(soak, soak.random() * SOAK_TIMELINE_SECONDS * TICKS_PER_SECOND)
    case 'save':
      await soakClips(soak)
  }
}

async function settleSoak(soak: Soak): Promise<void> {
  const { driver } = soak
  if ((await driver.page.evaluate(`${selector('text-editor')} !== null || document.querySelector('dialog[open], .options') !== null`)) === true) await driver.press('Escape')
  await driver.page.click('timeline-zoom-fit')
  await sleep(SOAK_SETTLE_MS)
}

async function testSoak(driver: Driver): Promise<UiTestReport> {
  const seconds = driver.options.seconds
  if (seconds === undefined) throw new PageError('This UI test needs --seconds <how long to run>')
  const seed = driver.options.seed ?? Date.now() % 2 ** 31
  const soak: Soak = { driver, random: seededRandom(seed) }
  driver.options.answers.importMedia = SOAK_MEDIA.map((name) => mediaFile(driver, name))
  driver.menu('import')
  await driver.until(SOAK_MEDIA.map((name) => `Boolean(${selector(`media-${name}`)}?.querySelector('.library-poster, .icon'))`).join(' && '), 'the media of the session')

  const startedAt = Date.now()
  const endsAt = startedAt + seconds * MS_PER_SECOND
  const memory: { minute: number; megabytes: number }[] = []
  const counts: Record<string, number> = {}
  const log: string[] = []
  let sampledAt = 0
  let exportedAt = startedAt
  try {
    while (Date.now() < endsAt) {
      const now = Date.now()
      let action: SoakAction | 'export' = pickOf(soak, SOAK_ACTIONS) ?? 'save'
      if (now - exportedAt >= SOAK_EXPORT_INTERVAL_MS) {
        action = 'export'
        exportedAt = now
      }
      log.push(`${Math.round((now - startedAt) / MS_PER_SECOND)} s ${action}`)
      if (log.length > SOAK_LOG_LENGTH) log.shift()
      counts[action] = (counts[action] ?? 0) + 1
      await withinTime(action === 'export' ? soakExport(soak) : runSoakAction(soak, action), SOAK_STEP_LIMIT_MS, action)
      await withinTime(settleSoak(soak), SOAK_STEP_LIMIT_MS, 'settling')
      await withinTime(soakTrimProject(soak), SOAK_STEP_LIMIT_MS, 'clearing the timeline')
      if (now - sampledAt >= SOAK_SAMPLE_INTERVAL_MS) {
        sampledAt = now
        memory.push({ minute: Math.round((now - startedAt) / MS_PER_MINUTE), megabytes: Math.round((await footprintNow(process.pid)) / BYTES_PER_MEGABYTE) })
      }
    }
  } catch (error) {
    throw new PageError(`The session failed after ${Math.round((Date.now() - startedAt) / MS_PER_SECOND)} s (seed ${seed}): ${describeError(error)}\nLast steps:\n${log.join('\n')}`)
  }
  return { seed, seconds, counts, memory }
}

export async function splitFirstTrackAtOneSecond(driver: Driver, trackCount: number): Promise<void> {
  const second = TICKS_PER_SECOND
  const ruler = await driver.rect('timeline')
  const oneSecond = await driver.timelinePoint(second, 0, trackCount)
  await driver.clickAt({ x: oneSecond.x, y: ruler.y + RULER_HEIGHT / 2 })
  await driver.until(`${selector('timecode')}.textContent === '00:00:01:00'`, 'the playhead at one second')
  await driver.clickAt(await driver.timelinePoint(second / 2, 0, trackCount))
  await driver.page.click('split')
  await driver.untilUndoLabel('Undo Split Clip')
}

function selectedFiles(driver: Driver): Promise<unknown> {
  return driver.page.evaluate(`[...document.querySelectorAll('.library-item.selected')].map((item) => item.dataset.testid)`)
}

async function testQuickEdits(driver: Driver): Promise<UiTestReport> {
  const second = TICKS_PER_SECOND
  const startingTracks = await driver.page.evaluate(`document.querySelectorAll('[data-testid^="track-name-"]').length`)
  await importThreeFiles(driver)

  const library = await driver.rect('left-sidebar')
  const firstFile = await driver.rect('media-h264.mp4')
  await driver.drag({ x: library.x + library.width - 6, y: library.y + library.height - 12 }, { x: firstFile.x + 2, y: firstFile.y + 2 })
  const pickedByBox = await selectedFiles(driver)

  await driver.clickAt(centerOf(await driver.rect('media-audio.wav')))
  driver.menu('select-all')
  await driver.until(`document.querySelectorAll('.library-item.selected').length === 3`, 'Select All to pick every file')
  const pickedBySelectAll = await selectedFiles(driver)

  const onTrackOne = await driver.timelinePoint(0, 0, 6)
  await driver.drag(centerOf(await driver.rect('media-audio.wav')), onTrackOne)
  await driver.untilUndoLabel('Undo Add 3 Clips')
  const dropped = await driver.savedProject('quick-dropped.json')
  await driver.clickAt(await driver.timelinePoint(30 * second, 3, 6))
  driver.menu('select-all')
  await driver.until(`${selector('canvas-overlay')}.dataset.selected === '1'`, 'Select All to pick the clips')
  const filesAfterClipSelectAll = await selectedFiles(driver)

  await splitFirstTrackAtOneSecond(driver, 6)
  const startAfterSplit = await driver.value('clip-start')

  await driver.rightClickAt(await driver.timelinePoint(1.5 * second, 0, 6))
  await driver.until(`${selector('menu-speed')} !== null`, 'the clip menu')
  await driver.page.click('menu-speed')
  await driver.until(`${selector('speed-dialog')}?.open === true`, 'the speed dialog')
  const speedShown = await driver.value('speed-value')
  await driver.typeInto('speed-value', '200')
  await driver.untilUndoLabel('Undo Change Speed')
  await driver.until(`${selector('speed-dialog')} === null`, 'the speed dialog to close')
  const typedSpeed = await driver.savedProject('quick-speed-typed.json')
  await driver.rightClickAt(await driver.timelinePoint(1.2 * second, 0, 6))
  await driver.until(`${selector('menu-speed')} !== null`, 'the clip menu')
  await driver.page.click('menu-speed')
  await driver.until(`${selector('speed-dialog')}?.open === true`, 'the speed dialog')
  const speedShownAgain = await driver.value('speed-value')
  await driver.page.evaluate(`${selector('speed-value')}.select()`)
  await driver.typeKeys('50')
  await driver.press('Escape')
  await driver.until(`${selector('speed-dialog')} === null`, 'the speed dialog to close')
  const undoAfterEscape = driver.menuLabel('undo')
  const escapedSpeed = await driver.savedProject('quick-speed-escaped.json')

  const canvasWidth = 320
  await pick(driver, 'canvas-zoom', '50')
  const ruler = await driver.rect('timeline')
  await driver.clickAt({ x: (await driver.timelinePoint(second / 2, 0, 6)).x, y: ruler.y + RULER_HEIGHT / 2 })
  await driver.until(`${selector('timecode')}.textContent === '00:00:00:15'`, 'the playhead at half a second')
  await driver.clickAt(await driver.timelinePoint(second / 2, 0, 6))
  await driver.typeInto('clip-x', '-100')
  await driver.untilUndoLabel('Undo Move Clip')
  await driver.press('Escape')
  await driver.until(`${selector('canvas-overlay')}.dataset.selected === '0'`, 'nothing selected')
  const outlinedOutside = await driver.page.evaluate(`${selector('canvas-overlay')}.dataset.outside`)
  await driver.picture('quick-edits-outside')
  const offCanvas = await canvasPoint(driver, canvasWidth, { x: -200, y: 90 })
  await driver.clickAt(offCanvas)
  await driver.until(`${selector('canvas-overlay')}.dataset.selected === '1'`, 'the clip off the canvas to be picked')
  await driver.drag(offCanvas, await canvasPoint(driver, canvasWidth, { x: 60, y: 90 }))
  await driver.untilUndoLabel('Undo Move Clip')
  const xDraggedBack = await driver.value('clip-x')
  const outlinedAfter = await driver.page.evaluate(`${selector('canvas-overlay')}.dataset.outside`)
  return {
    startingTracks,
    pickedByBox,
    pickedBySelectAll,
    dropped,
    filesAfterClipSelectAll,
    startAfterSplit,
    speedShown,
    typedSpeed,
    speedShownAgain,
    undoAfterEscape,
    escapedSpeed,
    outlinedOutside,
    xDraggedBack,
    outlinedAfter,
  }
}

const TIMELINE_VIEW = `JSON.parse(${selector('timeline')}.dataset.view)`

async function testTimelineScroll(driver: Driver): Promise<UiTestReport> {
  await fullQualityFrame(driver, 0)
  for (let step = 0; step < 6; step++) await driver.page.click('timeline-zoom-in')
  await driver.until(`${selector('timeline-scrollbar')}.scrollWidth > ${selector('timeline-scrollbar')}.clientWidth + 200`, 'the timeline to be wider than its view')

  await driver.page.evaluate(`${selector('timeline-scrollbar')}.scrollLeft = 120`)
  await driver.until(`${TIMELINE_VIEW}.scrollX === 120`, 'the scroll bar to scroll the timeline')
  const scrolledByBar = await driver.page.evaluate(`${TIMELINE_VIEW}.scrollX`)

  const from = await driver.timelinePoint(0, 0, 1)
  const start = { x: Math.round(from.x + 300), y: Math.round(from.y) }
  const { webContents } = driver.window
  webContents.sendInputEvent({ type: 'mouseDown', x: start.x, y: start.y, button: 'middle', clickCount: 1 })
  for (let step = 1; step <= 4; step++) webContents.sendInputEvent({ type: 'mouseMove', x: start.x - step * 20, y: start.y, button: 'middle', modifiers: ['middlebuttondown'] })
  webContents.sendInputEvent({ type: 'mouseUp', x: start.x - 80, y: start.y, button: 'middle', clickCount: 1 })
  await driver.until(`${TIMELINE_VIEW}.scrollX === 200`, 'the middle button to drag the view')
  await driver.until(`${selector('timeline-scrollbar')}.scrollLeft === 200`, 'the scroll bar to follow')
  const undoAfterScrolling = driver.menuLabel('undo')

  await driver.page.click('tab-media')
  await clickOn(driver, 'media-h264.mp4')
  await driver.press('Delete')
  await driver.untilUndoLabel('Undo Remove File')
  const removed = await driver.savedProject('removed.json')
  driver.menu('undo')
  await driver.until(`${selector('media-h264.mp4')} !== null`, 'Undo to bring the file back')
  return { scrolledByBar, undoAfterScrolling, removed, restored: await driver.savedProject('restored.json') }
}

const SETTINGS_SAVE_TIMEOUT_MS = 5000

async function savedSetting(key: string, expected: unknown): Promise<unknown> {
  const path = join(app.getPath('userData'), 'settings.json')
  const deadline = Date.now() + SETTINGS_SAVE_TIMEOUT_MS
  let found: unknown
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const saved: unknown = JSON.parse(await readFile(path, 'utf8'))
      const record: Record<string, unknown> = typeof saved === 'object' && saved !== null ? { ...saved } : {}
      found = record[key]
      if (found === expected) return found
    }
    await sleep(50)
  }
  return found
}

async function testDebugAndSettings(driver: Driver): Promise<UiTestReport> {
  await importThreeFiles(driver)
  await driver.clickAt(centerOf(await driver.rect('media-h264.mp4')))
  driver.menu('select-all')
  await driver.until(`document.querySelectorAll('.library-item.selected').length === 3`, 'Select All to pick every file')
  await driver.drag(centerOf(await driver.rect('media-h264.mp4')), await driver.timelinePoint(0, 0, 6))
  await driver.untilUndoLabel('Undo Add 3 Clips')

  driver.menu('deselect-all')
  driver.menu('toggle-debug')
  await driver.until(`${selector('debug-text')}?.textContent.startsWith('Playback ') === true`, 'the debug panel with the system info')
  const debugWithoutSelection = await driver.page.text('debug-text')
  await driver.clickAt(await driver.timelinePoint(30 * TICKS_PER_SECOND, 3, 6))
  driver.menu('select-all')
  await driver.until(`${selector('debug-text')}.textContent.includes('Selected 3')`, 'the selected clips in the debug text')
  const debugWithSelection = await driver.page.text('debug-text')

  await driver.typeInto('clip-speed', '200')
  await driver.untilUndoLabel('Undo Change Speed')
  const faster = await driver.savedProject('faster.json')
  driver.menu('toggle-debug')
  await driver.until(`${selector('debug-text')} === null`, 'the debug panel to go')

  const used = `${selector('cache-used')}?.textContent ?? ''`
  driver.menu('settings')
  await driver.until(`${selector('settings-dialog')}?.open === true`, 'the settings')
  await driver.until(`/^Using \\d/.test(${used})`, 'the cache in use')
  const cacheUsed = await driver.page.evaluate(used)
  await clickOn(driver, 'settings-tab-editing')
  await driver.typeInto('setting-snapRangePixels', '20')
  const savedSnapRange = await savedSetting('snapRangePixels', 20)
  await clickOn(driver, 'shortcuts-defaults')
  const restoredSnapRange = await savedSetting('snapRangePixels', 12)
  return { debugWithoutSelection, debugWithSelection, faster, cacheUsed, savedSnapRange, restoredSnapRange }
}

export const FEATURE_SCENARIOS: Record<string, Scenario> = {
  'debug-and-settings': testDebugAndSettings,
  'quick-edits': testQuickEdits,
  'timeline-scroll': testTimelineScroll,
  'broken-media': testBrokenMedia,
  soak: testSoak,
  accessibility: testAccessibility,
  responsiveness: testResponsiveness,
  idle: testIdle,
  annotations: testAnnotations,
  'text-style': testTextStyle,
  'missing-font': testMissingFont,
  animations: testAnimations,
  groups: testGroups,
  sound: testSound,
  shapes: testShapes,
  effects: testEffects,
  transitions: testTransitions,
  zoom: testZoom,
  keyframes: testKeyframes,
  arrange: testArrange,
  'canvas-size': testCanvasSize,
  controls: testControls,
  'controls-kept': testControlsKept,
  tutorial: testTutorial,
  export: testExport,
  relink: testRelink,
  animated: testAnimated,
  text: testText,
  blocks: testBlocks,
  transport: testTransport,
  windows: testWindows,
  preview: testPreview,
  shortcuts: testShortcuts,
}
