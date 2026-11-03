# #269 — ticket card and board views, 1:1 with the designs

This pass compares the ticket card, the New Ticket modal, drag and drop, the Main Board, List View, Sub-task Grouping
and Timeline View with their designs, section by section. It works from the HTML source (`design/source/*.dc.html`:
inline sizes, colours and copy), not only the PNG renders. It builds on the 2026-11 design audit
([comp-1](../2026-11-design-audit/comp-1.md), [comp-2](../2026-11-design-audit/comp-2.md),
[board](../2026-11-design-audit/board.md)) and its four fix waves ([fixes/board](../2026-11-design-audit/fixes/board.md)).
Rows fixed there are not redone. Every deliberate skip there is kept, and the table says so where one applies.

How each row reads: *Fix* is what changed in this pass, "none: matches", "kept code: why" (the code does more, or a
later design or audit decision wins), or "listed: why it is not fixed here". The live data is project
**Giọt — nhắc uống nước** (GIOT). GIOT-5…GIOT-20 were added for this pass through the REST API. Nothing that already
existed was changed or deleted, and no AI run was started.

Measured in the app at 1440×900 (computed styles, Playwright). A board column there is about 165–178 px wide, while
the artboards draw 280 px cards. So width-driven differences (wrapping, clamping) are judged at the real width.

Screenshots: `docs/screenshots/269/board/<design>-<section>-before.jpg` and `-after.jpg` (an *after* only where the row
changed). In two pairs the *before* was rendered from the current code with the old CSS values injected back into the
page, because the state was not captured before the edit: `listview-done-*` and `dragdrop-live-*`. This is noted at
each.

## Ticket Card (`TicketCard.dc.html`, rev. 6)

| Section | Design | Code today | Gap | Fix |
|---|---|---|---|---|
| Default — many tags | Padding 12/14, gap 8, radius 8, border `#E3E8E5`. Header: 15 px type icon, **5 px** gap, "Task" 12/500 `#5B6B60`; ID mono 11 `#9AA8A0` flush right. Title 14/600, line height 1.3. Tags 10/700 uppercase, radius 3, padding 2/7, "+2" 11/600 `#9AA8A0`. Footer with an **8 px** gap: 20 px tinted avatar (10/700), **15×14** priority bars, spacer, "3 pt" 11 `#9AA8A0`, "2/4" 11 `#5B6B60` | Same padding, radius, type, tag pill and overflow, ID, avatar, estimate and criteria count. Type gap 6, footer gap 6, priority bars 16×15. Card width follows the column (~165 px), and in that width the footer wraps the due date to a second line | Type gap, footer gap, priority size | Type gap 5, footer gap 8, `PriorityMark` 15×14 on the card. **Kept code:** the footer wrap (at 165 px the one-line footer would overflow the card) and the tag row wrap (a nowrap row would clip a pill). [before](../../screenshots/269/board/ticketcard-default-before.jpg) · [after](../../screenshots/269/board/ticketcard-default-after.jpg) |
| Hover — one tag | Border `#B9CBBF`, shadow `0 2px 8px rgba(30,42,34,.08)`. A 10×14 `#B7C4BC` grip 6 px after the ID. Overdue due date "Due Sep 12": 12 px calendar, 11/600 `#C4432A` | Same border, shadow, grip and due date. The "…" card menu also shows on hover (TicketPending A1, comp-1 TC-2) | None beyond row 1 | None: matches (the row 1 gaps applied here too). **Kept code:** the "…" button. [before](../../screenshots/269/board/ticketcard-hover-before.jpg) · [after](../../screenshots/269/board/ticketcard-hover-after.jpg) |
| Dragging — two tags | This board draws it 274×154, `rotate(1deg)`, shadow `0 12px 24px .18`. Drag & Drop owns the motion ("see Drag & Drop") and draws the dragging frame at **−1.5°**, scale 1.03, shadow `0 16px 30px .22`, opacity .97 | The pick-up keyframes from DD-3 (scale, lift, shadow, opacity) end at **+1.5°** | Tilt direction | Tilt is −1.5°, as the Drag & Drop frame draws it (`cardPickUp`). [before](../../screenshots/269/board/ticketcard-dragging-before.jpg) · [after](../../screenshots/269/board/ticketcard-dragging-after.jpg) |
| Blocked — floating badge | 1.5 px dashed `#D9A79A`, content at opacity .72. A 22 px white circle badge, 1.5 px `#C4432A` ring, 11 px lock, "Blocked by …" tooltip, at −9/−9 (Main Board draws the in-column card at **−7/−7**) | Same border, opacity, badge and tooltip, at top −6 / right −4 | Badge offset | Badge at top −7, right −6. The column body's side padding is 6 px, so −7 on the right would clip the ring. The body's top padding is now 8 px (Main Board), which gives the −7 room. [before](../../screenshots/269/board/ticketcard-blocked-before.jpg) · [after](../../screenshots/269/board/ticketcard-blocked-after.jpg) |
| Long title — 2-line clamp | Title clamps to two lines with an ellipsis | `-webkit-line-clamp: 2`, ellipsis | None | None: matches. This card (GIOT-10) is unassigned, see "Unassigned" below. [before](../../screenshots/269/board/ticketcard-longtitle-before.jpg) · [after](../../screenshots/269/board/ticketcard-longtitle-after.jpg) |
| Sub-ticket — has a parent | Parent chip "↳ KAN-140": radius 4, `#F6FAF7`, border `#E3E8E5`, 10/600 `#5B6B60`, padding 2/7, gap 4, 10 px arrow `#9AA8A0` | Identical (measured) | None | None: matches. **Kept code:** a Story's child shows the Story chip instead (ai-story-flow C). [before](../../screenshots/269/board/ticketcard-subticket-before.jpg) · [after](../../screenshots/269/board/ticketcard-subticket-after.jpg) |
| Done — struck ID | ID struck with `#C7D2CB`. The title stays `#1E2A22`. **No priority bars** (both this board and Main Board's Done column) | ID struck. Title grey `#5B6B60`, priority bars shown | Title colour, priority mark | The Done title is dark again, and a Done card shows no priority bars. [before](../../screenshots/269/board/ticketcard-done-before.jpg) · [after](../../screenshots/269/board/ticketcard-done-after.jpg) |

Parts the card has that this board does not draw:

| Part | Design | Code today | Gap | Fix |
|---|---|---|---|---|
| Unassigned avatar | Not drawn here. Elsewhere "Unassigned" is a 15–20 px dashed `#C7D2CB` empty circle (New Ticket, List View) | A filled 20 px grey disc with a "?" | Not the system's unassigned mark | A 20 px dashed empty circle, with the title and label "Unassigned" (`.avatarEmpty`). See the long-title shots |
| Testing roll-up (Main Board, Testing column) | "Test — 2 pass · 1 running · 1 pending", a 7 px dot (blue while running), 10.5 `#5B6B60` | Missing | Missing | Added on Testing cards (`data-testid="card-test-rollup"`). It counts the ticket's own test cases and its sub-tickets', with the same words and dot colour as the detail's Test tab tooltip (fail red, running blue, pass green). The words wrap in a narrow column rather than hide a count. [before](../../screenshots/269/board/ticketcard-testing-before.jpg) · [after](../../screenshots/269/board/ticketcard-testing-after.jpg) |
| Review requested (Main Board, Review column) | "Review requested — Ha My" with a 15 px avatar, 10.5 `#5B6B60` | Missing | Missing | **Listed:** the ticket has no "review requested from" field. Needs a server field (see Left open) |
| Story card and Story chip | Drawn by a later design (ai-story-flow C/D): chip `#E6ECF5` / `#1B3A6B`, pill, 11/700 | As drawn there | None | **Kept code:** a later design. [now](../../screenshots/269/board/ticketcard-story-before.jpg) |
| Workflow step chip, AI footer, cap line, schedule chip, health chip | Drawn by later designs (AI team process F/TP-12, AI ticket work A4, AI schedules E2, Board assistant): 11.5 px pills, radius 999 | As drawn there (code read). These are hidden while dragging | None found in code | **Kept code:** later designs. Their run states were not checked live, because that would start a paid AI run |
| Reopened badge, pending rail and strip | Later designs (TicketReopen C1, TicketPending C1/C2) | As drawn there (board RO-1, PD-1) | None | **Kept code** |
| Evidence | Not on the board card (evidence is in the run panel) | None on the card | — | None |

## New Ticket (`NewTicket.dc.html`, v1 — one modal, rows by block)

| Section | Design | Code today | Gap | Fix |
|---|---|---|---|---|
| Frame and header | 620 px, radius 12, shadow `0 24px 64px .16`. Header padding 18/24, "New Ticket" 15/700, 28 px close button (radius 6, `#9AA8A0`, 16 px ×) | Identical (measured) | None | None: matches |
| Body spacing | Padding 22/24, **20 px** between fields, max height 640 | Gap 18 | Gap | Gap 20 (`.newModalBody`) |
| Title | Label 10.5/700 uppercase .06em `#9AA8A0`. Input **15/600**, padding 10/12, radius 7, `#C7D2CB`, "Ticket title…" | Input 14/600 | Size | 15 px (`.ntInput`, the title field only; the other inputs use `.ntInputPlain`) |
| Type | Four equal buttons, padding 7/12, radius 8, 12.5/600, **13 px** icons. Active: forest border, `#F1F8F3` | Icons 14 px | Icon size | 13 px |
| Description | Box radius 7, `#C7D2CB`. A `#F6FAF7` toolbar with B, i, list, code, image and a "MARKDOWN" label 9.5/700. Body 12.5, min 70 px, "Add a description…" | The shared `MarkdownEditor` (compact) at rest: a white toolbar with undo, redo, B, I, link, H2, list, quote, code, link, attach, image and three align buttons. Green border, no MARKDOWN label | Toolbar set and look | **Kept code** for the extra buttons (attach, align, undo: the code does more). **Listed** the look: `MarkdownEditor` is shared with the ticket detail editors, so its toolbar colour and label are not changed from this modal |
| Priority and Assignee | Dot chips Low → Critical, padding 6/11, 12/600, 6 px dot. Assignee 20 px to the right: a white dropdown (padding 7/11, `#E3E8E5`, gap 6) with a **15 px dashed avatar** + "Unassigned" + 9 px chevron | Chips match. The trigger had no avatar, padding 5/10, border `#C7D2CB`, gap 8, 14 px chevron | Trigger | The trigger carries the chosen member's 15 px avatar, or the dashed circle for Unassigned. Padding 7/11, border `#E3E8E5`, gap 6. **Listed:** the 14 px chevron belongs to the shared `MenuSelect` |
| Estimate | 32×32, radius 7: — 1 2 3 5 8 13, active filled forest | Identical | None | None: matches |
| Tags | Input "frontend, bug, phase-2…" and a pill preview | Identical | None | None: matches |
| Start / Due date | Two fields side by side, gap 16 | Identical | None | None: matches |
| Footer | Padding 16/24, **gap 8**. Cancel 8/16 outlined. Create Ticket 8/18 forest, **flat** | Gap 10. Create has a `0 1px 3px` shadow | Gap, shadow | Gap 8, no shadow |
| Draft with AI | Not drawn | The AI draft box above the fields | — | **Kept code:** an AI feature newer than this design |

[before](../../screenshots/269/board/newticket-modal-before.jpg) · [after](../../screenshots/269/board/newticket-modal-after.jpg)

## Drag & Drop (`DragDrop.dc.html`)

| Section | Design | Code today | Gap | Fix |
|---|---|---|---|---|
| Idle | Resting card, flat | Flat | None | None: matches |
| Picked up | 0→150 ms ease-out, scale 1.03, lift 4 px, shadow grows | DD-3 keyframes | None | None: matches |
| Dragging | −1.5° tilt, shadow `0 16px 30px .22`, opacity .97 | +1.5° | Tilt direction | −1.5° (same fix as Ticket Card "Dragging"). [before](../../screenshots/269/board/dragdrop-dragging-before.jpg) · [after](../../screenshots/269/board/dragdrop-dragging-after.jpg) |
| Dropped | Overshoot to 1.05, rest in 220 ms | `DROP_ANIMATION` (DD-3) | None | None: matches |
| Live loop — source and target ghosts | Source: a 1.5 px dashed `#C7D2CB` outline at full strength, the card's size. Target: 1.5 px dashed `#9BB3A4`, `rgba(104,186,127,.08)` fill, **the card's size** (96 of a 96 px card), no text | Source ghost at opacity .75 with a 2 px margin above and below, so the cards under it moved 4 px. Target slot 48 px tall whatever the card | Ghost strength and margin, target height | The source ghost is at full strength with no margin. The target slot takes the dragged card's measured height (`dropSlotHeight` from `Board` to `Column`). The reopen and pending slots keep their hint text (DD-4). [before*](../../screenshots/269/board/dragdrop-live-before.jpg) · [after](../../screenshots/269/board/dragdrop-live-after.jpg) (*old values injected) |

## Main Board (`MainBoard.dc.html`, v1)

| Section | Design | Code today | Gap | Fix |
|---|---|---|---|---|
| Sidebar | A fixed 232 px Ink Deep panel | A 52 px rail that opens on hover (`ProjectSidebar`) | Layout | **Listed:** not in my files. Wave 1 decided it (board MB-1) |
| Top bar | Title 21/700. Board/List/Timeline segment (6/14, 12.5/600). New Ticket: padding **8/14**, 13/600, 12 px plus, **flat** | Title, segment and type match. New Ticket padding 8/16 with a shadow. Ask AI, the bell, Docs, Schedules and Give a Story are extra | Button padding, shadow | New Ticket padding 8/14, no shadow. **Kept code:** the extra controls (later designs). [before](../../screenshots/269/board/mainboard-topbar-filterbar-before.jpg) · [after](../../screenshots/269/board/mainboard-topbar-filterbar-after.jpg) |
| Filter bar | Search 220 px (7/12, 12.5, "Search tickets…"), a 1×20 divider, then Type / Priority / Assignee dropdowns (7/11, 12.5/600, grey prefix). The Assignee trigger shows a **15 px** avatar | Search **170 px**. Divider and dropdowns match. Trigger avatar 18 px. Reopened, Pending, Hide pending and Group by are extra | Search width, avatar size | Trigger avatar 15 px. **Kept code:** search at 170 px (board MB-3: the bar stays one line at 1440 px), and the later controls |
| Columns — Backlog | Header 11/700 .06em `#5B6B60`, mono 11/700 count pill on the accent, 3 px bar. **12 px** from the header to the list, plus **8 px** list top padding. 10 px between cards. Low priority is one `#9BB3A4` bar | Header, pill, bar and card gap match. 10 px + 6 px under the header | Header-to-cards spacing | Column gap 12, body top padding 8. [before](../../screenshots/269/board/mainboard-full-before.jpg) · [after](../../screenshots/269/board/mainboard-full-after.jpg) |
| Columns — To Do | A blocked card with no tags row, overdue due date, lock at −7/−7 | See Ticket Card "Blocked" | Badge offset | Fixed with Ticket Card "Blocked" |
| Columns — In Progress | Tinted parent (`#F1F8F3` / `#D7E8DC`), sub-ticket indented 18 px. The parent's footer shows "1/3" | Tint and indent match. The parent shows the "N/M sub-tasks" progress bar from Sub-task Grouping | Parent progress shown as a bar | **Kept code:** this board says parents "keep the treatment from Sub-task Grouping", which draws the bar |
| Columns — Review | Card line "Review requested — Ha My" | Missing | Missing | **Listed:** needs a server field |
| Columns — Testing | Card line "Test — 2 pass · 1 running · 1 pending" | Missing | Missing | Added (see Ticket Card, "Testing roll-up") |
| Columns — Done | IDs struck, dark titles, no priority bars | Grey titles, priority bars | Title colour, bars | Fixed (Ticket Card "Done") |
| Filter dropdowns | 190 px menu, radius 8, shadow `0 12px 28px .14`. Type rows have **13 px** icons and a check on the active row. Assignee: All Assignees, Unassigned, members with an **18 px** tinted avatar | Same menu. Type icons 15 px, member avatars 20 px. Story is an extra Type row | Icon and avatar size | Type icons 13 px (13 px in the trigger as well), member avatars 18 px. This corrects the 20 px of wave 3 (MB-6), which read the size from the PNG. **Kept code:** the Story row. [Type before](../../screenshots/269/board/mainboard-dropdown-type-before.jpg) · [after](../../screenshots/269/board/mainboard-dropdown-type-after.jpg) · [Assignee before](../../screenshots/269/board/mainboard-dropdown-assignee-before.jpg) · [after](../../screenshots/269/board/mainboard-dropdown-assignee-after.jpg) |
| Column states | Empty: dashed `#DCE6DF` box, square glyph, "No tickets". Drag-over: a green column outline and a "Drop here" slot. View switcher: the same segment | Empty and switcher match. Drag-over: only the dashed slot, no outline, no text | Drag-over | **Kept code:** Drag & Drop (the motion design) draws only the target slot, and wave 4 (DD-4) chose it. The slot now has the card's height (see Drag & Drop). [before](../../screenshots/269/board/mainboard-dragover-before.jpg) · [after](../../screenshots/269/board/mainboard-dragover-after.jpg) |
| Banners and toasts | Red error banner. Blocked-drag card: `#FEF3C7`, 1.5 px `#E8B93A`, radius 10, a 16 px line triangle, "This ticket is blocked. Move to In Progress anyway?", Move Anyway filled, Cancel outlined | Matches (MB-5, TS-3). The banner is `App.tsx` | None | None: matches. [now](../../screenshots/269/board/mainboard-blocked-confirm-before.jpg) |

## List View (`ListView.dc.html`, v1)

| Section | Design | Code today | Gap | Fix |
|---|---|---|---|---|
| Shared filter bar | The Main Board bar above the panel | The same component | None | None: see Main Board |
| Full panel — toolbar | "Group by" 12/600 `#9AA8A0`, Status dropdown, divider, "Status: All". Sort is a Due Date / Created toggle, then Collapse All | Same toolbar. Sort is the "⇅ Sort: Due date" menu with seven options | Sort control | **Kept code:** the later ticket-reopen E1 / ticket-pending F1 docs replace the toggle with the menu (board LV-2) |
| Groups (Backlog, To Do, In Progress, Review collapsed, Testing, Done) | Header padding 9/12, `#F6FAF7`, radius 7, 7 px dot, 10 px chevron, 13.5/700 name, mono 11/700 count. **10 px** between groups. Rows padding 9/12, gap 14: mono 11 key (68 px), 13 px title, 10.5/700 chips, due 78 px right-aligned 11.5 with "—" when empty, status chip 76 px. A Done row strikes the key only; the **title stays `#1E2A22`** | Header, rows and chips match (measured). Groups 12 px apart. A Done row's title is grey `#5B6B60`. A KEY · TITLE · PRIORITY · DUE · STATUS header row and an assignee avatar are extra (LV-1, later docs) | Group gap, Done title colour | Groups 10 px apart, Done title dark. [full before](../../screenshots/269/board/listview-full-before.jpg) · [after](../../screenshots/269/board/listview-full-after.jpg) · [Done before*](../../screenshots/269/board/listview-done-before.jpg) · [after](../../screenshots/269/board/listview-done-after.jpg) (*old values injected) |
| Group by dropdown open | 170 px menu: By Status (check), By Priority, By Tag | Same | None | None: matches. [now](../../screenshots/269/board/listview-groupby-before.jpg) |
| Status filter dropdown open | Checkboxes (15 px, radius 4, 1.6 px `#C7D2CB`, filled forest when on), a 7 px status dot, "2 selected" past one | Same | None | None: matches. [now](../../screenshots/269/board/listview-status-before.jpg) |

## Sub-task Grouping (`BoardGrouping.dc.html`)

| Section | Design | Code today | Gap | Fix |
|---|---|---|---|---|
| Column headers | 11/700 .05em `#9AA8A0`, no bar | Main Board's header with count pill and bar | Older drawing | **Kept code:** Main Board (later, assembles this pattern) draws the header with pill and bar |
| Column lanes | `#F6FAF7` lanes, radius 10 | Transparent lanes on the `#FBFCFB` page | Lane fill | **Kept code:** Main Board draws columns with no lane fill |
| Connector lines | Dashed 1.5 `#68BA7F` (3 3) across columns, a `#9BB3A4` elbow to the indented child, a 1.6 px forest ring 4 px out, radius 12 | `ParentGroupLinks` with the same strokes, outline 1.6 px at offset 3 (BG-1). Shown on hover or focus, not on click | Trigger | **Kept code:** hover, so a click still opens the ticket at once (wave 3 BG-1 decision). [now](../../screenshots/269/board/boardgrouping-hover-parent-before.jpg) |
| Sub A: To Do | Compact card (13 px title, 18 px avatar, 9 px parent chip) | The full card (rev. 6 sizes) | Older sizes | **Kept code:** Ticket Card rev. 6 is the later card |
| Parent: In Progress | `#F1F8F3` / `#D7E8DC` always on, a 4 px progress bar, "2/3 sub-tasks" 10/600 | Identical (`.cardParent`, `.subtaskProgressBar`) | None | None: matches |
| Sub B: indented | Indented 22 px under the parent | 18 px | Indent | **Kept code:** Main Board (later) indents 18 px |
| Sub C: Done | Struck ID, dark title, no priority | — | — | Fixed with Ticket Card "Done" |

## Timeline View (`TimelineView.dc.html`, v1)

| Section | Design | Code today | Gap | Fix |
|---|---|---|---|---|
| Sub-mode switcher | Segment on `#EEF3EF`, buttons 7/14 12.5/600, active white with a shadow | Identical (measured) | None | None: matches |
| Gantt | 230 px label column, 40 px header (10.5/700 uppercase, `#F6FAF7`), 46 px rows, 12.5 title, mono 11 key. Bars 16 px radius 4 (blue, red overdue, green done at .6), 10/700 white label. Today line 2 px forest at .4. A due-only marker with "Due Sep 12". Legend: Normal, Overdue, Done, Today | Identical sizes and colours (measured). The legend adds Pending now, Past pending, Reopened and Earlier Done span (later docs). Bars under 40 px print no label (TV-1) | None | None: matches. **Kept code:** the extra legend items. [now](../../screenshots/269/board/timeline-gantt-before.jpg) |
| Resize to change dates | Hover: 2×8 white grips at both ends. Dragging: a dashed `#B9CBBF` start outline, shadow, a "Due Sep 26" / "Starts Sep 14" tooltip | Grips, ghost, shadow and tooltip (TV-3, wave 4) | None | None: matches (resize not repeated live: it would change dates). [hover now](../../screenshots/269/board/timeline-hover-before.jpg) |
| Event Timeline | The Debug Space rail: 13 px dots with a white ring (created green +, status blue ↺, comment purple, other grey). A 10.5 mono chip, 12.5 title, 10.5 time "4:12 PM". Action 11.5 `#5B6B60` with a grey detail: "Changed status — To Do → In Progress", **"Changed assignee — unassigned → An"** | Rail, dots, chip and times match. The assignee change printed the member's UUID ("none → c83ab287-…"). An added test case, criterion, sub-task, link or blocker read "Changed test case — none → Upload a PDF" | Assignee shows an id; "none →" wording | The assignee change names the member, or "unassigned" ("Changed assignee — unassigned → An Nguyen"; `members` now passed to `TimelineView`). An item added or removed reads "Added test case — …", "Removed link — …", "Added blocker — GIOT-8". Other changes keep "from → to". [before](../../screenshots/269/board/timeline-events-before.jpg) · [after](../../screenshots/269/board/timeline-events-after.jpg) |

## Left open

- **Review requested line on Review cards** (Main Board, Review column). It needs a server field naming who review was
  requested from (for example `review_requested_from: member id`, set when a ticket enters Review). Then the card
  shows a 15 px avatar and "Review requested — Name" at 10.5 `#5B6B60`.
- **New Ticket description toolbar look**: a `#F6FAF7` toolbar, the "MARKDOWN" label and a `#C7D2CB` border at rest.
  This lives in the shared `MarkdownEditor` (`compact`), which the ticket detail also uses. A change there needs the
  owner of the detail editors.
- **9 px chevron in dropdown triggers**: the shared `MenuSelect` draws 14 px. This affects every `MenuSelect`, not only
  New Ticket.
- **Sidebar** (232 px Ink Deep panel vs the hover rail): `ProjectSidebar`, not in these files (board MB-1).
- **Search field width** 220 px vs 170 px: kept so the filter bar stays one line at 1440 px (MB-3). It can grow if the
  filters ever fold into a menu.
- **Card menu**: no change was needed to `StatusMenu` for the card.
- Not checked live: AI run states on the card (running, queued, needs input, failed, in review) and schedule chips,
  because they need a real AI run. They were checked from the code only.

## Files changed

`ui/src/components/TicketCard.tsx`, `TicketCard.module.css`, `DraggableTicketCard.tsx`, `Board.tsx`,
`Board.module.css`, `Column.tsx`, `ListView.module.css`, `TimelineView.tsx`, `FilterBar.tsx`, and the New Ticket
(create mode) part of `TicketModal.tsx` / `TicketModal.module.css` (`.newModalBody`, `.ntInput`, `.newModalFooter`,
`.btnSubmit`; these classes are used only by the create form).
