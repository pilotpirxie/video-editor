import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { partsOf } from '../../src/editor/colors.js'
import { parseProject, serializeProject, type Clip, type DrawingClip, type DrawingShape, type Project, type Transform } from '../../src/shared/project.js'
import { ROOT, animationOf, at, imageOf, pixelAt, probeExport, projectIn, projectOfTracks, projectPath, renderFrames, runApp, scratchDirectory, uiTest } from '../helpers.js'

const SECOND = 24_000_000
const MAX_STEP_MS = 50
const MAX_CANVAS_FOLLOW_MS = 33
const MAX_FRAME_INTERVAL_MS = 1000 / 60 + 4
const MEDIA_DIRECTORY = join(ROOT, 'test', 'media', 'generated')

const scratch = scratchDirectory('features')
const FRAMES_PER_SECOND = 30
const FRAME = SECOND / FRAMES_PER_SECOND

function framesOf(timecode: unknown): number {
  const [hours = 0, minutes = 0, seconds = 0, frames = 0] = String(timecode).split(':').map(Number)
  return ((hours * 60 + minutes) * 60 + seconds) * FRAMES_PER_SECOND + frames
}

type Point = {
  x: number
  y: number
}

function isPoint(value: unknown): value is Point {
  if (typeof value !== 'object' || value === null) return false
  if (!('x' in value) || !('y' in value)) return false
  return typeof value.x === 'number' && typeof value.y === 'number'
}

describe('transport', () => {
  it('steps, jumps and shuttles with the default keys', async () => {
    const report = await uiTest('transport', ['--project', projectPath('01-single-clip')])
    expect(report.duration).toBe('/ 00:00:02:00')
    expect(report.stepMilliseconds).toBeLessThanOrEqual(MAX_STEP_MS)

    expect(framesOf(report.timecodeAfterForward)).toBeGreaterThan(15)
    expect(framesOf(report.timecodeWhileReversing)).toBeLessThan(framesOf('00:00:01:29'))
    expect(report.timecodeAtStart).toBe('00:00:00:00')
  })
})

describe('linked clips and fades', () => {
  it('fades picture and sound with the corner handles, one undo step each, and separates the sound', async () => {
    const report = await uiTest('blocks', ['--project', projectPath('01-single-clip'), '--out', join(scratch, 'blocks')])
    expect(report.cursorOverHandle).toBe('grab')
    expect(report.dragToFrameP95).toBeLessThanOrEqual(MAX_CANVAS_FOLLOW_MS)

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
    expect(typed.tracks).toHaveLength(6)
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

    expect(report.fontCount).toBeGreaterThan(20)
    expect(report.fontHoverSamples).toBe(5)
    expect(report.fontHoverToFrameP95).toBeLessThanOrEqual(MAX_CANVAS_FOLLOW_MS)
    expect(report).toMatchObject({ fontAfterEscape: 'Helvetica Neue', focusAfterEscape: 'text-font', undoLabelAfterEscape: 'Undo Edit Text' })
    expect(report.sizeFromList).toBe('144')
    expect(projectIn(report, 'styled').tracks[0]?.clips[0]).toMatchObject({ text: 'Two\nlines', font: { family: 'Menlo', size: 120 }, color: '#ffcc00', align: 'left' })

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

    expect(report).toMatchObject({ isSwitchBesideSearch: true, isGridByDefault: true, isListStacked: true, areTilesSideBySide: true })
    expect(report.groupsOpenAtFirst).toEqual(['Transform', 'Timing'])

    expect(report.isLabelAbove).toBe(true)
    const inset = report.fieldInset
    if (typeof inset !== 'object' || inset === null || !('left' in inset) || !('right' in inset)) throw new Error('The scenario did not report where the field is')
    expect(inset.left).toBe(PANEL_PADDING)
    expect(inset.right).toBeGreaterThanOrEqual(PANEL_PADDING)
    expect(inset.right).toBeLessThanOrEqual(PANEL_PADDING + WIDEST_SCROLL_BAR)

    expect(report).toMatchObject({ focusAfterList: 'clip-volume', rotationAfterPressElsewhere: '0.0', undoLabelAfterLists: 'Undo Add Clip', isLockShownWhenFolded: true })
    expect(report).toMatchObject({ opacityFromKeys: '75', focusAfterKeys: 'clip-opacity' })

    expect(report.rightAfter).toBe(report.rightBefore)
    expect(report.leftWide).toBe(Number(report.windowWidth) - NARROWEST_CANVAS - SPLITTERS - Number(report.rightBefore))
    expect(report.leftWide).toBeGreaterThan(600)
    expect(report.canvasWhenWide).toBe(NARROWEST_CANVAS)
    expect(report.rightNarrow).toBe(NARROWEST_SIDEBAR)

    expect(Number(report.zoomedOut) * SECONDS_PER_HOUR).toBeCloseTo(Number(report.timelineWidth), 6)
    expect(report.zoomedOut).toBeLessThan(Number(report.zoomAtFit) / 100)
    expect(report.zoomAfterFit).toBe(report.zoomAtFit)

    expect(report.listSamples).toBe(12)
    expect(report.fontListSamples).toBe(5)
    expect(report.listOpenP95).toBeLessThanOrEqual(MAX_CANVAS_FOLLOW_MS)
    expect(report.groupSamples).toBe(6)
    expect(report.groupToggleP95).toBeLessThanOrEqual(MAX_CANVAS_FOLLOW_MS)

    const nextLaunch = await uiTest('controls-kept', [], profile)
    expect(nextLaunch).toEqual({ isProjectOpen: true, isGridChosen: false, isListChosen: true })
  })
})

function arrangement(project: Project): string[][] {
  return project.tracks.map((track) => track.clips.map((clip) => `${clip.type} ${clip.start / SECOND}`))
}

describe('arranging by dragging', () => {
  it('shows where held media would land, moves two clips across tracks together, and crops by typing', async () => {
    const report = await uiTest('arrange', ['--media', MEDIA_DIRECTORY, '--out', join(scratch, 'arrange')])

    expect(report.mediaDetails).toEqual(['0:02', '0:02', '320x180'])

    expect(report.heldOverEmpty).toEqual({ start: SECOND, trackIndex: 0, isNewTrack: false })
    expect(report.whileHeld).toEqual({ tracks: 6, undoLabel: 'unchanged' })
    expect(report.heldFrames).toBeGreaterThan(60)
    expect(report.heldFrameP95).toBeLessThanOrEqual(MAX_FRAME_INTERVAL_MS)
    expect(report.afterEscape).toEqual({ tracks: 6, undoLabel: 'unchanged' })
    expect(arrangement(projectIn(report, 'placed'))).toEqual([['video 1'], [], [], [], [], []])

    expect(report.heldOverTaken).toEqual({ start: 1.5 * SECOND, trackIndex: 1, isNewTrack: false })
    expect(report.isPlayingWhileHeld).toBe(true)
    expect(arrangement(projectIn(report, 'stacked'))).toEqual([['video 1'], ['audio 1.5'], [], [], [], []])

    expect(arrangement(projectIn(report, 'lifted'))).toEqual([[], ['video 2'], ['audio 2.5'], [], [], []])
    expect(report.groupSamples).toBeGreaterThan(4)
    expect(report.groupToFrameP95).toBeLessThanOrEqual(MAX_CANVAS_FOLLOW_MS)
    expect(arrangement(projectIn(report, 'lowered'))).toEqual([['video 2'], ['audio 2.5'], [], [], [], []])
    expect(projectIn(report, 'kept').tracks).toEqual(projectIn(report, 'lowered').tracks)

    expect(report.groupIcons).toEqual(['Transform 2', 'Timing 2', 'Crop 2', 'Opacity 2', 'In and out 2', 'Volume 2'])
    expect(projectIn(report, 'cropped').tracks[0]?.clips[0]).toMatchObject({ crop: { left: 100, top: 0, right: 0, bottom: 0 }, transform: { x: 210, y: 90 } })
    expect(report.widthAfterCrop).toBe('220.0')

    expect(report.selectedFiles).toEqual(['media-audio.wav', 'media-image.jpg'])
    expect(report.focusAfterClicks).not.toBe('option')
    expect(report.heldTogether).toEqual({ start: 0.5 * SECOND, trackIndex: 2, isNewTrack: false })
    const together = projectIn(report, 'droppedTogether').tracks[2]?.clips ?? []
    expect(together.map((clip) => clip.type)).toEqual(['audio', 'image'])
    expect(together[0]?.start).toBe(0.5 * SECOND)
    expect(together[1]?.start).toBe((together[0]?.start ?? 0) + (together[0]?.duration ?? 0))

    expect(report.listRole).toBe('listbox true')
    expect(report.pickedByKeys).toEqual(['media-audio.wav', 'media-image.jpg'])
    expect(report.focusAfterKeys).toBe('media-image.jpg')
    expect(report.timecodeAfterKeys).toBe(report.timecodeBeforeKeys)
    const byKeys = projectIn(report, 'addedByKeys')
    expect(byKeys.tracks).toHaveLength(6)
    const typed = byKeys.tracks[3]?.clips ?? []
    expect(typed.map((clip) => clip.type)).toEqual(['audio', 'image'])
    expect(typed[0]?.start).toBe(framesOf(report.timecodeBeforeKeys) * (SECOND / FRAMES_PER_SECOND))
    expect(typed[1]?.start).toBe((typed[0]?.start ?? 0) + (typed[0]?.duration ?? 0))
    expect(report.hintSize).toBe('13px')
  })
})

describe('annotations', () => {
  it('adds blur, pixelate, highlight and spotlight clips and changes them on the canvas and in Properties', async () => {
    const report = await uiTest('shapes', ['--project', projectPath('01-single-clip'), '--out', join(scratch, 'shapes')])

    const added = projectIn(report, 'added')
    expect(added.tracks).toHaveLength(2)
    expect(added.tracks[1]?.clips[0]).toMatchObject({ type: 'blur', start: 0, duration: 5 * SECOND, width: 192, height: 72, shape: 'rectangle', softEdge: 0, strength: 8, transform: { x: 320, y: 180, scaleX: 1, scaleY: 1 } })

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

    expect(projectIn(report, 'afterDelete').tracks.map((track) => track.clips.length)).toEqual([1, 1, 1, 0])
  })
})

describe('callouts, arrows and lines', () => {
  it('adds them from the Annotations tab and changes them on the canvas and in Properties', async () => {
    const report = await uiTest('annotations', ['--project', projectPath('01-single-clip'), '--out', join(scratch, 'annotations')])

    const added = projectIn(report, 'added').tracks[1]?.clips[0]
    expect(added).toMatchObject({ type: 'callout', shape: 'speechBubble', text: 'Look here', start: 0, duration: 5 * SECOND, width: 192, height: 72, tail: { x: -58, y: 65 }, transform: { x: 320, y: 180 } })

    const shaped = projectIn(report, 'shaped').tracks[1]?.clips[0]
    expect(shaped).toMatchObject({ shape: 'thoughtBubble', width: 240, fill: '#ffee00', borderWidth: 6 })
    expect(shaped?.type === 'callout' && Math.abs((shaped.tail?.x ?? 0) - 240)).toBeLessThanOrEqual(3)
    expect(shaped?.type === 'callout' && Math.abs((shaped.tail?.y ?? 0) - 140)).toBeLessThanOrEqual(3)
    const banner = projectIn(report, 'banner').tracks[1]?.clips[0]
    expect(banner).toMatchObject({ shape: 'banner' })
    expect(banner).not.toHaveProperty('tail')

    expect(projectIn(report, 'arrowAdded').tracks[2]?.clips[0]).toMatchObject({ type: 'arrow', length: 160, thickness: 3, startHead: 'none', endHead: 'triangle', transform: { x: 320, y: 180, rotation: 0 } })
    const pointed = projectIn(report, 'pointed').tracks[2]?.clips[0]
    expect(pointed).toMatchObject({ startHead: 'dot', thickness: 8 })
    if (pointed?.type !== 'arrow') throw new Error('The arrow is gone')
    expect(Math.abs(pointed.transform.x - 420)).toBeLessThanOrEqual(2)
    expect(Math.abs(pointed.transform.y - 110)).toBeLessThanOrEqual(2)
    expect(Math.abs(pointed.length - Math.hypot(360, 140))).toBeLessThanOrEqual(3)
    expect(Math.abs(pointed.transform.rotation + 21.25)).toBeLessThanOrEqual(1)

    const line = projectIn(report, 'withLine').tracks[3]?.clips[0]
    expect(line).toMatchObject({ type: 'arrow', start: 0, startHead: 'none', endHead: 'none' })
    expect(line !== undefined && 'transform' in line && Math.abs(line.transform.x - 160)).toBeLessThanOrEqual(2)
    expect(line !== undefined && 'transform' in line && Math.abs(line.transform.y - 90)).toBeLessThanOrEqual(2)
    expect(report.undoAfterClick).toBe('Undo Add Line')

    expect(report.titleHeld).toEqual({ start: SECOND, trackIndex: 1, isNewTrack: true })
    const withTitle = projectIn(report, 'withTitle')
    expect(withTitle.tracks).toHaveLength(5)
    expect(withTitle.tracks[1]?.clips[0]).toMatchObject({ type: 'text', start: SECOND, duration: 5 * SECOND, transform: { x: 320, y: 180 } })
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

    expect(projectIn(report, 'wrapped').tracks[0]?.clips[0]).toMatchObject({ boxWidth: 300 })
    expect(Number(report.heightOnTwoLines)).toBeGreaterThan(Number(report.heightOnOneLine) * 1.5)

    const plain = projectIn(report, 'plain').tracks[0]?.clips[0]
    expect(plain).toMatchObject({ shadow: { blur: 0 }, background: { color: '#3c5a88aa' } })
    expect(plain).not.toHaveProperty('boxWidth')
    expect(plain).not.toHaveProperty('outline')
  })
})

describe('missing fonts', () => {
  it('warns on opening and in the Text group, and keeps the name of a font this Mac does not have', async () => {
    const missing = 'No Such Font Family'
    const parsed = parseProject(readFileSync(projectPath('09-text'), 'utf8'))
    if (!parsed.ok) throw new Error(parsed.message)
    const project: Project = {
      ...parsed.project,
      media: parsed.project.media.map((reference) => ({ ...reference, path: join(MEDIA_DIRECTORY, 'h264.mp4') })),
      tracks: parsed.project.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) => (clip.id === 'latin' && clip.type === 'text' ? { ...clip, font: { ...clip.font, family: missing } } : clip)),
      })),
    }
    const path = join(scratch, 'missing-font.json')
    writeFileSync(path, serializeProject(project))
    const report = await uiTest('missing-font', ['--project', path, '--out', join(scratch, 'missing-font')])

    expect(report.openNotice).toContain(`The font "${missing}" is not installed on this Mac.`)
    expect(report.warning).toContain(`${missing} is not installed on this Mac`)
    expect(report.fontShown).toBe(`${missing} (not installed)`)
    const saved = projectIn(report, 'saved').tracks[1]?.clips[0]
    expect(saved).toMatchObject({ type: 'text', font: { family: missing } })
  })
})

describe('in and out', () => {
  it('chooses one fade, animation or transition at each end of a clip, and takes it away', async () => {
    const report = await uiTest('animations', ['--project', projectPath('01-single-clip'), '--out', join(scratch, 'animations')])
    expect(report.offersTypewriter).toBe(false)

    const animated = projectIn(report, 'animated').tracks[0]?.clips[0]
    expect(animated).toMatchObject({ animationIn: { type: 'pop', duration: SECOND }, fadeOut: SECOND / 2 })

    const replaced = projectIn(report, 'replaced').tracks[0]?.clips[0]
    expect(replaced).toMatchObject({ animationIn: { type: 'pop' }, transitionOut: { type: 'slideRight', duration: SECOND / 2 } })
    expect(replaced).not.toHaveProperty('fadeOut')

    const removed = projectIn(report, 'removed').tracks[0]?.clips[0]
    expect(removed).toMatchObject({ transitionOut: { type: 'slideRight' } })
    expect(removed).not.toHaveProperty('animationIn')
  })
})

describe('animation files', () => {
  const RED_PATH = join(MEDIA_DIRECTORY, 'image-red.png')

  function writeEpisode(directory: string, tracksBelow: Clip[][] = []): { episodePath: string; cardPath: string } {
    mkdirSync(directory, { recursive: true })
    const span = { start: 0, duration: 2 * SECOND }
    const card = projectOfTracks({ width: 320, height: 180 }, [...tracksBelow, [imageOf('image-red.png', 'red', span, at(160, 90, 0.5))]])
    const cardPath = join(directory, 'card.pbanim')
    writeFileSync(cardPath, serializeProject({ ...card, canvas: { ...card.canvas, frameRate: { num: 12, den: 1 } } }))
    const animation = { id: 'card', type: 'animation' as const, mediaId: 'card', ...span, sourceStart: 0, speedPercent: 100, volume: 1, transform: at(320, 180), opacity: 1 }
    const episode = projectOfTracks({ width: 640, height: 360 }, [[imageOf('image-white.png', 'ground', span, at(320, 180, 2))], [animation]])
    const media = episode.media.map((reference) => (reference.id === 'card' ? { ...reference, path: cardPath } : reference))
    const episodePath = join(directory, 'episode.json')
    writeFileSync(episodePath, serializeProject({ ...episode, media }))
    return { episodePath, cardPath }
  }

  function animationIn(path: string): Project {
    const parsed = parseProject(readFileSync(path, 'utf8'), 'animation')
    if (!parsed.ok) throw new Error(`${path} is not a valid animation: ${parsed.message}`)
    return parsed.project
  }

  it('opens an animation in place in frames, undoes inside it, saves its own file and creates a new one', async () => {
    const directory = join(scratch, 'animation-files')
    const { episodePath, cardPath } = writeEpisode(directory)
    const report = await uiTest('animation-files', ['--project', episodePath, '--out', directory])
    expect(report.inside).toEqual({ path: expect.stringContaining('card'), timecode: '0', duration: '/ 24', isTimingInFrames: true })
    expect(report.isEditedByAnimation).toBe(true)
    expect(report.newPath).toContain('new')

    const saved = animationIn(cardPath)
    expect(saved.tracks[0]?.clips[0]).toMatchObject({ id: 'red', opacity: 0.4 })
    const red = saved.media.find((reference) => reference.id === 'image-red.png')
    expect(resolve(dirname(cardPath), red?.relativePath ?? '')).toBe(RED_PATH)
    const created = animationIn(join(directory, 'new.pbanim'))
    expect(created).toMatchObject({ canvas: { width: 640, height: 360 }, tracks: [] })
  })

  it('moves a clipped child from the inside, draws a rectangle and a circle, and moves the rectangle', async () => {
    const directory = join(scratch, 'drawing-tools')
    const child = { id: 'pocket', nodes: [{ x: 270, y: 150 }, { x: 290, y: 150 }, { x: 290, y: 166 }, { x: 270, y: 166 }], isClosed: true as const, fill: '#0000FF' }
    const parent = { id: 'coat', nodes: [{ x: 250, y: 140 }, { x: 310, y: 140 }, { x: 310, y: 176 }, { x: 250, y: 176 }], isClosed: true as const, fill: '#FFFFFF', children: [child] }
    const coat: Clip = { id: 'coat', type: 'drawing', start: 0, duration: 2 * SECOND, shapes: [parent] }
    const { episodePath, cardPath } = writeEpisode(directory, [[coat]])
    const report = await uiTest('drawing-tools', ['--project', episodePath, '--out', directory])
    expect(report.tools).toEqual(['Move', 'Node', 'Pen', 'Fill', 'Rectangle', 'Ellipse', 'Colour picker'])

    // The card's 320x180 artboard sits in the middle of the 640x360 episode at full size; a pointer lands on whole screen pixels.
    const { preview } = report
    if (typeof preview !== 'object' || preview === null || !('width' in preview) || typeof preview.width !== 'number') throw new Error('The report has no preview size')
    const tolerance = (2 * 640) / preview.width
    const toArtboard = (shareX: number, shareY: number): { x: number; y: number } => ({ x: shareX * 640 - 160, y: shareY * 360 - 90 })
    const near = (actual: number | undefined, expected: number): boolean => actual !== undefined && Math.abs(actual - expected) < tolerance
    const drawings: Clip[] = []
    for (const track of animationIn(cardPath).tracks) {
      for (const clip of track.clips) {
        if (clip.type === 'drawing') drawings.push(clip)
      }
    }
    expect(drawings).toHaveLength(2)
    const [movedCoat, drawing] = drawings
    const [savedParent] = movedCoat?.type === 'drawing' ? movedCoat.shapes : []
    expect(savedParent?.nodes).toEqual(parent.nodes)
    const pocketCorner = savedParent?.children?.[0]?.nodes[0]
    expect(near(pocketCorner?.x, 270 - 0.05 * 640) && near(pocketCorner?.y, 150)).toBe(true)
    expect(drawing).toMatchObject({ start: 0, duration: SECOND })
    const [rectangle, circle] = drawing?.type === 'drawing' ? drawing.shapes : []
    const corner = toArtboard(0.3 + 0.05, 0.3)
    const opposite = toArtboard(0.45 + 0.05, 0.45)
    expect(rectangle?.nodes.map((node) => node.in === undefined && node.out === undefined)).toEqual([true, true, true, true])
    expect(near(rectangle?.nodes[0]?.x, corner.x) && near(rectangle?.nodes[0]?.y, corner.y)).toBe(true)
    expect(near(rectangle?.nodes[2]?.x, opposite.x) && near(rectangle?.nodes[2]?.y, opposite.y)).toBe(true)
    const across = (circle?.nodes[1]?.x ?? 0) - (circle?.nodes[3]?.x ?? 0)
    const down = (circle?.nodes[2]?.y ?? 0) - (circle?.nodes[0]?.y ?? 0)
    expect(across).toBeCloseTo(down, 6)
    expect(near(across, 0.15 * 640)).toBe(true)
  })

  // Back to front: Left, Coat with a pocket clipped inside, then Right.
  function shapesDrawing(): Clip {
    const square = (id: string, left: number, top: number, side: number, fill: string): DrawingShape => ({
      id,
      nodes: [
        { x: left, y: top },
        { x: left + side, y: top },
        { x: left + side, y: top + side },
        { x: left, y: top + side },
      ],
      isClosed: true,
      fill,
    })
    const pocket = square('pocket', 270, 150, 16, '#0000FF')
    const coat = { ...square('coat', 250, 140, 36, '#FFFFFF'), name: 'Coat', stroke: { color: '#FF0000', width: 2 }, children: [pocket] }
    const shapes = [{ ...square('left', 20, 20, 40, '#FF0000'), name: 'Left' }, coat, { ...square('right', 100, 20, 40, '#00FF00'), name: 'Right' }]
    return { id: 'sketch', type: 'drawing', start: 0, duration: 2 * SECOND, shapes }
  }

  function drawingsIn(path: string): DrawingClip[] {
    const drawings: DrawingClip[] = []
    for (const track of animationIn(path).tracks) {
      for (const clip of track.clips) {
        if (clip.type === 'drawing') drawings.push(clip)
      }
    }
    return drawings
  }

  it('lists the shapes of the drawing on an expanded track, and renames, hides, locks and reorders them there', async () => {
    const directory = join(scratch, 'shape-rows')
    const { episodePath, cardPath } = writeEpisode(directory, [[shapesDrawing()]])
    const report = await uiTest('shape-rows', ['--project', episodePath, '--out', directory])
    expect(report.rowsAtFirst).toEqual(['Right', 'Coat', 'Shape', 'Left'])
    expect(report.pickedWhereHidden).toBe('0')
    expect(report.pickedWhereLocked).toBe('0')
    expect(report.rowsAfter).toEqual(['Big coat', 'Shape', 'Left', 'Right'])

    const [sketch] = drawingsIn(cardPath)
    expect(sketch?.shapes.map((shape) => shape.id)).toEqual(['right', 'left', 'coat'])
    expect(sketch?.shapes[1]).toMatchObject({ name: 'Left', hidden: true })
    expect(sketch?.shapes[2]).toMatchObject({ name: 'Big coat', locked: true, children: [{ id: 'pocket' }] })
  })

  it('deletes, copies, pastes, duplicates, arranges and colours shapes, and draws in the colour last set', async () => {
    const directory = join(scratch, 'shape-edits')
    const { episodePath, cardPath } = writeEpisode(directory, [[shapesDrawing()]])
    const report = await uiTest('shape-edits', ['--project', episodePath, '--out', directory])
    expect(report.rowsWithCopies).toEqual(['Left', 'Left', 'Right', 'Coat', 'Shape', 'Left'])
    expect(report.notice).toBe('Shapes can only be pasted inside an animation.')

    const [sketch, drawn] = drawingsIn(cardPath)
    const ids = sketch?.shapes.map((shape) => shape.id) ?? []
    expect(ids.slice(0, 2)).toEqual(['coat', 'right'])
    expect(ids[3]).toBe('left')
    expect(ids.filter((id) => id !== 'left')).toHaveLength(4)
    const coat = sketch?.shapes[0]
    expect(coat?.fill).toBe('#336699')
    expect(coat?.stroke?.width).toBe(2)
    expect(partsOf(coat?.stroke?.color ?? '#000000').hue).toBeGreaterThan(100)
    expect(partsOf(coat?.stroke?.color ?? '#000000').hue).toBeLessThan(140)
    expect(drawn?.shapes).toEqual([expect.objectContaining({ name: 'Rectangle', fill: '#FF8800', stroke: { color: coat?.stroke?.color, width: 4, scalesWithObject: true } })])
  })

  it('fills shapes, picks colours off the canvas, and shares a colour that edits every shape using it', async () => {
    const directory = join(scratch, 'shape-paint')
    const { episodePath, cardPath } = writeEpisode(directory, [[shapesDrawing()]])
    const report = await uiTest('shape-paint', ['--project', episodePath, '--out', directory])
    expect(report).toEqual({ swatchName: 'Skin', coatFill: 'Fill #884400', isCoatLinked: true })

    const document = animationIn(cardPath)
    expect(document.swatches).toBeUndefined()
    const [sketch] = drawingsIn(cardPath)
    const [left, coat, right] = sketch?.shapes ?? []
    expect(left?.fill).toBe('#00AAFF')
    expect(coat).toMatchObject({ fill: '#884400', stroke: { color: '#00AAFF', width: 2 } })
    expect(coat?.children?.[0]?.fill).toBe('#00AAFF')
    expect(right?.fill).toBe('#884400')
    expect(JSON.stringify(sketch)).not.toContain('swatch')
  })

  it('styles strokes, draws without one, clips a shape inside another and duplicates a drawing', async () => {
    const directory = join(scratch, 'shape-strokes')
    const { episodePath, cardPath } = writeEpisode(directory, [[shapesDrawing()]])
    const report = await uiTest('shape-strokes', ['--project', episodePath, '--out', directory])
    expect(report.rows).toEqual(['Coat', 'Right', 'Shape', 'Left'])

    const [sketch, copy, drawn] = drawingsIn(cardPath)
    const coat = sketch?.shapes[1]
    expect(coat?.stroke).toEqual({ color: '#FF0000', width: 6, isDashed: true, cap: 'butt', align: 'outside', isBehind: true, scalesWithObject: true })
    expect(coat?.children?.map((child) => child.id)).toEqual(['pocket', 'right'])
    expect(sketch?.shapes.map((shape) => shape.id)).toEqual(['left', 'coat'])
    expect(copy).toMatchObject({ start: 2 * SECOND, duration: 2 * SECOND, shapes: sketch?.shapes })
    expect(drawn?.shapes).toEqual([expect.not.objectContaining({ stroke: expect.anything() })])
  })

  it('draws closed and open paths with the pen, each one undo step, filling open ones only when asked', async () => {
    const directory = join(scratch, 'pen-tool')
    const { episodePath, cardPath } = writeEpisode(directory, [[shapesDrawing()]])
    const report = await uiTest('pen-tool', ['--project', episodePath, '--out', directory])
    expect(report).toEqual({ nodesWhileDrawing: '4', isAnimationOpen: true })

    const paths: DrawingShape[] = []
    for (const drawing of drawingsIn(cardPath)) {
      for (const shape of drawing.shapes) {
        if (shape.name === 'Path') paths.push(shape)
      }
    }
    expect(paths).toHaveLength(3)
    const [closed, open, filled] = paths
    expect(closed).toMatchObject({ isClosed: true, fill: '#FFFFFF', stroke: { color: '#000000', width: 4 } })
    const [first, second, smooth, broken] = closed?.nodes ?? []
    expect(first?.in ?? first?.out).toBeUndefined()
    expect(second?.in ?? second?.out).toBeUndefined()
    expect(smooth?.out?.x).toBeGreaterThan(0)
    expect(smooth?.in?.x).toBeCloseTo(-(smooth?.out?.x ?? 0), 6)
    expect(smooth?.in?.y).toBeCloseTo(-(smooth?.out?.y ?? 0), 6)
    expect(broken?.in).toBeUndefined()
    expect(broken?.out?.y).toBeGreaterThan(0)
    expect(open?.nodes).toHaveLength(2)
    expect(open?.isClosed).toBeUndefined()
    expect(open?.fill).toBeUndefined()
    expect(open?.stroke).toBeDefined()
    expect(filled).toMatchObject({ fill: '#FFFFFF', stroke: { width: 4 } })
    expect(filled?.isClosed).toBeUndefined()
  })

  it('moves, boxes, nudges, smooths, adds, deletes, breaks and closes nodes with the node tool', async () => {
    const directory = join(scratch, 'node-tool')
    const { episodePath, cardPath } = writeEpisode(directory, [[shapesDrawing()]])
    const report = await uiTest('node-tool', ['--project', episodePath, '--out', directory])
    expect(report.timeAfter).toBe(report.timeBefore)
    expect(report.nodesAfterAdding).toBe(5)

    const [sketch] = drawingsIn(cardPath)
    const shapes = sketch?.shapes ?? []
    expect(shapes.map((shape) => shape.name)).toEqual(['Left', 'Left', 'Coat', 'Right'])
    const [left, leftPart, , right] = shapes
    expect(left?.isClosed).toBe(true)
    expect(left?.nodes.map((node) => ({ x: node.x, y: node.y }))).toEqual([
      { x: 20, y: 20 },
      { x: 60, y: 20 },
      { x: 60, y: 60 },
    ])
    expect(leftPart?.isClosed).toBeUndefined()
    expect(leftPart?.nodes.map((node) => ({ x: node.x, y: node.y }))).toEqual([
      { x: 60, y: 60 },
      { x: 20, y: 60 },
      { x: 20, y: 20 },
    ])

    const [moved, untouched, smooth, other] = right?.nodes ?? []
    expect(moved?.x).toBeLessThan(100)
    expect(moved?.y).toBeLessThan(20)
    expect(untouched).toEqual({ x: 140, y: 20 })
    expect(smooth).toMatchObject({ x: 141, y: 55 })
    expect(other).toMatchObject({ x: 101, y: 55 })
    const before = smooth?.in ?? { x: 0, y: 0 }
    const after = smooth?.out ?? { x: 0, y: 0 }
    const turn = Math.atan2(before.x * after.y - before.y * after.x, before.x * after.x + before.y * after.y)
    expect(Math.abs(turn)).toBeCloseTo(Math.PI, 6)
  })

  it('snaps nodes onto other nodes, the artboard edges and whole pixels, but not with ⌘', async () => {
    const directory = join(scratch, 'node-snapping')
    const { episodePath, cardPath } = writeEpisode(directory, [[shapesDrawing()]])
    const report = await uiTest('node-snapping', ['--project', episodePath, '--out', directory])
    const { previewWidth } = report
    if (typeof previewWidth !== 'number') throw new Error('The report has no preview width')
    const tolerance = (2 * 640) / previewWidth

    const [sketch] = drawingsIn(cardPath)
    const shapes = sketch?.shapes ?? []
    const right = shapes.find((shape) => shape.name === 'Right')
    const path = shapes.find((shape) => shape.name === 'Path')
    const rectangle = shapes.find((shape) => shape.name === 'Rectangle')
    const [onNode, onEdge, , unsnapped] = right?.nodes ?? []
    expect(onNode).toEqual({ x: 60, y: 20 })
    expect(onEdge?.y).toBe(0)
    expect(Number.isInteger(onEdge?.x)).toBe(true)
    expect(unsnapped).not.toEqual({ x: 60, y: 60 })
    expect(Math.abs((unsnapped?.x ?? 0) - 63)).toBeLessThan(tolerance)
    expect(Math.abs((unsnapped?.y ?? 0) - 62)).toBeLessThan(tolerance)

    expect(path?.nodes[0]).toEqual({ x: 20, y: 60 })
    expect(path?.nodes.map((node) => Number.isInteger(node.x) && Number.isInteger(node.y))).toEqual([true, true])
    const corners = rectangle?.nodes ?? []
    expect(corners.map((node) => Number.isInteger(node.x) && Number.isInteger(node.y))).toEqual([true, true, true, true])
    expect(corners[0]?.x).toBe(0)
    expect(corners[2]?.y).toBe(180)
    expect(Math.abs((corners[0]?.y ?? 0) - 150)).toBeLessThan(tolerance)
  })

  it('outlines the drawings around the playhead on the chosen track, fading with distance', async () => {
    const directory = join(scratch, 'onion-skin')
    const square = (left: number): DrawingShape => ({ id: 'square', nodes: [{ x: left, y: 60 }, { x: left + 40, y: 60 }, { x: left + 40, y: 100 }, { x: left, y: 100 }], isClosed: true, fill: '#00FF00' })
    const poses = [0, 1, 2, 3].map((index): Clip => ({ id: `pose-${index}`, type: 'drawing', start: (index * SECOND) / 2, duration: SECOND / 2, shapes: [square(20 + 70 * index)] }))
    const { episodePath } = writeEpisode(directory, [poses])
    const report = await uiTest('onion-skin', ['--project', episodePath, '--out', directory])
    expect(report.outlines).toHaveLength(3)
    expect(report.outlines).toEqual(
      expect.arrayContaining([
        { testId: 'onion-before-0', opacity: '0.6' },
        { testId: 'onion-before-1', opacity: '0.3' },
        { testId: 'onion-after-0', opacity: '0.6' },
      ]),
    )
  })

  it('keys a node, moves it between keys, eases, copies and pastes its keys, and drags them on its shape row', async () => {
    const directory = join(scratch, 'node-keys')
    const { episodePath, cardPath } = writeEpisode(directory, [[shapesDrawing()]])
    await uiTest('node-keys', ['--project', episodePath, '--out', directory])

    const [sketch] = drawingsIn(cardPath)
    const right = sketch?.shapes.find((shape) => shape.name === 'Right')
    const [unkeyed, keyed] = right?.nodes ?? []
    expect(unkeyed?.keyframes).toBeUndefined()
    expect(unkeyed?.x).toBe(100)
    expect(unkeyed?.y).toBeLessThan(20)
    expect(keyed).toMatchObject({ x: 140, y: 20 })
    const across = keyed?.keyframes?.x ?? []
    expect(across.map((key) => key.time)).toEqual([0, SECOND, (7 * SECOND) / 4])
    const [rest, moved, pasted] = across
    expect(rest).toMatchObject({ value: 0, easing: 'linear' })
    expect(moved?.value).toBeGreaterThan(10)
    expect(moved?.easing).toBe('easeIn')
    expect(pasted).toEqual({ ...moved, time: (7 * SECOND) / 4 })
    expect(keyed?.keyframes?.y?.map((key) => key.value)).toEqual([0, 0, 0])
  })

  it('saves a node set, turns it with keys, moves it and its pivot, and outlines it at the previous key', async () => {
    const directory = join(scratch, 'node-sets')
    const { episodePath, cardPath } = writeEpisode(directory, [[shapesDrawing()]])
    const report = await uiTest('node-sets', ['--project', episodePath, '--out', directory])
    expect(report.isGhostShownAtFirstKey).toBe(false)
    const { previewWidth } = report
    if (typeof previewWidth !== 'number') throw new Error('The report has no preview width')
    const artboardPerPixel = 640 / previewWidth

    const [sketch] = drawingsIn(cardPath)
    const [arm] = sketch?.nodeSets ?? []
    expect(arm?.name).toBe('Arm')
    const right = sketch?.shapes.find((shape) => shape.name === 'Right')
    expect(right?.nodes.map((node) => node.sets)).toEqual([[arm?.id], [arm?.id], [arm?.id], [arm?.id]])
    expect(right?.nodes.map((node) => ({ x: node.x, y: node.y }))).toEqual([
      { x: 100, y: 20 },
      { x: 140, y: 20 },
      { x: 140, y: 60 },
      { x: 100, y: 60 },
    ])
    const [firstTurn, secondTurn] = arm?.keyframes?.rotation ?? []
    expect(firstTurn?.time).toBe(0)
    expect(Math.abs((firstTurn?.value ?? 0) - 45)).toBeLessThan(5)
    expect(secondTurn).toMatchObject({ time: SECOND, value: 90 })
    expect(arm?.keyframes?.x?.map((key) => key.time)).toEqual([SECOND])
    expect(arm?.keyframes?.x?.[0]?.value).toBeGreaterThan(10)
    expect(arm?.keyframes?.y?.map((key) => key.value)).toEqual([0])
    const pivotShift = 50 * artboardPerPixel
    expect(Math.abs((arm?.pivot.x ?? 0) - (120 - pivotShift))).toBeLessThan(2 * artboardPerPixel)
    expect(Math.abs((arm?.pivot.y ?? 0) - (40 + pivotShift))).toBeLessThan(2 * artboardPerPixel)
  })

  it('makes a shape follow a set and gives a set a parent, so both turn with the parent', async () => {
    const directory = join(scratch, 'follow-and-parent')
    const { episodePath, cardPath } = writeEpisode(directory, [[shapesDrawing()]])
    const report = await uiTest('follow-and-parent', ['--project', episodePath, '--out', directory])
    const { previewWidth } = report
    if (typeof previewWidth !== 'number') throw new Error('The report has no preview width')
    const pixelsPerArtboard = previewWidth / 640

    const [sketch] = drawingsIn(cardPath)
    const [right, left] = sketch?.nodeSets ?? []
    expect(right).toMatchObject({ name: 'Set 1', keyframes: { rotation: [{ time: 0, value: -30 }] } })
    expect(left).toMatchObject({ name: 'Set 2', parent: right?.id })
    expect(sketch?.shapes.find((shape) => shape.name === 'Left')?.follows).toBe(right?.id)

    // Set 1 turns around the middle of Right, at 120,40.
    function shiftOnTurn(point: Point): Point {
      const angle = -30 * (Math.PI / 180)
      const offsetX = point.x - 120
      const offsetY = point.y - 40
      return { x: 120 + offsetX * Math.cos(angle) - offsetY * Math.sin(angle) - point.x, y: 40 + offsetX * Math.sin(angle) + offsetY * Math.cos(angle) - point.y }
    }

    function expectMoved(before: unknown, after: unknown, shift: Point): void {
      if (!isPoint(before) || !isPoint(after)) throw new Error('The report has no points')
      expect(Math.abs(after.x - before.x - shift.x * pixelsPerArtboard)).toBeLessThan(2)
      expect(Math.abs(after.y - before.y - shift.y * pixelsPerArtboard)).toBeLessThan(2)
    }

    expectMoved(report.pivotBefore, report.pivotAfter, shiftOnTurn({ x: 40, y: 40 }))
    expectMoved(report.cornerBefore, report.cornerAfter, shiftOnTurn({ x: 20, y: 20 }))
  })

  it('keys a shape in the Transform group and records the box turning and growing it as keys on its own set', async () => {
    const directory = join(scratch, 'shape-keys')
    const { episodePath, cardPath } = writeEpisode(directory, [[shapesDrawing()]])
    const report = await uiTest('shape-keys', ['--project', episodePath, '--out', directory])
    expect(report.hasSideHandles).toBe(false)

    const [sketch] = drawingsIn(cardPath)
    const right = sketch?.shapes.find((shape) => shape.name === 'Right')
    expect(right?.ownsSet).toBe(true)
    expect(right?.nodes.map((node) => node.x)).toEqual([100, 140, 140, 100])
    const own = sketch?.nodeSets?.find((set) => set.id === right?.follows)
    expect(own).toMatchObject({ name: 'Right', pivot: { x: 120, y: 40 } })
    const [rest, turned] = own?.keyframes?.rotation ?? []
    expect(rest).toMatchObject({ time: 0, value: 0 })
    expect(turned?.time).toBe(SECOND)
    expect(Math.abs((turned?.value ?? 0) - 90)).toBeLessThan(2)
    const [grown] = own?.keyframes?.scale ?? []
    expect(grown?.time).toBe(SECOND)
    expect(grown?.value).toBeGreaterThan(1.2)
  })

  const TWELFTH = SECOND / 12
  const MOUTH_FRAMES = 6

  function mouthSquare(frame: number): DrawingShape {
    const left = 20 + 40 * frame
    const side = 30
    return { id: 'mouth', nodes: [{ x: left, y: 70 }, { x: left + side, y: 70 }, { x: left + side, y: 70 + side }, { x: left, y: 70 + side }], isClosed: true, fill: '#FF0000' }
  }

  function animationFile(path: string, clips: Clip[], settings: Partial<Project> = {}): string {
    const project = projectOfTracks({ width: 320, height: 180 }, [clips])
    const media = project.media.map((reference) => ({ ...reference, path: join(dirname(path), `${reference.id}.pbanim`) }))
    writeFileSync(path, serializeProject({ ...project, media, canvas: { ...project.canvas, frameRate: { num: 12, den: 1 } }, ...settings }))
    return path
  }

  function writeMouths(directory: string): string {
    mkdirSync(directory, { recursive: true })
    const clips: Clip[] = []
    for (let frame = 0; frame < MOUTH_FRAMES; frame++) clips.push({ id: `frame-${frame}`, type: 'drawing', start: frame * TWELFTH, duration: TWELFTH, shapes: [mouthSquare(frame)] })
    return animationFile(join(directory, 'mouths.pbanim'), clips)
  }

  function writeEpisodeOf(directory: string, tracks: Clip[][]): string {
    const episode = projectOfTracks({ width: 640, height: 360 }, tracks)
    const media = episode.media.map((reference) => (reference.id.startsWith('image-') ? reference : { ...reference, path: join(directory, `${reference.id}.pbanim`) }))
    const episodePath = join(directory, 'episode.json')
    writeFileSync(episodePath, serializeProject({ ...episode, media }))
    return episodePath
  }

  function episodeIn(path: string): Project {
    const parsed = parseProject(readFileSync(path, 'utf8'))
    if (!parsed.ok) throw new Error(`${path} is not a valid project: ${parsed.message}`)
    return parsed.project
  }

  const GROUND_SPAN = { start: 0, duration: 3 * SECOND }

  it('holds a frame of an animation, stays free of its length, and swaps it with Split and a new pick', async () => {
    const directory = join(scratch, 'hold-frame')
    writeMouths(directory)
    const episodePath = writeEpisodeOf(directory, [[imageOf('image-white.png', 'ground', GROUND_SPAN, at(320, 180, 2))], [animationOf('mouths', 'lips', { start: 0, duration: MOUTH_FRAMES * TWELFTH }, at(320, 180))]])
    const report = await uiTest('hold-frame', ['--project', episodePath, '--out', directory])
    expect(report.isSpeedShownWhileHeld).toBe(false)
    expect(report.isSpeedShownWhenPlayed).toBe(true)
    expect(Number(report.playedDuration)).toBeCloseTo(0.5)

    const [lips, later] = episodeIn(episodePath).tracks[1]?.clips ?? []
    expect(lips).toMatchObject({ start: 0, duration: SECOND, heldTime: 3 * TWELFTH })
    expect(later).toMatchObject({ start: SECOND, duration: SECOND, heldTime: 5 * TWELFTH, sourceStart: 0 })
  })

  it('opens a shared part held inside a character, reaches all its frames and saves to its own file for every character', async () => {
    const directory = join(scratch, 'shared-parts')
    const mouthsPath = writeMouths(directory)
    const characterClip = (heldFrame: number): Clip => animationOf('mouths', 'lips', { start: 0, duration: SECOND }, at(160, 90), { heldTime: heldFrame * TWELFTH })
    const kentaPath = animationFile(join(directory, 'kenta.pbanim'), [characterClip(2)])
    const bobPath = animationFile(join(directory, 'bob.pbanim'), [characterClip(4)])
    const kentaBefore = readFileSync(kentaPath, 'utf8')
    const bobBefore = readFileSync(bobPath, 'utf8')
    const episodePath = writeEpisodeOf(directory, [
      [imageOf('image-white.png', 'ground', GROUND_SPAN, at(320, 180, 2))],
      [animationOf('kenta', 'kenta-clip', { start: SECOND, duration: SECOND }, at(160, 180))],
      [animationOf('bob', 'bob-clip', { start: 0, duration: 2 * SECOND }, at(480, 180), { loop: true })],
    ])
    const report = await uiTest('shared-parts', ['--project', episodePath, '--out', directory])
    expect(report.path).toContain('kenta')
    expect(report.path).toContain('mouths')
    expect(report.duration).toBe(`/ ${MOUTH_FRAMES}`)

    expect(readFileSync(kentaPath, 'utf8')).toBe(kentaBefore)
    expect(readFileSync(bobPath, 'utf8')).toBe(bobBefore)
    const drawings = drawingsIn(mouthsPath)
    const moved = drawings[4]?.shapes[0]?.nodes[0]?.x ?? 0
    expect(Math.abs(moved - (180 + 40))).toBeLessThanOrEqual(2)
    expect(drawings[3]?.shapes[0]?.nodes[0]?.x).toBe(140)

    const [bobFrame] = await renderFrames(episodePath, { via: 'export', frames: [0] })
    if (bobFrame === undefined) throw new Error('The frame was not rendered')
    expect(pixelAt(bobFrame, 320 + 195, 90 + 85)).toMatchObject({ red: 255, green: 255, blue: 255 })
    expect(pixelAt(bobFrame, 320 + 235, 90 + 85)).toMatchObject({ red: 255, green: 0, blue: 0 })
  })

  function firstNodeX(text: string): number | undefined {
    const parsed = parseProject(text, 'animation')
    const [frame] = parsed.ok ? (parsed.project.tracks[0]?.clips ?? []) : []
    return frame?.type === 'drawing' ? frame.shapes[0]?.nodes[0]?.x : undefined
  }

  it('makes one clip of an animation unique from what is on screen, undoes it and keeps the file', async () => {
    const directory = join(scratch, 'make-unique')
    writeMouths(directory)
    const span = { start: 0, duration: MOUTH_FRAMES * TWELFTH }
    const episodePath = writeEpisodeOf(directory, [[imageOf('image-white.png', 'ground', GROUND_SPAN, at(320, 180, 2))], [animationOf('mouths', 'lips', span, at(160, 180))], [animationOf('mouths', 'other-lips', span, at(480, 180))]])
    const report = await uiTest('make-unique', ['--project', episodePath, '--out', directory])
    expect(report.isCopyKeptAfterUndo).toBe(true)
    expect(firstNodeX(String(report.originalAtFirst))).toBe(20)
    expect(Math.abs((firstNodeX(String(report.copyAtFirst)) ?? 0) - 40)).toBeLessThanOrEqual(2)

    const saved = episodeIn(episodePath)
    const fileOf = (trackIndex: number): string | undefined => {
      const clip = saved.tracks[trackIndex]?.clips[0]
      const mediaId = clip?.type === 'animation' ? clip.mediaId : undefined
      return saved.media.find((reference) => reference.id === mediaId)?.relativePath
    }
    expect(fileOf(1)).toBe('mouths 2.pbanim')
    expect(fileOf(2)).toBe('mouths 3.pbanim')
    expect(statSync(join(directory, 'mouths 3.pbanim')).isFile()).toBe(true)
  })

  it('takes in an animation changed on disk or by another window, and asks when this window has unsaved changes to it', async () => {
    const directory = join(scratch, 'animation-reload')
    const mouthsPath = writeMouths(directory)
    const episodePath = writeEpisodeOf(directory, [[imageOf('image-white.png', 'ground', GROUND_SPAN, at(320, 180, 2))], [animationOf('mouths', 'lips', { start: 0, duration: MOUTH_FRAMES * TWELFTH }, at(320, 180))]])
    const report = await uiTest('animation-reload', ['--project', episodePath, '--out', directory])
    expect(report.isEditedAfterReload).toBe(false)
    expect(report.afterKeepingMine).toBe('/ 7')
    expect(report.undoAfterKeepingMine).toBe('Undo Move Shape')
    expect(report.isEditedAfterKeepingMine).toBe(true)
    expect(report.undoAfterUsingSaved).not.toBe('Undo Move Shape')
    expect(report.afterBrokenFile).toBe('/ 9')
    expect(report.isFirstWindowEdited).toBe(false)
    expect(drawingsIn(mouthsPath)).toHaveLength(10)
  })

  it('pastes shapes and drawings into another animation with their node sets and shared colours', async () => {
    const directory = join(scratch, 'paste-between')
    mkdirSync(directory, { recursive: true })
    const skin = { id: 'skin', name: 'Skin', color: '#FFCC99' }
    const turn = [{ time: 0, value: 0, easing: 'linear' as const }, { time: SECOND, value: 45, easing: 'linear' as const }]
    const nodeSets = [{ id: 'body', name: 'Body', pivot: { x: 0, y: 0 } }, { id: 'arm', name: 'Arm', pivot: { x: 35, y: 85 }, parent: 'body', keyframes: { rotation: turn } }]
    const hand: DrawingShape = { ...mouthSquare(0), id: 'hand', name: 'Hand', fill: '#FFCC99', fillSwatch: 'skin', follows: 'arm' }
    animationFile(join(directory, 'first.pbanim'), [{ id: 'pose', type: 'drawing', start: 0, duration: SECOND, shapes: [hand], nodeSets }], { swatches: [skin] })
    const secondPath = animationFile(join(directory, 'second.pbanim'), [{ id: 'theirs', type: 'drawing', start: 0, duration: SECOND, shapes: [{ ...mouthSquare(5), id: 'their-shape' }] }])
    const span = { start: 0, duration: SECOND }
    const episodePath = writeEpisodeOf(directory, [[imageOf('image-white.png', 'ground', GROUND_SPAN, at(320, 180, 2))], [animationOf('first', 'first-clip', span, at(160, 180))], [animationOf('second', 'second-clip', span, at(480, 180))]])
    await uiTest('paste-between', ['--project', episodePath, '--out', directory])

    expect(animationIn(secondPath).swatches).toEqual([skin])
    const drawings = drawingsIn(secondPath)
    expect(drawings).toHaveLength(2)
    const theirs = drawings.find((drawing) => drawing.id === 'theirs')
    expect(theirs?.shapes.map((shape) => shape.name)).toEqual([undefined, 'Hand'])
    expect(theirs?.shapes[1]).toMatchObject({ follows: 'arm', fillSwatch: 'skin', fill: '#FFCC99' })
    expect(theirs?.nodeSets?.map((set) => set.id).sort()).toEqual(['arm', 'body'])
    expect(theirs?.nodeSets?.find((set) => set.id === 'arm')?.keyframes?.rotation).toEqual(turn)
    const pastedDrawing = drawings.find((drawing) => drawing.id !== 'theirs')
    expect(pastedDrawing?.shapes[0]).toMatchObject({ follows: 'arm', fillSwatch: 'skin' })
    expect(pastedDrawing?.nodeSets).toEqual(nodeSets)
  })

  it('restores an unsaved animation after the editor was killed', async () => {
    const directory = join(scratch, 'animation-crash')
    const { episodePath, cardPath } = writeEpisode(directory)
    const profile = join(directory, 'profile')
    mkdirSync(profile, { recursive: true })
    const crashed = await runApp(['--uitest', 'animation-crash', '--project', episodePath], 120_000, profile)
    expect(crashed.exitCode).not.toBe(0)
    expect(animationIn(cardPath).tracks[0]?.clips[0]).toMatchObject({ opacity: 1 })

    await uiTest('animation-restore', [], profile)
    expect(animationIn(cardPath).tracks[0]?.clips[0]).toMatchObject({ opacity: 0.4 })
  })
})

describe('groups', () => {
  it('groups clips, changes a member from the inside, ungroups, and undoes it all', async () => {
    const original = projectPath('02-mosaic')
    const report = await uiTest('groups', ['--project', original, '--out', join(scratch, 'groups')])

    const grouped = projectIn(report, 'grouped')
    expect(grouped.tracks.map((track) => track.clips.length)).toEqual([0, 0, 0, 1])
    const group = grouped.tracks[3]?.clips[0]
    expect(group).toMatchObject({ type: 'group', start: 0, duration: 2 * SECOND, transform: { x: 320, y: 180, scaleX: 1, scaleY: 1, rotation: 0 } })
    if (group?.type !== 'group') throw new Error('There is no group')
    expect(group.tracks.map((track) => track.clips.map((clip) => clip.id))).toEqual([['a'], ['b'], ['c'], ['d']])
    expect(group.tracks[0]?.clips[0]).toMatchObject({ transform: { x: -160, y: -90 } })

    const moved = projectIn(report, 'moved').tracks[3]?.clips[0]
    expect(moved).toMatchObject({ transform: { scaleX: 0.5, scaleY: 0.5 } })
    expect(moved?.type === 'group' && Math.abs(moved.transform.x - 360)).toBeLessThanOrEqual(2)
    expect(moved?.type === 'group' && Math.abs(moved.transform.y - 200)).toBeLessThanOrEqual(2)

    expect(report.tracksInside).toBe(4)
    expect(report.isCameraToolOff).toBe(true)
    const inside = projectIn(report, 'inside').tracks[3]?.clips[0]
    if (inside?.type !== 'group') throw new Error('There is no group')
    expect(inside.tracks[3]?.clips[0]).toMatchObject({ id: 'd', opacity: 0.4 })
    const dragged = inside.tracks[0]?.clips[0]
    expect(dragged?.type === 'video' && Math.abs(dragged.transform.x + 120)).toBeLessThanOrEqual(4)
    expect(dragged?.type === 'video' && Math.abs(inside.transform.y + dragged.transform.y / 2 - 180)).toBeLessThanOrEqual(0.01)

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
    expect(report.cursorOverLine).toBe('ns-resize')
    expect(Math.abs(Number(report.lineVolume) - 50)).toBeLessThanOrEqual(3)
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
    const [kept] = projectIn(report, 'deleted').tracks[0]?.clips[0]?.keyframes?.volume ?? []
    expect(projectIn(report, 'deleted').tracks[0]?.clips[0]?.keyframes?.volume).toHaveLength(1)

    const added = projectIn(report, 'pointAdded').tracks[0]?.clips[0]?.keyframes?.volume ?? []
    expect(added.map((keyframe) => keyframe.time)).toEqual([SECOND / 2, kept?.time])
    expect(added[0]?.value).toBeCloseTo(kept?.value ?? 0, 5)
    const lowered = projectIn(report, 'lineDragged').tracks[0]?.clips[0]?.keyframes?.volume ?? []
    expect(lowered[0]?.value).toBeCloseTo((kept?.value ?? 0) - 0.5, 1)
    expect(lowered[1]?.value).toBeCloseTo(lowered[0]?.value ?? 0, 5)

    expect(report.offersFastSoundAtFirst).toBe(false)
    expect(projectIn(report, 'fast').tracks[0]?.clips[0]).toMatchObject({ speedPercent: 800, changesPitch: true, hasFastSound: true })
  })
})

describe('canvas size', () => {
  it('rescales every clip with the canvas', async () => {
    const report = await uiTest('canvas-size', ['--project', projectPath('02-mosaic'), '--out', join(scratch, 'canvas-size')])
    const transforms = (stage: string): Transform[] => projectIn(report, stage).tracks.map((track) => {
      const [clip] = track.clips
      if (clip === undefined || !('transform' in clip)) throw new Error(`Track ${track.id} has no visual clip`)
      return clip.transform
    })

    const doubled = projectIn(report, 'doubled')
    expect(doubled.canvas).toMatchObject({ width: 1280, height: 720 })
    const rounded = (transform: Transform): number[] => [transform.x, transform.y, transform.scaleX, transform.scaleY].map((value) => Math.round(value * 1000) / 1000)
    const doubledBefore = transforms('before').map((transform) => rounded({ ...transform, x: transform.x * 2, y: transform.y * 2, scaleX: transform.scaleX * 2, scaleY: transform.scaleY * 2 }))
    expect(transforms('doubled').map(rounded)).toEqual(doubledBefore)
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
    expect(report.isUnchangedByClick).toBe(true)
    const border = { type: 'border', width: 2, color: '#ffffff' }
    expect(effectsOf('bordered')).toEqual([[border], [border], [], []])
    expect(report.hintForTwo).toBe('Select one clip to change its effects.')

    expect(report.heldOverTimeline).toMatchObject({ kind: 'effect', clipIds: ['c'], effect: 'dropShadow' })
    expect(report.undoWhileHeld).toBe('Undo Add Effect')
    expect(effectsOf('dropped')).toMatchObject([[border], [border], [{ type: 'dropShadow', offsetX: 4, opacity: 0.5 }], [{ type: 'colorAdjust', saturation: 0 }]])

    expect(effectsOf('changed')[3]).toEqual([{ type: 'border', width: 12, color: '#ffffff', isOff: true }, { type: 'colorAdjust', brightness: 0, contrast: 0, saturation: -1 }])
    expect(effectsOf('keyed')[3]).toMatchObject([{ type: 'border' }, { type: 'colorAdjust' }, { type: 'chromaKey', color: '#123456', tolerance: 0.4 }])
    expect(JSON.stringify(effectsOf('keyed')[3])).toContain('"chromaKey"')
    expect(effectsOf('removed')[3]).toMatchObject([{ type: 'colorAdjust' }, { type: 'chromaKey' }])

    expect(effectsOf('graded')[3]).toMatchObject([{ type: 'colorAdjust' }, { type: 'chromaKey' }, { type: 'look', strength: 1, contrast: 0.15, shadowAmount: 0.35, highlightAmount: 0.3 }])
    expect(report.lookAfterEdit).toContain('Custom')
    expect(report.lookAfterUndo).toContain('Cinematic')
  })
})

describe('transitions', () => {
  it('drops transitions on a cut and on free ends, sets their length by the grip and changes them in Properties', async () => {
    const report = await uiTest('transitions', ['--project', projectPath('export-check'), '--out', join(scratch, 'transitions')])
    const clipsAt = (stage: string): unknown[] => projectIn(report, stage).tracks[0]?.clips ?? []

    expect(report.heldOnCut).toMatchObject({ kind: 'transition', target: { clipId: 'second', edge: 'in' }, type: 'crossDissolve' })
    expect(report.isUnchangedWhileHeld).toBe(true)
    expect(report.isUnchangedAfterEscape).toBe(true)
    expect(report.isUnchangedByClick).toBe(true)
    expect(clipsAt('onCut')[1]).toMatchObject({ id: 'second', transitionIn: { type: 'crossDissolve', duration: SECOND } })

    expect(clipsAt('shortened')[1]).toMatchObject({ transitionIn: { type: 'crossDissolve', duration: 0.4 * SECOND } })
    expect(report.gripSamples).toBeGreaterThan(3)
    expect(report.gripToFrameP95).toBeLessThanOrEqual(MAX_CANVAS_FOLLOW_MS)

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

    const [drawn] = zoomsAt('drawn')
    expect(drawn).toMatchObject({ time: SECOND, duration: SECOND, easing: 'easeInOut' })
    expect(near(drawn?.scale, 2, 0.02) && near(drawn?.x, 320, 2) && near(drawn?.y, 180, 2)).toBe(true)
    expect(report.frameSamples).toBeGreaterThan(3)
    expect(report.frameToFrameP95).toBeLessThanOrEqual(MAX_CANVAS_FOLLOW_MS)

    const [moved] = zoomsAt('movedFrame')
    expect(near(moved?.x, 400, 2) && near(moved?.y, 220, 2) && near(moved?.scale, 2, 0.02)).toBe(true)
    const [shaped] = zoomsAt('shaped')
    expect(near(shaped?.scale, 640 / 240, 0.05) && near(shaped?.x, 360, 3) && near(shaped?.y, 197.5, 3)).toBe(true)

    expect(zoomsAt('withFull')).toHaveLength(2)
    expect(zoomsAt('withFull')[1]).toMatchObject({ time: 1.5 * SECOND, x: 320, y: 180, scale: 1 })

    expect(zoomsAt('onLane')[0]).toMatchObject({ time: 0.8 * SECOND, duration: 0.4 * SECOND })
    expect(zoomsAt('viaProperties')[0]).toMatchObject({ time: 0.8 * SECOND, duration: SECOND / 2, easing: 'linear' })
    expect(zoomsAt('afterDelete').map((zoom) => zoom.time)).toEqual([0.8 * SECOND])

    const clip = projectIn(report, 'moved').tracks[0]?.clips[0]
    const expected = 320 + (Number(report.pulled) * Number(report.canvasPerPixel)) / (zoomsAt('moved')[0]?.scale ?? 1)
    expect(clip?.type === 'video' && near(clip.transform.x, expected, 1.5)).toBe(true)

    expect(zoomsAt('menuEased')[0]).toMatchObject({ time: 0.8 * SECOND, easing: 'hold' })
    expect(zoomsAt('menuDeleted')).toEqual([])
  })
})

describe('keyframes and the motion path', () => {
  it('keys sets of fields in Properties, keys a moved clip, drags a dot of its path and walks between keyframes', async () => {
    const report = await uiTest('keyframes', ['--project', projectPath('01-single-clip'), '--out', join(scratch, 'keyframes')])
    type Keyed = { time: number; value: number; easing: string }
    const keyframesAt = (stage: string): Partial<Record<string, Keyed[]>> => projectIn(report, stage).tracks[0]?.clips[0]?.keyframes ?? {}
    const near = (value: number | undefined, expected: number): boolean => value !== undefined && Math.abs(value - expected) <= 2

    expect(keyframesAt('keyed')).toEqual({ x: [{ time: 0, value: 320, easing: 'linear' }], y: [{ time: 0, value: 180, easing: 'linear' }] })
    expect(report.isPositionPressed).toBe(true)

    const moved = keyframesAt('moved')
    expect(moved.x?.map((keyframe) => keyframe.time)).toEqual([0, SECOND])
    expect(moved.y?.map((keyframe) => keyframe.time)).toEqual([0, SECOND])
    expect(near(moved.x?.[1]?.value, 420) && near(moved.y?.[1]?.value, 230)).toBe(true)
    expect(projectIn(report, 'moved').tracks[0]?.clips[0]).toMatchObject({ transform: { x: 320, y: 180 } })

    const dotMoved = keyframesAt('dotMoved')
    expect(near(dotMoved.x?.[0]?.value, 200) && near(dotMoved.y?.[0]?.value, 120)).toBe(true)
    expect(dotMoved.x?.[1]).toEqual(moved.x?.[1])
    expect(dotMoved.y?.[1]).toEqual(moved.y?.[1])

    expect(report.isSizePressed).toBe(true)
    expect(keyframesAt('sized')).toMatchObject({ scaleX: [{ time: SECOND, value: 2 }], scaleY: [{ time: SECOND, value: 2 }] })

    const typed = keyframesAt('typed')
    expect(typed.x?.[2]).toEqual({ time: 1.5 * SECOND, value: 500, easing: 'linear' })
    expect(typed.y?.[2]).toEqual({ time: 1.5 * SECOND, value: moved.y?.[1]?.value, easing: 'linear' })
    const removed = keyframesAt('removed')
    expect(removed.x?.map((keyframe) => keyframe.time)).toEqual([0, SECOND])
    expect(removed.y?.map((keyframe) => keyframe.time)).toEqual([0, SECOND])

    expect(report.jumpedTo).toBe(SECOND)
    expect(report.snappedToKeyframe).toBe(SECOND)
    expect(report.snappedToEnd).toBe(2 * SECOND - FRAME)
    expect(report.freeOfSnapping).toBeGreaterThan(SECOND)
  })
})

describe('animated images', () => {
  it('imports a GIF as a looping image clip that stretches past its own length', async () => {
    const report = await uiTest('animated', ['--media', MEDIA_DIRECTORY, '--out', join(scratch, 'animated')])

    const placed = projectIn(report, 'placed')
    expect(placed.canvas).toEqual({ width: 214, height: 120, frameRate: { num: 30, den: 1 } })
    expect(placed.tracks[0]?.clips[0]).toMatchObject({ type: 'video', loop: true, start: 0, duration: 5 * SECOND })
    expect(projectIn(report, 'stretched').tracks[0]?.clips[0]).toMatchObject({ loop: true, duration: 8 * SECOND })

    const once = projectIn(report, 'once').tracks[0]?.clips[0]
    expect(once).toMatchObject({ duration: 1.2 * SECOND })
    expect(once).not.toHaveProperty('loop')
    expect(report.isLoopingAfterUndo).toBe(true)
  })
})

describe('missing media', () => {
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

describe('canvas zoom and preview mode', () => {
  it('shows the canvas at each zoom, pinches it, and previews it with only the canvas and the transport', async () => {
    const report = await uiTest('preview', ['--project', projectPath('01-single-clip'), '--out', join(scratch, 'preview')])
    expect(report.widths).toEqual({ '50': 320, '100': 640, '200': 1280 })
    expect(report.renderingAt200).toBe('pixelated')
    expect(Number(report.pinchedZoom)).toBe(122)

    const everything = { left: true, right: true, timeline: true, overlay: true, zoomTool: true }
    expect(report.shownInPreview).toEqual({ left: false, right: false, timeline: false, overlay: false, zoomTool: false })
    expect(report.shownAfterEscape).toEqual(everything)
    expect(Math.abs(framesOf(report.timecodeAfterSeek) - FRAMES_PER_SECOND)).toBeLessThanOrEqual(2)
  })
})

describe('keyboard shortcuts', () => {
  it('rebinds keys in Settings, refuses fixed ones, flags shared ones and restores the defaults', async () => {
    const report = await uiTest('shortcuts', ['--project', projectPath('01-single-clip'), '--out', join(scratch, 'shortcuts')])
    expect(report.splitHint).toContain('(S)')
    expect(report.refusalText).toBe('⌘S belongs to Save.')
    expect(report.isOpenAfterEscape).toBe(true)
    expect(report.conflicts).toEqual({ group: 'Also Stop', stop: 'Also Group' })
    expect(projectIn(report, 'split').tracks[0]?.clips.map((clip) => clip.duration)).toEqual([SECOND, SECOND])
    expect(report.conflictsAfterDefaults).toBe(0)
  })
})

describe('several windows', () => {
  it('keeps each project to its window, shares the media, and runs one export at a time', async () => {
    const report = await uiTest('windows', ['--project', projectPath('02-mosaic'), '--media', MEDIA_DIRECTORY, '--out', join(scratch, 'windows')])
    expect(report.titles).toEqual({ first: '02-mosaic.json', other: '01-single-clip.json' })
    expect(report.first).toEqual({ width: '640', isEdited: false })
    expect(report.refusal).toBe('Another export is already running.')
    expect(report.isFirstRunning).toBe(true)
    expect(report.windows).toBe(2)
  })
})

describe('export dialog', () => {
  it('exports from the dialog with every option, holds the window meanwhile, and cancels cleanly', async () => {
    const report = await uiTest('export', ['--project', projectPath('05-fades'), '--out', join(scratch, 'export')])

    expect(report.defaultPreset).toBe('360p')
    expect(report.summaryAtOpen).toBe('MP4, 640x360, 3s long')
    expect(report.canChooseSelection).toBe(false)

    const controls = ['export-preset', 'export-frame-rate', 'export-quality-low', 'export-quality-medium', 'export-quality-high', 'export-range-whole', 'export-audio', 'export-cancel-dialog', 'export-start', 'export-format']
    expect(report.tabStops).toEqual([...controls, ...controls.slice(0, 3)])
    expect(report.isDialogOpenAfterListEscape).toBe(true)

    const range = await probeExport(String(report.range))
    expect(range.video).toMatchObject({ codec_name: 'h264', width: '426', height: '240', r_frame_rate: '25/1', nb_frames: '50' })
    expect(range.audio).toEqual({})
    expect(Math.abs(range.duration - 2)).toBeLessThan(0.05)

    expect(report.canShowInFinder).toBe(true)
    expect(report.focusOnResult).toBe('export-done')
    expect(report.behindResult).toEqual({ undoLabel: 'Undo', selectedStart: '1.000' })

    expect(report.rememberedPreset).toBe('240p')
    expect(report.progressText).toMatch(/^Frame \d+ of 90/)
    expect(report.focusWhileRunning).toBe('export-progress-dialog')
    expect(report.whileRunning).toEqual({ undoLabel: 'Undo Change Opacity', selectedStart: '1.000', notice: '', hasPlayheadMoved: false, isStillRunning: true })
    expect(report.resultsClosedByKeys).toEqual(['Exported "whole-low.mp4"', 'Exported "whole-high.mp4"'])

    expect(report.hadUnfinishedFile).toBe(true)
    expect(report.leftBehind).toEqual([])
    expect(report.leftAfterReload).toEqual([])

    expect(report.fieldsByFormat).toEqual({
      webm: ['export-preset', 'export-frame-rate', 'export-quality-high', 'export-range-whole', 'export-audio'],
      gif: ['export-preset', 'export-frame-rate', 'export-range-whole'],
      wav: ['export-range-whole'],
      png: [],
      mp4: ['export-preset', 'export-frame-rate', 'export-quality-high', 'export-range-whole', 'export-audio'],
    })
    const sound = await probeExport(String(report.sound))
    expect(sound.video).toEqual({})
    expect(sound.audio).toMatchObject({ codec_name: 'pcm_s16le', sample_rate: '48000', channels: '2' })
    expect(Math.abs(sound.duration - 3)).toBeLessThan(0.01)
    expect(report.stillSummary).toMatch(/^PNG, 640x360, the frame at /)
    expect((await probeExport(String(report.still))).video).toMatchObject({ codec_name: 'png', width: '640', height: '360' })

    const low = await probeExport(String(report.low))
    const high = await probeExport(String(report.high))
    expect(high.video).toMatchObject({ width: '426', height: '240', r_frame_rate: '30/1', nb_frames: '90' })
    expect(high.audio).toMatchObject({ codec_name: 'aac' })
    expect(Math.abs(low.duration - 3)).toBeLessThan(0.05)
    expect(statSync(String(report.low)).size).toBeLessThan(statSync(String(report.high)).size)
  })
})

describe('debug info and settings', () => {
  it('keeps clips end to end when they get faster, shows the debug text from the View menu and keeps settings on disk', async () => {
    const report = await uiTest('debug-and-settings', ['--media', MEDIA_DIRECTORY, '--out', join(scratch, 'debug-and-settings')])

    expect(report.debugWithoutSelection).toMatch(/^Playback \S+ \| Electron \S+ \| Chromium \S+ \| FFmpeg /)
    expect(report.debugWithoutSelection).toContain('3 clips')
    expect(report.debugWithoutSelection).not.toContain('Selected')
    expect(report.debugWithSelection).toContain('Selected 3')
    expect(report.debugWithSelection).toContain('h264.mp4')

    const clips = projectIn(report, 'faster').tracks[0]?.clips ?? []
    const timing = clips.map((clip) => ({ type: clip.type, start: clip.start, duration: clip.duration }))
    expect(timing).toEqual([
      { type: 'video', start: 0, duration: SECOND },
      { type: 'audio', start: SECOND, duration: SECOND },
      { type: 'image', start: 2 * SECOND, duration: 5 * SECOND },
    ])

    expect(report.cacheUsed).toMatch(/^Using \d+\.\d GB$/)
    expect(report.savedSnapRange).toBe(20)
    expect(report.restoredSnapRange).toBe(12)
  })
})

describe('quick edits', () => {
  it('starts with six tracks, picks files by box and Select All, picks the part after a cut, sets the speed from the clip menu and grabs a clip off the canvas', async () => {
    const report = await uiTest('quick-edits', ['--media', MEDIA_DIRECTORY, '--out', join(scratch, 'quick-edits')])

    expect(report.startingTracks).toBe(6)
    expect(report.pickedByBox).toEqual(['media-h264.mp4', 'media-audio.wav', 'media-image.jpg'])
    expect(report.pickedBySelectAll).toEqual(['media-h264.mp4', 'media-audio.wav', 'media-image.jpg'])
    expect(arrangement(projectIn(report, 'dropped'))).toEqual([['video 0', 'audio 2', 'image 4'], [], [], [], [], []])
    expect(report.filesAfterClipSelectAll).toEqual(['media-h264.mp4', 'media-audio.wav', 'media-image.jpg'])

    expect(report.startAfterSplit).toBe('1.000')
    expect(report.speedShown).toBe('100')
    const typed = projectIn(report, 'typedSpeed').tracks[0]?.clips[1]
    expect(typed).toMatchObject({ type: 'video', start: SECOND, speedPercent: 200, duration: SECOND / 2 })
    expect(report.speedShownAgain).toBe('200')
    expect(report.undoAfterEscape).toBe('Undo Change Speed')
    expect(projectIn(report, 'escapedSpeed').tracks[0]?.clips[1]).toMatchObject({ start: SECOND, speedPercent: 200 })

    expect(report.outlinedOutside).toBe('1')
    expect(report.xDraggedBack).toBe('160.0')
    expect(report.outlinedAfter).toBe('0')
  })
})

describe('accessibility', () => {
  it.each(['17-callouts-arrows', '15-blur-highlight', '05-fades', '20-groups', '09-text'])('names every control and reaches every panel and dialog by keyboard with a visible focus ring, on %s', async (project) => {
    const report = await uiTest('accessibility', ['--project', projectPath(project), '--out', join(scratch, `accessibility-${project}`)])
    expect(report.unnamed).toEqual([])
    expect(report.withoutRing).toEqual([])
    expect(report.windowRegions).toEqual(expect.arrayContaining(['Canvas', 'Library', 'Properties', 'Timeline']))
    expect(report.exportRegions).toEqual(['dialog'])
    expect(report.settingsRegions).toEqual(['dialog'])
  })
})

describe('timeline scrolling and removing media', () => {
  it('scrolls with the scroll bar and the middle button, and Delete in the Media tab takes a file out with its clips', async () => {
    const report = await uiTest('timeline-scroll', ['--project', projectPath('01-single-clip'), '--out', join(scratch, 'timeline-scroll')])
    expect(report.scrolledByBar).toBe(120)
    expect(report.undoAfterScrolling).toBe('Undo')
    const removed = projectIn(report, 'removed')
    expect(removed.media).toEqual([])
    expect(removed.tracks.flatMap((track) => track.clips)).toEqual([])
    expect(projectIn(report, 'restored').tracks[0]?.clips.map((clip) => clip.id)).toEqual(['clip'])
  })
})
