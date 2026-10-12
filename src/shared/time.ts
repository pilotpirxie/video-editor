// All times are integer ticks. One tick is 1/24,000,000 s: every supported frame
// duration and one 48 kHz sample are whole ticks, and timeline positions sit on a
// 100-tick grid so that integer-percent speeds map them to whole source ticks.

export type FrameRate = {
  readonly num: number
  readonly den: number
}

export const TICKS_PER_SECOND = 24_000_000
export const TIMELINE_GRID = 100
export const SAMPLE_RATE = 48_000
export const TICKS_PER_SAMPLE = TICKS_PER_SECOND / SAMPLE_RATE

export const MIN_SPEED_PERCENT = 25
export const MAX_SPEED_PERCENT = 10_000

export const PROJECT_FRAME_RATES: readonly FrameRate[] = [
  { num: 24000, den: 1001 },
  { num: 24, den: 1 },
  { num: 25, den: 1 },
  { num: 30000, den: 1001 },
  { num: 30, den: 1 },
  { num: 50, den: 1 },
  { num: 60, den: 1 },
]

export function isProjectFrameRate(rate: FrameRate): boolean {
  return PROJECT_FRAME_RATES.some((allowed) => allowed.num === rate.num && allowed.den === rate.den)
}

/** Frame duration in ticks, or undefined when the rate does not divide a second into whole ticks. */
export function exactFrameDuration(rate: FrameRate): number | undefined {
  if (rate.num <= 0 || rate.den <= 0) return undefined
  const ticks = (TICKS_PER_SECOND * rate.den) / rate.num
  return Number.isInteger(ticks) ? ticks : undefined
}

export function frameDuration(rate: FrameRate): number {
  const ticks = exactFrameDuration(rate)
  if (ticks === undefined) throw new RangeError(`Frame rate ${rate.num}/${rate.den} has no whole-tick frame duration`)
  return ticks
}

export function frameAt(time: number, frameDurationTicks: number): number {
  return Math.floor(time / frameDurationTicks)
}

export function sampleAt(time: number): number {
  return Math.floor(time / TICKS_PER_SAMPLE)
}

export function isOnTimelineGrid(time: number): boolean {
  return Number.isSafeInteger(time) && time % TIMELINE_GRID === 0
}

export type SourceMapping = {
  readonly start: number
  readonly sourceStart: number
  readonly speedPercent: number
}

/** Source time shown at timeline time `time`. Exact for any `time` on the timeline grid. */
export function sourceTime(clip: SourceMapping, time: number): number {
  // Divide first: the product of a 20-hour offset and a 10000% speed would exceed 2^53.
  return clip.sourceStart + ((time - clip.start) / TIMELINE_GRID) * clip.speedPercent
}

export type FrameTiming = {
  readonly startOffset: number
  readonly frameDuration: number
  readonly frameCount: number
}

/** The source frame at or before `time`, where source time 0 is the container start. */
export function frameIndexAt(video: FrameTiming, time: number): number {
  const index = Math.floor((time - video.startOffset) / video.frameDuration)
  return Math.min(Math.max(index, 0), video.frameCount - 1)
}

export function secondsToTicks(seconds: number): number {
  return Math.round(seconds * TICKS_PER_SECOND)
}

export function ticksToSeconds(ticks: number): number {
  return ticks / TICKS_PER_SECOND
}

/** Non-drop-frame timecode HH:MM:SS:FF counted in whole frames of `rate`. */
export function timecode(time: number, rate: FrameRate): string {
  const framesPerSecond = Math.ceil(rate.num / rate.den)
  const totalFrames = frameAt(time, frameDuration(rate))
  const frames = totalFrames % framesPerSecond
  const totalSeconds = Math.floor(totalFrames / framesPerSecond)
  const seconds = totalSeconds % 60
  const minutes = Math.floor(totalSeconds / 60) % 60
  const hours = Math.floor(totalSeconds / 3600)
  return `${twoDigits(hours)}:${twoDigits(minutes)}:${twoDigits(seconds)}:${twoDigits(frames)}`
}

function twoDigits(value: number): string {
  return String(value).padStart(2, '0')
}
