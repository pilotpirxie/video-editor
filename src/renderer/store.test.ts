import { describe, expect, it } from 'vitest'
import { MEDIA_STATES, SECOND, animationClip, drawingClip, groupClip, projectOf, track, videoClip } from '../../test/fixtures.js'
import { editClips } from '../editor/clips.js'
import { hexOf } from '../editor/colors.js'
import { addNodeSet, deleteNodeSet, deleteNodes, setShapeFlag, setSwatchColor } from '../editor/drawings.js'
import { trimClip } from '../editor/moveTrim.js'
import { setProperties } from '../editor/properties.js'
import type { Documents, LoadedProject } from '../shared/mediaProtocol.js'
import type { DrawingShape, Project } from '../shared/project.js'
import { frameDuration } from '../shared/time.js'
import { createEditorStore, type EditorStore } from './store.js'

const WAVE = '/films/wave.pbanim'
const OTHER = '/films/other.pbanim'
const MEDIA = { ...MEDIA_STATES, wave: { info: { kind: 'animation' as const, path: WAVE } } }
const ANIMATION = projectOf([track('a1', [videoClip('hand', 0, 2 * SECOND)])])
const EPISODE = projectOf([track('t1', [animationClip('anim', 0, 4 * SECOND)])])

function openedStore(documents: Documents = { [WAVE]: ANIMATION }): EditorStore {
  const store = createEditorStore()
  const loaded: LoadedProject = { project: EPISODE, media: MEDIA, documents }
  store.open(loaded, '/films/episode.pbproj', true, [])
  store.select(['anim'])
  store.openGroup('anim')
  return store
}

function handOpacity(document: Project | undefined): number | undefined {
  const hand = document?.tracks[0]?.clips[0]
  return hand?.type === 'video' ? hand.opacity : undefined
}

describe('editing inside an animation', () => {
  it('changes the animation file, not the episode, and undoes and redoes it', () => {
    const store = openedStore()
    expect(store.getState().openDocument).toBe(WAVE)
    expect(store.getState().openChain).toEqual([WAVE])
    store.apply('Change Opacity', (project) => setProperties(project, ['hand'], { opacity: 0.25 }, 0))
    expect(handOpacity(store.getState().documents[WAVE])).toBe(0.25)
    expect(store.getState().wholeProject).toBe(EPISODE)
    expect(handOpacity(store.getState().project)).toBe(0.25)

    store.undo()
    expect(store.getState().documents[WAVE]).toBe(ANIMATION)
    store.redo()
    expect(handOpacity(store.getState().documents[WAVE])).toBe(0.25)
  })

  it('records one step for a whole gesture and leaves nothing behind when it is cancelled', () => {
    const store = openedStore()
    store.begin('Change Opacity')
    store.update((project) => setProperties(project, ['hand'], { opacity: 0.5 }, 0))
    store.update((project) => setProperties(project, ['hand'], { opacity: 0.75 }, 0))
    store.commit()
    expect(store.getState().history.done).toHaveLength(1)
    expect(store.getState().history.done[0]?.documents?.[WAVE]?.before).toBe(ANIMATION)

    store.begin('Change Opacity')
    store.update((project) => setProperties(project, ['hand'], { opacity: 0.1 }, 0))
    store.cancel()
    expect(handOpacity(store.getState().documents[WAVE])).toBe(0.75)
    expect(store.getState().history.done).toHaveLength(1)
  })

  it('keeps animations loaded after an edit when that edit is undone', () => {
    const store = openedStore()
    store.apply('Change Opacity', (project) => setProperties(project, ['hand'], { opacity: 0.25 }, 0))
    store.addDocuments({ documents: { [OTHER]: ANIMATION }, media: {} })
    store.undo()
    expect(store.getState().documents[OTHER]).toBe(ANIMATION)
    expect(store.getState().documents[WAVE]).toBe(ANIMATION)
  })

  // The timeline snaps to frames of the open project's canvas.
  it('snaps clip edges to the animation\'s frames, not the episode\'s', () => {
    const twelveFps = { ...ANIMATION, canvas: { ...ANIMATION.canvas, frameRate: { num: 12, den: 1 } } }
    const store = openedStore({ [WAVE]: twelveFps })
    const frameTicks = frameDuration(store.getState().project.canvas.frameRate)
    expect(frameTicks).toBe(SECOND / 12)
    const pointerTime = 1.3 * SECOND
    const time = Math.round(pointerTime / frameTicks) * frameTicks
    const { mediaStates, documents } = store.getState()
    store.apply('Trim Clip', (project) => trimClip(project, { clipId: 'hand', edge: 'end', time, isRipple: false, frameTicks, mediaStates, documents }))
    expect(store.getState().documents[WAVE]?.tracks[0]?.clips[0]?.duration).toBe(16 * frameTicks)
  })

  it('edits the whole animation file from inside a group in it, and shows the change there', () => {
    const skin = hexOf({ hue: 30, saturation: 60, lightness: 70, opacity: 100 })
    const tan = hexOf({ hue: 30, saturation: 40, lightness: 40, opacity: 100 })
    const linked = (id: string): DrawingShape => ({ id, nodes: [{ x: 0, y: 0 }, { x: 1, y: 1 }], fill: skin, fillSwatch: 'skin' })
    const body = groupClip('body', 0, SECOND, [[drawingClip('inner', 0, SECOND, [linked('hand')])]])
    const character = { ...projectOf([track('a1', [drawingClip('loose', 0, SECOND, [linked('foot')])]), track('a2', [body])]), swatches: [{ id: 'skin', name: 'Skin', color: skin }] }
    const store = openedStore({ [WAVE]: character })
    store.select(['body'])
    store.openGroup('body')
    store.begin('Change Swatch')
    store.updateFile((project) => setSwatchColor(project, 'skin', tan))
    store.commit()
    const saved = store.getState().documents[WAVE]
    const fillOf = (clip: unknown): string | undefined => (typeof clip === 'object' && clip !== null && 'shapes' in clip && Array.isArray(clip.shapes) ? clip.shapes[0]?.fill : undefined)
    expect(fillOf(saved?.tracks[0]?.clips[0])).toBe(tan)
    const group = saved?.tracks[1]?.clips[0]
    expect(fillOf(group?.type === 'group' ? group.tracks[0]?.clips[0] : undefined)).toBe(tan)
    expect(store.getState().project.swatches?.[0]?.color).toBe(tan)
    expect(fillOf(store.getState().project.tracks[0]?.clips[0])).toBe(tan)
    store.undo()
    expect(store.getState().documents[WAVE]).toBe(character)
  })

  it('takes in a file changed elsewhere: the gesture ends, and undo no longer reaches the older versions', () => {
    const store = openedStore()
    store.apply('Change Opacity', (project) => setProperties(project, ['hand'], { opacity: 0.25 }, 0))
    store.begin('Change Opacity')
    store.update((project) => setProperties(project, ['hand'], { opacity: 0.5 }, 0))

    const changed = projectOf([track('a1', [videoClip('hand', 0, SECOND)]), track('a2', [videoClip('foot', 0, SECOND)])])
    const nestedAgain = projectOf([])
    store.addDocuments({ documents: { [OTHER]: ANIMATION }, media: {} })
    store.reloadDocument(WAVE, { documents: { [WAVE]: changed, [OTHER]: nestedAgain, '/films/new.pbanim': nestedAgain }, media: {} })

    const state = store.getState()
    expect(state.documents[WAVE]).toBe(changed)
    expect(state.savedDocuments[WAVE]).toBe(changed)
    expect(state.project).toBe(changed)
    expect(state.documents[OTHER]).toBe(ANIMATION)
    expect(state.documents['/films/new.pbanim']).toBe(nestedAgain)
    expect(state.history.done).toEqual([])
    store.undo()
    expect(store.getState().documents[WAVE]).toBe(changed)
  })

  it('closes an animation whose file is no longer loaded', () => {
    const store = openedStore({})
    expect(store.getState().openGroups).toEqual([])
    expect(store.getState().openDocument).toBeUndefined()
    expect(store.getState().project).toBe(EPISODE)
  })
})

describe('selecting shapes', () => {
  const box = { id: 'box', nodes: [{ x: 0, y: 0 }, { x: 10, y: 10 }] }

  it('replaces the clip selection and is replaced by it', () => {
    const store = openedStore({ [WAVE]: projectOf([track('a1', [videoClip('hand', 0, SECOND), drawingClip('sketch', SECOND, SECOND, [box])])]) })
    store.select(['hand'])
    store.selectShapes([{ clipId: 'sketch', shapeId: 'box' }])
    expect(store.getState().selection).toEqual([])
    store.select(['hand'])
    expect(store.getState().selectedShapes).toEqual([])
  })

  it('lets go of shapes that an undo takes away, and of all shapes when the animation closes', () => {
    const store = openedStore({ [WAVE]: projectOf([track('a1', [drawingClip('sketch', 0, SECOND)])]) })
    store.apply('Add Rectangle', (project) => editClips(project, new Set(['sketch']), (clip) => (clip.type === 'drawing' ? { ...clip, shapes: [box] } : clip)))
    store.selectShapes([{ clipId: 'sketch', shapeId: 'box' }])
    store.undo()
    expect(store.getState().selectedShapes).toEqual([])
    store.redo()
    store.selectShapes([{ clipId: 'sketch', shapeId: 'box' }])
    store.closeGroups(0)
    expect(store.getState().selectedShapes).toEqual([])
  })

  it('lets go of a shape once it is hidden or locked', () => {
    const store = openedStore({ [WAVE]: projectOf([track('a1', [drawingClip('sketch', 0, SECOND, [box, { ...box, id: 'lid' }])])]) })
    store.selectShapes([
      { clipId: 'sketch', shapeId: 'box' },
      { clipId: 'sketch', shapeId: 'lid' },
    ])
    store.apply('Hide Shape', (project) => setShapeFlag(project, { clipId: 'sketch', shapeId: 'box' }, 'hidden', true))
    expect(store.getState().selectedShapes).toEqual([{ clipId: 'sketch', shapeId: 'lid' }])
    store.apply('Lock Shape', (project) => setShapeFlag(project, { clipId: 'sketch', shapeId: 'lid' }, 'locked', true))
    expect(store.getState().selectedShapes).toEqual([])
  })
})

describe('choosing nodes', () => {
  const box = { id: 'box', nodes: [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }] }
  const lid = { clipId: 'sketch', shapeId: 'lid' }

  it('keeps nodes chosen only with the Node tool, on chosen shapes, while they exist', () => {
    const store = openedStore({ [WAVE]: projectOf([track('a1', [drawingClip('sketch', 0, SECOND, [box, { ...box, id: 'lid' }])])]) })
    store.setTool('node')
    store.selectShapes([{ clipId: 'sketch', shapeId: 'box' }, lid])
    store.selectNodes([
      { clipId: 'sketch', shapeId: 'box', index: 2 },
      { ...lid, index: 0 },
    ])
    store.selectShapes([lid])
    expect(store.getState().selectedNodes).toEqual([{ ...lid, index: 0 }])
    store.selectNodes([{ ...lid, index: 2 }])
    store.apply('Delete Node', (project) => deleteNodes(project, [{ ...lid, index: 1 }]))
    expect(store.getState().selectedNodes).toEqual([])
    store.selectNodes([{ ...lid, index: 0 }])
    store.setTool('pen')
    expect(store.getState().selectedNodes).toEqual([])
  })

  it('keeps a node set selected while its nodes stay chosen, with the Node tool, while it exists', () => {
    const store = openedStore({ [WAVE]: projectOf([track('a1', [drawingClip('sketch', 0, SECOND, [box, { ...box, id: 'lid' }])])]) })
    const nodes = [
      { ...lid, index: 0 },
      { ...lid, index: 1 },
    ]
    const set = { clipId: 'sketch', setId: 'hinge' }
    store.setTool('node')
    store.apply('Save Node Set', (project) => addNodeSet(project, nodes, 'hinge', 0))
    store.selectSet(set, [lid], nodes)
    expect(store.getState()).toMatchObject({ selectedSet: set, selectedShapes: [lid], selectedNodes: nodes })
    store.apply('Move Node', (project) => project)
    expect(store.getState().selectedSet).toEqual(set)
    store.selectNodes([{ ...lid, index: 2 }])
    expect(store.getState().selectedSet).toBeUndefined()

    store.selectSet(set, [lid], nodes)
    store.apply('Delete Node Set', (project) => deleteNodeSet(project, set))
    expect(store.getState().selectedSet).toBeUndefined()
    store.undo()
    store.selectSet(set, [lid], nodes)
    store.setTool('move')
    expect(store.getState().selectedSet).toBeUndefined()
  })
})

describe('drawing settings of the window', () => {
  it('keeps the colours for new shapes and the part the colour panel edits, outside the undo history', () => {
    const store = createEditorStore()
    const navy = hexOf({ hue: 210, saturation: 50, lightness: 20, opacity: 100 })
    const olive = hexOf({ hue: 60, saturation: 50, lightness: 40, opacity: 100 })
    store.setDrawingColor('stroke', navy)
    store.setDrawingColor('fill', olive)
    store.setColorPart('stroke')
    expect(store.getState()).toMatchObject({ drawingStyle: { fill: olive, stroke: { color: navy, width: 4 } }, colorPart: 'stroke' })
    store.setDrawingColor('fill', navy, 'ink')
    store.setDrawingStroke({ color: olive, width: 2, isDashed: true })
    expect(store.getState().drawingStyle).toEqual({ fill: navy, fillSwatch: 'ink', stroke: { color: olive, width: 2, isDashed: true } })
    store.setDrawingStroke(undefined)
    expect(store.getState().drawingStyle).toEqual({ fill: navy, fillSwatch: 'ink' })
    expect(store.getState().isFillingOpenPaths).toBe(false)
    store.setFillingOpenPaths(true)
    expect(store.getState().isFillingOpenPaths).toBe(true)
    expect(store.getState().history.done).toEqual([])
  })

  it('remembers which tracks show their shapes', () => {
    const store = createEditorStore()
    store.expandTrack('t1', true)
    const expanded = store.getState().expandedTracks
    store.expandTrack('t1', true)
    expect(store.getState().expandedTracks).toBe(expanded)
    store.expandTrack('t2', true)
    store.expandTrack('t1', false)
    expect([...store.getState().expandedTracks]).toEqual(['t2'])
  })
})
