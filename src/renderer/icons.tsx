import type { ReactElement } from 'react'

const PATHS = {
  panelLeft: 'M2 3h12v10H2zM6 3v10',
  panelRight: 'M2 3h12v10H2zM10 3v10',
  panelBottom: 'M2 3h12v10H2zM2 9h12',
  undo: 'M5 3L2 6l3 3M2 6h7.5a3.5 3.5 0 0 1 0 7H6',
  redo: 'M11 3l3 3-3 3M14 6H6.5a3.5 3.5 0 0 0 0 7H10',
  play: 'M5 3l8 5-8 5z',
  pause: 'M5 3v10M11 3v10',
  stepBack: 'M4 3v10M13 3L6 8l7 5z',
  stepForward: 'M12 3v10M3 3l7 5-7 5z',
  plus: 'M8 3v10M3 8h10',
  minus: 'M3 8h10',
  fit: 'M2 5V2h3M11 2h3v3M14 11v3h-3M5 14H2v-3',
  scissors: 'M4.5 5.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM4.5 13.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM5.8 4.9L14 12M5.8 11.1L14 4',
  magnet: 'M4 2v6a4 4 0 0 0 8 0V2H9.5v6a1.5 1.5 0 0 1-3 0V2z',
  lock: 'M4 7h8v6H4zM6 7V5a2 2 0 0 1 4 0v2',
  eye: 'M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8zM8 6.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z',
  speaker: 'M2 6h3l4-3v10l-4-3H2zM11.5 6a3 3 0 0 1 0 4',
  crop: 'M4 1.5V12h10.5M1.5 4H12v10.5',
  link: 'M6.5 9.5l3-3M7 4.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1M9 11.5l-1 1A2.5 2.5 0 0 1 4.5 9l1-1',
  text: 'M3 4.5V3h10v1.5M8 3v10M6 13h4',
  alignLeft: 'M2 3.5h12M2 6.5h8M2 9.5h12M2 12.5h8',
  alignCenter: 'M2 3.5h12M4 6.5h8M2 9.5h12M4 12.5h8',
  alignRight: 'M2 3.5h12M6 6.5h8M2 9.5h12M6 12.5h8',
  music: 'M6 12V3l7-1.5v9M6 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM13 10.5a2 2 0 1 1-4 0 2 2 0 0 1 4 0z',
  chevronDown: 'M4 6l4 4 4-4',
  chevronRight: 'M6 4l4 4-4 4',
  check: 'M3.5 8.5l3 3 6-7',
  list: 'M2 3h3.5v3.5H2zM8 4.75h6M2 9.5h3.5V13H2zM8 11.25h6',
  grid: 'M2.5 2.5h4.5V7H2.5zM9 2.5h4.5V7H9zM2.5 9h4.5v4.5H2.5zM9 9h4.5v4.5H9z',
} as const

export type IconName = keyof typeof PATHS

export function Icon({ name }: { name: IconName }): ReactElement {
  return (
    <svg className="icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  )
}

type IconButtonProps = {
  icon: IconName
  label: string
  testId: string
  // The keys that do the same, as written in the tooltip.
  shortcut?: string
  isPressed?: boolean
  isDisabled?: boolean
  onClick(): void
}

export function IconButton({ icon, label, testId, shortcut, isPressed, isDisabled, onClick }: IconButtonProps): ReactElement {
  const tooltip = shortcut === undefined ? label : `${label} (${shortcut})`
  return (
    <button type="button" className="button icon" aria-label={label} aria-pressed={isPressed} data-tooltip={tooltip} data-testid={testId} disabled={isDisabled} onClick={onClick}>
      <Icon name={icon} />
    </button>
  )
}
