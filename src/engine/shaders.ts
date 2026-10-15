// The programs the compositor draws with. Positions are output pixels with the first row at the top; `vLocal` is the place inside the box being drawn, measured from its centre.

// How many effects one draw can apply. A clip has each kind at most once, four of the fourteen kinds are not applied here, and a group adds its own effects to those of its members.
export const MAX_OPS = 12
// Samples on each side of the centre of a blur.
export const BLUR_TAPS = 7

export const OP_COLOR_ADJUST = 1
export const OP_BLACK_AND_WHITE = 2
export const OP_CHROMA_KEY = 3
export const OP_ROUNDED_CORNERS = 4
export const OP_BORDER = 5
export const OP_SEPIA = 6
export const OP_INVERT = 7
export const OP_TINT = 8
export const OP_VIGNETTE = 9
export const OP_LOOK = 10

export const SOURCE_PICTURE = 0
export const SOURCE_ALPHA_BELOW = 1
export const SOURCE_TARGET = 2

export const SHAPE_BLUR = 0
export const SHAPE_PIXELATE = 1
export const SHAPE_HIGHLIGHT = 2
export const SHAPE_SPOTLIGHT = 3

export const VERTEX_SHADER = `#version 300 es
layout(location = 0) in vec2 aPosition;
layout(location = 1) in vec2 aLocal;
uniform vec2 uOutputSize;
out vec2 vLocal;
void main() {
  vLocal = aLocal;
  gl_Position = vec4(aPosition / uOutputSize * 2.0 - 1.0, 0.0, 1.0);
}`

// The part of the output a wipe or a circle lets through. With no transition the line lies far behind every pixel and the circle is larger than any output.
const REVEAL = `
uniform vec3 uLine;
uniform vec4 uCircle;
float shown(vec2 at) {
  float line = clamp(dot(at, uLine.xy) - uLine.z + 0.5, 0.0, 1.0);
  float circle = clamp((uCircle.z - distance(at, uCircle.xy)) * uCircle.w + 0.5, 0.0, 1.0);
  return line * circle;
}`

export const LAYER_SHADER = `#version 300 es
precision highp float;
const int MAX_OPS = ${MAX_OPS};
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
// How far apart two colours may be, in the plane of their colour without their brightness, at full tolerance and at full softness.
const float TOLERANCE_REACH = 0.5;
const float SOFTNESS_REACH = 0.25;
// How far beyond the clear middle a vignette takes to reach its full darkness, as a share of the way to the corners.
const float VIGNETTE_FALLOFF = 0.5;
uniform sampler2D uTexture;
uniform int uSource;
uniform vec2 uHalfSize;
uniform vec4 uTextureRect;
uniform vec4 uTextureLimit;
uniform float uOpacity;
uniform float uLodBias;
uniform int uOpCount;
uniform int uOpKind[MAX_OPS];
uniform vec4 uOpA[MAX_OPS];
uniform vec4 uOpB[MAX_OPS];
uniform vec4 uOpC[MAX_OPS];
uniform float uRadius;
uniform vec2 uTint;
in vec2 vLocal;
out vec4 outColor;
${REVEAL}

// How much of a pixel lies inside the box once its corners are rounded.
float roundedBox(vec2 halfSize, float radius) {
  float rounding = min(radius, min(halfSize.x, halfSize.y));
  vec2 corner = abs(vLocal) - (halfSize - rounding);
  float outside = length(max(corner, 0.0)) + min(max(corner.x, corner.y), 0.0) - rounding;
  return clamp(0.5 - outside, 0.0, 1.0);
}

vec3 straight(vec4 color) {
  return color.a > 0.0 ? color.rgb / color.a : vec3(0.0);
}

vec2 chromaOf(vec3 color) {
  return vec2(dot(color, vec3(-0.1146, -0.3854, 0.5)), dot(color, vec3(0.5, -0.4542, -0.0458)));
}

void main() {
  vec4 color;
  float coverage = 1.0;
  if (uSource == ${SOURCE_TARGET}) {
    color = texelFetch(uTexture, ivec2(gl_FragCoord.xy), 0);
  } else {
    vec2 unit = vLocal / (2.0 * uHalfSize) + 0.5;
    vec2 uv = clamp(uTextureRect.xy + unit * uTextureRect.zw, uTextureLimit.xy, uTextureLimit.zw);
    if (uSource == ${SOURCE_ALPHA_BELOW}) {
      color.rgb = textureLod(uTexture, vec2(uv.x, uv.y * 0.5), 0.0).rgb;
      color.a = textureLod(uTexture, vec2(uv.x, 0.5 + uv.y * 0.5), 0.0).r;
    } else {
      color = texture(uTexture, uv, uLodBias);
    }
    vec2 inside = uHalfSize - abs(vLocal);
    coverage = clamp(min(inside.x, inside.y) + 0.5, 0.0, 1.0);
  }

  float radius = uRadius;
  for (int index = 0; index < MAX_OPS; index++) {
    if (index >= uOpCount) break;
    int kind = uOpKind[index];
    vec4 a = uOpA[index];
    vec4 b = uOpB[index];
    vec4 c = uOpC[index];
    if (kind == ${OP_COLOR_ADJUST}) {
      vec3 adjusted = (straight(color) - 0.5) * (1.0 + a.y) + 0.5 + a.x;
      adjusted = clamp(mix(vec3(dot(adjusted, LUMA)), adjusted, 1.0 + a.z), 0.0, 1.0);
      color.rgb = adjusted * color.a;
    } else if (kind == ${OP_BLACK_AND_WHITE}) {
      color.rgb = mix(color.rgb, vec3(dot(color.rgb, LUMA)), a.x);
    } else if (kind == ${OP_CHROMA_KEY}) {
      vec3 picture = straight(color);
      vec2 chroma = chromaOf(picture);
      vec2 key = chromaOf(a.rgb);
      float nearest = a.w * TOLERANCE_REACH;
      float kept = smoothstep(nearest, nearest + b.x * SOFTNESS_REACH + 0.001, distance(chroma, key));
      // What is left of the key colour in the pixels that stay is taken out along the key's own direction of colour.
      float keyLength = length(key);
      vec2 toward = keyLength > 0.0 ? key / keyLength : vec2(0.0);
      vec2 spill = -toward * max(dot(chroma, toward), 0.0) * b.y;
      picture = clamp(picture + vec3(1.5748 * spill.y, -0.1873 * spill.x - 0.4681 * spill.y, 1.8556 * spill.x), 0.0, 1.0);
      color = vec4(picture, 1.0) * (color.a * kept);
    } else if (kind == ${OP_ROUNDED_CORNERS}) {
      radius = a.x;
      color *= roundedBox(uHalfSize, radius);
      coverage = 1.0;
    } else if (kind == ${OP_BORDER}) {
      float outer = roundedBox(uHalfSize, radius);
      float inner = roundedBox(uHalfSize - a.w, max(radius - a.w, 0.0));
      color = mix(color, vec4(a.rgb, 1.0) * outer, 1.0 - inner);
      coverage = 1.0;
    } else if (kind == ${OP_SEPIA}) {
      vec3 sepia = vec3(dot(color.rgb, vec3(0.393, 0.769, 0.189)), dot(color.rgb, vec3(0.349, 0.686, 0.168)), dot(color.rgb, vec3(0.272, 0.534, 0.131)));
      color.rgb = mix(color.rgb, min(sepia, vec3(color.a)), a.x);
    } else if (kind == ${OP_INVERT}) {
      color.rgb = mix(color.rgb, vec3(color.a) - color.rgb, a.x);
    } else if (kind == ${OP_TINT}) {
      color.rgb = mix(color.rgb, a.rgb * dot(color.rgb, LUMA), a.w);
    } else if (kind == ${OP_VIGNETTE}) {
      // 0 in the middle of the box, 1 in its corners.
      float away = length(vLocal / uHalfSize) * 0.70710678;
      color.rgb *= 1.0 - a.x * smoothstep(a.y, a.y + VIGNETTE_FALLOFF, away);
    } else if (kind == ${OP_LOOK}) {
      // a: gain and contrast, b: lift and saturation, c: how much the shadows and the highlights are brightened.
      vec3 graded = straight(color) * a.rgb;
      float light = dot(graded, LUMA);
      graded *= 1.0 + c.x * (1.0 - smoothstep(0.0, 0.5, light)) + c.y * smoothstep(0.5, 1.0, light);
      graded = (graded - 0.5) * (1.0 + a.w) + 0.5;
      graded = mix(vec3(dot(graded, LUMA)), graded, 1.0 + b.w);
      graded = b.rgb + graded * (1.0 - b.rgb);
      color.rgb = clamp(graded, 0.0, 1.0) * color.a;
    }
  }

  if (uTint.y > 0.0) color.rgb = mix(color.rgb, vec3(uTint.x * color.a), uTint.y);
  outColor = color * (uOpacity * coverage * shown(gl_FragCoord.xy));
}`

// One direction of a blur. Its samples are taken from the level of the source's chain of smaller copies whose pixels are as far apart as the samples, so the cost does not grow with the strength.
export const BLUR_SHADER = `#version 300 es
precision highp float;
const int TAPS = ${BLUR_TAPS};
uniform sampler2D uTexture;
uniform vec2 uTexel;
uniform vec2 uStep;
uniform vec2 uShift;
uniform float uLevel;
uniform float uWeights[TAPS + 1];
uniform vec4 uShadow;
uniform float uGain;
in vec2 vLocal;
out vec4 outColor;
void main() {
  vec2 at = (gl_FragCoord.xy + uShift) * uTexel;
  vec4 sum = textureLod(uTexture, at, uLevel) * uWeights[0];
  for (int tap = 1; tap <= TAPS; tap++) {
    vec2 away = uStep * float(tap);
    sum += (textureLod(uTexture, at + away, uLevel) + textureLod(uTexture, at - away, uLevel)) * uWeights[tap];
  }
  // A shadow is the blurred shape of the picture, filled with one colour.
  outColor = uShadow.a > 0.0 ? vec4(uShadow.rgb, 1.0) * (sum.a * uShadow.a) : vec4(sum.rgb * uGain, sum.a);
}`

// An unsharp mask: each pixel is pushed away from the mean of the pixels around it. Both are taken as straight colour, so the transparent pixels around a clip do not brighten its edge.
export const SHARPEN_SHADER = `#version 300 es
precision highp float;
uniform sampler2D uTexture;
uniform vec2 uTexel;
uniform float uSpacing;
uniform float uLevel;
uniform float uAmount;
in vec2 vLocal;
out vec4 outColor;
vec4 near(vec2 at, float x, float y) {
  return textureLod(uTexture, at + vec2(x, y) * uSpacing * uTexel, uLevel);
}
void main() {
  vec4 middle = texelFetch(uTexture, ivec2(gl_FragCoord.xy), 0);
  if (middle.a <= 0.0) {
    outColor = middle;
    return;
  }
  vec2 at = gl_FragCoord.xy * uTexel;
  // A 3 × 3 bell: the middle counts 4, each side 2 and each corner 1.
  vec4 around = near(at, 0.0, 0.0) * 4.0;
  around += (near(at, 1.0, 0.0) + near(at, -1.0, 0.0) + near(at, 0.0, 1.0) + near(at, 0.0, -1.0)) * 2.0;
  around += near(at, 1.0, 1.0) + near(at, -1.0, 1.0) + near(at, 1.0, -1.0) + near(at, -1.0, -1.0);
  vec3 plain = middle.rgb / middle.a;
  vec3 mean = around.rgb / around.a;
  outColor = vec4(clamp(plain + uAmount * (plain - mean), 0.0, 1.0) * middle.a, middle.a);
}`

export const SHAPE_SHADER = `#version 300 es
precision highp float;
uniform sampler2D uTexture;
uniform int uKind;
uniform vec2 uHalfSize;
uniform float uIsEllipse;
uniform float uSoftEdge;
uniform float uOpacity;
uniform vec3 uColor;
uniform vec2 uTexel;
uniform vec4 uBlocks;
in vec2 vLocal;
out vec4 outColor;
${REVEAL}

// How far inside the shape a pixel lies, as a share of the soft edge: 0 at the edge, 1 where the edge has ended.
float shapeCoverage() {
  float inside;
  if (uIsEllipse > 0.5) {
    float reach = length(vLocal / uHalfSize);
    inside = reach > 0.0001 ? length(vLocal) * (1.0 / reach - 1.0) : min(uHalfSize.x, uHalfSize.y);
  } else {
    vec2 margin = uHalfSize - abs(vLocal);
    inside = min(margin.x, margin.y);
  }
  float ramp = clamp((inside + 0.5) / max(uSoftEdge, 1.0), 0.0, 1.0);
  return ramp * ramp * (3.0 - 2.0 * ramp);
}

void main() {
  float cover = shapeCoverage();
  float strength = uOpacity * shown(gl_FragCoord.xy);
  if (uKind == ${SHAPE_HIGHLIGHT} || uKind == ${SHAPE_SPOTLIGHT}) {
    // Drawn with a blend that multiplies: what is beneath keeps its colour where this is white.
    float amount = strength * (uKind == ${SHAPE_SPOTLIGHT} ? 1.0 - cover : cover);
    outColor = vec4(mix(vec3(1.0), uColor, amount), 1.0);
    return;
  }
  vec4 beneath;
  if (uKind == ${SHAPE_PIXELATE}) {
    // Each block shows the mean of what is beneath it: sixteen samples in a grid, each already the mean of its sixteenth of the block.
    vec2 corner = uBlocks.xy + floor((gl_FragCoord.xy - uBlocks.xy) / uBlocks.z) * uBlocks.z;
    beneath = vec4(0.0);
    for (int part = 0; part < 16; part++) {
      vec2 middle = (vec2(part % 4, part / 4) + 0.5) / 4.0;
      beneath += textureLod(uTexture, (corner + middle * uBlocks.z) * uTexel, uBlocks.w) / 16.0;
    }
  } else {
    beneath = texelFetch(uTexture, ivec2(gl_FragCoord.xy), 0);
  }
  outColor = beneath * (cover * strength);
}`

// The frame as the bytes of a YUV 4:2:0 picture in BT.709 TV range, as video encoders take it: the luma plane, then the blue and the red
// difference planes, each of their samples the average of 2 × 2 pixels. Every RGBA texel holds the next four bytes, row after row.
export const YUV_SHADER = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uTexture;
uniform ivec2 uPictureSize;
uniform int uRowTexels;
out vec4 outColor;
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
float byteAt(int index) {
  int width = uPictureSize.x;
  int lumaBytes = width * uPictureSize.y;
  if (index < lumaBytes) return (16.0 + 219.0 * dot(texelFetch(uTexture, ivec2(index % width, index / width), 0).rgb, LUMA)) / 255.0;
  int chromaWidth = width / 2;
  int chromaBytes = chromaWidth * (uPictureSize.y / 2);
  int chroma = index - lumaBytes;
  bool isRed = chroma >= chromaBytes;
  if (isRed) chroma -= chromaBytes;
  if (chroma >= chromaBytes) return 0.0;
  ivec2 at = ivec2(chroma % chromaWidth, chroma / chromaWidth) * 2;
  vec3 rgb = (texelFetch(uTexture, at, 0).rgb + texelFetch(uTexture, at + ivec2(1, 0), 0).rgb + texelFetch(uTexture, at + ivec2(0, 1), 0).rgb + texelFetch(uTexture, at + ivec2(1, 1), 0).rgb) * 0.25;
  float luma = dot(rgb, LUMA);
  float difference = isRed ? (rgb.r - luma) / 1.5748 : (rgb.b - luma) / 1.8556;
  return (128.0 + 224.0 * difference) / 255.0;
}
void main() {
  ivec2 texel = ivec2(gl_FragCoord.xy);
  int first = (texel.y * uRowTexels + texel.x) * 4;
  outColor = vec4(byteAt(first), byteAt(first + 1), byteAt(first + 2), byteAt(first + 3));
}`
