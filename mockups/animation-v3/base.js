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
  music: 'M6 12V3l7-1.5v9M6 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM13 10.5a2 2 0 1 1-4 0 2 2 0 0 1 4 0z',
  chevronDown: 'M4 6l4 4 4-4',
  chevronRight: 'M6 4l4 4-4 4',
  chevronLeft: 'M10 4L6 8l4 4',
  list: 'M2 3h3.5v3.5H2zM8 4.75h6M2 9.5h3.5V13H2zM8 11.25h6',
  grid: 'M2.5 2.5h4.5V7H2.5zM9 2.5h4.5V7H9zM2.5 9h4.5v4.5H2.5zM9 9h4.5v4.5H9z',
  move: 'M8 2v12M2 8h12M6 4l2-2 2 2M6 12l2 2 2-2M4 6L2 8l2 2M12 6l2 2-2 2',
  clock: 'M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zM8 5v3l2 1.5',
  droplet: 'M8 2.5s4 4 4 7a4 4 0 0 1-8 0c0-3 4-7 4-7z',
  keyframe: 'M8 2.5L13.5 8 8 13.5 2.5 8z',
  preview: 'M2 3h12v10H2zM6.5 5.5l4 2.5-4 2.5z',
  export: 'M8 10V2.5M5 5.5l3-3 3 3M3 9v4.5h10V9',
  search: 'M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM10.25 10.25L13.5 13.5',
  zoom: 'M2 3h12v10H2zM5.5 6h5v4h-5z',
  wand: 'M3 13l7-7M11.5 2v2.5M10.25 3.25h2.5M13.5 6.5v2M12.5 7.5h2M6 2.5v2M5 3.5h2',
  pointer: 'M3.5 2.5l9 5.5-4.2 1.2-2 4.3z',
  brush: 'M13.5 2.5l-6 6.5M7.5 9c-1.8-.4-3.4.6-3.6 2.4-.1 1-.6 1.8-1.4 2.1 2.4.6 5.6.1 6-2.6z',
  pencil: 'M10.5 2.5l3 3-8 8h-3v-3zM9 4l3 3',
  bucket: 'M2.5 8.5L8 3l5 5-5.5 5.5zM2.5 8.5h10.5M13.5 11.5s1 1.3 1 2a1 1 0 0 1-2 0c0-.7 1-2 1-2z',
  eraser: 'M5 12.5L2.5 10 9 3.5l4 4-5 5zM6 6.5l4 4M5 12.5h8.5',
  onion: 'M6 2.5h7.5V10M4.25 4.25h7.5v7.5M2.5 6h7.5v7.5H2.5z',
  pen: 'M8 2l4.5 5.5L10 13H6L3.5 7.5zM8 2v5.5',
}

const STAGE = '#2a303b'
const PAPER = '#f5f3ee'
const LINE_ART = { lineStyle: { line: 'black', width: 7 } }
const ALL_FILLS = ['skin', 'skinShade', 'gi', 'giShade', 'hakama', 'hakamaShade', 'sash', 'sashShade', 'sole', 'steel', 'steelShade', 'gold', 'scabbard']

/* Controls */

function icon(name) {
  return `<svg class="icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="${ICONS[name]}"/></svg>`
}

function iconButton(name, label, state = '') {
  return `<button class="button icon" aria-pressed="${state === 'on'}" title="${label}">${icon(name)}</button>`
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

function pickerControl(value) {
  return `<button class="field picker"><span class="picker-value">${value}</span>${icon('chevronDown')}</button>`
}

function keyNav(isOnKey) {
  return `${iconButton('chevronLeft', 'Previous keyframe')}${iconButton('keyframe', 'Keyframe', isOnKey ? 'on' : '')}${iconButton('chevronRight', 'Next keyframe')}`
}

function field(label, value, keyed) {
  if (keyed === undefined) return labelled(label, input(value))
  return `<div class="field-row keyed">${labelled(label, input(value))}${keyNav(keyed)}</div>`
}

function pair(first, second) {
  return `<div class="field-pair">${first}${second}</div>`
}

function keyedPair(first, second, isOnKey) {
  return `<div class="field-row keyed">${pair(field(...first), field(...second))}${keyNav(isOnKey)}</div>`
}

function check(label, isOn) {
  return `<label class="check-field"><input type="checkbox" ${isOn ? 'checked' : ''}>${label}</label>`
}

/* Art placement */

const CHARACTER_IN_CANVAS = { x: 540, y: 1040, scale: 1.45 }

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

function within(outer, inner) {
  return { x: outer.x + outer.scale * inner.x, y: outer.y + outer.scale * inner.y, scale: outer.scale * inner.scale }
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

function clipBox(at, size) {
  return { left: at.x, top: at.y, right: at.x + at.scale * size, bottom: at.y + at.scale * size }
}

function cursor(name, [x, y], unit) {
  const scale = 1.4 * unit
  const tips = { pencil: [2.5, 13.5], bucket: [13.5, 14] }
  const [tx, ty] = tips[name]
  return `<g transform="translate(${x - tx * scale} ${y - ty * scale}) scale(${scale})"><path d="${ICONS[name]}" fill="none" stroke="#141218" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/><path d="${ICONS[name]}" fill="none" stroke="#ffffff" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></g>`
}

function seeded(seed) {
  let state = seed
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296
    return state / 4294967296
  }
}

function waveform(width, height, seed, envelope = () => 1, level = 1) {
  const random = seeded(seed)
  let bars = ''
  for (let i = 0; i < width - 2; i += 3) {
    const amplitude = (0.2 + 0.8 * random()) * envelope(i / width) * level * (height / 2 - 2)
    bars += `<rect x="${i}" y="${(height / 2 - amplitude).toFixed(1)}" width="2" height="${Math.max(1, amplitude * 2).toFixed(1)}"/>`
  }
  return `<svg class="clip-wave" width="${width}" height="${height}"><g fill="rgb(255 255 255 / 55%)">${bars}</g></svg>`
}

function kentaThumb(pose, crop = '-330 -700 660 371', options = {}, background = STAGE) {
  return svgOf(crop, kenta(pose, options), background)
}

function mouthThumb(shape) {
  return svgOf('-48 -566 96 54', kenta({ mouth: shape }), STAGE)
}

/* Timeline, the editor's own, with any tracks */

function timecode(seconds, fps) {
  const whole = Math.floor(seconds + 1e-6)
  const frames = Math.round((seconds - whole) * fps)
  return `00:00:${String(whole).padStart(2, '0')}:${String(frames).padStart(2, '0')}`
}

function clipHtml(clip, pixelsPerSecond) {
  const left = clip.start * pixelsPerSecond
  const width = (clip.end - clip.start) * pixelsPerSecond
  const colour = { video: 'var(--clip-video)', audio: 'var(--clip-audio)', annotation: 'var(--clip-annotation)', animation: 'var(--clip-animation)', drawing: 'var(--clip-drawing)', image: 'var(--clip-image)' }[clip.kind]
  let body = ''
  if (clip.thumbs) body = clip.thumbs.map((thumb) => `<span class="clip-thumb">${thumb}</span>`).join('')
  if (clip.thumbEvery) body = Array.from({ length: Math.ceil(width / clip.thumbEvery.width) }, (_, i) => `<span class="clip-thumb">${clip.thumbEvery.at(i)}</span>`).join('')
  if (clip.kind === 'audio') {
    const gaps = clip.gaps ?? []
    const envelope = (t) => {
      const time = clip.start + t * (clip.end - clip.start)
      if (gaps.some(([from, to]) => time >= from && time < to)) return 0.06
      return Math.min(1, t * 12, (1 - t) * 12)
    }
    body = waveform(width, 34, clip.seed ?? 3, envelope, clip.level)
  }
  const keys = (clip.keys ?? []).map((time) => `<span class="clip-key" style="left:${time * pixelsPerSecond}px"></span>`).join('')
  const classes = ['clip', clip.isSelected ? 'selected' : '', clip.isGhost ? 'ghost' : ''].join(' ')
  const label = clip.label ? `<div class="clip-label">${clip.label}</div>` : ''
  return `<div class="${classes}" style="left:${left}px;width:${width}px;background:${colour}">${label}<div class="clip-body">${body}</div>${keys}</div>`
}

function timeline(config) {
  const { pixelsPerSecond, seconds, fps, labelEvery, tickEvery, playhead, tracks } = config
  const ticks = []
  const steps = Math.round(seconds / tickEvery)
  for (let i = 0; i <= steps; i++) {
    const time = i * tickEvery
    const x = time * pixelsPerSecond
    const isMajor = Math.abs(time / labelEvery - Math.round(time / labelEvery)) < 1e-6
    ticks.push(`<span class="etl-tick ${isMajor ? 'major' : ''}" style="left:${x}px"></span>`)
    if (isMajor) ticks.push(`<span class="etl-time" style="left:${x}px">${timecode(time, fps)}</span>`)
  }
  const headers = tracks
    .map((track) => `<div class="track-header"><div class="track-grip"><span class="track-name">${track.name}</span></div>${iconButton('lock', 'Lock')}${iconButton('eye', 'Hide')}${iconButton('speaker', 'Mute')}</div>`)
    .join('')
  const rows = tracks.map((track, i) => `<div class="etl-track" style="top:${46 + i * 56}px">${track.clips.map((clip) => clipHtml(clip, pixelsPerSecond)).join('')}</div>`).join('')
  const path = config.path
    ? `<nav class="group-path">${config.path
        .slice(0, -1)
        .map((step) => `<button class="button with-icon">${icon('chevronLeft')}${step}</button>`)
        .join('')}<span class="group-path-here">${config.path.at(-1)}</span></nav>`
    : ''
  const snap = config.snapAt === undefined ? '' : `<span class="etl-snap" style="left:${config.snapAt * pixelsPerSecond}px"></span>`
  const ghost = config.dragLabel ? `<span class="drag-ghost static" style="left:${config.dragAt[0]}px;top:${config.dragAt[1]}px">${config.dragLabel}</span>` : ''
  return `<div class="timeline">
    <div class="timeline-toolbar">
      ${iconButton('plus', 'Add track')}${iconButton('scissors', 'Split')}${iconButton('magnet', 'Snapping', 'on')}
      ${path}
      <span class="spacer"></span>
      ${iconButton('minus', 'Zoom out')}${iconButton('fit', 'Zoom to full')}${iconButton('plus', 'Zoom in')}
      <button class="button primary with-icon">${icon('export')}Export</button>
    </div>
    <div class="timeline-body">
      <div class="track-headers-viewport"><div class="camera-lane-header">${icon('zoom')}<span>Camera</span></div>${headers}</div>
      <div class="timeline-canvases etl">
        <div class="etl-ruler">${ticks.join('')}</div>
        <div class="etl-camera"></div>
        ${rows}
        ${snap}
        <span class="etl-playhead" style="left:${playhead * pixelsPerSecond}px"></span>
        ${ghost}
      </div>
    </div>
    <div class="timeline-scrollbar"><div style="width:1800px"></div></div>
  </div>`
}

/* Shared panels */

function libraryTile(name, picture, details, isSelected = false) {
  return `<li><button class="library-item ${isSelected ? 'selected' : ''}"><span class="library-thumbnail">${picture}</span><span class="library-text"><span class="library-name">${name}</span><span class="library-details">${details}</span></span></button></li>`
}

function mediaTab(tiles, search = '') {
  return `${tabs(['Media', 'Effects', 'Transitions', 'Annotations'], 'Media')}
    <div class="tab-panel"><div class="library-tab">
      <div class="library-tools"><div class="field-box search-box">${icon('search')}<input class="field" placeholder="Search media" value="${search}"></div><div class="segmented">${iconButton('list', 'List')}${iconButton('grid', 'Grid', 'on')}</div></div>
      <ul class="library-list grid">${tiles.join('')}</ul>
    </div></div>`
}

const WALK_POSE = { armR: { shoulder: 22, elbow: 14 }, armL: { shoulder: -2, elbow: -18 }, headTilt: -3 }
const SLASH_THUMB = { armR: { shoulder: 166, elbow: 14, sword: 24, holding: true }, brows: 'angry', mouth: 'D' }
const MOUTH_NAMES = [['Mouth closed', 'X'], ['Mouth talk', 'C'], ['Mouth open', 'D'], ['Mouth O', 'E'], ['Mouth smile', 'smile'], ['Mouth shout', 'D']]
const AUDIO_THUMB = `<span style="display:flex;align-items:center;justify-content:center;width:100%;height:100%">${icon('music')}</span>`

function animationTiles() {
  return [
    libraryTile('Kenta idle', kentaThumb({ mouth: 'none' }), '<span>0:06</span>'),
    libraryTile('Kenta walk', kentaThumb(WALK_POSE), '<span>0:01</span>'),
    libraryTile('Kenta slash', kentaThumb(SLASH_THUMB), '<span>0:03</span>'),
    libraryTile('Oni laugh', svgOf('-400 -780 800 450', oni(), STAGE), '<span>0:02</span>'),
  ]
}

function transformGroup(x, y, scale) {
  return group('Transform', 'move', keyedPair(['X', x], ['Y', y], true) + field('Scale (%)', scale, false) + field('Rotation (°)', '0.0', false))
}

function timingGroup(start, duration, isLooping) {
  return group('Timing', 'clock', pair(field('Start (s)', start), field('Duration (s)', duration)) + pair(field('Source offset (s)', '0.000'), field('Speed (%)', '100')) + check('Loop', isLooping))
}

function foldedGroups() {
  return group('Crop', 'crop', '', false) + group('Opacity', 'droplet', '', false) + group('In and out', 'preview', '', false) + group('Effects', 'wand', '', false)
}

function colourGroup(chosen) {
  const colours = [
    ['Line', '#141218'], ['Skin', PALETTES.day.skin], ['Skin shade', PALETTES.day.skinShade], ['Hair', PALETTES.day.hair], ['Gi', PALETTES.day.gi], ['Gi shade', PALETTES.day.giShade],
    ['Hakama', PALETTES.day.hakama], ['Hakama shade', PALETTES.day.hakamaShade], ['Sash', PALETTES.day.sash], ['Sash shade', PALETTES.day.sashShade], ['Steel', PALETTES.day.steel], ['Gold', PALETTES.day.gold],
  ]
  const chips = colours.map(([name, colour]) => `<span class="chip ${name === chosen ? 'chosen' : ''}" title="${name}" style="background:${colour}"></span>`).join('')
  const [, hex] = colours.find(([name]) => name === chosen)
  return group('Colours', 'droplet', `<div class="chip-grid">${chips}<span class="chip add">${icon('plus')}</span></div>` + pair(field('Name', chosen), field('Hex', hex.slice(1).toUpperCase())))
}

function drawingTools(active) {
  const tools = [['pointer', 'Select'], ['pencil', 'Pencil'], ['brush', 'Brush'], ['bucket', 'Fill'], ['eraser', 'Eraser']]
  return `<div class="floating-tools">${tools.map(([name, label]) => iconButton(name, label, name === active ? 'on' : '')).join('')}</div>`
}

function footer({ time, total, isAnimation, isOnion, zoom = 'Fit' }) {
  return `<div class="canvas-footer">
    ${iconButton('stepBack', 'Previous frame')}${iconButton('play', 'Play')}${iconButton('stepForward', 'Next frame')}
    <span class="timecodes"><span class="timecode">${time}</span> <span class="timecode total">/ ${total}</span></span>
    <span class="spacer"></span>
    ${isAnimation ? iconButton('onion', 'Onion skin', isOnion ? 'on' : '') : iconButton('zoom', 'Camera')}
    ${iconButton('fit', 'Full screen')}${iconButton('crop', 'Crop')}
    <div class="canvas-zoom">${pickerControl(zoom)}</div>
    ${iconButton('preview', 'Preview')}
  </div>`
}

