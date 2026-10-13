import { describe, expect, it } from 'vitest'
import { bundledFfmpeg } from '../../test/helpers.js'
import { MEDIA_NAMES, mediaPath } from '../../test/media/generate.js'
import type { MediaInfo } from '../shared/mediaProtocol.js'
import { ProbeError, probeMedia } from './probe.js'

const ffmpeg = bundledFfmpeg()
const SECOND = 24_000_000
const UNREADABLE = ['broken-no-index.mp4', 'broken-bitflips.mp4', 'broken-garbage.mp4', 'broken-empty.mp4', 'broken-text.mp3']
const MAX_PROBE_MS = 1000

function probe(name: string): Promise<MediaInfo> {
  return probeMedia(ffmpeg, mediaPath(name))
}

async function probeVideo(name: string): Promise<Extract<MediaInfo, { kind: 'video' }>> {
  const info = await probe(name)
  if (info.kind !== 'video') throw new Error(`${name} was probed as ${info.kind}`)
  return info
}

describe('probeMedia', () => {
  it('reads every usable test file in under a second', async () => {
    for (const name of MEDIA_NAMES) {
      if (UNREADABLE.includes(name)) continue
      const startedAt = performance.now()
      const info = await probe(name)
      expect(performance.now() - startedAt, name).toBeLessThan(MAX_PROBE_MS)

      let expectedKind = 'video'
      if (name.startsWith('image')) {
        expectedKind = 'image'
      } else if (name.startsWith('audio')) {
        expectedKind = 'audio'
      }
      expect(info.kind, name).toBe(expectedKind)
    }
  })

  it('reports size, timing, colour and audio layout', async () => {
    expect(await probe('h264.mp4')).toEqual({
      kind: 'video',
      duration: 2 * SECOND,
      containerStart: 0,
      video: {
        width: 320,
        height: 180,
        frameDuration: 800_000,
        frameCount: 60,
        startOffset: 0,
        seekPreroll: 3 * 800_000,
        isVariableFrameRate: false,
        hasAlpha: false,
        colorMatrix: 'bt709',
        colorRange: 'tv',
        isHdr: false,
        codec: 'h264',
      },
      audio: { channels: 2, sampleRate: 48_000, codec: 'aac' },
    })
  })

  it.each([
    ['fps-23976.mp4', 1_001_000],
    ['fps-24.mp4', 1_000_000],
    ['fps-25.mp4', 960_000],
    ['fps-2997.mp4', 800_800],
    ['fps-50.mp4', 480_000],
    ['fps-5994.mp4', 400_400],
    ['fps-60.mp4', 400_000],
    ['fps-120.mp4', 200_000],
  ])('reads the frame rate of %s exactly', async (name, frameDuration) => {
    const info = await probeVideo(name)
    expect(info.video.frameDuration).toBe(frameDuration)
    expect(info.video.frameCount).toBe(48)
    expect(info.video.isVariableFrameRate).toBe(false)
  })

  it('applies rotation and pixel aspect to the size', async () => {
    expect((await probeVideo('rotated-90.mp4')).video).toMatchObject({ width: 180, height: 320 })
    expect((await probeVideo('rotated-270.mp4')).video).toMatchObject({ width: 180, height: 320 })
    expect((await probeVideo('anamorphic.mp4')).video).toMatchObject({ width: 427, height: 180 })
    expect((await probeVideo('8k.mp4')).video).toMatchObject({ width: 7680, height: 4320 })
  })

  it('assumes BT.709 for untagged HD and BT.601 for untagged SD', async () => {
    expect((await probeVideo('h264-untagged-hd.mp4')).video.colorMatrix).toBe('bt709')
    expect((await probeVideo('h264-untagged-sd.mp4')).video.colorMatrix).toBe('bt601')
  })

  it('detects HDR, variable frame rate and a late video stream', async () => {
    expect((await probeVideo('hevc-hlg-portrait.mov')).video).toMatchObject({ isHdr: true, colorMatrix: 'bt2020', width: 180, height: 320 })
    expect((await probeVideo('variable-rate.mkv')).video.isVariableFrameRate).toBe(true)
    expect((await probeVideo('delayed-video.mkv')).video.startOffset).toBe(SECOND / 10)
  })

  it('detects alpha, including WebM alpha that needs libvpx', async () => {
    expect((await probeVideo('prores4444-alpha.mov')).video.hasAlpha).toBe(true)
    expect((await probeVideo('lossless-alpha.mov')).video.hasAlpha).toBe(true)
    expect((await probeVideo('vp9-alpha.webm')).video).toMatchObject({ hasAlpha: true, alphaDecoder: 'libvpx-vp9' })
    expect((await probeVideo('vp9.webm')).video.hasAlpha).toBe(false)
  })

  it('reads audio layouts', async () => {
    expect(await probe('audio.wav')).toEqual({ kind: 'audio', duration: 2 * SECOND, containerStart: 0, audio: { channels: 2, sampleRate: 48_000, codec: 'pcm_s16le' } })
    expect(await probe('audio-mono.wav')).toMatchObject({ audio: { channels: 1 } })
    expect(await probe('audio-surround.wav')).toMatchObject({ audio: { channels: 6 } })
    expect(await probe('audio-96k-24bit.flac')).toMatchObject({ audio: { sampleRate: 96_000, codec: 'flac' } })
    expect(await probe('audio-44k-click.wav')).toMatchObject({ audio: { sampleRate: 44_100, channels: 1 } })
  })

  it('reads still images', async () => {
    expect(await probe('image-alpha.png')).toEqual({ kind: 'image', width: 320, height: 180, hasAlpha: true })
    expect(await probe('image.jpg')).toEqual({ kind: 'image', width: 320, height: 180, hasAlpha: false })
    expect(await probe('image.webp')).toMatchObject({ kind: 'image', width: 320, height: 180 })
    expect(await probe('image.gif')).toMatchObject({ kind: 'image' })
  })

  // Twelve pictures at ten a second. Only the GIF file states its length; the others are measured by their pictures.
  it.each(['animated.gif', 'animated.webp', 'animated.apng'])('reads %s as moving pictures of 1.2 s', async (name) => {
    const info = await probe(name)
    expect(info).toMatchObject({
      kind: 'video',
      isAnimatedImage: true,
      duration: 1.2 * SECOND,
      containerStart: 0,
      video: { width: 160, height: 90, frameDuration: SECOND / 10, frameCount: 12, startOffset: 0, isVariableFrameRate: false },
    })
    expect(info).not.toHaveProperty('audio')
  })

  it.each(UNREADABLE)('rejects %s with one plain sentence', async (name) => {
    const startedAt = performance.now()
    const rejected = probe(name)
    await expect(rejected).rejects.toThrow(ProbeError)
    await expect(rejected).rejects.toThrow(new RegExp(`^"${name.replace('.', '\\.')}" (could not be read|cannot be used): [^\\n]+\\.$`))
    expect(performance.now() - startedAt).toBeLessThan(MAX_PROBE_MS)
  })

  it('still opens a file that is only cut short', async () => {
    expect((await probe('broken-truncated.mp4')).kind).toBe('video')
  })

  it('reports a missing file', async () => {
    await expect(probeMedia(ffmpeg, '/nonexistent/holiday.mov')).rejects.toThrow('"holiday.mov" was not found.')
  })
})
