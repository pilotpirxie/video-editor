import { randomUUID } from 'node:crypto'
import { readdir, rm, stat, utimes } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { logError } from '../shared/log.js'

const TEMPORARY_SUFFIX = '.tmp'
// Media folders of the first cache layout, which sat directly in the parent of this one.
const OLD_LAYOUT_FOLDER = /^[0-9a-f]{32}$/

// Files that are made and removed together: a preview segment's pictures and their index.
type Unit = {
  files: Set<string>
  bytes: number
  usedAt: number
}

type Deferred = {
  promise: Promise<void>
  resolve(): void
  reject(error: Error): void
}

// A claim on files a run is about to write. Each is settled once: written, or given up when the run stops.
export type BuildClaim = {
  paths: readonly string[]
  written(path: string): void
  giveUp(error: Error): void
}

export type DiskCache = {
  readonly directory: string
  // Resolves once what earlier runs left on disk has been counted.
  readonly ready: Promise<void>
  // A name beside `path` to write to. Renamed onto `path` when complete, so a file under its own name is always whole.
  temporaryPathFor(path: string): string
  // Counts a file just put under its final name, then removes the least recently used files while the cache is over its limit.
  added(path: string): Promise<void>
  used(path: string): void
  // What a session needs now is never removed. Each call replaces what that owner protected before.
  protect(owner: object, paths: ReadonlySet<string>): void
  // Claims the files a run will write, leaving out those someone else is writing already.
  claim(paths: readonly string[]): BuildClaim
  // Whether a whole file is in the cache, without asking the disk.
  has(path: string): boolean
  // The build of a file in progress, if any.
  pending(path: string): Promise<void> | undefined
  totalBytes(): number
  limitBytes(): number
}

// Files that belong together share their name before the extension.
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

// One disk cache for the whole media process: every window's session prepares into it, and it stays under its limit by removing what was used longest ago.
export function createDiskCache(directory: string, limitBytes: number): DiskCache {
  const units = new Map<string, Unit>()
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

  async function removeUnit(key: string, unit: Unit): Promise<void> {
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

  async function scanMediaFolder(folder: string): Promise<void> {
    for (const name of await readdir(folder)) {
      const path = join(folder, name)
      if (name.endsWith(TEMPORARY_SUFFIX)) {
        await rm(path, { force: true })
        continue
      }
      const size = await sizeOf(path)
      if (size !== undefined) record(path, size.bytes, size.modifiedAt)
    }
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
      if (OLD_LAYOUT_FOLDER.test(name)) await rm(join(parent, name), { recursive: true, force: true })
    }
  }

  async function scan(): Promise<void> {
    let folders: string[]
    try {
      folders = await readdir(directory)
    } catch {
      // No cache yet: nothing to count.
      folders = []
    }
    for (const folder of folders) {
      try {
        await scanMediaFolder(join(directory, folder))
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
  }
}
