import { describe, expect, it } from 'vitest'
import { createByteLru } from './byteLru.js'

describe('createByteLru', () => {
  it('evicts the least recently used entries once over budget', () => {
    const evicted: string[] = []
    const cache = createByteLru<string>(100, (value) => evicted.push(value))
    cache.set('a', 'A', 40)
    cache.set('b', 'B', 40)
    cache.set('c', 'C', 40)
    expect(evicted).toEqual(['A'])
    expect(cache.size()).toBe(80)
    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('b')).toBe('B')
  })

  it('treats a read as a use', () => {
    const evicted: string[] = []
    const cache = createByteLru<string>(100, (value) => evicted.push(value))
    cache.set('a', 'A', 40)
    cache.set('b', 'B', 40)
    cache.get('a')
    cache.set('c', 'C', 40)
    expect(evicted).toEqual(['B'])
  })

  it('keeps a single entry that is larger than the whole budget', () => {
    const evicted: string[] = []
    const cache = createByteLru<string>(100, (value) => evicted.push(value))
    cache.set('small', 'S', 10)
    cache.set('huge', 'H', 500)
    expect(evicted).toEqual(['S'])
    expect(cache.get('huge')).toBe('H')
    expect(cache.size()).toBe(500)
  })

  it('releases the old value when a key is replaced', () => {
    const evicted: string[] = []
    const cache = createByteLru<string>(100, (value) => evicted.push(value))
    cache.set('a', 'old', 30)
    cache.set('a', 'new', 50)
    expect(evicted).toEqual(['old'])
    expect(cache.size()).toBe(50)
    expect(cache.get('a')).toBe('new')
  })

  it('releases everything on clear', () => {
    const evicted: string[] = []
    const cache = createByteLru<string>(100, (value) => evicted.push(value))
    cache.set('a', 'A', 10)
    cache.set('b', 'B', 10)
    cache.clear()
    expect(evicted).toEqual(['A', 'B'])
    expect(cache.size()).toBe(0)
  })
})
