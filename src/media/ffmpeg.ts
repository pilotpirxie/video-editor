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

type RunOptions = {
  signal?: AbortSignal
  timeoutMs: number
}

type SpawnOptions = {
  signal?: AbortSignal
  extraInputPipes?: number
  isBackground?: boolean
}

export type Job = {
  stdin: Writable
  pipes: Writable[]
  readExact(byteCount: number, timeoutMs: number): Promise<Buffer | undefined>
  readChunk(timeoutMs: number): Promise<Buffer | undefined>
  done: Promise<void>
  kill(): void
}

export type FfmpegRunner = {
  runOnce(binary: Binary, args: readonly string[], options: RunOptions): Promise<Buffer>
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
  exitCode: Promise<number | undefined>
  stderrTail(): string
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

function reportedThroughJob(): void {}

function failureOf(running: RunningProcess, exitCode: number | undefined): FfmpegError {
  const stopReason = running.stopReason()
  if (stopReason !== undefined) return new FfmpegError(`${running.binary} ${stopReason}`, '', exitCode)
  const outcome = exitCode === undefined ? 'was killed' : `exited with code ${exitCode}`
  return new FfmpegError(`${running.binary} ${outcome}`, running.stderrTail(), exitCode)
}

export function writeAll(stream: Writable, data: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(data, (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

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
      stderrText = `${stderrText}${text}`.slice(-STDERR_TAIL_CHARACTERS)
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
