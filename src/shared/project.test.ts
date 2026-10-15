import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseProject, projectDuration, serializeProject, type Project } from './project.js'

const SECOND = 24_000_000

function sampleProject(): Project {
  return {
    version: 1,
    canvas: { width: 1920, height: 1080, frameRate: { num: 30, den: 1 } },
    camera: [
      { time: 2 * SECOND, duration: SECOND, easing: 'easeInOut', x: 480, y: 270, scale: 2 },
      { time: 4 * SECOND, duration: SECOND / 2, easing: 'hold', x: 960, y: 540, scale: 1 },
    ],
    media: [
      { id: 'm-video', path: '/media/clip.mp4', relativePath: 'media/clip.mp4' },
      { id: 'm-music', path: '', relativePath: 'media/music.mp3' },
      { id: 'm-logo', path: '/media/logo.png', relativePath: '' },
    ],
    tracks: [
      {
        id: 't1',
        name: 'Footage',
        hidden: false,
        locked: false,
        muted: false,
        clips: [
          {
            id: 'c-video',
            type: 'video',
            mediaId: 'm-video',
            start: 0,
            duration: 5 * SECOND,
            sourceStart: 12_345,
            speedPercent: 150,
            transform: { x: 960, y: 540, scaleX: 1, scaleY: 1, rotation: 0 },
            opacity: 1,
            fadeIn: SECOND,
            transitionOut: { type: 'wipeLeft', duration: SECOND },
            volume: 0.8,
            volumeFadeOut: SECOND / 2,
            crop: { left: 10, top: 0, right: 0, bottom: 4.5 },
            effects: [
              { type: 'colorAdjust', brightness: 0.1, contrast: -0.2, saturation: 0.5 },
              { type: 'chromaKey', color: '#00B140', tolerance: 0.4, softness: 0.1, spill: 0.5, isOff: true },
              { type: 'roundedCorners', radius: 24 },
              { type: 'border', width: 4, color: '#FFFFFF' },
              { type: 'clipBlur', strength: 6 },
              { type: 'dropShadow', offsetX: 8, offsetY: -8, softness: 12, color: '#000000', opacity: 0.5 },
              { type: 'blackAndWhite', amount: 1 },
              {
                type: 'look',
                strength: 0.8,
                exposure: -0.5,
                contrast: 0.15,
                highlights: -0.15,
                shadows: 0.2,
                temperature: 0.3,
                tint: -0.1,
                saturation: -0.1,
                fade: 0.2,
                shadowColor: '#1F6F8B',
                shadowAmount: 0.35,
                highlightColor: '#F2A35E',
                highlightAmount: 0.3,
              },
              { type: 'sharpen', amount: 1.5, radius: 1.5 },
              { type: 'blurFill', strength: 40, darken: 0.3 },
            ],
            keyframes: {
              x: [
                { time: 0, value: 100, easing: 'easeInOut' },
                { time: 2 * SECOND, value: 960, easing: 'linear' },
              ],
              volume: [{ time: SECOND, value: 0.25, easing: 'hold' }],
            },
          },
          {
            id: 'c-image',
            type: 'image',
            mediaId: 'm-logo',
            start: 6 * SECOND,
            duration: 5 * SECOND,
            transform: { x: 200, y: 200, scaleX: 0.5, scaleY: 0.5, rotation: 15 },
            opacity: 0.75,
            transitionIn: { type: 'crossDissolve', duration: SECOND },
          },
        ],
      },
      {
        id: 't2',
        name: 'Titles and music',
        hidden: false,
        locked: true,
        muted: false,
        clips: [
          {
            id: 'c-text',
            type: 'text',
            start: SECOND,
            duration: 3 * SECOND,
            text: 'Hello 你好 👋',
            font: { family: 'Helvetica Neue', size: 96 },
            color: '#FFFFFF',
            align: 'center',
            transform: { x: 960, y: 900, scaleX: 1, scaleY: 1, rotation: 0 },
            opacity: 1,
            fadeOut: SECOND,
          },
          {
            id: 'c-music',
            type: 'audio',
            mediaId: 'm-music',
            start: 4 * SECOND,
            duration: 10 * SECOND,
            sourceStart: 0,
            speedPercent: 100,
            volume: 0.5,
          },
        ],
      },
      {
        id: 't3',
        name: 'Marks',
        hidden: false,
        locked: false,
        muted: false,
        clips: [
          {
            id: 'c-blur',
            type: 'blur',
            start: 0,
            duration: 2 * SECOND,
            transform: { x: 400, y: 300, scaleX: 1, scaleY: 1, rotation: 0 },
            opacity: 1,
            width: 320,
            height: 80,
            shape: 'rectangle',
            softEdge: 0,
            strength: 20,
            isPixelated: true,
          },
          {
            id: 'c-highlight',
            type: 'highlight',
            start: 2 * SECOND,
            duration: 2 * SECOND,
            transform: { x: 960, y: 540, scaleX: 1, scaleY: 1, rotation: 0 },
            opacity: 0.8,
            fadeOut: SECOND / 2,
            width: 300,
            height: 300,
            shape: 'ellipse',
            softEdge: 12,
            color: '#4D4D4D',
            isSpotlight: true,
            keyframes: { x: [{ time: 0, value: 900, easing: 'linear' }] },
          },
        ],
      },
      {
        id: 't4',
        name: 'Notes',
        hidden: false,
        locked: false,
        muted: false,
        clips: [
          {
            id: 'c-callout',
            type: 'callout',
            start: 0,
            duration: 2 * SECOND,
            transform: { x: 600, y: 400, scaleX: 1, scaleY: 1, rotation: 0 },
            opacity: 1,
            animationIn: { type: 'pop', duration: SECOND / 2 },
            width: 400,
            height: 200,
            shape: 'speechBubble',
            fill: '#FFFFFFE6',
            borderColor: '#14171D',
            borderWidth: 6,
            tail: { x: -260, y: 180 },
            text: 'Click here',
            font: { family: 'Helvetica Neue', size: 48, weight: 700 },
            color: '#14171D',
            align: 'center',
            lineSpacing: 1.2,
          },
          {
            id: 'c-arrow',
            type: 'arrow',
            start: 2 * SECOND,
            duration: 2 * SECOND,
            transform: { x: 900, y: 500, scaleX: 1, scaleY: 1, rotation: -30 },
            opacity: 1,
            animationOut: { type: 'slideLeft', duration: SECOND },
            length: 300,
            thickness: 12,
            color: '#E5484D',
            startHead: 'dot',
            endHead: 'triangle',
            effects: [{ type: 'dropShadow', offsetX: 4, offsetY: 4, softness: 6, color: '#000000', opacity: 0.5 }],
          },
          {
            id: 'c-group',
            type: 'group',
            start: 5 * SECOND,
            duration: 4 * SECOND,
            contentStart: SECOND,
            transform: { x: 960, y: 540, scaleX: 0.5, scaleY: 0.5, rotation: 10 },
            opacity: 0.9,
            fadeIn: SECOND,
            volume: 0.5,
            volumeFadeOut: SECOND,
            animationIn: { type: 'zoom', duration: SECOND },
            keyframes: {
              scaleX: [{ time: 0, value: 0.5, easing: 'linear' }],
              scaleY: [{ time: 0, value: 0.5, easing: 'linear' }],
              volume: [{ time: 0, value: 1, easing: 'linear' }],
            },
            effects: [{ type: 'blackAndWhite', amount: 1 }],
            tracks: [
              {
                id: 'g1',
                name: 'Track 1',
                hidden: false,
                locked: false,
                muted: false,
                clips: [
                  {
                    id: 'c-voice',
                    type: 'audio',
                    mediaId: 'm-music',
                    start: 0,
                    duration: 3 * SECOND,
                    sourceStart: 0,
                    speedPercent: 800,
                    changesPitch: true,
                    hasFastSound: true,
                    volume: 1,
                  },
                ],
              },
              {
                id: 'g2',
                name: 'Track 2',
                hidden: false,
                locked: false,
                muted: false,
                clips: [
                  {
                    id: 'c-styled',
                    type: 'text',
                    start: SECOND,
                    duration: 4 * SECOND,
                    transform: { x: 0, y: -120, scaleX: 1, scaleY: 1, rotation: 0 },
                    opacity: 1,
                    animationIn: { type: 'typewriter', duration: 2 * SECOND },
                    text: 'Wrapped and styled words',
                    font: { family: 'Helvetica Neue', size: 64, weight: 300 },
                    color: '#FFFFFF',
                    align: 'left',
                    outline: { color: '#000000', width: 3 },
                    shadow: { color: '#00000080', offsetX: 4, offsetY: 6, blur: 8 },
                    background: { color: '#14171DCC' },
                    lineSpacing: 0.9,
                    boxWidth: 420,
                  },
                  {
                    id: 'c-inner-group',
                    type: 'group',
                    start: 5 * SECOND,
                    duration: SECOND,
                    transform: { x: 100, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
                    opacity: 1,
                    volume: 1,
                    tracks: [],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  }
}

type JsonHolder = Record<string, unknown> | unknown[]

function isHolder(value: unknown): value is JsonHolder {
  return typeof value === 'object' && value !== null
}

function childOf(holder: JsonHolder, key: string): unknown {
  return Array.isArray(holder) ? holder[Number(key)] : holder[key]
}

function editedAt(path: string, edit: (holder: JsonHolder, key: string) => void): string {
  const document: unknown = JSON.parse(JSON.stringify(sampleProject()))
  const keys = path.split('.')
  const lastKey = keys.pop()
  let holder = document
  for (const key of keys) {
    if (!isHolder(holder)) throw new Error(`Test path ${path} does not exist in the sample project`)
    holder = childOf(holder, key)
  }
  if (!isHolder(holder) || lastKey === undefined) throw new Error(`Test path ${path} does not exist in the sample project`)
  edit(holder, lastKey)
  return JSON.stringify(document)
}

function withValue(path: string, value: unknown): string {
  return editedAt(path, (holder, key) => {
    if (Array.isArray(holder)) holder[Number(key)] = value
    else holder[key] = value
  })
}

function without(path: string): string {
  return editedAt(path, (holder, key) => {
    if (!Array.isArray(holder)) delete holder[key]
  })
}

// The latest time on the timeline grid that is still an exact whole number.
const LATEST_GRID_TIME = Math.floor(Number.MAX_SAFE_INTEGER / 100) * 100

// A member of the group that ends just inside exact time on its own track, and so past it on the timeline, where the group moves it later.
function memberEndingPastExactTime(): string {
  return editedAt('tracks.3.clips.2.tracks.0.clips.0', (holder, key) => {
    const member = childOf(holder, key)
    if (!isRecord(member) || typeof member.duration !== 'number') throw new Error('The sample group has no member with a duration')
    member.start = LATEST_GRID_TIME - 100 - member.duration
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function messageFor(text: string): string {
  const result = parseProject(text)
  if (result.ok) throw new Error('expected the project to be rejected')
  return result.message
}

function nestedGroups(depth: number): unknown {
  const clips = depth === 0 ? [] : [nestedGroups(depth - 1)]
  const group = { id: `group-${depth}`, type: 'group', start: 0, duration: SECOND, transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 }, opacity: 1, volume: 1 }
  return { ...group, tracks: [{ id: 't', name: '', hidden: false, locked: false, muted: false, clips }] }
}

describe('groups', () => {
  it('may hold groups, eight deep, and no deeper', () => {
    const eightDeep = withValue('tracks.3.clips', [nestedGroups(7)])
    expect(parseProject(eightDeep).ok).toBe(true)
    expect(messageFor(withValue('tracks.3.clips', [nestedGroups(8)]))).toMatch(/is a group inside more than 8 groups$/)
  })

  it('does not count the clips inside a group toward the length of the project', () => {
    const lone = JSON.parse(withValue('tracks', [{ id: 't', name: '', hidden: false, locked: false, muted: false, clips: [sampleProject().tracks[3]?.clips[2]] }]))
    const parsed = parseProject(JSON.stringify(lone))
    expect(parsed.ok && projectDuration(parsed.project)).toBe(9 * SECOND)
  })
})

describe('serializeProject', () => {
  it('sorts keys at every level and ends with a newline', () => {
    const text = serializeProject(sampleProject())
    expect(text.endsWith('}\n')).toBe(true)
    const topLevelKeys: string[] = []
    for (const match of text.matchAll(/^ {2}"(?<key>\w+)":/gm)) {
      topLevelKeys.push(match.groups?.key ?? '')
    }
    expect(topLevelKeys).toEqual(['camera', 'canvas', 'media', 'tracks', 'version'])
    expect(text.indexOf('"den"')).toBeLessThan(text.indexOf('"num"'))
    expect(text.indexOf('"family"')).toBeLessThan(text.indexOf('"size"'))
  })

  it('does not depend on the order keys were set in', () => {
    const reversed = JSON.parse(JSON.stringify(sampleProject()), (_key, value) => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
      return Object.fromEntries(Object.entries(value).reverse())
    })
    expect(serializeProject(reversed)).toBe(serializeProject(sampleProject()))
  })
})

describe('parseProject', () => {
  it('load then save is byte-identical', () => {
    const saved = serializeProject(sampleProject())
    const loaded = parseProject(saved)
    expect(loaded.ok).toBe(true)
    if (!loaded.ok) return
    expect(loaded.project).toEqual(sampleProject())
    expect(serializeProject(loaded.project)).toBe(saved)
  })

  it('load then save is byte-identical for every reference project', () => {
    const directory = join(import.meta.dirname, '..', '..', 'test', 'projects')
    const files = readdirSync(directory).filter((name) => name.endsWith('.json'))
    for (const name of files) {
      const saved = readFileSync(join(directory, name), 'utf8')
      const loaded = parseProject(saved)
      if (!loaded.ok) throw new Error(`${name}: ${loaded.message}`)
      expect(serializeProject(loaded.project), name).toBe(saved)
    }
  })

  it('accepts keyframes before the clip start and after its end, as a trim or split leaves them', () => {
    const outside = [
      { time: -SECOND, value: 100, easing: 'easeInOut' },
      { time: 9 * SECOND, value: 960, easing: 'linear' },
    ]
    const loaded = parseProject(withValue('tracks.0.clips.0.keyframes.x', outside))
    expect(loaded.ok).toBe(true)
  })

  it.each(['isAudioSeparated', 'loop'])('keeps the %s switch of a video clip, and accepts it only when on', (key) => {
    const switchedOn = withValue(`tracks.0.clips.0.${key}`, true)
    const parsed = parseProject(switchedOn)
    expect(parsed.ok && parsed.project.tracks[0]?.clips[0]).toMatchObject({ [key]: true })
    expect(parsed.ok && parseProject(serializeProject(parsed.project))).toEqual(parsed)

    expect(messageFor(withValue(`tracks.0.clips.0.${key}`, false))).toContain(`tracks[0].clips[0].${key} must be true or left out`)
    expect(messageFor(withValue(`tracks.0.clips.0.${key}`, 'yes'))).toContain(`${key} must be true or false`)
    expect(messageFor(withValue(`tracks.0.clips.1.${key}`, true))).toContain(key)
  })

  it('accepts a transition that is longer than its clip, as a trim or a split may leave it', () => {
    expect(parseProject(withValue('tracks.0.clips.1.transitionIn.duration', 20 * SECOND)).ok).toBe(true)
  })

  it('reports the project duration as the end of the last clip', () => {
    expect(projectDuration(sampleProject())).toBe(14 * SECOND)
  })

  it.each([
    ['text that is not JSON', '{ "version": 1,', /not valid JSON/],
    ['a JSON list', '[]', /must be a JSON object/],
    ['a missing version', without('version'), /^version must be a whole number/],
    ['a newer format', withValue('version', 2), /saved by a newer version of the editor \(format 2\)/],
    ['a missing section', without('canvas'), /^project\.canvas is missing$/],
    ['an unknown top-level key', withValue('subtitles', {}), /^project\.subtitles is not a known setting$/],
    ['a canvas that is too small', withValue('canvas.width', 100), /^canvas\.width must be at least 160$/],
    ['a canvas that is too large', withValue('canvas.height', 4320), /^canvas\.height must be at most 2160$/],
    ['an unsupported frame rate', withValue('canvas.frameRate', { num: 48, den: 1 }), /^canvas\.frameRate must be 24000\/1001/],
    ['media without any path', withValue('media.1.relativePath', ''), /^media\[1\] needs a path or a relativePath$/],
    ['duplicate media ids', withValue('media.1.id', 'm-video'), /^media uses the id "m-video" more than once$/],
    ['duplicate clip ids', withValue('tracks.1.clips.0.id', 'c-video'), /^tracks\[1\]\.clips\[0\]\.id "c-video" is used by more than one clip$/],
    ['a wrong type', withValue('tracks.0.hidden', 'no'), /^tracks\[0\]\.hidden must be true or false$/],
    ['an off-grid duration', withValue('tracks.0.clips.0.duration', 12_345), /^tracks\[0\]\.clips\[0\]\.duration must be a positive multiple of 100$/],
    ['a negative start', withValue('tracks.0.clips.0.start', -100), /^tracks\[0\]\.clips\[0\]\.start must be a non-negative multiple of 100$/],
    ['a fractional time', withValue('tracks.0.clips.0.start', 100.5), /start must be a non-negative multiple of 100$/],
    ['a speed below 1%', withValue('tracks.0.clips.0.speedPercent', 0), /speedPercent must be at least 1$/],
    ['a speed above 10000%', withValue('tracks.0.clips.0.speedPercent', 20_000), /speedPercent must be at most 10000$/],
    ['a fractional speed', withValue('tracks.0.clips.0.speedPercent', 150.5), /speedPercent must be a whole number$/],
    ['a clip that ends past exact time', withValue('tracks.0.clips.0.start', LATEST_GRID_TIME), /^tracks\[0\]\.clips\[0\]\.duration ends the clip too far along the timeline$/],
    ['a group member that ends past exact time on the timeline', memberEndingPastExactTime(), /^tracks\[3\]\.clips\[2\]\.tracks\[0\]\.clips\[0\]\.duration ends the clip too far along the timeline$/],
    ['a source read past exact time', withValue('tracks.0.clips.0.sourceStart', Number.MAX_SAFE_INTEGER - 1), /^tracks\[0\]\.clips\[0\]\.sourceStart reaches too far into the source$/],
    ['an unknown media reference', withValue('tracks.0.clips.0.mediaId', 'nope'), /mediaId "nope" is not in the media list$/],
    ['an unknown clip type', withValue('tracks.0.clips.0.type', 'sticker'), /^tracks\[0\]\.clips\[0\]\.type must be one of video, audio, image, text, blur, highlight, callout, arrow, group;/],
    ['an unknown clip setting', withValue('tracks.0.clips.1.volume', 1), /^tracks\[0\]\.clips\[1\]\.volume is not a known setting$/],
    ['overlapping clips', withValue('tracks.0.clips.1.start', 2 * SECOND), /^tracks\[0\]\.clips has overlapping clips "c-video" and "c-image"$/],
    ['an opacity above 1', withValue('tracks.0.clips.0.opacity', 1.5), /opacity must be at most 1$/],
    ['a volume above 200%', withValue('tracks.0.clips.0.volume', 3), /volume must be at most 2$/],
    ['a fade longer than the clip', withValue('tracks.0.clips.0.fadeIn', 6 * SECOND), /fadeIn is longer than the clip$/],
    ['a zero-length fade', withValue('tracks.0.clips.0.fadeIn', 0), /fadeIn must be a positive multiple of 100$/],
    ['a crop that removes nothing', withValue('tracks.0.clips.0.crop', { left: 0, top: 0, right: 0, bottom: 0 }), /crop crops nothing; leave it out instead$/],
    ['an empty keyframes object', withValue('tracks.0.clips.0.keyframes', {}), /keyframes is empty; leave it out instead$/],
    ['an empty keyframe list', withValue('tracks.0.clips.0.keyframes.x', []), /keyframes\.x must be a list with at least one keyframe$/],
    ['keyframes out of order', withValue('tracks.0.clips.0.keyframes.x.1.time', 0), /keyframes\.x\[1\]\.time must be later than the previous keyframe$/],
    ['a keyframe off the time grid', withValue('tracks.0.clips.0.keyframes.x.1.time', 2 * SECOND + 1), /keyframes\.x\[1\]\.time must be a multiple of 100$/],
    ['an unknown easing', withValue('tracks.0.clips.0.keyframes.x.0.easing', 'bounce'), /easing must be one of linear, easeIn, easeOut, easeInOut, hold$/],
    ['a property the clip type cannot animate', withValue('tracks.1.clips.0.keyframes', { volume: [] }), /^tracks\[1\]\.clips\[0\]\.keyframes\.volume is not a known setting$/],
    ['a bad colour', withValue('tracks.1.clips.0.color', 'white'), /color must look like #RRGGBB or #RRGGBBAA$/],
    ['a non-finite number', '{"version":1,"canvas":{"width":1e999,"height":1080,"frameRate":{"num":30,"den":1}},"media":[],"tracks":[]}', /^canvas\.width must be a number$/],
    ['a camera without zooms', withValue('camera', []), /^camera must be a list with at least one zoom; leave it out instead$/],
    ['zooms out of order', withValue('camera.1.time', 2 * SECOND), /^camera\[1\]\.time must be later than the zoom before it$/],
    ['a zoom smaller than the canvas', withValue('camera.0.scale', 0.5), /^camera\[0\]\.scale must be at least 1$/],
    ['a zoom larger than ten times', withValue('camera.0.scale', 11), /^camera\[0\]\.scale must be at most 10$/],
    ['a zoom whose move has no length', withValue('camera.0.duration', 0), /^camera\[0\]\.duration must be a positive multiple of 100$/],
    ['an unknown zoom setting', withValue('camera.0.rotation', 5), /^camera\[0\]\.rotation is not a known setting$/],
    ['an unknown transition', withValue('tracks.0.clips.1.transitionIn.type', 'sparkle'), /transitionIn\.type must be one of crossDissolve, fadeBlack, fadeWhite, wipeLeft/],
    ['a transition without a length', withValue('tracks.0.clips.1.transitionIn.duration', 0), /transitionIn\.duration must be a positive multiple of 100$/],
    ['a transition on an audio clip', withValue('tracks.1.clips.1.transitionIn', { type: 'slide', duration: SECOND }), /^tracks\[1\]\.clips\[1\]\.transitionIn is not a known setting$/],
    ['an empty list of effects', withValue('tracks.0.clips.0.effects', []), /effects must be a list with at least one effect; leave it out instead$/],
    ['an unknown effect', withValue('tracks.0.clips.0.effects.0.type', 'sparkle'), /effects\[0\]\.type must be one of colorAdjust, look, blackAndWhite, sepia, tint, invert, vignette, dropShadow, border, roundedCorners, clipBlur, sharpen, chromaKey, blurFill$/],
    ['the same effect twice', withValue('tracks.0.clips.0.effects.1', { type: 'colorAdjust', brightness: 0, contrast: 0, saturation: 0 }), /effects\[1\]\.type "colorAdjust" is used more than once on this clip$/],
    ['an effect amount out of range', withValue('tracks.0.clips.0.effects.0.contrast', 1.5), /effects\[0\]\.contrast must be at most 1$/],
    ['an effect setting of another effect', withValue('tracks.0.clips.0.effects.2.width', 3), /effects\[2\]\.width is not a known setting$/],
    ['an effect colour with transparency', withValue('tracks.0.clips.0.effects.3.color', '#FFFFFF80'), /effects\[3\]\.color must look like #RRGGBB$/],
    ['an effect that is switched on in words', withValue('tracks.0.clips.0.effects.0.isOff', false), /effects\[0\]\.isOff must be true or left out$/],
    ['a border without a width', withValue('tracks.0.clips.0.effects.3.width', 0), /effects\[3\]\.width must be greater than 0$/],
    ['a look exposure out of range', withValue('tracks.0.clips.0.effects.7.exposure', 2.5), /effects\[7\]\.exposure must be at most 2$/],
    ['a sharpen amount out of range', withValue('tracks.0.clips.0.effects.8.amount', 2.5), /effects\[8\]\.amount must be at most 2$/],
    ['a blur fill on an arrow', withValue('tracks.3.clips.1.effects', [{ type: 'blurFill', strength: 40, darken: 0.3 }]), /^tracks\[3\]\.clips\[1\]\.effects\[0\]\.type can only be "blurFill" on a video or image clip$/],
    ['a blur fill on a group', withValue('tracks.3.clips.2.effects', [{ type: 'blurFill', strength: 40, darken: 0.3 }]), /^tracks\[3\]\.clips\[2\]\.effects\[0\]\.type can only be "blurFill" on a video or image clip$/],
    ['effects on a blur clip', withValue('tracks.2.clips.0.effects', [{ type: 'blackAndWhite', amount: 1 }]), /^tracks\[2\]\.clips\[0\]\.effects is not a known setting$/],
    ['a blur without strength', withValue('tracks.2.clips.0.strength', 0), /^tracks\[2\]\.clips\[0\]\.strength must be greater than 0$/],
    ['a shape that is neither', withValue('tracks.2.clips.0.shape', 'star'), /^tracks\[2\]\.clips\[0\]\.shape must be one of rectangle, ellipse$/],
    ['a shape without a size', without('tracks.2.clips.1.width'), /^tracks\[2\]\.clips\[1\]\.width is missing$/],
    ['a negative soft edge', withValue('tracks.2.clips.1.softEdge', -1), /^tracks\[2\]\.clips\[1\]\.softEdge must be at least 0$/],
    ['a highlight colour with transparency', withValue('tracks.2.clips.1.color', '#FFE94D80'), /^tracks\[2\]\.clips\[1\]\.color must look like #RRGGBB$/],
    ['an unknown callout shape', withValue('tracks.3.clips.0.shape', 'cloud'), /^tracks\[3\]\.clips\[0\]\.shape must be one of rectangle, roundedBox, ellipse, speechBubble, thoughtBubble, arrowBox, banner, burst$/],
    ['a bubble without a tail', without('tracks.3.clips.0.tail'), /^tracks\[3\]\.clips\[0\]\.tail is needed by a speech bubble and a thought bubble, and by no other shape$/],
    ['a tail on a shape that has none', withValue('tracks.3.clips.0.shape', 'banner'), /^tracks\[3\]\.clips\[0\]\.tail is needed by a speech bubble/],
    ['a callout without a size', withValue('tracks.3.clips.0.width', 0), /^tracks\[3\]\.clips\[0\]\.width must be greater than 0$/],
    ['a negative border', withValue('tracks.3.clips.0.borderWidth', -1), /^tracks\[3\]\.clips\[0\]\.borderWidth must be at least 0$/],
    ['a font weight between the hundreds', withValue('tracks.3.clips.0.font.weight', 450), /^tracks\[3\]\.clips\[0\]\.font\.weight must be a whole hundred from 100 to 900$/],
    ['a font weight that is too heavy', withValue('tracks.3.clips.0.font.weight', 1000), /font\.weight must be at most 900$/],
    ['line spacing that puts lines on top of each other', withValue('tracks.3.clips.0.lineSpacing', 0.2), /^tracks\[3\]\.clips\[0\]\.lineSpacing must be at least 0\.5$/],
    ['a typewriter on a clip without letters to type', withValue('tracks.3.clips.0.animationIn.type', 'typewriter'), /^tracks\[3\]\.clips\[0\]\.animationIn\.type can only be "typewriter" on a text clip$/],
    ['an unknown animation', withValue('tracks.3.clips.0.animationIn.type', 'spin'), /animationIn\.type must be one of fade, pop, slideLeft, slideRight, slideUp, slideDown, zoom, typewriter$/],
    ['an animation without a length', withValue('tracks.3.clips.1.animationOut.duration', 0), /animationOut\.duration must be a positive multiple of 100$/],
    ['an animation on an audio clip', withValue('tracks.1.clips.1.animationIn', { type: 'fade', duration: SECOND }), /^tracks\[1\]\.clips\[1\]\.animationIn is not a known setting$/],
    ['an arrow without a length', withValue('tracks.3.clips.1.length', 0), /^tracks\[3\]\.clips\[1\]\.length must be greater than 0$/],
    ['an unknown arrow head', withValue('tracks.3.clips.1.endHead', 'heart'), /^tracks\[3\]\.clips\[1\]\.endHead must be one of none, triangle, open, dot$/],
    ['a group that is stretched', withValue('tracks.3.clips.2.transform.scaleY', 0.75), /^tracks\[3\]\.clips\[2\]\.transform of a group must have the same scaleX and scaleY, in its keyframes too$/],
    ['a group whose scale keyframes differ', withValue('tracks.3.clips.2.keyframes.scaleY.0.value', 0.75), /transform of a group must have the same scaleX and scaleY/],
    ['a group without tracks', without('tracks.3.clips.2.tracks'), /^tracks\[3\]\.clips\[2\]\.tracks is missing$/],
    ['a content start of nothing', withValue('tracks.3.clips.2.contentStart', 0), /contentStart must be a positive multiple of 100$/],
    ['a member with the id of another clip', withValue('tracks.3.clips.2.tracks.0.clips.0.id', 'c-video'), /^tracks\[3\]\.clips\[2\]\.tracks\[0\]\.clips\[0\]\.id "c-video" is used by more than one clip$/],
    ['two tracks of a group with the same id', withValue('tracks.3.clips.2.tracks.1.id', 'g1'), /^tracks\[3\]\.clips\[2\]\.tracks uses the id "g1" more than once$/],
    ['members that overlap', withValue('tracks.3.clips.2.tracks.1.clips.1.start', 2 * SECOND), /^tracks\[3\]\.clips\[2\]\.tracks\[1\]\.clips has overlapping clips/],
    ['an outline without a width', withValue('tracks.3.clips.2.tracks.1.clips.0.outline.width', 0), /outline\.width must be greater than 0$/],
    ['a shadow that is blurred backwards', withValue('tracks.3.clips.2.tracks.1.clips.0.shadow.blur', -1), /shadow\.blur must be at least 0$/],
    ['a text box without a width', withValue('tracks.3.clips.2.tracks.1.clips.0.boxWidth', 0), /boxWidth must be greater than 0$/],
    ['a background on a callout', withValue('tracks.3.clips.0.background', { color: '#000000' }), /^tracks\[3\]\.clips\[0\]\.background is not a known setting$/],
    ['a pitch switch that is off in words', withValue('tracks.3.clips.2.tracks.0.clips.0.changesPitch', false), /changesPitch must be true or left out$/],
  ])('rejects %s with a readable message', (_label, text, expected) => {
    expect(messageFor(text)).toMatch(expected)
  })
})
