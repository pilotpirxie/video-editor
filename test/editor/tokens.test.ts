import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ROOT } from '../helpers.js'

const RENDERER = join(ROOT, 'src', 'renderer')
const AA_CONTRAST = 4.5
const HEX_COLOR = /#[0-9a-fA-F]{3,8}\b/g
const TOKEN = /--(?<name>[\w-]+):\s*(?<value>#[0-9a-fA-F]{6})/g

// Every pair of text colour and surface that the stylesheets actually put together.
const TEXT_ON_SURFACE: readonly [string, string][] = [
  ['text-primary', 'window-background'],
  ['text-primary', 'panel-background'],
  ['text-primary', 'raised-surface'],
  ['text-primary', 'hover-surface'],
  ['text-primary', 'clip-video'],
  ['text-primary', 'clip-audio'],
  ['text-primary', 'clip-image'],
  ['text-primary', 'clip-annotation'],
  ['text-secondary', 'window-background'],
  ['text-secondary', 'panel-background'],
  ['text-secondary', 'raised-surface'],
  ['text-secondary', 'hover-surface'],
  ['primary', 'panel-background'],
  ['primary', 'raised-surface'],
  ['text-on-primary', 'primary'],
  ['text-on-primary', 'primary-hover'],
  ['text-on-primary', 'primary-pressed'],
  ['text-on-primary', 'warning'],
  ['text-on-primary', 'danger'],
]

function tokens(): Map<string, string> {
  const found = new Map<string, string>()
  for (const match of readFileSync(join(RENDERER, 'tokens.css'), 'utf8').matchAll(TOKEN)) {
    const { name, value } = match.groups ?? {}
    if (name !== undefined && value !== undefined) found.set(name, value)
  }
  return found
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16) / 255)
  const [red, green, blue] = channels.map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
  return 0.2126 * (red ?? 0) + 0.7152 * (green ?? 0) + 0.0722 * (blue ?? 0)
}

function contrast(first: string, second: string): number {
  const lighter = Math.max(luminance(first), luminance(second))
  const darker = Math.min(luminance(first), luminance(second))
  return (lighter + 0.05) / (darker + 0.05)
}

describe('design tokens', () => {
  it('hold the palette of the specification', () => {
    expect(Object.fromEntries(tokens())).toMatchObject({
      'window-background': '#14171d',
      'panel-background': '#1b1f27',
      'raised-surface': '#252a34',
      'hover-surface': '#2e3440',
      divider: '#363d4a',
      'text-primary': '#ffffff',
      'text-secondary': '#a7b0c0',
      'text-disabled': '#687183',
      primary: '#3dba74',
      'primary-hover': '#4bc882',
      'primary-pressed': '#33a064',
      'text-on-primary': '#0d1a13',
      'snap-guide': '#e65fd3',
      danger: '#e5484d',
      warning: '#f2a93b',
      'clip-video': '#3c5a88',
      'clip-audio': '#2c6c80',
      'clip-image': '#5e4f8c',
      'clip-annotation': '#8a6a3a',
      'clip-blur': '#5b6474',
    })
  })

  it('are the only place a colour is written down', () => {
    const offenders: string[] = []
    for (const name of readdirSync(RENDERER)) {
      const isChecked = (name.endsWith('.css') && name !== 'tokens.css') || name.endsWith('.ts') || name.endsWith('.tsx')
      if (!isChecked) continue
      for (const color of readFileSync(join(RENDERER, name), 'utf8').match(HEX_COLOR) ?? []) offenders.push(`${name}: ${color}`)
    }
    expect(offenders).toEqual([])
  })

  it.each(TEXT_ON_SURFACE)('%s on %s meets AA contrast', (text, surface) => {
    const palette = tokens()
    const ratio = contrast(palette.get(text) ?? '', palette.get(surface) ?? '')
    expect(ratio).toBeGreaterThanOrEqual(AA_CONTRAST)
  })
})
