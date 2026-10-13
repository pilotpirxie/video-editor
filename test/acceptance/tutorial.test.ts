import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { ROOT, bundledFfmpeg, probeExport, projectIn, scratchDirectory, uiTest } from '../helpers.js'

// T-47: a ten-minute tutorial is built and exported through the real window. The run with a new user on the 4 GB reference Mac is done by hand; this is the part a machine can repeat.
const MEDIA_DIRECTORY = join(ROOT, 'test', 'media', 'generated', 'acceptance')
const SECOND = 24_000_000
const TUTORIAL_SECONDS = 600
const FRAME_SECONDS = 1 / 30
const GENERATE_TIMEOUT_MS = 15 * 60 * 1000
const RUN_TIMEOUT_MS = 40 * 60 * 1000
const MAX_PEAK_MEGABYTES = 1500

const ffmpeg = bundledFfmpeg()
const scratch = scratchDirectory('acceptance')

// The sources a tutorial is made of. They take a while to make, so they are made once and kept.
const SOURCES: readonly { name: string; args: readonly string[] }[] = [
  // Like a screen recording: a picture that mostly stands still, with a counter that changes every frame.
  {
    name: 'screen.mp4',
    args: ['-f', 'lavfi', '-i', `testsrc=size=1920x1080:rate=30:duration=${TUTORIAL_SECONDS}`, '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', '60'],
  },
  { name: 'voice.m4a', args: ['-f', 'lavfi', '-i', `sine=frequency=180:sample_rate=48000:duration=${TUTORIAL_SECONDS}`, '-c:a', 'aac', '-b:a', '96k'] },
  { name: 'music.mp3', args: ['-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=44100:duration=${TUTORIAL_SECONDS}`, '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '128k'] },
  { name: 'logo.png', args: ['-f', 'lavfi', '-i', 'color=c=0x3dba74:size=800x400', '-frames:v', '1'] },
]

beforeAll(async () => {
  mkdirSync(MEDIA_DIRECTORY, { recursive: true })
  for (const source of SOURCES) {
    const path = join(MEDIA_DIRECTORY, source.name)
    if (!existsSync(path)) await ffmpeg.runOnce('ffmpeg', [...source.args, '-y', path], { timeoutMs: GENERATE_TIMEOUT_MS })
  }
}, GENERATE_TIMEOUT_MS)

describe('a ten-minute tutorial', () => {
  it(
    'is built from a recording, a voice, music, a title and a logo, and exported at 1080p without a crash',
    async () => {
      const report = await uiTest('tutorial', ['--media', MEDIA_DIRECTORY, '--out', join(scratch, 'tutorial'), '--report-memory'], undefined, RUN_TIMEOUT_MS)
      expect(report.noticeBeforeExport).toBe('')
      expect(report.presetOffered).toBe('1080p')
      expect(report.cutSeconds).toBe(10)

      const project = projectIn(report, 'project')
      expect(project.canvas).toEqual({ width: 1920, height: 1080, frameRate: { num: 30, den: 1 } })
      const kinds = project.tracks.map((track) => track.clips.map((clip) => clip.type).join('+'))
      expect(kinds).toEqual(['video+video', 'audio', 'audio', 'text', 'image'])
      expect(project.tracks[2]?.clips[0]).toMatchObject({ volume: 0.3, volumeFadeOut: 3 * SECOND })
      expect(project.tracks[3]?.clips[0]).toMatchObject({ text: 'How to export a video', fadeOut: SECOND })

      const exported = await probeExport(String(report.exported))
      expect(exported.video).toMatchObject({ codec_name: 'h264', width: '1920', height: '1080', r_frame_rate: '30/1' })
      expect(exported.audio).toMatchObject({ codec_name: 'aac' })
      expect(Math.abs(exported.duration - TUTORIAL_SECONDS)).toBeLessThanOrEqual(FRAME_SECONDS)

      // The export speed is reported, not judged: making exports fast is a ticket of its own (T-63), and this run exports while the editor is still preparing the recording.
      const exportSpeed = TUTORIAL_SECONDS / Number(report.exportSeconds)
      // Written straight to the output: the test runner shows what a test logs only when it fails.
      process.stdout.write(`Exported ten minutes in ${Math.round(Number(report.exportSeconds))} s (${exportSpeed.toFixed(1)}x real time); peak memory ${String(report.peakMemoryMegabytes)} MB\n`)
      expect(report.peakMemoryMegabytes).toBeLessThanOrEqual(MAX_PEAK_MEGABYTES)
    },
    RUN_TIMEOUT_MS,
  )
})
