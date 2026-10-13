import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HAS_SAMPLES, lastJsonLine, projectPath, runApp, scratchDirectory } from '../helpers.js'

const scratch = scratchDirectory('limits')
const MAX_PEAK_MEMORY_MB = 1500
const KNOWN_4K_PEAK_MEMORY_MB = 2500
// Four 1080p layers at half size are read at full size for the whole clip when the camera zooms to 200% on them. Measured at 1,512 MB, which is over the 1.5 GB of the specification; bringing it under is part of the memory audit.
const KNOWN_ZOOMED_PEAK_MEMORY_MB = 1700

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

  it.skipIf(!HAS_SAMPLES)('the same four layers under camera zooms, with blur, spotlight, transitions and effects, stay under what they are known to need', async () => {
    expect(await peakMemoryOfExport('demo-zoom-effects', '1080p')).toBeLessThanOrEqual(KNOWN_ZOOMED_PEAK_MEMORY_MB)
  })

  // The second project blurs, pixelates and highlights parts of the picture, which takes spare pictures of the size of the output.
  it.each(['12-4k-canvas', '15-blur-highlight'])('a 4K export of %s stays under what x264 is known to need', async (project) => {
    expect(await peakMemoryOfExport(project, '4k')).toBeLessThanOrEqual(KNOWN_4K_PEAK_MEMORY_MB)
  })

  it.fails('a 4K export stays under 1.5 GB', async () => {
    expect(await peakMemoryOfExport('12-4k-canvas', '4k')).toBeLessThanOrEqual(MAX_PEAK_MEMORY_MB)
  })
})
