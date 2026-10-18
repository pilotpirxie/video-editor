import { describe, expect, it } from 'vitest'
import { litFraction, renderFrames, sameBytes, type Size } from '../helpers.js'

type Case = {
  project: string
  frames: number[]
  size?: Size
}

const REFERENCE_PROJECTS: Case[] = [
  { project: '01-single-clip', frames: [0, 1, 29, 30, 31, 59] },
  { project: '02-mosaic', frames: [0, 14, 30, 59] },
  { project: '03-rotation-opacity', frames: [0, 4, 5, 6, 33, 59] },
  { project: '04-crop', frames: [0, 17, 59] },
  { project: '05-fades', frames: [0, 7, 15, 29, 30, 37, 52, 60, 89] },
  { project: '06-keyframes', frames: [0, 1, 14, 15, 16, 29, 30, 31, 45, 59] },
  { project: '07-speeds', frames: [0, 1, 2, 3, 4, 5, 11, 12, 37, 58, 59] },
  { project: '08-mixed-rates', frames: [0, 1, 2, 3, 9, 17, 18, 21, 22, 35] },
  { project: '09-text', frames: [0, 20, 59] },
  { project: '10-alpha', frames: [0, 5, 9] },
  { project: '11-tiny-canvas', frames: [0, 12, 29] },
  { project: '12-4k-canvas', frames: [0, 14, 29] },
  { project: '13-camera', frames: [0, 7, 15, 22, 37, 45, 56, 57, 59] },
  { project: '14-transitions', frames: [0, 11, 20, 25, 30, 35, 55, 60, 65, 90, 118, 125, 150, 180, 215, 240, 245, 270, 295, 300, 330, 335, 360, 370, 410, 419, 445, 510, 570, 635, 695, 750, 775, 805] },
  { project: '15-blur-highlight', frames: [0, 15, 30, 50] },
  { project: '16-effects', frames: [0, 10, 30, 45, 60, 90] },
  { project: '17-callouts-arrows', frames: [0, 21, 59] },
  { project: '18-text-styles', frames: [0, 33, 59] },
  { project: '19-presets', frames: [0, 5, 14, 18, 29, 30, 45, 76, 80, 89] },
  { project: '20-groups', frames: [0, 7, 15, 31, 45, 59, 80, 89, 90, 95, 120, 149] },
  // HLG, 240 fps, 8K, a turned phone, wide pixels and a phone recording with a 12 s gap; the gap ends at frame 363.
  { project: '21-difficult-sources', frames: [0, 1, 2, 3, 5, 9, 30, 59, 300, 362, 363, 364, 377] },
  // Values a hand-edited file may hold: a 2000 pt heading, typing at ten times zoom, no width, a billion pixels away,
  // shadows and blurs of a million pixels, a 100,000 px arrow, 600 keyframes and groups eight deep.
  { project: '23-weird', frames: [0, 7, 15, 22, 30, 45, 59] },
  { project: '24-cache-pressure', frames: [0, 8, 15, 23, 30, 45, 59] },
]

const REDUCED_SIZE: Case[] = [
  { project: 'golden-downscale', frames: [0, 10, 29], size: { width: 960, height: 540 } },
  { project: 'golden-downscale', frames: [3], size: { width: 214, height: 120 } },
  { project: '02-mosaic', frames: [0, 31], size: { width: 320, height: 180 } },
  { project: '06-keyframes', frames: [8, 44], size: { width: 1280, height: 720 } },
  { project: '13-camera', frames: [37, 45], size: { width: 1280, height: 720 } },
  { project: '14-transitions', frames: [30, 300, 330, 480, 780], size: { width: 320, height: 180 } },
  { project: '15-blur-highlight', frames: [0, 30], size: { width: 480, height: 270 } },
  { project: '16-effects', frames: [0, 30, 60, 90], size: { width: 640, height: 360 } },
  { project: '17-callouts-arrows', frames: [30], size: { width: 320, height: 180 } },
  { project: '18-text-styles', frames: [30], size: { width: 3840, height: 2160 } },
  { project: '19-presets', frames: [10, 82], size: { width: 640, height: 360 } },
  { project: '20-groups', frames: [20, 93], size: { width: 480, height: 270 } },
  { project: '21-difficult-sources', frames: [1, 363], size: { width: 214, height: 120 } },
]

async function expectSamePixels(testCase: Case): Promise<void> {
  const request = testCase.size === undefined ? { frames: testCase.frames } : { frames: testCase.frames, size: testCase.size }
  const paused = await renderFrames(testCase.project, { ...request, via: 'paused' })
  const exported = await renderFrames(testCase.project, { ...request, via: 'export' })
  let mostContent = 0
  for (const [index, frame] of testCase.frames.entries()) {
    const pausedPicture = paused[index]
    const exportedPicture = exported[index]
    if (pausedPicture === undefined || exportedPicture === undefined) throw new Error(`Frame ${frame} was not rendered`)
    expect(sameBytes(pausedPicture, exportedPicture), `frame ${frame}`).toBe(true)
    mostContent = Math.max(mostContent, litFraction(pausedPicture))
  }
  expect(mostContent).toBeGreaterThan(0.2)
}

describe('preview and export render identical frames', () => {
  it.each(REFERENCE_PROJECTS)('$project', expectSamePixels)
})

describe('a downscaled preview equals a downscaled export', () => {
  it.each(REDUCED_SIZE)('$project at $size.width×$size.height', expectSamePixels)
})
