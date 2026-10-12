export type ByteLru<Value> = {
  get(key: string): Value | undefined
  set(key: string, value: Value, bytes: number): void
  clear(): void
  size(): number
}

type Entry<Value> = {
  value: Value
  bytes: number
}

export function createByteLru<Value>(maxBytes: number, onEvict: (value: Value) => void): ByteLru<Value> {
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
      if (heldBytes <= maxBytes || oldestKey === key) break
      remove(oldestKey)
    }
  }

  function clear(): void {
    for (const key of [...entries.keys()]) remove(key)
  }

  return { get, set, clear, size: () => heldBytes }
}
