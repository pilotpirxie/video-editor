import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { boxOf, containsPoint, toLocal, type Box } from '../../src/editor/geometry.js'
import { clipsToSplit, splitClips } from '../../src/editor/split.js'
import { parseProject, serializeProject, type Crop, type Project, type Transform } from '../../src/shared/project.js'
import { frameDuration } from '../../src/shared/time.js'
import { ROOT, projectPath, readBarcode, renderFrames, sameBytes, scratchDirectory, type Picture } from '../helpers.js'

const scratch = scratchDirectory('editing')
const BYTES_PER_PIXEL = 4
const EDGE_ALLOWANCE = 2
const GRID_STEP = 9

function referenceProject(name: string): Project {
  const path = projectPath(name)
  const parsed = parseProject(readFileSync(path, 'utf8'))
  if (!parsed.ok) throw new Error(`${name}: ${parsed.message}`)
  // The copy is written to another folder, so its media is pointed at by full path.
  const media = parsed.project.media.map((reference) => ({ id: reference.id, path: resolve(dirname(path), reference.relativePath), relativePath: '' }))
  return { ...parsed.project, media }
}

function saved(project: Project, name: string): string {
  const path = join(scratch, `${name}.json`)
  writeFileSync(path, serializeProject(project))
  return path
}

function splitAtFrame(project: Project, frame: number): Project {
  const cut = frame * frameDuration(project.canvas.frameRate)
  const newIds = new Map(clipsToSplit(project, [], cut).map((id) => [id, `${id}-second`]))
  if (newIds.size === 0) throw new Error(`No clip is under frame ${frame}`)
  return splitClips(project, cut, newIds)
}

describe('split', () => {
  it.each([
    ['06-keyframes', 22, [0, 1, 14, 21, 22, 23, 30, 45, 59]],
    ['07-speeds', 31, [0, 5, 30, 31, 32, 58, 59]],
    // Cut where no fade is in progress: a cut inside a fade ramp shortens that fade by design.
    ['05-fades', 25, [0, 7, 15, 24, 25, 26, 52, 60, 89]],
    ['05-fades', 70, [0, 30, 45, 69, 70, 71, 86, 89]],
  ])('exports %s identically before and after a split at frame %i', async (name, cutFrame, frames) => {
    const before = referenceProject(name)
    const after = splitAtFrame(before, cutFrame)
    expect(after.tracks.flatMap((track) => track.clips).length).toBeGreaterThan(before.tracks.flatMap((track) => track.clips).length)

    const expected = await renderFrames(saved(before, `${name}-before`), { via: 'export', frames })
    const actual = await renderFrames(saved(after, `${name}-after`), { via: 'export', frames })
    for (const [index, frame] of frames.entries()) {
      const expectedPicture = expected[index]
      const actualPicture = actual[index]
      if (expectedPicture === undefined || actualPicture === undefined) throw new Error(`Frame ${frame} was not rendered`)
      expect(sameBytes(actualPicture, expectedPicture), `frame ${frame}`).toBe(true)
    }
  })
})

// The animated test images hold twelve pictures at ten a second, each numbered by a barcode; the project runs at thirty a second.
describe('animated images', () => {
  const frames = [0, 2, 3, 4, 35, 36, 39, 71, 72, 89]
  const pictureShown = [0, 0, 1, 1, 11, 0, 1, 11, 0, 5]

  it.each(['animated.gif', 'animated.webp', 'animated.apng'])('plays %s picture by picture, loops it, and renders it the same paused and exported', async (name) => {
    const project: Project = {
      version: 1,
      canvas: { width: 320, height: 180, frameRate: { num: 30, den: 1 } },
      media: [{ id: 'animation', path: join(ROOT, 'test', 'media', 'generated', name), relativePath: '' }],
      tracks: [
        {
          id: 'track',
          name: 'Track 1',
          hidden: false,
          locked: false,
          muted: false,
          clips: [
            {
              id: 'clip',
              type: 'video',
              mediaId: 'animation',
              start: 0,
              duration: 3 * 24_000_000,
              sourceStart: 0,
              speedPercent: 100,
              loop: true,
              transform: { x: 160, y: 90, scaleX: 2, scaleY: 2, rotation: 0 },
              opacity: 1,
              volume: 1,
            },
          ],
        },
      ],
    }
    const path = saved(project, name)
    const exported = await renderFrames(path, { via: 'export', frames })
    const paused = await renderFrames(path, { via: 'paused', frames })
    for (const [index, frame] of frames.entries()) {
      const exportedPicture = exported[index]
      const pausedPicture = paused[index]
      if (exportedPicture === undefined || pausedPicture === undefined) throw new Error(`Frame ${frame} was not rendered`)
      expect(readBarcode(exportedPicture), `frame ${frame}`).toBe(pictureShown[index])
      expect(sameBytes(pausedPicture, exportedPicture), `frame ${frame}`).toBe(true)
    }
  })
})

function isLit(picture: Picture, x: number, y: number): boolean {
  const pixels = new Uint8Array(picture.data)
  const index = (Math.round(y) * picture.width + Math.round(x)) * BYTES_PER_PIXEL
  return (pixels[index] ?? 0) + (pixels[index + 1] ?? 0) + (pixels[index + 2] ?? 0) > 0
}

function distanceToEdge(box: Box, x: number, y: number): number {
  const local = toLocal(box, { x, y })
  return Math.max(Math.abs(local.x) - box.width / 2, Math.abs(local.y) - box.height / 2)
}

describe('canvas hit testing', () => {
  it('finds a rotated, scaled and cropped clip exactly where the compositor draws it', async () => {
    const natural = { width: 320, height: 180 }
    // The crop removes the dark bar on the right, so every pixel of the picture is brighter than the black canvas.
    const crop: Crop = { left: 20, top: 10, right: 50, bottom: 30 }
    const transform: Transform = { x: 300, y: 170, scaleX: 1.5, scaleY: 1.2, rotation: 25 }
    const project: Project = {
      version: 1,
      canvas: { width: 640, height: 360, frameRate: { num: 30, den: 1 } },
      media: [{ id: 'bars', path: join(ROOT, 'test', 'media', 'generated', 'image.jpg'), relativePath: '' }],
      tracks: [{ id: 't1', name: 'Track 1', hidden: false, locked: false, muted: false, clips: [{ id: 'bars', type: 'image', mediaId: 'bars', start: 0, duration: 24_000_000, transform, opacity: 1, crop }] }],
    }
    const [picture] = await renderFrames(saved(project, 'hit-test'), { via: 'paused', frames: [0] })
    if (picture === undefined) throw new Error('The frame was not rendered')
    expect(picture).toMatchObject({ width: 640, height: 360 })

    const box = boxOf(natural, crop, transform)
    let inside = 0
    let outside = 0
    for (let y = GRID_STEP; y < picture.height; y += GRID_STEP) {
      for (let x = GRID_STEP; x < picture.width; x += GRID_STEP) {
        // Right on the edge the picture is blended with the background, so those points say nothing either way.
        if (Math.abs(distanceToEdge(box, x, y)) < EDGE_ALLOWANCE) continue
        const isHit = containsPoint(box, { x, y })
        expect(isLit(picture, x, y), `pixel ${x},${y}`).toBe(isHit)
        if (isHit) inside += 1
        else outside += 1
      }
    }
    expect(inside).toBeGreaterThan(300)
    expect(outside).toBeGreaterThan(300)
  })
})
