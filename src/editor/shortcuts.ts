import type { MenuAction, MenuShortcuts } from '../shared/mediaProtocol.js'

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
  | 'split'
  | 'split-all'
  | 'duplicate'
  | 'delete'
  | 'ripple-delete'
  | 'group'
  | 'ungroup'
  | 'tool-move'
  | 'tool-shape'
  | 'bring-to-front'
  | 'bring-forward'
  | 'send-backward'
  | 'send-to-back'
  | 'import'
  | 'new-animation'
  | 'export'
  | 'preview-mode'

type Modifier = 'ctrl' | 'alt' | 'shift' | 'meta'

export type KeyPress = {
  code: string
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
}

export type Binding = {
  code: string
  modifiers: readonly Modifier[]
}

export type Bindings = Readonly<Record<ShortcutAction, readonly Binding[]>>

type ShortcutSection = 'Playback' | 'Timeline' | 'Editing' | 'Drawing' | 'File and view'

export const SHORTCUT_ACTIONS: readonly { action: ShortcutAction; name: string; section: ShortcutSection }[] = [
  { action: 'play-pause', name: 'Play or pause', section: 'Playback' },
  { action: 'step-back', name: 'Previous frame', section: 'Playback' },
  { action: 'step-forward', name: 'Next frame', section: 'Playback' },
  { action: 'jump-back', name: 'Fifteen frames back', section: 'Playback' },
  { action: 'jump-forward', name: 'Fifteen frames forward', section: 'Playback' },
  { action: 'previous-edit', name: 'Previous clip edge', section: 'Playback' },
  { action: 'next-edit', name: 'Next clip edge', section: 'Playback' },
  { action: 'go-to-start', name: 'Start of the timeline', section: 'Playback' },
  { action: 'go-to-end', name: 'End of the timeline', section: 'Playback' },
  { action: 'shuttle-back', name: 'Play backwards', section: 'Playback' },
  { action: 'shuttle-stop', name: 'Stop', section: 'Playback' },
  { action: 'shuttle-forward', name: 'Play forwards', section: 'Playback' },
  { action: 'timeline-zoom-in', name: 'Zoom the timeline in', section: 'Timeline' },
  { action: 'timeline-zoom-out', name: 'Zoom the timeline out', section: 'Timeline' },
  { action: 'timeline-zoom-fit', name: 'Show the whole project', section: 'Timeline' },
  { action: 'split', name: 'Split at playhead', section: 'Editing' },
  { action: 'split-all', name: 'Split all tracks', section: 'Editing' },
  { action: 'duplicate', name: 'Duplicate', section: 'Editing' },
  { action: 'delete', name: 'Delete', section: 'Editing' },
  { action: 'ripple-delete', name: 'Ripple delete', section: 'Editing' },
  { action: 'group', name: 'Group', section: 'Editing' },
  { action: 'ungroup', name: 'Ungroup', section: 'Editing' },
  { action: 'tool-move', name: 'Move tool', section: 'Drawing' },
  { action: 'tool-shape', name: 'Rectangle or ellipse tool', section: 'Drawing' },
  { action: 'bring-to-front', name: 'Bring to front', section: 'Drawing' },
  { action: 'bring-forward', name: 'Bring forward', section: 'Drawing' },
  { action: 'send-backward', name: 'Send backward', section: 'Drawing' },
  { action: 'send-to-back', name: 'Send to back', section: 'Drawing' },
  { action: 'import', name: 'Import media', section: 'File and view' },
  { action: 'new-animation', name: 'New animation', section: 'File and view' },
  { action: 'export', name: 'Export', section: 'File and view' },
  { action: 'preview-mode', name: 'Preview mode', section: 'File and view' },
]

export const MAX_KEYS = 2

function key(code: string, ...modifiers: Modifier[]): Binding {
  return { code, modifiers }
}

export const DEFAULT_BINDINGS: Bindings = {
  'play-pause': [key('Space')],
  'step-back': [key('Comma'), key('ArrowLeft')],
  'step-forward': [key('Period'), key('ArrowRight')],
  'jump-back': [key('Comma', 'ctrl', 'shift')],
  'jump-forward': [key('Period', 'ctrl', 'shift')],
  'previous-edit': [key('Comma', 'ctrl')],
  'next-edit': [key('Period', 'ctrl')],
  'go-to-start': [key('Enter', 'meta')],
  'go-to-end': [key('Enter', 'shift', 'meta')],
  'shuttle-back': [key('KeyJ')],
  'shuttle-stop': [key('KeyK')],
  'shuttle-forward': [key('KeyL')],
  'timeline-zoom-in': [key('Equal', 'shift', 'meta')],
  'timeline-zoom-out': [key('Minus', 'shift', 'meta')],
  'timeline-zoom-fit': [key('Digit0', 'shift', 'meta')],
  split: [key('KeyT', 'meta')],
  'split-all': [key('KeyT', 'shift', 'meta')],
  duplicate: [key('KeyD', 'meta')],
  delete: [key('Backspace'), key('Delete')],
  'ripple-delete': [key('Backspace', 'meta'), key('Delete', 'meta')],
  group: [key('KeyG', 'meta')],
  ungroup: [key('KeyU', 'meta')],
  'tool-move': [key('KeyV')],
  'tool-shape': [key('KeyM')],
  'bring-to-front': [key('BracketRight', 'shift', 'meta')],
  'bring-forward': [key('BracketRight', 'meta')],
  'send-backward': [key('BracketLeft', 'meta')],
  'send-to-back': [key('BracketLeft', 'shift', 'meta')],
  import: [key('KeyI', 'meta')],
  'new-animation': [],
  export: [key('KeyE', 'meta')],
  'preview-mode': [key('KeyF', 'shift', 'meta')],
}

const RESERVED_KEYS: readonly { binding: Binding; name: string }[] = [
  { binding: key('KeyN', 'meta'), name: 'New Project' },
  { binding: key('KeyO', 'meta'), name: 'Open' },
  { binding: key('KeyS', 'meta'), name: 'Save' },
  { binding: key('KeyS', 'shift', 'meta'), name: 'Save As' },
  { binding: key('KeyW', 'meta'), name: 'Close' },
  { binding: key('KeyZ', 'meta'), name: 'Undo' },
  { binding: key('KeyZ', 'shift', 'meta'), name: 'Redo' },
  { binding: key('KeyX', 'meta'), name: 'Cut' },
  { binding: key('KeyC', 'meta'), name: 'Copy' },
  { binding: key('KeyV', 'meta'), name: 'Paste' },
  { binding: key('KeyA', 'meta'), name: 'Select All' },
  { binding: key('KeyA', 'shift', 'meta'), name: 'Deselect All' },
  { binding: key('KeyQ', 'meta'), name: 'Quit' },
  { binding: key('KeyH', 'meta'), name: 'Hide' },
  { binding: key('KeyM', 'meta'), name: 'Minimize' },
  { binding: key('Comma', 'meta'), name: 'Settings' },
  { binding: key('KeyF', 'ctrl', 'meta'), name: 'Enter Full Screen' },
  { binding: key('Escape'), name: 'Escape, which cancels' },
  { binding: key('Tab'), name: 'Tab, which moves the focus' },
  { binding: key('Tab', 'shift'), name: 'Shift-Tab, which moves the focus' },
]

const MODIFIER_CODES = new Set(['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight', 'CapsLock', 'Fn', 'FnLock'])
const MODIFIER_ORDER: readonly Modifier[] = ['ctrl', 'alt', 'shift', 'meta']
const MODIFIER_SYMBOLS: Record<Modifier, string> = { ctrl: '⌃', alt: '⌥', shift: '⇧', meta: '⌘' }
const MODIFIER_ACCELERATORS: Record<Modifier, string> = { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Cmd' }
const LETTER_OR_DIGIT = /^(?:Key(?<letter>[A-Z])|Digit(?<digit>[0-9])|(?<function>F[0-9]{1,2}))$/

const KEY_NAMES: Record<string, { symbol: string; accelerator: string }> = {
  Comma: { symbol: ',', accelerator: ',' },
  Period: { symbol: '.', accelerator: '.' },
  Slash: { symbol: '/', accelerator: '/' },
  Semicolon: { symbol: ';', accelerator: ';' },
  Quote: { symbol: "'", accelerator: "'" },
  BracketLeft: { symbol: '[', accelerator: '[' },
  BracketRight: { symbol: ']', accelerator: ']' },
  Backslash: { symbol: '\\', accelerator: '\\' },
  Backquote: { symbol: '`', accelerator: '`' },
  Minus: { symbol: '-', accelerator: '-' },
  Equal: { symbol: '=', accelerator: '=' },
  Space: { symbol: 'Space', accelerator: 'Space' },
  Enter: { symbol: '↩', accelerator: 'Return' },
  Backspace: { symbol: '⌫', accelerator: 'Backspace' },
  Delete: { symbol: '⌦', accelerator: 'Delete' },
  Tab: { symbol: '⇥', accelerator: 'Tab' },
  Escape: { symbol: 'Esc', accelerator: 'Esc' },
  ArrowLeft: { symbol: '←', accelerator: 'Left' },
  ArrowRight: { symbol: '→', accelerator: 'Right' },
  ArrowUp: { symbol: '↑', accelerator: 'Up' },
  ArrowDown: { symbol: '↓', accelerator: 'Down' },
  Home: { symbol: '↖', accelerator: 'Home' },
  End: { symbol: '↘', accelerator: 'End' },
  PageUp: { symbol: '⇞', accelerator: 'PageUp' },
  PageDown: { symbol: '⇟', accelerator: 'PageDown' },
}

function keyName(code: string): { symbol: string; accelerator: string } | undefined {
  const named = KEY_NAMES[code]
  if (named !== undefined) return named
  const groups = LETTER_OR_DIGIT.exec(code)?.groups
  const plain = groups?.letter ?? groups?.digit ?? groups?.function
  return plain === undefined ? undefined : { symbol: plain, accelerator: plain }
}

function isModifier(value: unknown): value is Modifier {
  return value === 'ctrl' || value === 'alt' || value === 'shift' || value === 'meta'
}

function orderedModifiers(modifiers: readonly Modifier[]): Modifier[] {
  return MODIFIER_ORDER.filter((modifier) => modifiers.includes(modifier))
}

export function bindingOf(press: KeyPress): Binding | undefined {
  if (MODIFIER_CODES.has(press.code) || keyName(press.code) === undefined) return undefined
  const held: Record<Modifier, boolean> = { ctrl: press.ctrlKey, alt: press.altKey, shift: press.shiftKey, meta: press.metaKey }
  return { code: press.code, modifiers: MODIFIER_ORDER.filter((modifier) => held[modifier]) }
}

export function isSameBinding(a: Binding, b: Binding): boolean {
  if (a.code !== b.code) return false
  for (const modifier of MODIFIER_ORDER) {
    if (a.modifiers.includes(modifier) !== b.modifiers.includes(modifier)) return false
  }
  return true
}

function sharesBinding(first: readonly Binding[], second: readonly Binding[]): boolean {
  for (const binding of first) {
    for (const other of second) {
      if (isSameBinding(binding, other)) return true
    }
  }
  return false
}

export function actionFor(bindings: Bindings, press: KeyPress): ShortcutAction | undefined {
  const pressed = bindingOf(press)
  if (pressed === undefined) return undefined
  for (const { action } of SHORTCUT_ACTIONS) {
    if (sharesBinding(bindings[action], [pressed])) return action
  }
  return undefined
}

export function hintOf(binding: Binding): string {
  const symbols = orderedModifiers(binding.modifiers).map((modifier) => MODIFIER_SYMBOLS[modifier])
  const keySymbol = keyName(binding.code)?.symbol ?? binding.code
  return `${symbols.join('')}${keySymbol}`
}

export function acceleratorOf(binding: Binding): string | undefined {
  const name = keyName(binding.code)
  if (name === undefined) return undefined
  const modifiers = orderedModifiers(binding.modifiers).map((modifier) => MODIFIER_ACCELERATORS[modifier])
  return [...modifiers, name.accelerator].join('+')
}

export function reservedBy(binding: Binding): string | undefined {
  return RESERVED_KEYS.find((fixed) => isSameBinding(fixed.binding, binding))?.name
}

export function conflictsOf(bindings: Bindings): Map<ShortcutAction, ShortcutAction[]> {
  const conflicts = new Map<ShortcutAction, ShortcutAction[]>()
  for (const { action } of SHORTCUT_ACTIONS) {
    const others: ShortcutAction[] = []
    for (const { action: other } of SHORTCUT_ACTIONS) {
      if (other === action) continue
      if (sharesBinding(bindings[action], bindings[other])) others.push(other)
    }
    if (others.length > 0) conflicts.set(action, others)
  }
  return conflicts
}

function parsedBinding(value: unknown): Binding | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  if (!('code' in value) || !('modifiers' in value)) return undefined
  const { code, modifiers } = value
  if (typeof code !== 'string' || keyName(code) === undefined) return undefined
  if (!Array.isArray(modifiers)) return undefined
  const held = modifiers.filter(isModifier)
  if (held.length !== modifiers.length) return undefined
  return { code, modifiers: orderedModifiers(held) }
}

export function parseBindings(text: string | undefined): Bindings {
  if (text === undefined) return DEFAULT_BINDINGS
  let stored: unknown
  try {
    stored = JSON.parse(text)
  } catch (error) {
    if (error instanceof SyntaxError) return DEFAULT_BINDINGS
    throw error
  }
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return DEFAULT_BINDINGS
  const record: Record<string, unknown> = { ...stored }
  const bindings: Record<ShortcutAction, readonly Binding[]> = { ...DEFAULT_BINDINGS }
  for (const { action } of SHORTCUT_ACTIONS) {
    const list = record[action]
    if (!Array.isArray(list) || list.length > MAX_KEYS) continue
    const parsed: Binding[] = []
    for (const entry of list) {
      const binding = parsedBinding(entry)
      if (binding !== undefined && reservedBy(binding) === undefined) parsed.push(binding)
    }
    if (parsed.length === list.length) bindings[action] = parsed
  }
  return bindings
}

export const MENU_SHORTCUT_ACTIONS = [
  'split',
  'split-all',
  'duplicate',
  'delete',
  'ripple-delete',
  'group',
  'ungroup',
  'bring-to-front',
  'bring-forward',
  'send-backward',
  'send-to-back',
  'import',
  'new-animation',
  'export',
  'preview-mode',
] as const satisfies readonly (ShortcutAction & MenuAction)[]

export function menuShortcutsOf(bindings: Bindings): MenuShortcuts {
  const accelerators: MenuShortcuts = {}
  for (const action of MENU_SHORTCUT_ACTIONS) {
    const [first] = bindings[action]
    const accelerator = first === undefined ? undefined : acceleratorOf(first)
    if (accelerator !== undefined) accelerators[action] = accelerator
  }
  return accelerators
}
