# #269: ticket detail, 1:1 with the designs

I compared the ticket detail screens with `design/source/<Name>.dc.html`, section by section: markup, sizes, colours, type, icons, copy and states. The big boards (TicketComments, TicketDocRefs, TicketPending, TicketReopen) have no section comments, so their rows follow the lettered sections of `design/components/<name>.md`. Their board, list and timeline parts belong to the board agent, and those rows say so.

The run used the app at 1440×900, project **Giọt — nhắc uống nước**. Data I added through the REST API:
- **GIOT-2**: a leaf under GIOT-1. It got tags `frontend` and `test`, a description with inline code and `qa-notes.pdf`, 3 sub-tasks (one done), 3 criteria (one done), Blocked by GIOT-4, two comments (one with an image), two test cases, an assignee, a due date and 2 pt.
- **GIOT-3**: pending on GIOT-4 with a note.
- **GIOT-11**: a new bug, moved to Done, then reopened with a reason.
- **GIOT-4**: a rich Markdown description.

No AI run was started, and no dialog was submitted.

Screenshots are in [`docs/screenshots/269/detail/`](../../screenshots/269/detail/). `*-before.jpg` was taken before any edit and `*-after.jpg` after, of the same state. There is an after shot only where a row changed.

Building on the earlier work: the [design audit](../2026-11-design-audit/) (comp-1, comp-2, board) and [the fix waves](../2026-11-design-audit/fixes/board.md). Rows that were already fixed are marked "none: matches (wave n)". Deliberate skips stay skipped, with two exceptions:
- **CM-1 / TD-4** (comments oldest first, composer at the end) is recorded as fixed in wave 3, but the code still defaulted to newest first. Fixed now.
- **TC-3** (test-case group titles) went one step too far in wave 4. It also took the uppercase off the ticket key and set the group headers to 12/600, while the design keeps the key as a 10.5 px uppercase label. Put back as drawn.

**DR-4** (origin chip colours) was skipped because `docs/` was not that agent's area. `TicketDocsSection` is the ticket's doc-refs component, which is in my scope, so it is fixed here.

Legend for the *Fix* column: **fixed** = changed now · **none: matches** · **kept code: why** · **listed: why not fixed**.

## Ticket Detail (`TicketDetail.dc.html`)

| Section | Design | Code today | Gap | Fix |
|---|---|---|---|---|
| Panel mockup | 1038 wide, radius 12, 1 px #E3E8E5, shadow 0 24 64 .16 | `.panel` / `.panelDetail` 1040, same radius, border and shadow | none | none: matches |
| Header | padding 20/28, gap 24; type 13/500 #5B6B60; parent mono 13 #9AA8A0; id `.dt-id-btn` padding 3/5; four 30 px view buttons; close 28 px. Tooltip `Test — 1 pass · 1 running · 2 pending` | padding 18/28, gap 20, id padding 3/6. The view tooltips and every unstyled `<button>` in the panel fell back to **Arial** | spacing, font | **fixed**: padding 16 + the 4 px of the view row, gap 24, id 3/5. The panel's buttons, inputs and selects inherit Plus Jakarta (`:where(.panelDetail)`). **kept code**: the Branches view button, the AI split button, bell, fullscreen and delete come from later features. **listed**: the bar is 73 px, not 71, because the AI buttons are 32/34 px (TD-1, `ai/RunPanel.tsx` and `assist/TicketAi.tsx`, not mine) |
| Body: two columns | gap 32, padding 24/28/28, sidebar 240 | same | none | none: matches |
| Main › title and tags | h2 21/700/1.3. This board draws the removable pills uppercase 10 px | 21/700/1.3. Removable pills 12/600 lowercase, picker on "+ Add tag" | pill type | kept code: Tags rev. 2 (the later board) draws removable pills 12/600 lowercase, as decided in comp-1 TG-1 |
| Main › description | label 10/700/.08em #9AA8A0; body 14/1.6 #3A4A3E; code 12.5 mono #2E6F40 on #F6FAF7 | same, through the WYSIWYG editor (Approach B) | none | none: matches. kept code: the file card of a linked file in the description |
| Main › sub-tasks | "SUB-TASKS", 120 px bar, "2/3" 11/600; rows 10/12, 13 px, ids at the right in mono 11; dashed "+ Add sub-task" | same, with no ids; open rows #3A4A3E; Add button in Arial | ids, font, open colour | **fixed**: the button font. **listed**: no ids, because sub-tasks are checklist items with no ticket behind them (TD-2, needs a data model). kept code: the design greys an open row unless its linked ticket is the current one; checklist items have no status, so open rows keep the body colour |
| Main › acceptance criteria | rows 16 px with an 8 px gap (26 px apart); done row #9AA8A0 struck #C7D2CB | rows **36 px** apart: the hidden 24 px edit and delete buttons made each row 32 px, plus a 4 px gap. Add button in Arial | spacing, font | **fixed**: list gap 0, the action pair overlaps the row padding, so rows are 26 px apart; button font. kept code: the "Draft more" AI chip |
| Main › relations | label, "Blocked by" 10.5/600, rows 9/12, id mono 11 width 62, status pill 11.5/600, × hidden until hover | same; × always visible; a "Mark pending?" strip under an open blocker | ×, extra strip | kept code: × stays visible (REL-1 deliberate skip: no hover-only one-click action). kept code: the pending suggestion (TicketPending A4). **fixed**: the Add link font |
| Main › attachments | one 1 px #EEF3EF line, then 4 px, then "ATTACHMENTS · 2" 10 px, gap 8; chip "qa-notes.pdf / 248 KB" | an `<hr>`, the 22 px column gap, then 14 px padding: a 36 px empty band under the line. The chip shows "PDF" in the dev app | spacing; size in dev | **fixed**: the zone draws its own line with 4 px and gap 8, and the `<hr>` is gone. **listed**: the size comes from `/upload-info`, which the Vite dev proxy does not forward (`ui/vite.config.ts`, not mine). It works where the server serves the UI |
| Main › comments | label 10 px; the thread first, then the composer "Add a comment…" at the end | 11 px #8A998F label; **newest first with the composer on top**; 14 px gap above the label | order, spacing | **fixed**: oldest first by default, so the composer sits under the thread (the toggle and its remembered choice stay). Padding 4 and gap 10, as the other sections. kept code: the 11 px label, 28 px avatar and "COMMENTS n" pill follow the later TicketComments board |
| Sidebar | Status, Branch ("from main · 1 ahead"), Assignee 22 px avatar, Priority 13/500, Due date 13/400, Estimate 13/400, divider, Created / Updated 11.5 #9AA8A0 | same order; Due date and Estimate 13/**500**; Done requires and Pending / Reopen buttons added | weight | **fixed**: Due date and Estimate are 400. kept code: Done requires, Pending, Reopen and Completed by. kept code: In Progress is orange, the board accent (SM-1) |
| Note (Test button dot) | icon only, dot red when failing, grey/green otherwise; tooltip with the breakdown | same; tooltip "Test — 2 pass · 2 pending" | tooltip font | **fixed** with Header (font) |

Shots: header [before](../../screenshots/269/detail/TicketDetail-header-before.jpg) / [after](../../screenshots/269/detail/TicketDetail-header-after.jpg) · main top [before](../../screenshots/269/detail/TicketDetail-main-top-before.jpg) / [after](../../screenshots/269/detail/TicketDetail-main-top-after.jpg) · main bottom [before](../../screenshots/269/detail/TicketDetail-main-bottom-before.jpg) / [after](../../screenshots/269/detail/TicketDetail-main-bottom-after.jpg) · sidebar [before](../../screenshots/269/detail/TicketDetail-sidebar-before.jpg) / [after](../../screenshots/269/detail/TicketDetail-sidebar-after.jpg) · tooltip [before](../../screenshots/269/detail/TicketDetail-tooltip-before.jpg) / [after](../../screenshots/269/detail/TicketDetail-tooltip-after.jpg)

Note: `TicketDetail-sidebar-before.jpg` is a wrong crop (the type picker). The sidebar as it was is visible in `TicketPending-dialog-before.jpg` and `TicketDetailParent-sidebar-before.jpg`.

## Ticket Detail with Sub-tickets (`TicketDetailParent.dc.html`)

| Section | Design | Code today | Gap | Fix |
|---|---|---|---|---|
| Panel mockup | as TicketDetail | as TicketDetail | none | none: matches |
| Header | tooltips `Test — 5 pass · 1 fail · …`, `Debug — 5 entries · 1 blocked`, `Workspace — 9 files · 31 MB` | same wording ("Test — 2 pass · 2 pending", "Debug — 1 entry") | font | **fixed** (font, as TicketDetail) |
| Body: two columns | as TicketDetail | same | none | none: matches |
| Main › title, description, sub-tasks | as TicketDetail | same | as TicketDetail | **fixed** with TicketDetail (button font) |
| Main › Sub-tickets | "SUB-TICKETS · 4", bar, "1/4 done"; rows: 19 px wave badge (done filled, ready blue ring, waiting dashed), 15 px status mark, type icon, title, 18 px avatar, id width 62 right; red "Blocked by" chip; caption; dashed Add | same, including the caption wording | none | none: matches. kept code: "Make this a Story" (ai-story-flow) and the unlink × |
| Main › criteria and relations | as TicketDetail | same | as TicketDetail | **fixed** with TicketDetail (row spacing, font) |
| Main › attachments and comments | as TicketDetail | same | as TicketDetail | **fixed** with TicketDetail |
| Sidebar | Estimate "8 pt (rolled up)" | rolled-up estimate shown (TDP-2, wave 3) | none | none: matches (wave 3) |
| Clicking a wave badge | popover WAVE, − 2 +, "Auto-set from Blocked by"; green ring on hover | built, shown read-only (stepper and box disabled) | can't pin a wave | listed: pinning a wave by hand needs a server field (wave override on the ticket); TDP-1 deliberate partial |
| Header button: chosen design | Idle; Active = #2E6F40 border, #F1F8F3 fill, **#1E2A22 icon**; Hover tooltip | Active icon in forest green | colour | **fixed**: the active icon is #1E2A22 |

Shots: main [before](../../screenshots/269/detail/TicketDetailParent-main-before.jpg) / [after](../../screenshots/269/detail/TicketDetailParent-main-after.jpg) · sidebar [now](../../screenshots/269/detail/TicketDetailParent-sidebar-before.jpg) · wave popover [now](../../screenshots/269/detail/TicketDetailParent-wave-before.jpg) · active button [before](../../screenshots/269/detail/TestCases-parent-before.jpg) / [after](../../screenshots/269/detail/TestCases-parent-after.jpg)

## Add Acceptance Criterion (`AddAC.dc.html`)

| Section | Design | Code today | Gap | Fix |
|---|---|---|---|---|
| Idle | rows `gap 9`, 16 px box, 13 px #3A4A3E; rows 8 apart; dashed "+ Add criterion" 12 px | rows 36 px apart, button in Arial | spacing, font | **fixed** (as TicketDetail › criteria) |
| New | row 5/8 padding, 1 px #2E6F40 and a 3 px .10 halo, "New criterion…", × and a green ✓ 20 px; hint "Enter to save and add another · Esc to cancel" at 25 px | same, one focus ring (AS-1, wave 2), Esc cancels (AC-1, wave 1) | none | none: matches |
| Hover: edit/delete | row tint #F6FAF7, padding 4/6, pencil and trash 24 px, shown only on hover | same | none | none: matches |
| Icon close-up | line pencil and trash | same icons | none | none: matches |
| Editing | the same input row, checkbox kept | same | none | none: matches |

Shots: adding [before](../../screenshots/269/detail/AddAC-adding-before.jpg) / [after](../../screenshots/269/detail/AddAC-adding-after.jpg) · hover [before](../../screenshots/269/detail/AddAC-hover-before.jpg) / [after](../../screenshots/269/detail/AddAC-hover-after.jpg)

## Add Sub-ticket (`AddSubticket.dc.html`)

| Section | Design | Code today | Gap | Fix |
|---|---|---|---|---|
| Idle | dashed "+ Add sub-ticket", 12 px | same, in Arial | font | **fixed** (panel font) |
| Expanded: new | tabs New / Existing 11.5/600, 15 px circle, "Sub-ticket title…", × and ✓ 22 px; hint "Enter to create and add another · Esc to cancel" | same | none | none: matches |
| Expanded: existing | search "Search tickets…", results: 7 px status dot, title 12.5, id mono 10.5; caption "Already-linked tickets and the ticket's own parent are filtered out of results." | dot (AS-2, wave 4), title, id, plus a magnifier, a clear × and the type icon; caption "Already-linked tickets are filtered out" | copy | **fixed**: the caption reads as drawn (the parent is filtered out too: it has children). kept code: magnifier, clear and type icon |

Shots: new [now](../../screenshots/269/detail/AddSubticket-new-before.jpg) · existing [before](../../screenshots/269/detail/AddSubticket-existing-before.jpg) / [after](../../screenshots/269/detail/AddSubticket-existing-after.jpg)

## Relations (`Relations.dc.html`)

| Section | Design | Code today | Gap | Fix |
|---|---|---|---|---|
| Grouped, populated | groups Blocks / Blocked by / Relates to / Duplicates 10.5/600; rows 9/12; id mono 11 width 60; status pill 11.5/600 with the status dot; Won't Do title struck; × on hover | same; × always visible | × visibility | kept code: REL-1 deliberate skip. **fixed**: Add link font |
| Empty state | "No links" 13 #9AA8A0, then dashed Add link | same | none | none: matches |
| Add link form | type select, search with a halo, results "#KAN-088" mono with the match highlighted; caption "Search excludes the ticket itself and anything already linked to it (any relation type) — the same eligible-tickets rule as Add Sub-ticket's search." | same, caption ends at "(any relation type)." | copy | kept code: the second clause is not true here (the sub-ticket search also drops tickets that have a parent or children), so it would mislead |

Shots: populated [before](../../screenshots/269/detail/Relations-populated-before.jpg) / [after](../../screenshots/269/detail/Relations-populated-after.jpg) · empty [now](../../screenshots/269/detail/Relations-empty-before.jpg) · add [now](../../screenshots/269/detail/Relations-add-before.jpg)

## Tags (`Tags.dc.html`)

| Section | Design | Code today | Gap | Fix |
|---|---|---|---|---|
| Tag pill cluster | read-only pill 12/600, padding 3/10 | ticket card: uppercase 10 px (Ticket Card rev. 6, the board agent's) | — | kept code: Ticket Card rev. 6 is the later rule for cards (comp-1) |
| Removable | 12/600, padding 3/6/3/10, ×, hover darkens the tint | same (TG-1, TG-4) | none | none: matches |
| Add tag | idle: dashed, "Add tag" 12/600; typing: comma commits a pill | same (TG-3) | none | none: matches |
| Clicking Add tag: picker popover | 220 px, search with a halo, "perf · existing tag", `Create "perf-regression"` | same; curly quotes `Create “fr”` | copy | **fixed**: straight quotes, as drawn |

Shots: pills [now](../../screenshots/269/detail/Tags-pills-before.jpg) · picker [before](../../screenshots/269/detail/Tags-picker-before.jpg) / [after](../../screenshots/269/detail/Tags-picker-after.jpg)

## Ticket comments (`TicketComments.dc.html`, sections of `ticket-comments.md`)

| Section | Design | Code today | Gap | Fix |
|---|---|---|---|---|
| A. Placement | the last section of Details; "COMMENTS n Oldest first"; oldest first, composer at the end | newest first, composer on top (CM-1 recorded as fixed in wave 3, not in the code); 14 px above the label | order, spacing | **fixed**: default oldest first, composer under the thread; 4 px under the divider |
| B. The thread | 28 px avatars, name 13/700, time 12 dotted, text 13.5/1.65, hover bar Edit · Delete · Copy link, blue mention chip, pills | same (CM-2 fixed in wave 1) | none | none: matches |
| C. Composer (1–8) | Write / Preview, toolbar B i code link quote list `[[ ]]` @; **paperclip** "Attach", Cmd + Enter, Cancel, Comment; "Draft saved · kept on this device, per ticket"; suggesters for [[, @, KAN- | same, but Attach uses the **copy** icon (`i24`); extra toolbar tools (diagram, sketch, canvas) | icon | **fixed**: the design's paperclip. kept code: the extra tools |
| D. Editing and deleting | edit in place, inline delete confirm, toast with Undo, "Comment deleted" rule | built (checked from code) | none | none: matches (from code) |
| E. States | empty, long thread folded, very long comment, loading, send failed, offline queue, broken refs | built (checked from code) | none | none: matches (from code) |
| F. Mentions | @ list: "On this ticket" (Assignee, Reporter, Commented), "Everyone else"; chip; who is notified | same; the role sits at the right of the row | layout (minor) | none: matches (seen in the composer shot) |
| G. Activity interplay | one Activity line per comment, deep link `#comment-…` | built (ActivitySection, `#comment-id`) | none | none: matches (from code) |

Shots: thread [before](../../screenshots/269/detail/TicketComments-thread-before.jpg) / [after](../../screenshots/269/detail/TicketComments-thread-after.jpg) · composer and @ [before](../../screenshots/269/detail/TicketComments-composer-before.jpg) / [after](../../screenshots/269/detail/TicketComments-composer-after.jpg)

## Doc references in tickets (`TicketDocRefs.dc.html`, sections of `ticket-doc-refs.md`)

| Section | Design | Code today | Gap | Fix |
|---|---|---|---|---|
| A. Description: pills and edit round trip | page, section (`API › #Endpoints`), ticket and broken pills | same, but a section pill has no "#" (DR-1) | icon | listed: `docs/RefChip.tsx` is the shared Docs pill, not the ticket's component |
| B. Hover card | card with breadcrumb "Architecture › API" | card shows "Architecture" only (DR-2) | copy | listed: `docs/RefCardsTicket.tsx` / Docs side |
| C. Side panel | 480 px panel; the ticket dims and shifts left | panel covers the sidebar (DR-3) | layout | listed: `docs/DocPeekPanel.tsx`, Docs side |
| D. `[[` suggester in every text field | same suggester in description, comments, criteria, test cases | built (CM-3 fixed, wave 1) | none | none: matches |
| E. Where references appear, Activity | Activity line for added/removed references | the server events are a TODO in the design itself | — | listed: needs `doc_ref_added` / `doc_ref_removed` activity events on the server |
| F. Ticket and doc linkage | "LINKED DOCS 6" 11/700 #5B6B60; groups "Mentioned in this ticket", "Linked manually"; origin chips **blue** (#E8F1FB / #1F5A8E), "Manual link" grey; lock; red × on a manual row on hover | label and groups as drawn, plus "Pages that mention this ticket"; mention chips **grey**, "From docs" blue with grey text | chip colour | **fixed**: every origin chip is blue with #1F5A8E text, and only "Manual link" stays grey (DR-4). kept code: the "Pages that mention this ticket" group |

Shots: linked docs [now](../../screenshots/269/detail/TicketDocRefs-linked-before.jpg) (no mention data on GIOT-1, so the blue chip was checked from the code; no after shot)

## Pending ticket (`TicketPending.dc.html`, sections of `ticket-pending.md`)

| Section | Design | Code today | Gap | Fix |
|---|---|---|---|---|
| Pending chip variants | header pill: radius 999, padding 2/7/2/5, 11/700, line-height 1.3 | radius 4, 11/600 | shape | **fixed** |
| A. Entry points | detail button "‖ Pending P", card menus, P key, Relations suggestion | built; card menus are the board agent's | none | none: matches (detail) |
| B. Set Pending dialog | B1–B6; result rows with a status pill, dot in the status colour | built and worded as drawn; dots used a second palette (To Do grey, Done dark green) | colour | **fixed**: dots use the status menu colours (one status, one colour, SM-1) |
| C. Result on the board | striped rail, Waiting-on strip, column "+1 pending" | board agent's files | — | listed: not mine (TicketCard, Column) |
| D. Ticket Detail while pending | D1 banner: 28 px icon; "Pending since Oct 18" 13/700 + " - set by Hoa Mai" 500 #5B6F86; detail 12.5 #34455A; blocker status in a **white pill** with the status's own dot, 11/700; Change reason 12/600 #1E2A22 border #D4DDD7; Resume green; padding 11/24. D3 Resume dialog | 34 px icon; the whole title 600; detail 13 #1E293B; status in a grey tag with an always-blue dot; buttons 12/500 and Arial | type, colour, font | **fixed**: all of these. The panel keeps its 28 px side padding. D3 matches |
| E. Auto behaviours | E1 blocker Done prompt, E3 blocker Won't Do prompt | built (banners in TicketModal) | none | none: matches (from code) |
| F. Views: filter, sort, list, timeline | — | board agent's | — | listed: not mine |
| G. Activity feed | pending set / changed / resumed lines | built in ActivitySection (from code) | none | none: matches (from code) |
| H. Edge cases and rules | permissions, Done ticket, recycle bin, concurrent, offline, bulk | rules in the server and dialogs | — | none: matches (from code, no UI to compare) |
| I. Notes | — | — | — | none |

Shots: detail [before](../../screenshots/269/detail/TicketPending-detail-before.jpg) / [after](../../screenshots/269/detail/TicketPending-detail-after.jpg) · dialog [before](../../screenshots/269/detail/TicketPending-dialog-before.jpg) / [after](../../screenshots/269/detail/TicketPending-dialog-after.jpg) · resume [now](../../screenshots/269/detail/TicketPending-resume-before.jpg)

## Reopen ticket (`TicketReopen.dc.html`, sections of `ticket-reopen.md`)

| Section | Design | Code today | Gap | Fix |
|---|---|---|---|---|
| Reopened badge | header pill radius 999, 11/700, line-height 1.3; "x2" mono 11/700 on rgba(199,119,0,.16), radius 999 | radius 4, 600, "x2" 10 px on #FDE3A7 radius 3 | shape, type | **fixed** |
| A. Entry points | A1 status menu Reopen row and the detail Reopen button with R; A2 card menu; A3 drag; A4 R key | A1 built (detail); A2/A3 board agent's | none | none: matches (detail) |
| B. Reopen dialog | B1–B7 and field rules | matches (board audit) | none | none: matches |
| C. Result on the board | badge on cards, toast | board agent's | — | listed: not mine |
| D. Ticket Detail after reopening | D1 banner "Reopened by **Linh Pham** on Oct 21 - "…"", View history; status-area badge; Reopens meta; D4 history card | same | none (badge in the header fixed above) | none: matches |
| E. Views | — | board agent's | — | listed: not mine |
| F. Activity feed | reopened lines | ActivitySection (from code) | none | none: matches (from code) |
| G. Edge cases and rules | — | server rules | — | none: matches (from code) |
| H. Notes | — | — | — | none |

Shots: detail [before](../../screenshots/269/detail/TicketReopen-detail-before.jpg) / [after](../../screenshots/269/detail/TicketReopen-detail-after.jpg) · dialog [now](../../screenshots/269/detail/TicketReopen-dialog-before.jpg)

## Attachments (`Attachments.dc.html`)

| Section | Design | Code today | Gap | Fix |
|---|---|---|---|---|
| Consolidated attachments zone | "ATTACHMENTS · 4", gap 8; 76 px thumbs; file chip 12.5/600 + size 10.5; provenance 9.5 → 10 px; dashed 76 px add tile | same layout; a 36 px band above the label; "PDF" instead of the size in the dev app | spacing, size | **fixed**: one divider + 4 px, gap 8. listed: size in dev (Vite proxy, see Left open). kept code: provenance text is 10 px (no text under 10 px, wave 4 TT-3) |
| Uploading state | pulsing thumb; chip with a 3 px progress bar | built (ATT-3, wave 3) | none | none: matches |

Shots: zone [before](../../screenshots/269/detail/Attachments-zone-before.jpg) / [after](../../screenshots/269/detail/Attachments-zone-after.jpg)

## Description — Markdown (`DescriptionMarkdown.dc.html`)

| Section | Design | Code today | Gap | Fix |
|---|---|---|---|---|
| Approach A: View | rendered Markdown, click to edit; `> **Heads up:**` as an amber callout | the app ships Approach B; view and edit are the same WYSIWYG editor; a blockquote stays a quote | callout | kept code: Approach B was chosen (comp-2); whether a bold lead becomes a callout is open (DM-2) |
| Approach A: Write | raw Markdown tab | not built | — | kept code: Approach A is the alternative not taken |
| Approach A: Preview | preview tab | not built | — | kept code: as above |
| Approach B | boxed editor, toolbar B i strike H2 lists quote code link image, alignment; text stays rendered | same, plus undo/redo, `[[ ]]`, attach, diagram, sketch, canvas | none | none: matches. kept code: the extra tools |
| Link popover (Approach B, 5) | popover under the toolbar button | matches (comp-2) | none | none: matches |

Shots: view [now](../../screenshots/269/detail/DescriptionMarkdown-view-before.jpg) · edit [now](../../screenshots/269/detail/DescriptionMarkdown-edit-before.jpg)

## Test Cases (`TestCases.dc.html`)

| Section | Design | Code today | Gap | Fix |
|---|---|---|---|---|
| Leaf ticket, own test cases only | "4 TEST CASES · KAN-145", filter chips, rows: status mark, id mono, title, "passed 2d ago" / "started 4m ago", **nothing for a pending case**, avatar, chevron, trash | a pending row shows a bare "7m ago" (when it was added) | copy | **fixed**: a pending row shows no time; "Added 7m ago" is its tooltip. kept code: "Suggest cases" (TC-5) |
| Parent ticket, rollup | "Show All (9)" menu and counts; groups | same | — | none: matches |
| Group: own | "KAN-140 — this ticket" 10.5/700 uppercase .05em #9AA8A0 | 12/600 sentence case (wave 4 TC-3 went too far) | type | **fixed** |
| Group: sub-ticket | key 10.5/700 uppercase, "·" #C7D2CB, title 10.5 regular "— read-only here" | 12/600, key not uppercase | type | **fixed** |
| Expanded row (in the leaf section) | Description, Expected result with files, Test data, Notes with files; "Started 4m ago by Ha My · Last edited 1m ago" | separate "Result and proof", one Attach on Test data, footer without who | fields | listed: TC-2 deliberate skip (needs per-field file lists on the server) |
| Clicking Add test case | inline row: title only, Add / Cancel | title + optional description | field | kept code: TC-4 deliberate skip |

Shots: leaf [before](../../screenshots/269/detail/TestCases-leaf-before.jpg) / [after](../../screenshots/269/detail/TestCases-leaf-after.jpg) · parent [before](../../screenshots/269/detail/TestCases-parent-before.jpg) / [after](../../screenshots/269/detail/TestCases-parent-after.jpg) · add [now](../../screenshots/269/detail/TestCases-add-before.jpg)

## Status Menu (`StatusMenu.dc.html`)

| Section | Design | Code today | Gap | Fix |
|---|---|---|---|---|
| Closed state | 6/10 padding, 1 px #E3E8E5, #F6FAF7, dot 7 px, 12.5/600, 10 px chevron | same | none | none: matches |
| Open state | 188 px, radius 8, shadow 0 12 28 .14, padding 4; rows 8/10 13 px; current #F1F8F3 600 with a check; divider before Won't Do | same; row radius 4; dots are the board accents (doc text) not the image's | dot colours | kept code: SM-1 (one status, one colour) |

Shots: closed [now](../../screenshots/269/detail/StatusMenu-closed-before.jpg) · open [now](../../screenshots/269/detail/StatusMenu-open-before.jpg)

## Story, evidence and AI chips (code that is newer than the designs)

Measured in the app, not changed:
- **"Draft more"** (criteria, AI): 11.5/600 #5A3FD0 on #F6F3FE, a 1 px #D9D1F6 border, radius 999, 19 px tall.
- **"Make this a Story"** (sub-tickets): 11.5/700 #1B3A6B on #F3F6FB, a 1 px #C9D6EA border, radius 999, 23 px tall.

Both already use the designs' chip pattern: an 11.5 px pill with a tinted fill, a 1 px tinted border and the type of the status pills. The Story button makes the Sub-tickets header row 23 px instead of 13 px, a small difference I left.

Not checked:
- **Evidence chips** and the **run chip** in the header need an AI run, and none was started.
- The **workflow step strip** (`workflowBoard/`) and the **AI header buttons** (`ai/`, `assist/`) are not in my files.

## Counts

| Design | Rows | Fixed | Kept | Listed | Matches |
|---|---|---|---|---|---|
| TicketDetail | 12 | 8 | 1 | 0 | 3 |
| TicketDetailParent | 10 | 5 | 0 | 1 | 4 |
| AddAC | 5 | 1 | 0 | 0 | 4 |
| AddSubticket | 3 | 2 | 0 | 0 | 1 |
| Relations | 3 | 1 | 1 | 0 | 1 |
| Tags | 4 | 1 | 1 | 0 | 2 |
| TicketComments | 7 | 2 | 0 | 0 | 5 |
| TicketDocRefs | 6 | 1 | 0 | 4 | 1 |
| TicketPending | 10 | 3 | 0 | 2 | 5 |
| TicketReopen | 9 | 1 | 0 | 2 | 6 |
| Attachments | 2 | 1 | 0 | 0 | 1 |
| DescriptionMarkdown | 5 | 0 | 3 | 0 | 2 |
| TestCases | 6 | 3 | 1 | 1 | 1 |
| StatusMenu | 2 | 0 | 1 | 0 | 1 |
| **Total** | **84** | **29** | **8** | **10** | **37** |

A row is counted once, under its main outcome. "Kept" and "listed" notes inside a fixed row are not counted twice.

## Left open

- **Attachment size in the dev app**: `ui/vite.config.ts` has no proxy for `/upload-info`, so in `npm run dev` the chip shows "PDF" instead of "2 KB". One line: `'/upload-info': 'http://localhost:8000'` (not my file).
- **Header height 73 vs 71**: the AI header buttons are 32 and 34 px, while the view buttons are 30 (TD-1). Fix in `ai/RunPanel.tsx` (`RunHeaderButton`) and `assist/TicketAi.tsx`.
- **Sub-task ids** (TD-2): sub-tasks have no ticket behind them. Needs a data model change (server).
- **Pin a wave by hand** (TDP-1): needs a wave override field on the ticket (server).
- **Test case fields** (TC-2): per-field attachments on Expected result and Notes, and who started or failed a case. Needs server fields.
- **Doc pills and panel** (DR-1, DR-2, DR-3): the shared Docs components `docs/RefChip.tsx`, `RefCardsTicket.tsx` and `DocPeekPanel.tsx`.
- **Doc reference Activity lines**: needs `doc_ref_added` / `doc_ref_removed` events on the server.
- Not reached in the app, so checked from the code only: comment edit, delete, failed and offline states; the pending and reopen auto prompts (E1/E3); the Won't Do dialog; mention origin chips (no mention data on GIOT-1).
