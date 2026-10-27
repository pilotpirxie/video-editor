import { existsSync } from 'node:fs'
import { chmod, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { temporaryPathFor } from '../shared/exportPresets.js'
import { discardRecovery, findRecoveries, rememberExportOutput, rememberProjectPath } from './recovery.js'

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
    const projectPath = `${directory}-project.json`
    await writeFile(projectPath, '{}')
    await rememberProjectPath(saved, projectPath)
    await writeFile(join(directory, 'gone.json.export'), '{}')

    expect(await findRecoveries(directory)).toEqual([
      { recoveryPath: newer, projectPath: undefined, recoveredAnimations: {} },
      { recoveryPath: older, projectPath: undefined, recoveredAnimations: {} },
    ])
    expect((await readdir(directory)).sort()).toEqual(['newer.json', 'older.json'])
    await rm(projectPath)
  })

  it('removes the note of a window that left no recovery file, and keeps the note of one that did', async () => {
    const kept = await recoveryWrittenAt('kept.json', 10)
    await rememberProjectPath(kept, '/projects/kept.json')
    await rememberProjectPath(join(directory, 'closed.json'), '/projects/closed.json')

    expect(await findRecoveries(directory)).toEqual([{ recoveryPath: kept, projectPath: '/projects/kept.json', recoveredAnimations: {} }])
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

  it('leaves out a recovery whose note cannot be read and still finds the others', async () => {
    const readable = await recoveryWrittenAt('readable.json', 10)
    const unreadable = await recoveryWrittenAt('unreadable.json', 20)
    await rememberProjectPath(unreadable, '/projects/unreadable.json')
    await chmod(`${unreadable}.path`, 0)

    expect(await findRecoveries(directory)).toEqual([{ recoveryPath: readable, projectPath: undefined, recoveredAnimations: {} }])
    await chmod(`${unreadable}.path`, 0o600)
  })

  it('restores the unsaved animations of a window, even after its episode was saved, but not one saved since', async () => {
    const window = await recoveryWrittenAt('window.json', 30)
    const projectPath = `${directory}-episode.json`
    await writeFile(projectPath, '{}')
    await rememberProjectPath(window, projectPath)
    const unsaved = `${directory}-wave.pbanim`
    const saved = `${directory}-saved.pbanim`
    await recoveryWrittenAt('window.json.0.pbanim', 20)
    await recoveryWrittenAt('window.json.1.pbanim', 20)
    await writeFile(unsaved, '{}')
    await utimes(unsaved, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
    await writeFile(saved, '{}')
    await writeFile(join(directory, 'window.json.animations'), JSON.stringify({ [unsaved]: 'window.json.0.pbanim', [saved]: 'window.json.1.pbanim' }))
    await writeFile(join(directory, 'gone.json.0.pbanim'), '{}')
    await writeFile(join(directory, 'gone.json.animations'), '{}')

    expect(await findRecoveries(directory)).toEqual([{ recoveryPath: window, projectPath, recoveredAnimations: { [unsaved]: join(directory, 'window.json.0.pbanim') } }])
    expect((await readdir(directory)).sort()).toEqual(['window.json', 'window.json.0.pbanim', 'window.json.1.pbanim', 'window.json.animations', 'window.json.path'])
    await rm(projectPath)
    await rm(unsaved)
    await rm(saved)
  })

  it('discards the animation copies with the recovery of their window', async () => {
    const window = await recoveryWrittenAt('window.json', 10)
    await recoveryWrittenAt('window.json.0.pbanim', 10)
    await writeFile(join(directory, 'window.json.animations'), '{}')
    await recoveryWrittenAt('other.json.0.pbanim', 10)
    await discardRecovery(window)
    expect(await readdir(directory)).toEqual(['other.json.0.pbanim'])
  })

  it('finds nothing in a folder that is not there', async () => {
    expect(await findRecoveries(join(directory, 'missing'))).toEqual([])
  })
})
