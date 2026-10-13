import { createContext, useContext, useSyncExternalStore } from 'react'
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

// The selector must return a value that is identical between calls while the part of the state it reads has not changed.
export function useEditorState<Selected>(select: (state: EditorState) => Selected): Selected {
  const { store } = useSession()
  return useSyncExternalStore(store.subscribe, () => select(store.getState()))
}

export function usePosition<Selected>(select: (position: Position) => Selected): Selected {
  const { transport } = useSession()
  return useSyncExternalStore(transport.subscribe, () => select(transport.position()))
}
