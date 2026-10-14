import type { AudioStretch, MediaInfo, Wanted, WantedRange } from '../shared/mediaProtocol.js'
import { NORMAL_SPEED_PERCENT, TICKS_PER_SAMPLE, TICKS_PER_SECOND, frameIndexAt } from '../shared/time.js'
import { audioLayout, stretchedLayout, stretchKey, type AudioLayout } from './audio.js'
import { previewLayout, type PreviewLayout } from './previewCopy.js'

// What is played within a minute behind and five minutes ahead of the playhead is needed now; the rest is prepared outward from there while the cache has room.
const NEAR_BEFORE_TICKS = 60 * TICKS_PER_SECOND
const NEAR_AFTER_TICKS = 300 * TICKS_PER_SECOND
// A fast clip covers much of its file in little time; no more than ten minutes of one clip's file count as needed now.
const NEAR_SOURCE_TICKS = 600 * TICKS_PER_SECOND
// Something behind the playhead is less likely to be played next than something as far ahead.
const BEHIND_WEIGHT = 2

// In order: sound needed now, waveforms, pictures needed now, then everything else by distance. Waveforms are made beside the rest, so a long one holds nothing back.
const TIERS = { nearSound: 0, waveform: 1, nearPicture: 2, later: 3 } as const

export type PreparationJob =
  | { kind: 'picture'; mediaId: string; segment: number; isNear: boolean; tier: number; distance: number }
  | { kind: 'sound'; mediaId: string; segment: number; stretch?: AudioStretch; isNear: boolean; tier: number; distance: number }
  | { kind: 'waveform'; mediaId: string; isNear: true; tier: number; distance: number }

export type PreparableMedia = {
  id: string
  info: MediaInfo
}

type SourceSpan = {
  from: number
  to: number
}

export function previewLayoutOf(info: MediaInfo, segmentSeconds: number): PreviewLayout | undefined {
  if (info.kind !== 'video') return undefined
  return previewLayout(info.video, segmentSeconds)
}

export function audioLayoutOf(info: MediaInfo, segmentSeconds: number): AudioLayout | undefined {
  if (info.kind === 'image' || info.audio === undefined) return undefined
  return audioLayout(info.duration, segmentSeconds, info.audio.seeksExactly)
}

function sourceSpanOf(range: WantedRange, info: MediaInfo): SourceSpan {
  if (range.isLooping && info.kind !== 'image') return { from: 0, to: info.duration }
  const length = ((range.timelineEnd - range.timelineStart) * range.speedPercent) / NORMAL_SPEED_PERCENT
  return { from: range.sourceStart, to: range.sourceStart + length }
}

// Where on the timeline a source time plays.
function timelineAt(range: WantedRange, sourceTime: number): number {
  return range.timelineStart + ((sourceTime - range.sourceStart) * NORMAL_SPEED_PERCENT) / range.speedPercent
}

function distanceOf(range: WantedRange, sourceFrom: number, sourceTo: number, playhead: number): number {
  const from = Math.max(range.timelineStart, range.isLooping ? range.timelineStart : timelineAt(range, sourceFrom))
  const to = Math.min(range.timelineEnd, range.isLooping ? range.timelineEnd : timelineAt(range, sourceTo))
  if (playhead < from) return from - playhead
  if (playhead >= to) return (playhead - to) * BEHIND_WEIGHT
  return 0
}

function isWithinNearWindow(range: WantedRange, sourceFrom: number, sourceTo: number, playhead: number): boolean {
  const from = range.isLooping ? range.timelineStart : timelineAt(range, sourceFrom)
  const to = range.isLooping ? range.timelineEnd : timelineAt(range, sourceTo)
  return to > playhead - NEAR_BEFORE_TICKS && from < playhead + NEAR_AFTER_TICKS
}

type SegmentSpan = {
  segment: number
  sourceFrom: number
  sourceTo: number
}

type Candidate = {
  segment: number
  distance: number
  isWithinWindow: boolean
  sourceFrom: number
}

type PlacedSegment = {
  segment: number
  distance: number
  isNear: boolean
}

// How far from the playhead each segment of a range plays. The nearest within the window count as needed now, up to ten minutes of source.
function placeSegments(range: WantedRange, spans: readonly SegmentSpan[], playhead: number): PlacedSegment[] {
  const candidates: Candidate[] = []
  for (const { segment, sourceFrom, sourceTo } of spans) {
    candidates.push({ segment, sourceFrom, distance: distanceOf(range, sourceFrom, sourceTo, playhead), isWithinWindow: isWithinNearWindow(range, sourceFrom, sourceTo, playhead) })
  }
  const order = [...candidates.keys()].sort((a, b) => (candidates[a]?.distance ?? 0) - (candidates[b]?.distance ?? 0))
  const nearest = candidates[order[0] ?? 0]
  const placed: PlacedSegment[] = []
  for (const candidate of candidates) {
    const isNear = nearest !== undefined && candidate.isWithinWindow && Math.abs(candidate.sourceFrom - nearest.sourceFrom) <= NEAR_SOURCE_TICKS
    placed.push({ segment: candidate.segment, distance: candidate.distance, isNear })
  }
  return placed
}

function pictureJobs(range: WantedRange, info: MediaInfo, layout: PreviewLayout, playhead: number): PreparationJob[] {
  if (info.kind !== 'video') return []
  const span = sourceSpanOf(range, info)
  const firstFrame = frameIndexAt(info.video, span.from)
  const lastFrame = frameIndexAt(info.video, Math.max(span.from, span.to - 1))
  const segmentTicks = layout.framesPerSegment * info.video.frameDuration
  const spans: SegmentSpan[] = []
  for (let segment = Math.floor(firstFrame / layout.framesPerSegment); segment <= Math.floor(lastFrame / layout.framesPerSegment); segment++) {
    const sourceFrom = info.video.startOffset + segment * segmentTicks
    spans.push({ segment, sourceFrom, sourceTo: sourceFrom + segmentTicks })
  }
  const jobs: PreparationJob[] = []
  for (const { segment, distance, isNear } of placeSegments(range, spans, playhead)) {
    jobs.push({ kind: 'picture', mediaId: range.mediaId, segment, isNear, tier: isNear ? TIERS.nearPicture : TIERS.later, distance })
  }
  return jobs
}

function soundJobs(range: WantedRange, info: MediaInfo, layout: AudioLayout, playhead: number): PreparationJob[] {
  const span = sourceSpanOf(range, info)
  const stretch = range.stretch
  const segmentLayout = stretch === undefined ? layout : stretchedLayout(layout, stretch)
  // Samples of a stretched sound are counted at its speed.
  const speed = stretch?.speedPercent ?? NORMAL_SPEED_PERCENT
  function toSample(sourceTime: number): number {
    return (sourceTime * NORMAL_SPEED_PERCENT) / speed / TICKS_PER_SAMPLE
  }
  function toSource(sample: number): number {
    return (sample * TICKS_PER_SAMPLE * speed) / NORMAL_SPEED_PERCENT
  }
  const perSegment = segmentLayout.samplesPerSegment
  const firstSegment = Math.max(0, Math.floor(toSample(span.from) / perSegment))
  const lastSegment = Math.min(segmentLayout.segmentCount - 1, Math.floor(Math.max(0, toSample(span.to) - 1) / perSegment))
  const spans: SegmentSpan[] = []
  for (let segment = firstSegment; segment <= lastSegment; segment++) {
    spans.push({ segment, sourceFrom: toSource(segment * perSegment), sourceTo: toSource((segment + 1) * perSegment) })
  }
  const jobs: PreparationJob[] = []
  for (const { segment, distance, isNear } of placeSegments(range, spans, playhead)) {
    const job: PreparationJob = { kind: 'sound', mediaId: range.mediaId, segment, isNear, tier: isNear ? TIERS.nearSound : TIERS.later, distance }
    if (stretch !== undefined) job.stretch = stretch
    jobs.push(job)
  }
  return jobs
}

// A file in the project that no clip uses yet is prepared from its start, after what the timeline needs now, so it plays at once when placed.
function unusedRange(media: PreparableMedia, use: WantedRange['use']): WantedRange {
  return { mediaId: media.id, use, timelineStart: NEAR_AFTER_TICKS, timelineEnd: 2 * NEAR_AFTER_TICKS, sourceStart: 0, speedPercent: NORMAL_SPEED_PERCENT, isLooping: false }
}

function jobKey(job: PreparationJob): string {
  if (job.kind === 'waveform') return `waveform:${job.mediaId}`
  if (job.kind === 'picture') return `picture:${job.mediaId}:${job.segment}`
  return `sound:${job.mediaId}:${job.stretch === undefined ? '' : stretchKey(job.stretch)}:${job.segment}`
}

// Everything to prepare, most urgent first. A segment several ranges want is kept once, at its most urgent.
export function planPreparation(wanted: Wanted | undefined, media: readonly PreparableMedia[], segmentSeconds: number): PreparationJob[] {
  const playhead = wanted?.playhead ?? 0
  const byId = new Map(media.map((item) => [item.id, item]))
  const ranges = [...(wanted?.ranges ?? [])]
  const used = new Set(ranges.map((range) => range.mediaId))
  for (const item of media) {
    if (used.has(item.id)) continue
    if (item.info.kind === 'video') ranges.push(unusedRange(item, 'picture'))
    if (item.info.kind !== 'image' && item.info.audio !== undefined) ranges.push(unusedRange(item, 'sound'))
  }

  const best = new Map<string, PreparationJob>()
  function keep(job: PreparationJob): void {
    const key = jobKey(job)
    const known = best.get(key)
    const isMoreUrgent = known === undefined || job.tier < known.tier || (job.tier === known.tier && job.distance < known.distance)
    if (isMoreUrgent) best.set(key, job)
  }

  for (const range of ranges) {
    const item = byId.get(range.mediaId)
    if (item === undefined || range.timelineEnd <= range.timelineStart || range.speedPercent <= 0) continue
    if (range.use === 'picture') {
      const layout = previewLayoutOf(item.info, segmentSeconds)
      if (layout !== undefined) for (const job of pictureJobs(range, item.info, layout, playhead)) keep(job)
      continue
    }
    const layout = audioLayoutOf(item.info, segmentSeconds)
    if (layout === undefined) continue
    for (const job of soundJobs(range, item.info, layout, playhead)) keep(job)
    keep({ kind: 'waveform', mediaId: item.id, isNear: true, tier: TIERS.waveform, distance: 0 })
  }

  return [...best.values()].sort((a, b) => a.tier - b.tier || a.distance - b.distance)
}
