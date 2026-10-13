import { describe, expect, it } from 'vitest'
import { SECOND, audioClip, clipOf, projectOf, reopened, track, videoClip } from '../../test/fixtures.js'
import { EFFECT_TYPES, type Clip, type Effect, type EffectType, type Project } from '../shared/project.js'
import { addEffect, defaultEffect, moveEffect, removeEffect, setEffect, setEffectOff, takesEffects } from './effects.js'

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
