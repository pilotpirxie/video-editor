import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { serializeProject, type Clip, type Project, type Track } from '../../src/shared/project.js'
import { ROOT, projectIn, projectPath, runApp, scratchDirectory, uiTest } from '../helpers.js'

const SECOND = 24_000_000
const FRAME = SECOND / 30
const MEDIA_DIRECTORY = join(ROOT, 'test', 'media', 'generated')
const MAX_POSTER_MS = 1000
const POINTER_TOLERANCE = 1.5

const scratch = scratchDirectory('editor')

describe('window layout', () => {
  it('resizes and collapses panels, and remembers the layout for the next launch', async () => {
    const report = await uiTest('layout', [], scratch)
    expect(report.before).toEqual({ left: 300, right: 300, timeline: 280 })
    expect(report.after).toEqual({ left: 360, right: 0, timeline: 320 })

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

// One line per track, bottom first: "video 0+2" is a video clip starting at 0 s and lasting 2 s.
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
    expect(outline(placed)).toEqual(['video 0+2, image 3+5', 'audio 0.5+2'])
    expect(placed.tracks.map((track) => track.name)).toEqual(['Track 1', 'Track 2'])

    expect(outline(projectIn(report, 'movedAndTrimmed'))).toEqual(['video 0+2, image 2+3', 'audio 0.5+2'])

    const split = projectIn(report, 'split')
    expect(outline(split)).toEqual(['video 0+1, video 1+1, image 2+3', 'audio 0.5+2'])
    expect(split.tracks[0]?.clips[1]).toMatchObject({ sourceStart: SECOND })

    expect(report.redoLabel).toBe('Redo Split Clip')
    expect(outline(projectIn(report, 'afterUndo'))).toEqual(['video 0+2, image 2+3', 'audio 0.5+2'])
    expect(outline(projectIn(report, 'pasted'))).toEqual(['video 0+1, video 1+1, image 2+3', 'video 1+1', 'audio 0.5+2'])

    const final = projectIn(report, 'final')
    expect(outline(final)).toEqual(['video 0+1, image 1+3', '', 'audio 0.5+2'])
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

    // Released three pixels short of the canvas centre line, the clip snapped onto it.
    expect(report.xAfterMove).toBe('320.0')
    expect(projectIn(report, 'moved').tracks[0]?.clips[0]).toMatchObject({ transform: { x: 320, y: 90, scaleX: 1, scaleY: 1, rotation: 0 } })

    // The corner handle keeps the aspect ratio and the opposite corner: 320x180 at (160,0) became 480x270.
    const scaled = projectIn(report, 'scaled').tracks[0]?.clips[0]
    expect(scaled).toMatchObject({ type: 'video' })
    if (scaled?.type !== 'video') return
    expect(scaled.transform.scaleX).toBeCloseTo(1.5, 2)
    expect(scaled.transform.scaleY).toBeCloseTo(scaled.transform.scaleX, 6)
    expect(Math.abs(scaled.transform.x - 400)).toBeLessThan(POINTER_TOLERANCE)
    expect(Math.abs(scaled.transform.y - 135)).toBeLessThan(POINTER_TOLERANCE)

    // Cropping 120 canvas pixels off the right hides 80 source pixels and leaves the left edge where it was.
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

    // Dropped on the canvas, media lands at the playhead on a new top track; the scenario then selects three clips with a marquee.
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
})

// 4,096 clips on four tracks, spread over just under twenty hours.
function largeProject(): Project {
  const clipsPerTrack = 1024
  const spacing = 2109 * FRAME
  const tracks: Track[] = []
  for (let trackIndex = 0; trackIndex < 4; trackIndex++) {
    const clips: Clip[] = []
    for (let index = 0; index < clipsPerTrack; index++) {
      clips.push({
        id: `clip-${trackIndex}-${index}`,
        type: 'video',
        mediaId: 'video',
        start: index * spacing,
        duration: 2100 * FRAME,
        sourceStart: 0,
        speedPercent: 100,
        transform: { x: 160 + 320 * (trackIndex % 2), y: 90 + 180 * Math.floor(trackIndex / 2), scaleX: 1, scaleY: 1, rotation: 0 },
        opacity: 1,
        volume: 1,
      })
    }
    tracks.push({ id: `track-${trackIndex}`, name: `Track ${trackIndex + 1}`, hidden: false, locked: false, muted: false, clips })
  }
  return {
    version: 1,
    canvas: { width: 640, height: 360, frameRate: { num: 30, den: 1 } },
    media: [{ id: 'video', path: join(MEDIA_DIRECTORY, 'h264.mp4'), relativePath: '' }],
    tracks,
  }
}

describe('responsiveness with 4,096 clips on a 20-hour timeline', () => {
  const MAX_OPEN_SECONDS = 3
  const MAX_FRAME_INTERVAL_MS = 1000 / 60 + 4
  const MAX_DRAG_TO_FRAME_MS = 33
  const MAX_UNDO_MS = 50

  it('opens within 3 s, scrolls and zooms at 60 fps, follows a drag within 33 ms and undoes within 50 ms', async () => {
    const path = join(scratch, 'large.json')
    writeFileSync(path, serializeProject(largeProject()))
    const report = await uiTest('budgets', ['--project', path])
    console.info(`4,096 clips: ${JSON.stringify(report)}`)

    expect(report.openSeconds).toBeLessThanOrEqual(MAX_OPEN_SECONDS)
    expect(report.frameCount).toBeGreaterThan(60)
    expect(report.frameIntervalP95).toBeLessThanOrEqual(MAX_FRAME_INTERVAL_MS)
    expect(report.dragSamples).toBeGreaterThan(8)
    expect(report.dragToFrameP95).toBeLessThanOrEqual(MAX_DRAG_TO_FRAME_MS)
    expect(report.undoMilliseconds).toBeLessThanOrEqual(MAX_UNDO_MS)
  })
})
