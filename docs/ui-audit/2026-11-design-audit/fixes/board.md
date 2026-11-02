# Wave 3 — board area (comp-1, comp-2, board)

Before/after screenshots (JPEG, `*-before.jpg` from 5174, `*-after.jpg` from 5173):
`/tmp/claude-0/-home-user-kanban-board-mcp/217c9eaa-a832-52d5-8a05-ade5a07b6b57/scratchpad/w3/board/`
(scripts `shots.cjs` and `tc.cjs` in the same folder). Low findings are left for wave 4 unless a fix came with a
Medium or High one.

## comp-1

- TT-1 · Skipped (Low, wave 4)
- TT-2 · Skipped (Low, wave 4; `WorkLogSection.module.css`)
- TT-3 · Skipped (Low, wave 4)
- TT-4 · Skipped (Low; `index.css` is shared)
- TC-1 · Already fixed (wave 2)
- TC-2 · Fixed: the "…" button shows only on hover, focus-within or with its menu open, and the ID sits flush right at rest (the 28 px margin only while the button shows); the button is keyboard reachable (`TicketCard.tsx`, `TicketCard.module.css`)
- TC-3 · Fixed: the footer shows the criteria count "2/3" after the estimate (`TicketCard.tsx`)
- TC-4 · Fixed: "Due Oct 30" (`TicketCard.tsx`)
- TC-5 · Fixed by TC-2: the button no longer sits under the lock badge at rest
- TS-1 · Fixed: padding 16, radius 14, gap 12, 32 px badge, title 14/600, detail 13, close in 22 px, container 380 (`Toast.module.css`, `Toast.tsx`)
- TS-2 · Fixed with TS-1: Mint/#FBE7E4/#FCEFD9 badges, "!" mark in #B4791E, border #DCE6DF, shadow 0 10px 24px .10, × #B7C4BC
- TS-3 · Fixed: a failed move shows only the toast; the red banner stays for errors with no toast, now drawn over the page (design #C4432A, radius 8) so it no longer pushes the board down (`App.tsx`)
- TS-4 · Skipped: the raw server message is kept as the detail; it carries the reason a move was refused (criteria or test cases not done), which the generic line would hide
- TS-5 · Skipped (Low, wave 4)
- LD-1 · Already fixed (wave 1)
- LD-2 · Skipped (Low; `LoadingStates` belongs to another agent)
- TG-1 · Fixed: removable pills use `TagPill size="large"` (12/600, lowercase); "+ Add tag" is 12/600 sentence case (`TicketModal.tsx`, `TagPicker.tsx`)
- TG-2 · Fixed: new `TagPicker` popover: search field, the project's existing tags ("perf · existing tag", click to attach), a Create "…" row, Enter/arrows, comma commits and keeps it open, Esc closes without adding (`TagPicker.tsx`, `TicketModal.tsx`; test `TagPicker.test.tsx`)
- TG-3 · Already fixed (wave 1; the picker keeps the behaviour)
- TG-4 · Skipped (Low, wave 4)
- BG-1 · Fixed: pointing at (or focusing) a parent shows its group (1.6 px green ring on the parent and its sub-tickets, dashed #68BA7F connectors to sub-tickets in other columns, a #9BB3A4 elbow to the indented one); a click still opens the ticket at once (the design's click-to-select would have made opening a parent take two clicks); leaving the card or a drag clears it (`Board.tsx`, `Column.tsx`, `DraggableTicketCard.tsx`, new `ParentGroupLinks.tsx`, `TicketCard.module.css`)
- DD-1 · Fixed: the lifted card takes the source card's measured width (`Board.tsx`)
- DD-2 · Fixed: the source ghost takes the card's measured height (`DraggableTicketCard.tsx`)
- DD-3 · Fixed: pick-up keyframes (150 ms ease-out, scale 1.03, lift 4 px, 1.5° tilt, 97 % opacity, larger shadow; reduced-motion respected) and a custom drop animation (overshoot to 1.05, rest in 220 ms) (`TicketCard.module.css`, `Board.tsx`)
- DD-4 · Skipped (Low, wave 4)
- SM-1 · Skipped (design conflict to decide, Low)
- AS-1 · Already fixed (wave 2, one focus ring)
- AS-2 · Skipped (Low, wave 4)
- AC-1 · Already fixed (wave 1)
- AC-2 · Skipped (Low, wave 4)

## comp-2

- TD-1 · Skipped (Low, wave 4)
- TD-2 · Skipped: sub-tasks are checklist items (`id, text, done`) with no ticket id to show; needs a data model change
- TD-3 · Skipped (Low, wave 4)
- TD-4 · Fixed: comments default to oldest first with the composer under the thread (same fix as board CM-1)
- TD-5 · Skipped (Low, wave 4)
- TD-6 · Already fixed (wave 2: the native selects are drawn as the design's field)
- TDP-1 · Partly fixed (UI): the wave badge is a button (green ring on hover, blue halo while open) that opens the popover: WAVE, − n + stepper, "Auto-set from Blocked by", shown read-only (wave from Blocked by, controls disabled). Pinning a wave by hand needs a server field, so it is not offered (`SubTicketsSection.tsx`; test `SubTicketsSection.wave.test.tsx`)
- TDP-2 · Fixed: a parent with no estimate shows "8 pt (rolled up)" from its sub-tickets (`TicketModal.tsx`)
- DM-1 · Already fixed (wave 1)
- DM-2 · Already fixed (wave 2: callouts use line icons); whether a bold "Heads up:" lead becomes a callout is a design decision, not changed
- DM-3 · Skipped (Low, wave 4)
- ATT-1 · Fixed: a file linked from Markdown shows its size, asked of `/upload-info` (`TicketModal.tsx`); the per-type tint is in the shared `utils/fileIcons.ts`, not changed
- ATT-2 · Skipped (Low; the design contradicts itself)
- ATT-3 · Fixed: while a description upload runs, the zone shows a pulsing placeholder thumbnail (image) or the file name with a thin moving bar (other files) (`TicketModal.tsx`, `TicketModal.module.css`)
- REL-1 · Skipped (Low, wave 4)
- BR-1 · Skipped (per brief: lane graph)
- BR-2 · Already fixed (wave 1)
- BR-3 · Fixed: Create branch opens as a popover card under its button (no dimming), rendered in the page body; the worktree option stays (`CreateBranchModal.tsx`, `BranchesSection.tsx`)
- BR-4 · Fixed: the list starts with the baseline row, there is one Create branch (top), Checkout and Rename moved into a "…" row menu; Merge/Archive and delete stay (`BranchesSection.tsx`)
- BR-5 · Skipped (Low, wave 4)
- TC-1 · Fixed (display): the row avatar is the member's own (`MemberAvatar`, matched by id or name); unassigned shows a dashed circle instead of "QA". An assignee picker is not built (`TestCasesSection.tsx`)
- TC-2 · Skipped: merging "Result and proof" into Notes drops a stored field, and per-field attachments need new fields on the server
- TC-3 · Skipped (Low, wave 4)
- TC-4 · Skipped (Low, wave 4)
- TC-5 · Skipped (Low, wave 4)
- DS-1 · Skipped (Low, wave 4)
- DS-2 · Skipped (Low, wave 4)
- DS-3 · Fixed: the note field has the compact toolbar (B, i, code, link) and the MARKDOWN label; the buttons wrap the selection; the textarea, its AI and `KAN-` suggester are kept (`DebugSpaceSection.tsx`)
- DS-4 · Skipped (Low, wave 4)
- WS-1 · Fixed: the Retention Policy band is gone; the retention chip opens the menu (THIS TASK'S RETENTION, checked list: workspace default, 7, 14, 30 days, Keep forever, helper text); ideas keep their three choices (`WorkspaceSection.tsx`)
- WS-2 · Fixed: tooltip "Workspace — 2 files · 4.1 KB" (`TicketModal.tsx`)
- WS-3 · Fixed: with the workspace off, the tab stays and shows "Workspace isn't set up yet", the helper text and Open Settings (Settings › Storage › Workspace) (`TicketModal.tsx`, `App.tsx`)
- WS-4 · Skipped (Low, wave 4)
- WS-5 · Skipped (Low, wave 4)
- WS-6 · Skipped (Low; `settings/` is not in this area)
- NT-1 · Fixed: Assignee is a `MenuSelect` button (dashed avatar "Unassigned", member avatars) (`TicketModal.tsx`)
- NT-2 · Fixed: Tags field ("frontend, bug, phase-2…") with pill preview, and Start Date beside Due Date; both are saved on create (`TicketModal.tsx`)
- NT-3 · Fixed: priority dot chips Low → Critical on their own line, Assignee on the right, Estimate on its own row
- NT-4 · Fixed: the boxed editor with its compact toolbar shows at rest (new `focusOnMount` prop so the title keeps the focus) (`TicketModal.tsx`, `MarkdownEditor.tsx`)
- NT-5 · Fixed: the "—" (no estimate) button
- ACT-1 · Skipped (Low, wave 4)
- ACT-2 · Skipped (Low, wave 4)
- ACT-3 · Skipped (Low, wave 4)
- AM-1 · Skipped (per brief: account menu)
- AM-2 · Skipped (accounts: no sign-out or session flow)

## board

- MB-1 · Already fixed (wave 1)
- MB-2 · Skipped (Low, wave 4)
MB-3 · Skipped — folding the filters into one menu would add a click to each; the three stay on the bar
- MB-4 · Fixed: the Type menu has the 15 px type icon per row, and the trigger shows the chosen type's icon (`FilterBar.tsx`)
- MB-5 · Fixed: the blocked-drag confirmation is the design's card (16 px line triangle #B4791E, 1.5 px #E8B93A border, radius 10, filled Move Anyway, outlined Cancel, shadow) shown over the board under the filter bar, so the header stays usable (`App.tsx`, `Board.tsx`, `Board.module.css`)
- MB-6 · Fixed with MB-4: the Assignee trigger shows the chosen member's avatar; the menu uses the 20 px tinted `MemberAvatar` (`FilterBar.tsx`)
- MB-7 · Skipped (Low, wave 4)
- LV-1 · Fixed: a KEY · TITLE · PRIORITY · DUE · STATUS header row per group and the 20 px assignee avatar (dashed when unassigned) before the priority chip (`ListView.tsx`, `ListView.module.css`)
- LV-2 · Skipped (Low, wave 4)
- TV-1 · Skipped (Low, wave 4)
- TV-2 · Already fixed (wave 1)
- TV-3 · Skipped (Low, wave 4)
- TV-4 · Already fixed (wave 1)
- TV-5 · Skipped (Low, wave 4)
- DR-1 · Skipped (Low; `docs/` belongs to another agent)
- DR-2 · Skipped (Low; `docs/`)
- DR-3 · Skipped (Low; `docs/`)
- DR-4 · Skipped (Low; `docs/`)
- CM-1 · Fixed: oldest first by default, composer at the end; the toggle and its remembered choice stay (`CommentsSection.tsx`)
- CM-2 · Already fixed (wave 1)
- CM-3 · Already fixed (wave 1)
- RO-1 · Fixed: the type label no longer shrinks (the chips collapse first) and the 28 px margin is gone at rest (`TicketCard.module.css`)
- RO-2 · Skipped (Low, wave 4)
- RO-3 · Fixed in part: the drop popover hangs under the drop slot of the column the card was dropped on and has the 32 px amber reopen tile (`App.tsx`, `ReopenDropPopover.tsx`, `Column.tsx`). Not done: showing the card tinted in the target column and the "is being moved" caption in the source ghost (the card snaps back before the confirm, so there is no ghost left to label)
- RO-4 · Skipped (Low, wave 4)
- PD-1 · Fixed: the pause chip in the header shows only when the card is also Reopened; a pending card alone has the rail and the "Waiting on" strip (`TicketCard.tsx`)
- PD-2 · Skipped (Low, wave 4)
- AT-1 · Skipped (Low; `ai/` belongs to another agent)
- AT-2 · Already fixed (wave 1)
- AT-3 · Already fixed (wave 2, glyphs to line icons)

## Checks

`npx prettier --check` clean on the changed files, `npx tsc --noEmit -p .` clean, `npx eslint` 0 errors (6 old warnings in
`DebugSpaceSection.tsx` and `MarkdownEditor.tsx`), `npx vitest run` 133 files / 1076 tests passed. New tests:
`TagPicker.test.tsx` (4), `SubTicketsSection.wave.test.tsx` (1), one more in `WorkflowFilters.test.tsx`. No data was
changed: the drags in the screenshots were cancelled, and the failed move used a stubbed 500.
