import type { Host } from '../shared/mediaProtocol.js'
import type { WorkerCommand, WorkerEvent } from './engineWorker.js'

declare global {
  interface Window {
    host: Host
  }
}

export type EngineHost = {
  send(command: WorkerCommand, transfer?: Transferable[]): void
  onEvent(listener: (event: WorkerEvent) => void): () => void
}

function isMediaPortMessage(event: MessageEvent<unknown>): boolean {
  const data = event.data
  return typeof data === 'object' && data !== null && 'type' in data && data.type === 'media-port'
}

export function startEngine(canvas: HTMLCanvasElement | undefined): EngineHost {
  const worker = new Worker(new URL('./engineWorker.ts', import.meta.url), { type: 'module' })

  function send(command: WorkerCommand, transfer: Transferable[] = []): void {
    worker.postMessage(command, transfer)
  }

  window.addEventListener('message', (event: MessageEvent<unknown>) => {
    if (event.source === window && isMediaPortMessage(event)) send({ type: 'media-port' }, [...event.ports])
  })

  const offscreen = canvas?.transferControlToOffscreen()
  send({ type: 'init', canvas: offscreen }, offscreen === undefined ? [] : [offscreen])

  function onEvent(listener: (event: WorkerEvent) => void): () => void {
    function forward(event: MessageEvent<WorkerEvent>): void {
      listener(event.data)
    }
    worker.addEventListener('message', forward)
    return () => worker.removeEventListener('message', forward)
  }

  return { send, onEvent }
}
