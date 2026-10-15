const MEBIBYTE = 1024 * 1024
const FULL_HD_PIXELS = 1920 * 1080
const ULTRA_HD_PIXELS = 3840 * 2160

export const MAX_SOURCE_DIMENSION = 4096

export const TEXTURE_CACHE_BYTES = 128 * MEBIBYTE

// The part of its usual size each cache of a window keeps while macOS reports memory pressure.
export const UNDER_PRESSURE_SHARE = 0.25

export const READ_AHEAD_FRAMES = 4

export const AUDIO_QUEUE_SECONDS = 0.15

export const AUDIO_CACHE_BYTES = 32 * MEBIBYTE

export const FRAME_DECODE_PIXEL_BUDGET = ULTRA_HD_PIXELS

export const MAX_OPEN_STREAMS = 8

// Preview copies and sound are made and removed in pieces of this length of their source.
export const CACHE_SEGMENT_SECONDS = 30

export function frameDecoderThreads(pixelCount: number): number {
  if (pixelCount <= ULTRA_HD_PIXELS) return 4
  return 2
}

// A stream that hands over every n-th frame decodes n frames for each, so it gets the threads of a single-frame decode.
export function streamDecoderThreads(pixelCount: number, step: number): number {
  if (step > 1) return frameDecoderThreads(pixelCount)
  return 2
}

export type EncoderLimits = {
  threads: number
  lookahead: number
  references: number
}

export function encoderLimits(pixelCount: number): EncoderLimits {
  if (pixelCount <= FULL_HD_PIXELS) return { threads: 4, lookahead: 20, references: 3 }
  return { threads: 4, lookahead: 10, references: 2 }
}

export function minimumHalvings(width: number, height: number): number {
  let halvings = 0
  let longSide = Math.max(width, height)
  while (longSide > MAX_SOURCE_DIMENSION) {
    longSide /= 2
    halvings += 1
  }
  return halvings
}
