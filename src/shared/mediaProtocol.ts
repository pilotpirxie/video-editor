import type { ExportFormat, ExportPreset, ExportQuality } from './exportPresets.js'
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
  seeksExactly: boolean
}

export type MediaInfo =
  | { kind: 'video'; duration: number; containerStart: number; video: VideoInfo; audio?: AudioInfo; isAnimatedImage?: true }
  | { kind: 'audio'; duration: number; containerStart: number; audio: AudioInfo }
  | { kind: 'image'; width: number; height: number; hasAlpha: boolean }

export type MediaState = { info: MediaInfo; createdAt?: number } | { error: string; isMissing: boolean }

export type LoadedProject = {
  project: Project
  media: Record<string, MediaState>
}

export type AddedMedia = {
  id: string
  info: MediaInfo
  createdAt: number
}

export type MediaUse = 'video' | 'image' | 'sound'

export type UnlinkedMedia = {
  reference: MediaRef
  uses: MediaUse[]
}

export type RelinkedMedia = {
  id: string
  path: string
  info: MediaInfo
  createdAt: number
}

export type Preparation = {
  progress: number
  hasFailed: boolean
}

export type WaveformLevel = {
  samplesPerBucket: number
  peaks: Int8Array
}

export type AudioStretch = {
  speedPercent: number
  keepsPitch: boolean
}

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
  openMedia(media: readonly MediaRef[], projectPath: string | undefined): Promise<Record<string, MediaState>>
  whenPrepared(): Promise<void>
  readImage(mediaId: string): Promise<ArrayBuffer>
  previewFrame(mediaId: string, frame: number): Promise<ArrayBuffer | undefined>
  fullFrame(mediaId: string, frame: number, halvings: number, signal?: AbortSignal): Promise<RawFrame>
  keyframeThumbnail(mediaId: string, frame: number, halvings: number): Promise<RawFrame>
  openStream(mediaId: string, frame: number, halvings: number): Promise<number>
  streamFrame(streamId: number, frame: number): Promise<RawFrame>
  closeStream(streamId: number): Promise<void>
  audio(mediaId: string, firstSample: number, sampleCount: number, stretch?: AudioStretch): Promise<Float32Array | undefined>
  exportStart(target: ExportTarget): Promise<number>
  exportWrite(jobId: number, pixels: ArrayBuffer, audio: Float32Array): Promise<void>
  exportFinish(jobId: number): Promise<void>
  exportCancel(jobId: number): Promise<void>
  writeFile(directory: string, name: string, data: ArrayBuffer): Promise<void>
  addMedia(path: string): Promise<AddedMedia>
  relinkMedia(path: string, wanted: UnlinkedMedia, others: readonly UnlinkedMedia[]): Promise<RelinkedMedia[]>
  preparation(): Promise<Record<string, Preparation>>
  want(wanted: Wanted): Promise<void>
  waveform(mediaId: string): Promise<WaveformLevel[] | undefined>
  saveProject(path: string, project: Project): Promise<void>
  cacheUsage(): Promise<CacheUsage>
  clearCache(): Promise<void>
}

export type CacheUsage = {
  usedBytes: number
  limitBytes: number
  neededBytes: number
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

export type ExportJob = {
  kind: 'export'
  projectPath: string
  outputPath: string
  preset: ExportPreset
  format?: ExportFormat
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

export type MenuShortcuts = Partial<Record<MenuAction, string>>

export type HostCommand =
  | { type: 'open-project'; path: string }
  | { type: 'run-job'; job: HeadlessJob }
  | { type: 'export-event'; event: JobEvent }
  | { type: 'menu'; action: MenuAction }
  | { type: 'memory-pressure'; isUnderPressure: boolean }
  | { type: 'settings'; settings: AppSettings }

export type DocumentInfo = {
  path: string | undefined
  loadFrom: string | undefined
  recoveryPath: string
  exportSnapshotPath: string
}

export type DocumentState = {
  isDirty: boolean
  undoLabel: string | undefined
  redoLabel: string | undefined
}

export type UnsavedChoice = 'save' | 'discard' | 'cancel'

export type SlowFrame = {
  durationMs: number
  blockingMs: number
  scripts: { invoker: string; functionName: string; sourceUrl: string; durationMs: number }[]
}

export type DebugSystemInfo = {
  appVersion: string
  versions: string[]
  macOS: string
  cpu: string
  totalMemoryBytes: number
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
  closeDocument(): void
  discardRecovery(): void
  setMenuShortcuts(shortcuts: MenuShortcuts): void
  reportSlowFrame(frame: SlowFrame): void
  debugInfo(): Promise<DebugSystemInfo>
  settings(): Promise<AppSettings>
  setSettings(settings: AppSettings): void
}
