import { describe, expect, it } from 'vitest'
import { DEFAULT_BINDINGS, acceleratorOf, actionFor, bindingOf, conflictsOf, hintOf, parseBindings, reservedBy, type KeyPress } from './shortcuts.js'

function press(code: string, held: Partial<KeyPress> = {}): KeyPress {
  return { code, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...held }
}

describe('actionFor with the default keys', () => {
  function defaultFor(code: string, held: Partial<KeyPress> = {}): string | undefined {
    return actionFor(DEFAULT_BINDINGS, press(code, held))
  }

  it('maps the default transport keys', () => {
    expect(defaultFor('Space')).toBe('play-pause')
    expect(defaultFor('Comma')).toBe('step-back')
    expect(defaultFor('Period')).toBe('step-forward')
    expect(defaultFor('Comma', { ctrlKey: true })).toBe('previous-edit')
    expect(defaultFor('Period', { ctrlKey: true })).toBe('next-edit')
    expect(defaultFor('Comma', { ctrlKey: true, shiftKey: true })).toBe('jump-back')
    expect(defaultFor('Period', { ctrlKey: true, shiftKey: true })).toBe('jump-forward')
    expect(defaultFor('Enter', { metaKey: true })).toBe('go-to-start')
    expect(defaultFor('Enter', { metaKey: true, shiftKey: true })).toBe('go-to-end')
  })

  it('maps J, K and L to the shuttle and the arrow keys to frame steps', () => {
    expect(defaultFor('KeyJ')).toBe('shuttle-back')
    expect(defaultFor('KeyK')).toBe('shuttle-stop')
    expect(defaultFor('KeyL')).toBe('shuttle-forward')
    expect(defaultFor('ArrowLeft')).toBe('step-back')
    expect(defaultFor('ArrowRight')).toBe('step-forward')
  })

  it('maps the timeline zoom keys and the editing commands', () => {
    expect(defaultFor('Equal', { metaKey: true, shiftKey: true })).toBe('timeline-zoom-in')
    expect(defaultFor('Digit0', { metaKey: true, shiftKey: true })).toBe('timeline-zoom-fit')
    expect(defaultFor('KeyT', { metaKey: true })).toBe('split')
    expect(defaultFor('KeyT', { metaKey: true, shiftKey: true })).toBe('split-all')
    expect(defaultFor('Backspace')).toBe('delete')
    expect(defaultFor('Delete', { metaKey: true })).toBe('ripple-delete')
    expect(defaultFor('KeyF', { metaKey: true, shiftKey: true })).toBe('preview-mode')
  })

  it('needs exactly the modifiers of the shortcut', () => {
    expect(defaultFor('KeyJ', { metaKey: true })).toBeUndefined()
    expect(defaultFor('Space', { shiftKey: true })).toBeUndefined()
    expect(defaultFor('Comma', { altKey: true })).toBeUndefined()
    expect(defaultFor('Enter')).toBeUndefined()
    expect(defaultFor('KeyQ')).toBeUndefined()
  })
})

describe('bindingOf', () => {
  it('takes the modifiers held with a key, but not a modifier pressed alone', () => {
    expect(bindingOf(press('KeyS', { altKey: true, metaKey: true }))).toEqual({ code: 'KeyS', modifiers: ['alt', 'meta'] })
    expect(bindingOf(press('ShiftLeft', { shiftKey: true }))).toBeUndefined()
    expect(bindingOf(press('IntlBackslash'))).toBeUndefined()
  })
})

describe('writing keys', () => {
  it('writes a key as a Mac does, and as Electron names it in a menu', () => {
    expect(hintOf({ code: 'Enter', modifiers: ['shift', 'meta'] })).toBe('⇧⌘↩')
    expect(hintOf({ code: 'Comma', modifiers: ['ctrl', 'shift'] })).toBe('⌃⇧,')
    expect(hintOf({ code: 'KeyS', modifiers: [] })).toBe('S')
    expect(acceleratorOf({ code: 'Equal', modifiers: ['shift', 'meta'] })).toBe('Shift+Cmd+=')
    expect(acceleratorOf({ code: 'ArrowLeft', modifiers: ['alt'] })).toBe('Alt+Left')
    expect(acceleratorOf({ code: 'Digit7', modifiers: [] })).toBe('7')
  })
})

describe('reservedBy and conflictsOf', () => {
  it('keeps the standard Mac keys and the focus keys for themselves', () => {
    expect(reservedBy({ code: 'KeyS', modifiers: ['meta'] })).toBe('Save')
    expect(reservedBy({ code: 'Tab', modifiers: [] })).toBe('Tab, which moves the focus')
    expect(reservedBy({ code: 'KeyS', modifiers: [] })).toBeUndefined()
  })

  it('names the actions that share a key, on both sides', () => {
    expect(conflictsOf(DEFAULT_BINDINGS).size).toBe(0)
    const shared = { ...DEFAULT_BINDINGS, split: [{ code: 'KeyK', modifiers: [] }] }
    const conflicts = conflictsOf(shared)
    expect(conflicts.get('split')).toEqual(['shuttle-stop'])
    expect(conflicts.get('shuttle-stop')).toEqual(['split'])
    // Only the first action in the list answers to a shared key.
    expect(actionFor(shared, press('KeyK'))).toBe('shuttle-stop')
  })
})

describe('parseBindings', () => {
  it('reads stored keys and keeps the defaults of anything stored wrongly or not at all', () => {
    const stored = {
      split: [{ code: 'KeyS', modifiers: [] }],
      group: [],
      ungroup: [{ code: 'KeyS', modifiers: ['meta'] }],
      duplicate: [{ code: 'NoSuchKey', modifiers: [] }],
      export: [{ code: 'KeyE', modifiers: ['hyper'] }],
      'play-pause': [{ code: 'KeyP', modifiers: [] }, { code: 'KeyO', modifiers: [] }, { code: 'KeyI', modifiers: [] }],
    }
    const bindings = parseBindings(JSON.stringify(stored))
    expect(bindings.split).toEqual([{ code: 'KeyS', modifiers: [] }])
    expect(bindings.group).toEqual([])
    expect(bindings.ungroup).toEqual(DEFAULT_BINDINGS.ungroup)
    expect(bindings.duplicate).toEqual(DEFAULT_BINDINGS.duplicate)
    expect(bindings.export).toEqual(DEFAULT_BINDINGS.export)
    expect(bindings['play-pause']).toEqual(DEFAULT_BINDINGS['play-pause'])
    expect(bindings['step-back']).toEqual(DEFAULT_BINDINGS['step-back'])
  })

  it('falls back to the defaults for missing or broken text', () => {
    expect(parseBindings(undefined)).toBe(DEFAULT_BINDINGS)
    expect(parseBindings('{not json')).toBe(DEFAULT_BINDINGS)
    expect(parseBindings('[1, 2]')).toBe(DEFAULT_BINDINGS)
  })
})
