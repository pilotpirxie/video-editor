class FontListError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FontListError'
  }
}

function familyOf(font: unknown): string | undefined {
  if (typeof font !== 'object' || font === null || !('family' in font)) return undefined
  return typeof font.family === 'string' ? font.family : undefined
}

// The font families installed on this Mac, in alphabetical order. The browser only answers after a click or a key press, so this is called when the font control is first used.
export async function installedFontFamilies(): Promise<string[]> {
  const query: unknown = Reflect.get(window, 'queryLocalFonts')
  if (typeof query !== 'function') throw new FontListError('This system cannot list its fonts')
  const fonts: unknown = await query.call(window)
  if (!Array.isArray(fonts)) throw new FontListError('The list of fonts could not be read')

  const families = new Set<string>()
  for (const font of fonts) {
    const family = familyOf(font)
    if (family !== undefined) families.add(family)
  }
  return [...families].sort((a, b) => a.localeCompare(b))
}
