import { useMemo, type ReactElement } from 'react'
import { EFFECT_NAMES, moveEffect, removeEffect, setEffect, setEffectOff, takesEffects } from '../editor/effects.js'
import { describeErrorAsSentence, logError } from '../shared/log.js'
import type { Effect } from '../shared/project.js'
import { useEditorState, useSession } from './context.js'
import { IconButton } from './icons.js'
import { ColorField, EditField, Group, selectedClips } from './Properties.js'
import { updateStep, type Edit } from './store.js'

const PERCENT = 100
const MAX_LENGTH = 10_000
const LENGTHS = [2, 4, 8, 16, 32]
const AMOUNTS = [0, 25, 50, 75, 100]
const ADJUSTMENTS = [-100, -50, 0, 50, 100]

// The system's colour picker, which reads one pixel from anywhere on screen. The type library of this TypeScript does not describe it yet.
declare class EyeDropper {
  open(): Promise<{ sRGBHex: string }>
}

type EffectGroupProps = {
  clipId: string
  effect: Effect
  isFirst: boolean
  isLast: boolean
}

type NumberSetting = {
  label: string
  testId: string
  value: number
  // What the field shows is the stored value times this: 100 for settings stored as a share and shown in percent.
  shownPer: number
  min: number
  max: number
  presets: readonly number[]
  changed(value: number): Effect
}

function lengthOf(label: string, key: string, value: number, changed: (value: number) => Effect, min = 0): NumberSetting {
  return { label, testId: key, value, shownPer: 1, min, max: MAX_LENGTH, presets: LENGTHS, changed }
}

function amountOf(label: string, key: string, value: number, changed: (value: number) => Effect): NumberSetting {
  return { label: `${label} %`, testId: key, value, shownPer: PERCENT, min: 0, max: PERCENT, presets: AMOUNTS, changed }
}

function adjustmentOf(label: string, key: string, value: number, changed: (value: number) => Effect): NumberSetting {
  return { label: `${label} %`, testId: key, value, shownPer: PERCENT, min: -PERCENT, max: PERCENT, presets: ADJUSTMENTS, changed }
}

// The numbers of an effect, in the order they are shown. Lengths are canvas pixels.
function numberSettings(effect: Effect): NumberSetting[] {
  if (effect.type === 'colorAdjust') {
    return [
      adjustmentOf('Brightness', 'brightness', effect.brightness, (brightness) => ({ ...effect, brightness })),
      adjustmentOf('Contrast', 'contrast', effect.contrast, (contrast) => ({ ...effect, contrast })),
      adjustmentOf('Saturation', 'saturation', effect.saturation, (saturation) => ({ ...effect, saturation })),
    ]
  } else if (effect.type === 'blackAndWhite' || effect.type === 'sepia' || effect.type === 'invert' || effect.type === 'tint') {
    return [amountOf('Amount', 'amount', effect.amount, (amount) => ({ ...effect, amount }))]
  } else if (effect.type === 'vignette') {
    return [amountOf('Amount', 'amount', effect.amount, (amount) => ({ ...effect, amount })), amountOf('Size', 'size', effect.size, (size) => ({ ...effect, size }))]
  } else if (effect.type === 'dropShadow') {
    return [
      { ...lengthOf('Offset X', 'offsetX', effect.offsetX, (offsetX) => ({ ...effect, offsetX })), min: -MAX_LENGTH },
      { ...lengthOf('Offset Y', 'offsetY', effect.offsetY, (offsetY) => ({ ...effect, offsetY })), min: -MAX_LENGTH },
      lengthOf('Softness', 'softness', effect.softness, (softness) => ({ ...effect, softness })),
      amountOf('Opacity', 'opacity', effect.opacity, (opacity) => ({ ...effect, opacity })),
    ]
  } else if (effect.type === 'border') {
    return [lengthOf('Width', 'width', effect.width, (width) => ({ ...effect, width }), 1)]
  } else if (effect.type === 'roundedCorners') {
    return [lengthOf('Radius', 'radius', effect.radius, (radius) => ({ ...effect, radius }), 1)]
  } else if (effect.type === 'clipBlur') {
    return [lengthOf('Strength', 'strength', effect.strength, (strength) => ({ ...effect, strength }), 1)]
  } else {
    return [
      amountOf('Tolerance', 'tolerance', effect.tolerance, (tolerance) => ({ ...effect, tolerance })),
      amountOf('Softness', 'softness', effect.softness, (softness) => ({ ...effect, softness })),
      amountOf('Spill removal', 'spill', effect.spill, (spill) => ({ ...effect, spill })),
    ]
  }
}

// One effect of the selected clip: its settings, and in its title line the switch, its place in the order and its removal.
function EffectGroup({ clipId, effect, isFirst, isLast }: EffectGroupProps): ReactElement {
  const { store } = useSession()
  const { type } = effect
  const name = EFFECT_NAMES[type]
  const isOn = effect.isOff !== true
  const ids = [clipId]

  function withSettings(changed: Effect): Edit {
    return (project) => setEffect(project, ids, changed)
  }

  // While a colour is picked the key is switched off, so the picture shows the colours there are to pick from.
  async function pickKeyColor(key: Extract<Effect, { type: 'chromaKey' }>): Promise<void> {
    updateStep(store, 'Pick Key Colour', (project) => setEffectOff(project, ids, 'chromaKey', true), false)
    try {
      const picked = await new EyeDropper().open()
      updateStep(store, 'Pick Key Colour', withSettings({ ...key, color: picked.sRGBHex }), true)
      store.commit()
    } catch (error) {
      store.cancel()
      // Escape closes the picker without a colour; that is not a failure.
      if (error instanceof DOMException && error.name === 'AbortError') return
      logError('Could not pick a colour from the screen', error)
      store.notify(`The colour could not be picked: ${describeErrorAsSentence(error)} Choose it in the Key colour field instead.`)
    }
  }

  const actions = (
    <>
      <IconButton icon="eye" label={isOn ? `Switch ${name} off` : `Switch ${name} on`} testId={`effect-${type}-switch`} isPressed={isOn} onClick={() => store.apply(isOn ? 'Switch Effect Off' : 'Switch Effect On', (project) => setEffectOff(project, ids, type, isOn))} />
      <IconButton icon="chevronUp" label="Apply earlier" testId={`effect-${type}-earlier`} isDisabled={isFirst} onClick={() => store.apply('Reorder Effects', (project) => moveEffect(project, ids, type, -1))} />
      <IconButton icon="chevronDown" label="Apply later" testId={`effect-${type}-later`} isDisabled={isLast} onClick={() => store.apply('Reorder Effects', (project) => moveEffect(project, ids, type, 1))} />
      <IconButton icon="trash" label={`Remove ${name}`} testId={`effect-${type}-remove`} onClick={() => store.apply('Remove Effect', (project) => removeEffect(project, ids, type))} />
    </>
  )

  return (
    <Group title={name} icon="wand" actions={actions}>
      {(effect.type === 'dropShadow' || effect.type === 'border' || effect.type === 'chromaKey' || effect.type === 'tint') && (
        <ColorField label={effect.type === 'chromaKey' ? 'Key colour' : 'Colour'} testId={`effect-${type}-color`} command="Change Effect" value={effect.color} edit={(color) => withSettings({ ...effect, color })} />
      )}
      {effect.type === 'chromaKey' && (
        <button type="button" className="button" data-testid="effect-chromaKey-pick" onClick={() => void pickKeyColor(effect)}>
          Pick the key colour from the screen
        </button>
      )}
      {numberSettings(effect).map((setting) => (
        <EditField
          key={setting.testId}
          label={setting.label}
          testId={`effect-${type}-${setting.testId}`}
          command="Change Effect"
          value={setting.value * setting.shownPer}
          min={setting.min}
          max={setting.max}
          decimals={1}
          presets={setting.presets}
          edit={(shown) => withSettings(setting.changed(shown / setting.shownPer))}
        />
      ))}
    </Group>
  )
}

// The effects of the selected clip, first to last, under the clip's other properties.
export function EffectProperties(): ReactElement | undefined {
  const project = useEditorState((state) => state.project)
  const selection = useEditorState((state) => state.selection)
  const clips = useMemo(() => selectedClips(project, selection).filter(takesEffects), [project, selection])
  const [only] = clips
  if (only === undefined) return undefined
  if (clips.length > 1) {
    const hasEffects = clips.some((clip) => clip.effects !== undefined)
    // Two clips rarely have the same effects in the same order, so their settings are changed one clip at a time.
    return hasEffects ? (
      <p className="hint panel-hint" data-testid="effects-hint">
        Select one clip to change its effects.
      </p>
    ) : undefined
  }

  const effects = only.effects ?? []
  return (
    <>
      {effects.map((effect, index) => (
        <EffectGroup key={effect.type} clipId={only.id} effect={effect} isFirst={index === 0} isLast={index === effects.length - 1} />
      ))}
    </>
  )
}
