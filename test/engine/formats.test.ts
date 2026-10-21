import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bundledFfmpeg, decodedAudio, probeExport, projectPath, renderFrames, runApp, sameBytes, scratchDirectory, type Picture } from '../helpers.js'
import { mediaPath } from '../media/generate.js'

const ffmpeg = bundledFfmpeg()
const scratch = scratchDirectory('formats')
const PROJECT = 'export-check'
const SAMPLE_RATE = 48_000
const STILL_FRAME = 45

async function exported(name: string, extra: readonly string[] = []): Promise<string> {
  const path = join(scratch, name)
  const result = await runApp(['--export', projectPath(PROJECT), '--out', path, '--preset', '240p', ...extra])
  if (result.exitCode !== 0) throw new Error(`Export failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`)
  return path
}

async function pictureOf(path: string, width: number, height: number): Promise<Picture> {
  const raw = await ffmpeg.runOnce('ffmpeg', ['-i', path, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { timeoutMs: 30_000 })
  const data = new ArrayBuffer(raw.length)
  new Uint8Array(data).set(raw)
  return { width, height, data }
}

describe('export formats', () => {
  it('writes WebM with VP9 and Opus', async () => {
    const probed = await probeExport(await exported('video.webm'))
    expect(probed.video).toMatchObject({ codec_name: 'vp9', width: '426', height: '240', r_frame_rate: '30/1' })
    expect(probed.audio).toMatchObject({ codec_name: 'opus', sample_rate: '48000', channels: '2' })
    expect(Math.abs(probed.duration - 2)).toBeLessThan(0.05)
  })

  it('writes an animated GIF at ten pictures a second unless asked otherwise', async () => {
    const path = await exported('moving.gif')
    const probed = await probeExport(path)
    expect(probed.video).toMatchObject({ codec_name: 'gif', width: '426', height: '240' })
    expect(probed.audio).toEqual({})
    const delays = (await ffmpeg.runOnce('ffprobe', ['-select_streams', 'v', '-show_entries', 'packet=duration_time', '-of', 'csv=p=0', path], { timeoutMs: 30_000 })).toString().trim().split('\n')
    expect(delays).toHaveLength(20)
    expect(new Set(delays)).toEqual(new Set(['0.100000']))
  })

  it.each([
    ['sound.m4a', 'aac'],
    ['sound.mp3', 'mp3'],
    ['sound.wav', 'pcm_s16le'],
  ])('writes %s as sound alone', async (name, codec) => {
    const probed = await probeExport(await exported(name))
    expect(probed.video).toEqual({})
    expect(probed.audio).toMatchObject({ codec_name: codec, channels: '2' })
    expect(Math.abs(probed.duration - 2)).toBeLessThan(0.06)
  })

  it('writes in a WAV exactly what the mixer heard: the first clip at full volume, then silence', async () => {
    const exportedSound = await decodedAudio(await exported('heard.wav'))
    expect(exportedSound.length / 2).toBe(2 * SAMPLE_RATE)
    const source = await decodedAudio(mediaPath('h264.mp4'))
    let largestDifference = 0
    for (let index = 4000; index < 2 * (SAMPLE_RATE - 1000); index++) largestDifference = Math.max(largestDifference, Math.abs((exportedSound[index] ?? 0) - (source[index] ?? 0)))
    expect(largestDifference).toBeLessThan(1 / 32_768)
    let loudestAfter = 0
    for (let index = 2 * SAMPLE_RATE; index < exportedSound.length; index++) loudestAfter = Math.max(loudestAfter, Math.abs(exportedSound[index] ?? 0))
    expect(loudestAfter).toBe(0)
  })

  it('writes the PNG of a frame at the size of the project, equal to the paused frame', async () => {
    const path = await exported('still.png', ['--at', String(STILL_FRAME)])
    expect((await probeExport(path)).video).toMatchObject({ codec_name: 'png', width: '640', height: '360', pix_fmt: 'rgb24' })
    const [paused] = await renderFrames(PROJECT, { via: 'paused', frames: [STILL_FRAME] })
    if (paused === undefined) throw new Error('No paused frame')
    expect(sameBytes(await pictureOf(path, 640, 360), paused)).toBe(true)
  })

  it('encodes an MP4 with VideoToolbox', async () => {
    const probed = await probeExport(await exported('video.mp4'))
    expect(probed.video).toMatchObject({ codec_name: 'h264', width: '426', height: '240', nb_frames: '60' })
    expect(probed.audio).toMatchObject({ codec_name: 'aac' })
  })

  it('refuses a file name whose extension is no format it writes', async () => {
    const result = await runApp(['--export', projectPath(PROJECT), '--out', join(scratch, 'video.avi')])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('--out must end in one of .mp4, .webm, .gif, .m4a, .mp3, .wav, .png')
  })
})
