import { describe, expect, it } from 'vitest'
import { SECOND, clipIds, clipOf, projectOf, reopened, track, videoClip } from '../../test/fixtures.js'
import type { Project } from '../shared/project.js'
import { ANNOTATION_KINDS, addAnnotation, addArrow, addCallout, arrowBetween, arrowEnds, canvasPointToClip, clipPointToCanvas, setArrowStyle, setCalloutStyle } from './annotations.js'
import { setTextStyle } from './text.js'

const NEW_TRACK = { id: 'notes', name: 'Track 2' }

function sample(): Project {
  const project = projectOf([track('t1', [videoClip('a', 0, 10 * SECOND)])])
  const withCallout = addCallout(project, { clipId: 'callout', start: SECOND, duration: 5 * SECOND, newTrack: NEW_TRACK })
  return addArrow(withCallout, { clipId: 'arrow', start: SECOND, duration: 5 * SECOND, newTrack: { id: 'arrows', name: 'Track 3' }, kind: 'arrow' })
}

describe('adding annotations', () => {
  it('adds a speech bubble and an arrow in the middle of the canvas, each on a new top track', () => {
    const project = sample()
    expect(clipIds(project)).toEqual([['a'], ['callout'], ['arrow']])
    expect(clipOf(project, 'callout')).toMatchObject({ type: 'callout', shape: 'speechBubble', width: 576, height: 216, text: 'Callout', duration: 5 * SECOND, tail: { x: -173, y: 194 } })
    expect(clipOf(project, 'arrow')).toMatchObject({ type: 'arrow', length: 480, thickness: 8, startHead: 'none', endHead: 'triangle', transform: { x: 960, y: 540 } })
    expect(reopened(project)).toEqual(project)
  })

  it('adds a line as an arrow without heads', () => {
    const project = addArrow(projectOf([]), { clipId: 'line', start: 0, duration: 5 * SECOND, newTrack: NEW_TRACK, kind: 'line' })
    expect(clipOf(project, 'line')).toMatchObject({ startHead: 'none', endHead: 'none' })
  })

  it('adds every kind where it was dropped: on the chosen track when it is free, with its middle at the chosen point', () => {
    const project = projectOf([track('t1', [videoClip('a', 0, 2 * SECOND)]), track('t2', [])])
    for (const kind of ANNOTATION_KINDS) {
      const dropped = addAnnotation(project, kind, { clipId: 'note', start: 3 * SECOND, duration: 5 * SECOND, trackIndex: 0, newTrack: NEW_TRACK, centre: { x: 200, y: 100 } })
      expect(clipIds(dropped)).toEqual([['a', 'note'], []])
      expect(clipOf(dropped, 'note')).toMatchObject({ start: 3 * SECOND, transform: { x: 200, y: 100 } })
      reopened(dropped)
    }
  })

  it('goes on a new track above the chosen one when its place there is taken', () => {
    const project = projectOf([track('t1', [videoClip('a', 0, 10 * SECOND)]), track('t2', [videoClip('b', 20 * SECOND, SECOND)])])
    expect(clipIds(addAnnotation(project, 'blur', { clipId: 'note', start: SECOND, duration: 5 * SECOND, trackIndex: 0, newTrack: NEW_TRACK }))).toEqual([['a'], ['note'], ['b']])
  })
})

describe('setCalloutStyle', () => {
  const project = sample()

  it('changes the box, the colours and the border', () => {
    const styled = setCalloutStyle(project, ['callout'], { width: 300, height: 100, fill: '#ffee00', borderColor: '#00000080', borderWidth: 0 })
    expect(clipOf(styled, 'callout')).toMatchObject({ width: 300, height: 100, fill: '#ffee00', borderColor: '#00000080', borderWidth: 0 })
    expect(reopened(styled)).toEqual(styled)
  })

  it('takes the tail away with a shape that has none and gives a bubble a new one', () => {
    const boxed = setCalloutStyle(project, ['callout'], { shape: 'banner' })
    expect(clipOf(boxed, 'callout')).toMatchObject({ shape: 'banner' })
    expect('tail' in clipOf(reopened(boxed), 'callout')).toBe(false)
    const bubble = setCalloutStyle(boxed, ['callout'], { shape: 'thoughtBubble' })
    expect(clipOf(bubble, 'callout')).toMatchObject({ shape: 'thoughtBubble', tail: { x: -173, y: 194 } })
    expect(reopened(bubble)).toEqual(bubble)
  })

  it('moves the tail of a bubble and ignores a tail for other shapes', () => {
    expect(clipOf(setCalloutStyle(project, ['callout'], { tail: { x: 400, y: -20 } }), 'callout')).toMatchObject({ tail: { x: 400, y: -20 } })
    const boxed = setCalloutStyle(project, ['callout'], { shape: 'rectangle' })
    expect(setCalloutStyle(boxed, ['callout'], { tail: { x: 1, y: 1 } })).toBe(boxed)
  })

  it('ignores what the file format would refuse and leaves other clips alone', () => {
    expect(setCalloutStyle(project, ['callout'], { fill: 'white' })).toBe(project)
    expect(setCalloutStyle(project, ['arrow', 'a'], { width: 10 })).toBe(project)
    expect(clipOf(setCalloutStyle(project, ['callout'], { width: 0, borderWidth: -3 }), 'callout')).toMatchObject({ width: 1, borderWidth: 0 })
  })

  it('has its words styled like a text clip, and may be left without words', () => {
    const styled = setTextStyle(project, ['callout'], { text: '', weight: 700, hasBackground: true, boxWidth: 200 })
    expect(clipOf(styled, 'callout')).toMatchObject({ text: '', font: { weight: 700 } })
    expect(clipOf(styled, 'callout')).not.toHaveProperty('background')
    expect(reopened(styled)).toEqual(styled)
  })
})

describe('setArrowStyle', () => {
  const project = sample()

  it('changes length, thickness, colour and heads', () => {
    const styled = setArrowStyle(project, ['arrow'], { length: 200, thickness: 3, color: '#00ff00', startHead: 'dot', endHead: 'open' })
    expect(clipOf(styled, 'arrow')).toMatchObject({ length: 200, thickness: 3, color: '#00ff00', startHead: 'dot', endHead: 'open' })
    expect(reopened(styled)).toEqual(styled)
  })

  it('leaves unchanged arrows and other clips alone', () => {
    expect(setArrowStyle(project, ['arrow'], { length: 480, color: 'green' })).toBe(project)
    expect(setArrowStyle(project, ['callout'], { length: 10 })).toBe(project)
  })
})

describe('arrow ends', () => {
  const transform = { x: 500, y: 300, scaleX: 2, scaleY: 2, rotation: 90 }

  it('finds the two ends of a turned and scaled arrow', () => {
    const { start, end } = arrowEnds(transform, 100)
    expect(start.x).toBeCloseTo(500)
    expect(start.y).toBeCloseTo(200)
    expect(end.x).toBeCloseTo(500)
    expect(end.y).toBeCloseTo(400)
  })

  it('places an arrow between two points, keeping its scale', () => {
    const between = arrowBetween({ x: 100, y: 100 }, { x: 100, y: 500 }, transform)
    expect(between).toMatchObject({ x: 100, y: 300, length: 200 })
    expect(between.rotation).toBeCloseTo(90)
    const ends = arrowEnds({ ...transform, ...between }, between.length)
    expect(ends.end.x).toBeCloseTo(100)
    expect(ends.end.y).toBeCloseTo(500)
  })

  it('turns the short way from where the arrow is', () => {
    expect(arrowBetween({ x: 0, y: 0 }, { x: -10, y: -1 }, { ...transform, rotation: 170 }).rotation).toBeCloseTo(185.71, 1)
    expect(arrowBetween({ x: 0, y: 0 }, { x: 10, y: 0 }, { ...transform, rotation: 725 }).rotation).toBeCloseTo(720)
  })

  it('turns a point of a clip into a point of the canvas and back', () => {
    const onCanvas = clipPointToCanvas(transform, { x: 30, y: -10 })
    expect(onCanvas.x).toBeCloseTo(520)
    expect(onCanvas.y).toBeCloseTo(360)
    const back = canvasPointToClip(transform, onCanvas)
    expect(back.x).toBeCloseTo(30)
    expect(back.y).toBeCloseTo(-10)
    expect(canvasPointToClip({ ...transform, scaleX: 0 }, onCanvas)).toEqual({ x: 0, y: 0 })
  })
})
