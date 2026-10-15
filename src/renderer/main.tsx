import { createRoot } from 'react-dom/client'
import { logError } from '../shared/log.js'
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

// An error that no panel caught has emptied the window; the log says what it was.
function logUncaughtError(error: unknown, info: { componentStack?: string }): void {
  logError('The window stopped drawing', error, { componentStack: info.componentStack })
}

function rootContainer(): HTMLElement {
  const container = document.getElementById('root')
  if (container === null) throw new PageError('The page has no root element')
  return container
}

async function runEditor(): Promise<void> {
  // The engine must listen for its media port before the page finishes loading, so it starts before anything is awaited or rendered.
  const preview = document.createElement('canvas')
  preview.dataset.testid = 'preview'
  preview.setAttribute('aria-label', 'Preview')
  const engine = startEngine(preview)
  const media = createMediaClient(await engine.uiMediaPort)
  const session = createSession(engine, media, await window.host.documentInfo())
  engine.onEvent((event) => {
    if (event.type === 'error') session.store.notify(event.message)
  })
  createRoot(rootContainer(), { onUncaughtError: logUncaughtError }).render(<Editor session={session} preview={preview} />)
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
