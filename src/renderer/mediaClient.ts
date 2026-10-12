import type { LoadedProject, MediaClient, MediaMessage, MediaReply, MediaRequest, RawFrame } from '../shared/mediaProtocol.js'

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

function unexpectedAnswer(request: MediaRequest): MediaRequestError {
  return new MediaRequestError(`The media process gave an unexpected answer to ${request.method}`)
}

export function createMediaClient(port: MessagePort): MediaClient {
  const pending = new Map<number, Pending>()
  let nextId = 1

  port.onmessage = (event: MessageEvent<unknown>): void => {
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

  function call(request: MediaRequest, signal?: AbortSignal): Promise<unknown> {
    const id = nextId
    nextId += 1
    return new Promise<unknown>((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(new DOMException('The request was cancelled', 'AbortError'))
        return
      }
      pending.set(id, { resolve, reject })
      signal?.addEventListener(
        'abort',
        () => {
          if (!pending.delete(id)) return
          const abort: MediaMessage = { abort: id }
          port.postMessage(abort)
          reject(new DOMException('The request was cancelled', 'AbortError'))
        },
        { once: true },
      )
      const message: MediaMessage = { id, request }
      port.postMessage(message)
    })
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
    openStream: (mediaId, frame, halvings) => callForNumber({ method: 'openStream', mediaId, frame, halvings }),
    streamFrame: (streamId, frame) => callForFrame({ method: 'streamFrame', streamId, frame }),
    closeStream: (streamId) => callForNothing({ method: 'closeStream', streamId }),
    async audio(mediaId, firstSample, sampleCount) {
      const request: MediaRequest = { method: 'audio', mediaId, firstSample, sampleCount }
      const answer = await call(request)
      if (answer !== undefined && !(answer instanceof Float32Array)) throw unexpectedAnswer(request)
      return answer
    },
    exportStart: (target) => callForNumber({ method: 'exportStart', target }),
    exportWrite: (jobId, pixels, audio) => callForNothing({ method: 'exportWrite', jobId, pixels, audio }),
    exportFinish: (jobId) => callForNothing({ method: 'exportFinish', jobId }),
    exportCancel: (jobId) => callForNothing({ method: 'exportCancel', jobId }),
    writeFile: (directory, name, data) => callForNothing({ method: 'writeFile', directory, name, data }),
  }
}
