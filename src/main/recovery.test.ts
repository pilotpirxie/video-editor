import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { temporaryPathFor } from '../shared/exportPresets.js'
import { findRecoveries, rememberExportOutput, rememberProjectPath } from './recovery.js'

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

  it('removes the note of a window that left no recovery file, and keeps the note of one that did', async () => {
    const kept = await recoveryWrittenAt('kept.json', 10)
    await rememberProjectPath(kept, '/projects/kept.json')
    await rememberProjectPath(join(directory, 'closed.json'), '/projects/closed.json')

    expect(await findRecoveries(directory)).toEqual([{ recoveryPath: kept, projectPath: '/projects/kept.json' }])
    expect((await readdir(directory)).sort()).toEqual(['kept.json', 'kept.json.path'])
  })

  it('removes the unfinished file of an export a crash cut short, and never the finished file', async () => {
    const outputPath = `${directory}-export.mp4`
    await writeFile(outputPath, 'finished')
    await writeFile(temporaryPathFor(outputPath), 'unfinished')
    await rememberExportOutput(directory, outputPath)

    expect(await findRecoveries(directory)).toEqual([])
    expect(existsSync(temporaryPathFor(outputPath))).toBe(false)
    expect(existsSync(outputPath)).toBe(true)
    expect(await readdir(directory)).toEqual([])
    await rm(outputPath)
  })

  it('finds nothing in a folder that is not there', async () => {
    expect(await findRecoveries(join(directory, 'missing'))).toEqual([])
  })
})
