import { mkdir, open, rename, rm } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { describeError } from '../shared/log.js'
import { parseProject, serializeProject, type MediaRef, type Project } from '../shared/project.js'

export class ProjectFileError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ProjectFileError'
  }
}

export type MediaLocations = {
  resolvedPaths: ReadonlyMap<string, string>
  sourceDirectory: string | undefined
}

function savedReference(reference: MediaRef, locations: MediaLocations, targetDirectory: string): MediaRef {
  const resolved = locations.resolvedPaths.get(reference.id)
  if (resolved !== undefined) return { id: reference.id, path: resolved, relativePath: relative(targetDirectory, resolved) }

  const sourceDirectory = locations.sourceDirectory
  if (reference.relativePath === '' || sourceDirectory === undefined) return reference
  const expected = resolve(sourceDirectory, reference.relativePath)
  return { ...reference, relativePath: relative(targetDirectory, expected) }
}

export function withSavedPaths(project: Project, locations: MediaLocations, targetPath: string): Project {
  const targetDirectory = dirname(targetPath)
  const media = project.media.map((reference) => savedReference(reference, locations, targetDirectory))
  return { ...project, media }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function writeAndSync(path: string, text: string): Promise<void> {
  const file = await open(path, 'w')
  try {
    await file.writeFile(text)
    await file.sync()
  } finally {
    await file.close()
  }
}

export async function writeProjectFile(path: string, project: Project): Promise<void> {
  const name = basename(path)
  const text = serializeProject(project)
  const check = parseProject(text)
  if (!check.ok) throw new ProjectFileError(`"${name}" was not saved because the project is not valid: ${check.message}`)

  const directory = dirname(path)
  const temporaryPath = join(directory, `.${name}.saving`)
  try {
    await mkdir(directory, { recursive: true })
    await writeAndSync(temporaryPath, text)
    await rename(temporaryPath, path)
    await syncDirectory(directory)
  } catch (error) {
    await rm(temporaryPath, { force: true })
    throw new ProjectFileError(`"${name}" could not be saved: ${describeError(error)}`, { cause: error })
  }
}
