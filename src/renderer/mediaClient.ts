import type { AddedMedia, LoadedProject, MediaClient, MediaMessage, MediaReply, MediaRequest, MediaState, Preparation, RawFrame, RelinkedMedia, WaveformLevel } from '../shared/mediaProtocol.js'

type Pending = {
  resolve(answer: unknown): void
  reject(error: Error): void
}

class MediaRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MediaRequestError'
  }
}

function isReply(value: unknown): value is MediaReply {
  return typeof value === 'object' && value !== null && 'id' in value && typeof value.id === 'number'
}

function isLoadedProject(value: unknown): value is LoadedProject {
  return typeof value === 'object' && value !== null && 'project' in value && 'media' in value
}

function isRawFrame(value: unknown): value is RawFrame {
  if (typeof value !== 'object' || value === null) return false
  if (!('width' in value) || !('height' in value) || !('data' in value)) return false
  return typeof value.width === 'number' && typeof value.height === 'number' && value.data instanceof ArrayBuffer
}

function isAddedMedia(value: unknown): value is AddedMedia {
  return typeof value === 'object' && value !== null && 'id' in value && typeof value.id === 'string' && 'info' in value
}

function isRelinkedMedia(value: unknown): value is RelinkedMedia[] {
  return Array.isArray(value) && value.every((item) => isAddedMedia(item) && 'path' in item && typeof item.path === 'string')
}

function isMediaStates(value: unknown): value is Record<string, MediaState> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPreparationRecord(value: unknown): value is Record<string, Preparation> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isWaveform(value: unknown): value is WaveformLevel[] {
  return Array.isArray(value) && value.every((level) => typeof level === 'object' && level !== null && 'peaks' in level && level.peaks instanceof Int8Array)
}

function unexpectedAnswer(request: MediaRequest): MediaRequestError {
  return new MediaRequestError(`The media process gave an unexpected answer to ${request.method}`)
}

// A save that takes longer than this has met a media process that hangs; the window is told, so closing it never waits forever.
const SAVE_TIMEOUT_MS = 30_000

export type MediaConnection = MediaClient & {
  // Goes on through the port of a media process that was started again.
  reconnect(port: MessagePort): void
  // Heard when the media process stops; every request until the next port fails at once.
  onClose(listener: () => void): () => void
}

export function createMediaClient(firstPort: MessagePort): MediaConnection {
  const pending = new Map<number, Pending>()
  const closeListeners = new Set<() => void>()
  // Undefined once the media process has stopped, until a port of the next one arrives.
  let port: MessagePort | undefined
  let nextId = 1

  function onReply(event: MessageEvent<unknown>): void {
    const reply = event.data
    if (!isReply(reply)) return
    const waiting = pending.get(reply.id)
    if (waiting === undefined) return
    pending.delete(reply.id)
    if ('error' in reply) {
      waiting.reject(new MediaRequestError(reply.error))
    } else {
      waiting.resolve(reply.result)
    }
  }

  function attach(next: MessagePort): void {
    port = next
    next.onmessage = onReply
    // Without this a request made just before the media process dies would wait forever, and so would Save.
    next.addEventListener('close', () => {
      if (port !== next) return
      port = undefined
      for (const waiting of pending.values()) waiting.reject(new MediaRequestError('The media process stopped.'))
      pending.clear()
      for (const listener of closeListeners) listener()
    })
  }

  attach(firstPort)

  function call(request: MediaRequest, signal?: AbortSignal): Promise<unknown> {
    const id = nextId
    nextId += 1
    return new Promise<unknown>((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(new DOMException('The request was cancelled', 'AbortError'))
        return
      }
      const sendTo = port
      if (sendTo === undefined) {
        reject(new MediaRequestError('The media process stopped.'))
        return
      }
      pending.set(id, { resolve, reject })
      signal?.addEventListener(
        'abort',
        () => {
          if (!pending.delete(id)) return
          const abort: MediaMessage = { abort: id }
          port?.postMessage(abort)
          reject(new DOMException('The request was cancelled', 'AbortError'))
        },
        { once: true },
      )
      const message: MediaMessage = { id, request }
      sendTo.postMessage(message)
    })
  }

  async function callWithin(request: MediaRequest, timeoutMs: number): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new MediaRequestError('The media process did not answer.')), timeoutMs)
    })
    try {
      return await Promise.race([call(request), timedOut])
    } finally {
      clearTimeout(timer)
    }
  }

  async function callForNothing(request: MediaRequest): Promise<void> {
    await call(request)
  }

  async function callForNumber(request: MediaRequest): Promise<number> {
    const answer = await call(request)
    if (typeof answer !== 'number') throw unexpectedAnswer(request)
    return answer
  }

  async function callForFrame(request: MediaRequest, signal?: AbortSignal): Promise<RawFrame> {
    const answer = await call(request, signal)
    if (!isRawFrame(answer)) throw unexpectedAnswer(request)
    return answer
  }

  return {
    async loadProject(path, forPreview) {
      const request: MediaRequest = { method: 'loadProject', path, forPreview }
      const answer = await call(request)
      if (!isLoadedProject(answer)) throw unexpectedAnswer(request)
      return answer
    },
    whenPrepared: () => callForNothing({ method: 'whenPrepared' }),
    async readImage(mediaId) {
      const request: MediaRequest = { method: 'readImage', mediaId }
      const answer = await call(request)
      if (!(answer instanceof ArrayBuffer)) throw unexpectedAnswer(request)
      return answer
    },
    async previewFrame(mediaId, frame) {
      const request: MediaRequest = { method: 'previewFrame', mediaId, frame }
      const answer = await call(request)
      if (answer !== undefined && !(answer instanceof ArrayBuffer)) throw unexpectedAnswer(request)
      return answer
    },
    fullFrame: (mediaId, frame, halvings, signal) => callForFrame({ method: 'fullFrame', mediaId, frame, halvings }, signal),
    keyframeThumbnail: (mediaId, frame, halvings) => callForFrame({ method: 'keyframeThumbnail', mediaId, frame, halvings }),
    openStream: (mediaId, frame, halvings) => callForNumber({ method: 'openStream', mediaId, frame, halvings }),
    streamFrame: (streamId, frame) => callForFrame({ method: 'streamFrame', streamId, frame }),
    closeStream: (streamId) => callForNothing({ method: 'closeStream', streamId }),
    async audio(mediaId, firstSample, sampleCount, stretch) {
      const request: MediaRequest = { method: 'audio', mediaId, firstSample, sampleCount, stretch }
      const answer = await call(request)
      if (answer !== undefined && !(answer instanceof Float32Array)) throw unexpectedAnswer(request)
      return answer
    },
    exportStart: (target) => callForNumber({ method: 'exportStart', target }),
    exportWrite: (jobId, pixels, audio) => callForNothing({ method: 'exportWrite', jobId, pixels, audio }),
    exportFinish: (jobId) => callForNothing({ method: 'exportFinish', jobId }),
    exportCancel: (jobId) => callForNothing({ method: 'exportCancel', jobId }),
    writeFile: (directory, name, data) => callForNothing({ method: 'writeFile', directory, name, data }),
    async addMedia(path) {
      const request: MediaRequest = { method: 'addMedia', path }
      const answer = await call(request)
      if (!isAddedMedia(answer)) throw unexpectedAnswer(request)
      return answer
    },
    async relinkMedia(path, wanted, others) {
      const request: MediaRequest = { method: 'relinkMedia', path, wanted, others: [...others] }
      const answer = await call(request)
      if (!isRelinkedMedia(answer)) throw unexpectedAnswer(request)
      return answer
    },
    async preparation() {
      const request: MediaRequest = { method: 'preparation' }
      const answer = await call(request)
      if (!isPreparationRecord(answer)) throw unexpectedAnswer(request)
      return answer
    },
    async waveform(mediaId) {
      const request: MediaRequest = { method: 'waveform', mediaId }
      const answer = await call(request)
      if (answer !== undefined && !isWaveform(answer)) throw unexpectedAnswer(request)
      return answer
    },
    async saveProject(path, project) {
      await callWithin({ method: 'saveProject', path, project }, SAVE_TIMEOUT_MS)
    },
    want: (wanted) => callForNothing({ method: 'want', wanted }),
    async openMedia(media, projectPath) {
      const request: MediaRequest = { method: 'openMedia', media: [...media], projectPath }
      const answer = await call(request)
      if (!isMediaStates(answer)) throw unexpectedAnswer(request)
      return answer
    },
    reconnect: attach,
    onClose(listener) {
      closeListeners.add(listener)
      return () => closeListeners.delete(listener)
    },
  }
}
