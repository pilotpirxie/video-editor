import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isSlowFrame, trimLogFile } from './logFiles.js'

describe('trimLogFile', () => {
  let directory = ''

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'video-editor-logs-'))
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('keeps the newer half of a log over the limit, from a whole line on', async () => {
    const path = join(directory, 'crash.log')
    const lines = Array.from({ length: 100 }, (_, index) => `line ${String(index).padStart(3, '0')}`)
    await writeFile(path, `${lines.join('\n')}\n`)

    await trimLogFile(path, 400)

    const kept = await readFile(path, 'utf8')
    expect(kept.length).toBeLessThanOrEqual(200)
    expect(kept.endsWith('line 099\n')).toBe(true)
    expect(kept.split('\n').slice(0, -1).every((line) => /^line \d{3}$/.test(line))).toBe(true)
    expect(await readdir(directory)).toEqual(['crash.log'])
  })

  it('leaves a log under the limit and a missing log alone', async () => {
    const path = join(directory, 'crash.log')
    await writeFile(path, 'one line\n')

    await trimLogFile(path, 400)
    await trimLogFile(join(directory, 'missing.log'), 400)

    expect(await readFile(path, 'utf8')).toBe('one line\n')
  })
})

describe('isSlowFrame', () => {
  it('takes what the editor window reports and refuses anything else', () => {
    const script = { invoker: 'SVGSVGElement.onpointermove', functionName: 'onPointerMove', sourceUrl: 'app://editor/assets/index.js', durationMs: 60 }
    expect(isSlowFrame({ durationMs: 80, blockingMs: 30, scripts: [script] })).toBe(true)
    expect(isSlowFrame({ durationMs: 80, blockingMs: 30, scripts: [{ ...script, invoker: 1 }] })).toBe(false)
    expect(isSlowFrame({ durationMs: '80', blockingMs: 30, scripts: [] })).toBe(false)
    expect(isSlowFrame(undefined)).toBe(false)
  })
})
