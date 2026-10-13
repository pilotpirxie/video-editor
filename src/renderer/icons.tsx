import type { ReactElement } from 'react'

const PATHS = {
  panelLeft: 'M2 3h12v10H2zM6 3v10',
  panelRight: 'M2 3h12v10H2zM10 3v10',
  panelBottom: 'M2 3h12v10H2zM2 9h12',
  undo: 'M5 3L2 6l3 3M2 6h7.5a3.5 3.5 0 0 1 0 7H6',
  redo: 'M11 3l3 3-3 3M14 6H6.5a3.5 3.5 0 0 0 0 7H10',
  play: 'M5 3l8 5-8 5z',
  pause: 'M5 3v10M11 3v10',
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
  music: 'M6 12V3l7-1.5v9M6 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM13 10.5a2 2 0 1 1-4 0 2 2 0 0 1 4 0z',
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
  isPressed?: boolean
  isDisabled?: boolean
  onClick(): void
}

export function IconButton({ icon, label, testId, isPressed, isDisabled, onClick }: IconButtonProps): ReactElement {
  return (
    <button type="button" className="button icon" aria-label={label} aria-pressed={isPressed} data-tooltip={label} data-testid={testId} disabled={isDisabled} onClick={onClick}>
      <Icon name={icon} />
    </button>
  )
}
