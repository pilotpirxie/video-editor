import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MEDIA_DIRECTORY, scratchDirectory, uiTest } from '../helpers.js'

// Run by hand with `npm run test:stability`; it is not part of `npm test`.
// STABILITY_HOURS sets the length of the random session (8 by default); STABILITY_SEED repeats the session a failure reported.
const SECONDS_PER_HOUR = 3600
const MS_PER_SECOND = 1000
const HOURS = Number(process.env.STABILITY_HOURS ?? '8')
const SEED = process.env.STABILITY_SEED
// Room for the last step and the export that may be running when the time is up.
const SESSION_MARGIN_MS = 30 * 60 * MS_PER_SECOND
const BROKEN_MEDIA_TIMEOUT_MS = 10 * 60 * MS_PER_SECOND
// At most 1.5 GB, and memory that stays flat over the session.
const MAX_PEAK_MEGABYTES = 1500
const MAX_GROWTH_FACTOR = 1.1
const MAX_GROWTH_MEGABYTES = 50

const scratch = scratchDirectory('stability')

type MemorySample = {
  minute: number
  megabytes: number
}

function isMemorySample(value: unknown): value is MemorySample {
  return typeof value === 'object' && value !== null && 'minute' in value && 'megabytes' in value && typeof value.megabytes === 'number'
}

function median(values: readonly number[]): number {
  const inOrder = [...values].sort((a, b) => a - b)
  return inOrder[Math.floor(inOrder.length / 2)] ?? Number.NaN
}

// The samples between two shares of the session, as megabytes.
function megabytesBetween(samples: readonly MemorySample[], from: number, to: number): number[] {
  const first = Math.floor(samples.length * from)
  const last = Math.max(first + 1, Math.floor(samples.length * to))
  return samples.slice(first, last).map((sample) => sample.megabytes)
}

function crashLogOf(profile: string): string {
  const path = join(profile, 'logs', 'crash.log')
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

describe('stability', () => {
  it(
    'imports every broken file without a crash or a hang, and goes on importing and playing good media',
    async () => {
      const profile = join(scratch, 'broken-profile')
      mkdirSync(profile, { recursive: true })
      const report = await uiTest('broken-media', ['--media', MEDIA_DIRECTORY], profile, BROKEN_MEDIA_TIMEOUT_MS)
      process.stdout.write(`Broken media: ${JSON.stringify(report)}\n`)
      // Each broken file is refused by name in the notice, or listed in the Media tab with its badge.
      expect(report.listedShown).toEqual(report.listed)
      expect(report.timecodeAfterPlaying).not.toBe('00:00:00:00')
      expect(crashLogOf(profile)).toBe('')
    },
    BROKEN_MEDIA_TIMEOUT_MS,
  )

  it(
    `survives ${HOURS} hours of random edits, playback, undo, saving and exporting with flat memory`,
    async () => {
      const profile = join(scratch, 'soak-profile')
      mkdirSync(profile, { recursive: true })
      const args = ['--media', MEDIA_DIRECTORY, '--out', join(scratch, 'soak'), '--seconds', String(HOURS * SECONDS_PER_HOUR)]
      if (SEED !== undefined) args.push('--seed', SEED)
      const report = await uiTest('soak', args, profile, HOURS * SECONDS_PER_HOUR * MS_PER_SECOND + SESSION_MARGIN_MS)
      const samples = Array.isArray(report.memory) ? report.memory.filter(isMemorySample) : []
      // Written straight to the output: the test runner shows what a test logs only when it fails.
      process.stdout.write(`Session (seed ${String(report.seed)}): ${JSON.stringify(report.counts)}\nMemory by minute: ${samples.map((sample) => `${sample.minute}:${sample.megabytes}`).join(' ')}\n`)

      expect(crashLogOf(profile)).toBe('')
      expect(samples.length).toBeGreaterThan(10)
      expect(Math.max(...samples.map((sample) => sample.megabytes))).toBeLessThanOrEqual(MAX_PEAK_MEGABYTES)
      // The first tenth warms up: caches fill and the code is compiled. From then on the memory must not creep up.
      const early = median(megabytesBetween(samples, 0.1, 0.2))
      const late = median(megabytesBetween(samples, 0.9, 1))
      expect(late).toBeLessThanOrEqual(early * MAX_GROWTH_FACTOR + MAX_GROWTH_MEGABYTES)
    },
    HOURS * SECONDS_PER_HOUR * MS_PER_SECOND + SESSION_MARGIN_MS,
  )
})
