import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { serializeProject, type Project } from '../../src/shared/project.js'
import { ROOT, probeExport, projectIn, projectPath, scratchDirectory, uiTest } from '../helpers.js'

const SECOND = 24_000_000
const MAX_STEP_MS = 50
const MAX_CANVAS_FOLLOW_MS = 33
const MAX_FRAME_INTERVAL_MS = 1000 / 60 + 4
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

// Every track as its clips: what each is and the second it starts at.
function arrangement(project: Project): string[][] {
  return project.tracks.map((track) => track.clips.map((clip) => `${clip.type} ${clip.start / SECOND}`))
}

describe('arranging by dragging', () => {
  it('shows where held media would land, moves two clips across tracks together, and crops by typing', async () => {
    const report = await uiTest('arrange', ['--media', MEDIA_DIRECTORY, '--out', join(scratch, 'arrange')])

    // The Media tab says how long or how large a file is, and no longer what kind it is or whether it is used.
    expect(report.mediaDetails).toEqual(['0:02', '0:02', '320 × 180'])

    // Held over the timeline, the video shows where it would land while nothing is added, and the outline keeps up with the pointer.
    expect(report.heldOverEmpty).toEqual({ start: SECOND, trackIndex: 0, isNewTrack: true })
    expect(report.whileHeld).toEqual({ tracks: 0, undoLabel: 'unchanged' })
    expect(report.heldFrames).toBeGreaterThan(60)
    expect(report.heldFrameP95).toBeLessThanOrEqual(MAX_FRAME_INTERVAL_MS)
    // Escape abandons the drag; let go on the timeline, the clip is where the outline was.
    expect(report.afterEscape).toEqual({ tracks: 0, undoLabel: 'unchanged' })
    expect(arrangement(projectIn(report, 'placed'))).toEqual([['video 1']])

    // Over the video the outline promised a track of its own, and playback went on while the sound was held there.
    expect(report.heldOverTaken).toEqual({ start: 1.5 * SECOND, trackIndex: 1, isNewTrack: true })
    expect(report.isPlayingWhileHeld).toBe(true)
    expect(arrangement(projectIn(report, 'stacked'))).toEqual([['video 1'], ['audio 1.5']])

    // The two clips went a second later and a track up together, the upper one onto a new track; then down again; then stayed, with no track below.
    expect(arrangement(projectIn(report, 'lifted'))).toEqual([[], ['video 2'], ['audio 2.5']])
    expect(report.groupSamples).toBeGreaterThan(4)
    expect(report.groupToFrameP95).toBeLessThanOrEqual(MAX_CANVAS_FOLLOW_MS)
    expect(arrangement(projectIn(report, 'lowered'))).toEqual([['video 2'], ['audio 2.5'], []])
    expect(projectIn(report, 'kept').tracks).toEqual(projectIn(report, 'lowered').tracks)

    // A hundred pixels cropped off the left of the 320-wide picture: the centre moved right by fifty, so what is left did not move.
    expect(report.groupIcons).toEqual(['Transform 2', 'Crop 2', 'Timing 2', 'Opacity 2', 'Transitions 2', 'Animation 2', 'Volume 2'])
    expect(projectIn(report, 'cropped').tracks[0]?.clips[0]).toMatchObject({ crop: { left: 100, top: 0, right: 0, bottom: 0 }, transform: { x: 210, y: 90 } })
    expect(report.widthAfterCrop).toBe('220.0')
    expect(report.hintSize).toBe('13px')
  })
})

describe('annotations', () => {
  it('adds blur, pixelate, highlight and spotlight clips and changes them on the canvas and in Properties', async () => {
    const report = await uiTest('shapes', ['--project', projectPath('01-single-clip'), '--out', join(scratch, 'shapes')])

    // A new blur is three tenths of the canvas wide and two tenths high, in the middle, on a new top track, for five seconds from the playhead.
    const added = projectIn(report, 'added')
    expect(added.tracks).toHaveLength(2)
    expect(added.tracks[1]?.clips[0]).toMatchObject({ type: 'blur', start: 0, duration: 5 * SECOND, width: 192, height: 72, shape: 'rectangle', softEdge: 0, strength: 8, transform: { x: 320, y: 180, scaleX: 1, scaleY: 1 } })

    // Its corner was pulled to twice the size; shape, edge, strength and the switch to pixels came from Properties, where the strength is then called the block size.
    const styled = projectIn(report, 'styled').tracks[1]?.clips[0]
    expect(styled).toMatchObject({ type: 'blur', shape: 'ellipse', softEdge: 6, strength: 20, isPixelated: true })
    expect(styled?.type === 'blur' && Math.abs(styled.transform.scaleX - 2)).toBeLessThan(0.05)
    expect(report.strengthLabel).toBe('Block size')

    expect(projectIn(report, 'spotlight').tracks[2]?.clips[0]).toMatchObject({ type: 'highlight', color: '#00ff00', isSpotlight: true })
    const kinds = projectIn(report, 'all').tracks.map((track) => {
      const [clip] = track.clips
      if (clip?.type === 'blur') return clip.isPixelated === true ? 'pixelate' : 'blur'
      if (clip?.type === 'highlight') return clip.isSpotlight === true ? 'spotlight' : 'highlight'
      return clip?.type
    })
    expect(kinds).toEqual(['video', 'pixelate', 'spotlight', 'pixelate', 'spotlight'])

    // Undo took the last spotlight and its track away; Delete emptied the track of the pixelate clip before it.
    expect(projectIn(report, 'afterDelete').tracks.map((track) => track.clips.length)).toEqual([1, 1, 1, 0])
  })
})

describe('callouts, arrows and lines', () => {
  it('adds them from the Annotations tab and changes them on the canvas and in Properties', async () => {
    const report = await uiTest('annotations', ['--project', projectPath('01-single-clip'), '--out', join(scratch, 'annotations')])

    // A new callout is a speech bubble in the middle, three tenths of the canvas wide, with the words that were typed into it.
    const added = projectIn(report, 'added').tracks[1]?.clips[0]
    expect(added).toMatchObject({ type: 'callout', shape: 'speechBubble', text: 'Look here', start: 0, duration: 5 * SECOND, width: 192, height: 72, tail: { x: -58, y: 65 }, transform: { x: 320, y: 180 } })

    // The tail was dragged to the canvas point 560, 320, which is 240 right of and 140 below the middle of the callout.
    const shaped = projectIn(report, 'shaped').tracks[1]?.clips[0]
    expect(shaped).toMatchObject({ shape: 'thoughtBubble', width: 240, fill: '#ffee00', borderWidth: 6 })
    expect(shaped?.type === 'callout' && Math.abs((shaped.tail?.x ?? 0) - 240)).toBeLessThanOrEqual(3)
    expect(shaped?.type === 'callout' && Math.abs((shaped.tail?.y ?? 0) - 140)).toBeLessThanOrEqual(3)
    const banner = projectIn(report, 'banner').tracks[1]?.clips[0]
    expect(banner).toMatchObject({ shape: 'banner' })
    expect(banner).not.toHaveProperty('tail')

    expect(projectIn(report, 'arrowAdded').tracks[2]?.clips[0]).toMatchObject({ type: 'arrow', length: 160, thickness: 3, startHead: 'none', endHead: 'triangle', transform: { x: 320, y: 180, rotation: 0 } })
    // Its end went from 400, 180 to 600, 40 while its start stayed at 240, 180.
    const pointed = projectIn(report, 'pointed').tracks[2]?.clips[0]
    expect(pointed).toMatchObject({ startHead: 'dot', thickness: 8 })
    if (pointed?.type !== 'arrow') throw new Error('The arrow is gone')
    expect(Math.abs(pointed.transform.x - 420)).toBeLessThanOrEqual(2)
    expect(Math.abs(pointed.transform.y - 110)).toBeLessThanOrEqual(2)
    expect(Math.abs(pointed.length - Math.hypot(360, 140))).toBeLessThanOrEqual(3)
    expect(Math.abs(pointed.transform.rotation + 21.25)).toBeLessThanOrEqual(1)

    expect(projectIn(report, 'withLine').tracks[3]?.clips[0]).toMatchObject({ type: 'arrow', startHead: 'none', endHead: 'none' })
  })
})

describe('text styling', () => {
  it('sets weight, spacing, outline, shadow, background and a fixed box from Properties', async () => {
    const report = await uiTest('text-style', ['--out', join(scratch, 'text-style')])
    const styled = projectIn(report, 'styled').tracks[0]?.clips[0]
    expect(styled).toMatchObject({
      type: 'text',
      text: 'Two words',
      font: { weight: 700 },
      lineSpacing: 1.5,
      outline: { color: '#000000', width: 4 },
      shadow: { color: '#000000aa', blur: 0 },
      background: { color: '#3c5a88aa' },
    })
    expect(styled).not.toHaveProperty('boxWidth')

    // Narrower than its words, the box breaks them into two lines and grows taller.
    expect(projectIn(report, 'wrapped').tracks[0]?.clips[0]).toMatchObject({ boxWidth: 300 })
    expect(Number(report.heightOnTwoLines)).toBeGreaterThan(Number(report.heightOnOneLine) * 1.5)

    const plain = projectIn(report, 'plain').tracks[0]?.clips[0]
    expect(plain).toMatchObject({ shadow: { blur: 0 }, background: { color: '#3c5a88aa' } })
    expect(plain).not.toHaveProperty('boxWidth')
    expect(plain).not.toHaveProperty('outline')
  })
})

describe('animation presets', () => {
  it('applies them at either end and turns them into keyframes', async () => {
    const report = await uiTest('animations', ['--project', projectPath('01-single-clip'), '--out', join(scratch, 'animations')])
    expect(report.canConvertBefore).toBe(false)
    // A video has no letters to type.
    expect(report.offersTypewriter).toBe(false)

    const animated = projectIn(report, 'animated').tracks[0]?.clips[0]
    expect(animated).toMatchObject({ animationIn: { type: 'pop', duration: SECOND }, animationOut: { type: 'slideRight', duration: SECOND / 2 } })
    expect(animated).not.toHaveProperty('keyframes')

    const converted = projectIn(report, 'converted').tracks[0]?.clips[0]
    expect(converted).not.toHaveProperty('animationIn')
    expect(converted).not.toHaveProperty('animationOut')
    // The pop became three scale keyframes that end at the size the clip has; the slide two position keyframes that end a canvas width away.
    expect(converted?.keyframes?.scaleX?.map((keyframe) => keyframe.value)).toEqual([0, 2.2, 2])
    expect(converted?.keyframes?.scaleY).toEqual(converted?.keyframes?.scaleX)
    expect(converted?.keyframes?.x).toEqual([
      { time: 1.5 * SECOND, value: 320, easing: 'easeIn' },
      { time: 2 * SECOND, value: 960, easing: 'linear' },
    ])

    const removed = projectIn(report, 'removed').tracks[0]?.clips[0]
    expect(removed).toMatchObject({ animationOut: { type: 'slideRight' } })
    expect(removed).not.toHaveProperty('animationIn')
  })
})

describe('groups', () => {
  it('groups clips, changes a member from the inside, ungroups, and undoes it all', async () => {
    const original = projectPath('02-mosaic')
    const report = await uiTest('groups', ['--project', original, '--out', join(scratch, 'groups')])

    // The group lies where the topmost clip was and holds the four clips on four tracks of its own, placed around its middle.
    const grouped = projectIn(report, 'grouped')
    expect(grouped.tracks.map((track) => track.clips.length)).toEqual([0, 0, 0, 1])
    const group = grouped.tracks[3]?.clips[0]
    expect(group).toMatchObject({ type: 'group', start: 0, duration: 2 * SECOND, transform: { x: 320, y: 180, scaleX: 1, scaleY: 1, rotation: 0 } })
    if (group?.type !== 'group') throw new Error('There is no group')
    expect(group.tracks.map((track) => track.clips.map((clip) => clip.id))).toEqual([['a'], ['b'], ['c'], ['d']])
    expect(group.tracks[0]?.clips[0]).toMatchObject({ transform: { x: -160, y: -90 } })

    // Dragged by one member, the whole group moved; its scale is one number.
    const moved = projectIn(report, 'moved').tracks[3]?.clips[0]
    expect(moved).toMatchObject({ transform: { scaleX: 0.5, scaleY: 0.5 } })
    expect(moved?.type === 'group' && Math.abs(moved.transform.x - 360)).toBeLessThanOrEqual(2)
    expect(moved?.type === 'group' && Math.abs(moved.transform.y - 200)).toBeLessThanOrEqual(2)

    // Inside, the timeline shows the group's own tracks and the camera cannot be changed. Twenty canvas pixels are forty inside a group at half its size; going down, the member comes within reach of the middle of the canvas and snaps to it.
    expect(report.tracksInside).toBe(4)
    expect(report.isCameraToolOff).toBe(true)
    const inside = projectIn(report, 'inside').tracks[3]?.clips[0]
    if (inside?.type !== 'group') throw new Error('There is no group')
    expect(inside.tracks[3]?.clips[0]).toMatchObject({ id: 'd', opacity: 0.4 })
    const dragged = inside.tracks[0]?.clips[0]
    expect(dragged?.type === 'video' && Math.abs(dragged.transform.x + 120)).toBeLessThanOrEqual(4)
    expect(dragged?.type === 'video' && Math.abs(inside.transform.y + dragged.transform.y / 2 - 180)).toBeLessThanOrEqual(0.01)

    // Ungrouped, the members are where and as large as the group showed them, the lowest where the group was and the others above it.
    const ungrouped = projectIn(report, 'ungrouped')
    expect(ungrouped.tracks.map((track) => track.clips.map((clip) => clip.id))).toEqual([[], [], [], ['a'], ['b'], ['c'], ['d']])
    const last = ungrouped.tracks[6]?.clips[0]
    expect(last).toMatchObject({ opacity: 0.4, transform: { scaleX: 0.5, scaleY: 0.5 } })
    expect(last?.type === 'video' && Math.abs(last.transform.x - 440)).toBeLessThanOrEqual(2)
    expect(last?.type === 'video' && Math.abs(last.transform.y - 245)).toBeLessThanOrEqual(2)

    const undone = projectIn(report, 'undone')
    expect(undone.tracks.map((track) => track.clips.map((clip) => clip.id))).toEqual([['a'], ['b'], ['c'], ['d']])
    expect(undone.tracks[0]?.clips[0]).toMatchObject({ transform: { x: 160, y: 90, scaleX: 1 } })
  })
})

describe('volume keyframes and the sound of fast clips', () => {
  it('keys the volume in Properties, drags a keyframe on the waveform and sets how sound follows speed', async () => {
    const report = await uiTest('sound', ['--project', projectPath('01-single-clip'), '--out', join(scratch, 'sound')])
    expect(projectIn(report, 'keyed').tracks[0]?.clips[0]?.keyframes?.volume).toEqual([
      { time: 0, value: 1, easing: 'linear' },
      { time: SECOND, value: 0.5, easing: 'linear' },
    ])

    expect(report.cursorOverPoint).toBe('grab')
    const [first, second] = projectIn(report, 'dragged').tracks[0]?.clips[0]?.keyframes?.volume ?? []
    expect(first).toEqual({ time: 0, value: 1, easing: 'linear' })
    expect(Math.abs((second?.time ?? 0) - 1.5 * SECOND)).toBeLessThanOrEqual(SECOND / 30)
    expect(second?.value).toBeGreaterThan(1.7)

    expect(projectIn(report, 'eased').tracks[0]?.clips[0]?.keyframes?.volume?.[0]).toMatchObject({ time: 0, easing: 'easeIn' })
    expect(projectIn(report, 'deleted').tracks[0]?.clips[0]?.keyframes?.volume).toHaveLength(1)

    expect(report.offersFastSoundAtFirst).toBe(false)
    expect(projectIn(report, 'fast').tracks[0]?.clips[0]).toMatchObject({ speedPercent: 800, changesPitch: true, hasFastSound: true })
  })
})

describe('effects', () => {
  it('adds effects by click and by dragging onto the timeline and the canvas, and changes a clip\'s list in Properties', async () => {
    const report = await uiTest('effects', ['--project', projectPath('02-mosaic'), '--out', join(scratch, 'effects')])
    const effectsOf = (stage: string): unknown[] => projectIn(report, stage).tracks.map((track) => {
      const [clip] = track.clips
      return clip?.type === 'video' ? (clip.effects ?? []) : []
    })

    expect(report.noticeWithoutSelection).toBe('Select a video, an image or a text first, or drag the effect onto one.')
    // A click put a border on both selected clips, sized for the 360 pixel high canvas.
    const border = { type: 'border', width: 2, color: '#ffffff' }
    expect(effectsOf('bordered')).toEqual([[border], [border], [], []])
    expect(report.hintForTwo).toBe('Select one clip to change its effects.')

    // Held over the third clip the shadow marked it and changed nothing; dropped there and on the fourth clip on the canvas, each got its effect.
    expect(report.heldOverTimeline).toMatchObject({ kind: 'effect', clipIds: ['c'], effect: 'dropShadow' })
    expect(report.undoWhileHeld).toBe('Undo Add Effect')
    expect(effectsOf('dropped')).toMatchObject([[border], [border], [{ type: 'dropShadow', offsetX: 4, opacity: 0.5 }], [{ type: 'colorAdjust', saturation: 0 }]])

    // The border of the fourth clip was made 12 wide, moved before the colour adjustment and switched off.
    expect(effectsOf('changed')[3]).toEqual([{ type: 'border', width: 12, color: '#ffffff', isOff: true }, { type: 'colorAdjust', brightness: 0, contrast: 0, saturation: -1 }])
    expect(effectsOf('keyed')[3]).toMatchObject([{ type: 'border' }, { type: 'colorAdjust' }, { type: 'chromaKey', color: '#123456', tolerance: 0.4 }])
    expect(JSON.stringify(effectsOf('keyed')[3])).toContain('"chromaKey"')
    expect(effectsOf('removed')[3]).toMatchObject([{ type: 'colorAdjust' }, { type: 'chromaKey' }])
  })
})

describe('transitions', () => {
  it('drops transitions on a cut and on free ends, sets their length by the grip and changes them in Properties', async () => {
    const report = await uiTest('transitions', ['--project', projectPath('export-check'), '--out', join(scratch, 'transitions')])
    const clipsAt = (stage: string): unknown[] => projectIn(report, stage).tracks[0]?.clips ?? []

    // Held over the first clip near its end, the transition marks the cut, which belongs to the start of the second clip. Nothing changes until it is let go, and nothing after Escape.
    expect(report.heldOnCut).toMatchObject({ kind: 'transition', target: { clipId: 'second', edge: 'in' }, type: 'crossDissolve' })
    expect(report.isUnchangedWhileHeld).toBe(true)
    expect(report.isUnchangedAfterEscape).toBe(true)
    expect(clipsAt('onCut')[1]).toMatchObject({ id: 'second', transitionIn: { type: 'crossDissolve', duration: SECOND } })

    // The grip was pulled from half a second after the cut to 0.2 s after it: the transition is 0.4 s long, and the picture followed within the budget.
    expect(clipsAt('shortened')[1]).toMatchObject({ transitionIn: { type: 'crossDissolve', duration: 0.4 * SECOND } })
    expect(report.gripSamples).toBeGreaterThan(3)
    expect(report.gripToFrameP95).toBeLessThanOrEqual(MAX_CANVAS_FOLLOW_MS)

    // Each one-second clip has 0.8 s left beside its half of the transition on the cut, and that is how long the transitions at the free ends became.
    expect(clipsAt('withEnds')).toMatchObject([{ transitionIn: { type: 'zoom', duration: 0.8 * SECOND } }, { transitionOut: { type: 'push', duration: 0.8 * SECOND } }])

    const second = clipsAt('viaProperties')[1]
    expect(second).toMatchObject({ transitionIn: { type: 'wipeLeft', duration: 0.3 * SECOND } })
    expect(second).not.toHaveProperty('transitionOut')
    expect(clipsAt('clicked')[1]).toMatchObject({ transitionIn: { type: 'circleReveal' } })
  })
})

describe('zoom and pan', () => {
  it('frames the canvas with the zoom tool, edits zooms on the camera lane and in Properties, and keeps the handles on a zoomed picture', async () => {
    const report = await uiTest('zoom', ['--project', projectPath('01-single-clip'), '--out', join(scratch, 'zoom')])
    const zoomsAt = (stage: string): { time: number; duration: number; easing: string; x: number; y: number; scale: number }[] => projectIn(report, stage).camera ?? []
    const near = (value: number | undefined, expected: number, within: number): boolean => value !== undefined && Math.abs(value - expected) <= within

    // The frame drawn over the middle half of the canvas is a zoom to 200% at the playhead, reached over a second with an eased move.
    const [drawn] = zoomsAt('drawn')
    expect(drawn).toMatchObject({ time: SECOND, duration: SECOND, easing: 'easeInOut' })
    expect(near(drawn?.scale, 2, 0.02) && near(drawn?.x, 320, 2) && near(drawn?.y, 180, 2)).toBe(true)
    expect(report.frameSamples).toBeGreaterThan(3)
    expect(report.frameToFrameP95).toBeLessThanOrEqual(MAX_CANVAS_FOLLOW_MS)

    // Moved by 80 and 40, then made smaller from its bottom right corner: 240 wide, with the top left corner where it was.
    const [moved] = zoomsAt('movedFrame')
    expect(near(moved?.x, 400, 2) && near(moved?.y, 220, 2) && near(moved?.scale, 2, 0.02)).toBe(true)
    const [shaped] = zoomsAt('shaped')
    expect(near(shaped?.scale, 640 / 240, 0.05) && near(shaped?.x, 360, 3) && near(shaped?.y, 197.5, 3)).toBe(true)

    expect(zoomsAt('withFull')).toHaveLength(2)
    expect(zoomsAt('withFull')[1]).toMatchObject({ time: 1.5 * SECOND, x: 320, y: 180, scale: 1 })

    // On the lane the first zoom went to 0.8 s and its move was cut to 0.4 s; Properties then made it 0.5 s and linear.
    expect(zoomsAt('onLane')[0]).toMatchObject({ time: 0.8 * SECOND, duration: 0.4 * SECOND })
    expect(zoomsAt('viaProperties')[0]).toMatchObject({ time: 0.8 * SECOND, duration: SECOND / 2, easing: 'linear' })
    expect(zoomsAt('afterDelete').map((zoom) => zoom.time)).toEqual([0.8 * SECOND])

    // Under the zoom the clip moved by what the pointer travelled on the zoomed picture, not on the whole canvas.
    const clip = projectIn(report, 'moved').tracks[0]?.clips[0]
    const expected = 320 + (Number(report.pulled) * Number(report.canvasPerPixel)) / (zoomsAt('moved')[0]?.scale ?? 1)
    expect(clip?.type === 'video' && near(clip.transform.x, expected, 1.5)).toBe(true)
  })
})

describe('animated images', () => {
  it('imports a GIF as a looping image clip that stretches past its own length', async () => {
    const report = await uiTest('animated', ['--media', MEDIA_DIRECTORY, '--out', join(scratch, 'animated')])

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
  it('exports from the dialog with every option, holds the window meanwhile, and cancels cleanly', async () => {
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

    // The result is read in the dialog, with the focus on the button that closes it. Behind it nothing was duplicated, pasted, selected or replaced by a new project.
    expect(report.canShowInFinder).toBe(true)
    expect(report.focusOnResult).toBe('export-done')
    expect(report.behindResult).toEqual({ undoLabel: 'Undo', selectedStart: '1.000' })

    // The next export starts from the size chosen last time. While it runs, the focus is on the dialog and not on Cancel; Delete, Space, Duplicate, a click, a dropped file, Escape twice and closing the window change and stop nothing.
    expect(report.rememberedPreset).toBe('240p')
    expect(report.progressText).toMatch(/^Frame \d+ of 90/)
    expect(report.focusWhileRunning).toBe('export-progress-dialog')
    expect(report.whileRunning).toEqual({ undoLabel: 'Undo Change Opacity', selectedStart: '1.000', notice: '', hasPlayheadMoved: false, isStillRunning: true })
    // A result is closed by Return, with the focus on its button, and by Escape.
    expect(report.resultsClosedByKeys).toEqual(['Exported "whole-low.mp4"', 'Exported "whole-high.mp4"'])

    // Cancelled half way, it leaves nothing on disk; so does an export whose window loads again.
    expect(report.hadUnfinishedFile).toBe(true)
    expect(report.leftBehind).toEqual([])
    expect(report.leftAfterReload).toEqual([])

    const low = await probeExport(String(report.low))
    const high = await probeExport(String(report.high))
    expect(high.video).toMatchObject({ width: '426', height: '240', r_frame_rate: '30/1', nb_frames: '90' })
    expect(high.audio).toMatchObject({ codec_name: 'aac' })
    expect(Math.abs(low.duration - 3)).toBeLessThan(0.05)
    expect(statSync(String(report.low)).size).toBeLessThan(statSync(String(report.high)).size)
  })
})

