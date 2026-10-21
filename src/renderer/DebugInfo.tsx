import { useEffect, useState, useSyncExternalStore, type ReactElement } from 'react'
import { logError } from '../shared/log.js'
import type { DebugSystemInfo } from '../shared/mediaProtocol.js'
import { useEditorState, usePosition, useSession } from './context.js'
import { debugReport, type DebugReportInput } from './debugReport.js'
import { Group } from './Properties.js'

const COPIED_SHOWN_MS = 1500

async function systemInfo(): Promise<DebugSystemInfo | 'unavailable'> {
  try {
    return await window.host.debugInfo()
  } catch (error) {
    logError('Could not read the system info for the debug panel', error)
    return 'unavailable'
  }
}

export function DebugInfo(): ReactElement {
  const session = useSession()
  const { store, transport } = session
  const project = useEditorState((state) => state.project)
  const selection = useEditorState((state) => state.selection)
  const openGroups = useEditorState((state) => state.openGroups)
  const mediaStates = useEditorState((state) => state.mediaStates)
  const documentPath = useEditorState((state) => state.documentPath)
  const preparation = useSyncExternalStore(session.onPreparation, session.preparation)
  usePosition((position) => (position.isPlaying ? -1 : position.time))
  const [system, setSystem] = useState<DebugReportInput['system']>('reading')
  const [isCopied, setIsCopied] = useState(false)

  useEffect(() => {
    void systemInfo().then(setSystem)
  }, [])

  useEffect(() => {
    if (!isCopied) return
    const timer = window.setTimeout(() => setIsCopied(false), COPIED_SHOWN_MS)
    return () => window.clearTimeout(timer)
  }, [isCopied])

  function reportNow(current: DebugReportInput['system']): string {
    const position = transport.position()
    return debugReport({
      project,
      openGroups,
      selection,
      mediaStates,
      preparation,
      playhead: position.time,
      droppedFrames: position.droppedFrames,
      fullQualityMs: position.fullQualityMs,
      documentPath,
      system: current,
    })
  }

  async function copy(): Promise<void> {
    const fresh = await systemInfo()
    setSystem(fresh)
    try {
      await navigator.clipboard.writeText(reportNow(fresh))
      setIsCopied(true)
    } catch (error) {
      logError('Could not copy the debug info', error)
      store.notify('Could not copy the debug info.')
    }
  }

  return (
    <Group title="Debug" icon="list" isOpenAtStart>
      <pre className="debug-text" data-testid="debug-text">
        {reportNow(system)}
      </pre>
      <button type="button" className="button" data-testid="debug-copy" onClick={() => void copy()}>
        {isCopied ? 'Copied' : 'Copy'}
      </button>
    </Group>
  )
}
