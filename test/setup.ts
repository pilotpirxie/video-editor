import { execFileSync } from 'node:child_process'
import { bundledFfmpeg } from './helpers.js'
import { generateTestMedia } from './media/generate.js'

export default async function setup(): Promise<void> {
  execFileSync(process.execPath, ['scripts/fetch-ffmpeg.mjs'], { stdio: 'inherit' })
  await generateTestMedia(bundledFfmpeg())
}
