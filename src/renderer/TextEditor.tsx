import { useEffect, useRef, type CSSProperties, type KeyboardEvent, type ReactElement } from 'react'
import { locateClip } from '../editor/clips.js'
import { setTextStyle } from '../editor/text.js'
import { calloutTextArea } from '../engine/annotations.js'
import type { TextLook } from '../engine/resolve.js'
import { measureText } from '../engine/text.js'
import type { CalloutClip, TextClip } from '../shared/project.js'
import { useSession } from './context.js'
import { updateStep, type EditorStore } from './store.js'

// Sends typed words to the project as part of one "Edit Text" step.
export function typeText(store: EditorStore, clipIds: readonly string[], text: string, isStepOpen: boolean): void {
  updateStep(store, 'Edit Text', (project) => setTextStyle(project, clipIds, { text }), isStepOpen)
}

// Ends the "Edit Text" step. A text clip without words cannot be saved, so text left empty goes back to what it said. A callout may be left without words.
export function endTextEdit(store: EditorStore, clipId: string): void {
  const clip = locateClip(store.getState().project, clipId)?.clip
  const canBeKept = clip?.type === 'callout' || (clip?.type === 'text' && clip.text.trim() !== '')
  if (canBeKept) store.commit()
  else store.cancel()
}

// The words of a clip as they are laid out, and how far the middle of their box lies to the right of the middle of the clip.
function wordsOf(clip: TextClip | CalloutClip): { look: TextLook; centerX: number } {
  if (clip.type === 'text') return { look: clip, centerX: 0 }
  const area = calloutTextArea(clip)
  const look: TextLook = { text: clip.text, font: clip.font, color: clip.color, align: clip.align, lineSpacing: clip.lineSpacing, boxWidth: area.width }
  return { look, centerX: area.centerX }
}

// The words of a text clip or a callout, typed where they are drawn. Its own letters are invisible: the preview underneath shows them exactly as they will be exported, and this field adds the caret and the selection on top.
// It is drawn in canvas units inside the overlay, in a group that already carries the clip's position, rotation and scale.
export function TextEditor({ clip }: { clip: TextClip | CalloutClip }): ReactElement {
  const { store } = useSession()
  const fieldRef = useRef<HTMLTextAreaElement>(null)
  const isStepOpenRef = useRef(false)
  const clipId = clip.id
  const { look, centerX } = wordsOf(clip)
  const measured = measureText(look)

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
    lineHeight: `${measured.lineStep}px`,
    padding: `${measured.padding}px`,
    // The first line is drawn at the top of the box whatever the spacing, while a text field shares the spacing out above and below each line.
    paddingTop: `${measured.padding - (measured.lineStep - measured.lineHeight) / 2}px`,
    textAlign: clip.align,
    whiteSpace: look.boxWidth === undefined ? 'pre' : 'pre-wrap',
  }
  return (
    <foreignObject className="text-editor-frame" x={centerX - measured.naturalWidth / 2} y={-measured.naturalHeight / 2} width={measured.naturalWidth} height={measured.naturalHeight}>
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
