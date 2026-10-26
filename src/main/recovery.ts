import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { temporaryPathFor } from '../shared/exportPresets.js'
import { logError } from '../shared/log.js'

const RECOVERY_EXTENSION = '.json'
const PROJECT_PATH_EXTENSION = '.path'
const EXPORT_SNAPSHOT_EXTENSION = '.export'
const EXPORT_OUTPUT_EXTENSION = '.output'

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

export function exportSnapshotPath(recoveryPath: string): string {
  return `${recoveryPath}${EXPORT_SNAPSHOT_EXTENSION}`
}

export async function discardExportSnapshot(path: string, directory: string): Promise<void> {
  const isOurs = dirname(path) === directory && path.endsWith(EXPORT_SNAPSHOT_EXTENSION)
  if (isOurs) await discardRecoveredWork(path)
}

export async function rememberExportOutput(directory: string, outputPath: string): Promise<string> {
  const notePath = join(directory, `${randomUUID()}${EXPORT_OUTPUT_EXTENSION}`)
  try {
    await mkdir(directory, { recursive: true })
    await writeFile(notePath, outputPath)
  } catch (error) {
    logError('Could not note where an export writes', error, { outputPath })
  }
  return notePath
}

async function removeUnfinishedExport(notePath: string): Promise<void> {
  try {
    const outputPath = await readFile(notePath, 'utf8')
    if (isAbsolute(outputPath)) await rm(temporaryPathFor(outputPath), { force: true })
  } catch (error) {
    if (!isMissingFile(error)) logError('Could not remove what an interrupted export left', error, { notePath })
  }
  await discardRecoveredWork(notePath)
}

export async function rememberProjectPath(recoveryPath: string, projectPath: string): Promise<void> {
  try {
    await mkdir(dirname(recoveryPath), { recursive: true })
    await writeFile(`${recoveryPath}${PROJECT_PATH_EXTENSION}`, projectPath)
  } catch (error) {
    logError('Could not note which project a recovery file belongs to', error, { recoveryPath })
  }
}

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

async function recoveryAt(recoveryPath: string): Promise<(FoundRecovery & { writtenAt: number }) | undefined> {
  const writtenAt = await modifiedAt(recoveryPath)
  if (writtenAt === undefined) return undefined

  const projectPath = await readProjectPath(recoveryPath)
  const projectSavedAt = projectPath === undefined ? undefined : await modifiedAt(projectPath)
  const isSuperseded = projectSavedAt !== undefined && projectSavedAt > writtenAt
  if (isSuperseded) {
    await discardRecovery(recoveryPath)
    return undefined
  }
  return { recoveryPath, projectPath, writtenAt }
}

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
    if (name.endsWith(EXPORT_SNAPSHOT_EXTENSION)) await discardRecoveredWork(join(directory, name))
    if (name.endsWith(EXPORT_OUTPUT_EXTENSION)) await removeUnfinishedExport(join(directory, name))
    if (name.endsWith(PROJECT_PATH_EXTENSION) && !names.includes(name.slice(0, -PROJECT_PATH_EXTENSION.length))) await discardRecoveredWork(join(directory, name))
    if (!name.endsWith(RECOVERY_EXTENSION)) continue
    const recoveryPath = join(directory, name)
    try {
      const recovery = await recoveryAt(recoveryPath)
      if (recovery !== undefined) found.push(recovery)
    } catch (error) {
      logError('Could not read a recovery file, so it is left for a later launch', error, { recoveryPath })
    }
  }
  found.sort((a, b) => b.writtenAt - a.writtenAt)
  return found.map(({ recoveryPath, projectPath }) => ({ recoveryPath, projectPath }))
}
