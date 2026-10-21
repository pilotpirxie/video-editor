import type { ReactElement, ReactNode } from 'react'
import type { AnnotationKind } from '../editor/annotations.js'
import type { EffectType, TransitionType } from '../shared/project.js'

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
const FILLED_CARD: Box = { x: 18, y: 10.125, width: 28, height: 15.75 }
const REGION: Box = { x: 16, y: 6, width: 32, height: 22 }
const BLOCKS: readonly (readonly ('sky' | 'sun' | 'hill')[])[] = [
  ['sky', 'sky', 'sky', 'sun'],
  ['sky', 'hill', 'sky', 'sky'],
  ['hill', 'hill', 'hill', 'hill'],
]
const BLOCK_SIZE = 8
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

function ArrivingScene(): ReactElement {
  return (
    <g>
      <rect className="ink-other" width="64" height="36" />
      <rect className="ink-card" x="18" y="9" width="28" height="18" rx="3" />
    </g>
  )
}

function CroppedView({ view, at, children }: { view: Box; at?: { x: number; y: number }; children: ReactNode }): ReactElement {
  const place = at ?? view
  return (
    <svg x={place.x} y={place.y} width={view.width} height={view.height} viewBox={`${view.x} ${view.y} ${view.width} ${view.height}`}>
      {children}
    </svg>
  )
}

function ShrunkToFit({ box, children }: { box: Box; children: ReactNode }): ReactElement {
  return (
    <svg x={box.x} y={box.y} width={box.width} height={box.height} viewBox="0 0 64 36">
      {children}
    </svg>
  )
}

function Divider(): ReactElement {
  return <path className="ink-divider" d="M32 0V36" />
}

function BeforeAndAfter({ look }: { look: string }): ReactElement {
  return (
    <Picture>
      <Scene />
      <CroppedView view={RIGHT_HALF}>
        <Scene look={look} />
      </CroppedView>
      <Divider />
    </Picture>
  )
}

function OnBackdrop({ isShadowed, children }: { isShadowed?: boolean; children?: ReactNode }): ReactElement {
  return (
    <Picture>
      <rect className="ink-backdrop" width="64" height="36" />
      <g className={isShadowed === true ? 'look-shadow' : undefined}>
        <ShrunkToFit box={CARD}>
          <Scene />
        </ShrunkToFit>
      </g>
      {children}
    </Picture>
  )
}

function FadeThrough({ ink }: { ink: string }): ReactElement {
  return (
    <Picture>
      <CroppedView view={{ x: 0, y: 0, width: 24, height: 36 }}>
        <Scene />
      </CroppedView>
      <CroppedView view={{ x: 40, y: 0, width: 24, height: 36 }}>
        <ArrivingScene />
      </CroppedView>
      <rect className={ink} x="16" width="8" height="36" opacity="0.5" />
      <rect className={ink} x="24" width="16" height="36" />
      <rect className={ink} x="40" width="8" height="36" opacity="0.5" />
    </Picture>
  )
}

function Wipe({ arriving, edge, chevron }: { arriving: Box; edge: string; chevron: string }): ReactElement {
  return (
    <Picture>
      <Scene />
      <CroppedView view={arriving}>
        <ArrivingScene />
      </CroppedView>
      <path className="ink-divider" d={edge} />
      <path className="ink-chevron" d={chevron} />
    </Picture>
  )
}

type Point = {
  x: number
  y: number
}

type Halfway = {
  leaving: Box
  leavingAt: Point
  arriving: Box
  arrivingAt: Point
  edge: string
  chevron: string
}

type Way = 'left' | 'right' | 'up' | 'down'

const HALFWAY: Record<Way, Halfway> = {
  left: {
    leaving: { x: 36, y: 0, width: 28, height: 36 },
    leavingAt: { x: 0, y: 0 },
    arriving: { x: 0, y: 0, width: 36, height: 36 },
    arrivingAt: { x: 28, y: 0 },
    edge: 'M28 0V36',
    chevron: 'M24 15L21 18L24 21',
  },
  right: {
    leaving: { x: 0, y: 0, width: 28, height: 36 },
    leavingAt: { x: 36, y: 0 },
    arriving: { x: 28, y: 0, width: 36, height: 36 },
    arrivingAt: { x: 0, y: 0 },
    edge: 'M36 0V36',
    chevron: 'M40 15L43 18L40 21',
  },
  up: {
    leaving: { x: 0, y: 20, width: 64, height: 16 },
    leavingAt: { x: 0, y: 0 },
    arriving: { x: 0, y: 0, width: 64, height: 20 },
    arrivingAt: { x: 0, y: 16 },
    edge: 'M0 16H64',
    chevron: 'M29 12L32 9L35 12',
  },
  down: {
    leaving: { x: 0, y: 0, width: 64, height: 16 },
    leavingAt: { x: 0, y: 20 },
    arriving: { x: 0, y: 16, width: 64, height: 20 },
    arrivingAt: { x: 0, y: 0 },
    edge: 'M0 20H64',
    chevron: 'M29 24L32 27L35 24',
  },
}

function Slide({ way }: { way: Way }): ReactElement {
  const halfway = HALFWAY[way]
  return (
    <Picture>
      <Scene />
      <g className="look-shadow">
        <CroppedView view={halfway.arriving} at={halfway.arrivingAt}>
          <ArrivingScene />
        </CroppedView>
      </g>
      <path className="ink-chevron" d={halfway.chevron} />
    </Picture>
  )
}

function Push({ way }: { way: Way }): ReactElement {
  const halfway = HALFWAY[way]
  return (
    <Picture>
      <CroppedView view={halfway.leaving} at={halfway.leavingAt}>
        <Scene />
      </CroppedView>
      <CroppedView view={halfway.arriving} at={halfway.arrivingAt}>
        <ArrivingScene />
      </CroppedView>
      <path className="ink-divider" d={halfway.edge} />
      <path className="ink-chevron" d={halfway.chevron} />
    </Picture>
  )
}

function CornerWipe({ arriving, edge, chevron }: { arriving: string; edge: string; chevron: string }): ReactElement {
  return (
    <Picture>
      <Scene />
      <path className="ink-other" d={arriving} />
      <path className="ink-divider" d={edge} />
      <path className="ink-chevron" d={chevron} />
    </Picture>
  )
}

function Shrinking({ turn }: { turn: number }): ReactElement {
  return (
    <Picture>
      <ArrivingScene />
      <g className="look-shadow" transform={`rotate(${turn} 32 18)`}>
        <ShrunkToFit box={{ x: 20, y: 11.25, width: 24, height: 13.5 }}>
          <Scene />
        </ShrunkToFit>
      </g>
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
      if ((row + column) % 2 === 0) blocks.push(<rect key={`${row}-${column}-tint`} className="ink-tint" x={x} y={y} width={BLOCK_SIZE} height={BLOCK_SIZE} />)
    }
  }
  return <g>{blocks}</g>
}

export const EFFECT_PREVIEWS: Record<EffectType, ReactElement> = {
  colorAdjust: <BeforeAndAfter look="look-vivid" />,
  look: <BeforeAndAfter look="look-graded" />,
  blackAndWhite: <BeforeAndAfter look="look-grey" />,
  sepia: <BeforeAndAfter look="look-sepia" />,
  tint: <BeforeAndAfter look="look-tint" />,
  invert: <BeforeAndAfter look="look-invert" />,
  vignette: (
    <OnScene>
      <path className="ink-shade look-soft" fillRule="evenodd" d="M0 0H64V36H0ZM6 18A26 16 0 1 0 58 18A26 16 0 1 0 6 18Z" />
    </OnScene>
  ),
  dropShadow: <OnBackdrop isShadowed />,
  border: (
    <OnBackdrop>
      <rect className="ink-border" x={CARD.x} y={CARD.y} width={CARD.width} height={CARD.height} />
    </OnBackdrop>
  ),
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
  sharpen: (
    <Picture>
      <Scene look="look-soft" />
      <CroppedView view={RIGHT_HALF}>
        <Scene />
      </CroppedView>
      <Divider />
    </Picture>
  ),
  blurFill: (
    <Picture>
      <Scene look="look-fill" />
      <ShrunkToFit box={FILLED_CARD}>
        <Scene />
      </ShrunkToFit>
    </Picture>
  ),
  chromaKey: (
    <Picture>
      <rect className="ink-key" width="32" height="36" />
      <CroppedView view={RIGHT_HALF}>
        <Scene />
      </CroppedView>
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
        <ArrivingScene />
      </g>
    </Picture>
  ),
  fadeBlack: <FadeThrough ink="ink-black" />,
  fadeWhite: <FadeThrough ink="ink-white" />,
  wipeLeft: <Wipe arriving={RIGHT_HALF} edge="M32 0V36" chevron="M29 15L26 18L29 21" />,
  wipeRight: <Wipe arriving={LEFT_HALF} edge="M32 0V36" chevron="M35 15L38 18L35 21" />,
  wipeUp: <Wipe arriving={BOTTOM_HALF} edge="M0 18H64" chevron="M29 15L32 12L35 15" />,
  wipeDown: <Wipe arriving={TOP_HALF} edge="M0 18H64" chevron="M29 21L32 24L35 21" />,
  wipeUpLeft: <CornerWipe arriving="M50 0H64V36H14Z" edge="M50 0L14 36" chevron="M30 12H26V16" />,
  wipeUpRight: <CornerWipe arriving="M0 0H14L50 36H0Z" edge="M14 0L50 36" chevron="M34 12H38V16" />,
  wipeDownLeft: <CornerWipe arriving="M14 0H64V36H50Z" edge="M14 0L50 36" chevron="M26 20V24H30" />,
  wipeDownRight: <CornerWipe arriving="M0 0H50L14 36H0Z" edge="M50 0L14 36" chevron="M40 20V24H36" />,
  slide: <Slide way="left" />,
  slideRight: <Slide way="right" />,
  slideUp: <Slide way="up" />,
  slideDown: <Slide way="down" />,
  push: <Push way="left" />,
  pushRight: <Push way="right" />,
  pushUp: <Push way="up" />,
  pushDown: <Push way="down" />,
  zoom: (
    <Picture>
      <Scene />
      <g className="look-shadow">
        <ShrunkToFit box={{ x: 16, y: 9, width: 32, height: 18 }}>
          <ArrivingScene />
        </ShrunkToFit>
      </g>
    </Picture>
  ),
  shrink: <Shrinking turn={0} />,
  spin: <Shrinking turn={-20} />,
  circleReveal: (
    <Picture>
      <Scene />
      <circle className="ink-other" cx="32" cy="18" r="13" />
      <rect className="ink-card" x="24" y="13" width="16" height="10" rx="2" />
    </Picture>
  ),
  circleClose: (
    <Picture>
      <ArrivingScene />
      <circle className="ink-sky" cx="32" cy="18" r="11" />
      <circle className="ink-sun" cx="36" cy="14" r="3" />
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
      <CroppedView view={REGION}>
        <Scene look="look-soft" />
      </CroppedView>
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
