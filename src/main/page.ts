import { setTimeout as sleep } from 'node:timers/promises'
import type { BrowserWindow } from 'electron'

const POLL_INTERVAL_MS = 50

export class PageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PageError'
  }
}

export type Page = {
  text(testId: string): Promise<string>
  click(testId: string): Promise<void>
  evaluate(script: string): Promise<unknown>
  waitFor(testId: string, check: (text: string) => boolean, timeoutMs: number, what: string): Promise<string>
}

export function selector(testId: string): string {
  return `document.querySelector('[data-testid="${testId}"]')`
}

export function pageOf(window: BrowserWindow): Page {
  function evaluate(script: string): Promise<unknown> {
    return window.webContents.executeJavaScript(script, true)
  }

  async function text(testId: string): Promise<string> {
    const content = await evaluate(`${selector(testId)}?.textContent ?? ''`)
    return typeof content === 'string' ? content : ''
  }

  async function click(testId: string): Promise<void> {
    await evaluate(`${selector(testId)}.click()`)
  }

  async function waitFor(testId: string, check: (content: string) => boolean, timeoutMs: number, what: string): Promise<string> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const content = await text(testId)
      if (check(content)) return content
      if (Date.now() > deadline) throw new PageError(`Timed out waiting for ${what}; ${testId} shows "${content}"`)
      await sleep(POLL_INTERVAL_MS)
    }
  }

  return { text, click, evaluate, waitFor }
}
