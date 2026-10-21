import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { EXPORT_PRESETS, exportSize, fitCanvas, type ExportPreset } from '../../src/shared/exportPresets.js'
import { temporaryPathFor } from '../../src/shared/exportPresets.js'
import { serializeProject, type Project } from '../../src/shared/project.js'
import { ELECTRON_BINARY, ROOT, bundledFfmpeg, cropPicture, decodedAudio, probeExport, projectPath, readBarcode, runApp, scratchDirectory, type Picture } from '../helpers.js'
import { CLICK_SAMPLE_44K, mediaPath } from '../media/generate.js'

const ffmpeg = bundledFfmpeg()
const scratch = scratchDirectory('export')
const CANVAS = { width: 640, height: 360 }
const FRAME_COUNT = 60
const SAMPLE_RATE = 48_000
const SECOND = 24_000_000
const SAMPLES_PER_VIDEO_FRAME = SAMPLE_RATE / 30
const CLICK_SECONDS = CLICK_SAMPLE_44K / 44_100
const STOP_TIMEOUT_MS = 30_000

const CLICK_AT_TWO_SPEEDS: Project = {
  version: 1,
  canvas: { width: 160, height: 120, frameRate: { num: 30, den: 1 } },
  media: [{ id: 'click', path: mediaPath('audio-44k-click.wav'), relativePath: '' }],
  tracks: [
    {
      id: 'sound',
      name: 'sound',
      hidden: false,
      locked: false,
      muted: false,
      clips: [
        { id: 'fast', type: 'audio', mediaId: 'click', start: 0, duration: SECOND / 2, sourceStart: 0, speedPercent: 200, changesPitch: true, volume: 1 },
        { id: 'slow', type: 'audio', mediaId: 'click', start: 2 * SECOND, duration: 2 * SECOND, sourceStart: 0, speedPercent: 50, volume: 1 },
      ],
    },
  ],
}

async function exported(project: string, name: string, preset: ExportPreset): Promise<string> {
  const path = join(scratch, `${name}.mp4`)
  const result = await runApp(['--export', project, '--out', path, '--preset', preset])
  if (result.exitCode !== 0) throw new Error(`Export failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`)
  return path
}

function exportCheckProject(preset: ExportPreset): Promise<string> {
  return exported(projectPath('export-check'), preset, preset)
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

function loudness(samples: Float32Array, firstFrame: number, endFrame: number): number {
  let sumOfSquares = 0
  for (let frame = firstFrame; frame < endFrame; frame++) sumOfSquares += (samples[frame * 2] ?? 0) ** 2
  return Math.sqrt(sumOfSquares / (endFrame - firstFrame))
}

function loudestSample(samples: Float32Array, fromSecond: number, toSecond: number): number {
  let loudest = fromSecond * SAMPLE_RATE
  for (let frame = loudest; frame < toSecond * SAMPLE_RATE; frame++) {
    if (Math.abs(samples[frame * 2] ?? 0) > Math.abs(samples[loudest * 2] ?? 0)) loudest = frame
  }
  return loudest
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

  it('puts the sound of faster and slower clips where it is heard, within one frame', async () => {
    const projectFile = join(scratch, 'click-at-two-speeds.json')
    writeFileSync(projectFile, serializeProject(CLICK_AT_TWO_SPEEDS))
    const samples = await decodedAudio(await exported(projectFile, 'click-at-two-speeds', '120p'))
    expect(Math.abs(samples.length / 2 - 4 * SAMPLE_RATE)).toBeLessThan(2048)

    const fastClick = loudestSample(samples, 0, 2)
    const slowClick = loudestSample(samples, 2, 4)
    expect(Math.abs(fastClick - (CLICK_SECONDS / 2) * SAMPLE_RATE)).toBeLessThanOrEqual(SAMPLES_PER_VIDEO_FRAME)
    expect(Math.abs(slowClick - (2 + CLICK_SECONDS * 2) * SAMPLE_RATE)).toBeLessThanOrEqual(SAMPLES_PER_VIDEO_FRAME)
    expect(loudness(samples, SAMPLE_RATE / 2 + SAMPLES_PER_VIDEO_FRAME, 2 * SAMPLE_RATE)).toBeLessThan(0.005)
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

  it('stops with an error when nobody reads its output any more', async () => {
    const profile = mkdtempSync(join(scratch, 'profile-'))
    const args = [ROOT, `--user-data-dir=${profile}`, '--export', projectPath('22-timelapse'), '--out', join(scratch, 'unread.mp4'), '--preset', '240p']
    const child = spawn(ELECTRON_BINARY, args)
    onTestFinished(() => {
      child.kill('SIGKILL')
    })
    let stderr = ''
    child.stderr.on('data', (text: Buffer) => (stderr += text.toString()))
    child.stdout.on('data', (text: Buffer) => {
      if (text.toString().includes('progress ')) child.stdout.destroy()
    })
    const exitCode = await new Promise<number | null>((resolve) => child.on('close', resolve))
    expect(exitCode).toBe(1)
    expect(stderr).toMatch(/The output of a command-line run closed/)
  }, STOP_TIMEOUT_MS)
})
