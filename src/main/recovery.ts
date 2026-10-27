import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { temporaryPathFor } from '../shared/exportPresets.js'
import { logError } from '../shared/log.js'
import { animationManifestPath, type AnimationOverrides } from '../shared/mediaProtocol.js'

const RECOVERY_EXTENSION = '.json'
const PROJECT_PATH_EXTENSION = '.path'
const EXPORT_SNAPSHOT_EXTENSION = '.export'
const EXPORT_OUTPUT_EXTENSION = '.output'
const ANIMATION_COPY_EXTENSION = '.pbanim'
const ANIMATION_MANIFEST_EXTENSION = '.animations'

export type FoundRecovery = {
  recoveryPath: string
  projectPath: string | undefined
  recoveredAnimations: AnimationOverrides
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

export async function discardExportSnapshot(path: string, directory: string, animationCopies: Readonly<Record<string, string>> = {}): Promise<void> {
  for (const copy of [path, ...Object.values(animationCopies)]) {
    const isOurs = dirname(copy) === directory && copy.endsWith(EXPORT_SNAPSHOT_EXTENSION)
    if (isOurs) await discardRecoveredWork(copy)
  }
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

export async function discardAnimationCopies(recoveryPath: string): Promise<void> {
  const directory = dirname(recoveryPath)
  const prefix = `${basename(recoveryPath)}.`
  let names: string[]
  try {
    names = await readdir(directory)
  } catch (error) {
    if (isMissingFile(error)) return
    throw error
  }
  for (const name of names) {
    if (name.startsWith(prefix) && name.endsWith(ANIMATION_COPY_EXTENSION)) await discardRecoveredWork(join(directory, name))
  }
  await discardRecoveredWork(animationManifestPath(recoveryPath))
}

export async function discardRecovery(recoveryPath: string): Promise<void> {
  await discardRecoveredWork(recoveryPath)
  await discardRecoveredWork(`${recoveryPath}${PROJECT_PATH_EXTENSION}`)
  await discardAnimationCopies(recoveryPath)
}

async function readManifest(recoveryPath: string): Promise<Record<string, string>> {
  let text: string
  try {
    text = await readFile(animationManifestPath(recoveryPath), 'utf8')
  } catch (error) {
    if (isMissingFile(error)) return {}
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    logError('Could not read the list of unsaved animations, so they are not restored', error, { recoveryPath })
    return {}
  }
  const manifest: Record<string, string> = {}
  if (typeof parsed !== 'object' || parsed === null) return manifest
  for (const [realPath, copyName] of Object.entries(parsed)) {
    if (typeof copyName === 'string' && isAbsolute(realPath)) manifest[realPath] = copyName
  }
  return manifest
}

// A copy older than its real file was overtaken by a save there.
export async function recoveredAnimations(recoveryPath: string): Promise<AnimationOverrides> {
  const found: Record<string, string> = {}
  for (const [realPath, copyName] of Object.entries(await readManifest(recoveryPath))) {
    const copyPath = join(dirname(recoveryPath), basename(copyName))
    const copiedAt = await modifiedAt(copyPath)
    const savedAt = await modifiedAt(realPath)
    const isOvertaken = savedAt !== undefined && copiedAt !== undefined && savedAt > copiedAt
    if (copiedAt !== undefined && !isOvertaken) found[realPath] = copyPath
  }
  return found
}

async function recoveryAt(recoveryPath: string): Promise<(FoundRecovery & { writtenAt: number }) | undefined> {
  const writtenAt = await modifiedAt(recoveryPath)
  if (writtenAt === undefined) return undefined

  const projectPath = await readProjectPath(recoveryPath)
  const projectSavedAt = projectPath === undefined ? undefined : await modifiedAt(projectPath)
  const animations = await recoveredAnimations(recoveryPath)
  const isSuperseded = projectSavedAt !== undefined && projectSavedAt > writtenAt && Object.keys(animations).length === 0
  if (isSuperseded) {
    await discardRecovery(recoveryPath)
    return undefined
  }
  return { recoveryPath, projectPath, recoveredAnimations: animations, writtenAt }
}

function isAnimationLeftover(name: string, names: readonly string[]): boolean {
  if (!name.endsWith(ANIMATION_COPY_EXTENSION) && !name.endsWith(ANIMATION_MANIFEST_EXTENSION)) return false
  const end = name.indexOf(`${RECOVERY_EXTENSION}.`)
  return end < 0 || !names.includes(name.slice(0, end + RECOVERY_EXTENSION.length))
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
    if (isAnimationLeftover(name, names)) await discardRecoveredWork(join(directory, name))
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
  return found.map(({ recoveryPath, projectPath, recoveredAnimations: animations }) => ({ recoveryPath, projectPath, recoveredAnimations: animations }))
}
