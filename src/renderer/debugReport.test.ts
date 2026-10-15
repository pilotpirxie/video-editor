import { describe, expect, it } from 'vitest'
import { MEDIA_STATES, SECOND, projectOf, track, videoClip } from '../../test/fixtures.js'
import { debugReport, type DebugReportInput } from './debugReport.js'

function inputWith(selection: readonly string[]): DebugReportInput {
  const clips = Array.from({ length: 30 }, (_, index) => videoClip(`c${index}`, index * SECOND, SECOND, { speedPercent: 5000 }))
  return {
    project: projectOf([track('t1', clips), track('t2', [])]),
    openGroups: [],
    selection,
    mediaStates: MEDIA_STATES,
    preparation: { video: { progress: 0.37, hasFailed: false } },
    playhead: 2 * SECOND,
    droppedFrames: 3,
    fullQualityMs: undefined,
    documentPath: '/Users/someone/speedup.json',
    system: { appVersion: '1.0.0', versions: ['FFmpeg 7.1'], macOS: '15.6', cpu: 'Apple M1', totalMemoryBytes: 8 * 1024 ** 3, footprintBytes: 412 * 1024 ** 2 },
  }
}

describe('debug report', () => {
  it('describes the app, the project and each track without a selection', () => {
    const text = debugReport(inputWith([]))
    expect(text).toContain('Playback 1.0.0 | FFmpeg 7.1 | macOS 15.6 | Apple M1 | 8 GB | using 412 MB')
    expect(text).toContain('File /Users/someone/speedup.json')
    expect(text).toContain('2 tracks | 30 clips')
    expect(text).toContain('playhead 2.000s')
    expect(text).toContain('dropped 3 frames')
    expect(text).toContain('[t2] | 0 clips | empty')
    expect(text).not.toContain('Selected')
  })

  it('details the selected clips with their file, its preparation and their JSON', () => {
    const text = debugReport(inputWith(['c1']))
    expect(text).toContain('Selected 1')
    expect(text).toContain('Clip c1 | video on')
    expect(text).toContain('speed 5000%')
    expect(text).toContain('prepared 37%')
    expect(text).toContain('"speedPercent":5000')
  })

  it('details at most twenty clips and counts the rest', () => {
    const ids = Array.from({ length: 30 }, (_, index) => `c${index}`)
    const text = debugReport(inputWith(ids))
    expect(text.match(/^Clip /gm)).toHaveLength(20)
    expect(text).toContain('…and 10 more')
  })

  it('says so when the system info could not be read', () => {
    expect(debugReport({ ...inputWith([]), system: 'unavailable' })).toContain('System: unavailable')
    expect(debugReport({ ...inputWith([]), system: 'reading' })).toContain('System: reading…')
  })
})
