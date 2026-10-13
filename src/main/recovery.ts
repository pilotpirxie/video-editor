import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { logError } from '../shared/log.js'

const RECOVERY_EXTENSION = '.json'
const PROJECT_PATH_EXTENSION = '.path'

export type FoundRecovery = {
  recoveryPath: string
  projectPath: string | undefined
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

async function modifiedAt(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mtimeMs
  } catch (error) {
    if (isMissingFile(error)) return undefined
    throw error
  }
}

async function readProjectPath(recoveryPath: string): Promise<string | undefined> {
  try {
    const text = await readFile(`${recoveryPath}${PROJECT_PATH_EXTENSION}`, 'utf8')
    return text === '' ? undefined : text
  } catch (error) {
    if (isMissingFile(error)) return undefined
    throw error
  }
}

export function newRecoveryPath(directory: string): string {
  return join(directory, `${randomUUID()}${RECOVERY_EXTENSION}`)
}

// The recovery file itself is a plain project file, so this note is the only record of which project it belongs to.
export async function rememberProjectPath(recoveryPath: string, projectPath: string): Promise<void> {
  try {
    await mkdir(dirname(recoveryPath), { recursive: true })
    await writeFile(`${recoveryPath}${PROJECT_PATH_EXTENSION}`, projectPath)
  } catch (error) {
    logError('Could not note which project a recovery file belongs to', error, { recoveryPath })
  }
}

// The project file now holds everything, so the recovered work is dropped; the note stays for the next autosave.
export async function discardRecoveredWork(recoveryPath: string): Promise<void> {
  try {
    await rm(recoveryPath, { force: true })
  } catch (error) {
    logError('Could not remove a recovery file', error, { recoveryPath })
  }
}

export async function discardRecovery(recoveryPath: string): Promise<void> {
  await discardRecoveredWork(recoveryPath)
  await discardRecoveredWork(`${recoveryPath}${PROJECT_PATH_EXTENSION}`)
}

// Returns the newest recovery file that still holds work the project file does not.
export async function findRecovery(directory: string): Promise<FoundRecovery | undefined> {
  let names: string[]
  try {
    names = await readdir(directory)
  } catch (error) {
    if (isMissingFile(error)) return undefined
    throw error
  }

  let newest: (FoundRecovery & { writtenAt: number }) | undefined
  for (const name of names) {
    if (!name.endsWith(RECOVERY_EXTENSION)) continue
    const recoveryPath = join(directory, name)
    const writtenAt = await modifiedAt(recoveryPath)
    if (writtenAt === undefined) continue

    const projectPath = await readProjectPath(recoveryPath)
    const projectSavedAt = projectPath === undefined ? undefined : await modifiedAt(projectPath)
    const isSuperseded = projectSavedAt !== undefined && projectSavedAt > writtenAt
    if (isSuperseded) {
      await discardRecovery(recoveryPath)
      continue
    }
    if (newest === undefined || writtenAt > newest.writtenAt) newest = { recoveryPath, projectPath, writtenAt }
  }
  if (newest === undefined) return undefined
  return { recoveryPath: newest.recoveryPath, projectPath: newest.projectPath }
}
