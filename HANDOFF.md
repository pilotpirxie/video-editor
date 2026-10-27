# Handoff: animation workspace, shape rows and Colour panel A-32–A-36 (2026-10-27)

## Status

The task is the animation workspace specified in `AGENTS.md`. Earlier batches:
- A-01–A-26 were built on 2026-10-26.
- A-27–A-31 were built earlier on 2026-10-27.

This session built **A-32–A-36**:
- variable-height track rows
- the expandable track with the shapes list
- delete/copy/paste/duplicate for shapes
- Arrange
- the Colour panel with a "current colour"

Everything is on branch `feature/animations` and **nothing is committed**; the user commits.

The last full `npm test` started 2026-10-27 at 14:26 local time, after the last code edit, and **passed everything**:
- typecheck: clean
- lint: clean, 0 clones
- unit: 54 files, 1075 tests
- build: OK
- engine/editor: 19 files, 365 tests, 816 s

The user has been told the result, but has not yet reviewed the veto list or the one change made after screenshots (the colour field, see Decisions). Next action: wait for the user's review and commit. Don't start A-37 or later until the user asks.

## Original prompt

The user's messages in this session (2026-10-27), word for word:

1. > '/Users/localuser/video-editor/HANDOFF.md''/Users/localuser/video-editor/AGENTS.md' take next

   Questions asked in plan mode, with the options offered and the answers:
   - "Which tickets should this batch cover?"
     - Options:
       - "A-32–A-35 (Recommended)"
       - "A-32–A-33"
       - "A-32–A-36": as the recommended batch plus the Colour panel (fill/stroke wells become clickable, HSL picker, sliders, hex).
     - Answer: **"A-32–A-36"**
   - "A-36 Colour panel: should it also set the colour that new shapes get (Affinity's "current colour", which A-37's Fill tool uses)?"
     - Options:
       - "Selection only (Recommended)": edits only the selected shapes; new shapes stay white/black until A-37.
       - "Also current colour": Affinity behaviour now. The last colour you set becomes the colour for new shapes, kept per window and not in the file. With nothing selected, the wells and the Colour panel edit that current colour.
     - Answer: **"Also current colour"**
   - "A-33 expanded track: the list shows the drawing under the playhead. How tall should an expanded track be?"
     - Options:
       - "Tallest drawing (Recommended)": rows sized for the drawing with the most shapes on that track, so tracks below never jump; spare rows stay blank.
       - "Current drawing": exactly as many rows as the drawing under the playhead; tracks below move as the playhead crosses drawings.
     - Answer: **"Tallest drawing (Recommended)"**
   - The plan was approved through ExitPlanMode.

2. `/handoff` (this file).

Earlier sessions (summarised in earlier handoffs):
- 2026-10-26: built the workspace plan and A-01–A-26. Standing answers then:
  - "No commits".
  - The shapes list is an expanded track.
  - Each animation is its own file.
  - Mouth swaps use Hold frame.
- 2026-10-27 morning: built A-27–A-31. Answers then:
  - A drawing clip holds timing and shapes only.
  - V = Move; M = Rectangle, and M again = Ellipse.

## Paraphrased task

Build the next tickets of `AGENTS.md` after A-31. The user scoped this batch to **A-32–A-36**. Each ticket ships with its tests, `npm test` stays green, nothing is committed, and every build-time decision goes into `AGENTS.md` §3 "Made in this plan" for veto.

- **A-32:** one row layout for the timeline that allows different track heights. Every `TRACK_HEIGHT` caller and the UI test driver use it. Nothing changes visibly.
- **A-33:** ▸ on a track header lists the shapes of the drawing under the playhead, with clipped children indented.
  - Each row has a name, hide and lock.
  - Hidden shapes don't render; locked ones can't be picked.
  - Click selects, drag reorders, double-click renames.
- **A-34:** delete, copy, paste and duplicate the selected shapes, within and across drawings. ⌘D duplicates shapes when shapes are selected, and clips when clips are.
- **A-35:** ⌘[ / ⌘] move shapes back and forward; ⌘⇧[ / ⌘⇧] send them to the back and front. All four are also in the menu.
- **A-36:** Properties › Colour has:
  - fill and stroke wells
  - an HSL picker
  - H/S/L and opacity sliders
  - a hex field
  - live changes, with one undo step per drag

  Per the user's answer, the last colour set also becomes the colour for new shapes.

Out of scope: A-37+ (Fill tool, colour picker tool, swatches, Stroke panel, clip inside, Pen, nodes), commits, and anything not asked.

## Plan

The plan file is `/Users/localuser/.claude/plans/compiled-dazzling-lecun.md`, approved by the user through ExitPlanMode on 2026-10-27. Short form:

1. A-32: the `TrackRows` layout in `src/editor/timelineView.ts` replaces the `trackCount × TRACK_HEIGHT` maths in the controller, the drawing code, the headers and the driver.
2. A-33 format, engine and picking:
   - `name`, `hidden` and `locked` on `DrawingShape`.
   - The resolver skips hidden shapes.
   - Picking skips hidden and locked shapes.
   - Pure row and flag edits.
3. A-33 UI: the store's `expandedTracks`, `ShapeRows` under `TrackHeader`, and empty lanes drawn on the timeline canvas.
4. A-34/A-35: pure edits in `src/editor/drawings.ts`, shape branches in `src/renderer/actions.ts`, four shortcuts and the Edit › Arrange submenu.
5. A-36:
   - `src/editor/colors.ts`.
   - The store's `drawingStyle` and `colorPart`.
   - The Colour panel component.
   - Properties wiring.
   - Clickable tool-strip wells.
6. The UI scenarios `shape-rows` and `shape-edits`, and their feature tests.
7. `AGENTS.md` §3 decisions and a memory note.

Where the work left the plan, and why:

| Plan said | What was done | Why |
| --- | --- | --- |
| `trackRowHeights(tracks, expanded)` | Exported `trackRowsOf(tracks, expandedTrackIds)` returning `TrackRows` | Both callers want rows, not heights |
| `uiScenarios.ts`/`uiTest.ts` import the constants from `timelineView.ts` | `src/main/uiDriver.ts` imports them and **re-exports** `RULER_HEIGHT`, `CAMERA_LANE_HEIGHT`, `TRACK_HEIGHT`; `uiTest.ts` also imports `SHAPE_ROW_HEIGHT` directly | Fewer import changes |
| `ShapeRow` has `ancestorIds` | `ShapeRow { shape, depth, isPickable }` | `reorderShape` resolves the sibling itself |
| Store prune `withoutMissingShapes` extended | Renamed `withoutUnpickableShapes` (`src/renderer/store.ts:140`) | It now drops hidden and locked shapes too |
| Row `aria-selected` | `data-selected` on `shape-row-${id}` | Rows are not a listbox role |
| Row drag with pointer capture | List-level `pointerup` without capture, plus `user-select: none` | Capture retargeted the double-click away from the name |
| A shared `refsByDrawing` helper | `shapeIdsByDrawing`, and `editDrawings` passes the `clipId` to its callback | Same purpose |
| New-drawing 1 s helper | `drawingPlace(...)` in `src/editor/drawings.ts:117`, used by `CanvasOverlay.startDrawing` and paste | Shared rule |
| **New** `src/renderer/ColorPanel.tsx` exporting `ColorPanel` in a Group | **New** `src/renderer/ColorFields.tsx` exporting `ColorFields` and `useWellColors`; `Properties.tsx` wraps it in its `Group` | Importing `Group` from Properties into the panel would have been circular |
| A ref keeps the last HSL | `useState` (`remembered`) | Reading a ref during render |
| Colour field: hue across, lightness down **at the current saturation** | Field is a **full-saturation spectrum**; a pick sets hue and lightness and **saturation 100%**; the hue track is a fixed rainbow | Found in screenshots: from the default white, or any grey, the field and the hue track were all white or grey, so no hue could be picked |
| `rowInView` unchanged | Its scroll loop is now `timelinePointInView(driver, pointNow, rowHeight, what)` (`src/main/uiScenarios.ts:2047`); `rowInView` calls it | The shape-row scenarios needed the same scrolling with a 30 px margin |
| — | `testShapeRows` saves a `shape-rows.png` screenshot | For eye checks |

## Decisions

| Decision | Who | Why |
| --- | --- | --- |
| Batch scope A-32–A-36 | User | Answer (the recommendation was A-32–A-35) |
| The Colour panel also sets the current colour for new shapes: per window, not in the file, not undoable. With nothing selected the wells and panel edit it | User chose "Also current colour"; "not undoable" is mine, for veto | Answer (the recommendation was "Selection only") |
| An expanded track is as tall as the drawing with the most shapes on it | User | Answer: rows below never jump |
| No commits | User (2026-10-26, standing) | Earlier answer |
| Shape rows are 30 px and list front to back | Me, for veto | Mockup v3 layer rows |
| Only tracks holding a drawing get ▸. Expansion is per window, by track id, and isn't saved. With no drawing at the playhead, a row "No drawing at the playhead" shows | Me, for veto | Minimal state |
| Hiding or locking a shape also hides or locks its clipped children. Hidden and locked shapes can't be selected from the list or the canvas, and hiding or locking deselects them | Me, for veto | Clipped children draw inside their parent |
| Dragging a row only reorders among siblings, with no drop indicator (as for tracks); clipping inside is A-41 | Me, for veto | Keeps A-33 small |
| Unnamed shapes show "Shape"; the tools name new shapes "Rectangle"/"Ellipse" | Me, for veto | — |
| Paste and ⌘D keep coordinates and put copies in front: paste into the drawing at the playhead (or a new one, as for the tools), ⌘D right above each original | Me, for veto | Affinity behaviour |
| Cut works on shapes; ripple delete deletes shapes; deleting every shape leaves an empty drawing clip | Me, for veto | — |
| Shapes paste into other animations now; A-63 brings shared colours | Me, for veto | Shared colours don't exist yet (A-39) |
| Edit › Arrange is a submenu: Bring to Front, Bring Forward, Send Backward, Send to Back (undo labels match) | Me, for veto | Affinity names |
| The Colour group is open at start, shows the first selected shape's colour and sets every selected shape | Me, for veto | — |
| Setting a stroke colour on a shape without a stroke gives it a 4 px stroke | Me, for veto | Same width as new shapes |
| Opacity is stored as `#RRGGBBAA` (6 digits when opaque) | Me, for veto | No format change |
| **The colour field is a full-saturation spectrum; a pick sets hue and lightness and makes saturation 100%.** The hue track is a fixed rainbow | Me, after the plan; **the user has been told but has not answered** | From white the old field was useless. It matches mockup v3. Rejected alternative: a saturation × lightness square for the current hue (classic Photoshop picker), which does not match the mockup |
| Gradients only in the colour field and the slider tracks | Me, for veto | UI rule: no gradients on controls except colour content |
| The slider tracks take no keyboard focus; the number fields are the keyboard path until A-76 | Me, for veto | A-76 does keyboard and labels |
| A-31 lines amended: with shapes selected Properties shows only the Colour group, and the wells are clickable | Me | They said "until A-34 and A-36" |

All of these are in `AGENTS.md` §3 "Made in this plan":
- lines 97 and 100 are the amended A-31 lines;
- lines 103–113 are this batch's decisions.

The decisions from A-01–A-31 are in §3 lines 73–102. The user has not reviewed any of the "Made in this plan" lines yet.

## Steps done

| Step | Where | Checked by |
| --- | --- | --- |
| A-32 row layout | `src/editor/timelineView.ts`: `SHAPE_ROW_HEIGHT = 30` (`:11`), `TrackRows` (`:59`), `trackRows` (`:65`), `trackRowsOf` (`:90`), `trackTop` (`:104`), `trackIndexAtOffset` (`:108`), `trackIndexAt` (`:118`). `hitClip` (`:198`) ignores shape rows; `clipsInMarquee` (`:225`) | `src/editor/timelineView.test.ts` (41 tests, incl. `describe('track rows of different heights')` and "finds no clip in the shape rows of an expanded track") |
| A-32 callers | `src/renderer/timelineController.ts`: `rowsNow()` (`:194`) is cached on `(project.tracks, expandedTracks)`; `host.dataset.rows` (`:267`) holds heights JSON; the move gesture carries `rows`; `withScrollInRange` uses `rows.total`. `src/renderer/timelineDraw.ts`: `ContentScene.rows`, `drawTrack(…, rowTop, rowHeight)`, `drawShapeLanes` (`:461`). `src/renderer/Timeline.tsx`: the grip drop uses `trackIndexAtOffset`. `src/main/uiDriver.ts` `timelinePoint` (`:252`) builds rows from `dataset.rows` | The existing `drawing-tools` feature test and the full engine/editor run, including all track and timeline scenarios |
| A-33 format | `src/shared/project.ts`: `DrawingShape.name?`, `hidden?: true`, `locked?: true`; the parser takes `name` as a string and the flags via `parseSwitch` | `src/shared/project.test.ts` (eye fixture with name/hidden/locked; rejects `hidden: false` and `name: 3`) |
| A-33 engine | `src/engine/resolve.ts:588` `shownShapes` drops hidden shapes and their subtrees, returning the same array when none are hidden; `drawingLayers` uses it | `src/engine/resolve.test.ts` "leaves out hidden shapes…" (incl. the identity check) |
| A-33 pure edits | `src/editor/drawings.ts`: `pickableShape` (`:65`), `ShapeRow`/`shapeRows` (`:75`, `:92`), `drawingAt` (`:98`), `setShapeFlag` (`:230`), `renameShape` (`:242`), `reorderShape` (`:256`) | `src/editor/drawings.test.ts` (21 tests in total) |
| A-33 picking | `src/renderer/CanvasOverlay.tsx`: `topmostAt` skips locked shapes, the double-click child pick skips locked children, `shapeUnder` uses `pickableShape`; store prune `withoutUnpickableShapes` | `src/renderer/store.test.ts` "hide/lock lets go of the selection"; scenario `shape-rows` (`pickedWhereHidden`/`pickedWhereLocked` = `'0'`) |
| A-33 UI | `src/renderer/Timeline.tsx`: `ShapeRows` (`:58`), `TrackHeader` (`:172`; expand button `track-expand-${index}`), `rows` memo (`:432`). Test ids: `shape-row-${id}` (`data-selected`), `shape-name-${id}`, `shape-name-input`, `shape-hidden-${id}`, `shape-locked-${id}`. CSS: `src/renderer/editor.css` `.shape-rows`, `.shape-row` (30 px, "Must match SHAPE_ROW_HEIGHT"), `.selected`, `.muted`, `.empty`. Store: `expandedTracks` and `expandTrack` (`src/renderer/store.ts:33`, `:341`) | Scenario `shape-rows` and its feature test (rows `['Right','Coat','Shape','Left']`; rename, Shift-add, hide, lock, drag-reorder; saved file has the order `right, left, coat` with `hidden`/`locked`/`name`). Screenshot `shape-rows.png` checked by eye |
| A-34 pure edits | `src/editor/drawings.ts`: `drawingPlace` (`:117`), `addDrawingShapes` (`:127`, was `addDrawingShape`), `shapeRefsOf` (`:140`), `deleteShapes` (`:296`), `CopiedShape`/`copyShapes` (`:300`, `:313`), `withNewShapeIds` (`:322`), `addShapesAbove` (`:329`) | `src/editor/drawings.test.ts` |
| A-34 commands | `src/renderer/actions.ts`: `Copied` union (`:58`); shape branches in `copy`, `cut`, `pasteShapes` (`:132`; outside an animation `notify('Shapes can only be pasted inside an animation.')`), `deleteSelection`, ripple delete, `duplicate` | Scenario `shape-edits`: delete + undo, copy + paste, ⌘D (rows `['Left','Left','Right','Coat','Shape','Left']`), the refusal notice in the episode. **Cut, ripple delete on shapes and paste into another animation have no automated test** |
| A-35 Arrange | `src/editor/drawings.ts` `ArrangePlace`/`arrangeShapes` (`:270`, `:292`); `src/editor/shortcuts.ts` (`:28`, `:81`, `:122`, `:311`); `src/shared/mediaProtocol.ts:266`; `src/renderer/Editor.tsx:280`; `src/renderer/document.ts:579`; `src/main/main.ts:924` Edit › Arrange submenu; `src/renderer/actions.ts:60` `ARRANGE_LABELS`, `arrange` (`:366`) | Unit tests for all four places; `src/editor/shortcuts.test.ts`; scenario `shape-edits` (⌘⇧] then ⌘[, checked in the saved order) |
| A-36 colour maths | **New** `src/editor/colors.ts`: `ColorParts`, `partsOf`, `hexOf`, `hexInput` | **New** `src/editor/colors.test.ts` (4 tests) |
| A-36 store and style | `src/editor/drawings.ts`: `ShapeStyle`, `ColorPart`, `NEW_SHAPE_STYLE` (`:17`), `setShapeColor` (`:248`); `rectangleShape`/`ellipseShape` take a style. Store: `drawingStyle`, `colorPart`, `setDrawingColor` (`:335`), `setColorPart` | `src/renderer/store.test.ts` "keeps the colours for new shapes…" |
| A-36 panel | **New** `src/renderer/ColorFields.tsx`: `useWellColors` (`:31`), `useAreaDrag`, `SliderTrack`, `HslField`, `ColorFields` (`:145`). Test ids: `colour-fill`, `colour-stroke`, `colour-field`, `colour-${hue,saturation,lightness,opacity}`, `colour-…-track`, `colour-hex`. `src/renderer/NumberField.tsx` optional `track`; `src/renderer/controls.css` `.field-row.with-track`, `.slider-track`, `.slider-knob`, `.hsl-field`, `.colour-wells`, `.colour-chip`; `src/renderer/Properties.tsx` Colour group; `src/renderer/CanvasPanel.tsx` wells `tool-well-fill`/`tool-well-stroke` | Scenario `shape-edits`: hue-track drag on the coat's stroke (saved hue 100–140), hex `#336699` on its fill, Esc, then hex `ff8800` with nothing selected and a new rectangle with fill `#FF8800`. Screenshots `shape-colours.png`, `shape-rows.png` and a crop of the panel checked by eye after the spectrum change |
| UI scenarios | `src/main/uiTest.ts`: `CHOSEN_SHAPES`, `artboardPointer`, `openShapeRows`, `shownRows`, `shapeRowPoint` (`:533`), `chooseRow`, `shapesPickedAt`, `testShapeRows` (`:549`), `testShapeEdits` (`:580`), registered at `:732-733`. The `drawing-tools` tool query is now `:scope > button` | `npx vitest run test/editor/features.test.ts -t "shape\|clipped child" --no-file-parallelism`: 3 passed |
| Feature tests | `test/editor/features.test.ts`: `shapesDrawing()` (`:398`), `drawingsIn` (`:416`), tests at `:426` and `:441` | As above, and in the full run |
| Token rule fix | `ColorFields.tsx` lightness gradient uses `hsl(0 0% 0%)`/`hsl(0 0% 100%)`; `src/renderer/store.test.ts` builds its colours with `hexOf` | `test/editor/tokens.test.ts` "are the only place a colour is written down" (failed in the first full run, passed in the second) |
| Docs | `AGENTS.md` §3 lines 97, 100, 103–113 | Read back |
| Memory | **New** `memory/shape-rows-colour-a32-a36-2026-10-27.md` and its line in `memory/MEMORY.md` | Written |
| Full `npm test` | — | **Passed**, started 2026-10-27 14:26 local, after the last code edit. Log: `/private/tmp/claude-501/-Users-localuser-video-editor/7e79620e-6c7a-4d17-9353-0b7dc77f9e65/scratchpad/npm-test-2.log` |

## Remaining

1. **The user reviews and commits.** No code is pending.
   - Point the user to `AGENTS.md` §3 lines 103–113, and the colour-field spectrum decision in particular, which was made after the plan.
   - The earlier "Made in this plan" lines 73–102 are also unreviewed.
   - Do not commit; the user commits. `HANDOFF.md` and `AGENTS.md` are untracked. The `mockups/animation-*` files are staged (`A`), and the user said earlier they would revert them.
2. **Ask the user before fixing the camera double count** (Findings). It is a pre-existing A-07 issue; output is correct.
3. **Optional, ask the user:** stop the shapes box refitting during a rotate drag (`src/renderer/CanvasOverlay.tsx` `shapesBoxOf` is recomputed from the live shapes). Cosmetic.
4. **Optional test gaps, ask the user whether wanted:**
   - Cut on shapes, ripple delete on shapes, Bring Forward / Send to Back through the UI, and paste of shapes into a second animation: these have no automated UI test.
   - The paste refusal for drawing clips (A-27) in `actions.ts`.
   - A-18 "undo ≤ 50 ms" inside an animation.
   - The engine `still` command (A-11).
5. **Next tickets, only when the user asks:** A-37 Fill tool (`AGENTS.md:245`), then A-38 colour picker, A-39 shared colours, A-40 Stroke panel, A-41 clip inside, A-42 duplicate drawing. Follow `/Users/localuser/.claude/rules/planning.md`: plan mode, questions only for decisions that are the user's, and the plan structure given there.
   - A-37 uses the current colour (`drawingStyle.fill` in the store).
   - A-41 extends `reorderShape`/row drag to clip inside.
   - A-54 puts keys into the lanes drawn by `drawShapeLanes`.
6. **If a latency budget fails in a full run**, rerun that test alone before treating it as a regression:

   ```sh
   npx vitest run test/editor/editor.test.ts -t "responsiveness on a profile without a cache" --no-file-parallelism
   ```

   The two 2026-10-27 runs of this session had no latency failures.

## Findings

- **The bottom track's shape rows sit below the UI-test timeline.**
  - The test window's inner size is 1440x868, and the `timeline` canvas is 250 px tall (y 606–856).
  - The card's drawing is on track 0, the bottom track, so its expanded rows start below the visible area. The 4th row's centre was at y 869.
  - `driver.rect` + `clickAt` then clicks outside the window, and the scenario times out with "the left row to be chosen".
  - Fix used: `shapeRowPoint` scrolls with `timelinePointInView`.
  - The scroll range is exact: `maxScrollY = TRACKS_TOP + rows.total - height` (`timelineController.ts:217`), with no slack. So the old `TRACK_HEIGHT / 2` margin in `rowInView` could never be met by a 30 px row at the bottom ("could not be scrolled into view"). That is why the helper takes a `rowHeight`.
  - Expanding a track does not scroll it into view. That was not asked; a user scrolls.
- **`test/editor/tokens.test.ts` forbids hex colour literals** (`/#[0-9a-fA-F]{3,8}\b/`) in every `.ts`, `.tsx` and `.css` file directly in `src/renderer/` except `tokens.css`, **tests included**. Use `hsl(...)` strings in renderer code, and build test colours with `hexOf` from `src/editor/colors.ts`. `src/editor/` is not checked.
- **An HSL field drawn at the current saturation is useless from white or grey**; it showed only white or grey. Same for a hue track drawn at the current lightness. Both now use the fixed `SPECTRUM` in `ColorFields.tsx`.
- **The CSS layers are exact HSL.**
  - Hue stops every 60° at S100 L50, under a white→transparent→black vertical layer, give exactly `hsl(h, 100%, l)`, because HSL above and below L50 is a linear mix with white or black.
  - Keep this when changing the field.
- **Pointer capture on a row retargets the double-click** to the row, so the name never got `dblclick`. Rows record the press on `pointerdown` and the list handles `pointerup` without capture.
- **jscpd threshold 0** forced the shared `useAreaDrag` (slider and field) and `timelinePointInView`.
- **knip flags every unused export.** Keep helper types unexported unless used elsewhere.
- **Electron `sendInputEvent` mouseWheel:** in `timelinePointInView` a negative `deltaY` (`-ROW_SCROLL_PIXELS`) brings lower rows up into view. Observed: the scenarios pass with it.
- **macOS has no `timeout` command** in this shell; run hand scenarios without it.
- **There is no TS runner** (no tsx or vite-node). The scratch script `write-episode.mjs` (Other information) rebuilds the shape-rows fixture in plain JS.
- **The header shows "Camera" inside an animation.** The lane is empty there, and mockup v3 shows the same label. It is not a regression from this batch.
- **Carried over and still true:**
  - **Camera zoom counted twice for drawn layers inside animations** (since A-07; not fixed):
    - `src/engine/resolve.ts` folds `largestZoom(...)` into `frame.largestScale` for an animation's inner frame.
    - `drawingLayers` and the text/callout/arrow layers use that as `sharpScaleX/Y`.
    - The provider multiplies by `view.largestScale` again (`src/engine/engine.ts`, `src/engine/exporter.ts`).
    - Rasters inside animations are up to zoom× larger per side than needed. Pixels on screen are correct.
    - This is why `test/engine/drawings.test.ts` "stay sharp under a camera zoom" checks `steepestEdge`, not bytes.
  - **`tsconfig.node.json` includes `src/editor`, `src/main` and `test`** and has no DOM lib. Anything the resolver, editor or driver imports must not use `Path2D` or `OffscreenCanvas`. That is why `src/engine/curves.ts` exists, and why the driver can import `src/editor/timelineView.ts`.
  - **Electron `sendInputEvent` takes accelerator key names** (`'M'`, `']'`, `'['`, `'D'`), not `'KeyM'`.
  - `driver.savedProject()` (Save As) hangs when an animation is unsaved. Scenarios inside animations use `driver.menu('save')` and then `untilEdited(driver, false)`.
  - Relative media paths are computed from the folder as given (`/var/folders/...`). Don't `realpathSync` in tests.
  - `MIN_CANVAS` is 160x120.
  - Recovery write order: episode, then animation copies, then the manifest.
  - The `ARTBOARD` in `src/engine/resolve.test.ts` `describe('animation clips')` is 12 fps.
  - Known small gaps, not fixed:
    - A closed group inside an open animation uses unstepped time for its own transform.
    - Keyframes set while paused between animation frames land at unstepped times.
    - The readout keeps `aria-label="Timecode"` when it shows frames.
    - A new empty animation has duration 0.
  - Suspicion only: at speed ≠ 100%, `floor` in `animationTime` could pick the previous frame at an exact boundary because of `TIMELINE_GRID` rounding. Not observed.
  - Known behaviours by decision:
    - The shapes box refits during rotation.
    - A double-click picks only a direct child.
    - Shape-box snapping targets clips and the canvas, not other shapes (A-47).

## Files changed and to change

Changed in this batch (A-32–A-36), all uncommitted:

- **Shared:** `src/shared/project.ts`, `src/shared/project.test.ts`, `src/shared/mediaProtocol.ts`.
- **Editor:**
  - `src/editor/timelineView.ts` and its test
  - `src/editor/drawings.ts` and its test (both untracked from A-30; largely rewritten here)
  - **new** `src/editor/colors.ts` and `src/editor/colors.test.ts`
  - `src/editor/shortcuts.ts` and its test
- **Engine:** `src/engine/resolve.ts` (`shownShapes`), `src/engine/resolve.test.ts`.
- **Renderer:**
  - `store.ts` and `store.test.ts`
  - `timelineController.ts`, `timelineDraw.ts`, `Timeline.tsx`
  - `actions.ts`, `document.ts`, `Editor.tsx`
  - `CanvasOverlay.tsx`, `CanvasPanel.tsx`, `Properties.tsx`, `NumberField.tsx`
  - **new** `ColorFields.tsx`
  - `editor.css`, `controls.css`
- **Main:**
  - `src/main/main.ts` (Arrange submenu)
  - `src/main/uiDriver.ts` (rows-aware `timelinePoint`, re-exported constants)
  - `src/main/uiScenarios.ts` (`timelinePointInView`)
  - `src/main/uiTest.ts` (helpers and two scenarios)
- **Tests:** `test/editor/features.test.ts` (two tests and fixtures); `test/engine/drawings.test.ts` (builders take `NEW_SHAPE_STYLE`).
- **Docs:** `AGENTS.md` §3; `HANDOFF.md` (this file).

Changed in earlier batches (A-01–A-31, also uncommitted): about 80 more files. `git status --short` lists them. They are described in `AGENTS.md` tickets A-01–A-31 and in the memory notes `animation-files-a01-a26-2026-10-26.md` and `drawing-shapes-a27-a31-2026-10-27.md`. The `mockups/animation-*` files are staged and are not code.

To change: nothing pending. Items 2–4 in Remaining need the user's go.

## Files with useful context

- `AGENTS.md`:
  - §1–2: spec and model.
  - §3: decisions (lines 62–113).
  - §4: code map (line 115).
  - §5: tickets (line 134); group 3 Shapes starts at line 213, and A-37 is at line 245.
- Plans:
  - `/Users/localuser/.claude/plans/compiled-dazzling-lecun.md`: the approved A-32–A-36 plan.
  - `/Users/localuser/.claude/plans/glittery-sparking-sundae.md`: the approved A-27–A-31 plan.
  - `/Users/localuser/.claude/plans/splendid-finding-valley.md`: the approved A-01–A-26 plan.
- Transcripts in `/Users/localuser/.claude/projects/-Users-localuser-video-editor/`:
  - `7e79620e-6c7a-4d17-9353-0b7dc77f9e65.jsonl`: this session.
  - `f7d9b122-76a5-426b-87ac-076ec42147ae.jsonl`: A-27–A-31.
  - `f52dad3e-10c2-47dd-b1cf-cd0b7f3b5e1b.jsonl`: 2026-10-26.
- Memory, in `/Users/localuser/.claude/projects/-Users-localuser-video-editor/memory/`:
  - `MEMORY.md` (the index)
  - `shape-rows-colour-a32-a36-2026-10-27.md`
  - `drawing-shapes-a27-a31-2026-10-27.md`
  - `animation-files-a01-a26-2026-10-26.md`
  - `animation-workspace-decisions-2026-10-26.md`
  - `isolate-electron-test-profile.md`
  - `orphaned-test-apps.md`
  - `latency-budgets-under-load.md`
  - `no-assumed-features.md`
  - `minimal-comments.md`
  - `ui-controls-style-decisions.md`
- User rules: `/Users/localuser/.claude/rules/global-standards.md`, `planning.md`, `typescript-standards.md`.
- Patterns to copy:
  - `src/editor/drawings.ts` `editDrawings`/`editSiblings`/`editEachShape`: the way to edit shapes by ref. `src/editor/drawings.ts:117` `drawingPlace`: where new shapes go.
  - `src/renderer/ColorFields.tsx` `useAreaDrag` and the begin/update/commit gesture, for A-40's sliders. `NumberField` `track` prop.
  - `src/renderer/Timeline.tsx:58` `ShapeRows`: row press/drag/rename, for A-41 and A-54.
  - `src/renderer/timelineDraw.ts:461` `drawShapeLanes`: where A-54 keys go.
  - `src/main/uiTest.ts:513-640`: shape scenarios and helpers. `test/editor/features.test.ts:321` `writeEpisode(directory, tracksBelow)`, and `:398` `shapesDrawing()`.
- Visual reference: `mockups/animation-v3/` (`views.js` `colourPanel` at line 71, layer rows at line 120, `screens/01-shapes.png`).

## How to run and check

From `/Users/localuser/video-editor`:

| Command | What it does | Last result (2026-10-27, after the last edit) |
| --- | --- | --- |
| `npm run typecheck` | tsc with `tsconfig.json` and `tsconfig.node.json` | Clean |
| `npm run lint` | `knip && jscpd`, threshold 0 | Clean, 0 clones |
| `npm run test:unit` | `vitest run src`, about 14 s | 54 files, 1075 passed |
| `npm run build` | FFmpeg check, tsc, vite | OK. Needed before any `test/engine` or `test/editor` run, because those drive the built app |
| `npm test` | All of the above, then `vitest run test/engine test/editor --no-file-parallelism` | All passed: 19 files, 365 tests, 816 s for the last part (about 14 min in total) |

Targeted runs, after `npm run build`:

```sh
npx vitest run test/editor/features.test.ts -t "shape|clipped child" --no-file-parallelism   # shape-rows, shape-edits, drawing-tools: 3 passed
npx vitest run test/editor/tokens.test.ts src/renderer/store.test.ts                          # passed
npx vitest run test/engine/drawings.test.ts --no-file-parallelism
npx vitest run test/engine/parity.test.ts -t "26-animation" --no-file-parallelism
```

To hand-run a scenario and get its screenshots, use **a scratch profile only**; the default profile holds the user's real work:

```sh
S=/private/tmp/claude-501/-Users-localuser-video-editor/7e79620e-6c7a-4d17-9353-0b7dc77f9e65/scratchpad
rm -rf $S/ui && node $S/write-episode.mjs $S/ui && mkdir -p $S/ui/profile
"$(node -e "console.log(require('electron'))")" . --user-data-dir=$S/ui/profile --uitest shape-edits --project $S/ui/episode.json --out $S/ui
```

- `shape-rows` writes `shape-rows.png`.
- `shape-edits` writes `shape-colours.png` and `shape-edits.png`.
- The last stdout line is the JSON report.
- If the scratchpad is gone, rebuild the fixture as `writeEpisode(directory, [[shapesDrawing()]])` does in `test/editor/features.test.ts`. Ticks are `TICKS_PER_SECOND = 24_000_000`.

Goldens: run the test with `UPDATE_GOLDEN=1`, then check the PNG by eye.

## Other information

- **The user's standing rules** (instructions and memory):
  - Never commit unless asked; the user commits.
  - Build only what was asked, and name every forced side change so the user can veto it. Record build-time decisions in `AGENTS.md` §3 "Made in this plan".
  - No new dependencies, abstractions or files unless needed.
  - Minimal comments (non-obvious why only).
  - Early returns.
  - TypeScript rules in `typescript-standards.md`: no casts, no `!`, `unknown` over `any`, loops over long chains, named functions.
  - UI rules: one field per row with the label above, units in brackets, tokens only, no hex in renderer files, in-house pickers, terse copy.
  - Never do database changes.
  - Plans use the `planning.md` structure.
  - Concise chat replies.
  - Subagents run on Haiku; no forks.
  - Hand-run Electron only with a scratch `--user-data-dir`.
  - After a vitest timeout, kill orphaned test apps whose parent PID is 1.
  - Rerun a latency failure alone before treating it as a regression.
  - Don't send the user's email anywhere.
- **Processes:** none from this session are running. `ps` at the end showed no electron or vitest test processes, only unrelated Slack and Cursor helpers.
- **Scratch files** (not in the repo; can be deleted), in `/private/tmp/claude-501/-Users-localuser-video-editor/7e79620e-6c7a-4d17-9353-0b7dc77f9e65/scratchpad/`:
  - `npm-test.log`: the first full run, with 1 tokens failure.
  - `npm-test-2.log`: the second full run, all passed.
  - `write-episode.mjs`: the fixture generator.
  - `ui/`: card, episode, profile, `shape-rows.png`, `panel.png`.
- **Already reported to the user** at the end of the build:
  - what was built
  - the colour-field change
  - the veto list
  - the forced side changes: driver re-exports, `timelinePointInView`, the `drawing-tools` query, the `addDrawingShapes` and `withoutUnpickableShapes` renames, the new screenshot
  - the passing full test result
  - that nothing is committed
- **Dates:**
  - A-01–A-26 were built 2026-10-26.
  - A-27–A-31 were built 2026-10-27 in the morning.
  - A-32–A-36 were built 2026-10-27, with the final test run at 14:26–14:40 local.
