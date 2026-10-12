/** A cache with a byte budget: adding past the budget evicts the least recently used entries. */
export type ByteLru<Value> = {
  /** The value for `key`, marked as most recently used. */
  get(key: string): Value | undefined
  set(key: string, value: Value, bytes: number): void
  clear(): void
  /** Bytes currently held. */
  size(): number
}

type Entry<Value> = {
  value: Value
  bytes: number
}

/** `onEvict` is called for every value that leaves the cache, so its owner can release it. */
export function createByteLru<Value>(maxBytes: number, onEvict: (value: Value) => void): ByteLru<Value> {
  // A Map iterates in insertion order, so the first entry is always the least recently used.
  const entries = new Map<string, Entry<Value>>()
  let heldBytes = 0

  function remove(key: string): void {
    const entry = entries.get(key)
    if (entry === undefined) return
    entries.delete(key)
    heldBytes -= entry.bytes
    onEvict(entry.value)
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
    for (const oldestKey of entries.keys()) {
      // The newest entry stays even when it alone exceeds the budget: it is about to be used.
      if (heldBytes <= maxBytes || oldestKey === key) break
      remove(oldestKey)
    }
  }

  function clear(): void {
    for (const key of [...entries.keys()]) remove(key)
  }

  return { get, set, clear, size: () => heldBytes }
}
