// Drives the harness window the way a user would: clicks its real buttons, presses Space,
// drags the playhead, and reports what the window shows. Run with --selftest <project>.
import { existsSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import type { BrowserWindow } from 'electron'

const POLL_INTERVAL_MS = 50
const LOAD_TIMEOUT_MS = 60_000
const PREPARE_TIMEOUT_MS = 600_000
const STEP_TIMEOUT_MS = 30_000
const EXPORT_TIMEOUT_MS = 600_000
const SCRUB_FRAME = 45

export type SelfTestOptions = {
  /** How long to let the project play while counting dropped frames. */
  playSeconds: number
  /** Where a test export goes; no export is tried when left out. */
  exportPath: string | undefined
}

export type SelfTestReport = Record<string, unknown>

export class SelfTestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SelfTestError'
  }
}

type Page = {
  text(testId: string): Promise<string>
  click(testId: string): Promise<void>
  evaluate(script: string): Promise<unknown>
  /** Waits until `check` returns true for the text of `testId`; returns that text. */
  waitFor(testId: string, check: (text: string) => boolean, timeoutMs: number, what: string): Promise<string>
  /** How many position reports the window has shown so far. */
  reportCount(): Promise<number>
  /** Waits for a full-quality frame reported after report number `since`; returns the stats text. */
  waitForFullQuality(since: number, what: string): Promise<string>
}

function selector(testId: string): string {
  return `document.querySelector('[data-testid="${testId}"]')`
}

function pageOf(window: BrowserWindow): Page {
  function evaluate(script: string): Promise<unknown> {
    return window.webContents.executeJavaScript(script, true)
  }

  async function text(testId: string): Promise<string> {
    const content = await evaluate(`${selector(testId)}?.textContent ?? ''`)
    return typeof content === 'string' ? content : ''
  }

  async function click(testId: string): Promise<void> {
    await evaluate(`${selector(testId)}.click()`)
  }

  async function waitFor(testId: string, check: (content: string) => boolean, timeoutMs: number, what: string): Promise<string> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const content = await text(testId)
      if (check(content)) return content
      if (Date.now() > deadline) throw new SelfTestError(`Timed out waiting for ${what}; ${testId} shows "${content}"`)
      await sleep(POLL_INTERVAL_MS)
    }
  }

  async function reportCount(): Promise<number> {
    return Number(await evaluate(`${selector('stats')}?.dataset.sequence ?? 0`))
  }

  async function waitForFullQuality(since: number, what: string): Promise<string> {
    const deadline = Date.now() + STEP_TIMEOUT_MS
    for (;;) {
      // Count and text are read together, so the text belongs to that report.
      const snapshot = await evaluate(`(() => {
        const stats = ${selector('stats')}
        return { count: Number(stats?.dataset.sequence ?? 0), text: stats?.textContent ?? '' }
      })()`)
      const isSnapshot = typeof snapshot === 'object' && snapshot !== null && 'count' in snapshot && 'text' in snapshot
      if (isSnapshot && typeof snapshot.count === 'number' && typeof snapshot.text === 'string') {
        if (snapshot.count > since && isFullQuality(snapshot.text)) return snapshot.text
      }
      if (Date.now() > deadline) throw new SelfTestError(`Timed out waiting for ${what}`)
      await sleep(POLL_INTERVAL_MS)
    }
  }

  return { text, click, evaluate, waitFor, reportCount, waitForFullQuality }
}

function droppedFramesIn(stats: string): number {
  return Number(/dropped (?<count>\d+)/.exec(stats)?.groups?.count ?? Number.NaN)
}

function fullQualityMillisecondsIn(stats: string): number {
  return Number(/full quality in (?<time>\d+) ms/.exec(stats)?.groups?.time ?? Number.NaN)
}

function isFullQuality(stats: string): boolean {
  return stats.includes('full quality')
}

async function pressSpace(window: BrowserWindow): Promise<void> {
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' })
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' })
  await sleep(POLL_INTERVAL_MS)
}

async function testExport(page: Page, exportPath: string): Promise<SelfTestReport> {
  // First run: cancel once progress is showing, and nothing may be left on disk.
  await page.click('export')
  await page.waitFor('cancel-export', (label) => /\((?!0%)\d+%\)/.test(label), EXPORT_TIMEOUT_MS, 'export progress')
  const existedDuringExport = existsSync(exportPath)
  await page.click('cancel-export')
  await page.waitFor('status', (status) => status === 'Export cancelled.', STEP_TIMEOUT_MS, 'the cancelled export')
  await sleep(1000)
  const existsAfterCancel = existsSync(exportPath) || existsSync(`${exportPath}.part`)

  // Second run: let it finish.
  await page.click('export')
  const outcome = await page.waitFor('status', (status) => status.startsWith('Export f'), EXPORT_TIMEOUT_MS, 'the export to finish')
  return { existedDuringExport, existsAfterCancel, outcome, existsAfterFinish: existsSync(exportPath) }
}

/** Runs the whole tour and returns what was observed. Throws SelfTestError when the window stops responding. */
export async function runSelfTest(window: BrowserWindow, options: SelfTestOptions): Promise<SelfTestReport> {
  const page = pageOf(window)
  const startedAt = Date.now()
  const status = await page.waitFor('status', (content) => content !== '' && !content.startsWith('Open'), LOAD_TIMEOUT_MS, 'the project to load')
  const loadMilliseconds = Date.now() - startedAt
  // The play button only becomes usable once a project is loaded; otherwise the status says why not.
  const isLoaded = (await page.evaluate(`${selector('play')}.disabled === false`)) === true
  if (!isLoaded) throw new SelfTestError(`The project did not load: ${status}`)

  // Paused at the start: the frame is first shown from the preview, then from the originals.
  const firstStats = await page.waitForFullQuality(0, 'the first full-quality frame')
  const timecodeAtStart = await page.text('timecode')

  await page.waitFor('stats', (stats) => !stats.includes('preparing'), PREPARE_TIMEOUT_MS, 'preview copies to be prepared')
  const prepareMilliseconds = Date.now() - startedAt

  await page.click('play')
  await page.waitFor('play', (label) => label === 'Pause', STEP_TIMEOUT_MS, 'playback to start')
  await sleep(options.playSeconds * 1000)
  const timecodeWhilePlaying = await page.text('timecode')
  const reportsBeforePause = await page.reportCount()
  // Playback stops by itself at the end of the timeline; only pause when it is still running.
  if ((await page.text('play')) === 'Pause') await page.click('play')
  await page.waitFor('play', (label) => label === 'Play', STEP_TIMEOUT_MS, 'playback to pause')
  const droppedFrames = droppedFramesIn(await page.text('stats'))
  await page.waitForFullQuality(reportsBeforePause, 'the paused full-quality frame')
  const timecodeAfterPause = await page.text('timecode')
  await sleep(300)
  const timecodeStillPaused = await page.text('timecode')

  // Drag the playhead: set the slider the way the browser does when the user moves it.
  const reportsBeforeScrub = await page.reportCount()
  await page.evaluate(`(() => {
    const slider = ${selector('scrub')}
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setValue.call(slider, String(Number(slider.step) * ${SCRUB_FRAME}))
    slider.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  const scrubStats = await page.waitForFullQuality(reportsBeforeScrub, 'the scrubbed full-quality frame')
  const timecodeAfterScrub = await page.text('timecode')

  await pressSpace(window)
  const playsOnSpace = (await page.waitFor('play', (label) => label === 'Pause', STEP_TIMEOUT_MS, 'Space to start playback')) === 'Pause'
  const reportsBeforeSpacePause = await page.reportCount()
  await pressSpace(window)
  await page.waitFor('play', (label) => label === 'Play', STEP_TIMEOUT_MS, 'Space to pause playback')
  await page.waitForFullQuality(reportsBeforeSpacePause, 'the frame after pausing with Space')

  const reportsBeforeZoom = await page.reportCount()
  await page.click('zoom-actual')
  const actualStats = await page.waitForFullQuality(reportsBeforeZoom, 'the full-quality frame at 100%')
  const actualSize = await page.evaluate(`(() => {
    const canvas = ${selector('preview')}
    return { cssWidth: parseFloat(canvas.style.width), pixelWidth: canvas.getBoundingClientRect().width * devicePixelRatio }
  })()`)

  const report: SelfTestReport = {
    status,
    loadMilliseconds,
    prepareMilliseconds,
    timecodeAtStart,
    timecodeWhilePlaying,
    timecodeAfterPause,
    timecodeStillPaused,
    timecodeAfterScrub,
    droppedFrames,
    playsOnSpace,
    actualSize,
    fullQualityMilliseconds: {
      firstFrame: fullQualityMillisecondsIn(firstStats),
      afterScrub: fullQualityMillisecondsIn(scrubStats),
      atActualSize: fullQualityMillisecondsIn(actualStats),
    },
  }
  if (options.exportPath !== undefined) report.export = await testExport(page, options.exportPath)
  return report
}
