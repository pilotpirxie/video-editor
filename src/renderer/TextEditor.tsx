import { useEffect, useRef, type CSSProperties, type KeyboardEvent, type ReactElement } from 'react'
import { locateClip } from '../editor/clips.js'
import { setTextStyle } from '../editor/text.js'
import { measureText } from '../engine/text.js'
import type { Clip } from '../shared/project.js'
import { useSession } from './context.js'
import { updateStep, type EditorStore } from './store.js'

export type TextClip = Extract<Clip, { type: 'text' }>

// Sends typed words to the project as part of one "Edit Text" step.
export function typeText(store: EditorStore, clipIds: readonly string[], text: string, isStepOpen: boolean): void {
  updateStep(store, 'Edit Text', (project) => setTextStyle(project, clipIds, { text }), isStepOpen)
}

// Ends the "Edit Text" step. A text clip without words cannot be saved, so text left empty goes back to what it said.
export function endTextEdit(store: EditorStore, clipId: string): void {
  const clip = locateClip(store.getState().project, clipId)?.clip
  const hasWords = clip?.type === 'text' && clip.text.trim() !== ''
  if (hasWords) store.commit()
  else store.cancel()
}

// The words of a text clip, typed where they are drawn. Its own letters are invisible: the preview underneath shows them exactly as they will be exported, and this field adds the caret and the selection on top.
// It is drawn in canvas units inside the overlay, in a group that already carries the clip's position, rotation and scale.
export function TextEditor({ clip }: { clip: TextClip }): ReactElement {
  const { store } = useSession()
  const fieldRef = useRef<HTMLTextAreaElement>(null)
  const isStepOpenRef = useRef(false)
  const clipId = clip.id
  const measured = measureText({ text: clip.text, family: clip.font.family, size: clip.font.size })

  useEffect(() => {
    function finish(): void {
      if (!isStepOpenRef.current) return
      isStepOpenRef.current = false
      endTextEdit(store, clipId)
    }

    const field = fieldRef.current
    if (field === null) return
    field.focus()
    field.select()
    const leave = (): void => {
      finish()
      store.editText(undefined)
    }
    field.addEventListener('blur', leave)
    // Also runs when the field is taken away without losing the focus first, as when the playhead leaves the clip.
    return () => {
      field.removeEventListener('blur', leave)
      finish()
    }
  }, [store, clipId])

  function onInput(field: HTMLTextAreaElement): void {
    typeText(store, [clipId], field.value, isStepOpenRef.current)
    isStepOpenRef.current = true
    // The field grows with its words on the next frame; until then it must not scroll them out of place.
    field.scrollLeft = 0
    field.scrollTop = 0
  }

  // Enter starts a new line, so the ways out are Escape and Cmd+Return; both keep what was typed, and Undo takes it back.
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    const isDone = event.key === 'Escape' || (event.key === 'Enter' && event.metaKey)
    if (!isDone) return
    event.preventDefault()
    event.currentTarget.blur()
  }

  const style: CSSProperties = {
    font: measured.font,
    lineHeight: `${measured.lineHeight}px`,
    padding: `${measured.padding}px`,
    textAlign: clip.align,
  }
  return (
    <foreignObject className="text-editor-frame" x={-measured.naturalWidth / 2} y={-measured.naturalHeight / 2} width={measured.naturalWidth} height={measured.naturalHeight}>
      <textarea
        ref={fieldRef}
        className="text-editor"
        aria-label="Text"
        data-testid="text-editor"
        spellCheck={false}
        style={style}
        defaultValue={clip.text}
        onInput={(event) => onInput(event.currentTarget)}
        onKeyDown={onKeyDown}
      />
    </foreignObject>
  )
}
