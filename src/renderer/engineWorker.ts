import { createEngine, type Engine, type EngineEvent } from '../engine/engine.js'
import { describeError } from '../shared/log.js'
import type { HeadlessJob, JobEvent, LoadedProject } from '../shared/mediaProtocol.js'
import { createMediaClient, type MediaConnection } from './mediaClient.js'

export type WorkerCommand =
  | { type: 'init'; canvas: OffscreenCanvas | undefined }
  | { type: 'media-port' }
  | { type: 'audio-port' }
  | { type: 'load'; path: string }
  | { type: 'project'; loaded: LoadedProject }
  | { type: 'resize'; width: number; height: number }
  | { type: 'whole-canvas'; isShown: boolean }
  | { type: 'seek'; time: number }
  | { type: 'play'; outputLatency: number }
  | { type: 'pause' }
  | { type: 'job'; job: HeadlessJob }
  | { type: 'memory-pressure'; isUnderPressure: boolean }

export type WorkerEvent = EngineEvent | { type: 'job'; event: JobEvent }

const HEADLESS_SURFACE_SIZE = 2

function post(event: WorkerEvent): void {
  postMessage(event)
}

type Startup = {
  canvas: Promise<OffscreenCanvas>
  media: Promise<MediaConnection>
  provideCanvas(canvas: OffscreenCanvas): void
  provideMedia(media: MediaConnection): void
}

function createStartup(): Startup {
  let provideCanvas: (canvas: OffscreenCanvas) => void = () => {}
  let provideMedia: (media: MediaConnection) => void = () => {}
  const canvas = new Promise<OffscreenCanvas>((resolve) => {
    provideCanvas = resolve
  })
  const media = new Promise<MediaConnection>((resolve) => {
    provideMedia = resolve
  })
  return { canvas, media, provideCanvas, provideMedia }
}

async function runJob(engine: Engine, job: HeadlessJob): Promise<void> {
  try {
    await engine.load(job.projectPath, false)
    const summary =
      job.kind === 'export'
        ? await engine.exportMedia(job, (done, total) => post({ type: 'job', event: { type: 'progress', done, total } }))
        : await engine.renderFrames(job)
    post({ type: 'job', event: { type: 'done', summary } })
  } catch (error) {
    post({ type: 'job', event: { type: 'error', message: describeError(error) } })
  }
}

async function handle(engine: Engine, command: WorkerCommand, ports: readonly MessagePort[]): Promise<void> {
  if (command.type === 'load') {
    await engine.load(command.path, true)
  } else if (command.type === 'project') {
    engine.setProject(command.loaded)
  } else if (command.type === 'resize') {
    engine.setOutputSize({ width: command.width, height: command.height })
  } else if (command.type === 'whole-canvas') {
    engine.showWholeCanvasWhenPaused(command.isShown)
  } else if (command.type === 'seek') {
    engine.seek(command.time)
  } else if (command.type === 'play') {
    engine.play(command.outputLatency)
  } else if (command.type === 'pause') {
    engine.pause()
  } else if (command.type === 'job') {
    await runJob(engine, command.job)
  } else if (command.type === 'audio-port') {
    const port = ports[0]
    if (port !== undefined) engine.attachAudio(port)
  } else if (command.type === 'memory-pressure') {
    engine.setUnderPressure(command.isUnderPressure)
  }
}

async function createEngineWhenReady(startup: Startup): Promise<Engine> {
  const [canvas, media] = await Promise.all([startup.canvas, startup.media])
  return createEngine(media, canvas, post)
}

function start(): void {
  const startup = createStartup()
  const engineReady = createEngineWhenReady(startup)
  let media: MediaConnection | undefined

  addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    event.preventDefault()
    post({ type: 'error', message: describeError(event.reason) })
  })

  async function dispatch(command: WorkerCommand, ports: readonly MessagePort[]): Promise<void> {
    try {
      await handle(await engineReady, command, ports)
    } catch (error) {
      post({ type: 'error', message: describeError(error) })
    }
  }

  addEventListener('message', (event: MessageEvent<WorkerCommand>) => {
    const command = event.data
    if (command.type === 'init') {
      startup.provideCanvas(command.canvas ?? new OffscreenCanvas(HEADLESS_SURFACE_SIZE, HEADLESS_SURFACE_SIZE))
    } else if (command.type === 'media-port') {
      const port = event.ports[0]
      if (port === undefined) return
      if (media === undefined) {
        media = createMediaClient(port)
        startup.provideMedia(media)
      } else {
        media.reconnect(port)
      }
    } else {
      void dispatch(command, event.ports)
    }
  })
}

start()
