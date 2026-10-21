import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { serializeProject, type Clip, type Project, type Track } from '../../src/shared/project.js'
import { MEDIA_DIRECTORY, largeProject, projectIn, projectPath, runApp, scratchDirectory, uiTest } from '../helpers.js'

const SECOND = 24_000_000
const MAX_POSTER_MS = 1000
const POINTER_TOLERANCE = 1.5
const MAX_RETURN_SECONDS = 3
const MAX_UNDO_MS = 50
const MAX_TASK_MS = 50

const scratch = scratchDirectory('editor')

describe('window layout', () => {
  it('resizes and collapses panels, and remembers the layout for the next launch', async () => {
    const report = await uiTest('layout', [], scratch)
    expect(report.before).toEqual({ left: 300, right: 300, timeline: 291 })
    expect(report.after).toEqual({ left: 360, right: 0, timeline: 331 })

    const nextLaunch = await uiTest('layout-kept', [], scratch)
    expect(nextLaunch.after).toEqual(report.after)
  })
})

describe('commands', () => {
  it('names the action in the Edit menu and undoes and redoes it', async () => {
    const report = await uiTest('commands')
    expect(report).toEqual({
      widthAtStart: '1920',
      undoLabel: 'Undo Change Canvas Size',
      redoLabel: 'Redo Change Canvas Size',
      undoLabelAfterUndo: 'Undo',
      widthAfterRedo: '1280',
    })
  })
})

function outline(project: Project): string[] {
  return project.tracks.map((track) => track.clips.map((clip) => `${clip.type} ${clip.start / SECOND}+${clip.duration / SECOND}`).join(', '))
}

describe('editing', () => {
  const output = join(scratch, 'edit')

  it('imports, places, moves, trims, splits, undoes, pastes, deletes and saves', async () => {
    const report = await uiTest('edit', ['--media', MEDIA_DIRECTORY, '--out', output])

    expect(report.posterMilliseconds).toBeLessThanOrEqual(MAX_POSTER_MS)
    expect(report.importNotice).toBe('"broken-garbage.mp4" could not be read: it is damaged or not a supported media file.')
    expect(report.hasBrokenItem).toBe(false)

    const placed = projectIn(report, 'placed')
    expect(placed.canvas).toEqual({ width: 320, height: 180, frameRate: { num: 30, den: 1 } })
    expect(placed.media.map((reference) => reference.path)).toEqual(['h264.mp4', 'audio.wav', 'image.jpg'].map((name) => join(MEDIA_DIRECTORY, name)))
    expect(outline(placed)).toEqual(['video 0+2, image 3+5', 'audio 0.5+2', '', '', '', ''])
    expect(placed.tracks.map((track) => track.name)).toEqual(['Track 1', 'Track 2', 'Track 3', 'Track 4', 'Track 5', 'Track 6'])

    expect(outline(projectIn(report, 'movedAndTrimmed'))).toEqual(['video 0+2, image 2+3', 'audio 0.5+2', '', '', '', ''])

    const split = projectIn(report, 'split')
    expect(outline(split)).toEqual(['video 0+1, video 1+1, image 2+3', 'audio 0.5+2', '', '', '', ''])
    expect(split.tracks[0]?.clips[1]).toMatchObject({ sourceStart: SECOND })

    expect(report.redoLabel).toBe('Redo Split Clip')
    expect(outline(projectIn(report, 'afterUndo'))).toEqual(['video 0+2, image 2+3', 'audio 0.5+2', '', '', '', ''])
    expect(outline(projectIn(report, 'pasted'))).toEqual(['video 0+1, video 1+1, image 2+3', 'video 1+1', 'audio 0.5+2', '', '', '', ''])

    const final = projectIn(report, 'final')
    expect(outline(final)).toEqual(['video 0+1, image 1+3', '', 'audio 0.5+2', '', '', '', ''])
    expect(final.tracks[0]?.clips[0]).toMatchObject({ sourceStart: SECOND })
  })

  it('reopens a saved project identically', async () => {
    const saved = join(output, 'final.json')
    const report = await uiTest('open-and-save', ['--project', saved, '--out', output])
    expect(report.title).toBe('reopened.json')
    expect(readFileSync(join(output, 'reopened.json'), 'utf8')).toBe(readFileSync(saved, 'utf8'))
  })
})

describe('canvas', () => {
  it('selects the topmost clip and moves, scales, crops and rotates it with the handles', async () => {
    const report = await uiTest('canvas', ['--project', projectPath('02-mosaic'), '--out', join(scratch, 'canvas')])
    expect(report.selectedX).toBe('160.0')

    expect(report.xAfterMove).toBe('320.0')
    expect(projectIn(report, 'moved').tracks[0]?.clips[0]).toMatchObject({ transform: { x: 320, y: 90, scaleX: 1, scaleY: 1, rotation: 0 } })

    const scaled = projectIn(report, 'scaled').tracks[0]?.clips[0]
    expect(scaled).toMatchObject({ type: 'video' })
    if (scaled?.type !== 'video') return
    expect(scaled.transform.scaleX).toBeCloseTo(1.5, 2)
    expect(scaled.transform.scaleY).toBeCloseTo(scaled.transform.scaleX, 6)
    expect(Math.abs(scaled.transform.x - 400)).toBeLessThan(POINTER_TOLERANCE)
    expect(Math.abs(scaled.transform.y - 135)).toBeLessThan(POINTER_TOLERANCE)

    const cropped = projectIn(report, 'cropped').tracks[0]?.clips[0]
    if (cropped?.type !== 'video' || cropped.crop === undefined) throw new Error('The clip was not cropped')
    expect(Math.abs(cropped.crop.right - 80)).toBeLessThan(POINTER_TOLERANCE)
    expect(cropped.crop).toMatchObject({ left: 0, top: 0, bottom: 0 })
    const leftEdge = cropped.transform.x - ((320 - cropped.crop.right) * cropped.transform.scaleX) / 2
    expect(Math.abs(leftEdge - 160)).toBeLessThan(POINTER_TOLERANCE)

    expect(projectIn(report, 'final').tracks[0]?.clips[0]).toMatchObject({ transform: { rotation: 45 }, opacity: 0.5, fadeIn: SECOND / 2 })

    expect(report.sharedOpacity).toBe('Mixed')
    const both = projectIn(report, 'both')
    expect(both.tracks[0]?.clips[0]).toMatchObject({ opacity: 0.25 })
    expect(both.tracks[3]?.clips[0]).toMatchObject({ opacity: 0.25 })
    expect(both.tracks[1]?.clips[0]).toMatchObject({ opacity: 1 })

    const dropped = projectIn(report, 'dropped')
    expect(dropped.tracks).toHaveLength(5)
    expect(dropped.tracks[4]).toMatchObject({ name: 'Track 5', clips: [{ type: 'video', start: 0, transform: { x: 320, y: 180, scaleX: 1, scaleY: 1 } }] })
  })
})

describe('tracks', () => {
  it('adds, renames, locks, hides, mutes, reorders and deletes tracks', async () => {
    const report = await uiTest('tracks', ['--project', projectPath('02-mosaic'), '--out', join(scratch, 'tracks')])
    expect(report.addedName).toBe('Track 5')
    expect(report.selectedOnLockedTrack).toBe('0')

    const flags = (track: Track): string => `${track.name}${track.locked ? ' locked' : ''}${track.hidden ? ' hidden' : ''}${track.muted ? ' muted' : ''}`
    expect(projectIn(report, 'reordered').tracks.map(flags)).toEqual(['top-left locked', 'top-right hidden', 'Titles', 'bottom-left muted', 'bottom-right'])
    expect(projectIn(report, 'final').tracks.map(flags)).toEqual(['top-left locked', 'top-right hidden', 'bottom-left muted', 'bottom-right'])
  })
})

describe('documents', () => {
  it('opens each project in a window of its own and asks about unsaved changes when one closes', async () => {
    const report = await uiTest('documents', ['--out', join(scratch, 'documents')])
    expect(report.start).toEqual({ title: 'Untitled', isEdited: false })
    expect(report.afterNew).toEqual({
      windows: 2,
      first: { title: 'Untitled', isEdited: true, width: '1280' },
      other: { title: 'Untitled', isEdited: false, width: '1920' },
    })
    expect(report.afterSaveAs).toEqual({ title: 'second.json', isEdited: false })
    expect(report.afterOpenInPlace).toEqual({ windows: 2, other: { title: 'first.json', isEdited: false, width: '1280' } })
    expect(report.afterOpenOfOpen).toEqual({ windows: 2, other: { title: 'first.json', isEdited: false } })
    expect(report.afterCancelledClose).toEqual({ isOpen: true, width: '700' })
    expect(projectIn(report, 'secondAfterDiscard').canvas.width).toBe(1000)
    expect(report.afterOpenInNew).toEqual({ windows: 2, third: { title: 'second.json', isEdited: false, width: '1000' } })
    expect(projectIn(report, 'secondAfterSave').canvas.width).toBe(640)
    expect(report.recoveryFiles).toEqual([])
  })

  it('restores the unsaved work of every window after the editor was killed', async () => {
    const profile = join(scratch, 'recovery-profile')
    mkdirSync(profile, { recursive: true })
    const crashed = await runApp(['--uitest', 'crash'], 120_000, profile)
    expect(crashed.exitCode).not.toBe(0)

    const report = await uiTest('restore', ['--out', join(scratch, 'restored')], profile)
    expect(report).toMatchObject({ title: 'Untitled', isEdited: true, windows: 2, widths: ['1280', '800'] })
    expect(projectIn(report, 'saved').canvas.width).toBe(Number(report.width))
  })

  it('brings the window back with its work within 3 s when its page dies, keeps it as it is when the GPU process dies, and logs both', async () => {
    const report = await uiTest('page-crash')
    expect(report.afterPageCrash).toBeLessThanOrEqual(MAX_RETURN_SECONDS)
    expect(report.afterGpuCrash).toBeLessThanOrEqual(MAX_RETURN_SECONDS)
    expect(report).toMatchObject({ reloadsAfterGpuCrash: 0, widthAfterGpuCrash: '1000', undoLabelAfterGpuCrash: 'Undo Change Canvas Size' })
    expect(report.crashLog).toEqual([expect.objectContaining({ process: 'renderer' }), expect.objectContaining({ process: 'GPU' })])
  })

  it('keeps the window, its work and its undo when the media process dies, decodes with the new one within 3 s, and logs it', async () => {
    const report = await uiTest('media-crash', ['--project', projectPath('01-single-clip'), '--out', join(scratch, 'media-crash')])
    expect(report.secondsToRestart).toBeLessThanOrEqual(MAX_RETURN_SECONDS)
    expect(report).toMatchObject({ reloads: 0, width: '1280', undoLabel: 'Undo Change Canvas Size', undoLabelAfter: 'Undo Change Canvas Size' })
    expect(projectIn(report, 'saved').canvas.width).toBe(1280)
    expect(report.crashLog).toEqual([expect.objectContaining({ process: 'media' })])
  })
})

function numbersOf(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((entry): entry is number => typeof entry === 'number') : []
}

describe('responsiveness with 4,096 clips on a 20-hour timeline', () => {
  const MAX_OPEN_SECONDS = 3
  const MAX_FRAME_INTERVAL_MS = 1000 / 60 + 4
  const MAX_DRAG_TO_FRAME_MS = 33
  const MAX_PREPARED_SEEK_MS = 150
  const MAX_TYPICAL_MEMORY_MB = 1024

  it('opens within 3 s, scrolls and zooms at 60 fps, follows a drag within 33 ms, undoes and redoes within 50 ms, seeks within 150 ms, never blocks for more than 50 ms and stays within 1 GB', async () => {
    const path = join(scratch, 'large.json')
    writeFileSync(path, serializeProject(largeProject()))
    const report = await uiTest('budgets', ['--project', path, '--report-memory'])
    console.info(`4,096 clips: ${JSON.stringify(report)}`)

    expect(report.openSeconds).toBeLessThanOrEqual(MAX_OPEN_SECONDS)
    expect(report.frameCount).toBeGreaterThan(60)
    expect(report.frameIntervalP95).toBeLessThanOrEqual(MAX_FRAME_INTERVAL_MS)
    expect(report.dragSamples).toBeGreaterThan(8)
    expect(report.dragToFrameP95).toBeLessThanOrEqual(MAX_DRAG_TO_FRAME_MS)
    expect(report.undoMilliseconds).toBeLessThanOrEqual(MAX_UNDO_MS)
    expect(report.redoMilliseconds).toBeLessThanOrEqual(MAX_UNDO_MS)
    expect(report.seekP95).toBeLessThanOrEqual(MAX_PREPARED_SEEK_MS)
    expect(Math.max(0, ...numbersOf(report.longTasks))).toBeLessThanOrEqual(MAX_TASK_MS)
    expect(report.peakMemoryMegabytes).toBeLessThanOrEqual(MAX_TYPICAL_MEMORY_MB)
  })
})

function longRecordingProject(): Project {
  const placed = { sourceStart: 0, speedPercent: 100, transform: { x: 960, y: 540, scaleX: 1, scaleY: 1, rotation: 0 }, opacity: 1, volume: 1 }
  const clips: Clip[] = [
    { id: 'short', type: 'video', mediaId: 'short', start: 0, duration: 5 * SECOND, ...placed },
    { id: 'long', type: 'video', mediaId: 'long', start: 10 * SECOND, duration: 600 * SECOND, ...placed },
  ]
  return {
    version: 1,
    canvas: { width: 1920, height: 1080, frameRate: { num: 30, den: 1 } },
    media: [
      { id: 'short', path: join(MEDIA_DIRECTORY, '1080p.mp4'), relativePath: '' },
      { id: 'long', path: join(MEDIA_DIRECTORY, 'timelapse-1080p.mp4'), relativePath: '' },
    ],
    tracks: [{ id: 'track-0', name: 'Track 1', hidden: false, locked: false, muted: false, clips }],
  }
}

describe('responsiveness on a profile without a cache', () => {
  const MAX_LAUNCH_SECONDS = 3
  const MAX_UNCACHED_SEEK_MS = 150
  const MAX_CACHED_SEEK_MS = 50
  const MAX_SPACE_TO_MOTION_MS = 100
  const MAX_DRAG_TO_FRAME_END_MS = 1000 / 60 + 4

  it('meets the responsiveness budgets for launch, scrubbing, Space, timeline drags, undo, redo and blocking tasks', async () => {
    const path = join(scratch, 'long-recording.json')
    writeFileSync(path, serializeProject(longRecordingProject()))
    const report = await uiTest('responsiveness', ['--project', path])
    console.info(`responsiveness: ${JSON.stringify(report)}`)

    expect(report.launchSeconds).toBeLessThanOrEqual(MAX_LAUNCH_SECONDS)
    expect(report.uncachedSeekP95).toBeLessThanOrEqual(MAX_UNCACHED_SEEK_MS)
    expect(report.cachedSeekP95).toBeLessThanOrEqual(MAX_CACHED_SEEK_MS)
    expect(report.spaceToMotionP95).toBeLessThanOrEqual(MAX_SPACE_TO_MOTION_MS)
    expect(report.timelineDragSamples).toBeGreaterThan(20)
    expect(report.timelineDragP95).toBeLessThanOrEqual(MAX_DRAG_TO_FRAME_END_MS)
    expect(report.undoMilliseconds).toBeLessThanOrEqual(MAX_UNDO_MS)
    expect(report.redoMilliseconds).toBeLessThanOrEqual(MAX_UNDO_MS)
    expect(report.longestTaskMs).toBeLessThanOrEqual(MAX_TASK_MS)
  })
})
