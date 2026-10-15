import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MediaMessage, MediaReply } from '../shared/mediaProtocol.js'
import type { Project } from '../shared/project.js'
import { createMediaClient } from './mediaClient.js'

const PROJECT: Project = { version: 1, canvas: { width: 640, height: 360, frameRate: { num: 30, den: 1 } }, media: [], tracks: [] }

type FakeMediaProcess = {
  clientPort: MessagePort
  // The requests that arrived, by method.
  methods: string[]
  close(): void
}

// The other end of a port, answering every request but a save, which it never answers when `isSaveIgnored`.
function fakeMediaProcess(isSaveIgnored = false): FakeMediaProcess {
  const channel = new MessageChannel()
  const methods: string[] = []
  channel.port2.onmessage = (event: MessageEvent<MediaMessage>): void => {
    const message = event.data
    if ('abort' in message) return
    methods.push(message.request.method)
    if (message.request.method === 'saveProject' && isSaveIgnored) return
    const reply: MediaReply = { id: message.id, result: message.request.method === 'preparation' ? {} : undefined }
    channel.port2.postMessage(reply)
  }
  return { clientPort: channel.port1, methods, close: () => channel.port2.close() }
}

function untilClosed(client: ReturnType<typeof createMediaClient>): Promise<void> {
  return new Promise((resolve) => client.onClose(resolve))
}

afterEach(() => {
  vi.useRealTimers()
})

describe('createMediaClient', () => {
  it('fails a request that waits when the media process stops, and every request after it at once', async () => {
    const neverSaves = fakeMediaProcess(true)
    const client = createMediaClient(neverSaves.clientPort)
    const waiting = client.saveProject('/tmp/a.json', PROJECT)
    const closed = untilClosed(client)
    neverSaves.close()
    await closed
    await expect(waiting).rejects.toThrow('The media process stopped.')
    await expect(client.preparation()).rejects.toThrow('The media process stopped.')
  })

  it('goes on through the port of the next media process', async () => {
    const first = fakeMediaProcess()
    const client = createMediaClient(first.clientPort)
    const closed = untilClosed(client)
    first.close()
    await closed
    const second = fakeMediaProcess()
    client.reconnect(second.clientPort)
    await expect(client.preparation()).resolves.toEqual({})
    expect(second.methods).toEqual(['preparation'])
    second.close()
  })

  it('gives up on a save the media process never answers', async () => {
    vi.useFakeTimers()
    const hanging = fakeMediaProcess(true)
    const client = createMediaClient(hanging.clientPort)
    const saving = client.saveProject('/tmp/a.json', PROJECT)
    const failure = expect(saving).rejects.toThrow('The media process did not answer.')
    await vi.advanceTimersByTimeAsync(30_000)
    await failure
    hanging.close()
  })
})
