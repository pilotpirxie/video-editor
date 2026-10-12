import { spawn, type ChildProcess } from 'node:child_process'
import { constants as osConstants, setPriority } from 'node:os'
import { join } from 'node:path'
import type { Readable, Writable } from 'node:stream'

export type Binary = 'ffmpeg' | 'ffprobe'

const STDERR_TAIL_CHARACTERS = 2048
const QUIET_FLAGS = ['-hide_banner', '-loglevel', 'error']
const FIRST_EXTRA_PIPE = 3

export class FfmpegError extends Error {
  constructor(
    message: string,
    readonly stderrTail: string,
    readonly exitCode: number | undefined,
  ) {
    super(stderrTail === '' ? message : `${message}: ${stderrTail}`)
    this.name = 'FfmpegError'
  }
}

export type RunOptions = {
  signal?: AbortSignal
  /** The whole job must finish within this time. */
  timeoutMs: number
}

export type SpawnOptions = {
  signal?: AbortSignal
  /** Number of extra input pipes, readable by FFmpeg as pipe:3, pipe:4, … */
  extraInputPipes?: number
  /**
   * Runs at low CPU priority: full speed on an idle machine, but it yields to the decodes
   * the user is waiting for. For preparation work.
   */
  isBackground?: boolean
}

export type Job = {
  stdin: Writable
  /** Extra input pipes in order: pipes[0] is pipe:3. */
  pipes: Writable[]
  /**
   * Resolves with exactly `byteCount` bytes of stdout, or undefined once the stream has ended.
   * Rejects when FFmpeg fails, or produces nothing for `timeoutMs` while this read is pending.
   */
  readExact(byteCount: number, timeoutMs: number): Promise<Buffer | undefined>
  /** Resolves with the next stdout chunk of any size, or undefined once the stream has ended. */
  readChunk(timeoutMs: number): Promise<Buffer | undefined>
  /** Resolves when FFmpeg exits cleanly, rejects with the reason otherwise. */
  done: Promise<void>
  kill(): void
}

export type FfmpegRunner = {
  /** Runs a job to completion and resolves with everything it wrote to stdout. */
  runOnce(binary: Binary, args: readonly string[], options: RunOptions): Promise<Buffer>
  /** Starts a streaming job. Unread stdout exerts back-pressure on FFmpeg. */
  spawnJob(binary: Binary, args: readonly string[], options?: SpawnOptions): Job
  killAll(): void
}

type Pipes = {
  stdin: Writable
  stdout: Readable
  stderr: Readable
  extraInputs: Writable[]
}

type RunningProcess = {
  binary: Binary
  pipes: Pipes
  /** Settles when the process has exited and its pipes are closed; undefined when it was killed. */
  exitCode: Promise<number | undefined>
  stderrTail(): string
  /** The reason we stopped it ourselves, if we did. */
  stopReason(): string | undefined
  stop(reason: string): void
  lowerPriority(): void
}

function isWritable(stream: unknown): stream is Writable {
  return typeof stream === 'object' && stream !== null && 'write' in stream
}

function openPipes(child: ChildProcess, binary: Binary): Pipes {
  const { stdin, stdout, stderr } = child
  if (stdin === null || stdout === null || stderr === null) {
    throw new FfmpegError(`${binary} was started without pipes`, '', undefined)
  }
  const extraInputs: Writable[] = []
  for (const stream of child.stdio.slice(FIRST_EXTRA_PIPE)) {
    if (isWritable(stream)) extraInputs.push(stream)
  }
  return { stdin, stdout, stderr, extraInputs }
}

function reportedThroughJob(): void {
  // A killed FFmpeg closes its pipes while we may still be writing, and its exit rejects
  // `done`. Both failures already reach the caller through read() and `done`, so these
  // listeners exist only to keep Node from treating them as uncaught.
}

function failureOf(running: RunningProcess, exitCode: number | undefined): FfmpegError {
  const stopReason = running.stopReason()
  if (stopReason !== undefined) return new FfmpegError(`${running.binary} ${stopReason}`, '', exitCode)
  const outcome = exitCode === undefined ? 'was killed' : `exited with code ${exitCode}`
  return new FfmpegError(`${running.binary} ${outcome}`, running.stderrTail(), exitCode)
}

/** Writes one buffer and resolves once FFmpeg has taken it, so callers are paced by the encoder. */
export function writeAll(stream: Writable, data: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(data, (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

/** Creates the one place that starts FFmpeg and FFprobe processes from `binaryDirectory`. */
export function createFfmpegRunner(binaryDirectory: string): FfmpegRunner {
  const children = new Set<ChildProcess>()

  function start(binary: Binary, args: readonly string[], extraInputPipes: number, signal: AbortSignal | undefined): RunningProcess {
    const stdio = Array<'pipe'>(FIRST_EXTRA_PIPE + extraInputPipes).fill('pipe')
    const child = spawn(join(binaryDirectory, binary), [...QUIET_FLAGS, ...args], { stdio })
    children.add(child)

    const pipes = openPipes(child, binary)
    let stderrText = ''
    let stopReason: string | undefined

    pipes.stderr.setEncoding('utf8')
    pipes.stderr.on('data', (text: string) => {
      stderrText = (stderrText + text).slice(-STDERR_TAIL_CHARACTERS)
    })
    for (const stream of [pipes.stdin, pipes.stdout, pipes.stderr, ...pipes.extraInputs]) {
      stream.on('error', reportedThroughJob)
    }

    function stop(reason: string): void {
      if (stopReason !== undefined) return
      stopReason = reason
      child.kill('SIGKILL')
    }

    const exitCode = new Promise<number | undefined>((resolve) => {
      child.on('error', (error) => {
        stopReason ??= `could not be started: ${error.message}`
        children.delete(child)
        resolve(undefined)
      })
      child.on('close', (code) => {
        children.delete(child)
        resolve(code ?? undefined)
      })
    })

    if (signal?.aborted === true) stop('was cancelled')
    signal?.addEventListener('abort', () => stop('was cancelled'), { once: true })

    function lowerPriority(): void {
      if (child.pid === undefined) return
      try {
        setPriority(child.pid, osConstants.priority.PRIORITY_LOW)
      } catch (error) {
        // The process can exit before its priority is set; a job that already ended needs none.
        if (child.exitCode === null && child.signalCode === null) throw error
      }
    }

    return { binary, pipes, exitCode, stderrTail: () => stderrText.trim(), stopReason: () => stopReason, stop, lowerPriority }
  }

  async function runOnce(binary: Binary, args: readonly string[], options: RunOptions): Promise<Buffer> {
    const running = start(binary, args, 0, options.signal)
    const timer = setTimeout(() => running.stop(`timed out after ${options.timeoutMs} ms`), options.timeoutMs)

    const chunks: Buffer[] = []
    running.pipes.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    running.pipes.stdin.end()

    const exitCode = await running.exitCode
    clearTimeout(timer)
    if (exitCode !== 0 || running.stopReason() !== undefined) throw failureOf(running, exitCode)
    return Buffer.concat(chunks)
  }

  function spawnJob(binary: Binary, args: readonly string[], options: SpawnOptions = {}): Job {
    const running = start(binary, args, options.extraInputPipes ?? 0, options.signal)
    if (options.isBackground === true) running.lowerPriority()
    const stdout = running.pipes.stdout

    // stdout stays paused unless a read is waiting, so unread output backs up into FFmpeg.
    // (Node's 'readable' event is not usable here: with a partial unit buffered it fires
    // again on every subscription and spins the process.)
    const buffered: Buffer[] = []
    let bufferedBytes = 0
    let hasEnded = false
    let wakeReader: (() => void) | undefined

    stdout.pause()
    stdout.on('data', (chunk: Buffer) => {
      buffered.push(chunk)
      bufferedBytes += chunk.length
      wakeReader?.()
    })
    function markEnded(): void {
      hasEnded = true
      wakeReader?.()
    }
    stdout.on('end', markEnded)
    stdout.on('close', markEnded)

    async function waitUntilDone(): Promise<void> {
      const exitCode = await running.exitCode
      if (exitCode !== 0 || running.stopReason() !== undefined) throw failureOf(running, exitCode)
    }
    const done = waitUntilDone()
    done.catch(reportedThroughJob)

    function waitForOutput(timeoutMs: number): Promise<void> {
      return new Promise((resolve) => {
        const timer = setTimeout(() => running.stop(`produced no output for ${timeoutMs} ms`), timeoutMs)
        wakeReader = (): void => {
          clearTimeout(timer)
          wakeReader = undefined
          stdout.pause()
          resolve()
        }
        stdout.resume()
      })
    }

    /** Removes exactly `byteCount` buffered bytes into one buffer that owns its memory. */
    function take(byteCount: number): Buffer {
      const unit = Buffer.allocUnsafeSlow(byteCount)
      let filled = 0
      while (filled < byteCount) {
        const head = buffered[0]
        if (head === undefined) break
        const wanted = byteCount - filled
        if (head.length <= wanted) {
          head.copy(unit, filled)
          filled += head.length
          buffered.shift()
        } else {
          head.copy(unit, filled, 0, wanted)
          buffered[0] = head.subarray(wanted)
          filled = byteCount
        }
      }
      bufferedBytes -= byteCount
      return unit
    }

    async function read(byteCount: number | undefined, timeoutMs: number): Promise<Buffer | undefined> {
      const needed = byteCount ?? 1
      while (bufferedBytes < needed && !hasEnded) {
        await waitForOutput(timeoutMs)
      }
      if (bufferedBytes >= needed) return take(byteCount ?? bufferedBytes)
      // The stream ended, possibly inside a unit; a failure surfaces here.
      await done
      return undefined
    }

    return {
      stdin: running.pipes.stdin,
      pipes: running.pipes.extraInputs,
      readExact: (byteCount, timeoutMs) => read(byteCount, timeoutMs),
      readChunk: (timeoutMs) => read(undefined, timeoutMs),
      done,
      kill: () => running.stop('was cancelled'),
    }
  }

  function killAll(): void {
    for (const child of children) child.kill('SIGKILL')
  }

  return { runOnce, spawnJob, killAll }
}
