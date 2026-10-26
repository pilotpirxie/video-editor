import { describe, expect, it } from 'vitest'
import { frameDecoderThreads, streamDecoderThreads } from './limits.js'

const FULL_HD = 1920 * 1080
const EIGHT_K = 7680 * 4320

describe('decoder threads', () => {
  it('leave one core to the interface and never drop below one', () => {
    expect(frameDecoderThreads(FULL_HD, 8)).toBe(4)
    expect(frameDecoderThreads(FULL_HD, 4)).toBe(3)
    expect(frameDecoderThreads(FULL_HD, 2)).toBe(1)
    expect(frameDecoderThreads(FULL_HD, 1)).toBe(1)
    expect(frameDecoderThreads(EIGHT_K, 8)).toBe(2)
  })

  it('give a stepping stream the frame budget and a plain stream two threads', () => {
    expect(streamDecoderThreads(FULL_HD, 3, 8)).toBe(4)
    expect(streamDecoderThreads(FULL_HD, 1, 8)).toBe(2)
    expect(streamDecoderThreads(FULL_HD, 1, 2)).toBe(1)
  })
})
