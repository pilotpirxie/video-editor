import {
  ANIMATION_FRAME_RATES,
  MAX_SPEED_PERCENT,
  MIN_SPEED_PERCENT,
  PROJECT_FRAME_RATES,
  TIMELINE_GRID,
  isFrameRateIn,
  isOnTimelineGrid,
  type FrameRate,
} from './time.js'

export const PROJECT_VERSION = 1

export type DocumentKind = 'project' | 'animation'

export const ANIMATION_EXTENSION = 'pbanim'
export const MAX_ANIMATION_DEPTH = 8

export function isAnimationPath(path: string): boolean {
  return path.toLowerCase().endsWith(`.${ANIMATION_EXTENSION}`)
}

export type Easing = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | 'hold'

export function ease(easing: Easing, progress: number): number {
  if (easing === 'hold') {
    return 0
  } else if (easing === 'easeIn') {
    return progress * progress * progress
  } else if (easing === 'easeOut') {
    const remaining = 1 - progress
    return 1 - remaining * remaining * remaining
  } else if (easing === 'easeInOut') {
    if (progress < 0.5) return 4 * progress * progress * progress
    const remaining = 1 - progress
    return 1 - 4 * remaining * remaining * remaining
  } else {
    return progress
  }
}

export type Keyframe = {
  time: number
  value: number
  easing: Easing
}

export function valueAt(keyframes: readonly Keyframe[], localTime: number): number | undefined {
  let earlier = 0
  let later = keyframes.length
  while (earlier < later) {
    const middle = (earlier + later) >>> 1
    const keyframe = keyframes[middle]
    if (keyframe !== undefined && keyframe.time > localTime) later = middle
    else earlier = middle + 1
  }

  const next = keyframes[later]
  const previous = keyframes[later - 1]
  if (previous === undefined) return next?.value
  if (next === undefined) return previous.value
  const progress = (localTime - previous.time) / (next.time - previous.time)
  return previous.value + (next.value - previous.value) * ease(previous.easing, progress)
}

export type AnimatableProperty =
  | 'x'
  | 'y'
  | 'scaleX'
  | 'scaleY'
  | 'rotation'
  | 'opacity'
  | 'cropLeft'
  | 'cropTop'
  | 'cropRight'
  | 'cropBottom'
  | 'volume'

export type Keyframes = Partial<Record<AnimatableProperty, Keyframe[]>>

export type Transform = {
  x: number
  y: number
  scaleX: number
  scaleY: number
  rotation: number
}

export type Crop = {
  left: number
  top: number
  right: number
  bottom: number
}

type ClipTiming = {
  id: string
  start: number
  duration: number
  keyframes?: Keyframes
}

export type TransitionType =
  | 'crossDissolve'
  | 'fadeBlack'
  | 'fadeWhite'
  | 'wipeLeft'
  | 'wipeRight'
  | 'wipeUp'
  | 'wipeDown'
  | 'wipeUpLeft'
  | 'wipeUpRight'
  | 'wipeDownLeft'
  | 'wipeDownRight'
  | 'slide'
  | 'slideRight'
  | 'slideUp'
  | 'slideDown'
  | 'push'
  | 'pushRight'
  | 'pushUp'
  | 'pushDown'
  | 'zoom'
  | 'shrink'
  | 'spin'
  | 'circleReveal'
  | 'circleClose'

export type Transition = {
  type: TransitionType
  duration: number
}

export type AnimationPresetType = 'fade' | 'pop' | 'slideLeft' | 'slideRight' | 'slideUp' | 'slideDown' | 'zoom' | 'typewriter'

export type AnimationPreset = {
  type: AnimationPresetType
  duration: number
}

type VisualSettings = {
  transform: Transform
  opacity: number
  fadeIn?: number
  fadeOut?: number
  transitionIn?: Transition
  transitionOut?: Transition
  animationIn?: AnimationPreset
  animationOut?: AnimationPreset
}

type EffectSwitch = {
  isOff?: true
}

export type Effect =
  | (EffectSwitch & { type: 'colorAdjust'; brightness: number; contrast: number; saturation: number })
  | (EffectSwitch & { type: 'blackAndWhite'; amount: number })
  | (EffectSwitch & { type: 'dropShadow'; offsetX: number; offsetY: number; softness: number; color: string; opacity: number })
  | (EffectSwitch & { type: 'border'; width: number; color: string })
  | (EffectSwitch & { type: 'roundedCorners'; radius: number })
  | (EffectSwitch & { type: 'clipBlur'; strength: number })
  | (EffectSwitch & { type: 'chromaKey'; color: string; tolerance: number; softness: number; spill: number })
  | (EffectSwitch & { type: 'sepia'; amount: number })
  | (EffectSwitch & { type: 'invert'; amount: number })
  | (EffectSwitch & { type: 'tint'; color: string; amount: number })
  | (EffectSwitch & { type: 'vignette'; amount: number; size: number })
  | (EffectSwitch & {
      type: 'look'
      strength: number
      exposure: number
      contrast: number
      highlights: number
      shadows: number
      temperature: number
      tint: number
      saturation: number
      fade: number
      shadowColor: string
      shadowAmount: number
      highlightColor: string
      highlightAmount: number
    })
  | (EffectSwitch & { type: 'sharpen'; amount: number; radius: number })
  | (EffectSwitch & { type: 'blurFill'; strength: number; darken: number })

export type EffectType = Effect['type']

type EffectSettings = {
  effects?: Effect[]
}

type SourceSettings = {
  mediaId: string
  sourceStart: number
  speedPercent: number
  changesPitch?: true
  hasFastSound?: true
}

type VolumeSettings = {
  volume: number
  volumeFadeIn?: number
  volumeFadeOut?: number
}

export type VideoClip = ClipTiming &
  VisualSettings &
  EffectSettings &
  SourceSettings &
  VolumeSettings & {
    type: 'video'
    crop?: Crop
    isAudioSeparated?: true
    loop?: true
  }

export type AudioClip = ClipTiming &
  SourceSettings &
  VolumeSettings & {
    type: 'audio'
  }

type ImageClip = ClipTiming &
  VisualSettings &
  EffectSettings & {
    type: 'image'
    mediaId: string
    crop?: Crop
  }

export type TextAlign = 'left' | 'center' | 'right'

export type TextSettings = {
  text: string
  font: { family: string; size: number; weight?: number }
  color: string
  align: TextAlign
  outline?: { color: string; width: number }
  shadow?: { color: string; offsetX: number; offsetY: number; blur: number }
  lineSpacing?: number
}

export type TextClip = ClipTiming &
  VisualSettings &
  EffectSettings &
  TextSettings & {
    type: 'text'
    background?: { color: string }
    boxWidth?: number
  }

export type CalloutShape = 'rectangle' | 'roundedBox' | 'ellipse' | 'speechBubble' | 'thoughtBubble' | 'arrowBox' | 'banner' | 'burst'

export type CalloutClip = ClipTiming &
  VisualSettings &
  EffectSettings &
  TextSettings & {
    type: 'callout'
    width: number
    height: number
    shape: CalloutShape
    fill: string
    borderColor: string
    borderWidth: number
    tail?: { x: number; y: number }
  }

export type ArrowHead = 'none' | 'triangle' | 'open' | 'dot'

export type ArrowClip = ClipTiming &
  VisualSettings &
  EffectSettings & {
    type: 'arrow'
    length: number
    thickness: number
    color: string
    startHead: ArrowHead
    endHead: ArrowHead
  }

export type Shape = 'rectangle' | 'ellipse'

type ShapeSettings = {
  width: number
  height: number
  shape: Shape
  softEdge: number
}

export type BlurClip = ClipTiming &
  VisualSettings &
  ShapeSettings & {
    type: 'blur'
    strength: number
    isPixelated?: true
  }

export type HighlightClip = ClipTiming &
  VisualSettings &
  ShapeSettings & {
    type: 'highlight'
    color: string
    isSpotlight?: true
  }

export type GroupClip = ClipTiming &
  VisualSettings &
  EffectSettings &
  VolumeSettings & {
    type: 'group'
    tracks: Track[]
    contentStart?: number
  }

export type AnimationClip = ClipTiming &
  VisualSettings &
  EffectSettings &
  SourceSettings &
  VolumeSettings & {
    type: 'animation'
    loop?: true
  }

// Offset from its node, so a moved node takes its handles along.
type ShapeHandle = {
  x: number
  y: number
}

// A side without a handle is sharp there.
export type ShapeNode = {
  x: number
  y: number
  in?: ShapeHandle
  out?: ShapeHandle
}

export type ShapeStroke = {
  color: string
  width: number
}

export type DrawingShape = {
  id: string
  name?: string
  hidden?: true
  locked?: true
  nodes: ShapeNode[]
  isClosed?: true
  fill?: string
  stroke?: ShapeStroke
  children?: DrawingShape[]
}

// Shapes are listed back to front, in the artboard's pixels.
export type DrawingClip = ClipTiming & {
  type: 'drawing'
  shapes: DrawingShape[]
}

export type Clip = VideoClip | AudioClip | ImageClip | TextClip | BlurClip | HighlightClip | CalloutClip | ArrowClip | GroupClip | AnimationClip | DrawingClip
export type PictureClip = VideoClip | ImageClip | TextClip | CalloutClip | ArrowClip
export type ShapeClip = BlurClip | HighlightClip
export type VisualClip = PictureClip | ShapeClip | GroupClip | AnimationClip

export function isVisual(clip: Clip): clip is VisualClip {
  return clip.type !== 'audio' && clip.type !== 'drawing'
}

export type Track = {
  id: string
  name: string
  hidden: boolean
  locked: boolean
  muted: boolean
  clips: Clip[]
}

export type MediaRef = {
  id: string
  path: string
  relativePath: string
}

export type Canvas = {
  width: number
  height: number
  frameRate: FrameRate
}

export type CameraKeyframe = {
  time: number
  duration: number
  easing: Easing
  x: number
  y: number
  scale: number
}

export type Project = {
  version: typeof PROJECT_VERSION
  canvas: Canvas
  media: MediaRef[]
  tracks: Track[]
  camera?: CameraKeyframe[]
}

export type ParseResult = { ok: true; project: Project } | { ok: false; message: string }

export const MIN_CANVAS = { width: 160, height: 120 }
export const MAX_CANVAS = { width: 3840, height: 2160 }
export const MAX_CAMERA_SCALE = 10
const MAX_VOLUME = 2
const MAX_GROUP_DEPTH = 8
const MAX_SHAPE_DEPTH = 8
const MIN_SHAPE_NODES = 2
const FONT_WEIGHT_STEP = 100
const FONT_WEIGHT = { min: 100, max: 900 }
const LINE_SPACING: NumberRule = { min: 0.5, max: 3 }

const EASINGS: readonly Easing[] = ['linear', 'easeIn', 'easeOut', 'easeInOut', 'hold']
const TRANSFORM_PROPERTIES: readonly AnimatableProperty[] = ['x', 'y', 'scaleX', 'scaleY', 'rotation', 'opacity']
const CROP_PROPERTIES: readonly AnimatableProperty[] = ['cropLeft', 'cropTop', 'cropRight', 'cropBottom']
const TEXT_ALIGNMENTS: readonly TextAlign[] = ['left', 'center', 'right']
const CLIP_TYPES = ['video', 'audio', 'image', 'text', 'blur', 'highlight', 'callout', 'arrow', 'group', 'animation', 'drawing']
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/
const OPAQUE_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/
export const TRANSITION_TYPES: readonly TransitionType[] = [
  'crossDissolve',
  'fadeBlack',
  'fadeWhite',
  'wipeLeft',
  'wipeRight',
  'wipeUp',
  'wipeDown',
  'wipeUpLeft',
  'wipeUpRight',
  'wipeDownLeft',
  'wipeDownRight',
  'slide',
  'slideRight',
  'slideUp',
  'slideDown',
  'push',
  'pushRight',
  'pushUp',
  'pushDown',
  'zoom',
  'shrink',
  'spin',
  'circleReveal',
  'circleClose',
]
export const EFFECT_TYPES: readonly EffectType[] = [
  'colorAdjust',
  'look',
  'blackAndWhite',
  'sepia',
  'tint',
  'invert',
  'vignette',
  'dropShadow',
  'border',
  'roundedCorners',
  'clipBlur',
  'sharpen',
  'chromaKey',
  'blurFill',
]
const SHAPES: readonly Shape[] = ['rectangle', 'ellipse']
export const ANIMATION_PRESET_TYPES: readonly AnimationPresetType[] = ['fade', 'pop', 'slideLeft', 'slideRight', 'slideUp', 'slideDown', 'zoom', 'typewriter']
export const CALLOUT_SHAPES: readonly CalloutShape[] = ['rectangle', 'roundedBox', 'ellipse', 'speechBubble', 'thoughtBubble', 'arrowBox', 'banner', 'burst']
export const ARROW_HEADS: readonly ArrowHead[] = ['none', 'triangle', 'open', 'dot']
const AMOUNT: NumberRule = { min: 0, max: 1 }
const ADJUSTMENT: NumberRule = { min: -1, max: 1 }
const EXPOSURE: NumberRule = { min: -2, max: 2 }
const SHARPEN_AMOUNT: NumberRule = { min: 0, max: 2 }

class FormatError extends Error {}

function fail(path: string, problem: string): never {
  throw new FormatError(`${path} ${problem}`)
}

type NumberRule = {
  min?: number
  max?: number
  above?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readFields(value: unknown, path: string, required: readonly string[], optional: readonly string[] = []): Fields {
  if (!isRecord(value)) fail(path, 'must be an object')
  for (const key of required) {
    if (!(key in value)) fail(`${path}.${key}`, 'is missing')
  }
  for (const key of Object.keys(value)) {
    const isKnown = required.includes(key) || optional.includes(key)
    if (!isKnown) fail(`${path}.${key}`, 'is not a known setting')
  }
  return new Fields(value, path)
}

class Fields {
  constructor(
    private readonly record: Record<string, unknown>,
    readonly path: string,
  ) {}

  at(key: string): string {
    return `${this.path}.${key}`
  }

  has(key: string): boolean {
    return key in this.record
  }

  raw(key: string): unknown {
    return this.record[key]
  }

  string(key: string): string {
    const value = this.record[key]
    if (typeof value !== 'string') fail(this.at(key), 'must be text')
    return value
  }

  nonEmptyString(key: string): string {
    const value = this.string(key)
    if (value === '') fail(this.at(key), 'must not be empty')
    return value
  }

  boolean(key: string): boolean {
    const value = this.record[key]
    if (typeof value !== 'boolean') fail(this.at(key), 'must be true or false')
    return value
  }

  oneOf<Option extends string>(key: string, allowed: readonly Option[]): Option {
    const value = this.string(key)
    const match = allowed.find((option) => option === value)
    if (match === undefined) fail(this.at(key), `must be one of ${allowed.join(', ')}`)
    return match
  }

  number(key: string, rule: NumberRule = {}): number {
    const value = this.record[key]
    if (typeof value !== 'number' || !Number.isFinite(value)) fail(this.at(key), 'must be a number')
    if (rule.min !== undefined && value < rule.min) fail(this.at(key), `must be at least ${rule.min}`)
    if (rule.max !== undefined && value > rule.max) fail(this.at(key), `must be at most ${rule.max}`)
    if (rule.above !== undefined && value <= rule.above) fail(this.at(key), `must be greater than ${rule.above}`)
    return value
  }

  integer(key: string, rule: NumberRule = {}): number {
    const value = this.number(key, rule)
    if (!Number.isSafeInteger(value)) fail(this.at(key), 'must be a whole number')
    return value
  }

  gridTime(key: string, kind: 'zero or more' | 'positive'): number {
    const sign = kind === 'positive' ? 'positive' : 'non-negative'
    const problem = `must be a ${sign} multiple of ${TIMELINE_GRID}`
    const value = this.anyGridTime(key, problem)
    const minimum = kind === 'positive' ? TIMELINE_GRID : 0
    if (value < minimum) fail(this.at(key), problem)
    return value
  }

  anyGridTime(key: string, problem = `must be a multiple of ${TIMELINE_GRID}`): number {
    const value = this.record[key]
    if (typeof value !== 'number' || !isOnTimelineGrid(value)) fail(this.at(key), problem)
    return value
  }

  array(key: string): unknown[] {
    const value = this.record[key]
    if (!Array.isArray(value)) fail(this.at(key), 'must be a list')
    return value
  }

  color(key: string): string {
    const value = this.string(key)
    if (!COLOR_PATTERN.test(value)) fail(this.at(key), 'must look like #RRGGBB or #RRGGBBAA')
    return value
  }

  opaqueColor(key: string): string {
    const value = this.string(key)
    if (!OPAQUE_COLOR_PATTERN.test(value)) fail(this.at(key), 'must look like #RRGGBB')
    return value
  }
}

function rateNames(rates: readonly FrameRate[]): string {
  const names = rates.map((rate) => (rate.den === 1 ? String(rate.num) : `${rate.num}/${rate.den}`))
  return `${names.slice(0, -1).join(', ')} or ${names.at(-1) ?? ''}`
}

function parseFrameRate(value: unknown, path: string, kind: DocumentKind): FrameRate {
  const fields = readFields(value, path, ['num', 'den'])
  const rate = { num: fields.integer('num', { min: 1 }), den: fields.integer('den', { min: 1 }) }
  const allowed = kind === 'animation' ? ANIMATION_FRAME_RATES : PROJECT_FRAME_RATES
  if (!isFrameRateIn(allowed, rate)) fail(path, `must be ${rateNames(allowed)} frames per second`)
  return rate
}

function parseCanvas(value: unknown, path: string, kind: DocumentKind): Canvas {
  const fields = readFields(value, path, ['width', 'height', 'frameRate'])
  return {
    width: fields.integer('width', { min: MIN_CANVAS.width, max: MAX_CANVAS.width }),
    height: fields.integer('height', { min: MIN_CANVAS.height, max: MAX_CANVAS.height }),
    frameRate: parseFrameRate(fields.raw('frameRate'), fields.at('frameRate'), kind),
  }
}

function parseMedia(value: unknown, path: string): MediaRef {
  const fields = readFields(value, path, ['id', 'path', 'relativePath'])
  const media = {
    id: fields.nonEmptyString('id'),
    path: fields.string('path'),
    relativePath: fields.string('relativePath'),
  }
  if (media.path === '' && media.relativePath === '') fail(path, 'needs a path or a relativePath')
  return media
}

function parseTransform(value: unknown, path: string): Transform {
  const fields = readFields(value, path, ['x', 'y', 'scaleX', 'scaleY', 'rotation'])
  return {
    x: fields.number('x'),
    y: fields.number('y'),
    scaleX: fields.number('scaleX', { min: 0 }),
    scaleY: fields.number('scaleY', { min: 0 }),
    rotation: fields.number('rotation'),
  }
}

function parseCrop(value: unknown, path: string): Crop {
  const fields = readFields(value, path, ['left', 'top', 'right', 'bottom'])
  const crop = {
    left: fields.number('left', { min: 0 }),
    top: fields.number('top', { min: 0 }),
    right: fields.number('right', { min: 0 }),
    bottom: fields.number('bottom', { min: 0 }),
  }
  const isEmpty = crop.left === 0 && crop.top === 0 && crop.right === 0 && crop.bottom === 0
  if (isEmpty) fail(path, 'crops nothing; leave it out instead')
  return crop
}

function valueRule(property: AnimatableProperty): NumberRule {
  if (property === 'opacity') return { min: 0, max: 1 }
  if (property === 'volume') return { min: 0, max: MAX_VOLUME }
  if (property === 'x' || property === 'y' || property === 'rotation') return {}
  return { min: 0 }
}

function parseKeyframeList(value: unknown, path: string, property: AnimatableProperty): Keyframe[] {
  if (!Array.isArray(value) || value.length === 0) fail(path, 'must be a list with at least one keyframe')

  const keyframes: Keyframe[] = []
  let previousTime = -Infinity
  for (const [index, entry] of value.entries()) {
    const fields = readFields(entry, `${path}[${index}]`, ['time', 'value', 'easing'])
    const keyframe: Keyframe = {
      time: fields.anyGridTime('time'),
      value: fields.number('value', valueRule(property)),
      easing: fields.oneOf('easing', EASINGS),
    }
    if (keyframe.time <= previousTime) fail(fields.at('time'), 'must be later than the previous keyframe')
    previousTime = keyframe.time
    keyframes.push(keyframe)
  }
  return keyframes
}

function parseKeyframes(value: unknown, path: string, allowed: readonly AnimatableProperty[]): Keyframes {
  const fields = readFields(value, path, [], allowed)
  const keyframes: Keyframes = {}
  for (const property of allowed) {
    if (!fields.has(property)) continue
    keyframes[property] = parseKeyframeList(fields.raw(property), fields.at(property), property)
  }
  if (Object.keys(keyframes).length === 0) fail(path, 'is empty; leave it out instead')
  return keyframes
}

function parseFade(fields: Fields, key: string, clipDuration: number): number {
  const fade = fields.gridTime(key, 'positive')
  if (fade > clipDuration) fail(fields.at(key), 'is longer than the clip')
  return fade
}

function parseTransition(fields: Fields, key: string): Transition {
  const transition = readFields(fields.raw(key), fields.at(key), ['type', 'duration'])
  return { type: transition.oneOf('type', TRANSITION_TYPES), duration: transition.gridTime('duration', 'positive') }
}

const EFFECT_KEYS: Record<EffectType, readonly string[]> = {
  colorAdjust: ['brightness', 'contrast', 'saturation'],
  blackAndWhite: ['amount'],
  dropShadow: ['offsetX', 'offsetY', 'softness', 'color', 'opacity'],
  border: ['width', 'color'],
  roundedCorners: ['radius'],
  clipBlur: ['strength'],
  chromaKey: ['color', 'tolerance', 'softness', 'spill'],
  sepia: ['amount'],
  invert: ['amount'],
  tint: ['color', 'amount'],
  vignette: ['amount', 'size'],
  look: ['strength', 'exposure', 'contrast', 'highlights', 'shadows', 'temperature', 'tint', 'saturation', 'fade', 'shadowColor', 'shadowAmount', 'highlightColor', 'highlightAmount'],
  sharpen: ['amount', 'radius'],
  blurFill: ['strength', 'darken'],
}

function effectSettings(type: EffectType, fields: Fields): Effect {
  if (type === 'colorAdjust') {
    return {
      type,
      brightness: fields.number('brightness', ADJUSTMENT),
      contrast: fields.number('contrast', ADJUSTMENT),
      saturation: fields.number('saturation', ADJUSTMENT),
    }
  } else if (type === 'blackAndWhite' || type === 'sepia' || type === 'invert') {
    return { type, amount: fields.number('amount', AMOUNT) }
  } else if (type === 'dropShadow') {
    return {
      type,
      offsetX: fields.number('offsetX'),
      offsetY: fields.number('offsetY'),
      softness: fields.number('softness', { min: 0 }),
      color: fields.opaqueColor('color'),
      opacity: fields.number('opacity', AMOUNT),
    }
  } else if (type === 'border') {
    return { type, width: fields.number('width', { above: 0 }), color: fields.opaqueColor('color') }
  } else if (type === 'roundedCorners') {
    return { type, radius: fields.number('radius', { above: 0 }) }
  } else if (type === 'clipBlur') {
    return { type, strength: fields.number('strength', { above: 0 }) }
  } else if (type === 'tint') {
    return { type, color: fields.opaqueColor('color'), amount: fields.number('amount', AMOUNT) }
  } else if (type === 'vignette') {
    return { type, amount: fields.number('amount', AMOUNT), size: fields.number('size', AMOUNT) }
  } else if (type === 'look') {
    return {
      type,
      strength: fields.number('strength', AMOUNT),
      exposure: fields.number('exposure', EXPOSURE),
      contrast: fields.number('contrast', ADJUSTMENT),
      highlights: fields.number('highlights', ADJUSTMENT),
      shadows: fields.number('shadows', ADJUSTMENT),
      temperature: fields.number('temperature', ADJUSTMENT),
      tint: fields.number('tint', ADJUSTMENT),
      saturation: fields.number('saturation', ADJUSTMENT),
      fade: fields.number('fade', AMOUNT),
      shadowColor: fields.opaqueColor('shadowColor'),
      shadowAmount: fields.number('shadowAmount', AMOUNT),
      highlightColor: fields.opaqueColor('highlightColor'),
      highlightAmount: fields.number('highlightAmount', AMOUNT),
    }
  } else if (type === 'sharpen') {
    return { type, amount: fields.number('amount', SHARPEN_AMOUNT), radius: fields.number('radius', { above: 0 }) }
  } else if (type === 'blurFill') {
    return { type, strength: fields.number('strength', { above: 0 }), darken: fields.number('darken', AMOUNT) }
  } else {
    return {
      type,
      color: fields.opaqueColor('color'),
      tolerance: fields.number('tolerance', AMOUNT),
      softness: fields.number('softness', AMOUNT),
      spill: fields.number('spill', AMOUNT),
    }
  }
}

function parseEffects(value: unknown, path: string, canFill = false): Effect[] {
  if (!Array.isArray(value) || value.length === 0) fail(path, 'must be a list with at least one effect; leave it out instead')

  const effects: Effect[] = []
  for (const [index, entry] of value.entries()) {
    const entryPath = `${path}[${index}]`
    const named = isRecord(entry) ? entry.type : undefined
    const type = EFFECT_TYPES.find((known) => known === named)
    if (type === undefined) fail(`${entryPath}.type`, `must be one of ${EFFECT_TYPES.join(', ')}`)
    if (effects.some((other) => other.type === type)) fail(`${entryPath}.type`, `"${type}" is used more than once on this clip`)
    if (type === 'blurFill' && !canFill) fail(`${entryPath}.type`, 'can only be "blurFill" on a video or image clip')

    const fields = readFields(entry, entryPath, ['type', ...EFFECT_KEYS[type]], ['isOff'])
    const effect = effectSettings(type, fields)
    if (fields.has('isOff')) effect.isOff = parseSwitch(fields, 'isOff')
    effects.push(effect)
  }
  return effects
}

const TIMING_KEYS = ['id', 'type', 'start', 'duration']
const VISUAL_KEYS = ['transform', 'opacity']
const SOURCE_KEYS = ['mediaId', 'sourceStart', 'speedPercent']
const SHAPE_KEYS = ['width', 'height', 'shape', 'softEdge']
const TEXT_KEYS = ['text', 'font', 'color', 'align']
const OPTIONAL_VISUAL_KEYS = ['fadeIn', 'fadeOut', 'transitionIn', 'transitionOut', 'animationIn', 'animationOut', 'keyframes']
const OPTIONAL_PICTURE_KEYS = [...OPTIONAL_VISUAL_KEYS, 'effects']
const OPTIONAL_VOLUME_KEYS = ['volumeFadeIn', 'volumeFadeOut']
const OPTIONAL_SOURCE_KEYS = ['changesPitch', 'hasFastSound']
const OPTIONAL_TEXT_KEYS = ['outline', 'shadow', 'lineSpacing']

type ParseContext = {
  kind: DocumentKind
  mediaIds: ReadonlySet<string>
  clipIds: Set<string>
  depth: number
  shift: number
}

function parseTiming(fields: Fields, context: ParseContext, animatable: readonly AnimatableProperty[]): ClipTiming {
  const id = fields.nonEmptyString('id')
  if (context.clipIds.has(id)) fail(fields.at('id'), `"${id}" is used by more than one clip`)
  context.clipIds.add(id)

  const timing: ClipTiming = {
    id,
    start: fields.gridTime('start', 'zero or more'),
    duration: fields.gridTime('duration', 'positive'),
  }
  const projectEnd = context.shift + timing.start + timing.duration
  if (!Number.isSafeInteger(projectEnd)) fail(fields.at('duration'), 'ends the clip too far along the timeline')
  if (fields.has('keyframes')) {
    timing.keyframes = parseKeyframes(fields.raw('keyframes'), fields.at('keyframes'), animatable)
  }
  return timing
}

function parseAnimationPreset(fields: Fields, key: string): AnimationPreset {
  const animation = readFields(fields.raw(key), fields.at(key), ['type', 'duration'])
  const type = animation.oneOf('type', ANIMATION_PRESET_TYPES)
  if (type === 'typewriter' && fields.raw('type') !== 'text') fail(animation.at('type'), 'can only be "typewriter" on a text clip')
  return { type, duration: animation.gridTime('duration', 'positive') }
}

function parseVisual(fields: Fields, clipDuration: number): VisualSettings {
  const visual: VisualSettings = {
    transform: parseTransform(fields.raw('transform'), fields.at('transform')),
    opacity: fields.number('opacity', { min: 0, max: 1 }),
  }
  if (fields.has('fadeIn')) visual.fadeIn = parseFade(fields, 'fadeIn', clipDuration)
  if (fields.has('fadeOut')) visual.fadeOut = parseFade(fields, 'fadeOut', clipDuration)
  if (fields.has('transitionIn')) visual.transitionIn = parseTransition(fields, 'transitionIn')
  if (fields.has('transitionOut')) visual.transitionOut = parseTransition(fields, 'transitionOut')
  if (fields.has('animationIn')) visual.animationIn = parseAnimationPreset(fields, 'animationIn')
  if (fields.has('animationOut')) visual.animationOut = parseAnimationPreset(fields, 'animationOut')
  return visual
}

function parseMediaId(fields: Fields, context: ParseContext): string {
  const mediaId = fields.string('mediaId')
  if (!context.mediaIds.has(mediaId)) fail(fields.at('mediaId'), `"${mediaId}" is not in the media list`)
  return mediaId
}

function parseSource(fields: Fields, context: ParseContext, clipDuration: number): SourceSettings {
  const source: SourceSettings = {
    mediaId: parseMediaId(fields, context),
    sourceStart: fields.integer('sourceStart', { min: 0 }),
    speedPercent: fields.integer('speedPercent', { min: MIN_SPEED_PERCENT, max: MAX_SPEED_PERCENT }),
  }
  const sourceEnd = source.sourceStart + (clipDuration / TIMELINE_GRID) * source.speedPercent
  if (!Number.isSafeInteger(sourceEnd)) fail(fields.at('sourceStart'), 'reaches too far into the source')
  if (fields.has('changesPitch')) source.changesPitch = parseSwitch(fields, 'changesPitch')
  if (fields.has('hasFastSound')) source.hasFastSound = parseSwitch(fields, 'hasFastSound')
  return source
}

function parseVolume(fields: Fields, clipDuration: number): VolumeSettings {
  const settings: VolumeSettings = { volume: fields.number('volume', { min: 0, max: MAX_VOLUME }) }
  if (fields.has('volumeFadeIn')) settings.volumeFadeIn = parseFade(fields, 'volumeFadeIn', clipDuration)
  if (fields.has('volumeFadeOut')) settings.volumeFadeOut = parseFade(fields, 'volumeFadeOut', clipDuration)
  return settings
}

function parseSwitch(fields: Fields, key: string): true {
  if (!fields.boolean(key)) fail(fields.at(key), 'must be true or left out')
  return true
}

function parseVideoClip(value: unknown, path: string, context: ParseContext): VideoClip {
  const fields = readFields(
    value,
    path,
    [...TIMING_KEYS, ...VISUAL_KEYS, ...SOURCE_KEYS, 'volume'],
    [...OPTIONAL_PICTURE_KEYS, ...OPTIONAL_VOLUME_KEYS, ...OPTIONAL_SOURCE_KEYS, 'crop', 'isAudioSeparated', 'loop'],
  )
  const timing = parseTiming(fields, context, [...TRANSFORM_PROPERTIES, ...CROP_PROPERTIES, 'volume'])
  const clip: VideoClip = {
    type: 'video',
    ...timing,
    ...parseVisual(fields, timing.duration),
    ...parseSource(fields, context, timing.duration),
    ...parseVolume(fields, timing.duration),
  }
  if (fields.has('crop')) clip.crop = parseCrop(fields.raw('crop'), fields.at('crop'))
  if (fields.has('effects')) clip.effects = parseEffects(fields.raw('effects'), fields.at('effects'), true)
  if (fields.has('isAudioSeparated')) clip.isAudioSeparated = parseSwitch(fields, 'isAudioSeparated')
  if (fields.has('loop')) clip.loop = parseSwitch(fields, 'loop')
  return clip
}

function parseAudioClip(value: unknown, path: string, context: ParseContext): AudioClip {
  const fields = readFields(value, path, [...TIMING_KEYS, ...SOURCE_KEYS, 'volume'], [...OPTIONAL_VOLUME_KEYS, ...OPTIONAL_SOURCE_KEYS, 'keyframes'])
  const timing = parseTiming(fields, context, ['volume'])
  return { type: 'audio', ...timing, ...parseSource(fields, context, timing.duration), ...parseVolume(fields, timing.duration) }
}

function parseImageClip(value: unknown, path: string, context: ParseContext): ImageClip {
  const fields = readFields(value, path, [...TIMING_KEYS, ...VISUAL_KEYS, 'mediaId'], [...OPTIONAL_PICTURE_KEYS, 'crop'])
  const timing = parseTiming(fields, context, [...TRANSFORM_PROPERTIES, ...CROP_PROPERTIES])
  const clip: ImageClip = {
    type: 'image',
    ...timing,
    ...parseVisual(fields, timing.duration),
    mediaId: parseMediaId(fields, context),
  }
  if (fields.has('crop')) clip.crop = parseCrop(fields.raw('crop'), fields.at('crop'))
  if (fields.has('effects')) clip.effects = parseEffects(fields.raw('effects'), fields.at('effects'), true)
  return clip
}

function parseFont(value: unknown, path: string): TextSettings['font'] {
  const fields = readFields(value, path, ['family', 'size'], ['weight'])
  const font: TextSettings['font'] = { family: fields.nonEmptyString('family'), size: fields.number('size', { above: 0 }) }
  if (fields.has('weight')) {
    const weight = fields.integer('weight', FONT_WEIGHT)
    if (weight % FONT_WEIGHT_STEP !== 0) fail(fields.at('weight'), `must be a whole hundred from ${FONT_WEIGHT.min} to ${FONT_WEIGHT.max}`)
    font.weight = weight
  }
  return font
}

function parseTextSettings(fields: Fields, text: string): TextSettings {
  const settings: TextSettings = {
    text,
    font: parseFont(fields.raw('font'), fields.at('font')),
    color: fields.color('color'),
    align: fields.oneOf('align', TEXT_ALIGNMENTS),
  }
  if (fields.has('outline')) {
    const outline = readFields(fields.raw('outline'), fields.at('outline'), ['color', 'width'])
    settings.outline = { color: outline.color('color'), width: outline.number('width', { above: 0 }) }
  }
  if (fields.has('shadow')) {
    const shadow = readFields(fields.raw('shadow'), fields.at('shadow'), ['color', 'offsetX', 'offsetY', 'blur'])
    settings.shadow = {
      color: shadow.color('color'),
      offsetX: shadow.number('offsetX'),
      offsetY: shadow.number('offsetY'),
      blur: shadow.number('blur', { min: 0 }),
    }
  }
  if (fields.has('lineSpacing')) settings.lineSpacing = fields.number('lineSpacing', LINE_SPACING)
  return settings
}

function parseTextClip(value: unknown, path: string, context: ParseContext): TextClip {
  const required = [...TIMING_KEYS, ...VISUAL_KEYS, ...TEXT_KEYS]
  const optional = [...OPTIONAL_PICTURE_KEYS, ...OPTIONAL_TEXT_KEYS, 'background', 'boxWidth']
  const fields = readFields(value, path, required, optional)
  const timing = parseTiming(fields, context, TRANSFORM_PROPERTIES)
  const clip: TextClip = {
    type: 'text',
    ...timing,
    ...parseVisual(fields, timing.duration),
    ...parseTextSettings(fields, fields.nonEmptyString('text')),
  }
  if (fields.has('background')) {
    const background = readFields(fields.raw('background'), fields.at('background'), ['color'])
    clip.background = { color: background.color('color') }
  }
  if (fields.has('boxWidth')) clip.boxWidth = fields.number('boxWidth', { above: 0 })
  if (fields.has('effects')) clip.effects = parseEffects(fields.raw('effects'), fields.at('effects'))
  return clip
}

export function hasTail(shape: CalloutShape): boolean {
  return shape === 'speechBubble' || shape === 'thoughtBubble'
}

function parseCalloutClip(value: unknown, path: string, context: ParseContext): CalloutClip {
  const required = [...TIMING_KEYS, ...VISUAL_KEYS, ...TEXT_KEYS, 'width', 'height', 'shape', 'fill', 'borderColor', 'borderWidth']
  const fields = readFields(value, path, required, [...OPTIONAL_PICTURE_KEYS, ...OPTIONAL_TEXT_KEYS, 'tail'])
  const timing = parseTiming(fields, context, TRANSFORM_PROPERTIES)
  const clip: CalloutClip = {
    type: 'callout',
    ...timing,
    ...parseVisual(fields, timing.duration),
    ...parseTextSettings(fields, fields.string('text')),
    width: fields.number('width', { above: 0 }),
    height: fields.number('height', { above: 0 }),
    shape: fields.oneOf('shape', CALLOUT_SHAPES),
    fill: fields.color('fill'),
    borderColor: fields.color('borderColor'),
    borderWidth: fields.number('borderWidth', { min: 0 }),
  }
  if (fields.has('tail') !== hasTail(clip.shape)) fail(fields.at('tail'), 'is needed by a speech bubble and a thought bubble, and by no other shape')
  if (fields.has('tail')) {
    const tail = readFields(fields.raw('tail'), fields.at('tail'), ['x', 'y'])
    clip.tail = { x: tail.number('x'), y: tail.number('y') }
  }
  if (fields.has('effects')) clip.effects = parseEffects(fields.raw('effects'), fields.at('effects'))
  return clip
}

function parseArrowClip(value: unknown, path: string, context: ParseContext): ArrowClip {
  const required = [...TIMING_KEYS, ...VISUAL_KEYS, 'length', 'thickness', 'color', 'startHead', 'endHead']
  const fields = readFields(value, path, required, OPTIONAL_PICTURE_KEYS)
  const timing = parseTiming(fields, context, TRANSFORM_PROPERTIES)
  const clip: ArrowClip = {
    type: 'arrow',
    ...timing,
    ...parseVisual(fields, timing.duration),
    length: fields.number('length', { above: 0 }),
    thickness: fields.number('thickness', { above: 0 }),
    color: fields.color('color'),
    startHead: fields.oneOf('startHead', ARROW_HEADS),
    endHead: fields.oneOf('endHead', ARROW_HEADS),
  }
  if (fields.has('effects')) clip.effects = parseEffects(fields.raw('effects'), fields.at('effects'))
  return clip
}

function parseTracks(value: readonly unknown[], path: string, context: ParseContext): Track[] {
  const tracks: Track[] = []
  for (const [index, track] of value.entries()) {
    tracks.push(parseTrack(track, `${path}[${index}]`, context))
  }
  rejectDuplicateIds(tracks, path)
  return tracks
}

// Groups and animations scale their members by one factor, so both of their scales have to match.
function rejectUnevenScale(fields: Fields, clip: { transform: Transform; keyframes?: Keyframes }, kind: string): void {
  const hasSameScaleKeyframes = JSON.stringify(clip.keyframes?.scaleX) === JSON.stringify(clip.keyframes?.scaleY)
  const isEvenlyScaled = clip.transform.scaleX === clip.transform.scaleY && hasSameScaleKeyframes
  if (!isEvenlyScaled) fail(fields.at('transform'), `of ${kind} must have the same scaleX and scaleY, in its keyframes too`)
}

function parseAnimationClip(value: unknown, path: string, context: ParseContext): AnimationClip {
  const required = [...TIMING_KEYS, ...VISUAL_KEYS, ...SOURCE_KEYS, 'volume']
  const optional = [...OPTIONAL_PICTURE_KEYS, ...OPTIONAL_VOLUME_KEYS, ...OPTIONAL_SOURCE_KEYS, 'loop']
  const fields = readFields(value, path, required, optional)
  const timing = parseTiming(fields, context, [...TRANSFORM_PROPERTIES, 'volume'])
  const clip: AnimationClip = {
    type: 'animation',
    ...timing,
    ...parseVisual(fields, timing.duration),
    ...parseSource(fields, context, timing.duration),
    ...parseVolume(fields, timing.duration),
  }
  rejectUnevenScale(fields, clip, 'an animation')
  if (fields.has('effects')) clip.effects = parseEffects(fields.raw('effects'), fields.at('effects'))
  if (fields.has('loop')) clip.loop = parseSwitch(fields, 'loop')
  return clip
}

function parseGroupClip(value: unknown, path: string, context: ParseContext): GroupClip {
  if (context.depth >= MAX_GROUP_DEPTH) fail(path, `is a group inside more than ${MAX_GROUP_DEPTH} groups`)
  const required = [...TIMING_KEYS, ...VISUAL_KEYS, 'volume', 'tracks']
  const optional = [...OPTIONAL_PICTURE_KEYS, ...OPTIONAL_VOLUME_KEYS, 'contentStart']
  const fields = readFields(value, path, required, optional)
  const timing = parseTiming(fields, context, [...TRANSFORM_PROPERTIES, 'volume'])
  const contentStart = fields.has('contentStart') ? fields.gridTime('contentStart', 'positive') : undefined
  const memberShift = context.shift + timing.start - (contentStart ?? 0)
  const memberContext: ParseContext = { ...context, depth: context.depth + 1, shift: memberShift }
  const clip: GroupClip = {
    type: 'group',
    ...timing,
    ...parseVisual(fields, timing.duration),
    ...parseVolume(fields, timing.duration),
    tracks: parseTracks(fields.array('tracks'), fields.at('tracks'), memberContext),
  }
  rejectUnevenScale(fields, clip, 'a group')
  if (contentStart !== undefined) clip.contentStart = contentStart
  if (fields.has('effects')) clip.effects = parseEffects(fields.raw('effects'), fields.at('effects'))
  return clip
}

function parseShape(fields: Fields): ShapeSettings {
  return {
    width: fields.number('width', { above: 0 }),
    height: fields.number('height', { above: 0 }),
    shape: fields.oneOf('shape', SHAPES),
    softEdge: fields.number('softEdge', { min: 0 }),
  }
}

function parseBlurClip(value: unknown, path: string, context: ParseContext): BlurClip {
  const fields = readFields(value, path, [...TIMING_KEYS, ...VISUAL_KEYS, ...SHAPE_KEYS, 'strength'], [...OPTIONAL_VISUAL_KEYS, 'isPixelated'])
  const timing = parseTiming(fields, context, TRANSFORM_PROPERTIES)
  const clip: BlurClip = {
    type: 'blur',
    ...timing,
    ...parseVisual(fields, timing.duration),
    ...parseShape(fields),
    strength: fields.number('strength', { above: 0 }),
  }
  if (fields.has('isPixelated')) clip.isPixelated = parseSwitch(fields, 'isPixelated')
  return clip
}

function parseHighlightClip(value: unknown, path: string, context: ParseContext): HighlightClip {
  const fields = readFields(value, path, [...TIMING_KEYS, ...VISUAL_KEYS, ...SHAPE_KEYS, 'color'], [...OPTIONAL_VISUAL_KEYS, 'isSpotlight'])
  const timing = parseTiming(fields, context, TRANSFORM_PROPERTIES)
  const clip: HighlightClip = {
    type: 'highlight',
    ...timing,
    ...parseVisual(fields, timing.duration),
    ...parseShape(fields),
    color: fields.opaqueColor('color'),
  }
  if (fields.has('isSpotlight')) clip.isSpotlight = parseSwitch(fields, 'isSpotlight')
  return clip
}

function parseShapeHandle(fields: Fields, key: string): ShapeHandle {
  const handle = readFields(fields.raw(key), fields.at(key), ['x', 'y'])
  return { x: handle.number('x'), y: handle.number('y') }
}

function parseShapeNode(value: unknown, path: string): ShapeNode {
  const fields = readFields(value, path, ['x', 'y'], ['in', 'out'])
  const node: ShapeNode = { x: fields.number('x'), y: fields.number('y') }
  if (fields.has('in')) node.in = parseShapeHandle(fields, 'in')
  if (fields.has('out')) node.out = parseShapeHandle(fields, 'out')
  return node
}

function parseDrawingShapes(value: unknown, path: string, depth: number, shapeIds: Set<string>): DrawingShape[] {
  if (!Array.isArray(value)) fail(path, 'must be a list')
  const shapes: DrawingShape[] = []
  for (const [index, entry] of value.entries()) {
    shapes.push(parseDrawingShape(entry, `${path}[${index}]`, depth, shapeIds))
  }
  return shapes
}

function parseDrawingShape(value: unknown, path: string, depth: number, shapeIds: Set<string>): DrawingShape {
  const fields = readFields(value, path, ['id', 'nodes'], ['name', 'hidden', 'locked', 'isClosed', 'fill', 'stroke', 'children'])
  const id = fields.nonEmptyString('id')
  if (shapeIds.has(id)) fail(fields.at('id'), `"${id}" is used by more than one shape in this drawing`)
  shapeIds.add(id)

  const nodes: ShapeNode[] = []
  for (const [index, entry] of fields.array('nodes').entries()) {
    nodes.push(parseShapeNode(entry, `${fields.at('nodes')}[${index}]`))
  }
  if (nodes.length < MIN_SHAPE_NODES) fail(fields.at('nodes'), `must have at least ${MIN_SHAPE_NODES} nodes`)
  const shape: DrawingShape = { id, nodes }
  if (fields.has('name')) shape.name = fields.string('name')
  if (fields.has('hidden')) shape.hidden = parseSwitch(fields, 'hidden')
  if (fields.has('locked')) shape.locked = parseSwitch(fields, 'locked')
  if (fields.has('isClosed')) shape.isClosed = parseSwitch(fields, 'isClosed')
  if (fields.has('fill')) shape.fill = fields.color('fill')
  if (fields.has('stroke')) {
    const stroke = readFields(fields.raw('stroke'), fields.at('stroke'), ['color', 'width'])
    shape.stroke = { color: stroke.color('color'), width: stroke.number('width', { above: 0 }) }
  }
  if (fields.has('children')) {
    if (depth >= MAX_SHAPE_DEPTH) fail(fields.at('children'), `go deeper than ${MAX_SHAPE_DEPTH} shapes clipped inside each other`)
    const children = parseDrawingShapes(fields.raw('children'), fields.at('children'), depth + 1, shapeIds)
    if (children.length === 0) fail(fields.at('children'), 'is empty; leave it out instead')
    shape.children = children
  }
  return shape
}

function parseDrawingClip(value: unknown, path: string, context: ParseContext): DrawingClip {
  if (context.kind !== 'animation') fail(path, 'is a drawing, which only an animation can hold')
  const fields = readFields(value, path, [...TIMING_KEYS, 'shapes'])
  return { type: 'drawing', ...parseTiming(fields, context, []), shapes: parseDrawingShapes(fields.raw('shapes'), fields.at('shapes'), 0, new Set()) }
}

function parseClip(value: unknown, path: string, context: ParseContext): Clip {
  const type = isRecord(value) ? value.type : undefined
  if (type === 'video') {
    return parseVideoClip(value, path, context)
  } else if (type === 'audio') {
    return parseAudioClip(value, path, context)
  } else if (type === 'image') {
    return parseImageClip(value, path, context)
  } else if (type === 'text') {
    return parseTextClip(value, path, context)
  } else if (type === 'blur') {
    return parseBlurClip(value, path, context)
  } else if (type === 'highlight') {
    return parseHighlightClip(value, path, context)
  } else if (type === 'callout') {
    return parseCalloutClip(value, path, context)
  } else if (type === 'arrow') {
    return parseArrowClip(value, path, context)
  } else if (type === 'group') {
    return parseGroupClip(value, path, context)
  } else if (type === 'animation') {
    return parseAnimationClip(value, path, context)
  } else if (type === 'drawing') {
    return parseDrawingClip(value, path, context)
  } else {
    return fail(`${path}.type`, `must be one of ${CLIP_TYPES.join(', ')}; this version cannot open other clip types`)
  }
}

function rejectOverlaps(clips: readonly Clip[], path: string): void {
  const byStart = [...clips].sort((a, b) => a.start - b.start)
  let previous: Clip | undefined
  for (const current of byStart) {
    if (previous !== undefined && previous.start + previous.duration > current.start) {
      fail(path, `has overlapping clips "${previous.id}" and "${current.id}"`)
    }
    previous = current
  }
}

function parseTrack(value: unknown, path: string, context: ParseContext): Track {
  const fields = readFields(value, path, ['id', 'name', 'hidden', 'locked', 'muted', 'clips'])
  const clips: Clip[] = []
  for (const [index, clip] of fields.array('clips').entries()) {
    clips.push(parseClip(clip, `${fields.at('clips')}[${index}]`, context))
  }
  rejectOverlaps(clips, fields.at('clips'))
  return {
    id: fields.nonEmptyString('id'),
    name: fields.string('name'),
    hidden: fields.boolean('hidden'),
    locked: fields.boolean('locked'),
    muted: fields.boolean('muted'),
    clips,
  }
}

function rejectDuplicateIds(items: readonly { id: string }[], path: string): void {
  const seen = new Set<string>()
  for (const item of items) {
    if (seen.has(item.id)) fail(path, `uses the id "${item.id}" more than once`)
    seen.add(item.id)
  }
}

function parseCamera(value: unknown, path: string): CameraKeyframe[] {
  if (!Array.isArray(value) || value.length === 0) fail(path, 'must be a list with at least one zoom; leave it out instead')

  const zooms: CameraKeyframe[] = []
  for (const [index, entry] of value.entries()) {
    const fields = readFields(entry, `${path}[${index}]`, ['time', 'duration', 'easing', 'x', 'y', 'scale'])
    const zoom: CameraKeyframe = {
      time: fields.gridTime('time', 'zero or more'),
      duration: fields.gridTime('duration', 'positive'),
      easing: fields.oneOf('easing', EASINGS),
      x: fields.number('x'),
      y: fields.number('y'),
      scale: fields.number('scale', { min: 1, max: MAX_CAMERA_SCALE }),
    }
    const previous = zooms.at(-1)
    if (previous !== undefined && zoom.time <= previous.time) fail(fields.at('time'), 'must be later than the zoom before it')
    zooms.push(zoom)
  }
  return zooms
}

function rejectUnreadableVersion(document: Record<string, unknown>): void {
  const version = document.version
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    fail('version', 'must be a whole number, 1 or higher')
  }
  if (version > PROJECT_VERSION) {
    throw new FormatError(
      `This project was saved by a newer version of the editor (format ${version}); this version reads format ${PROJECT_VERSION}.`,
    )
  }
}

function parseDocument(document: unknown, kind: DocumentKind): Project {
  if (!isRecord(document)) fail(`The ${kind}`, 'must be a JSON object')
  rejectUnreadableVersion(document)
  if (kind === 'animation' && 'camera' in document) fail('camera', 'is not allowed: an animation has no camera')

  const fields = readFields(document, kind, ['version', 'canvas', 'media', 'tracks'], kind === 'project' ? ['camera'] : [])
  const media: MediaRef[] = []
  for (const [index, entry] of fields.array('media').entries()) {
    media.push(parseMedia(entry, `media[${index}]`))
  }
  rejectDuplicateIds(media, 'media')

  const context: ParseContext = { kind, mediaIds: new Set(media.map((entry) => entry.id)), clipIds: new Set(), depth: 0, shift: 0 }
  const tracks = parseTracks(fields.array('tracks'), 'tracks', context)

  const project: Project = {
    version: PROJECT_VERSION,
    canvas: parseCanvas(fields.raw('canvas'), 'canvas', kind),
    media,
    tracks,
  }
  if (fields.has('camera')) project.camera = parseCamera(fields.raw('camera'), 'camera')
  return project
}

export function parseProject(text: string, kind: DocumentKind = 'project'): ParseResult {
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { ok: false, message: `The ${kind} file is not valid JSON: ${detail}` }
  }

  try {
    return { ok: true, project: parseDocument(document, kind) }
  } catch (error) {
    if (error instanceof FormatError) return { ok: false, message: error.message }
    throw error
  }
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (!isRecord(value)) return value
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) sorted[key] = sortKeys(value[key])
  }
  return sorted
}

export function serializeProject(project: Project): string {
  return `${JSON.stringify(sortKeys(project), null, 2)}\n`
}

export function projectDuration(project: Project): number {
  let end = 0
  for (const track of project.tracks) {
    for (const clip of track.clips) end = Math.max(end, clip.start + clip.duration)
  }
  return end
}
