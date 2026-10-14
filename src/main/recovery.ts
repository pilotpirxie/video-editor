import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { logError } from '../shared/log.js'

const RECOVERY_EXTENSION = '.json'
const PROJECT_PATH_EXTENSION = '.path'
const EXPORT_SNAPSHOT_EXTENSION = '.export'

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

// The copy of a project that an export reads. It lives beside the recovery file and is never taken for one.
export function exportSnapshotPath(recoveryPath: string): string {
  return `${recoveryPath}${EXPORT_SNAPSHOT_EXTENSION}`
}

// Removes an export's copy of the project. Only files this app put in its own recovery folder are ever removed.
export async function discardExportSnapshot(path: string, directory: string): Promise<void> {
  const isOurs = dirname(path) === directory && path.endsWith(EXPORT_SNAPSHOT_EXTENSION)
  if (isOurs) await discardRecoveredWork(path)
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

// The recovery files that still hold work their project files do not, the newest first: one for each window that had unsaved changes.
export async function findRecoveries(directory: string): Promise<FoundRecovery[]> {
  let names: string[]
  try {
    names = await readdir(directory)
  } catch (error) {
    if (isMissingFile(error)) return []
    throw error
  }

  const found: (FoundRecovery & { writtenAt: number })[] = []
  for (const name of names) {
    // No export is running at launch, so a copy an interrupted one left behind is of no use any more.
    if (name.endsWith(EXPORT_SNAPSHOT_EXTENSION)) await discardRecoveredWork(join(directory, name))
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
    found.push({ recoveryPath, projectPath, writtenAt })
  }
  found.sort((a, b) => b.writtenAt - a.writtenAt)
  return found.map(({ recoveryPath, projectPath }) => ({ recoveryPath, projectPath }))
}
