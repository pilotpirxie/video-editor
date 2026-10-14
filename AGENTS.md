# Lightweight Non-Linear Video Editor

## 1. Product summary and principles

An internal, Camtasia-class video editor for **tutorial makers and marketers**. It offers a multi-track timeline, a WYSIWYG canvas, keyframed transforms, a Camtasia-style zoom-n-pan camera, annotations, blur, transitions and simple export. It runs offline on Apple silicon Macs, including machines with only 4 GB of memory.

**Principles (in priority order)**

1. **Simple, not over-engineered.** Build only what tutors and marketers use. Every feature should be explainable in one sentence. No plugin systems, no generic frameworks, no abstraction "for later".
2. **Perfect UI/UX.** Every drag responds within one display frame; the UI never waits on media work.
3. **What you see is what you export.** One compositor draws both the preview and the export.
4. **Never lose work, never crash.** Risky media work runs in separate processes; autosave is always on.
5. **Boring technology, few dependencies.** Electron, React, TypeScript, plain HTML/CSS, WebGL2, FFmpeg.
6. **Offline.** Nothing ever needs a network connection.

**Context:** internal tool, distributed to staff as a DMG. Licences and codec patents are not a constraint. English UI only.

**Platform:** macOS 15 or later, Apple silicon only. Low-end reference: M1 CPU with 4 GB of total memory.

**Out of scope:** screen and voice recording, subtitles, Windows and Intel Macs, App Store, auto-update, translations, right-to-left text, timeline markers, reverse and freeze-frame, device frames, stock assets, project templates, plugins, collaboration.

## 2. User stories

All 43 stories are v1 must-haves; each is done when its acceptance criteria pass on the §12 reference setup (M1, 4 GB memory).

| ID | As a user, I want to… | Accepted when | Spec |
| --- | --- | --- | --- |
| US-01 | use JPG, PNG, GIF and WebP images | All import; animated GIF/WebP play as moving clips; transparency kept | §6 |
| US-02 | use AVI, MP4, WebM, MOV, MKV, FLV and Apple formats | OBS, iPhone and downloaded files in the §6 matrix import and play, rotation included | §6 |
| US-03 | use MP3, OGG, WAV, FLAC and other audio | All §6 audio formats import, show waveforms and play in sync | §6 |
| US-04 | make anything from a 120p to a 4K video, from sources up to 8K | Canvas 160×120 to 3840×2160; 8K sources import and play | §6, §7 |
| US-05 | mix clips of all formats | Any mix of formats, sizes, frame rates and sample rates plays and exports in sync | §6 |
| US-06 | overlap clips | Higher tracks draw over lower; transparency shows what is beneath | §7 |
| US-07 | transform position, size, scale and rotation | Editable on canvas handles and in properties; rotation about the clip centre | §4 |
| US-08 | make a mosaic of several visuals | Grid presets arrange selected clips in one action | §5 |
| US-09 | export 480p | 480p preset gives 854×480 (640×480 for 4:3) | §9 |
| US-10 | speed clips up, including timelapses | Speed 0.25× to 100× per clip; linked audio stays in sync | §4, §8 |
| US-11 | set start offset and duration of every clip | Media: timeline start, source start offset, duration. Graphics: timeline start, duration | §4 |
| US-12 | play music and sounds at once | Any number of audio clips mix without clipping or drift | §8 |
| US-13 | fade smoothly between visual clips | Transitions drop between clips and resize by dragging | §7 |
| US-14 | fade clips in and out | Fade handles on clip corners for opacity and volume | §7 |
| US-15 | blur part of the video with a separate clip | A blur clip blurs everything beneath it inside its shape | §7 |
| US-16 | edit smoothly on a weak Mac | §12 targets met on M1 with 4 GB total memory | §12 |
| US-17 | never crash | Zero crashes in §12 tests; a media failure affects one clip only | §12 |
| US-18 | save and open projects | Save, Save As, Open, Open Recent, autosave; reopens identically; relink missing media | §5 |
| US-19 | undo and redo | Every edit undoable, one gesture = one step | §5 |
| US-20 | edit WYSIWYG on the canvas | Move, resize, rotate, crop, edit text directly on the preview | §3 |
| US-21 | snap clips, positions and sizes | Timeline, canvas position and size snapping as in §5 | §5 |
| US-22 | cut a clip perfectly | Split renders identically to the unsplit clip, frame- and sample-accurate | §5 |
| US-23 | work fully offline | Everything works with networking disabled | §1 |
| US-24 | a snappy editor | All §3 budgets met | §3 |
| US-25 | a pixel-perfect preview | Paused preview at 100% equals the exported frame | §7 |
| US-26 | give images and text a duration | Default 5 s, any length | §4 |
| US-27 | animate with keyframes | Transform, opacity, crop and volume keyframes with easing presets | §5 |
| US-28 | zoom and pan like Camtasia | A camera over the whole canvas, set by drawing a frame on the canvas | §5 |
| US-29 | browse media, effects, transitions and annotations | Four left-sidebar tabs; items drag onto canvas, timeline or clip | §3 |
| US-30 | add callouts, text, blurs, arrows and highlights | All in the Annotations tab, editable on canvas, with timing and fades | §4 |
| US-31 | apply effects | Drop on a clip; stack, reorder, toggle, remove | §7 |
| US-32 | put any clip on any track | No dedicated video or audio tracks | §4 |
| US-33 | use any installed font, with CJK and emoji | Font picker lists all system fonts; CJK and emoji render | §4 |
| US-34 | group clips | Grouped clips move, transform and animate as one | §5 |
| US-35 | use animation presets | Fade, pop, slide, zoom and typewriter apply in one click | §5 |
| US-36 | edit long projects | 20-hour timelines with up to 4,096 clips meet §12 targets | §12 |
| US-37 | export for social media | YouTube, vertical 9:16 and square presets | §9 |
| US-38 | export the current frame | PNG of the current frame at project size | §9 |
| US-39 | work on several projects | One project per window, several windows | §3 |
| US-40 | preview full screen | Full-screen preview with transport controls | §3 |
| US-41 | use Camtasia-like shortcuts | Camtasia defaults; rebindable | §3 |
| US-42 | start from examples | Sample projects offered on first launch | §3 |
| US-43 | use the editor without a mouse where it matters | Keyboard navigation, visible focus, VoiceOver labels on controls | §3 |

## 3. UX and UI

The window follows the layout Camtasia users know. A left sidebar holds media, effects, transitions and annotations; the canvas sits in the centre and properties on the right; a full-width, multi-track timeline runs along the bottom. The responsiveness budgets below are release blockers.

&#91;embedded content: main window layout · sidebar, canvas, properties, full-width timeline\]

**Panels**

- **Left sidebar**, four searchable tabs:
  - *Media*: files in the project with thumbnail, duration, type and preparation status; items used on the timeline are marked.
  - *Effects*: drop on a clip to apply.
  - *Transitions*: drop on a clip edge or the cut between two clips. Previews animate on hover.
  - *Annotations*: Callouts, Text, Blurs, Arrows, Highlights. Drop on the canvas or the timeline.
- **Canvas**: the WYSIWYG preview and the main place to change transforms. Handles for move, scale (Shift for free aspect), rotate and crop; double-click text to edit in place; the zoom-n-pan tool; a dotted motion path for keyframed clips. Zoom: fit, 50%, 100%, 200%.
- **Right sidebar**: properties of the selection: Transform, Timing and speed, Opacity and fades, Volume, Text style, Animation preset, Effects. Every animatable field has a keyframe toggle and previous/next keyframe buttons. With nothing selected it shows project settings.
- **Timeline**: full window width. A camera lane at the top holds zoom-n-pan keyframes; below it, unlimited tracks with any clip on any track. Track header: name, lock, hide, mute. Keyframes appear as diamonds on their clip.

**Interaction**

- Selection is shared between canvas, timeline and properties.
- Every drag updates the canvas live, not on release.
- Linked video and audio show as one clip (thumbnails above, waveform below), with "Separate video and audio" in the context menu.
- Clip badges show "preparing", "media missing" and "media error"; none of them blocks editing.
- Import, preparation and export run in the background; editing continues during export.
- Shortcuts follow Camtasia by default and can be rebound. Trackpad pinch zooms and two-finger swipe scrolls, on canvas and timeline.
- One project per window; several windows can be open. Full-screen preview with transport controls.
- Minimum window size 1280×720; panels resize and collapse; layout is remembered.
- First launch offers sample projects.

**Responsiveness budgets (M1, 4 GB memory)**

| Interaction | Budget |
| --- | --- |
| Response to dragging a clip, handle or trim edge | Next display frame (≤ 16 ms) |
| Canvas re-render while dragging a transform | ≤ 33 ms |
| Space to first moving frame | ≤ 100 ms |
| Scrub to a new position | ≤ 50 ms cached, ≤ 150 ms uncached |
| Undo or redo | ≤ 50 ms |
| Any single blocking task on the UI thread | ≤ 50 ms |
| Imported file visible with thumbnail | ≤ 1 s |
| Launch to editable project | ≤ 3 s |
| Open a 4,096-clip, 20-hour project | ≤ 3 s |

**Visual design**

Dark grey with a slight blue cast, white text, and one fresh (not neon) green accent reserved for primary actions, selection and active states. Dark theme only in v1; a light theme is a nice-to-have.

| Role | Hex | Used for |
| --- | --- | --- |
| Window background | #14171D | Behind panels; timeline |
| Panel background | #1B1F27 | Sidebars, toolbars |
| Raised surface | #252A34 | Inputs, cards, track headers, menus |
| Hover surface | #2E3440 | Hovered rows and buttons |
| Divider | #363D4A | Panel edges, separators |
| Text primary / secondary / disabled | #FFFFFF / #A7B0C0 / #687183 | Labels and values / hints / unavailable |
| Primary green (normal / hover / pressed) | #3DBA74 / #4BC882 / #33A064 | Primary buttons, selection, playhead, active tab, focus ring |
| Text on green | #0D1A13 | Labels on green buttons (white fails contrast there) |
| Snap guide | #E65FD3 | Snap lines, distinct from footage and accent |
| Danger / warning | #E5484D / #F2A93B | Errors, missing media / preparing |
| Clip bodies | Video #3C5A88, Audio #2C6C80, Image #5E4F8C, Annotation #8A6A3A, Blur #5B6474 | Muted, so green selection stands out |

Typography is the macOS system font at 11, 12, 13 and 15 pt, with tabular figures for timecodes and numbers. There is one in-house monochrome icon set, and colours are used only through named design tokens.

**Accessibility (kept simple):** all panels and dialogs reachable by keyboard, visible focus ring, VoiceOver labels on every control, AA contrast for all text, and reduced motion respected for UI animations. Timeline content itself does not need to be VoiceOver-navigable.

## 4. Timeline and clip model

A project is a canvas, a camera and a list of tracks. Each track holds clips placed freely, with gaps allowed, never overlapping on the same track. Higher tracks draw on top, and any clip type can go on any track.

**Canvas.** Size and frame rate are taken from the first clip added and can be changed at any time. Changing the size rescales all clips proportionally. Allowed range is 160×120 to 3840×2160 at 23.976, 24, 25, 29.97, 30, 50 or 60 fps.

**Timing fields**

| Field | Meaning | Applies to |
| --- | --- | --- |
| Timeline start | Where the clip begins on the timeline | All clips |
| Duration | How long it occupies the timeline | All clips |
| Source start offset | Where in the source file playback begins | Video, audio, animated images |
| Speed | 0.25× to 100×; source time used = duration × speed | Video, audio, animated images |
| Loop | Repeat the source when duration exceeds it | Animated images |

A media clip can never run past the end of its source; trimming stops there. Graphics have no source length, default to 5 s and can be any length.

**Time precision.** Times are stored as exact integer units, not floating-point seconds. Every supported frame rate and every audio sample lands exactly, with no drift across a 20-hour timeline.

**Clip types**

| Clip type | Transform | Opacity + fades | Volume + fades | Speed | Specific settings |
| --- | --- | --- | --- | --- | --- |
| Video (with linked audio) | yes | yes | yes | yes | Crop; separate video and audio |
| Audio | — | — | yes | yes | — |
| Image (still or animated) | yes | yes | — | animated only | Crop, loop |
| Text | yes | yes | — | — | Font (any installed), size, weight, colour, alignment, outline, shadow, background box, line spacing; auto-size or fixed box with wrapping; one style per clip |
| Callout | yes | yes | — | — | About 8 essential shapes (speech bubble, rounded box, arrow box, banner…), fill, border, text |
| Arrow or line | yes | yes | — | — | Two endpoints, thickness, colour, head style per end |
| Highlight | yes | yes | — | — | Highlight: translucent tint like a marker pen. Spotlight: dims everything outside its shape |
| Blur | yes | yes | — | — | Strength, rectangle or ellipse, soft edge; pixelate option |
| Group | yes | yes | yes | — | Contains other clips; edited by opening it |

**Transform** consists of position (clip centre in canvas pixels), width and height, scale relative to natural size, rotation about the centre, and aspect lock. Width, height and scale are two views of one stored value.

**Camera.** One per project. It holds keyframed view rectangles over the whole composition, annotations included, and drives zoom-n-pan (§5, §7).

**Keyframes** are available for transform, opacity, crop, volume and the camera. Each has an easing preset: linear, ease in, ease out, ease in-out or hold.

**Transitions** work as in Camtasia. They sit on a clip edge, or on the cut between two adjacent clips on the same track, and never change the timeline length. If a clip has no spare footage beyond the cut, its first or last frame is held for the transition.

## 5. Editing features

**Split (perfect cut)**

- Split at the playhead, snapped to a frame boundary. It applies to the selected clips, or to all clips under the playhead on unlocked tracks.
- The first part keeps its start and offset and ends at the cut. The second starts at the cut with offset = original offset + elapsed time × speed.
- Settings, effects and keyframes are copied (values at the cut preserved on both sides). Fade-in stays on the first part and fade-out moves to the second. Linked audio is split at the same instant.
- Acceptance: exporting before and after any split gives identical frames and audio samples.

**Move, trim, delete**

- Drag to move within or across tracks; drag edges to trim. Hold a modifier to ripple later clips. Gaps are allowed.
- Delete leaves a gap; ripple delete closes it. Copy, paste at the playhead, and duplicate are supported.

**Snapping** (on by default, toolbar toggle, Cmd held suspends it, 8 screen-pixel range)

- Timeline: clip edges snap to other clip edges, the playhead, keyframes and the timeline start.
- Canvas position: edges and centres snap to canvas edges and centre lines, and to other visible clips.
- Canvas size: snaps to other clips' width or height, to 100% of source size, and to canvas size. Rotation snaps every 15° with Shift.

**Groups**

- Group selected clips into one timeline item with its own transform, opacity, fades, keyframes and effects; ungroup restores the parts.
- Double-click opens a group to edit its contents in place.

**Layouts and mosaic:** align and distribute selected clips; grid presets 2×2, 3×3, 1 large + 3 small, and picture-in-picture corners, with adjustable gap and fit/fill.

**Keyframes**

- Toggling a property's keyframe button creates a keyframe at the playhead. After that, changing the property on canvas or in properties adds or updates a keyframe at the playhead.
- Diamonds on the clip can be selected, dragged (with snapping), copied, pasted and deleted. Right-click sets the easing preset.
- Keyframes belong to the clip and move with it. Position animates along straight lines.
- Volume keyframes appear as draggable points on the waveform's volume line.

**Animation presets:** fade, pop, slide (four directions), zoom, and typewriter (text only). Each applies as "in" or "out" with an adjustable duration, and can be converted to ordinary keyframes.

**Zoom-n-pan (Camtasia-style camera)**

- The camera views the whole composition, annotations included. With the zoom-n-pan tool, the user draws or drags a frame on the canvas at the playhead to create a camera keyframe that frames that area.
- Each step animates from the previous view over an adjustable duration (default 1 s, ease in-out). "Zoom to full" returns to the whole canvas.
- The frame keeps the canvas aspect ratio. The framed area moves in a straight line with even zoom speed: no wobble, no overshoot.
- Camera keyframes live on the camera lane at the top of the timeline and edit like any other keyframes.

**Undo and redo:** every project change is undoable, including keyframe and camera edits, with one gesture = one step and at least 500 steps. Viewing actions (zoom, scroll, playhead, panel sizes) are not undo steps.

**Save and open**

- A project is one JSON file with stable, sorted keys, so diffs stay readable. Media is referenced in place (as in Camtasia), stored both as an absolute path and relative to the project file.
- Save, Save As, Open, Open Recent.
- Saves are atomic: a crash mid-save never damages the previous file.
- Autosave writes a recovery file every 10 s when something changed; after a crash, the next launch offers to restore it.
- Missing media is badged on open; relinking one file also finds others in the same folder.
- A format version number lets newer builds open older projects.

## 6. Media and import

FFmpeg reads all video and audio; Chromium's image decoder reads images. Media stays where it is on local drives and is referenced, as in Camtasia.

| Category | Files | Codecs |
| --- | --- | --- |
| Still images | JPG, PNG, WebP, GIF | — |
| Animated images | GIF, WebP, APNG | — |
| Video | MP4, M4V, MOV, MKV, WebM, AVI, FLV, MPEG-TS/MTS, 3GP | H.264, HEVC, ProRes (incl. 4444 alpha), VP8, VP9, AV1, MPEG-4 Part 2, MJPEG, DNxHD/HR |
| Audio | MP3, M4A/AAC, ALAC, WAV, AIFF, FLAC, OGG Vorbis, Opus | as listed |

**Source handling rules**

- Sizes up to 8K are accepted. Rotation metadata, non-square pixels, standard colour spaces and alpha are honoured.
- High-frame-rate sources (120/240 fps) play at the project frame rate.
- HDR footage (iPhone HLG and Dolby Vision) is tone-mapped to standard range; there is no HDR output.
- Variable-frame-rate recordings (common from OBS and phones) are mapped to a constant rate once at import, and preview and export use that same mapping.
- Only local drives are supported. Cloud placeholders (iCloud files not yet downloaded) are refused with a clear message.

**Import flow**

1. Probe the file (under 1 s). Unsupported or corrupt files show a plain message and add nothing.
2. Show it in Media immediately with a poster frame; it can be used straight away.
3. Prepare in the background, nearest-to-playhead first: preview copy, audio, waveform and thumbnails. A badge shows progress.

**Preview copies.** For smooth scrubbing on weak machines, each video and animated image gets a preview copy in which every frame decodes on its own. Copies are 960 px on the long side by default, with alpha kept where present. Full-quality frames come from the originals when paused and during export.

**Caches.** One cache per project holds preview copies, audio, waveforms and thumbnails. The default limit is 10 GB with least-recently-used eviction. For long projects, caches are built around the playhead and recently visited areas, so a 20-hour project never needs cache space proportional to its length. Everything in the cache is regenerable and safe to delete.

## 7. Rendering and pixel-perfect preview

One GPU compositor (WebGL2) draws every frame of both preview and export. Only two things differ: the output size, and whether frames come from preview copies or originals.

**Compositing rules**

- Tracks are drawn bottom to top. For each active clip the order is: source frame, crop, effects, then scale, rotation about the centre and position, then opacity with fades, blended over what is beneath.
- The camera is applied last, conceptually, but each layer is drawn with the camera's zoom already applied. Zoomed text, annotations and video therefore stay sharp rather than being an enlarged picture. When paused, zoomed video uses detail from the original file.
- Blending uses premultiplied alpha in 8-bit standard-range colour. One resampling filter is used for every scale step.
- Sizes, positions, blur radii and text sizes are in canvas units, scaled to the output. A 120p and a 4K render look the same apart from detail.
- Text is laid out by Chromium's text engine (shaping, kerning, CJK, emoji, any installed font) and drawn at output scale. Annotations are vectors drawn at output scale.
- For time t, the compositor uses the source frame at or before the mapped source time. Preview and export apply the same rule. Fast speeds such as 50× simply skip source frames.

**Fades and transitions**

- Fades ramp opacity over the set duration.
- v1 transitions: cross-dissolve, fade through black, fade through white, wipe (4 directions), slide, push, zoom, circle reveal.

**Blur, pixelate, highlight and spotlight clips** apply to everything already drawn beneath them, inside their shape with a soft edge. Tracks above are unaffected.

**Effects (v1)**

| Effect | Settings |
| --- | --- |
| Colour adjust | Brightness, contrast, saturation |
| Black and white | Amount |
| Drop shadow | Offset, softness, colour, opacity (stays put when the clip rotates) |
| Border | Width, colour |
| Rounded corners | Radius |
| Clip blur | Strength (whole clip) |
| Chroma key | Key colour picked from canvas, tolerance, softness, spill removal |

Effects stack in order, can be reordered and switched off, and work on any visual clip.

**Pixel-perfect guarantee**

- **Paused:** the canvas frame is rendered from originals at the displayed size. At 100% zoom it is identical to the exported frame before compression.
- **Playing:** preview copies are used for speed. Geometry, timing, text, effects and colour are identical; only fine source detail may be softer.
- **Overlays** (handles, guides, motion paths) are drawn on a separate layer and never exported.
- **Check:** an automated test renders reference projects through both paths and requires identical frames.

## 8. Audio

One mixer produces the sound for both playback and export, so what you hear is what you export.

- **Many sounds at once:** any number of audio clips and linked video audio mix together. There is per-clip volume (0–200%) with fades and keyframes, and per-track mute. A master limiter prevents distortion.
- **Speed:** up to 4×, pitch is preserved (switchable). Above 4×, typical for timelapses, audio is muted by default; unmuting plays it sped up.
- **Sync:** audio is the playback clock; video follows and drops frames rather than drift. Export stays in sync within one frame over the full project length.
- **Accuracy:** splits, trims and fades are sample-accurate. Short automatic fades (5 ms) prevent clicks where a sound starts or stops abruptly, but never between the halves of a split.
- **Waveforms** draw from precomputed data, so zooming and scrolling never decode audio.
- Output goes to the system default device and follows headphone plug and unplug.

## 9. Export

Export is one dialog with presets and five options. It runs the same compositor and mixer as the preview, feeds an FFmpeg encoder, and runs one job at a time.

| Format | Video | Audio |
| --- | --- | --- |
| MP4 (default) | H.264 | AAC |
| WebM | VP9 | Opus |
| Animated GIF | 256-colour palette | — |
| Audio only | — | M4A, MP3 or WAV |
| Current frame | PNG at project size | — |

**Presets:** 120p, 240p, 360p, **480p**, 720p, 1080p, 1440p and 4K at the project aspect ratio (480p = 854×480, or 640×480 for 4:3), plus YouTube 1080p, Vertical 1080×1920 and Square 1080×1080.

**Options:** resolution, frame rate (project or lower), quality (Low / Medium / High), range (whole timeline or selection), audio on/off.

**Behaviour**

- Export works on a snapshot, so editing continues while it runs. Sources are always originals at full quality.
- The file is written to a temporary name and moved into place only when complete.
- Progress, elapsed time, time left and cancel are shown. Failures name the clip and time in plain words.
- Files play in QuickTime, Safari, Chrome and VLC, and upload to YouTube without warnings.

Per-track audio stems are not needed. Export to a target file size is a nice-to-have.

## 10. Technology stack

There are four runtime dependencies: Electron, React, React DOM and FFmpeg. Everything else is built in-house on platform features that ship inside Electron.

| Concern | Choice |
| --- | --- |
| App shell | Electron, pinned version, arm64 only |
| Language | TypeScript, strict |
| UI | React with plain HTML5 and CSS; no UI kit, CSS framework or state library |
| Timeline drawing | HTML5 canvas 2D |
| Compositor | WebGL2 (runs on Metal on macOS) |
| Text and fonts | Chromium text engine; font list read from the system |
| Images | Chromium image decoder |
| Video and audio decode/encode | FFmpeg and FFprobe as bundled command-line tools; full build, including x264 for the best H.264 quality; hardware decode via VideoToolbox |
| Audio output | Web Audio (output device only) |
| Project files | JSON on local disk |

**Why FFmpeg runs as separate processes:** a crash or hang there kills one helper, never the editor. No native compilation is needed, and upgrades are a binary swap. The cost is piping frames between processes, which is acceptable because playback reads preview copies.

**Dependency rule:** any new runtime dependency needs a one-paragraph justification and team agreement; the default answer is no. Dev tools are limited to the TypeScript compiler, one bundler, one Electron packager, one unit-test runner and one UI-test runner. All versions are pinned so builds are reproducible offline.

**Distribution:** a DMG with drag-to-Applications. The app must be signed to launch smoothly on macOS 15. With an Apple Developer ID it is signed and notarised; without one it is ad-hoc signed, and staff approve it once under System Settings, Privacy & Security. There is no auto-update; new versions are a new DMG.

## 11. Architecture

The UI changes the project only through commands; the render engine reads the project and draws; FFmpeg processes supply frames and samples. Preview and export are two consumers of the same engine.

&#91;embedded content: process architecture · 1 shared render path\]

- The render engine knows nothing about the UI or Electron, so export reuses it unchanged and it can be tested without a window.
- The UI thread never decodes, encodes, composites or touches the disk; it sends commands and receives results.
- The project model is the single source of truth; undo and autosave work by recording commands against it.
- The camera and keyframes are resolved inside the engine, so animation looks the same in preview and export.
- Keep it flat: no plugin layer, no generic effect graph. Effects and transitions are a fixed list in code.

## 12. Performance and reliability

Every target is measured on an M1 with 4 GB of total memory; a release ships only when all pass.

**Reference setup.** The CPU is an M1 (2020 MacBook Air: 8 cores, 7-core GPU). No Apple silicon Mac ships with less than 8 GB, so the 4 GB case is reproduced on an 8 GB M1 Air with 4 GB held by a memory-pressure tool. The Air has no fan, so sustained targets are measured after 10 minutes of continuous load.

| Requirement | Target |
| --- | --- |
| Playback: 1080p30, 4 video layers + 2 text + 1 blur, camera zooming | No dropped frames |
| Playback: 4K project | Smooth at preview resolution; paused full-quality frame ≤ 500 ms |
| 20-hour project with 4,096 clips | Opens ≤ 3 s; timeline scroll and zoom at 60 fps; seek ≤ 150 ms where prepared |
| Editor memory, all processes together | ≤ 700 MB typical; ≤ 1.5 GB peak, 4K export included; caches shrink first under memory pressure |
| Idle CPU while paused | ≤ 2% |
| Preview-copy preparation, 1080p H.264 | ≥ 8× real time |
| Export, 1080p30 MP4 | ≥ 2× real time; 4K ≥ 0.5× real time; 50× timelapse clips complete with progress shown |
| Installed size | ≤ 250 MB |

**Reliability**

- Each FFmpeg job is its own process. A failure is retried once, then the clip shows a "media error" badge and the session continues.
- Autosave (every 10 s) plus atomic saves mean any crash, power cut included, loses at most 10 seconds of work.
- If the UI or GPU process dies, the window comes back in the same state within 3 s.
- Caches have hard limits; every FFmpeg job has a timeout, so nothing can hang the editor.
- A set of broken and truncated media files is imported in automated tests; none may crash or hang the app.
- An automated 8-hour session of random edits, playback, undo, save and export must end with zero crashes and flat memory.
- Crash logs are written locally only.

## 13. Risks, spikes and decisions

Six risks get a spike in the first two weeks, before the editor is built on top of the engine.

| Risk | Mitigation | Spike passes when |
| --- | --- | --- |
| 4 GB total memory is too tight | Hard cache caps; shrink on memory pressure; lower preview resolution as fallback | 4K-source project plays and exports with editor ≤ 1.5 GB and no swap stutter |
| Preview copies too slow or too big for 20-hour projects | Prepare around the playhead; 10 GB cache with eviction; tunable preview size | 1 hour of 1080p prepared in ≤ 8 min; cache stays ≤ 10 GB on a 20-hour project |
| Preview and export pixels diverge | Single compositor; parity test from week 1 | Identical frames for 10 reference projects, camera zoom included |
| Camera zoom looks soft or stutters | Layers drawn with the zoom applied; originals when paused | 300% zoom on 4K screen recording is sharp when paused and smooth when playing |
| 4K and 50× export too slow | Compact pixel formats on the pipe; hardware decode; skip unused frames where possible | 1 min of 4K exports in ≤ 2 min; a 10-min source at 50× completes in ≤ 5 min |
| Variable-frame-rate OBS and phone recordings drift | Map to constant rate at import | 3 real recordings stay in sync within 1 frame at the end |

**Decisions log**

- Apple silicon only, macOS 15 or later; M1 with 4 GB of memory is the floor.
- Internal tool distributed as a DMG; licences are not a constraint; no App Store, no auto-update, local crash logs only.
- Zoom-n-pan is a whole-canvas camera, as in Camtasia.
- No screen or voice recording and no subtitles.
- Free clip placement with gaps; any clip on any track; groups supported.
- Speed range 0.25× to 100×; audio is muted by default above 4×.
- Media is referenced in place on local drives; there is no packaging.
- HDR is tone-mapped to standard range; there is no HDR export.
- System fonts only. A missing font is substituted, with a warning, and its name is kept for Macs that have it.
- Dark theme only in v1; shortcuts are Camtasia-like and customisable.

14. Tickets
101 tickets in six groups, in build order. Each line is the title, then its definition of done. After group 2 the app is usable end to end.
1. Core rendering engine (a video can be made from a hand-written project file)
• T-01 App skeleton and build — Electron + React + TypeScript app builds to an arm64 DMG with one command and launches offline on a clean macOS 15 M1.
• T-02 Bundle FFmpeg and FFprobe — binaries ship inside the app and run offline; versions shown in About.
• T-03 FFmpeg job runner — jobs start, stream, cancel and time out; killing FFmpeg mid-job never crashes or freezes the app.
• T-04 Test media set — sample files for every §6 format plus OBS variable frame rate, iPhone HEVC/HDR, 8K, 120 fps, alpha, animated GIF/WebP and broken files, used by automated tests.
• T-05 Project file format — JSON with sorted, stable keys; load then save is byte-identical; version number; malformed files rejected with a readable message.
• T-06 Exact time units — integer times; frame and sample conversions exact at all §4 frame rates; no drift over 20 hours.
• T-07 Media probe — size, rotation, frame rate, duration, colour, alpha and audio layout for every test file in under 1 s; corrupt files rejected cleanly.
• T-08 Full-quality frame decoding — correct frame for any source time at a requested size, rotation and colour applied; matches reference images.
• T-09 Preview copies — 960 px copies where every frame decodes on its own, alpha kept; 1080p H.264 prepared at 8× real time or faster on M1.
• T-10 Audio decoding — any audio delivered as 48 kHz stereo for a requested time window, sample-accurate.
• T-11 Waveform data — built in the background at import; a 20-hour file needs at most 20 MB.
• T-12 Timeline resolver — for any time returns active clips with offset, speed, fades and keyframes evaluated; unit tests cover edges, 0.25×–100× and all easings.
• T-13 Compositor layers and transforms — position, size, scale, rotation, opacity, crop and alpha drawn bottom to top; golden-image tests pass at 120p, 1080p and 4K.
• T-14 One resampling filter — all scaling uses one filter; downscaled preview equals downscaled export.
• T-15 Basic text rendering — any system font, size, colour, alignment, CJK and emoji, sharp at any output scale.
• T-16 Audio mixer — any number of clips with volume, fades and master limiter; playback and export produce identical samples.
• T-17 Playback clock — play, pause, seek with audio as master; video drops frames rather than drift; in sync within 1 frame after 60 minutes.
• T-18 Dev harness window — loads a project JSON, plays, scrubs and shows timecode; 1080p30 with 4 layers plays without drops on M1.
• T-19 Paused full-quality frame — when paused, frame re-rendered from originals within 500 ms and equal to the export frame at 100%.
• T-20 MP4 export — H.264/AAC at any §9 preset; plays in QuickTime, Safari, Chrome and VLC; cancel works; file appears only when complete.
• T-21 Preview/export parity test — 10 reference projects render identically through both paths; runs on every commit.
• T-22 Memory limits — hard caps on caches, decoders and export buffers; a 4K project plays and exports on the 4 GB M1 setup with the editor at 1.5 GB or less.
2. Basic editor (usable end to end)
• T-23 Window layout — top bar, left sidebar, canvas, right sidebar, full-width timeline; panels resize and collapse; minimum 1280×720; layout remembered.
• T-24 Design tokens and base controls — §3 palette and type; in-house buttons, inputs, scrubbable number fields, tabs, menus, tooltips; no raw colours; AA contrast.
• T-25 Commands and undo/redo — every edit is a command; at least 500 steps; one gesture = one step; menu names the action; undo within 50 ms.
• T-26 New, open, save — Save, Save As, Open, unsaved-changes prompt, atomic writes; a saved project reopens identically.
• T-27 Autosave and recovery — recovery file every 10 s when changed; after a forced kill, relaunch restores with at most 10 s lost.
• T-28 Import and Media tab — button or drag-drop; item with poster frame within 1 s; type and progress badges; unsupported files rejected with a message.
• T-29 Timeline view — canvas-drawn ruler, tracks, clips with thumbnails and waveforms, playhead; zoom from whole project to single frames at 60 fps with 4,096 clips; trackpad pinch and swipe.
• T-30 Tracks — add, delete, reorder, rename, lock, hide, mute; any clip on any track.
• T-31 Place clips — drag from Media to timeline or canvas; drop on occupied space creates a track; first clip sets canvas size and frame rate.
• T-32 Move and trim — move within and across tracks with gaps; trim limited by source length; ripple with a modifier; canvas updates live.
• T-33 Split at playhead — perfect cut per §5; export identical before and after a split.
• T-34 Delete, ripple delete, copy, paste, duplicate — work on multi-selection and are undoable.
• T-35 Selection — click, Shift/Cmd multi-select, timeline marquee; selection shared by canvas, timeline and properties.
• T-36 Timeline snapping — snap to clips, playhead, keyframes and start with a guide line; Cmd suspends; toolbar toggle.
• T-37 Canvas handles — select topmost clip; move, scale (Shift free), rotate (Shift 15°), crop; hit-testing matches the render; within §3 budgets.
• T-38 Canvas snapping — position snaps to canvas edges, centre and other clips; size snaps to other clips and 100%; snap-colour guides.
• T-39 Properties panel — Transform, Timing (start, offset, duration, speed), Opacity, Volume, Fades; instant edits; shared fields for multi-selection; project settings when nothing selected.
• T-40 Clip fades — corner handles for opacity and volume fades; preview matches export.
• T-41 Linked video and audio — one block with thumbnails and waveform; "Separate video and audio" makes two clips.
• T-42 Text clips — add, edit in place, installed-font picker, size, colour, alignment, auto-size box.
• T-43 Images and durations — stills and text default to 5 s and stretch to any length; animated GIF/WebP play with a loop option.
• T-44 Transport and shortcuts — play/pause, frame step, J/K/L, timecode; Camtasia-like default keys.
• T-45 Export dialog — MP4 presets incl. 480p and social sizes; resolution, fps, quality, range, audio; progress, time left, cancel; editing continues.
• T-46 Missing media and relink — missing files badged on open; relinking one finds others in the same folder.
• T-47 End-to-end acceptance — a new user builds and exports a 10-minute tutorial (recording, voice, music, title, image) on the 4 GB M1 setup with no crash and no help.
3. Advanced rendering
• T-48 Camera rendering — whole-canvas camera from keyframed view rectangles; layers drawn with zoom applied so text and annotations stay sharp; paused zoomed video uses original detail.
• T-49 Easing and zoom motion — linear, ease in, ease out, ease in-out, hold; camera moves the framed area in a straight line at even zoom speed.
• T-50 Transitions — cross-dissolve, fade through black and white, 4 wipes, slide, push, zoom, circle reveal; first or last frame held when no spare footage; golden tests pass.
• T-51 Blur and pixelate clips — blur everything beneath inside a rectangle or ellipse with soft edge; correct at 120p and 4K.
• T-52 Highlight and spotlight — highlight tints like a marker pen; spotlight dims outside the shape; golden tests pass.
• T-53 Effects — colour adjust, black and white, drop shadow, border, rounded corners, clip blur, chroma key; stackable and toggleable; golden tests pass.
• T-54 Callouts and arrows — about 8 callout shapes plus arrows and lines with head styles, drawn as vectors and sharp at 4K.
• T-55 Text styling — weight, outline, shadow, background box, line spacing, fixed box with wrapping; preview equals export.
• T-56 Animation presets — fade, pop, slide (4 directions), zoom, typewriter as in/out presets with duration; convertible to keyframes.
• T-57 Group rendering — group transform, opacity, fades, effects and keyframes apply to all members; nested animation composes correctly.
• T-58 Audio speed — pitch preserved up to 4×; above 4× muted by default with optional sped-up audio; playback equals export.
• T-59 Volume keyframes in the mixer — volume follows keyframes sample-accurately.
• T-60 Difficult sources — HDR tone-mapping, 8K input, 120/240 fps, variable frame rate and rotation all pass on the test set.
• T-61 Long-project caches — preview copies and audio built around the playhead within a 10 GB limit; a 20-hour project seeks anywhere and stays within it.
• T-62 More export formats — WebM (VP9/Opus), animated GIF, M4A/MP3/WAV audio only, PNG of the current frame.
• T-63 Export performance — 1080p at 2× and 4K at 0.5× real time or faster on M1; 50× timelapse clips export with progress; editor stays at 1.5 GB or less.
4. Advanced editor
• T-64 Effects, Transitions and Annotations tabs — searchable lists with hover previews; dragging onto a clip, edge, cut or canvas applies the item.
• T-65 Keyframe controls in properties — keyframe toggle and previous/next on every animatable field; changing a value at the playhead adds or updates a keyframe.
• T-66 Keyframes on the timeline — diamonds on clips, expandable per property; select, multi-select, drag with snapping, copy, paste, delete; easing from context menu.
• T-67 Zoom-n-pan tool and camera lane — draw a frame on canvas to add a camera keyframe; adjustable duration; "Zoom to full"; camera lane on top of the timeline; undoable.
• T-68 Motion path on canvas — dotted path with keyframe dots; dragging a dot moves that keyframe's position.
• T-69 Transition editing — drop on edges or cuts, drag to change duration, change type in properties.
• T-70 Effect stack editing — reorder, toggle, remove, edit settings; chroma key colour picked from canvas.
• T-71 Annotation editing — arrow endpoints, callout tails and blur/highlight shapes editable on canvas; styles in properties.
• T-72 Full text editing — all styling controls, fixed-box mode, font picker with live previews; missing-font warning with substitution.
• T-73 Groups — group, ungroup, double-click to edit inside; a group acts as one clip on timeline and canvas.
• T-74 Layout tools — align, distribute, grid presets 2×2, 3×3, 1+3 and picture-in-picture corners with gap and fit/fill.
• T-75 Animation preset controls — apply in/out presets with duration from properties; "Convert to keyframes".
• T-76 Volume line editing — draggable volume line with keyframes on waveforms.
• T-77 Canvas zoom and full-screen preview — fit, 50, 100, 200% and pinch; full-screen preview with transport.
• T-78 Multiple windows — one project per window, several open; the same media is safe in several projects.
• T-79 Change canvas size — resizing the canvas rescales all clips proportionally; undoable.
• T-80 Package project — permanently skipped (2026-10-14): not needed; media stays referenced in place.
• T-81 Custom shortcuts — Camtasia defaults, rebindable in Settings, conflicts flagged.
5. Polish
• T-82 Responsiveness audit — every §3 budget measured on the 4 GB M1 setup and every failure fixed; no UI task over 50 ms.
• T-83 Memory audit — a 20-hour, 4,096-clip project and a 4K export stay within §12 memory targets with no swap stutter.
• T-84 Visual polish pass — every screen follows tokens, spacing and icons; hover, pressed, focus and disabled states complete; product owner signs off.
• T-85 Empty, loading and error states — designed empty state for every panel; all badges and errors plain and actionable.
• T-86 Accessibility basics — keyboard reach to all panels and dialogs, visible focus, VoiceOver labels, AA contrast, reduced motion; checked with VoiceOver.
• T-87 Sample projects and first run — two or three bundled samples (tutorial, marketing promo) offered on first launch.
• T-88 Stability testing — 8-hour automated session and broken-media set pass with zero crashes; failures write a local crash log.
• T-89 Extremes test — 120p and 4K projects, 8K sources, 100× speed, 4,096 clips and a 20-hour timeline all meet §12.
• T-90 Release DMG — drag-to-Applications DMG, app icon, About with versions; installs and runs offline on a clean macOS 15 M1.
• T-91 Offline help — shortcut sheet and short help pages inside the app.
6. Nice-to-haves
• T-92 Light theme — full light palette switchable in Settings; AA contrast throughout.
• T-93 Export to target file size — output lands within 5% of the size entered.
• T-94 Second-display preview — full-screen canvas on a second display while editing on the first.
• T-95 Curved motion paths and custom easing — bezier path handles and easing curve editor; preview equals export.
• T-96 Keyframes for effect settings — effect values and blur strength animatable from properties.
• T-97 Export queue — several exports queued and run one after another.
• T-98 Audio clean-up — loudness normalisation, noise reduction, music ducking under voice.
• T-99 Timeline markers — add and name markers; clips snap to them.
• T-100 HEVC and ProRes export — extra export formats including transparent ProRes 4444.
• T-101 HEIC photo import — iPhone photos import directly.