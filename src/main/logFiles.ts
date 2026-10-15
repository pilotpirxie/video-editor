import { appendFile, mkdir, open, rename, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { SlowFrame } from '../shared/mediaProtocol.js'
import { logError } from '../shared/log.js'

// A log over this size keeps only its newer half when the editor starts.
export const MAX_LOG_BYTES = 1024 * 1024
// A window that keeps stalling would otherwise write a line for every frame.
export const MAX_SLOW_FRAMES_PER_RUN = 500

const NEWLINE = 0x0a

export function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

export function isSlowFrame(value: unknown): value is SlowFrame {
  if (typeof value !== 'object' || value === null) return false
  if (!('durationMs' in value) || typeof value.durationMs !== 'number') return false
  if (!('blockingMs' in value) || typeof value.blockingMs !== 'number') return false
  if (!('scripts' in value) || !Array.isArray(value.scripts)) return false
  for (const script of value.scripts) {
    if (!isScriptTiming(script)) return false
  }
  return true
}

function isScriptTiming(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  if (!('invoker' in value) || typeof value.invoker !== 'string') return false
  if (!('functionName' in value) || typeof value.functionName !== 'string') return false
  if (!('sourceUrl' in value) || typeof value.sourceUrl !== 'string') return false
  return 'durationMs' in value && typeof value.durationMs === 'number'
}

export async function appendLogLine(path: string, entry: Record<string, unknown>): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true })
    await appendFile(path, `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`)
  } catch (error) {
    logError('Could not write a log line', error, { path })
  }
}

// Keeps the newer half of a log that grew over `maxBytes`, starting at a whole line. A line written while it is trimmed may be lost.
export async function trimLogFile(path: string, maxBytes: number): Promise<void> {
  let size: number
  try {
    size = (await stat(path)).size
  } catch (error) {
    if (isMissingFile(error)) return
    throw error
  }
  if (size <= maxBytes) return

  const keptBytes = Math.floor(maxBytes / 2)
  const tail = Buffer.alloc(keptBytes)
  const file = await open(path, 'r')
  try {
    await file.read(tail, 0, keptBytes, size - keptBytes)
  } finally {
    await file.close()
  }
  const temporaryPath = `${path}.trimming`
  await writeFile(temporaryPath, tail.subarray(tail.indexOf(NEWLINE) + 1))
  await rename(temporaryPath, path)
}
