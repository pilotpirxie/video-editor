import { execFileSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { bundledFfmpeg } from '../../test/helpers.js'
import { FfmpegError, createFfmpegRunner, writeAll } from './ffmpeg.js'

const { runOnce, spawnJob } = bundledFfmpeg()

const FRAME_BYTES = 64 * 48 * 4
const TEN_FRAMES = ['-f', 'lavfi', '-i', 'testsrc=size=64x48:rate=10:duration=1', '-pix_fmt', 'rgba', '-f', 'rawvideo', '-']
const ENDLESS_REALTIME = ['-re', '-f', 'lavfi', '-i', 'testsrc=size=64x48:rate=10', '-pix_fmt', 'rgba', '-f', 'rawvideo', '-']
const WAITS_FOR_STDIN = ['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', '64x48', '-i', 'pipe:0', '-f', 'rawvideo', '-']

function runningFfmpegChildren(): number {
  try {
    return execFileSync('pgrep', ['-P', String(process.pid), 'ffmpeg'], { encoding: 'utf8' }).trim().split('\n').length
  } catch {
    return 0
  }
}

async function expectNoChildrenLeft(): Promise<void> {
  for (let attempt = 0; attempt < 50 && runningFfmpegChildren() > 0; attempt++) await sleep(20)
  expect(runningFfmpegChildren()).toBe(0)
}

describe('runOnce', () => {
  it('resolves with stdout', async () => {
    const output = await runOnce('ffmpeg', ['-version'], { timeoutMs: 10_000 })
    expect(output.toString()).toMatch(/^ffmpeg version 9\.0\.2/)
  })

  it('rejects with the last error lines when FFmpeg fails', async () => {
    const failed = runOnce('ffmpeg', ['-i', '/nonexistent/file.mp4', '-f', 'null', '-'], { timeoutMs: 10_000 })
    await expect(failed).rejects.toThrow(FfmpegError)
    await expect(failed).rejects.toThrow(/exited with code \d+: .*No such file or directory/s)
  })

  it('kills a job that exceeds its timeout', async () => {
    const startedAt = Date.now()
    await expect(runOnce('ffmpeg', ENDLESS_REALTIME, { timeoutMs: 300 })).rejects.toThrow(/timed out after 300 ms/)
    expect(Date.now() - startedAt).toBeLessThan(3000)
    await expectNoChildrenLeft()
  })

  it('kills a job when it is cancelled', async () => {
    const controller = new AbortController()
    const pending = runOnce('ffmpeg', ENDLESS_REALTIME, { timeoutMs: 60_000, signal: controller.signal })
    setTimeout(() => controller.abort(), 150)
    await expect(pending).rejects.toThrow(/cancelled/)
    await expectNoChildrenLeft()
  })

  it('rejects at once when the signal is already aborted', async () => {
    await expect(runOnce('ffprobe', ['-i', 'x'], { timeoutMs: 1000, signal: AbortSignal.abort() })).rejects.toThrow(/was cancelled/)
  })

  it('reports a missing binary as a rejection', async () => {
    const misconfigured = createFfmpegRunner('/nonexistent/directory')
    await expect(misconfigured.runOnce('ffmpeg', ['-version'], { timeoutMs: 1000 })).rejects.toThrow(/could not be started/)
  })
})

describe('spawnJob', () => {
  it('streams exact frames, then ends', async () => {
    const job = spawnJob('ffmpeg', TEN_FRAMES)
    for (let frame = 0; frame < 10; frame++) {
      const data = await job.readExact(FRAME_BYTES, 5000)
      expect(data?.length).toBe(FRAME_BYTES)
    }
    expect(await job.readExact(FRAME_BYTES, 5000)).toBeUndefined()
    await expect(job.done).resolves.toBeUndefined()
  })

  it('does not mistake back-pressure for a hang', async () => {
    const job = spawnJob('ffmpeg', ['-f', 'lavfi', '-i', 'testsrc=size=64x48:rate=10:duration=600', '-pix_fmt', 'rgba', '-f', 'rawvideo', '-'])
    expect(await job.readExact(FRAME_BYTES, 5000)).toBeDefined()
    await sleep(700)
    expect(await job.readExact(FRAME_BYTES, 500)).toBeDefined()
    job.kill()
    await expect(job.done).rejects.toThrow(/cancelled/)
  })

  it('times out when FFmpeg stops producing output', async () => {
    const job = spawnJob('ffmpeg', WAITS_FOR_STDIN)
    await expect(job.readExact(FRAME_BYTES, 300)).rejects.toThrow(/produced no output for 300 ms/)
    await expectNoChildrenLeft()
  })

  it('survives FFmpeg being killed from outside mid-job', async () => {
    const job = spawnJob('ffmpeg', ENDLESS_REALTIME)
    expect(await job.readExact(FRAME_BYTES, 5000)).toBeDefined()

    execFileSync('pkill', ['-KILL', '-P', String(process.pid), 'ffmpeg'])

    // Frames already in the pipe are still delivered; after them the failure surfaces.
    const drain = async (): Promise<void> => {
      while ((await job.readExact(FRAME_BYTES, 5000)) !== undefined);
    }
    await expect(drain()).rejects.toThrow(/ffmpeg was killed/)
    await expect(job.done).rejects.toThrow(FfmpegError)
    // Writing into the dead process must fail quietly, never crash the caller.
    await expect(writeAll(job.stdin, Buffer.alloc(FRAME_BYTES))).rejects.toThrow()
    await expect(runOnce('ffmpeg', ['-version'], { timeoutMs: 10_000 })).resolves.toBeInstanceOf(Buffer)
  })

  it('rejects a pending read when the job is cancelled', async () => {
    const controller = new AbortController()
    const job = spawnJob('ffmpeg', WAITS_FOR_STDIN, { signal: controller.signal })
    const pending = job.readExact(FRAME_BYTES, 60_000)
    setTimeout(() => controller.abort(), 100)
    await expect(pending).rejects.toThrow(/cancelled/)
    await expectNoChildrenLeft()
  })

  it('reads a second input from an extra pipe', async () => {
    const job = spawnJob(
      'ffmpeg',
      ['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', '64x48', '-i', 'pipe:3', '-frames:v', '1', '-f', 'rawvideo', '-'],
      { extraInputPipes: 1 },
    )
    const frame = Buffer.alloc(FRAME_BYTES, 0x7f)
    await writeAll(job.pipes[0]!, frame)
    job.pipes[0]!.end()
    expect((await job.readExact(FRAME_BYTES, 5000))?.equals(frame)).toBe(true)
  })
})
