// One structured line per event on stderr, so every process logs the same way.

type LogLevel = 'info' | 'warn' | 'error'

export type LogFields = Record<string, unknown>

function write(level: LogLevel, message: string, fields: LogFields): void {
  const line = JSON.stringify({ time: new Date().toISOString(), level, message, ...fields })
  if (level === 'error') {
    console.error(line)
  } else if (level === 'warn') {
    console.warn(line)
  } else {
    console.info(line)
  }
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function logInfo(message: string, fields: LogFields = {}): void {
  write('info', message, fields)
}

export function logWarning(message: string, fields: LogFields = {}): void {
  write('warn', message, fields)
}

export function logError(message: string, error: unknown, fields: LogFields = {}): void {
  write('error', message, { ...fields, error: describeError(error) })
}
