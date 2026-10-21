import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ExportEncoder } from '../../src/shared/exportPresets.js'
import { HAS_SAMPLES, exportWithReport, projectPath, scratchDirectory, type ExportReport } from '../helpers.js'

const scratch = scratchDirectory('limits')
const MAX_PEAK_MEMORY_MB = 1500
// x264 keeps more pictures than the media engine, which Macs with 8 GB or less export with unless asked otherwise. Measured at up to 1,982 MB;
// allowed over 1.5 GB because a small Mac uses x264 only when it is chosen in the Export dialog.
const KNOWN_X264_4K_PEAK_MEMORY_MB = 2100
// Timed on the export alone.
const MIN_1080P_REAL_TIME_RATIO = 2
const MIN_4K_REAL_TIME_RATIO = 0.5
// Ten minutes of source at 50× within five minutes.
const MAX_TIMELAPSE_MS = 300_000
const EXPORT_TIMEOUT_MS = 600_000

function exportReport(project: string, preset: string, encoder: ExportEncoder): Promise<ExportReport> {
  return exportWithReport(projectPath(project), join(scratch, `${project}-${preset}-${encoder}.mp4`), preset, encoder)
}

describe('memory while exporting', { timeout: EXPORT_TIMEOUT_MS }, () => {
  it.skipIf(!HAS_SAMPLES)('a four-layer 1080p export stays under 1.5 GB', async () => {
    expect((await exportReport('demo-four-layers', '1080p', 'x264')).peakMemoryMegabytes).toBeLessThanOrEqual(MAX_PEAK_MEMORY_MB)
  })

  it.skipIf(!HAS_SAMPLES)('the same four layers under camera zooms, with blur, spotlight, transitions and effects, stay under 1.5 GB', async () => {
    expect((await exportReport('demo-zoom-effects', '1080p', 'x264')).peakMemoryMegabytes).toBeLessThanOrEqual(MAX_PEAK_MEMORY_MB)
  })

  // Blurring, pixelating and highlighting parts of the picture takes spare pictures of the size of the output.
  it('a 4K export with blur, pixelate and highlight by the media engine stays under 1.5 GB', async () => {
    expect((await exportReport('15-blur-highlight', '4k', 'hardware')).peakMemoryMegabytes).toBeLessThanOrEqual(MAX_PEAK_MEMORY_MB)
  })

  it('a 4K export of a 4K source by the media engine stays under 1.5 GB', async () => {
    expect((await exportReport('12-4k-canvas', '4k', 'hardware')).peakMemoryMegabytes).toBeLessThanOrEqual(MAX_PEAK_MEMORY_MB)
  })

  it.each(['12-4k-canvas', '15-blur-highlight'])('a 4K export of %s by x264 stays under what x264 is known to need', async (project) => {
    expect((await exportReport(project, '4k', 'x264')).peakMemoryMegabytes).toBeLessThanOrEqual(KNOWN_X264_4K_PEAK_MEMORY_MB)
  })
})

describe('export speed', { timeout: EXPORT_TIMEOUT_MS }, () => {
  it.skipIf(!HAS_SAMPLES)('exports four 1080p layers at twice real time with the media engine', async () => {
    expect((await exportReport('demo-four-layers', '1080p', 'hardware')).realTimeRatio).toBeGreaterThanOrEqual(MIN_1080P_REAL_TIME_RATIO)
  })

  it.skipIf(!HAS_SAMPLES)('exports the four layers at 4K at half real time with the media engine', async () => {
    expect((await exportReport('demo-four-layers', '4k', 'hardware')).realTimeRatio).toBeGreaterThanOrEqual(MIN_4K_REAL_TIME_RATIO)
  })

  it('exports ten minutes of 1080p at 50× within five minutes, showing progress as it goes', async () => {
    const report = await exportReport('22-timelapse', '1080p', 'hardware')
    expect(report.elapsedMs).toBeLessThanOrEqual(MAX_TIMELAPSE_MS)
    expect(report.progressLines.length).toBeGreaterThan(100)
    expect(report.progressLines.at(-1)).toBe('progress 360/360')
  })
})
