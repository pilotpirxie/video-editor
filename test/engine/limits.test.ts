import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HAS_SAMPLES, lastJsonLine, projectPath, runApp, scratchDirectory } from '../helpers.js'

const scratch = scratchDirectory('limits')
const MAX_PEAK_MEMORY_MB = 1500
const KNOWN_4K_PEAK_MEMORY_MB = 2500

async function peakMemoryOfExport(project: string, preset: string): Promise<number> {
  const startedAt = performance.now()
  const result = await runApp(['--export', projectPath(project), '--out', join(scratch, `${project}-${preset}.mp4`), '--preset', preset, '--report-memory'], 600_000)
  if (result.exitCode !== 0) throw new Error(`Export failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`)
  const summary = lastJsonLine(result.stdout)
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

  it.fails('a 4K export stays under 1.5 GB', async () => {
    expect(await peakMemoryOfExport('12-4k-canvas', '4k')).toBeLessThanOrEqual(MAX_PEAK_MEMORY_MB)
  })
})
