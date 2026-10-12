import type { ExportTarget, LoadedProject, MediaClient, MediaMessage, MediaReply, MediaRequest, RawFrame } from '../shared/mediaProtocol.js'

/** What each request resolves with. */
type Results = {
  loadProject: LoadedProject
  whenPrepared: void
  readImage: ArrayBuffer
  previewFrame: ArrayBuffer | undefined
  fullFrame: RawFrame
  openStream: number
  streamFrame: RawFrame
  closeStream: void
  audio: Float32Array | undefined
  exportStart: number
  exportWrite: void
  exportFinish: void
  exportCancel: void
  writeFile: void
}

type Method = MediaRequest['method']

type Pending = {
  resolve(result: unknown): void
  reject(error: Error): void
}

/** The media process could not do what was asked; the message is its explanation. */
export class MediaRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MediaRequestError'
  }
}

function isReply(value: unknown): value is MediaReply {
  return typeof value === 'object' && value !== null && 'id' in value && typeof value.id === 'number'
}

/** Speaks the media protocol over `port`. Pixel and sample buffers are copied, never transferred. */
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

  function call<Name extends Method>(request: Extract<MediaRequest, { method: Name }>, signal?: AbortSignal): Promise<Results[Name]> {
    const id = nextId
    nextId += 1
    return new Promise<Results[Name]>((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(new DOMException('The request was cancelled', 'AbortError'))
        return
      }
      pending.set(id, {
        // The media process is part of this app: its reply has the shape the request asks for.
        resolve: (result) => resolve(result as Results[Name]),
        reject,
      })
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

  return {
    loadProject: (path, forPreview) => call({ method: 'loadProject', path, forPreview }),
    whenPrepared: () => call({ method: 'whenPrepared' }),
    readImage: (mediaId) => call({ method: 'readImage', mediaId }),
    previewFrame: (mediaId, frame) => call({ method: 'previewFrame', mediaId, frame }),
    fullFrame: (mediaId, frame, halvings, signal) => call({ method: 'fullFrame', mediaId, frame, halvings }, signal),
    openStream: (mediaId, frame, halvings) => call({ method: 'openStream', mediaId, frame, halvings }),
    streamFrame: (streamId, frame) => call({ method: 'streamFrame', streamId, frame }),
    closeStream: (streamId) => call({ method: 'closeStream', streamId }),
    audio: (mediaId, firstSample, sampleCount) => call({ method: 'audio', mediaId, firstSample, sampleCount }),
    exportStart: (target: ExportTarget) => call({ method: 'exportStart', target }),
    exportWrite: (jobId, pixels, audio) => call({ method: 'exportWrite', jobId, pixels, audio }),
    exportFinish: (jobId) => call({ method: 'exportFinish', jobId }),
    exportCancel: (jobId) => call({ method: 'exportCancel', jobId }),
    writeFile: (directory, name, data) => call({ method: 'writeFile', directory, name, data }),
  }
}
