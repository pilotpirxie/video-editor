import type { MediaStates } from '../src/engine/resolve.js'
import type { MediaInfo, VideoInfo } from '../src/shared/mediaProtocol.js'
import { parseProject, serializeProject, type AudioClip, type Clip, type GroupClip, type MediaRef, type Project, type TextClip, type Track, type VideoClip } from '../src/shared/project.js'

export const SECOND = 24_000_000
export const FRAME = SECOND / 30

export function videoClip(id: string, start: number, duration: number, settings: Partial<VideoClip> = {}): VideoClip {
  return {
    id,
    type: 'video',
    mediaId: 'video',
    start,
    duration,
    sourceStart: 0,
    speedPercent: 100,
    transform: { x: 960, y: 540, scaleX: 1, scaleY: 1, rotation: 0 },
    opacity: 1,
    volume: 1,
    ...settings,
  }
}

export function audioClip(id: string, start: number, duration: number, settings: Partial<AudioClip> = {}): AudioClip {
  return { id, type: 'audio', mediaId: 'music', start, duration, sourceStart: 0, speedPercent: 100, volume: 1, ...settings }
}

export function textClip(id: string, start: number, duration: number, settings: Partial<TextClip> = {}): TextClip {
  return {
    id,
    type: 'text',
    start,
    duration,
    transform: { x: 960, y: 540, scaleX: 1, scaleY: 1, rotation: 0 },
    opacity: 1,
    text: 'Title',
    font: { family: 'Helvetica Neue', size: 48 },
    color: '#ffffff',
    align: 'center',
    ...settings,
  }
}

// A group around the given tracks, the lowest first, placed so that it changes nothing about its members.
export function groupClip(id: string, start: number, duration: number, tracks: Clip[][], settings: Partial<GroupClip> = {}): GroupClip {
  return {
    id,
    type: 'group',
    start,
    duration,
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
    opacity: 1,
    volume: 1,
    tracks: tracks.map((clips, index) => track(`track-${index + 1}`, clips)),
    ...settings,
  }
}

export function track(id: string, clips: Clip[], settings: Partial<Track> = {}): Track {
  return { id, name: id, hidden: false, locked: false, muted: false, clips, ...settings }
}

export const SAMPLE_MEDIA: MediaRef[] = [
  { id: 'video', path: '/footage/video.mp4', relativePath: '' },
  { id: 'music', path: '/footage/music.mp3', relativePath: '' },
  { id: 'logo', path: '/footage/logo.png', relativePath: '' },
]

// The sample media plus a video file with sound and an animated image; `MEDIA_STATES.talk` and `MEDIA_STATES.sticker` describe them.
export const ALL_MEDIA: MediaRef[] = [...SAMPLE_MEDIA, { id: 'talk', path: '/footage/talk.mp4', relativePath: '' }, { id: 'sticker', path: '/footage/sticker.gif', relativePath: '' }]

export function projectOf(tracks: Track[], media: MediaRef[] = SAMPLE_MEDIA): Project {
  return { version: 1, canvas: { width: 1920, height: 1080, frameRate: { num: 30, den: 1 } }, media, tracks }
}

// What the project looks like after a save and a reopen. Throws when a command produced something the format rejects.
export function reopened(project: Project): Project {
  const parsed = parseProject(serializeProject(project))
  if (!parsed.ok) throw new Error(`The project is not valid: ${parsed.message}`)
  return parsed.project
}

export function clipIds(project: Project): string[][] {
  return project.tracks.map((entry) => entry.clips.map((clip) => clip.id))
}

export function clipOf(project: Project, id: string): Clip {
  for (const entry of project.tracks) {
    const found = entry.clips.find((clip) => clip.id === id)
    if (found !== undefined) return found
  }
  throw new Error(`There is no clip "${id}"`)
}

export const VIDEO_INFO: VideoInfo = {
  width: 1920,
  height: 1080,
  frameDuration: FRAME,
  frameCount: 300,
  startOffset: 0,
  seekPreroll: 0,
  isVariableFrameRate: false,
  hasAlpha: false,
  colorMatrix: 'bt709',
  colorRange: 'tv',
  transfer: 'sdr',
  codec: 'h264',
}

export const VIDEO_MEDIA: Extract<MediaInfo, { kind: 'video' }> = { kind: 'video', duration: 10 * SECOND, containerStart: 0, video: VIDEO_INFO }

// An animated image: twelve pictures at ten a second.
export const STICKER_MEDIA: Extract<MediaInfo, { kind: 'video' }> = {
  kind: 'video',
  duration: 1.2 * SECOND,
  containerStart: 0,
  video: { ...VIDEO_INFO, width: 160, height: 90, frameDuration: SECOND / 10, frameCount: 12, codec: 'gif' },
  isAnimatedImage: true,
}

export const MEDIA_STATES: MediaStates = {
  video: { info: VIDEO_MEDIA },
  talk: { info: { ...VIDEO_MEDIA, audio: { channels: 2, sampleRate: 48_000, codec: 'aac', seeksExactly: true } } },
  sticker: { info: STICKER_MEDIA },
  music: { info: { kind: 'audio', duration: 60 * SECOND, containerStart: 0, audio: { channels: 2, sampleRate: 48_000, codec: 'mp3', seeksExactly: false } } },
  logo: { info: { kind: 'image', width: 400, height: 200, hasAlpha: true } },
}
