import { MAX_SOURCE_DIMENSION, TEXTURE_CACHE_BYTES } from '../shared/limits.js'
import { logError } from '../shared/log.js'
import type { MediaClient, RawFrame } from '../shared/mediaProtocol.js'
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
  id: Promise<number>
  shown: GpuTexture | undefined
  ahead: { frame: number; raw: Promise<RawFrame> } | undefined
}

export type FrameProvider = {
  itemsFor(layers: readonly Layer[], quality: FrameQuality, outputScale: number, signal?: AbortSignal): Promise<DrawItem[]>
  itemsNow(layers: readonly Layer[], outputScale: number): { items: DrawItem[]; lateLayers: number }
  prepare(layers: readonly Layer[], outputScale: number): Promise<void>
  prefetchStreams(layers: readonly Layer[]): void
  setCacheShare(share: number): void
  collect(): void
  closeStreams(): Promise<void>
  clear(): void
}

class PreviewNotReady extends Error {}

function isDrawn(layer: PictureLayer): layer is DrawnLayer {
  return layer.kind === 'text' || layer.kind === 'callout' || layer.kind === 'arrow'
}

function drawnKey(layer: DrawnLayer, outputScale: number): string {
  const shownLetters = layer.kind === 'text' ? layer.shownLetters : undefined
  return `${layer.kind}:${JSON.stringify([layer.look, shownLetters, layer.sharpScaleX * outputScale, layer.sharpScaleY * outputScale])}`
}

function videoKey(layer: VideoLayer, quality: 'preview' | 'full'): string {
  if (quality === 'preview') return `preview:${layer.mediaId}:${layer.frame}`
  return `full:${layer.mediaId}:${layer.frame}:${layer.halvings}`
}

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
  const lastShown = new Map<string, Picture>()
  const evictedWhileShown = new Set<GpuTexture>()
  const pictures = createByteLru<Picture>(TEXTURE_CACHE_BYTES, (picture) => retire(picture.texture))
  const loading = new Map<string, Promise<Picture>>()
  const streams = new Map<string, OpenStream>()

  function isShown(texture: GpuTexture): boolean {
    for (const picture of lastShown.values()) {
      if (picture.texture === texture) return true
    }
    return false
  }

  function retire(texture: GpuTexture): void {
    if (isShown(texture)) evictedWhileShown.add(texture)
    else retired.push(texture)
  }

  function releaseIfLetGo(texture: GpuTexture): void {
    if (!evictedWhileShown.has(texture) || isShown(texture)) return
    evictedWhileShown.delete(texture)
    retired.push(texture)
  }

  function show(clipId: string, picture: Picture): void {
    const previous = lastShown.get(clipId)
    lastShown.set(clipId, picture)
    if (previous !== undefined && previous.texture !== picture.texture) releaseIfLetGo(previous.texture)
  }

  function forgetShown(clipId: string): void {
    const previous = lastShown.get(clipId)
    if (previous === undefined) return
    lastShown.delete(clipId)
    releaseIfLetGo(previous.texture)
  }

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

  function drawnPicture(layer: DrawnLayer, outputScale: number): Picture {
    const scaleX = layer.sharpScaleX * outputScale
    const scaleY = layer.sharpScaleY * outputScale
    let raster: Raster
    if (layer.kind === 'text') raster = rasterizeText(layer.look, layer.shownLetters, scaleX, scaleY)
    else if (layer.kind === 'callout') raster = rasterizeCallout(layer.look, scaleX, scaleY)
    else raster = rasterizeArrow(layer.look, scaleX, scaleY)
    const texture = compositor.uploadImage(raster.canvas)
    return { texture, naturalWidth: raster.naturalWidth, naturalHeight: raster.naturalHeight, hasAlphaBelow: false }
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

  function streamOf(layer: VideoLayer): OpenStream {
    const known = streams.get(layer.clipId)
    if (known !== undefined) return known
    const opened: OpenStream = { id: media.openStream(layer.mediaId, layer.frame, layer.halvings), shown: undefined, ahead: undefined }
    streams.set(layer.clipId, opened)
    return opened
  }

  async function nextStreamFrame(layer: VideoLayer): Promise<Picture> {
    const stream = streamOf(layer)
    const ahead = stream.ahead
    stream.ahead = undefined
    const frame = ahead?.frame === layer.frame ? await ahead.raw : await media.streamFrame(await stream.id, layer.frame)
    stream.shown = stream.shown === undefined ? compositor.uploadPixels(frame) : compositor.refillPixels(stream.shown, frame)
    return { texture: stream.shown, naturalWidth: layer.video.width, naturalHeight: layer.video.height, hasAlphaBelow: false }
  }

  function pictureFor(layer: PictureLayer, quality: FrameQuality, outputScale: number, signal: AbortSignal | undefined): Promise<Picture> {
    if (layer.kind === 'image') return cached(`image:${layer.mediaId}`, () => loadImage(layer))
    if (isDrawn(layer)) return cached(drawnKey(layer, outputScale), () => Promise.resolve(drawnPicture(layer, outputScale)))
    if (quality === 'stream') return nextStreamFrame(layer)
    if (quality === 'full') return cached(videoKey(layer, 'full'), () => loadFull(layer, signal))
    return previewOrFull(layer, signal)
  }

  function playbackKey(layer: PictureLayer, outputScale: number): string {
    if (layer.kind === 'image') return `image:${layer.mediaId}`
    if (isDrawn(layer)) return drawnKey(layer, outputScale)
    return videoKey(layer, 'preview')
  }

  function prefetchStreams(layers: readonly Layer[]): void {
    for (const layer of layers) {
      if (layer.kind !== 'video') continue
      const stream = streamOf(layer)
      const raw = stream.id.then((id) => media.streamFrame(id, layer.frame))
      // A frame asked for ahead that is never drawn is not needed; one that is drawn reports its failure there.
      raw.catch(() => {})
      stream.ahead = { frame: layer.frame, raw }
    }
  }

  async function closeEndedStreams(layers: readonly Layer[]): Promise<void> {
    const active = new Set(layers.map((layer) => layer.clipId))
    for (const [clipId, stream] of streams) {
      if (active.has(clipId)) continue
      streams.delete(clipId)
      if (stream.shown !== undefined) retired.push(stream.shown)
      await media.closeStream(await stream.id)
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
    const drawnClips = new Set<string>()
    let lateLayers = 0
    for (const layer of layers) {
      if (!hasPicture(layer)) {
        items.push(layer)
        continue
      }
      drawnClips.add(layer.clipId)
      const key = playbackKey(layer, outputScale)
      let ready = pictures.get(key)
      if (ready === undefined && isDrawn(layer)) {
        ready = drawnPicture(layer, outputScale)
        pictures.set(key, ready, ready.texture.bytes)
      }
      if (ready === undefined) lateLayers += 1
      else show(layer.clipId, ready)
      const picture = ready ?? lastShown.get(layer.clipId)
      if (picture !== undefined) items.push(itemOf(layer, picture))
    }
    for (const clipId of [...lastShown.keys()]) {
      if (!drawnClips.has(clipId)) forgetShown(clipId)
    }
    return { items, lateLayers }
  }

  function collect(): void {
    for (const texture of retired) compositor.release(texture)
    retired.length = 0
  }

  function setCacheShare(share: number): void {
    pictures.setLimit(TEXTURE_CACHE_BYTES * share)
  }

  async function closeStreams(): Promise<void> {
    await closeEndedStreams([])
  }

  function clear(): void {
    lastShown.clear()
    pictures.clear()
    retired.push(...evictedWhileShown)
    evictedWhileShown.clear()
    collect()
  }

  return { itemsFor, itemsNow, prepare, prefetchStreams, setCacheShare, collect, closeStreams, clear }
}
