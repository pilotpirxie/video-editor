import type { FrameRate } from './time.js'

export type Size = {
  width: number
  height: number
}

type PresetRule =
  | { kind: 'short-side'; shortSide: number }
  | { kind: 'fixed'; size: Size }

const PRESET_RULES = {
  '120p': { kind: 'short-side', shortSide: 120 },
  '240p': { kind: 'short-side', shortSide: 240 },
  '360p': { kind: 'short-side', shortSide: 360 },
  '480p': { kind: 'short-side', shortSide: 480 },
  '720p': { kind: 'short-side', shortSide: 720 },
  '1080p': { kind: 'short-side', shortSide: 1080 },
  '1440p': { kind: 'short-side', shortSide: 1440 },
  '4k': { kind: 'short-side', shortSide: 2160 },
  'youtube-1080p': { kind: 'fixed', size: { width: 1920, height: 1080 } },
  'vertical-1080x1920': { kind: 'fixed', size: { width: 1080, height: 1920 } },
  'square-1080': { kind: 'fixed', size: { width: 1080, height: 1080 } },
} as const satisfies Record<string, PresetRule>

export type ExportPreset = keyof typeof PRESET_RULES

export const EXPORT_PRESETS: readonly ExportPreset[] = [
  '120p',
  '240p',
  '360p',
  '480p',
  '720p',
  '1080p',
  '1440p',
  '4k',
  'youtube-1080p',
  'vertical-1080x1920',
  'square-1080',
]

export function isExportPreset(name: string): name is ExportPreset {
  return Object.hasOwn(PRESET_RULES, name)
}

export const EXPORT_QUALITIES = ['low', 'medium', 'high'] as const

export type ExportQuality = (typeof EXPORT_QUALITIES)[number]

export function isExportQuality(name: string): name is ExportQuality {
  return EXPORT_QUALITIES.some((quality) => quality === name)
}

export const EXPORT_FORMATS = ['mp4', 'webm', 'gif', 'm4a', 'mp3', 'wav', 'png'] as const

export type ExportFormat = (typeof EXPORT_FORMATS)[number]

export function isExportFormat(name: string): name is ExportFormat {
  return EXPORT_FORMATS.some((format) => format === name)
}

const MOVING_PICTURE_FORMATS: readonly ExportFormat[] = ['mp4', 'webm', 'gif']
const SOUND_FORMATS: readonly ExportFormat[] = ['mp4', 'webm', 'm4a', 'mp3', 'wav']

export function hasMovingPicture(format: ExportFormat): boolean {
  return MOVING_PICTURE_FORMATS.includes(format)
}

export function hasSound(format: ExportFormat): boolean {
  return SOUND_FORMATS.includes(format)
}

// What the engine hands the encoder for each picture. Video codecs take YUV 4:2:0, made on the GPU so a third as many bytes cross between processes; a GIF and a PNG take the RGBA pixels.
export type PixelLayout = 'yuv420p' | 'rgba'

export function pixelLayoutOf(format: ExportFormat): PixelLayout {
  return format === 'mp4' || format === 'webm' ? 'yuv420p' : 'rgba'
}

export function temporaryPathFor(path: string): string {
  return `${path}.part`
}

export const EXPORT_ENCODERS = ['x264', 'hardware'] as const

export type ExportEncoder = (typeof EXPORT_ENCODERS)[number]

export function isExportEncoder(name: string): name is ExportEncoder {
  return EXPORT_ENCODERS.some((encoder) => encoder === name)
}

// A GIF stores how long each picture shows in hundredths of a second, so only these rates play at their true speed.
export const GIF_FRAME_RATES: readonly FrameRate[] = [
  { num: 10, den: 1 },
  { num: 20, den: 1 },
  { num: 25, den: 1 },
]

export const DEFAULT_GIF_FRAME_RATE: FrameRate = { num: 10, den: 1 }

export function shortSideOf(preset: ExportPreset): number | undefined {
  const rule: PresetRule = PRESET_RULES[preset]
  return rule.kind === 'short-side' ? rule.shortSide : undefined
}

function nearestEven(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2)
}

export function exportSize(preset: ExportPreset, canvas: Size): Size {
  const rule: PresetRule = PRESET_RULES[preset]
  if (rule.kind === 'fixed') return { ...rule.size }

  const canvasLongSide = Math.max(canvas.width, canvas.height)
  const canvasShortSide = Math.min(canvas.width, canvas.height)
  const longSide = nearestEven((rule.shortSide * canvasLongSide) / canvasShortSide)
  const isLandscape = canvas.width >= canvas.height
  if (isLandscape) return { width: longSide, height: rule.shortSide }
  return { width: rule.shortSide, height: longSide }
}

export type CanvasFit = {
  scale: number
  offsetX: number
  offsetY: number
}

export function fitCanvas(canvas: Size, output: Size): CanvasFit {
  const scale = Math.min(output.width / canvas.width, output.height / canvas.height)
  return {
    scale,
    offsetX: (output.width - canvas.width * scale) / 2,
    offsetY: (output.height - canvas.height * scale) / 2,
  }
}
