import type { ReactElement, ReactNode } from 'react'
import type { AnnotationKind } from '../editor/annotations.js'
import type { EffectType, TransitionType } from '../shared/project.js'

// The pictures on the tiles of the library: one made-up landscape, shown as each item changes it. They are drawn once, are never animated and load nothing.
// Every picture is 64 by 36 units, the shape of a 16:9 video; colours come from the stylesheet.

type Box = {
  x: number
  y: number
  width: number
  height: number
}

const LEFT_HALF: Box = { x: 0, y: 0, width: 32, height: 36 }
const RIGHT_HALF: Box = { x: 32, y: 0, width: 32, height: 36 }
const TOP_HALF: Box = { x: 0, y: 0, width: 64, height: 18 }
const BOTTOM_HALF: Box = { x: 0, y: 18, width: 64, height: 18 }
const CARD: Box = { x: 12, y: 6, width: 40, height: 22.5 }
const REGION: Box = { x: 16, y: 6, width: 32, height: 22 }
// The colours of the pixel blocks: rows from the top, as the landscape under them roughly is.
const BLOCKS: readonly (readonly ('sky' | 'sun' | 'hill')[])[] = [
  ['sky', 'sky', 'sky', 'sun'],
  ['sky', 'hill', 'sky', 'sky'],
  ['hill', 'hill', 'hill', 'hill'],
]
const BLOCK_SIZE = 8
// The arrow runs from its tail up to the back of its head; the head ends at its tip.
const ARROW_TAIL = 'M14 28L41 12.9'
const ARROW_HEAD = 'M48 9L43.2 16.8L38.8 9Z'

function Picture({ children }: { children: ReactNode }): ReactElement {
  return (
    <svg className="library-preview" viewBox="0 0 64 36" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      {children}
    </svg>
  )
}

function Scene({ look }: { look?: string }): ReactElement {
  return (
    <g className={look}>
      <rect className="ink-sky" width="64" height="36" />
      <circle className="ink-sun" cx="47" cy="11" r="5" />
      <path className="ink-hill" d="M0 26C12 18 22 18 34 24S54 31 64 22V36H0Z" />
    </g>
  )
}

// The picture a transition arrives at.
function NextScene(): ReactElement {
  return (
    <g>
      <rect className="ink-other" width="64" height="36" />
      <rect className="ink-card" x="18" y="9" width="28" height="18" rx="3" />
    </g>
  )
}

// Only the part `view` of a picture, drawn at its own place unless `at` moves it.
function Part({ view, at, children }: { view: Box; at?: { x: number; y: number }; children: ReactNode }): ReactElement {
  const place = at ?? view
  return (
    <svg x={place.x} y={place.y} width={view.width} height={view.height} viewBox={`${view.x} ${view.y} ${view.width} ${view.height}`}>
      {children}
    </svg>
  )
}

// A whole picture made smaller to fit `box`.
function Shrunk({ box, children }: { box: Box; children: ReactNode }): ReactElement {
  return (
    <svg x={box.x} y={box.y} width={box.width} height={box.height} viewBox="0 0 64 36">
      {children}
    </svg>
  )
}

function Divider(): ReactElement {
  return <path className="ink-divider" d="M32 0V36" />
}

// Before on the left, after on the right.
function Compared({ look }: { look: string }): ReactElement {
  return (
    <Picture>
      <Scene />
      <Part view={RIGHT_HALF}>
        <Scene look={look} />
      </Part>
      <Divider />
    </Picture>
  )
}

// The landscape as a card on a light backdrop, with something drawn over or around it.
function OnBackdrop({ isShadowed, children }: { isShadowed?: boolean; children?: ReactNode }): ReactElement {
  return (
    <Picture>
      <rect className="ink-backdrop" width="64" height="36" />
      <g className={isShadowed === true ? 'look-shadow' : undefined}>
        <Shrunk box={CARD}>
          <Scene />
        </Shrunk>
      </g>
      {children}
    </Picture>
  )
}

// Halfway through: the leaving picture, a band of black or white, the arriving picture.
function FadeThrough({ ink }: { ink: string }): ReactElement {
  return (
    <Picture>
      <Part view={{ x: 0, y: 0, width: 24, height: 36 }}>
        <Scene />
      </Part>
      <Part view={{ x: 40, y: 0, width: 24, height: 36 }}>
        <NextScene />
      </Part>
      <rect className={ink} x="16" width="8" height="36" opacity="0.5" />
      <rect className={ink} x="24" width="16" height="36" />
      <rect className={ink} x="40" width="8" height="36" opacity="0.5" />
    </Picture>
  )
}

// Halfway through a wipe: the arriving picture covers `arriving`, the edge between them moves the way the chevron points.
function Wipe({ arriving, edge, chevron }: { arriving: Box; edge: string; chevron: string }): ReactElement {
  return (
    <Picture>
      <Scene />
      <Part view={arriving}>
        <NextScene />
      </Part>
      <path className="ink-divider" d={edge} />
      <path className="ink-chevron" d={chevron} />
    </Picture>
  )
}

function OnScene({ children }: { children: ReactNode }): ReactElement {
  return (
    <Picture>
      <Scene />
      {children}
    </Picture>
  )
}

function PixelBlocks(): ReactElement {
  const blocks: ReactElement[] = []
  for (const [row, colours] of BLOCKS.entries()) {
    for (const [column, colour] of colours.entries()) {
      const x = REGION.x + column * BLOCK_SIZE
      const y = REGION.y + row * BLOCK_SIZE
      blocks.push(<rect key={`${row}-${column}`} className={`ink-${colour}`} x={x} y={y} width={BLOCK_SIZE} height={BLOCK_SIZE} />)
      // Every other block is a little lighter, so the blocks read as blocks.
      if ((row + column) % 2 === 0) blocks.push(<rect key={`${row}-${column}-tint`} className="ink-tint" x={x} y={y} width={BLOCK_SIZE} height={BLOCK_SIZE} />)
    }
  }
  return <g>{blocks}</g>
}

export const EFFECT_PREVIEWS: Record<EffectType, ReactElement> = {
  colorAdjust: <Compared look="look-vivid" />,
  blackAndWhite: <Compared look="look-grey" />,
  dropShadow: <OnBackdrop isShadowed />,
  border: (
    <OnBackdrop>
      <rect className="ink-border" x={CARD.x} y={CARD.y} width={CARD.width} height={CARD.height} />
    </OnBackdrop>
  ),
  // The corners of the card are covered with the backdrop, so the card looks rounded.
  roundedCorners: (
    <OnBackdrop>
      <path className="ink-backdrop" d="M12 6H16A4 4 0 0 0 12 10ZM52 6V10A4 4 0 0 0 48 6ZM52 28.5H48A4 4 0 0 0 52 24.5ZM12 28.5V24.5A4 4 0 0 0 16 28.5Z" />
    </OnBackdrop>
  ),
  clipBlur: (
    <Picture>
      <Scene />
      <Scene look="look-soft" />
    </Picture>
  ),
  // A person in front of a green screen on the left; with the green keyed out on the right.
  chromaKey: (
    <Picture>
      <rect className="ink-key" width="32" height="36" />
      <Part view={RIGHT_HALF}>
        <Scene />
      </Part>
      <g className="ink-person">
        <circle cx="32" cy="14" r="5" />
        <path d="M21 36C21 25 43 25 43 36Z" />
      </g>
      <Divider />
    </Picture>
  ),
}

export const TRANSITION_PREVIEWS: Record<TransitionType, ReactElement> = {
  crossDissolve: (
    <Picture>
      <Scene />
      <g opacity="0.5">
        <NextScene />
      </g>
    </Picture>
  ),
  fadeBlack: <FadeThrough ink="ink-black" />,
  fadeWhite: <FadeThrough ink="ink-white" />,
  wipeLeft: <Wipe arriving={RIGHT_HALF} edge="M32 0V36" chevron="M29 15L26 18L29 21" />,
  wipeRight: <Wipe arriving={LEFT_HALF} edge="M32 0V36" chevron="M35 15L38 18L35 21" />,
  wipeUp: <Wipe arriving={BOTTOM_HALF} edge="M0 18H64" chevron="M29 15L32 12L35 15" />,
  wipeDown: <Wipe arriving={TOP_HALF} edge="M0 18H64" chevron="M29 21L32 24L35 21" />,
  // The arriving picture comes in from the right over the one that stays.
  slide: (
    <Picture>
      <Scene />
      <g className="look-shadow">
        <Part view={{ x: 0, y: 0, width: 36, height: 36 }} at={{ x: 28, y: 0 }}>
          <NextScene />
        </Part>
      </g>
      <path className="ink-chevron" d="M24 15L21 18L24 21" />
    </Picture>
  ),
  // The arriving picture comes in from the right and pushes the other one out to the left.
  push: (
    <Picture>
      <Part view={{ x: 36, y: 0, width: 28, height: 36 }} at={{ x: 0, y: 0 }}>
        <Scene />
      </Part>
      <Part view={{ x: 0, y: 0, width: 36, height: 36 }} at={{ x: 28, y: 0 }}>
        <NextScene />
      </Part>
      <path className="ink-divider" d="M28 0V36" />
      <path className="ink-chevron" d="M24 15L21 18L24 21" />
    </Picture>
  ),
  zoom: (
    <Picture>
      <Scene />
      <g className="look-shadow">
        <Shrunk box={{ x: 16, y: 9, width: 32, height: 18 }}>
          <NextScene />
        </Shrunk>
      </g>
    </Picture>
  ),
  circleReveal: (
    <Picture>
      <Scene />
      <circle className="ink-other" cx="32" cy="18" r="13" />
      <rect className="ink-card" x="24" y="13" width="16" height="10" rx="2" />
    </Picture>
  ),
}

export const ANNOTATION_PREVIEWS: Record<AnnotationKind, ReactElement> = {
  text: (
    <OnScene>
      <text className="ink-title" x="32" y="23" textAnchor="middle">
        Aa
      </text>
    </OnScene>
  ),
  callout: (
    <OnScene>
      <path className="ink-bubble" d="M14 5H50A4 4 0 0 1 54 9V20A4 4 0 0 1 50 24H27L20 30V24H14A4 4 0 0 1 10 20V9A4 4 0 0 1 14 5Z" />
      <rect className="ink-words" x="17" y="10" width="30" height="2.5" rx="1.25" />
      <rect className="ink-words" x="17" y="15.5" width="20" height="2.5" rx="1.25" />
    </OnScene>
  ),
  arrow: (
    <OnScene>
      <path className="ink-arrow" d={ARROW_TAIL} />
      <path className="ink-arrow-head" d={ARROW_HEAD} />
    </OnScene>
  ),
  line: (
    <OnScene>
      <path className="ink-arrow" d="M14 28L48 9" />
    </OnScene>
  ),
  blur: (
    <OnScene>
      <Part view={REGION}>
        <Scene look="look-soft" />
      </Part>
      <rect className="ink-frame" x={REGION.x} y={REGION.y} width={REGION.width} height={REGION.height} />
    </OnScene>
  ),
  pixelate: (
    <OnScene>
      <PixelBlocks />
    </OnScene>
  ),
  highlight: (
    <OnScene>
      <rect className="ink-marker" x="8" y="14" width="48" height="9" rx="1" />
    </OnScene>
  ),
  spotlight: (
    <OnScene>
      <path className="ink-shade" fillRule="evenodd" d="M0 0H64V36H0ZM18 18A14 11 0 1 0 46 18A14 11 0 1 0 18 18Z" />
    </OnScene>
  ),
}
