import { useEffect, useRef, type CSSProperties, type KeyboardEvent, type ReactElement } from 'react'
import { locateClip } from '../editor/clips.js'
import { setTextStyle } from '../editor/text.js'
import { calloutTextArea } from '../engine/annotations.js'
import type { TextLook } from '../engine/resolve.js'
import { measureText } from '../engine/text.js'
import type { CalloutClip, TextClip } from '../shared/project.js'
import { useSession } from './context.js'
import { updateStep, type EditorStore } from './store.js'

export function typeText(store: EditorStore, clipIds: readonly string[], text: string, isStepOpen: boolean): void {
  updateStep(store, 'Edit Text', (project) => setTextStyle(project, clipIds, { text }), isStepOpen)
}

export function endTextEdit(store: EditorStore, clipId: string): void {
  const clip = locateClip(store.getState().project, clipId)?.clip
  const canBeKept = clip?.type === 'callout' || (clip?.type === 'text' && clip.text.trim() !== '')
  if (canBeKept) store.commit()
  else store.cancel()
}

function wordsOf(clip: TextClip | CalloutClip): { look: TextLook; centerX: number } {
  if (clip.type === 'text') return { look: clip, centerX: 0 }
  const area = calloutTextArea(clip)
  const look: TextLook = { text: clip.text, font: clip.font, color: clip.color, align: clip.align, lineSpacing: clip.lineSpacing, boxWidth: area.width }
  return { look, centerX: area.centerX }
}

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
    return () => {
      field.removeEventListener('blur', leave)
      finish()
    }
  }, [store, clipId])

  function onInput(field: HTMLTextAreaElement): void {
    typeText(store, [clipId], field.value, isStepOpenRef.current)
    isStepOpenRef.current = true
    field.scrollLeft = 0
    field.scrollTop = 0
  }

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
