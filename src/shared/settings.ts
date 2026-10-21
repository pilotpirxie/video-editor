import type { CacheUsage } from './mediaProtocol.js'
import { TICKS_PER_SECOND, TIMELINE_GRID } from './time.js'

export type AppSettings = {
  cacheLimitGb: number
  previewLongSide: number
  backgroundCores: BackgroundCores
  unusedMediaHours: number
  snapRangePixels: number
  isSnappingAtLaunch: boolean
  stillDurationSeconds: number
  autosaveSeconds: number
  undoSteps: number
  mediaSort: MediaSort
}

type BackgroundCores = 'all' | 'half'

const MEDIA_SORTS = ['created', 'name', 'duration'] as const

export type MediaSort = (typeof MEDIA_SORTS)[number]

export type MediaSettings = Pick<AppSettings, 'cacheLimitGb' | 'previewLongSide' | 'backgroundCores' | 'unusedMediaHours'>

type NumberSetting = 'cacheLimitGb' | 'unusedMediaHours' | 'snapRangePixels' | 'stillDurationSeconds' | 'autosaveSeconds' | 'undoSteps'

export const PREVIEW_LONG_SIDES = [480, 720, 960, 1280] as const
export const DEFAULT_PREVIEW_LONG_SIDE = 960

export const DEFAULT_SETTINGS: AppSettings = {
  cacheLimitGb: 10,
  previewLongSide: DEFAULT_PREVIEW_LONG_SIDE,
  backgroundCores: 'all',
  unusedMediaHours: 48,
  snapRangePixels: 12,
  isSnappingAtLaunch: true,
  stillDurationSeconds: 5,
  autosaveSeconds: 10,
  undoSteps: 500,
  mediaSort: 'created',
}

export const SETTING_RANGES: Record<NumberSetting, { min: number; max: number }> = {
  cacheLimitGb: { min: 1, max: 1000 },
  unusedMediaHours: { min: 1, max: 8760 },
  snapRangePixels: { min: 1, max: 40 },
  stillDurationSeconds: { min: 0.1, max: 3600 },
  autosaveSeconds: { min: 5, max: 600 },
  undoSteps: { min: 50, max: 5000 },
}

const BYTES_PER_GIGABYTE = 1024 ** 3
const FREE_DISK_KEPT_BYTES = 5 * BYTES_PER_GIGABYTE
const OFFER_HEADROOM = 1.25
const MILLISECONDS_PER_HOUR = 60 * 60 * 1000

function numberWithin(value: unknown, setting: NumberSetting, isWhole: boolean): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_SETTINGS[setting]
  const { min, max } = SETTING_RANGES[setting]
  const clamped = Math.min(max, Math.max(min, value))
  return isWhole ? Math.round(clamped) : clamped
}

export function parseSettings(value: unknown): AppSettings {
  const record: Record<string, unknown> = typeof value === 'object' && value !== null && !Array.isArray(value) ? { ...value } : {}
  const { previewLongSide, backgroundCores, isSnappingAtLaunch, mediaSort } = record
  return {
    cacheLimitGb: numberWithin(record.cacheLimitGb, 'cacheLimitGb', true),
    previewLongSide: PREVIEW_LONG_SIDES.find((side) => side === previewLongSide) ?? DEFAULT_SETTINGS.previewLongSide,
    backgroundCores: backgroundCores === 'half' ? 'half' : 'all',
    unusedMediaHours: numberWithin(record.unusedMediaHours, 'unusedMediaHours', true),
    snapRangePixels: numberWithin(record.snapRangePixels, 'snapRangePixels', true),
    isSnappingAtLaunch: typeof isSnappingAtLaunch === 'boolean' ? isSnappingAtLaunch : DEFAULT_SETTINGS.isSnappingAtLaunch,
    stillDurationSeconds: numberWithin(record.stillDurationSeconds, 'stillDurationSeconds', false),
    autosaveSeconds: numberWithin(record.autosaveSeconds, 'autosaveSeconds', true),
    undoSteps: numberWithin(record.undoSteps, 'undoSteps', true),
    mediaSort: MEDIA_SORTS.find((sort) => sort === mediaSort) ?? DEFAULT_SETTINGS.mediaSort,
  }
}

export function mediaSettingsOf(settings: AppSettings): MediaSettings {
  return {
    cacheLimitGb: settings.cacheLimitGb,
    previewLongSide: settings.previewLongSide,
    backgroundCores: settings.backgroundCores,
    unusedMediaHours: settings.unusedMediaHours,
  }
}

export function stillDurationTicks(settings: AppSettings): number {
  return Math.round((settings.stillDurationSeconds * TICKS_PER_SECOND) / TIMELINE_GRID) * TIMELINE_GRID
}

export function cacheLimitBytes(settings: MediaSettings): number {
  return settings.cacheLimitGb * BYTES_PER_GIGABYTE
}

export function unusedMediaMs(settings: MediaSettings): number {
  return settings.unusedMediaHours * MILLISECONDS_PER_HOUR
}

export function cacheLimitOffer(usage: CacheUsage): number | undefined {
  if (usage.neededBytes <= usage.limitBytes) return undefined
  const wanted = Math.ceil((usage.neededBytes * OFFER_HEADROOM) / BYTES_PER_GIGABYTE)
  const fitting = Math.floor((usage.usedBytes + usage.freeBytes - FREE_DISK_KEPT_BYTES) / BYTES_PER_GIGABYTE)
  const offer = Math.min(wanted, fitting, SETTING_RANGES.cacheLimitGb.max)
  return offer * BYTES_PER_GIGABYTE > usage.limitBytes ? offer : undefined
}
