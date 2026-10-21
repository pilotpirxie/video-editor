import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { serializeProject, type CameraKeyframe, type Clip, type Project } from '../../src/shared/project.js'
import { FRAME, SECOND, textClip } from '../fixtures.js'
import { ROOT, at, exportWithReport, largeProject, projectOfTracks, projectPath, scratchDirectory, selfTestReport, uiTest, videoOf } from '../helpers.js'

// Run by hand with `npm run test:extremes` on an M1 with 4 GB of memory; it is not part of `npm test`.
const scratch = scratchDirectory('extremes')
const MS_PER_SECOND = 1000
const BYTES_PER_MEGABYTE = 1024 * 1024
const EXTREME_TIMEOUT_MS = 15 * 60 * MS_PER_SECOND
const MAX_PEAK_MEMORY_MB = 1500
const MAX_TYPICAL_MEMORY_MB = 1024
const MAX_PAUSED_FRAME_MS = 500
const MIN_1080P_REAL_TIME_RATIO = 2
const MIN_4K_REAL_TIME_RATIO = 0.5
const MAX_OPEN_SECONDS = 3
const MAX_FRAME_INTERVAL_MS = 1000 / 60 + 4
const MAX_PREPARED_SEEK_MS = 150
const MAX_IDLE_CPU_PERCENT = 2
const MAX_FASTEST_EXPORT_MS = 5 * 60 * MS_PER_SECOND
const MAX_INSTALLED_MEGABYTES = 400
const INSTALLED_APP = join(ROOT, 'release', 'mac-arm64', 'Playback.app')
const FULL_HD = { width: 1920, height: 1080 }
const PLAY_SECONDS = '4.5'
const SHORT_PLAY_SECONDS = '0.8'
const FASTEST_SPEED_PERCENT = 10_000

function writtenProject(name: string, project: Project): string {
  const path = join(scratch, `${name}.json`)
  writeFileSync(path, serializeProject(project))
  return path
}

function megabytesOf(directory: string): number {
  let bytes = 0
  for (const entry of readdirSync(directory, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) bytes += statSync(join(entry.parentPath, entry.name)).size
  }
  return bytes / BYTES_PER_MEGABYTE
}

function eightKProject(): Project {
  return projectOfTracks({ width: 3840, height: 2160 }, [[videoOf('8k.mp4', 'eight-k', { start: 0, duration: 4 * FRAME }, at(1920, 1080, 0.5))]])
}

function fastestProject(): Project {
  const span = { start: 0, duration: 6 * SECOND }
  return projectOfTracks(FULL_HD, [[videoOf('timelapse-1080p.mp4', 'fastest', span, at(960, 540), { speedPercent: FASTEST_SPEED_PERCENT })]])
}

function fourLayerProject(): Project {
  const span = { start: 0, duration: 5 * SECOND }
  const quarters = [at(480, 270, 0.5), at(1440, 270, 0.5), at(480, 810, 0.5), at(1440, 810, 0.5)]
  const layers: Clip[][] = quarters.map((transform, index) => [videoOf('1080p.mp4', `layer-${index}`, span, transform)])
  const blur: Clip = { id: 'blur', type: 'blur', ...span, transform: at(960, 540), opacity: 1, width: 600, height: 300, shape: 'rectangle', softEdge: 0, strength: 24 }
  const titles = [textClip('title', 0, span.duration, { transform: at(960, 120) }), textClip('caption', 0, span.duration, { text: 'Caption', transform: at(960, 960) })]
  const camera: CameraKeyframe[] = [
    { time: SECOND, duration: SECOND, easing: 'easeInOut', x: 480, y: 270, scale: 2 },
    { time: 3 * SECOND, duration: SECOND, easing: 'easeInOut', x: 960, y: 540, scale: 1 },
  ]
  return projectOfTracks(FULL_HD, [...layers, [blur], titles], camera)
}

describe('extreme canvas sizes and sources', { timeout: EXTREME_TIMEOUT_MS }, () => {
  it.each([
    { project: '11-tiny-canvas', preset: '120p', minRealTime: MIN_1080P_REAL_TIME_RATIO },
    { project: '12-4k-canvas', preset: '4k', minRealTime: MIN_4K_REAL_TIME_RATIO },
  ])('$project plays without dropping a frame and exports at $preset within the memory and speed targets', async ({ project, preset, minRealTime }) => {
    const played = await selfTestReport(projectPath(project), ['--seconds', SHORT_PLAY_SECONDS])
    console.info(`${project}: dropped ${played.droppedFrames} frames, paused frame ${JSON.stringify(played.fullQualityMilliseconds)}`)
    expect(played.status).toBe('Ready.')
    expect(played.droppedFrames).toBe(0)
    expect(played.fullQualityMilliseconds.atActualSize).toBeLessThanOrEqual(MAX_PAUSED_FRAME_MS)

    const exported = await exportWithReport(projectPath(project), join(scratch, `${project}.mp4`), preset, 'hardware')
    expect(exported.peakMemoryMegabytes).toBeLessThanOrEqual(MAX_PEAK_MEMORY_MB)
    expect(exported.realTimeRatio).toBeGreaterThanOrEqual(minRealTime)
  })

  it('opens and plays an 8K source, and exports it at 4K within 1.5 GB', async () => {
    const path = writtenProject('eight-k', eightKProject())
    const played = await selfTestReport(path, ['--seconds', '0.1'])
    console.info(`8K source: paused frame ${JSON.stringify(played.fullQualityMilliseconds)}`)
    expect(played.status).toBe('Ready.')

    const exported = await exportWithReport(path, join(scratch, 'eight-k.mp4'), '4k', 'hardware')
    expect(exported.peakMemoryMegabytes).toBeLessThanOrEqual(MAX_PEAK_MEMORY_MB)
  })

  it('exports ten minutes of 1080p at 100× within five minutes, showing progress as it goes', async () => {
    const path = writtenProject('fastest', fastestProject())
    const exported = await exportWithReport(path, join(scratch, 'fastest.mp4'), '1080p', 'hardware')
    expect(exported.elapsedMs).toBeLessThanOrEqual(MAX_FASTEST_EXPORT_MS)
    expect(exported.progressLines.length).toBeGreaterThan(1)
    expect(exported.peakMemoryMegabytes).toBeLessThanOrEqual(MAX_PEAK_MEMORY_MB)
  })
})

describe('the heaviest projects', { timeout: EXTREME_TIMEOUT_MS }, () => {
  it('plays four 1080p layers, two titles and a blur under a zooming camera without dropping a frame, and exports them at twice real time', async () => {
    const path = writtenProject('four-layers', fourLayerProject())
    const played = await selfTestReport(path, ['--seconds', PLAY_SECONDS, '--report-memory'])
    console.info(`four layers: dropped ${played.droppedFrames} frames, peak memory ${played.peakMemoryMegabytes} MB`)
    expect(played.droppedFrames).toBe(0)
    expect(played.peakMemoryMegabytes).toBeLessThanOrEqual(MAX_TYPICAL_MEMORY_MB)

    const exported = await exportWithReport(path, join(scratch, 'four-layers.mp4'), '1080p', 'hardware')
    expect(exported.realTimeRatio).toBeGreaterThanOrEqual(MIN_1080P_REAL_TIME_RATIO)
  })

  it('opens 4,096 clips over twenty hours within 3 s, scrolls at 60 fps, seeks within 150 ms and stays within 1 GB', async () => {
    const path = writtenProject('large', largeProject())
    const report = await uiTest('budgets', ['--project', path, '--report-memory'], undefined, EXTREME_TIMEOUT_MS)
    console.info(`4,096 clips: ${JSON.stringify(report)}`)
    expect(report.openSeconds).toBeLessThanOrEqual(MAX_OPEN_SECONDS)
    expect(report.frameIntervalP95).toBeLessThanOrEqual(MAX_FRAME_INTERVAL_MS)
    expect(report.seekP95).toBeLessThanOrEqual(MAX_PREPARED_SEEK_MS)
    expect(report.peakMemoryMegabytes).toBeLessThanOrEqual(MAX_TYPICAL_MEMORY_MB)
  })
})

describe('the app at rest and on disk', () => {
  it('uses at most 2% of a core while a prepared project sits paused', async () => {
    const report = await uiTest('idle', ['--project', projectPath('01-single-clip')])
    console.info(`idle: ${JSON.stringify(report)}`)
    expect(report.cpuPercent).toBeLessThanOrEqual(MAX_IDLE_CPU_PERCENT)
  })

  it.skipIf(!existsSync(INSTALLED_APP))('takes at most 400 MB once installed', () => {
    const megabytes = megabytesOf(INSTALLED_APP)
    console.info(`installed size: ${Math.round(megabytes)} MB`)
    expect(megabytes).toBeLessThanOrEqual(MAX_INSTALLED_MEGABYTES)
  })
})
