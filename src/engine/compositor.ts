// The one compositor behind preview and export. Every frame is drawn into an off-screen
// buffer at the output size; the preview copies that buffer to the canvas and the export
// reads it back, so both see the same pixels.
import { fitCanvas, type Size } from '../shared/exportPresets.js'
import type { RawFrame } from '../shared/mediaProtocol.js'
import type { Crop, Transform } from '../shared/project.js'

/**
 * The one resampling filter: trilinear mip-mapping, biased half a level towards the sharper
 * mip. Unbiased, a 1.5× reduction already blends in 58% of the half-size picture and softens
 * screen text; the bias keeps moderate reductions crisp without aliasing large ones.
 */
const LOD_BIAS = -0.5
/** Each quad is drawn this many output pixels larger than the picture, so its edge can be anti-aliased. */
const EDGE_MARGIN = 1
const BYTES_PER_PIXEL = 4
/** A full mip chain adds a third to the base level. */
const MIP_CHAIN_FACTOR = 4 / 3
const FLOATS_PER_VERTEX = 4
const DEGREES_TO_RADIANS = Math.PI / 180

const VERTEX_SHADER = `#version 300 es
in vec2 aPosition;
in vec2 aLocal;
uniform vec2 uOutputSize;
out vec2 vLocal;
void main() {
  vLocal = aLocal;
  // Output row 0 lands on the first row the buffer is read back from, so no flip is needed.
  gl_Position = vec4(aPosition / uOutputSize * 2.0 - 1.0, 0.0, 1.0);
}`

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform sampler2D uTexture;
uniform vec2 uHalfSize;
uniform vec4 uTextureRect;
uniform vec4 uTextureLimit;
uniform float uOpacity;
uniform float uLodBias;
uniform bool uAlphaBelow;
in vec2 vLocal;
out vec4 outColor;
void main() {
  vec2 unit = vLocal / (2.0 * uHalfSize) + 0.5;
  vec2 uv = clamp(uTextureRect.xy + unit * uTextureRect.zw, uTextureLimit.xy, uTextureLimit.zw);
  vec4 color;
  if (uAlphaBelow) {
    color.rgb = textureLod(uTexture, vec2(uv.x, uv.y * 0.5), 0.0).rgb;
    color.a = textureLod(uTexture, vec2(uv.x, 0.5 + uv.y * 0.5), 0.0).r;
  } else {
    color = texture(uTexture, uv, uLodBias);
  }
  // Distance to the nearest edge in output pixels becomes coverage: exact for aligned
  // edges, smooth for rotated ones, and identical with or without multisampling.
  vec2 inside = uHalfSize - abs(vLocal);
  float coverage = clamp(min(inside.x, inside.y) + 0.5, 0.0, 1.0);
  outColor = color * (uOpacity * coverage);
}`

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
  /** GPU memory held, mip chain included. */
  bytes: number
}

/** One layer to draw. Colour in the texture is premultiplied by alpha. */
export type DrawItem = {
  texture: GpuTexture
  /** Size of the whole, uncropped picture in canvas pixels. */
  naturalWidth: number
  naturalHeight: number
  crop: Crop
  transform: Transform
  opacity: number
  /** The texture is twice the picture height: colour on top, alpha as grey below. */
  hasAlphaBelow: boolean
}

export type Compositor = {
  /** Uploads premultiplied RGBA pixels, top row first. */
  uploadPixels(frame: RawFrame): GpuTexture
  /** Uploads a decoded image or a canvas; its colour must already be premultiplied. */
  uploadImage(image: ImageBitmap | OffscreenCanvas): GpuTexture
  release(texture: GpuTexture): void
  /** Draws `items` bottom to top over black, with the canvas fitted inside the output. */
  render(canvas: Size, output: Size, items: readonly DrawItem[]): void
  /** Copies the last rendered frame onto the drawing surface. */
  present(): void
  /** The last rendered frame as RGBA, top row first. The buffer is reused by the next call. */
  readPixels(): ArrayBuffer
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

function linkProgram(gl: WebGL2RenderingContext): WebGLProgram {
  const program = gl.createProgram()
  gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER))
  gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER))
  gl.linkProgram(program)
  if (gl.getProgramParameter(program, gl.LINK_STATUS) !== true) {
    throw new CompositorError(`The shader program did not link: ${gl.getProgramInfoLog(program) ?? 'no details'}`)
  }
  return program
}

/** Corner positions and local coordinates of one item's quad, as a triangle strip in output pixels. */
function quadVertices(item: DrawItem, canvas: Size, output: Size): { vertices: Float32Array; halfWidth: number; halfHeight: number } | undefined {
  const fit = fitCanvas(canvas, output)
  const croppedWidth = item.naturalWidth - item.crop.left - item.crop.right
  const croppedHeight = item.naturalHeight - item.crop.top - item.crop.bottom
  const halfWidth = (croppedWidth * item.transform.scaleX * fit.scale) / 2
  const halfHeight = (croppedHeight * item.transform.scaleY * fit.scale) / 2
  if (!(halfWidth > 0) || !(halfHeight > 0)) return undefined

  const centerX = fit.offsetX + item.transform.x * fit.scale
  const centerY = fit.offsetY + item.transform.y * fit.scale
  const angle = item.transform.rotation * DEGREES_TO_RADIANS
  const cosine = Math.cos(angle)
  const sine = Math.sin(angle)

  const vertices = new Float32Array(4 * FLOATS_PER_VERTEX)
  const corners = [
    { x: -1, y: -1 },
    { x: 1, y: -1 },
    { x: -1, y: 1 },
    { x: 1, y: 1 },
  ]
  for (const [index, corner] of corners.entries()) {
    const localX = corner.x * (halfWidth + EDGE_MARGIN)
    const localY = corner.y * (halfHeight + EDGE_MARGIN)
    // Y points down in output pixels, so a positive angle turns clockwise.
    vertices[index * FLOATS_PER_VERTEX] = centerX + localX * cosine - localY * sine
    vertices[index * FLOATS_PER_VERTEX + 1] = centerY + localX * sine + localY * cosine
    vertices[index * FLOATS_PER_VERTEX + 2] = localX
    vertices[index * FLOATS_PER_VERTEX + 3] = localY
  }
  return { vertices, halfWidth, halfHeight }
}

export function createCompositor(gl: WebGL2RenderingContext): Compositor {
  const program = linkProgram(gl)
  function uniform(name: string): WebGLUniformLocation | null {
    return gl.getUniformLocation(program, name)
  }
  const uniforms = {
    outputSize: uniform('uOutputSize'),
    halfSize: uniform('uHalfSize'),
    textureRect: uniform('uTextureRect'),
    textureLimit: uniform('uTextureLimit'),
    opacity: uniform('uOpacity'),
    lodBias: uniform('uLodBias'),
    alphaBelow: uniform('uAlphaBelow'),
  }

  const vertexArray = gl.createVertexArray()
  const vertexBuffer = gl.createBuffer()
  gl.bindVertexArray(vertexArray)
  gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer)
  gl.bufferData(gl.ARRAY_BUFFER, 4 * FLOATS_PER_VERTEX * Float32Array.BYTES_PER_ELEMENT, gl.DYNAMIC_DRAW)
  const stride = FLOATS_PER_VERTEX * Float32Array.BYTES_PER_ELEMENT
  const positionAttribute = gl.getAttribLocation(program, 'aPosition')
  const localAttribute = gl.getAttribLocation(program, 'aLocal')
  gl.enableVertexAttribArray(positionAttribute)
  gl.vertexAttribPointer(positionAttribute, 2, gl.FLOAT, false, stride, 0)
  gl.enableVertexAttribArray(localAttribute)
  gl.vertexAttribPointer(localAttribute, 2, gl.FLOAT, false, stride, 2 * Float32Array.BYTES_PER_ELEMENT)

  gl.disable(gl.DEPTH_TEST)
  gl.enable(gl.BLEND)
  // Premultiplied alpha: source colour is added as is.
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE)

  const frameBuffer = gl.createFramebuffer()
  const frameTexture = gl.createTexture()
  const frameSize: Size = { width: 0, height: 0 }

  function resizeFrame(output: Size): void {
    if (frameSize.width === output.width && frameSize.height === output.height) return
    gl.bindTexture(gl.TEXTURE_2D, frameTexture)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, output.width, output.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.bindFramebuffer(gl.FRAMEBUFFER, frameBuffer)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, frameTexture, 0)
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw new CompositorError(`The GPU cannot render at ${output.width}×${output.height}`)
    }
    frameSize.width = output.width
    frameSize.height = output.height
  }

  /** Sets sampling and builds the mip chain of the texture that was just filled. */
  function finishTexture(handle: WebGLTexture, width: number, height: number): GpuTexture {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.generateMipmap(gl.TEXTURE_2D)
    return { handle, width, height, bytes: Math.ceil(width * height * BYTES_PER_PIXEL * MIP_CHAIN_FACTOR) }
  }

  function uploadPixels(frame: RawFrame): GpuTexture {
    const handle = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, handle)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, frame.width, frame.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(frame.data))
    return finishTexture(handle, frame.width, frame.height)
  }

  function uploadImage(image: ImageBitmap | OffscreenCanvas): GpuTexture {
    const handle = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, handle)
    // The source is already premultiplied; without this flag WebGL would divide the alpha back out.
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, image)
    return finishTexture(handle, image.width, image.height)
  }

  function release(texture: GpuTexture): void {
    gl.deleteTexture(texture.handle)
  }

  function draw(item: DrawItem, canvas: Size, output: Size): void {
    if (!(item.opacity > 0)) return
    const quad = quadVertices(item, canvas, output)
    if (quad === undefined) return

    const pictureHeight = item.hasAlphaBelow ? item.texture.height / 2 : item.texture.height
    const left = item.crop.left / item.naturalWidth
    const top = item.crop.top / item.naturalHeight
    const width = 1 - (item.crop.left + item.crop.right) / item.naturalWidth
    const height = 1 - (item.crop.top + item.crop.bottom) / item.naturalHeight
    // Samples stay half a texel inside the drawn part, so nothing outside the crop bleeds in.
    const halfTexelX = 0.5 / item.texture.width
    const halfTexelY = 0.5 / pictureHeight

    gl.bindTexture(gl.TEXTURE_2D, item.texture.handle)
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, quad.vertices)
    gl.uniform2f(uniforms.halfSize, quad.halfWidth, quad.halfHeight)
    gl.uniform4f(uniforms.textureRect, left, top, width, height)
    gl.uniform4f(uniforms.textureLimit, left + halfTexelX, top + halfTexelY, left + width - halfTexelX, top + height - halfTexelY)
    gl.uniform1f(uniforms.opacity, Math.min(item.opacity, 1))
    gl.uniform1i(uniforms.alphaBelow, item.hasAlphaBelow ? 1 : 0)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }

  function render(canvas: Size, output: Size, items: readonly DrawItem[]): void {
    resizeFrame(output)
    gl.bindFramebuffer(gl.FRAMEBUFFER, frameBuffer)
    gl.viewport(0, 0, output.width, output.height)
    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)

    gl.useProgram(program)
    gl.bindVertexArray(vertexArray)
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer)
    gl.activeTexture(gl.TEXTURE0)
    gl.uniform2f(uniforms.outputSize, output.width, output.height)
    gl.uniform1f(uniforms.lodBias, LOD_BIAS)
    for (const item of items) draw(item, canvas, output)
  }

  function present(): void {
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, frameBuffer)
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null)
    // The buffer holds the top row first; the canvas wants it at the top, hence the flipped target.
    gl.blitFramebuffer(0, 0, frameSize.width, frameSize.height, 0, frameSize.height, frameSize.width, 0, gl.COLOR_BUFFER_BIT, gl.NEAREST)
  }

  // One read-back buffer for the compositor's lifetime: at 4K each one is 33 MB, and an export
  // would otherwise leave one behind per frame for the garbage collector.
  let readBack = new Uint8Array(0)

  function readPixels(): ArrayBuffer {
    const byteLength = frameSize.width * frameSize.height * BYTES_PER_PIXEL
    if (readBack.length !== byteLength) readBack = new Uint8Array(byteLength)
    gl.bindFramebuffer(gl.FRAMEBUFFER, frameBuffer)
    gl.readPixels(0, 0, frameSize.width, frameSize.height, gl.RGBA, gl.UNSIGNED_BYTE, readBack)
    return readBack.buffer
  }

  return { uploadPixels, uploadImage, release, render, present, readPixels }
}
