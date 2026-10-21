import { logError } from '../shared/log.js'
import type { Host } from '../shared/mediaProtocol.js'
import type { WorkerCommand, WorkerEvent } from './engineWorker.js'

declare global {
  interface Window {
    host: Host
  }
}

export type MediaPorts = {
  engine: MessagePort
  ui: MessagePort
}

export type EngineHost = {
  send(command: WorkerCommand, transfer?: Transferable[]): void
  onEvent(listener: (event: WorkerEvent) => void): () => void
  uiMediaPort: Promise<MessagePort>
  onReconnect(listener: (ports: MediaPorts) => void): void
}

function isMediaPortMessage(event: MessageEvent<unknown>): boolean {
  const data = event.data
  return typeof data === 'object' && data !== null && 'type' in data && data.type === 'media-port'
}

export function startEngine(canvas: HTMLCanvasElement | undefined): EngineHost {
  const worker = new Worker(new URL('./engineWorker.ts', import.meta.url), { type: 'module' })
  let hasMediaPorts = false
  let reconnectListener: ((ports: MediaPorts) => void) | undefined
  let waitingPorts: MediaPorts | undefined

  function send(command: WorkerCommand, transfer: Transferable[] = []): void {
    worker.postMessage(command, transfer)
  }

  worker.addEventListener('error', (event) => {
    event.preventDefault()
    logError('The engine failed', new Error(event.message), { file: event.filename, line: event.lineno })
  })

  const uiMediaPort = new Promise<MessagePort>((resolve) => {
    window.addEventListener('message', (event: MessageEvent<unknown>) => {
      if (event.source !== window || !isMediaPortMessage(event)) return
      const [enginePort, uiPort] = event.ports
      if (enginePort === undefined || uiPort === undefined) return
      if (!hasMediaPorts) {
        hasMediaPorts = true
        send({ type: 'media-port' }, [enginePort])
        resolve(uiPort)
        return
      }
      const ports = { engine: enginePort, ui: uiPort }
      if (reconnectListener === undefined) waitingPorts = ports
      else reconnectListener(ports)
    })
  })

  const offscreen = canvas?.transferControlToOffscreen()
  send({ type: 'init', canvas: offscreen }, offscreen === undefined ? [] : [offscreen])

  function onEvent(listener: (event: WorkerEvent) => void): () => void {
    function forward(event: MessageEvent<WorkerEvent>): void {
      listener(event.data)
    }
    function forwardError(event: ErrorEvent): void {
      listener({ type: 'error', message: `The preview stopped working: ${event.message}` })
    }
    function forwardUnreadable(): void {
      listener({ type: 'error', message: 'The preview sent a message that could not be read.' })
    }
    worker.addEventListener('message', forward)
    worker.addEventListener('error', forwardError)
    worker.addEventListener('messageerror', forwardUnreadable)
    return () => {
      worker.removeEventListener('message', forward)
      worker.removeEventListener('error', forwardError)
      worker.removeEventListener('messageerror', forwardUnreadable)
    }
  }

  function onReconnect(listener: (ports: MediaPorts) => void): void {
    reconnectListener = listener
    if (waitingPorts === undefined) return
    const ports = waitingPorts
    waitingPorts = undefined
    listener(ports)
  }

  return { send, onEvent, uiMediaPort, onReconnect }
}
