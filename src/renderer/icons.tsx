import type { ReactElement } from 'react'

const PATHS = {
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
  chevronLeft: 'M10 4L6 8l4 4',
  check: 'M3.5 8.5l3 3 6-7',
  list: 'M2 3h3.5v3.5H2zM8 4.75h6M2 9.5h3.5V13H2zM8 11.25h6',
  grid: 'M2.5 2.5h4.5V7H2.5zM9 2.5h4.5V7H9zM2.5 9h4.5v4.5H2.5zM9 9h4.5v4.5H9z',
  film: 'M2.5 3h11v10h-11zM5.5 3v10M10.5 3v10M2.5 6.5h3M2.5 9.5h3M10.5 6.5h3M10.5 9.5h3',
  move: 'M8 2v12M2 8h12M6 4l2-2 2 2M6 12l2 2 2-2M4 6L2 8l2 2M12 6l2 2-2 2',
  clock: 'M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zM8 5v3l2 1.5',
  droplet: 'M8 2.5s4 4 4 7a4 4 0 0 1-8 0c0-3 4-7 4-7z',
  chevronUp: 'M4 10l4-4 4 4',
  trash: 'M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.5 8.5h6l.5-8.5M6.75 7v4M9.25 7v4',
  pipette: 'M10.5 2.5l3 3-2 2-3-3zM9.5 5.5l-6 6-1 2 2-1 6-6',
  zoom: 'M2 3h12v10H2zM5.5 6h5v4h-5z',
  wand: 'M3 13l7-7M11.5 2v2.5M10.25 3.25h2.5M13.5 6.5v2M12.5 7.5h2M6 2.5v2M5 3.5h2',
  transition: 'M2 3.5h12v9H2zM2 12.5l12-9',
  blur: 'M8 3a5 5 0 0 0 0 10M10 3.4l.5.3M12 5.2l.3.5M12.8 7.8v.5M12 10.3l-.3.5M10.5 12.3l-.5.3',
  marker: 'M3 13.5h10M5 10l5.5-7 2.5 2-5.5 7zM5 10l-.5 2.5 3-.5',
  spotlight: 'M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2',
  keyframe: 'M8 2.5L13.5 8 8 13.5 2.5 8z',
  callout: 'M2.5 3h11v7.5H7.5l-3 2.5v-2.5h-2z',
  arrow: 'M3 13L13 3M7.5 3H13v5.5',
  line: 'M3 13L13 3',
  group: 'M2.5 2.5h7v7h-7zM6.5 6.5h7v7h-7z',
  motion: 'M2 12.5c3.5 0 3-9 6.5-9S11 9 14 9M11.5 6.5L14 9l-2.5 2.5',
  edgeLeft: 'M2.5 2v12M4.5 4h8v3h-8zM4.5 9h5v3h-5z',
  edgeCenter: 'M8 2v12M3.5 4h9v3h-9zM5.5 9h5v3h-5z',
  edgeRight: 'M13.5 2v12M3.5 4h8v3h-8zM6.5 9h5v3h-5z',
  edgeTop: 'M2 2.5h12M4 4.5h3v8H4zM9 4.5h3v5H9z',
  edgeMiddle: 'M2 8h12M4 3.5h3v9H4zM9 5.5h3v5H9z',
  edgeBottom: 'M2 13.5h12M4 3.5h3v8H4zM9 6.5h3v5H9z',
  spreadAcross: 'M2 2v12M14 2v12M6.5 4.5h3v7h-3z',
  spreadDown: 'M2 2h12M2 14h12M4.5 6.5h7v3h-7z',
  preview: 'M2 3h12v10H2zM6.5 5.5l4 2.5-4 2.5z',
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
