import { describe, expect, it } from 'vitest'
import { SECOND, audioClip, clipOf, groupClip, projectOf, reopened, track, videoClip } from '../../test/fixtures.js'
import { EFFECT_TYPES, type Clip, type Effect, type EffectType, type Project } from '../shared/project.js'
import { LOOK_PRESETS, addEffect, defaultEffect, lookPresetOf, moveEffect, removeEffect, setEffect, setEffectOff, takesEffects } from './effects.js'

const BLUR_CLIP: Clip = { id: 'blur', type: 'blur', start: SECOND, duration: SECOND, transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 }, opacity: 1, width: 100, height: 100, shape: 'rectangle', softEdge: 0, strength: 10 }

function sample(effects?: Effect[]): Project {
  return projectOf([track('pictures', [videoClip('a', 0, SECOND, effects === undefined ? {} : { effects }), videoClip('b', SECOND, SECOND)]), track('other', [audioClip('music', 0, SECOND), BLUR_CLIP])])
}

function kindsOn(project: Project, clipId: string): EffectType[] {
  const clip = clipOf(project, clipId)
  return takesEffects(clip) ? (clip.effects ?? []).map((effect) => effect.type) : []
}

describe('addEffect', () => {
  it.each(EFFECT_TYPES)('adds %s with settings the project file accepts, sized to the canvas', (type) => {
    const added = addEffect(sample(), ['a'], type)
    expect(kindsOn(added, 'a')).toEqual([type])
    expect(reopened(added)).toEqual(added)
    const small = defaultEffect(type, { width: 320, height: 180 })
    expect(JSON.stringify(small)).not.toContain('"width":0')
  })

  it('adds to every selected clip that has a picture, at the end of its list', () => {
    const project = sample([{ type: 'border', width: 4, color: '#ffffff' }])
    const added = addEffect(project, ['a', 'b', 'music', 'blur'], 'clipBlur')
    expect(kindsOn(added, 'a')).toEqual(['border', 'clipBlur'])
    expect(kindsOn(added, 'b')).toEqual(['clipBlur'])
    expect(clipOf(added, 'music')).toBe(clipOf(project, 'music'))
    expect(clipOf(added, 'blur')).toBe(clipOf(project, 'blur'))
  })

  it('keeps an effect the clip already has, and switches it on if it was off', () => {
    const project = sample([{ type: 'border', width: 9, color: '#ff0000', isOff: true }])
    const added = addEffect(project, ['a'], 'border')
    expect(clipOf(added, 'a')).toMatchObject({ effects: [{ type: 'border', width: 9, color: '#ff0000' }] })
    expect(JSON.stringify(clipOf(added, 'a'))).not.toContain('isOff')
    expect(addEffect(added, ['a'], 'border')).toBe(added)
  })

  it('adds a blur fill only to video and image clips', () => {
    const base = { start: 0, duration: SECOND, transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 }, opacity: 1 }
    const arrow: Clip = { ...base, id: 'arrow', type: 'arrow', length: 100, thickness: 4, color: '#ff0000', startHead: 'none', endHead: 'triangle' }
    const project = projectOf([track('t1', [videoClip('a', 0, SECOND)]), track('t2', [arrow]), track('t3', [groupClip('group', 0, SECOND, [[videoClip('m', 0, SECOND)]])])])
    const added = addEffect(project, ['a', 'arrow', 'group'], 'blurFill')
    expect(kindsOn(added, 'a')).toEqual(['blurFill'])
    expect(clipOf(added, 'arrow')).toBe(clipOf(project, 'arrow'))
    expect(clipOf(added, 'group')).toBe(clipOf(project, 'group'))
  })

  it('scales lengths with the height of the canvas', () => {
    expect(defaultEffect('roundedCorners', { width: 3840, height: 2160 })).toEqual({ type: 'roundedCorners', radius: 60 })
    expect(defaultEffect('roundedCorners', { width: 1920, height: 1080 })).toEqual({ type: 'roundedCorners', radius: 30 })
  })
})

describe('changing effects', () => {
  const stack: Effect[] = [
    { type: 'colorAdjust', brightness: 0, contrast: 0, saturation: 0 },
    { type: 'roundedCorners', radius: 20 },
    { type: 'border', width: 4, color: '#ffffff' },
  ]
  const project = sample(stack)

  it('moves an effect one place and stops at the ends of the list', () => {
    expect(kindsOn(moveEffect(project, ['a'], 'border', -1), 'a')).toEqual(['colorAdjust', 'border', 'roundedCorners'])
    expect(kindsOn(moveEffect(project, ['a'], 'colorAdjust', 1), 'a')).toEqual(['roundedCorners', 'colorAdjust', 'border'])
    expect(moveEffect(project, ['a'], 'border', 1)).toBe(project)
    expect(moveEffect(project, ['a'], 'colorAdjust', -1)).toBe(project)
    expect(moveEffect(project, ['a'], 'clipBlur', 1)).toBe(project)
  })

  it('switches an effect off and on without losing its settings', () => {
    const off = setEffectOff(project, ['a'], 'roundedCorners', true)
    expect(clipOf(off, 'a')).toMatchObject({ effects: [stack[0], { type: 'roundedCorners', radius: 20, isOff: true }, stack[2]] })
    expect(reopened(off)).toEqual(off)
    expect(setEffectOff(off, ['a'], 'roundedCorners', true)).toBe(off)
    expect(clipOf(setEffectOff(off, ['a'], 'roundedCorners', false), 'a')).toEqual(clipOf(project, 'a'))
  })

  it('changes the settings of an effect and keeps them inside what the file accepts', () => {
    const changed = setEffect(project, ['a'], { type: 'colorAdjust', brightness: 2, contrast: -0.25, saturation: -5 })
    expect(clipOf(changed, 'a')).toMatchObject({ effects: [{ type: 'colorAdjust', brightness: 1, contrast: -0.25, saturation: -1 }, stack[1], stack[2]] })
    const thin = setEffect(project, ['a'], { type: 'border', width: 0, color: 'red' })
    expect(clipOf(thin, 'a')).toMatchObject({ effects: [stack[0], stack[1], { type: 'border', width: 0.1, color: '#ffffff' }] })
    expect(reopened(thin)).toEqual(thin)
    expect(setEffect(project, ['a'], { type: 'roundedCorners', radius: 20 })).toBe(project)
    expect(setEffect(project, ['a'], { type: 'clipBlur', strength: 3 })).toBe(project)
  })

  it('keeps the amounts, the size and the colour of the colour effects inside what the file accepts', () => {
    const toned = sample([
      { type: 'sepia', amount: 1 },
      { type: 'invert', amount: 1 },
      { type: 'tint', color: '#3d7be6', amount: 0.5 },
      { type: 'vignette', amount: 0.6, size: 0.5 },
    ])
    let changed = setEffect(toned, ['a'], { type: 'sepia', amount: 3 })
    changed = setEffect(changed, ['a'], { type: 'invert', amount: -1 })
    changed = setEffect(changed, ['a'], { type: 'tint', color: 'blue', amount: 2 })
    changed = setEffect(changed, ['a'], { type: 'vignette', amount: -0.5, size: 1.5 })
    expect(clipOf(changed, 'a')).toMatchObject({
      effects: [
        { type: 'sepia', amount: 1 },
        { type: 'invert', amount: 0 },
        { type: 'tint', color: '#3d7be6', amount: 1 },
        { type: 'vignette', amount: 0, size: 1 },
      ],
    })
    expect(reopened(changed)).toEqual(changed)
  })

  it('keeps an effect switched off while its settings change', () => {
    const off = setEffectOff(project, ['a'], 'border', true)
    const changed = setEffect(off, ['a'], { type: 'border', width: 12, color: '#00ff00' })
    expect(clipOf(changed, 'a')).toMatchObject({ effects: [stack[0], stack[1], { type: 'border', width: 12, color: '#00ff00', isOff: true }] })
  })

  it('removes an effect, and the list with the last one', () => {
    const fewer = removeEffect(project, ['a'], 'roundedCorners')
    expect(kindsOn(fewer, 'a')).toEqual(['colorAdjust', 'border'])
    const none = removeEffect(removeEffect(fewer, ['a'], 'border'), ['a'], 'colorAdjust')
    expect(JSON.stringify(reopened(none))).not.toContain('effects')
    expect(removeEffect(none, ['a'], 'border')).toBe(none)
  })
})

describe('effects on drawn clips and groups', () => {
  it('gives an effect to a callout, an arrow and a group', () => {
    const base = { start: 0, duration: SECOND, transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 }, opacity: 1 }
    const callout: Clip = { ...base, id: 'callout', type: 'callout', text: '', font: { family: 'Menlo', size: 20 }, color: '#000000', align: 'center', width: 200, height: 100, shape: 'banner', fill: '#ffffff', borderColor: '#000000', borderWidth: 2 }
    const arrow: Clip = { ...base, id: 'arrow', type: 'arrow', length: 100, thickness: 4, color: '#ff0000', startHead: 'none', endHead: 'triangle' }
    const project = projectOf([track('t1', [callout]), track('t2', [arrow]), track('t3', [groupClip('group', 0, SECOND, [[videoClip('m', 0, SECOND)]])])])
    const added = addEffect(project, ['callout', 'arrow', 'group'], 'dropShadow')
    for (const id of ['callout', 'arrow', 'group']) expect(kindsOn(added, id)).toEqual(['dropShadow'])
    expect(reopened(added)).toEqual(added)
  })
})

describe('looks', () => {
  const look = defaultEffect('look', { width: 1920, height: 1080 })

  it('starts as no look at full strength', () => {
    expect(look).toMatchObject({ strength: 1 })
    expect(look.type === 'look' && lookPresetOf(look)).toBe('none')
  })

  it('names the preset a look matches, and none once a setting is changed', () => {
    if (look.type !== 'look') throw new Error('expected a look')
    for (const preset of LOOK_PRESETS) {
      expect(lookPresetOf({ ...look, ...preset.values, strength: 0.4 })).toBe(preset.name)
    }
    const cinematic = LOOK_PRESETS.find((preset) => preset.name === 'cinematic')
    expect(lookPresetOf({ ...look, ...cinematic?.values, contrast: 0.5 })).toBe('custom')
  })

  it('keeps every preset inside what the project file accepts', () => {
    if (look.type !== 'look') throw new Error('expected a look')
    for (const preset of LOOK_PRESETS) {
      const project = sample([{ ...look, ...preset.values }])
      expect(reopened(project)).toEqual(project)
    }
  })

  it('keeps settings in range and the colour it had for one the file refuses', () => {
    const project = sample([look])
    if (look.type !== 'look') throw new Error('expected a look')
    const changed = setEffect(project, ['a'], { ...look, exposure: 5, fade: -1, shadowColor: 'teal' })
    expect(clipOf(changed, 'a')).toMatchObject({ effects: [{ exposure: 2, fade: 0, shadowColor: look.shadowColor }] })
  })
})
