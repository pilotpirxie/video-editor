import {
  MAX_SPEED_PERCENT,
  MIN_SPEED_PERCENT,
  TIMELINE_GRID,
  isOnTimelineGrid,
  isProjectFrameRate,
  type FrameRate,
} from './time.js'

const PROJECT_VERSION = 1

export type Easing = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | 'hold'

export type Keyframe = {
  time: number
  value: number
  easing: Easing
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

type VisualSettings = {
  transform: Transform
  opacity: number
  fadeIn?: number
  fadeOut?: number
}

type SourceSettings = {
  mediaId: string
  sourceStart: number
  speedPercent: number
}

type VolumeSettings = {
  volume: number
  volumeFadeIn?: number
  volumeFadeOut?: number
}

export type VideoClip = ClipTiming &
  VisualSettings &
  SourceSettings &
  VolumeSettings & {
    type: 'video'
    crop?: Crop
  }

export type AudioClip = ClipTiming &
  SourceSettings &
  VolumeSettings & {
    type: 'audio'
  }

type ImageClip = ClipTiming &
  VisualSettings & {
    type: 'image'
    mediaId: string
    crop?: Crop
  }

export type TextAlign = 'left' | 'center' | 'right'

type TextClip = ClipTiming &
  VisualSettings & {
    type: 'text'
    text: string
    font: { family: string; size: number }
    color: string
    align: TextAlign
  }

export type Clip = VideoClip | AudioClip | ImageClip | TextClip
export type VisualClip = VideoClip | ImageClip | TextClip

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

export type Project = {
  version: typeof PROJECT_VERSION
  canvas: Canvas
  media: MediaRef[]
  tracks: Track[]
}

export type ParseResult = { ok: true; project: Project } | { ok: false; message: string }

const MIN_CANVAS = { width: 160, height: 120 }
const MAX_CANVAS = { width: 3840, height: 2160 }
const MAX_VOLUME = 2

const EASINGS: readonly Easing[] = ['linear', 'easeIn', 'easeOut', 'easeInOut', 'hold']
const TRANSFORM_PROPERTIES: readonly AnimatableProperty[] = ['x', 'y', 'scaleX', 'scaleY', 'rotation', 'opacity']
const CROP_PROPERTIES: readonly AnimatableProperty[] = ['cropLeft', 'cropTop', 'cropRight', 'cropBottom']
const TEXT_ALIGNMENTS: readonly TextAlign[] = ['left', 'center', 'right']
const CLIP_TYPES = ['video', 'audio', 'image', 'text']
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/

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
    const value = this.record[key]
    const sign = kind === 'positive' ? 'positive' : 'non-negative'
    const problem = `must be a ${sign} multiple of ${TIMELINE_GRID}`
    if (typeof value !== 'number' || !isOnTimelineGrid(value)) fail(this.at(key), problem)
    const minimum = kind === 'positive' ? TIMELINE_GRID : 0
    if (value < minimum) fail(this.at(key), problem)
    return value
  }

  array(key: string): unknown[] {
    const value = this.record[key]
    if (!Array.isArray(value)) fail(this.at(key), 'must be a list')
    return value
  }
}

function parseFrameRate(value: unknown, path: string): FrameRate {
  const fields = readFields(value, path, ['num', 'den'])
  const rate = { num: fields.integer('num', { min: 1 }), den: fields.integer('den', { min: 1 }) }
  if (!isProjectFrameRate(rate)) fail(path, 'must be 24000/1001, 24, 25, 30000/1001, 30, 50 or 60 frames per second')
  return rate
}

function parseCanvas(value: unknown, path: string): Canvas {
  const fields = readFields(value, path, ['width', 'height', 'frameRate'])
  return {
    width: fields.integer('width', { min: MIN_CANVAS.width, max: MAX_CANVAS.width }),
    height: fields.integer('height', { min: MIN_CANVAS.height, max: MAX_CANVAS.height }),
    frameRate: parseFrameRate(fields.raw('frameRate'), fields.at('frameRate')),
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

function parseKeyframeList(value: unknown, path: string, property: AnimatableProperty, clipDuration: number): Keyframe[] {
  if (!Array.isArray(value) || value.length === 0) fail(path, 'must be a list with at least one keyframe')

  const keyframes: Keyframe[] = []
  let previousTime = -1
  for (const [index, entry] of value.entries()) {
    const fields = readFields(entry, `${path}[${index}]`, ['time', 'value', 'easing'])
    const keyframe: Keyframe = {
      time: fields.gridTime('time', 'zero or more'),
      value: fields.number('value', valueRule(property)),
      easing: fields.oneOf('easing', EASINGS),
    }
    if (keyframe.time > clipDuration) fail(fields.at('time'), 'is after the end of the clip')
    if (keyframe.time <= previousTime) fail(fields.at('time'), 'must be later than the previous keyframe')
    previousTime = keyframe.time
    keyframes.push(keyframe)
  }
  return keyframes
}

function parseKeyframes(value: unknown, path: string, allowed: readonly AnimatableProperty[], clipDuration: number): Keyframes {
  const fields = readFields(value, path, [], allowed)
  const keyframes: Keyframes = {}
  for (const property of allowed) {
    if (!fields.has(property)) continue
    keyframes[property] = parseKeyframeList(fields.raw(property), fields.at(property), property, clipDuration)
  }
  if (Object.keys(keyframes).length === 0) fail(path, 'is empty; leave it out instead')
  return keyframes
}

function parseFade(fields: Fields, key: string, clipDuration: number): number {
  const fade = fields.gridTime(key, 'positive')
  if (fade > clipDuration) fail(fields.at(key), 'is longer than the clip')
  return fade
}

const TIMING_KEYS = ['id', 'type', 'start', 'duration']
const VISUAL_KEYS = ['transform', 'opacity']
const SOURCE_KEYS = ['mediaId', 'sourceStart', 'speedPercent']
const OPTIONAL_VISUAL_KEYS = ['fadeIn', 'fadeOut', 'keyframes']
const OPTIONAL_VOLUME_KEYS = ['volumeFadeIn', 'volumeFadeOut']

type ParseContext = {
  mediaIds: ReadonlySet<string>
  clipIds: Set<string>
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
  if (fields.has('keyframes')) {
    timing.keyframes = parseKeyframes(fields.raw('keyframes'), fields.at('keyframes'), animatable, timing.duration)
  }
  return timing
}

function parseVisual(fields: Fields, clipDuration: number): VisualSettings {
  const visual: VisualSettings = {
    transform: parseTransform(fields.raw('transform'), fields.at('transform')),
    opacity: fields.number('opacity', { min: 0, max: 1 }),
  }
  if (fields.has('fadeIn')) visual.fadeIn = parseFade(fields, 'fadeIn', clipDuration)
  if (fields.has('fadeOut')) visual.fadeOut = parseFade(fields, 'fadeOut', clipDuration)
  return visual
}

function parseMediaId(fields: Fields, context: ParseContext): string {
  const mediaId = fields.string('mediaId')
  if (!context.mediaIds.has(mediaId)) fail(fields.at('mediaId'), `"${mediaId}" is not in the media list`)
  return mediaId
}

function parseSource(fields: Fields, context: ParseContext): SourceSettings {
  return {
    mediaId: parseMediaId(fields, context),
    sourceStart: fields.integer('sourceStart', { min: 0 }),
    speedPercent: fields.integer('speedPercent', { min: MIN_SPEED_PERCENT, max: MAX_SPEED_PERCENT }),
  }
}

function parseVolume(fields: Fields, clipDuration: number): VolumeSettings {
  const settings: VolumeSettings = { volume: fields.number('volume', { min: 0, max: MAX_VOLUME }) }
  if (fields.has('volumeFadeIn')) settings.volumeFadeIn = parseFade(fields, 'volumeFadeIn', clipDuration)
  if (fields.has('volumeFadeOut')) settings.volumeFadeOut = parseFade(fields, 'volumeFadeOut', clipDuration)
  return settings
}

function parseVideoClip(value: unknown, path: string, context: ParseContext): VideoClip {
  const fields = readFields(
    value,
    path,
    [...TIMING_KEYS, ...VISUAL_KEYS, ...SOURCE_KEYS, 'volume'],
    [...OPTIONAL_VISUAL_KEYS, ...OPTIONAL_VOLUME_KEYS, 'crop'],
  )
  const timing = parseTiming(fields, context, [...TRANSFORM_PROPERTIES, ...CROP_PROPERTIES, 'volume'])
  const clip: VideoClip = {
    type: 'video',
    ...timing,
    ...parseVisual(fields, timing.duration),
    ...parseSource(fields, context),
    ...parseVolume(fields, timing.duration),
  }
  if (fields.has('crop')) clip.crop = parseCrop(fields.raw('crop'), fields.at('crop'))
  return clip
}

function parseAudioClip(value: unknown, path: string, context: ParseContext): AudioClip {
  const fields = readFields(value, path, [...TIMING_KEYS, ...SOURCE_KEYS, 'volume'], [...OPTIONAL_VOLUME_KEYS, 'keyframes'])
  const timing = parseTiming(fields, context, ['volume'])
  return { type: 'audio', ...timing, ...parseSource(fields, context), ...parseVolume(fields, timing.duration) }
}

function parseImageClip(value: unknown, path: string, context: ParseContext): ImageClip {
  const fields = readFields(value, path, [...TIMING_KEYS, ...VISUAL_KEYS, 'mediaId'], [...OPTIONAL_VISUAL_KEYS, 'crop'])
  const timing = parseTiming(fields, context, [...TRANSFORM_PROPERTIES, ...CROP_PROPERTIES])
  const clip: ImageClip = {
    type: 'image',
    ...timing,
    ...parseVisual(fields, timing.duration),
    mediaId: parseMediaId(fields, context),
  }
  if (fields.has('crop')) clip.crop = parseCrop(fields.raw('crop'), fields.at('crop'))
  return clip
}

function parseTextClip(value: unknown, path: string, context: ParseContext): TextClip {
  const fields = readFields(value, path, [...TIMING_KEYS, ...VISUAL_KEYS, 'text', 'font', 'color', 'align'], OPTIONAL_VISUAL_KEYS)
  const timing = parseTiming(fields, context, TRANSFORM_PROPERTIES)
  const font = readFields(fields.raw('font'), fields.at('font'), ['family', 'size'])
  const color = fields.string('color')
  if (!COLOR_PATTERN.test(color)) fail(fields.at('color'), 'must look like #RRGGBB or #RRGGBBAA')
  return {
    type: 'text',
    ...timing,
    ...parseVisual(fields, timing.duration),
    text: fields.nonEmptyString('text'),
    font: { family: font.nonEmptyString('family'), size: font.number('size', { above: 0 }) },
    color,
    align: fields.oneOf('align', TEXT_ALIGNMENTS),
  }
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

function parseDocument(document: unknown): Project {
  if (!isRecord(document)) fail('The project', 'must be a JSON object')
  rejectUnreadableVersion(document)

  const fields = readFields(document, 'project', ['version', 'canvas', 'media', 'tracks'])
  const media: MediaRef[] = []
  for (const [index, entry] of fields.array('media').entries()) {
    media.push(parseMedia(entry, `media[${index}]`))
  }
  rejectDuplicateIds(media, 'media')

  const context: ParseContext = { mediaIds: new Set(media.map((entry) => entry.id)), clipIds: new Set() }
  const tracks: Track[] = []
  for (const [index, track] of fields.array('tracks').entries()) {
    tracks.push(parseTrack(track, `tracks[${index}]`, context))
  }
  rejectDuplicateIds(tracks, 'tracks')

  return {
    version: PROJECT_VERSION,
    canvas: parseCanvas(fields.raw('canvas'), 'canvas'),
    media,
    tracks,
  }
}

export function parseProject(text: string): ParseResult {
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { ok: false, message: `The project file is not valid JSON: ${detail}` }
  }

  try {
    return { ok: true, project: parseDocument(document) }
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
