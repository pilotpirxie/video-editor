import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SOURCES = [
  {
    name: 'zimg',
    archive: 'zimg-3.0.6.tar.gz',
    url: 'https://github.com/sekrit-twc/zimg/archive/refs/tags/release-3.0.6.tar.gz',
    sha256: 'be89390f13a5c9b2388ce0f44a5e89364a20c1c57ce46d382b1fcc3967057577',
    licenses: ['COPYING'],
  },
  {
    name: 'opus',
    archive: 'opus-1.6.1.tar.gz',
    url: 'https://ftp.osuosl.org/pub/xiph/releases/opus/opus-1.6.1.tar.gz',
    sha256: '6ffcb593207be92584df15b32466ed64bbec99109f007c82205f0194572411a1',
    licenses: ['COPYING'],
  },
  {
    name: 'lame',
    archive: 'lame-4.0.tar.gz',
    url: 'https://downloads.sourceforge.net/project/lame/lame/4.0/lame-4.0.tar.gz',
    sha256: '3df5124d5ad3a98312ffd7ba6a9b36230e4f8a3e66d3ce0f425e336c32d216eb',
    licenses: ['COPYING'],
  },
  {
    name: 'libvpx',
    archive: 'libvpx-1.17.0.tar.gz',
    url: 'https://github.com/webmproject/libvpx/archive/refs/tags/v1.17.0.tar.gz',
    sha256: '1020f184046187baa2985dbde38e0691f49c44088bca7a1842b0236c6081dc0a',
    licenses: ['LICENSE', 'PATENTS'],
  },
  {
    name: 'libwebp',
    archive: 'libwebp-1.6.0.tar.gz',
    url: 'https://storage.googleapis.com/downloads.webmproject.org/releases/webp/libwebp-1.6.0.tar.gz',
    sha256: 'e4ab7009bf0629fd11982d4c2aa83964cf244cffba7347ecd39019a9e38c4564',
    licenses: ['COPYING', 'PATENTS'],
  },
  {
    name: 'dav1d',
    archive: 'dav1d-1.5.4.tar.xz',
    url: 'https://downloads.videolan.org/pub/videolan/dav1d/1.5.4/dav1d-1.5.4.tar.xz',
    sha256: '686616b7c69eb88d44459391ab25cac13b6647a3b288835c5784e71c1514a5c5',
    licenses: ['COPYING'],
  },
  {
    name: 'ffmpeg',
    archive: 'ffmpeg-9.0.2.tar.xz',
    url: 'https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz',
    sha256: '8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e',
    licenses: ['COPYING.LGPLv2.1', 'LICENSE.md'],
  },
]

const APP_ENCODERS = ['h264_videotoolbox', 'aac_at', 'libvpx_vp9', 'libopus', 'libmp3lame', 'gif', 'png', 'mjpeg', 'pcm_s16le', 'pcm_f32le', 'rawvideo', 'wrapped_avframe']
const TEST_MEDIA_ENCODERS = ['hevc_videotoolbox', 'prores_videotoolbox', 'libvpx_vp8', 'vorbis', 'flac', 'alac', 'pcm_s16be', 'apng', 'libwebp', 'libwebp_anim']
const DISABLED_DECODERS = ['aac', 'aac_fixed', 'aac_latm', 'ac3', 'ac3_fixed', 'eac3', 'vvc']
const MINIMUM_MACOS = '15.0'
const LIBVPX_TARGET = 'arm64-darwin24-gcc'
const BUILD_TOOLS = ['make', 'pkg-config', 'cmake', 'meson', 'ninja', 'autoreconf', 'glibtoolize']

const scriptPath = fileURLToPath(import.meta.url)
const rootDir = join(dirname(scriptPath), '..')
const vendorDir = join(rootDir, 'vendor', 'ffmpeg')
const sourcesDir = join(rootDir, 'vendor', 'ffmpeg-sources')
const buildDir = join(rootDir, 'vendor', 'ffmpeg-build')
const prefix = join(buildDir, 'prefix')
const licensesDir = join(buildDir, 'licenses')
const markerPath = join(vendorDir, 'PINNED')
const pinned = createHash('sha256').update(readFileSync(scriptPath)).digest('hex')
const jobs = String(availableParallelism())

const isInstalled = existsSync(markerPath) && readFileSync(markerPath, 'utf8') === pinned && existsSync(join(vendorDir, 'ffmpeg')) && existsSync(join(vendorDir, 'ffprobe'))
if (isInstalled) process.exit(0)

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  console.error(`build-ffmpeg: only macOS arm64 is supported, this is ${process.platform} ${process.arch}`)
  process.exit(1)
}

const missingTools = BUILD_TOOLS.filter((tool) => spawnSync('/usr/bin/which', [tool]).status !== 0)
if (missingTools.length > 0) {
  console.error(`build-ffmpeg: missing ${missingTools.join(', ')}. Install the Xcode Command Line Tools and run: brew install pkgconf cmake meson ninja autoconf automake libtool`)
  process.exit(1)
}

const buildEnv = {
  ...process.env,
  MACOSX_DEPLOYMENT_TARGET: MINIMUM_MACOS,
  PKG_CONFIG_LIBDIR: join(prefix, 'lib', 'pkgconfig'),
  PKG_CONFIG_PATH: '',
  LIBTOOLIZE: 'glibtoolize',
}

function run(command, args, cwd) {
  console.log(`build-ffmpeg: ${command} ${args.join(' ')}`)
  execFileSync(command, args, { cwd, env: buildEnv, stdio: 'inherit' })
}

async function downloaded(source) {
  const archivePath = join(sourcesDir, source.archive)
  if (existsSync(archivePath) && sha256Of(readFileSync(archivePath)) === source.sha256) return archivePath
  console.log(`build-ffmpeg: downloading ${source.url}`)
  const response = await fetch(source.url)
  if (!response.ok) throw new Error(`${source.url} answered ${response.status} ${response.statusText}`)
  const archive = Buffer.from(await response.arrayBuffer())
  const actualSha256 = sha256Of(archive)
  if (actualSha256 !== source.sha256) throw new Error(`checksum mismatch for ${source.url}\n  expected ${source.sha256}\n  actual   ${actualSha256}`)
  writeFileSync(archivePath, archive)
  return archivePath
}

function sha256Of(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function unpacked(source, archivePath) {
  const sourceDir = join(buildDir, source.name)
  mkdirSync(sourceDir, { recursive: true })
  run('/usr/bin/tar', ['-xf', archivePath, '-C', sourceDir, '--strip-components', '1'], buildDir)
  return sourceDir
}

const STATIC_CONFIGURE = [`--prefix=${prefix}`, '--disable-shared', '--enable-static']

function buildZimg(dir) {
  run('./autogen.sh', [], dir)
  run('./configure', STATIC_CONFIGURE, dir)
  run('make', ['-j', jobs, 'install'], dir)
}

function buildOpus(dir) {
  run('./configure', [...STATIC_CONFIGURE, '--disable-doc', '--disable-extra-programs'], dir)
  run('make', ['-j', jobs, 'install'], dir)
}

// LAME still calls undeclared ID3 functions, which do not compile as C23.
function buildLame(dir) {
  run('./configure', [...STATIC_CONFIGURE, '--disable-frontend', '--disable-decoder', '--disable-debug', 'ac_cv_prog_cc_c23=no', 'CFLAGS=-O2 -Wno-implicit-function-declaration'], dir)
  run('make', ['-j', jobs, 'install'], dir)
}

function buildLibvpx(dir) {
  const args = ['--disable-examples', '--disable-tools', '--disable-docs', '--disable-unit-tests', '--enable-pic', '--enable-vp9-highbitdepth', `--target=${LIBVPX_TARGET}`]
  run('./configure', [...STATIC_CONFIGURE, ...args], dir)
  run('make', ['-j', jobs, 'install'], dir)
}

function buildLibwebp(dir) {
  const tools = ['ANIM_UTILS', 'CWEBP', 'DWEBP', 'GIF2WEBP', 'IMG2WEBP', 'VWEBP', 'WEBPINFO', 'WEBPMUX', 'EXTRAS'].map((tool) => `-DWEBP_BUILD_${tool}=OFF`)
  run('cmake', ['-S', '.', '-B', 'build', `-DCMAKE_INSTALL_PREFIX=${prefix}`, '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_SHARED_LIBS=OFF', ...tools], dir)
  run('cmake', ['--build', 'build', '--parallel', jobs], dir)
  run('cmake', ['--install', 'build'], dir)
}

function buildDav1d(dir) {
  run('meson', ['setup', 'build', `--prefix=${prefix}`, '--libdir=lib', '--buildtype=release', '--default-library=static', '-Denable_tools=false', '-Denable_tests=false'], dir)
  run('ninja', ['-C', 'build', 'install'], dir)
}

// Autodetection would link whatever it finds on this Mac; every library the binaries use is named instead.
function buildFfmpeg(dir) {
  const libraries = ['audiotoolbox', 'videotoolbox', 'zlib', 'bzlib', 'libzimg', 'libdav1d', 'libvpx', 'libopus', 'libmp3lame', 'libwebp'].map((library) => `--enable-${library}`)
  run('./configure', [
    `--prefix=${prefix}`,
    '--pkg-config-flags=--static',
    `--extra-cflags=-I${join(prefix, 'include')}`,
    `--extra-ldflags=-L${join(prefix, 'lib')}`,
    '--disable-autodetect',
    ...libraries,
    '--disable-encoders',
    `--enable-encoder=${[...APP_ENCODERS, ...TEST_MEDIA_ENCODERS].join(',')}`,
    `--disable-decoder=${DISABLED_DECODERS.join(',')}`,
    '--disable-ffplay',
    '--disable-doc',
  ], dir)
  run('make', ['-j', jobs], dir)
}

const BUILDERS = { zimg: buildZimg, opus: buildOpus, lame: buildLame, libvpx: buildLibvpx, libwebp: buildLibwebp, dav1d: buildDav1d, ffmpeg: buildFfmpeg }

rmSync(buildDir, { recursive: true, force: true })
mkdirSync(licensesDir, { recursive: true })
mkdirSync(sourcesDir, { recursive: true })

for (const source of SOURCES) {
  const sourceDir = unpacked(source, await downloaded(source))
  BUILDERS[source.name](sourceDir)
  for (const license of source.licenses) copyFileSync(join(sourceDir, license), join(licensesDir, `${source.name}-${license}.txt`))
}

const ffmpegDir = join(buildDir, 'ffmpeg')
for (const binary of ['ffmpeg', 'ffprobe']) {
  const linked = execFileSync('/usr/bin/otool', ['-L', join(ffmpegDir, binary)], { encoding: 'utf8' })
  const foreignLibraries = linked.split('\n').slice(1).filter((line) => line.trim() !== '' && !line.includes('/usr/lib/') && !line.includes('/System/Library/'))
  if (foreignLibraries.length > 0) throw new Error(`${binary} links libraries that macOS does not have:\n${foreignLibraries.join('\n')}`)
}

rmSync(vendorDir, { recursive: true, force: true })
mkdirSync(vendorDir, { recursive: true })
for (const binary of ['ffmpeg', 'ffprobe']) copyFileSync(join(ffmpegDir, binary), join(vendorDir, binary))
cpSync(licensesDir, join(vendorDir, 'licenses'), { recursive: true })
console.log(`build-ffmpeg: ${execFileSync(join(vendorDir, 'ffmpeg'), ['-version'], { encoding: 'utf8' }).split('\n')[0]}`)
rmSync(buildDir, { recursive: true, force: true })
writeFileSync(markerPath, pinned)
