'use strict'

const PALETTES = {
  day: {
    skin: '#f0c39a', skinShade: '#d9a273', hair: '#1c1a24', gi: '#f3ecdc', giShade: '#d6cbb2',
    hakama: '#34405e', hakamaShade: '#272f49', sash: '#c4472f', sashShade: '#9e3522', sole: '#3a2b24',
    steel: '#dfe5ec', steelShade: '#a9b3bf', gold: '#d6a93c', scabbard: '#2b2320',
    mouth: '#5a1f1a', tongue: '#c4574a', teeth: '#ffffff',
  },
  night: {
    skin: '#8f86b8', skinShade: '#6f669c', hair: '#14121f', gi: '#a9b3d6', giShade: '#8690bd',
    hakama: '#232a4a', hakamaShade: '#1a2039', sash: '#7c3a63', sashShade: '#5e2a4c', sole: '#1e1a2a',
    steel: '#c9d6f2', steelShade: '#8d9bc4', gold: '#a99560', scabbard: '#1a1624',
    mouth: '#2c1730', tongue: '#6f3d63', teeth: '#d9def0',
  },
  monk: {
    skin: '#e7b48a', skinShade: '#cc9468', hair: '#1c1a24', gi: '#e98c2f', giShade: '#c86f1d',
    hakama: '#8a3b22', hakamaShade: '#6e2d19', sash: '#f2d27a', sashShade: '#d4b25a', sole: '#3a2b24',
    steel: '#dfe5ec', steelShade: '#a9b3bf', gold: '#d6a93c', scabbard: '#2b2320',
    mouth: '#5a1f1a', tongue: '#c4574a', teeth: '#ffffff',
  },
}

const BACKDROPS = {
  dusk: { sky: ['#f6c47c', '#f0a663', '#e8875a'], sun: '#fde7b0', far: '#d78468', mid: '#a6585a', near: '#5c3447', front: '#3a2134' },
  night: { sky: ['#2d3560', '#232a4f', '#1a1f3d'], sun: '#e8ecff', far: '#3a3f6e', mid: '#2b2f57', near: '#1d2040', front: '#12142b' },
  bamboo: { sky: ['#e3edc4', '#d2e3a8', '#bdd68f'], sun: '#f7f9e6', far: '#9dbd75', mid: '#6b9655', near: '#456c3e', front: '#28442a' },
}

const SHOULDERS = { R: [-72, -455], L: [72, -455] }
const UPPER_ARM = 94
const FOREARM = 88
const BLADE = 280
const HAKAMA = 'M-60 -306 L60 -306 L116 -36 Q70 -24 20 -32 L6 -176 L-6 -176 L-20 -32 Q-70 -24 -116 -36Z'
const TAIL_A = [[48, -594], [100, -612], [160, -600], [214, -618], [262, -598]]
const TAIL_B = [[48, -588], [96, -578], [150, -586], [198, -566], [236, -574]]

function darker(hex, amount) {
  const value = parseInt(hex.slice(1), 16)
  const channel = (shift) => Math.round(((value >> shift) & 255) * (1 - amount))
  return `rgb(${channel(16)} ${channel(8)} ${channel(0)})`
}

function painter(lineStyle = {}) {
  const hasLine = lineStyle.line === 'black' || lineStyle.line === 'darker'
  const strokeFor = (fill) => (lineStyle.line === 'black' ? '#141218' : darker(fill, lineStyle.darken ?? 0.45))
  const paint = (fill) =>
    hasLine ? `fill="${fill}" stroke="${strokeFor(fill)}" stroke-width="${lineStyle.width}" stroke-linejoin="round" paint-order="stroke"` : `fill="${fill}"`
  return {
    part: (d, fill) => `<path d="${d}" ${paint(fill)}/>`,
    flat: (d, fill) => `<path d="${d}" fill="${fill}"/>`,
    blob: (cx, cy, rx, ry, fill) => `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" ${paint(fill)}/>`,
    dot: (cx, cy, rx, ry, fill) => `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${fill}"/>`,
  }
}

function rotated(length, degrees) {
  const radians = (degrees * Math.PI) / 180
  return [-length * Math.sin(radians), length * Math.cos(radians)]
}

function armJoints(side, joint) {
  const [sx, sy] = SHOULDERS[side]
  const [ex, ey] = rotated(UPPER_ARM, joint.shoulder)
  const elbow = [sx + ex, sy + ey]
  const [hx, hy] = rotated(FOREARM, joint.shoulder + joint.elbow)
  const hand = [elbow[0] + hx, elbow[1] + hy]
  const [tx, ty] = rotated(BLADE, joint.shoulder + joint.elbow + (joint.sword ?? 0))
  return { shoulder: [sx, sy], elbow, hand, tip: [hand[0] + tx, hand[1] + ty] }
}

function smoothPoints(points, steps) {
  const samples = []
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)]
    const p1 = points[i]
    const p2 = points[i + 1]
    const p3 = points[Math.min(points.length - 1, i + 2)]
    for (let s = 0; s < steps; s++) {
      const t = s / steps
      const t2 = t * t
      const t3 = t2 * t
      const at = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3)
      samples.push([at(p0[0], p1[0], p2[0], p3[0]), at(p0[1], p1[1], p2[1], p3[1])])
    }
  }
  samples.push(points[points.length - 1])
  return samples
}

function taperedOutline(points, startWidth, endWidth) {
  const samples = smoothPoints(points, 10)
  const left = []
  const right = []
  samples.forEach((point, i) => {
    const previous = samples[Math.max(0, i - 1)]
    const next = samples[Math.min(samples.length - 1, i + 1)]
    const dx = next[0] - previous[0]
    const dy = next[1] - previous[1]
    const length = Math.hypot(dx, dy) || 1
    const t = i / (samples.length - 1)
    const half = (endWidth + (startWidth - endWidth) * Math.pow(1 - t, 0.8)) / 2
    left.push([point[0] - (dy / length) * half, point[1] + (dx / length) * half])
    right.push([point[0] + (dy / length) * half, point[1] - (dx / length) * half])
  })
  return [...left, ...right.reverse()]
}

function pathOf(outline) {
  return `M${outline.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(' L')}Z`
}

const MOUTHS = {
  none: () => '',
  smile: (c) => `<path d="M-13 -4 Q0 9 13 -4 Q0 2 -13 -4Z" fill="${c.mouth}"/>`,
  X: (c) => `<rect x="-10" y="-1.5" width="20" height="3" rx="1.5" fill="${c.mouth}"/>`,
  A: (c) => `<path d="M-12 -1 Q0 2 12 -1 L12 1.5 Q0 4.5 -12 1.5Z" fill="${c.mouth}"/>`,
  B: (c) => `<path d="M-13 -3 Q0 -5 13 -3 Q12 5 0 6 Q-12 5 -13 -3Z" fill="${c.mouth}"/><path d="M-11 -3 Q0 -4.6 11 -3 L10 0 Q0 -1 -10 0Z" fill="${c.teeth}"/>`,
  C: (c) => `<ellipse cx="0" cy="1" rx="14" ry="7.5" fill="${c.mouth}"/><path d="M-11 -4 Q0 -6.5 11 -4 L10 -1 Q0 -3 -10 -1Z" fill="${c.teeth}"/>`,
  D: (c) => `<path d="M-15 -4 Q0 -7 15 -4 Q13 15 0 16 Q-13 15 -15 -4Z" fill="${c.mouth}"/><path d="M-8 10 Q0 6 8 10 Q4 14.5 0 15 Q-4 14.5 -8 10Z" fill="${c.tongue}"/><path d="M-13 -3.5 Q0 -6 13 -3.5 L12 -0.5 Q0 -2.5 -12 -0.5Z" fill="${c.teeth}"/>`,
  E: (c) => `<ellipse cx="0" cy="2" rx="9" ry="10" fill="${c.mouth}"/><path d="M-5 8 Q0 5 5 8 Q2.5 11 0 11 Q-2.5 11 -5 8Z" fill="${c.tongue}"/>`,
  F: (c) => `<ellipse cx="0" cy="1" rx="5.5" ry="6" fill="${c.mouth}"/>`,
  G: (c) => `<path d="M-11 -2 Q0 -3 11 -2 Q10 4 0 4.5 Q-10 4 -11 -2Z" fill="${c.mouth}"/><rect x="-8" y="-2.5" width="16" height="3.5" rx="1" fill="${c.teeth}"/>`,
  H: (c) => `<ellipse cx="0" cy="2" rx="12" ry="9" fill="${c.mouth}"/><path d="M-6 7 Q0 -5 6 7Z" fill="${c.tongue}"/>`,
}

function eyesOf(kind, c, p) {
  if (kind === 'closed') {
    return p.flat('M-24 -561 Q-17 -556 -10 -561 L-10 -558 Q-17 -552 -24 -558Z', c.hair) + p.flat('M24 -561 Q17 -556 10 -561 L10 -558 Q17 -552 24 -558Z', c.hair)
  }
  return p.dot(-17, -562, 5.5, 8, c.hair) + p.dot(17, -562, 5.5, 8, c.hair)
}

function browsOf(kind, c, p) {
  if (kind === 'angry') {
    return p.flat('M-33 -590 L-7 -577 L-8 -569 L-33 -581Z', c.hair) + p.flat('M33 -590 L7 -577 L8 -569 L33 -581Z', c.hair)
  }
  return p.flat('M-32 -585 L-8 -580 L-8 -573 L-32 -577Z', c.hair) + p.flat('M32 -585 L8 -580 L8 -573 L32 -577Z', c.hair)
}

function headOf(pose, c, p) {
  const hasHair = !pose.bald
  const hasBand = hasHair && pose.headband !== false
  const tails = hasBand ? p.part(pathOf(taperedOutline(TAIL_A, 16, 1.5)), c.sash) + p.part(pathOf(taperedOutline(TAIL_B, 13, 1.5)), c.sashShade) : ''
  const hair = hasHair
    ? p.blob(0, -654, 13, 17, c.hair) +
      p.part('M-46 -582 Q-50 -632 0 -638 Q50 -632 46 -582 L40 -584 Q36 -606 0 -608 Q-36 -606 -40 -584Z', c.hair) +
      p.flat('M-46 -584 L-40 -584 L-39 -552 L-45 -558Z', c.hair) +
      p.flat('M46 -584 L40 -584 L39 -552 L45 -558Z', c.hair) +
      p.part('M-9 -643 L9 -643 L9 -635 L-9 -635Z', c.sash)
    : ''
  const band = hasBand ? p.part('M-47 -598 Q0 -614 47 -598 L46 -585 Q0 -601 -46 -585Z', c.sash) + p.blob(49, -591, 8, 9, c.sash) : ''
  return `<g transform="rotate(${pose.headTilt ?? 0} 0 -505)">
    ${tails}
    ${p.blob(-41, -556, 7, 12, c.skin)}${p.blob(41, -556, 7, 12, c.skin)}
    ${p.part('M-40 -604 Q-46 -560 -36 -530 L-18 -508 Q0 -500 18 -508 L36 -530 Q46 -560 40 -604 Q0 -626 -40 -604Z', c.skin)}
    ${p.flat('M28 -606 Q41 -602 42 -588 Q45 -560 36 -530 L18 -508 Q30 -540 28 -606Z', c.skinShade)}
    ${p.flat('M1 -566 L8 -543 L-2 -541Z', c.skinShade)}
    ${eyesOf(pose.eyes, c, p)}${browsOf(pose.brows, c, p)}
    <g transform="translate(0 -526)">${MOUTHS[pose.mouth ?? 'X'](c)}</g>
    ${hair}${band}
  </g>`
}

function heldSword(c, p) {
  return (
    p.flat('M-7 -46 L7 -46 L7 -38 L-7 -38Z', c.scabbard) +
    p.part('M-7 -40 L7 -40 L7 6 L-7 6Z', c.gi) +
    p.blob(0, 10, 16, 5, c.gold) +
    p.part('M-5 14 L5 14 L6 250 Q4 270 -2 280 L-5 250Z', c.steel) +
    p.flat('M1 16 L5 16 L6 250 Q5 262 2 270Z', c.steelShade)
  )
}

function armOf(side, joint, c, p) {
  const [sx, sy] = SHOULDERS[side]
  const sword = joint.holding ? `<g transform="translate(0 ${FOREARM}) rotate(${joint.sword ?? 0})">${heldSword(c, p)}</g>` : ''
  const forearm = `<g transform="translate(0 ${UPPER_ARM}) rotate(${joint.elbow})">${p.part('M-10 -10 L10 -10 L8 80 L-8 80Z', c.skin)}${sword}${p.blob(0, FOREARM, 12, 14, c.skin)}</g>`
  const sleeve = p.part('M-24 -12 Q0 -24 24 -12 L36 98 Q2 116 -34 102Z', c.gi) + p.flat('M10 -18 Q20 -16 24 -12 L36 98 Q30 102 22 104Z', c.giShade)
  return `<g transform="translate(${sx} ${sy}) rotate(${joint.shoulder})">${forearm}${sleeve}</g>`
}

function kenta(pose = {}, options = {}) {
  const unfilled = options.unfilled ?? []
  const c = Object.fromEntries(Object.entries(PALETTES[options.palette ?? 'day']).map(([key, value]) => [key, unfilled.includes(key) ? '#ffffff' : value]))
  const p = painter(options.lineStyle)
  const armR = { shoulder: 10, elbow: 6, ...pose.armR }
  const armL = pose.armL === null ? null : { shoulder: -10, elbow: -6, ...pose.armL }
  const isDrawn = Boolean(armR.holding || armL?.holding)
  const hilt = 'translate(58 -306) rotate(-28)'
  const handle = isDrawn
    ? ''
    : `<g transform="${hilt}">${p.blob(0, 0, 5, 17, c.gold)}${p.part('M5 -8 L74 -7 Q80 0 74 7 L5 8Z', c.gi)}${[18, 34, 50, 66]
        .map((x) => p.flat(`M${x - 5} 0 L${x} -6 L${x + 5} 0 L${x} 6Z`, c.scabbard))
        .join('')}${p.flat('M72 -7 L81 -5 L81 5 L72 7Z', c.scabbard)}</g>`
  return `<g transform="rotate(${pose.lean ?? 0})">
    <g transform="${hilt}">${p.part('M-6 -9 L-300 -6 Q-312 0 -300 6 L-6 9Z', c.scabbard)}</g>
    ${p.part('M-100 -8 Q-100 -26 -62 -28 Q-28 -28 -26 -10 Q-26 -2 -40 -2 L-90 -2 Q-100 -2 -100 -8Z', c.skin)}
    ${p.part('M100 -8 Q100 -26 62 -28 Q28 -28 26 -10 Q26 -2 40 -2 L90 -2 Q100 -2 100 -8Z', c.skin)}
    ${p.flat('M-102 -6 L-24 -6 L-24 2 L-102 2Z', c.sole)}${p.flat('M102 -6 L24 -6 L24 2 L102 2Z', c.sole)}
    ${p.part(HAKAMA, c.hakama)}
    ${p.flat('M34 -306 L60 -306 L116 -36 Q100 -31 84 -30Z', c.hakamaShade)}
    ${p.flat('M-36 -300 L-31 -300 L-70 -36 L-77 -36Z', c.hakamaShade)}
    ${p.flat('M18 -300 L23 -300 L52 -30 L45 -30Z', c.hakamaShade)}
    ${p.part('M-15 -512 L15 -512 L17 -458 L-17 -458Z', c.skin)}
    ${p.flat('M-15 -512 L15 -512 L15 -496 Q0 -490 -15 -496Z', c.skinShade)}
    ${p.part('M-74 -466 Q0 -484 74 -466 L66 -312 L-66 -312Z', c.gi)}
    ${p.flat('M-24 -476 L24 -476 L0 -404Z', c.skin)}
    ${p.flat('M-24 -476 L-12 -478 L34 -312 L18 -312Z', c.giShade)}
    ${p.flat('M24 -476 L12 -478 L-2 -428 L4 -418Z', c.giShade)}
    ${p.flat('M46 -472 Q60 -470 74 -466 L66 -312 L48 -312Z', c.giShade)}
    ${p.part('M-66 -326 L66 -326 L64 -294 L-64 -294Z', c.sash)}
    ${p.flat('M-64 -304 L64 -304 L64 -294 L-64 -294Z', c.sashShade)}
    ${p.part('M-44 -306 L-30 -300 L-40 -250 L-56 -254Z', c.sash)}
    ${p.part('M-36 -304 L-24 -302 L-22 -262 L-34 -262Z', c.sashShade)}
    ${handle}
    ${headOf(pose, c, p)}
    ${armOf('R', armR, c, p)}
    ${armL ? armOf('L', armL, c, p) : ''}
  </g>`
}

function oni() {
  const skin = '#a3312f'
  const shade = '#7e2424'
  const dark = '#2a2433'
  return `<g>
    <path d="M-112 -4 Q-112 -30 -72 -32 Q-30 -32 -28 -4Z" fill="${dark}"/>
    <path d="M112 -4 Q112 -30 72 -32 Q30 -32 28 -4Z" fill="${dark}"/>
    <path d="M-92 -210 L-30 -210 L-36 -26 L-88 -26Z" fill="${skin}"/>
    <path d="M92 -210 L30 -210 L36 -26 L88 -26Z" fill="${shade}"/>
    <path d="M-104 -320 L104 -320 L110 -180 L14 -160 L0 -200 L-14 -160 L-110 -180Z" fill="${dark}"/>
    <path d="M-140 -540 Q0 -585 140 -540 L104 -318 L-104 -318Z" fill="${skin}"/>
    <path d="M60 -556 Q110 -552 140 -540 L104 -318 L70 -318Z" fill="${shade}"/>
    <path d="M-60 -450 Q0 -430 60 -450 Q50 -400 0 -395 Q-50 -400 -60 -450Z" fill="${shade}"/>
    <path d="M-138 -538 L-196 -480 L-214 -330 L-170 -318 L-150 -460Z" fill="${skin}"/>
    <ellipse cx="-192" cy="-312" rx="30" ry="28" fill="${skin}"/>
    <path d="M138 -538 L196 -480 L214 -330 L170 -318 L150 -460Z" fill="${shade}"/>
    <ellipse cx="192" cy="-312" rx="30" ry="28" fill="${shade}"/>
    <path d="M-62 -600 Q-74 -540 -42 -515 L42 -515 Q74 -540 62 -600 Q0 -642 -62 -600Z" fill="${skin}"/>
    <path d="M-48 -612 Q-96 -650 -104 -730 Q-70 -690 -24 -628Z" fill="#ecdfc2"/>
    <path d="M48 -612 Q96 -650 104 -730 Q70 -690 24 -628Z" fill="#ecdfc2"/>
    <path d="M-46 -590 L-6 -574 L6 -574 L46 -590 L46 -580 L6 -564 L-6 -564 L-46 -580Z" fill="${dark}"/>
    <path d="M-40 -572 L-10 -562 Q-26 -548 -40 -560Z" fill="#f6d44a"/>
    <path d="M40 -572 L10 -562 Q26 -548 40 -560Z" fill="#f6d44a"/>
    <rect x="-26" y="-568" width="4" height="12" fill="${dark}"/><rect x="22" y="-568" width="4" height="12" fill="${dark}"/>
    <path d="M-40 -540 Q0 -500 40 -540 Q24 -518 0 -515 Q-24 -518 -40 -540Z" fill="${dark}"/>
    <path d="M-30 -534 L-24 -524 L-18 -530 L-12 -521 L-6 -527 L0 -519 L6 -527 L12 -521 L18 -530 L24 -524 L30 -534Z" fill="#ffffff"/>
  </g>`
}

function crow() {
  return `<g>
    <path d="M-150 -150 Q-40 -260 90 -190 L190 -215 L120 -160 Q100 -60 -20 -50 L-160 -20 L-100 -80Z" fill="#1c1a24"/>
    <path d="M95 -200 L165 -180 L95 -168Z" fill="#d6a93c"/>
    <circle cx="70" cy="-192" r="8" fill="#f6d44a"/>
    <path d="M-10 -52 L-24 0 M30 -56 L22 0" stroke="#d6a93c" stroke-width="10" stroke-linecap="round"/>
  </g>`
}

function lantern() {
  return `<g>
    <rect x="-10" y="-430" width="20" height="40" fill="#2b2320"/>
    <ellipse cx="0" cy="-240" rx="150" ry="180" fill="#c4472f"/>
    <path d="M-60 -405 Q-110 -240 -60 -75 L-40 -75 Q-80 -240 -40 -405Z" fill="#9e3522"/>
    <path d="M60 -405 Q110 -240 60 -75 L40 -75 Q80 -240 40 -405Z" fill="#9e3522"/>
    <rect x="-80" y="-410" width="160" height="26" rx="6" fill="#2b2320"/>
    <rect x="-80" y="-96" width="160" height="26" rx="6" fill="#2b2320"/>
  </g>`
}

function sword() {
  return `<g transform="rotate(-62)">${heldSword(PALETTES.day, painter())}</g>`
}

function background(variant = 'dusk') {
  const v = BACKDROPS[variant]
  const stalks =
    variant === 'bamboo'
      ? Array.from({ length: 10 }, (_, i) => {
          const x = 70 + i * 196 + (i % 3) * 22
          return `<rect x="${x}" y="0" width="28" height="1080" fill="${v.near}"/>${[220, 470, 720].map((y) => `<rect x="${x - 2}" y="${y + i * 9}" width="32" height="7" fill="${v.front}"/>`).join('')}`
        }).join('')
      : ''
  const tree =
    variant === 'bamboo'
      ? ''
      : `<path d="M1640 1000 L1660 620 Q1640 560 1580 540 L1600 530 Q1650 545 1672 590 Q1690 520 1760 500 L1770 510 Q1705 540 1690 620 L1700 1000Z" fill="${v.front}"/>
         <path d="M1470 545 Q1560 470 1660 500 Q1760 440 1880 505 Q1800 545 1700 532 Q1600 565 1470 545Z" fill="${v.front}"/>`
  return `<rect width="1920" height="1080" fill="${v.sky[0]}"/>
    <rect width="1920" height="430" fill="${v.sky[1]}"/>
    <rect width="1920" height="210" fill="${v.sky[2]}"/>
    <circle cx="1360" cy="${variant === 'night' ? 260 : 430}" r="${variant === 'night' ? 110 : 170}" fill="${v.sun}"/>
    <path d="M0 640 L180 480 L330 570 L520 380 L700 550 L880 460 L1080 610 L1260 470 L1460 600 L1660 440 L1920 570 L1920 1080 L0 1080Z" fill="${v.far}"/>
    ${stalks}
    <path d="M0 760 Q260 640 540 730 T1120 700 T1920 690 L1920 1080 L0 1080Z" fill="${v.mid}"/>
    <path d="M0 880 Q500 820 980 860 T1920 840 L1920 1080 L0 1080Z" fill="${v.near}"/>
    <path d="M0 990 Q600 950 1200 985 T1920 970 L1920 1080 L0 1080Z" fill="${v.front}"/>
    ${tree}
    <path d="M420 250 l16 9 l16 -9 l-16 5z M480 300 l12 7 l12 -7 l-12 4z M372 318 l10 6 l10 -6 l-10 3z" fill="${v.front}"/>`
}

/* One-contour body: arms and legs are node sets of the same shape, so the outline only runs around the outside */

const BODY_NODES = [
  { x: -17, y: -472, set: 'body' },
  { x: -74, y: -464, set: 'body', smooth: true },
  { x: -100, y: -432, set: 'armR', smooth: true },
  { x: -116, y: -362, set: 'armR' },
  { x: -84, y: -346, set: 'armR' },
  { x: -66, y: -398, set: 'body' },
  { x: -63, y: -316, set: 'body', smooth: true },
  { x: -116, y: -40, set: 'legR' },
  { x: -18, y: -32, set: 'legR' },
  { x: 0, y: -178, set: 'body' },
  { x: 18, y: -32, set: 'legL' },
  { x: 116, y: -40, set: 'legL' },
  { x: 63, y: -316, set: 'body', smooth: true },
  { x: 66, y: -398, set: 'body' },
  { x: 84, y: -346, set: 'armL' },
  { x: 116, y: -362, set: 'armL' },
  { x: 100, y: -432, set: 'armL', smooth: true },
  { x: 74, y: -464, set: 'body', smooth: true },
  { x: 17, y: -472, set: 'body' },
]
const PIVOTS = { armR: [-70, -452], armL: [70, -452], legR: [-34, -300], legL: [34, -300] }
const HANDS = { armR: 'M-106 -372 L-86 -372 L-86 -298 A13 13 0 1 1 -106 -298Z', armL: 'M106 -372 L86 -372 L86 -298 A13 13 0 1 0 106 -298Z' }
const FEET = {
  legR: 'M-100 -8 Q-100 -30 -62 -32 Q-28 -32 -26 -10 Q-26 -2 -40 -2 L-90 -2 Q-100 -2 -100 -8Z',
  legL: 'M100 -8 Q100 -30 62 -32 Q28 -32 26 -10 Q26 -2 40 -2 L90 -2 Q100 -2 100 -8Z',
}
const OUTLINE = '#141218'
let clipCount = 0

function rotateAround([px, py], degrees, [x, y]) {
  const radians = (degrees * Math.PI) / 180
  const dx = x - px
  const dy = y - py
  return [px + dx * Math.cos(radians) - dy * Math.sin(radians), py + dx * Math.sin(radians) + dy * Math.cos(radians)]
}

function posedNodes(rotations = {}) {
  return BODY_NODES.map((node) => {
    const degrees = rotations[node.set] ?? 0
    if (degrees === 0 || !PIVOTS[node.set]) return { ...node }
    const [x, y] = rotateAround(PIVOTS[node.set], degrees, [node.x, node.y])
    return { ...node, x, y }
  })
}

function nodeHandles(nodes) {
  return nodes.map((node, i) => {
    if (!node.smooth) return { in: [node.x, node.y], out: [node.x, node.y] }
    const previous = nodes[(i - 1 + nodes.length) % nodes.length]
    const next = nodes[(i + 1) % nodes.length]
    const tx = (next.x - previous.x) / 6
    const ty = (next.y - previous.y) / 6
    return { in: [node.x - tx, node.y - ty], out: [node.x + tx, node.y + ty] }
  })
}

function curvePath(nodes, isClosed = true) {
  const handles = nodeHandles(nodes)
  const point = ([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`
  let d = `M${point([nodes[0].x, nodes[0].y])}`
  const last = isClosed ? nodes.length : nodes.length - 1
  for (let i = 1; i <= last; i++) {
    const from = i - 1
    const to = i % nodes.length
    d += ` C${point(handles[from].out)} ${point(handles[to].in)} ${point([nodes[to].x, nodes[to].y])}`
  }
  return isClosed ? `${d}Z` : d
}

function figure(pose = {}, options = {}) {
  const c = PALETTES[options.palette ?? 'day']
  const p = painter({ line: 'black', width: 7 })
  const rotations = pose.rotations ?? {}
  const body = curvePath(posedNodes(rotations))
  const id = `body-clip-${clipCount++}`
  const turned = (set, d, fill) => `<path d="${d}" fill="${fill}" stroke="${OUTLINE}" stroke-width="7" stroke-linejoin="round" transform="rotate(${rotations[set] ?? 0} ${PIVOTS[set].join(' ')})"/>`
  return `<g>
    <defs><clipPath id="${id}"><path d="${body}"/></clipPath></defs>
    ${turned('armR', HANDS.armR, c.skin)}${turned('armL', HANDS.armL, c.skin)}
    ${turned('legR', FEET.legR, c.skin)}${turned('legL', FEET.legL, c.skin)}
    ${p.part('M-15 -512 L15 -512 L17 -458 L-17 -458Z', c.skin)}
    <path d="${body}" fill="${c.gi}"/>
    <g clip-path="url(#${id})">
      <rect x="-240" y="-306" width="480" height="320" fill="${c.hakama}"/>
      <path d="M30 -306 L240 -306 L240 0 L84 0Z" fill="${c.hakamaShade}"/>
      <rect x="-240" y="-328" width="480" height="34" fill="${c.sash}"/>
      <rect x="-240" y="-304" width="480" height="10" fill="${c.sashShade}"/>
      <path d="M-24 -480 L24 -480 L0 -404Z" fill="${c.skin}"/>
      <path d="M-24 -480 L-12 -482 L34 -328 L18 -328Z" fill="${c.giShade}"/>
      <path d="M46 -480 L92 -480 L70 -328 L48 -328Z" fill="${c.giShade}"/>
    </g>
    <path d="${body}" fill="none" stroke="${OUTLINE}" stroke-width="7" stroke-linejoin="round"/>
    ${headOf(pose, c, p)}
  </g>`
}
