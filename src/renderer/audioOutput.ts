// The system audio output. Only a device here: all mixing happens in the engine worker, which
// talks to the output's audio thread directly, so the UI thread never touches a sample.
import { SAMPLE_RATE } from '../shared/time.js'

export type AudioOutput = {
  /** Direct line to the audio thread; hand it to the engine worker. */
  enginePort: MessagePort
  /** Seconds from handing a sample to the device until it is heard. */
  latency(): number
  resume(): Promise<void>
  /** Stops the audio thread while paused, so an idle editor uses no CPU for sound. */
  suspend(): Promise<void>
}

export async function createAudioOutput(): Promise<AudioOutput> {
  const context = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' })
  await context.audioWorklet.addModule(new URL('./outputWorklet.js', import.meta.url))
  const node = new AudioWorkletNode(context, 'output', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] })
  node.connect(context.destination)

  const channel = new MessageChannel()
  node.port.postMessage(undefined, [channel.port1])
  await context.suspend()

  return {
    enginePort: channel.port2,
    latency: () => context.baseLatency + context.outputLatency,
    resume: () => context.resume(),
    suspend: () => context.suspend(),
  }
}
