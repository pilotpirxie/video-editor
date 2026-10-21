import { describe, expect, it } from 'vitest'
import type { CameraKeyframe, Clip, Transform } from '../../src/shared/project.js'
import { FRAME, SECOND } from '../fixtures.js'
import { bundledFfmpeg, expectGolden, imageOf, litFraction, cropPicture, pictureAt, projectOfTracks, renderFrames, renderProject, sameBytes, scratchDirectory, videoOf } from '../helpers.js'

const ffmpeg = bundledFfmpeg()
const scratch = scratchDirectory('camera')
const CANVAS = { width: 1920, height: 1080 }
const SPAN = { start: 0, duration: SECOND }
const ZOOM = 2
const CENTRE = { x: 700, y: 400 }

function at(x: number, y: number, scale: number, rotation = 0): Transform {
  return { x, y, scaleX: scale, scaleY: scale, rotation }
}

const TITLE: Clip = { id: 'title', type: 'text', text: 'Sharp 清晰', font: { family: 'Helvetica Neue', size: 60 }, color: '#FFFFFF', align: 'center', ...SPAN, transform: at(700, 300, 1), opacity: 1 }

function zoomedByHand(clip: Clip): Clip {
  if (clip.type === 'audio') return clip
  const { transform } = clip
  const x = (transform.x - CENTRE.x) * ZOOM + CANVAS.width / 2
  const y = (transform.y - CENTRE.y) * ZOOM + CANVAS.height / 2
  return { ...clip, transform: { ...transform, x, y, scaleX: transform.scaleX * ZOOM, scaleY: transform.scaleY * ZOOM } }
}

describe('camera', () => {
  it('draws a zoom at the zoomed size: text, a picture and 4K footage give the same bytes as when each is enlarged by hand', async () => {
    const clips = [videoOf('4k-long-gop.mp4', 'footage', SPAN, at(960, 540, 0.5)), imageOf('image-alpha.png', 'card', SPAN, at(900, 500, 1.5, 12)), TITLE]
    const camera: CameraKeyframe[] = [{ time: 0, duration: FRAME, easing: 'hold', ...CENTRE, scale: ZOOM }]
    const request = { via: 'paused', frames: [3] } as const
    const zoomed = await renderProject(scratch, 'zoomed', projectOfTracks(CANVAS, clips.map((clip) => [clip]), camera), request)
    const byHand = await renderProject(scratch, 'by-hand', projectOfTracks(CANVAS, clips.map((clip) => [zoomedByHand(clip)])), request)
    expect(litFraction(pictureAt(zoomed, 0))).toBeGreaterThan(0.5)
    expect(sameBytes(pictureAt(zoomed, 0), pictureAt(byHand, 0))).toBe(true)
  })

  it('matches the golden image in the middle of a move', async () => {
    const pictures = await renderFrames('13-camera', { via: 'paused', frames: [37] })
    await expectGolden(ffmpeg, 'camera-360p', pictureAt(pictures, 0))
  })

  it('keeps a zoomed picture out of the bars of an output with another shape', async () => {
    const size = { width: 360, height: 360 }
    const picture = pictureAt(await renderFrames('13-camera', { via: 'paused', frames: [45], size }), 0)
    expect(litFraction(cropPicture(picture, 0, 0, 360, 78))).toBe(0)
    expect(litFraction(cropPicture(picture, 0, 282, 360, 78))).toBe(0)
    expect(litFraction(cropPicture(picture, 0, 80, 360, 200))).toBeGreaterThan(0.99)
  })
})
