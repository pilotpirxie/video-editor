import { describe, expect, it } from 'vitest'
import { SECOND, clipIds, clipOf, groupClip, projectOf, reopened, textClip, track, videoClip } from '../../test/fixtures.js'
import { allClips } from './clips.js'
import { addText, missingFonts, setTextStyle } from './text.js'

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

  it('sets the weight in whole hundreds and leaves the regular weight out of the clip', () => {
    const bold = setTextStyle(project, ['title'], { weight: 730 })
    expect(clipOf(bold, 'title')).toMatchObject({ font: { family: 'Helvetica Neue', size: 90, weight: 700 } })
    expect(reopened(bold)).toEqual(bold)
    expect(clipOf(setTextStyle(bold, ['title'], { weight: 5000 }), 'title')).toMatchObject({ font: { weight: 900 } })
    expect(clipOf(setTextStyle(bold, ['title'], { weight: 400 }), 'title')).toEqual(clipOf(project, 'title'))
    expect(setTextStyle(project, ['title'], { weight: 400 })).toBe(project)
  })

  it('sets the line spacing within what the file accepts, and leaves the font\'s own out of the clip', () => {
    const spaced = setTextStyle(project, ['title'], { lineSpacing: 1.5 })
    expect(clipOf(spaced, 'title')).toMatchObject({ lineSpacing: 1.5 })
    expect(reopened(spaced)).toEqual(spaced)
    expect(clipOf(setTextStyle(project, ['title'], { lineSpacing: 9 }), 'title')).toMatchObject({ lineSpacing: 3 })
    expect(clipOf(setTextStyle(project, ['title'], { lineSpacing: 0 }), 'title')).toMatchObject({ lineSpacing: 0.5 })
    expect(clipOf(reopened(setTextStyle(spaced, ['title'], { lineSpacing: 1 })), 'title')).not.toHaveProperty('lineSpacing')
  })

  it('switches an outline, a shadow and a background on with a look that fits the size, and off again', () => {
    const dressed = setTextStyle(project, ['title'], { hasOutline: true, hasShadow: true, hasBackground: true })
    expect(clipOf(dressed, 'title')).toMatchObject({
      outline: { color: '#000000', width: 5 },
      shadow: { color: '#000000aa', offsetX: 6, offsetY: 6, blur: 6 },
      background: { color: '#000000aa' },
    })
    expect(reopened(dressed)).toEqual(dressed)
    expect(setTextStyle(dressed, ['title'], { hasOutline: true, hasShadow: true, hasBackground: true })).toBe(dressed)
    const plain = reopened(setTextStyle(dressed, ['title'], { hasOutline: false, hasShadow: false, hasBackground: false }))
    expect(plain).toEqual(reopened(project))
  })

  it('changes an outline, a shadow and a background that are there, and none that are not', () => {
    const dressed = setTextStyle(project, ['title'], { hasOutline: true, hasShadow: true, hasBackground: true })
    const changed = setTextStyle(dressed, ['title'], { outlineColor: '#ff0000', outlineWidth: 0, shadowOffsetX: -4, shadowBlur: -1, backgroundColor: '#112233' })
    expect(clipOf(changed, 'title')).toMatchObject({
      outline: { color: '#ff0000', width: 0.1 },
      shadow: { color: '#000000aa', offsetX: -4, offsetY: 6, blur: 0 },
      background: { color: '#112233' },
    })
    expect(reopened(changed)).toEqual(changed)
    expect(setTextStyle(project, ['title'], { outlineColor: '#ff0000', shadowBlur: 3, backgroundColor: '#112233' })).toBe(project)
    expect(setTextStyle(dressed, ['title'], { outlineColor: 'red', shadowColor: 'grey' })).toBe(dressed)
  })

  it('fixes the width of the box and lets it follow the lines again', () => {
    const boxed = setTextStyle(project, ['title'], { boxWidth: 400 })
    expect(clipOf(boxed, 'title')).toMatchObject({ boxWidth: 400 })
    expect(reopened(boxed)).toEqual(boxed)
    expect(clipOf(setTextStyle(boxed, ['title'], { boxWidth: 0 }), 'title')).toMatchObject({ boxWidth: 1 })
    expect(clipOf(reopened(setTextStyle(boxed, ['title'], { boxWidth: 'auto' })), 'title')).not.toHaveProperty('boxWidth')
    expect(setTextStyle(project, ['title'], { boxWidth: 'auto' })).toBe(project)
  })
})

describe('missingFonts', () => {
  it('names each font the words use that is not installed, once, also inside groups, whatever its case', () => {
    const inGroup = textClip('inner', 0, SECOND, { font: { family: 'Brand Sans', size: 40 } })
    const project = projectOf([
      track('t1', [textClip('a', 0, SECOND, { font: { family: 'helvetica neue', size: 40 } }), textClip('b', SECOND, SECOND, { font: { family: 'Brand Sans', size: 40 } })]),
      track('t2', [groupClip('g', 0, SECOND, [[inGroup]]), textClip('c', SECOND, SECOND, { font: { family: 'Abril', size: 40 } })]),
    ])
    expect(missingFonts(allClips(project.tracks), ['Helvetica Neue', 'Menlo'])).toEqual(['Abril', 'Brand Sans'])
    expect(missingFonts(allClips(project.tracks), ['Helvetica Neue', 'Brand Sans', 'Abril'])).toEqual([])
  })
})
