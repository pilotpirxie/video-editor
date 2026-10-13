import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseProject, projectDuration, serializeProject, type Project } from './project.js'

const SECOND = 24_000_000

function sampleProject(): Project {
  return {
    version: 1,
    canvas: { width: 1920, height: 1080, frameRate: { num: 30, den: 1 } },
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
            volume: 0.8,
            volumeFadeOut: SECOND / 2,
            crop: { left: 10, top: 0, right: 0, bottom: 4.5 },
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

function messageFor(text: string): string {
  const result = parseProject(text)
  if (result.ok) throw new Error('expected the project to be rejected')
  return result.message
}

describe('serializeProject', () => {
  it('sorts keys at every level and ends with a newline', () => {
    const text = serializeProject(sampleProject())
    expect(text.endsWith('}\n')).toBe(true)
    const topLevelKeys: string[] = []
    for (const match of text.matchAll(/^ {2}"(?<key>\w+)":/gm)) {
      topLevelKeys.push(match.groups?.key ?? '')
    }
    expect(topLevelKeys).toEqual(['canvas', 'media', 'tracks', 'version'])
    expect(text.indexOf('"den"')).toBeLessThan(text.indexOf('"num"'))
    expect(text.indexOf('"align"')).toBeLessThan(text.indexOf('"color"'))
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

  it('reports the project duration as the end of the last clip', () => {
    expect(projectDuration(sampleProject())).toBe(14 * SECOND)
  })

  it.each([
    ['text that is not JSON', '{ "version": 1,', /not valid JSON/],
    ['a JSON list', '[]', /must be a JSON object/],
    ['a missing version', without('version'), /^version must be a whole number/],
    ['a newer format', withValue('version', 2), /saved by a newer version of the editor \(format 2\)/],
    ['a missing section', without('canvas'), /^project\.canvas is missing$/],
    ['an unknown top-level key', withValue('camera', {}), /^project\.camera is not a known setting$/],
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
    ['a speed below 25%', withValue('tracks.0.clips.0.speedPercent', 10), /speedPercent must be at least 25$/],
    ['a speed above 10000%', withValue('tracks.0.clips.0.speedPercent', 20_000), /speedPercent must be at most 10000$/],
    ['a fractional speed', withValue('tracks.0.clips.0.speedPercent', 150.5), /speedPercent must be a whole number$/],
    ['an unknown media reference', withValue('tracks.0.clips.0.mediaId', 'nope'), /mediaId "nope" is not in the media list$/],
    ['an unknown clip type', withValue('tracks.0.clips.0.type', 'blur'), /^tracks\[0\]\.clips\[0\]\.type must be one of video, audio, image, text/],
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
  ])('rejects %s with a readable message', (_label, text, expected) => {
    expect(messageFor(text)).toMatch(expected)
  })
})
