# video-editor

Lightweight non-linear video editor for macOS on Apple silicon. The specification and ticket
list are in [AGENTS.md](AGENTS.md). What exists so far is ticket group 1, the core rendering
engine, and tickets T-23 to T-39 of group 2: the editor window with its layout, undo, project
files, autosave, media import, timeline, canvas handles and properties panel. Export from the
editor window (T-45) is not there yet; `--export` renders a saved project.

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
| `npm run test:engine` | Builds the app and tests it for real: golden images, preview/export parity, MP4 export, the harness window, split and hit-test parity |
| `npm run test:editor` | Builds the app and drives the editor window with real mouse and keyboard input: layout, editing, canvas, tracks, documents, crash recovery, and the responsiveness budgets on a 4,096-clip project |
| `npm test` | All of the above |
| `npm run dist` | Builds `release/Video Editor-<version>-arm64.dmg` |

`UPDATE_GOLDEN=1 npm run test:engine` rewrites the golden images in `test/golden`.

## Running the app from the command line

```
npx electron . --project test/projects/demo-four-layers.json
npx electron . --export project.json --out video.mp4 --preset 1080p
npx electron . --frames project.json --at 0,30,60 --via paused --out frames/
npx electron . --selftest project.json --seconds 10 --report-memory
```

- `--export` renders the whole timeline to H.264/AAC. Presets: `120p`, `240p`, `360p`, `480p`,
  `720p`, `1080p`, `1440p`, `4k`, `youtube-1080p`, `vertical-1080x1920`, `square-1080`.
- `--frames` writes single frames as raw RGBA. `--via paused` reads the originals by seeking,
  as the paused preview does; `--via export` reads them in order, as an export does.
- `--selftest` opens the dev harness, plays, pauses, scrubs and zooms through its own buttons
  and prints what the window showed. The window opens muted and without taking focus.
- `--uitest <scenario>` opens the editor and runs one of the scenarios in `src/main/uiTest.ts`,
  with `--media <folder>` for files to import and `--out <folder>` for saved projects and a
  picture of the window as the scenario left it.

## Project files

A project is one JSON file: a canvas, a media list and tracks of clips, bottom track first.
Times are whole ticks of 1/24,000,000 s; positions on the timeline are multiples of 100 ticks.
`test/projects` holds the reference projects; `src/shared/project.ts` is the format.

## Where things are

| Folder | What lives there |
| --- | --- |
| `src/shared` | Project format, time units and the message types between processes |
| `src/engine` | Resolver, compositor, mixer and exporter; knows nothing about the UI |
| `src/editor` | Editing commands, snapping and geometry as pure functions on a project |
| `src/renderer` | The editor window (React), the timeline canvas and the dev harness |
| `src/media` | The media process: probing, decoding, preview copies, saving project files |
| `src/main` | Electron main process: windows, menu, dialogs, recovery, test drivers |

## Test media

`npm test` generates its own media into `test/media/generated` (every supported container and
codec, alpha, 8K, 120 fps, variable frame rate, broken files). Real recordings dropped into
`samples/` are used by the demo project and the benchmarks, which are skipped without them.
Recordings that cannot be synthesised (OBS captures, iPhone HDR clips) are probed and decoded
by the tests when they are placed in `test/media/real`.
