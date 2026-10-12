// Turns resolved layers into textures: stills and text once, video frames from the preview
// copy (playback and scrubbing), from the original by seeking (paused), or from a sequential
// decoder (export). Everything it uploads lives in one byte-capped cache.
import { MAX_SOURCE_DIMENSION, TEXTURE_CACHE_BYTES } from '../shared/limits.js'
import { logError } from '../shared/log.js'
import type { MediaClient } from '../shared/mediaProtocol.js'
import { createByteLru } from './byteLru.js'
import type { Compositor, DrawItem, GpuTexture } from './compositor.js'
import type { ImageLayer, Layer, TextLayer, VideoLayer } from './resolve.js'
import { rasterizeText } from './text.js'

const NO_CROP = { left: 0, top: 0, right: 0, bottom: 0 }

/** Where video frames come from. */
export type FrameQuality =
  // Preview copy; a frame that is not prepared yet falls back to the original.
  | 'preview'
  // The original file, decoded by seeking to the frame.
  | 'full'
  // The original file, decoded in order by one running decoder per clip.
  | 'stream'

type Picture = {
  texture: GpuTexture
  /** Size of the whole picture in canvas pixels. */
  naturalWidth: number
  naturalHeight: number
  hasAlphaBelow: boolean
}

type OpenStream = {
  id: number
  /** The frame this clip shows now; replaced, and its texture retired, on the next frame. */
  shown: GpuTexture | undefined
}

export type FrameProvider = {
  /** Draw items for exactly these layers; waits until every picture is there. */
  itemsFor(layers: readonly Layer[], quality: FrameQuality, outputScale: number, signal?: AbortSignal): Promise<DrawItem[]>
  /**
   * Draw items from what is already loaded. A layer whose picture is not ready shows the
   * last one it had; `lateLayers` counts those.
   */
  itemsNow(layers: readonly Layer[], outputScale: number): { items: DrawItem[]; lateLayers: number }
  /**
   * Loads preview pictures so that itemsNow finds them later. Resolves when they are loaded
   * or known to be unavailable; never rejects.
   */
  prepare(layers: readonly Layer[], outputScale: number): Promise<void>
  /** Frees textures that left the cache. Call after each render, never between loading and drawing. */
  collect(): void
  /** Stops the sequential decoders of an export. */
  closeStreams(): Promise<void>
  /** Drops every picture; for when another project is loaded. */
  clear(): void
}

/** The preview copy does not hold this frame yet. */
class PreviewNotReady extends Error {}

function textKey(layer: TextLayer, scaleX: number, scaleY: number): string {
  return `text:${JSON.stringify([layer.text, layer.family, layer.size, layer.color, layer.align, scaleX, scaleY])}`
}

function videoKey(layer: VideoLayer, quality: 'preview' | 'full'): string {
  if (quality === 'preview') return `preview:${layer.mediaId}:${layer.frame}`
  return `full:${layer.mediaId}:${layer.frame}:${layer.halvings}`
}

function itemOf(layer: Layer, picture: Picture): DrawItem {
  return {
    texture: picture.texture,
    naturalWidth: picture.naturalWidth,
    naturalHeight: picture.naturalHeight,
    crop: layer.kind === 'text' ? NO_CROP : layer.crop,
    transform: layer.transform,
    opacity: layer.opacity,
    hasAlphaBelow: picture.hasAlphaBelow,
  }
}

export function createFrameProvider(media: MediaClient, compositor: Compositor): FrameProvider {
  const retired: GpuTexture[] = []
  const pictures = createByteLru<Picture>(TEXTURE_CACHE_BYTES, (picture) => retired.push(picture.texture))
  const loading = new Map<string, Promise<Picture>>()
  const streams = new Map<string, OpenStream>()
  /** Cache key of the last picture each clip showed, for when its next one is late. */
  const lastShown = new Map<string, string>()

  /** Returns the cached picture for `key`, loading it once however many callers ask. */
  async function cached(key: string, load: () => Promise<Picture>): Promise<Picture> {
    const ready = pictures.get(key)
    if (ready !== undefined) return ready
    const pending = loading.get(key)
    if (pending !== undefined) return pending

    const started = load()
    loading.set(key, started)
    try {
      const picture = await started
      pictures.set(key, picture, picture.texture.bytes)
      return picture
    } finally {
      loading.delete(key)
    }
  }

  async function loadImage(layer: ImageLayer): Promise<Picture> {
    const bytes = await media.readImage(layer.mediaId)
    const options: ImageBitmapOptions = { premultiplyAlpha: 'premultiply', colorSpaceConversion: 'none' }
    const longSide = Math.max(layer.width, layer.height)
    if (longSide > MAX_SOURCE_DIMENSION) {
      options.resizeWidth = Math.round((layer.width * MAX_SOURCE_DIMENSION) / longSide)
      options.resizeHeight = Math.round((layer.height * MAX_SOURCE_DIMENSION) / longSide)
      options.resizeQuality = 'high'
    }
    const bitmap = await createImageBitmap(new Blob([bytes]), options)
    const texture = compositor.uploadImage(bitmap)
    bitmap.close()
    return { texture, naturalWidth: layer.width, naturalHeight: layer.height, hasAlphaBelow: false }
  }

  function loadText(layer: TextLayer, scaleX: number, scaleY: number): Promise<Picture> {
    const raster = rasterizeText(layer, scaleX, scaleY)
    const texture = compositor.uploadImage(raster.canvas)
    return Promise.resolve({ texture, naturalWidth: raster.naturalWidth, naturalHeight: raster.naturalHeight, hasAlphaBelow: false })
  }

  async function loadFull(layer: VideoLayer, signal: AbortSignal | undefined): Promise<Picture> {
    const frame = await media.fullFrame(layer.mediaId, layer.frame, layer.halvings, signal)
    return { texture: compositor.uploadPixels(frame), naturalWidth: layer.video.width, naturalHeight: layer.video.height, hasAlphaBelow: false }
  }

  async function loadPreview(layer: VideoLayer): Promise<Picture | undefined> {
    const jpeg = await media.previewFrame(layer.mediaId, layer.frame)
    if (jpeg === undefined) return undefined
    const bitmap = await createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }), { colorSpaceConversion: 'none' })
    const texture = compositor.uploadImage(bitmap)
    bitmap.close()
    return { texture, naturalWidth: layer.video.width, naturalHeight: layer.video.height, hasAlphaBelow: layer.video.hasAlpha }
  }

  async function previewOrFull(layer: VideoLayer, signal: AbortSignal | undefined): Promise<Picture> {
    const previewKey = videoKey(layer, 'preview')
    const ready = pictures.get(previewKey)
    if (ready !== undefined) return ready
    const preview = await loadPreview(layer)
    if (preview !== undefined) {
      pictures.set(previewKey, preview, preview.texture.bytes)
      return preview
    }
    return cached(videoKey(layer, 'full'), () => loadFull(layer, signal))
  }

  async function nextStreamFrame(layer: VideoLayer): Promise<Picture> {
    let stream = streams.get(layer.clipId)
    if (stream === undefined) {
      stream = { id: await media.openStream(layer.mediaId, layer.frame, layer.halvings), shown: undefined }
      streams.set(layer.clipId, stream)
    }
    const frame = await media.streamFrame(stream.id, layer.frame)
    if (stream.shown !== undefined) retired.push(stream.shown)
    stream.shown = compositor.uploadPixels(frame)
    return { texture: stream.shown, naturalWidth: layer.video.width, naturalHeight: layer.video.height, hasAlphaBelow: false }
  }

  function pictureFor(layer: Layer, quality: FrameQuality, outputScale: number, signal: AbortSignal | undefined): Promise<Picture> {
    if (layer.kind === 'image') return cached(`image:${layer.mediaId}`, () => loadImage(layer))
    if (layer.kind === 'text') {
      const scaleX = layer.transform.scaleX * outputScale
      const scaleY = layer.transform.scaleY * outputScale
      return cached(textKey(layer, scaleX, scaleY), () => loadText(layer, scaleX, scaleY))
    }
    if (quality === 'stream') return nextStreamFrame(layer)
    if (quality === 'full') return cached(videoKey(layer, 'full'), () => loadFull(layer, signal))
    return previewOrFull(layer, signal)
  }

  /** Cache key under which a layer's picture is found during playback. */
  function playbackKey(layer: Layer, outputScale: number): string {
    if (layer.kind === 'image') return `image:${layer.mediaId}`
    if (layer.kind === 'text') return textKey(layer, layer.transform.scaleX * outputScale, layer.transform.scaleY * outputScale)
    return videoKey(layer, 'preview')
  }

  async function closeEndedStreams(layers: readonly Layer[]): Promise<void> {
    const active = new Set(layers.map((layer) => layer.clipId))
    for (const [clipId, stream] of streams) {
      if (active.has(clipId)) continue
      streams.delete(clipId)
      if (stream.shown !== undefined) retired.push(stream.shown)
      await media.closeStream(stream.id)
    }
  }

  async function itemsFor(layers: readonly Layer[], quality: FrameQuality, outputScale: number, signal?: AbortSignal): Promise<DrawItem[]> {
    if (quality === 'stream') await closeEndedStreams(layers)
    const loaded = await Promise.all(layers.map((layer) => pictureFor(layer, quality, outputScale, signal)))
    const items: DrawItem[] = []
    for (const [index, layer] of layers.entries()) {
      const picture = loaded[index]
      if (picture !== undefined) items.push(itemOf(layer, picture))
    }
    return items
  }

  async function prepareOne(layer: Layer, outputScale: number): Promise<void> {
    const key = playbackKey(layer, outputScale)
    if (pictures.get(key) !== undefined) return
    try {
      // Loaded under the playback key, so that itemsNow finds it.
      if (layer.kind === 'video') {
        await cached(key, () => requirePreview(layer))
      } else {
        await pictureFor(layer, 'preview', outputScale, undefined)
      }
    } catch (error) {
      // A preview frame that is not prepared yet simply shows up as a late layer.
      if (!(error instanceof PreviewNotReady)) logError('Could not load a picture for playback', error, { clipId: layer.clipId })
    }
  }

  async function prepare(layers: readonly Layer[], outputScale: number): Promise<void> {
    await Promise.all(layers.map((layer) => prepareOne(layer, outputScale)))
  }

  async function requirePreview(layer: VideoLayer): Promise<Picture> {
    const preview = await loadPreview(layer)
    if (preview === undefined) throw new PreviewNotReady()
    return preview
  }

  function itemsNow(layers: readonly Layer[], outputScale: number): { items: DrawItem[]; lateLayers: number } {
    const items: DrawItem[] = []
    let lateLayers = 0
    for (const layer of layers) {
      const key = playbackKey(layer, outputScale)
      let picture = pictures.get(key)
      if (picture === undefined) {
        lateLayers += 1
        const previousKey = lastShown.get(layer.clipId)
        picture = previousKey === undefined ? undefined : pictures.get(previousKey)
      } else {
        lastShown.set(layer.clipId, key)
      }
      if (picture !== undefined) items.push(itemOf(layer, picture))
    }
    return { items, lateLayers }
  }

  function collect(): void {
    for (const texture of retired) compositor.release(texture)
    retired.length = 0
  }

  async function closeStreams(): Promise<void> {
    await closeEndedStreams([])
  }

  function clear(): void {
    pictures.clear()
    lastShown.clear()
    collect()
  }

  return { itemsFor, itemsNow, prepare, collect, closeStreams, clear }
}
