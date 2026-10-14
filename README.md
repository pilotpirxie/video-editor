# video-editor

Lightweight non-linear video editor for macOS on Apple silicon. The specification and ticket
list are in [AGENTS.md](AGENTS.md). What exists so far is ticket group 1, the core rendering
engine, and group 2, the basic editor: the window with its layout, undo, project files,
autosave, media import and relink, the timeline with linked clips and fade handles, canvas
handles, text clips, animated images, the properties panel, the transport with Camtasia-like
keys, and the export dialog. From group 3 there are the camera zoom (T-48, T-49), transitions
(T-50), blur and pixelate clips (T-51), highlight and spotlight clips (T-52) and effects
(T-53), each with the controls to add and change it: the zoom tool and the camera lane, the
Effects and Transitions tabs, and the Annotations tab. Also from group 3 are
callouts, arrows and lines (T-54), text styling (T-55), animation presets (T-56), groups
(T-57), sound that follows the speed of its clip (T-58) and volume keyframes (T-59), again
with their controls: the Annotations tab, handles for an arrow's ends and a bubble's tail,
the text and animation fields in Properties, groups that open on a double click, and volume
points on the waveform. From group 4 there are keyframe buttons on every animatable field in
Properties (T-65), the motion path of a keyframed clip on the canvas with dots that drag its
position keyframes (T-68), and a right-click menu on the zooms of the camera lane (T-67). X and
Y, the width, height and scale, and the four crop sides are each keyed as one. The four tabs of
the library look alike, as tiles by default, with a still picture for each effect, transition and
annotation; all of them are dragged onto the canvas or the timeline, several media files at once
when picked with Cmd or Shift. Panels are shown and hidden from the View menu, Export sits at the
right of the timeline toolbar, and projects and exports can run at 120 and 160 fps. The end-to-end
run of T-47 with a new user on the 4 GB reference Mac is still to be done by hand.

To see the new features at once, open `test/projects/demo-zoom-effects.json` with File, Open.

## Commands

Needs Node 24 and macOS on Apple silicon. The first build downloads the pinned FFmpeg and
FFprobe binaries into `vendor/ffmpeg` and checks their SHA-256.

| Command | What it does |
| --- | --- |
| `npm ci` | Installs the pinned dependencies |
| `npm start` | Builds and opens the editor |
| `npm run typecheck` | Strict TypeScript check of everything |
| `npm run lint` | Unused files, exports and dependencies (knip) and duplicated code (jscpd); any finding fails |
| `npm run test:unit` | Unit tests (time, project format, resolver, mixer, FFmpeg jobs, probe, decoding, caches, editing commands) |
| `npm run test:engine` | Builds the app and tests it for real: golden images, preview/export parity, export to every format, export speed and memory, the harness window, split and hit-test parity, and pixels worked out by hand for the camera zoom, every transition, blur, pixelate, highlight, spotlight, each effect, callouts, arrows, styled text and groups |
| `npm run test:editor` | Builds the app and drives the editor window with real mouse and keyboard input: layout, editing, canvas, tracks, documents, crash recovery, transport keys, fades, text, animated images, relink, the export dialog and how it holds the window, arranging by dragging (landing outline, group moves across tracks, crop fields), annotations, callouts and arrows, text styling, animation presets, groups (made, edited from the inside, taken apart), volume keyframes and the sound of fast clips, keyframes from Properties and the motion path, effects, transitions and zoom-and-pan (added, changed and removed by mouse, in Properties and from the lane's menu), the controls (drop-down lists, groups, media tiles, wide sidebars, timeline zoom-out), and the responsiveness budgets on a 4,096-clip project |
| `npm test` | All of the above |
| `npm run test:acceptance` | Builds a ten-minute tutorial through the editor window and exports it at 1080p; takes several minutes and is not part of `npm test` |
| `npm run dist` | Builds `release/Video Editor-<version>-arm64.dmg` |

`UPDATE_GOLDEN=1 npm run test:engine` rewrites the golden images in `test/golden`.

## Running the app from the command line

```
npx electron . --project test/projects/demo-four-layers.json
npx electron . --export project.json --out video.mp4 --preset 1080p
npx electron . --export project.json --out frame.png --at 120
npx electron . --frames project.json --at 0,30,60 --via paused --out frames/
npx electron . --selftest project.json --seconds 10 --report-memory
```

- `--export` renders the whole timeline in the format the extension of `--out` names: `.mp4`
  (H.264/AAC), `.webm` (VP9/Opus), `.gif`, `.m4a`, `.mp3` or `.wav` (sound alone), or `.png`
  (the frame `--at <number>`, at the size of the project). Presets: `120p`, `240p`, `360p`,
  `480p`, `720p`, `1080p`, `1440p`, `4k`, `youtube-1080p`, `vertical-1080x1920`, `square-1080`.
  `--encoder hardware` encodes an MP4 with the Mac's media engine instead of x264.
- `--frames` writes single frames as raw RGBA. `--via paused` reads the originals by seeking,
  as the paused preview does; `--via export` reads them in order, as an export does.
- `--selftest` opens the dev harness, plays, pauses, scrubs and zooms through its own buttons
  and prints what the window showed. The window opens muted and without taking focus.
- `--uitest <scenario>` opens the editor and runs one of the scenarios in `src/main/uiTest.ts`
  and `src/main/uiScenarios.ts`, with `--media <folder>` for files to import and `--out <folder>`
  for saved projects and a picture of the window as the scenario left it. It needs
  `--user-data-dir=<empty folder>`: a UI test restores recovery files without asking, so it
  refuses to run on the profile that holds your own work.

## Keys

Shortcuts follow Camtasia for Mac. Those that are a single key work whenever no text field has
the focus; `src/editor/shortcuts.ts` is the table.

| Keys | What they do |
| --- | --- |
| Space | Play or pause |
| `,` `.` or ← → | One frame back or forward |
| Ctrl+Shift+`,` `.` | Fifteen frames back or forward |
| Ctrl+`,` `.` | Previous or next clip edge |
| Cmd+Return, Cmd+Shift+Return | Start or end of the timeline |
| J, K, L | Backwards, stop, forwards; J or L again doubles the speed, up to 8× (only normal forward speed has sound) |
| Cmd+Shift+`=` `-` `0` | Timeline zoom in, out, fit |
| Cmd+T, Cmd+Shift+T | Split the selected clips, or every clip under the playhead |
| Delete, Cmd+Delete | Delete, ripple delete |
| Cmd+G, Cmd+U | Group the selected clips, ungroup the selected group |
| Esc | Let go of the selection; with nothing selected, leave the open group |
| Cmd+E, Cmd+I | Export, import media |

## Project files

A project is one JSON file: a canvas, a media list and tracks of clips, bottom track first.
Times are whole ticks of 1/24,000,000 s; positions on the timeline are multiples of 100 ticks.
`test/projects` holds the reference projects; `src/shared/project.ts` is the format.

Besides video, audio, image and text clips there are `blur` clips (blur or pixelate what is
beneath, inside a rectangle or ellipse) and `highlight` clips (tint what is beneath like a
marker pen, or as a spotlight dim everything outside the shape). A clip with a picture can
carry `effects`, applied first to last; any visual clip can carry `transitionIn` and
`transitionOut`, and the one at the start of a clip that touches the clip before it is the
transition on their cut. `camera` at the top level lists the zooms: each is the view reached at
its time after a move of its `duration`. Lengths in all of these are canvas pixels.

A `callout` clip is a filled shape with words in it (`shape`, `width`, `height`, `fill`,
`borderColor`, `borderWidth`, and for the two bubbles a `tail` tip measured from the middle of
the box). An `arrow` clip is a line of `length` and `thickness` through the middle of the
clip, with a `startHead` and an `endHead`; a line is an arrow without heads. Text and callouts
take `font.weight`, `lineSpacing`, `outline` and `shadow`; a text clip also takes `background`
and `boxWidth`, the width its words wrap at. Any visual clip can carry `animationIn` and
`animationOut`, a preset with a `duration`. A `group` clip holds `tracks` of its own, in a time
of its own that it shows from `contentStart` on, with its members placed around the middle of
the group. On a video or audio clip `changesPitch` lets the pitch follow the speed, and
`hasFastSound` gives a clip faster than 400 % its sound; `keyframes.volume` holds the volume
keyframes. All of these keys are optional, and the format version is still 1.

## Where things are

| Folder | What lives there |
| --- | --- |
| `src/shared` | Project format, time units and the message types between processes |
| `src/engine` | Resolver, compositor, mixer and exporter; knows nothing about the UI |
| `src/editor` | Editing commands, snapping and geometry as pure functions on a project |
| `src/renderer` | The editor window (React), the timeline canvas and the dev harness |
| `src/media` | The media process: probing, decoding, preview copies, saving project files |
| `src/main` | Electron main process: windows, menu, dialogs, recovery, test drivers |

Preview copies, sound and waveforms are kept in `cache/v2` in the app's data folder. Preview
copies and sound are cut into 30-second segments, built outward from the playhead; all windows
share one 10 GB limit, and the segments used longest ago are removed first. Everything there
can be deleted and is made again when needed.

## Test media

`npm test` generates its own media into `test/media/generated` (every supported container and
codec, alpha, 8K, 120 and 240 fps, variable frame rate, HLG and PQ, twenty hours of sound, ten
minutes of 1080p for a 50× export, broken files). Real recordings dropped into
`samples/` are used by the demo project and the benchmarks, which are skipped without them.
Recordings that cannot be synthesised (OBS captures, iPhone HDR clips) are probed and decoded
by the tests when they are placed in `test/media/real`.
