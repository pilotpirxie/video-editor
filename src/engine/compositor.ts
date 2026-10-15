import { fitCanvas, type PixelLayout, type Size } from '../shared/exportPresets.js'
import type { RawFrame } from '../shared/mediaProtocol.js'
import type { Crop, Effect, Transform } from '../shared/project.js'
import { outputMapping, type OutputMapping, type View } from './camera.js'
import type { BlurLayer, HighlightLayer, TransitionLook } from './resolve.js'
import {
  BLUR_SHADER,
  BLUR_TAPS,
  LAYER_SHADER,
  MAX_OPS,
  OP_BLACK_AND_WHITE,
  OP_BORDER,
  OP_CHROMA_KEY,
  OP_COLOR_ADJUST,
  OP_INVERT,
  OP_LOOK,
  OP_ROUNDED_CORNERS,
  OP_SEPIA,
  OP_TINT,
  OP_VIGNETTE,
  SHAPE_BLUR,
  SHAPE_HIGHLIGHT,
  SHAPE_PIXELATE,
  SHAPE_SHADER,
  SHAPE_SPOTLIGHT,
  SHARPEN_SHADER,
  SOURCE_ALPHA_BELOW,
  SOURCE_PICTURE,
  SOURCE_TARGET,
  VERTEX_SHADER,
  YUV_SHADER,
} from './shaders.js'

const LOD_BIAS = -0.5
const EDGE_MARGIN = 1
const BYTES_PER_PIXEL = 4
// How often a copy out of the GPU is asked whether it is done.
const READBACK_POLL_MS = 1
const MIP_CHAIN_FACTOR = 4 / 3
const FLOATS_PER_VERTEX = 4
const COMPONENTS = 4
const DEGREES_TO_RADIANS = Math.PI / 180
const COLOR_CHANNEL_MAX = 255
// The samples of a blur are this many of its standard deviations apart; closer together a strong blur would need more of them than the shader takes.
const SIGMA_PER_STEP = 2.5
const SMALLEST_SIGMA = 0.01
// Nothing smaller than this many output pixels can be told from no blur at all.
const SMALLEST_VISIBLE_BLUR = 0.05
// How far the settings of a look reach at their ends: the share a colour channel changes by, or what a lifted black becomes.
const WHITE_BALANCE_REACH = 0.15
const TONE_GAIN_REACH = 0.35
const TONE_LIFT_REACH = 0.25
const FADE_LIFT = 0.2
const SHADOWS_REACH = 0.8
const HIGHLIGHTS_REACH = 0.4
const NO_LINE = [0, 0, -1] as const
const NO_CIRCLE = [0, 0, 1e9, 1] as const

export class CompositorError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CompositorError'
  }
}

export type GpuTexture = {
  handle: WebGLTexture
  width: number
  height: number
  bytes: number
}

type PictureItem = {
  kind: 'picture'
  texture: GpuTexture
  naturalWidth: number
  naturalHeight: number
  crop: Crop
  transform: Transform
  placed?: Transform
  opacity: number
  hasAlphaBelow: boolean
  effects?: readonly Effect[]
  transition?: TransitionLook
}

export type DrawItem = PictureItem | BlurLayer | HighlightLayer

export type Compositor = {
  uploadPixels(frame: RawFrame): GpuTexture
  // Puts the frame into a texture it was made for when the sizes match, or else into a new one; the old one is then released.
  refillPixels(texture: GpuTexture, frame: RawFrame): GpuTexture
  uploadImage(image: ImageBitmap | OffscreenCanvas): GpuTexture
  release(texture: GpuTexture): void
  render(canvas: Size, output: Size, view: View, items: readonly DrawItem[]): void
  present(): void
  readPixels(): ArrayBuffer
  // Starts copying the frame just rendered out of the GPU and answers a way to wait for the pixels. Two copies can be under way at once.
  startReadback(layout: PixelLayout): () => Promise<ArrayBuffer>
}

// How a draw is combined with what its target already holds.
type Blend = 'over' | 'add' | 'replace' | 'under' | 'multiply'

// Something to draw into besides the screen: the frame, and the spare pictures that effects, blurs and summed transitions are worked out in.
type Target = {
  framebuffer: WebGLFramebuffer
  texture: WebGLTexture
  width: number
  height: number
}

// The rectangle a layer is drawn into, in output pixels.
type Box = {
  centerX: number
  centerY: number
  halfWidth: number
  halfHeight: number
  cosine: number
  sine: number
}

type Program = {
  handle: WebGLProgram
  locations: Map<string, WebGLUniformLocation | null>
}

// The effects that need the pixels around each pixel. They cannot be worked out while the picture is drawn, so the picture is drawn into a spare target first.
type AreaEffect = Extract<Effect, { type: 'clipBlur' | 'dropShadow' | 'sharpen' }>
type Look = Extract<Effect, { type: 'look' }>
type BlurFill = Extract<Effect, { type: 'blurFill' }>

// The effects that change only the colour of each pixel. A blur fill takes them from its clip, so the backdrop has the clip's colours.
const COLOUR_EFFECTS: ReadonlySet<Effect['type']> = new Set(['colorAdjust', 'look', 'blackAndWhite', 'sepia', 'tint', 'invert'])

// Effects that are applied in one draw, and the area effect that follows them, if any.
type Stage = {
  effects: Effect[]
  then: AreaEffect | undefined
}

type BlurPlan = {
  level: number
  spacing: number
  weights: Float32Array
  // How far, in output pixels, the blur carries a pixel along each axis.
  reach: number
}

type Rgb = {
  red: number
  green: number
  blue: number
}

// What the last draw of a layer adds: how strongly it is drawn, and what a transition does to it.
type Finish = {
  opacity: number
  look: TransitionLook | undefined
}

const PLAIN: Finish = { opacity: 1, look: undefined }

type BlurPass = {
  source: Target
  target: Target
  blend: Blend
  box: Box
  margin: number
  plan: BlurPlan
  isHorizontal: boolean
  shiftX: number
  shiftY: number
  shadow: Extract<Effect, { type: 'dropShadow' }> | undefined
  // What the colour of the second direction is multiplied by: 1 leaves it, less darkens it.
  gain: number
}

// What the shader applies for a look: each colour channel is multiplied by `gain`, the shadows and the highlights brightened, contrast and saturation changed, and black lifted to `lift`.
type LookNumbers = {
  gain: Rgb
  lift: Rgb
  contrast: number
  saturation: number
  shadows: number
  highlights: number
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)
  if (shader === null) throw new CompositorError('The GPU refused to create a shader')
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS) !== true) {
    throw new CompositorError(`A shader did not compile: ${gl.getShaderInfoLog(shader) ?? 'no details'}`)
  }
  return shader
}

function linkProgram(gl: WebGL2RenderingContext, fragmentShader: string): Program {
  const handle = gl.createProgram()
  gl.attachShader(handle, compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER))
  gl.attachShader(handle, compileShader(gl, gl.FRAGMENT_SHADER, fragmentShader))
  gl.linkProgram(handle)
  if (gl.getProgramParameter(handle, gl.LINK_STATUS) !== true) {
    throw new CompositorError(`The shader program did not link: ${gl.getProgramInfoLog(handle) ?? 'no details'}`)
  }
  return { handle, locations: new Map() }
}

function rgbOf(color: string): Rgb {
  const channel = (at: number): number => Number.parseInt(color.slice(at, at + 2), 16) / COLOR_CHANNEL_MAX
  return { red: channel(1), green: channel(3), blue: channel(5) }
}

function isAreaEffect(effect: Effect): effect is AreaEffect {
  return effect.type === 'clipBlur' || effect.type === 'dropShadow' || effect.type === 'sharpen'
}

function lumaOf(color: Rgb): number {
  return 0.2126 * color.red + 0.7152 * color.green + 0.0722 * color.blue
}

// A look at full strength, mixed toward changing nothing by its strength. With every setting at its middle, nothing changes.
function lookNumbers(look: Look): LookNumbers {
  const warmth = look.temperature * WHITE_BALANCE_REACH
  const balance = { red: 1 + warmth, green: 1 - look.tint * WHITE_BALANCE_REACH, blue: 1 - warmth }
  const balanceLuma = lumaOf(balance)
  // The highlight colour is taken at its brightest, so it tints without darkening much; black tints nothing.
  const highlight = rgbOf(look.highlightColor)
  const brightest = Math.max(highlight.red, highlight.green, highlight.blue)
  const shadow = rgbOf(look.shadowColor)
  const shadowLuma = lumaOf(shadow)
  const exposure = 2 ** look.exposure
  const strength = look.strength
  const channel = (key: keyof Rgb): { gain: number; lift: number } => {
    const toned = brightest > 0 ? 1 + (highlight[key] / brightest - 1) * look.highlightAmount * TONE_GAIN_REACH : 1
    const gain = exposure * (balance[key] / balanceLuma) * toned
    const lift = look.fade * FADE_LIFT + (shadow[key] - shadowLuma) * look.shadowAmount * TONE_LIFT_REACH
    return { gain: 1 + (gain - 1) * strength, lift: lift * strength }
  }
  const red = channel('red')
  const green = channel('green')
  const blue = channel('blue')
  return {
    gain: { red: red.gain, green: green.gain, blue: blue.gain },
    lift: { red: red.lift, green: green.lift, blue: blue.lift },
    contrast: look.contrast * strength,
    saturation: look.saturation * strength,
    shadows: look.shadows * SHADOWS_REACH * strength,
    highlights: look.highlights * HIGHLIGHTS_REACH * strength,
  }
}

function stagesOf(effects: readonly Effect[]): Stage[] {
  const stages: Stage[] = []
  let current: Effect[] = []
  for (const effect of effects) {
    if (isAreaEffect(effect)) {
      stages.push({ effects: current, then: effect })
      current = []
    } else {
      current.push(effect)
    }
  }
  stages.push({ effects: current, then: undefined })
  return stages
}

// The corner radius, in output pixels, that later effects of a clip follow once these have been applied.
function radiusAfter(effects: readonly Effect[], radius: number, scale: number): number {
  let rounded = radius
  for (const effect of effects) {
    if (effect.type === 'roundedCorners') rounded = effect.radius * scale
  }
  return rounded
}

function blurPlan(sigma: number): BlurPlan {
  const spread = Math.max(sigma, SMALLEST_SIGMA)
  const level = Math.max(0, Math.log2(spread / SIGMA_PER_STEP))
  const spacing = 2 ** level
  const weights = new Float32Array(BLUR_TAPS + 1)
  let total = 0
  for (let tap = 0; tap <= BLUR_TAPS; tap++) {
    const weight = Math.exp(-((tap * spacing) ** 2) / (2 * spread * spread))
    weights[tap] = weight
    total += tap === 0 ? weight : 2 * weight
  }
  for (let tap = 0; tap <= BLUR_TAPS; tap++) weights[tap] = (weights[tap] ?? 0) / total
  return { level, spacing, weights, reach: BLUR_TAPS * spacing }
}

function boxOf(width: number, height: number, transform: Transform, mapping: OutputMapping): Box | undefined {
  const halfWidth = (width * transform.scaleX * mapping.scale) / 2
  const halfHeight = (height * transform.scaleY * mapping.scale) / 2
  if (!(halfWidth > 0) || !(halfHeight > 0)) return undefined
  const angle = transform.rotation * DEGREES_TO_RADIANS
  return {
    centerX: mapping.offsetX + transform.x * mapping.scale,
    centerY: mapping.offsetY + transform.y * mapping.scale,
    halfWidth,
    halfHeight,
    cosine: Math.cos(angle),
    sine: Math.sin(angle),
  }
}

// The four corners of a box that reaches `margin` output pixels past its edges on every side.
function quadVertices(box: Box, margin: number): Float32Array {
  const vertices = new Float32Array(4 * FLOATS_PER_VERTEX)
  const corners = [
    { x: -1, y: -1 },
    { x: 1, y: -1 },
    { x: -1, y: 1 },
    { x: 1, y: 1 },
  ]
  for (const [index, corner] of corners.entries()) {
    const localX = corner.x * (box.halfWidth + margin)
    const localY = corner.y * (box.halfHeight + margin)
    vertices[index * FLOATS_PER_VERTEX] = box.centerX + localX * box.cosine - localY * box.sine
    vertices[index * FLOATS_PER_VERTEX + 1] = box.centerY + localX * box.sine + localY * box.cosine
    vertices[index * FLOATS_PER_VERTEX + 2] = localX
    vertices[index * FLOATS_PER_VERTEX + 3] = localY
  }
  return vertices
}

export function createCompositor(gl: WebGL2RenderingContext): Compositor {
  const layerProgram = linkProgram(gl, LAYER_SHADER)
  const blurProgram = linkProgram(gl, BLUR_SHADER)
  const sharpenProgram = linkProgram(gl, SHARPEN_SHADER)
  const shapeProgram = linkProgram(gl, SHAPE_SHADER)
  const yuvProgram = linkProgram(gl, YUV_SHADER)

  const vertexArray = gl.createVertexArray()
  const vertexBuffer = gl.createBuffer()
  gl.bindVertexArray(vertexArray)
  gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer)
  gl.bufferData(gl.ARRAY_BUFFER, 4 * FLOATS_PER_VERTEX * Float32Array.BYTES_PER_ELEMENT, gl.DYNAMIC_DRAW)
  const stride = FLOATS_PER_VERTEX * Float32Array.BYTES_PER_ELEMENT
  gl.enableVertexAttribArray(0)
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0)
  gl.enableVertexAttribArray(1)
  gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 2 * Float32Array.BYTES_PER_ELEMENT)

  gl.disable(gl.DEPTH_TEST)
  gl.disable(gl.DITHER)
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE)
  gl.activeTexture(gl.TEXTURE0)

  function createTarget(): Target {
    return { framebuffer: gl.createFramebuffer(), texture: gl.createTexture(), width: 0, height: 0 }
  }

  const frame = createTarget()
  // Made on first use: a project without effects, blur clips and summed transitions never pays for them.
  let held: Target | undefined
  let spare: Target | undefined
  let pair: Target | undefined
  let backdrop: Target | undefined
  let yuv: Target | undefined

  let output: Size = { width: 0, height: 0 }
  let canvasSize: Size = { width: 0, height: 0 }
  let mapping: OutputMapping = { scale: 1, offsetX: 0, offsetY: 0 }
  let used: Program | undefined

  function sized(target: Target, width = output.width, height = output.height): Target {
    if (target.width === width && target.height === height) return target
    gl.bindTexture(gl.TEXTURE_2D, target.texture)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    const filter = target === frame ? gl.NEAREST : gl.LINEAR
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target.texture, 0)
    // An effect that is silently left out could show what a blur was meant to hide, so a refusal stops the frame.
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw new CompositorError(`The GPU cannot render at ${width}x${height}`)
    }
    target.width = width
    target.height = height
    return target
  }

  function heldTarget(): Target {
    held ??= createTarget()
    return sized(held)
  }

  function spareTarget(): Target {
    spare ??= createTarget()
    return sized(spare)
  }

  function pairTarget(): Target {
    pair ??= createTarget()
    return sized(pair)
  }

  function backdropTarget(): Target {
    backdrop ??= createTarget()
    return sized(backdrop)
  }

  function use(program: Program): void {
    if (used === program) return
    used = program
    gl.useProgram(program.handle)
  }

  function at(name: string): WebGLUniformLocation | null {
    if (used === undefined) return null
    if (!used.locations.has(name)) used.locations.set(name, gl.getUniformLocation(used.handle, name))
    return used.locations.get(name) ?? null
  }

  // Only the frame is cut to the canvas. A spare target is always cleared, copied and drawn whole, so nothing of an earlier frame can be left in it.
  function drawInto(target: Target, blend: Blend): void {
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer)
    if (target === frame) gl.enable(gl.SCISSOR_TEST)
    else gl.disable(gl.SCISSOR_TEST)

    if (blend === 'replace') {
      gl.disable(gl.BLEND)
      return
    }
    gl.enable(gl.BLEND)
    if (blend === 'over') gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    else if (blend === 'add') gl.blendFunc(gl.ONE, gl.ONE)
    else if (blend === 'under') gl.blendFunc(gl.ONE_MINUS_DST_ALPHA, gl.ONE)
    else gl.blendFunc(gl.DST_COLOR, gl.ZERO)
  }

  function clear(target: Target, alpha: number): void {
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer)
    gl.disable(gl.SCISSOR_TEST)
    gl.clearColor(0, 0, 0, alpha)
    gl.clear(gl.COLOR_BUFFER_BIT)
  }

  function drawQuad(box: Box, margin: number): void {
    gl.uniform2f(at('uOutputSize'), output.width, output.height)
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, quadVertices(box, margin))
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }

  // A wipe or a circle is given on the canvas; the shader needs it in output pixels.
  function sendReveal(look: TransitionLook | undefined): void {
    const reveal = look?.reveal
    if (reveal?.kind === 'line') {
      const x = mapping.offsetX + reveal.x * mapping.scale
      const y = mapping.offsetY + reveal.y * mapping.scale
      gl.uniform3f(at('uLine'), reveal.normalX, reveal.normalY, x * reveal.normalX + y * reveal.normalY)
    } else {
      gl.uniform3f(at('uLine'), ...NO_LINE)
    }
    if (reveal?.kind === 'circle') {
      const x = mapping.offsetX + reveal.x * mapping.scale
      const y = mapping.offsetY + reveal.y * mapping.scale
      gl.uniform4f(at('uCircle'), x, y, reveal.radius * mapping.scale, reveal.isInside ? 1 : -1)
    } else {
      gl.uniform4f(at('uCircle'), ...NO_CIRCLE)
    }
  }

  function sendEffects(effects: readonly Effect[], radius: number): void {
    gl.uniform1f(at('uRadius'), radius)
    // Most layers have no effects, and every layer is drawn on every frame: nothing is built for them.
    if (effects.length === 0) {
      gl.uniform1i(at('uOpCount'), 0)
      return
    }
    const kinds = new Int32Array(MAX_OPS)
    const first = new Float32Array(MAX_OPS * COMPONENTS)
    const second = new Float32Array(MAX_OPS * COMPONENTS)
    const third = new Float32Array(MAX_OPS * COMPONENTS)
    let count = 0
    for (const effect of effects) {
      if (count === MAX_OPS) break
      const base = count * COMPONENTS
      if (effect.type === 'colorAdjust') {
        kinds[count] = OP_COLOR_ADJUST
        first.set([effect.brightness, effect.contrast, effect.saturation], base)
      } else if (effect.type === 'blackAndWhite') {
        kinds[count] = OP_BLACK_AND_WHITE
        first.set([effect.amount], base)
      } else if (effect.type === 'chromaKey') {
        const key = rgbOf(effect.color)
        kinds[count] = OP_CHROMA_KEY
        first.set([key.red, key.green, key.blue, effect.tolerance], base)
        second.set([effect.softness, effect.spill], base)
      } else if (effect.type === 'roundedCorners') {
        kinds[count] = OP_ROUNDED_CORNERS
        first.set([effect.radius * mapping.scale], base)
      } else if (effect.type === 'border') {
        const color = rgbOf(effect.color)
        kinds[count] = OP_BORDER
        first.set([color.red, color.green, color.blue, effect.width * mapping.scale], base)
      } else if (effect.type === 'sepia') {
        kinds[count] = OP_SEPIA
        first.set([effect.amount], base)
      } else if (effect.type === 'invert') {
        kinds[count] = OP_INVERT
        first.set([effect.amount], base)
      } else if (effect.type === 'tint') {
        const color = rgbOf(effect.color)
        kinds[count] = OP_TINT
        first.set([color.red, color.green, color.blue, effect.amount], base)
      } else if (effect.type === 'vignette') {
        kinds[count] = OP_VIGNETTE
        first.set([effect.amount, effect.size], base)
      } else if (effect.type === 'look') {
        const look = lookNumbers(effect)
        kinds[count] = OP_LOOK
        first.set([look.gain.red, look.gain.green, look.gain.blue, look.contrast], base)
        second.set([look.lift.red, look.lift.green, look.lift.blue, look.saturation], base)
        third.set([look.shadows, look.highlights], base)
      } else {
        continue
      }
      count += 1
    }
    gl.uniform1i(at('uOpCount'), count)
    gl.uniform1iv(at('uOpKind'), kinds)
    gl.uniform4fv(at('uOpA'), first)
    gl.uniform4fv(at('uOpB'), second)
    gl.uniform4fv(at('uOpC'), third)
  }

  function sendFinish(finish: Finish): void {
    const tint = finish.look?.tint
    gl.uniform1f(at('uOpacity'), Math.min(finish.opacity, 1))
    gl.uniform2f(at('uTint'), tint?.color === 'white' ? 1 : 0, tint?.amount ?? 0)
    sendReveal(finish.look)
  }

  function drawPictureInto(target: Target, blend: Blend, item: PictureItem, box: Box, effects: readonly Effect[], finish: Finish): void {
    const pictureHeight = item.hasAlphaBelow ? item.texture.height / 2 : item.texture.height
    const left = item.crop.left / item.naturalWidth
    const top = item.crop.top / item.naturalHeight
    const width = 1 - (item.crop.left + item.crop.right) / item.naturalWidth
    const height = 1 - (item.crop.top + item.crop.bottom) / item.naturalHeight
    const halfTexelX = 0.5 / item.texture.width
    const halfTexelY = 0.5 / pictureHeight

    drawInto(target, blend)
    use(layerProgram)
    gl.bindTexture(gl.TEXTURE_2D, item.texture.handle)
    gl.uniform1i(at('uSource'), item.hasAlphaBelow ? SOURCE_ALPHA_BELOW : SOURCE_PICTURE)
    gl.uniform2f(at('uHalfSize'), box.halfWidth, box.halfHeight)
    gl.uniform4f(at('uTextureRect'), left, top, width, height)
    gl.uniform4f(at('uTextureLimit'), left + halfTexelX, top + halfTexelY, left + width - halfTexelX, top + height - halfTexelY)
    gl.uniform1f(at('uLodBias'), LOD_BIAS)
    sendEffects(effects, 0)
    sendFinish(finish)
    drawQuad(box, EDGE_MARGIN)
  }

  // Draws what a spare target holds, pixel for pixel, with the effects that come after the ones already in it.
  function drawTargetInto(target: Target, blend: Blend, source: Target, box: Box, margin: number, effects: readonly Effect[], radius: number, finish: Finish): void {
    drawInto(target, blend)
    use(layerProgram)
    gl.bindTexture(gl.TEXTURE_2D, source.texture)
    gl.uniform1i(at('uSource'), SOURCE_TARGET)
    gl.uniform2f(at('uHalfSize'), box.halfWidth, box.halfHeight)
    sendEffects(effects, radius)
    sendFinish(finish)
    drawQuad(box, margin)
  }

  function blurPass(pass: BlurPass): void {
    const { source, plan, isHorizontal, shadow } = pass
    drawInto(pass.target, pass.blend)
    use(blurProgram)
    gl.bindTexture(gl.TEXTURE_2D, source.texture)
    // The first direction reads the chain of smaller copies. The second reads what the first wrote, which is already as smooth as that level.
    if (isHorizontal) {
      gl.generateMipmap(gl.TEXTURE_2D)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
    }
    gl.uniform2f(at('uTexel'), 1 / source.width, 1 / source.height)
    gl.uniform2f(at('uStep'), isHorizontal ? plan.spacing / source.width : 0, isHorizontal ? 0 : plan.spacing / source.height)
    gl.uniform2f(at('uShift'), pass.shiftX, pass.shiftY)
    gl.uniform1f(at('uLevel'), isHorizontal ? plan.level : 0)
    gl.uniform1fv(at('uWeights'), plan.weights)
    const color = shadow === undefined || isHorizontal ? undefined : rgbOf(shadow.color)
    gl.uniform4f(at('uShadow'), color?.red ?? 0, color?.green ?? 0, color?.blue ?? 0, color === undefined ? 0 : (shadow?.opacity ?? 0))
    gl.uniform1f(at('uGain'), isHorizontal ? 1 : pass.gain)
    drawQuad(pass.box, pass.margin)
    // A target whose filter asks for smaller copies it does not have reads as black, so the filter goes back at once.
    if (isHorizontal) gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  }

  // Sharpens the picture a target holds, through the other target, which is copied back whole: the other is cleared first so nothing old comes back with it.
  function sharpen(effect: Extract<Effect, { type: 'sharpen' }>, picture: Target, other: Target, box: Box, reach: number): void {
    const spacing = effect.radius * mapping.scale
    const level = Math.max(0, Math.log2(spacing))
    clear(other, 0)
    drawInto(other, 'replace')
    use(sharpenProgram)
    gl.bindTexture(gl.TEXTURE_2D, picture.texture)
    if (level > 0) {
      gl.generateMipmap(gl.TEXTURE_2D)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
    }
    gl.uniform2f(at('uTexel'), 1 / picture.width, 1 / picture.height)
    gl.uniform1f(at('uSpacing'), spacing)
    gl.uniform1f(at('uLevel'), level)
    gl.uniform1f(at('uAmount'), effect.amount)
    drawQuad(box, reach)
    if (level > 0) gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, other.framebuffer)
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, picture.framebuffer)
    gl.disable(gl.SCISSOR_TEST)
    gl.blitFramebuffer(0, 0, other.width, other.height, 0, 0, picture.width, picture.height, gl.COLOR_BUFFER_BIT, gl.NEAREST)
  }

  // Blurs the picture a target holds, sharpens it, or lays its shadow under it. Returns how far past its box the picture now reaches.
  function applyAreaEffect(effect: AreaEffect, picture: Target, other: Target, box: Box, reach: number, gain = 1): number {
    if (effect.type === 'sharpen') {
      if (effect.amount > 0) sharpen(effect, picture, other, box, reach)
      return reach
    }
    const isShadow = effect.type === 'dropShadow'
    if (isShadow && !(effect.opacity > 0)) return reach
    const plan = blurPlan((isShadow ? effect.softness : effect.strength) * mapping.scale)
    const shiftX = isShadow ? effect.offsetX * mapping.scale : 0
    const shiftY = isShadow ? effect.offsetY * mapping.scale : 0
    // A blur reaches along both axes, and the box may be turned: the diagonal of that reach covers every turn.
    const carried = reach + Math.hypot(shiftX, shiftY) + plan.reach * Math.SQRT2
    const common = { box, plan, shadow: isShadow ? effect : undefined, gain }
    // The first direction is written wider than the second reads, so the second never reads what the first did not write.
    blurPass({ ...common, source: picture, target: other, blend: 'replace', margin: carried + plan.reach, isHorizontal: true, shiftX: -shiftX, shiftY: -shiftY })
    blurPass({ ...common, source: other, target: picture, blend: isShadow ? 'under' : 'replace', margin: carried, isHorizontal: false, shiftX: 0, shiftY: 0 })
    return carried
  }

  // The picture of a clip, with its colour effects, made large enough to cover the canvas and the reach of the blur past it, then blurred and darkened.
  function drawBlurFill(item: PictureItem, fill: BlurFill, croppedWidth: number, croppedHeight: number, target: Target): void {
    const blurReach = blurPlan(fill.strength * mapping.scale).reach * Math.SQRT2
    const needX = (canvasSize.width * mapping.scale) / 2 + blurReach
    const needY = (canvasSize.height * mapping.scale) / 2 + blurReach
    const aspect = croppedWidth / croppedHeight
    const isWider = needX / needY > aspect
    const box: Box = {
      centerX: mapping.offsetX + (canvasSize.width * mapping.scale) / 2,
      centerY: mapping.offsetY + (canvasSize.height * mapping.scale) / 2,
      halfWidth: isWider ? needX : needY * aspect,
      halfHeight: isWider ? needX / aspect : needY,
      cosine: 1,
      sine: 0,
    }
    const picture = heldTarget()
    clear(picture, 0)
    const colourEffects = (item.effects ?? []).filter((effect) => COLOUR_EFFECTS.has(effect.type))
    drawPictureInto(picture, 'over', item, box, colourEffects, PLAIN)
    const reach = applyAreaEffect({ type: 'clipBlur', strength: fill.strength }, picture, spareTarget(), box, EDGE_MARGIN, 1 - fill.darken)
    drawTargetInto(target, 'over', picture, box, reach, [], 0, PLAIN)
  }

  function drawPicture(item: PictureItem, target: Target, blend: Blend): void {
    if (!(item.opacity > 0)) return
    const croppedWidth = item.naturalWidth - item.crop.left - item.crop.right
    const croppedHeight = item.naturalHeight - item.crop.top - item.crop.bottom
    const box = boxOf(croppedWidth, croppedHeight, item.placed ?? item.transform, mapping)
    if (box === undefined) return

    const finish: Finish = { opacity: item.opacity, look: item.transition }
    const fill = item.effects?.find((effect): effect is BlurFill => effect.type === 'blurFill')
    if (fill === undefined) {
      drawWithEffects(item, box, target, blend, finish)
      return
    }
    // The clip goes over its fill first and the two are then drawn as one, so a fade or a transition shows neither through the other.
    const backdrop = backdropTarget()
    clear(backdrop, 0)
    drawBlurFill(item, fill, croppedWidth, croppedHeight, backdrop)
    drawWithEffects(item, box, backdrop, 'over', PLAIN)
    drawTargetInto(target, blend, backdrop, wholeOutput(), 0, [], 0, finish)
  }

  function drawWithEffects(item: PictureItem, box: Box, target: Target, blend: Blend, finish: Finish): void {
    const [first, ...later] = stagesOf(item.effects ?? [])
    if (first === undefined) return
    if (first.then === undefined) {
      drawPictureInto(target, blend, item, box, first.effects, finish)
      return
    }

    let picture = heldTarget()
    let other = spareTarget()
    clear(picture, 0)
    drawPictureInto(picture, 'over', item, box, first.effects, PLAIN)
    let radius = radiusAfter(first.effects, 0, mapping.scale)
    let reach = EDGE_MARGIN
    let areaEffect: AreaEffect | undefined = first.then
    for (const stage of later) {
      if (areaEffect !== undefined) reach = applyAreaEffect(areaEffect, picture, other, box, reach)
      if (stage.then === undefined) {
        drawTargetInto(target, blend, picture, box, reach, stage.effects, radius, finish)
        return
      }
      // Another area effect follows: the effects before it go onto the picture first, in the other target.
      clear(other, 0)
      drawTargetInto(other, 'replace', picture, box, reach, stage.effects, radius, PLAIN)
      const swapped = picture
      picture = other
      other = swapped
      radius = radiusAfter(stage.effects, radius, mapping.scale)
      areaEffect = stage.then
    }
  }

  function wholeOutput(): Box {
    return { centerX: output.width / 2, centerY: output.height / 2, halfWidth: output.width / 2, halfHeight: output.height / 2, cosine: 1, sine: 0 }
  }

  // Two pictures that a transition adds up. Each is drawn at its share into a target of their own, which is then drawn as one layer.
  function drawPair(first: PictureItem, second: PictureItem): void {
    const sum = pairTarget()
    clear(sum, 0)
    drawPicture(first, sum, 'add')
    drawPicture(second, sum, 'add')
    drawTargetInto(frame, 'over', sum, wholeOutput(), 0, [], 0, PLAIN)
  }

  function drawShape(item: BlurLayer | HighlightLayer): void {
    if (!(item.opacity > 0)) return
    const box = boxOf(item.width, item.height, item.placed ?? item.transform, mapping)
    if (box === undefined) return

    let kind = SHAPE_BLUR
    let source: Target | undefined
    let blockSize = 1
    if (item.kind === 'highlight') {
      kind = item.isSpotlight ? SHAPE_SPOTLIGHT : SHAPE_HIGHLIGHT
    } else {
      const strength = item.strength * mapping.scale
      if (strength < SMALLEST_VISIBLE_BLUR || (item.isPixelated && strength < 1)) return
      // What is beneath is copied whole: the frame cannot be read while it is drawn into.
      source = heldTarget()
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, frame.framebuffer)
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, source.framebuffer)
      gl.disable(gl.SCISSOR_TEST)
      gl.blitFramebuffer(0, 0, output.width, output.height, 0, 0, output.width, output.height, gl.COLOR_BUFFER_BIT, gl.NEAREST)
      if (item.isPixelated) {
        kind = SHAPE_PIXELATE
        blockSize = strength
      } else {
        applyAreaEffect({ type: 'clipBlur', strength: item.strength }, source, spareTarget(), box, EDGE_MARGIN)
      }
    }

    const color = item.kind === 'highlight' ? rgbOf(item.color) : { red: 0, green: 0, blue: 0 }
    // A spotlight darkens everything outside its shape, so its quad covers the whole output however the shape is turned.
    const margin = kind === SHAPE_SPOTLIGHT ? Math.hypot(output.width, output.height) : EDGE_MARGIN
    drawInto(frame, item.kind === 'highlight' ? 'multiply' : 'over')
    use(shapeProgram)
    // A highlight reads no picture. Nothing is left bound for it either: a draw that could read the frame it writes to is refused.
    gl.bindTexture(gl.TEXTURE_2D, source?.texture ?? null)
    if (kind === SHAPE_PIXELATE) {
      gl.generateMipmap(gl.TEXTURE_2D)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
    }
    gl.uniform1i(at('uKind'), kind)
    gl.uniform2f(at('uHalfSize'), box.halfWidth, box.halfHeight)
    gl.uniform1f(at('uIsEllipse'), item.shape === 'ellipse' ? 1 : 0)
    gl.uniform1f(at('uSoftEdge'), item.softEdge * mapping.scale)
    gl.uniform1f(at('uOpacity'), Math.min(item.opacity, 1))
    gl.uniform3f(at('uColor'), color.red, color.green, color.blue)
    gl.uniform2f(at('uTexel'), 1 / output.width, 1 / output.height)
    // The blocks stand on a grid that starts at the corner of the canvas, so they stay where they are when the clip moves. Each is read from the smaller copy whose pixels are a quarter of its side.
    gl.uniform4f(at('uBlocks'), mapping.offsetX, mapping.offsetY, blockSize, Math.max(0, Math.log2(blockSize) - 2))
    sendReveal(item.transition)
    drawQuad(box, margin)
    if (kind === SHAPE_PIXELATE) gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  }

  function finishTexture(handle: WebGLTexture, width: number, height: number): GpuTexture {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.generateMipmap(gl.TEXTURE_2D)
    return { handle, width, height, bytes: Math.ceil(width * height * BYTES_PER_PIXEL * MIP_CHAIN_FACTOR) }
  }

  function uploadPixels(pixels: RawFrame): GpuTexture {
    const handle = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, handle)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, pixels.width, pixels.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(pixels.data))
    return finishTexture(handle, pixels.width, pixels.height)
  }

  // A stream shows a frame of the same size each time; writing it into the texture it has spares the GPU a new 4K texture, and its freeing, per frame.
  function refillPixels(texture: GpuTexture, pixels: RawFrame): GpuTexture {
    if (texture.width !== pixels.width || texture.height !== pixels.height) {
      release(texture)
      return uploadPixels(pixels)
    }
    gl.bindTexture(gl.TEXTURE_2D, texture.handle)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, pixels.width, pixels.height, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(pixels.data))
    gl.generateMipmap(gl.TEXTURE_2D)
    return texture
  }

  function uploadImage(image: ImageBitmap | OffscreenCanvas): GpuTexture {
    const handle = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, handle)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, image)
    return finishTexture(handle, image.width, image.height)
  }

  function release(texture: GpuTexture): void {
    gl.deleteTexture(texture.handle)
  }

  function render(canvas: Size, outputSize: Size, view: View, items: readonly DrawItem[]): void {
    // Drawing on a lost context does nothing and would read back black pictures, so an export stops here instead.
    if (gl.isContextLost()) throw new CompositorError('The graphics processor stopped; export again once the preview is back.')
    output = outputSize
    canvasSize = canvas
    mapping = outputMapping(canvas, output, view)
    sized(frame)
    gl.viewport(0, 0, output.width, output.height)
    clear(frame, 1)
    gl.bindVertexArray(vertexArray)
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer)

    // A zoomed layer is larger than the canvas; where the output has bars beside the canvas, it must not be drawn into them.
    const fit = fitCanvas(canvas, output)
    const left = Math.floor(fit.offsetX)
    const top = Math.floor(fit.offsetY)
    gl.scissor(left, top, Math.ceil(output.width - fit.offsetX) - left, Math.ceil(output.height - fit.offsetY) - top)

    let index = 0
    while (index < items.length) {
      const item = items[index]
      const next = items[index + 1]
      index += 1
      if (item === undefined) continue
      if (item.kind !== 'picture') {
        drawShape(item)
        continue
      }
      const mixKey = item.transition?.mixKey
      const isPair = mixKey !== undefined && next?.kind === 'picture' && next.transition?.mixKey === mixKey
      if (isPair) {
        drawPair(item, next)
        index += 1
      } else {
        drawPicture(item, frame, 'over')
      }
    }
    gl.disable(gl.SCISSOR_TEST)
  }

  function present(): void {
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, frame.framebuffer)
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null)
    gl.blitFramebuffer(0, 0, frame.width, frame.height, 0, frame.height, frame.width, 0, gl.COLOR_BUFFER_BIT, gl.NEAREST)
  }

  let readBack = new Uint8Array(0)

  function readPixels(): ArrayBuffer {
    const byteLength = frame.width * frame.height * BYTES_PER_PIXEL
    if (readBack.length !== byteLength) readBack = new Uint8Array(byteLength)
    gl.bindFramebuffer(gl.FRAMEBUFFER, frame.framebuffer)
    gl.readPixels(0, 0, frame.width, frame.height, gl.RGBA, gl.UNSIGNED_BYTE, readBack)
    return readBack.buffer
  }

  const readbackBuffers = [gl.createBuffer(), gl.createBuffer()]
  const readbackSizes = [0, 0]
  let nextReadback = 0

  // Draws the frame as the bytes of a YUV 4:2:0 picture into a target with whole rows of RGBA texels.
  function drawYuv(): { target: Target; byteLength: number } {
    const byteLength = (frame.width * frame.height * 3) / 2
    const rowTexels = frame.width
    const rows = Math.ceil(byteLength / (rowTexels * BYTES_PER_PIXEL))
    yuv ??= createTarget()
    const target = sized(yuv, rowTexels, rows)
    use(yuvProgram)
    drawInto(target, 'replace')
    gl.viewport(0, 0, rowTexels, rows)
    gl.bindTexture(gl.TEXTURE_2D, frame.texture)
    gl.uniform1i(at('uTexture'), 0)
    gl.uniform2i(at('uPictureSize'), frame.width, frame.height)
    gl.uniform1i(at('uRowTexels'), rowTexels)
    gl.uniform2f(at('uOutputSize'), rowTexels, rows)
    gl.bindVertexArray(vertexArray)
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer)
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, quadVertices({ centerX: rowTexels / 2, centerY: rows / 2, halfWidth: rowTexels / 2, halfHeight: rows / 2, cosine: 1, sine: 0 }, 0))
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    gl.viewport(0, 0, output.width, output.height)
    return { target, byteLength }
  }

  function startReadback(layout: PixelLayout): () => Promise<ArrayBuffer> {
    const source = layout === 'yuv420p' ? drawYuv() : { target: frame, byteLength: frame.width * frame.height * BYTES_PER_PIXEL }
    const { target, byteLength } = source
    const bufferBytes = target.width * target.height * BYTES_PER_PIXEL
    const slot = nextReadback
    nextReadback = 1 - nextReadback
    const buffer = readbackBuffers[slot] ?? null
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer)
    if (readbackSizes[slot] !== bufferBytes) {
      gl.bufferData(gl.PIXEL_PACK_BUFFER, bufferBytes, gl.STREAM_READ)
      readbackSizes[slot] = bufferBytes
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer)
    gl.readPixels(0, 0, target.width, target.height, gl.RGBA, gl.UNSIGNED_BYTE, 0)
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
    const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)
    gl.flush()

    return async () => {
      while (fence !== null && gl.clientWaitSync(fence, 0, 0) === gl.TIMEOUT_EXPIRED) {
        await new Promise((resolve) => setTimeout(resolve, READBACK_POLL_MS))
      }
      gl.deleteSync(fence)
      if (readBack.length !== byteLength) readBack = new Uint8Array(byteLength)
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer)
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, readBack)
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
      return readBack.buffer
    }
  }

  return { uploadPixels, refillPixels, uploadImage, release, render, present, readPixels, startReadback }
}
