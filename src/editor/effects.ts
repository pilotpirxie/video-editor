import type { Size } from '../shared/exportPresets.js'
import type { Clip, Effect, EffectType, GroupClip, PictureClip, Project } from '../shared/project.js'
import { editClips } from './clips.js'

const OPAQUE_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/
const SMALLEST_EFFECT_LENGTH = 0.1
const EFFECT_SIZES_CANVAS_HEIGHT = 1080

export function takesEffects(clip: Clip): clip is PictureClip | GroupClip {
  return clip.type !== 'audio' && clip.type !== 'blur' && clip.type !== 'highlight'
}

function between(value: number, least: number, most: number): number {
  return Math.min(most, Math.max(least, value))
}

function colorOr(color: string, fallback: string): string {
  return OPAQUE_COLOR_PATTERN.test(color) ? color : fallback
}

export const EFFECT_NAMES: Record<EffectType, string> = {
  colorAdjust: 'Colour adjust',
  blackAndWhite: 'Black and white',
  dropShadow: 'Drop shadow',
  border: 'Border',
  roundedCorners: 'Rounded corners',
  clipBlur: 'Clip blur',
  chromaKey: 'Chroma key',
  sepia: 'Sepia',
  invert: 'Invert colours',
  tint: 'Colour tint',
  vignette: 'Vignette',
  look: 'Look',
  sharpen: 'Sharpen',
  blurFill: 'Blur fill',
}

type Look = Extract<Effect, { type: 'look' }>
export type LookValues = Omit<Look, 'type' | 'strength' | 'isOff'>

const NO_LOOK: LookValues = {
  exposure: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  temperature: 0,
  tint: 0,
  saturation: 0,
  fade: 0,
  shadowColor: '#1f6f8b',
  shadowAmount: 0,
  highlightColor: '#f2a35e',
  highlightAmount: 0,
}

export const LOOK_PRESETS: readonly { name: string; label: string; values: LookValues }[] = [
  { name: 'none', label: 'None', values: NO_LOOK },
  { name: 'warm', label: 'Warm', values: { ...NO_LOOK, contrast: 0.05, temperature: 0.35, saturation: 0.1, highlightAmount: 0.15 } },
  { name: 'cool', label: 'Cool', values: { ...NO_LOOK, contrast: 0.1, temperature: -0.35, shadowAmount: 0.15 } },
  { name: 'vivid', label: 'Vivid', values: { ...NO_LOOK, contrast: 0.2, highlights: -0.1, shadows: 0.1, saturation: 0.35 } },
  { name: 'faded', label: 'Faded', values: { ...NO_LOOK, contrast: -0.2, saturation: -0.3, fade: 0.35 } },
  { name: 'cinematic', label: 'Cinematic', values: { ...NO_LOOK, contrast: 0.15, highlights: -0.15, saturation: -0.1, shadowAmount: 0.35, highlightAmount: 0.3 } },
  {
    name: 'vintage',
    label: 'Vintage',
    values: { ...NO_LOOK, contrast: -0.1, temperature: 0.2, saturation: -0.25, fade: 0.3, shadowColor: '#6b4a2f', shadowAmount: 0.25, highlightColor: '#e8d98a', highlightAmount: 0.3 },
  },
  { name: 'moody', label: 'Moody', values: { ...NO_LOOK, exposure: -0.3, contrast: 0.2, shadows: -0.15, temperature: -0.15, saturation: -0.35, shadowAmount: 0.25 } },
  { name: 'bright', label: 'Bright', values: { ...NO_LOOK, exposure: 0.25, contrast: 0.05, highlights: -0.2, shadows: 0.3, saturation: 0.1 } },
]

export function lookPresetOf(look: Look): string {
  for (const preset of LOOK_PRESETS) {
    const withPreset: Look = { ...look, ...preset.values }
    if (hasSameSettings(withPreset, look)) return preset.name
  }
  return 'custom'
}

export function defaultEffect(type: EffectType, canvas: Size): Effect {
  function sized(length: number): number {
    return Math.max(1, Math.round((length * canvas.height) / EFFECT_SIZES_CANVAS_HEIGHT))
  }
  if (type === 'colorAdjust') {
    return { type, brightness: 0, contrast: 0, saturation: 0 }
  } else if (type === 'blackAndWhite' || type === 'sepia' || type === 'invert') {
    return { type, amount: 1 }
  } else if (type === 'dropShadow') {
    return { type, offsetX: sized(12), offsetY: sized(12), softness: sized(12), color: '#000000', opacity: 0.5 }
  } else if (type === 'border') {
    return { type, width: sized(6), color: '#ffffff' }
  } else if (type === 'roundedCorners') {
    return { type, radius: sized(30) }
  } else if (type === 'clipBlur') {
    return { type, strength: sized(10) }
  } else if (type === 'tint') {
    return { type, color: '#3d7be6', amount: 0.5 }
  } else if (type === 'vignette') {
    return { type, amount: 0.6, size: 0.5 }
  } else if (type === 'look') {
    return { type, strength: 1, ...NO_LOOK }
  } else if (type === 'sharpen') {
    return { type, amount: 0.5, radius: sized(1) }
  } else if (type === 'blurFill') {
    return { type, strength: sized(40), darken: 0.3 }
  } else {
    return { type, color: '#00b140', tolerance: 0.4, softness: 0.1, spill: 0.5 }
  }
}

function withinLimits(effect: Effect, before: Effect): Effect {
  if (effect.type === 'colorAdjust') {
    return {
      ...effect,
      brightness: between(effect.brightness, -1, 1),
      contrast: between(effect.contrast, -1, 1),
      saturation: between(effect.saturation, -1, 1),
    }
  } else if (effect.type === 'blackAndWhite' || effect.type === 'sepia' || effect.type === 'invert') {
    return { ...effect, amount: between(effect.amount, 0, 1) }
  } else if (effect.type === 'dropShadow') {
    const color = colorOr(effect.color, before.type === 'dropShadow' ? before.color : '#000000')
    return { ...effect, softness: Math.max(0, effect.softness), color, opacity: between(effect.opacity, 0, 1) }
  } else if (effect.type === 'border') {
    const color = colorOr(effect.color, before.type === 'border' ? before.color : '#ffffff')
    return { ...effect, width: Math.max(SMALLEST_EFFECT_LENGTH, effect.width), color }
  } else if (effect.type === 'roundedCorners') {
    return { ...effect, radius: Math.max(SMALLEST_EFFECT_LENGTH, effect.radius) }
  } else if (effect.type === 'clipBlur') {
    return { ...effect, strength: Math.max(SMALLEST_EFFECT_LENGTH, effect.strength) }
  } else if (effect.type === 'tint') {
    return { ...effect, color: colorOr(effect.color, before.type === 'tint' ? before.color : '#3d7be6'), amount: between(effect.amount, 0, 1) }
  } else if (effect.type === 'vignette') {
    return { ...effect, amount: between(effect.amount, 0, 1), size: between(effect.size, 0, 1) }
  } else if (effect.type === 'look') {
    const was = before.type === 'look' ? before : { ...NO_LOOK }
    return {
      ...effect,
      strength: between(effect.strength, 0, 1),
      exposure: between(effect.exposure, -2, 2),
      contrast: between(effect.contrast, -1, 1),
      highlights: between(effect.highlights, -1, 1),
      shadows: between(effect.shadows, -1, 1),
      temperature: between(effect.temperature, -1, 1),
      tint: between(effect.tint, -1, 1),
      saturation: between(effect.saturation, -1, 1),
      fade: between(effect.fade, 0, 1),
      shadowColor: colorOr(effect.shadowColor, was.shadowColor),
      shadowAmount: between(effect.shadowAmount, 0, 1),
      highlightColor: colorOr(effect.highlightColor, was.highlightColor),
      highlightAmount: between(effect.highlightAmount, 0, 1),
    }
  } else if (effect.type === 'sharpen') {
    return { ...effect, amount: between(effect.amount, 0, 2), radius: Math.max(SMALLEST_EFFECT_LENGTH, effect.radius) }
  } else if (effect.type === 'blurFill') {
    return { ...effect, strength: Math.max(SMALLEST_EFFECT_LENGTH, effect.strength), darken: between(effect.darken, 0, 1) }
  } else {
    const color = colorOr(effect.color, before.type === 'chromaKey' ? before.color : '#00b140')
    return { ...effect, color, tolerance: between(effect.tolerance, 0, 1), softness: between(effect.softness, 0, 1), spill: between(effect.spill, 0, 1) }
  }
}

function switched(effect: Effect, isOff: boolean): Effect {
  if (isOff) return { ...effect, isOff: true }
  const { isOff: _removed, ...on } = effect
  return on
}

function hasSameSettings(first: Effect, second: Effect): boolean {
  const others = new Map<string, unknown>(Object.entries(second))
  const settings = Object.entries(first)
  return settings.length === others.size && settings.every(([key, value]) => others.get(key) === value)
}

function withEffects(clip: PictureClip | GroupClip, effects: Effect[]): Clip {
  return { ...clip, effects: effects.length === 0 ? undefined : effects }
}

function editEffects(project: Project, clipIds: readonly string[], type: EffectType, edit: (effects: readonly Effect[]) => readonly Effect[]): Project {
  return editClips(project, new Set(clipIds), (clip) => {
    if (!takesEffect(clip, type)) return clip
    const before = clip.effects ?? []
    const after = edit(before)
    return after === before ? clip : withEffects(clip, [...after])
  })
}

export function takesEffect(clip: Clip, type: EffectType): clip is PictureClip | GroupClip {
  if (type === 'blurFill') return clip.type === 'video' || clip.type === 'image'
  return takesEffects(clip)
}

export function addEffect(project: Project, clipIds: readonly string[], type: EffectType): Project {
  const added = defaultEffect(type, project.canvas)
  return editEffects(project, clipIds, type, (effects) => {
    const existing = effects.find((effect) => effect.type === type)
    if (existing === undefined) return [...effects, added]
    if (existing.isOff !== true) return effects
    return effects.map((effect) => (effect === existing ? switched(effect, false) : effect))
  })
}

export function removeEffect(project: Project, clipIds: readonly string[], type: EffectType): Project {
  return editEffects(project, clipIds, type, (effects) => {
    const kept = effects.filter((effect) => effect.type !== type)
    return kept.length === effects.length ? effects : kept
  })
}

export function setEffectOff(project: Project, clipIds: readonly string[], type: EffectType, isOff: boolean): Project {
  return editEffects(project, clipIds, type, (effects) => {
    const existing = effects.find((effect) => effect.type === type)
    if (existing === undefined || (existing.isOff === true) === isOff) return effects
    return effects.map((effect) => (effect === existing ? switched(effect, isOff) : effect))
  })
}

export function moveEffect(project: Project, clipIds: readonly string[], type: EffectType, direction: 1 | -1): Project {
  return editEffects(project, clipIds, type, (effects) => {
    const from = effects.findIndex((effect) => effect.type === type)
    const moved = effects[from]
    const passed = effects[from + direction]
    if (moved === undefined || passed === undefined) return effects
    return effects.map((effect, index) => {
      if (index === from) return passed
      return index === from + direction ? moved : effect
    })
  })
}

export function setEffect(project: Project, clipIds: readonly string[], changed: Effect): Project {
  return editEffects(project, clipIds, changed.type, (effects) => {
    const existing = effects.find((effect) => effect.type === changed.type)
    if (existing === undefined) return effects
    const next = switched(withinLimits(changed, existing), existing.isOff === true)
    if (hasSameSettings(next, existing)) return effects
    return effects.map((effect) => (effect === existing ? next : effect))
  })
}
