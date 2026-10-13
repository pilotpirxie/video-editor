import { useEffect, useRef, type ReactElement } from 'react'

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

// A context menu on the browser's own popover layer: it sits above everything, and a click elsewhere or Escape closes it.
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

    function onToggle(event: Event): void {
      if (event instanceof ToggleEvent && event.newState === 'closed') onClose()
    }
    menu.addEventListener('toggle', onToggle)
    return () => menu.removeEventListener('toggle', onToggle)
  }, [at, onClose])

  return (
    <div ref={menuRef} popover="auto" className="menu" role="menu" aria-label={label} data-testid="menu">
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
