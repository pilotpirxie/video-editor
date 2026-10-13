import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { TICKS_PER_SECOND } from '../shared/time.js'
import { PageError, selector } from './page.js'
import { P95, POLL_INTERVAL_MS, RULER_HEIGHT, canvasPoint, centerOf, dragMedia, fullQualityFrame, mediaFile, numbersIn, percentile, type Driver, type Point, type Scenario, type UiTestReport } from './uiDriver.js'

const SHUTTLE_WATCH_MS = 400
const STEPS_TO_TIME = 20
// Thumbnails and waveforms are fetched after the media is prepared; pictures taken for a person to look at wait for them.
const PICTURES_SETTLE_MS = 1500
// A fade handle rests this far inside its corner of the clip; `timelinePoint` gives the middle of the row.
const HANDLE_INSET = 7
const HANDLE_FROM_ROW_MIDDLE = 19
const DIALOG_TAB_STOPS = 12
const CANCEL_SETTLE_MS = 1500
const LONG_EXPORT_TIMEOUT_MS = 30 * 60 * 1000
const MS_PER_SECOND = 1000
const FRAMES_PER_SECOND = 30
const JUMP_FRAMES = 15
const CUT_SECONDS = 10
const TALLER_TIMELINE = 170
const FONT_LIST_TURNS = 5
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
  await driver.until(`document.querySelector('.media-item') !== null && document.querySelector('.media-item .badge.warning') === null`, 'the media to be prepared')
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
  await driver.until(`${selector('redo')}.getAttribute('aria-label') === 'Redo Change Fade'`, 'undo to take back one fade')
  const afterUndo = await driver.savedProject('one-fade.json')
  driver.menu('redo')
  await driver.until(`${selector('redo')}.getAttribute('aria-label') === 'Redo'`, 'redo to bring the fade back')

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

// A real press in the middle of a control, which is first brought into view if its panel has scrolled it away.
// The page hears of that scroll with its next frame; a person could not press sooner, and a list that opened sooner would take the scroll for a reason to close.
async function clickOn(driver: Driver, testId: string): Promise<void> {
  await driver.page.evaluate(`(() => {
    ${selector(testId)}.scrollIntoView({ block: 'nearest' })
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
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
  await driver.page.click('add-text')
  await untilTextEditor(driver, true)
  const typingDelays = await watchDelays(driver, 'input', 'any frame')
  await driver.typeKeys('Hello')
  await driver.until(`${selector('text-words')}?.value === 'Hello'`, 'the typed words in the properties panel')
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
  const kindShown = await driver.page.evaluate(`${selector('media-animated.gif')}.querySelector('.badge').textContent`)

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
  return { kindShown, placed, stretched, once, isLoopingAfterUndo: await driver.page.evaluate(`${selector('clip-loop')}.checked`) }
}

// Opens a project whose three media files have moved: it says so, refuses a file of the wrong kind, then finds all three from one answer.
async function testRelink(driver: Driver): Promise<UiTestReport> {
  const missingBadgeCount = `document.querySelectorAll('.media-item .badge.danger').length`
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
async function startExport(driver: Driver, setup: ExportSetup): Promise<string> {
  if (driver.options.outputDirectory === undefined) throw new PageError('This UI test needs --out <directory>')
  // A save dialog only ever gives a folder that exists.
  await mkdir(driver.options.outputDirectory, { recursive: true })
  const path = join(driver.options.outputDirectory, setup.fileName)
  driver.options.answers.exportPath = path
  await pick(driver, 'export-preset', setup.preset)
  await driver.page.click(`export-quality-${setup.quality}`)
  const hasAudio = (await driver.page.evaluate(`${selector('export-audio')}.checked`)) === true
  if (hasAudio !== setup.hasAudio) await driver.page.click('export-audio')
  await driver.page.evaluate(`${selector('export-start')}.focus()`)
  await driver.press('Return')
  await driver.until(`${selector('export-dialog')} === null`, 'the export dialog to close')
  return path
}

async function untilExported(driver: Driver, fileName: string, timeoutMs?: number): Promise<void> {
  await driver.until(`${selector('notice')}?.textContent.includes('${fileName}') === true && ${selector('export-progress')} === null`, `the export of ${fileName} to end`, timeoutMs)
  const notice = await driver.page.text('notice')
  if (notice !== `Exported "${fileName}".`) throw new PageError(notice)
}

// Exports the three-second fades project several ways from the dialog: a range at a lower frame rate without sound, a cancelled one, and the whole timeline at two qualities.
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
  // Editing goes on while the video is made.
  await driver.typeInto('clip-opacity', '50')
  await driver.untilUndoLabel('Undo Change Opacity')
  await untilExported(driver, 'range.mp4')
  const canShowInFinder = (await driver.page.evaluate(`${selector('show-export')} !== null`)) === true

  // A large export is stopped half way: nothing of it stays on disk.
  await openExportDialog(driver)
  const rememberedPreset = await driver.value('export-preset')
  const cancelled = await startExport(driver, { fileName: 'cancelled.mp4', preset: '4k', quality: 'high', hasAudio: true })
  await driver.until(`/Frame [1-9]/.test(${selector('export-progress')}?.textContent ?? '')`, 'the export to be under way')
  const progressText = await driver.page.text('export-progress')
  const hadUnfinishedFile = existsSync(`${cancelled}.part`)
  await driver.page.click('export-cancel')
  await driver.until(`${selector('export-progress')} === null`, 'the export to stop')
  await sleep(CANCEL_SETTLE_MS)
  const leftBehind = [cancelled, `${cancelled}.part`].filter((path) => existsSync(path))

  await openExportDialog(driver)
  const low = await startExport(driver, { fileName: 'whole-low.mp4', preset: '240p', quality: 'low', hasAudio: true })
  await untilExported(driver, 'whole-low.mp4')
  await openExportDialog(driver)
  const high = await startExport(driver, { fileName: 'whole-high.mp4', preset: '240p', quality: 'high', hasAudio: true })
  await untilExported(driver, 'whole-high.mp4')
  return { defaultPreset, summaryAtOpen, canChooseSelection, tabStops, isDialogOpenAfterListEscape, canShowInFinder, rememberedPreset, progressText, hadUnfinishedFile, leftBehind, range, low, high }
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
  await driver.page.click('add-text')
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
  // Editing goes on while the video is made.
  await driver.clickAt(await driver.timelinePoint(2 * second, 3, 5))
  await driver.until(`${selector('text-size')} !== null`, 'the title to be selected during the export')
  await driver.typeInto('text-size', '110')
  await driver.untilUndoLabel('Undo Change Text Size')
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

  // The switch sits on the line of the search field; as tiles, the media lies side by side.
  const search = await driver.rect('media-search')
  const gridSwitch = await driver.rect('media-view-grid')
  const isSwitchBesideSearch = Math.abs(centerOf(search).y - centerOf(gridSwitch).y) < 1 && gridSwitch.x > search.x + search.width
  const firstInList = await driver.rect('media-h264.mp4')
  const secondInList = await driver.rect('media-audio.wav')
  await clickOn(driver, 'media-view-grid')
  await driver.until(`${selector('media-h264.mp4')}.getBoundingClientRect().top === ${selector('media-audio.wav')}.getBoundingClientRect().top`, 'the media to be shown as tiles')
  const firstTile = await driver.rect('media-h264.mp4')
  const secondTile = await driver.rect('media-audio.wav')
  await sleep(PICTURES_SETTLE_MS)
  await driver.picture('media-grid')

  // A tile is dragged to the timeline like a row.
  await dragMedia(driver, 'h264.mp4', await driver.timelinePoint(0, 0, 1))
  await driver.untilUndoLabel('Undo Add Clip')
  await driver.until(`${selector('clip-x')} !== null`, 'the properties of the new clip')

  // Every field is as wide as its panel and sits under its own label.
  const sidebar = await driver.rect('right-sidebar')
  const field = await driver.rect('clip-x')
  const labelBottom = await driver.page.evaluate(`document.querySelector('label[for="' + ${selector('clip-x')}.id + '"]').getBoundingClientRect().bottom`)
  const fieldInset = { left: field.x - sidebar.x, right: sidebar.x + sidebar.width - field.x - field.width }
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
  await driver.page.click('add-text')
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
  await driver.page.evaluate(`${selector('clip-opacity')}.focus()`)
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
  const tilesAcrossWhenWide = await driver.page.evaluate(`new Set([...document.querySelectorAll('.media-item')].map((item) => item.getBoundingClientRect().left)).size`)
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

  const listDelays = numbersIn(await driver.page.evaluate('window.listDelays'))
  const fontListDelays = listDelays.slice(listsBeforeFonts)
  const groupDelays = numbersIn(await driver.page.evaluate('window.groupDelays'))
  return {
    windowWidth,
    isSwitchBesideSearch,
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

// The next launch on the same profile: what was folded is folded, and the media is still shown as tiles.
async function testControlsKept(driver: Driver): Promise<UiTestReport> {
  await driver.until(`${selector('group-project')} !== null`, 'the project settings')
  return {
    isProjectOpen: await isExpanded(driver, 'group-project'),
    isGridChosen: await isPressed(driver, 'media-view-grid'),
    isListChosen: await isPressed(driver, 'media-view-list'),
  }
}

export const FEATURE_SCENARIOS: Record<string, Scenario> = {
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
