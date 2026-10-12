// Runs on the audio thread. Plays the mixed samples the engine queues and reports how many it
// has actually played: that count is the playback clock. When the queue runs dry it plays
// silence and the count stands still, so sound and picture stall together and never drift.

/** Reports are sent every this many render quanta (128 samples each). */
const QUANTA_PER_REPORT = 4
const CHANNELS = 2

class OutputProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.queue = []
    this.readOffset = 0
    this.consumedSamples = 0
    this.isRunning = false
    this.quantaSinceReport = 0
    this.engine = undefined
    // The node's own port only delivers the direct line to the engine worker.
    this.port.onmessage = (event) => {
      this.engine = event.ports[0]
      if (this.engine === undefined) return
      this.engine.onmessage = (message) => this.handle(message.data)
    }
  }

  handle(command) {
    if (command.type === 'start') {
      this.queue = []
      this.readOffset = 0
      this.consumedSamples = 0
      this.quantaSinceReport = 0
      this.isRunning = true
    } else if (command.type === 'samples') {
      if (this.isRunning) this.queue.push(command.samples)
    } else if (command.type === 'stop') {
      this.isRunning = false
      this.queue = []
    }
  }

  process(_inputs, outputs) {
    const left = outputs[0][0]
    const right = outputs[0][1]
    if (!this.isRunning) return true

    let written = 0
    while (written < left.length && this.queue.length > 0) {
      const block = this.queue[0]
      const available = block.length / CHANNELS - this.readOffset
      const count = Math.min(available, left.length - written)
      for (let index = 0; index < count; index++) {
        left[written + index] = block[(this.readOffset + index) * CHANNELS]
        right[written + index] = block[(this.readOffset + index) * CHANNELS + 1]
      }
      written += count
      this.readOffset += count
      if (this.readOffset * CHANNELS >= block.length) {
        this.queue.shift()
        this.readOffset = 0
      }
    }

    this.consumedSamples += written
    this.quantaSinceReport += 1
    if (written > 0 && this.quantaSinceReport >= QUANTA_PER_REPORT) {
      this.quantaSinceReport = 0
      this.engine?.postMessage({ type: 'consumed', samples: this.consumedSamples })
    }
    return true
  }
}

registerProcessor('output', OutputProcessor)
