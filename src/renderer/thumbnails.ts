import { createByteLru } from '../engine/byteLru.js'
import { minimumHalvings, UNDER_PRESSURE_SHARE } from '../shared/limits.js'
import { logError } from '../shared/log.js'
import type { MediaClient, MediaInfo, VideoInfo, WaveformLevel } from '../shared/mediaProtocol.js'

const POSTER_HEIGHT = 120
const FRAME_HEIGHT = 96
const CACHE_BYTES = 24 * 1024 * 1024
const BYTES_PER_PIXEL = 4
const MAX_HALVINGS = 6
const MAX_FRAME_REQUESTS = 4
const RETRY_AFTER_MS = 1000

function standInKeyOf(mediaId: string, frame: number): string {
  return `keyframe:${mediaId}:${frame}`
}

export type Thumbnails = {
  poster(mediaId: string, info: MediaInfo): ImageBitmap | undefined
  videoFrame(mediaId: string, video: VideoInfo, frame: number): ImageBitmap | undefined
  waveform(mediaId: string): readonly WaveformLevel[] | undefined
  subscribe(listener: () => void): () => void
  setUnderPressure(isUnderPressure: boolean): void
}

export function createThumbnails(media: MediaClient, isPlaying: () => boolean): Thumbnails {
  const pictures = createByteLru<ImageBitmap>(CACHE_BYTES, (bitmap) => bitmap.close())
  const waveforms = new Map<string, WaveformLevel[]>()
  const inFlight = new Set<string>()
  const notReadyAt = new Map<string, number>()
  const listeners = new Set<() => void>()
  let frameRequests = 0
  let retryTimer: number | undefined

  function askAgainLater(): void {
    retryTimer ??= window.setTimeout(() => {
      retryTimer = undefined
      for (const listener of listeners) listener()
    }, RETRY_AFTER_MS)
  }

  function canRequest(key: string): boolean {
    if (inFlight.has(key)) return false
    const missedAt = notReadyAt.get(key)
    if (missedAt === undefined || performance.now() - missedAt >= RETRY_AFTER_MS) return true
    askAgainLater()
    return false
  }

  async function fetchOnce(key: string, load: () => Promise<boolean>): Promise<void> {
    inFlight.add(key)
    let isReady = false
    try {
      isReady = await load()
    } catch (error) {
      logError('Could not load a thumbnail', error, { key })
    }
    inFlight.delete(key)
    if (!isReady) {
      notReadyAt.set(key, performance.now())
      askAgainLater()
      return
    }
    notReadyAt.delete(key)
    for (const listener of listeners) listener()
  }

  function halvingsFor(video: VideoInfo, height: number): number {
    const wanted = Math.floor(Math.log2(video.height / height))
    return Math.min(MAX_HALVINGS, Math.max(0, wanted, minimumHalvings(video.width, video.height)))
  }

  function keep(key: string, bitmap: ImageBitmap): boolean {
    pictures.set(key, bitmap, bitmap.width * bitmap.height * BYTES_PER_PIXEL)
    return true
  }

  async function loadPoster(key: string, mediaId: string, info: MediaInfo): Promise<boolean> {
    if (info.kind === 'audio') return false
    if (info.kind === 'image') {
      const bytes = await media.readImage(mediaId)
      return keep(key, await createImageBitmap(new Blob([bytes]), { resizeHeight: POSTER_HEIGHT, resizeQuality: 'medium' }))
    }
    const frame = await media.fullFrame(mediaId, 0, halvingsFor(info.video, POSTER_HEIGHT))
    return keep(key, await createImageBitmap(new ImageData(new Uint8ClampedArray(frame.data), frame.width, frame.height)))
  }

  async function loadKeyframe(mediaId: string, video: VideoInfo, frame: number): Promise<void> {
    const key = standInKeyOf(mediaId, frame)
    if (pictures.get(key) !== undefined) return
    const decoded = await media.keyframeThumbnail(mediaId, frame, halvingsFor(video, FRAME_HEIGHT))
    const whole = await createImageBitmap(new ImageData(new Uint8ClampedArray(decoded.data), decoded.width, decoded.height))
    const width = Math.round((whole.width * FRAME_HEIGHT) / whole.height)
    keep(key, await createImageBitmap(whole, { resizeWidth: width, resizeHeight: FRAME_HEIGHT }))
    whole.close()
    for (const listener of listeners) listener()
  }

  async function loadVideoFrame(key: string, mediaId: string, video: VideoInfo, frame: number): Promise<boolean> {
    frameRequests += 1
    try {
      const jpeg = await media.previewFrame(mediaId, frame)
      if (jpeg === undefined) {
        await loadKeyframe(mediaId, video, frame)
        return false
      }
      const whole = await createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }))
      const pictureHeight = video.hasAlpha ? whole.height / 2 : whole.height
      const width = Math.round((whole.width * FRAME_HEIGHT) / pictureHeight)
      const picture = await createImageBitmap(whole, 0, 0, whole.width, pictureHeight, { resizeWidth: width, resizeHeight: FRAME_HEIGHT })
      whole.close()
      return keep(key, picture)
    } finally {
      frameRequests -= 1
    }
  }

  async function loadWaveform(mediaId: string): Promise<boolean> {
    const levels = await media.waveform(mediaId)
    if (levels === undefined) return false
    waveforms.set(mediaId, levels)
    return true
  }

  return {
    poster(mediaId, info) {
      const key = `poster:${mediaId}`
      const known = pictures.get(key)
      if (known === undefined && canRequest(key)) void fetchOnce(key, () => loadPoster(key, mediaId, info))
      return known
    },
    videoFrame(mediaId, video, frame) {
      const key = `frame:${mediaId}:${frame}`
      const known = pictures.get(key)
      const mayFetch = known === undefined && !isPlaying() && frameRequests < MAX_FRAME_REQUESTS && canRequest(key)
      if (mayFetch) void fetchOnce(key, () => loadVideoFrame(key, mediaId, video, frame))
      return known ?? pictures.get(standInKeyOf(mediaId, frame))
    },
    waveform(mediaId) {
      const key = `waveform:${mediaId}`
      const known = waveforms.get(mediaId)
      if (known === undefined && canRequest(key)) void fetchOnce(key, () => loadWaveform(mediaId))
      return known
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    setUnderPressure(isUnderPressure) {
      pictures.setLimit(isUnderPressure ? CACHE_BYTES * UNDER_PRESSURE_SHARE : CACHE_BYTES)
    },
  }
}
