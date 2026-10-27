export type ColorParts = {
  hue: number
  saturation: number
  lightness: number
  opacity: number
}

const CHANNEL_MAX = 255
const PERCENT = 100
const FULL_TURN = 360
const SECTOR = 60
const OPAQUE_HEX_LENGTH = 7
// HSL to RGB walks the hue circle in twelfths: red starts at 0, green at 8 and blue at 4.
const TWELFTH = FULL_TURN / 12
const HEX_PATTERN = /^#?(?<digits>[0-9a-fA-F]{6})$/

function channelAt(hex: string, index: number): number {
  return Number.parseInt(hex.slice(1 + 2 * index, 3 + 2 * index), 16) / CHANNEL_MAX
}

// Hue in degrees, the rest in percent; a hex without alpha is opaque.
export function partsOf(hex: string): ColorParts {
  const red = channelAt(hex, 0)
  const green = channelAt(hex, 1)
  const blue = channelAt(hex, 2)
  const opacity = hex.length > OPAQUE_HEX_LENGTH ? channelAt(hex, 3) * PERCENT : PERCENT
  const brightest = Math.max(red, green, blue)
  const darkest = Math.min(red, green, blue)
  const lightness = (brightest + darkest) / 2
  const spread = brightest - darkest
  if (spread === 0) return { hue: 0, saturation: 0, lightness: lightness * PERCENT, opacity }

  const saturation = spread / (1 - Math.abs(2 * lightness - 1))
  let sector = (red - green) / spread + 4
  if (brightest === red) sector = ((green - blue) / spread + 6) % 6
  else if (brightest === green) sector = (blue - red) / spread + 2
  return { hue: sector * SECTOR, saturation: saturation * PERCENT, lightness: lightness * PERCENT, opacity }
}

function hexByte(share: number): string {
  return Math.round(Math.min(1, Math.max(0, share)) * CHANNEL_MAX)
    .toString(16)
    .padStart(2, '0')
    .toUpperCase()
}

export function hexOf(parts: ColorParts): string {
  const saturation = parts.saturation / PERCENT
  const lightness = parts.lightness / PERCENT
  const reach = saturation * Math.min(lightness, 1 - lightness)
  function channel(offset: number): number {
    const turn = (offset + parts.hue / TWELFTH) % 12
    return lightness - reach * Math.max(-1, Math.min(turn - 3, 9 - turn, 1))
  }
  const opaque = `#${hexByte(channel(0))}${hexByte(channel(8))}${hexByte(channel(4))}`
  const alpha = hexByte(parts.opacity / PERCENT)
  return alpha === 'FF' ? opaque : `${opaque}${alpha}`
}

export function hexInput(text: string): string | undefined {
  const digits = HEX_PATTERN.exec(text.trim())?.groups?.digits
  return digits === undefined ? undefined : `#${digits.toUpperCase()}`
}
