const MEBIBYTE = 1024 * 1024
const ULTRA_HD_PIXELS = 3840 * 2160

export const MAX_SOURCE_DIMENSION = 4096

export const TEXTURE_CACHE_BYTES = 128 * MEBIBYTE

export const UNDER_PRESSURE_SHARE = 0.25

export const READ_AHEAD_FRAMES = 4

export const AUDIO_QUEUE_SECONDS = 0.15

export const AUDIO_CACHE_BYTES = 32 * MEBIBYTE

export const FRAME_DECODE_PIXEL_BUDGET = ULTRA_HD_PIXELS

export const MAX_OPEN_STREAMS = 8

export const CACHE_SEGMENT_SECONDS = 30

// One core stays free for the interface, so decoding never starves input and paint on a small machine.
export function frameDecoderThreads(pixelCount: number, cores: number): number {
  const wanted = pixelCount <= ULTRA_HD_PIXELS ? 4 : 2
  return Math.max(1, Math.min(wanted, cores - 1))
}

export function streamDecoderThreads(pixelCount: number, step: number, cores: number): number {
  if (step > 1) return frameDecoderThreads(pixelCount, cores)
  return Math.max(1, Math.min(2, cores - 1))
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
