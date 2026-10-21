import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HAS_SAMPLES, exportWithReport, projectPath, scratchDirectory, type ExportReport } from '../helpers.js'

const scratch = scratchDirectory('limits')
const MAX_PEAK_MEMORY_MB = 1500
const MIN_1080P_REAL_TIME_RATIO = 2
const MIN_4K_REAL_TIME_RATIO = 0.5
const MAX_TIMELAPSE_MS = 300_000
const EXPORT_TIMEOUT_MS = 600_000

function exportReport(project: string, preset: string): Promise<ExportReport> {
  return exportWithReport(projectPath(project), join(scratch, `${project}-${preset}.mp4`), preset)
}

describe('memory while exporting', { timeout: EXPORT_TIMEOUT_MS }, () => {
  it.skipIf(!HAS_SAMPLES)('a four-layer 1080p export stays under 1.5 GB', async () => {
    expect((await exportReport('demo-four-layers', '1080p')).peakMemoryMegabytes).toBeLessThanOrEqual(MAX_PEAK_MEMORY_MB)
  })

  it.skipIf(!HAS_SAMPLES)('the same four layers under camera zooms, with blur, spotlight, transitions and effects, stay under 1.5 GB', async () => {
    expect((await exportReport('demo-zoom-effects', '1080p')).peakMemoryMegabytes).toBeLessThanOrEqual(MAX_PEAK_MEMORY_MB)
  })

  it('a 4K export with blur, pixelate and highlight stays under 1.5 GB', async () => {
    expect((await exportReport('15-blur-highlight', '4k')).peakMemoryMegabytes).toBeLessThanOrEqual(MAX_PEAK_MEMORY_MB)
  })

  it('a 4K export of a 4K source stays under 1.5 GB', async () => {
    expect((await exportReport('12-4k-canvas', '4k')).peakMemoryMegabytes).toBeLessThanOrEqual(MAX_PEAK_MEMORY_MB)
  })
})

describe('export speed', { timeout: EXPORT_TIMEOUT_MS }, () => {
  it.skipIf(!HAS_SAMPLES)('exports four 1080p layers at twice real time', async () => {
    expect((await exportReport('demo-four-layers', '1080p')).realTimeRatio).toBeGreaterThanOrEqual(MIN_1080P_REAL_TIME_RATIO)
  })

  it.skipIf(!HAS_SAMPLES)('exports the four layers at 4K at half real time', async () => {
    expect((await exportReport('demo-four-layers', '4k')).realTimeRatio).toBeGreaterThanOrEqual(MIN_4K_REAL_TIME_RATIO)
  })

  it('exports ten minutes of 1080p at 50× within five minutes, showing progress as it goes', async () => {
    const report = await exportReport('22-timelapse', '1080p')
    expect(report.elapsedMs).toBeLessThanOrEqual(MAX_TIMELAPSE_MS)
    expect(report.progressLines.length).toBeGreaterThan(100)
    expect(report.progressLines.at(-1)).toBe('progress 360/360')
  })
})
