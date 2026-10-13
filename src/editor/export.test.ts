import { describe, expect, it } from 'vitest'
import { SECOND, audioClip, projectOf, track, videoClip } from '../../test/fixtures.js'
import { defaultPreset, durationText, exportFrameRates, exportJobFor, parseRememberedChoices, selectionRange, startingChoices, timeLeft, type ExportChoices } from './export.js'

const project = projectOf([track('t1', [videoClip('a', SECOND, 2 * SECOND), videoClip('b', 5 * SECOND, SECOND)]), track('t2', [audioClip('music', 0, 10 * SECOND)])])
const PATHS = { projectPath: '/tmp/snapshot.json', outputPath: '/tmp/out.mp4' }

describe('exportFrameRates', () => {
  it('offers the project rate and every slower one, fastest first', () => {
    expect(exportFrameRates({ num: 30, den: 1 })).toEqual([
      { num: 30, den: 1 },
      { num: 30000, den: 1001 },
      { num: 25, den: 1 },
      { num: 24, den: 1 },
      { num: 24000, den: 1001 },
    ])
    expect(exportFrameRates({ num: 24000, den: 1001 })).toEqual([{ num: 24000, den: 1001 }])
    expect(exportFrameRates({ num: 60, den: 1 })).toHaveLength(7)
  })
})

describe('defaultPreset', () => {
  it('is the largest size that does not enlarge the canvas', () => {
    expect(defaultPreset({ width: 1920, height: 1080 })).toBe('1080p')
    expect(defaultPreset({ width: 3840, height: 2160 })).toBe('4k')
    expect(defaultPreset({ width: 1280, height: 800 })).toBe('720p')
    expect(defaultPreset({ width: 1080, height: 1920 })).toBe('1080p')
  })

  it('is the smallest size for a canvas smaller than every preset', () => {
    expect(defaultPreset({ width: 160, height: 100 })).toBe('120p')
  })
})

describe('remembered choices', () => {
  it('keeps size, quality and sound from the last export', () => {
    expect(parseRememberedChoices('{"preset":"720p","quality":"low","hasAudio":false}')).toEqual({ preset: '720p', quality: 'low', hasAudio: false })
  })

  it('drops what it does not understand', () => {
    expect(parseRememberedChoices('{"preset":"8k","quality":7,"hasAudio":"yes","other":1}')).toEqual({})
    expect(parseRememberedChoices('not json')).toEqual({})
    expect(parseRememberedChoices('null')).toEqual({})
    expect(parseRememberedChoices(undefined)).toEqual({})
  })

  it('start from the project and the last export together', () => {
    expect(startingChoices(project, {})).toEqual({ preset: '1080p', frameRate: { num: 30, den: 1 }, quality: 'high', isSelectionOnly: false, hasAudio: true })
    expect(startingChoices(project, { preset: '480p', hasAudio: false })).toMatchObject({ preset: '480p', quality: 'high', hasAudio: false })
  })
})

describe('selectionRange', () => {
  it('spans the selected clips', () => {
    expect(selectionRange(project, ['a'])).toEqual({ start: SECOND, end: 3 * SECOND })
    expect(selectionRange(project, ['b', 'a'])).toEqual({ start: SECOND, end: 6 * SECOND })
  })

  it('is nothing without a selection', () => {
    expect(selectionRange(project, [])).toBeUndefined()
    expect(selectionRange(project, ['gone'])).toBeUndefined()
  })
})

describe('exportJobFor', () => {
  const choices: ExportChoices = { preset: '720p', frameRate: { num: 25, den: 1 }, quality: 'medium', isSelectionOnly: true, hasAudio: false }

  it('carries every choice', () => {
    expect(exportJobFor(choices, { start: SECOND, end: 3 * SECOND }, PATHS)).toEqual({
      kind: 'export',
      projectPath: '/tmp/snapshot.json',
      outputPath: '/tmp/out.mp4',
      preset: '720p',
      frameRate: { num: 25, den: 1 },
      quality: 'medium',
      hasAudio: false,
      range: { start: SECOND, end: 3 * SECOND },
    })
  })

  it('exports the whole timeline unless the selection was asked for and exists', () => {
    expect(exportJobFor({ ...choices, isSelectionOnly: false }, { start: 0, end: SECOND }, PATHS)).not.toHaveProperty('range')
    expect(exportJobFor(choices, undefined, PATHS)).not.toHaveProperty('range')
  })
})

describe('timeLeft', () => {
  it('scales the time taken so far to what is left', () => {
    expect(timeLeft(250, 1000, 10_000)).toBe(30_000)
    expect(timeLeft(1000, 1000, 10_000)).toBe(0)
  })

  it('gives no answer before the pace has settled', () => {
    expect(timeLeft(0, 1000, 10_000)).toBeUndefined()
    expect(timeLeft(500, 1000, 2000)).toBeUndefined()
    expect(timeLeft(10, 1000, 10_000)).toBeUndefined()
  })
})

describe('durationText', () => {
  it('is as exact as the length calls for', () => {
    expect(durationText(0)).toBe('0 s')
    expect(durationText(44_600)).toBe('45 s')
    expect(durationText(125_000)).toBe('2 min 5 s')
    expect(durationText(3_780_000)).toBe('1 h 3 min')
  })
})
