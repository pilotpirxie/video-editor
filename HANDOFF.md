# Handoff: animation workspace, A-59–A-63 (2026-11-03)

## Status

The task is the animation workspace specified in `AGENTS.md`, built ticket by ticket on branch `feature/animations`. Group 6 (`AGENTS.md` §5, A-59–A-63) is complete.

Nothing from this session is committed. The user committed A-43–A-58 themselves as `b20f0ba` on 2026-11-02, so the working tree holds only A-59–A-63 and this file.

The last full `npm test` ran after the last code edit (2026-11-02 23:58 to 2026-11-03 00:13 CET). It exited 0: unit 1176/1176, engine and editor 385/385, typecheck clean, lint 0 clones, build OK.

The next action is to wait for the user. The next ticket is A-64 Pencil stroke capture, the first of group 7.

## Original prompt

1. > '/Users/localuser/video-editor/HANDOFF.md''/Users/localuser/video-editor/AGENTS.md' what is next?

   Answered: A-59 Hold frame, and asked whether to commit first. The user didn't answer that question.
2. > ok so please focus now on 59-63

   Plan mode was entered and three questions were asked:
   - "When you open a held clip (say a Mouths clip holding frame 3), what should the canvas and timeline show?" Answer: **"All frames (Recommended)"**.
   - "Where should the frame thumbnails for Hold frame go?" Answer: **"Grid in Timing (Recommended)"**.
   - "If the animation has unsaved edits when you press Make Unique, what should the copy contain?" Answer: **"What's on screen (Recommended)"**.

   The plan was approved through ExitPlanMode. It is at `/Users/localuser/.claude/plans/tingly-beaming-magpie.md`.

## Decisions

All are in `AGENTS.md` §3, at the end of the "Made in this plan" list, and all but the three above are the assistant's, open to veto:
- A held clip stores `heldTime` in ticks. It has no sound and ignores speed, Loop and source offset, which Timing hides. Split and trims keep it.
- Hold frame starts on what the clip shows at the playhead, or its first frame from elsewhere. Back to Play shortens the clip to the cap. A held frame past the animation's end shows nothing.
- Playing inside an opened held clip plays the episode's sound from the clip's start.
- Make Unique needs one unlocked animation clip selected, and is one undo step.
- A reload removes that file from undo. Keep Mine is the prompt's default and isn't asked again for that version. A change that only moves media paths isn't treated as a change.
- Pasted shapes bring their node sets into any drawing that lacks them, in the same file too; this replaced an earlier §3 line. A file's own swatch colour wins on paste. Clipboards stay per window.

## Where the work left the plan

| Plan said | What was done | Why |
| --- | --- | --- |
| A new `resolveOpenFrame` | An optional `holds` parameter on `resolveFrame` | Smaller; one entry point |
| A golden showing a held clip equal to the played frame | `test/engine/animations.test.ts` compares the held frames, paused and exported, byte for byte with the played frame | Stronger, and adds no PNG |
| The first window saves while the second takes it in | The second window saves and the first takes it in | `driver.menu` acts on the newest window |

## Findings

- **Held clips:**
  - `animationTime` in `src/engine/resolve.ts` is the one place that picks the time shown.
  - An open held clip is a `HeldLevel` in `Scope.holds`, from `resolveScope` in `src/editor/groups.ts`. `resolveFrame(..., holds)` draws the world at the innermost hold's `offset` and overrides the held time on the open path, matched against `frame.groups`. Export never passes holds.
  - `sendFocus` runs synchronously from the store subscription, because the engine's `timeLimit` must be set before a seek past the episode's end.
  - While a clip is held open, `frameStartNear` doesn't snap to the episode's frames, so a 12 fps Mouths in a 30 fps episode reaches odd frames. Played clips still have the older gap there.
- **Known limit:** if a played parent is trimmed so that its first pass never shows the held clip, the held clip's world time falls outside the parent and the canvas shows nothing from it. Played clips have the same limit.
- **Outside changes:**
  - There is one route: `src/main/animationWatch.ts` watches folders, main sends `animation-changed` to each editor listing the path, and `reloadAnimation` in `src/renderer/document.ts` compares contents. A window's own save ends there as "already the same".
  - A file deleted or broken on disk leaves the window's copy, with a notice.
- **Not exercised by hand:** the native Keep Mine / Use Saved dialog. Tests answer it through `dialogAnswers.animationChanged`.
- **UI scenario quirks:**
  - The `animation-open` button sits in a second group titled "Animation", folded at launch, sharing the `group-animation` test id with the presets group. Scenarios click the last one. This predates the session.
  - Zoom to fit shows at least 10 s, so a short animation's clips look small after opening. This also predates the session.
- **Carried over from earlier handoffs:**
  - The camera zoom is counted twice for drawn layers inside animations, and rasters come out larger than needed (`src/engine/resolve.ts`, `animationFrame`). The user hasn't decided whether to fix it.
  - `driver.picture` taken right after a DOM wait can show the previous frame.
  - A latency or playback test failing in a full run should be rerun alone first.

## Files changed

- **New:** `src/main/animationWatch.ts`, `src/main/animationWatch.test.ts`.
- **Format and protocol:** `src/shared/project.ts` (`heldTime`), `src/shared/mediaProtocol.ts`.
- **Engine:** `src/engine/resolve.ts`, `engine.ts`, `mixer.ts`.
- **Editor:** `src/editor/clips.ts` (`isHeld`), `moveTrim.ts`, `split.ts`, `properties.ts`, `groups.ts`, `history.ts` (`withoutDocument`), `drawings.ts`, `clipboard.ts`, `place.ts`.
- **Renderer:** `src/renderer/Properties.tsx` (`HeldFramePicker`), `Timeline.tsx`, `CanvasOverlay.tsx`, `MediaTab.tsx`, `context.ts` (`useThumbnailUpdates`), `thumbnails.ts`, `actions.ts`, `transport.ts`, `document.ts` (`makeUnique`, `reloadAnimation`), `store.ts`, `engineWorker.ts`, `mediaClient.ts`, `controls.css`.
- **Main and media:** `src/main/main.ts`, `preload.cts`, `uiDriver.ts`, `src/media/mediaStore.ts`, `projectFile.ts`, `service.ts`.
- **Tests:**
  - unit tests next to the modules;
  - UI scenarios `hold-frame`, `shared-parts`, `make-unique`, `animation-reload` and `paste-between` in `src/main/uiTest.ts`, with their tests in `test/editor/features.test.ts`;
  - `test/engine/animations.test.ts`;
  - a held clip in `test/projects/26-animation.json`.
- **Docs:** `AGENTS.md` §3 and §4, this file.

## How to run and check

From `/Users/localuser/video-editor`:

```sh
npm run typecheck
npm run lint
npm run test:unit
npm run build   # needed before test/engine or test/editor runs
npm test        # all of the above, about 15 minutes
npx vitest run test/editor/features.test.ts -t "holds a frame of an animation|opens a shared part|makes one clip|takes in an animation|pastes shapes and drawings" --no-file-parallelism
```

To hand-run a scenario, use **a scratch profile only**, because the default profile holds the user's real work. Use a new folder per run. `write-mouths.mjs` writes the fixture, with `hold` or `shared` as its mode:

```sh
S=/private/tmp/claude-501/-Users-localuser-video-editor/7ae2700b-8ab4-4f7d-9791-a3d60204424f/scratchpad
node $S/write-mouths.mjs $S/run-1 shared && mkdir -p $S/run-1/profile
"$(node -e "console.log(require('electron'))")" . --user-data-dir=$S/run-1/profile --uitest shared-parts --project $S/run-1/episode.json --out $S/run-1
```

## Other information

- **Standing rules:** commit only when asked; build only what was asked and name forced side changes; record build-time decisions in `AGENTS.md` §3; plans follow `/Users/localuser/.claude/rules/planning.md`; hand-run Electron only with a scratch `--user-data-dir`.
- **Processes:** none left running; a check after the full run found no orphaned test apps.
- **Memory:** `/Users/localuser/.claude/projects/-Users-localuser-video-editor/memory/reuse-composition-a59-a63-2026-11-02.md`.
- **Not removed:** the scratch folders above, which can be deleted. A safety check blocked a clean-up command in this session, so every run used a new folder instead.
