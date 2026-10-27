# Animations in Playback

## 1. Summary and principles

Playback gets an animation workspace for Samurai Jack–style cartoons. It is to Flash and Spine what Playback is to Premiere: the same basic model with most of the concepts removed. An animation is a file, like a video. It sits in Media, goes on the timeline as a clip and opens in place with the same timeline, canvas and Properties. Inside it you draw Affinity-style vector shapes and animate them by moving their nodes.

**Principles (in priority order)**

1. **Simple, fast, lean.** Every concept fits in one sentence. Nothing from Flash, Spine or Affinity comes in unless a cartoon needs it.
2. **One editor.** Inside an animation, the timeline, canvas, Properties, keyframes, snapping, undo and shortcuts are the ones Playback already has. New UI appears only where drawing needs it.
3. **What you see is what you export.** The engine draws the drawings. The parity tests (paused against export) and the output tests (screen against export) prove it.
4. **Never lose work.** Animation files save atomically, autosave and recover like projects.
5. **No new dependencies.**

**Out of scope:**
- bones, IK, meshes, weights and skins
- symbol types and scripting
- classic versus motion tweens
- merge drawing (overlapping shapes cutting each other)
- guide and mask layers
- automatic lip sync, or any AI
- X-sheet, node view and curve editor
- game runtime export
- palettes and line-style presets
- per-copy colour overrides

## 2. Model

Episode › Animation › Track › Drawing › Shape › Node set. The word "layer" is not used in the UI.

| Thing | What it is | Closest thing elsewhere |
| --- | --- | --- |
| Episode | A Playback project (`.pbproj`) | Flash document |
| Animation | A `.pbanim` file: the project JSON format without a camera. Its canvas is the artboard size and frame rate. It is placed as a clip | Flash symbol, Moho action, After Effects precomp |
| Track | A timeline row, top drawn in front. It expands to show the shapes of its drawing | Flash layer |
| Drawing | A clip on a track that holds shapes. Frame by frame is a row of drawing clips | Flash keyframe |
| Shape | One bezier outline, open or closed, with a fill, a stroke and the shapes clipped inside it | Affinity curve |
| Node set | Named nodes of one shape that move together around a pivot, with keyed rotation and offset | A simple Spine bone |

**Rules**

- **An animation clip** works like an image clip: transform, opacity, fades, effects, timing, speed and Loop. It also has **Play / Hold frame**. Hold frame shows one chosen frame for the clip's whole length. That is how mouth, hand and blink swaps work: one shared "Mouths" animation has one drawing per frame, each clip of it holds one, and a swap is Split plus a new pick.
- **Animations nest** up to 8 deep, so an animation can contain clips of other animations, the shared parts.
  - Editing a file changes every clip of it, in every episode.
  - **Make Unique** copies the file and points one clip at the copy.
  - An animation that would contain itself is refused.
- **The Media tab always shows the episode's media.** Dropping an item into an open animation adds the reference to that animation's file.
- **Inside an animation:**
  - The timeline shows the animation's own time, in frames, from 0 to its length.
  - The canvas shows the episode around the clip at the clip's first pass.
  - The animation's frame rate steps playback, so a 12 fps animation is on twos in a 24 fps episode.
  - The camera lane and zoom tool are off, as inside groups.
- **Drawing clips exist only inside animations.** Images, video, audio and text can go on an animation's tracks too.
- **Colours:** each animation file has shared colours. A fill or stroke uses either a shared colour or its own hex. Changing a shared colour updates every shape that uses it.
- **Moving nodes:**
  - Node offset keys and node-set keys (rotation, x, y) live on the drawing clip. They show as diamonds and use the existing easings.
  - Node offsets apply first, then the node sets in list order.
  - A shape can follow a node set; hands and feet do this.
- **Outlines only on the outside:** a body is one closed shape. Its inner colours are shapes clipped inside it, and its stroke draws above them.
- **Target track:** tools act on the track of the selected clip, or on the top track when nothing is selected. There is no separate track selection.

## 3. Decisions

Approved by the user (2026-10-26):
- The shapes list is an expanded track on the timeline, not a panel.
- Each animation is its own file, imported like media.
- Mouth swaps use Hold frame on one shared animation.

Approved by the user (2026-10-27):
- A drawing clip holds timing and shapes only: no transform, opacity, fades, transitions or effects. Shapes move by their nodes; fades and effects go on the animation clip.
- V picks Move; M picks Rectangle, and M again Ellipse, as in Affinity. Both keys are rebindable.

Made in this plan (veto any of them before its ticket is built):
- The file format version stays 1. New clip types are `drawing` and `animation`; all other new keys are optional.
- The `.pbanim` extension.
- The type for a drawing's shape is `DrawingShape`, because `Shape` is already the blur/highlight type. A-01 renames the preset "animation" code.
- Animations may use 8, 12 and 15 fps as well as the project rates.
- Animation clips use a new rose clip colour.
- Animation clips render flattened, like groups, until A-73. The cost until then is that parts show through each other while a clip fades.
- Onion skin is drawn as outlines by the canvas overlay. It shows in the preview only, never in export.
- Drawings are rasterised with Canvas2D on the CPU, like callouts, for parity.
- ⌘D on a drawing ripples later drawings on the same track to make room.
- With the Node tool and nodes selected, the arrow keys nudge the nodes; otherwise they step frames as now.
- Pasting a drawing clip into an episode is refused.
- Save As saves the episode only; ⌘S also saves changed animations.
- Animation clips trim freely and show nothing past the animation's end unless Loop is on. They always scale evenly, like groups.
- Sound inside an animation is silent while the animation clip's speed isn't 100%.
- Inside an animation, only the Timing group (start, duration, source offset) is in frames; fade and transition lengths stay in seconds.
- Stepped playback steps pictures only; sound inside an animation plays unstepped.
- While an animation is open, the preview draws everything outside it at 40% opacity; export never does.
- Unsaved animations are recovered through a list next to the episode's recovery file (`<recovery>.animations`) that maps each real path to its copy. After a clean save the recovery files go at once.
- Media dropped inside an animation adds its reference through the normal drop; there is no separate copy step.
- Build order for groups 1–2 differed from ticket order: A-05/06 before A-04's placement; A-13, A-15 and A-18 together; A-14, A-16 and A-17 together.
- Node handles are stored relative to their node; a side without a handle is sharp. Shape ids are unique within their drawing, shapes are listed back to front, and shapes clip inside each other at most 8 deep.
- New shapes have a white fill and a black 4 px stroke, with round caps and joins until A-40.
- Drawing clips use the image clip colour (mockup v3) and the label "Drawing".
- Shape and clip selections are exclusive. While shapes are selected, Properties shows only the Colour group.
- The shapes' selection box is upright in the artboard, fits the outlines without their strokes, and refits as they turn. Corners keep the aspect and Shift frees it, as for clips. Stroke widths don't scale until A-40.
- Clipped children are drawn from A-28, because the file format holds them; A-41 adds the way to make them. A double-click picks a direct child, and a press on a chosen child moves that child.
- The fill and stroke wells show the first selected shape's colours, or the current colours with nothing selected. A click picks which one the Colour group edits.
- The Rectangle and Ellipse tools stay on after a drag and select the new shape. A hidden or locked target track gets the new drawing on a track above it. Coordinates are not rounded until A-47.
- A clip after a drawing plays its transition in on its own, as after a gap; drawings take no part in transitions.
- Shape rows are 30 px and list front to back. An expanded track is as tall as its drawing with the most shapes, so rows below never jump. Only tracks holding a drawing get ▸; expansion is per window, by track id, and isn't saved. With no drawing at the playhead, an expanded track shows "No drawing at the playhead".
- Hiding or locking a shape also hides or locks its clipped children. Hidden or locked shapes can't be selected from the list or the canvas, and hiding or locking unselects them.
- Dragging a row only reorders among its siblings, with no drop indicator, as for tracks; clipping inside is A-41.
- Unnamed shapes show "Shape"; the tools name new shapes "Rectangle" and "Ellipse".
- Paste and ⌘D keep the coordinates and put the copies in front: paste goes into the drawing at the playhead (or a new one, as for the tools), ⌘D right above each original. Cut works on shapes, and ripple delete deletes them. Deleting every shape leaves an empty drawing clip.
- Shapes paste into other animations now; A-63 brings their shared colours.
- Edit › Arrange is a submenu: Bring to Front, Bring Forward, Send Backward, Send to Back.
- The current colour: the last fill or stroke set becomes the colour of new shapes. It is kept per window, isn't saved and isn't undoable. With nothing selected the Colour group edits it.
- The Colour group is open at start, shows the first selected shape's colour and sets every selected shape. Setting a stroke colour on a shape without a stroke gives it a 4 px stroke. Opacity is stored as `#RRGGBBAA`.
- The colour field is a full-saturation spectrum, as in the mockup; a pick there sets hue and lightness and makes saturation 100%. Gradients appear only in the field and the slider tracks.
- The slider tracks take no keyboard focus; their number fields are the keyboard path until A-76.

## 4. Code map

| Area | Where |
| --- | --- |
| Types and parsing | `src/shared/project.ts`: `DrawingClip`, `AnimationClip`, `DrawingShape`, `NodeSet`. Extend `parseDocument` and `parseKeyframeList` with parameters; don't copy them |
| Files and media | `src/media/projectFile.ts`, `src/media/mediaStore.ts` (media per document), `src/main/main.ts` (`.pbanim`), `src/main/recovery.ts` |
| Documents | `src/renderer/store.ts` and `src/renderer/document.ts`: the episode plus loaded animation documents; `src/editor/history.ts` steps across documents |
| Resolving | `src/engine/resolve.ts`: animation clips nest like groups (`frameInside`); layer ids include the clip path; `forEachPlacedClip` recurses into animations |
| Rasterising | `src/engine/drawings.ts` (new), sharing `rasterOf` with `annotations.ts`, called from `frameProvider.ts` `drawnPicture`; bezier segments and bounds in `src/engine/curves.ts`, which has no DOM types so the resolver stays usable in Node |
| Pure edits | `src/editor/drawings.ts` (new): shapes, nodes, node sets, keys |
| Canvas tools | `src/renderer/CanvasOverlay.tsx`, sharing the SVG handle and `data-dot` code |
| Tests | `test/engine/drawings.test.ts` goldens; `test/projects/26-animation.json` and `.pbanim` fixtures in the parity list and output tests; scenarios in `src/main/uiScenarios.ts` |

Rules for every ticket:
- It ships with its tests and leaves `npm test` passing.
- jscpd runs with threshold 0, so shared code is extracted, never copied.
- UI follows `tokens.css` and `controls.css`: one field per row with its label above, units in brackets, in-house pickers.
- Visual reference: `mockups/animation-v3/`.

## 5. Tickets

79 tickets in 8 groups, in build order and of rising difficulty, plus nice-to-haves. Each line is the ticket, its difficulty, then its definition of done. After group 2 animations are files you can open, edit and save. After group 5 you can draw and animate a character. After group 6 the workflow is complete.

### 1. Animation files in episodes (easy → medium)

- **A-01** Free the name (easy):
  - The preset code that says "animation" is renamed to "preset": the `Animation`/`AnimationType` types, `parseAnimation`, and `src/editor/animations.ts` → `src/editor/presets.ts`.
  - The file keys `animationIn`/`animationOut` don't change.
  - Tests pass.
- **A-02** Animation file format (easy): `.pbanim` is project JSON without a camera, read and written through a kind parameter on the existing parser and serializer. Load then save is byte-identical; a camera is rejected; 8, 12 and 15 fps are allowed.
- **A-03** Import animation files (easy):
  - Import Media accepts `.pbanim`.
  - The media process reads size, frame rate and duration (the end of the last clip) without FFprobe.
  - Media shows an "Animation" type.
  - Broken files are rejected with a message.
- **A-04** Animation clip type (easy):
  - `type: 'animation'` with `mediaId`, visual, effect, timing, speed and loop fields, plus transform keyframes.
  - It is placed from Media at the artboard size.
  - Rose clip colour.
  - It saves and reopens.
- **A-05** Load animation documents (medium):
  - The renderer loads every imported `.pbanim` into a document map on import and on project open.
  - The engine worker, the headless export window and `--frames` renders receive the same map.
- **A-06** Media per file (medium):
  - Media inside an animation resolves against that file's folder and its own media list in the media process.
  - The same media id in two files never clashes.
  - After the media process restarts, media of loaded animations reopens.
- **A-07** Draw animation clips (medium):
  - The resolver nests an animation's tracks like a group: transform, opacity and effects are pushed down, and the background is transparent.
  - Speed and Loop work.
  - Golden test with an image inside an animation.
- **A-08** Unique layer ids (medium):
  - Two clips of the same animation on screen get different layer ids, built from the clip path.
  - Video streams, transitions and canvas hit tests never mix them up.
  - Tested with two copies of an animation that contains a video.
- **A-09** Sound and video inside animations (medium): the mixer and preparation ranges recurse into animations. A voice clip inside an animation plays in sync and exports.
- **A-10** Nested animations (medium):
  - Animation clips work inside animations, up to 8 deep across files.
  - A drop that would make an animation contain itself is refused with a message.
  - A cyclic file loads with "media error" on the clip.
- **A-11** Animation thumbnails (medium):
  - The engine renders a frame of an animation on request.
  - Media items show the first frame, refreshed after save.
- **A-12** Missing animation files (easy): they get the "media missing" badge and relink like media.

### 2. Opening and saving (medium)

- **A-13** Several documents in the store (medium): `EditorState` holds the episode and the loaded animation documents. Edits target the document that owns the open scope. Groups inside animations still work.
- **A-14** Open in place (medium):
  - Double-clicking an animation clip opens it. That works on the timeline, on the canvas and from a Properties button.
  - The breadcrumb reads `Project › kenta-wave`, with the file name for each animation, and Esc closes the animation.
  - The camera lane is off.
- **A-15** Time inside an animation (medium):
  - The timeline shows the animation's own time from 0 to its length.
  - Play and seek map through the clip's start, speed and loop to the episode's time on its first pass.
  - Unit tests cover speed, loop and trimmed starts.
- **A-16** Canvas framing (medium): the canvas shows the animation where its clip sits in the episode, with the rest dimmed. Handles map through the clip's transform, as `groupFrameAt` does for groups.
- **A-17** Media tab inside animations (easy): the Media tab shows the episode's media inside an animation. Dropping an item adds its reference to the animation's file.
- **A-18** Undo across documents (medium):
  - An undo step records each document it changed, and undo/redo restore them.
  - One gesture is still one step.
  - Undo takes ≤ 50 ms.
- **A-19** Save all (medium):
  - ⌘S writes the episode and every changed animation atomically, with media paths relative to each file.
  - Save As saves the episode only.
- **A-20** Unsaved changes and close (easy): the unsaved-changes dot and the close and quit prompts cover changed animations.
- **A-21** Autosave and recovery (medium):
  - Each changed animation gets a recovery file with its real path.
  - After a forced kill, relaunch restores everything with at most 10 s lost.
  - Recovery files for animations are never opened as windows.
- **A-22** Export uses live documents (easy): the export snapshot includes unsaved animation documents, so the exported frames match the screen.
- **A-23** New Animation (easy):
  - Media › New Animation… asks for a name and folder (default: the project's folder).
  - It writes an empty file at the episode's size and frame rate, imports it, places it at the playhead on a new track and opens it.
- **A-24** Animation settings (easy): with nothing selected inside an animation, Properties shows its size and frame rate. Changing the size rescales like Fit.
- **A-25** Frames inside animations (easy): the ruler, playhead time and Timing fields show frames, and clip edges snap to frames.
- **A-26** Stepped playback (easy): an animation plays on its own frame grid, in preview and in export. A parity project covers 12 fps inside a 24 fps episode.

### 3. Shapes (easy → medium)

- **A-27** Drawing clip type (easy):
  - `type: 'drawing'` with `shapes`. Each `DrawingShape` has a path of nodes, `isClosed`, a fill, a stroke and clipped `children`.
  - A `.pbproj` with a drawing is rejected, and pasting a drawing into an episode is refused with a message.
  - 1 s default length.
- **A-28** Draw shapes in the engine (medium):
  - Canvas2D rasteriser for bezier paths with fill and centre stroke.
  - Sharp at 4K and under camera zoom, like callouts.
  - Goldens at 360p and 4K; a parity project.
- **A-29** Tool strip (easy):
  - Inside an animation the canvas shows Move, Node, Pen, Pencil, Brush, Fill, Rectangle, Ellipse and Colour picker, with fill and stroke wells.
  - Affinity Designer's default keys, rebindable.
  - A tool shows only once its ticket is done.
- **A-30** Rectangle and ellipse (easy):
  - Dragging creates a closed shape in the drawing under the playhead on the target track. With no drawing there, it creates a new one.
  - Shift makes a square or circle.
  - One undo step.
- **A-31** Select shapes on canvas (medium):
  - A click picks the topmost shape whose outline contains the pointer (a path test, not a box).
  - Shift adds to the selection; double-click goes into clipped children.
  - The selection box moves, scales and rotates the shapes.
- **A-32** Variable-height track rows (medium): the timeline has a row layout that allows different track heights. Every `TRACK_HEIGHT` caller and the UI test driver use it. Nothing changes visibly.
- **A-33** Expandable track (medium):
  - ▸ on a track header lists the shapes of the drawing under the playhead, with clipped children indented.
  - Each row has a name, hide and lock. Hidden shapes don't render, and locked ones can't be picked.
  - Click selects, drag reorders, double-click renames.
- **A-34** Delete, copy, paste, duplicate shapes (easy): these work on the selected shapes within and across drawings. ⌘D duplicates shapes when shapes are selected, and clips when clips are.
- **A-35** Arrange (easy): ⌘[ and ⌘] move shapes back and forward; ⌘⇧[ and ⌘⇧] send them to the back and front. All are also in the menu.
- **A-36** Colour panel (medium):
  - Properties › Colour has fill and stroke wells, an HSL picker, H/S/L and opacity sliders and a hex field.
  - Changes show live, with one undo step per drag.
- **A-37** Fill tool on shapes (easy): clicking inside a shape sets its fill to the current colour, with a hover preview.
- **A-38** Colour picker tool (easy): a click takes the canvas colour under the pointer as the selection's fill; Shift takes it as the stroke.
- **A-39** Shared colours (medium):
  - Swatches are stored in the animation file, and you can add the current colour.
  - Shapes using a swatch update when it changes.
  - Swatches can be renamed and deleted; deleting one keeps its hex on the shapes.
- **A-40** Stroke panel (medium):
  - Style none, solid or dashed; width; cap; join; align inside, centre or outside; order behind or in front of the fill; Scale with object.
  - Drawn by the engine, with a golden for each.
- **A-41** Clip inside (medium):
  - Dragging a shape onto another in the track rows clips it inside.
  - The child draws only within the parent's fill and moves with it.
  - The parent's stroke draws above its children. Goldens.
- **A-42** Duplicate drawing (easy): ⌘D on a drawing clip puts a copy right after it on the same track, ripples later drawings and selects the copy.

### 4. Pen and nodes (medium)

- **A-43** Pen tool (medium):
  - Click adds a sharp node, drag pulls smooth handles, and clicking the first node closes the path.
  - Enter or Esc ends an open path.
  - A preview shows the next segment; ⌥-drag breaks a handle.
  - One undo step per shape.
- **A-44** Node tool (medium):
  - Shows the selected shape's nodes and handles, and drags both.
  - Box select and Shift multi-select.
  - With nodes selected, the arrow keys nudge by 1 px (Shift: 10 px); otherwise they step frames.
- **A-45** Node type and position (easy): Properties shows Sharp/Smooth and X/Y for the selected nodes. Converting a node recalculates its handles.
- **A-46** Add and delete nodes (medium): clicking a segment adds a node without changing the curve. Delete removes nodes. Close and break path.
- **A-47** Node snapping (medium): nodes snap to other nodes, whole pixels and the artboard edges. ⌘ turns snapping off, as on the canvas.

### 5. Animating (medium → hard)

- **A-48** Onion skin (easy):
  - A canvas footer button.
  - Shows the outlines of the 2 drawings before (red) and after (green) the playhead on the target track, fading with distance.
  - Overlay only.
- **A-49** Node keys (medium):
  - Moving nodes with the playhead inside a drawing records offset keys at the playhead, shown as diamonds on the clip.
  - Nodes interpolate with the existing easings.
  - Keyframe parsing takes the new keys through the existing parser.
  - Preview equals export.
- **A-50** Node sets (medium):
  - "Save selection" in Properties names a set of selected nodes and sets its pivot, whose crosshair you can drag.
  - Sets show as pills; clicking one selects its nodes.
- **A-51** Rotate a node set (medium):
  - The rotate handle or the Rotation field turns the set around its pivot and records a rotation key.
  - In-between frames follow the arc instead of shrinking.
  - Golden at a mid-key frame.
- **A-52** Move a node set (easy): dragging the set records x/y offset keys.
- **A-53** Key editing (easy): node keys work like other keyframes: easing and Delete from the right-click menu, previous/next buttons, copy and paste.
- **A-54** Keys in track rows (medium): node and set keys show on the shape's row in an expanded track and can be dragged in time, with snapping.
- **A-55** Previous key ghost (easy): while a set is selected, its outline at the previous key shows dashed red.
- **A-56** Follow a node set (medium): "Follow" in Properties attaches a shape, such as a hand or foot, to a set in the same drawing. It then moves and rotates with that set.
- **A-57** Keys survive node edits (medium):
  - Adding or deleting nodes keeps keys and sets on the right nodes.
  - Deleting a node removes its keys.
  - Unit tests cover these edits.
- **A-58** Parent node sets (hard):
  - A set can have a parent set, like a forearm inside an arm.
  - The child's pivot moves with its parent, and rotating the parent carries the child.
  - Forward kinematics only.

### 6. Reuse and composition (medium)

- **A-59** Hold frame (easy):
  - Timing for an animation clip has Play / Hold frame, with a picker of frame thumbnails from A-11.
  - The clip shows only that frame.
  - Split, then a new pick, swaps a mouth.
- **A-60** Edit shared parts in place (medium):
  - Double-clicking a Mouths clip inside Kenta wave opens Mouths, and the breadcrumb shows the whole path.
  - Edits save to the Mouths file, and every character using it updates.
- **A-61** Make Unique (easy):
  - The clip menu item copies the file next to it as `Mouths 2.pbanim`, imports it and points only this clip at the copy.
  - Undo restores the clip; the copied file stays on disk.
- **A-62** Changes from other windows (medium):
  - Saving an animation in one window, or changing it on disk, reloads it in other windows that use it.
  - A window with unsaved changes to that file asks: Keep mine, or Use saved.
- **A-63** Paste between animations (medium): shapes, drawings and node sets paste into another animation, and the shared colours they use come with them.

### 7. Freehand and fill (hard)

- **A-64** Pencil stroke capture (medium): dragging records the stroke and shows it live within one display frame.
- **A-65** Pencil smoothing (hard):
  - On release the stroke becomes a bezier path with few nodes, by curve fitting.
  - A Smoothing slider (0–100) in Properties.
  - The path closes when its end meets its start.
- **A-66** Brush with pressure (hard):
  - Pen pressure sets the width; with a mouse, speed does.
  - On release the stroke becomes a filled outline shape with tapered ends.
  - Width, Smoothing and Pressure in Properties.
- **A-67** Stroke pressure profile (hard): a pressure curve in the Stroke panel gives any stroke variable width. Drawn by the engine; goldens.
- **A-68** Fill enclosed areas (hard):
  - A click inside an area enclosed by several strokes creates a fill shape bounded exactly by them, placed under the strokes.
  - Gaps of up to 4 screen px close.
  - Hover preview.

### 8. Quality and performance (medium → hard)

- **A-69** Raster cache (medium):
  - A still drawing is rasterised once per look and scale; an animated one only on frames that change.
  - A 40-shape 1080p character rasterises in ≤ 4 ms on M1.
- **A-70** Editing budget (medium):
  - Node, handle and shape drags respond in the next display frame on 40-shape drawings.
  - A large animation opens in ≤ 1 s.
- **A-71** Playback budget (hard):
  - An episode with 6 animated characters over 1080p video plays without dropped frames on M1.
  - Scrubbing takes ≤ 50 ms when cached.
- **A-72** Memory (medium): a project with 20 animations and 2,000 drawings stays within the editor's memory budget, and caches shrink under pressure.
- **A-73** Animation as one picture (hard):
  - An animation clip is composited into its own picture before opacity, fades and effects, so parts don't show through each other.
  - Preview equals export; goldens.
- **A-74** Parity set (medium): reference animations covering shapes, clipping, strokes, node keys, nesting, Hold frame and stepped rate pass both the parity tests and the screen-against-export output tests.
- **A-75** Broken animation files (medium): truncated, cyclic, huge and malformed `.pbanim` files never crash or hang the app. Their clips show "media error".
- **A-76** Keyboard and labels (medium):
  - Tools, track rows and the Colour and Stroke panels are reachable by keyboard and have VoiceOver labels.
  - The new shortcuts are listed in Shortcut settings.
- **A-77** Visual polish (medium): every new control has hover, pressed, focus and disabled states and follows the tokens. The user signs off.
- **A-78** Stability (hard): a scripted 1-hour session of drawing, node edits, nested opening, undo, save and export ends with zero crashes and flat memory.
- **A-79** Acceptance (hard):
  - A new user makes a 30-second scene with no help and no crash.
  - They draw a character with Pen and Brush and wave an arm with a node set.
  - They lip-sync with a shared Mouths animation.
  - They put two characters over a video and export.

### 9. Nice-to-haves

- **A-80** Boolean operations: add, subtract, intersect and divide shapes.
- **A-81** Vector eraser.
- **A-82** Open an animation on its own and export it with transparency.
- **A-83** Step the held frame with ⌥← / ⌥→.
- **A-84** "Used in N" on Media items.
- **A-85** Two-bone IK on parent node sets.
- **A-86** Morph between two drawings (shape tween).
- **A-87** Filled, tinted onion skin drawn by the engine.
