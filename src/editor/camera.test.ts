import { describe, expect, it } from 'vitest'
import { FRAME, SECOND, projectOf, reopened } from '../../test/fixtures.js'
import type { CameraKeyframe, Project } from '../shared/project.js'
import { deleteZoom, clampedView, frameOf, moveZoom, setViewAt, setZoom, viewFromCorner, zoomIndexAt } from './camera.js'

const CANVAS = { width: 1920, height: 1080 }

function withZooms(...zooms: CameraKeyframe[]): Project {
  return { ...projectOf([]), camera: zooms }
}

function zoom(time: number, scale = 2): CameraKeyframe {
  return { time, duration: SECOND, easing: 'easeInOut', x: 960, y: 540, scale }
}

describe('clampedView', () => {
  it('keeps the frame inside the canvas and the scale between the whole canvas and ten times', () => {
    expect(clampedView(CANVAS, { x: 0, y: 2000, scale: 2 })).toEqual({ x: 480, y: 810, scale: 2 })
    expect(clampedView(CANVAS, { x: 300, y: 300, scale: 0.5 })).toEqual({ x: 960, y: 540, scale: 1 })
    expect(clampedView(CANVAS, { x: 960, y: 540, scale: 50 })).toEqual({ x: 960, y: 540, scale: 10 })
  })

  it('shows a frame of the shape of the canvas', () => {
    expect(frameOf(CANVAS, { x: 960, y: 540, scale: 2 })).toEqual({ left: 480, top: 270, width: 960, height: 540 })
  })
})

describe('viewFromCorner', () => {
  it('frames from the corner toward the pointer, as large as the farther of the two distances asks', () => {
    expect(viewFromCorner(CANVAS, { x: 400, y: 200 }, { x: 1360, y: 300 })).toEqual({ x: 880, y: 470, scale: 2 })
    expect(viewFromCorner(CANVAS, { x: 400, y: 200 }, { x: 500, y: 740 })).toEqual({ x: 880, y: 470, scale: 2 })
  })

  it('grows up and to the left when the pointer is there', () => {
    expect(viewFromCorner(CANVAS, { x: 1400, y: 800 }, { x: 440, y: 700 })).toEqual({ x: 920, y: 530, scale: 2 })
  })

  it('never makes a frame smaller than the closest zoom or larger than the canvas', () => {
    expect(viewFromCorner(CANVAS, { x: 500, y: 500 }, { x: 501, y: 500 }).scale).toBe(10)
    expect(viewFromCorner(CANVAS, { x: 0, y: 0 }, { x: 5000, y: 5000 })).toEqual({ x: 960, y: 540, scale: 1 })
  })
})

describe('setViewAt', () => {
  it('adds a zoom that arrives over a second with an eased move, in time order', () => {
    const first = setViewAt(projectOf([]), 3 * SECOND, { x: 600, y: 400, scale: 2 })
    expect(first.camera).toEqual([{ time: 3 * SECOND, duration: SECOND, easing: 'easeInOut', x: 600, y: 400, scale: 2 }])
    const second = setViewAt(first, SECOND, { x: 960, y: 540, scale: 1 })
    expect(second.camera?.map((entry) => entry.time)).toEqual([SECOND, 3 * SECOND])
    expect(reopened(second)).toEqual(second)
  })

  it('changes the view of the zoom that is already at that time and keeps how it arrives', () => {
    const project = withZooms({ ...zoom(SECOND), duration: 5 * FRAME, easing: 'linear' })
    const changed = setViewAt(project, SECOND, { x: 700, y: 500, scale: 3 })
    expect(changed.camera).toEqual([{ time: SECOND, duration: 5 * FRAME, easing: 'linear', x: 700, y: 500, scale: 3 }])
    expect(setViewAt(changed, SECOND, { x: 700, y: 500, scale: 3 })).toBe(changed)
  })

  it('moves a view that reaches past the canvas back inside', () => {
    expect(setViewAt(projectOf([]), 0, { x: 0, y: 0, scale: 4 }).camera?.[0]).toMatchObject({ x: 240, y: 135, scale: 4 })
  })
})

describe('moveZoom, setZoom and deleteZoom', () => {
  const project = withZooms(zoom(SECOND), zoom(3 * SECOND, 3), zoom(5 * SECOND, 1))

  it('moves a zoom in time but not past its neighbours', () => {
    expect(moveZoom(project, 1, 2 * SECOND, FRAME).camera?.[1]?.time).toBe(2 * SECOND)
    expect(moveZoom(project, 1, 0, FRAME).camera?.[1]?.time).toBe(SECOND + FRAME)
    expect(moveZoom(project, 1, 9 * SECOND, FRAME).camera?.[1]?.time).toBe(5 * SECOND - FRAME)
    expect(moveZoom(project, 0, -SECOND, FRAME).camera?.[0]?.time).toBe(0)
    expect(moveZoom(project, 1, 3 * SECOND, FRAME)).toBe(project)
    expect(moveZoom(project, 7, SECOND, FRAME)).toBe(project)
  })

  it('changes scale, place, length and easing within what the camera can do', () => {
    const changed = setZoom(project, 0, { scale: 4, x: 0, duration: SECOND / 2 + 1000, easing: 'hold' }, FRAME)
    expect(changed.camera?.[0]).toEqual({ time: SECOND, duration: SECOND / 2, easing: 'hold', x: 240, y: 540, scale: 4 })
    expect(setZoom(project, 0, { duration: 0 }, FRAME).camera?.[0]?.duration).toBe(FRAME)
    expect(setZoom(project, 0, { scale: 2 }, FRAME)).toBe(project)
    expect(reopened(changed)).toEqual(changed)
  })

  it('removes a zoom, and the camera with the last one', () => {
    const fewer = deleteZoom(project, 1)
    expect(fewer.camera?.map((entry) => entry.time)).toEqual([SECOND, 5 * SECOND])
    const none = deleteZoom(deleteZoom(fewer, 0), 0)
    expect('camera' in none).toBe(false)
    expect(reopened(none)).toEqual(none)
    expect(deleteZoom(project, 9)).toBe(project)
  })

  it('finds the zoom that is reached at a time', () => {
    expect(zoomIndexAt(project, 3 * SECOND)).toBe(1)
    expect(zoomIndexAt(project, 3 * SECOND + FRAME)).toBeUndefined()
  })
})
