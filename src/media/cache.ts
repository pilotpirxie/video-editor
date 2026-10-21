import { randomUUID } from 'node:crypto'
import { readdir, rm, stat, statfs, utimes } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { logError } from '../shared/log.js'
import { DEFAULT_SETTINGS, unusedMediaMs } from '../shared/settings.js'

const TEMPORARY_SUFFIX = '.tmp'
const MEDIA_FACTS_NAME = 'info'
const FIRST_LAYOUT_MEDIA_FOLDER = /^[0-9a-f]{32}$/

type EvictionUnit = {
  files: Set<string>
  bytes: number
  usedAt: number
}

type Deferred = {
  promise: Promise<void>
  resolve(): void
  reject(error: Error): void
}

export type BuildClaim = {
  paths: readonly string[]
  written(path: string): void
  giveUp(error: Error): void
}

export type DiskCache = {
  readonly directory: string
  readonly ready: Promise<void>
  temporaryPathFor(path: string): string
  added(path: string): Promise<void>
  used(path: string): void
  protect(owner: object, paths: ReadonlySet<string>): void
  claim(paths: readonly string[]): BuildClaim
  has(path: string): boolean
  pending(path: string): Promise<void> | undefined
  totalBytes(): number
  limitBytes(): number
  setLimit(bytes: number): Promise<void>
  bytesOf(path: string): number | undefined
  clear(): Promise<void>
  freeBytes(): Promise<number>
}

function unitKeyOf(path: string): string {
  return join(dirname(path), basename(path, extname(path)))
}

function deferred(): Deferred {
  let resolve: () => void = () => {}
  let reject: (error: Error) => void = () => {}
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  // A build nobody waits for must not report an unhandled rejection; waiters still see it.
  promise.catch(() => {})
  return { promise, resolve, reject }
}

async function sizeOf(path: string): Promise<{ bytes: number; modifiedAt: number } | undefined> {
  try {
    const found = await stat(path)
    return { bytes: found.size, modifiedAt: found.mtimeMs }
  } catch (error) {
    logError('A cache file vanished before it was counted', error, { path })
    return undefined
  }
}

export function createDiskCache(directory: string, initialLimitBytes: number, maxUnusedMs = unusedMediaMs(DEFAULT_SETTINGS)): DiskCache {
  let limitBytes = initialLimitBytes
  const units = new Map<string, EvictionUnit>()
  const protectedBy = new Map<object, ReadonlySet<string>>()
  const building = new Map<string, Deferred>()
  let total = 0
  let evicting: Promise<void> = Promise.resolve()

  function record(path: string, bytes: number, usedAt: number): void {
    const key = unitKeyOf(path)
    let unit = units.get(key)
    if (unit === undefined) {
      unit = { files: new Set(), bytes: 0, usedAt }
      units.set(key, unit)
    }
    if (unit.files.has(path)) return
    unit.files.add(path)
    unit.bytes += bytes
    unit.usedAt = Math.max(unit.usedAt, usedAt)
    total += bytes
  }

  function isBeingBuilt(key: string): boolean {
    for (const path of building.keys()) {
      if (unitKeyOf(path) === key) return true
    }
    return false
  }

  async function removeUnit(key: string, unit: EvictionUnit): Promise<void> {
    units.delete(key)
    total -= unit.bytes
    // An index goes before its pictures, so a half-removed segment reads as missing rather than broken.
    const files = [...unit.files].sort((a, b) => Number(b.endsWith('.idx')) - Number(a.endsWith('.idx')))
    for (const file of files) await rm(file, { force: true })
  }

  async function evictOverLimit(): Promise<void> {
    if (total <= limitBytes) return
    const protectedKeys = new Set<string>()
    for (const paths of protectedBy.values()) {
      for (const path of paths) protectedKeys.add(unitKeyOf(path))
    }
    const candidates = [...units.entries()].filter(([key]) => !protectedKeys.has(key) && !isBeingBuilt(key))
    candidates.sort((a, b) => a[1].usedAt - b[1].usedAt)
    for (const [key, unit] of candidates) {
      if (total <= limitBytes) return
      try {
        await removeUnit(key, unit)
      } catch (error) {
        logError('Could not remove a cache file to stay under the limit', error, { key })
      }
    }
  }

  async function scanMediaFolder(folder: string, unusedSince: number): Promise<void> {
    const files: { path: string; bytes: number; modifiedAt: number }[] = []
    let lastUsedAt = 0
    for (const name of await readdir(folder)) {
      const path = join(folder, name)
      if (name.endsWith(TEMPORARY_SUFFIX)) {
        await rm(path, { force: true })
        continue
      }
      const size = await sizeOf(path)
      if (size === undefined) continue
      files.push({ path, ...size })
      lastUsedAt = Math.max(lastUsedAt, size.modifiedAt)
    }
    if (lastUsedAt < unusedSince) {
      await rm(folder, { recursive: true, force: true })
      return
    }
    for (const file of files) record(file.path, file.bytes, file.modifiedAt)
  }

  async function removeOldLayout(): Promise<void> {
    const parent = dirname(directory)
    let names: string[]
    try {
      names = await readdir(parent)
    } catch (error) {
      logError('Could not look for an old cache to remove', error, { parent })
      return
    }
    for (const name of names) {
      if (FIRST_LAYOUT_MEDIA_FOLDER.test(name)) await rm(join(parent, name), { recursive: true, force: true })
    }
  }

  async function scan(): Promise<void> {
    let folders: string[]
    try {
      folders = await readdir(directory)
    } catch (error) {
      const hasNoCacheYet = error instanceof Error && 'code' in error && error.code === 'ENOENT'
      if (!hasNoCacheYet) logError('Could not read the cache folder', error, { directory })
      folders = []
    }
    const unusedSince = Date.now() - maxUnusedMs
    for (const folder of folders) {
      try {
        await scanMediaFolder(join(directory, folder), unusedSince)
      } catch (error) {
        logError('Could not count a cache folder', error, { folder })
      }
    }
    await evictOverLimit()
    void removeOldLayout()
  }

  const ready = scan()

  async function added(path: string): Promise<void> {
    await ready
    const size = await sizeOf(path)
    if (size === undefined) return
    record(path, size.bytes, Date.now())
    evicting = evicting.then(evictOverLimit, evictOverLimit)
    await evicting
  }

  async function setLimit(bytes: number): Promise<void> {
    limitBytes = bytes
    evicting = evicting.then(evictOverLimit, evictOverLimit)
    await evicting
  }

  async function clear(): Promise<void> {
    await ready
    for (const [key, unit] of [...units.entries()]) {
      if (basename(key) === MEDIA_FACTS_NAME || isBeingBuilt(key)) continue
      try {
        await removeUnit(key, unit)
      } catch (error) {
        logError('Could not remove a cache file while clearing the cache', error, { key })
      }
    }
  }

  async function freeBytes(): Promise<number> {
    const disk = await statfs(directory)
    return disk.bavail * disk.bsize
  }

  function bytesOf(path: string): number | undefined {
    const unit = units.get(unitKeyOf(path))
    if (unit === undefined || !unit.files.has(path)) return undefined
    return unit.bytes
  }

  function used(path: string): void {
    const unit = units.get(unitKeyOf(path))
    if (unit !== undefined) unit.usedAt = Date.now()
  }

  // A file that becomes needed is marked on disk as well, so the order of use survives a restart.
  function protect(owner: object, paths: ReadonlySet<string>): void {
    const before = protectedBy.get(owner) ?? new Set<string>()
    protectedBy.set(owner, paths)
    const now = new Date()
    for (const path of paths) {
      if (before.has(path)) continue
      const unit = units.get(unitKeyOf(path))
      if (unit === undefined || !unit.files.has(path)) continue
      unit.usedAt = now.getTime()
      utimes(path, now, now).catch((error: unknown) => logError('Could not mark a cache file as used', error, { path }))
    }
    if (paths.size === 0) protectedBy.delete(owner)
  }

  function claim(paths: readonly string[]): BuildClaim {
    const claimed: string[] = []
    for (const path of paths) {
      if (building.has(path)) continue
      building.set(path, deferred())
      claimed.push(path)
    }
    const open = new Set(claimed)
    return {
      paths: claimed,
      written(path) {
        if (!open.delete(path)) return
        building.get(path)?.resolve()
        building.delete(path)
      },
      giveUp(error) {
        for (const path of open) {
          building.get(path)?.reject(error)
          building.delete(path)
        }
        open.clear()
      },
    }
  }

  return {
    directory,
    ready,
    temporaryPathFor: (path) => `${path}.${randomUUID()}${TEMPORARY_SUFFIX}`,
    added,
    used,
    protect,
    claim,
    pending: (path) => building.get(path)?.promise,
    has: (path) => units.get(unitKeyOf(path))?.files.has(path) === true,
    totalBytes: () => total,
    limitBytes: () => limitBytes,
    setLimit,
    bytesOf,
    clear,
    freeBytes,
  }
}
