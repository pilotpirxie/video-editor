import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { serializeProject, type Project } from '../../src/shared/project.js'
import { ROOT, probeExport, projectIn, projectPath, scratchDirectory, uiTest } from '../helpers.js'

const SECOND = 24_000_000
const MAX_STEP_MS = 50
const MAX_CANVAS_FOLLOW_MS = 33
const MEDIA_DIRECTORY = join(ROOT, 'test', 'media', 'generated')

const scratch = scratchDirectory('features')
const FRAMES_PER_SECOND = 30

// "00:00:01:15" as a number of frames, for a 30 fps project.
function framesOf(timecode: unknown): number {
  const [hours = 0, minutes = 0, seconds = 0, frames = 0] = String(timecode).split(':').map(Number)
  return ((hours * 60 + minutes) * 60 + seconds) * FRAMES_PER_SECOND + frames
}

describe('transport', () => {
  it('steps, jumps and shuttles with the Camtasia keys', async () => {
    const report = await uiTest('transport', ['--project', projectPath('01-single-clip')])
    expect(report.duration).toBe('/ 00:00:02:00')
    expect(report.stepMilliseconds).toBeLessThanOrEqual(MAX_STEP_MS)

    // L played on from frame 15; J then ran backwards and stopped by itself at the start.
    expect(framesOf(report.timecodeAfterForward)).toBeGreaterThan(15)
    expect(framesOf(report.timecodeWhileReversing)).toBeLessThan(framesOf(report.timecodeAfterForward))
    expect(report.timecodeAtStart).toBe('00:00:00:00')
  })
})

describe('linked clips and fades', () => {
  it('fades picture and sound with the corner handles, one undo step each, and separates the sound', async () => {
    const report = await uiTest('blocks', ['--project', projectPath('01-single-clip'), '--out', join(scratch, 'blocks')])
    expect(report.cursorOverHandle).toBe('grab')
    expect(report.dragToFrameP95).toBeLessThanOrEqual(MAX_CANVAS_FOLLOW_MS)

    // The top-left handle was dragged to half a second, the bottom-right one back to one second before the end.
    expect(projectIn(report, 'faded').tracks[0]?.clips[0]).toMatchObject({ fadeIn: SECOND / 2, volumeFadeOut: SECOND })
    const afterUndo = projectIn(report, 'afterUndo').tracks[0]?.clips[0]
    expect(afterUndo).toMatchObject({ fadeIn: SECOND / 2 })
    expect(afterUndo).not.toHaveProperty('volumeFadeOut')

    const separated = projectIn(report, 'separated')
    expect(separated.tracks.map((track) => track.name)).toEqual(['video', 'Track 2'])
    const picture = separated.tracks[0]?.clips[0]
    expect(picture).toMatchObject({ type: 'video', isAudioSeparated: true, fadeIn: SECOND / 2 })
    expect(picture).not.toHaveProperty('volumeFadeOut')
    expect(separated.tracks[1]?.clips[0]).toMatchObject({ type: 'audio', mediaId: 'clip', start: 0, duration: 2 * SECOND, volumeFadeOut: SECOND })
    expect(report.canSeparateAgain).toBe(false)
  })
})

describe('text clips', () => {
  it('adds a title, types it on the canvas and styles it in the properties panel', async () => {
    const report = await uiTest('text', ['--out', join(scratch, 'text')])
    expect(report.typingToFrameP95).toBeLessThanOrEqual(MAX_CANVAS_FOLLOW_MS)

    const typed = projectIn(report, 'typed')
    expect(typed.tracks).toHaveLength(1)
    expect(typed.tracks[0]?.clips[0]).toMatchObject({
      type: 'text',
      text: 'Hello',
      start: 0,
      duration: 5 * SECOND,
      font: { family: 'Helvetica Neue', size: 90 },
      color: '#ffffff',
      align: 'center',
      transform: { x: 960, y: 540, scaleX: 1, scaleY: 1, rotation: 0 },
    })

    // Every Mac has far more than twenty font families; the picker lists them all.
    expect(report.fontCount).toBeGreaterThan(20)
    // Each font pointed at was on the canvas within the budget of a drag. Escape put the old one back, with the focus and without an undo step.
    expect(report.fontHoverSamples).toBe(5)
    expect(report.fontHoverToFrameP95).toBeLessThanOrEqual(MAX_CANVAS_FOLLOW_MS)
    expect(report).toMatchObject({ fontAfterEscape: 'Helvetica Neue', focusAfterEscape: 'text-font', undoLabelAfterEscape: 'Undo Edit Text' })
    // The size pointed at in the list was only shown; the one clicked was kept.
    expect(report.sizeFromList).toBe('144')
    expect(projectIn(report, 'styled').tracks[0]?.clips[0]).toMatchObject({ text: 'Two\nlines', font: { family: 'Menlo', size: 120 }, color: '#ffcc00', align: 'left' })

    // Deleting every word and leaving the text put the words back, without an undo step of its own.
    expect(report.wordsAfterEmptying).toBe('Two\nlines')
    expect(report.undoLabel).toBe('Undo Change Alignment')
  })
})

describe('controls', () => {
  const NARROWEST_SIDEBAR = 220
  const NARROWEST_CANVAS = 360
  const SPLITTERS = 10
  const PANEL_PADDING = 8
  const WIDEST_SCROLL_BAR = 16
  const SECONDS_PER_HOUR = 3600

  it('shows fields under their labels, folds groups, shows media as tiles, widens a sidebar and zooms the timeline far out', async () => {
    const profile = join(scratch, 'controls-profile')
    mkdirSync(profile, { recursive: true })
    const report = await uiTest('controls', ['--media', MEDIA_DIRECTORY, '--out', join(scratch, 'controls')], profile)
    console.info(`controls: ${JSON.stringify(report)}`)

    expect(report).toMatchObject({ isSwitchBesideSearch: true, isListStacked: true, areTilesSideBySide: true })

    // A field starts at the padding of its panel and ends at the padding, or at the room kept for the scroll bar.
    expect(report.isLabelAbove).toBe(true)
    const inset = report.fieldInset
    if (typeof inset !== 'object' || inset === null || !('left' in inset) || !('right' in inset)) throw new Error('The scenario did not report where the field is')
    expect(inset.left).toBe(PANEL_PADDING)
    expect(inset.right).toBeGreaterThanOrEqual(PANEL_PADDING)
    expect(inset.right).toBeLessThanOrEqual(PANEL_PADDING + WIDEST_SCROLL_BAR)

    // Escape handed the focus back to the field; a value only pointed at was not kept and made no undo step.
    expect(report).toMatchObject({ focusAfterList: 'clip-volume', rotationAfterPressElsewhere: '0.0', undoLabelAfterLists: 'Undo Add Clip', isLockShownWhenFolded: true })
    // The keyboard alone opened a list of values, moved one up from 100 and kept it.
    expect(report).toMatchObject({ opacityFromKeys: '75', focusAfterKeys: 'clip-opacity' })

    // The dragged sidebar took all the canvas could spare; the other one did not move.
    expect(report.rightAfter).toBe(report.rightBefore)
    expect(report.leftWide).toBe(Number(report.windowWidth) - NARROWEST_CANVAS - SPLITTERS - Number(report.rightBefore))
    expect(report.leftWide).toBeGreaterThan(600)
    expect(report.canvasWhenWide).toBe(NARROWEST_CANVAS)
    expect(report.rightNarrow).toBe(NARROWEST_SIDEBAR)

    // Zoomed out, the view holds an hour; the fit button brings the two-second project back.
    expect(Number(report.zoomedOut) * SECONDS_PER_HOUR).toBeCloseTo(Number(report.timelineWidth), 6)
    expect(report.zoomedOut).toBeLessThan(Number(report.zoomAtFit) / 100)
    expect(report.zoomAfterFit).toBe(report.zoomAtFit)

    // Every press that opens a list, the 200 fonts included, shows it on the next frame; so does folding a group.
    // Twelve lists were opened with a press, and one from the keyboard, which is not timed.
    expect(report.listSamples).toBe(12)
    expect(report.fontListSamples).toBe(5)
    expect(report.listOpenP95).toBeLessThanOrEqual(MAX_CANVAS_FOLLOW_MS)
    expect(report.groupSamples).toBe(3)
    expect(report.groupToggleP95).toBeLessThanOrEqual(MAX_CANVAS_FOLLOW_MS)

    const nextLaunch = await uiTest('controls-kept', [], profile)
    expect(nextLaunch).toEqual({ isProjectOpen: false, isGridChosen: true, isListChosen: false })
  })
})

describe('animated images', () => {
  it('imports a GIF as a looping image clip that stretches past its own length', async () => {
    const report = await uiTest('animated', ['--media', MEDIA_DIRECTORY, '--out', join(scratch, 'animated')])
    expect(report.kindShown).toBe('image')

    const placed = projectIn(report, 'placed')
    expect(placed.canvas).toEqual({ width: 214, height: 120, frameRate: { num: 30, den: 1 } })
    expect(placed.tracks[0]?.clips[0]).toMatchObject({ type: 'video', loop: true, start: 0, duration: 5 * SECOND })
    expect(projectIn(report, 'stretched').tracks[0]?.clips[0]).toMatchObject({ loop: true, duration: 8 * SECOND })

    // Without the loop the clip is one play of its twelve pictures long.
    const once = projectIn(report, 'once').tracks[0]?.clips[0]
    expect(once).toMatchObject({ duration: 1.2 * SECOND })
    expect(once).not.toHaveProperty('loop')
    expect(report.isLoopingAfterUndo).toBe(true)
  })
})

describe('missing media', () => {
  // The three files this project names are in the test media folder, not in the folder it remembers.
  const moved: Project = {
    version: 1,
    canvas: { width: 640, height: 360, frameRate: { num: 30, den: 1 } },
    media: [
      { id: 'screen', path: '/moved/away/h264.mp4', relativePath: '' },
      { id: 'voice', path: '/moved/away/audio.wav', relativePath: '' },
      { id: 'logo', path: '/moved/away/image.jpg', relativePath: '' },
    ],
    tracks: [
      {
        id: 't1',
        name: 'Track 1',
        hidden: false,
        locked: false,
        muted: false,
        clips: [{ id: 'screen', type: 'video', mediaId: 'screen', start: 0, duration: 2 * SECOND, sourceStart: 0, speedPercent: 100, volume: 1, opacity: 1, transform: { x: 320, y: 180, scaleX: 2, scaleY: 2, rotation: 0 } }],
      },
      {
        id: 't2',
        name: 'Track 2',
        hidden: false,
        locked: false,
        muted: false,
        clips: [{ id: 'voice', type: 'audio', mediaId: 'voice', start: 0, duration: 2 * SECOND, sourceStart: 0, speedPercent: 100, volume: 1 }],
      },
      {
        id: 't3',
        name: 'Track 3',
        hidden: false,
        locked: false,
        muted: false,
        clips: [{ id: 'logo', type: 'image', mediaId: 'logo', start: 0, duration: 2 * SECOND, opacity: 1, transform: { x: 100, y: 60, scaleX: 0.25, scaleY: 0.25, rotation: 0 } }],
      },
    ],
  }

  it('badges missing files on open, and relinking one finds the others in the same folder', async () => {
    const path = join(scratch, 'moved.json')
    writeFileSync(path, serializeProject(moved))
    const report = await uiTest('relink', ['--project', path, '--media', MEDIA_DIRECTORY, '--out', join(scratch, 'relink')])

    expect(report.openNotice).toBe('3 media files are missing. Use Relink in the Media tab to say where they are.')
    expect(report.missingAtOpen).toBe(3)
    expect(report.refusal).toBe('"audio.wav" cannot take the place of "h264.mp4": the project uses that file for its video.')
    expect(report.missingAfterRefusal).toBe(3)
    expect(report.foundNotice).toBe('2 more missing files were found in the same folder.')
    expect(projectIn(report, 'relinked').media.map((reference) => reference.path)).toEqual(['h264.mp4', 'audio.wav', 'image.jpg'].map((name) => join(MEDIA_DIRECTORY, name)))
  })
})

describe('export dialog', () => {
  it('exports from the dialog with every option, keeps editing meanwhile, and cancels cleanly', async () => {
    const report = await uiTest('export', ['--project', projectPath('05-fades'), '--out', join(scratch, 'export')])

    // The 640 x 360 project starts at its own size; nothing is selected yet, so there is no range to choose.
    expect(report.defaultPreset).toBe('360p')
    expect(report.summaryAtOpen).toBe('MP4, 640 × 360, 3 s long.')
    expect(report.canChooseSelection).toBe(false)

    // Tab reaches every control and stays inside the dialog.
    const controls = ['export-frame-rate', 'export-quality-low', 'export-quality-medium', 'export-quality-high', 'export-range-whole', 'export-audio', 'export-cancel-dialog', 'export-start', 'export-preset']
    expect(report.tabStops).toEqual([...controls, ...controls.slice(0, 3)])
    expect(report.isDialogOpenAfterListEscape).toBe(true)

    // The selected clip runs for two seconds: fifty frames at 25 a second, with no sound.
    const range = await probeExport(String(report.range))
    expect(range.video).toMatchObject({ codec_name: 'h264', width: '426', height: '240', r_frame_rate: '25/1', nb_frames: '50' })
    expect(range.audio).toEqual({})
    expect(Math.abs(range.duration - 2)).toBeLessThan(0.05)
    expect(report.canShowInFinder).toBe(true)

    // The next export starts from the size chosen last time. Cancelled half way, it leaves nothing on disk.
    expect(report.rememberedPreset).toBe('240p')
    expect(report.progressText).toMatch(/^Frame \d+ of 90/)
    expect(report.hadUnfinishedFile).toBe(true)
    expect(report.leftBehind).toEqual([])

    const low = await probeExport(String(report.low))
    const high = await probeExport(String(report.high))
    expect(high.video).toMatchObject({ width: '426', height: '240', r_frame_rate: '30/1', nb_frames: '90' })
    expect(high.audio).toMatchObject({ codec_name: 'aac' })
    expect(Math.abs(low.duration - 3)).toBeLessThan(0.05)
    expect(statSync(String(report.low)).size).toBeLessThan(statSync(String(report.high)).size)
  })
})

