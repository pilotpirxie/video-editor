import { describe, expect, it } from 'vitest'
import { shortcutFor, shortcutHint, type KeyPress } from './shortcuts.js'

function press(code: string, held: Partial<KeyPress> = {}): KeyPress {
  return { code, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...held }
}

describe('shortcutFor', () => {
  it('maps the Camtasia transport keys', () => {
    expect(shortcutFor(press('Space'))).toBe('play-pause')
    expect(shortcutFor(press('Comma'))).toBe('step-back')
    expect(shortcutFor(press('Period'))).toBe('step-forward')
    expect(shortcutFor(press('Comma', { ctrlKey: true }))).toBe('previous-edit')
    expect(shortcutFor(press('Period', { ctrlKey: true }))).toBe('next-edit')
    expect(shortcutFor(press('Comma', { ctrlKey: true, shiftKey: true }))).toBe('jump-back')
    expect(shortcutFor(press('Period', { ctrlKey: true, shiftKey: true }))).toBe('jump-forward')
    expect(shortcutFor(press('Enter', { metaKey: true }))).toBe('go-to-start')
    expect(shortcutFor(press('Enter', { metaKey: true, shiftKey: true }))).toBe('go-to-end')
  })

  it('maps J, K and L to the shuttle', () => {
    expect(shortcutFor(press('KeyJ'))).toBe('shuttle-back')
    expect(shortcutFor(press('KeyK'))).toBe('shuttle-stop')
    expect(shortcutFor(press('KeyL'))).toBe('shuttle-forward')
  })

  it('steps a frame with the arrow keys', () => {
    expect(shortcutFor(press('ArrowLeft'))).toBe('step-back')
    expect(shortcutFor(press('ArrowRight'))).toBe('step-forward')
  })

  it('maps the timeline zoom keys', () => {
    expect(shortcutFor(press('Equal', { metaKey: true, shiftKey: true }))).toBe('timeline-zoom-in')
    expect(shortcutFor(press('Minus', { metaKey: true, shiftKey: true }))).toBe('timeline-zoom-out')
    expect(shortcutFor(press('Digit0', { metaKey: true, shiftKey: true }))).toBe('timeline-zoom-fit')
  })

  it('needs exactly the modifiers of the shortcut', () => {
    expect(shortcutFor(press('KeyJ', { metaKey: true }))).toBeUndefined()
    expect(shortcutFor(press('Space', { shiftKey: true }))).toBeUndefined()
    expect(shortcutFor(press('Comma', { altKey: true }))).toBeUndefined()
    expect(shortcutFor(press('Enter'))).toBeUndefined()
    expect(shortcutFor(press('KeyQ'))).toBeUndefined()
  })
})

describe('shortcutHint', () => {
  it('names the first key of an action', () => {
    expect(shortcutHint('play-pause')).toBe('Space')
    expect(shortcutHint('step-back')).toBe(',')
    expect(shortcutHint('go-to-start')).toBe('⌘↩')
  })
})
