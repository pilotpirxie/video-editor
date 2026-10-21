import { describe, expect, it } from 'vitest'
import { SECOND, audioClip, projectOf, track, videoClip } from '../../test/fixtures.js'
import { EXPORT_FORMATS, EXPORT_PRESETS, EXPORT_QUALITIES } from '../shared/exportPresets.js'
import { defaultPreset, durationText, exportFrameRates, exportJobFor, isExportJob, parseRememberedChoices, selectionRange, startingChoices, timeLeftMs, withFormat, type ExportChoices } from './export.js'

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
  const mp4 = startingChoices(project, {})

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
  it('keeps format, size, quality and sound from the last export', () => {
    expect(parseRememberedChoices('{"format":"webm","preset":"720p","quality":"low","hasAudio":false}')).toEqual({ format: 'webm', preset: '720p', quality: 'low', hasAudio: false })
  })

  it('drops what it does not understand', () => {
    expect(parseRememberedChoices('{"format":"avi","preset":"8k","quality":7,"encoder":"nvenc","hasAudio":"yes","other":1}')).toEqual({})
    expect(parseRememberedChoices('not json')).toEqual({})
    expect(parseRememberedChoices('null')).toEqual({})
    expect(parseRememberedChoices(undefined)).toEqual({})
  })

  it('start from the project and the last export together', () => {
    expect(startingChoices(project, {})).toEqual({ format: 'mp4', preset: '1080p', frameRate: { num: 30, den: 1 }, quality: 'high', isSelectionOnly: false, hasAudio: true })
    expect(startingChoices(project, { preset: '480p', hasAudio: false })).toMatchObject({ preset: '480p', quality: 'high', hasAudio: false })
    expect(startingChoices(project, { format: 'gif' })).toMatchObject({ format: 'gif', frameRate: { num: 10, den: 1 } })
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
  const choices: ExportChoices = { format: 'mp4', preset: '720p', frameRate: { num: 25, den: 1 }, quality: 'medium', isSelectionOnly: true, hasAudio: false }
  const selected = { start: SECOND, end: 3 * SECOND }
  const BASE = { kind: 'export', projectPath: '/tmp/snapshot.json', outputPath: '/tmp/out.mp4', preset: '720p' }

  it('carries every choice of an MP4', () => {
    expect(exportJobFor(choices, selected, PATHS, 12)).toEqual({ ...BASE, format: 'mp4', frameRate: { num: 25, den: 1 }, quality: 'medium', hasAudio: false, range: selected })
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

describe('isExportJob', () => {
  const VALID = { kind: 'export', projectPath: '/tmp/snapshot.json', outputPath: '/tmp/out.mp4', preset: '720p' }

  // The main process runs only jobs that pass; every job the dialog can make must pass, or its export waits for ever.
  it('accepts every job the dialog can make', () => {
    let checked = 0
    for (const format of EXPORT_FORMATS) {
      for (const frameRate of exportFrameRates(format)) {
        for (const preset of EXPORT_PRESETS) {
          for (const quality of EXPORT_QUALITIES) {
            for (const isSelectionOnly of [false, true]) {
              const choices: ExportChoices = { format, preset, frameRate, quality, isSelectionOnly, hasAudio: isSelectionOnly }
              const job = exportJobFor(choices, { start: SECOND, end: 2 * SECOND }, PATHS, 7)
              expect(isExportJob(job), JSON.stringify(job)).toBe(true)
              checked += 1
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(1000)
  })

  it('accepts a GIF at each of its own rates, and no other picture format at them', () => {
    expect(isExportJob({ ...VALID, format: 'gif', frameRate: { num: 10, den: 1 } })).toBe(true)
    expect(isExportJob({ ...VALID, format: 'gif', frameRate: { num: 20, den: 1 } })).toBe(true)
    expect(isExportJob({ ...VALID, format: 'mp4', frameRate: { num: 10, den: 1 } })).toBe(false)
    expect(isExportJob({ ...VALID, frameRate: { num: 10, den: 1 } })).toBe(false)
    expect(isExportJob({ ...VALID, format: 'gif', frameRate: { num: 60, den: 1 } })).toBe(false)
  })

  it('accepts the rates above the project rate that MP4 and WebM offer', () => {
    expect(isExportJob({ ...VALID, format: 'mp4', frameRate: { num: 120, den: 1 } })).toBe(true)
    expect(isExportJob({ ...VALID, format: 'webm', frameRate: { num: 160, den: 1 } })).toBe(true)
    expect(isExportJob({ ...VALID, format: 'webm', frameRate: { num: 30000, den: 1001 } })).toBe(true)
  })

  it.each([
    ['nothing', null],
    ['a string', 'export'],
    ['another kind of job', { ...VALID, kind: 'frames' }],
    ['no project', { ...VALID, projectPath: undefined }],
    ['no output', { ...VALID, outputPath: 42 }],
    ['an unknown preset', { ...VALID, preset: '8k' }],
    ['an unknown format', { ...VALID, format: 'avi' }],
    ['a rate no format offers', { ...VALID, frameRate: { num: 29, den: 1 } }],
    ['a rate as text', { ...VALID, frameRate: '30/1' }],
    ['a rate without a denominator', { ...VALID, frameRate: { num: 30 } }],
    ['an unknown quality', { ...VALID, quality: 'ultra' }],
    ['a backwards range', { ...VALID, range: { start: 2 * SECOND, end: SECOND } }],
    ['an empty range', { ...VALID, range: { start: SECOND, end: SECOND } }],
    ['a range before the start', { ...VALID, range: { start: -1, end: SECOND } }],
    ['a fractional frame', { ...VALID, format: 'png', frame: 1.5 }],
    ['a negative frame', { ...VALID, format: 'png', frame: -1 }],
    ['sound as text', { ...VALID, hasAudio: 'yes' }],
  ])('refuses %s', (_, job) => {
    expect(isExportJob(job)).toBe(false)
  })
})

describe('timeLeftMs', () => {
  it('scales the time taken so far to what is left', () => {
    expect(timeLeftMs(250, 1000, 10_000)).toBe(30_000)
    expect(timeLeftMs(1000, 1000, 10_000)).toBe(0)
  })

  it('gives no answer before the pace has settled', () => {
    expect(timeLeftMs(0, 1000, 10_000)).toBeUndefined()
    expect(timeLeftMs(500, 1000, 2000)).toBeUndefined()
    expect(timeLeftMs(10, 1000, 10_000)).toBeUndefined()
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
