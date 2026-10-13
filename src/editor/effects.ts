import type { Size } from '../shared/exportPresets.js'
import type { Clip, Effect, EffectType, GroupClip, PictureClip, Project } from '../shared/project.js'
import { editClips } from './clips.js'

const OPAQUE_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/
// The smallest length an effect can have; the file format refuses a border, a radius or a blur of nothing.
const SMALLEST_LENGTH = 0.1
// New effects are sized for a canvas 1080 pixels high and scaled to the canvas they are added to, so they look the same on a small and on a 4K canvas.
const REFERENCE_HEIGHT = 1080

// Everything with a picture of its own takes effects, and a group passes its effects on to its members. Sound has no picture, and blur and highlight clips are effects on what is beneath them.
export function takesEffects(clip: Clip): clip is PictureClip | GroupClip {
  return clip.type !== 'audio' && clip.type !== 'blur' && clip.type !== 'highlight'
}

function between(value: number, least: number, most: number): number {
  return Math.min(most, Math.max(least, value))
}

function colorOr(color: string, fallback: string): string {
  return OPAQUE_COLOR_PATTERN.test(color) ? color : fallback
}

// What each effect is called in the editor.
export const EFFECT_NAMES: Record<EffectType, string> = {
  colorAdjust: 'Colour adjust',
  blackAndWhite: 'Black and white',
  dropShadow: 'Drop shadow',
  border: 'Border',
  roundedCorners: 'Rounded corners',
  clipBlur: 'Clip blur',
  chromaKey: 'Chroma key',
}

export function defaultEffect(type: EffectType, canvas: Size): Effect {
  const sized = (length: number): number => Math.max(1, Math.round((length * canvas.height) / REFERENCE_HEIGHT))
  if (type === 'colorAdjust') {
    return { type, brightness: 0, contrast: 0, saturation: 0 }
  } else if (type === 'blackAndWhite') {
    return { type, amount: 1 }
  } else if (type === 'dropShadow') {
    return { type, offsetX: sized(12), offsetY: sized(12), softness: sized(12), color: '#000000', opacity: 0.5 }
  } else if (type === 'border') {
    return { type, width: sized(6), color: '#ffffff' }
  } else if (type === 'roundedCorners') {
    return { type, radius: sized(30) }
  } else if (type === 'clipBlur') {
    return { type, strength: sized(10) }
  } else {
    return { type, color: '#00b140', tolerance: 0.4, softness: 0.1, spill: 0.5 }
  }
}

// An effect with every setting inside what the file format accepts; a colour it would refuse is replaced by the one the effect had.
function withinLimits(effect: Effect, before: Effect): Effect {
  if (effect.type === 'colorAdjust') {
    return { ...effect, brightness: between(effect.brightness, -1, 1), contrast: between(effect.contrast, -1, 1), saturation: between(effect.saturation, -1, 1) }
  } else if (effect.type === 'blackAndWhite') {
    return { ...effect, amount: between(effect.amount, 0, 1) }
  } else if (effect.type === 'dropShadow') {
    const color = colorOr(effect.color, before.type === 'dropShadow' ? before.color : '#000000')
    return { ...effect, softness: Math.max(0, effect.softness), color, opacity: between(effect.opacity, 0, 1) }
  } else if (effect.type === 'border') {
    return { ...effect, width: Math.max(SMALLEST_LENGTH, effect.width), color: colorOr(effect.color, before.type === 'border' ? before.color : '#ffffff') }
  } else if (effect.type === 'roundedCorners') {
    return { ...effect, radius: Math.max(SMALLEST_LENGTH, effect.radius) }
  } else if (effect.type === 'clipBlur') {
    return { ...effect, strength: Math.max(SMALLEST_LENGTH, effect.strength) }
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

// Applies a change to the list of effects of the chosen clips that can have effects. A change that returns the list it was given changes nothing.
function editEffects(project: Project, clipIds: readonly string[], edit: (effects: readonly Effect[]) => readonly Effect[]): Project {
  return editClips(project, new Set(clipIds), (clip) => {
    if (!takesEffects(clip)) return clip
    const before = clip.effects ?? []
    const after = edit(before)
    return after === before ? clip : withEffects(clip, [...after])
  })
}

// Adds an effect at the end of each clip's list. A clip that has the effect already keeps it as it is, switched on.
export function addEffect(project: Project, clipIds: readonly string[], type: EffectType): Project {
  const added = defaultEffect(type, project.canvas)
  return editEffects(project, clipIds, (effects) => {
    const existing = effects.find((effect) => effect.type === type)
    if (existing === undefined) return [...effects, added]
    if (existing.isOff !== true) return effects
    return effects.map((effect) => (effect === existing ? switched(effect, false) : effect))
  })
}

export function removeEffect(project: Project, clipIds: readonly string[], type: EffectType): Project {
  return editEffects(project, clipIds, (effects) => (effects.some((effect) => effect.type === type) ? effects.filter((effect) => effect.type !== type) : effects))
}

export function setEffectOff(project: Project, clipIds: readonly string[], type: EffectType, isOff: boolean): Project {
  return editEffects(project, clipIds, (effects) => {
    const existing = effects.find((effect) => effect.type === type)
    if (existing === undefined || (existing.isOff === true) === isOff) return effects
    return effects.map((effect) => (effect === existing ? switched(effect, isOff) : effect))
  })
}

// Moves an effect one place toward the start of the list (-1) or toward its end (1). Effects are applied from first to last.
export function moveEffect(project: Project, clipIds: readonly string[], type: EffectType, direction: 1 | -1): Project {
  return editEffects(project, clipIds, (effects) => {
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

// Replaces the settings of the effect of the same kind on each clip that has it. Whether it is switched off stays as it is.
export function setEffect(project: Project, clipIds: readonly string[], changed: Effect): Project {
  return editEffects(project, clipIds, (effects) => {
    const existing = effects.find((effect) => effect.type === changed.type)
    if (existing === undefined) return effects
    const next = switched(withinLimits(changed, existing), existing.isOff === true)
    return hasSameSettings(next, existing) ? effects : effects.map((effect) => (effect === existing ? next : effect))
  })
}
