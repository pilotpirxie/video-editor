import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createDiskCache, type DiskCache } from './cache.js'

const scratch = await mkdtemp(join(tmpdir(), 'disk-cache-'))
const KIBIBYTE = 1024

afterAll(() => rm(scratch, { recursive: true, force: true }))

async function emptyCache(limitBytes: number): Promise<DiskCache> {
  const directory = await mkdtemp(join(scratch, 'cache-'))
  const cache = createDiskCache(directory, limitBytes)
  await cache.ready
  return cache
}

async function put(cache: DiskCache, name: string, bytes: number): Promise<string> {
  const folder = join(cache.directory, 'media')
  await mkdir(folder, { recursive: true })
  const path = join(folder, name)
  await writeFile(path, Buffer.alloc(bytes))
  await cache.added(path)
  return path
}

describe('createDiskCache', () => {
  it('counts what an earlier run left, removes unfinished files and old-layout folders', async () => {
    const parent = await mkdtemp(join(scratch, 'parent-'))
    const directory = join(parent, 'v2')
    const media = join(directory, 'media')
    const oldLayout = join(parent, '0123456789abcdef0123456789abcdef')
    await mkdir(media, { recursive: true })
    await mkdir(oldLayout)
    await writeFile(join(media, 'audio-0.f32'), Buffer.alloc(3 * KIBIBYTE))
    await writeFile(join(media, 'audio-1.f32.1234.tmp'), Buffer.alloc(KIBIBYTE))

    const cache = createDiskCache(directory, 100 * KIBIBYTE)
    await cache.ready
    await expect.poll(() => existsSync(oldLayout)).toBe(false)

    expect(cache.totalBytes()).toBe(3 * KIBIBYTE)
    expect(cache.has(join(media, 'audio-0.f32'))).toBe(true)
    expect(existsSync(join(media, 'audio-1.f32.1234.tmp'))).toBe(false)
  })

  it('removes what was used longest ago once over the limit', async () => {
    const cache = await emptyCache(3 * KIBIBYTE)
    const first = await put(cache, 'audio-0.f32', KIBIBYTE)
    const second = await put(cache, 'audio-1.f32', KIBIBYTE)
    const third = await put(cache, 'audio-2.f32', KIBIBYTE)
    await new Promise((resolve) => setTimeout(resolve, 5))
    cache.used(first)
    await put(cache, 'audio-3.f32', KIBIBYTE)

    expect(existsSync(first)).toBe(true)
    expect(existsSync(second)).toBe(false)
    expect(existsSync(third)).toBe(true)
    expect(cache.has(second)).toBe(false)
    expect(cache.totalBytes()).toBe(3 * KIBIBYTE)
  })

  it('keeps the order of use across a restart', async () => {
    const parent = await mkdtemp(join(scratch, 'restart-'))
    const media = join(parent, 'media')
    await mkdir(media)
    const older = join(media, 'audio-0.f32')
    const newer = join(media, 'audio-1.f32')
    await writeFile(older, Buffer.alloc(KIBIBYTE))
    await writeFile(newer, Buffer.alloc(KIBIBYTE))
    await utimes(older, new Date(1_000_000), new Date(1_000_000))

    const cache = createDiskCache(parent, KIBIBYTE)
    await cache.ready

    expect(existsSync(older)).toBe(false)
    expect(existsSync(newer)).toBe(true)
  })

  it('removes a preview segment with its index, and never a protected or unfinished one', async () => {
    const cache = await emptyCache(4 * KIBIBYTE)
    const pictures = await put(cache, 'preview-0.mjpeg', KIBIBYTE)
    const index = await put(cache, 'preview-0.idx', KIBIBYTE)
    const wanted = await put(cache, 'audio-0.f32', KIBIBYTE)
    const owner = {}
    cache.protect(owner, new Set([wanted]))
    const building = join(cache.directory, 'media', 'audio-1.f32')
    const claim = cache.claim([building])
    await writeFile(building, Buffer.alloc(KIBIBYTE))
    await cache.added(building)

    await put(cache, 'audio-2.f32', KIBIBYTE)

    expect(existsSync(pictures)).toBe(false)
    expect(existsSync(index)).toBe(false)
    expect(existsSync(wanted)).toBe(true)
    expect(existsSync(building)).toBe(true)
    claim.written(building)

    cache.protect(owner, new Set())
    await put(cache, 'audio-3.f32', 2 * KIBIBYTE)
    expect(existsSync(wanted)).toBe(false)
  })

  it('lets one run build a file and others wait for it', async () => {
    const cache = await emptyCache(100 * KIBIBYTE)
    const path = join(cache.directory, 'media', 'audio-0.f32')
    const first = cache.claim([path])
    const second = cache.claim([path])
    expect(first.paths).toEqual([path])
    expect(second.paths).toEqual([])

    const waited = cache.pending(path)
    first.written(path)
    await expect(waited).resolves.toBeUndefined()
    expect(cache.pending(path)).toBeUndefined()

    const third = cache.claim([path])
    const failed = cache.pending(path)
    third.giveUp(new Error('cancelled'))
    await expect(failed).rejects.toThrow('cancelled')
    expect(cache.claim([path]).paths).toEqual([path])
  })
})
