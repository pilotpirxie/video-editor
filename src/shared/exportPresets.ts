export type Size = {
  width: number
  height: number
}

type PresetRule =
  // Follows the project aspect ratio; named by its short side.
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

/** H.264 4:2:0 needs even dimensions. */
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
  /** Output pixels per canvas pixel. */
  scale: number
  offsetX: number
  offsetY: number
}

/** Places the whole canvas inside the output, centred, with bars where the aspect differs. */
export function fitCanvas(canvas: Size, output: Size): CanvasFit {
  const scale = Math.min(output.width / canvas.width, output.height / canvas.height)
  return {
    scale,
    offsetX: (output.width - canvas.width * scale) / 2,
    offsetY: (output.height - canvas.height * scale) / 2,
  }
}
