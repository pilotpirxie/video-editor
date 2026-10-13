import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { SECOND, projectOf, track, videoClip } from '../../test/fixtures.js'
import { parseProject } from '../shared/project.js'
import { ProjectFileError, withSavedPaths, writeProjectFile } from './projectFile.js'

const scratch = await mkdtemp(join(tmpdir(), 'project-file-'))

afterAll(() => rm(scratch, { recursive: true, force: true }))

const sample = projectOf([track('t1', [videoClip('a', 0, 2 * SECOND)])], [
  { id: 'video', path: '', relativePath: 'clips/video.mp4' },
  { id: 'lost', path: '', relativePath: '../lost.mp4' },
  { id: 'gone', path: '/elsewhere/gone.mp4', relativePath: '' },
])

describe('withSavedPaths', () => {
  const locations = { resolvedPaths: new Map([['video', '/work/project/clips/video.mp4']]), sourceDirectory: '/work/project' }

  it('stores found media as an absolute path and a path relative to the saved file', () => {
    const saved = withSavedPaths(sample, locations, '/work/exports/copy.json')
    expect(saved.media[0]).toEqual({ id: 'video', path: '/work/project/clips/video.mp4', relativePath: '../project/clips/video.mp4' })
  })

  it('keeps missing media pointing at the same place when the project moves', () => {
    const saved = withSavedPaths(sample, locations, '/work/exports/copy.json')
    expect(saved.media[1]).toEqual({ id: 'lost', path: '', relativePath: '../lost.mp4' })
    expect(saved.media[2]).toEqual({ id: 'gone', path: '/elsewhere/gone.mp4', relativePath: '' })
  })

  it('leaves missing media alone when the project was never saved before', () => {
    const saved = withSavedPaths(sample, { resolvedPaths: new Map(), sourceDirectory: undefined }, '/work/new.json')
    expect(saved.media).toEqual(sample.media)
  })

  it('does not change the project it was given', () => {
    const before = JSON.stringify(sample)
    withSavedPaths(sample, locations, '/work/exports/copy.json')
    expect(JSON.stringify(sample)).toBe(before)
  })
})

describe('writeProjectFile', () => {
  it('writes a file that reads back identically and leaves nothing else behind', async () => {
    const directory = await mkdtemp(join(scratch, 'write-'))
    const path = join(directory, 'project.json')
    await writeProjectFile(path, sample)

    const loaded = parseProject(await readFile(path, 'utf8'))
    expect(loaded).toEqual({ ok: true, project: sample })
    expect(await readdir(directory)).toEqual(['project.json'])
  })

  it('creates the folder when it does not exist yet', async () => {
    const path = join(scratch, 'recovery', 'nested', 'untitled.json')
    await writeProjectFile(path, sample)
    expect(existsSync(path)).toBe(true)
  })

  it('refuses a project that would not open again and keeps the previous file', async () => {
    const directory = await mkdtemp(join(scratch, 'invalid-'))
    const path = join(directory, 'project.json')
    await writeFile(path, 'previous contents')
    const overlapping = projectOf([track('t1', [videoClip('a', 0, 2 * SECOND), videoClip('b', SECOND, 2 * SECOND)])])

    await expect(writeProjectFile(path, overlapping)).rejects.toThrow(/"project\.json" was not saved because the project is not valid: .*overlapping clips "a" and "b"/)
    expect(await readFile(path, 'utf8')).toBe('previous contents')
    expect(await readdir(directory)).toEqual(['project.json'])
  })

  it('removes its temporary file and keeps the target when the write cannot complete', async () => {
    const directory = await mkdtemp(join(scratch, 'blocked-'))
    const path = join(directory, 'project.json')
    await mkdir(join(path, 'occupied'), { recursive: true })

    await expect(writeProjectFile(path, sample)).rejects.toThrow(ProjectFileError)
    expect(await readdir(directory)).toEqual(['project.json'])
  })
})
