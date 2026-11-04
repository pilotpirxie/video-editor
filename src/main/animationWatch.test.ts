import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterAll, describe, expect, it } from 'vitest'
import { createAnimationWatch, type AnimationWatch } from './animationWatch.js'

const directory = mkdtempSync(join(tmpdir(), 'video-editor-watch-'))
const WAIT_MS = 2000
const QUIET_MS = 500
const STEP_MS = 20

afterAll(() => rmSync(directory, { recursive: true, force: true }))

async function untilHeard(heard: readonly string[], path: string): Promise<void> {
  const deadline = Date.now() + WAIT_MS
  while (!heard.includes(path) && Date.now() < deadline) await sleep(STEP_MS)
}

async function watchedFile(name: string): Promise<{ path: string; heard: string[]; animationWatch: AnimationWatch }> {
  const path = join(directory, name)
  writeFileSync(path, 'first')
  const heard: string[] = []
  const animationWatch = createAnimationWatch((changed) => heard.push(changed))
  animationWatch.setPaths(new Set([path]))
  await sleep(STEP_MS)
  return { path, heard, animationWatch }
}

describe('createAnimationWatch', () => {
  it('hears a file written in place and one replaced by a rename, and only the listed files', async () => {
    const { path, heard, animationWatch } = await watchedFile('mouths.pbanim')
    writeFileSync(join(directory, 'other.pbanim'), 'not listed')
    writeFileSync(path, 'second')
    await untilHeard(heard, path)
    expect(heard).toEqual([path])

    heard.length = 0
    const temporary = join(directory, 'mouths.pbanim.tmp')
    writeFileSync(temporary, 'third')
    renameSync(temporary, path)
    await untilHeard(heard, path)
    expect(heard).toEqual([path])
    animationWatch.close()
  })

  it('settles a burst of writes into one change, and stops hearing a file taken off the list', async () => {
    const { path, heard, animationWatch } = await watchedFile('burst.pbanim')
    writeFileSync(path, 'second')
    writeFileSync(path, 'third')
    await untilHeard(heard, path)
    await sleep(QUIET_MS)
    expect(heard).toEqual([path])

    heard.length = 0
    animationWatch.setPaths(new Set())
    writeFileSync(path, 'fourth')
    await sleep(QUIET_MS)
    expect(heard).toEqual([])
    animationWatch.close()
  })

  it('survives being asked to watch a folder that does not exist', () => {
    const animationWatch = createAnimationWatch(() => undefined)
    expect(() => animationWatch.setPaths(new Set([join(directory, 'gone', 'file.pbanim')]))).not.toThrow()
    animationWatch.close()
  })
})
