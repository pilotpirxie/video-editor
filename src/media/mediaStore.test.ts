import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { bundledFfmpeg } from '../../test/helpers.js'
import { mediaPath } from '../../test/media/generate.js'
import { MAX_OPEN_STREAMS } from '../shared/limits.js'
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

describe('MediaSession.streamFrame', () => {
  it('reads from more streams at once than it keeps open, without failing any of them', async () => {
    const session = newSession('many-streams')
    await session.openMedia([{ id: 'clip', path: mediaPath('h264.mp4'), relativePath: '' }], undefined)
    const streamCount = MAX_OPEN_STREAMS + 2
    const ids = await Promise.all(Array.from({ length: streamCount }, () => session.openStream('clip', 0, 0)))
    const frames = await Promise.all(ids.map((id) => session.streamFrame(id, 0)))
    expect(frames).toHaveLength(streamCount)
    await session.dispose()
  })
})

describe('animation files', () => {
  const ANIMATION = { version: 1, canvas: { width: 640, height: 360, frameRate: { num: 12, den: 1 } }, media: [], tracks: [] }

  it('import as animations without being probed', async () => {
    const session = newSession('animation-import')
    const path = join(scratch, 'wave.pbanim')
    await writeFile(path, JSON.stringify(ANIMATION))
    const added = await session.addMedia(path)
    expect(added.info).toEqual({ kind: 'animation', path })
    await session.dispose()
  })

  function animationWith(media: readonly { id: string; relativePath: string }[]): string {
    return JSON.stringify({ ...ANIMATION, media: media.map((reference) => ({ ...reference, path: '' })) })
  }

  async function episodeIn(folder: string, media: readonly { id: string; relativePath: string }[]): Promise<string> {
    const path = join(folder, 'episode.pbproj')
    const canvas = { width: 1920, height: 1080, frameRate: { num: 24, den: 1 } }
    await writeFile(path, JSON.stringify({ version: 1, canvas, media: media.map((reference) => ({ ...reference, path: '' })), tracks: [] }))
    return path
  }

  it('load with the project, nested ones too, each finding its media from its own folder', async () => {
    const folder = join(scratch, 'nested')
    await mkdir(join(folder, 'parts', 'art'), { recursive: true })
    await copyFile(mediaPath('image-red.png'), join(folder, 'parts', 'art', 'red.png'))
    await writeFile(join(folder, 'parts', 'mouths.pbanim'), animationWith([{ id: 'red', relativePath: 'art/red.png' }]))
    await writeFile(join(folder, 'wave.pbanim'), animationWith([{ id: 'mouths', relativePath: 'parts/mouths.pbanim' }]))
    const session = newSession('animation-nested')
    const loaded = await session.loadProject(await episodeIn(folder, [{ id: 'wave', relativePath: 'wave.pbanim' }]), false)
    expect(Object.keys(loaded.documents).sort()).toEqual([join(folder, 'parts', 'mouths.pbanim'), join(folder, 'wave.pbanim')])
    expect(loaded.media.wave).toEqual({ info: { kind: 'animation', path: join(folder, 'wave.pbanim') }, createdAt: expect.any(Number) })
    expect(loaded.media.red).toMatchObject({ info: { kind: 'image' } })
    await session.dispose()
  })

  it('give a media id of their own when another file already uses it for something else', async () => {
    const folder = join(scratch, 'colliding')
    await mkdir(folder, { recursive: true })
    await copyFile(mediaPath('image-red.png'), join(folder, 'red.png'))
    await copyFile(mediaPath('image-blue.png'), join(folder, 'blue.png'))
    await writeFile(join(folder, 'copy.pbanim'), animationWith([{ id: 'art', relativePath: 'blue.png' }]))
    const session = newSession('animation-colliding')
    const loaded = await session.loadProject(await episodeIn(folder, [{ id: 'art', relativePath: 'red.png' }, { id: 'copy', relativePath: 'copy.pbanim' }]), false)
    const renamed = loaded.documents[join(folder, 'copy.pbanim')]?.media[0]?.id ?? 'art'
    expect(renamed).not.toBe('art')
    expect(loaded.media.art).toMatchObject({ info: { kind: 'image' } })
    expect(loaded.media[renamed]).toMatchObject({ info: { kind: 'image' } })
    await session.dispose()
  })

  it('read a stand-in file, such as a recovery copy, as if it were the real one', async () => {
    const folder = join(scratch, 'overridden')
    await mkdir(join(folder, 'recovery'), { recursive: true })
    await copyFile(mediaPath('image-red.png'), join(folder, 'red.png'))
    await writeFile(join(folder, 'wave.pbanim'), animationWith([]))
    await writeFile(join(folder, 'recovery', 'wave.pbanim'), animationWith([{ id: 'red', relativePath: '../red.png' }]))
    const session = newSession('animation-overridden')
    const episode = await episodeIn(folder, [{ id: 'wave', relativePath: 'wave.pbanim' }])
    const loaded = await session.loadProject(episode, false, { [join(folder, 'wave.pbanim')]: join(folder, 'recovery', 'wave.pbanim') })
    expect(loaded.documents[join(folder, 'wave.pbanim')]?.media).toEqual([{ id: 'red', path: '', relativePath: 'red.png' }])
    expect(loaded.media.red).toMatchObject({ info: { kind: 'image' } })
    await session.dispose()
  })

  it('save their media paths relative to themselves', async () => {
    const folder = join(scratch, 'saved')
    await mkdir(join(folder, 'parts'), { recursive: true })
    await copyFile(mediaPath('image-red.png'), join(folder, 'red.png'))
    await writeFile(join(folder, 'parts', 'wave.pbanim'), animationWith([{ id: 'red', relativePath: '../red.png' }]))
    const session = newSession('animation-saved')
    const loaded = await session.loadProject(await episodeIn(folder, [{ id: 'wave', relativePath: 'parts/wave.pbanim' }]), false)
    const path = join(folder, 'parts', 'wave.pbanim')
    const document = loaded.documents[path]
    if (document === undefined) throw new Error('The animation did not load')
    await session.saveProject(path, document, path)
    const saved: unknown = JSON.parse(await readFile(path, 'utf8'))
    expect(saved).toMatchObject({ media: [{ id: 'red', path: join(folder, 'red.png'), relativePath: '../red.png' }] })
    await session.dispose()
  })

  it('load a file that contains itself without reading it again', async () => {
    const folder = join(scratch, 'cyclic')
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, 'a.pbanim'), animationWith([{ id: 'self', relativePath: 'a.pbanim' }, { id: 'b', relativePath: 'b.pbanim' }]))
    await writeFile(join(folder, 'b.pbanim'), animationWith([{ id: 'back', relativePath: 'a.pbanim' }]))
    const session = newSession('animation-cyclic')
    const loaded = await session.loadProject(await episodeIn(folder, [{ id: 'a', relativePath: 'a.pbanim' }]), false)
    expect(Object.keys(loaded.documents).sort()).toEqual([join(folder, 'a.pbanim'), join(folder, 'b.pbanim')])
    expect(loaded.media.self).toEqual(loaded.media.a)
    await session.dispose()
  })

  it('are missing media when gone, and relink only to another animation', async () => {
    const folder = join(scratch, 'relinked')
    await mkdir(folder, { recursive: true })
    await copyFile(mediaPath('image-red.png'), join(folder, 'red.png'))
    await writeFile(join(folder, 'found.pbanim'), animationWith([{ id: 'red', relativePath: 'red.png' }]))
    const session = newSession('animation-relinked')
    const loaded = await session.loadProject(await episodeIn(folder, [{ id: 'wave', relativePath: 'gone.pbanim' }]), false)
    expect(loaded.media.wave).toMatchObject({ isMissing: true })
    const wanted = { reference: { id: 'wave', path: '', relativePath: 'gone.pbanim' }, uses: ['animation' as const] }
    await expect(session.relinkMedia(join(folder, 'red.png'), wanted, [])).rejects.toThrow('the project uses that file for its animation')
    const relinked = await session.relinkMedia(join(folder, 'found.pbanim'), wanted, [])
    expect(relinked).toMatchObject([{ id: 'wave', info: { kind: 'animation', path: join(folder, 'found.pbanim') } }])
    const added = await session.loadAnimations([join(folder, 'found.pbanim')])
    expect(Object.keys(added.documents)).toEqual([join(folder, 'found.pbanim')])
    expect(added.media.red).toMatchObject({ info: { kind: 'image' } })
    await session.dispose()
  })

  it('are refused with the reason when they cannot be read as an animation', async () => {
    const session = newSession('animation-broken')
    const path = join(scratch, 'broken.pbanim')
    await writeFile(path, JSON.stringify({ ...ANIMATION, camera: [] }))
    await expect(session.addMedia(path)).rejects.toThrow('"broken.pbanim" cannot be used: camera is not allowed: an animation has no camera')
    await session.dispose()
  })
})
