import { describe, expect, it } from 'vitest'
import { FRAME, SECOND, clipOf, drawingClip, projectOf, track, videoClip } from '../../test/fixtures.js'
import type { DrawingClip, DrawingShape, Keyframe, NodeSet, Project, ShapeNode } from '../shared/project.js'
import { TIMELINE_GRID } from '../shared/time.js'
import { posedShapes } from '../engine/curves.js'
import { laterPart } from './split.js'
import {
  NEW_SHAPE_STYLE,
  NEW_STROKE,
  addDrawingShapes,
  addNodeSet,
  copyKeysAt,
  deleteKeysAt,
  deleteNodeSet,
  drawingKeyTimes,
  hasNodeKeysAt,
  hasSetKeysAt,
  moveKeysAt,
  pasteKeys,
  renameNodeSet,
  setKeysEasing,
  setNodeKeys,
  followChoices,
  followedSetOf,
  hasShapeKeysAt,
  parentChoices,
  setNodeSetKeys,
  setNodeSetParent,
  setNodeSetPivot,
  setNodeSetPose,
  setShapesFollow,
  setShapesKeys,
  setShapesPose,
  shapePoseAt,
  shownPivot,
  turnAndScaleAboveSet,
  addShapesAbove,
  addSwatch,
  arrangeShapes,
  breakPaths,
  canDropShape,
  closePaths,
  copyShapes,
  deleteNodes,
  deleteShapes,
  deleteSwatch,
  dragBox,
  drawingPlace,
  duplicateDrawing,
  ellipseShape,
  insertNode,
  moveHandle,
  moveNodes,
  moveShape,
  nextSwatchName,
  nodePointsOf,
  nodeTypeOf,
  pathShape,
  pickableShape,
  rectangleShape,
  renameShape,
  renameSwatch,
  setNodePosition,
  setNodeType,
  setShapeColor,
  setShapeFlag,
  setShapeStroke,
  setSwatchColor,
  shapeRefsOf,
  shapeRows,
  styleIn,
  targetTrackIndex,
  transformShapes,
  withKnownSwatches,
  withNewShapeIds,
  type ArrangePlace,
  type DrawingPlace,
  type NodeRef,
} from './drawings.js'

const STILL = { x: 50, y: 50, scaleX: 1, scaleY: 1, rotation: 0 }
const BOX = { left: 10, top: 20, right: 110, bottom: 80 }
const NEW_SHAPE = rectangleShape('new', BOX, NEW_SHAPE_STYLE)

function placeAt(trackIndex: number, time: number): DrawingPlace {
  return { trackIndex, time, newDrawing: { clipId: 'drawn', duration: SECOND, newTrack: { id: 'above', name: 'Track 3' } } }
}

function shapeOf(id: string, children?: DrawingShape[]): DrawingShape {
  const shape: DrawingShape = { id, nodes: [{ x: 0, y: 0 }, { x: 10, y: 10 }] }
  if (children !== undefined) shape.children = children
  return shape
}

function idsOf(shapes: readonly DrawingShape[]): string[] {
  return shapes.map((shape) => shape.id)
}

function shapesOf(project: Project, clipId: string): DrawingShape[] {
  const clip = clipOf(project, clipId)
  if (clip.type !== 'drawing') throw new Error(`"${clipId}" is not a drawing`)
  return clip.shapes
}

describe('dragBox', () => {
  it('spans the drag in any direction, and makes it square with the longer side when asked', () => {
    expect(dragBox({ x: 50, y: 40 }, { x: 10, y: 60 }, false)).toEqual({ left: 10, top: 40, right: 50, bottom: 60 })
    expect(dragBox({ x: 50, y: 40 }, { x: 10, y: 60 }, true)).toEqual({ left: 10, top: 40, right: 50, bottom: 80 })
  })
})

describe('rectangleShape and ellipseShape', () => {
  it('make named closed outlines in the given colours', () => {
    expect(rectangleShape('box', BOX, NEW_SHAPE_STYLE)).toEqual({
      id: 'box',
      name: 'Rectangle',
      nodes: [{ x: 10, y: 20 }, { x: 110, y: 20 }, { x: 110, y: 80 }, { x: 10, y: 80 }],
      isClosed: true,
      fill: '#FFFFFF',
      stroke: { color: '#000000', width: 4, scalesWithObject: true },
    })
    const bare = rectangleShape('bare', BOX, { fill: '#000000', fillSwatch: 'ink' })
    expect(bare).toMatchObject({ fill: '#000000', fillSwatch: 'ink' })
    expect('stroke' in bare).toBe(false)
    const ellipse = ellipseShape('sun', BOX, { fill: '#112233', stroke: { color: '#445566', width: 4 } })
    expect(ellipse).toMatchObject({ name: 'Ellipse', isClosed: true, fill: '#112233', stroke: { color: '#445566' } })
    expect(ellipse.nodes.map((node) => ({ x: node.x, y: node.y }))).toEqual([{ x: 60, y: 20 }, { x: 110, y: 50 }, { x: 60, y: 80 }, { x: 10, y: 50 }])
    expect(ellipse.nodes[0]?.out?.x).toBeCloseTo(27.615)
    expect(ellipse.nodes[1]?.out?.y).toBeCloseTo(16.569)
  })
})

describe('pathShape', () => {
  const nodes = [{ x: 0, y: 0 }, { x: 10, y: 0 }]
  const style = { fill: '#112233', fillSwatch: 'skin', stroke: NEW_STROKE }

  it('fills a closed path, and an open one only when open paths are filled', () => {
    expect(pathShape('closed', nodes, true, style, false)).toEqual({ id: 'closed', name: 'Path', nodes, isClosed: true, fill: '#112233', fillSwatch: 'skin', stroke: NEW_STROKE })
    expect(pathShape('open', nodes, false, style, false)).toEqual({ id: 'open', name: 'Path', nodes, stroke: NEW_STROKE })
    expect(pathShape('filled', nodes, false, style, true)).toEqual({ id: 'filled', name: 'Path', nodes, fill: '#112233', fillSwatch: 'skin', stroke: NEW_STROKE })
  })
})

describe('targetTrackIndex', () => {
  const project = projectOf([track('low', [videoClip('a', 0, SECOND)]), track('high', [drawingClip('sketch', 0, SECOND)])])

  it('takes the track of the selected clip, then of the selected shapes, then the top track', () => {
    expect(targetTrackIndex(project, ['a'], [{ clipId: 'sketch', shapeId: 's' }])).toBe(0)
    expect(targetTrackIndex(project, [], [{ clipId: 'sketch', shapeId: 's' }])).toBe(1)
    expect(targetTrackIndex(project, [], [])).toBe(1)
    expect(targetTrackIndex(projectOf([]), [], [])).toBe(0)
  })
})

describe('drawingPlace', () => {
  it('aims at the target track on the frame under the playhead, with a one-second drawing ready', () => {
    const project = projectOf([track('art', [])])
    const place = drawingPlace(project, 1.5 * FRAME, [], [], { clipId: 'drawn', trackId: 'above' })
    expect(place).toEqual({ trackIndex: 0, time: FRAME, newDrawing: { clipId: 'drawn', duration: 30 * FRAME, newTrack: { id: 'above', name: 'Track 2' } } })
  })
})

describe('addDrawingShapes', () => {
  const dot = rectangleShape('dot', { left: 0, top: 0, right: 4, bottom: 4 }, NEW_SHAPE_STYLE)
  const project = projectOf([track('low', [videoClip('a', 0, SECOND)]), track('art', [drawingClip('sketch', 0, SECOND, [dot])])])

  it('puts the shape in front in the drawing under the playhead', () => {
    const drawn = addDrawingShapes(project, placeAt(1, SECOND / 2), [NEW_SHAPE])
    expect(shapesOf(drawn, 'sketch').map((shape) => shape.id)).toEqual(['dot', 'new'])
  })

  it('starts a new drawing at the playhead when there is none under it', () => {
    const drawn = addDrawingShapes(project, placeAt(1, 2 * SECOND), [NEW_SHAPE])
    expect(drawn.tracks[1]?.clips.map((clip) => clip.id)).toEqual(['sketch', 'drawn'])
    expect(clipOf(drawn, 'drawn')).toEqual(drawingClip('drawn', 2 * SECOND, SECOND, [NEW_SHAPE]))
  })

  it('draws on a new track when the target track holds another clip there, is locked or is hidden', () => {
    expect(addDrawingShapes(project, placeAt(0, 0), [NEW_SHAPE]).tracks.map((entry) => entry.id)).toEqual(['low', 'above', 'art'])
    const locked = projectOf([track('art', [drawingClip('sketch', 0, SECOND, [dot])], { locked: true })])
    expect(shapesOf(addDrawingShapes(locked, placeAt(0, 0), [NEW_SHAPE]), 'sketch')).toEqual([dot])
    expect(addDrawingShapes(locked, placeAt(0, 0), [NEW_SHAPE]).tracks.map((entry) => entry.id)).toEqual(['art', 'above'])
    const hidden = projectOf([track('art', [], { hidden: true })])
    expect(addDrawingShapes(hidden, placeAt(0, 0), [NEW_SHAPE]).tracks.map((entry) => entry.clips.length)).toEqual([0, 1])
  })
})

describe('transformShapes', () => {
  const curve: DrawingShape = { id: 'curve', nodes: [{ x: 40, y: 50, out: { x: 0, y: -10 } }, { x: 60, y: 50, in: { x: 0, y: -10 } }] }
  const child: DrawingShape = { id: 'child', nodes: [{ x: 45, y: 45 }, { x: 55, y: 55 }] }
  const parent: DrawingShape = { ...curve, id: 'parent', children: [child] }
  const project = projectOf([track('art', [drawingClip('sketch', 0, SECOND, [curve, parent])])])

  function moved(refs: readonly string[], to: Partial<typeof STILL>): DrawingShape[] {
    const shapes = refs.map((shapeId) => ({ clipId: 'sketch', shapeId }))
    return shapesOf(transformShapes(project, shapes, STILL, { ...STILL, ...to }, 0), 'sketch')
  }

  it('moves nodes and keeps handles as they were', () => {
    expect(moved(['curve'], { x: 60, y: 45 })[0]?.nodes).toEqual([{ x: 50, y: 45, out: { x: 0, y: -10 } }, { x: 70, y: 45, in: { x: 0, y: -10 } }])
  })

  it('scales nodes and handles around the box', () => {
    expect(moved(['curve'], { scaleX: 2, scaleY: 3 })[0]?.nodes).toEqual([{ x: 30, y: 50, out: { x: 0, y: -30 } }, { x: 70, y: 50, in: { x: 0, y: -30 } }])
  })

  it('turns nodes and handles around the box', () => {
    const [start] = moved(['curve'], { rotation: 90 })[0]?.nodes ?? []
    expect(start?.x).toBeCloseTo(50)
    expect(start?.y).toBeCloseTo(40)
    expect(start?.out?.x).toBeCloseTo(10)
    expect(start?.out?.y).toBeCloseTo(0)
  })

  it('scales a stroke with its shape only when asked, by the mean of the two scales', () => {
    const stroked = projectOf([track('art', [drawingClip('sketch', 0, SECOND, [{ ...curve, stroke: { color: '#000000', width: 4, scalesWithObject: true } }, { ...child, stroke: { color: '#000000', width: 4 } }])])])
    const scaled = shapesOf(transformShapes(stroked, [{ clipId: 'sketch', shapeId: 'curve' }, { clipId: 'sketch', shapeId: 'child' }], STILL, { ...STILL, scaleX: 2, scaleY: 8 }, 0), 'sketch')
    expect(scaled.map((shape) => shape.stroke?.width)).toEqual([16, 4])
  })

  it('takes clipped children along once, and moves a chosen child alone', () => {
    const [, withParent] = moved(['parent', 'child'], { x: 60 })
    expect(withParent?.children?.[0]?.nodes).toEqual([{ x: 55, y: 45 }, { x: 65, y: 55 }])
    const [untouched, alone] = moved(['child'], { x: 60 })
    expect(untouched).toBe(curve)
    expect(alone?.nodes).toEqual(parent.nodes)
    expect(alone?.children?.[0]?.nodes).toEqual([{ x: 55, y: 45 }, { x: 65, y: 55 }])
  })
})

describe('the shapes list', () => {
  const pocket = shapeOf('pocket')
  const coat = shapeOf('coat', [pocket, shapeOf('patch')])
  const shapes = [shapeOf('back'), coat, { ...shapeOf('hat'), hidden: true as const, children: [shapeOf('band')] }]

  it('lists shapes front to back, each followed by its clipped children', () => {
    const rows = shapeRows(shapes)
    expect(rows.map((row) => `${row.depth}:${row.shape.id}`)).toEqual(['0:hat', '1:band', '0:coat', '1:patch', '1:pocket', '0:back'])
    expect(rows.filter((row) => !row.isPickable).map((row) => row.shape.id)).toEqual(['hat', 'band'])
  })

  it('cannot pick a hidden or locked shape, nor anything clipped inside one', () => {
    expect(pickableShape(shapes, 'pocket')).toBe(pocket)
    expect(pickableShape(shapes, 'hat')).toBeUndefined()
    expect(pickableShape(shapes, 'band')).toBeUndefined()
    expect(pickableShape([{ ...coat, locked: true }], 'pocket')).toBeUndefined()
  })
})

describe('editing shapes', () => {
  const pocket = shapeOf('pocket')
  const coat = shapeOf('coat', [pocket, shapeOf('patch')])
  const project = projectOf([track('art', [drawingClip('sketch', 0, SECOND, [shapeOf('back'), coat, shapeOf('hat')]), drawingClip('other', SECOND, SECOND, [shapeOf('dot')])])])

  function ref(shapeId: string, clipId = 'sketch'): { clipId: string; shapeId: string } {
    return { clipId, shapeId }
  }

  function treeOf(edited: Project, clipId = 'sketch'): string[] {
    return shapeRows(shapesOf(edited, clipId)).map((row) => `${row.depth}:${row.shape.id}`)
  }

  it('hides, locks and renames one shape, clearing a flag by leaving it out', () => {
    const hidden = setShapeFlag(project, ref('pocket'), 'hidden', true)
    expect(shapesOf(hidden, 'sketch')[1]?.children?.[0]).toEqual({ ...pocket, hidden: true })
    expect(shapesOf(setShapeFlag(hidden, ref('pocket'), 'hidden', false), 'sketch')[1]?.children?.[0]).toEqual(pocket)
    expect(shapesOf(setShapeFlag(project, ref('hat'), 'locked', true), 'sketch')[2]).toMatchObject({ locked: true })
    expect(shapesOf(renameShape(project, ref('coat'), '  Coat '), 'sketch')[1]?.name).toBe('Coat')
    expect(renameShape(project, ref('coat'), '  ')).toBe(project)
  })

  it('moves a shape in front of, behind or inside another, across levels', () => {
    expect(treeOf(moveShape(project, ref('hat'), 'back', 'behind'))).toEqual(['0:coat', '1:patch', '1:pocket', '0:back', '0:hat'])
    expect(treeOf(moveShape(project, ref('back'), 'coat', 'front'))).toEqual(['0:hat', '0:back', '0:coat', '1:patch', '1:pocket'])
    expect(treeOf(moveShape(project, ref('pocket'), 'patch', 'front'))).toEqual(['0:hat', '0:coat', '1:pocket', '1:patch', '0:back'])
    expect(treeOf(moveShape(project, ref('pocket'), 'hat', 'front'))).toEqual(['0:pocket', '0:hat', '0:coat', '1:patch', '0:back'])
    expect(treeOf(moveShape(project, ref('hat'), 'pocket', 'inside'))).toEqual(['0:coat', '1:patch', '1:pocket', '2:hat', '0:back'])
    expect(treeOf(moveShape(project, ref('back'), 'coat', 'inside'))).toEqual(['0:hat', '0:coat', '1:back', '1:patch', '1:pocket'])
    const emptied = moveShape(moveShape(project, ref('pocket'), 'hat', 'inside'), ref('patch'), 'hat', 'inside')
    expect(shapesOf(emptied, 'sketch')[1]).toEqual(shapeOf('coat'))
  })

  it('refuses to put a shape into itself, into a shape clipped inside it, or deeper than eight', () => {
    const shapes = shapesOf(project, 'sketch')
    expect(canDropShape(shapes, 'coat', 'coat', 'inside')).toBe(false)
    expect(canDropShape(shapes, 'coat', 'pocket', 'inside')).toBe(false)
    expect(canDropShape(shapes, 'coat', 'missing', 'front')).toBe(false)
    expect(moveShape(project, ref('coat'), 'pocket', 'front')).toBe(project)
    let deep = shapeOf('level-0')
    for (let level = 1; level <= 8; level++) deep = shapeOf(`level-${level}`, [deep])
    expect(canDropShape([deep, shapeOf('loose')], 'loose', 'level-1', 'inside')).toBe(true)
    expect(canDropShape([deep, shapeOf('loose')], 'loose', 'level-0', 'inside')).toBe(false)
    expect(canDropShape([deep, shapeOf('loose', [shapeOf('inner')])], 'loose', 'level-1', 'inside')).toBe(false)
  })

  it('arranges chosen siblings one step or all the way, keeping their order', () => {
    const arranged = (shapeIds: string[], place: ArrangePlace): string[] =>
      idsOf(shapesOf(arrangeShapes(project, shapeIds.map((shapeId) => ref(shapeId)), place), 'sketch'))
    expect(arranged(['back'], 'forward')).toEqual(['coat', 'back', 'hat'])
    expect(arranged(['back', 'coat'], 'forward')).toEqual(['hat', 'back', 'coat'])
    expect(arranged(['hat'], 'forward')).toEqual(['back', 'coat', 'hat'])
    expect(arranged(['hat'], 'backward')).toEqual(['back', 'hat', 'coat'])
    expect(arranged(['back', 'hat'], 'front')).toEqual(['coat', 'back', 'hat'])
    expect(arranged(['coat', 'hat'], 'back')).toEqual(['coat', 'hat', 'back'])
    const inside = arrangeShapes(project, [ref('pocket')], 'front')
    expect(idsOf(shapesOf(inside, 'sketch')[1]?.children ?? [])).toEqual(['patch', 'pocket'])
  })

  it('deletes shapes in any drawing, dropping an emptied list of children', () => {
    const deleted = deleteShapes(project, [ref('pocket'), ref('patch'), ref('dot', 'other')])
    expect(shapesOf(deleted, 'sketch')[1]).toEqual(shapeOf('coat'))
    expect(shapesOf(deleted, 'other')).toEqual([])
  })

  it('sets the fill or the stroke colour, giving a stroke to a shape without one', () => {
    const filled = setShapeColor(project, [ref('back'), ref('pocket')], 'fill', '#FF000080')
    expect(shapesOf(filled, 'sketch')[0]?.fill).toBe('#FF000080')
    expect(shapesOf(filled, 'sketch')[1]?.children?.[0]?.fill).toBe('#FF000080')
    const stroked = setShapeColor(project, [ref('hat')], 'stroke', '#00FF00')
    expect(shapesOf(stroked, 'sketch')[2]?.stroke).toEqual({ color: '#00FF00', width: 4, scalesWithObject: true })
  })

  it('links a colour to a swatch, and a colour of its own unlinks it', () => {
    const linked = setShapeColor(setShapeColor(project, [ref('back')], 'fill', '#112233', 'skin'), [ref('back')], 'stroke', '#000000', 'line')
    expect(shapesOf(linked, 'sketch')[0]).toMatchObject({ fill: '#112233', fillSwatch: 'skin', stroke: { color: '#000000', swatch: 'line' } })
    const own = setShapeColor(setShapeColor(linked, [ref('back')], 'fill', '#445566'), [ref('back')], 'stroke', '#FFFFFF')
    expect(shapesOf(own, 'sketch')[0]?.fillSwatch).toBeUndefined()
    expect(shapesOf(own, 'sketch')[0]?.stroke).toEqual({ color: '#FFFFFF', width: 4, scalesWithObject: true })
  })

  it('changes strokes, leaving switched-off settings out, and takes a stroke away', () => {
    const base = { color: '#000000', width: 4 }
    const dashed = setShapeStroke(project, [ref('back'), ref('pocket')], { width: 6, isDashed: true, cap: 'butt', align: 'outside' }, base)
    expect(shapesOf(dashed, 'sketch')[0]?.stroke).toEqual({ color: '#000000', width: 6, isDashed: true, cap: 'butt', align: 'outside' })
    expect(shapesOf(dashed, 'sketch')[1]?.children?.[0]?.stroke).toMatchObject({ width: 6, isDashed: true })
    const solid = setShapeStroke(dashed, [ref('back')], { isDashed: false, isBehind: true }, base)
    expect(shapesOf(solid, 'sketch')[0]?.stroke).toEqual({ color: '#000000', width: 6, cap: 'butt', align: 'outside', isBehind: true })
    expect(shapesOf(setShapeStroke(solid, [ref('back')], 'none', base), 'sketch')[0]).toEqual(shapeOf('back'))
  })

  it('copies chosen shapes back to front, a chosen child only once with its parent', () => {
    const copies = copyShapes(project, [ref('hat'), ref('pocket'), ref('coat'), ref('dot', 'other')])
    expect(copies.map((copy) => `${copy.ref.clipId}/${copy.shape.id}`)).toEqual(['sketch/coat', 'sketch/hat', 'other/dot'])
    expect(copies[0]?.shape).toBe(coat)
  })

  it('gives a copy new ids all the way down', () => {
    let next = 0
    const renamed = withNewShapeIds(coat, () => `new-${++next}`)
    expect(shapeRows([renamed]).map((row) => row.shape.id)).toEqual(['new-1', 'new-3', 'new-2'])
  })

  it('puts each duplicate right in front of its original, and finds shapes by id', () => {
    let next = 0
    const copies = copyShapes(project, [ref('back'), ref('patch')]).map((copy) => ({ ...copy, shape: withNewShapeIds(copy.shape, () => `copy-${++next}`) }))
    const duplicated = addShapesAbove(project, copies)
    expect(treeOf(duplicated)).toEqual(['0:hat', '0:coat', '1:copy-2', '1:patch', '1:pocket', '0:copy-1', '0:back'])
    expect(shapeRefsOf(duplicated, ['copy-1', 'copy-2', 'missing'])).toEqual([ref('copy-1'), ref('copy-2')])
  })
})

describe('shared colours', () => {
  const skin = { id: 'skin', name: 'Skin', color: '#FFCC99' }
  const hand: DrawingShape = { ...shapeOf('hand'), fill: '#FFCC99', fillSwatch: 'skin', stroke: { color: '#FFCC99', width: 2, swatch: 'skin' } }
  const inGroup = { ...clipOf(projectOf([track('inner', [drawingClip('far', 0, SECOND, [{ ...shapeOf('foot'), fill: '#FFCC99', fillSwatch: 'skin' }])])]), 'far') }
  const group = { id: 'body', type: 'group' as const, start: 0, duration: SECOND, transform: STILL, opacity: 1, volume: 1, tracks: [{ id: 'inner', name: '', hidden: false, locked: false, muted: false, clips: [inGroup] }] }
  const project: Project = { ...projectOf([track('art', [drawingClip('sketch', 0, SECOND, [hand, shapeOf('plain')]), group])]), swatches: [skin] }

  function footOf(edited: Project): DrawingShape | undefined {
    const body = clipOf(edited, 'body')
    const far = body.type === 'group' ? body.tracks[0]?.clips[0] : undefined
    return far?.type === 'drawing' ? far.shapes[0] : undefined
  }

  it('recolours every linked fill and stroke in the file, inside groups too', () => {
    const changed = setSwatchColor(project, 'skin', '#AA7755')
    expect(changed.swatches).toEqual([{ ...skin, color: '#AA7755' }])
    expect(shapesOf(changed, 'sketch')[0]).toMatchObject({ fill: '#AA7755', stroke: { color: '#AA7755' } })
    expect(shapesOf(changed, 'sketch')[1]).toEqual(shapeOf('plain'))
    expect(footOf(changed)?.fill).toBe('#AA7755')
  })

  it('adds, names and renames swatches, and a deleted one leaves its colour on the shapes', () => {
    expect(nextSwatchName(undefined)).toBe('Colour 1')
    expect(nextSwatchName([{ ...skin, name: 'Colour 2' }])).toBe('Colour 3')
    const added = addSwatch(project, { id: 'ink', name: 'Ink', color: '#000000' })
    expect(added.swatches?.map((swatch) => swatch.id)).toEqual(['skin', 'ink'])
    expect(renameSwatch(added, 'ink', ' Line ').swatches?.[1]?.name).toBe('Line')
    expect(renameSwatch(added, 'ink', '  ')).toBe(added)
    const deleted = deleteSwatch(project, 'skin')
    expect(deleted.swatches).toBeUndefined()
    expect(shapesOf(deleted, 'sketch')[0]).toEqual({ ...shapeOf('hand'), fill: '#FFCC99', stroke: { color: '#FFCC99', width: 2 } })
    expect(footOf(deleted)?.fillSwatch).toBeUndefined()
    expect(deleteSwatch(added, 'skin').swatches).toEqual([{ id: 'ink', name: 'Ink', color: '#000000' }])
  })

  it('keeps a link only into a file that has the swatch, with its colour', () => {
    const style = { fill: '#000000', fillSwatch: 'skin', stroke: { color: '#000000', width: 4, swatch: 'gone' } }
    expect(styleIn(style, [skin])).toEqual({ fill: '#FFCC99', fillSwatch: 'skin', stroke: { color: '#000000', width: 4 } })
    expect(styleIn(style, undefined)).toEqual({ fill: '#000000', stroke: { color: '#000000', width: 4 } })
    const pasted = withKnownSwatches({ ...hand, children: [{ ...shapeOf('nail'), fill: '#FFFFFF', fillSwatch: 'nail' }] }, [skin])
    expect(pasted).toMatchObject({ fillSwatch: 'skin', stroke: { swatch: 'skin' } })
    expect(pasted.children?.[0]?.fillSwatch).toBeUndefined()
  })
})

describe('duplicateDrawing', () => {
  const project = projectOf([
    track('art', [drawingClip('one', 0, SECOND), drawingClip('two', SECOND, SECOND), videoClip('later', 3 * SECOND, SECOND)]),
    track('other', [drawingClip('beside', SECOND, SECOND)]),
  ])

  it('puts the copy right after the drawing and moves every later clip on its track to make room', () => {
    const duplicated = duplicateDrawing(project, 'one', 'copy')
    expect(clipOf(duplicated, 'copy')).toMatchObject({ type: 'drawing', start: SECOND, duration: SECOND })
    expect(clipOf(duplicated, 'two').start).toBe(2 * SECOND)
    expect(clipOf(duplicated, 'later').start).toBe(4 * SECOND)
    expect(clipOf(duplicated, 'beside').start).toBe(SECOND)
  })

  it('leaves anything but an unlocked drawing alone', () => {
    expect(duplicateDrawing(project, 'later', 'copy')).toBe(project)
    const locked = { ...project, tracks: project.tracks.map((each) => ({ ...each, locked: true })) }
    expect(duplicateDrawing(locked, 'one', 'copy')).toBe(locked)
  })
})

describe('editing nodes', () => {
  // A square with a smooth top right corner and a shape clipped inside it, and an open line.
  const square: DrawingShape = {
    id: 'square',
    nodes: [{ x: 0, y: 0 }, { x: 30, y: 0, in: { x: -10, y: 0 }, out: { x: 10, y: 0 } }, { x: 30, y: 30 }, { x: 0, y: 30 }],
    isClosed: true,
    children: [shapeOf('inner')],
  }
  const line: DrawingShape = { id: 'line', nodes: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 30, y: 0 }], fill: '#FF0000' }
  const project = projectOf([track('art', [drawingClip('sketch', 0, SECOND, [square, line]), drawingClip('copy', SECOND, SECOND, [square])])])

  function node(shapeId: string, index: number): NodeRef {
    return { clipId: 'sketch', shapeId, index }
  }

  function nodesOf(edited: Project, shapeIndex: number, clipId = 'sketch'): ShapeNode[] {
    return shapesOf(edited, clipId)[shapeIndex]?.nodes ?? []
  }

  function xsOf(shape: DrawingShape | undefined): number[] {
    return shape?.nodes.map((each) => each.x) ?? []
  }

  it('tells smooth nodes, whose handles point away from each other, from sharp ones', () => {
    expect(nodeTypeOf({ x: 0, y: 0, in: { x: -10, y: 0 }, out: { x: 10, y: 0.1 } })).toBe('smooth')
    expect(nodeTypeOf({ x: 0, y: 0, in: { x: -10, y: 0 }, out: { x: 10, y: 1 } })).toBe('sharp')
    expect(nodeTypeOf({ x: 0, y: 0, in: { x: 10, y: 0 }, out: { x: 10, y: 0 } })).toBe('sharp')
    expect(nodeTypeOf({ x: 0, y: 0, out: { x: 10, y: 0 } })).toBe('sharp')
  })

  it('moves nodes with their handles and sets their place, only in their own drawing', () => {
    const moved = moveNodes(project, [node('square', 1), node('line', 0)], { x: 5, y: -5 }, 0)
    expect(nodesOf(moved, 0)[1]).toEqual({ x: 35, y: -5, in: { x: -10, y: 0 }, out: { x: 10, y: 0 } })
    expect(nodesOf(moved, 1)[0]).toEqual({ x: 5, y: -5 })
    expect(nodesOf(moved, 0, 'copy')).toEqual(square.nodes)
    expect(xsOf(shapesOf(setNodePosition(project, [node('square', 0), node('square', 2)], 'x', 12, 0), 'sketch')[0])).toEqual([12, 30, 12, 0])
  })

  it('turns the other handle of a smooth node along with a dragged one, unless the drag breaks it', () => {
    const turned = nodesOf(moveHandle(project, node('square', 1), 'out', { x: 0, y: 20 }, false, 0), 0)[1]
    expect(turned?.out).toEqual({ x: 0, y: 20 })
    expect(turned?.in?.x).toBeCloseTo(0)
    expect(turned?.in?.y).toBeCloseTo(-10)
    const broken = moveHandle(project, node('square', 1), 'out', { x: 0, y: 20 }, true, 0)
    expect(nodesOf(broken, 0)[1]).toMatchObject({ in: { x: -10, y: 0 }, out: { x: 0, y: 20 } })
    expect(nodesOf(moveHandle(broken, node('square', 1), 'in', { x: 0, y: 5 }, false, 0), 0)[1]).toMatchObject({ in: { x: 0, y: 5 }, out: { x: 0, y: 20 } })
  })

  it('makes a node sharp by dropping its handles, and smooth along its neighbours or its own handles', () => {
    expect(nodesOf(setNodeType(project, [node('square', 1)], 'sharp'), 0)[1]).toEqual({ x: 30, y: 0 })

    const corner = nodesOf(setNodeType(project, [node('square', 2)], 'smooth'), 0)[2]
    expect(corner?.in?.x).toBeCloseTo(10 * Math.SQRT1_2)
    expect(corner?.in?.y).toBeCloseTo(-10 * Math.SQRT1_2)
    expect(corner?.out?.x).toBeCloseTo(-10 * Math.SQRT1_2)
    expect(corner?.out?.y).toBeCloseTo(10 * Math.SQRT1_2)

    const end = nodesOf(setNodeType(project, [node('line', 0)], 'smooth'), 1)[0]
    expect(end?.in?.x).toBeCloseTo(-10 / 3)
    expect(end?.out?.x).toBeCloseTo(10 / 3)

    const broken = moveHandle(project, node('square', 1), 'out', { x: 0, y: 20 }, true, 0)
    const lined = nodesOf(setNodeType(broken, [node('square', 1)], 'smooth'), 0)[1] ?? { x: 0, y: 0 }
    expect(nodeTypeOf(lined)).toBe('smooth')
    expect(Math.hypot(lined.in?.x ?? 0, lined.in?.y ?? 0)).toBeCloseTo(10)
    expect(Math.hypot(lined.out?.x ?? 0, lined.out?.y ?? 0)).toBeCloseTo(20)
  })

  it('adds a node on a segment', () => {
    expect(xsOf(shapesOf(insertNode(project, { clipId: 'sketch', shapeId: 'line' }, 1, 0.5), 'sketch')[1])).toEqual([0, 10, 15, 20, 30])
  })

  it('deletes nodes, and a shape left with fewer than two goes with what is clipped inside it', () => {
    expect(nodesOf(deleteNodes(project, [node('line', 1), node('line', 2)]), 1)).toEqual([{ x: 0, y: 0 }, { x: 30, y: 0 }])
    const gone = deleteNodes(project, [node('square', 0), node('square', 1), node('square', 2)])
    expect(idsOf(shapesOf(gone, 'sketch'))).toEqual(['line'])
    expect(idsOf(shapesOf(gone, 'copy'))).toEqual(['square'])
  })

  it('closes open paths and leaves closed ones as they are', () => {
    const closed = shapesOf(closePaths(project, [{ clipId: 'sketch', shapeId: 'line' }, { clipId: 'sketch', shapeId: 'square' }]), 'sketch')
    expect(closed[0]).toEqual(square)
    expect(closed[1]).toEqual({ ...line, isClosed: true })
  })

  it('opens a closed path at a node, which then ends it too', () => {
    const [opened] = shapesOf(breakPaths(project, [node('square', 2)], () => 'part'), 'sketch')
    expect(opened?.isClosed).toBeUndefined()
    expect(opened?.nodes.map((each) => ({ x: each.x, y: each.y }))).toEqual([
      { x: 30, y: 30 },
      { x: 0, y: 30 },
      { x: 0, y: 0 },
      { x: 30, y: 0 },
      { x: 30, y: 30 },
    ])
    expect(opened?.children).toEqual(square.children)
  })

  it('splits paths at the chosen nodes inside them, putting the later parts right in front', () => {
    let made = 0
    function newId(): string {
      made += 1
      return `part-${made}`
    }
    const split = shapesOf(breakPaths(project, [node('line', 2), node('line', 1), node('line', 3)], newId), 'sketch')
    expect(idsOf(split)).toEqual(['square', 'line', 'part-1', 'part-2'])
    expect(split.map(xsOf)).toEqual([[0, 30, 30, 0], [0, 10], [10, 20], [20, 30]])
    expect(split[2]).toMatchObject({ fill: '#FF0000' })

    const closedSplit = shapesOf(breakPaths(project, [node('square', 1), node('square', 3)], () => 'part'), 'sketch')
    expect(idsOf(closedSplit)).toEqual(['square', 'part', 'line'])
    expect(closedSplit.slice(0, 2).map(xsOf)).toEqual([[30, 30, 0], [0, 0, 30]])
    expect(closedSplit[1]?.children).toBeUndefined()
  })

  it('leaves an open path whole when broken at its ends', () => {
    expect(shapesOf(breakPaths(project, [node('line', 0), node('line', 3)], () => 'part'), 'sketch')[1]).toEqual(line)
  })

  it('offers every node to snap to, clipped ones too, except the moving ones', () => {
    const points = nodePointsOf('sketch', [square], [node('square', 1), node('square', 2), { ...node('inner', 0), clipId: 'copy' }])
    expect(points).toEqual([{ x: 0, y: 0 }, { x: 0, y: 30 }, { x: 0, y: 0 }, { x: 10, y: 10 }])
  })
})

describe('node keys and sets', () => {
  const arm: DrawingShape = { id: 'arm', nodes: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0, out: { x: 4, y: 0 } }] }
  const body: DrawingShape = { id: 'body', nodes: [{ x: 50, y: 50 }, { x: 60, y: 50 }] }
  const project = projectOf([track('art', [drawingClip('sketch', 0, SECOND, [arm, body])])])
  const elbow = { clipId: 'sketch', setId: 'elbow' }
  const ramp = (from: number, to: number): Keyframe[] => [
    { time: 0, value: from, easing: 'linear' },
    { time: 10 * FRAME, value: to, easing: 'linear' },
  ]

  function node(shapeId: string, index: number): NodeRef {
    return { clipId: 'sketch', shapeId, index }
  }

  function drawingOf(edited: Project): DrawingClip {
    const clip = clipOf(edited, 'sketch')
    if (clip.type !== 'drawing') throw new Error('sketch is not a drawing')
    return clip
  }

  function armAt(edited: Project, index: number): ShapeNode | undefined {
    return shapesOf(edited, 'sketch')[0]?.nodes[index]
  }

  function posedArmAt(edited: Project, index: number, local: number): ShapeNode | undefined {
    return posedShapes(drawingOf(edited), local)[0]?.nodes[index]
  }

  function withDrawing(change: (clip: DrawingClip) => DrawingClip): Project {
    return projectOf([track('art', [change(drawingOf(project))])])
  }

  // Elbow holds the arm's last two nodes and is turned a quarter clockwise around the arm's start.
  const turnedArm = withDrawing((clip) => ({
    ...clip,
    shapes: [{ ...arm, nodes: [{ x: 0, y: 0 }, { x: 10, y: 0, sets: ['elbow'] }, { x: 20, y: 0, out: { x: 4, y: 0 }, sets: ['elbow'] }] }, body],
    nodeSets: [{ id: 'elbow', name: 'Elbow', pivot: { x: 0, y: 0 }, keyframes: { rotation: [{ time: 0, value: 90, easing: 'linear' }] } }],
  }))

  it('moves an unkeyed node on every frame, and records offset keys at the playhead only for a keyed one', () => {
    const keyed = setNodeKeys(project, [node('arm', 2)], 0, true)
    expect(armAt(keyed, 2)?.keyframes).toEqual({ x: [{ time: 0, value: 0, easing: 'linear' }], y: [{ time: 0, value: 0, easing: 'linear' }] })
    expect(hasNodeKeysAt(keyed, [node('arm', 2)], 0)).toBe(true)
    expect(hasNodeKeysAt(keyed, [node('arm', 1), node('arm', 2)], 0)).toBe(false)

    const moved = moveNodes(keyed, [node('arm', 1), node('arm', 2)], { x: 5, y: 0 }, 10 * FRAME)
    expect(armAt(moved, 1)).toEqual({ x: 15, y: 0 })
    expect(armAt(moved, 2)).toMatchObject({ x: 20, keyframes: { x: ramp(0, 5) } })
    expect(posedArmAt(moved, 2, 5 * FRAME)?.x).toBeCloseTo(22.5, 10)
    expect(moveNodes(keyed, [node('arm', 2)], { x: 0, y: 0 }, 10 * FRAME)).toEqual(keyed)
  })

  it('turns moves back through the sets turning a node, so it follows the pointer, and handles too', () => {
    const moved = moveNodes(turnedArm, [node('arm', 2)], { x: 5, y: 0 }, 0)
    expect(posedArmAt(moved, 2, 0)?.x).toBeCloseTo(5, 10)
    expect(posedArmAt(moved, 2, 0)?.y).toBeCloseTo(20, 10)
    expect(posedArmAt(setNodePosition(turnedArm, [node('arm', 2)], 'y', 25, 0), 2, 0)?.y).toBeCloseTo(25, 10)
    const handle = armAt(moveHandle(turnedArm, node('arm', 2), 'out', { x: 0, y: 10 }, false, 0), 2)?.out
    expect(handle?.x).toBeCloseTo(10, 10)
    expect(handle?.y).toBeCloseTo(0, 10)
  })

  it('removes the keys at the playhead, and the last key leaves its offset on the place', () => {
    const keyed = withDrawing((clip) => ({ ...clip, shapes: [{ ...arm, nodes: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0, keyframes: { x: ramp(0, 5), y: [{ time: 10 * FRAME, value: 2, easing: 'linear' }] } }] }, body] }))
    const once = setNodeKeys(keyed, [node('arm', 2)], 0, false)
    expect(armAt(once, 2)).toEqual({ x: 20, y: 0, keyframes: { x: [{ time: 10 * FRAME, value: 5, easing: 'linear' }], y: [{ time: 10 * FRAME, value: 2, easing: 'linear' }] } })
    expect(armAt(setNodeKeys(once, [node('arm', 2)], 10 * FRAME, false), 2)).toEqual({ x: 25, y: 2 })
  })

  it('saves a set around the middle of the chosen nodes as they show, names it, and deletes it from every node', () => {
    const saved = addNodeSet(turnedArm, [node('arm', 0), node('arm', 1)], 'shoulder', 0)
    const shoulder = drawingOf(saved).nodeSets?.[1]
    expect(shoulder).toMatchObject({ id: 'shoulder', name: 'Set 2' })
    expect(shoulder?.pivot.x).toBeCloseTo(0, 10)
    expect(shoulder?.pivot.y).toBeCloseTo(5, 10)
    expect(armAt(saved, 1)?.sets).toEqual(['elbow', 'shoulder'])
    expect(drawingOf(renameNodeSet(saved, { clipId: 'sketch', setId: 'shoulder' }, ' Arm ')).nodeSets?.[1]?.name).toBe('Arm')
    expect(drawingOf(setNodeSetPivot(saved, elbow, { x: 3, y: 4 })).nodeSets?.[0]?.pivot).toEqual({ x: 3, y: 4 })

    const deleted = deleteNodeSet(saved, elbow)
    expect(drawingOf(deleted).nodeSets?.map((set) => set.id)).toEqual(['shoulder'])
    expect(armAt(deleted, 1)?.sets).toEqual(['shoulder'])
    expect(armAt(deleted, 2)).not.toHaveProperty('sets')
    expect(drawingOf(deleteNodeSet(deleted, { clipId: 'sketch', setId: 'shoulder' }))).not.toHaveProperty('nodeSets')
  })

  it('keys a set every time it turns or moves: rotation alone, x and y together', () => {
    const turned = setNodeSetPose(turnedArm, elbow, { rotation: 45 }, 10 * FRAME)
    expect(drawingOf(turned).nodeSets?.[0]?.keyframes).toEqual({ rotation: [{ time: 0, value: 90, easing: 'linear' }, { time: 10 * FRAME, value: 45, easing: 'linear' }] })
    const moved = setNodeSetPose(turned, elbow, { x: 3 }, 10 * FRAME)
    expect(drawingOf(moved).nodeSets?.[0]?.keyframes).toMatchObject({ x: [{ time: 10 * FRAME, value: 3 }], y: [{ time: 10 * FRAME, value: 0 }] })
    expect(hasSetKeysAt(moved, [elbow], 'position', 10 * FRAME)).toBe(true)
    expect(hasSetKeysAt(moved, [elbow], 'position', 0)).toBe(false)

    const unturned = setNodeSetKeys(setNodeSetKeys(moved, elbow, 'rotation', 10 * FRAME, false), elbow, 'rotation', 0, false)
    expect(drawingOf(unturned).nodeSets?.[0]?.keyframes).not.toHaveProperty('rotation')
    expect(drawingOf(setNodeSetKeys(unturned, elbow, 'rotation', 0, true)).nodeSets?.[0]?.keyframes?.rotation).toEqual([{ time: 0, value: 0, easing: 'linear' }])
  })

  // The arm's last node and Elbow are keyed at 0 and 10 frames, the body's first node at 10 frames only.
  const animated = withDrawing((clip) => ({
    ...clip,
    shapes: [
      { ...arm, nodes: [{ x: 0, y: 0 }, { x: 10, y: 0, sets: ['elbow'] }, { x: 20, y: 0, sets: ['elbow'], keyframes: { x: ramp(0, 5) } }] },
      { ...body, nodes: [{ x: 50, y: 50, keyframes: { y: [{ time: 10 * FRAME, value: 1, easing: 'linear' }] } }, { x: 60, y: 50 }] },
    ],
    nodeSets: [{ id: 'elbow', name: 'Elbow', pivot: { x: 0, y: 0 }, keyframes: { rotation: ramp(0, 90) } }],
  }))
  const armScope = { clipId: 'sketch', shapeId: 'arm' }
  const elbowOf = (edited: Project): NodeSet | undefined => drawingOf(edited).nodeSets?.[0]

  it('lists the moments with keys for the drawing or one shape with the sets holding its nodes', () => {
    expect(drawingKeyTimes(drawingOf(animated))).toEqual([0, 10 * FRAME])
    expect(drawingKeyTimes(drawingOf(animated), 'body')).toEqual([10 * FRAME])
    expect(drawingKeyTimes(drawingOf(animated), 'arm')).toEqual([0, 10 * FRAME])
  })

  it('eases and deletes the keys of one moment', () => {
    const eased = setKeysEasing(animated, armScope, 0, 'easeIn')
    expect(armAt(eased, 2)?.keyframes?.x?.[0]?.easing).toBe('easeIn')
    expect(elbowOf(eased)?.keyframes?.rotation?.[0]?.easing).toBe('easeIn')
    expect(shapesOf(eased, 'sketch')[1]).toEqual(shapesOf(animated, 'sketch')[1])

    const deleted = deleteKeysAt(animated, { clipId: 'sketch' }, 10 * FRAME)
    expect(shapesOf(deleted, 'sketch')[1]?.nodes[0]).toEqual({ x: 50, y: 51 })
    expect(elbowOf(deleted)?.keyframes?.rotation).toEqual([{ time: 0, value: 0, easing: 'linear' }])
  })

  it('moves the keys of a moment in time, inside the drawing and short of the next key', () => {
    const later = moveKeysAt(animated, armScope, 10 * FRAME, 20 * FRAME + 30)
    expect(armAt(later, 2)?.keyframes?.x?.[1]?.time).toBe(20 * FRAME)
    expect(elbowOf(later)?.keyframes?.rotation?.[1]?.time).toBe(20 * FRAME)
    expect(shapesOf(later, 'sketch')[1]?.nodes[0]?.keyframes?.y?.[0]?.time).toBe(10 * FRAME)
    expect(armAt(moveKeysAt(animated, armScope, 10 * FRAME, 2 * SECOND), 2)?.keyframes?.x?.[1]?.time).toBe(SECOND)
    expect(armAt(moveKeysAt(animated, armScope, 10 * FRAME, -FRAME), 2)?.keyframes?.x?.[1]?.time).toBe(TIMELINE_GRID)
  })

  it('copies the keys of a moment and pastes them at the playhead onto the same nodes and sets', () => {
    const copied = copyKeysAt(drawingOf(animated), 'arm', 0)
    expect(copied).toEqual({ nodes: [{ shapeId: 'arm', index: 2, x: { value: 0, easing: 'linear' } }], sets: [{ setId: 'elbow', rotation: { value: 0, easing: 'linear' } }] })
    const pasted = pasteKeys(animated, 'sketch', copied, 20 * FRAME)
    expect(armAt(pasted, 2)?.keyframes?.x?.[2]).toEqual({ time: 20 * FRAME, value: 0, easing: 'linear' })
    expect(elbowOf(pasted)?.keyframes?.rotation?.[2]).toEqual({ time: 20 * FRAME, value: 0, easing: 'linear' })
  })

  it('carries keys and whole sets along when shapes move, scale, split, trim or land in another drawing', () => {
    const at = (x: number, scale: number): { x: number; y: number; scaleX: number; scaleY: number; rotation: number } => ({ x, y: 0, scaleX: scale, scaleY: scale, rotation: 0 })
    const moved = transformShapes(animated, [{ clipId: 'sketch', shapeId: 'arm' }], at(0, 1), at(100, 2), 0)
    expect(armAt(moved, 2)).toMatchObject({ x: 140, sets: ['elbow'], keyframes: { x: ramp(0, 10) } })
    expect(elbowOf(moved)?.pivot).toEqual({ x: 100, y: 0 })
    expect(elbowOf(transformShapes(animated, [{ clipId: 'sketch', shapeId: 'body' }], at(0, 1), at(100, 1), 0))?.pivot).toEqual({ x: 0, y: 0 })

    const inserted = shapesOf(insertNode(animated, { clipId: 'sketch', shapeId: 'arm' }, 1, 0.5), 'sketch')[0]?.nodes
    expect(inserted?.map((each) => each.sets)).toEqual([undefined, ['elbow'], ['elbow'], ['elbow']])

    const later = laterPart(drawingOf(animated), 5 * FRAME)
    expect(later.type === 'drawing' && later.nodeSets?.[0]?.keyframes?.rotation?.map((key) => key.time)).toEqual([-5 * FRAME, 5 * FRAME])

    const place = drawingPlace(project, 2 * SECOND, [], [], { clipId: 'new', trackId: 'top' })
    const landed = addDrawingShapes(animated, place, [shapesOf(animated, 'sketch')[0] ?? arm])
    expect(shapesOf(landed, 'new')[0]?.nodes.map((each) => each.sets)).toEqual([undefined, undefined, undefined])
  })

  function expectNear(point: { x: number; y: number } | undefined, x: number, y: number): void {
    expect(point?.x).toBeCloseTo(x, 10)
    expect(point?.y).toBeCloseTo(y, 10)
  }

  it('moves a shape that follows a set, turns its moves back, and lets go of a set it cannot follow', () => {
    const bodyShape = { clipId: 'sketch', shapeId: 'body' }
    const following = setShapesFollow(turnedArm, [bodyShape], 'elbow')
    expect(shapesOf(following, 'sketch')[1]?.follows).toBe('elbow')
    expectNear(posedShapes(drawingOf(following), 0)[1]?.nodes[0], -50, 50)
    expectNear(posedShapes(drawingOf(moveNodes(following, [node('body', 0)], { x: 5, y: 0 }, 0)), 0)[1]?.nodes[0], -45, 50)
    expect(drawingKeyTimes(drawingOf(following), 'body')).toEqual([0])
    expect(setShapesFollow(following, [bodyShape], 'missing')).toEqual(following)
    expect(shapesOf(setShapesFollow(following, [bodyShape], undefined), 'sketch')[1]).not.toHaveProperty('follows')
    expect(shapesOf(deleteNodeSet(following, elbow), 'sketch')[1]).not.toHaveProperty('follows')

    const place = drawingPlace(project, 2 * SECOND, [], [], { clipId: 'new', trackId: 'top' })
    const landed = addDrawingShapes(following, place, [shapesOf(following, 'sketch')[1] ?? body])
    expect(shapesOf(landed, 'new')[0]).not.toHaveProperty('follows')
  })

  // Wrist holds the arm's last node and Tip nothing; Elbow turns a quarter around the arm's start.
  const rigged = withDrawing((clip) => ({
    ...clip,
    shapes: [{ ...arm, nodes: [{ x: 0, y: 0 }, { x: 10, y: 0, sets: ['elbow'] }, { x: 20, y: 0, sets: ['wrist'] }] }, body],
    nodeSets: [
      { id: 'elbow', name: 'Elbow', pivot: { x: 0, y: 0 }, keyframes: { rotation: [{ time: 0, value: 90, easing: 'linear' }] } },
      { id: 'wrist', name: 'Wrist', pivot: { x: 10, y: 0 } },
      { id: 'tip', name: 'Tip', pivot: { x: 20, y: 0 }, parent: 'wrist' },
    ],
  }))
  const wrist = { clipId: 'sketch', setId: 'wrist' }

  it('parents a set without loops, and carries its pivot and nodes with the parent', () => {
    const parented = setNodeSetParent(rigged, wrist, 'elbow')
    expect(drawingOf(parented).nodeSets?.[1]?.parent).toBe('elbow')
    expect(parentChoices(drawingOf(parented), 'elbow')).toEqual([])
    expect(parentChoices(drawingOf(parented), 'wrist').map((set) => set.id)).toEqual(['elbow'])
    expect(setNodeSetParent(parented, elbow, 'tip')).toEqual(parented)
    expect(drawingOf(setNodeSetParent(parented, wrist, undefined)).nodeSets?.[1]).not.toHaveProperty('parent')

    expectNear(shownPivot(drawingOf(parented), 'wrist', 0), 0, 10)
    expect(turnAndScaleAboveSet(drawingOf(parented), 'tip', 0)).toEqual({ rotation: 90, scale: 1 })
    expect(turnAndScaleAboveSet(drawingOf(parented), 'elbow', 0)).toEqual({ rotation: 0, scale: 1 })
    expectNear(posedArmAt(parented, 2, 0), 0, 20)
    expectNear(posedArmAt(moveNodes(parented, [node('arm', 2)], { x: 5, y: 0 }, 0), 2, 0), 5, 20)
  })

  it('gives the children of a deleted set its parent', () => {
    const parented = setNodeSetParent(rigged, wrist, 'elbow')
    expect(drawingOf(deleteNodeSet(parented, wrist)).nodeSets?.[1]).toMatchObject({ id: 'tip', parent: 'elbow' })
    expect(drawingOf(deleteNodeSet(rigged, wrist)).nodeSets?.[1]).not.toHaveProperty('parent')
  })

  const bodyShape = { clipId: 'sketch', shapeId: 'body' }
  const armShape = { clipId: 'sketch', shapeId: 'arm' }

  function setOf(edited: Project, setId: string): NodeSet | undefined {
    return drawingOf(edited).nodeSets?.find((set) => set.id === setId)
  }

  it('keys a shape on a set of its own, named after it, around its middle and inside the set it followed', () => {
    const keyed = setShapesKeys(setShapesFollow(turnedArm, [bodyShape], 'elbow'), [bodyShape], 'rotation', 0, true, () => 'body-own')
    const own = setOf(keyed, 'body-own')
    expect(own).toMatchObject({ name: 'Shape', parent: 'elbow', keyframes: { rotation: [{ time: 0, value: 0, easing: 'linear' }] } })
    expectNear(own?.pivot, 55, 50)
    expect(shapesOf(keyed, 'sketch')[1]).toMatchObject({ follows: 'body-own', ownsSet: true })
    expectNear(posedShapes(drawingOf(keyed), 0)[1]?.nodes[0], -50, 50)
    expect(hasShapeKeysAt(keyed, [bodyShape], 'rotation', 0)).toBe(true)
    expect(hasShapeKeysAt(keyed, [bodyShape, armShape], 'rotation', 0)).toBe(false)
    expect(shapePoseAt(keyed, bodyShape, 0)).toEqual({ rotation: 0, scale: 1, x: 0, y: 0 })

    const grown = setShapesPose(keyed, [bodyShape], { scale: 2 }, 0, () => 'unused')
    expect(setOf(grown, 'body-own')?.keyframes?.scale).toEqual([{ time: 0, value: 2, easing: 'linear' }])
    expectNear(posedShapes(drawingOf(grown), 0)[1]?.nodes[0], -50, 45)
  })

  it('records the box turning, scaling and moving a keyed shape as keys on its set, and moves unkeyed shapes in place', () => {
    const keyed = setShapesKeys(project, [armShape], 'rotation', 0, true, () => 'arm-own')
    const box = { x: 10, y: 0, scaleX: 1, scaleY: 1, rotation: 0 }
    const turnedBox = transformShapes(keyed, [armShape], box, { ...box, rotation: 90 }, 10 * FRAME)
    expect(setOf(turnedBox, 'arm-own')?.keyframes).toEqual({ rotation: [{ time: 0, value: 0, easing: 'linear' }, { time: 10 * FRAME, value: 90, easing: 'linear' }] })
    expectNear(posedArmAt(turnedBox, 0, 10 * FRAME), 10, -10)
    expect(setOf(transformShapes(keyed, [armShape], box, { ...box, scaleX: 2, scaleY: 2 }, 0), 'arm-own')?.keyframes?.scale).toEqual([{ time: 0, value: 2, easing: 'linear' }])

    const moved = transformShapes(keyed, [armShape, bodyShape], box, { ...box, x: 15 }, 0)
    expect(setOf(moved, 'arm-own')?.keyframes).toMatchObject({ x: [{ time: 0, value: 5 }], y: [{ time: 0, value: 0 }] })
    expect(armAt(moved, 0)).toEqual({ x: 0, y: 0 })
    expect(shapesOf(moved, 'sketch')[1]?.nodes[0]).toEqual({ x: 55, y: 50 })
  })

  it('leaves the shapes clipped inside a keyed shape to follow it, and lets copies follow without owning', () => {
    const lining: DrawingShape = { id: 'lining', nodes: [{ x: 2, y: 0 }, { x: 4, y: 0 }] }
    const lined = withDrawing((clip) => ({ ...clip, shapes: [{ ...arm, children: [lining] }, body] }))
    const keyed = setShapesKeys(lined, [armShape], 'position', 0, true, () => 'arm-own')
    const box = { x: 10, y: 0, scaleX: 1, scaleY: 1, rotation: 0 }
    const moved = transformShapes(keyed, [armShape, { clipId: 'sketch', shapeId: 'lining' }], box, { ...box, y: 7 }, 0)
    expect(shapesOf(moved, 'sketch')[0]?.children?.[0]?.nodes[0]).toEqual({ x: 2, y: 0 })
    expectNear(posedShapes(drawingOf(moved), 0)[0]?.children?.[0]?.nodes[0], 2, 7)

    const copy = withNewShapeIds(shapesOf(keyed, 'sketch')[0] ?? arm, () => 'copy')
    expect(copy.follows).toBe('arm-own')
    expect(copy).not.toHaveProperty('ownsSet')
    expect(setOf(deleteShapes(keyed, [armShape]), 'arm-own')).toBeDefined()
    expect(shapesOf(deleteNodeSet(keyed, { clipId: 'sketch', setId: 'arm-own' }), 'sketch')[0]).not.toHaveProperty('ownsSet')
  })

  it('makes a keyed shape follow through its own set', () => {
    const keyed = setShapesKeys(turnedArm, [bodyShape], 'rotation', 0, true, () => 'body-own')
    const following = setShapesFollow(keyed, [bodyShape], 'elbow')
    expect(setOf(following, 'body-own')?.parent).toBe('elbow')
    const body = shapesOf(following, 'sketch')[1]
    expect(body).toMatchObject({ follows: 'body-own', ownsSet: true })
    expect(body === undefined ? undefined : followedSetOf(drawingOf(following), body)).toBe('elbow')
    expect(followChoices(drawingOf(following), body === undefined ? [] : [body]).map((set) => set.id)).toEqual(['elbow'])
  })

  it('gives a node added between keyed nodes keys that keep it on the outline at every key', () => {
    const keyedArm = withDrawing((clip) => ({ ...clip, shapes: [{ ...arm, nodes: [{ x: 0, y: 0 }, { x: 10, y: 0, keyframes: { y: ramp(0, 10) } }, { x: 20, y: 0, keyframes: { x: ramp(0, 6) } }] }, body] }))
    const inserted = insertNode(keyedArm, armScope, 1, 0.5)
    expect(armAt(inserted, 2)).toEqual({ x: 15, y: 0, keyframes: { x: ramp(0, 3), y: ramp(0, 5) } })
    expectNear(posedArmAt(inserted, 2, 5 * FRAME), 16.5, 2.5)
    expect(armAt(insertNode(project, armScope, 1, 0.5), 2)).toEqual({ x: 15, y: 0 })
  })

  it('keeps keys and sets on their own nodes when nodes go, paths break or close, and node types change', () => {
    expect(shapesOf(deleteNodes(animated, [node('arm', 1)]), 'sketch')[0]?.nodes).toEqual([{ x: 0, y: 0 }, { x: 20, y: 0, sets: ['elbow'], keyframes: { x: ramp(0, 5) } }])

    const [first, second] = shapesOf(breakPaths(animated, [node('arm', 1)], () => 'forearm'), 'sketch')
    expect(first?.nodes).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0, sets: ['elbow'] }])
    expect(second).toMatchObject({ id: 'forearm', nodes: [{ x: 10, y: 0, sets: ['elbow'] }, { x: 20, y: 0, sets: ['elbow'], keyframes: { x: ramp(0, 5) } }] })

    expect(shapesOf(closePaths(animated, [armScope]), 'sketch')[0]?.nodes).toEqual(shapesOf(animated, 'sketch')[0]?.nodes)
    expect(armAt(setNodeType(animated, [node('arm', 2)], 'smooth'), 2)).toMatchObject({ x: 20, sets: ['elbow'], keyframes: { x: ramp(0, 5) } })
  })
})
