import { describe, expect, it } from 'vitest'
import { SECOND, clipIds, clipOf, projectOf, reopened, track, videoClip } from '../../test/fixtures.js'
import { addText, setTextStyle } from './text.js'

const NEW_TRACK = { id: 'titles', name: 'Track 2' }

function withTitle(): ReturnType<typeof addText> {
  return addText(projectOf([track('t1', [videoClip('a', 0, 10 * SECOND)])]), { clipId: 'title', start: 2 * SECOND, newTrack: NEW_TRACK })
}

describe('addText', () => {
  it('adds a five-second title in the middle of the canvas, on a new top track', () => {
    const project = withTitle()
    expect(clipIds(project)).toEqual([['a'], ['title']])
    expect(project.tracks[1]).toMatchObject({ id: 'titles', name: 'Track 2' })
    expect(clipOf(project, 'title')).toEqual({
      id: 'title',
      type: 'text',
      start: 2 * SECOND,
      duration: 5 * SECOND,
      transform: { x: 960, y: 540, scaleX: 1, scaleY: 1, rotation: 0 },
      opacity: 1,
      text: 'Text',
      font: { family: 'Helvetica Neue', size: 90 },
      color: '#ffffff',
      align: 'center',
    })
  })

  it('sizes the text to the canvas', () => {
    const small = addText({ ...projectOf([]), canvas: { width: 160, height: 120, frameRate: { num: 30, den: 1 } } }, { clipId: 'title', start: 0, newTrack: NEW_TRACK })
    expect(clipOf(small, 'title')).toMatchObject({ font: { size: 10 }, transform: { x: 80, y: 60 } })
  })

  it('gives a project the file format accepts', () => {
    expect(reopened(withTitle())).toEqual(withTitle())
  })
})

describe('setTextStyle', () => {
  const project = withTitle()

  it('changes words, font, size, colour and alignment', () => {
    const styled = setTextStyle(project, ['title'], { text: 'Hello\nworld', family: 'Menlo', size: 48, color: '#ff8800', align: 'left' })
    expect(clipOf(styled, 'title')).toMatchObject({ text: 'Hello\nworld', font: { family: 'Menlo', size: 48 }, color: '#ff8800', align: 'left' })
    expect(reopened(styled)).toEqual(styled)
  })

  it('changes only what was asked for', () => {
    expect(clipOf(setTextStyle(project, ['title'], { size: 48 }), 'title')).toMatchObject({ text: 'Text', font: { family: 'Helvetica Neue', size: 48 }, color: '#ffffff' })
  })

  it('keeps the size within what can be drawn', () => {
    expect(clipOf(setTextStyle(project, ['title'], { size: 0 }), 'title')).toMatchObject({ font: { size: 1 } })
    expect(clipOf(setTextStyle(project, ['title'], { size: 99_999 }), 'title')).toMatchObject({ font: { size: 2000 } })
  })

  it('ignores a colour or family the file format would refuse', () => {
    expect(setTextStyle(project, ['title'], { color: 'red' })).toBe(project)
    expect(setTextStyle(project, ['title'], { family: '' })).toBe(project)
  })

  it('leaves other kinds of clip and unchanged text alone', () => {
    expect(setTextStyle(project, ['a'], { text: 'x' })).toBe(project)
    expect(setTextStyle(project, ['title'], { text: 'Text', align: 'center' })).toBe(project)
  })

  it('lets typing pass through empty text', () => {
    expect(clipOf(setTextStyle(project, ['title'], { text: '' }), 'title')).toMatchObject({ text: '' })
  })
})
