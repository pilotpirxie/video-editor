import { MAX_SOURCE_DIMENSION, TEXTURE_CACHE_BYTES } from '../shared/limits.js'
import { logError } from '../shared/log.js'
import type { MediaClient } from '../shared/mediaProtocol.js'
import { createByteLru } from './byteLru.js'
import type { Compositor, DrawItem, GpuTexture } from './compositor.js'
import { rasterizeArrow, rasterizeCallout } from './annotations.js'
import type { DrawnLayer, ImageLayer, Layer, PictureLayer, VideoLayer } from './resolve.js'
import { rasterizeText, type Raster } from './text.js'

const NO_CROP = { left: 0, top: 0, right: 0, bottom: 0 }

type FrameQuality =
  | 'preview'
  | 'full'
  | 'stream'

type Picture = {
  texture: GpuTexture
  naturalWidth: number
  naturalHeight: number
  hasAlphaBelow: boolean
}

type OpenStream = {
  id: number
  shown: GpuTexture | undefined
}

export type FrameProvider = {
  itemsFor(layers: readonly Layer[], quality: FrameQuality, outputScale: number, signal?: AbortSignal): Promise<DrawItem[]>
  itemsNow(layers: readonly Layer[], outputScale: number): { items: DrawItem[]; lateLayers: number }
  prepare(layers: readonly Layer[], outputScale: number): Promise<void>
  collect(): void
  closeStreams(): Promise<void>
  clear(): void
}

class PreviewNotReady extends Error {}

function isDrawn(layer: PictureLayer): layer is DrawnLayer {
  return layer.kind === 'text' || layer.kind === 'callout' || layer.kind === 'arrow'
}

// Everything a drawn layer's picture depends on: what it shows, and how large it is drawn.
function drawnKey(layer: DrawnLayer, outputScale: number): string {
  const shownLetters = layer.kind === 'text' ? layer.shownLetters : undefined
  return `${layer.kind}:${JSON.stringify([layer.look, shownLetters, layer.sharpScaleX * outputScale, layer.sharpScaleY * outputScale])}`
}

function videoKey(layer: VideoLayer, quality: 'preview' | 'full'): string {
  if (quality === 'preview') return `preview:${layer.mediaId}:${layer.frame}`
  return `full:${layer.mediaId}:${layer.frame}:${layer.halvings}`
}

// Blur and highlight layers have no picture of their own: they are drawn from what is beneath them.
function hasPicture(layer: Layer): layer is PictureLayer {
  return layer.kind !== 'blur' && layer.kind !== 'highlight'
}

function itemOf(layer: PictureLayer, picture: Picture): DrawItem {
  return {
    kind: 'picture',
    texture: picture.texture,
    naturalWidth: picture.naturalWidth,
    naturalHeight: picture.naturalHeight,
    crop: isDrawn(layer) ? NO_CROP : layer.crop,
    transform: layer.transform,
    placed: layer.placed,
    opacity: layer.opacity,
    hasAlphaBelow: picture.hasAlphaBelow,
    effects: layer.effects,
    transition: layer.transition,
  }
}

export function createFrameProvider(media: MediaClient, compositor: Compositor): FrameProvider {
  const retired: GpuTexture[] = []
  const pictures = createByteLru<Picture>(TEXTURE_CACHE_BYTES, (picture) => retired.push(picture.texture))
  const loading = new Map<string, Promise<Picture>>()
  const streams = new Map<string, OpenStream>()
  const lastShown = new Map<string, string>()

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

  function loadDrawn(layer: DrawnLayer, outputScale: number): Promise<Picture> {
    const scaleX = layer.sharpScaleX * outputScale
    const scaleY = layer.sharpScaleY * outputScale
    let raster: Raster
    if (layer.kind === 'text') raster = rasterizeText(layer.look, layer.shownLetters, scaleX, scaleY)
    else if (layer.kind === 'callout') raster = rasterizeCallout(layer.look, scaleX, scaleY)
    else raster = rasterizeArrow(layer.look, scaleX, scaleY)
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

  function pictureFor(layer: PictureLayer, quality: FrameQuality, outputScale: number, signal: AbortSignal | undefined): Promise<Picture> {
    if (layer.kind === 'image') return cached(`image:${layer.mediaId}`, () => loadImage(layer))
    if (isDrawn(layer)) return cached(drawnKey(layer, outputScale), () => loadDrawn(layer, outputScale))
    if (quality === 'stream') return nextStreamFrame(layer)
    if (quality === 'full') return cached(videoKey(layer, 'full'), () => loadFull(layer, signal))
    return previewOrFull(layer, signal)
  }

  function playbackKey(layer: PictureLayer, outputScale: number): string {
    if (layer.kind === 'image') return `image:${layer.mediaId}`
    if (isDrawn(layer)) return drawnKey(layer, outputScale)
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
    const loaded = await Promise.all(layers.map((layer) => (hasPicture(layer) ? pictureFor(layer, quality, outputScale, signal) : undefined)))
    const items: DrawItem[] = []
    for (const [index, layer] of layers.entries()) {
      const picture = loaded[index]
      if (!hasPicture(layer)) items.push(layer)
      else if (picture !== undefined) items.push(itemOf(layer, picture))
    }
    return items
  }

  async function prepareOne(layer: Layer, outputScale: number): Promise<void> {
    if (!hasPicture(layer)) return
    const key = playbackKey(layer, outputScale)
    if (pictures.get(key) !== undefined) return
    try {
      if (layer.kind === 'video') {
        await cached(key, () => requirePreview(layer))
      } else {
        await pictureFor(layer, 'preview', outputScale, undefined)
      }
    } catch (error) {
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
      if (!hasPicture(layer)) {
        items.push(layer)
        continue
      }
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
