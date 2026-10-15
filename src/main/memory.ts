import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const runTool = promisify(execFile)
const SAMPLE_INTERVAL_MS = 1000
const SECONDS_PER_MINUTE = 60
const FOOTPRINT_LINE = /\[(?<pid>\d+)\]: .*Footprint: (?<bytes>\d+) B/g
// macOS rates its memory pressure 1 (normal), 2 (warning) or 4 (critical).
const WARNING_PRESSURE_LEVEL = 2

export type MemoryMonitor = {
  stop(): Promise<number>
}

async function processTree(rootPid: number): Promise<number[]> {
  const { stdout } = await runTool('/bin/ps', ['-axo', 'pid=,ppid='])
  const childrenOf = new Map<number, number[]>()
  for (const line of stdout.trim().split('\n')) {
    const [pidText, parentText] = line.trim().split(/\s+/)
    const pid = Number(pidText)
    const parent = Number(parentText)
    const siblings = childrenOf.get(parent) ?? []
    siblings.push(pid)
    childrenOf.set(parent, siblings)
  }

  const tree: number[] = []
  const queue = [rootPid]
  for (const pid of queue) {
    tree.push(pid)
    queue.push(...(childrenOf.get(pid) ?? []))
  }
  return tree
}

async function footprintOf(pids: readonly number[]): Promise<number> {
  let stdout: string
  try {
    const footprint = await runTool('/usr/bin/footprint', ['--noCategories', '-f', 'bytes', ...pids.map(String)])
    stdout = footprint.stdout
  } catch (error) {
    const partial = error instanceof Error && 'stdout' in error ? error.stdout : ''
    stdout = typeof partial === 'string' ? partial : ''
  }
  let total = 0
  for (const match of stdout.matchAll(FOOTPRINT_LINE)) total += Number(match.groups?.bytes ?? 0)
  return total
}

// The memory the app and every process it started use together, in bytes.
export async function footprintNow(rootPid: number): Promise<number> {
  return footprintOf(await processTree(rootPid))
}

// "1:02.50" or "1:00:02.50" as seconds.
function secondsOfCpuTime(text: string): number {
  let seconds = 0
  for (const part of text.split(':')) seconds = seconds * SECONDS_PER_MINUTE + Number(part)
  return seconds
}

// Whether macOS says memory is short, by the same measure as the Activity Monitor's memory pressure graph.
export async function isMemoryUnderPressure(): Promise<boolean> {
  const { stdout } = await runTool('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'])
  return Number(stdout.trim()) >= WARNING_PRESSURE_LEVEL
}

// The processor time the app and every process it started have used so far, in seconds; a process that ended since is no longer counted.
export async function cpuSecondsOf(rootPid: number): Promise<number> {
  const tree = new Set(await processTree(rootPid))
  const { stdout } = await runTool('/bin/ps', ['-axo', 'pid=,time='])
  let total = 0
  for (const line of stdout.trim().split('\n')) {
    const [pidText, timeText] = line.trim().split(/\s+/)
    if (tree.has(Number(pidText)) && timeText !== undefined) total += secondsOfCpuTime(timeText)
  }
  return total
}

export function startMemoryMonitor(rootPid: number): MemoryMonitor {
  let peak = 0
  let isSampling = false

  async function sample(): Promise<void> {
    if (isSampling) return
    isSampling = true
    try {
      peak = Math.max(peak, await footprintNow(rootPid))
    } finally {
      isSampling = false
    }
  }

  const timer = setInterval(() => void sample(), SAMPLE_INTERVAL_MS)
  void sample()

  async function stop(): Promise<number> {
    clearInterval(timer)
    await sample()
    return peak
  }

  return { stop }
}
