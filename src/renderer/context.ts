import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react'
import { hintOf, type ShortcutAction } from '../editor/shortcuts.js'
import type { Session } from './document.js'
import type { EditorState } from './store.js'
import type { Position } from './transport.js'

class SessionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SessionError'
  }
}

export const SessionContext = createContext<Session | undefined>(undefined)

export function useSession(): Session {
  const session = useContext(SessionContext)
  if (session === undefined) throw new SessionError('This component is used outside the editor')
  return session
}

export function useEditorState<Selected>(select: (state: EditorState) => Selected): Selected {
  const { store } = useSession()
  return useSyncExternalStore(store.subscribe, () => select(store.getState()))
}

export function usePosition<Selected>(select: (position: Position) => Selected): Selected {
  const { transport } = useSession()
  return useSyncExternalStore(transport.subscribe, () => select(transport.position()))
}

export function useShortcutHint(action: ShortcutAction): string | undefined {
  const { shortcuts } = useSession()
  const [first] = useSyncExternalStore(shortcuts.subscribe, shortcuts.get)[action]
  return first === undefined ? undefined : hintOf(first)
}

// Draws again when a thumbnail arrives, at most once per display frame.
export function useThumbnailUpdates(): void {
  const { thumbnails } = useSession()
  const [, setPictureCount] = useState(0)
  useEffect(() => {
    let redraw: number | undefined
    const unsubscribe = thumbnails.subscribe(() => {
      if (redraw !== undefined) return
      redraw = requestAnimationFrame(() => {
        redraw = undefined
        setPictureCount((count) => count + 1)
      })
    })
    return () => {
      unsubscribe()
      if (redraw !== undefined) cancelAnimationFrame(redraw)
    }
  }, [thumbnails])
}
