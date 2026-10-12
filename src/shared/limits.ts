// Hard caps that keep the whole editor inside its memory budget (AGENTS.md §12).
// Every cache, decoder and export buffer takes its size from here.

const MEBIBYTE = 1024 * 1024
const FULL_HD_PIXELS = 1920 * 1080
const ULTRA_HD_PIXELS = 3840 * 2160

/** Sources larger than this on either side are halved by FFmpeg before they reach the GPU. */
export const MAX_SOURCE_DIMENSION = 4096

/**
 * Texture bytes kept for decoded frames, images and text, mip chains included. The GPU process
 * was measured holding about twice this, so the figure is half of what the budget allows.
 */
export const TEXTURE_CACHE_BYTES = 128 * MEBIBYTE

/** Decoded preview frames kept ahead of the playhead, per layer. */
export const READ_AHEAD_FRAMES = 4

/** Mixed audio queued for the output device, in seconds. */
export const AUDIO_QUEUE_SECONDS = 0.15

/** Decoded audio the engine keeps in memory. */
export const AUDIO_CACHE_BYTES = 32 * MEBIBYTE

/**
 * Picture area, in pixels, that single-frame FFmpeg decoders may be working on at once:
 * four 1080p frames or one 4K frame. A larger frame than this is decoded alone.
 */
export const FRAME_DECODE_PIXEL_BUDGET = ULTRA_HD_PIXELS

/** Sequential FFmpeg decoders kept open during an export. */
export const MAX_OPEN_STREAMS = 8

/**
 * Threads for decoding one frame by seeking. The process lives for a moment, so it may use
 * more threads than a decoder that stays open; measured at about 140 MB for 1080p and 600 MB for 4K.
 */
export function frameDecoderThreads(pixelCount: number): number {
  if (pixelCount <= ULTRA_HD_PIXELS) return 4
  return 2
}

/**
 * Threads for a decoder that stays open through an export, next to the encoder. Each thread
 * holds whole frames: two threads measured at about 100 MB for 1080p and 315 MB for 4K.
 */
export function streamDecoderThreads(_pixelCount: number): number {
  return 2
}

export type EncoderLimits = {
  threads: number
  /** Frames x264 buffers to plan bitrate; with reference frames, its largest memory cost. */
  lookahead: number
  /** Earlier frames x264 may predict from. */
  references: number
}

/**
 * x264 settings that keep the encoder near 360 MB at 1080p; larger pictures get less to work with.
 *
 * Known miss: at 4K x264 needs about 1.1 GB with these settings (0.86 GB with B-frames and
 * lookahead off), so a 4K export peaks near 2.2 GB, over the 1.5 GB budget of AGENTS.md §12.
 * The hardware encoder would fit (1.25 GB measured) but x264 was kept for its quality
 * (decided 2026-10-13); test/engine/limits.test.ts tracks the gap.
 */
export function encoderLimits(pixelCount: number): EncoderLimits {
  if (pixelCount <= FULL_HD_PIXELS) return { threads: 4, lookahead: 20, references: 3 }
  return { threads: 4, lookahead: 10, references: 2 }
}

/** How many times a source must be halved to fit MAX_SOURCE_DIMENSION. */
export function minimumHalvings(width: number, height: number): number {
  let halvings = 0
  let longSide = Math.max(width, height)
  while (longSide > MAX_SOURCE_DIMENSION) {
    longSide /= 2
    halvings += 1
  }
  return halvings
}
