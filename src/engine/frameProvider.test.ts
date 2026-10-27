import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TEXTURE_CACHE_BYTES, UNDER_PRESSURE_SHARE } from '../shared/limits.js'
import type { MediaClient } from '../shared/mediaProtocol.js'
import type { Compositor, DrawItem, GpuTexture } from './compositor.js'
import { createFrameProvider, type FrameProvider } from './frameProvider.js'
import type { ImageLayer, VideoLayer } from './resolve.js'

const PICTURE_BYTES = Math.ceil(TEXTURE_CACHE_BYTES * 0.4)
const SCALE = 1
const PLACED = {
  crop: { left: 0, top: 0, right: 0, bottom: 0 },
  transform: { x: 160, y: 90, scaleX: 1, scaleY: 1, rotation: 0 },
  opacity: 1,
}

function notUsed(): never {
  throw new Error('The frame provider should not need this here')
}

function fakeMedia(): MediaClient {
  return {
    loadProject: notUsed,
    loadAnimations: notUsed,
    reopenAnimations: notUsed,
    openMedia: notUsed,
    whenPrepared: notUsed,
    readImage: () => Promise.resolve(new ArrayBuffer(1)),
    previewFrame: notUsed,
    fullFrame: notUsed,
    keyframeThumbnail: notUsed,
    openStream: notUsed,
    streamFrame: notUsed,
    closeStream: notUsed,
    audio: notUsed,
    exportStart: notUsed,
    exportWrite: notUsed,
    exportFinish: notUsed,
    exportCancel: notUsed,
    writeFile: notUsed,
    addMedia: notUsed,
    relinkMedia: notUsed,
    preparation: notUsed,
    want: notUsed,
    waveform: notUsed,
    saveProject: notUsed,
    cacheUsage: notUsed,
    clearCache: notUsed,
  }
}

type FakeGpu = {
  compositor: Compositor
  uploaded: GpuTexture[]
  released: GpuTexture[]
}

function fakeGpu(): FakeGpu {
  const uploaded: GpuTexture[] = []
  const released: GpuTexture[] = []
  function upload(): GpuTexture {
    const texture = { handle: {}, width: 1, height: 1, bytes: PICTURE_BYTES }
    uploaded.push(texture)
    return texture
  }
  const compositor: Compositor = {
    uploadPixels: upload,
    refillPixels: upload,
    uploadImage: upload,
    release: (texture) => released.push(texture),
    render: notUsed,
    present: notUsed,
    readPixels: notUsed,
    startReadback: notUsed,
  }
  return { compositor, uploaded, released }
}

function imageLayer(name: string): ImageLayer {
  return {
    kind: 'image',
    clipId: `clip-${name}`,
    key: `clip-${name}`,
    mediaId: `media-${name}`,
    width: 320,
    height: 180,
    ...PLACED,
  }
}

function texturesOf(items: readonly DrawItem[]): unknown[] {
  return items.map((item) => (item.kind === 'picture' ? item.texture : item.kind))
}

const first = imageLayer('first')
const second = imageLayer('second')
const third = imageLayer('third')

describe('pictures while playing', () => {
  let gpu: FakeGpu
  let provider: FrameProvider

  beforeEach(() => {
    vi.stubGlobal('createImageBitmap', () => Promise.resolve({ close: () => {} }))
    gpu = fakeGpu()
    provider = createFrameProvider(fakeMedia(), gpu.compositor)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  async function firstShownThenPushedOut(): Promise<GpuTexture> {
    await provider.prepare([first], SCALE)
    const shown = provider.itemsNow([first], SCALE)
    expect(shown.lateLayers).toBe(0)
    await provider.prepare([second, third], SCALE)
    const texture = gpu.uploaded[0]
    if (texture === undefined) throw new Error('Nothing was uploaded')
    return texture
  }

  it('draws a picture the cache let go of as it was last shown, instead of leaving its layer out', async () => {
    const texture = await firstShownThenPushedOut()
    const now = provider.itemsNow([first, second, third], SCALE)
    expect(now.lateLayers).toBe(1)
    expect(texturesOf(now.items)).toEqual([texture, gpu.uploaded[1], gpu.uploaded[2]])
  })

  it('never releases a picture that is still shown, however often textures are collected', async () => {
    const texture = await firstShownThenPushedOut()
    for (let frame = 0; frame < 3; frame++) {
      provider.itemsNow([first, second, third], SCALE)
      provider.collect()
    }
    expect(gpu.released).not.toContain(texture)
  })

  it('releases it once its clip has left the frame', async () => {
    const texture = await firstShownThenPushedOut()
    provider.itemsNow([first, second, third], SCALE)
    provider.itemsNow([second, third], SCALE)
    provider.collect()
    expect(gpu.released).toEqual([texture])
  })

  it('releases it once its clip shows a picture that is ready again', async () => {
    const texture = await firstShownThenPushedOut()
    provider.itemsNow([first], SCALE)
    await provider.prepare([first], SCALE)
    const now = provider.itemsNow([first], SCALE)
    provider.collect()
    expect(now.lateLayers).toBe(0)
    expect(texturesOf(now.items)).toEqual([gpu.uploaded[3]])
    expect(gpu.released).toEqual([texture, gpu.uploaded[1]])
  })

  it('keeps a picture the cache still holds when its clip leaves, and lets the cache release it later', async () => {
    await provider.prepare([first], SCALE)
    provider.itemsNow([first], SCALE)
    provider.itemsNow([], SCALE)
    provider.collect()
    expect(gpu.released).toEqual([])
    await provider.prepare([second, third], SCALE)
    provider.collect()
    expect(gpu.released).toEqual([gpu.uploaded[0]])
  })

  it('leaves out, and counts as late, a picture that was never ready', () => {
    const now = provider.itemsNow([first], SCALE)
    expect(now).toEqual({ items: [], lateLayers: 1 })
  })

  it('keeps the next frame\'s pictures when the cache is smaller than one frame, and reads no further ahead', async () => {
    provider.setCacheShare(UNDER_PRESSURE_SHARE)
    provider.keepNextFrame([first, second], SCALE)
    await provider.prepare([first, second], SCALE)
    expect(provider.hasRoomAhead()).toBe(false)
    await provider.prepare([third], SCALE)
    const next = provider.itemsNow([first, second], SCALE)
    expect(next.lateLayers).toBe(0)
    expect(texturesOf(next.items)).toEqual([gpu.uploaded[0], gpu.uploaded[1]])
  })

  it('releases every texture on clear, those still shown included', async () => {
    await firstShownThenPushedOut()
    provider.itemsNow([first, second, third], SCALE)
    provider.clear()
    expect(new Set(gpu.released)).toEqual(new Set(gpu.uploaded))
    expect(gpu.released).toHaveLength(gpu.uploaded.length)
  })
})

describe('a picture that cannot be loaded', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('is asked for again after a pause, not on every frame', async () => {
    vi.stubGlobal('createImageBitmap', () => Promise.resolve({ close: () => {} }))
    const media = fakeMedia()
    const readImage = vi.fn(() => Promise.reject(new Error('The file is damaged')))
    media.readImage = readImage
    const provider = createFrameProvider(media, fakeGpu().compositor)
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000)

    await provider.prepare([first], SCALE)
    await provider.prepare([first], SCALE)
    expect(readImage).toHaveBeenCalledTimes(1)

    now.mockReturnValue(1000 + 2001)
    await provider.prepare([first], SCALE)
    expect(readImage).toHaveBeenCalledTimes(2)
  })
})

function videoAt(frame: number): VideoLayer {
  return {
    kind: 'video',
    clipId: 'clip-video',
    key: 'clip-video',
    mediaId: 'media-video',
    video: { width: 320, height: 180, frameDuration: 800_000, frameCount: 60, startOffset: 0, seekPreroll: 0, isVariableFrameRate: false, hasAlpha: false, colorMatrix: 'bt709', colorRange: 'tv', transfer: 'sdr', codec: 'h264' },
    frame,
    halvings: 0,
    ...PLACED,
  }
}

describe('pictures when playback starts before the playback copies are made', () => {
  let gpu: FakeGpu
  let provider: FrameProvider

  beforeEach(() => {
    vi.stubGlobal('createImageBitmap', () => Promise.resolve({ close: () => {} }))
    gpu = fakeGpu()
    const media: MediaClient = {
      ...fakeMedia(),
      previewFrame: () => Promise.resolve(undefined),
      fullFrame: () => Promise.resolve({ width: 1, height: 1, data: new ArrayBuffer(4) }),
    }
    provider = createFrameProvider(media, gpu.compositor)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reports a video without its playback copy as not ready, and a picture as ready', async () => {
    expect(await provider.prepare([videoAt(0)], SCALE)).toBe(false)
    expect(await provider.prepare([first], SCALE)).toBe(true)
  })

  it('holds a video at its paused picture, instead of leaving it out', async () => {
    await provider.itemsFor([videoAt(0)], 'full', SCALE)
    const now = provider.itemsNow([videoAt(1)], SCALE)
    expect(now.lateLayers).toBe(1)
    expect(texturesOf(now.items)).toEqual([gpu.uploaded[0]])
  })

  it('lets go of the paused picture of a clip that is no longer under the playhead', async () => {
    await provider.itemsFor([videoAt(0)], 'full', SCALE)
    await provider.itemsFor([], 'full', SCALE)
    expect(provider.itemsNow([videoAt(1)], SCALE)).toEqual({ items: [], lateLayers: 1 })
  })
})
