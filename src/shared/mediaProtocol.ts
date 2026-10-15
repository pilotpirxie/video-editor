import type { ExportEncoder, ExportFormat, ExportPreset, ExportQuality } from './exportPresets.js'
import type { MediaRef, Project } from './project.js'
import type { AppSettings, MediaSettings } from './settings.js'
import type { FrameRate } from './time.js'

export type VideoInfo = {
  width: number
  height: number
  frameDuration: number
  frameCount: number
  startOffset: number
  seekPreroll: number
  isVariableFrameRate: boolean
  hasAlpha: boolean
  alphaDecoder?: string
  colorMatrix: 'bt709' | 'bt601' | 'bt2020'
  colorRange: 'tv' | 'pc'
  transfer: 'sdr' | 'hlg' | 'pq'
  codec: string
}

export type AudioInfo = {
  channels: number
  sampleRate: number
  codec: string
  // MP3 and raw AAC files cannot be sought to an exact sample; their sound is decoded from the start.
  seeksExactly: boolean
}

// An animated GIF, WebP or APNG is moving pictures like any video; `isAnimatedImage` only says it came from an image file, so it may loop and is shown as an image.
export type MediaInfo =
  | { kind: 'video'; duration: number; containerStart: number; video: VideoInfo; audio?: AudioInfo; isAnimatedImage?: true }
  | { kind: 'audio'; duration: number; containerStart: number; audio: AudioInfo }
  | { kind: 'image'; width: number; height: number; hasAlpha: boolean }

// `isMissing` tells a file that is not where the project expects it from one that is there but cannot be read.
export type MediaState = { info: MediaInfo } | { error: string; isMissing: boolean }

export type LoadedProject = {
  project: Project
  media: Record<string, MediaState>
}

export type AddedMedia = {
  id: string
  info: MediaInfo
}

// What the clips of a project use a media file for. A file relinked in its place has to offer the same.
export type MediaUse = 'video' | 'image' | 'sound'

export type UnlinkedMedia = {
  reference: MediaRef
  uses: MediaUse[]
}

export type RelinkedMedia = {
  id: string
  path: string
  info: MediaInfo
}

export type Preparation = {
  progress: number
  hasFailed: boolean
}

// Lowest and highest sample of each bucket, as Int8 pairs.
export type WaveformLevel = {
  samplesPerBucket: number
  peaks: Int8Array
}

// The sound of a file played at another speed. With the pitch kept the voice stays a voice; without, it rises and falls with the speed.
export type AudioStretch = {
  speedPercent: number
  keepsPitch: boolean
}

// A part of a media file the timeline uses, and where it plays, so the media process prepares what is nearest the playhead first.
// A fast clip shows only some frames of its source: those at `phase + k * step` ticks after the source's first frame, for whole k.
// Such a clip gets a preview copy of just those frames.
export type Cadence = {
  step: number
  phase: number
}

export type WantedRange = {
  mediaId: string
  use: 'picture' | 'sound'
  stretch?: AudioStretch
  timelineStart: number
  timelineEnd: number
  sourceStart: number
  speedPercent: number
  isLooping: boolean
  cadence?: Cadence
}

export type Wanted = {
  playhead: number
  ranges: WantedRange[]
}

export type RawFrame = {
  width: number
  height: number
  data: ArrayBuffer
}

export type ExportTarget = {
  path: string
  format: ExportFormat
  encoder: ExportEncoder
  width: number
  height: number
  frameRate: FrameRate
  quality: ExportQuality
  hasAudio: boolean
}

export type TimeRange = {
  start: number
  end: number
}

export type MediaClient = {
  loadProject(path: string, forPreview: boolean): Promise<LoadedProject>
  // Opens again the media of the project a window shows, in a media process that was started anew. Relative paths are read beside `projectPath`.
  openMedia(media: readonly MediaRef[], projectPath: string | undefined): Promise<Record<string, MediaState>>
  whenPrepared(): Promise<void>
  readImage(mediaId: string): Promise<ArrayBuffer>
  previewFrame(mediaId: string, frame: number): Promise<ArrayBuffer | undefined>
  fullFrame(mediaId: string, frame: number, halvings: number, signal?: AbortSignal): Promise<RawFrame>
  // The keyframe at or before `frame`: a quick stand-in for a timeline thumbnail until the preview copy holds the frame.
  keyframeThumbnail(mediaId: string, frame: number, halvings: number): Promise<RawFrame>
  openStream(mediaId: string, frame: number, halvings: number): Promise<number>
  streamFrame(streamId: number, frame: number): Promise<RawFrame>
  closeStream(streamId: number): Promise<void>
  // With a `stretch`, the samples are counted in the stretched sound, not in the file.
  audio(mediaId: string, firstSample: number, sampleCount: number, stretch?: AudioStretch): Promise<Float32Array | undefined>
  exportStart(target: ExportTarget): Promise<number>
  exportWrite(jobId: number, pixels: ArrayBuffer, audio: Float32Array): Promise<void>
  exportFinish(jobId: number): Promise<void>
  exportCancel(jobId: number): Promise<void>
  writeFile(directory: string, name: string, data: ArrayBuffer): Promise<void>
  addMedia(path: string): Promise<AddedMedia>
  relinkMedia(path: string, wanted: UnlinkedMedia, others: readonly UnlinkedMedia[]): Promise<RelinkedMedia[]>
  preparation(): Promise<Record<string, Preparation>>
  // Tells the media process what the timeline uses and where the playhead is; it prepares in that order.
  want(wanted: Wanted): Promise<void>
  waveform(mediaId: string): Promise<WaveformLevel[] | undefined>
  saveProject(path: string, project: Project): Promise<void>
  cacheUsage(): Promise<CacheUsage>
  // Removes every cached copy no build is writing; what the timeline needs is made again.
  clearCache(): Promise<void>
}

export type CacheUsage = {
  usedBytes: number
  limitBytes: number
  // What this project's copies would take, from the size of those already made; 0 until one is.
  neededBytes: number
  // Free space on the disk the cache is on.
  freeBytes: number
}

export type MediaRequest =
  | { method: 'loadProject'; path: string; forPreview: boolean }
  | { method: 'openMedia'; media: MediaRef[]; projectPath: string | undefined }
  | { method: 'whenPrepared' }
  | { method: 'readImage'; mediaId: string }
  | { method: 'previewFrame'; mediaId: string; frame: number }
  | { method: 'fullFrame'; mediaId: string; frame: number; halvings: number }
  | { method: 'keyframeThumbnail'; mediaId: string; frame: number; halvings: number }
  | { method: 'openStream'; mediaId: string; frame: number; halvings: number }
  | { method: 'streamFrame'; streamId: number; frame: number }
  | { method: 'closeStream'; streamId: number }
  | { method: 'audio'; mediaId: string; firstSample: number; sampleCount: number; stretch?: AudioStretch }
  | { method: 'exportStart'; target: ExportTarget }
  | { method: 'exportWrite'; jobId: number; pixels: ArrayBuffer; audio: Float32Array }
  | { method: 'exportFinish'; jobId: number }
  | { method: 'exportCancel'; jobId: number }
  | { method: 'writeFile'; directory: string; name: string; data: ArrayBuffer }
  | { method: 'addMedia'; path: string }
  | { method: 'relinkMedia'; path: string; wanted: UnlinkedMedia; others: UnlinkedMedia[] }
  | { method: 'preparation' }
  | { method: 'want'; wanted: Wanted }
  | { method: 'waveform'; mediaId: string }
  | { method: 'saveProject'; path: string; project: Project }
  | { method: 'cacheUsage' }
  | { method: 'clearCache' }

export type MediaMessage = { id: number; request: MediaRequest } | { abort: number }

export type MediaReply = { id: number; result: unknown } | { id: number; error: string }

type MediaProcessSetup = {
  ffmpegDirectory: string
  cacheDirectory: string
  settings: MediaSettings
}

export type MediaProcessCommand = { type: 'setup'; setup: MediaProcessSetup } | { type: 'connect' } | { type: 'settings'; settings: MediaSettings }

export type MediaProcessReport = { type: 'versions'; ffmpeg: string; ffprobe: string }

// What is left out takes its default: an MP4 by x264 at the project's frame rate (10 fps for a GIF), high quality, the whole timeline, with sound.
// A PNG is the picture at `frame`, at the size of the project.
export type ExportJob = {
  kind: 'export'
  projectPath: string
  outputPath: string
  preset: ExportPreset
  format?: ExportFormat
  encoder?: ExportEncoder
  frameRate?: FrameRate
  quality?: ExportQuality
  range?: TimeRange
  hasAudio?: boolean
  frame?: number
}

export type FramesJob = {
  kind: 'frames'
  projectPath: string
  via: 'paused' | 'export'
  frames: number[]
  outputDirectory: string
  size?: { width: number; height: number }
}

export type HeadlessJob = ExportJob | FramesJob

export type JobEvent =
  | { type: 'progress'; done: number; total: number }
  | { type: 'done'; summary: Record<string, unknown> }
  | { type: 'error'; message: string }

export type MenuAction =
  | 'new'
  | 'open-project'
  | 'save'
  | 'save-as'
  | 'import'
  | 'export'
  | 'close'
  | 'undo'
  | 'redo'
  | 'split'
  | 'split-all'
  | 'select-all'
  | 'deselect-all'
  | 'duplicate'
  | 'delete'
  | 'ripple-delete'
  | 'group'
  | 'ungroup'
  | 'toggle-library'
  | 'toggle-properties'
  | 'toggle-timeline'
  | 'toggle-debug'
  | 'preview-mode'
  | 'settings'

// The keys the menu shows for the commands whose keys can be changed, as Electron accelerators. The page itself answers to those keys.
export type MenuShortcuts = Partial<Record<MenuAction, string>>

export type HostCommand =
  | { type: 'open-project'; path: string }
  | { type: 'run-job'; job: HeadlessJob }
  | { type: 'export-event'; event: JobEvent }
  | { type: 'menu'; action: MenuAction }
  // macOS reports that memory is short (or no longer is): the caches of the window shrink, or grow back.
  | { type: 'memory-pressure'; isUnderPressure: boolean }
  | { type: 'settings'; settings: AppSettings }

// `loadFrom` is the file to read (the project, or its recovery file after a crash); `path` is where Save writes.
export type DocumentInfo = {
  path: string | undefined
  loadFrom: string | undefined
  recoveryPath: string
  // Where the project is written for an export to read: the export works on that copy while editing goes on.
  exportSnapshotPath: string
  // An MP4 is made by the Mac's media engine unless the user chose otherwise.
  hasSmallMemory: boolean
}

export type DocumentState = {
  isDirty: boolean
  undoLabel: string | undefined
  redoLabel: string | undefined
}

export type UnsavedChoice = 'save' | 'discard' | 'cancel'

// A frame of the editor window that took over 50 ms, and the scripts that ran in it.
export type SlowFrame = {
  durationMs: number
  blockingMs: number
  scripts: { invoker: string; functionName: string; sourceUrl: string; durationMs: number }[]
}

// What the debug panel tells about the app and the Mac it runs on.
export type DebugSystemInfo = {
  appVersion: string
  // Electron, Chromium, FFmpeg and FFprobe, once the media process has reported them.
  versions: string[]
  macOS: string
  cpu: string
  totalMemoryBytes: number
  // The app and every process it started, together; undefined when macOS could not tell.
  footprintBytes: number | undefined
}

export type Host = {
  openProjectDialog(): Promise<string | undefined>
  saveExportDialog(suggestedName: string): Promise<string | undefined>
  startExport(job: ExportJob): void
  cancelExport(): void
  reportJobEvent(event: JobEvent): void
  pathOfFile(file: File): string
  onCommand(listener: (command: HostCommand) => void): void
  documentInfo(): Promise<DocumentInfo>
  setDocumentState(state: DocumentState): void
  setDocumentPath(path: string): void
  saveProjectDialog(): Promise<string | undefined>
  importMediaDialog(): Promise<string[]>
  chooseMediaFile(name: string): Promise<string | undefined>
  showLastExport(): void
  confirmUnsavedChanges(): Promise<UnsavedChoice>
  // Closes the window once its unsaved changes have been dealt with.
  closeDocument(): void
  discardRecovery(): void
  setMenuShortcuts(shortcuts: MenuShortcuts): void
  reportSlowFrame(frame: SlowFrame): void
  debugInfo(): Promise<DebugSystemInfo>
  settings(): Promise<AppSettings>
  setSettings(settings: AppSettings): void
}
