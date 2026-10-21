import { createRoot } from 'react-dom/client'
import { logError } from '../shared/log.js'
import type { SlowFrame } from '../shared/mediaProtocol.js'
import { createSession } from './document.js'
import { Editor } from './Editor.js'
import { Harness } from './Harness.js'
import { startEngine } from './engineHost.js'
import { createMediaClient } from './mediaClient.js'

class PageError extends Error {}

function runHeadless(): void {
  const engine = startEngine(undefined)
  engine.onEvent((event) => {
    if (event.type === 'job') window.host.reportJobEvent(event.event)
    if (event.type === 'error') window.host.reportJobEvent({ type: 'error', message: event.message })
  })
  window.host.onCommand((command) => {
    if (command.type === 'run-job') engine.send({ type: 'job', job: command.job })
    if (command.type === 'memory-pressure') engine.send({ type: 'memory-pressure', isUnderPressure: command.isUnderPressure })
  })
}

function logUncaughtError(error: unknown, info: { componentStack?: string }): void {
  logError('The window stopped drawing', error, { componentStack: info.componentStack })
}

function rootContainer(): HTMLElement {
  const container = document.getElementById('root')
  if (container === null) throw new PageError('The page has no root element')
  return container
}

function textOf(script: PerformanceEntry, field: string): string {
  if (!(field in script)) return ''
  return String(Reflect.get(script, field))
}

function scriptsOf(entry: PerformanceEntry): SlowFrame['scripts'] {
  if (!('scripts' in entry) || !Array.isArray(entry.scripts)) return []
  const scripts: SlowFrame['scripts'] = []
  for (const script of entry.scripts) {
    if (!(script instanceof PerformanceEntry)) continue
    scripts.push({
      invoker: textOf(script, 'invoker'),
      functionName: textOf(script, 'sourceFunctionName'),
      sourceUrl: textOf(script, 'sourceURL'),
      durationMs: Math.round(script.duration),
    })
  }
  return scripts
}

function logSlowFrames(): void {
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      const blockingMs = 'blockingDuration' in entry && typeof entry.blockingDuration === 'number' ? entry.blockingDuration : 0
      window.host.reportSlowFrame({ durationMs: Math.round(entry.duration), blockingMs: Math.round(blockingMs), scripts: scriptsOf(entry) })
    }
  }).observe({ type: 'long-animation-frame' })
}

async function runEditor(): Promise<void> {
  // The engine must listen for its media port before the page finishes loading, so it starts before anything is awaited or rendered.
  const preview = document.createElement('canvas')
  preview.dataset.testid = 'preview'
  preview.setAttribute('aria-label', 'Preview')
  const engine = startEngine(preview)
  const media = createMediaClient(await engine.uiMediaPort)
  const [info, settings] = await Promise.all([window.host.documentInfo(), window.host.settings()])
  const session = createSession(engine, media, info, settings)
  engine.onEvent((event) => {
    if (event.type === 'error') session.store.notify(event.message)
  })
  createRoot(rootContainer(), { onUncaughtError: logUncaughtError }).render(<Editor session={session} preview={preview} />)
  logSlowFrames()
  await session.open()
}

async function start(): Promise<void> {
  const mode = new URLSearchParams(location.search).get('mode')
  if (mode === 'headless') {
    runHeadless()
  } else if (mode === 'harness') {
    createRoot(rootContainer()).render(<Harness />)
  } else {
    await runEditor()
  }
}

async function run(): Promise<void> {
  try {
    await start()
  } catch (error) {
    logError('The window could not start', error)
  }
}

void run()
