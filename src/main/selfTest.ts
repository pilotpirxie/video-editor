import { existsSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import type { BrowserWindow } from 'electron'
import { PageError, pageOf, selector, type Page } from './page.js'

const POLL_INTERVAL_MS = 50
const LOAD_TIMEOUT_MS = 60_000
const PREPARE_TIMEOUT_MS = 600_000
const STEP_TIMEOUT_MS = 30_000
const EXPORT_TIMEOUT_MS = 600_000
const SCRUB_FRAME = 45
const MS_PER_SECOND = 1000
const CANCEL_SETTLE_MS = 1000
const PAUSE_SETTLE_MS = 300

export type SelfTestOptions = {
  playSeconds: number
  exportPath: string | undefined
}

export type SelfTestReport = Record<string, unknown>

type HarnessPage = Page & {
  reportCount(): Promise<number>
  waitForFullQuality(since: number, what: string): Promise<string>
}

function harnessPageOf(window: BrowserWindow): HarnessPage {
  const page = pageOf(window)

  async function reportCount(): Promise<number> {
    return Number(await page.evaluate(`${selector('stats')}?.dataset.sequence ?? 0`))
  }

  async function waitForFullQuality(since: number, what: string): Promise<string> {
    const deadline = Date.now() + STEP_TIMEOUT_MS
    for (;;) {
      const snapshot = await page.evaluate(`(() => {
        const stats = ${selector('stats')}
        return { count: Number(stats?.dataset.sequence ?? 0), text: stats?.textContent ?? '' }
      })()`)
      const isSnapshot = typeof snapshot === 'object' && snapshot !== null && 'count' in snapshot && 'text' in snapshot
      if (isSnapshot && typeof snapshot.count === 'number' && typeof snapshot.text === 'string') {
        if (snapshot.count > since && snapshot.text.includes('full quality')) return snapshot.text
      }
      if (Date.now() > deadline) throw new PageError(`Timed out waiting for ${what}`)
      await sleep(POLL_INTERVAL_MS)
    }
  }

  return { ...page, reportCount, waitForFullQuality }
}

function droppedFramesIn(stats: string): number {
  return Number(/dropped (?<count>\d+)/.exec(stats)?.groups?.count ?? Number.NaN)
}

function fullQualityMillisecondsIn(stats: string): number {
  return Number(/full quality in (?<time>\d+) ms/.exec(stats)?.groups?.time ?? Number.NaN)
}

async function pressSpace(window: BrowserWindow): Promise<void> {
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' })
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' })
  await sleep(POLL_INTERVAL_MS)
}

async function testExport(page: HarnessPage, exportPath: string): Promise<SelfTestReport> {
  await page.click('export')
  await page.waitFor('cancel-export', (label) => /\((?!0%)\d+%\)/.test(label), EXPORT_TIMEOUT_MS, 'export progress')
  const existedDuringExport = existsSync(exportPath)
  await page.click('cancel-export')
  await page.waitFor('status', (status) => status === 'Export cancelled.', STEP_TIMEOUT_MS, 'the cancelled export')
  await sleep(CANCEL_SETTLE_MS)
  const existsAfterCancel = existsSync(exportPath) || existsSync(`${exportPath}.part`)

  await page.click('export')
  const outcome = await page.waitFor('status', (status) => status.startsWith('Export f'), EXPORT_TIMEOUT_MS, 'the export to finish')
  return { existedDuringExport, existsAfterCancel, outcome, existsAfterFinish: existsSync(exportPath) }
}

export async function runSelfTest(window: BrowserWindow, options: SelfTestOptions): Promise<SelfTestReport> {
  const page = harnessPageOf(window)
  const startedAt = Date.now()
  const status = await page.waitFor('status', (content) => content !== '' && !content.startsWith('Open'), LOAD_TIMEOUT_MS, 'the project to load')
  const loadMilliseconds = Date.now() - startedAt
  const isLoaded = (await page.evaluate(`${selector('play')}.disabled === false`)) === true
  if (!isLoaded) throw new PageError(`The project did not load: ${status}`)

  const firstStats = await page.waitForFullQuality(0, 'the first full-quality frame')
  const timecodeAtStart = await page.text('timecode')

  await page.waitFor('stats', (stats) => !stats.includes('preparing'), PREPARE_TIMEOUT_MS, 'preview copies to be prepared')
  const prepareMilliseconds = Date.now() - startedAt

  await page.click('play')
  await page.waitFor('play', (label) => label === 'Pause', STEP_TIMEOUT_MS, 'playback to start')
  await sleep(options.playSeconds * MS_PER_SECOND)
  const timecodeWhilePlaying = await page.text('timecode')
  const reportsBeforePause = await page.reportCount()
  if ((await page.text('play')) === 'Pause') await page.click('play')
  await page.waitFor('play', (label) => label === 'Play', STEP_TIMEOUT_MS, 'playback to pause')
  const droppedFrames = droppedFramesIn(await page.text('stats'))
  await page.waitForFullQuality(reportsBeforePause, 'the paused full-quality frame')
  const timecodeAfterPause = await page.text('timecode')
  await sleep(PAUSE_SETTLE_MS)
  const timecodeStillPaused = await page.text('timecode')

  // Playback can pause on the very frame the test scrubs to, and a slider set to the value it already shows reports nothing.
  // So the slider first goes to the frame beside it, and once the harness shows that frame, to the frame the test wants.
  // Both are worked out in the page, because the slider keeps a value within a project shorter than the scrub frame.
  const scrubTo = (frame: 'wanted' | 'beside it'): Promise<unknown> =>
    page.evaluate(`(() => {
      const slider = ${selector('scrub')}
      const step = Number(slider.step)
      const wanted = Math.min(Number(slider.max), step * ${SCRUB_FRAME})
      const besideIt = wanted >= step ? wanted - step : wanted + step
      const value = ${JSON.stringify(frame)} === 'wanted' ? wanted : besideIt
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(slider, String(value))
      slider.dispatchEvent(new Event('input', { bubbles: true }))
      return value
    })()`)
  const besideIt = await scrubTo('beside it')
  const deadline = Date.now() + STEP_TIMEOUT_MS
  while ((await page.evaluate(`Number(${selector('scrub')}.value)`)) !== besideIt) {
    if (Date.now() > deadline) throw new PageError('Timed out waiting for the harness to show the frame beside the scrub frame')
    await sleep(POLL_INTERVAL_MS)
  }
  const reportsBeforeScrub = await page.reportCount()
  await scrubTo('wanted')
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
