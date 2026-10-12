export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function logError(message: string, error: unknown, fields: Record<string, unknown> = {}): void {
  console.error(JSON.stringify({ time: new Date().toISOString(), level: 'error', message, ...fields, error: describeError(error) }))
}
