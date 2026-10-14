import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findRecoveries, rememberProjectPath } from './recovery.js'

describe('findRecoveries', () => {
  let directory = ''

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'video-editor-recovery-'))
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  async function recoveryWrittenAt(name: string, secondsAgo: number): Promise<string> {
    const path = join(directory, name)
    await writeFile(path, '{}')
    const at = new Date(Date.now() - secondsAgo * 1000)
    await utimes(path, at, at)
    return path
  }

  it('finds the work of every window, newest first, and drops what a later save holds', async () => {
    const older = await recoveryWrittenAt('older.json', 60)
    const newer = await recoveryWrittenAt('newer.json', 10)
    const saved = await recoveryWrittenAt('saved.json', 30)
    // The project lives elsewhere: everything in the recovery folder that ends in .json is a recovery file.
    const projectPath = `${directory}-project.json`
    await writeFile(projectPath, '{}')
    await rememberProjectPath(saved, projectPath)
    await writeFile(join(directory, 'gone.json.export'), '{}')

    expect(await findRecoveries(directory)).toEqual([
      { recoveryPath: newer, projectPath: undefined },
      { recoveryPath: older, projectPath: undefined },
    ])
    // The saved project superseded its recovery file, and no export is running at launch.
    expect((await readdir(directory)).sort()).toEqual(['newer.json', 'older.json'])
    await rm(projectPath)
  })

  it('finds nothing in a folder that is not there', async () => {
    expect(await findRecoveries(join(directory, 'missing'))).toEqual([])
  })
})
