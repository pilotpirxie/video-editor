import { useEffect, useRef, type KeyboardEvent, type ReactElement } from 'react'

const EDGE_GAP = 8

export type MenuItem = {
  label: string
  testId: string
  isDisabled?: boolean
  onSelect(): void
}

type PopupMenuProps = {
  label: string
  items: readonly MenuItem[]
  at: { x: number; y: number }
  onClose(): void
}

// Closes a menu or a list that is open above everything when the user turns to something else: a press or a scroll outside it, another window, a window of another size.
// The browser's own way of closing a popover is not used: it also counts the release of the very press that opened one, when that release lands just beside it.
export function closeOnTurningAway(element: HTMLElement, close: () => void): () => void {
  function onEvent(event: Event): void {
    const isInside = event.target instanceof Node && element.contains(event.target)
    if (!isInside) close()
  }

  // A scroll is reported where it happens and does not travel up, so it is caught on the way down.
  document.addEventListener('pointerdown', onEvent, true)
  document.addEventListener('scroll', onEvent, true)
  window.addEventListener('blur', onEvent)
  window.addEventListener('resize', onEvent)
  return () => {
    document.removeEventListener('pointerdown', onEvent, true)
    document.removeEventListener('scroll', onEvent, true)
    window.removeEventListener('blur', onEvent)
    window.removeEventListener('resize', onEvent)
  }
}

export function PopupMenu({ label, items, at, onClose }: PopupMenuProps): ReactElement {
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const menu = menuRef.current
    if (menu === null) return
    menu.showPopover()
    const box = menu.getBoundingClientRect()
    menu.style.left = `${Math.max(EDGE_GAP, Math.min(at.x, window.innerWidth - box.width - EDGE_GAP))}px`
    menu.style.top = `${Math.max(EDGE_GAP, Math.min(at.y, window.innerHeight - box.height - EDGE_GAP))}px`
    menu.querySelector('button')?.focus()
    return closeOnTurningAway(menu, onClose)
  }, [at, onClose])

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== 'Escape') return
    event.preventDefault()
    onClose()
  }

  return (
    <div ref={menuRef} popover="manual" className="menu" role="menu" aria-label={label} data-testid="menu" onKeyDown={onKeyDown}>
      {items.map((item) => (
        <button
          key={item.testId}
          type="button"
          role="menuitem"
          className="menu-item"
          data-testid={item.testId}
          disabled={item.isDisabled}
          onClick={() => {
            item.onSelect()
            onClose()
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}
