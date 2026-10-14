import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { TICKS_PER_SECOND } from '../shared/time.js'
import { PageError, selector } from './page.js'
import {
  CAMERA_LANE_HEIGHT,
  P95,
  POLL_INTERVAL_MS,
  RULER_HEIGHT,
  canvasPoint,
  centerOf,
  dragMedia,
  fullQualityFrame,
  mediaFile,
  numbersIn,
  percentile,
  type Driver,
  type Point,
  type Scenario,
  type UiTestReport,
} from './uiDriver.js'

const SHUTTLE_WATCH_MS = 400
const STEPS_TO_TIME = 20
// Thumbnails and waveforms are fetched after the media is prepared; pictures taken for a person to look at wait for them.
const PICTURES_SETTLE_MS = 1500
// A fade handle rests this far inside its corner of the clip; `timelinePoint` gives the middle of the row.
const HANDLE_INSET = 7
const HANDLE_FROM_ROW_MIDDLE = 19
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

type Shown = 'any frame' | 'another timecode'

// Starts timing from each event of one kind until the preview shows the result; `read` gives the delays collected so far.
// "Any frame" counts every picture drawn; "another timecode" waits for the playhead to be somewhere else.
async function watchDelays(driver: Driver, eventType: string, shown: Shown): Promise<{ read(): Promise<number[]> }> {
  const store = `delays_${eventType}`
  const watched = shown === 'any frame' ? `{ attributes: true, attributeFilter: ['data-frames'] }` : `{ childList: true, characterData: true, subtree: true }`
  await driver.page.evaluate(`(() => {
    window.${store} = []
    let startedAt
    addEventListener('${eventType}', () => { startedAt ??= performance.now() }, true)
    new MutationObserver(() => {
      if (startedAt === undefined) return
      window.${store}.push(performance.now() - startedAt)
      startedAt = undefined
    }).observe(${selector('timecode')}, ${watched})
  })()`)
  return { read: async () => numbersIn(await driver.page.evaluate(`window.${store}`)) }
}

// Prepared media answers from its preview copy, which is what the "cached" budgets are about.
async function untilPrepared(driver: Driver): Promise<void> {
  await driver.until(`document.querySelector('.library-item[data-testid^="media-"]') !== null && document.querySelector('.library-item .badge.warning') === null`, 'the media to be prepared')
}

async function untilTimecode(driver: Driver, timecode: string): Promise<void> {
  await driver.until(`${selector('timecode')}.textContent === '${timecode}'`, `the playhead at ${timecode}`)
}

// Moves through a two-second project with the keyboard alone.
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

// Works on the one clip of a two-second project, a video with sound: fades its picture in and its sound out with the corner handles, then separates the sound.
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

// Sets a form control to a value the way a choice in its picker would, and tells the page about it.
// Sets a control whose own picker belongs to the system, as the colour field's does.
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

// A real press in the middle of a control, which is first brought into view if its panel has scrolled it away.
async function clickOn(driver: Driver, testId: string): Promise<void> {
  await driver.page.evaluate(`(() => {
    ${selector(testId)}.scrollIntoView({ block: 'nearest' })
    return ${ONCE_THE_SCROLL_IS_HEARD}
  })()`)
  await driver.clickAt(centerOf(await driver.rect(testId)))
}

// A press on a drop-down, or on the arrow of a number field, opens its list.
async function openList(driver: Driver, pressed: string, testId: string): Promise<void> {
  await clickOn(driver, pressed)
  await driver.until(isListOpen(testId), `the list of ${testId} to open`)
}

// Where an option of an open list is, scrolled into view first.
async function optionPoint(driver: Driver, testId: string, value: string): Promise<Point> {
  const option = `${testId}-option-${value}`
  await driver.page.evaluate(`${selector(option)}.scrollIntoView({ block: 'nearest' })`)
  return centerOf(await driver.rect(option))
}

// Chooses from a drop-down as a person would: a press opens the list, a click on the option closes it.
async function pick(driver: Driver, testId: string, value: string): Promise<void> {
  await openList(driver, testId, testId)
  await driver.clickAt(await optionPoint(driver, testId, value))
  await driver.until(`!(${isListOpen(testId)})`, `the list of ${testId} to close`)
}

async function untilTextEditor(driver: Driver, isOpen: boolean): Promise<void> {
  const state = isOpen ? 'document.activeElement?.dataset.testid === "text-editor"' : `${selector('text-editor')} === null`
  await driver.until(state, isOpen ? 'the text to open for typing' : 'the text to close')
}

// Starts from an empty project: adds a title from the Annotations tab, types it on the canvas, changes its look in the properties panel.
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
  // The properties panel can show the words before the canvas has drawn them; read too early, the delays are empty.
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

  // Pointing at a font shows the title in it at once. Escape puts the old font back, hands the focus back and leaves no undo step.
  const fontOptions = `document.querySelectorAll('[data-testid="text-font-options"] [role="option"]').length`
  await openList(driver, 'text-font', 'text-font')
  await driver.until(`${fontOptions} > 20`, 'the installed fonts to be listed')
  const fontCount = await driver.page.evaluate(fontOptions)
  const fontDelays = await watchDelays(driver, 'pointermove', 'any frame')
  for (const family of ['Menlo', 'Georgia', 'Courier New', 'Menlo', 'Georgia']) {
    await driver.hover(await optionPoint(driver, 'text-font', family))
    await driver.until(`${selector('text-font')}.value === '${family}'`, `${family} to be shown while pointed at`)
    // The sharper picture that follows a pause must not be taken for the answer to the next move.
    await fullQualityFrame(driver, 0)
  }
  const fontHoverDelays = await fontDelays.read()
  await driver.press('Escape')
  await driver.until(`!(${isListOpen('text-font')})`, 'Escape to close the font list')
  const fontAfterEscape = await driver.value('text-font')
  const focusAfterEscape = await driver.page.evaluate(`document.activeElement?.dataset.testid`)
  const undoLabelAfterEscape = driver.menuLabel('undo')

  // By keyboard: the arrow key opens the list, typing a name finds it, Return keeps it.
  await driver.press('Down')
  await driver.until(isListOpen('text-font'), 'the font list to open from the keyboard')
  await driver.typeKeys('menlo')
  await driver.until(`${selector('text-font')}.value === 'Menlo'`, 'the typed font to be found')
  await driver.press('Return')
  await driver.untilUndoLabel('Undo Change Font')

  // A ready-made size is shown while pointed at and kept with a click.
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

  // Words that are deleted altogether come back when the editing ends.
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

// Imports an animated GIF, places it, stretches it past its own length and switches its loop off and on again.
async function testAnimated(driver: Driver): Promise<UiTestReport> {
  const second = TICKS_PER_SECOND
  driver.options.answers.importMedia = [mediaFile(driver, 'animated.gif')]
  await driver.page.click('import')
  await driver.until(`${selector('media-animated.gif')} !== null`, 'the animated image in the Media tab')

  await dragMedia(driver, 'animated.gif', await driver.timelinePoint(0, 0, 1))
  await driver.untilUndoLabel('Undo Add Clip')
  const placed = await driver.savedProject('placed.json')

  const end = await driver.timelinePoint(5 * second, 0, 1)
  const later = await driver.timelinePoint(8 * second, 0, 1)
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

// Opens a project whose three media files have moved: it says so, refuses a file of the wrong kind, then finds all three from one answer.
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

async function openExportDialog(driver: Driver): Promise<void> {
  await driver.page.click('export')
  await driver.until(`${selector('export-dialog')}?.open === true`, 'the export dialog')
}

type ExportSetup = {
  fileName: string
  preset: string
  quality: 'low' | 'medium' | 'high'
  hasAudio: boolean
}

// Fills in the open export dialog and starts the export with the Return key.
// Starts the export as the dialog stands, saving it under `fileName` in the output folder.
async function submitExport(driver: Driver, fileName: string): Promise<string> {
  if (driver.options.outputDirectory === undefined) throw new PageError('This UI test needs --out <directory>')
  // A save dialog only ever gives a folder that exists.
  await mkdir(driver.options.outputDirectory, { recursive: true })
  const path = join(driver.options.outputDirectory, fileName)
  driver.options.answers.exportPath = path
  await driver.page.evaluate(`${selector('export-start')}.focus()`)
  await driver.press('Return')
  await driver.until(`${selector('export-dialog')} === null`, 'the export dialog to close')
  return path
}

async function startExport(driver: Driver, setup: ExportSetup): Promise<string> {
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

// The dialog that held the window during the export says how it ended; it goes away with a real click on its button, as a person would close it.
async function untilExported(driver: Driver, fileName: string, timeoutMs?: number): Promise<void> {
  await driver.until(`${selector('export-done')} !== null`, `the export of ${fileName} to end`, timeoutMs)
  const result = await driver.page.text('export-title')
  if (result !== `Exported "${fileName}"`) throw new PageError(`${result}: ${String(await driver.page.evaluate(`${selector('export-problem')}?.textContent`))}`)
  await driver.clickAt(centerOf(await driver.rect('export-done')))
  await driver.until(`${selector('export-progress-dialog')} === null`, 'the export dialog to close')
}

// Exports the three-second fades project several ways from the dialog: a range at a lower frame rate without sound, a cancelled one, the whole timeline at two qualities, and one that ends with a reload of the window.
async function testExport(driver: Driver): Promise<UiTestReport> {
  const second = TICKS_PER_SECOND
  await fullQualityFrame(driver, 0)

  // The dialog opens from the menu, every control in it is reached with Tab, and Escape closes it.
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
  // Escape backs out one level at a time: first the open list, then the dialog.
  await driver.picture('export-dialog')
  await openList(driver, 'export-preset', 'export-preset')
  await driver.picture('export-sizes')
  await driver.press('Escape')
  await driver.until(`!(${isListOpen('export-preset')})`, 'Escape to close the list of sizes')
  const isDialogOpenAfterListEscape = (await driver.page.evaluate(`${selector('export-dialog')}?.open === true`)) === true
  await driver.press('Escape')
  await driver.until(`${selector('export-dialog')} === null`, 'Escape to close the dialog')

  // The clip on the middle track runs from 1 s to 3 s; only that stretch is exported, at 25 frames a second, without sound.
  await driver.clickAt(await driver.timelinePoint(2.5 * second, 1, 3))
  await driver.until(`${selector('clip-start')}?.value === '1.000'`, 'the clip to be selected')
  await openExportDialog(driver)
  await pick(driver, 'export-frame-rate', '25/1')
  await driver.page.click('export-range-selection')
  const range = await startExport(driver, { fileName: 'range.mp4', preset: '240p', quality: 'low', hasAudio: false })
  // The result stays in the dialog until it has been read, and the project behind it still answers to nothing: not to the menu, not to a paste, not to the mouse.
  await driver.until(`${selector('export-done')} !== null`, 'the export of the range to end')
  const canShowInFinder = (await driver.page.evaluate(`${selector('show-export')} !== null`)) === true
  const focusOnResult = await driver.page.evaluate(`document.activeElement?.dataset.testid`)
  await driver.picture('export-finished')
  driver.menu('duplicate')
  driver.menu('new')
  driver.window.webContents.paste()
  await driver.clickAt(await driver.timelinePoint(second / 2, 0, 3))
  await sleep(POLL_INTERVAL_MS)
  const behindResult = { undoLabel: driver.menuLabel('undo'), selectedStart: await driver.value('clip-start') }
  await untilExported(driver, 'range.mp4')
  // With the dialog gone the project answers again.
  await driver.typeInto('clip-opacity', '50')
  await driver.untilUndoLabel('Undo Change Opacity')

  // A large export is stopped half way: nothing of it stays on disk.
  await openExportDialog(driver)
  const rememberedPreset = await driver.value('export-preset')
  const cancelled = await startExport(driver, { fileName: 'cancelled.mp4', preset: '4k', quality: 'high', hasAudio: true })
  await driver.until(`/Frame [1-9]\\d/.test(${selector('export-progress')}?.textContent ?? '')`, 'the export to be well under way')
  const progressText = await driver.page.text('export-progress')
  const hadUnfinishedFile = existsSync(`${cancelled}.part`)
  await driver.picture('export-running')
  // While it runs the export has the window. Keys do not reach the project, and neither Escape, however often, nor closing the window stops it: only Cancel does.
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

  // The result is also closed without the mouse: by Return, with the focus on its button, and by Escape.
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

  // Each format shows only the fields it uses. Sound alone and the picture under the playhead are exported from the same dialog.
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

  // A window that loads again has forgotten its export, so the export ends with it instead of running on where nobody can stop it.
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

// The playhead position in ticks, read from the timecode of a 30 fps project.
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

// Builds a ten-minute tutorial the way its maker would: a screen recording, a voice track and music, a title and a logo, one cut, then an export at full size.
async function testTutorial(driver: Driver): Promise<UiTestReport> {
  const second = TICKS_PER_SECOND
  // Five tracks need a taller timeline than the window starts with.
  const splitter = centerOf(await driver.rect('split-timeline'))
  await driver.drag(splitter, { x: splitter.x, y: splitter.y - TALLER_TIMELINE })
  const names = ['screen.mp4', 'voice.m4a', 'music.mp3', 'logo.png']
  driver.options.answers.importMedia = names.map((name) => mediaFile(driver, name))
  await driver.page.click('import')
  await driver.until(names.map((name) => `${selector(`media-${name}`)} !== null`).join(' && '), 'the four files in the Media tab')

  await dragMedia(driver, 'screen.mp4', await driver.timelinePoint(0, 0, 1))
  await driver.until(`${selector('track-0')} !== null`, 'the recording on the timeline')
  await dragMedia(driver, 'voice.m4a', await driver.timelinePoint(0, 0, 1))
  await driver.until(`${selector('track-1')} !== null`, 'the voice on a track of its own')
  await dragMedia(driver, 'music.mp3', await driver.timelinePoint(0, 1, 2))
  await driver.until(`${selector('track-2')} !== null`, 'the music on a track of its own')
  await driver.page.click('timeline-zoom-fit')

  // The music plays quietly under the voice and fades out at the end.
  await driver.clickAt(await driver.timelinePoint(300 * second, 2, 3))
  await driver.until(`${selector('clip-volume')} !== null`, 'the music to be selected')
  await driver.typeInto('clip-volume', '30')
  await driver.typeInto('clip-volumeFadeOut', '3')
  await driver.untilUndoLabel('Undo Change Fade')

  // A title over the first five seconds.
  await driver.press('Return', ['meta'])
  await driver.page.click('tab-annotations')
  await driver.page.click('annotation-text')
  await untilTextEditor(driver, true)
  await driver.window.webContents.insertText('How to export a video')
  await driver.press('Escape')
  await untilTextEditor(driver, false)
  await driver.typeInto('text-size', '120')
  await driver.typeInto('clip-fadeOut', '1')

  // A logo in the corner, dropped on the canvas and placed by its numbers.
  await driver.page.click('tab-media')
  await driver.until(`${selector('media-logo.png')} !== null`, 'the Media tab')
  await dragMedia(driver, 'logo.png', centerOf(await driver.rect('preview')))
  await driver.untilUndoLabel('Undo Add Clip')
  await driver.typeInto('clip-scale', '25')
  await driver.typeInto('clip-x', '1760')
  await driver.typeInto('clip-y', '100')
  await driver.typeInto('clip-duration', '30')
  await driver.untilUndoLabel('Undo Trim Clip')

  // Ten seconds in the middle of the recording are cut out, and what follows closes the gap.
  const ruler = await driver.rect('timeline')
  const middle = await driver.timelinePoint(300 * second, 0, 5)
  await driver.clickAt({ x: middle.x, y: ruler.y + RULER_HEIGHT / 2 })
  await driver.until(`${selector('timecode')}.textContent.startsWith('00:0')  && ${selector('timecode')}.textContent !== '00:00:00:00'`, 'the playhead in the middle')
  const cutStart = await playheadTime(driver)
  await driver.clickAt(await driver.timelinePoint(100 * second, 0, 5))
  await driver.page.click('split')
  await driver.untilUndoLabel('Undo Split Clip')
  const cutEnd = cutStart + CUT_SECONDS * second
  for (let jump = 0; jump < (CUT_SECONDS * FRAMES_PER_SECOND) / JUMP_FRAMES; jump++) await driver.press('.', ['control', 'shift'])
  await untilPlayhead(driver, cutEnd)
  await driver.clickAt(await driver.timelinePoint(cutEnd + 100 * second, 0, 5))
  await driver.page.click('split')
  await driver.clickAt(await driver.timelinePoint((cutStart + cutEnd) / 2, 0, 5))
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

// Looks at the controls themselves: fields under their labels, groups that fold, the media as tiles, a very wide sidebar and a timeline zoomed far out.
async function testControls(driver: Driver): Promise<UiTestReport> {
  // One look at the next frame after each press: a list that is not there by then counts as late and leaves no sample.
  await driver.page.evaluate(`(() => {
    window.listDelays = []
    window.groupDelays = []
    addEventListener('pointerdown', () => {
      const startedAt = performance.now()
      requestAnimationFrame(() => {
        if (document.querySelector('[role="listbox"]') !== null) window.listDelays.push(performance.now() - startedAt)
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

  // The project settings fold away, and stay folded for the next launch.
  await clickOn(driver, 'group-project')
  await driver.until(`${selector('canvas-width')} === null`, 'the project settings to fold away')

  driver.options.answers.importMedia = ['h264.mp4', 'audio.wav', 'image.jpg'].map((name) => mediaFile(driver, name))
  await driver.page.click('import')
  await driver.until(`${selector('media-image.jpg')} !== null`, 'the import to finish')
  await untilPrepared(driver)

  // The switch sits on the line of the search field. Media starts as tiles side by side; as a list, one row lies under another.
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

  // A tile is dragged to the timeline like a row.
  await dragMedia(driver, 'h264.mp4', await driver.timelinePoint(0, 0, 1))
  await driver.untilUndoLabel('Undo Add Clip')
  await driver.until(`${selector('clip-x')} !== null`, 'the properties of the new clip')

  // Every field, with the keyframe buttons at the end of its line, is as wide as its panel and sits under its own label.
  const sidebar = await driver.rect('right-sidebar')
  const field = await driver.rect('clip-x')
  const lineEnd = await driver.rect('clip-x-next-keyframe')
  const labelBottom = await driver.page.evaluate(`document.querySelector('label[for="' + ${selector('clip-x')}.id + '"]').getBoundingClientRect().bottom`)
  const fieldInset = { left: field.x - sidebar.x, right: sidebar.x + sidebar.width - lineEnd.x - lineEnd.width }
  const isLabelAbove = typeof labelBottom === 'number' && labelBottom <= field.y
  await driver.picture('properties')

  // Each list of ready-made values opens on the press; Escape closes it and hands the focus back to its field.
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
  // A press elsewhere closes the list and puts the old value back.
  await clickOn(driver, 'timecode')
  await driver.until(`!(${isListOpen('clip-rotation')})`, 'a press elsewhere to close the list')
  const rotationAfterPressElsewhere = await driver.value('clip-rotation')
  const undoLabelAfterLists = driver.menuLabel('undo')

  // The longest list there is, every font on this Mac, opens as promptly as the short ones.
  await driver.page.click('tab-annotations')
  await driver.page.click('annotation-text')
  await untilTextEditor(driver, true)
  await driver.press('Escape')
  await untilTextEditor(driver, false)
  await driver.page.click('tab-media')
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

  // By keyboard: Alt+Down in a number field opens its values, the arrow keys move through them, Return keeps one.
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

  // A group folds with a click and opens again from the keyboard.
  await clickOn(driver, 'group-transform')
  await driver.until(`${selector('clip-x')} === null`, 'the transform fields to fold away')
  const isLockShownWhenFolded = (await driver.page.evaluate(`${selector('aspect-lock')} !== null`)) === true
  await driver.picture('folded')
  await driver.page.evaluate(`${selector('group-transform')}.focus()`)
  await driver.press('Return')
  await driver.until(`${selector('clip-x')} !== null`, 'Return to open the group again')

  // A sidebar takes all the room the canvas can spare, and the other sidebar stays as it is.
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

  // The timeline zooms out until an hour is in view, far past this two-second project, and fits it again on request.
  const timeline = await driver.rect('timeline')
  const zoomAtFit = await timelineZoom(driver)
  for (let step = 0; step < 24; step++) await driver.page.click('timeline-zoom-out')
  await driver.until(`JSON.parse(${selector('timeline')}.dataset.view).pixelsPerSecond * ${SECONDS_PER_HOUR} < ${timeline.width + 1}`, 'the timeline to zoom out as far as it goes')
  const zoomedOut = await timelineZoom(driver)
  await driver.picture('zoomed-out')
  await driver.page.click('timeline-zoom-fit')
  await driver.until(`JSON.parse(${selector('timeline')}.dataset.view).pixelsPerSecond > 1`, 'the timeline to fit the project again')
  const zoomAfterFit = await timelineZoom(driver)
  // The list is chosen last, so the next launch shows whether the choice was kept.
  await clickOn(driver, 'media-view-list')

  const listDelays = numbersIn(await driver.page.evaluate('window.listDelays'))
  const fontListDelays = listDelays.slice(listsBeforeFonts)
  const groupDelays = numbersIn(await driver.page.evaluate('window.groupDelays'))
  return {
    windowWidth,
    isSwitchBesideSearch,
    isGridByDefault,
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

// The next launch on the same profile: what was folded is folded, and the media is still shown as a list.
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

// Where the timeline says the media held over it would land.
async function untilLanding(driver: Driver): Promise<ShownLanding> {
  await driver.until(`${LANDING} !== ''`, 'the outline of where the held media would land')
  const landing: unknown = JSON.parse(String(await driver.page.evaluate(LANDING)))
  if (!isShownLanding(landing)) throw new PageError('The timeline does not say where the held media would land')
  return { start: landing.start, trackIndex: landing.trackIndex, isNewTrack: landing.isNewTrack }
}

async function trackCount(driver: Driver): Promise<unknown> {
  return driver.page.evaluate(`document.querySelectorAll('.track-header').length`)
}

async function isPlaying(driver: Driver): Promise<boolean> {
  return (await driver.page.evaluate(`${selector('play')}.getAttribute('aria-label')`)) === 'Pause'
}

// Builds a small project by dragging: looks at where held media would land before it is let go, moves two clips across tracks together, and crops by typing.
async function testArrange(driver: Driver): Promise<UiTestReport> {
  const second = TICKS_PER_SECOND
  const names = ['h264.mp4', 'audio.wav', 'image.jpg']
  driver.options.answers.importMedia = names.map((name) => mediaFile(driver, name))
  await driver.page.click('import')
  await driver.until(names.map((name) => `${selector(`media-${name}`)} !== null`).join(' && '), 'the three files in the Media tab')
  await untilPrepared(driver)
  const mediaDetails = await driver.page.evaluate(`[...document.querySelectorAll('.library-item .library-details')].map((details) => details.textContent)`)

  // Held over the empty timeline, the video shows where it would land while nothing has been added. The pointer is then moved about, to see that the outline keeps up.
  const video = centerOf(await driver.rect('media-h264.mp4'))
  const oneSecond = await driver.timelinePoint(second, 0, 1)
  const fourSeconds = await driver.timelinePoint(4 * second, 0, 1)
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

  // Off the timeline the outline goes. Back on it, Escape abandons the drag, and letting go then adds nothing.
  await driver.dragOn(oneSecond, video)
  await driver.until(`${LANDING} === ''`, 'the outline to go when the pointer leaves the timeline')
  await driver.dragOn(video, oneSecond)
  await untilLanding(driver)
  await driver.press('Escape')
  await driver.until(`${LANDING} === ''`, 'Escape to abandon the drag')
  await driver.releaseAt(oneSecond)
  await sleep(POLL_INTERVAL_MS)
  const afterEscape = { tracks: await trackCount(driver), undoLabel: driver.menuLabel('undo') === undoBefore ? 'unchanged' : driver.menuLabel('undo') }

  // Let go over the timeline, the clip is where the outline was.
  driver.holdAt(video)
  await driver.dragOn(video, oneSecond)
  await untilLanding(driver)
  await driver.releaseAt(oneSecond)
  await driver.untilUndoLabel('Undo Add Clip')
  const placed = await driver.savedProject('placed.json')

  // Over a spot that is taken the outline says the drop makes a track of its own. Playback goes on while the sound is held there: holding is not an edit.
  await driver.press('Return', ['meta'])
  await driver.press('Space')
  await driver.until(`${selector('play')}.getAttribute('aria-label') === 'Pause'`, 'playback to start')
  const sound = centerOf(await driver.rect('media-audio.wav'))
  const onTheVideo = await driver.timelinePoint(1.5 * second, 0, 1)
  driver.holdAt(sound)
  await driver.dragOn(sound, onTheVideo)
  const heldOverTaken = await untilLanding(driver)
  const isPlayingWhileHeld = await isPlaying(driver)
  await driver.picture('arrange-new-track')
  await driver.releaseAt(onTheVideo)
  await driver.until(`${selector('track-1')} !== null`, 'the sound on a track of its own')
  const stacked = await driver.savedProject('stacked.json')
  const ruler = await driver.rect('timeline')
  await driver.clickAt({ x: ruler.x + 8, y: ruler.y + RULER_HEIGHT / 2 })

  // Selected together, the two clips go a second later and up a track together: the video takes the track of the sound and the sound gets a new one.
  await driver.clickAt(await driver.timelinePoint(1.25 * second, 0, 2))
  const onTheSound = await driver.timelinePoint(2.5 * second, 1, 2)
  const aboveTheTop = await driver.timelinePoint(3.5 * second, 2, 2)
  await driver.clickAt(onTheSound, ['shift'])
  const moveDelays = await watchDelays(driver, 'pointermove', 'any frame')
  driver.holdAt(onTheSound)
  await driver.dragOn(onTheSound, aboveTheTop)
  await driver.picture('arrange-group')
  await driver.releaseAt(aboveTheTop)
  await driver.untilUndoLabel('Undo Move Clips')
  const groupDelays = await moveDelays.read()
  const lifted = await driver.savedProject('lifted.json')

  // One track down they are back on their tracks; one more down there is no track, so they stay.
  await driver.drag(await driver.timelinePoint(3.5 * second, 2, 3), await driver.timelinePoint(3.5 * second, 1, 3))
  await sleep(POLL_INTERVAL_MS)
  const lowered = await driver.savedProject('lowered.json')
  await driver.drag(await driver.timelinePoint(3.5 * second, 1, 3), await driver.timelinePoint(3.5 * second, 0, 3))
  await sleep(POLL_INTERVAL_MS)
  const kept = await driver.savedProject('kept.json')

  // A crop typed in the properties panel hides that side of the picture; the rest stays where it is, so the centre moves by half of what went.
  const inTheVideo = await driver.timelinePoint(2.25 * second, 0, 3)
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

  // Picked with a click and a Cmd-click, two files are dragged as one: held over the empty top track they show one outline,
  // and let go they lie one after the other there, in the order of the list, in one undo step.
  await driver.clickAt(centerOf(await driver.rect('media-audio.wav')))
  await driver.clickAt(centerOf(await driver.rect('media-image.jpg')), ['meta'])
  const selectedFiles = await driver.page.evaluate(`[...document.querySelectorAll('.library-item.selected')].map((item) => item.dataset.testid)`)
  const image = centerOf(await driver.rect('media-image.jpg'))
  const onTheTopTrack = await driver.timelinePoint(0.5 * second, 2, 3)
  driver.holdAt(image)
  await driver.dragOn(image, onTheTopTrack)
  const heldTogether = await untilLanding(driver)
  await driver.picture('arrange-held-together')
  await driver.releaseAt(onTheTopTrack)
  await driver.untilUndoLabel('Undo Add 2 Clips')
  const droppedTogether = await driver.savedProject('dropped-together.json')

  // A hint is as large as the text of the window, not smaller.
  await driver.hover(centerOf(await driver.rect('split')))
  await driver.until(`document.querySelector('.tooltip:not([hidden])') !== null`, 'the hint of the split button')
  const hintSize = await driver.page.evaluate(`getComputedStyle(document.querySelector('.tooltip')).fontSize`)
  await driver.picture('arrange-hint')
  return {
    mediaDetails,
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

// What the timeline says a transition or an effect held over it would go to.
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

// Chooses a button with the keyboard alone: the focus is put on it, as Tab would, and Return presses it.
async function pressWithKeyboard(driver: Driver, testId: string): Promise<void> {
  await driver.page.evaluate(`${selector(testId)}.focus()`)
  await driver.press('Return')
}

// Adds each kind of blur and highlight from the Annotations tab to a project with one clip, and changes them on the canvas and in Properties.
async function testShapes(driver: Driver): Promise<UiTestReport> {
  await fullQualityFrame(driver, 0)
  await driver.page.click('tab-annotations')
  await driver.page.click('annotation-blur')
  await driver.untilUndoLabel('Undo Add Blur')
  await driver.until(`${selector('blur-strength')} !== null`, 'the new blur to be selected')
  const added = await driver.savedProject('blur.json')

  // The new blur is 192 by 72 in the middle of the canvas. Its corner is pulled to twice that; its look is set in Properties.
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

  // Undo takes the last one away again; the one before it is deleted like any clip.
  driver.menu('undo')
  await driver.untilUndoLabel('Undo Add Pixelate')
  await driver.clickAt(await driver.timelinePoint(TICKS_PER_SECOND / 2, 3, 4))
  await driver.until(`${selector('blur-strength')} !== null`, 'the pixelate clip to be selected')
  await driver.press('Backspace')
  await driver.untilUndoLabel('Undo Delete Clip')
  return { added, strengthLabel, styled, spotlight, all, afterDelete: await driver.savedProject('deleted.json') }
}

// Puts effects on the four clips of a mosaic by click and by dragging onto the timeline and the canvas, then changes one clip's list in Properties.
async function testEffects(driver: Driver): Promise<UiTestReport> {
  const second = TICKS_PER_SECOND
  await fullQualityFrame(driver, 0)
  await driver.page.click('tab-effects')
  await driver.page.click('effect-border')
  const noticeWithoutSelection = await driver.page.waitFor('notice', (text) => text !== '', POLL_INTERVAL_MS * STEPS_TO_TIME, 'a notice that nothing is selected')

  // A click with the pointer adds nothing. Pressed without one, as Return and VoiceOver do, the effect goes to every selected clip; with two selected, their settings are not offered together.
  await driver.clickAt(await driver.timelinePoint(second / 2, 0, 4))
  await driver.clickAt(await driver.timelinePoint(second / 2, 1, 4), ['shift'])
  const undoBeforeClick = driver.menuLabel('undo')
  await driver.clickAt(centerOf(await driver.rect('effect-border')))
  await sleep(POLL_INTERVAL_MS)
  const isUnchangedByClick = driver.menuLabel('undo') === undoBeforeClick
  await driver.page.click('effect-border')
  await driver.untilUndoLabel('Undo Add Effect')
  const hintForTwo = await driver.page.waitFor('effects-hint', (text) => text !== '', POLL_INTERVAL_MS * STEPS_TO_TIME, 'the hint to select one clip')
  const bordered = await driver.savedProject('bordered.json')

  // Held over a clip on the timeline, the effect marks that clip and changes nothing yet.
  const shadow = centerOf(await driver.rect('effect-dropShadow'))
  const onThird = await driver.timelinePoint(second, 2, 4)
  driver.holdAt(shadow)
  await driver.dragOn(shadow, onThird)
  const heldOverTimeline = await untilDrop(driver)
  const undoWhileHeld = driver.menuLabel('undo')
  await driver.picture('effects-held')
  await driver.releaseAt(onThird)
  await driver.until(`${selector('effect-dropShadow-offsetX')} !== null`, 'the shadow of the third clip in Properties')

  // Held over the canvas, it marks the topmost clip under the pointer: the fourth clip fills the bottom right quarter.
  const adjust = centerOf(await driver.rect('effect-colorAdjust'))
  const onFourth = await onCanvas(driver, 480, 270)
  driver.holdAt(adjust)
  await driver.dragOn(adjust, onFourth)
  await driver.until(`${selector('canvas-overlay')}.dataset.dropTarget === 'd'`, 'the clip under the held effect to be marked')
  await driver.releaseAt(onFourth)
  await driver.until(`${selector('effect-colorAdjust-brightness')} !== null`, 'the colour adjustment of the fourth clip in Properties')
  const dropped = await driver.savedProject('dropped.json')

  // The fourth clip gets a border too. Its effects are changed, reordered and switched off in Properties.
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

  // The key colour is picked from the screen. The system's picker is stood in for here; the key is back on with the colour it gave.
  await pressWithKeyboard(driver, 'effect-chromaKey')
  await driver.until(`${selector('effect-chromaKey-pick')} !== null`, 'the chroma key in Properties')
  await driver.page.evaluate(`void (window.EyeDropper = class { open() { return Promise.resolve({ sRGBHex: '#123456' }) } })`)
  await driver.page.click('effect-chromaKey-pick')
  await driver.untilUndoLabel('Undo Pick Key Colour')
  const keyed = await driver.savedProject('keyed.json')

  await driver.page.click('effect-border-remove')
  await driver.untilUndoLabel('Undo Remove Effect')
  await fullQualityFrame(driver, 0)
  await driver.picture('effects-applied')
  return { noticeWithoutSelection, isUnchangedByClick, hintForTwo, bordered, heldOverTimeline, undoWhileHeld, dropped, changed, keyed, removed: await driver.savedProject('removed.json') }
}

// Drags transitions onto the cut between two clips and onto their free ends, changes one by its grip and in Properties, and removes one.
async function testTransitions(driver: Driver): Promise<UiTestReport> {
  const second = TICKS_PER_SECOND
  await fullQualityFrame(driver, 0)
  await driver.page.click('tab-transitions')
  const dissolve = centerOf(await driver.rect('transition-crossDissolve'))
  const beforeCut = await driver.timelinePoint(0.8 * second, 0, 1)
  const undoBefore = driver.menuLabel('undo')

  // Held near the cut, the transition marks the cut and changes nothing. Escape abandons the drag.
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
  // A click on a transition adds nothing: transitions are always dragged where they go.
  await driver.clickAt(dissolve)
  await sleep(POLL_INTERVAL_MS)
  const isUnchangedByClick = driver.menuLabel('undo') === undoBefore

  await driver.drag(dissolve, beforeCut)
  await driver.untilUndoLabel('Undo Add Transition')
  const onCut = await driver.savedProject('cut.json')

  // The grip at the end of the transition sets its length: on a cut, twice as far as the grip is from the cut.
  const gripDelays = await watchDelays(driver, 'pointermove', 'any frame')
  await driver.drag(await driver.timelinePoint(1.5 * second, 0, 1), await driver.timelinePoint(1.2 * second, 0, 1))
  await driver.untilUndoLabel('Undo Change Transition')
  const gripToFrame = await gripDelays.read()
  const shortened = await driver.savedProject('shortened.json')

  // The free ends take a transition each, as long as the clip has room left beside the one on the cut.
  await driver.drag(centerOf(await driver.rect('transition-zoom')), await driver.timelinePoint(0.2 * second, 0, 1))
  await untilField(driver, 'transition-in', 'zoom')
  await driver.drag(centerOf(await driver.rect('transition-push')), await driver.timelinePoint(1.8 * second, 0, 1))
  await untilField(driver, 'transition-out', 'push')
  const withEnds = await driver.savedProject('ends.json')
  await sleep(PICTURES_SETTLE_MS)
  await driver.picture('transitions-three')

  // Properties changes the kind and the length of the transition at each end of the selected clip, and takes one away.
  await pick(driver, 'transition-in', 'wipeLeft')
  await driver.untilUndoLabel('Undo Change Transition')
  await driver.typeInto('transition-in-length', '0.3')
  await untilField(driver, 'transition-in-length', '0.300')
  await pick(driver, 'transition-out', 'none')
  await driver.untilUndoLabel('Undo Remove Transition')
  const viaProperties = await driver.savedProject('properties.json')

  // A click in the tab, or Return with the focus on it, puts the transition at the start of the selected clip.
  await pressWithKeyboard(driver, 'transition-circleReveal')
  await untilField(driver, 'transition-in', 'circleReveal')
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

// Where a moment is on the camera lane.
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

// Frames a part of the canvas with the zoom tool, changes the frame, the zooms on the camera lane and their settings, and moves a clip under a zoom.
async function testZoom(driver: Driver): Promise<UiTestReport> {
  const second = TICKS_PER_SECOND
  await fullQualityFrame(driver, 0)
  await driver.page.click('zoom-tool')
  await driver.until(`${selector('camera-tool')} !== null`, 'the zoom tool')
  await seekOnRuler(driver, second, '00:00:01:00')

  // A frame drawn over the middle half of the canvas is a zoom to 200% at the playhead.
  const frameDelays = await watchDelays(driver, 'pointermove', 'any frame')
  await driver.drag(await onCanvas(driver, 160, 90), await onCanvas(driver, 480, 270))
  await driver.untilUndoLabel('Undo Zoom and Pan')
  await driver.until(`${selector('zoom-scale')} !== null`, 'the new zoom in Properties')
  const frameToFrame = await frameDelays.read()
  const drawn = await driver.savedProject('drawn.json')
  await driver.picture('zoom-drawn')

  // Dragged by its inside the frame moves; dragged by a corner it changes size about the opposite corner.
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

  // On the camera lane a zoom is dragged to another time, and the start of its bar sets how long its move takes.
  await driver.drag(await lanePoint(driver, second), await lanePoint(driver, 0.8 * second))
  await driver.untilUndoLabel('Undo Move Zoom')
  const barStart = await lanePoint(driver, 0)
  await driver.drag({ x: barStart.x + 2, y: barStart.y }, await lanePoint(driver, 0.4 * second))
  await driver.untilUndoLabel('Undo Change Zoom Length')
  const onLane = await driver.savedProject('lane.json')
  await sleep(PICTURES_SETTLE_MS)
  await driver.picture('zoom-lane')

  // A click on a zoom selects it and goes to its time; its settings are in Properties.
  await driver.clickAt(await lanePoint(driver, 0.8 * second))
  await untilTimecode(driver, '00:00:00:24')
  await driver.typeInto('zoom-duration', '0.5')
  await untilField(driver, 'zoom-duration', '0.500')
  await pick(driver, 'zoom-easing', 'linear')
  await driver.untilUndoLabel('Undo Change Zoom Easing')
  const viaProperties = await driver.savedProject('properties.json')

  // The Delete key removes the selected zoom.
  await driver.clickAt(await lanePoint(driver, 1.5 * second))
  await untilTimecode(driver, '00:00:01:15')
  await driver.press('Backspace')
  await driver.untilUndoLabel('Undo Delete Zoom')
  const afterDelete = await driver.savedProject('deleted.json')

  // With the tool off the canvas shows the zoomed picture, and the handles lie on it: a drag moves the clip by what the pointer travels on the zoomed picture.
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

  // A right click on a zoom offers how the camera moves to it, and a way to delete it.
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

// The sound of a clip is drawn in the lower part of its row. A volume keyframe sits this far below the middle of the row at the recorded volume, and the top of the sound lies this far below it.
const VOLUME_POINT_AT_UNITY = 15.5
const VOLUME_POINT_AT_HALF = 20.75
const NEAR_TOP_OF_SOUND = 6

// Adds a callout, an arrow and a line from the Annotations tab, and changes them on the canvas and in Properties.
async function testAnnotations(driver: Driver): Promise<UiTestReport> {
  await fullQualityFrame(driver, 0)
  await driver.page.click('tab-annotations')
  await driver.page.click('annotation-callout')
  await driver.untilUndoLabel('Undo Add Callout')
  // A new callout opens for typing, like a new title.
  await untilTextEditor(driver, true)
  await driver.typeKeys('Look here')
  await driver.press('Escape')
  await untilTextEditor(driver, false)
  await driver.untilUndoLabel('Undo Edit Text')
  const added = await driver.savedProject('callout.json')

  // The tail of the bubble is dragged to the bottom right of the canvas; shape, size and colours come from Properties.
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

  // A new arrow lies level in the middle. Its end is dragged to the top right corner, its start stays where it is.
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

  // A line dragged onto the canvas lands where it is let go. A click on a tile adds nothing: annotations are dragged where they go.
  await driver.drag(centerOf(await driver.rect('annotation-line')), await onCanvas(driver, 160, 90))
  await driver.untilUndoLabel('Undo Add Line')
  const withLine = await driver.savedProject('line.json')
  await driver.clickAt(centerOf(await driver.rect('annotation-highlight')))
  await sleep(POLL_INTERVAL_MS)
  const undoAfterClick = driver.menuLabel('undo')

  // A title dragged onto the video on the timeline shows where it would land, then lies at that moment on a new track just above the video.
  const titleTile = centerOf(await driver.rect('annotation-text'))
  const onTheVideo = await driver.timelinePoint(TICKS_PER_SECOND, 0, 4)
  driver.holdAt(titleTile)
  await driver.dragOn(titleTile, onTheVideo)
  const titleHeld = await untilLanding(driver)
  await driver.releaseAt(onTheVideo)
  await driver.untilUndoLabel('Undo Add Text')
  return { added, shaped, banner, arrowAdded, pointed, withLine, undoAfterClick, titleHeld, withTitle: await driver.savedProject('title.json') }
}

// Styles a title with everything the Text group of Properties offers.
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

  // Wrapping starts at the width the text has; made narrower, the two words stand on two lines and the box gets taller.
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

// Gives the one clip of a project an animation at each end, and turns them into keyframes.
async function testAnimations(driver: Driver): Promise<UiTestReport> {
  const second = TICKS_PER_SECOND
  await fullQualityFrame(driver, 0)
  await driver.clickAt(await driver.timelinePoint(second, 0, 1))
  await driver.until(`${selector('animation-in')} !== null`, 'the clip to be selected')
  const canConvertBefore = await driver.page.evaluate(`!${selector('animation-convert')}.disabled`)
  const offersTypewriter = await (async () => {
    await openList(driver, 'animation-in', 'animation-in')
    const isOffered = await driver.page.evaluate(`${selector('animation-in-option-typewriter')} !== null`)
    await driver.press('Escape')
    return isOffered
  })()

  await pick(driver, 'animation-in', 'pop')
  await driver.untilUndoLabel('Undo Change Animation')
  await driver.typeInto('animation-in-length', '1')
  await pick(driver, 'animation-out', 'slideRight')
  const animated = await driver.savedProject('animated.json')

  await clickOn(driver, 'animation-convert')
  await driver.untilUndoLabel('Undo Convert Animation to Keyframes')
  const converted = await driver.savedProject('converted.json')
  driver.menu('undo')
  await driver.untilUndoLabel('Undo Change Animation')
  await pick(driver, 'animation-in', 'none')
  await driver.untilUndoLabel('Undo Remove Animation')
  return { canConvertBefore, offersTypewriter, animated, converted, removed: await driver.savedProject('removed.json') }
}

// Groups the four clips of a mosaic, moves the group, changes a member from the inside, and takes the group apart again.
async function testGroups(driver: Driver): Promise<UiTestReport> {
  const second = TICKS_PER_SECOND
  await fullQualityFrame(driver, 0)
  await driver.clickAt(await driver.timelinePoint(second, 0, 4))
  driver.menu('select-all')
  driver.menu('group')
  await driver.untilUndoLabel('Undo Group Clips')
  await driver.until(`${selector('group-open')} !== null`, 'the group to be selected')
  const grouped = await driver.savedProject('grouped.json')

  // On the canvas the group is one thing: a press on any member grabs it, and all four move together.
  await driver.drag(await onCanvas(driver, 160, 90), await onCanvas(driver, 200, 110))
  await driver.untilUndoLabel('Undo Move Clip')
  await driver.typeInto('clip-scale', '50')
  await driver.untilUndoLabel('Undo Resize Clip')
  const moved = await driver.savedProject('moved.json')
  await fullQualityFrame(driver, 0)
  await driver.picture('groups-closed')

  // A double click on the timeline goes into the group: its four tracks are shown, and Properties changes one member.
  await driver.doubleClickAt(await driver.timelinePoint(second, 3, 4))
  await driver.until(`${selector('group-path')} !== null`, 'the group to open')
  const tracksInside = await driver.page.evaluate(`document.querySelectorAll('.track-header').length`)
  const isCameraToolOff = await driver.page.evaluate(`${selector('zoom-tool')}.disabled`)
  await driver.clickAt(await driver.timelinePoint(second, 3, 4))
  await driver.until(`${selector('clip-opacity')} !== null`, 'a member to be selected')
  await driver.typeInto('clip-opacity', '40')
  await driver.untilUndoLabel('Undo Change Opacity')
  // The member is dragged on the canvas, which shows the whole project with the group at half its size.
  await driver.drag(await onCanvas(driver, 280, 195), await onCanvas(driver, 300, 215))
  await driver.untilUndoLabel('Undo Move Clip')
  const inside = await driver.savedProject('inside.json')
  await driver.picture('groups-open')

  // Escape first lets go of the member, then leaves the group, which is selected again.
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

// Keys the volume of a clip in Properties, drags a keyframe on its waveform, and sets how its sound follows its speed.
async function testSound(driver: Driver): Promise<UiTestReport> {
  const second = TICKS_PER_SECOND
  await fullQualityFrame(driver, 0)
  await untilPrepared(driver)
  await driver.clickAt(await driver.timelinePoint(second / 2, 0, 1))
  await driver.until(`${selector('clip-volume-keyframe')} !== null`, 'the clip to be selected')

  // A keyframe at the start holds the volume there; with one on the clip, a new volume further on makes the next.
  await clickOn(driver, 'clip-volume-keyframe')
  await driver.untilUndoLabel('Undo Add Volume Keyframe')
  await seekOnRuler(driver, second, '00:00:01:00')
  await driver.typeInto('clip-volume', '50')
  await driver.untilUndoLabel('Undo Change Volume')
  const keyed = await driver.savedProject('keyed.json')

  // The second point is dragged half a second later and up to nearly the top of the sound.
  const point = await driver.timelinePoint(second, 0, 1)
  const later = await driver.timelinePoint(1.5 * second, 0, 1)
  await driver.hover({ x: point.x, y: point.y + VOLUME_POINT_AT_HALF })
  const cursorOverPoint = await driver.page.evaluate(`document.querySelector('[data-testid="timeline"] canvas:last-child').style.cursor`)
  await driver.drag({ x: point.x, y: point.y + VOLUME_POINT_AT_HALF }, { x: later.x, y: later.y + NEAR_TOP_OF_SOUND })
  await driver.untilUndoLabel('Undo Change Volume Keyframe')
  const dragged = await driver.savedProject('dragged.json')
  await driver.picture('sound-keyframes')

  // A right click on the first point offers its easing and a way to delete it.
  const first = await driver.timelinePoint(0, 0, 1)
  await driver.rightClickAt({ x: first.x + 1, y: first.y + VOLUME_POINT_AT_UNITY })
  await driver.page.click('menu-easing-easeIn')
  await driver.untilUndoLabel('Undo Change Keyframe Easing')
  const eased = await driver.savedProject('eased.json')
  await driver.rightClickAt({ x: first.x + 1, y: first.y + VOLUME_POINT_AT_UNITY })
  await driver.page.click('menu-keyframe-delete')
  await driver.untilUndoLabel('Undo Delete Volume Keyframe')
  const deleted = await driver.savedProject('deleted.json')

  // The switch for sound above 400% is only there for a clip that fast.
  const offersFastSoundAtFirst = await driver.page.evaluate(`${selector('clip-fast-sound')} !== null`)
  await clickOn(driver, 'clip-keep-pitch')
  await driver.untilUndoLabel('Undo Let Pitch Follow Speed')
  await driver.typeInto('clip-speed', '800')
  await driver.untilUndoLabel('Undo Change Speed')
  await driver.until(`${selector('clip-fast-sound')} !== null`, 'the switch for fast sound')
  await clickOn(driver, 'clip-fast-sound')
  await driver.untilUndoLabel('Undo Play Fast Sound')
  return { keyed, cursorOverPoint, dragged, eased, deleted, offersFastSoundAtFirst, fast: await driver.savedProject('fast.json') }
}

// Keys a clip's place in Properties, moves it a second later so its motion path shows, drags a dot of the path, walks between the keyframes and keys its size.
async function testKeyframes(driver: Driver): Promise<UiTestReport> {
  const second = TICKS_PER_SECOND
  await fullQualityFrame(driver, 0)
  await driver.clickAt(await driver.timelinePoint(second / 2, 0, 1))
  await driver.until(`${selector('clip-x-keyframe')} !== null`, 'the clip to be selected')

  // X and Y are one set: the button on either keys both, and both light up.
  await clickOn(driver, 'clip-y-keyframe')
  await driver.untilUndoLabel('Undo Add Position Keyframe')
  const keyed = await driver.savedProject('keyed.json')
  const isXPressed = await isPressed(driver, 'clip-x-keyframe')

  // A second later the clip still stands on the first dot; a drag from there moves the clip, which keys that moment.
  await seekOnRuler(driver, second, '00:00:01:00')
  await driver.drag(await onCanvas(driver, 320, 180), await onCanvas(driver, 420, 230))
  await driver.untilUndoLabel('Undo Move Clip')
  await driver.until(`${selector('motion-path')}?.dataset.dots === '2'`, 'a motion path with two dots')
  const moved = await driver.savedProject('moved.json')

  // The first dot is dragged on its own; the keyframe at the playhead stays where it is.
  await driver.drag(centerOf(await driver.rect('path-point-0')), await onCanvas(driver, 200, 120))
  await driver.untilUndoLabel('Undo Move Position Keyframe')
  const dotMoved = await driver.savedProject('dot-moved.json')
  await driver.picture('motion-path')

  await clickOn(driver, 'clip-x-previous-keyframe')
  await untilTimecode(driver, '00:00:00:00')
  await clickOn(driver, 'clip-y-next-keyframe')
  await untilTimecode(driver, '00:00:01:00')

  // Width, height and scale are one set as well.
  await clickOn(driver, 'clip-scale-keyframe')
  await driver.untilUndoLabel('Undo Add Size Keyframe')
  const sizePressed = [await isPressed(driver, 'clip-width-keyframe'), await isPressed(driver, 'clip-height-keyframe')]
  const sized = await driver.savedProject('sized.json')

  // With the place animated, a typed X keys the place at the playhead, Y with it; the button then takes both away again.
  await seekOnRuler(driver, 1.5 * second, '00:00:01:15')
  await driver.typeInto('clip-x', '500')
  await driver.untilUndoLabel('Undo Move Clip')
  const typed = await driver.savedProject('typed.json')
  await clickOn(driver, 'clip-x-keyframe')
  await driver.untilUndoLabel('Undo Remove Position Keyframe')
  return { keyed, isXPressed, moved, dotMoved, sizePressed, sized, typed, removed: await driver.savedProject('removed.json') }
}

export const FEATURE_SCENARIOS: Record<string, Scenario> = {
  annotations: testAnnotations,
  'text-style': testTextStyle,
  animations: testAnimations,
  groups: testGroups,
  sound: testSound,
  shapes: testShapes,
  effects: testEffects,
  transitions: testTransitions,
  zoom: testZoom,
  keyframes: testKeyframes,
  arrange: testArrange,
  controls: testControls,
  'controls-kept': testControlsKept,
  tutorial: testTutorial,
  export: testExport,
  relink: testRelink,
  animated: testAnimated,
  text: testText,
  blocks: testBlocks,
  transport: testTransport,
}
