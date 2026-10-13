import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EXPORT_PRESETS, exportSize, fitCanvas, type ExportPreset } from '../../src/shared/exportPresets.js'
import { temporaryPathFor } from '../../src/media/encoder.js'
import { bundledFfmpeg, cropPicture, probeExport, projectPath, readBarcode, runApp, scratchDirectory, type Picture } from '../helpers.js'

const ffmpeg = bundledFfmpeg()
const scratch = scratchDirectory('export')
const CANVAS = { width: 640, height: 360 }
const FRAME_COUNT = 60
const SAMPLE_RATE = 48_000

async function exportCheckProject(preset: ExportPreset): Promise<string> {
  const path = join(scratch, `${preset}.mp4`)
  const result = await runApp(['--export', projectPath('export-check'), '--out', path, '--preset', preset])
  if (result.exitCode !== 0) throw new Error(`Export failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`)
  return path
}

async function decodedFrames(path: string, preset: ExportPreset): Promise<Picture[]> {
  const size = exportSize(preset, CANVAS)
  const fit = fitCanvas(CANVAS, size)
  const frameBytes = size.width * size.height * 4
  const raw = await ffmpeg.runOnce('ffmpeg', ['-i', path, '-map', '0:v:0', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { timeoutMs: 120_000 })
  const frames: Picture[] = []
  for (let start = 0; start + frameBytes <= raw.length; start += frameBytes) {
    const data = new ArrayBuffer(frameBytes)
    new Uint8Array(data).set(raw.subarray(start, start + frameBytes))
    const whole = { ...size, data }
    frames.push(cropPicture(whole, Math.round(fit.offsetX), Math.round(fit.offsetY), Math.round(CANVAS.width * fit.scale), Math.round(CANVAS.height * fit.scale)))
  }
  return frames
}

async function decodedAudio(path: string): Promise<Float32Array> {
  const raw = await ffmpeg.runOnce('ffmpeg', ['-i', path, '-map', '0:a:0', '-f', 'f32le', '-'], { timeoutMs: 60_000 })
  const samples = new Float32Array(raw.length / 4)
  for (let index = 0; index < samples.length; index++) samples[index] = raw.readFloatLE(index * 4)
  return samples
}

function loudness(samples: Float32Array, firstFrame: number, endFrame: number): number {
  let sumOfSquares = 0
  for (let frame = firstFrame; frame < endFrame; frame++) sumOfSquares += (samples[frame * 2] ?? 0) ** 2
  return Math.sqrt(sumOfSquares / (endFrame - firstFrame))
}

describe('MP4 export', () => {
  it.each(EXPORT_PRESETS)('writes H.264/AAC at the %s preset', async (preset) => {
    const path = await exportCheckProject(preset)
    const probed = await probeExport(path)
    const size = exportSize(preset, CANVAS)
    expect(probed.video).toMatchObject({
      codec_name: 'h264',
      profile: 'High',
      pix_fmt: 'yuv420p',
      width: String(size.width),
      height: String(size.height),
      r_frame_rate: '30/1',
      nb_frames: String(FRAME_COUNT),
      color_space: 'bt709',
      color_primaries: 'bt709',
      color_transfer: 'bt709',
      color_range: 'tv',
    })
    expect(probed.audio).toMatchObject({ codec_name: 'aac', sample_rate: '48000', channels: '2' })
    expect(Math.abs(probed.duration - 2)).toBeLessThan(0.05)
    expect(existsSync(temporaryPathFor(path))).toBe(false)
  })

  it.each<ExportPreset>(['480p', '120p', 'vertical-1080x1920', 'square-1080'])('shows the right frame at every position (%s)', async (preset) => {
    const frames = await decodedFrames(join(scratch, `${preset}.mp4`), preset)
    expect(frames).toHaveLength(FRAME_COUNT)
    for (const [index, frame] of frames.entries()) {
      const expected = index < 30 ? index : 100 + (index - 30)
      expect(readBarcode(frame), `frame ${index}`).toBe(expected)
    }
  })

  it('keeps the sound in step with the picture', async () => {
    const samples = await decodedAudio(join(scratch, '480p.mp4'))
    expect(Math.abs(samples.length / 2 - 2 * SAMPLE_RATE)).toBeLessThan(2048)
    expect(loudness(samples, 1000, 47_000)).toBeGreaterThan(0.3)
    expect(loudness(samples, 50_000, 95_000)).toBeLessThan(0.005)
    let crossing = -1
    for (let frame = 30_000; frame < 36_000; frame++) {
      if ((samples[frame * 2] ?? 0) < 0 && (samples[(frame + 1) * 2] ?? 0) >= 0) crossing = frame + 1
    }
    expect(Math.abs(crossing - 32_768)).toBeLessThanOrEqual(40)
  })

  it('fails with a plain message, and writes nothing, for a broken project', async () => {
    const path = join(scratch, 'never.mp4')
    const result = await runApp(['--export', join(scratch, 'missing.json'), '--out', path])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toMatch(/"missing\.json" could not be opened/)
    expect(existsSync(path)).toBe(false)
  })

  it('rejects an unknown preset before starting', async () => {
    const result = await runApp(['--export', projectPath('export-check'), '--out', join(scratch, 'x.mp4'), '--preset', '8k'])
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toMatch(/--preset must be one of 120p, 240p/)
  })
})
