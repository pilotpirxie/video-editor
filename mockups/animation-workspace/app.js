'use strict'

const ICONS = {
  play: 'M5 3l8 5-8 5z',
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
  music: 'M6 12V3l7-1.5v9M6 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM13 10.5a2 2 0 1 1-4 0 2 2 0 0 1 4 0z',
  chevronDown: 'M4 6l4 4 4-4',
  chevronRight: 'M6 4l4 4-4 4',
  chevronLeft: 'M10 4L6 8l4 4',
  list: 'M2 3h3.5v3.5H2zM8 4.75h6M2 9.5h3.5V13H2zM8 11.25h6',
  grid: 'M2.5 2.5h4.5V7H2.5zM9 2.5h4.5V7H9zM2.5 9h4.5v4.5H2.5zM9 9h4.5v4.5H9z',
  move: 'M8 2v12M2 8h12M6 4l2-2 2 2M6 12l2 2 2-2M4 6L2 8l2 2M12 6l2 2-2 2',
  clock: 'M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zM8 5v3l2 1.5',
  droplet: 'M8 2.5s4 4 4 7a4 4 0 0 1-8 0c0-3 4-7 4-7z',
  pipette: 'M10.5 2.5l3 3-2 2-3-3zM9.5 5.5l-6 6-1 2 2-1 6-6',
  keyframe: 'M8 2.5L13.5 8 8 13.5 2.5 8z',
  line: 'M3 13L13 3',
  group: 'M2.5 2.5h7v7h-7zM6.5 6.5h7v7h-7z',
  preview: 'M2 3h12v10H2zM6.5 5.5l4 2.5-4 2.5z',
  search: 'M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM10.25 10.25L13.5 13.5',
  zoom: 'M2 3h12v10H2zM5.5 6h5v4h-5z',
  wand: 'M3 13l7-7M11.5 2v2.5M10.25 3.25h2.5M13.5 6.5v2M12.5 7.5h2M6 2.5v2M5 3.5h2',
  blur: 'M8 3a5 5 0 0 0 0 10M10 3.4l.5.3M12 5.2l.3.5M12.8 7.8v.5M12 10.3l-.3.5M10.5 12.3l-.5.3',
  pointer: 'M3.5 2.5l9 5.5-4.2 1.2-2 4.3z',
  node: 'M3.5 2.5l7 4.3-3.3 1-1.6 3.4zM10.5 10.5h3v3h-3z',
  brush: 'M13.5 2.5l-6 6.5M7.5 9c-1.8-.4-3.4.6-3.6 2.4-.1 1-.6 1.8-1.4 2.1 2.4.6 5.6.1 6-2.6z',
  pencil: 'M10.5 2.5l3 3-8 8h-3v-3zM9 4l3 3',
  pen: 'M8 2l4.5 5.5L10 13H6L3.5 7.5zM8 2v5.5',
  shapes: 'M2.5 2.5h6v6h-6zM13.5 10.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
  bucket: 'M2.5 8.5L8 3l5 5-5.5 5.5zM2.5 8.5h10.5M13.5 11.5s1 1.3 1 2a1 1 0 0 1-2 0c0-.7 1-2 1-2z',
  eraser: 'M5 12.5L2.5 10 9 3.5l4 4-5 5zM6 6.5l4 4M5 12.5h8.5',
  bone: 'M2.5 13.5l2.5-6 7-4.5-4.5 7zM5 7.5l3.5 3.5',
  pin: 'M8 14.5V10M4.5 10h7M5.5 10l1-4.5h3l1 4.5M6 2.5h4M6.5 2.5v3M9.5 2.5v3',
  onion: 'M6 2.5h7.5V10M4.25 4.25h7.5v7.5M2.5 6h7.5v7.5H2.5z',
  symbol: 'M8 2l1.7 4.3L14 8l-4.3 1.7L8 14l-1.7-4.3L2 8l4.3-1.7z',
  loop: 'M12.5 6.5A4.5 4.5 0 0 0 4 5M3.5 9.5A4.5 4.5 0 0 0 12 11M3.5 2.5V5H6M12.5 13.5V11H10',
  export: 'M8 10V2.5M5 5.5l3-3 3 3M3 9v4.5h10V9',
  target: 'M8 3a5 5 0 1 0 0 10A5 5 0 0 0 8 3zM8 1v4M8 11v4M1 8h4M11 8h4',
}

const KIND_ICONS = { drawing: 'pen', symbol: 'symbol', tween: 'move', folder: 'group', audio: 'music', bone: 'bone', ik: 'target', physics: 'wand' }
const SPAN_FILLS = { drawing: '#3a4560', symbol: '#5e4f8c', tween: '#3a4560', folder: '#2c323e', audio: 'var(--clip-audio)', bone: '#3a4560', ik: '#6b4f2a', physics: '#46506a' }
const STAGE = '#2a303b'

/* Controls */

function icon(name) {
  return `<svg class="icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="${ICONS[name]}"/></svg>`
}

function iconButton(name, label, state = '') {
  return `<button class="button icon ${state === 'off' ? 'off' : ''}" aria-pressed="${state === 'on'}" title="${label}">${icon(name)}</button>`
}

function button(text, iconName, extra = '') {
  return `<button class="button ${iconName ? 'with-icon' : ''} ${extra}">${iconName ? icon(iconName) : ''}${text}</button>`
}

function tabs(names, chosen) {
  return `<div class="tabs" role="tablist">${names.map((name) => `<button class="tab" role="tab" aria-selected="${name === chosen}">${name}</button>`).join('')}</div>`
}

function group(title, iconName, body, isOpen = true) {
  const toggle = `<button class="group-toggle">${icon(isOpen ? 'chevronDown' : 'chevronRight')}${icon(iconName)}<span>${title}</span></button>`
  return `<div class="group"><div class="group-header">${toggle}</div>${isOpen ? `<div class="group-body">${body}</div>` : ''}</div>`
}

function labelled(label, control) {
  return `<div class="labelled"><span class="field-label">${label}</span>${control}</div>`
}

function input(value) {
  return `<input class="field" value="${value}">`
}

function pickerControl(value, swatch) {
  const chip = swatch ? `<span class="swatch-chip" style="background:${swatch}"></span>` : ''
  return `<button class="field picker"><span class="picker-start">${chip}<span class="picker-value">${value}</span></span>${icon('chevronDown')}</button>`
}

function picker(label, value, swatch) {
  return labelled(label, pickerControl(value, swatch))
}

function keyNav(isOnKey) {
  return `${iconButton('chevronLeft', 'Previous keyframe')}${iconButton('keyframe', 'Keyframe', isOnKey ? 'on' : '')}${iconButton('chevronRight', 'Next keyframe')}`
}

function field(label, value, keyed) {
  if (keyed === undefined) return labelled(label, input(value))
  return `<div class="field-row keyed">${labelled(label, input(value))}${keyNav(keyed)}</div>`
}

function keyedPair(first, second, isOnKey) {
  return `<div class="field-row keyed">${pair(field(...first), field(...second))}${keyNav(isOnKey)}</div>`
}

function segmented(label, options, chosen) {
  const buttons = options.map((option) => `<button class="button" aria-pressed="${option === chosen}">${option}</button>`).join('')
  return labelled(label, `<div class="segmented wide">${buttons}</div>`)
}

function check(label, isOn, detail = '') {
  return `<label class="check-field"><input type="checkbox" ${isOn ? 'checked' : ''}>${label}${detail ? `<span class="detail">${detail}</span>` : ''}</label>`
}

function pair(first, second) {
  return `<div class="field-pair">${first}${second}</div>`
}

function colourWell(colour) {
  return `<button class="color-field"><span class="colour-well" style="background:${colour}"></span></button>`
}

/* Art placement */

const KENTA_BOX = { left: -212, top: -672, right: 130, bottom: 2 }

function svgOf(viewBox, content, background) {
  const [x, y, w, h] = viewBox.split(' ').map(Number)
  const fill = background ? `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${background}"/>` : ''
  return `<svg viewBox="${viewBox}" preserveAspectRatio="xMidYMid meet">${fill}${content}</svg>`
}

function placed(at, content) {
  return `<g transform="translate(${at.x} ${at.y}) scale(${at.scale})">${content}</g>`
}

function toScene(at, [x, y]) {
  return [at.x + at.scale * x, at.y + at.scale * y]
}

function sceneBox(at, box) {
  const [left, top] = toScene(at, [box.left, box.top])
  const [right, bottom] = toScene(at, [box.right, box.bottom])
  return { left, top, right, bottom }
}

function selectionBox({ left, top, right, bottom }, unit) {
  const midX = (left + right) / 2
  const midY = (top + bottom) / 2
  const handles = [[left, top], [midX, top], [right, top], [right, midY], [right, bottom], [midX, bottom], [left, bottom], [left, midY]]
  const size = 8 * unit
  return (
    `<rect class="selection-box" x="${left}" y="${top}" width="${right - left}" height="${bottom - top}"/>` +
    handles.map(([x, y]) => `<rect class="canvas-handle" x="${x - size / 2}" y="${y - size / 2}" width="${size}" height="${size}"/>`).join('')
  )
}

function canvasTag(x, y, text, unit) {
  const width = (text.length * 7 + 12) * unit
  return `<rect class="canvas-tag" x="${x}" y="${y - 20 * unit}" width="${width}" height="${18 * unit}" rx="${3 * unit}"/><text class="canvas-tag-text" x="${x + 6 * unit}" y="${y - 7 * unit}" style="font-size:${12 * unit}px">${text}</text>`
}

function rotatePoint(degrees, [x, y]) {
  const radians = (degrees * Math.PI) / 180
  return [x * Math.cos(radians) - y * Math.sin(radians), x * Math.sin(radians) + y * Math.cos(radians)]
}

function armPoint(side, joint, segment, point) {
  const [sx, sy] = SHOULDERS[side]
  if (segment === 'upper') {
    const [x, y] = rotatePoint(joint.shoulder, point)
    return [sx + x, sy + y]
  }
  const [ex, ey] = rotatePoint(joint.shoulder, [0, UPPER_ARM])
  const [x, y] = rotatePoint(joint.shoulder + joint.elbow, point)
  return [sx + ex + x, sy + ey + y]
}

function seeded(seed) {
  let state = seed
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296
    return state / 4294967296
  }
}

function waveform(x, y, width, height, seed, envelope = () => 1, level = 1) {
  const random = seeded(seed)
  let bars = ''
  for (let i = 0; i < width - 2; i += 3) {
    const amplitude = (0.2 + 0.8 * random()) * envelope(i / width) * level * (height / 2 - 2)
    bars += `<rect x="${(x + i).toFixed(1)}" y="${(y + height / 2 - amplitude).toFixed(1)}" width="2" height="${Math.max(1, amplitude * 2).toFixed(1)}"/>`
  }
  return `<g fill="rgb(255 255 255 / 55%)">${bars}</g>`
}

/* Shared chrome */

function toolstrip(active) {
  const tools = [
    ['pointer', 'Move'], ['node', 'Node'], null,
    ['brush', 'Brush'], ['pencil', 'Pencil'], ['pen', 'Pen'], ['shapes', 'Shapes'], ['bucket', 'Fill'], ['eraser', 'Eraser'], ['pipette', 'Colour picker'], ['text', 'Text'], null,
    ['bone', 'Bones'], ['pin', 'Pin'], null,
    ['search', 'Zoom'],
  ]
  const buttons = tools.map((tool) => (tool ? iconButton(tool[0], tool[1], tool[0] === active ? 'on' : '') : '<hr>')).join('')
  return `<div class="toolstrip">${buttons}<div class="tool-swatches"><span class="fill" style="background:#9e3522"></span><span class="stroke"></span></div></div>`
}

function editFooter() {
  return `<div class="canvas-footer">
    ${iconButton('stepBack', 'Previous frame')}${iconButton('play', 'Play')}${iconButton('stepForward', 'Next frame')}
    <span class="timecodes"><span class="timecode">00:00:03:10</span> <span class="timecode total">/ 00:00:24:00</span></span>
    <span class="spacer"></span>
    ${iconButton('zoom', 'Camera')}${iconButton('fit', 'Full screen')}${iconButton('crop', 'Crop')}
    <div class="canvas-zoom">${pickerControl('Fit')}</div>
    ${iconButton('preview', 'Preview')}
  </div>`
}

function animFooter({ frame, total, time, zoom, context, isOnion }) {
  const contextField = context === undefined ? '' : `<label class="footer-field">Context (%) <input class="field" value="${context}"></label>`
  return `<div class="canvas-footer">
    ${iconButton('stepBack', 'Previous frame')}${iconButton('play', 'Play')}${iconButton('stepForward', 'Next frame')}
    <span class="timecodes"><span class="timecode">${time}</span></span>
    <span class="frame-counter">Frame ${frame} of ${total}</span>
    <span class="spacer"></span>
    ${contextField}
    ${iconButton('onion', 'Onion skin', isOnion ? 'on' : '')}
    <div class="canvas-zoom">${pickerControl(zoom)}</div>
  </div>`
}

/* Edit timeline */

function editTimeline() {
  const pixelsPerSecond = 61
  const tracks = [
    { name: 'Titles', clips: [{ start: 0.5, end: 4.5, kind: 'annotation', label: 'Ronin Road, episode 3' }] },
    {
      name: 'Kenta',
      clips: [
        { start: 1.5, end: 9, kind: 'animation', label: 'Kenta: Walk', isSelected: true, art: 'walk', keys: [0, 7.5] },
        { start: 9, end: 12.5, kind: 'animation', label: 'Kenta: Slash', art: 'slash' },
      ],
    },
    { name: 'Oni', clips: [{ start: 12, end: 19.5, kind: 'animation', label: 'Oni: Laugh', art: 'oni' }] },
    { name: 'Footage', clips: [{ start: 0, end: 24, kind: 'video', label: 'cows1920.mp4' }] },
    {
      name: 'Dialogue',
      clips: [
        { start: 2, end: 5.5, kind: 'audio', label: 'kenta-line-03.wav', seed: 3 },
        { start: 12.5, end: 16.5, kind: 'audio', label: 'oni-line-01.wav', seed: 9 },
      ],
    },
    { name: 'Music', clips: [{ start: 0, end: 24, kind: 'audio', label: 'ever.mp3', seed: 5, level: 0.45 }] },
  ]
  const colours = { video: 'var(--clip-video)', audio: 'var(--clip-audio)', annotation: 'var(--clip-annotation)', animation: 'var(--clip-animation)' }
  const thumbFor = (art, index) => {
    if (art === 'oni') return svgOf('-400 -780 800 450', oni(), STAGE)
    const poses = art === 'slash'
      ? [{ armR: { shoulder: 166, elbow: 14, sword: 24, holding: true }, brows: 'angry', mouth: 'D' }, { armR: { shoulder: 72, elbow: -6, sword: -8, holding: true }, brows: 'angry', mouth: 'D' }]
      : [{ armR: { shoulder: 22, elbow: 14 }, armL: { shoulder: -2, elbow: -18 }, mouth: 'C' }, { armR: { shoulder: 2, elbow: 8 }, armL: { shoulder: -20, elbow: -10 }, mouth: 'X' }]
    return svgOf('-330 -700 660 371', kenta(poses[index % poses.length]), STAGE)
  }
  const clipHtml = (clip) => {
    const left = clip.start * pixelsPerSecond
    const width = (clip.end - clip.start) * pixelsPerSecond
    let body = ''
    if (clip.kind === 'video') body = `<span class="clip-thumb"><img src="img/cows.jpg" alt=""></span>`
    if (clip.kind === 'animation') {
      const count = Math.ceil(width / 61)
      body = Array.from({ length: count }, (_, i) => `<span class="clip-thumb">${thumbFor(clip.art, i)}</span>`).join('')
    }
    if (clip.kind === 'audio') body = `<svg class="clip-wave" width="${width}" height="34">${waveform(0, 0, width, 34, clip.seed, (t) => Math.min(1, t * 12, (1 - t) * 12), clip.level)}</svg>`
    const keys = (clip.keys ?? []).map((time) => `<span class="clip-key" style="left:${time * pixelsPerSecond + 1}px"></span>`).join('')
    const prefix = clip.kind === 'animation' ? icon('symbol') : ''
    return `<div class="clip ${clip.isSelected ? 'selected' : ''}" style="left:${left}px;width:${width}px;background:${colours[clip.kind]}"><div class="clip-label">${prefix}${clip.label}</div><div class="clip-body">${body}</div>${keys}</div>`
  }
  const ticks = []
  for (let time = 0; time <= 24; time += 0.5) {
    const x = time * pixelsPerSecond
    const isMajor = time % 2 === 0
    ticks.push(`<span class="etl-tick ${isMajor ? 'major' : ''}" style="left:${x}px"></span>`)
    if (isMajor) ticks.push(`<span class="etl-time" style="left:${x}px">00:00:${String(time).padStart(2, '0')}:00</span>`)
  }
  const headers = tracks
    .map((track) => `<div class="track-header"><div class="track-grip"><span class="track-name">${track.name}</span></div>${iconButton('lock', 'Lock')}${iconButton('eye', 'Hide')}${iconButton('speaker', 'Mute')}</div>`)
    .join('')
  const rows = tracks.map((track, i) => `<div class="etl-track" style="top:${46 + i * 56}px">${track.clips.map(clipHtml).join('')}</div>`).join('')
  const camera = `<div class="etl-camera"><span class="etl-camera-move" style="left:${9 * pixelsPerSecond}px;width:${1.5 * pixelsPerSecond}px"></span><span class="clip-key" style="left:${10.5 * pixelsPerSecond}px;bottom:4px"></span></div>`
  return `<div class="timeline">
    <div class="timeline-toolbar">
      ${iconButton('plus', 'Add track')}${iconButton('scissors', 'Split')}${iconButton('magnet', 'Snapping', 'on')}
      <span class="spacer"></span>
      ${iconButton('minus', 'Zoom out')}${iconButton('fit', 'Zoom to full')}${iconButton('plus', 'Zoom in')}
      <button class="button primary with-icon">${icon('export')}Export</button>
    </div>
    <div class="timeline-body">
      <div class="track-headers-viewport"><div class="camera-lane-header">${icon('zoom')}<span>Camera</span></div>${headers}</div>
      <div class="timeline-canvases etl">
        <div class="etl-ruler">${ticks.join('')}</div>
        ${camera}
        ${rows}
        <span class="etl-playhead" style="left:${3.4 * pixelsPerSecond}px"></span>
      </div>
    </div>
    <div class="timeline-scrollbar"><div style="width:1800px"></div></div>
  </div>`
}

/* Frame timeline */

function exposures(start, end, hold) {
  const spans = []
  for (let frame = start; frame <= end; frame += hold) spans.push({ start: frame, length: Math.min(hold, end - frame + 1) })
  return spans
}

function spansFrom(list) {
  return list.map(([start, length, label]) => ({ start, length, label }))
}

function rowHeight(row) {
  return row.kind === 'audio' ? 44 : 26
}

function rowSpans(row, top, height, frameWidth, current) {
  const centre = (frame) => (frame - 0.5) * frameWidth
  const middle = top + height / 2
  const parts = []
  for (const span of row.spans ?? []) {
    const x = (span.start - 1) * frameWidth
    const width = span.length * frameWidth
    const isCurrent = row.selected && current >= span.start && current < span.start + span.length
    const outline = isCurrent ? 'stroke="var(--primary)" stroke-width="1.5"' : ''
    parts.push(`<rect x="${x + 1}" y="${top + 3}" width="${width - 2}" height="${height - 6}" rx="3" fill="${SPAN_FILLS[row.kind]}" ${outline}/>`)
    if (row.kind === 'audio') {
      const gap = span.gap
      const envelope = (t) => {
        const frame = span.start + t * span.length
        if (gap && frame >= gap[0] && frame < gap[1]) return 0.08
        return Math.min(1, t * 10, (1 - t) * 10)
      }
      const waveTop = span.words ? top + 4 : top + 18
      parts.push(waveform(x + 3, waveTop, width - 6, span.words ? height - 16 : height - 22, span.seed ?? 7, envelope))
      for (const [frame, word] of span.words ?? []) parts.push(`<text class="ftl-word" x="${(frame - 1) * frameWidth + 4}" y="${top + height - 6}">${word}</text>`)
      if (!span.words && span.label) parts.push(`<text class="ftl-label" x="${x + 6}" y="${top + 14}">${span.label}</text>`)
      continue
    }
    if (span.tween) {
      const from = centre(span.start) + 5
      const to = centre(span.start + span.length - 1) + frameWidth / 2 - 4
      parts.push(`<line x1="${from}" x2="${to}" y1="${middle}" y2="${middle}" stroke="var(--primary)" stroke-width="1.25"/><path d="M${to} ${middle} l-6 -3.5 v7z" fill="var(--primary)"/>`)
    }
    const hasDot = row.kind === 'drawing' || row.kind === 'symbol' || row.kind === 'tween'
    if (hasDot) parts.push(`<circle cx="${centre(span.start)}" cy="${middle}" r="3" fill="#dfe5ec"/>`)
    if (span.label) {
      const isShort = span.label.length === 1
      const labelX = isShort && width < 40 ? x + width / 2 + (span.length === 1 ? 0 : 3) : x + (hasDot ? frameWidth / 2 + 6 : 8)
      const anchor = isShort && width < 40 ? 'middle' : 'start'
      if (width >= 14) parts.push(`<text class="ftl-label" x="${labelX}" y="${middle + 4}" text-anchor="${anchor}">${hasDot && anchor === 'middle' && span.length === 1 ? '' : span.label}</text>`)
    }
  }
  const keys = row.keys ?? []
  keys.forEach((key, i) => {
    if (i > 0) parts.push(`<line x1="${centre(keys[i - 1]) + 6}" x2="${centre(key) - 6}" y1="${middle}" y2="${middle}" stroke="${row.kind === 'ik' ? 'var(--ik)' : 'var(--primary)'}" stroke-width="1.25" opacity="0.8"/>`)
    const size = 5
    const fill = row.selected && key === current ? 'var(--primary)' : '#dfe5ec'
    parts.push(`<path d="M${centre(key)} ${middle - size} l${size} ${size} l${-size} ${size} l${-size} ${-size}z" fill="${fill}"/>`)
  })
  return parts.join('')
}

function frameGrid({ rows, visible, end, current, frameWidth, onion }) {
  const ruler = 24
  let y = ruler
  const laidOut = rows.map((row) => {
    const top = y
    y += rowHeight(row)
    return { row, top, height: rowHeight(row) }
  })
  const width = visible * frameWidth
  const height = y
  const centre = (frame) => (frame - 0.5) * frameWidth
  const parts = []
  for (const { row, top, height: h } of laidOut) parts.push(`<rect x="0" y="${top}" width="${width}" height="${h}" fill="${row.selected ? '#1d222b' : 'var(--window-background)'}"/>`)
  for (const [frames, colour] of [[onion?.before ?? [], 'var(--onion-before)'], [onion?.after ?? [], 'var(--onion-after)']]) {
    for (const frame of frames) parts.push(`<rect x="${(frame - 1) * frameWidth}" y="${ruler}" width="${frameWidth}" height="${height - ruler}" fill="${colour}" opacity="0.09"/>`)
  }
  for (let frame = 1; frame <= visible; frame++) {
    const x = (frame - 1) * frameWidth + 0.5
    const isStrong = (frame - 1) % 6 === 0
    parts.push(`<line x1="${x}" x2="${x}" y1="${ruler}" y2="${height}" stroke="rgb(255 255 255 / ${isStrong ? 8 : 3}%)"/>`)
  }
  for (const { top, height: h } of laidOut) parts.push(`<line x1="0" x2="${width}" y1="${top + h - 0.5}" y2="${top + h - 0.5}" stroke="var(--divider)"/>`)
  for (const { row, top, height: h } of laidOut) parts.push(rowSpans(row, top, h, frameWidth, current))
  parts.push(`<rect x="${end * frameWidth}" y="${ruler}" width="${width - end * frameWidth}" height="${height - ruler}" fill="rgb(0 0 0 / 30%)"/>`)
  parts.push(`<line x1="${end * frameWidth}" x2="${end * frameWidth}" y1="0" y2="${height}" stroke="var(--text-disabled)" stroke-dasharray="3 3"/>`)
  parts.push(`<rect x="0" y="0" width="${width}" height="${ruler}" fill="var(--panel-background)"/><line x1="0" x2="${width}" y1="${ruler - 0.5}" y2="${ruler - 0.5}" stroke="var(--divider)"/>`)
  for (let frame = 1; frame <= visible; frame++) {
    const x = (frame - 1) * frameWidth + 0.5
    const isNumbered = (frame === 1 || frame % 6 === 0) && Math.abs(frame - current) > 1
    parts.push(`<line x1="${x}" x2="${x}" y1="${isNumbered ? ruler - 9 : ruler - 4}" y2="${ruler}" stroke="var(--divider)"/>`)
    if (isNumbered) parts.push(`<text class="ftl-number" x="${x + 3}" y="13">${frame}</text>`)
  }
  for (const [frames, colour] of [[onion?.before ?? [], 'var(--onion-before)'], [onion?.after ?? [], 'var(--onion-after)']]) {
    for (const frame of frames) parts.push(`<rect x="${(frame - 1) * frameWidth + 2}" y="${ruler - 5}" width="${frameWidth - 4}" height="4" rx="1" fill="${colour}"/>`)
  }
  parts.push(`<rect x="${(current - 1) * frameWidth}" y="${ruler}" width="${frameWidth}" height="${height - ruler}" fill="rgb(174 216 54 / 10%)"/>`)
  parts.push(`<line x1="${centre(current)}" x2="${centre(current)}" y1="0" y2="${height}" stroke="var(--primary)" stroke-width="1.5"/>`)
  parts.push(`<rect x="${centre(current) - 13}" y="2" width="26" height="15" rx="3" fill="var(--primary)"/><text class="ftl-badge" x="${centre(current)}" y="13" text-anchor="middle">${current}</text>`)
  return `<svg width="${width}" height="${height}">${parts.join('')}</svg>`
}

function frameHeader(row) {
  const indent = 6 + (row.depth ?? 0) * 14
  const chevron = row.kind === 'folder' ? icon(row.open ? 'chevronDown' : 'chevronRight') : '<span class="chevron-space"></span>'
  return `<div class="ftl-header ${row.selected ? 'selected' : ''}" style="height:${rowHeight(row)}px;padding-left:${indent}px">${chevron}${icon(KIND_ICONS[row.kind])}<span class="track-name">${row.name}</span>${iconButton('eye', 'Hide')}${iconButton('lock', 'Lock')}</div>`
}

function frameTimeline(config) {
  const crumbs = config.path.slice(0, -1).map((part) => `<button class="button">${part}</button>${icon('chevronRight')}`).join('') + `<span class="group-path-here">${config.path.at(-1)}</span>`
  return `<div class="timeline">
    <div class="timeline-toolbar">
      ${iconButton('plus', 'Add layer')}${iconButton('onion', 'Onion skin', config.onion ? 'on' : '')}${iconButton('loop', 'Loop', 'on')}${iconButton('magnet', 'Snapping', 'on')}
      <nav class="group-path">${crumbs}</nav>
      <span class="spacer"></span>
      ${config.toolbarExtra ?? ''}
      <span class="toolbar-chip">${config.fps} fps</span>
      <span class="toolbar-divider"></span>
      ${iconButton('minus', 'Zoom out')}${iconButton('fit', 'Zoom to full')}${iconButton('plus', 'Zoom in')}
      <button class="button primary">Done</button>
    </div>
    <div class="ftl-body">
      <div class="ftl-headers"><div class="ftl-ruler-gap">${config.end} frames</div>${config.rows.map(frameHeader).join('')}</div>
      <div class="ftl-grid">${frameGrid(config)}</div>
    </div>
  </div>`
}

/* Left panels */

function libraryTile(name, picture, details = '', isSelected = false) {
  return `<li><button class="library-item ${isSelected ? 'selected' : ''}"><span class="library-thumbnail">${picture}</span><span class="library-text"><span class="library-name">${name}</span><span class="library-details">${details}</span></span></button></li>`
}

function searchRow(placeholder) {
  return `<div class="library-tools"><div class="field-box search-box">${icon('search')}<input class="field" placeholder="${placeholder}"></div><div class="segmented">${iconButton('list', 'List')}${iconButton('grid', 'Grid', 'on')}</div></div>`
}

function assetsLibrary() {
  const character = (content) => svgOf('-640 -720 1280 720', content, STAGE)
  const action = (pose) => svgOf('-520 -700 1040 585', kenta(pose), STAGE)
  const scene = (variant) => svgOf('0 0 1920 1080', background(variant))
  return `<div class="library-tab">
    ${searchRow('Search assets')}
    <div class="library-tools">${pickerControl('Series: Ronin Road')}</div>
    <div class="section-heading">Characters</div>
    <ul class="library-list grid">
      ${libraryTile('Kenta', character(kenta()), '<span>v4</span><span class="badge">v5 ready</span>', true)}
      ${libraryTile('Oni', character(oni()), '<span>v2</span>')}
      ${libraryTile('Monk', character(kenta({ bald: true, eyes: 'closed' }, { palette: 'monk' })), '<span>v1</span>')}
      ${libraryTile('Crow', svgOf('-400 -330 800 450', crow(), STAGE), '<span>v3</span>')}
    </ul>
    <div class="section-heading">Kenta actions</div>
    <ul class="library-list grid">
      ${libraryTile('Walk', action({ armR: { shoulder: 22, elbow: 14 }, armL: { shoulder: -2, elbow: -18 } }), '<span>16 frames</span>')}
      ${libraryTile('Run', action({ lean: -8, armR: { shoulder: 50, elbow: 60 }, armL: { shoulder: -40, elbow: -70 } }), '<span>12 frames</span>')}
      ${libraryTile('Slash', action({ armR: { shoulder: 166, elbow: 14, sword: 24, holding: true }, brows: 'angry', mouth: 'D' }), '<span>36 frames</span>')}
      ${libraryTile('Bow', action({ headTilt: 0, eyes: 'closed', armR: { shoulder: 4, elbow: 2 }, armL: { shoulder: -4, elbow: -2 } }), '<span>30 frames</span>')}
    </ul>
    <div class="section-heading">Props</div>
    <ul class="library-list grid">
      ${libraryTile('Katana', svgOf('-260 -180 520 292', sword(), STAGE), '<span>v1</span>')}
      ${libraryTile('Lantern', svgOf('-400 -470 800 450', lantern(), STAGE), '<span>v1</span>')}
    </ul>
    <div class="section-heading">Backgrounds</div>
    <ul class="library-list grid">
      ${libraryTile('Dusk pass', scene('dusk'), '<span>6 layers</span>')}
      ${libraryTile('Bamboo', scene('bamboo'), '<span>5 layers</span>')}
      ${libraryTile('Night pass', scene('night'), '<span>6 layers</span>')}
    </ul>
  </div>`
}

const LAYER_CROPS = {
  whole: '-230 -690 460 700', head: '-70 -680 140 180', band: '-60 -630 320 80', hair: '-60 -680 120 110', eyes: '-36 -592 72 44', mouth: '-22 -540 44 30',
  face: '-55 -625 110 125', torso: '-90 -490 180 200', armR: '-140 -470 120 260', armL: '20 -470 120 260', hakama: '-125 -310 250 315', sword: '-220 -400 340 260',
  forearm: '-140 -470 120 260',
}

function layerRow(row, pose) {
  const guides = Array.from({ length: row.depth ?? 0 }, () => '<span class="tree-guide"></span>').join('')
  const chevron = row.open === undefined ? '<span class="chevron-space"></span>' : icon(row.open ? 'chevronDown' : 'chevronRight')
  const thumb = row.thumb ?? svgOf(LAYER_CROPS[row.crop], kenta(pose))
  const lock = row.locked ? iconButton('lock', 'Unlock', 'on') : iconButton('lock', 'Lock', 'off')
  return `<li class="layer-row ${row.selected ? 'selected' : ''} ${row.muted ? 'muted' : ''}">${guides}${chevron}<span class="layer-thumb">${thumb}</span>${icon(KIND_ICONS[row.kind])}<span class="layer-name">${row.name}</span>${iconButton('eye', 'Hide')}${lock}</li>`
}

function layersPanel(rows, pose) {
  return `<div class="panel-controls">${pair(picker('Blend', 'Normal'), field('Opacity (%)', '100'))}</div>
    <ul class="layer-list">${rows.map((row) => layerRow(row, pose)).join('')}</ul>`
}

const ANIM_TABS = ['Layers', 'Bones', 'Frames', 'Assets', 'Swatches']

function drawLayers() {
  const rows = [
    { name: 'Kenta', kind: 'symbol', open: true, crop: 'whole' },
    { name: 'Head', kind: 'folder', depth: 1, open: true, crop: 'head' },
    { name: 'Headband', kind: 'drawing', depth: 2, crop: 'band', selected: true },
    { name: 'Hair', kind: 'drawing', depth: 2, crop: 'hair' },
    { name: 'Eyes', kind: 'symbol', depth: 2, crop: 'eyes' },
    { name: 'Mouth', kind: 'symbol', depth: 2, crop: 'mouth' },
    { name: 'Face', kind: 'drawing', depth: 2, crop: 'face' },
    { name: 'Torso', kind: 'drawing', depth: 1, crop: 'torso' },
    { name: 'Arm R', kind: 'folder', depth: 1, open: false, crop: 'armR' },
    { name: 'Arm L', kind: 'folder', depth: 1, open: false, crop: 'armL' },
    { name: 'Hakama', kind: 'drawing', depth: 1, crop: 'hakama' },
    { name: 'Sword', kind: 'drawing', depth: 1, crop: 'sword' },
    { name: 'Dusk pass', kind: 'folder', open: false, thumb: svgOf('0 0 1920 1080', background('dusk')), locked: true, muted: true },
  ]
  return tabs(ANIM_TABS, 'Layers') + `<div class="tab-panel">${layersPanel(rows, {})}</div>`
}

function slashLayers(pose) {
  const rows = [
    { name: 'Kenta', kind: 'symbol', open: true, crop: 'whole' },
    { name: 'Head', kind: 'folder', depth: 1, open: false, crop: 'head' },
    { name: 'Torso', kind: 'drawing', depth: 1, crop: 'torso' },
    { name: 'Arm R', kind: 'folder', depth: 1, open: true, crop: 'whole' },
    { name: 'Sleeve R', kind: 'drawing', depth: 2, crop: 'whole' },
    { name: 'Forearm R', kind: 'drawing', depth: 2, crop: 'whole' },
    { name: 'Sword', kind: 'drawing', depth: 2, crop: 'whole', selected: true },
    { name: 'Arm L', kind: 'folder', depth: 1, open: false, crop: 'armL' },
    { name: 'Hakama', kind: 'drawing', depth: 1, crop: 'hakama' },
    { name: 'Swish', kind: 'audio', depth: 1, thumb: '' },
    { name: 'Dusk pass', kind: 'folder', open: false, thumb: svgOf('0 0 1920 1080', background('dusk')), locked: true, muted: true },
  ]
  return tabs(ANIM_TABS, 'Layers') + `<div class="tab-panel">${layersPanel(rows, pose)}</div>`
}

function bonesPanel() {
  const bones = [
    ['Root', 0], ['Spine', 1], ['Chest', 2], ['Neck', 3], ['Head', 4], ['Upper arm R', 3], ['Forearm R', 4, true], ['Hand R', 5],
    ['Upper arm L', 3], ['Forearm L', 4], ['Hand L', 5], ['Thigh R', 1], ['Shin R', 2], ['Thigh L', 1], ['Shin L', 2],
  ]
  const boneRows = bones
    .map(([name, depth, isSelected]) => {
      const guides = Array.from({ length: depth }, () => '<span class="tree-guide"></span>').join('')
      return `<li class="layer-row ${isSelected ? 'selected' : ''}">${guides}${icon('bone')}<span class="layer-name">${name}</span>${iconButton('eye', 'Hide')}${iconButton('lock', 'Lock', 'off')}</li>`
    })
    .join('')
  const constraints = [['IK arm R', 'target', 'Hand R target'], ['IK leg R', 'pin', 'Pinned'], ['IK leg L', 'pin', 'Pinned'], ['Jiggle', 'wand', 'Headband']]
    .map(([name, iconName, detail]) => `<li class="layer-row">${icon(iconName)}<span class="layer-name">${name}</span><span class="layer-detail">${detail}</span></li>`)
    .join('')
  return (
    tabs(ANIM_TABS, 'Bones') +
    `<div class="tab-panel">
      <div class="section-heading">Skeleton</div>
      <ul class="layer-list">${boneRows}</ul>
      <div class="section-heading">Constraints</div>
      <ul class="layer-list">${constraints}</ul>
    </div>`
  )
}

const MOUTH_SOUNDS = [['X', 'Rest'], ['A', 'M B P'], ['B', 'K S T'], ['C', 'E'], ['D', 'A I'], ['E', 'O'], ['F', 'U W'], ['G', 'F V'], ['H', 'L']]

function framesPanel(chosen) {
  const tiles = MOUTH_SOUNDS.map(
    ([shape, sounds]) => `<div class="mouth-tile ${shape === chosen ? 'selected' : ''}"><div class="mouth-picture">${svgOf('-48 -566 96 72', kenta({ mouth: shape }), STAGE)}</div><span>${shape}</span><span class="mouth-sounds">${sounds}</span></div>`,
  ).join('')
  return (
    tabs(ANIM_TABS, 'Frames') +
    `<div class="tab-panel">
      <div class="panel-controls">${picker('Symbol', 'Mouth')}</div>
      <div class="mouth-grid">${tiles}</div>
    </div>`
  )
}

function swatchesPanel() {
  const day = PALETTES.day
  const strip = (colours) => `<span class="palette-strip">${colours.map((colour) => `<span style="background:${colour}"></span>`).join('')}</span>`
  const palettes = [
    ['Day', [day.skin, day.hair, day.gi, day.hakama, day.sash, day.steel, day.gold], true],
    ['Dusk', ['#e8a27e', '#1c1a24', '#f2d3b8', '#3a3558', '#c43a3a', '#f0c7a0', '#d69a3c']],
    ['Night', ['#8f86b8', '#14121f', '#a9b3d6', '#232a4a', '#7c3a63', '#c9d6f2', '#a99560']],
  ]
    .map(([name, colours, isSelected]) => `<li class="layer-row ${isSelected ? 'selected' : ''}">${strip(colours)}<span class="layer-name">${name}</span></li>`)
    .join('')
  const swatch = ([name, colour, isSelected]) =>
    `<li class="layer-row ${isSelected ? 'selected' : ''}"><span class="swatch-chip big" style="background:${colour}"></span><span class="layer-name">${name}</span><span class="hex">${colour.slice(1).toUpperCase()}</span></li>`
  const kentaColours = [
    ['Skin', day.skin], ['Skin shade', day.skinShade], ['Hair', day.hair], ['Gi', day.gi, true], ['Gi shade', day.giShade], ['Hakama', day.hakama],
    ['Hakama shade', day.hakamaShade], ['Sash', day.sash], ['Sash shade', day.sashShade], ['Steel', day.steel], ['Gold', day.gold],
  ]
  const dusk = BACKDROPS.dusk
  const sceneColours = [['Sky', dusk.sky[1]], ['Sun', dusk.sun], ['Far hills', dusk.far], ['Hills', dusk.mid], ['Ground', dusk.near]]
  return (
    tabs(ANIM_TABS, 'Swatches') +
    `<div class="tab-panel">
      <div class="section-heading">Palettes</div>
      <ul class="layer-list">${palettes}</ul>
      <div class="section-heading">Kenta, global colours</div>
      <ul class="layer-list">${kentaColours.map(swatch).join('')}</ul>
      <div class="section-heading">Dusk pass, global colours</div>
      <ul class="layer-list">${sceneColours.map(swatch).join('')}</ul>
    </div>`
  )
}

/* Views */

const EDIT_AT = { x: 480, y: 990, scale: 0.62 }
const WALK_POSE = { armR: { shoulder: 22, elbow: 14 }, armL: { shoulder: -2, elbow: -18 }, headTilt: -3, mouth: 'C' }

function editCanvas(unit) {
  const box = sceneBox(EDIT_AT, KENTA_BOX)
  const middle = [(box.left + box.right) / 2, (box.top + box.bottom) / 2]
  const path = [[middle[0] - 300, middle[1] + 20], middle, [middle[0] + 420, middle[1] - 30]]
  return `<image href="img/cows.jpg" width="1920" height="1080" preserveAspectRatio="xMidYMid slice"/>
    <ellipse cx="${EDIT_AT.x}" cy="${EDIT_AT.y}" rx="${110 * EDIT_AT.scale}" ry="${14 * EDIT_AT.scale}" fill="rgb(0 0 0 / 28%)"/>
    ${placed(EDIT_AT, kenta(WALK_POSE))}
    <polyline class="motion-path" points="${path.map((point) => point.join(',')).join(' ')}"/>
    ${path.map(([x, y]) => `<circle class="canvas-handle path-point" cx="${x}" cy="${y}" r="${4.5 * unit}"/>`).join('')}
    ${selectionBox(box, unit)}`
}

function editProperties() {
  return (
    group(
      'Animation',
      'symbol',
      picker('Asset', 'Kenta') +
        labelled('Version', `<div class="field-row"><div class="field-box">${input('v4, linked')}</div>${button('Update to v5')}</div>`) +
        picker('Action', 'Walk') +
        segmented('Playback', ['Loop', 'Once', 'Hold'], 'Loop') +
        pair(field('First frame', '1'), picker('Frame rate (fps)', '12')) +
        button('Edit animation', 'pen', 'wide'),
    ) +
    group('Transform', 'move', keyedPair(['X', '454.0'], ['Y', '782.4'], true) + field('Scale (%)', '62.0', false) + field('Rotation (°)', '0.0', false)) +
    group('Timing', 'clock', pair(field('Start (s)', '1.500'), field('Duration (s)', '7.500'))) +
    group('Opacity', 'droplet', '', false) +
    group('In and out', 'preview', '', false) +
    group('Effects', 'wand', '', false)
  )
}

const DRAW_AT = { x: 860, y: 1000, scale: 1.22 }
const TAIL_C = [[50, -584], [86, -558], [128, -550], [170, -532]]

function drawCanvas(unit) {
  const outline = taperedOutline(TAIL_B, 13, 1.5).map((point) => toScene(DRAW_AT, point))
  const nodeIndexes = [0, 13, 27, 40, 54, 68, 81]
  const chosenIndex = 27
  const size = 7 * unit
  const [cx, cy] = outline[chosenIndex]
  const [px, py] = outline[chosenIndex - 6]
  const [nx, ny] = outline[chosenIndex + 6]
  const nodes = nodeIndexes
    .map((index) => {
      const [x, y] = outline[index]
      return `<rect class="node ${index === chosenIndex ? 'chosen' : ''}" x="${x - size / 2}" y="${y - size / 2}" width="${size}" height="${size}"/>`
    })
    .join('')
  const handles = `<line class="node-handle-line" x1="${px}" y1="${py}" x2="${nx}" y2="${ny}"/><circle class="node" cx="${px}" cy="${py}" r="${3.5 * unit}"/><circle class="node" cx="${nx}" cy="${ny}" r="${3.5 * unit}"/>`
  const [bx, by] = toScene(DRAW_AT, TAIL_C.at(-1))
  return `${background('dusk')}
    <rect class="context-dim" width="1920" height="1080"/>
    ${placed(DRAW_AT, kenta({}) + `<path d="${pathOf(taperedOutline(TAIL_C, 12, 2))}" fill="${PALETTES.day.sash}"/>`)}
    <path class="node-path" d="${pathOf(outline)}"/>
    ${handles}${nodes}
    <circle class="brush-ring" cx="${bx + 2}" cy="${by + 2}" r="9"/><circle class="brush-ring inner" cx="${bx + 2}" cy="${by + 2}" r="10"/>`
}

function drawProperties() {
  return (
    group(
      'Brush',
      'brush',
      field('Width (px)', '16') +
        segmented('Pressure', ['Width', 'Opacity', 'Off'], 'Width') +
        pair(field('Taper start (%)', '0'), field('Taper end (%)', '100')) +
        field('Smoothing (%)', '60') +
        check('Merge with same colour', true),
    ) +
    group('Fill', 'droplet', picker('Colour', 'Sash shade', PALETTES.day.sashShade) + field('Opacity (%)', '100')) +
    group('Stroke', 'line', picker('Colour', 'None') + field('Width (px)', '0')) +
    group('Transform', 'move', '', false) +
    group('Effects', 'wand', '', false)
  )
}

const IDLE_TIMELINE = {
  path: ['Episode 3', 'Kenta', 'Idle'],
  fps: 12,
  end: 72,
  current: 17,
  frameWidth: 18,
  visible: 84,
  rows: [
    { name: 'Head', kind: 'folder', open: true, spans: [{ start: 1, length: 72 }] },
    { name: 'Headband', kind: 'drawing', depth: 1, selected: true, spans: exposures(1, 72, 3) },
    { name: 'Hair', kind: 'drawing', depth: 1, spans: [{ start: 1, length: 72 }] },
    { name: 'Eyes', kind: 'symbol', depth: 1, spans: spansFrom([[1, 40, 'Open'], [41, 4, 'Blink'], [45, 28, 'Open']]) },
    { name: 'Mouth', kind: 'symbol', depth: 1, spans: spansFrom([[1, 72, 'X']]) },
    { name: 'Face', kind: 'drawing', depth: 1, spans: [{ start: 1, length: 72 }] },
    { name: 'Torso', kind: 'tween', spans: [{ start: 1, length: 36, tween: true }, { start: 37, length: 36, tween: true }] },
    { name: 'Arm R', kind: 'folder', open: false, spans: [{ start: 1, length: 72 }] },
    { name: 'Arm L', kind: 'folder', open: false, spans: [{ start: 1, length: 72 }] },
    { name: 'Hakama', kind: 'drawing', spans: [{ start: 1, length: 72 }] },
    { name: 'Sword', kind: 'drawing', spans: [{ start: 1, length: 72 }] },
  ],
}

const STYLE_VARIANTS = [
  { x: 270, label: 'No outline', options: {} },
  { x: 720, label: 'Black outline, 6 px', options: { lineStyle: { line: 'black', width: 12 } } },
  { x: 1170, label: 'Darker fill, 45%', options: { lineStyle: { line: 'darker', width: 12, darken: 0.45 } }, isSelected: true },
  { x: 1640, label: 'Night palette', options: { palette: 'night' }, labelColour: '#a9b3d6' },
]

function styleCanvas(unit) {
  const y = 985
  const scale = 1.1
  const figures = STYLE_VARIANTS.map((variant) => {
    const at = { x: variant.x, y, scale }
    const shadow = `<ellipse cx="${variant.x}" cy="${y}" rx="${120 * scale}" ry="${12 * scale}" fill="rgb(0 0 0 / 14%)"/>`
    return `${shadow}${placed(at, kenta({ armR: { shoulder: 12, elbow: 6 } }, variant.options))}<text class="canvas-label" x="${variant.x - 40}" y="200" text-anchor="middle" ${variant.labelColour ? `style="fill:${variant.labelColour}"` : ''}>${variant.label}</text>`
  }).join('')
  const chosen = STYLE_VARIANTS.find((variant) => variant.isSelected)
  return `<rect width="1920" height="1080" fill="#ece6da"/>
    <rect x="1400" y="0" width="520" height="1080" fill="#232a4f"/>
    ${figures}
    ${selectionBox(sceneBox({ x: chosen.x, y, scale }, KENTA_BOX), unit)}`
}

function styleProperties() {
  const colourEditor = `<div class="colour-editor"><div class="sv-square" style="--hue:42"><span class="knob" style="left:10%;top:5%"></span></div><div class="hue-bar"><span class="knob" style="left:11.7%"></span></div></div>`
  return (
    group('Line style', 'pen', picker('Outline', 'Darker fill') + pair(field('Width (px)', '6'), field('Darken (%)', '45')) + check('Outline shading shapes', false)) +
    group('Fill', 'droplet', picker('Colour', 'Gi', PALETTES.day.gi) + colourEditor + pair(field('Hex', 'F3ECDC'), field('Opacity (%)', '100'))) +
    group('Stroke', 'line', picker('Colour', 'From line style') + segmented('Align', ['Inside', 'Centre', 'Outside'], 'Outside') + segmented('Joins', ['Round', 'Mitre', 'Bevel'], 'Round')) +
    group('Shading', 'blur', check('Clip to fill', true) + picker('Blend', 'Multiply')) +
    group('Fill tool', 'bucket', field('Close gaps (px)', '4'))
  )
}

const ANIMATE_AT = { x: 1060, y: 1000, scale: 1 }
const SLASH_POSES = {
  13: { shoulder: 174, elbow: 18, sword: 30 },
  14: { shoulder: 172, elbow: 16, sword: 28 },
  15: { shoulder: 166, elbow: 14, sword: 24 },
  16: { shoulder: 142, elbow: 8, sword: 14 },
  17: { shoulder: 108, elbow: 0, sword: 4 },
  18: { shoulder: 72, elbow: -6, sword: -8 },
  19: { shoulder: 44, elbow: -10, sword: -14 },
  20: { shoulder: 32, elbow: -12, sword: -16 },
  21: { shoulder: 28, elbow: -12, sword: -17 },
}

function slashPose(frame) {
  return { armR: { ...SLASH_POSES[frame], holding: true }, armL: { shoulder: -34, elbow: -36 }, brows: 'angry', mouth: 'D' }
}

function animateCanvas(unit) {
  const skin = (frame, filter, opacity) => `<g filter="url(#${filter})" opacity="${opacity}">${placed(ANIMATE_AT, kenta(slashPose(frame)))}</g>`
  const frames = Object.keys(SLASH_POSES).map(Number)
  const tips = frames.map((frame) => toScene(ANIMATE_AT, armJoints('R', SLASH_POSES[frame]).tip))
  const arc = smoothPoints(tips, 8)
  const dotClass = (frame) => (frame === 15 || frame === 16 ? 'before' : frame === 18 || frame === 19 ? 'after' : '')
  const dots = frames
    .map((frame, i) => {
      const [x, y] = tips[i]
      const radius = (frame === 17 ? 7 : 5) * unit
      const fill = frame === 17 || dotClass(frame) ? '' : 'style="fill:var(--text-secondary)"'
      return `<circle class="arc-dot ${dotClass(frame)}" cx="${x}" cy="${y}" r="${radius}" ${fill}/>`
    })
    .join('')
  return `<defs>
      <filter id="onion-before"><feFlood flood-color="#e5484d"/><feComposite in2="SourceAlpha" operator="in"/></filter>
      <filter id="onion-after"><feFlood flood-color="#46c35a"/><feComposite in2="SourceAlpha" operator="in"/></filter>
    </defs>
    ${background('dusk')}
    ${skin(15, 'onion-before', 0.22)}${skin(16, 'onion-before', 0.4)}
    ${skin(19, 'onion-after', 0.22)}${skin(18, 'onion-after', 0.4)}
    ${placed(ANIMATE_AT, kenta(slashPose(17)))}
    <path class="arc-path" d="M${arc.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(' L')}"/>
    ${dots}`
}

function animateProperties() {
  return (
    group(
      'Onion skin',
      'onion',
      pair(field('Before', '2'), field('After', '2')) +
        segmented('Count', ['Drawings', 'Frames'], 'Drawings') +
        field('Opacity (%)', '40') +
        pair(labelled('Before colour', colourWell('#e5484d')), labelled('After colour', colourWell('#46c35a'))) +
        check('Show arcs', true) +
        check('Outlines only', false),
    ) +
    group('Drawing', 'pen', field('Name', 'Slash 17') + segmented('Hold (frames)', ['1', '2', '3', '4'], '1')) +
    group('Fill', 'droplet', picker('Colour', 'Steel', PALETTES.day.steel)) +
    group('Transform', 'move', '', false)
  )
}

const SLASH_EXPOSURES = spansFrom([[1, 4], [5, 4], [9, 2], [11, 2], [13, 2], [15, 1], [16, 1], [17, 1], [18, 1], [19, 1], [20, 2], [22, 2], [24, 4], [28, 9]])

const SLASH_TIMELINE = {
  path: ['Episode 3', 'Kenta', 'Slash'],
  fps: 12,
  end: 36,
  current: 17,
  frameWidth: 25,
  visible: 60,
  onion: { before: [15, 16], after: [18, 19] },
  rows: [
    { name: 'Head', kind: 'tween', spans: [{ start: 1, length: 12, tween: true }, { start: 13, length: 24 }] },
    { name: 'Eyes', kind: 'symbol', spans: spansFrom([[1, 12, 'Open'], [13, 24, 'Angry']]) },
    { name: 'Mouth', kind: 'symbol', spans: spansFrom([[1, 12, 'X'], [13, 12, 'D'], [25, 6, 'C'], [31, 6, 'X']]) },
    { name: 'Torso', kind: 'tween', spans: [{ start: 1, length: 14, tween: true }, { start: 15, length: 6, tween: true }, { start: 21, length: 16 }] },
    { name: 'Arm R', kind: 'folder', open: true, spans: [{ start: 1, length: 36 }] },
    { name: 'Sleeve R', kind: 'drawing', depth: 1, spans: SLASH_EXPOSURES },
    { name: 'Forearm R', kind: 'drawing', depth: 1, spans: SLASH_EXPOSURES },
    { name: 'Sword', kind: 'drawing', depth: 1, selected: true, spans: SLASH_EXPOSURES },
    { name: 'Arm L', kind: 'folder', open: false, spans: [{ start: 1, length: 36 }] },
    { name: 'Hakama', kind: 'drawing', spans: [{ start: 1, length: 36 }] },
    { name: 'Swish', kind: 'audio', spans: [{ start: 15, length: 8, label: 'swish.wav', seed: 11 }] },
  ],
}

const RIG_AT = { x: 940, y: 1020, scale: 1.32 }
const REACH_POSE = { armR: { shoulder: 115, elbow: -40 }, armL: { shoulder: -20, elbow: 26 }, headTilt: -6 }

function bonePath([ax, ay], [bx, by], unit, isChosen) {
  const dx = bx - ax
  const dy = by - ay
  const length = Math.hypot(dx, dy)
  const ux = dx / length
  const uy = dy / length
  const halfWidth = Math.max(4 * unit, Math.min(length * 0.1, 11 * unit))
  const mx = ax + ux * length * 0.2
  const my = ay + uy * length * 0.2
  return `<path class="bone ${isChosen ? 'chosen' : ''}" d="M${ax} ${ay} L${mx - uy * halfWidth} ${my + ux * halfWidth} L${bx} ${by} L${mx + uy * halfWidth} ${my - ux * halfWidth}Z"/>`
}

function rigCanvas(unit) {
  const scene = (point) => toScene(RIG_AT, point)
  const right = armJoints('R', REACH_POSE.armR)
  const left = armJoints('L', REACH_POSE.armL)
  const [tx, ty] = rotatePoint(REACH_POSE.headTilt, [0, -125])
  const headEnd = [tx, -505 + ty]
  const bones = [
    [[0, -300], [0, -455]], [[0, -455], [0, -505]], [[0, -505], headEnd],
    [[0, -455], right.shoulder], [right.shoulder, right.elbow], [right.elbow, right.hand, true],
    [[0, -455], left.shoulder], [left.shoulder, left.elbow], [left.elbow, left.hand],
    [[-28, -300], [-50, -165]], [[-50, -165], [-62, -26]], [[28, -300], [50, -165]], [[50, -165], [62, -26]],
  ]
  const boneShapes = bones.map(([a, b, isChosen]) => bonePath(scene(a), scene(b), unit, isChosen)).join('')
  const joints = bones.map(([a]) => scene(a)).map(([x, y]) => `<circle class="joint" cx="${x}" cy="${y}" r="${4 * unit}"/>`).join('')
  const [hx, hy] = scene(right.hand)
  const [sx, sy] = scene(right.shoulder)
  const target = `<line class="ik-line" x1="${sx}" y1="${sy}" x2="${hx}" y2="${hy}"/>
    <circle class="ik-target" cx="${hx}" cy="${hy}" r="${15 * unit}"/>
    <line class="ik-cross" x1="${hx - 22 * unit}" y1="${hy}" x2="${hx + 22 * unit}" y2="${hy}"/>
    <line class="ik-cross" x1="${hx}" y1="${hy - 22 * unit}" x2="${hx}" y2="${hy + 22 * unit}"/>`
  const pins = [[-62, -26], [62, -26]]
    .map(scene)
    .map(([x, y]) => `<line class="ik-cross" x1="${x}" y1="${y}" x2="${x}" y2="${y - 16 * unit}"/><circle class="pin" cx="${x}" cy="${y - 20 * unit}" r="${6 * unit}"/>`)
    .join('')
  const forearmPoints = [[-10, -10], [10, -10], [8, 80], [-8, 80], [0, FOREARM - 14], [0, FOREARM + 14], [-12, FOREARM], [12, FOREARM]]
    .map((point) => scene(armPoint('R', REACH_POSE.armR, 'fore', point)))
    .map(([x, y]) => `<circle class="bound-point" cx="${x}" cy="${y}" r="${3.5 * unit}"/>`)
    .join('')
  const sleevePoints = [[-24, -12], [24, -12], [36, 98], [-34, 102], [2, 112]]
    .map((point) => scene(armPoint('R', REACH_POSE.armR, 'upper', point)))
    .map(([x, y]) => `<circle class="bound-point other" cx="${x}" cy="${y}" r="${3.5 * unit}"/>`)
    .join('')
  const [ex, ey] = scene(right.elbow)
  return `${background('dusk')}
    <line x1="600" y1="0" x2="600" y2="372" stroke="#3a2134" stroke-width="3"/>
    ${placed({ x: 600, y: 480, scale: 0.26 }, lantern())}
    <rect class="context-dim" width="1920" height="1080"/>
    ${placed(RIG_AT, kenta(REACH_POSE))}
    ${boneShapes}${joints}${target}${pins}${sleevePoints}${forearmPoints}
    ${canvasTag(ex + 10 * unit, ey - 14 * unit, 'Forearm R', unit)}`
}

function rigProperties() {
  return (
    group('Bone', 'bone', field('Name', 'Forearm R') + picker('Parent', 'Upper arm R') + pair(field('Length (px)', '88'), field('Rotation (°)', '-40.0')) + field('Scale (%)', '100', false)) +
    group('IK', 'target', picker('Target', 'Hand R target') + segmented('Bend', ['Clockwise', 'Anticlockwise'], 'Anticlockwise') + field('Mix (%)', '100', true) + check('Stretch to reach', false)) +
    group('Binding', 'link', segmented('Mode', ['Points', 'Mesh'], 'Points') + field('Falloff (px)', '24') + button('Paint weights', 'brush', 'wide')) +
    group('Jiggle', 'wand', '', false)
  )
}

const REACH_TIMELINE = {
  path: ['Episode 3', 'Kenta', 'Reach'],
  fps: 12,
  end: 48,
  current: 13,
  frameWidth: 18,
  visible: 84,
  toolbarExtra: '<div class="segmented"><button class="button" aria-pressed="true">Frames</button><button class="button" aria-pressed="false">Curves</button></div><span class="toolbar-divider"></span>',
  rows: [
    { name: 'IK arm R', kind: 'ik', selected: true, keys: [1, 13, 25, 48] },
    { name: 'Spine', kind: 'bone', keys: [1, 13, 37] },
    { name: 'Head', kind: 'bone', keys: [1, 9, 25] },
    { name: 'Upper arm L', kind: 'bone', keys: [1, 25] },
    { name: 'Forearm L', kind: 'bone', keys: [1, 25] },
    { name: 'IK leg R', kind: 'ik', spans: spansFrom([[1, 48, 'Pinned']]) },
    { name: 'IK leg L', kind: 'ik', spans: spansFrom([[1, 48, 'Pinned']]) },
    { name: 'Headband', kind: 'physics', spans: spansFrom([[1, 48, 'Jiggle']]) },
    { name: 'Mouth', kind: 'symbol', spans: spansFrom([[1, 48, 'X']]) },
  ],
}

const LIP_AT = { x: 900, y: 1856, scale: 2.6 }

function lipCanvas(unit) {
  const box = sceneBox(LIP_AT, { left: -22, top: -537, right: 22, bottom: -506 })
  return `${background('dusk')}
    ${placed(LIP_AT, kenta({ mouth: 'D', brows: 'angry' }))}
    ${selectionBox(box, unit)}
    ${canvasTag(box.right + 10 * unit, box.top + 4 * unit, 'Mouth: D', unit)}`
}

function lipProperties() {
  return (
    group('Instance', 'symbol', picker('Symbol', 'Mouth') + segmented('Playback', ['Loop', 'Once', 'Single frame'], 'Single frame') + picker('Frame', 'D (A, I)')) +
    group('Lip sync', 'music', picker('Audio', 'kenta-line-03.wav') + picker('Detection', 'Phonetic, any language') + button('Detect mouth shapes', 'wand', 'wide')) +
    group('Transform', 'move', '', false) +
    group('Effects', 'wand', '', false)
  )
}

const LINE_TIMELINE = {
  path: ['Episode 3', 'Kenta', 'Line 03'],
  fps: 12,
  end: 48,
  current: 21,
  frameWidth: 18,
  visible: 84,
  rows: [
    { name: 'Dialogue', kind: 'audio', spans: [{ start: 3, length: 22, seed: 21, gap: [10.6, 11.8], words: [[3, 'Nie'], [6, 'dziś,'], [12, 'demonie!']] }] },
    {
      name: 'Mouth',
      kind: 'symbol',
      selected: true,
      spans: spansFrom([[1, 2, 'X'], [3, 1, 'B'], [4, 2, 'C'], [6, 1, 'B'], [7, 2, 'C'], [9, 2, 'B'], [11, 1, 'X'], [12, 1, 'B'], [13, 2, 'C'], [15, 1, 'A'], [16, 2, 'E'], [18, 1, 'B'], [19, 2, 'C'], [21, 3, 'D'], [24, 25, 'X']]),
    },
    { name: 'Eyes', kind: 'symbol', spans: spansFrom([[1, 28, 'Angry'], [29, 3, 'Blink'], [32, 17, 'Angry']]) },
    { name: 'Brows', kind: 'tween', spans: [{ start: 1, length: 12, tween: true }, { start: 13, length: 36 }] },
    { name: 'Head', kind: 'tween', spans: [{ start: 1, length: 11, tween: true }, { start: 12, length: 10, tween: true }, { start: 22, length: 27 }] },
  ],
}

function saveDialog() {
  const include = `<div class="check-list">
    ${check('Drawings and symbols', true, '31')}
    ${check('Bones and IK', true, '15 bones')}
    ${check('Actions', true, 'Idle, Walk, Slash, Reach')}
    ${check('Mouth chart', true, '9 shapes')}
    ${check('Palettes', true, 'Day, Dusk, Night')}
  </div>`
  return `<div class="dialog-layer"><div class="dialog" style="width:460px"><div class="dialog-form">
    <h2 class="dialog-title">Save as asset</h2>
    ${field('Name', 'Kenta')}
    ${segmented('Save to', ['This episode', 'Series library'], 'Series library')}
    ${picker('Library', 'Ronin Road')}
    ${labelled('Include', include)}
    ${segmented('Other episodes get', ['Linked', 'Copy'], 'Linked')}
    <p class="hint">Episodes 1 and 2 use v4 and offer v5 when opened</p>
    ${field('Version', 'v5')}
    <div class="dialog-buttons"><button class="button">Cancel</button><button class="button primary">Save</button></div>
  </div></div></div>`
}

const DRAW_VIEW = {
  left: drawLayers,
  right: drawProperties,
  canvas: { viewBox: '540 120 800 450', draw: drawCanvas },
  toolstrip: 'brush',
  footer: () => animFooter({ frame: 17, total: 72, time: '00:00:01:04', zoom: '125%', context: 45 }),
  timeline: () => frameTimeline(IDLE_TIMELINE),
  timelineHeight: 345,
}

const VIEWS = {
  edit: {
    title: 'Edit: animation clips on the timeline',
    left: () => tabs(['Media', 'Effects', 'Transitions', 'Annotations', 'Assets'], 'Assets') + `<div class="tab-panel">${assetsLibrary()}</div>`,
    right: editProperties,
    canvas: { viewBox: '0 0 1920 1080', draw: editCanvas },
    footer: editFooter,
    timeline: editTimeline,
    timelineHeight: 424,
  },
  draw: { title: 'Draw: vector brush', ...DRAW_VIEW },
  style: {
    title: 'Outlines, fills and colours',
    left: swatchesPanel,
    right: styleProperties,
    canvas: { viewBox: '0 0 1920 1080', draw: styleCanvas },
    toolstrip: 'pointer',
    footer: () => animFooter({ frame: 1, total: 1, time: '00:00:00:00', zoom: 'Fit' }),
    timelineHeight: 0,
  },
  animate: {
    title: 'Animate: frame by frame with onion skin',
    left: () => slashLayers(slashPose(17)),
    right: animateProperties,
    canvas: { viewBox: '0 0 1920 1080', draw: animateCanvas },
    toolstrip: 'brush',
    footer: () => animFooter({ frame: 17, total: 36, time: '00:00:01:04', zoom: 'Fit', isOnion: true }),
    timeline: () => frameTimeline(SLASH_TIMELINE),
    timelineHeight: 362,
  },
  rig: {
    title: 'Rig: bones and IK',
    left: bonesPanel,
    right: rigProperties,
    canvas: { viewBox: '0 0 1920 1080', draw: rigCanvas },
    toolstrip: 'bone',
    footer: () => animFooter({ frame: 13, total: 48, time: '00:00:01:00', zoom: 'Fit', context: 45 }),
    timeline: () => frameTimeline(REACH_TIMELINE),
    timelineHeight: 292,
  },
  lipsync: {
    title: 'Lip sync: mouth chart',
    left: () => framesPanel('D'),
    right: lipProperties,
    canvas: { viewBox: '0 0 1920 1080', draw: lipCanvas },
    toolstrip: 'pointer',
    footer: () => animFooter({ frame: 21, total: 48, time: '00:00:01:08', zoom: 'Fit' }),
    timeline: () => frameTimeline(LINE_TIMELINE),
    timelineHeight: 236,
  },
  save: { title: 'Save as asset', ...DRAW_VIEW, dialog: saveDialog },
}

function shell(view) {
  const hasTimeline = view.timelineHeight > 0
  return `<div class="editor" style="--timelineHeight:${view.timelineHeight}px">
    <aside class="sidebar left">${view.left()}</aside>
    <div class="splitter leftWidth"></div>
    <section class="canvas-panel">
      <div class="canvas-row">${view.toolstrip ? toolstrip(view.toolstrip) : ''}<div class="canvas-area" id="canvas-area"></div></div>
      ${view.footer()}
    </section>
    <div class="splitter rightWidth"></div>
    <aside class="sidebar right">${view.right()}</aside>
    ${hasTimeline ? `<div class="splitter timelineHeight"></div><section class="timeline-panel">${view.timeline()}</section>` : ''}
  </div>`
}

function render() {
  const names = Object.keys(VIEWS)
  const name = new URLSearchParams(location.search).get('view') ?? 'edit'
  const view = VIEWS[name] ?? VIEWS.edit
  document.title = view.title
  const root = document.getElementById('root')
  root.innerHTML = shell(view)
  const area = document.getElementById('canvas-area')
  const [, , boxWidth, boxHeight] = view.canvas.viewBox.split(' ').map(Number)
  const fit = Math.min((area.clientWidth - 32) / boxWidth, (area.clientHeight - 32) / boxHeight)
  const width = Math.floor(boxWidth * fit)
  const height = Math.floor(boxHeight * fit)
  const unit = boxWidth / width
  area.innerHTML = `<div class="preview-fit"><div class="preview-frame"><svg class="canvas-svg" width="${width}" height="${height}" viewBox="${view.canvas.viewBox}">${view.canvas.draw(unit)}</svg></div></div>`
  if (view.dialog) root.insertAdjacentHTML('beforeend', view.dialog())
  document.addEventListener('keydown', (event) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    if (step === 0) return
    location.search = `?view=${names[(names.indexOf(name) + step + names.length) % names.length]}`
  })
}

render()
