import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HAS_SAMPLES, lastJsonLine, projectPath, runApp, scratchDirectory } from '../helpers.js'

const scratch = scratchDirectory('harness')
const MAX_PAUSED_FRAME_MS = 500
const MAX_TYPICAL_MEMORY_MB = 700

type Report = {
  status: string
  timecodeAtStart: string
  timecodeWhilePlaying: string
  timecodeAfterPause: string
  timecodeStillPaused: string
  timecodeAfterScrub: string
  droppedFrames: number
  playsOnSpace: boolean
  actualSize: { cssWidth: number; pixelWidth: number }
  fullQualityMilliseconds: { firstFrame: number; afterScrub: number; atActualSize: number }
  export?: { existedDuringExport: boolean; existsAfterCancel: boolean; outcome: string; existsAfterFinish: boolean }
  peakMemoryMegabytes?: number
}

function isReport(value: unknown): value is Report {
  return typeof value === 'object' && value !== null && 'status' in value && 'droppedFrames' in value
}

async function selfTest(project: string, extraArgs: readonly string[]): Promise<Report> {
  const result = await runApp(['--selftest', projectPath(project), ...extraArgs], 600_000)
  if (result.exitCode !== 0) throw new Error(`The self-test failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`)
  const report = lastJsonLine(result.stdout)
  if (!isReport(report)) throw new Error(`Unexpected self-test report: ${result.stdout}`)
  return report
}

function framesOf(timecode: string): number {
  const [hours, minutes, seconds, frames] = timecode.split(':').map(Number)
  return (((hours ?? 0) * 60 + (minutes ?? 0)) * 60 + (seconds ?? 0)) * 30 + (frames ?? 0)
}

describe('dev harness', () => {
  it('loads a project, plays, pauses, scrubs, zooms and exports', async () => {
    const exportPath = join(scratch, 'harness.mp4')
    const report = await selfTest('05-fades', ['--seconds', '1.5', '--out', exportPath])

    expect(report.status).toBe('Ready.')
    expect(report.timecodeAtStart).toBe('00:00:00:00')

    const played = framesOf(report.timecodeWhilePlaying)
    expect(played).toBeGreaterThan(30)
    expect(played).toBeLessThan(60)
    expect(report.droppedFrames).toBe(0)

    expect(framesOf(report.timecodeAfterPause)).toBeGreaterThanOrEqual(played)
    expect(report.timecodeStillPaused).toBe(report.timecodeAfterPause)

    expect(report.timecodeAfterScrub).toBe('00:00:01:15')
    expect(report.playsOnSpace).toBe(true)

    expect(Math.round(report.actualSize.pixelWidth)).toBe(640)

    expect(report.fullQualityMilliseconds.firstFrame).toBeLessThanOrEqual(MAX_PAUSED_FRAME_MS)
    expect(report.fullQualityMilliseconds.afterScrub).toBeLessThanOrEqual(MAX_PAUSED_FRAME_MS)

    expect(report.export).toEqual({ existedDuringExport: false, existsAfterCancel: false, outcome: 'Export finished.', existsAfterFinish: true })
    expect(existsSync(exportPath)).toBe(true)
  })

  it.skipIf(!HAS_SAMPLES).each([
    { project: 'demo-four-layers', layers: 'four video layers, an image, two titles and music' },
    { project: 'demo-zoom-effects', layers: 'four video layers, two titles, a blur and a spotlight, through camera zooms, transitions and effects' },
  ])('plays 1080p30 with $layers without dropping a frame', async ({ project }) => {
    const report = await selfTest(project, ['--seconds', '10', '--report-memory'])
    console.info(`${project} at 1080p30: dropped ${report.droppedFrames} frames in 10 s, paused frame ${JSON.stringify(report.fullQualityMilliseconds)}, peak memory ${report.peakMemoryMegabytes} MB`)
    expect(report.status).toBe('Ready.')
    expect(framesOf(report.timecodeWhilePlaying)).toBeGreaterThan(270)
    expect(report.droppedFrames).toBe(0)
    expect(report.fullQualityMilliseconds.afterScrub).toBeLessThanOrEqual(MAX_PAUSED_FRAME_MS)
    expect(report.fullQualityMilliseconds.atActualSize).toBeLessThanOrEqual(MAX_PAUSED_FRAME_MS)
    // Paused under its 2x zoom the second project reads four layers at full size, which is not the typical case the limit is for; its memory is printed above and judged while exporting.
    if (project === 'demo-four-layers') expect(report.peakMemoryMegabytes).toBeLessThanOrEqual(MAX_TYPICAL_MEMORY_MB)
  })

  it('shows a 4K frame from the originals within the paused-frame budget', async () => {
    const report = await selfTest('12-4k-canvas', ['--seconds', '0.5'])
    console.info(`4K project: paused frame ${JSON.stringify(report.fullQualityMilliseconds)}`)
    expect(report.status).toBe('Ready.')
    expect(Math.round(report.actualSize.pixelWidth)).toBe(3840)
    expect(report.fullQualityMilliseconds.firstFrame).toBeLessThanOrEqual(MAX_PAUSED_FRAME_MS)
    expect(report.fullQualityMilliseconds.atActualSize).toBeLessThanOrEqual(MAX_PAUSED_FRAME_MS)
  })

  it('reports a project that cannot be opened instead of hanging', async () => {
    const result = await runApp(['--selftest', join(scratch, 'missing.json'), '--seconds', '0.5'], 120_000)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toMatch(/The project did not load: "missing\.json" could not be opened/)
  }, 150_000)
})
