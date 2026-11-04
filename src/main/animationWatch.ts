import { watch, type FSWatcher } from 'node:fs'
import { dirname, join } from 'node:path'
import { logError } from '../shared/log.js'

const SETTLE_MS = 150

export type AnimationWatch = {
  setPaths(paths: ReadonlySet<string>): void
  close(): void
}

// Folders are watched, not files: an atomic save replaces the file, which would end a watch on it.
export function createAnimationWatch(onChange: (path: string) => void): AnimationWatch {
  const watchers = new Map<string, FSWatcher>()
  const settling = new Map<string, ReturnType<typeof setTimeout>>()
  let watched: ReadonlySet<string> = new Set()

  function noteChange(directory: string, fileName: string | null): void {
    if (fileName === null) return
    const path = join(directory, fileName)
    if (!watched.has(path)) return
    clearTimeout(settling.get(path))
    settling.set(
      path,
      setTimeout(() => {
        settling.delete(path)
        if (watched.has(path)) onChange(path)
      }, SETTLE_MS),
    )
  }

  function startWatching(directory: string): void {
    let watcher: FSWatcher
    try {
      watcher = watch(directory, { persistent: false }, (_event, fileName) => noteChange(directory, fileName))
    } catch (error) {
      logError('Could not watch a folder of animations', error, { directory })
      return
    }
    watcher.on('error', (error) => {
      logError('Stopped watching a folder of animations', error, { directory })
      watcher.close()
      watchers.delete(directory)
    })
    watchers.set(directory, watcher)
  }

  return {
    setPaths(paths) {
      watched = paths
      const directories = new Set<string>()
      for (const path of paths) directories.add(dirname(path))
      for (const [directory, watcher] of watchers) {
        if (directories.has(directory)) continue
        watcher.close()
        watchers.delete(directory)
      }
      for (const directory of directories) {
        if (!watchers.has(directory)) startWatching(directory)
      }
    },
    close() {
      for (const timer of settling.values()) clearTimeout(timer)
      settling.clear()
      for (const watcher of watchers.values()) watcher.close()
      watchers.clear()
    },
  }
}
