import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { logError } from '../shared/log.js'
import { DEFAULT_SETTINGS, parseSettings, type AppSettings } from '../shared/settings.js'
import { isMissingFile } from './logFiles.js'

// No file yet is the first launch. A file that cannot be read or parsed is logged and the defaults are used, so a bad file never stops the app.
export async function readSettings(path: string): Promise<AppSettings> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (!isMissingFile(error)) logError('Could not read the settings; the defaults are used', error, { path })
    return DEFAULT_SETTINGS
  }
  try {
    return parseSettings(JSON.parse(text))
  } catch (error) {
    logError('The settings file is not valid JSON; the defaults are used', error, { path })
    return DEFAULT_SETTINGS
  }
}

// Written beside the file and renamed over it, so a crash mid-write leaves the earlier settings whole.
export async function writeSettings(path: string, settings: AppSettings): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`)
  await rename(temporary, path)
}
