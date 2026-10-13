import { describe, expect, it } from 'vitest'
import type { Clip, GroupClip, Track, Transform } from '../../src/shared/project.js'
import { SECOND } from '../fixtures.js'
import { bundledFfmpeg, expectGolden, expectPixel, imageOf, pictureAt, projectOfTracks, renderFrames, renderProject, sameBytes, scratchDirectory, type Picture } from '../helpers.js'

const ffmpeg = bundledFfmpeg()
const scratch = scratchDirectory('groups')
const CANVAS = { width: 640, height: 360 }
const SPAN = { start: 0, duration: SECOND }
const WHITE = { red: 255, green: 255, blue: 255 }
const RED = { red: 255, green: 0, blue: 0 }
const BLUE = { red: 0, green: 0, blue: 255 }

function at(x: number, y: number, scale = 1, rotation = 0): Transform {
  return { x, y, scaleX: scale, scaleY: scale, rotation }
}

const GROUND = imageOf('image-white.png', 'ground', { start: 0, duration: 2 * SECOND }, at(320, 180, 2))

function groupOf(id: string, transform: Transform, members: readonly Clip[][], settings: Partial<GroupClip> = {}): Clip {
  const tracks: Track[] = members.map((clips, index) => ({ id: `track-${index + 1}`, name: `Track ${index + 1}`, hidden: false, locked: false, muted: false, clips: [...clips] }))
  return { id, type: 'group', ...SPAN, transform, opacity: 1, volume: 1, tracks, ...settings }
}

async function frameOf(name: string, tracks: readonly Clip[][], frame = 0): Promise<Picture> {
  return pictureAt(await renderProject(scratch, name, projectOfTracks(CANVAS, tracks), { via: 'paused', frames: [frame] }), 0)
}

// Two cards of 80 by 45 (320 by 180 at a quarter): red on the left of the group's middle, blue on the right.
const RED_CARD = imageOf('image-red.png', 'red', SPAN, at(-100, 0, 0.25))
const BLUE_CARD = imageOf('image-blue.png', 'blue', SPAN, at(100, 0, 0.25))

describe('groups', () => {
  it('draws its members around its own place', async () => {
    const picture = await frameOf('placed', [[GROUND], [groupOf('group', at(320, 180), [[RED_CARD], [BLUE_CARD]])]])
    expectPixel(picture, 220, 180, RED)
    expectPixel(picture, 420, 180, BLUE)
    expectPixel(picture, 320, 180, WHITE)
  })

  it('draws the same picture as the members would without the group', async () => {
    const grouped = await frameOf('same-grouped', [[GROUND], [groupOf('group', at(320, 180), [[RED_CARD], [BLUE_CARD]])]])
    const loose = await frameOf('same-loose', [[GROUND], [imageOf('image-red.png', 'red', SPAN, at(220, 180, 0.25))], [imageOf('image-blue.png', 'blue', SPAN, at(420, 180, 0.25))]])
    expect(sameBytes(grouped, loose)).toBe(true)
  })

  it('turns and scales its members around its middle', async () => {
    const picture = await frameOf('turned', [[GROUND], [groupOf('group', at(320, 180, 1.5, 90), [[RED_CARD], [BLUE_CARD]])]])
    // A quarter turn clockwise puts what was on the left at the top; the distance grows with the scale.
    expectPixel(picture, 320, 30, RED)
    expectPixel(picture, 320, 330, BLUE)
    expectPixel(picture, 170, 180, WHITE)
    expectPixel(picture, 470, 180, WHITE)
  })

  it('fades all members with its opacity and shows them from its content start', async () => {
    const half = await frameOf('half', [[GROUND], [groupOf('group', at(320, 180), [[RED_CARD]], { opacity: 0.5 })]])
    expectPixel(half, 220, 180, { red: 255, green: 128, blue: 128 }, 2)
    const late = imageOf('image-blue.png', 'late', { start: SECOND, duration: SECOND }, at(0, 0, 0.25))
    const early = await frameOf('early', [[GROUND], [groupOf('group', at(320, 180), [[late]])]])
    const shifted = await frameOf('shifted', [[GROUND], [groupOf('group', at(320, 180), [[late]], { contentStart: SECOND })]])
    expectPixel(early, 320, 180, WHITE)
    expectPixel(shifted, 320, 180, BLUE)
  })

  it('places the members of a group inside a group', async () => {
    const inner = groupOf('inner', at(0, 100, 1, 90), [[RED_CARD]])
    const picture = await frameOf('nested', [[GROUND], [groupOf('outer', at(320, 180, 1, 90), [[inner]])]])
    // The outer quarter turn puts the inner group, 100 below its middle, 100 to the left of it, turned by a half turn in all.
    // Half a turn puts the card, 100 to the left of the inner group, 100 to its right: in the middle of the canvas.
    expectPixel(picture, 320, 180, RED)
    expectPixel(picture, 220, 180, WHITE)
    expectPixel(picture, 320, 280, WHITE)
    expectPixel(picture, 320, 80, WHITE)
  })

  it('matches the golden image with nested, turned and animated groups', async () => {
    const pictures = await renderFrames('20-groups', { via: 'paused', frames: [45, 93], size: { width: 1280, height: 720 } })
    await expectGolden(ffmpeg, 'groups-720p', pictureAt(pictures, 0))
    await expectGolden(ffmpeg, 'groups-cut-720p', pictureAt(pictures, 1))
  })
})
