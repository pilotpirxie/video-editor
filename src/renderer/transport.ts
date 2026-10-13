import { describeError } from '../shared/log.js'
import { createAudioOutput, type AudioOutput } from './audioOutput.js'
import type { EngineHost } from './engineHost.js'

export type Position = {
  time: number
  isPlaying: boolean
  droppedFrames: number
  fullQualityMs: number | undefined
  sequence: number
}

export type Transport = {
  position(): Position
  subscribe(listener: () => void): () => void
  toggle(): Promise<void>
  seek(time: number): void
}

const START_POSITION: Position = { time: 0, isPlaying: false, droppedFrames: 0, fullQualityMs: undefined, sequence: 0 }

export function createTransport(engine: EngineHost, onError: (message: string) => void): Transport {
  let position = START_POSITION
  let audio: AudioOutput | undefined
  const listeners = new Set<() => void>()

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
      time: event.time,
      isPlaying: event.isPlaying,
      droppedFrames: event.droppedFrames,
      fullQualityMs: event.fullQualityMs,
      sequence: position.sequence + 1,
    }
    if (hasStopped) void suspendSound()
    for (const listener of listeners) listener()
  })

  async function toggle(): Promise<void> {
    if (position.isPlaying) {
      engine.send({ type: 'pause' })
      return
    }
    try {
      if (audio === undefined) {
        audio = await createAudioOutput()
        engine.send({ type: 'audio-port' }, [audio.enginePort])
      }
      await audio.resume()
      engine.send({ type: 'play', outputLatency: audio.latency() })
    } catch (error) {
      onError(`The sound output could not be started: ${describeError(error)}`)
    }
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  return {
    position: () => position,
    subscribe,
    toggle,
    seek: (time) => engine.send({ type: 'seek', time }),
  }
}

export function isTypingTarget(target: EventTarget | null): boolean {
  if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement) return true
  return target instanceof HTMLElement && target.isContentEditable
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
