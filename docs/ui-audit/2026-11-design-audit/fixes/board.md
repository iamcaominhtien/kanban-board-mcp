# Wave 3 — board area (comp-1, comp-2, board)

Before/after screenshots (JPEG, `*-before.jpg` from 5174, `*-after.jpg` from 5173):
`/tmp/claude-0/-home-user-kanban-board-mcp/217c9eaa-a832-52d5-8a05-ade5a07b6b57/scratchpad/w3/board/`
(scripts `shots.cjs` and `tc.cjs` in the same folder). Low findings are left for wave 4 unless a fix came with a
Medium or High one.

## comp-1

- TT-1 · Fixed (wave 4, in part): the five palette colours (#2e6f40, #1e2a22, #5b6b60, #dce6df, #68ba7f) are now `var(--color-forest)`, `--color-text-pri`, `--color-text-sec`, `--color-border`, `--color-sage` in 431 places of the module CSS in my files (same values, no visual change). The type scale classes are not adopted: 40 odd sizes cannot be mapped to 7 classes without changing how screens look
- TT-2 · Fixed (wave 4): the undefined `--color-orange` is `var(--color-inprogress)` (`WorkLogSection.module.css`)
- TT-3 · Fixed (wave 4, in part): every 8, 9 and 9.5 px text in my files is 10 px (`ActivitySection`, `DebugSpaceSection`, `FileAttachmentCard`, `TestCasesSection`, `TicketModal`, `ProjectSidebar` CSS). Left: 7 to 9.5 px in `ai/` and `aiteam/` CSS, not mine (`workflow.css:115`, `evidence.css`, `talk.css`, `ticketWork.css`, `flowScope.css`)
- TT-4 · Skipped (Low; `index.css` is shared, not mine)
- TC-1 · Already fixed (wave 2)
- TC-2 · Fixed: the "…" button shows only on hover, focus-within or with its menu open, and the ID sits flush right at rest (the 28 px margin only while the button shows); the button is keyboard reachable (`TicketCard.tsx`, `TicketCard.module.css`)
- TC-3 · Fixed: the footer shows the criteria count "2/3" after the estimate (`TicketCard.tsx`)
- TC-4 · Fixed: "Due Oct 30" (`TicketCard.tsx`)
- TC-5 · Fixed by TC-2: the button no longer sits under the lock badge at rest
- TS-1 · Fixed: padding 16, radius 14, gap 12, 32 px badge, title 14/600, detail 13, close in 22 px, container 380 (`Toast.module.css`, `Toast.tsx`)
- TS-2 · Fixed with TS-1: Mint/#FBE7E4/#FCEFD9 badges, "!" mark in #B4791E, border #DCE6DF, shadow 0 10px 24px .10, × #B7C4BC
- TS-3 · Fixed: a failed move shows only the toast; the red banner stays for errors with no toast, now drawn over the page (design #C4432A, radius 8) so it no longer pushes the board down (`App.tsx`)
- TS-4 · Skipped: the raw server message is kept as the detail; it carries the reason a move was refused (criteria or test cases not done), which the generic line would hide
- TS-5 · Skipped: the app has no sync state to show, and a fixed "Board synced" line would be fixed text standing in for live data
- LD-1 · Already fixed (wave 1)
- LD-2 · Skipped (Low; `LoadingStates` is not in my files)
- TG-1 · Fixed: removable pills use `TagPill size="large"` (12/600, lowercase); "+ Add tag" is 12/600 sentence case (`TicketModal.tsx`, `TagPicker.tsx`)
- TG-2 · Fixed: new `TagPicker` popover: search field, the project's existing tags ("perf · existing tag", click to attach), a Create "…" row, Enter/arrows, comma commits and keeps it open, Esc closes without adding (`TagPicker.tsx`, `TicketModal.tsx`; test `TagPicker.test.tsx`)
- TG-3 · Already fixed (wave 1; the picker keeps the behaviour)
- TG-4 · Fixed (wave 4): a removable tag pill darkens its tint on hover (`TagPill.module.css`)
- BG-1 · Fixed: pointing at (or focusing) a parent shows its group (1.6 px green ring on the parent and its sub-tickets, dashed #68BA7F connectors to sub-tickets in other columns, a #9BB3A4 elbow to the indented one); a click still opens the ticket at once (the design's click-to-select would have made opening a parent take two clicks); leaving the card or a drag clears it (`Board.tsx`, `Column.tsx`, `DraggableTicketCard.tsx`, new `ParentGroupLinks.tsx`, `TicketCard.module.css`)
- DD-1 · Fixed: the lifted card takes the source card's measured width (`Board.tsx`)
- DD-2 · Fixed: the source ghost takes the card's measured height (`DraggableTicketCard.tsx`)
- DD-3 · Fixed: pick-up keyframes (150 ms ease-out, scale 1.03, lift 4 px, 1.5° tilt, 97 % opacity, larger shadow; reduced-motion respected) and a custom drop animation (overshoot to 1.05, rest in 220 ms) (`TicketCard.module.css`, `Board.tsx`)
- DD-4 · Fixed (wave 4): the column outline while dragging over is gone; the target slot is the dashed slot with no text for a plain move. The reopen and pending slots keep their hint text (`Board.module.css`, `Column.tsx`)
- SM-1 · Fixed (wave 4): one status is one colour. The status menu dots use the board's column accents (Backlog #9AA8A0, To Do #2F6FB0, In Progress #E2793D, Done #68BA7F), as the doc text says; the image's grey and blue lose (`StatusMenu.tsx`)
- AS-1 · Already fixed (wave 2, one focus ring)
- AS-2 · Fixed (wave 4): each result of "Link existing" starts with a 7 px status dot, filled for In Progress, outline otherwise (`SubTicketsSection.tsx`, `.module.css`)
- AC-1 · Already fixed (wave 1)
- AC-2 · Fixed (wave 4): the inline Markdown span of a criterion inherits size, line height and colour, so a criterion is 13 px and a done row is grey with its light strike (`MarkdownRenderer.tsx`)

## comp-2

- TD-1 · Skipped: the AI buttons (`RunHeaderButton`, `TicketAiMenu`) are in `ai/RunPanel.tsx` and `assist/TicketAi.tsx`, not my files
- TD-2 · Skipped: sub-tasks are checklist items (`id, text, done`) with no ticket id to show; needs a data model change
- TD-3 · Fixed (wave 4): the checkbox is 2 px lower, centred on the first line of the (now 13 px) text (`AcceptanceCriteriaSection.module.css`)
- TD-4 · Fixed: comments default to oldest first with the composer under the thread (same fix as board CM-1)
- TD-5 · Fixed (wave 4): the attachments zone drops its own top border; the one divider above it stays (`TicketModal.module.css`)
- TD-6 · Already fixed (wave 2: the native selects are drawn as the design's field)
- TDP-1 · Partly fixed (UI): the wave badge is a button (green ring on hover, blue halo while open) that opens the popover: WAVE, − n + stepper, "Auto-set from Blocked by", shown read-only (wave from Blocked by, controls disabled). Pinning a wave by hand needs a server field, so it is not offered (`SubTicketsSection.tsx`; test `SubTicketsSection.wave.test.tsx`)
- TDP-2 · Fixed: a parent with no estimate shows "8 pt (rolled up)" from its sub-tickets (`TicketModal.tsx`)
- DM-1 · Already fixed (wave 1)
- DM-2 · Already fixed (wave 2: callouts use line icons); whether a bold "Heads up:" lead becomes a callout is a design decision, not changed
- DM-3 · Fixed (wave 4): the tooltips read "Attach file (Excel, Word, PowerPoint, PDF, JSON, TXT, Zip...)" and "Insert image" (`MarkdownEditor.tsx`)
- ATT-1 · Fixed: a file linked from Markdown shows its size, asked of `/upload-info` (`TicketModal.tsx`); the per-type tint is in the shared `utils/fileIcons.ts` (done in wave 4, see Wave 4 leftovers)
- ATT-2 · Skipped (Low; the design contradicts itself)
- ATT-3 · Fixed: while a description upload runs, the zone shows a pulsing placeholder thumbnail (image) or the file name with a thin moving bar (other files) (`TicketModal.tsx`, `TicketModal.module.css`)
- REL-1 · Skipped: hiding the remove "×" until row hover makes a one-click action hover-only (no touch, no keyboard path) which the wave-4 rules forbid. It already turns red on hover
- BR-1 · Skipped (per brief: lane graph)
- BR-2 · Already fixed (wave 1)
- BR-3 · Fixed: Create branch opens as a popover card under its button (no dimming), rendered in the page body; the worktree option stays (`CreateBranchModal.tsx`, `BranchesSection.tsx`)
- BR-4 · Fixed: the list starts with the baseline row, there is one Create branch (top), Checkout and Rename moved into a "…" row menu; Merge/Archive and delete stay (`BranchesSection.tsx`)
- BR-5 · Skipped: the dot in the graph's legend is the lane colour that keys the branch to its lane in the graph (the lane graph is out of scope); making it the status colour would lose that key
- TC-1 · Fixed (display): the row avatar is the member's own (`MemberAvatar`, matched by id or name); unassigned shows a dashed circle instead of "QA". An assignee picker is not built (`TestCasesSection.tsx`)
- TC-2 · Skipped: merging "Result and proof" into Notes drops a stored field, and per-field attachments need new fields on the server
- TC-3 · Fixed (wave 4): group titles are sentence case 12/600, and a child with no test cases at all is not listed while "Show: All" (its 0 is in the Show menu) (`TestCasesSection.tsx`, `.module.css`)
- TC-4 · Skipped: dropping the description field removes the way to write a description while adding; the editor stays
- TC-5 · Fixed (wave 4): "Suggest cases" sits next to "Add test case" on the right, the count label on the left (`TestCasesSection.tsx`)
- DS-1 · Fixed (wave 4): chips and kind choices run Root cause, Investigation, Fix attempt, Blocked, Resolved; the form still starts on Investigation (`DebugSpaceSection.tsx`)
- DS-2 · Fixed (wave 4): a pinned note is drawn with the inline Markdown renderer (code style and bold kept, no stray spaces) instead of stripped text (`DebugSpaceSection.tsx`)
- DS-3 · Fixed: the note field has the compact toolbar (B, i, code, link) and the MARKDOWN label; the buttons wrap the selection; the textarea, its AI and `KAN-` suggester are kept (`DebugSpaceSection.tsx`)
- DS-4 · Fixed (wave 4, in part): the name is prefilled with the saved author, else the current person. The two link selects stay in the form (moving them to the saved card would add a step) but are now in the body font, not mono (`DebugSpaceSection.tsx`, `.module.css`)
- WS-1 · Fixed: the Retention Policy band is gone; the retention chip opens the menu (THIS TASK'S RETENTION, checked list: workspace default, 7, 14, 30 days, Keep forever, helper text); ideas keep their three choices (`WorkspaceSection.tsx`)
- WS-2 · Fixed: tooltip "Workspace — 2 files · 4.1 KB" (`TicketModal.tsx`)
- WS-3 · Fixed: with the workspace off, the tab stays and shows "Workspace isn't set up yet", the helper text and Open Settings (Settings › Storage › Workspace) (`TicketModal.tsx`, `App.tsx`)
- WS-4 · Fixed (wave 4, in part): the path shows `~` for the home folder (title and Copy keep the real path), folder rows show "N files", file icons take the design's tint per type (image orange, JSON blue, video purple, log grey). Not done: the read-only footer line (no wording in the design source)
- WS-5 · Fixed (wave 4, in part): an existing empty folder shows the dashed box with the folder icon and "No files yet. The folder exists, nothing has been written to it yet.", the old hint (Drop files, Upload, agent path) stays under it. The no-folder state is unchanged (the design does not draw it)
- WS-6 · Skipped (Low; `settings/` is not in my files)
- NT-1 · Fixed: Assignee is a `MenuSelect` button (dashed avatar "Unassigned", member avatars) (`TicketModal.tsx`)
- NT-2 · Fixed: Tags field ("frontend, bug, phase-2…") with pill preview, and Start Date beside Due Date; both are saved on create (`TicketModal.tsx`)
- NT-3 · Fixed: priority dot chips Low → Critical on their own line, Assignee on the right, Estimate on its own row
- NT-4 · Fixed: the boxed editor with its compact toolbar shows at rest (new `focusOnMount` prop so the title keeps the focus) (`TicketModal.tsx`, `MarkdownEditor.tsx`)
- NT-5 · Fixed: the "—" (no estimate) button
- ACT-1 · Fixed (wave 4): work-log entries are labelled "Debug" and the chip draws the Markdown (`ActivitySection.tsx`)
- ACT-2 · Fixed (wave 4, in part): "1 change" / "N changes" and "Show 1 earlier change" are singular when they are. The empty text keeps the current wording, which names more (comments, test cases, links, branches) than the design's line
- ACT-3 · Skipped: the default view draws doc references as pills (`RefLine`), so a word-level mark would have to cut through the reference segments; a large change for a Low row
- AM-1 · Skipped (per brief: account menu)
- AM-2 · Skipped (accounts: no sign-out or session flow)

## board

- MB-1 · Already fixed (wave 1)
- MB-2 · Fixed (wave 4, in part): the column gap is 18 px (the minimum column width follows). The header keeps its 6 px side padding so it lines up with the cards, whose body padding the drag ring needs (`Board.module.css`)
MB-3 · Skipped — folding the filters into one menu would add a click to each; the three stay on the bar
- MB-4 · Fixed: the Type menu has the 15 px type icon per row, and the trigger shows the chosen type's icon (`FilterBar.tsx`)
- MB-5 · Fixed: the blocked-drag confirmation is the design's card (16 px line triangle #B4791E, 1.5 px #E8B93A border, radius 10, filled Move Anyway, outlined Cancel, shadow) shown over the board under the filter bar, so the header stays usable (`App.tsx`, `Board.tsx`, `Board.module.css`)
- MB-6 · Fixed with MB-4: the Assignee trigger shows the chosen member's avatar; the menu uses the 20 px tinted `MemberAvatar` (`FilterBar.tsx`)
- MB-7 · Fixed (wave 4): title 21 px with no letter spacing, active view button 600 (`Board.module.css`)
- LV-1 · Fixed: a KEY · TITLE · PRIORITY · DUE · STATUS header row per group and the 20 px assignee avatar (dashed when unassigned) before the priority chip (`ListView.tsx`, `ListView.module.css`)
- LV-2 · Fixed (wave 4): the sort trigger reads "⇅ Sort: Due date" in one button; Most reopened, Pending first and Longest pending carry the reopen, pause and clock icons; all seven options and the default stay (`ListView.tsx`)
- TV-1 · Fixed (wave 4): a bar narrower than 40 px prints no label (the ID is in its tooltip) (`TimelineView.tsx`)
- TV-2 · Already fixed (wave 1)
- TV-3 · Fixed (wave 4): while a bar is resized a dashed outline marks where it started and the bar has the raised shadow (`TimelineView.tsx`, `.module.css`)
- TV-4 · Already fixed (wave 1)
- TV-5 · Fixed (wave 4): times are "4:12 PM" (`TimelineView.tsx`)
- DR-1 · Skipped (Low; `docs/` is not in my files)
- DR-2 · Skipped (Low; `docs/` is not in my files)
- DR-3 · Skipped (Low; `docs/` is not in my files)
- DR-4 · Skipped (Low; `docs/` is not in my files)
- CM-1 · Fixed: oldest first by default, composer at the end; the toggle and its remembered choice stay (`CommentsSection.tsx`)
- CM-2 · Already fixed (wave 1)
- CM-3 · Already fixed (wave 1)
- RO-1 · Fixed: the type label no longer shrinks (the chips collapse first) and the 28 px margin is gone at rest (`TicketCard.module.css`)
- RO-2 · Fixed (wave 4): after a reopen the To Do header shows "+1" and the source lane "−1 (was N)" for 8 s, and it clears at once on Undo (it is tied to where the ticket is now) (`App.tsx`, `Board.tsx`, `Column.tsx`)
- RO-3 · Fixed in part: the drop popover hangs under the drop slot of the column the card was dropped on and has the 32 px amber reopen tile (`App.tsx`, `ReopenDropPopover.tsx`, `Column.tsx`). Not done: showing the card tinted in the target column and the "is being moved" caption in the source ghost (the card snaps back before the confirm, so there is no ghost left to label)
- RO-4 · Fixed (wave 4): the Undo action of a toast is the light green tinted button with the undo icon (`Toast.tsx`, `.module.css`). The quiet-line Undo link is unchanged
- PD-1 · Fixed: the pause chip in the header shows only when the card is also Reopened; a pending card alone has the rail and the "Waiting on" strip (`TicketCard.tsx`)
- PD-2 · Fixed (wave 4): the "pending" word shows down to a 180 px header (`Board.module.css`)
- AT-1 · Skipped (Low; `ai/AssigneePicker.tsx` is not in my files)
- AT-2 · Already fixed (wave 1)
- AT-3 · Already fixed (wave 2, glyphs to line icons)

## Wave 4 leftovers (rows taken from other areas)

- AB-6 (ai) · Already fixed: `TicketCard.module.css` has no `min-height` since wave 3 (comp-1 TC-1); a card fits its content
- TP-12 (ai) · Fixed (wave 4): the board card step chip is red (#FBE7E4, border #F2C4BA, text #C4432A) with "· blocked" when an AI step's role has no member (`step_kind` ai, a role, no holder) or the workflow state is blocked; the tooltip says why. Waiting-for-you keeps its amber (`workflowBoard/WorkflowBoardContext.tsx`)
- WY-3 (ai) · Fixed (wave 4, in part): the comment box shows each picked AI as a purple "✦ Name" pill beside "N AI mentioned", and Comment has the send icon (`comments/Composer.tsx`). The text box itself is a plain textarea, so the mention stays "@Reviewer" inside it; pills in the box would need a rich editor
- AB-3 remainder (ai) · Fixed (wave 4): the minimum column width is 176 px (was 200), so six columns fit at 1440 px with the sidebar open and the board no longer scrolls sideways (measured: scroll width = client width); the dock still scrolls the board when it is wider than the room (`Board.module.css`)
- TP-11 remainder (ai) · Fixed (wave 4, in part): a ticket that is on a workflow shows the step tile strip on the Ticket view, under the title and tags (one instance, same component, so notes, Skip, Change workflow, Who did what and Review depth come with it). A ticket with no workflow keeps "Put on a workflow" in the AI activity view. Not done: the "Who did what" list beside the assignee in the side column (it stays under the strip) (`TicketModal.tsx`)
- AL-1 (app) · Fixed (wave 4, in part): while tickets load the filter bar is dimmed and inert, like it already was while projects load, so it is not clickable before its data is there. Lane counts from the lane response: not done, there is no lane-count endpoint (needs a server field); the count pill stays a skeleton (`Board.tsx`)
- PV-1 (app) · Fixed (wave 4, in part): the file card of a description shows the file size, asked of `/upload-info` once per file (no query provider needed, so the Markdown renderer works anywhere). Not done: page, sheet or archive thumbnails; they need server-made previews (`FileAttachmentCard.tsx`)
- PT-2 (app) · Fixed (wave 4): `utils/fileIcons.tsx` labels CSV, TSV, Markdown, HTML, Audio and Video by name instead of "Excel Spreadsheet", "Plain Text", "Source Code", "Media"
- NT-4 (app) · Skipped: the Board owns the top bar and the filter bar, so putting All notifications below the top bar needs a page slot in `Board` that hides the filter bar and sends the view tabs back out, plus keeping the page's own bell and Back/Esc keys. That is a shell restructure, and a half version would lose a path
- ATT-1 (board) · Fixed (wave 4): file types have the design's tints in `utils/fileIcons.tsx` (PDF and JSON blue #E1EEFB/#2F6FB0, image orange #FBE9E1/#B4571F, video and audio purple #E6E9F5/#5B5FA8, archive #F3EFEA/#8A7355, text and code grey #F1F3F1/#5B6B60, spreadsheet green, Word blue, slides orange). Applies to the attachment chips, the description file cards and the workspace list

## Wave 4 checks

Screenshots (JPEG, `*-before.jpg` from 5174, `*-after.jpg` from 5173): `/tmp/claude-0/-home-user-kanban-board-mcp/217c9eaa-a832-52d5-8a05-ade5a07b6b57/scratchpad/w4/board/`.
`npx tsc --noEmit -p .` clean, eslint 0 errors on my files, prettier clean, `npx vitest run` 140 of 141 files pass: the one
failure is `ai/packs/Packs.test.tsx` (another area's work in progress). No data was added or changed.

## Checks

`npx prettier --check` clean on the changed files, `npx tsc --noEmit -p .` clean, `npx eslint` 0 errors (6 old warnings in
`DebugSpaceSection.tsx` and `MarkdownEditor.tsx`), `npx vitest run` 133 files / 1076 tests passed. New tests:
`TagPicker.test.tsx` (4), `SubTicketsSection.wave.test.tsx` (1), one more in `WorkflowFilters.test.tsx`. No data was
changed: the drags in the screenshots were cancelled, and the failed move used a stubbed 500.
