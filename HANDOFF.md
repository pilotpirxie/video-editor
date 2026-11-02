# Handoff: animation workspace, A-56–A-58 plus clip length cap and shape keys (2026-10-30)

## Status

The task is the animation workspace specified in `AGENTS.md`, built ticket by ticket on branch `feature/animations`. Group 5 (`AGENTS.md` §5, A-48–A-58) is now complete. On 2026-10-30 this session:
- built A-56 Follow, A-57 keys surviving node edits and A-58 parent node sets;
- built two changes the user asked for afterwards: a length cap on animation clips, and Move-tool transform keys for shapes (through each shape's own node set, with a new Scale key on sets).

Nothing is committed: A-43 to A-58 and both extras are all in the working tree, with the user's own readability edits. The last full `npm test` (2026-10-30, 14:24–14:39 CET) ran after the last code edit. It exited 0: unit 1148/1148, engine and editor 379/379, typecheck clean, lint 0 clones, build OK.

The user has been given the final report for everything above. The next action is to wait for the user. Don't commit unless asked. The next ticket is A-59 Hold frame (`AGENTS.md:352`), the first of group 6.

## Original prompt

The user's messages in this session, word for word:

1. > '/Users/localuser/video-editor/HANDOFF.md''/Users/localuser/video-editor/AGENTS.md' take next group of tasks and continue

   Read as: build the rest of group 5, A-56–A-58. The old `HANDOFF.md` described A-47, and A-48–A-55 had been built in a session after it. Plan mode was entered and three questions were asked:
   - "When a shape starts to Follow a set, or a set gets a Parent, while that set is turned or moved at the playhead, what should happen?"
     - Options: "Moves from rest (Recommended)" / "Stays where it is".
     - Answer: **"Moves from rest (Recommended)"**.
   - "Where should the Follow picker for selected shapes go?"
     - Options: "Node group (Recommended)" / "Own group, any tool".
     - Answer: **"Node group (Recommended)"**.
   - "A-57: when a node is added on the outline of a keyed shape, what keys should the new node get?"
     - Options: "Keys along (Recommended)" / "No keys".
     - Answer: **"Keys along (Recommended)"**.
   - The plan was approved through ExitPlanMode.

2. > by the way animation duration vs clip duration. clip can be longer than animation and this is wrong. max length of clip i guess should be as long as animation.
   >
   > also i can add keyframes to nodes but i guess would be nice to be able to transform objects too. for example when i want to add arm movement.
   >
   > is there in plan step for this?

   Answered: neither is in the plan. §3 recorded "Animation clips trim freely", and shapes move only by nodes and node sets. Then asked:
   - "How should an animation clip's length be limited?"
     - Options: "Cap Play clips (Recommended)" / "Cap and shorten" / "Keep it free".
     - Answer: **"Cap Play clips (Recommended)"**.
   - "Should shapes get transform keys of their own, beyond node sets?"
     - Options: "Move tool records keys" / "Add Scale to node sets" / "Node sets as they are".
     - Answer: **"Move tool records keys"**.

   Plan mode was entered again, and three more questions were asked:
   - "Where should a shape's move, turn and scale keys live?"
     - Options: "Its own node set (Recommended)" / "Keys on the shape".
     - Answer: **"Its own node set (Recommended)"**.
   - "Where does the key button for selected shapes go?"
     - Options: "Transform group (Recommended)" / "Auto-key keyed shapes only".
     - Answer: **"Transform group (Recommended)"**.
   - "How should keyed shapes scale?"
     - Options: "Evenly (Recommended)" / "Width and height apart".
     - Answer: **"Evenly (Recommended)"**.
   - The plan was approved through ExitPlanMode.

3. `/anthropic-skills:handoff` (this file).

Earlier sessions, summarised in earlier handoffs and memory:
- **2026-10-26:** the workspace plan and A-01–A-26. Standing answers:
  - no commits unless asked;
  - the shapes list is an expanded track;
  - each animation is its own `.pbanim` file;
  - mouth swaps use Hold frame.
- **2026-10-27:** A-27–A-42.
- **2026-10-27/28:** A-43–A-46. The user chose:
  - a "Fill open paths" switch;
  - Close and Break buttons in Properties › Node;
  - Break splitting an open path in two;
  - an unfinished Pen path drawn by the overlay.
- **2026-10-29:** A-47 node snapping. The user chose nodes snapping onto nodes in reach; Node, Pen, Rectangle and Ellipse snap.
- **2026-10-29** (transcript `a1348b75-…`): A-48–A-55. The user chose:
  - node keys that work like clip keys, via the key button beside Node X/Y;
  - Copy Keys and Paste Keys menus.

  That session left `HANDOFF.md` unchanged, so it described A-47 until now.

## Paraphrased task

Build the `AGENTS.md` §5 tickets in order, each with its tests and with `npm test` green. Record build-time decisions in `AGENTS.md` §3 for veto, and commit nothing.

This session covered:
- **A-56 Follow:** a shape, and the shapes clipped inside it, moves and turns with a node set of the same drawing. A Follow picker sits in Properties › Node.
- **A-57 Keys survive node edits:**
  - adding or deleting nodes keeps keys and sets on the right nodes;
  - deleting a node removes its keys;
  - a node added on a keyed outline gets "keys along";
  - unit tests cover the edits.
- **A-58 Parent node sets:** a set can have a parent that carries its pivot and nodes. This is forward kinematics only, with a Parent picker in the set's fields.
- **Extra 1, clip length cap:** an animation clip in Play without Loop can't extend past its animation's end. Loop and Hold frame stay free, and so does an empty animation.
- **Extra 2, shape transform keys:**
  - With the Move tool, a Transform group (X/Y, Scale (%), Rotation (°) with key buttons) keys the selected shapes.
  - The first key gives a shape its own node set, which it follows (`ownsSet`). After that, Move-tool box moves, turns and scales record keys on that set.
  - Sets gained an even Scale key.

Out of scope: A-59 and later, the camera double count (carried finding), and any commit.

## Plan

The plan file is `/Users/localuser/.claude/plans/mutable-cuddling-puzzle.md`. It now holds the second plan, "Animation clip length cap, and Move tool keys for shapes", which the user approved through ExitPlanMode. The first plan in the same file (A-56–A-58), also approved, was overwritten by it. Short form of both:

**A-56–A-58** (done):
1. Format: `DrawingShape.follows`, `NodeSet.parent`, parser checks (unknown set, self-parent, loops).
2. Posing in `src/engine/curves.ts`:
   - poses sorted children-first by depth (stable, so sets without parents keep list order);
   - `SetPose.carried` is the set plus every set below it;
   - `followed` lists are passed down through clipped children.
3. Editor plumbing in `src/editor/drawings.ts`:
   - `followedSetIds`, `Moment.followedByShape`;
   - `shownPivot` through the parent;
   - parents' turn for the turn handle, nudges and pivot drags;
   - `shapeIdsMovedBy` for the ghost;
   - row keys including followed sets and parents.
4. Follow picker (`shape-follow`) under the Node sets pills; `setShapesFollow`.
5. Parent picker (`node-set-parent`) under Name; `setNodeSetParent` and `parentChoices`. A deleted set's children take its parent.
6. `insertNode` "keys along" (`withKeysAlong`).
7. Parity fixture: a head that follows `tilt`, and a `jaw` set parented to `tilt`.
8. UI scenario `follow-and-parent`.
9. Docs.

**Extras** (done):
- A1–A3: `sourceDuration(clip, mediaStates, documents)` caps animation clips, with `documents` threaded through `Trim`, `setDuration`, `setSourceStart` and `setLoop`, and tests.
- B1–B8:
  - format: `scale` set key (> 0), `ownsSet`;
  - posing: scale, `turnAndScaleOf`, stroke scale for followed sets;
  - own sets: `withOwnSets` and the shape pose and key functions;
  - keyed `transformShapes` with `time`;
  - UI:
    - the Transform group;
    - Scale (%) in the set fields;
    - corner-only box for keyed shapes;
  - tests and docs.

Where the work left the plans:

| Plan said | What was done | Why |
| --- | --- | --- |
| A `restPoint` function in `curves.ts` | `restPlace` in `drawings.ts` (one step back through a similarity), and pivot drag and nudge via `unturnedAndUnscaled` on deltas | Smaller; the parents' transform is a similarity, so deltas suffice |
| Transform group order Rotation, Scale, X/Y | X/Y, Scale (%), Rotation (°) | Matches the clip Transform group |
| Box keeps the aspect for keyed shapes | Also hides the side handles (`scalesEvenly` in `CanvasOverlay.tsx`) | `scaleFromHandle` stretches one side on a side handle even with the aspect kept |
| — | `saveBoxedCorners` extracted in `uiTest.ts` | jscpd flagged the shared opening of `node-sets` and `follow-and-parent` |
| — | `NO_DOCUMENTS`, `WAVE_STATES`, `waveDocuments` added to `test/fixtures.ts` | Shared by the trim and properties tests |

## Decisions

All of these are in `AGENTS.md` §3 (lines about 89 and 148–156) unless marked otherwise.

| Decision | Who | Why |
| --- | --- | --- |
| Follow and Parent move from rest. Nothing is re-based on attach, so a shape jumps into place at a turned frame; detaching puts it back where it is without the set | User | Same as Save selection and deleting a set; re-basing would change the rest pose |
| The Follow picker sits under the Node sets pills (Node tool), shown only when every selected shape is in one drawing that has sets | User (place), me (one-drawing rule) | All rigging in one group; sets belong to one drawing |
| A shape's follow carries its clipped children. Shapes pasted into another drawing, and followers of a deleted set, stop following | Me, for veto | Children stay inside the parent's fill; a set id is per drawing |
| Parent picker under the set's Name, offering every set but itself and the sets below it (no loops) | Me, for veto | — |
| A deleted set's children take its parent | Me, for veto | Keeps the rest of the chain carrying them |
| Order: node offsets first, then sets, each before its parent and otherwise in list order (`AGENTS.md` §2 amended) | Me, for veto (forced) | Forward kinematics needs the child turned around its rest pivot before the parent carries it |
| Parents' turn (and scale) apply to the child's turn handle, arrow nudges and pivot drags | Me, for veto | So they follow the pointer |
| A shape row's keys include its followed sets and every parent of its sets | Me, for veto | The row shows what moves the shape |
| Keys along: a node added on a keyed outline gets offset keys at the union of its neighbours' key times, on the curve at each; the easing comes from the neighbours | User | Handles aren't keyed, so a curved segment can bend slightly between keys; exact for straight segments or neighbours keyed together |
| Clip cap: Play without Loop can't pass the animation's end at the clip's speed (trim, Duration, Source offset). Loop off shortens. Loop, Hold frame and empty animations are free. A clip left past the end after the animation shrinks shows nothing there | User (cap, keep long clips), me (Loop off shortens) | Like video clips; Hold frame covers lines longer than the Mouths animation |
| Shape keys live on the shape's own node set: named after the shape (or "Shape"), pivoting on the middle of its posed outline at the playhead, parented to the innermost set it followed; the shape then follows it with `ownsSet: true` | User (own set), me (name, pivot, parent) | One concept; Follow and Parent work with it |
| Transform group (Move tool, shapes selected) above Colour, in clip order X/Y, Scale (%), Rotation (°), with key buttons | User (group), me (order) | — |
| Keyed = owns a set. Typed values always key. Move-tool box changes of keyed shapes record keys; unkeyed shapes change their place, as before | Me, for veto | Sets have no resting place |
| Keyed shapes scale evenly; their box has corner handles only | User (even), me (handles) | Side handles stretch one axis |
| Shapes clipped inside a keyed shape follow it and are not moved on their own when both are selected | Me, for veto | Prevents double moves |
| Deleting a shape leaves its own set as a plain set; deleting the own set unkeys the shape; copies and broken-off parts follow without owning | Me, for veto | One owner per set (the parser rejects two) |
| Follow on a keyed shape reads and sets its own set's parent, and leaves the own set and the sets inside it out of the choices | Me, for veto | Keeps its keys |
| Sets have an even Scale key (factor, > 0) around the pivot, applied before the turn, with a Scale (%) field and key buttons in the set's fields | User (scale), me (set field) | Mockup v3 shows Scale beside Rotation |
| A Scale-with-object stroke grows with the sets the shape follows, not with sets holding single nodes | Me, for veto | Node-level scales bend the outline, and a per-node stroke can't vary |
| Rejected options | — | Re-basing on attach; Follow in its own group; no keys for added nodes; "Cap and shorten"; keys on the shape itself; auto-key without fields; width and height scale apart |

## Steps done

| Step | Where | Checked by |
| --- | --- | --- |
| `follows`, `parent`, parser | `src/shared/project.ts`: `rejectBrokenParents`, `parseNodeSets`, `parseDrawingShape` | `src/shared/project.test.ts`: "load and save shapes that follow a set, and sets with a parent" and "reject following or parenting a set…" |
| Poses children-first, follows | `src/engine/curves.ts`: `carriedSetIds` (`:226`), `setPosesAt` (`:249`), `posedNode` (`:309`), `followedBy`, `posedList` | `src/engine/curves.test.ts`: "moves a shape that follows a set…", "turns a child set first…" |
| Follow and parent editing | `src/editor/drawings.ts`:<br>- `followedSetIds` (`:645`)<br>- `shownPivot` (`:1203`), `turnAndScaleAboveSet` (`:1214`)<br>- `shapeIdsMovedBy` (`:1230`), `deleteNodeSet` (`:1270`)<br>- `parentChoices`/`setNodeSetParent` (`:1290`/`:1295`)<br>- `followChoices`/`setShapesFollow` (`:1314`/`:1325`)<br>- `withKnownSets` | `src/editor/drawings.test.ts`: "moves a shape that follows a set…", "parents a set without loops…", "gives the children of a deleted set its parent", "makes a keyed shape follow through its own set" |
| A-57 keys along and node edits | `drawings.ts`: `withKeysAlong` (`:799`), `insertNode` (`:823`) | `drawings.test.ts`: "gives a node added between keyed nodes keys…", "keeps keys and sets on their own nodes when nodes go…" |
| Pickers | `src/renderer/Properties.tsx`: `SET_CHOICE_PREFIX` (`:1279`), `setChoices`/`setChoiceOf`/`chosenSetId`, `NodeSetFields` (`:1303`) | UI scenario `follow-and-parent` (`src/main/uiTest.ts:1024`), feature test `test/editor/features.test.ts:671` |
| Overlay | `src/renderer/CanvasOverlay.tsx`:<br>- ghost via `shapeIdsMovedBy` (`ghostOf` `:262`)<br>- turn handle direction<br>- pivot gesture `above`, set-move `after`<br>- `scalesEvenly` (`:596`) | Feature tests; hand-run pictures |
| Parity fixture | `test/projects/animations/scene.pbanim` `face-2`:<br>- `head.follows: "tilt"`<br>- set `jaw` with `parent: "tilt"`, rotation keys and scale keys (1 → 1.25)<br>- the mouth's nodes in `jaw` | `test/engine/parity.test.ts` `26-animation` passes. A rendered frame 36 looked right by eye (`…/scratchpad/face-1/frame-36.png`) |
| Clip cap | `src/editor/moveTrim.ts:142` `sourceDuration(…, documents)`, `Trim.documents`; `src/editor/properties.ts` `setDuration`/`setSourceStart`/`setLoop` (`:491`, `isAnimatedImage`); callers in `src/renderer/timelineController.ts:831` and `Properties.tsx` (Timing, Loop) | `src/editor/moveTrim.test.ts` "cannot extend a played animation past its end…"; `src/editor/properties.test.ts` "keeps a played animation within its end, but not a looping one" |
| Scale and own sets | `curves.ts`:<br>- `REST_SCALE`, `keyedValueAt(…, restValue)`<br>- `TurnAndScale`, `NO_TURN_OR_SCALE`<br>- `turnAndScaleOf` (`:289`), `unturnedAndUnscaled`<br>- `posedStroke` (`:341`)<br>`drawings.ts`:<br>- `boxPose` (`:408`), `transformShapes(…, time)` (`:427`), `withPoseKeyed` (`:1355`)<br>- `restPlace` (`:1423`), `withOwnSets` (`:1442`)<br>- `shapePoseAt`, `setShapesPose` (`:1488`), `setShapesKeys` (`:1495`), `hasShapeKeysAt`, `shapeKeyTimes` (`:1508`)<br>- `setKeyTimes`/`hasSetKeysAt` now take lists of sets<br>- `withNewShapeIds` and `breakPaths` drop `ownsSet` | `curves.test.ts` "scales nodes and handles around the pivot…"; `drawings.test.ts` "keys a shape on a set of its own…", "records the box turning, scaling and moving a keyed shape…", "leaves the shapes clipped inside a keyed shape…" |
| Transform group and set Scale | `Properties.tsx`: `ShapeKeyButtons` (`:1678`), `ShapeTransformFields` (`:1693`), `PART_NAMES`, `MIN_SET_SCALE_PERCENT`, Scale (%) in `NodeSetFields`, `toolGroup` for `tool === 'move'` | UI scenario `shape-keys` (`uiTest.ts:1053`), feature test `features.test.ts:703`. A hand-run picture (`…/scratchpad/keys-1/shape-keys.png`) shows the Transform group with keyed X/Y 5.2, Scale 125.8, Rotation 89.9 and corner-only handles |
| Nudge through parents | `src/renderer/actions.ts` `nudgeNodes` (`unturnedAndUnscaled` with `turnAndScaleAboveSet`) | Typecheck only; no test drives a nudge on a child set |
| Docs | `AGENTS.md` §2 (order line, own sets), §3 (line 89 replaced; new lines 148–156) | Read back |
| Memory | `/Users/localuser/.claude/projects/-Users-localuser-video-editor/memory/follow-parent-a56-a58-2026-10-30.md` and its `MEMORY.md` line | Written |
| Full suite | `npm test`, 2026-10-30 14:24–14:39 CET, after the last code edit | Exit 0: unit 54 files/1148; engine+editor 19 files/379, 886 s; 0 clones |

## Remaining

1. **Wait for the user.** They have the final report for A-56–A-58 and both extras. Don't start A-59 or commit until asked.
2. **Commit only if asked.** The tree mixes:
   - A-43–A-47, A-48–A-55, A-56–A-58 and the two extras;
   - the user's earlier readability edits (Files changed);
   - this file.

   Ask whether to make one commit or several, and whether the readability edits go in. Use the style of `3961d14`, and end with the attribution lines from the session's system reminder. Per `/Users/localuser/.claude/rules/global-standards.md`, don't override the author.
3. **Next ticket, when asked: A-59 Hold frame** (`AGENTS.md:352`): Play / Hold frame on animation clips, a picker of frame thumbnails from A-11, and Split plus a new pick swaps a mouth.
   - Follow `/Users/localuser/.claude/rules/planning.md`: plan mode, questions only for the user's decisions.
   - **Hold frame must stay free of the cap:** make `sourceDuration` (`src/editor/moveTrim.ts:142`) return `undefined` for a held clip, and add a test next to "cannot extend a played animation past its end…".
4. **Optional test gaps; ask the user whether they want them:**
   - New in this session:
     - nudging a child set with the arrow keys (parents' turn and scale);
     - typing in the Transform group through the UI;
     - Follow on a keyed shape through the UI;
     - Loop off shortening an animation clip through the UI;
     - a keyed clipped child whose parent shape follows an unrelated set (see Findings).
   - Carried from before:
     - the `isArtboardOpen === false` snapping path;
     - the snapping switch with nodes;
     - Shift with a snapped rectangle corner;
     - ripple delete of chosen nodes;
     - Break at two nodes;
     - the Pen ending on a tool change;
     - ⌘D drawing ripple;
     - Unlink Swatch;
     - Cut/Arrange on shapes;
     - pasting shapes into a second animation;
     - the A-27 paste refusal;
     - A-18 undo ≤ 50 ms inside an animation;
     - the engine `still` command.
5. **Ask the user before fixing the camera double count** (Findings, carried).

## Findings

**Posing model (this session)**
- **One posing path:** `posedShapes` (`src/engine/curves.ts:359`) is used by the resolver (`src/engine/resolve.ts:610`), the overlay and Properties.
  - A node is moved by a pose when any of its own `sets`, or any set its shape follows (inherited through clipped parents), is in `pose.carried`.
  - Poses are sorted deepest first, so a child applies before its parent; parentless drawings keep list order.
- **Inverting moves:** screen deltas go back through `unturnedAndUnscaled(delta, turnAndScaleOf(node, poses, followed))`.
  - The parents' transform of a set is a similarity (turn plus even scale plus move), so a pivot or offset change is just the delta turned and scaled back.
  - `restPlace` (`drawings.ts:1423`) uses this to put a new own set's pivot in rest space.
- **Box keys:** `boxPose` (`drawings.ts:408`) keys a keyed shape's box change as:
  - rotation `+= to.rotation − from.rotation`;
  - scale `×= to.scaleX / from.scaleX`;
  - offset `+=` the shown pivot's shift, turned and scaled back through the parents.

  A turn around the box centre adds no position key, because a new own set's pivot is the outline's middle, which is the box centre.
- **The scale key rests at 1, not 0.** `keyedValueAt(list, local, restValue)` and `restValueOf` in `drawings.ts` handle it. `withNodeLists` adds removed offsets for `x`/`y` only.
- **Edge case not tested:** a keyed shape clipped inside a shape that follows an unrelated set.
  - Its own set's parent is the innermost followed set (`followed.at(-1)`), and the crosshair is posed through that chain only, so the crosshair may not sit where the shape turns.
  - Believed rare. Confirm with a unit test on `shownPivot` before relying on it.
- **Time bases differ slightly:**
  - `shapePoseAt` and the Properties set fields read at `time − clip.start`.
  - Key writes (`setNodeSetPose`, `transformShapes`) use `localGridTime`.

  Inside a 12 fps animation at odd episode frames these can differ by one picture (the known gap "keys set while paused between animation frames").

**Clip cap (this session)**
- An animation's length is `projectDuration(document)`, the end of its last clip. Media info for animations has no duration (`isTimed` is false), which is why clips used to trim freely.
- **Where the cap lives:** `sourceDuration` reads `documents[info.path]`, from the store's `state.documents`, which `ClipProperties` already reads.

**UI scenarios (this session)**
- **Set picker options:** their values are `set:<random id>`, so scenarios pick by name with `pickSetNamed` (`uiTest.ts:1013`). The option test id is `${testId}-option-${value}`.
- **Mid-run pictures can lag:** `driver.picture` taken right after a DOM wait captured the previous frame (`follow-and-parent-turned.png` showed Set 1 selected after Set 2 was pressed). The end-of-run picture is reliable; mid-run pictures were removed.
- **Ids in the shape box:**
  - the box rotate handle is `handle-rotate`, the corners `handle-nw|ne|se|sw`;
  - the gesture undo labels are `Rotate Shape` and `Resize Shape`;
  - key buttons are `${testId}-keyframe`, for example `shape-rotation-keyframe`, with the label `Add Rotation Keyframe`.
- `follow-and-parent` and `shape-keys` each run in about 2–3 s.

**Test runs (this session)**
- **A transient failure:** the full run at 13:10 failed one playback output test, `test/editor/outputs.test.ts` "25-no-video: from the first frame to the last". The error was "playing-9.rgba at 00:00:02:09–00:00:02:10 equals the render of one of its frames: expected false to be true", with the load rising to about 9. It passed alone (5/5) and in the 14:24 full run.
- **A transient failure:** a parallel `npx vitest run src` once failed `src/media/probe.test.ts` "reads every usable test file in under a second" (1766 ms) under load. It passed in both later full runs.

**Carried over and still true**
- **Pen and Node tools:**
  - Pen state lives in the overlay (`penRef`, `penPath`), not the store.
  - Esc and Enter reach the Pen first through a capture-phase listener.
  - `store.selectedNodes` is pruned in `setState`.
  - `nearestOnOutline` resolves to about 3e-4 of a segment.
- **Snap targets:**
  - Take snap targets at press time; `pickables` is rebuilt every render.
  - Snap range in artboard units = `settings.snapRangePixels * canvasPerPixel / openFrame.scale`.
- **Electron and driver quirks:**
  - Electron `sendInputEvent` arrow keys are `'Up'`/`'Down'`/`'Left'`/`'Right'`.
  - Repeated undo labels are ambiguous in waits: undo → wait for `Undo` → redo.
  - `driver.savedProject()` hangs when an animation is unsaved; use `driver.menu('save')` then `untilEdited(driver, false)`.
- **Seeking in the 12 fps card:** inside it, seek only to even frames (`seekToFrame` in `uiTest.ts`); odd ones fall between frames of the 30 fps episode.
- **The timeline shows a "Camera" header inside an open animation** (`src/renderer/Timeline.tsx` always renders it; visible in the hand-run pictures). Whether it is inert there was not checked.
- **Store and parser rules:**
  - `store.update` drops root keys inside a group; whole-file edits (swatches) use `store.updateFile`.
  - Parser switches are `?: true`; `false` is rejected.
- **The camera zoom is counted twice for drawn layers inside animations** (since A-07; not fixed). `resolve.ts` folds `largestZoom(...)` into the inner frame's `largestScale`, and the provider multiplies again. Rasters are up to zoom× larger than needed; the pixels are correct.
- **Repo rules:**
  - `tsconfig.node.json` has no DOM lib; keep `Path2D`/`OffscreenCanvas` out of `src/editor`, `src/main`, `test`.
  - `test/editor/tokens.test.ts` forbids hex literals in renderer files except `tokens.css`.
  - jscpd runs at threshold 0 over `src`, `test` and `scripts` (tests included), and knip flags unused exports.
- **Running the app by hand:**
  - `--frames` needs absolute media paths.
  - A synthetic ⌘S over DevTools doesn't reach the macOS menu.
  - A first launch after a build can time out opening the project; rerun in a new folder.
- **Known small gaps:**
  - A closed group inside an open animation uses unstepped time.
  - The readout keeps `aria-label="Timecode"` when showing frames.
  - A new empty animation has duration 0 (the cap treats it as uncapped).
  - The shapes box refits during rotation.

## Files changed and to change

Changed in this session (uncommitted):
- **Format:**
  - `src/shared/project.ts`:
    - `DrawingShape.follows`/`ownsSet`
    - `NodeSet.parent`
    - `NodeSetKeyframes.scale`, `'scale'` in `AnimatableProperty` and `NODE_SET_KEY_PROPERTIES`, `valueRule` scale > 0
    - `rejectBrokenParents`, `ShapeContext.ownedSetIds`
  - `src/shared/project.test.ts`
- **Engine:**
  - `src/engine/curves.ts`:
    - children-first poses, `carriedSetIds`, follows
    - scale, `TurnAndScale`/`turnAndScaleOf`/`unturnedAndUnscaled`
    - `posedStroke`, `keyedValueAt` rest value
  - `src/engine/curves.test.ts`
- **Editor:**
  - `src/editor/drawings.ts`: follow, parent, keys along, own sets, shape pose/keys, keyed `transformShapes(…, time)`; `setKeyTimes`/`hasSetKeysAt` take lists.
  - `src/editor/drawings.test.ts`
  - `src/editor/moveTrim.ts` (cap), `src/editor/moveTrim.test.ts`
  - `src/editor/properties.ts` (`setDuration`/`setSourceStart`/`setLoop` with `documents`), `src/editor/properties.test.ts`
- **Renderer:**
  - `src/renderer/Properties.tsx`: Follow and Parent pickers, set Scale field, `ShapeKeyButtons`, `ShapeTransformFields`, Transform group for the Move tool.
  - `src/renderer/CanvasOverlay.tsx`: ghost, turn handle, pivot and set-move gestures, `scalesEvenly`, `transformShapes` gets `time`.
  - `src/renderer/actions.ts` (nudge through parents)
  - `src/renderer/timelineController.ts` (trim passes `documents`)
  - `src/renderer/store.test.ts` (trim passes `documents`)
- **UI tests:**
  - `src/main/uiTest.ts`: `saveBoxedCorners`, `pickSetNamed`, `testFollowAndParent`, `testShapeKeys`, registry entries `follow-and-parent` and `shape-keys`.
  - `test/editor/features.test.ts`: `Point`, `isPoint`, two tests.
- **Fixtures:**
  - `test/fixtures.ts`: `NO_DOCUMENTS`, `WAVE_STATES`, `waveDocuments`.
  - `test/projects/animations/scene.pbanim`: head follows `tilt`, `jaw` set with keys.
- **Docs:**
  - `AGENTS.md`: §2 two lines, §3 line 89 and lines 148–156.
  - `HANDOFF.md`: this file.

Changed by earlier sessions and still uncommitted: A-43–A-55 across `src/engine/curves.ts`, `src/editor/{drawings,clips,geometry,shortcuts,snapping,split,timelineView}.ts`, the renderer files listed in `git status`, `test/engine/{drawings,parity}.test.ts`, and the untracked goldens `test/golden/node-keys-half-way.png` and `node-set-turn-half-way.png`.

The user's own readability edits (present since before 2026-10-27 23:21):
- `src/editor/clips.ts` `mapClipsDeep`;
- `src/renderer/ColorFields.tsx` `chooseSwatch`;
- `src/renderer/Timeline.tsx` `dropAt`;
- parts of `drawings.ts`, `CanvasOverlay.tsx` and `Properties.tsx`.

To change: nothing pending. A-59 will touch `sourceDuration` (Remaining 3).

## Files with useful context

- `AGENTS.md`:
  - §2 model and rules
  - §3 decisions (the A-56+ ones at lines 148–156, the cap at line 89)
  - §4 code map
  - §5 tickets (group 6 from line 350)
- Plans in `/Users/localuser/.claude/plans/`:
  - `mutable-cuddling-puzzle.md` (this session, second plan)
  - `cosmic-questing-engelbart.md` (A-48–A-55)
  - `parsed-forging-eclipse.md` (A-47)
  - earlier: `ok-then-proceed-with-cuddly-robin.md`, `sunny-discovering-octopus.md`, `compiled-dazzling-lecun.md`, `glittery-sparking-sundae.md`, `splendid-finding-valley.md`
- Transcripts in `/Users/localuser/.claude/projects/-Users-localuser-video-editor/`:
  - `e8a236f1-3eeb-4c85-a265-2dfa481ffa7b.jsonl` (this session)
  - `a1348b75-bb1d-44dd-a8cf-f21799ab1666.jsonl` (A-48–A-55)
  - `b2b20783-…jsonl` (A-47)
- Memory in `/Users/localuser/.claude/projects/-Users-localuser-video-editor/memory/`:
  - `MEMORY.md`, `follow-parent-a56-a58-2026-10-30.md`, `node-keys-sets-a48-a55-2026-10-29.md`, `node-snapping-a47-2026-10-29.md`
  - test rules: `isolate-electron-test-profile.md`, `orphaned-test-apps.md`, `latency-budgets-under-load.md`
  - working style: `no-assumed-features.md`, `minimal-comments.md`, `cheaper-subagents.md`
- User rules: `/Users/localuser/.claude/rules/global-standards.md`, `planning.md`, `typescript-standards.md`.
- Patterns to copy:
  - `src/editor/drawings.ts` `withOwnSets`/`setShapesKeys` for "create on first key"
  - `editChosenDrawings`/`editSiblings` for shape edits
  - `src/renderer/Properties.tsx` `ShapeKeyButtons` over `DrawingKeyButtons` for key buttons
  - `src/main/uiTest.ts` `pickSetNamed` for pickers with random-id values
  - `test/editor/features.test.ts`:
    - `writeEpisode`: a 320×180, 12 fps card animation at (320,180) in a 640×360, 30 fps episode
    - `shapesDrawing`: Left at 20,20 and Right at 100,20, both 40 px; Coat at 250,140 with a pocket
- Visual reference: `mockups/animation-v3/` (set fields show Rotation and Scale (%)).

## How to run and check

From `/Users/localuser/video-editor`:

| Command | What it does | Last result |
| --- | --- | --- |
| `npm run typecheck` | tsc, both configs | Clean, 2026-10-30 after the last edit |
| `npm run lint` | `knip && jscpd`, threshold 0 | 0 clones, knip clean |
| `npm run test:unit` | `vitest run src`, about 16 s | 54 files, 1148 passed |
| `npm run build` | FFmpeg check, tsc, vite; needed before `test/engine` or `test/editor` runs | OK |
| `npm test` | All of the above, then `vitest run test/engine test/editor --no-file-parallelism` | Exit 0, 2026-10-30 14:24–14:39 CET, 379/379, 886 s |

Targeted runs, after `npm run build`:

```sh
npx vitest run test/editor/features.test.ts -t "shape in the Transform|follow a set|node set|node keys|node tool|snaps nodes|pen|rectangle and a circle" --no-file-parallelism
npx vitest run test/engine/parity.test.ts test/engine/drawings.test.ts test/engine/animations.test.ts --no-file-parallelism
```

If a latency or playback output test fails in a full run, rerun it alone first, for example:

```sh
npx vitest run test/editor/outputs.test.ts -t "25-no-video" --no-file-parallelism
```

To hand-run a scenario, use **a scratch profile only**; the default profile holds the user's real work. `write-episode.mjs` writes the `shapesDrawing` fixture:

```sh
S=/private/tmp/claude-501/-Users-localuser-video-editor/e8a236f1-3eeb-4c85-a265-2dfa481ffa7b/scratchpad
node $S/write-episode.mjs $S/run-1 && mkdir -p $S/run-1/profile
"$(node -e "console.log(require('electron'))")" . --user-data-dir=$S/run-1/profile --uitest shape-keys --project $S/run-1/episode.json --out $S/run-1
```

- The last stdout line is the JSON report.
- `<scenario>.png` is written at the end.
- Use a new folder per run.

To see an export frame:

```sh
"$(node -e "console.log(require('electron'))")" . --user-data-dir=$S/f/profile --frames test/projects/26-animation.json --via export --at 36 --out $S/f
node $S/rgba-to-png.mjs $S/f/frame-000036.rgba 1280 720 $S/f/frame-36.png
```

## Other information

- **The user's standing rules:**
  - Workflow:
    - commit only when asked
    - build only what was asked, and name forced side changes so they can be vetoed
    - record build-time decisions in `AGENTS.md` §3
    - plans in the `planning.md` structure, through plan mode, with questions only for the user's decisions
    - no database changes
    - concise replies that lead with the outcome
  - Code:
    - no new dependencies or abstractions unless needed
    - minimal comments (only the why)
    - early returns
    - `typescript-standards.md`: no casts, no `!`, `for…of` over chained array calls, function declarations for reused functions, named parameters
  - UI: label above, units in brackets, tokens only, no hex in renderer files, in-house pickers, terse copy.
  - Git (`global-standards.md`, changed during this session): no worktrees; keep the configured author; no Claude mentions or session links in PR descriptions.
  - Agents and test runs:
    - Subagents run on Haiku with no forks; this session used none.
    - Hand-run Electron only with a scratch `--user-data-dir`.
    - After a vitest timeout, kill orphaned test apps whose parent PID is 1.
    - Rerun latency or playback failures alone.
- **Processes:** none left running. `ps` at 14:54 CET showed no Electron or vitest processes from this repo.
- **Scratch files** (not in the repo; can be deleted) in `/private/tmp/claude-501/-Users-localuser-video-editor/e8a236f1-3eeb-4c85-a265-2dfa481ffa7b/scratchpad/`:
  - scripts: `write-episode.mjs`, `rgba-to-png.mjs`
  - `follow-1/` (`follow-and-parent.png`), `keys-1/` (`shape-keys.png`), `face-1/` (`frame-36.png`)
  - logs: `npm-test.log` (lint failure, fixed), `npm-test-2.log` (one transient output failure), `npm-test-3.log` (green), `build.log`
- **Already told the user:**
  - the A-56–A-58 report with its veto list and forced changes;
  - the answer to their clip length and transform question;
  - the final report for the cap and shape keys with its veto list (set Scale field and parity scale key as unrequested changes).

  Nothing is promised beyond waiting for the next instruction.
