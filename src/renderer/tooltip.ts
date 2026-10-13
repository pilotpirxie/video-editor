const SHOW_DELAY_MS = 500
const GAP = 6

// One tooltip element serves every control that carries a data-tooltip attribute.
export function installTooltips(root: HTMLElement): () => void {
  const tooltip = document.createElement('div')
  tooltip.className = 'tooltip'
  tooltip.setAttribute('role', 'tooltip')
  tooltip.hidden = true
  document.body.append(tooltip)
  let timer: number | undefined

  function hide(): void {
    window.clearTimeout(timer)
    tooltip.hidden = true
  }

  function show(owner: HTMLElement, text: string): void {
    tooltip.textContent = text
    tooltip.hidden = false
    const anchor = owner.getBoundingClientRect()
    const size = tooltip.getBoundingClientRect()
    const left = Math.min(Math.max(GAP, anchor.left + anchor.width / 2 - size.width / 2), window.innerWidth - size.width - GAP)
    const hasRoomBelow = anchor.bottom + GAP + size.height < window.innerHeight
    const top = hasRoomBelow ? anchor.bottom + GAP : anchor.top - GAP - size.height
    tooltip.style.left = `${left}px`
    tooltip.style.top = `${top}px`
  }

  function onEnter(event: Event): void {
    const owner = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-tooltip]') : null
    hide()
    const text = owner?.dataset.tooltip
    // A drag is not a question about what is under the pointer.
    const isDragging = event instanceof PointerEvent && event.buttons !== 0
    if (owner === null || text === undefined || isDragging) return
    timer = window.setTimeout(() => show(owner, text), SHOW_DELAY_MS)
  }

  root.addEventListener('pointerover', onEnter)
  root.addEventListener('focusin', onEnter)
  root.addEventListener('pointerdown', hide)
  root.addEventListener('pointerleave', hide)
  root.addEventListener('focusout', hide)
  root.addEventListener('keydown', hide)

  return () => {
    hide()
    tooltip.remove()
    root.removeEventListener('pointerover', onEnter)
    root.removeEventListener('focusin', onEnter)
    root.removeEventListener('pointerdown', hide)
    root.removeEventListener('pointerleave', hide)
    root.removeEventListener('focusout', hide)
    root.removeEventListener('keydown', hide)
  }
}
