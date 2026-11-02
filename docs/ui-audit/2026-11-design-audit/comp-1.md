# Comp 1 (Board and Ticket Card level) — design audit

Demo video: `/tmp/claude-0/-home-user-kanban-board-mcp/217c9eaa-a832-52d5-8a05-ade5a07b6b57/scratchpad/audit/videos/comp-1.mp4` (not committed, too large; 1 min 40 s, 14 scenes, Vietnamese captions)

Summary: 30 findings (0 critical, 4 high, 10 medium, 16 low). The tokens, fonts, type icons, priority marks, the status menu and the sub-ticket and criterion rows mostly match the design. The gaps are in how the board behaves. (1) Every card has a fixed minimum height, so the board looks loose and gappy next to the design's compact, content-height cards. (2) Some states the design draws are missing: the selected parent group (ring and connectors), the tag picker popover, the skeleton when you switch projects, and the drag motion. (3) Esc and focus details are wrong in the inline editors: Esc saves a tag, Esc does not cancel a new criterion, and a global `input:focus-visible` rule from `docs.css` draws a second ring inside every focused input.

Data added to KAN for this audit (nothing existing was changed): KAN-10…KAN-18. These are a many-tags task (KAN-10, with three acceptance criteria, two of them ticked), an overdue critical bug (KAN-11), a feature (KAN-12), a blocked chore (KAN-13, blocked by KAN-10), a long-title bug (KAN-14), and a parent (KAN-15) with three sub-tickets: KAN-16 in progress, KAN-17 to do, KAN-18 done. A tag and an AC tick that were added by accident to KAN-10 (my own ticket) during the probes were put back. Failure states were made with Playwright route stubs: a 500 on `PATCH /tickets/*/status`, and a 4–8 s delay on `GET /projects/*/tickets`. Nothing was saved on the server.

Card size measured at 1440×900 with the sidebar open. Columns are 188 px wide. Every card is **140 px** tall (`min-height: 140px`). The design's board card (`MainBoard.dc.html` `.mb-card`, the same values as `TicketCard.dc.html`: padding 12/14, gap 8) has no fixed height, so it fits its content:

| Card content | Design height (content) | App height | Empty band at the bottom |
|---|---|---|---|
| 1-line title, no tags (KAN-1 "Webhook retries") | ≈ 95 px | 140 px | **45 px** (32 % of the card) |
| 2-line title, no tags (KAN-4, KAN-8, KAN-14…) | ≈ 113 px | 140 px | **27 px** |
| 2-line title + tag row (KAN-10, KAN-11) | ≈ 139 px | 140 px | ≈ 1 px |

The 280×160 cards on the TicketCard artboard are fixed-size presentation frames. The Main Board doc, which is later and "pulled together" from the Ticket Card, draws the same card at its content height (for example "Upgrade dnd-kit to v7" ≈ 93 px).

## Theme & Typography (`design/foundations/theme-and-typography.md`)

Coverage: checked in code and in the app: brand and neutral tokens (`ui/src/index.css:3-40`), the fonts (Plus Jakarta Sans 400–800 and JetBrains Mono, loaded in `index.html:9` and `index.css:1`), and the type-scale classes. The rendered card title is Plus Jakarta Sans 14 px/600 and the ID is JetBrains Mono 11 px, as in the design. All nine palette hex values match exactly. The app icon is out of scope (the splash and sidebar belong to other parts).

| # | Frame | Severity | Category | Design | Now | Where | Fix |
|---|---|---|---|---|---|---|---|
| TT-1 | 4 | Low | type | A single type scale (Display 44/800 … Caption 12/500, Code 14 mono) used everywhere | `.text-display`, `.text-h1` … `.text-code` are defined but used **0** times. Components hard-code colours and sizes: `#2e6f40` appears 265 times in module CSS against 25 uses of `var(--color-forest)`, and there are 40+ different font sizes (12.5, 11.5, 10.5…) | `ui/src/index.css:103-160`, all `*.module.css` | Use the tokens and scale classes, at least for colours, so the palette cannot drift |
| TT-2 | 2 | Low | color | Only the palette tokens exist | `var(--color-orange)` is used but never defined, so the border falls back to `currentColor` | `ui/src/components/WorkLogSection.module.css:143` | Define it, or use `--color-inprogress` (#E2793D) |
| TT-3 | 4 | Low | type | The smallest text in the system is 10–11 px (card pills, captions) | 7, 8, 9 and 9.5 px text in about 15 places, for example `FilterBar.module.css:163` (8 px) and `ai/workflow/workflow.css:115` (7 px) | see left | Raise the floor to 10 px |
| TT-4 | — | Low | spacing | Card radius 8 (Ticket Card), skeleton/panel 12 | `--radius-card: 12px`, but the cards use 8 px, so the token does not mean the card | `ui/src/index.css:31` | Rename it, or set it to 8 px and use it on `.card` |

Images: [design type scale](../../../design/images/theme-and-typography/theme-and-typography-4-type-scale.png) · [design brand](../../../design/images/theme-and-typography/theme-and-typography-1-brand-colors.png)

## Ticket Card (`design/components/ticket-card.md`)

Extended by ticket-pending and ticket-reopen (the card "..." menu, pending rail and reopened badge) and by board-grouping (the parent tint). Those additions are not findings in themselves.

Coverage: checked in the app: 1 default (KAN-10), 2 hover (KAN-11), 4 blocked (KAN-13), 5 long title (KAN-14), 6 sub-ticket (KAN-16), 7 done (KAN-18). 3 dragging is covered under Drag & Drop. Matching: the title clamps to 2 lines with an ellipsis, the tags are uppercase 10/700 pills with a `+2` overflow, the hover border is #B9CBBF with the 0 2px 8px shadow and the grip shows, the blocked card has a 1.5px dashed #D9A79A border, 0.72 opacity and a floating lock, the parent chip `↳ KAN-15` shows, and the Done ID is struck in #C7D2CB.

| # | Frame | Severity | Category | Design | Now | Where | Fix |
|---|---|---|---|---|---|---|---|
| TC-1 | 1, 2, 5, 6, 7 (whole board) | High | spacing | Board cards fit their content (padding 12/14, gap 8, footer `margin-top:auto` with nothing to push it): ≈ 95 px with a 1-line title, ≈ 113 px with 2 lines | Every card is at least 140 px: a 45 px empty band under a 1-line card and 27 px under a 2-line card. The columns look sparse, and only about 5 cards fit above the fold instead of about 7 | `ui/src/components/TicketCard.module.css:18` (`min-height: 140px`), same in `AppLoading.module.css:97` (skeleton) | Remove `min-height` and let the card fit its content, as `.mb-card` does |
| TC-2 | 1, 2 | Medium | layout | At rest the header is type + label on the left and the ID flush right. Hover adds the grip. The "..." button appears only with the menu (TicketPending A1) | A tinted 24×24 "..." button is always visible in the top-right. `headerRight` keeps a 28 px right margin for it, so the ID sits 36 px from the edge and not at the right. The blocked lock badge sits on the button's corner (TC-5) | `TicketCard.tsx:234`, `TicketCard.module.css:235, 256` | Show the button on `:hover`/`:focus-within` (or with the menu open), and drop the 28 px margin at rest |
| TC-3 | 1 | Medium | missing | The footer ends with "3 pt" then the AC progress "2/4" (#5B6B60, 11 px) | KAN-10 has 2 of 3 criteria done, but the footer shows only "3 pt". The AC count is never rendered (the code comment lists it) | `TicketCard.tsx:711-760` | Add `{done}/{total}` after the estimate when the ticket has criteria |
| TC-4 | 2 | Low | copy | "Due Sep 12" (calendar icon, 11/600, red when overdue) | "Oct 30": the word "Due" is missing | `TicketCard.tsx:757` | Render `Due {due.label}` |
| TC-5 | 4 | Low | layout | The floating lock badge has the corner to itself | The lock badge (top -6, right -4) overlaps the always-visible "..." button (top 8, right 8) | `TicketCard.module.css:163, 256` | Fixed by TC-2; otherwise move the button down or left on blocked cards |

Images: [design 1](../../../design/images/ticket-card/ticket-card-1-default.png) · [now 1](shots/comp-1/ticket-card-1.jpg) · [design 2](../../../design/images/ticket-card/ticket-card-2-hover.png) · [now 2](shots/comp-1/ticket-card-2.jpg) · [design 4](../../../design/images/ticket-card/ticket-card-4-blocked.png) · [now 4](shots/comp-1/ticket-card-4.jpg) · [now 5](shots/comp-1/ticket-card-5.jpg) · [design 6](../../../design/images/ticket-card/ticket-card-6-sub-ticket.png) · [now 6](shots/comp-1/ticket-card-6.jpg) · [design 7](../../../design/images/ticket-card/ticket-card-7-done.png) · [now 7](shots/comp-1/ticket-card-7.jpg) · [design main board](../../../design/images/main-board/main-board-1-full-screen.png) · [now board](shots/comp-1/board-overview.jpg)

## Notification Toast (`design/components/toast.md`)

Extended by notifications.md: a success toast without a second action becomes the "quiet line" (`Toast.tsx:198`), so "Moved to Done" never shows as a card toast. This is not a finding.

Coverage: checked in the app: the error toast (a failed status move, made with a stubbed 500). Warning variant from code only (no reachable trigger without failing an AI path). The inline banner is not built.

| # | Frame | Severity | Category | Design | Now | Where | Fix |
|---|---|---|---|---|---|---|---|
| TS-1 | 1 | Medium | spacing | Padding 16, radius 14, gap 12, a 32 px round icon badge, title 14/600, detail 13 px, close × in a 22 px box | Padding 11/12, radius 11, gap 10, a **24 px** badge, title 13/700, detail 12 px, close in 20 px. The toast is visibly smaller and tighter | `ui/src/components/Toast.module.css:15-80` | Use the design values |
| TS-2 | 1 | Low | color | Badges: success #CFFFDC (Mint), error #FBE7E4, warning #FCEFD9 with #B4791E "!". Border #DCE6DF, shadow 0 10px 24px .10, × #B7C4BC | #E6F2EA / #FDECE8 / #FEF3D9 with #B8860B. The warning uses a triangle icon. Border #E3E8E5, shadow 0 8px 24px .14, × #9AA8A0 | `Toast.module.css:25-66, 110`, `Toast.tsx:96` | Use the design colours and the "!" mark |
| TS-3 | 1 | Medium | behavior | A failed save gives one toast: "Couldn't save changes · Check your connection and try again." | Two messages: a full-width red banner at the top ("Simulated network error (audit)") pushes the whole page down about 53 px, and the error toast repeats the same text | `ui/src/App.tsx:651-652` (and `:674-675`) | Keep only the toast for a failed move. Keep the banner for errors with no toast |
| TS-4 | 1 | Low | copy | Detail: "Check your connection and try again." | The detail is the raw server message (`extractError`) | `App.tsx:652` | Use the design line, and show the raw error only on hover or in details |
| TS-5 | 2 | Low | missing | Inline banner "Board synced — all changes saved" (#F6FAF7, ✓) | Not built (no such copy or component) | — | Add it, or mark it as dropped in the design |

Images: [design 1](../../../design/images/toast/toast-1-toast-variants.png) · [now 1](shots/comp-1/toast-1-crop.jpg) · [now, banner + toast](shots/comp-1/toast-1.jpg)

## Loading States (`design/components/loading.md`)

Extended by app-loading.md (the skeleton under the real column headers, the status pill). The first-load skeleton follows that later doc (188×140 r8 cards), so its size is not a finding.

Coverage: checked in the app: 1 column skeleton (first load with tickets delayed) and the project switch with tickets delayed. 2 full-page spinner and 3 button states from code. `LoadingStates.tsx` has components that match the design exactly but are not used.

| # | Frame | Severity | Category | Design | Now | Where | Fix |
|---|---|---|---|---|---|---|---|
| LD-1 | 1 | High | state | While a column's tickets load, it shows skeleton cards | Switching projects never shows the skeleton. If the target project was not loaded before, every column shows count **0** and "No tickets" until the data arrives (KAN, 6 s stub). If another project was loaded, the board keeps **that project's cards under the new project's name** ("Marketing Site" showing KAN-10, KAN-11…) | `ui/src/App.tsx:252, 790` (`ticketsPhase` only uses `isLoading` of a query with `placeholderData`) | Treat "fetching for a new project id" as the tickets phase, and do not show placeholder data from another project |
| LD-2 | 3 | Low | state | Saving… = the same button at 0.8 opacity with a 14 px white spinner, gap 8 | The buttons only swap their label to "Saving…" (12 places, for example `story/PlanReview.tsx:163`). `ButtonSpinner` and `FullPageSpinner` are never used | `ui/src/components/LoadingStates.tsx:41-48` | Use `ButtonSpinner` in the pending buttons |

Images: [design 1](../../../design/images/loading/loading-1-column-skeleton.png) · [now first load](shots/comp-1/loading-1-first.jpg) · [now switch, 0 / No tickets](shots/comp-1/loading-1-switch.jpg) · [now switch, stale cards](shots/comp-1/loading-1-stale.jpg) · [design 3](../../../design/images/loading/loading-3-button-states.png)

## Ticket Type Icons (`design/components/icons.md`)

Coverage: checked in the app: section 1 (Task, Bug, Feature, Chore at 15 px on cards, checked at 2× zoom) and section 2 (the priority bars Low…Critical, due, overdue, blocked, drag handle). The colours are identical (#9BB3A4, #E8B93A, #E2793D, #D64545, inactive #DCE6DF). Sections 3–5 (test case, debug space and workspace marks) belong to other screens' parts.

No findings.

Images: [design 1](../../../design/images/icons/icons-1-ticket-type-icons.png) · [design 2](../../../design/images/icons/icons-2-priority-status-marks.png) · [now](shots/comp-1/ticket-card-2.jpg)

## Tags (`design/components/tags.md`)

The Ticket Card (rev. 6) draws the card pills uppercase at 10 px. That later, more specific rule wins on the card, so the uppercase card pills are not a finding. Tags.md still applies to the ticket detail.

Coverage: checked in the app: 1 (card, read-only), 2 removable (ticket detail, KAN-10), 3 idle and typing, 4 add-tag picker.

| # | Frame | Severity | Category | Design | Now | Where | Fix |
|---|---|---|---|---|---|---|---|
| TG-1 | 2, 3 | Medium | type | Removable pills are 12 px/600 lowercase ("ui ×"), padding 3/6/3/10. "+ Add tag" is sentence case, 12 px | The detail uses the small card pill: 10 px/700 **UPPERCASE** ("UI ×", "A11Y ×"), and "+ ADD TAG" is 10 px uppercase. `TagPill size="large"` exists but is not used | `ui/src/components/TicketModal.tsx:1847, 1864` | Pass `size="large"`, and style Add tag as in the design |
| TG-2 | 4 | High | missing | Clicking "+ Add tag" opens a popover: a search input, matching existing tags ("perf · existing tag", click to attach) and a "Create "…"" row | It becomes a bare 90 px input, "Tag name…". Typing "pe" in a project that has "perf" suggests nothing, and there is no Create row | `TicketModal.tsx:1850-1862` | Build the picker (the same shape as the Relations "Add link" search) |
| TG-3 | 3 | Medium | behavior | Comma commits a pill. Esc cancels | **Esc saves the typed text as a tag**: the input unmounts, `onBlur` calls `handleAddTagSubmit`. This was reproduced: "pe" was added to KAN-10 and then put back. Comma does nothing | `TicketModal.tsx:1857-1860, 730` | On Esc, clear `newTagText` before closing (or ignore the blur after Esc). Commit on `,` |
| TG-4 | 2 | Low | state | Hover darkens the tint (bg 0.12 → 0.20) | Hover only changes the opacity of the × | `ui/src/components/TagPill.module.css:44` | Darken the pill background on hover |

Images: [design 2](../../../design/images/tags/tags-2-removable-tags.png) · [now 2](shots/comp-1/tags-2.jpg) · [design 4](../../../design/images/tags/tags-4-add-tag-popover.png) · [now 4](shots/comp-1/tags-4.jpg)

## Sub-task Grouping (`design/components/board-grouping.md`)

Coverage: checked in the app with KAN-15 (in progress) and its sub-tickets KAN-16 (same column), KAN-17 (To Do) and KAN-18 (Done). Matching: the parent's tint (#F1F8F3 / #D7E8DC) is always on, the "1/3 sub-tasks" progress bar (10/600) shows, the same-column child is indented 18 px, and the children carry the parent chip.

| # | Frame | Severity | Category | Design | Now | Where | Fix |
|---|---|---|---|---|---|---|---|
| BG-1 | 1 | High | missing | Clicking the parent selects the group: a green ring on the parent and every child, dashed connectors to the children in other columns, and an elbow to the indented child | There is no selected state. A click opens the ticket detail. No ring, no connectors and no elbow exist anywhere in the code | `ui/src/components/Column.tsx:170-185`, `Board.tsx` | Add a selected-parent state (a click selects it, a second click or Enter opens it) and draw the ring and the connectors |

Images: [design 1](../../../design/images/board-grouping/board-grouping-1-grouped-board.png) · [now 1](shots/comp-1/board-grouping-1.jpg)

## Drag & Drop (`design/components/drag-drop.md`)

Coverage: checked in the app: pick-up and dragging (KAN-10 from To Do toward In Progress, the drop failed on purpose with a stubbed 500 so nothing moved). The drop overshoot was checked from code (`@dnd-kit` default drop animation, no custom keyframes).

| # | Frame | Severity | Category | Design | Now | Where | Fix |
|---|---|---|---|---|---|---|---|
| DD-1 | 1 (Dragging) | Medium | layout | The lifted card keeps its footprint (274×154 in a 280 frame, scale 1.03) | The drag overlay is a fixed **280 px** wide while the column cards are 188 px. The lifted card grows by 92 px and covers the next column | `ui/src/components/Board.tsx:480` | Use the source card's measured width (`active.rect`) |
| DD-2 | 2 (source ghost) | Medium | spacing | The source ghost (1.5px dashed #C7D2CB) keeps the card's slot | The ghost is 118 px tall while the card is 140 px, so the cards below jump up 22 px on pick-up | `ui/src/components/DraggableTicketCard.tsx:52` | Give the ghost the card's measured height |
| DD-3 | 1 | Medium | behavior | Pick-up: scale 1.03, lift 4 px, shadow grows, 150 ms ease-out. Dragging: 1.5° tilt, 97 % opacity. Drop: overshoot to 1.05, then rest in 220 ms | The overlay appears at once rotated 1° with the 0 12px 24px shadow. There is no scale, no lift, opacity 1, and the default drop fade with no overshoot | `TicketCard.module.css:62`, `Board.tsx:478` (`DragOverlay` without `dropAnimation`) | Add the pick-up and drop keyframes from the doc (`cardMotion`), and pass a custom `dropAnimation` |
| DD-4 | 2 (target ghost) | Low | state | Only a target slot: 1.5px dashed #9BB3A4, fill rgba(104,186,127,.08), no text | The whole column gets a 2px dashed forest outline (offset 4), and the slot has a "Drop here" label | `ui/src/components/Board.module.css:165`, `Column.tsx:214` | Drop the column outline. Keep the slot without text (the reopen and pending hints may keep their text) |

Images: [design 1](../../../design/images/drag-drop/drag-drop-1-sequence-filmstrip.png) · [design 2](../../../design/images/drag-drop/drag-drop-2-live-loop-frame.png) · [now picked up](shots/comp-1/drag-drop-1.jpg) · [now over target](shots/comp-1/drag-drop-2.jpg)

## Status Menu (`design/components/status-menu.md`)

Coverage: checked in the app: 1 closed and 2 open (KAN-10). The order, the divider before Won't Do, the check plus tinted current row, and the hover all match.

| # | Frame | Severity | Category | Design | Now | Where | Fix |
|---|---|---|---|---|---|---|---|
| SM-1 | 2 | Low | color | The doc says each status keeps "the dot colour it already has on the board (column accents)", but its image uses To Do grey and In Progress blue | The menu follows the image (To Do #9AA8A0, In Progress #2F6FB0), while the board accents are To Do blue #2F6FB0 and In Progress orange #E2793D. The same status shows two different colours | `ui/src/components/StatusMenu.tsx:12-19`, `index.css:18-25` | A design conflict: decide on one; the doc text says to use the column accents |

Images: [design 2](../../../design/images/status-menu/status-menu-2-open.png) · [now 2](shots/comp-1/status-menu-2.jpg)

## Add Sub-ticket (`design/components/add-subticket.md`)

Coverage: checked in the app: 1 idle, 2 expanded New, and 3 Existing with the search "drag" and the hover. The tabs, the hint "Enter to create and add another · Esc to cancel", the × and ✓ buttons and the filtering all match.

| # | Frame | Severity | Category | Design | Now | Where | Fix |
|---|---|---|---|---|---|---|---|
| AS-1 | 2, 3 (also AC 2, 5) | Low | state | One ring: the row's 1px #2E6F40 border with a 3px .10 halo. The input inside is borderless | A second 2px forest outline (offset 2) is drawn around the input inside the row: a box inside a box. It comes from an unscoped global rule `button:focus-visible, a:focus-visible, input:focus-visible` in the Docs stylesheet, which applies app-wide | `ui/src/components/docs/docs.css:486-490` | Scope the rule to the Docs root (`.dk-…`) |
| AS-2 | 3 | Low | missing | Each result starts with a 7 px status dot (filled = in progress, outline = to do) before the type icon | Results show only the type icon, title and ID | `ui/src/components/SubTicketsSection.tsx` (results list), `.resultItem` `SubTicketsSection.module.css:371` | Add the status dot |

Images: [design 2](../../../design/images/add-subticket/add-subticket-2-expanded-new.png) · [now 2](shots/comp-1/add-subticket-2.jpg) · [design 3](../../../design/images/add-subticket/add-subticket-3-expanded-existing.png) · [now 3](shots/comp-1/add-subticket-3.jpg)

## Add Acceptance Criterion (`design/components/add-ac.md`)

Coverage: checked in the app: 1 idle, 2 adding, 3 row hover (pencil and trash appear only on hover), and 5 editing (the checkbox stays). Section 4 (icon close-up) checked against 3.

| # | Frame | Severity | Category | Design | Now | Where | Fix |
|---|---|---|---|---|---|---|---|
| AC-1 | 2 | Medium | behavior | "Esc to cancel" (the app's own hint says the same) | After typing a criterion, Esc leaves the input open with the text. Only × closes it. `handleCancelNew` is never reached: the key is consumed earlier, most likely by `editorAi.onKeyDown` or `TicketRefSuggester` | `ui/src/components/AcceptanceCriteriaSection.tsx:306-313` | Let Esc fall through to `handleCancelNew` when no AI ghost or suggestion is open |
| AC-2 | 1, 3 (done rows) | Low | type | Criterion text 13 px #3A4A3E. A done row is #9AA8A0, struck in #C7D2CB (TicketDetail) | The text renders at **14 px**, and done rows stay dark #3A4A3E with a dark strike. The inline Markdown span overrides the row's size and colour | `ui/src/components/MarkdownRenderer.module.css:4-10` (`.markdown` 14 px, colour) over `AcceptanceCriteriaSection.module.css:73, 83` | Make the inline Markdown span `font-size: inherit; color: inherit` |

Images: [design 2](../../../design/images/add-ac/add-ac-2-adding-new.png) · [now 2](shots/comp-1/add-ac-2.jpg) · [now 2, after Esc](shots/comp-1/add-ac-2-esc.jpg) · [design 3](../../../design/images/add-ac/add-ac-3-row-hover.png) · [now 3](shots/comp-1/add-ac-3.jpg) · [design 5](../../../design/images/add-ac/add-ac-5-editing.png) · [now 5](shots/comp-1/add-ac-5.jpg)

## Patterns

- **Fixed heights where the design fits the content**: the card (`min-height: 140px`), the skeleton card (140) and the drag ghost (118, which does not even match the card). Card heights come out wrong in three places.
- **Esc handling in inline editors is unreliable**: Esc saves the tag (TG-3), Esc does not cancel a new criterion (AC-1), and Esc did not close the ticket detail while the cursor was in the sub-ticket list (seen while recording; ticket detail is another part).
- **The design's motion and selection states are missing**: drag pick-up and drop (DD-3), the selected parent group (BG-1), the tag picker (TG-2).
- **Leaking global CSS**: `docs.css` styles every `input`, `button` and `a` on focus (AS-1). The inline Markdown renderer forces 14 px and a colour on criterion text (AC-2).
- **Hard-coded values instead of tokens**: the type-scale classes are unused, and hex values are repeated hundreds of times (TT-1). An undefined token is in use (TT-2).
- Outside this part, but it affects the cards: at 1440 px with the sidebar open, the Done column is cut off at the right edge, and "New Ticket" is clipped in the header ([board](shots/comp-1/board-overview.jpg)). Left to the Main Board audit.
