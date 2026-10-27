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

/* 1. Episode: animations composited on the main timeline */

const EPISODE_KENTA = { x: 249.1, y: 545.3, scale: 0.4276 }

function episodeTracks(selected) {
  return [
    { name: 'Titles', clips: [{ start: 0.5, end: 4.5, kind: 'annotation', label: 'Ronin Road, episode 3' }] },
    {
      name: 'Kenta',
      clips: [
        { start: 1.5, end: 9, kind: 'animation', label: 'Kenta walk', isSelected: selected === 'walk', keys: [0, 7.5], thumbEvery: { width: 61, at: (i) => kentaThumb(i % 2 ? { mouth: 'X' } : WALK_POSE) } },
        { start: 9, end: 12.5, kind: 'animation', label: 'Kenta slash', thumbEvery: { width: 61, at: (i) => kentaThumb(i % 2 ? { ...SLASH_THUMB, armR: { shoulder: 72, elbow: -6, sword: -8, holding: true } } : SLASH_THUMB) } },
      ],
    },
    { name: 'Oni', clips: [{ start: 12, end: 19.5, kind: 'animation', label: 'Oni laugh', thumbEvery: { width: 61, at: () => svgOf('-400 -780 800 450', oni(), STAGE) } }] },
    { name: 'Footage', clips: [{ start: 0, end: 24, kind: 'video', label: 'cows1920.mp4', thumbs: ['<img src="img/cows.jpg" alt="">'] }] },
    { name: 'Dialogue', clips: [{ start: 2, end: 5.5, kind: 'audio', label: 'kenta-line-03.wav', seed: 3 }, { start: 12.5, end: 16.5, kind: 'audio', label: 'oni-line-01.wav', seed: 9 }] },
    { name: 'Music', clips: [{ start: 0, end: 24, kind: 'audio', label: 'ever.mp3', seed: 5, level: 0.45 }] },
  ]
}

const EPISODE_VIEW = {
  left: () =>
    mediaTab([
      ...animationTiles(),
      ...MOUTH_NAMES.slice(0, 2).map(([name, shape]) => libraryTile(name, mouthThumb(shape), '<span>0:01</span>')),
      libraryTile('cows1920.mp4', '<img class="library-poster" src="img/cows.jpg" alt="">', '<span>0:24</span>'),
      libraryTile('kenta-line-03.wav', AUDIO_THUMB, '<span>0:03</span>'),
      libraryTile('ever.mp3', AUDIO_THUMB, '<span>3:01</span>'),
    ]),
  right: () => transformGroup('480.0', '766.3', '42.8') + timingGroup('1.500', '7.500', true) + foldedGroups(),
  canvas: {
    size: [1920, 1080],
    draw: (unit) => `<image href="img/cows.jpg" width="1920" height="1080" preserveAspectRatio="xMidYMid slice"/>
      <ellipse cx="480" cy="990" rx="68" ry="9" fill="rgb(0 0 0 / 28%)"/>
      ${placed(within(EPISODE_KENTA, CHARACTER_IN_CANVAS), kenta(WALK_POSE))}
      ${selectionBox(clipBox(EPISODE_KENTA, 1080), unit)}`,
  },
  footer: () => footer({ time: '00:00:03:10', total: '00:00:24:00' }),
  timeline: () => timeline({ pixelsPerSecond: 61, seconds: 24, fps: 30, labelEvery: 2, tickEvery: 0.5, playhead: 3.4, tracks: episodeTracks('walk') }),
  timelineHeight: 424,
}

/* 2. Draw: pencil turns rough lines into smooth vectors */

const PART_CROPS = { armL: '20 -480 140 120', armR: '-150 -480 140 260', head: '-60 -680 120 180', body: '-90 -490 180 200', legs: '-125 -310 250 315', sword: '-220 -400 340 260' }
const SLEEVE_STROKE = [[66, -474], [90, -466], [104, -430], [116, -392], [124, -364], [110, -350], [90, -342]]

function idleTracks(isLineArt, selected) {
  const options = isLineArt ? { ...LINE_ART, unfilled: ALL_FILLS } : { ...LINE_ART, unfilled: ['hakama', 'hakamaShade'] }
  const pose = { mouth: 'none', armL: null }
  const thumb = (crop) => [svgOf(PART_CROPS[crop], kenta(pose, options), PAPER)]
  const drawing = (name, crop, extra = {}) => ({ start: 0, end: 6, kind: 'drawing', label: name, thumbs: crop ? thumb(crop) : [], isSelected: selected === name, ...extra })
  return [
    { name: 'Arm L', clips: [drawing('Arm L', null, { thumbs: [svgOf('0 0 16 9', '', PAPER)] })] },
    { name: 'Arm R', clips: [drawing('Arm R', 'armR', { keys: [0, 3, 6] })] },
    { name: 'Head', clips: [drawing('Head', 'head', { keys: [0, 3, 6] })] },
    { name: 'Body', clips: [drawing('Body', 'body', { keys: [0, 3, 6] })] },
    { name: 'Legs', clips: [drawing('Legs', 'legs')] },
    { name: 'Sword', clips: [drawing('Sword', 'sword')] },
  ]
}

function idleTimeline(isLineArt, selected) {
  return timeline({ path: ['Episode 3', 'Kenta idle'], pixelsPerSecond: 240, seconds: 6.2, fps: 12, labelEvery: 1, tickEvery: 0.5, playhead: 1.5, tracks: idleTracks(isLineArt, selected) })
}

function drawCanvas(unit) {
  const inCanvas = (point) => toScene(CHARACTER_IN_CANVAS, point)
  const smooth = smoothPoints(SLEEVE_STROKE, 10).map(inCanvas)
  const random = seeded(17)
  const raw = smoothPoints(SLEEVE_STROKE, 6).map(([x, y], i, all) => {
    const wobble = i === 0 || i === all.length - 1 ? 0 : 5
    return inCanvas([x + (random() - 0.5) * wobble, y + (random() - 0.5) * wobble])
  })
  const line = (points) => points.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(' L')
  return `<rect width="1080" height="1080" fill="${PAPER}"/>
    ${placed(CHARACTER_IN_CANVAS, kenta({ mouth: 'X', armL: null }, { ...LINE_ART, unfilled: ALL_FILLS }))}
    <path d="M${line(smooth)}" fill="none" stroke="#141218" stroke-width="${7 * CHARACTER_IN_CANVAS.scale}" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M${line(raw)}" fill="none" stroke="var(--primary)" stroke-width="1.6" stroke-linejoin="round" vector-effect="non-scaling-stroke" opacity="0.95"/>
    ${cursor('pencil', smooth.at(-1), unit)}`
}

/* 3. Fill: bucket fills closed areas, colours are shared */

function fillCanvas(unit) {
  const [x, y] = toScene(CHARACTER_IN_CANVAS, [-44, -200])
  return `<rect width="1080" height="1080" fill="${PAPER}"/>
    ${placed(CHARACTER_IN_CANVAS, kenta({ mouth: 'X' }, { ...LINE_ART, unfilled: ['hakama', 'hakamaShade'] }) + `<path d="${HAKAMA}" fill="${PALETTES.day.hakama}" opacity="0.55"/>`)}
    ${cursor('bucket', [x, y], unit)}`
}

/* 4. Frame by frame: each drawing is a short clip, onion skin shows its neighbours */

const SLASH_AT = { x: 1060, y: 1000, scale: 1 }
const SLASH_DRAWINGS = [
  [1, 4, { shoulder: 30, elbow: 20, sword: 60 }], [5, 4, { shoulder: 80, elbow: 40, sword: 60 }], [9, 2, { shoulder: 130, elbow: 30, sword: 40 }],
  [11, 2, { shoulder: 160, elbow: 20, sword: 32 }], [13, 2, { shoulder: 174, elbow: 18, sword: 30 }], [15, 1, { shoulder: 166, elbow: 14, sword: 24 }],
  [16, 1, { shoulder: 142, elbow: 8, sword: 14 }], [17, 1, { shoulder: 108, elbow: 0, sword: 4 }], [18, 1, { shoulder: 72, elbow: -6, sword: -8 }],
  [19, 1, { shoulder: 44, elbow: -10, sword: -14 }], [20, 2, { shoulder: 32, elbow: -12, sword: -16 }], [22, 2, { shoulder: 28, elbow: -12, sword: -17 }],
  [24, 4, { shoulder: 26, elbow: -10, sword: -16 }], [28, 9, { shoulder: 20, elbow: -6, sword: -12 }],
]

function slashPose(frame) {
  const [, , arm] = SLASH_DRAWINGS.find(([start]) => start === frame)
  return { armR: { ...arm, holding: true }, armL: { shoulder: -34, elbow: -36 }, brows: 'angry', mouth: 'D' }
}

function framesCanvas() {
  const skin = (frame, filter, opacity) => `<g filter="url(#${filter})" opacity="${opacity}">${placed(SLASH_AT, kenta(slashPose(frame)))}</g>`
  return `<defs>
      <filter id="onion-before"><feFlood flood-color="#e5484d"/><feComposite in2="SourceAlpha" operator="in"/></filter>
      <filter id="onion-after"><feFlood flood-color="#46c35a"/><feComposite in2="SourceAlpha" operator="in"/></filter>
    </defs>
    <rect width="1920" height="1080" fill="${PAPER}"/>
    ${skin(15, 'onion-before', 0.18)}${skin(16, 'onion-before', 0.35)}
    ${skin(19, 'onion-after', 0.18)}${skin(18, 'onion-after', 0.35)}
    ${placed(SLASH_AT, kenta(slashPose(17)))}`
}

function slashTracks() {
  const frame = (n) => (n - 1) / 12
  const armThumb = (arm) => svgOf('-560 -940 1120 630', kenta({ armR: { ...arm, holding: true }, brows: 'angry', mouth: 'D' }), STAGE)
  const arm = SLASH_DRAWINGS.map(([start, length, pose]) => ({
    start: frame(start),
    end: frame(start + length),
    kind: 'drawing',
    thumbs: [armThumb(pose)],
    isSelected: start === 17,
  }))
  return [
    {
      name: 'Mouth',
      clips: [
        { start: 0, end: 1, kind: 'animation', label: 'Mouth closed', thumbs: [mouthThumb('X')] },
        { start: 1, end: 2, kind: 'animation', label: 'Mouth shout', thumbs: [mouthThumb('D')] },
        { start: 2, end: 3, kind: 'animation', label: 'Mouth closed', thumbs: [mouthThumb('X')] },
      ],
    },
    { name: 'Head', clips: [{ start: 0, end: 3, kind: 'drawing', label: 'Head', keys: [0, 1, 1.5], thumbs: [svgOf(PART_CROPS.head, kenta({ brows: 'angry', mouth: 'none' }), PAPER)] }] },
    { name: 'Arm R', clips: arm },
    { name: 'Body', clips: [{ start: 0, end: 3, kind: 'drawing', label: 'Body', keys: [0, 1.17, 1.67], thumbs: [svgOf(PART_CROPS.body, kenta({}), PAPER)] }] },
    { name: 'Arm L', clips: [{ start: 0, end: 3, kind: 'drawing', label: 'Arm L', keys: [0, 1.17, 1.5], thumbs: [svgOf('20 -500 220 124', kenta({ armL: { shoulder: -34, elbow: -36 } }), PAPER)] }] },
    { name: 'Sound', clips: [{ start: frame(15), end: frame(23), kind: 'audio', label: 'swish.wav', seed: 11 }] },
  ]
}

/* 5. Mouths: separate little animations, dropped under the dialogue */

const CLOSE_UP = { x: 900, y: 1856, scale: 2.6 }

function mouthsCanvas(unit) {
  const [mx, my] = toScene(CLOSE_UP, [0, -526])
  const scale = CLOSE_UP.scale
  return `${background('dusk')}
    ${placed(CLOSE_UP, kenta({ mouth: 'none', brows: 'angry' }))}
    <g transform="translate(${mx} ${my}) scale(${scale})">${MOUTHS.C(PALETTES.day)}</g>
    ${selectionBox({ left: mx - 20 * scale, top: my - 12 * scale, right: mx + 20 * scale, bottom: my + 12 * scale }, unit)}`
}

function mouthTracks() {
  const mouth = (start, end, name, shape, extra = {}) => ({ start, end, kind: 'animation', label: name, thumbs: [mouthThumb(shape)], ...extra })
  return [
    {
      name: 'Mouth',
      clips: [
        mouth(0, 1.1, 'Mouth closed', 'X'),
        mouth(1.1, 2.3, 'Mouth talk', 'C', { isSelected: true }),
        mouth(2.3, 2.6, 'Closed', 'X'),
        mouth(2.6, 3.5, 'Mouth talk', 'C'),
        mouth(3.5, 4.4, 'Mouth shout', 'D', { isGhost: true }),
        mouth(4.4, 8.3, 'Mouth closed', 'X'),
      ],
    },
    { name: 'Kenta', clips: [{ start: 0, end: 8.3, kind: 'animation', label: 'Kenta idle', thumbEvery: { width: 61, at: () => kentaThumb({ mouth: 'none' }) } }] },
    { name: 'Background', clips: [{ start: 0, end: 8.3, kind: 'image', label: 'dusk-pass.svg', thumbs: [svgOf('0 0 1920 1080', background('dusk'))] }] },
    { name: 'Dialogue', clips: [{ start: 1.1, end: 4.4, kind: 'audio', label: 'kenta-line-03.wav', seed: 21, gaps: [[2.3, 2.6]] }] },
  ]
}

/* 6. Reuse: animations are files, imported into any episode */

const NIGHT_KENTA = { x: 180, y: 520, scale: 0.46 }
const NIGHT_ONI = { x: 1040, y: 420, scale: 0.52 }

function reuseCanvas(unit) {
  return `${background('night')}
    ${placed(within(NIGHT_KENTA, CHARACTER_IN_CANVAS), kenta({ ...WALK_POSE, brows: 'angry' }, { palette: 'day' }))}
    ${placed(within(NIGHT_ONI, { x: 540, y: 1040, scale: 1.3 }), oni())}
    ${selectionBox(clipBox(NIGHT_ONI, 1080), unit)}`
}

function macMenu() {
  return `<div class="mac-menubar"><b>Playback</b><span>File</span><span>Edit</span><span>View</span><span class="open">Media</span><span>Window</span></div>
    <div class="mac-menu" style="left:226px;top:26px">
      <div class="hot"><span class="tick"></span>New Animation<span class="keys">⇧⌘N</span></div>
      <div><span class="tick"></span>Import Media…<span class="keys">⌘I</span></div>
      <hr>
      <div><span class="tick">✓</span>Sort by Date Created</div>
      <div><span class="tick"></span>Sort by Name</div>
      <div><span class="tick"></span>Sort by Duration</div>
    </div>`
}

const VIEWS = {
  episode: { title: 'Episode', ...EPISODE_VIEW },
  draw: {
    title: 'Draw',
    left: () => mediaTab([...animationTiles(), ...MOUTH_NAMES.slice(0, 2).map(([name, shape]) => libraryTile(name, mouthThumb(shape), '<span>0:01</span>'))]),
    right: () => group('Pencil', 'pencil', field('Width (px)', '4') + field('Smoothing (%)', '70') + check('Pressure', true)) + colourGroup('Line'),
    tools: 'pencil',
    canvas: { size: [1080, 1080], view: { x: -60, y: 40, width: 1200 }, draw: drawCanvas },
    footer: () => footer({ time: '00:00:01:06', total: '00:00:06:00', isAnimation: true, zoom: '90%' }),
    timeline: () => idleTimeline(true, 'Arm L'),
    timelineHeight: 424,
  },
  fill: {
    title: 'Fill',
    left: () => mediaTab([...animationTiles(), ...MOUTH_NAMES.slice(0, 2).map(([name, shape]) => libraryTile(name, mouthThumb(shape), '<span>0:01</span>'))]),
    right: () => group('Fill', 'bucket', check('Close small gaps', true)) + colourGroup('Hakama'),
    tools: 'bucket',
    canvas: { size: [1080, 1080], view: { x: -60, y: 340, width: 1200 }, draw: fillCanvas },
    footer: () => footer({ time: '00:00:01:06', total: '00:00:06:00', isAnimation: true, zoom: '90%' }),
    timeline: () => idleTimeline(false, 'Legs'),
    timelineHeight: 424,
  },
  frames: {
    title: 'Frame by frame',
    left: () => mediaTab([...animationTiles(), ...MOUTH_NAMES.map(([name, shape]) => libraryTile(name, mouthThumb(shape), '<span>0:01</span>'))]),
    right: () =>
      transformGroup('0.0', '0.0', '100.0') +
      group('Timing', 'clock', pair(field('Start (frame)', '17'), field('Duration (frames)', '1'))) +
      group('Opacity', 'droplet', '', false) +
      group('Effects', 'wand', '', false),
    tools: 'pointer',
    canvas: { size: [1920, 1080], draw: framesCanvas },
    footer: () => footer({ time: '00:00:01:04', total: '00:00:03:00', isAnimation: true, isOnion: true }),
    timeline: () => timeline({ path: ['Episode 3', 'Kenta slash'], pixelsPerSecond: 470, seconds: 3.2, fps: 12, labelEvery: 0.5, tickEvery: 1 / 12, playhead: 16.5 / 12, tracks: slashTracks() }),
    timelineHeight: 424,
  },
  mouths: {
    title: 'Mouths',
    left: () => mediaTab(MOUTH_NAMES.map(([name, shape]) => libraryTile(name, mouthThumb(shape), '<span>0:01</span>', name === 'Mouth shout')), 'mouth'),
    right: () => transformGroup('900.0', '488.4', '100.0') + timingGroup('1.100', '1.200', true) + foldedGroups(),
    canvas: { size: [1920, 1080], draw: mouthsCanvas },
    footer: () => footer({ time: '00:00:01:24', total: '00:00:08:10' }),
    timeline: () =>
      timeline({
        pixelsPerSecond: 180,
        seconds: 8.3,
        fps: 30,
        labelEvery: 1,
        tickEvery: 0.5,
        playhead: 1.8,
        tracks: mouthTracks(),
        snapAt: 3.5,
        dragLabel: 'Mouth shout',
        dragAt: [3.5 * 180 + 70, 46 + 34],
      }),
    timelineHeight: 312,
  },
  reuse: {
    title: 'Reuse in another episode',
    menubar: macMenu,
    left: () =>
      mediaTab([
        ...animationTiles(),
        ...MOUTH_NAMES.map(([name, shape]) => libraryTile(name, mouthThumb(shape), '<span>0:01</span>')),
        libraryTile('night-pass.svg', svgOf('0 0 1920 1080', background('night')), '<span>Image</span>'),
      ]),
    right: () => transformGroup('1320.8', '700.8', '52.0') + timingGroup('6.000', '8.000', true) + foldedGroups(),
    canvas: { size: [1920, 1080], draw: reuseCanvas },
    footer: () => footer({ time: '00:00:07:02', total: '00:00:30:00' }),
    timeline: () =>
      timeline({
        path: undefined,
        pixelsPerSecond: 50,
        seconds: 30,
        fps: 30,
        labelEvery: 2,
        tickEvery: 0.5,
        playhead: 7.07,
        tracks: [
          { name: 'Titles', clips: [{ start: 0.5, end: 4, kind: 'annotation', label: 'Ronin Road, episode 4' }] },
          { name: 'Kenta', clips: [{ start: 2, end: 14, kind: 'animation', label: 'Kenta walk', thumbEvery: { width: 61, at: (i) => kentaThumb(i % 2 ? { mouth: 'X' } : WALK_POSE) } }] },
          { name: 'Oni', clips: [{ start: 6, end: 14, kind: 'animation', label: 'Oni laugh', isSelected: true, thumbEvery: { width: 61, at: () => svgOf('-400 -780 800 450', oni(), STAGE) } }] },
          { name: 'Background', clips: [{ start: 0, end: 30, kind: 'image', label: 'night-pass.svg', thumbs: [svgOf('0 0 1920 1080', background('night'))] }] },
          { name: 'Dialogue', clips: [{ start: 7, end: 10.5, kind: 'audio', label: 'oni-line-07.wav', seed: 13 }] },
          { name: 'Music', clips: [{ start: 0, end: 30, kind: 'audio', label: 'weekend.mp3', seed: 5, level: 0.45 }] },
        ],
      }),
    timelineHeight: 424,
  },
}

function shell(view) {
  const editor = `<div class="editor" style="--timelineHeight:${view.timelineHeight}px">
    <aside class="sidebar left">${view.left()}</aside>
    <div class="splitter leftWidth"></div>
    <section class="canvas-panel">
      <div class="canvas-row"><div class="canvas-area" id="canvas-area">${view.tools ? drawingTools(view.tools) : ''}</div></div>
      ${view.footer()}
    </section>
    <div class="splitter rightWidth"></div>
    <aside class="sidebar right">${view.right()}</aside>
    <div class="splitter timelineHeight"></div>
    <section class="timeline-panel">${view.timeline()}</section>
  </div>`
  return view.menubar ? `<div class="screen">${view.menubar()}${editor}</div>` : editor
}

function render() {
  const names = Object.keys(VIEWS)
  const name = new URLSearchParams(location.search).get('view') ?? names[0]
  const view = VIEWS[name] ?? VIEWS[names[0]]
  document.title = view.title
  document.getElementById('root').innerHTML = shell(view)
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
  document.addEventListener('keydown', (event) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    if (step === 0) return
    location.search = `?view=${names[(names.indexOf(name) + step + names.length) % names.length]}`
  })
}

render()
