import { SAMPLE_RATE } from '../shared/time.js'

export type AudioOutput = {
  enginePort: MessagePort
  latency(): number
  resume(): Promise<void>
  suspend(): Promise<void>
}

export async function createAudioOutput(): Promise<AudioOutput> {
  const context = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' })
  const channel = new MessageChannel()
  try {
    await context.audioWorklet.addModule(new URL('./outputWorklet.js', import.meta.url))
    const node = new AudioWorkletNode(context, 'output', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] })
    node.connect(context.destination)
    node.port.postMessage(undefined, [channel.port1])
    await context.suspend()
  } catch (error) {
    await context.close()
    throw error
  }

  return {
    enginePort: channel.port2,
    latency: () => context.baseLatency + context.outputLatency,
    resume: () => context.resume(),
    suspend: () => context.suspend(),
  }
}
