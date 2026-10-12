import { createRoot } from 'react-dom/client'
import { Harness } from './Harness.js'
import { startEngine } from './engineHost.js'

const HEADLESS_MODE = 'headless'

class PageError extends Error {}

function runHeadless(): void {
  const engine = startEngine(undefined)
  engine.onEvent((event) => {
    if (event.type === 'job') window.host.reportJobEvent(event.event)
    if (event.type === 'error') window.host.reportJobEvent({ type: 'error', message: event.message })
  })
  window.host.onCommand((command) => {
    if (command.type === 'run-job') engine.send({ type: 'job', job: command.job })
  })
}

function runHarness(): void {
  const container = document.getElementById('root')
  if (container === null) throw new PageError('The page has no root element')
  createRoot(container).render(<Harness />)
}

if (new URLSearchParams(location.search).get('mode') === HEADLESS_MODE) {
  runHeadless()
} else {
  runHarness()
}
