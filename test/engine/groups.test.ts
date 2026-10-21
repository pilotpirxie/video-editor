import { describe, expect, it } from 'vitest'
import type { Clip, GroupClip, Track, Transform } from '../../src/shared/project.js'
import { SECOND } from '../fixtures.js'
import { at, BLUE, FIRST_SECOND, frameOfTracks, RED, WHITE, WHITE_GROUND, bundledFfmpeg, expectGolden, expectPixel, imageOf, pictureAt, renderFrames, sameBytes, scratchDirectory, type Picture } from '../helpers.js'

const ffmpeg = bundledFfmpeg()
const scratch = scratchDirectory('groups')

function groupOf(id: string, transform: Transform, members: readonly Clip[][], settings: Partial<GroupClip> = {}): Clip {
  const tracks: Track[] = members.map((clips, index) => ({ id: `track-${index + 1}`, name: `Track ${index + 1}`, hidden: false, locked: false, muted: false, clips: [...clips] }))
  return { id, type: 'group', ...FIRST_SECOND, transform, opacity: 1, volume: 1, tracks, ...settings }
}

function frameOf(name: string, tracks: readonly Clip[][], frame = 0): Promise<Picture> {
  return frameOfTracks(scratch, name, tracks, frame)
}

const RED_CARD = imageOf('image-red.png', 'red', FIRST_SECOND, at(-100, 0, 0.25))
const BLUE_CARD = imageOf('image-blue.png', 'blue', FIRST_SECOND, at(100, 0, 0.25))

describe('groups', () => {
  it('draws its members around its own place', async () => {
    const picture = await frameOf('placed', [[WHITE_GROUND], [groupOf('group', at(320, 180), [[RED_CARD], [BLUE_CARD]])]])
    expectPixel(picture, 220, 180, RED)
    expectPixel(picture, 420, 180, BLUE)
    expectPixel(picture, 320, 180, WHITE)
  })

  it('draws the same picture as the members would without the group', async () => {
    const grouped = await frameOf('same-grouped', [[WHITE_GROUND], [groupOf('group', at(320, 180), [[RED_CARD], [BLUE_CARD]])]])
    const loose = await frameOf('same-loose', [[WHITE_GROUND], [imageOf('image-red.png', 'red', FIRST_SECOND, at(220, 180, 0.25))], [imageOf('image-blue.png', 'blue', FIRST_SECOND, at(420, 180, 0.25))]])
    expect(sameBytes(grouped, loose)).toBe(true)
  })

  it('turns and scales its members around its middle', async () => {
    const picture = await frameOf('turned', [[WHITE_GROUND], [groupOf('group', at(320, 180, 1.5, 90), [[RED_CARD], [BLUE_CARD]])]])
    expectPixel(picture, 320, 30, RED)
    expectPixel(picture, 320, 330, BLUE)
    expectPixel(picture, 170, 180, WHITE)
    expectPixel(picture, 470, 180, WHITE)
  })

  it('fades all members with its opacity and shows them from its content start', async () => {
    const half = await frameOf('half', [[WHITE_GROUND], [groupOf('group', at(320, 180), [[RED_CARD]], { opacity: 0.5 })]])
    expectPixel(half, 220, 180, { red: 255, green: 128, blue: 128 }, 2)
    const late = imageOf('image-blue.png', 'late', { start: SECOND, duration: SECOND }, at(0, 0, 0.25))
    const early = await frameOf('early', [[WHITE_GROUND], [groupOf('group', at(320, 180), [[late]])]])
    const shifted = await frameOf('shifted', [[WHITE_GROUND], [groupOf('group', at(320, 180), [[late]], { contentStart: SECOND })]])
    expectPixel(early, 320, 180, WHITE)
    expectPixel(shifted, 320, 180, BLUE)
  })

  it('places the members of a group inside a group', async () => {
    const inner = groupOf('inner', at(0, 100, 1, 90), [[RED_CARD]])
    const picture = await frameOf('nested', [[WHITE_GROUND], [groupOf('outer', at(320, 180, 1, 90), [[inner]])]])
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
