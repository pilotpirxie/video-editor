import type { Size } from '../shared/exportPresets.js'
import { MAX_CAMERA_SCALE, type CameraKeyframe, type Easing, type Project } from '../shared/project.js'
import { TICKS_PER_SECOND } from '../shared/time.js'
import type { Point } from './geometry.js'

// A new zoom takes a second to arrive, eased at both ends.
const DEFAULT_MOVE = TICKS_PER_SECOND
const DEFAULT_EASING: Easing = 'easeInOut'

// What the camera shows: the part of the canvas around (x, y), enlarged `scale` times.
export type ZoomView = {
  x: number
  y: number
  scale: number
}

// The part of the canvas a view shows, as a rectangle in canvas pixels.
export type ZoomFrame = {
  left: number
  top: number
  width: number
  height: number
}

export type ZoomChanges = Partial<Pick<CameraKeyframe, 'x' | 'y' | 'scale' | 'duration' | 'easing'>>

export function frameOf(canvas: Size, view: ZoomView): ZoomFrame {
  const width = canvas.width / view.scale
  const height = canvas.height / view.scale
  return { left: view.x - width / 2, top: view.y - height / 2, width, height }
}

// A view the camera can have: between the whole canvas and the closest zoom, and never showing anything outside the canvas.
export function fittedView(canvas: Size, view: ZoomView): ZoomView {
  const scale = Math.min(MAX_CAMERA_SCALE, Math.max(1, view.scale))
  const halfWidth = canvas.width / (2 * scale)
  const halfHeight = canvas.height / (2 * scale)
  return {
    x: Math.min(canvas.width - halfWidth, Math.max(halfWidth, view.x)),
    y: Math.min(canvas.height - halfHeight, Math.max(halfHeight, view.y)),
    scale,
  }
}

// The view whose frame has one corner at `anchor` and reaches toward the pointer. The frame keeps the shape of the canvas, so the larger of the two distances decides its size.
export function viewFromCorner(canvas: Size, anchor: Point, pointer: Point): ZoomView {
  const reachX = Math.abs(pointer.x - anchor.x)
  const reachY = Math.abs(pointer.y - anchor.y)
  const smallest = canvas.width / MAX_CAMERA_SCALE
  const width = Math.min(canvas.width, Math.max(smallest, reachX, (reachY * canvas.width) / canvas.height))
  const height = (width * canvas.height) / canvas.width
  const x = anchor.x + (pointer.x < anchor.x ? -width : width) / 2
  const y = anchor.y + (pointer.y < anchor.y ? -height : height) / 2
  return fittedView(canvas, { x, y, scale: canvas.width / width })
}

// The zoom that is reached exactly at `time`, if there is one.
export function zoomIndexAt(project: Project, time: number): number | undefined {
  const index = (project.camera ?? []).findIndex((zoom) => zoom.time === time)
  return index === -1 ? undefined : index
}

function withCamera(project: Project, camera: CameraKeyframe[]): Project {
  if (camera.length > 0) return { ...project, camera }
  const { camera: _removed, ...rest } = project
  return rest
}

// Sets what the camera shows at `time`: the zoom reached at that time is changed, or a new one is added there.
export function setViewAt(project: Project, time: number, view: ZoomView): Project {
  const camera = project.camera ?? []
  const fitted = fittedView(project.canvas, view)
  const existing = camera.find((zoom) => zoom.time === time)
  if (existing !== undefined) {
    const isUnchanged = existing.x === fitted.x && existing.y === fitted.y && existing.scale === fitted.scale
    return isUnchanged ? project : { ...project, camera: camera.map((zoom) => (zoom === existing ? { ...zoom, ...fitted } : zoom)) }
  }
  const added: CameraKeyframe = { time, duration: DEFAULT_MOVE, easing: DEFAULT_EASING, ...fitted }
  return { ...project, camera: [...camera, added].sort((a, b) => a.time - b.time) }
}

// Moves a zoom in time. It stays between its neighbours, one frame away from each at the closest.
export function moveZoom(project: Project, index: number, time: number, frameTicks: number): Project {
  const camera = project.camera ?? []
  const zoom = camera[index]
  if (zoom === undefined) return project
  const earliest = (camera[index - 1]?.time ?? -frameTicks) + frameTicks
  const latest = (camera[index + 1]?.time ?? Infinity) - frameTicks
  const moved = Math.min(latest, Math.max(earliest, time))
  if (moved === zoom.time) return project
  return { ...project, camera: camera.map((other) => (other === zoom ? { ...zoom, time: moved } : other)) }
}

export function setZoom(project: Project, index: number, changes: ZoomChanges, frameTicks: number): Project {
  const camera = project.camera ?? []
  const zoom = camera[index]
  if (zoom === undefined) return project
  const view = fittedView(project.canvas, { x: changes.x ?? zoom.x, y: changes.y ?? zoom.y, scale: changes.scale ?? zoom.scale })
  const duration = Math.max(frameTicks, Math.round((changes.duration ?? zoom.duration) / frameTicks) * frameTicks)
  const changed: CameraKeyframe = { ...zoom, ...view, duration, easing: changes.easing ?? zoom.easing }
  const isUnchanged = changed.x === zoom.x && changed.y === zoom.y && changed.scale === zoom.scale && changed.duration === zoom.duration && changed.easing === zoom.easing
  return isUnchanged ? project : { ...project, camera: camera.map((other) => (other === zoom ? changed : other)) }
}

export function deleteZoom(project: Project, index: number): Project {
  const camera = project.camera ?? []
  if (camera[index] === undefined) return project
  return withCamera(project, camera.filter((_zoom, position) => position !== index))
}
