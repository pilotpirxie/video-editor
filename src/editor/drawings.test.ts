import { describe, expect, it } from 'vitest'
import { FRAME, SECOND, clipOf, drawingClip, projectOf, track, videoClip } from '../../test/fixtures.js'
import type { DrawingShape, Project } from '../shared/project.js'
import {
  NEW_SHAPE_STYLE,
  addDrawingShapes,
  addShapesAbove,
  arrangeShapes,
  copyShapes,
  deleteShapes,
  dragBox,
  drawingPlace,
  ellipseShape,
  pickableShape,
  rectangleShape,
  renameShape,
  reorderShape,
  setShapeColor,
  setShapeFlag,
  shapeRefsOf,
  shapeRows,
  targetTrackIndex,
  transformShapes,
  withNewShapeIds,
  type ArrangePlace,
  type DrawingPlace,
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
      stroke: { color: '#000000', width: 4 },
    })
    const ellipse = ellipseShape('sun', BOX, { fill: '#112233', stroke: { color: '#445566', width: 4 } })
    expect(ellipse).toMatchObject({ name: 'Ellipse', isClosed: true, fill: '#112233', stroke: { color: '#445566' } })
    expect(ellipse.nodes.map((node) => ({ x: node.x, y: node.y }))).toEqual([{ x: 60, y: 20 }, { x: 110, y: 50 }, { x: 60, y: 80 }, { x: 10, y: 50 }])
    expect(ellipse.nodes[0]?.out?.x).toBeCloseTo(27.615)
    expect(ellipse.nodes[1]?.out?.y).toBeCloseTo(16.569)
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
    return shapesOf(transformShapes(project, shapes, STILL, { ...STILL, ...to }), 'sketch')
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

  it('reorders a shape among its siblings only, onto a sibling or anything inside it', () => {
    expect(treeOf(reorderShape(project, ref('hat'), 'back'))).toEqual(['0:coat', '1:patch', '1:pocket', '0:back', '0:hat'])
    expect(treeOf(reorderShape(project, ref('back'), 'pocket'))).toEqual(['0:hat', '0:back', '0:coat', '1:patch', '1:pocket'])
    expect(treeOf(reorderShape(project, ref('pocket'), 'patch'))).toEqual(['0:hat', '0:coat', '1:pocket', '1:patch', '0:back'])
    expect(reorderShape(project, ref('pocket'), 'hat')).toEqual(project)
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
    expect(shapesOf(stroked, 'sketch')[2]?.stroke).toEqual({ color: '#00FF00', width: NEW_SHAPE_STYLE.stroke.width })
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
