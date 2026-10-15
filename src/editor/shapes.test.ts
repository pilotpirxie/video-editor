import { describe, expect, it } from 'vitest'
import { SECOND, clipOf, projectOf, reopened, track, videoClip } from '../../test/fixtures.js'
import type { Project } from '../shared/project.js'
import { addShape, isShape, setShapeStyle, type ShapeKind } from './shapes.js'

const NEW_TRACK = { id: 'new-track', name: 'Track 2' }

function withShape(kind: ShapeKind): Project {
  const project = projectOf([track('footage', [videoClip('footage', 0, 10 * SECOND)])])
  return addShape(project, { kind, clipId: kind, start: 2 * SECOND, duration: 5 * SECOND, newTrack: NEW_TRACK })
}

describe('addShape', () => {
  it.each<ShapeKind>(['blur', 'pixelate', 'highlight', 'spotlight'])('adds a %s in the middle of the canvas on a new top track, in a form the project file accepts', (kind) => {
    const project = withShape(kind)
    expect(project.tracks.map((entry) => entry.id)).toEqual(['footage', 'new-track'])
    const clip = clipOf(project, kind)
    expect(clip).toMatchObject({ start: 2 * SECOND, duration: 5 * SECOND, opacity: 1, transform: { x: 960, y: 540, scaleX: 1, scaleY: 1, rotation: 0 } })
    expect(isShape(clip)).toBe(true)
    expect(reopened(project)).toEqual(project)
  })

  it('tells the four kinds apart by type and switch', () => {
    expect(clipOf(withShape('blur'), 'blur')).toMatchObject({ type: 'blur', width: 576, height: 216, shape: 'rectangle', strength: 24 })
    expect(clipOf(withShape('pixelate'), 'pixelate')).toMatchObject({ type: 'blur', strength: 40, isPixelated: true })
    expect(clipOf(withShape('highlight'), 'highlight')).toMatchObject({ type: 'highlight', shape: 'rectangle', color: '#ffe94d' })
    expect(clipOf(withShape('spotlight'), 'spotlight')).toMatchObject({ type: 'highlight', shape: 'ellipse', softEdge: 30, color: '#404040', isSpotlight: true })
  })
})

describe('setShapeStyle', () => {
  it('changes shape, edge and strength of a blur and turns it into pixels and back', () => {
    const project = withShape('blur')
    const styled = setShapeStyle(project, ['blur'], { shape: 'ellipse', softEdge: 12, strength: 0, isPixelated: true })
    expect(clipOf(styled, 'blur')).toMatchObject({ shape: 'ellipse', softEdge: 12, strength: 0.1, isPixelated: true })
    expect(reopened(styled)).toEqual(styled)
    const back = setShapeStyle(styled, ['blur'], { isPixelated: false })
    expect(JSON.stringify(reopened(back))).not.toContain('isPixelated')
    expect(setShapeStyle(project, ['blur'], { softEdge: 0, strength: 24 })).toBe(project)
  })

  it('changes the colour of a highlight, refuses one the file would not take, and makes it a spotlight', () => {
    const project = withShape('highlight')
    expect(clipOf(setShapeStyle(project, ['highlight'], { color: '#00ff00', isSpotlight: true }), 'highlight')).toMatchObject({ color: '#00ff00', isSpotlight: true })
    expect(setShapeStyle(project, ['highlight'], { color: 'yellow' })).toBe(project)
    expect(setShapeStyle(project, ['highlight'], { softEdge: -5 })).toBe(project)
  })

  it('ignores settings a clip does not have, and clips that are not shapes', () => {
    const project = withShape('blur')
    expect(setShapeStyle(project, ['blur', 'footage'], { color: '#00ff00', isSpotlight: true })).toBe(project)
  })
})
