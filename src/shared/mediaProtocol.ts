import type { ExportPreset } from './exportPresets.js'
import type { Project } from './project.js'
import type { FrameRate } from './time.js'

export type VideoInfo = {
  /** Display size: rotation and pixel aspect ratio already applied. */
  width: number
  height: number
  frameDuration: number
  frameCount: number
  /** Ticks from the container start to the first frame. */
  startOffset: number
  /** How far before a frame decoding must begin to be sure of reaching that frame, in ticks. */
  seekPreroll: number
  isVariableFrameRate: boolean
  hasAlpha: boolean
  /** Decoder to force when the default one would drop the alpha channel. */
  alphaDecoder?: string
  colorMatrix: 'bt709' | 'bt601' | 'bt2020'
  colorRange: 'tv' | 'pc'
  isHdr: boolean
  codec: string
}

export type AudioInfo = {
  channels: number
  sampleRate: number
  codec: string
}

/** `containerStart` is the file's own first timestamp in ticks; source time 0 is that instant. */
export type MediaInfo =
  | { kind: 'video'; duration: number; containerStart: number; video: VideoInfo; audio?: AudioInfo }
  | { kind: 'audio'; duration: number; containerStart: number; audio: AudioInfo }
  | { kind: 'image'; width: number; height: number; hasAlpha: boolean; isAnimated: boolean }

/** A media failure affects only its own clips, so each entry succeeds or fails alone. */
export type MediaState = { info: MediaInfo } | { error: string }

export type LoadedProject = {
  project: Project
  media: Record<string, MediaState>
}

/** Premultiplied RGBA, 8 bits per channel, top row first. */
export type RawFrame = {
  width: number
  height: number
  data: ArrayBuffer
}

export type ExportTarget = {
  path: string
  width: number
  height: number
  frameRate: FrameRate
}

/** Everything the engine needs from the outside world. Implemented by the media process. */
export type MediaClient = {
  /**
   * Opens a project file. With `forPreview` its preview copies and audio are prepared in the
   * background; a render that only reads originals leaves that out.
   */
  loadProject(path: string, forPreview: boolean): Promise<LoadedProject>
  /** Resolves once the open project's preview copies and audio have been prepared (or failed). */
  whenPrepared(): Promise<void>
  /** The bytes of a still image file. */
  readImage(mediaId: string): Promise<ArrayBuffer>
  /** One JPEG from the preview copy, or undefined while that frame is not prepared. */
  previewFrame(mediaId: string, frame: number): Promise<ArrayBuffer | undefined>
  /** One frame decoded from the original file, halved `halvings` times. */
  fullFrame(mediaId: string, frame: number, halvings: number, signal?: AbortSignal): Promise<RawFrame>
  /** Opens a sequential decoder positioned at `frame`; resolves with its id. */
  openStream(mediaId: string, frame: number, halvings: number): Promise<number>
  streamFrame(streamId: number, frame: number): Promise<RawFrame>
  closeStream(streamId: number): Promise<void>
  /** Interleaved 48 kHz stereo samples, zero-padded outside the file; undefined when the media has no audio. */
  audio(mediaId: string, firstSample: number, sampleCount: number): Promise<Float32Array | undefined>
  exportStart(target: ExportTarget): Promise<number>
  /** Resolves once the encoder has taken the frame. */
  exportWrite(jobId: number, pixels: ArrayBuffer, audio: Float32Array): Promise<void>
  exportFinish(jobId: number): Promise<void>
  exportCancel(jobId: number): Promise<void>
  /** Writes `data` as the file `name` inside `directory`, creating the directory when needed. */
  writeFile(directory: string, name: string, data: ArrayBuffer): Promise<void>
}

/** One call to the media process, as it travels over the port. */
export type MediaRequest =
  | { method: 'loadProject'; path: string; forPreview: boolean }
  | { method: 'whenPrepared' }
  | { method: 'readImage'; mediaId: string }
  | { method: 'previewFrame'; mediaId: string; frame: number }
  | { method: 'fullFrame'; mediaId: string; frame: number; halvings: number }
  | { method: 'openStream'; mediaId: string; frame: number; halvings: number }
  | { method: 'streamFrame'; streamId: number; frame: number }
  | { method: 'closeStream'; streamId: number }
  | { method: 'audio'; mediaId: string; firstSample: number; sampleCount: number }
  | { method: 'exportStart'; target: ExportTarget }
  | { method: 'exportWrite'; jobId: number; pixels: ArrayBuffer; audio: Float32Array }
  | { method: 'exportFinish'; jobId: number }
  | { method: 'exportCancel'; jobId: number }
  | { method: 'writeFile'; directory: string; name: string; data: ArrayBuffer }

export type MediaMessage = { id: number; request: MediaRequest } | { abort: number }

export type MediaReply = { id: number; result: unknown } | { id: number; error: string }

/** Sent by main to the media process before any window connects. */
export type MediaProcessSetup = {
  ffmpegDirectory: string
  cacheDirectory: string
}

export type MediaProcessCommand = { type: 'setup'; setup: MediaProcessSetup } | { type: 'connect' }

export type MediaProcessReport = { type: 'versions'; ffmpeg: string; ffprobe: string }

export type ExportJob = {
  kind: 'export'
  projectPath: string
  outputPath: string
  preset: ExportPreset
}

export type FramesJob = {
  kind: 'frames'
  projectPath: string
  /** Which frame source to exercise: the paused preview path or the export path. */
  via: 'paused' | 'export'
  frames: number[]
  outputDirectory: string
  /** Output size; the project canvas size when left out. */
  size?: { width: number; height: number }
}

/** A job main hands to a hidden engine window. */
export type HeadlessJob = ExportJob | FramesJob

export type JobEvent =
  | { type: 'progress'; done: number; total: number }
  | { type: 'done'; summary: Record<string, unknown> }
  | { type: 'error'; message: string }

/** Pushed from main to a window. */
export type HostCommand =
  | { type: 'open-project'; path: string }
  | { type: 'run-job'; job: HeadlessJob }
  | { type: 'export-event'; event: JobEvent }
  | { type: 'menu'; action: 'open-project' | 'export' }

/** What the preload exposes to the page as `window.host`. */
export type Host = {
  openProjectDialog(): Promise<string | undefined>
  saveExportDialog(suggestedName: string): Promise<string | undefined>
  startExport(job: ExportJob): void
  cancelExport(): void
  reportJobEvent(event: JobEvent): void
  /** Absolute path of a file the user dropped on the window. */
  pathOfFile(file: File): string
  onCommand(listener: (command: HostCommand) => void): void
}
