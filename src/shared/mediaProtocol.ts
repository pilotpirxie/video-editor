import type { ExportPreset, ExportQuality } from './exportPresets.js'
import type { MediaRef, Project } from './project.js'
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
  isHdr: boolean
  codec: string
}

export type AudioInfo = {
  channels: number
  sampleRate: number
  codec: string
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
  quality: ExportQuality
  hasAudio: boolean
}

export type TimeRange = {
  start: number
  end: number
}

export type MediaClient = {
  loadProject(path: string, forPreview: boolean): Promise<LoadedProject>
  whenPrepared(): Promise<void>
  readImage(mediaId: string): Promise<ArrayBuffer>
  previewFrame(mediaId: string, frame: number): Promise<ArrayBuffer | undefined>
  fullFrame(mediaId: string, frame: number, halvings: number, signal?: AbortSignal): Promise<RawFrame>
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
  waveform(mediaId: string): Promise<WaveformLevel[] | undefined>
  saveProject(path: string, project: Project): Promise<void>
}

export type MediaRequest =
  | { method: 'loadProject'; path: string; forPreview: boolean }
  | { method: 'whenPrepared' }
  | { method: 'readImage'; mediaId: string }
  | { method: 'previewFrame'; mediaId: string; frame: number }
  | { method: 'fullFrame'; mediaId: string; frame: number; halvings: number }
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
  | { method: 'waveform'; mediaId: string }
  | { method: 'saveProject'; path: string; project: Project }

export type MediaMessage = { id: number; request: MediaRequest } | { abort: number }

export type MediaReply = { id: number; result: unknown } | { id: number; error: string }

type MediaProcessSetup = {
  ffmpegDirectory: string
  cacheDirectory: string
}

export type MediaProcessCommand = { type: 'setup'; setup: MediaProcessSetup } | { type: 'connect' }

export type MediaProcessReport = { type: 'versions'; ffmpeg: string; ffprobe: string }

// What is left out takes its default: the project's frame rate, high quality, the whole timeline, with sound.
export type ExportJob = {
  kind: 'export'
  projectPath: string
  outputPath: string
  preset: ExportPreset
  frameRate?: FrameRate
  quality?: ExportQuality
  range?: TimeRange
  hasAudio?: boolean
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

export type HostCommand =
  | { type: 'open-project'; path: string }
  | { type: 'run-job'; job: HeadlessJob }
  | { type: 'export-event'; event: JobEvent }
  | { type: 'menu'; action: MenuAction }

// `loadFrom` is the file to read (the project, or its recovery file after a crash); `path` is where Save writes.
export type DocumentInfo = {
  path: string | undefined
  loadFrom: string | undefined
  recoveryPath: string
  // Where the project is written for an export to read: the export works on that copy while editing goes on.
  exportSnapshotPath: string
}

export type DocumentState = {
  isDirty: boolean
  undoLabel: string | undefined
  redoLabel: string | undefined
}

export type UnsavedChoice = 'save' | 'discard' | 'cancel'

export type NextDocument = { kind: 'new' } | { kind: 'open'; path: string } | { kind: 'close' }

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
  replaceDocument(next: NextDocument): void
  discardRecovery(): void
}
