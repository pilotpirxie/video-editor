'use strict'

Object.assign(ICONS, {
  node: 'M3.5 2.5l7 4.3-3.3 1-1.6 3.4zM10.5 10.5h3v3h-3z',
  rectangle: 'M2.5 3.5h11v9h-11z',
  ellipse: 'M8 3c3.3 0 5.5 2.2 5.5 5S11.3 13 8 13 2.5 10.8 2.5 8 4.7 3 8 3z',
  pipette: 'M10.5 2.5l3 3-2 2-3-3zM9.5 5.5l-6 6-1 2 2-1 6-6',
  line: 'M3 13L13 3',
  group: 'M2.5 2.5h7v7h-7zM6.5 6.5h7v7h-7z',
  curve: 'M2.5 13C3 6 7 3 13.5 3',
})

const DAY = PALETTES.day
const MONK = PALETTES.monk
const SKIN_STAGE = '#e9c3a0'

/* Small pictures */

function smallIcon(content) {
  return `<svg class="icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">${content}</svg>`
}

const STROKE_ICONS = {
  none: smallIcon('<circle cx="8" cy="8" r="5.5"/><path d="M4.2 11.8l7.6-7.6"/>'),
  solid: smallIcon('<path d="M2.5 8h11" stroke-width="2.5"/>'),
  dashed: smallIcon('<path d="M2.5 8h11" stroke-width="2.5" stroke-dasharray="2.6 2" stroke-linecap="butt"/>'),
  butt: smallIcon('<path d="M2 8h8" stroke-width="5" stroke-linecap="butt"/><path d="M10 2.5v11" stroke-width="1"/>'),
  round: smallIcon('<path d="M2 8h5.5" stroke-width="5" stroke-linecap="round"/><path d="M10 2.5v11" stroke-width="1"/>'),
  square: smallIcon('<path d="M2 8h5.5" stroke-width="5" stroke-linecap="square"/><path d="M10 2.5v11" stroke-width="1"/>'),
  mitre: smallIcon('<path d="M3.5 13L8 4.5l4.5 8.5" stroke-width="3" stroke-linejoin="miter" stroke-linecap="butt"/>'),
  roundJoin: smallIcon('<path d="M3.5 13L8 4.5l4.5 8.5" stroke-width="3" stroke-linejoin="round" stroke-linecap="butt"/>'),
  bevel: smallIcon('<path d="M3.5 13L8 4.5l4.5 8.5" stroke-width="3" stroke-linejoin="bevel" stroke-linecap="butt"/>'),
  inside: smallIcon('<rect x="3" y="3" width="10" height="10" stroke-width="0.8" stroke-dasharray="1.2 1.2"/><rect x="4.7" y="4.7" width="6.6" height="6.6" stroke-width="2"/>'),
  centre: smallIcon('<rect x="3" y="3" width="10" height="10" stroke-width="2.2"/>'),
  outside: smallIcon('<rect x="3" y="3" width="10" height="10" stroke-width="0.8" stroke-dasharray="1.2 1.2"/><rect x="1.4" y="1.4" width="13.2" height="13.2" stroke-width="1.6"/>'),
  behind: smallIcon('<rect x="2.5" y="2.5" width="8" height="8" stroke-width="2"/><rect x="5.5" y="5.5" width="8" height="8" fill="currentColor" stroke="none"/>'),
  front: smallIcon('<rect x="5.5" y="5.5" width="8" height="8" fill="currentColor" stroke="none" opacity="0.45"/><rect x="2.5" y="2.5" width="8" height="8" stroke-width="2"/>'),
}

function segmented(label, options, chosen) {
  const buttons = options.map((option) => `<button class="button" aria-pressed="${option === chosen}">${option}</button>`).join('')
  return labelled(label, `<div class="segmented wide">${buttons}</div>`)
}

function iconChoice(label, options, chosen) {
  const buttons = options.map((key) => `<button class="button" aria-pressed="${key === chosen}" title="${key}">${STROKE_ICONS[key]}</button>`).join('')
  return labelled(label, `<div class="segmented wide">${buttons}</div>`)
}

function sliderRow(label, background, position, value) {
  return `<div class="slider-row"><span class="slider-label">${label}</span><div class="slider-track" style="background:${background}"><span class="knob" style="left:${position * 100}%"></span></div>${input(value)}</div>`
}

function plainSlider(position) {
  return `<div class="slider-track plain" style="--value:${position * 100}%"><span class="knob" style="left:${position * 100}%"></span></div>`
}

function hexToHsl(hex) {
  const value = parseInt(hex.slice(1), 16)
  const [r, g, b] = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((channel) => channel / 255)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const lightness = (max + min) / 2
  if (max === min) return [0, 0, Math.round(lightness * 100)]
  const delta = max - min
  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min)
  const hue = max === r ? (g - b) / delta + (g < b ? 6 : 0) : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4
  return [Math.round(hue * 60), Math.round(saturation * 100), Math.round(lightness * 100)]
}

function colourPanel(name, hex, chips) {
  const [h, s, l] = hexToHsl(hex)
  const swatches = chips
    .map(([chipName, colour]) => `<span class="chip ${chipName === name ? 'chosen' : ''}" title="${chipName}" style="background:${colour}"></span>`)
    .join('')
  return group(
    'Colour',
    'droplet',
    `<div class="colour-head"><span class="colour-wells"><span class="fill" style="background:${hex}"></span><span class="stroke"></span></span><span class="field-label">Fill: ${name}</span>${pickerControl('HSL')}</div>` +
      sliderRow('H', 'linear-gradient(to right, red, yellow, lime, cyan, blue, magenta, red)', h / 360, h) +
      sliderRow('S', `linear-gradient(to right, hsl(${h} 0% ${l}%), hsl(${h} 100% ${l}%))`, s / 100, s) +
      sliderRow('L', `linear-gradient(to right, #000, hsl(${h} ${s}% 50%), #fff)`, l / 100, l) +
      '<div class="spectrum"></div>' +
      `<div class="slider-row"><span class="slider-label">${icon('droplet')}</span>${plainSlider(1)}${input('100%')}</div>` +
      `<div class="chip-grid">${swatches}<span class="chip add">${icon('plus')}</span></div>`,
  )
}

function strokePanel(isOpen = true) {
  const width = `<div class="slider-row" style="grid-template-columns:1fr 52px">${plainSlider(0.22)}${input('7')}</div>`
  const pressure = `<div class="pressure-box"><svg viewBox="0 0 100 24" preserveAspectRatio="none"><path d="M0 21 C 30 21 45 3 100 3" fill="none" stroke="var(--primary)" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg></div>`
  return group(
    'Stroke',
    'line',
    iconChoice('Style', ['none', 'solid', 'dashed'], 'solid') +
      labelled('Width (px)', width) +
      pair(iconChoice('Cap', ['butt', 'round', 'square'], 'round'), iconChoice('Join', ['mitre', 'roundJoin', 'bevel'], 'roundJoin')) +
      pair(iconChoice('Align', ['inside', 'centre', 'outside'], 'centre'), iconChoice('Order', ['behind', 'front'], 'front')) +
      check('Scale with object', true) +
      labelled('Pressure', pressure),
    isOpen,
  )
}

const KENTA_CHIPS = [
  ['Line', OUTLINE], ['Skin', DAY.skin], ['Skin shade', DAY.skinShade], ['Hair', DAY.hair], ['Gi', DAY.gi], ['Gi shade', DAY.giShade],
  ['Hakama', DAY.hakama], ['Hakama shade', DAY.hakamaShade], ['Sash', DAY.sash], ['Straw', '#d9b86a'],
]

function tools(active, fill) {
  const list = [['pointer', 'Move'], ['node', 'Node'], null, ['pen', 'Pen'], ['pencil', 'Pencil'], ['brush', 'Brush'], ['bucket', 'Fill'], null, ['rectangle', 'Rectangle'], ['ellipse', 'Ellipse'], null, ['pipette', 'Colour picker']]
  const buttons = list.map((tool) => (tool ? iconButton(tool[0], tool[1], tool[0] === active ? 'on' : '') : '<hr>')).join('')
  return `<div class="floating-tools">${buttons}<div class="tool-wells"><span class="fill" style="background:${fill}"></span><span class="stroke"></span></div></div>`
}

/* Left panel: shapes of the open drawing, like Affinity's Layers */

function shapeRow(row) {
  const indent = row.isClipped ? '<span class="chevron-space"></span><span class="clip-mark"></span>' : row.isGroup ? icon('chevronDown') : '<span class="chevron-space"></span>'
  return `<li class="layer-row ${row.isSelected ? 'selected' : ''}">${indent}<span class="layer-thumb">${row.thumb}</span><span class="layer-name">${row.name}</span>${iconButton('eye', 'Hide')}${iconButton('lock', 'Lock')}</li>`
}

function bodyThumb(rotations = {}) {
  const body = curvePath(posedNodes(rotations))
  return svgOf('-150 -500 300 520', `<path d="${body}" fill="${DAY.gi}" stroke="${OUTLINE}" stroke-width="12"/>`, STAGE)
}

function clippedThumb(content) {
  const id = `thumb-clip-${clipCount++}`
  const body = curvePath(posedNodes())
  return svgOf('-150 -500 300 520', `<defs><clipPath id="${id}"><path d="${body}"/></clipPath></defs><path d="${body}" fill="none" stroke="#596173" stroke-width="10"/><g clip-path="url(#${id})">${content}</g>`, STAGE)
}

function partThumb(d, fill, viewBox) {
  return svgOf(viewBox, `<path d="${d}" fill="${fill}" stroke="${OUTLINE}" stroke-width="8"/>`, STAGE)
}

function shapesTab(selected, rotations, extra = []) {
  const rows = [
    ...extra,
    { name: 'Body', thumb: bodyThumb(rotations), isGroup: true },
    { name: 'Hakama', thumb: clippedThumb(`<rect x="-240" y="-306" width="480" height="320" fill="${DAY.hakama}"/>`), isClipped: true },
    { name: 'Hakama shade', thumb: clippedThumb(`<path d="M30 -306 L240 -306 L240 0 L84 0Z" fill="${DAY.hakamaShade}"/>`), isClipped: true },
    { name: 'Sash', thumb: clippedThumb(`<rect x="-240" y="-328" width="480" height="34" fill="${DAY.sash}"/>`), isClipped: true },
    { name: 'Lapel', thumb: clippedThumb(`<path d="M-24 -480 L24 -480 L0 -404Z" fill="${DAY.skin}"/><path d="M-24 -480 L-12 -482 L34 -328 L18 -328Z" fill="${DAY.giShade}"/>`), isClipped: true },
    { name: 'Gi shade', thumb: clippedThumb(`<path d="M46 -480 L92 -480 L70 -328 L48 -328Z" fill="${DAY.giShade}"/>`), isClipped: true },
    { name: 'Neck', thumb: partThumb('M-15 -512 L15 -512 L17 -458 L-17 -458Z', DAY.skin, '-60 -530 120 90') },
    { name: 'Hand R', thumb: partThumb(HANDS.armR, DAY.skin, '-150 -390 100 120') },
    { name: 'Hand L', thumb: partThumb(HANDS.armL, DAY.skin, '50 -390 100 120') },
    { name: 'Foot R', thumb: partThumb(FEET.legR, DAY.skin, '-120 -60 110 70') },
    { name: 'Foot L', thumb: partThumb(FEET.legL, DAY.skin, '10 -60 110 70') },
  ].map((row) => ({ ...row, isSelected: row.name === selected }))
  return `${tabs(['Media', 'Effects', 'Transitions', 'Annotations', 'Shapes'], 'Shapes')}
    <div class="tab-panel"><div class="panel-controls">${pair(labelled('Blend', pickerControl('Normal')), field('Opacity (%)', '100'))}</div>
    <ul class="layer-list">${rows.map(shapeRow).join('')}</ul></div>`
}

/* Timeline inside a character animation */

const WAVE_KEYS = [0, 0.5, 1, 1.5]

function mouthPicture(shape) {
  return svgOf('-30 -17 60 34', MOUTHS[shape](DAY), SKIN_STAGE)
}

function blinkPicture(kind) {
  return svgOf('-40 -592 80 45', eyesOf(kind, DAY, painter()) + browsOf('', DAY, painter()), SKIN_STAGE)
}

function waveTracks({ selected, rotations, withHat }) {
  const drawing = (name, picture, extra = {}) => ({ start: 0, end: 2, kind: 'drawing', label: name, thumbs: [picture], isSelected: selected === name, ...extra })
  const figureThumb = (crop) => svgOf(crop, figure({ rotations, mouth: 'none' }), STAGE)
  const tracks = [
    { name: 'Mouth', clips: [{ start: 0, end: 2, kind: 'animation', label: 'Mouths', thumbs: [mouthPicture('X'), mouthPicture('C'), mouthPicture('D'), mouthPicture('C')] }] },
    { name: 'Eyes', clips: [{ start: 0, end: 2, kind: 'animation', label: 'Blink', thumbs: [blinkPicture('open'), blinkPicture('closed')] }] },
    { name: 'Head', clips: [drawing('Head', figureThumb('-80 -680 160 90'), { keys: [0, 1] })] },
    { name: 'Body', clips: [drawing('Body', figureThumb('-190 -560 380 214'), { keys: WAVE_KEYS })] },
  ]
  if (withHat) tracks.unshift({ name: 'Hat', clips: [drawing('Hat', svgOf('0 0 16 9', '', STAGE))] })
  return tracks
}

function waveTimeline(options, playhead) {
  return timeline({ path: ['Episode 3', 'Kenta wave'], pixelsPerSecond: 700, seconds: 2.12, fps: 12, labelEvery: 0.5, tickEvery: 1 / 12, playhead, tracks: waveTracks(options) })
}

/* 1. Shapes: pick any contour and set its fill and stroke precisely */

const SHAPES_POSE = { rotations: { armR: 6, armL: -18 }, mouth: 'X' }

function nodesBox(nodes) {
  const xs = nodes.map((node) => node.x)
  const ys = nodes.map((node) => node.y)
  return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) }
}

function inCanvas(point) {
  return toScene(CHARACTER_IN_CANVAS, point)
}

function shapesCanvas(unit) {
  const box = nodesBox(posedNodes(SHAPES_POSE.rotations))
  const [left, top] = inCanvas([box.left, box.top])
  const [right, bottom] = inCanvas([box.right, box.bottom])
  return `<rect width="1080" height="1080" fill="${PAPER}"/>
    ${placed(CHARACTER_IN_CANVAS, figure(SHAPES_POSE))}
    ${selectionBox({ left, top, right, bottom }, unit)}`
}

/* 2. Pen: bezier curves with handles */

const HAT = { a: [-150, -598], b: [0, -716], c: [150, -598], cIn: [96, -592], cOut: [204, -604], cursor: [-40, -566] }

function penCanvas(unit) {
  const [ax, ay] = HAT.a
  const [bx, by] = HAT.b
  const [cx, cy] = HAT.c
  const preview = `M${cx} ${cy} C${HAT.cOut.join(' ')} ${HAT.cursor[0] + 60} ${HAT.cursor[1] + 30} ${HAT.cursor.join(' ')}`
  const shape = `M${ax} ${ay} L${bx} ${by} L${cx} ${cy} C${HAT.cOut.join(' ')} ${HAT.cursor[0] + 60} ${HAT.cursor[1] + 30} ${HAT.cursor.join(' ')} Z`
  const size = (7 * unit) / CHARACTER_IN_CANVAS.scale
  const node = ([x, y], isChosen) => `<rect class="node ${isChosen ? 'chosen' : ''}" x="${x - size / 2}" y="${y - size / 2}" width="${size}" height="${size}"/>`
  const handle = ([x, y]) => `<line class="node-handle-line" x1="${cx}" y1="${cy}" x2="${x}" y2="${y}"/><circle class="node" cx="${x}" cy="${y}" r="${(3.5 * unit) / CHARACTER_IN_CANVAS.scale}"/>`
  const [px, py] = inCanvas(HAT.cursor)
  return `<rect width="1080" height="1080" fill="${PAPER}"/>
    ${placed(
      CHARACTER_IN_CANVAS,
      figure({ rotations: { armL: -18 }, mouth: 'X' }) +
        `<path d="${shape}" fill="#d9b86a" stroke="${OUTLINE}" stroke-width="7" stroke-linejoin="round"/>
        <path class="node-path" d="M${ax} ${ay} L${bx} ${by} L${cx} ${cy}"/>
        <path class="node-path" d="${preview}" stroke-dasharray="4 4"/>
        ${handle(HAT.cIn)}${handle(HAT.cOut)}${node(HAT.a)}${node(HAT.b)}${node(HAT.c, true)}`,
    )}
    ${cursorPen([px, py], unit)}`
}

function cursorPen([x, y], unit) {
  const scale = 1.4 * unit
  return `<g transform="translate(${x - 8 * scale} ${y - 2 * scale}) scale(${scale})"><path d="${ICONS.pen}" fill="none" stroke="#141218" stroke-width="3.2" stroke-linejoin="round"/><path d="${ICONS.pen}" fill="none" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></g>`
}

/* 3. Nodes: animate one shape by moving node sets, keyframed like anything else */

const WAVE_NOW = { armL: -75, armR: 4 }

function nodesCanvas(unit) {
  const scale = CHARACTER_IN_CANVAS.scale
  const nodes = posedNodes(WAVE_NOW)
  const handles = nodeHandles(nodes)
  const chosen = nodes.filter((node) => node.set === 'armL')
  const size = (7 * unit) / scale
  const squares = nodes
    .map((node) => `<rect class="node ${node.set === 'armL' ? 'chosen' : ''}" x="${node.x - size / 2}" y="${node.y - size / 2}" width="${size}" height="${size}"/>`)
    .join('')
  const smoothHandles = nodes
    .map((node, i) => (node.set === 'armL' && node.smooth ? [handles[i].in, handles[i].out].map(([x, y]) => `<line class="node-handle-line" x1="${node.x}" y1="${node.y}" x2="${x}" y2="${y}"/><circle class="node" cx="${x}" cy="${y}" r="${(3.5 * unit) / scale}"/>`).join('') : ''))
    .join('')
  const box = nodesBox(chosen)
  const pad = (10 * unit) / scale
  const [pivotX, pivotY] = PIVOTS.armL
  const pivot = `<circle cx="${pivotX}" cy="${pivotY}" r="${(6 * unit) / scale}" fill="none" stroke="var(--primary)" stroke-width="1.5" vector-effect="non-scaling-stroke"/><line class="node-handle-line" x1="${pivotX - (10 * unit) / scale}" y1="${pivotY}" x2="${pivotX + (10 * unit) / scale}" y2="${pivotY}"/><line class="node-handle-line" x1="${pivotX}" y1="${pivotY - (10 * unit) / scale}" x2="${pivotX}" y2="${pivotY + (10 * unit) / scale}"/>`
  const radius = 78
  const [startX, startY] = rotateAround([pivotX, pivotY], 0, [pivotX + 30, pivotY + radius])
  const [endX, endY] = rotateAround([pivotX, pivotY], -75, [pivotX + 30, pivotY + radius])
  const arc = `<path d="M${startX} ${startY} A${Math.hypot(30, radius)} ${Math.hypot(30, radius)} 0 0 0 ${endX} ${endY}" fill="none" stroke="var(--primary)" stroke-width="1.5" stroke-dasharray="3 4" vector-effect="non-scaling-stroke"/>`
  const previous = curvePath(posedNodes({ armR: 4 }))
  return `<rect width="1080" height="1080" fill="${PAPER}"/>
    ${placed(
      CHARACTER_IN_CANVAS,
      figure({ rotations: WAVE_NOW, mouth: 'smile' }) +
        `<path d="${previous}" fill="none" stroke="var(--onion-before)" stroke-width="1.5" stroke-dasharray="5 4" vector-effect="non-scaling-stroke" opacity="0.9"/>
        <path class="node-path" d="${curvePath(nodes)}"/>
        <rect x="${box.left - pad}" y="${box.top - pad}" width="${box.right - box.left + pad * 2}" height="${box.bottom - box.top + pad * 2}" fill="none" stroke="var(--primary)" stroke-width="1" stroke-dasharray="4 3" vector-effect="non-scaling-stroke"/>
        ${arc}${smoothHandles}${squares}${pivot}`,
    )}`
}

function nodesProperties() {
  const sets = ['Arm R', 'Arm L', 'Leg R', 'Leg L'].map((name) => `<button class="button" aria-pressed="${name === 'Arm L'}">${name}</button>`).join('')
  return (
    group(
      'Nodes',
      'node',
      labelled('Node sets', `<div class="pill-row">${sets}<button class="button with-icon">${icon('plus')}Save selection</button></div>`) +
        pair(field('Rotation (°)', '-75.0'), field('Scale (%)', '100')) +
        segmented('Type', ['Sharp', 'Smooth'], 'Smooth'),
    ) +
    group('Shape', 'curve', labelled('Keyframe', `<div class="field-row keyed"><div class="field-box">${pickerControl('Ease in and out')}</div>${keyNav(true)}</div>`)) +
    strokePanel(false) +
    group('Colour', 'droplet', '', false)
  )
}

/* 4. Parts: shared animations placed inside many characters */

const MONK_POSE = { rotations: { armR: 10, armL: -10 }, bald: true, mouth: 'none' }

function partsCanvas(unit) {
  const head = within(CHARACTER_IN_CANVAS, { x: 0, y: -526, scale: 1 })
  const [mx, my] = [head.x, head.y]
  const scale = head.scale
  return `<rect width="1080" height="1080" fill="${PAPER}"/>
    ${placed(CHARACTER_IN_CANVAS, figure(MONK_POSE, { palette: 'monk' }))}
    <g transform="translate(${mx} ${my}) scale(${scale})">${MOUTHS.C(MONK)}</g>
    ${selectionBox({ left: mx - 34 * scale, top: my - 22 * scale, right: mx + 34 * scale, bottom: my + 22 * scale }, unit)}`
}

function sectionedMedia(sections) {
  const body = sections.map(([title, tiles]) => `<div class="section-heading">${title}</div><ul class="library-list grid">${tiles.join('')}</ul>`).join('')
  return `${tabs(['Media', 'Effects', 'Transitions', 'Annotations', 'Shapes'], 'Media')}
    <div class="tab-panel"><div class="library-tab">
      <div class="library-tools"><div class="field-box search-box">${icon('search')}<input class="field" placeholder="Search media"></div><div class="segmented">${iconButton('list', 'List')}${iconButton('grid', 'Grid', 'on')}</div></div>
      ${body}
    </div></div>`
}

function partsMedia() {
  const character = (content) => svgOf('-640 -720 1280 720', content, STAGE)
  return sectionedMedia([
    [
      'Characters',
      [
        libraryTile('Kenta wave', character(figure({ rotations: WAVE_NOW, mouth: 'smile' })), '<span>0:02</span>'),
        libraryTile('Monk talk', character(figure({ ...MONK_POSE, mouth: 'C' }, { palette: 'monk' })), '<span>0:03</span>', true),
        libraryTile('Oni laugh', svgOf('-400 -780 800 450', oni(), STAGE), '<span>0:02</span>'),
      ],
    ],
    [
      'Parts',
      [
        libraryTile('Mouths', mouthPicture('D'), '<span>Used in 3</span>'),
        libraryTile('Blink', blinkPicture('open'), '<span>Used in 3</span>'),
        libraryTile('Hands', svgOf('-150 -400 300 169', `<path d="${HANDS.armR}" fill="${DAY.skin}" stroke="${OUTLINE}" stroke-width="7"/><path d="${HANDS.armL}" fill="${DAY.skin}" stroke="${OUTLINE}" stroke-width="7"/>`, STAGE), '<span>Used in 2</span>'),
      ],
    ],
    ['Scenes', [libraryTile('Dusk pass', svgOf('0 0 1920 1080', background('dusk')), '<span>Image</span>'), libraryTile('Night pass', svgOf('0 0 1920 1080', background('night')), '<span>Image</span>')]],
  ])
}

function monkTracks() {
  const figureThumb = (crop) => svgOf(crop, figure(MONK_POSE, { palette: 'monk' }), STAGE)
  return [
    { name: 'Mouth', clips: [{ start: 0, end: 3, kind: 'animation', label: 'Mouths', isSelected: true, thumbs: ['X', 'C', 'B', 'D', 'C', 'X', 'C', 'D', 'E', 'C', 'X', 'B', 'C', 'X'].map(mouthPicture) }] },
    { name: 'Eyes', clips: [{ start: 0, end: 3, kind: 'animation', label: 'Blink', thumbs: [blinkPicture('open'), blinkPicture('open'), blinkPicture('closed'), blinkPicture('open')] }] },
    { name: 'Head', clips: [{ start: 0, end: 3, kind: 'drawing', label: 'Head', keys: [0, 1.5], thumbs: [figureThumb('-80 -640 160 90')] }] },
    { name: 'Body', clips: [{ start: 0, end: 3, kind: 'drawing', label: 'Body', keys: [0, 1, 2], thumbs: [figureThumb('-190 -560 380 214')] }] },
    { name: 'Voice', clips: [{ start: 0.2, end: 2.8, kind: 'audio', label: 'monk-line-02.wav', seed: 31, gaps: [[1.3, 1.5]] }] },
  ]
}

function partsMenu() {
  const clip = document.querySelector('.timeline .clip.selected')
  if (!clip) return ''
  const box = clip.getBoundingClientRect()
  const items = ['Open Animation', 'Make Unique', 'Split at Playhead', 'Speed…', 'Group', 'Copy', 'Duplicate', 'Delete']
  return `<div class="menu mock-menu" style="left:${box.left + 300}px;top:${box.top + 26}px">${items.map((item) => `<button class="menu-item ${item === 'Make Unique' ? 'hot' : ''}">${item}</button>`).join('')}</div>`
}

const VIEWS = {
  shapes: {
    title: 'Shapes, fill and stroke',
    left: () => shapesTab('Body', SHAPES_POSE.rotations),
    right: () => colourPanel('Gi', DAY.gi, KENTA_CHIPS) + strokePanel(),
    tools: () => tools('pointer', DAY.gi),
    canvas: { size: [1080, 1080], draw: shapesCanvas },
    footer: () => footer({ time: '00:00:00:06', total: '00:00:02:00', isAnimation: true }),
    timeline: () => waveTimeline({ selected: 'Body', rotations: SHAPES_POSE.rotations }, 0.5),
    timelineHeight: 312,
  },
  pen: {
    title: 'Pen and bezier curves',
    left: () => shapesTab('Hat', { armL: -18 }, [{ name: 'Hat', thumb: partThumb('M-150 -598 L0 -716 L150 -598 C204 -604 20 -536 -40 -566Z', '#d9b86a', '-170 -730 340 190') }]),
    right: () => group('Node', 'node', segmented('Type', ['Sharp', 'Smooth'], 'Smooth') + pair(field('X', '150.0'), field('Y', '-598.0'))) + colourPanel('Straw', '#d9b86a', KENTA_CHIPS) + strokePanel(false),
    tools: () => tools('pen', '#d9b86a'),
    canvas: { size: [1080, 1080], view: { x: 100, y: -60, width: 880 }, draw: penCanvas },
    footer: () => footer({ time: '00:00:00:06', total: '00:00:02:00', isAnimation: true, zoom: '125%' }),
    timeline: () => waveTimeline({ selected: 'Hat', rotations: { armL: -18 }, withHat: true }, 0.5),
    timelineHeight: 368,
  },
  nodes: {
    title: 'Animate nodes',
    left: () => shapesTab('Body', WAVE_NOW),
    right: nodesProperties,
    tools: () => tools('node', DAY.gi),
    canvas: { size: [1080, 1080], draw: nodesCanvas },
    footer: () => footer({ time: '00:00:00:06', total: '00:00:02:00', isAnimation: true, isOnion: true }),
    timeline: () => waveTimeline({ selected: 'Body', rotations: WAVE_NOW }, 0.5),
    timelineHeight: 312,
  },
  parts: {
    title: 'Shared parts',
    left: partsMedia,
    right: () => transformGroup('540.0', '277.3', '100.0') + timingGroup('0.000', '3.000', true) + foldedGroups(),
    tools: () => tools('pointer', MONK.gi),
    canvas: { size: [1080, 1080], draw: partsCanvas },
    footer: () => footer({ time: '00:00:01:02', total: '00:00:03:00', isAnimation: true }),
    timeline: () => timeline({ path: ['Episode 3', 'Monk talk'], pixelsPerSecond: 470, seconds: 3.2, fps: 12, labelEvery: 0.5, tickEvery: 1 / 12, playhead: 1.17, tracks: monkTracks() }),
    timelineHeight: 368,
    overlay: partsMenu,
  },
}

function shell(view) {
  return `<div class="editor" style="--timelineHeight:${view.timelineHeight}px">
    <aside class="sidebar left">${view.left()}</aside>
    <div class="splitter leftWidth"></div>
    <section class="canvas-panel">
      <div class="canvas-row"><div class="canvas-area" id="canvas-area">${view.tools ? view.tools() : ''}</div></div>
      ${view.footer()}
    </section>
    <div class="splitter rightWidth"></div>
    <aside class="sidebar right">${view.right()}</aside>
    <div class="splitter timelineHeight"></div>
    <section class="timeline-panel">${view.timeline()}</section>
  </div>`
}

function render() {
  const names = Object.keys(VIEWS)
  const name = new URLSearchParams(location.search).get('view') ?? names[0]
  const view = VIEWS[name] ?? VIEWS[names[0]]
  document.title = view.title
  const root = document.getElementById('root')
  root.innerHTML = shell(view)
  const area = document.getElementById('canvas-area')
  const areaWidth = area.clientWidth - 32
  const areaHeight = area.clientHeight - 32
  const [canvasWidth, canvasHeight] = view.canvas.size
  let viewBox
  let width
  let height
  if (view.canvas.view) {
    const { x, y, width: boxWidth } = view.canvas.view
    viewBox = `${x} ${y} ${boxWidth} ${(boxWidth * areaHeight) / areaWidth}`
    width = areaWidth
    height = areaHeight
  } else {
    const fit = Math.min(areaWidth / canvasWidth, areaHeight / canvasHeight)
    width = Math.floor(canvasWidth * fit)
    height = Math.floor(canvasHeight * fit)
    viewBox = `0 0 ${canvasWidth} ${canvasHeight}`
  }
  const unit = Number(viewBox.split(' ')[2]) / width
  area.insertAdjacentHTML('beforeend', `<div class="preview-fit"><div class="preview-frame"><svg class="canvas-svg" width="${width}" height="${height}" viewBox="${viewBox}">${view.canvas.draw(unit)}</svg></div></div>`)
  if (view.overlay) root.insertAdjacentHTML('beforeend', view.overlay())
  document.addEventListener('keydown', (event) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    if (step === 0) return
    location.search = `?view=${names[(names.indexOf(name) + step + names.length) % names.length]}`
  })
}

render()
