// T-22: the whole editor (every Electron process plus its FFmpeg processes) stays inside the
// memory budget while exporting. Playback memory is checked in harness.test.ts.
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ROOT, projectPath, runApp } from '../helpers.js'

const scratch = mkdtempSync(join(tmpdir(), 'video-editor-limits-'))
const HAS_SAMPLES = existsSync(join(ROOT, 'samples', 'kangaroo1920.mp4'))
const MAX_PEAK_MEMORY_MB = 1500
/** Measured 2.2 GB; the margin catches a regression without failing on run-to-run noise. */
const KNOWN_4K_PEAK_MEMORY_MB = 2500

afterAll(() => rmSync(scratch, { recursive: true, force: true }))

async function peakMemoryOfExport(project: string, preset: string): Promise<number> {
  const startedAt = performance.now()
  const result = await runApp(['--export', projectPath(project), '--out', join(scratch, `${project}-${preset}.mp4`), '--preset', preset, '--report-memory'], 600_000)
  if (result.exitCode !== 0) throw new Error(`Export failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`)
  const summary: unknown = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '')
  if (!hasPeakMemory(summary)) throw new Error(`The export did not report its memory: ${result.stdout}`)
  const seconds = ((performance.now() - startedAt) / 1000).toFixed(1)
  console.info(`export ${project} at ${preset}: peak memory ${summary.peakMemoryMegabytes} MB, ${seconds} s`)
  return summary.peakMemoryMegabytes
}

function hasPeakMemory(value: unknown): value is { peakMemoryMegabytes: number } {
  return typeof value === 'object' && value !== null && 'peakMemoryMegabytes' in value && typeof value.peakMemoryMegabytes === 'number'
}

describe('memory while exporting', () => {
  it.skipIf(!HAS_SAMPLES)('a four-layer 1080p export stays under 1.5 GB', async () => {
    expect(await peakMemoryOfExport('demo-four-layers', '1080p')).toBeLessThanOrEqual(MAX_PEAK_MEMORY_MB)
  })

  it('a 4K export stays under what x264 is known to need', async () => {
    expect(await peakMemoryOfExport('12-4k-canvas', '4k')).toBeLessThanOrEqual(KNOWN_4K_PEAK_MEMORY_MB)
  })

  // Known miss, by decision (2026-10-13): x264 is used at every size for its quality, and at 4K
  // it alone needs about 1.1 GB. This test is expected to fail; if it ever passes, the budget
  // is met and `fails` should be removed.
  it.fails('a 4K export stays under 1.5 GB', async () => {
    expect(await peakMemoryOfExport('12-4k-canvas', '4k')).toBeLessThanOrEqual(MAX_PEAK_MEMORY_MB)
  })
})
