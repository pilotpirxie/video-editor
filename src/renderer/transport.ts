import { describeError, describeErrorAsSentence } from '../shared/log.js'
import { TICKS_PER_SECOND, frameAt } from '../shared/time.js'
import { createAudioOutput, type AudioOutput } from './audioOutput.js'
import type { EngineHost } from './engineHost.js'

const MAX_SHUTTLE_RATE = 8
const MS_PER_SECOND = 1000

export type Position = {
  time: number
  isPlaying: boolean
  droppedFrames: number
  fullQualityMs: number | undefined
  sequence: number
  shuttleRate: number
}

export type TimelineLimits = {
  duration: number
  frameTicks: number
}

export type Transport = {
  position(): Position
  subscribe(listener: () => void): () => void
  toggle(): Promise<void>
  pause(): void
  seek(time: number): void
  shuttle(direction: 1 | -1, limits: TimelineLimits): void
  setOffset(offset: number): void
}

type Shuttle = {
  rate: number
  fromTime: number
  startedAt: number
  limits: TimelineLimits
  shownFrame: number
}

const START_POSITION: Position = { time: 0, isPlaying: false, droppedFrames: 0, fullQualityMs: undefined, sequence: 0, shuttleRate: 0 }

export function createTransport(engine: EngineHost, onError: (message: string) => void): Transport {
  let position = START_POSITION
  let audio: AudioOutput | undefined
  let shuttling: Shuttle | undefined
  let offset = 0
  const listeners = new Set<() => void>()

  function announce(): void {
    for (const listener of listeners) listener()
  }

  async function suspendSound(): Promise<void> {
    try {
      await audio?.suspend()
    } catch (error) {
      onError(`The sound output could not be paused: ${describeError(error)}`)
    }
  }

  engine.onEvent((event) => {
    if (event.type !== 'position') return
    const hasStopped = position.isPlaying && !event.isPlaying
    position = {
      time: event.time - offset,
      isPlaying: event.isPlaying,
      droppedFrames: event.droppedFrames,
      fullQualityMs: event.fullQualityMs,
      sequence: position.sequence + 1,
      shuttleRate: position.shuttleRate,
    }
    if (hasStopped) void suspendSound()
    announce()
  })

  function seekEngine(time: number): void {
    engine.send({ type: 'seek', time: Math.max(0, time + offset) })
  }

  function endShuttle(): void {
    if (shuttling === undefined) return
    shuttling = undefined
    position = { ...position, shuttleRate: 0 }
    announce()
  }

  async function play(): Promise<void> {
    try {
      if (audio === undefined) {
        audio = await createAudioOutput()
        engine.send({ type: 'audio-port' }, [audio.enginePort])
      }
      await audio.resume()
      engine.send({ type: 'play', outputLatency: audio.latency() })
    } catch (error) {
      onError(`The sound output could not be started: ${describeErrorAsSentence(error)} Check the sound output in System Settings, then play again.`)
    }
  }

  function pause(): void {
    endShuttle()
    if (position.isPlaying) engine.send({ type: 'pause' })
  }

  async function toggle(): Promise<void> {
    if (position.isPlaying || shuttling !== undefined) {
      pause()
      return
    }
    await play()
  }

  function showShuttle(active: Shuttle): void {
    if (shuttling !== active) return
    const { duration, frameTicks } = active.limits
    const elapsedSeconds = (performance.now() - active.startedAt) / MS_PER_SECOND
    const wanted = active.fromTime + elapsedSeconds * active.rate * TICKS_PER_SECOND
    const lastFrame = Math.max(0, Math.ceil(duration / frameTicks) - 1)
    const frame = Math.min(lastFrame, Math.max(0, frameAt(wanted, frameTicks)))
    if (frame !== active.shownFrame) {
      active.shownFrame = frame
      seekEngine(frame * frameTicks)
    }
    const hasReachedAnEnd = active.rate < 0 ? frame === 0 : frame === lastFrame
    if (hasReachedAnEnd) {
      endShuttle()
      return
    }
    requestAnimationFrame(() => showShuttle(active))
  }

  function shuttle(direction: 1 | -1, limits: TimelineLimits): void {
    let rate = position.isPlaying ? 1 : 0
    if (shuttling !== undefined) rate = shuttling.rate
    const isSameDirection = Math.sign(rate) === direction
    const next = isSameDirection ? Math.min(MAX_SHUTTLE_RATE, Math.abs(rate) * 2) * direction : direction
    if (next === 1) {
      endShuttle()
      if (!position.isPlaying) void play()
      return
    }

    if (position.isPlaying) engine.send({ type: 'pause' })
    const active: Shuttle = { rate: next, fromTime: position.time, startedAt: performance.now(), limits, shownFrame: frameAt(position.time, limits.frameTicks) }
    shuttling = active
    position = { ...position, shuttleRate: next }
    announce()
    requestAnimationFrame(() => showShuttle(active))
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  return {
    position: () => position,
    subscribe,
    toggle,
    pause,
    seek(time) {
      endShuttle()
      seekEngine(time)
    },
    shuttle,
    setOffset(next) {
      if (next === offset) return
      endShuttle()
      position = { ...position, time: position.time + offset - next, sequence: position.sequence + 1 }
      offset = next
      announce()
    },
  }
}

export function isTypingTarget(target: EventTarget | null): boolean {
  if (target instanceof HTMLInputElement) return target.type !== 'range'
  if (target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement) return true
  return target instanceof HTMLElement && target.isContentEditable
}

export function isModalOpen(): boolean {
  return document.querySelector('dialog:modal') !== null
}

export function isKeyForTheEditor(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || isTypingTarget(event.target) || isModalOpen()) return false
  return !(event.target instanceof Element) || event.target.closest('[role="menu"], [role="listbox"]') === null
}

export function onSpaceKey(handler: () => void): () => void {
  function onKeyDown(event: KeyboardEvent): void {
    if (event.code !== 'Space' || isTypingTarget(event.target)) return
    event.preventDefault()
    handler()
  }
  window.addEventListener('keydown', onKeyDown)
  return () => window.removeEventListener('keydown', onKeyDown)
}
