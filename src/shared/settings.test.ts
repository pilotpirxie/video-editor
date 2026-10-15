import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, cacheLimitOffer, parseSettings, stillDurationTicks } from './settings.js'

const GB = 1024 ** 3

describe('parseSettings', () => {
  it('gives the defaults for anything that is not settings', () => {
    expect(parseSettings(undefined)).toEqual(DEFAULT_SETTINGS)
    expect(parseSettings('text')).toEqual(DEFAULT_SETTINGS)
    expect(parseSettings([1, 2])).toEqual(DEFAULT_SETTINGS)
  })

  it('keeps valid values, brings numbers into range and replaces wrong ones by their default', () => {
    const parsed = parseSettings({ cacheLimitGb: 20.6, previewLongSide: 720, backgroundCores: 'half', unusedMediaHours: 99999, snapRangePixels: 0, isSnappingAtLaunch: false, stillDurationSeconds: 'long', undoSteps: Number.NaN })
    expect(parsed).toEqual({ ...DEFAULT_SETTINGS, cacheLimitGb: 21, previewLongSide: 720, backgroundCores: 'half', unusedMediaHours: 8760, snapRangePixels: 1, isSnappingAtLaunch: false })
  })

  it('allows only the offered preview sizes', () => {
    expect(parseSettings({ previewLongSide: 1000 }).previewLongSide).toBe(DEFAULT_SETTINGS.previewLongSide)
  })
})

describe('stillDurationTicks', () => {
  it('puts the duration on the grid of the project file', () => {
    expect(stillDurationTicks({ ...DEFAULT_SETTINGS, stillDurationSeconds: 5 })).toBe(120_000_000)
    expect(stillDurationTicks({ ...DEFAULT_SETTINGS, stillDurationSeconds: 1.234_56 }) % 100).toBe(0)
  })
})

describe('cacheLimitOffer', () => {
  it('offers nothing while the project fits', () => {
    expect(cacheLimitOffer({ usedBytes: 2 * GB, limitBytes: 10 * GB, neededBytes: 9 * GB, freeBytes: 100 * GB })).toBeUndefined()
  })

  it('offers what the project needs with a quarter to spare', () => {
    expect(cacheLimitOffer({ usedBytes: 10 * GB, limitBytes: 10 * GB, neededBytes: 16 * GB, freeBytes: 100 * GB })).toBe(20)
  })

  it('offers no more than the disk holds, keeping 5 GB free, and nothing when that is no larger', () => {
    expect(cacheLimitOffer({ usedBytes: 10 * GB, limitBytes: 10 * GB, neededBytes: 40 * GB, freeBytes: 11 * GB })).toBe(16)
    expect(cacheLimitOffer({ usedBytes: 10 * GB, limitBytes: 10 * GB, neededBytes: 40 * GB, freeBytes: 4 * GB })).toBeUndefined()
  })
})
