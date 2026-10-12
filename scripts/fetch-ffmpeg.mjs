import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE_URL = 'https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2'
const BINARIES = [
  { name: 'ffmpeg', sha256: 'c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924' },
  { name: 'ffprobe', sha256: 'fcbe839537485eaee7a7a8bc5cbc0f90d53617e80943e8a5b2e31cb851197ea6' },
]

const vendorDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'vendor', 'ffmpeg')
const markerPath = join(vendorDir, 'PINNED')
const pinned = BINARIES.map((binary) => `${binary.name} ${binary.sha256}`).join('\n')

const isInstalled =
  existsSync(markerPath) &&
  readFileSync(markerPath, 'utf8') === pinned &&
  BINARIES.every((binary) => existsSync(join(vendorDir, binary.name)))

if (isInstalled) process.exit(0)

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  console.error(`fetch-ffmpeg: only macOS arm64 is supported, this is ${process.platform} ${process.arch}`)
  process.exit(1)
}

mkdirSync(vendorDir, { recursive: true })

for (const binary of BINARIES) {
  const url = `${BASE_URL}/${binary.name}.zip`
  console.log(`fetch-ffmpeg: downloading ${url}`)
  const response = await fetch(url)
  if (!response.ok) {
    console.error(`fetch-ffmpeg: ${url} answered ${response.status} ${response.statusText}`)
    process.exit(1)
  }
  const archive = Buffer.from(await response.arrayBuffer())
  const actualSha256 = createHash('sha256').update(archive).digest('hex')
  if (actualSha256 !== binary.sha256) {
    console.error(`fetch-ffmpeg: checksum mismatch for ${binary.name}.zip\n  expected ${binary.sha256}\n  actual   ${actualSha256}`)
    process.exit(1)
  }

  const archivePath = join(vendorDir, `${binary.name}.zip`)
  const binaryPath = join(vendorDir, binary.name)
  writeFileSync(archivePath, archive)
  execFileSync('/usr/bin/unzip', ['-o', '-q', archivePath, binary.name, '-d', vendorDir])
  rmSync(archivePath)
  chmodSync(binaryPath, 0o755)

  const versionLine = execFileSync(binaryPath, ['-version'], { encoding: 'utf8' }).split('\n')[0]
  console.log(`fetch-ffmpeg: ${versionLine}`)
}

writeFileSync(markerPath, pinned)
