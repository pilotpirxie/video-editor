import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { bundledFfmpeg } from '../../test/helpers.js'
import { mediaPath } from '../../test/media/generate.js'
import { createDiskCache } from './cache.js'
import { MediaSession } from './mediaStore.js'

const scratch = await mkdtemp(join(tmpdir(), 'media-store-'))
const PLENTY_OF_ROOM = 1024 ** 3
const SAMPLES_READ = 480

afterAll(() => rm(scratch, { recursive: true, force: true }))

function newSession(name: string): MediaSession {
  return new MediaSession(bundledFfmpeg(), createDiskCache(join(scratch, name), PLENTY_OF_ROOM))
}

describe('MediaSession.openMedia', () => {
  it('tells which files of a project are there and which are missing, and serves the ones that are', async () => {
    const session = newSession('cache-found')
    const states = await session.openMedia(
      [
        { id: 'sound', path: mediaPath('audio.wav'), relativePath: '' },
        { id: 'gone', path: join(scratch, 'gone.mp4'), relativePath: '' },
      ],
      undefined,
    )
    expect(states.sound).toMatchObject({ info: { kind: 'audio' } })
    expect(states.gone).toMatchObject({ isMissing: true })
    const samples = await session.audio('sound', 0, SAMPLES_READ)
    expect(samples?.length).toBeGreaterThan(0)
    await session.dispose()
  })

  it('finds a file beside the project by its relative path', async () => {
    const projectDirectory = join(scratch, 'moved-project')
    await mkdir(projectDirectory, { recursive: true })
    await copyFile(mediaPath('audio.wav'), join(projectDirectory, 'voice.wav'))
    const session = newSession('cache-relative')
    const states = await session.openMedia([{ id: 'voice', path: join(scratch, 'old-place', 'voice.wav'), relativePath: 'voice.wav' }], join(projectDirectory, 'project.json'))
    expect(states.voice).toMatchObject({ info: { kind: 'audio' } })
    await session.dispose()
  })
})
