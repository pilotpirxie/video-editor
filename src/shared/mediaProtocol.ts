import type { ExportPreset } from './exportPresets.js'
import type { Project } from './project.js'
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

export type MediaInfo =
  | { kind: 'video'; duration: number; containerStart: number; video: VideoInfo; audio?: AudioInfo }
  | { kind: 'audio'; duration: number; containerStart: number; audio: AudioInfo }
  | { kind: 'image'; width: number; height: number; hasAlpha: boolean; isAnimated: boolean }

export type MediaState = { info: MediaInfo } | { error: string }

export type LoadedProject = {
  project: Project
  media: Record<string, MediaState>
}

export type AddedMedia = {
  id: string
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

export type MediaClient = {
  loadProject(path: string, forPreview: boolean): Promise<LoadedProject>
  whenPrepared(): Promise<void>
  readImage(mediaId: string): Promise<ArrayBuffer>
  previewFrame(mediaId: string, frame: number): Promise<ArrayBuffer | undefined>
  fullFrame(mediaId: string, frame: number, halvings: number, signal?: AbortSignal): Promise<RawFrame>
  openStream(mediaId: string, frame: number, halvings: number): Promise<number>
  streamFrame(streamId: number, frame: number): Promise<RawFrame>
  closeStream(streamId: number): Promise<void>
  audio(mediaId: string, firstSample: number, sampleCount: number): Promise<Float32Array | undefined>
  exportStart(target: ExportTarget): Promise<number>
  exportWrite(jobId: number, pixels: ArrayBuffer, audio: Float32Array): Promise<void>
  exportFinish(jobId: number): Promise<void>
  exportCancel(jobId: number): Promise<void>
  writeFile(directory: string, name: string, data: ArrayBuffer): Promise<void>
  addMedia(path: string): Promise<AddedMedia>
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
  | { method: 'audio'; mediaId: string; firstSample: number; sampleCount: number }
  | { method: 'exportStart'; target: ExportTarget }
  | { method: 'exportWrite'; jobId: number; pixels: ArrayBuffer; audio: Float32Array }
  | { method: 'exportFinish'; jobId: number }
  | { method: 'exportCancel'; jobId: number }
  | { method: 'writeFile'; directory: string; name: string; data: ArrayBuffer }
  | { method: 'addMedia'; path: string }
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

export type ExportJob = {
  kind: 'export'
  projectPath: string
  outputPath: string
  preset: ExportPreset
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
  | 'duplicate'
  | 'delete'
  | 'ripple-delete'

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
  confirmUnsavedChanges(): Promise<UnsavedChoice>
  replaceDocument(next: NextDocument): void
  discardRecovery(): void
}
