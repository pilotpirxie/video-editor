import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Size } from '../../src/shared/exportPresets.js'
import { serializeProject, type Clip, type Project } from '../../src/shared/project.js'
import { SECOND } from '../fixtures.js'
import { CLICK_SAMPLE_44K } from '../media/generate.js'
import { at, FIRST_SECOND, RED, SMALL_CANVAS, WHITE, WHITE_GROUND, animationOf, bundledFfmpeg, clickHeardAt, decodedAudio, episodeOf, expectGolden, expectPixel, imageOf, pictureAt, projectOfTracks, renderFrames, renderProject, runApp, sameBytes, scratchDirectory, videoOf, writeAnimation, type Picture } from '../helpers.js'

const ffmpeg = bundledFfmpeg()
const scratch = scratchDirectory('animations')
const ARTBOARD = { width: 200, height: 120 }
const SAMPLE_RATE = 48_000
const SAMPLES_PER_FRAME = SAMPLE_RATE / 30
const RED_CARD = imageOf('image-red.png', 'red', FIRST_SECOND, at(50, 60, 0.25))

async function frameOf(name: string, project: Project, frame = 0, size?: Size): Promise<Picture> {
  return pictureAt(await renderProject(scratch, name, project, { via: 'paused', frames: [frame], size }), 0)
}

describe('animation clips', () => {
  const cardPath = writeAnimation(scratch, 'card', ARTBOARD, [[RED_CARD]])

  it('draws the clips of an animation where the clip puts the middle of its artboard', async () => {
    const picture = await frameOf('placed', episodeOf([[WHITE_GROUND], [animationOf('card', 'card', FIRST_SECOND, at(320, 180))]], { card: cardPath }))
    expectPixel(picture, 270, 180, RED)
    expectPixel(picture, 370, 180, WHITE)
  })

  it('draws the same picture as its clips placed straight on the timeline', async () => {
    const inside = await frameOf('same-inside', episodeOf([[WHITE_GROUND], [animationOf('card', 'card', FIRST_SECOND, at(320, 180))]], { card: cardPath }))
    const loose = await frameOf('same-loose', projectOfTracks(SMALL_CANVAS, [[WHITE_GROUND], [imageOf('image-red.png', 'red', FIRST_SECOND, at(270, 180, 0.25))]]))
    expect(sameBytes(inside, loose)).toBe(true)
  })

  it('plays a video inside two copies of an animation at their own times', async () => {
    const span = { start: 0, duration: 2 * SECOND }
    const reelPath = writeAnimation(scratch, 'reel', SMALL_CANVAS, [[videoOf('h264.mp4', 'film', span, at(320, 180, 2))]])
    const later = { start: SECOND / 2, duration: span.duration }
    const copies = episodeOf([[animationOf('reel', 'left', span, at(160, 180, 0.5))], [animationOf('reel', 'right', later, at(480, 180, 0.5))]], { reel: reelPath })
    const loose = projectOfTracks(SMALL_CANVAS, [[videoOf('h264.mp4', 'left', span, at(160, 180))], [videoOf('h264.mp4', 'right', later, at(480, 180))]])
    expect(sameBytes(await frameOf('copies', copies, 20), await frameOf('copies-loose', loose, 20))).toBe(true)
  })

  it('exports a voice inside an animation when the animation plays it', async () => {
    const click: Clip = { id: 'click', type: 'audio', mediaId: 'audio-44k-click.wav', start: SECOND / 2, duration: SECOND, sourceStart: 0, speedPercent: 100, volume: 1 }
    const voicePath = writeAnimation(scratch, 'voice', SMALL_CANVAS, [[click]])
    const episodePath = join(scratch, 'voice-episode.json')
    writeFileSync(episodePath, serializeProject(episodeOf([[animationOf('voice', 'voice', { start: SECOND, duration: 2 * SECOND }, at(320, 180))]], { voice: voicePath })))
    const outputPath = join(scratch, 'voice.mp4')
    const result = await runApp(['--export', episodePath, '--out', outputPath, '--preset', '120p'])
    expect(result.exitCode, result.stderr).toBe(0)
    const heardAt = clickHeardAt(await decodedAudio(outputPath), SAMPLE_RATE, 3 * SAMPLE_RATE)
    expect(Math.abs(heardAt - (1.5 + CLICK_SAMPLE_44K / 44_100) * SAMPLE_RATE)).toBeLessThanOrEqual(SAMPLES_PER_FRAME)
  })

  it('matches the golden image with a turned, scaled and keyframed animation', async () => {
    const grow = [{ time: 0, value: 0.25, easing: 'linear' as const }, { time: SECOND, value: 0.5, easing: 'linear' as const }]
    const moving = imageOf('image-blue.png', 'blue', FIRST_SECOND, at(150, 60, 0.25, 30), { keyframes: { scaleX: grow, scaleY: grow } })
    const path = writeAnimation(scratch, 'golden', ARTBOARD, [[RED_CARD], [moving]])
    const episode = episodeOf([[WHITE_GROUND], [animationOf('golden', 'golden', FIRST_SECOND, at(320, 180, 1.5, 15), { opacity: 0.8 })]], { golden: path })
    await expectGolden(ffmpeg, 'animation-image-720p', await frameOf('golden', episode, 15, { width: 1280, height: 720 }))
  })

  it('holds each picture of a 12 fps animation for two frames of a 24 fps episode', async () => {
    const [held, same, next] = await renderFrames('26-animation', { via: 'paused', frames: [12, 13, 14] })
    if (held === undefined || same === undefined || next === undefined) throw new Error('A frame was not rendered')
    expect(sameBytes(held, same)).toBe(true)
    expect(sameBytes(same, next)).toBe(false)
  })
})
