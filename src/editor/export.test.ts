import { describe, expect, it } from 'vitest'
import { SECOND, audioClip, projectOf, track, videoClip } from '../../test/fixtures.js'
import { defaultPreset, durationText, exportFrameRates, exportJobFor, parseRememberedChoices, selectionRange, startingChoices, timeLeft, withFormat, type ExportChoices } from './export.js'

const project = projectOf([track('t1', [videoClip('a', SECOND, 2 * SECOND), videoClip('b', 5 * SECOND, SECOND)]), track('t2', [audioClip('music', 0, 10 * SECOND)])])
const PATHS = { projectPath: '/tmp/snapshot.json', outputPath: '/tmp/out.mp4' }

describe('exportFrameRates', () => {
  it('offers every project rate, faster ones than the project included, fastest first', () => {
    expect(exportFrameRates('mp4')).toEqual([
      { num: 160, den: 1 },
      { num: 120, den: 1 },
      { num: 60, den: 1 },
      { num: 50, den: 1 },
      { num: 30, den: 1 },
      { num: 30000, den: 1001 },
      { num: 25, den: 1 },
      { num: 24, den: 1 },
      { num: 24000, den: 1001 },
    ])
    expect(exportFrameRates('webm')).toEqual(exportFrameRates('mp4'))
  })

  it('offers a GIF only the rates its frame times can hold', () => {
    expect(exportFrameRates('gif')).toEqual([
      { num: 25, den: 1 },
      { num: 20, den: 1 },
      { num: 10, den: 1 },
    ])
  })
})

describe('withFormat', () => {
  const projectRate = { num: 30, den: 1 }
  const mp4 = startingChoices(project, {}, false)

  it('keeps a frame rate the new format can hold, and starts from its default otherwise', () => {
    expect(withFormat(mp4, 'webm', projectRate)).toEqual({ ...mp4, format: 'webm' })
    const gif = withFormat(mp4, 'gif', projectRate)
    expect(gif).toEqual({ ...mp4, format: 'gif', frameRate: { num: 10, den: 1 } })
    expect(withFormat({ ...gif, frameRate: { num: 25, den: 1 } }, 'mp4', projectRate).frameRate).toEqual({ num: 25, den: 1 })
    expect(withFormat({ ...gif, frameRate: { num: 20, den: 1 } }, 'mp4', projectRate).frameRate).toEqual(projectRate)
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
  it('keeps format, size, quality, encoder and sound from the last export', () => {
    expect(parseRememberedChoices('{"format":"webm","preset":"720p","quality":"low","encoder":"hardware","hasAudio":false}')).toEqual({ format: 'webm', preset: '720p', quality: 'low', encoder: 'hardware', hasAudio: false })
  })

  it('drops what it does not understand', () => {
    expect(parseRememberedChoices('{"format":"avi","preset":"8k","quality":7,"encoder":"nvenc","hasAudio":"yes","other":1}')).toEqual({})
    expect(parseRememberedChoices('not json')).toEqual({})
    expect(parseRememberedChoices('null')).toEqual({})
    expect(parseRememberedChoices(undefined)).toEqual({})
  })

  it('start from the project and the last export together', () => {
    expect(startingChoices(project, {}, false)).toEqual({ format: 'mp4', preset: '1080p', frameRate: { num: 30, den: 1 }, quality: 'high', encoder: 'x264', isSelectionOnly: false, hasAudio: true })
    expect(startingChoices(project, { preset: '480p', hasAudio: false }, false)).toMatchObject({ preset: '480p', quality: 'high', hasAudio: false })
    expect(startingChoices(project, { format: 'gif' }, false)).toMatchObject({ format: 'gif', frameRate: { num: 10, den: 1 } })
  })

  it('make MP4s with the media engine on a Mac with little memory, unless the user chose otherwise', () => {
    expect(startingChoices(project, {}, true).encoder).toBe('hardware')
    expect(startingChoices(project, { encoder: 'x264' }, true).encoder).toBe('x264')
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
  const choices: ExportChoices = { format: 'mp4', preset: '720p', frameRate: { num: 25, den: 1 }, quality: 'medium', encoder: 'hardware', isSelectionOnly: true, hasAudio: false }
  const selected = { start: SECOND, end: 3 * SECOND }
  const BASE = { kind: 'export', projectPath: '/tmp/snapshot.json', outputPath: '/tmp/out.mp4', preset: '720p' }

  it('carries every choice of an MP4', () => {
    expect(exportJobFor(choices, selected, PATHS, 12)).toEqual({ ...BASE, format: 'mp4', encoder: 'hardware', frameRate: { num: 25, den: 1 }, quality: 'medium', hasAudio: false, range: selected })
  })

  it('carries only what the format uses', () => {
    expect(exportJobFor({ ...choices, format: 'webm' }, selected, PATHS, 12)).toEqual({ ...BASE, format: 'webm', frameRate: { num: 25, den: 1 }, quality: 'medium', hasAudio: false, range: selected })
    expect(exportJobFor({ ...choices, format: 'gif', frameRate: { num: 10, den: 1 } }, selected, PATHS, 12)).toEqual({ ...BASE, format: 'gif', frameRate: { num: 10, den: 1 }, range: selected })
    expect(exportJobFor({ ...choices, format: 'wav' }, selected, PATHS, 12)).toEqual({ ...BASE, format: 'wav', hasAudio: true, range: selected })
    expect(exportJobFor({ ...choices, format: 'png' }, selected, PATHS, 12)).toEqual({ ...BASE, format: 'png', frame: 12 })
  })

  it('exports the whole timeline unless the selection was asked for and exists', () => {
    expect(exportJobFor({ ...choices, isSelectionOnly: false }, { start: 0, end: SECOND }, PATHS, 0)).not.toHaveProperty('range')
    expect(exportJobFor(choices, undefined, PATHS, 0)).not.toHaveProperty('range')
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
    expect(durationText(0)).toBe('0s')
    expect(durationText(44_600)).toBe('45s')
    expect(durationText(125_000)).toBe('2m 5s')
    expect(durationText(3_780_000)).toBe('1h 3m')
  })
})
