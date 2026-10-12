// Measures the memory of the whole editor: every Electron process plus the FFmpeg processes
// they start. Uses the physical footprint, the figure Activity Monitor shows as "Memory".
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const runTool = promisify(execFile)
const SAMPLE_INTERVAL_MS = 1000
const FOOTPRINT_LINE = /\[(?<pid>\d+)\]: .*Footprint: (?<bytes>\d+) B/g

export type MemoryMonitor = {
  /** Stops sampling and returns the largest total seen, in bytes. */
  stop(): Promise<number>
}

/** Ids of `rootPid` and every process descended from it. */
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
    const result = await runTool('/usr/bin/footprint', ['--noCategories', '-f', 'bytes', ...pids.map(String)])
    stdout = result.stdout
  } catch (error) {
    // The tool exits with an error when one of the processes ended while it was looking;
    // what it printed about the others still counts.
    const partial = error instanceof Error && 'stdout' in error ? error.stdout : ''
    stdout = typeof partial === 'string' ? partial : ''
  }
  let total = 0
  for (const match of stdout.matchAll(FOOTPRINT_LINE)) total += Number(match.groups?.bytes ?? 0)
  return total
}

export function startMemoryMonitor(rootPid: number): MemoryMonitor {
  let peak = 0
  let isSampling = false

  async function sample(): Promise<void> {
    if (isSampling) return
    isSampling = true
    try {
      peak = Math.max(peak, await footprintOf(await processTree(rootPid)))
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
