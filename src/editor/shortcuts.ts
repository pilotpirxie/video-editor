export type ShortcutAction =
  | 'play-pause'
  | 'step-back'
  | 'step-forward'
  | 'jump-back'
  | 'jump-forward'
  | 'previous-edit'
  | 'next-edit'
  | 'go-to-start'
  | 'go-to-end'
  | 'shuttle-back'
  | 'shuttle-stop'
  | 'shuttle-forward'
  | 'timeline-zoom-in'
  | 'timeline-zoom-out'
  | 'timeline-zoom-fit'

type Modifier = 'meta' | 'ctrl' | 'shift'

// The part of a keyboard event a shortcut is matched on. `code` names the physical key, so the keys stay put on every keyboard layout.
export type KeyPress = {
  code: string
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
}

type Shortcut = {
  action: ShortcutAction
  code: string
  modifiers: readonly Modifier[]
  // How the keys are written in a tooltip.
  hint: string
}

// The defaults of Camtasia for Mac, plus the arrow keys and K, which editors share. Shortcuts that need Cmd and belong to a menu item live in the menu instead.
const SHORTCUTS: readonly Shortcut[] = [
  { action: 'play-pause', code: 'Space', modifiers: [], hint: 'Space' },
  { action: 'step-back', code: 'Comma', modifiers: [], hint: ',' },
  { action: 'step-forward', code: 'Period', modifiers: [], hint: '.' },
  { action: 'step-back', code: 'ArrowLeft', modifiers: [], hint: '←' },
  { action: 'step-forward', code: 'ArrowRight', modifiers: [], hint: '→' },
  { action: 'jump-back', code: 'Comma', modifiers: ['ctrl', 'shift'], hint: '⌃⇧,' },
  { action: 'jump-forward', code: 'Period', modifiers: ['ctrl', 'shift'], hint: '⌃⇧.' },
  { action: 'previous-edit', code: 'Comma', modifiers: ['ctrl'], hint: '⌃,' },
  { action: 'next-edit', code: 'Period', modifiers: ['ctrl'], hint: '⌃.' },
  { action: 'go-to-start', code: 'Enter', modifiers: ['meta'], hint: '⌘↩' },
  { action: 'go-to-end', code: 'Enter', modifiers: ['meta', 'shift'], hint: '⇧⌘↩' },
  { action: 'shuttle-back', code: 'KeyJ', modifiers: [], hint: 'J' },
  { action: 'shuttle-stop', code: 'KeyK', modifiers: [], hint: 'K' },
  { action: 'shuttle-forward', code: 'KeyL', modifiers: [], hint: 'L' },
  { action: 'timeline-zoom-in', code: 'Equal', modifiers: ['meta', 'shift'], hint: '⇧⌘=' },
  { action: 'timeline-zoom-out', code: 'Minus', modifiers: ['meta', 'shift'], hint: '⇧⌘-' },
  { action: 'timeline-zoom-fit', code: 'Digit0', modifiers: ['meta', 'shift'], hint: '⇧⌘0' },
]

function hasExactly(press: KeyPress, modifiers: readonly Modifier[]): boolean {
  return press.metaKey === modifiers.includes('meta') && press.ctrlKey === modifiers.includes('ctrl') && press.shiftKey === modifiers.includes('shift') && !press.altKey
}

export function shortcutFor(press: KeyPress): ShortcutAction | undefined {
  return SHORTCUTS.find((shortcut) => shortcut.code === press.code && hasExactly(press, shortcut.modifiers))?.action
}

export function shortcutHint(action: ShortcutAction): string | undefined {
  return SHORTCUTS.find((shortcut) => shortcut.action === action)?.hint
}
