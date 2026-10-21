export type ByteLru<Value> = {
  get(key: string): Value | undefined
  set(key: string, value: Value, bytes: number): void
  delete(key: string): void
  setLimit(maxBytes: number): void
  keep(keys: ReadonlySet<string>): void
  hasRoom(): boolean
  clear(): void
  size(): number
}

type Entry<Value> = {
  value: Value
  bytes: number
}

export function createByteLru<Value>(initialMaxBytes: number, onEvict: (value: Value) => void): ByteLru<Value> {
  const entries = new Map<string, Entry<Value>>()
  let maxBytes = initialMaxBytes
  let heldBytes = 0
  let kept: ReadonlySet<string> = new Set()

  function remove(key: string): void {
    const entry = entries.get(key)
    if (entry === undefined) return
    entries.delete(key)
    heldBytes -= entry.bytes
    onEvict(entry.value)
  }

  function evictOverLimit(keyToKeep: string | undefined): void {
    for (const oldestKey of entries.keys()) {
      if (heldBytes <= maxBytes) return
      if (oldestKey !== keyToKeep && !kept.has(oldestKey)) remove(oldestKey)
    }
  }

  function get(key: string): Value | undefined {
    const entry = entries.get(key)
    if (entry === undefined) return undefined
    entries.delete(key)
    entries.set(key, entry)
    return entry.value
  }

  function set(key: string, value: Value, bytes: number): void {
    remove(key)
    entries.set(key, { value, bytes })
    heldBytes += bytes
    evictOverLimit(key)
  }

  function setLimit(nextMaxBytes: number): void {
    maxBytes = nextMaxBytes
    evictOverLimit(undefined)
  }

  function keep(keys: ReadonlySet<string>): void {
    kept = keys
    evictOverLimit(undefined)
  }

  function clear(): void {
    for (const key of [...entries.keys()]) remove(key)
  }

  return { get, set, delete: remove, setLimit, keep, hasRoom: () => heldBytes < maxBytes, clear, size: () => heldBytes }
}
