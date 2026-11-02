# Ticket detail and its tabs (comp-2) — design audit

Demo video: `/tmp/claude-0/-home-user-kanban-board-mcp/217c9eaa-a832-52d5-8a05-ade5a07b6b57/scratchpad/audit/videos/comp-2.mp4` (3 min, 18 scenes, not in the repo)

Summary: 45 findings (0 critical, 8 high, 17 medium, 20 low). The main ticket panel matches the source closely: the title, labels, description, sub-tickets, sidebar and header view buttons use the design's exact sizes and colours. The gaps are in the secondary views and in pieces that were never built. These are the wave popover, the account menu, the lane-style branch graph, the retention popover and the "not set up" workspace state. Three problems repeat across the views: native `<select>` menus where the design draws custom menus (sidebar fields, retention, New Ticket assignee), markdown shown raw outside the description (`::: center`, `**…**` in Activity chips, the Debug pinned strip), and small copy differences (missing size or summary, wrong plurals).

Notes on the run:
- Data: I created my own tickets: **KAN-24** (parent with sub-tickets KAN-25, KAN-26 and KAN-27), **KAN-26** (leaf ticket with tags, sub-tasks, criteria, relations, a PDF and an image, a comment, four test cases, three debug entries, workspace files and two branches), **KAN-28** (empty) and **KAN-29** (rich Markdown description, with priority, status, assignee, title and description changes for Activity). I did not edit any existing ticket.
- Branches: as the brief allowed, I linked `/root/kbaudit-repo` to KAN (`repo_path`). I added branch `feature/drag-tests` (one commit) and `spike/pointer-events` in that repo, with no worktrees. The repo's default branch is `master`, and that is how BR-2 showed up.
- No AI run was started. "Suggest cases", "Draft more", "Draft with AI", the AI split button and chat were never pressed. In the video, the Create branch, Log entry and New Ticket forms were opened and cancelled. Nothing was submitted.
- Tag colours, the status menu and card visuals belong to another auditor and are not reported here.
- Description: the app ships **Approach B** (WYSIWYG). Approach A frames A2 and A3 (Write and Preview tabs) are an alternative the design left open, so their absence is not a finding.
- `ticket-detail-parent` is extended by [ai-story-flow](../../../design/screens/ai-story-flow.md). "Make this a Story" in the Sub-tickets header comes from that doc and is not extra.

## Ticket Detail (`design/components/ticket-detail.md`)

Coverage: frames checked in the app: 1 (header and tooltips), 2, 3, 4 (KAN-26). From code only: none. Not built: none.

| # | Frame | Severity | Category | Design | Now | Where | Fix |
|---|---|---|---|---|---|---|---|
| TD-1 | 1 | Low | layout | Four 30 px view buttons, then close | Five 30 px view buttons (Branches added), then a 32 px "✦ ⌄" split, a 34 px "✦ AI" and a 34 px "▾" glyph button: three heights in one row | `ui/src/components/TicketModal.tsx:1192-1325` | Give the AI buttons the `.dt-view-btn` 30 px height; use a chevron SVG instead of "▾" |
| TD-2 | 2 | Medium | missing | Each sub-task row ends with its ticket id in mono grey (`KAN-146`) | Sub-task rows show the circle and title only, with no id | `ui/src/components/SubTasksSection.tsx:62` | Show the linked ticket id at the right in JetBrains Mono 11 px `#9AA8A0` (or drop the ids from the design if sub-tasks are only checklist items) |
| TD-3 | 2 | Low | layout | Criterion checkbox centred on the first text line (`gap 9px`) | The checkbox sits about 5 px above the text line | `ui/src/components/AcceptanceCriteriaSection.module.css:29` | Add `margin-top: 2px` to the box, or align to the first line box |
| TD-4 | 3 | Medium | layout | Comments: the list first, then the avatar and the "Add a comment…" field at the bottom | The input sits above the list, and the list is sorted "Newest first" | `ui/src/components/CommentsSection.tsx:951,1022` | Default to oldest-first with the composer under the list, as drawn |
| TD-5 | 3 | Low | spacing | One divider between sections | Between Linked docs and Attachments there are two dividers with about 30 px of empty band | `ui/src/components/TicketModal.tsx` (linked docs and attachments block, about line 2240) | Drop the extra top border on the attachments zone when it follows another bordered section |
| TD-6 | 1, 4 | Medium | component | Sidebar values with a custom dropdown style (as Status and Branch) | Type, Priority and Estimate each hide a native `<select>` over the value, so clicking opens the OS menu | `ui/src/components/TicketModal.tsx:1060,2982,3048` | Use the StatusMenu-style popover for all three |

Images: [design 1](../../../design/images/ticket-detail/ticket-detail-1-header-bar.png) · [design 2](../../../design/images/ticket-detail/ticket-detail-2-main-title-to-criteria.png) · [design 3](../../../design/images/ticket-detail/ticket-detail-3-main-relations-attachments-comments.png) · [design 4](../../../design/images/ticket-detail/ticket-detail-4-sidebar.png) · [now 1–4, full length](shots/comp-2/ticket-detail-1-4.jpg)

## Ticket Detail — with Sub-tickets (`design/components/ticket-detail-parent.md`)

Coverage: frames checked in the app: 1, 2, 3, 4, 5, 6, 7 and 8 (KAN-24). The tooltip ("Test — 2 pass · 1 fail · …") and the Active state match. From code only: none. Not built: 7 (the wave popover).

| # | Frame | Severity | Category | Design | Now | Where | Fix |
|---|---|---|---|---|---|---|---|
| TDP-1 | 7 | High | missing | Clicking a wave badge opens a popover: label WAVE, stepper `− 2 +` and the "Auto-set from Blocked by" checkbox. The badge gets a green ring on hover | The badge is a plain `<span>` with `cursor: default`. Clicking it does nothing, and the wave cannot be pinned by hand | `ui/src/components/SubTicketsSection.tsx:213` | Make the badge a button that opens the popover; store a wave override next to the computed wave |
| TDP-2 | 6 | Medium | missing | Estimate "8 pt (rolled up)" from the sub-tickets | The parent shows "–" although its sub-tickets have 3, 2 and 3 pt | `ui/src/components/TicketModal.tsx:3042-3060` | When the parent has no estimate of its own, show the sum of the sub-ticket estimates with the "(rolled up)" suffix |

Images: [design 3](../../../design/images/ticket-detail-parent/ticket-detail-parent-3-main-sub-tickets.png) · [design 7](../../../design/images/ticket-detail-parent/ticket-detail-parent-7-wave-badge-popover.png) · [design 8](../../../design/images/ticket-detail-parent/ticket-detail-parent-8-header-button-states.png) · [now 1–6](shots/comp-2/ticket-detail-parent-1-6.jpg) · [now 8 tooltip](shots/comp-2/ticket-detail-parent-8.jpg)

## Description — Markdown (`design/components/description-markdown.md`)

Coverage: frames checked in the app: 1 (view), 4 (WYSIWYG) and 5 (the link popover, which matches closely), on KAN-29. Not built: 2 and 3 (Approach A, by choice).

| # | Frame | Severity | Category | Design | Now | Where | Fix |
|---|---|---|---|---|---|---|---|
| DM-1 | 1 | High | state | A centred image and a right-aligned "Reviewed by…" line, rendered | View mode prints the fences as text: "::: center", ":::" and "::: right Reviewed by … :::". The editor's own Align buttons write this syntax, and the editor shows it correctly, so any aligned text breaks once saved | `ui/src/utils/markdownWysiwyg.ts:816-821` (writes) vs `ui/src/components/MarkdownRenderer.tsx:188` (no plugin for it) | Add a remark plugin (or a pre-pass) for `::: center` / `::: right` to MarkdownRenderer, the same as `markdownWysiwyg.ts:465-477` does |
| DM-2 | 1 | Medium | icon | `> **Heads up:** …` renders as an amber callout (`#FDF4E3` with a border) with a line ⚠ icon and the lead words highlighted | A plain italic blockquote. Callouts only appear for `[!…]` syntax, and their icons are glyphs ℹ ⚠ ⛔ 💡 | `ui/src/components/MarkdownRenderer.tsx:55,208-218` | Use SVG line icons for the callouts. Decide whether a bold "Heads up:" lead also becomes a warning callout, as the design shows |
| DM-3 | 4 | Low | copy | English tooltips | The toolbar tooltips "Đính kèm tệp tin (Excel, Word…)" and "Chèn ảnh" are in Vietnamese, among English ones | `ui/src/components/MarkdownEditor.tsx:1212,1357` | Use "Attach file" and "Insert image" |

Images: [design 1](../../../design/images/description-markdown/description-markdown-1-approach-a-view.png) · [design 5](../../../design/images/description-markdown/description-markdown-5-link-popover.png) · [now 1](shots/comp-2/description-markdown-1.jpg) · [now 5](shots/comp-2/description-markdown-5.jpg)

## Attachments (`design/components/attachments.md`)

Coverage: frames checked in the app: 1 (KAN-26). From code only: 2 (uploading).

| # | Frame | Severity | Category | Design | Now | Where | Fix |
|---|---|---|---|---|---|---|---|
| ATT-1 | 1 | Medium | copy | File chip: name and size ("qa-notes.pdf / 248 KB"), with a blue tinted icon | Shows "PDF" instead of the size for files linked from Markdown (the size is unknown); the icon is red | `ui/src/components/TicketModal.tsx:2346-2347` | Fetch the size (`/upload-info/{path}` exists) and show `formatFileSize`; use the design's tint per type |
| ATT-2 | 1 | Low | layout | attachments.md: "One zone, ticket-wide — placed after Comments" | The zone sits before Comments. ticket-detail.md images 3 and 5 also draw it before Comments, so the design contradicts itself | `ui/src/components/TicketModal.tsx:2242` | Settle on one order; the code comment already says "placed after Comments" |
| ATT-3 | 2 | Medium | missing | While a file uploads: a pulsing placeholder thumbnail (1.4 s), or a thin progress bar under a file name | Items whose source is `uploading:` are filtered out of the zone, so nothing shows until the upload ends | `ui/src/components/TicketModal.tsx:2270` | Render the in-flight items with the `attPulse` placeholder and a progress bar |

Images: [design 1](../../../design/images/attachments/attachments-1-consolidated-zone.png) · [design 2](../../../design/images/attachments/attachments-2-uploading.png) · [now 1](shots/comp-2/attachments-1.jpg)

## Relations (`design/components/relations.md`)

Coverage: frames checked in the app: 1, 2 (KAN-24 "No links" and dashed Add link) and 3 (type select, search, highlighted matches, already-linked tickets excluded). All of them match except:

| # | Frame | Severity | Category | Design | Now | Where | Fix |
|---|---|---|---|---|---|---|---|
| REL-1 | 1 | Low | state | Remove "×" hidden at rest; it appears on row hover and turns red | The "×" is always visible (opacity 1) | `ui/src/components/RelationsSection.module.css:105` | `opacity: 0` at rest, `1` on `.row:hover` |

Images: [design 1](../../../design/images/relations/relations-1-grouped-populated.png) · [design 3](../../../design/images/relations/relations-3-add-link-form.png) · [now 1](shots/comp-2/relations-1.jpg) · [now 3](shots/comp-2/relations-3.jpg)

## Branches (`design/components/branches.md`)

Coverage: frames checked in the app: 1 (the sidebar row "from master · 1 ahead"), 2 (the switcher popover, close to the design), 3, 4 and 5, on KAN-26 with `/root/kbaudit-repo`. Note: the design models a branch as a variant **ticket** (each branch has its own KAN id and switches the panel to that ticket). The app models plain git branches. Rows therefore show no ticket ids, and clicking a branch in the popover does not open another ticket.

| # | Frame | Severity | Category | Design | Now | Where | Fix |
|---|---|---|---|---|---|---|---|
| BR-1 | 3 | High | layout | Graph tab: a lane diagram with labelled lanes on the left, curved forks, a merge node with ✓, an open tip as a hollow ring, a stale tip as a dashed ring with ×, and "KAN-152 — you are here" | "Overview / All commits" tabs, a branch list and a git-log commit graph (commit rows with refs) | `ui/src/components/BranchesSection.tsx:175`, `ui/src/components/BranchGraph.tsx` | Draw the lane view as the default Graph content and keep the commit log behind "All commits" |
| BR-2 | 5 | High | behavior | "Branch from" defaults to the baseline | The base is hard-coded to `'main'` and `main` is always added to the options. In a repo whose default branch is `master`, the API rejects the default: "Branch 'main' does not exist in the repository" (checked through the API with the same payload). The popover also labels the baseline "main" | `ui/src/components/CreateBranchModal.tsx:66,132,157`, `ui/src/components/BranchesSection.tsx:179,565` | Read the repo's default branch (HEAD) and use it as the baseline name and default |
| BR-3 | 5 | Medium | component | A small popover card next to the Create branch button | A centred modal over the dimmed panel, with an extra "Create git worktree" box | `ui/src/components/CreateBranchModal.module.css:2` | Anchor it as a popover under the trigger |
| BR-4 | 4 | Medium | missing | The list starts with "● main · baseline · BASELINE", then the other branches; one dashed "Create branch" under the table | No baseline row. "Create branch" appears twice (dashed top-right and dashed under the table). Each row has four buttons (Checkout, Rename, Merge or Archive, trash) where the design has one | `ui/src/components/BranchesSection.tsx:250-300` | Add the baseline row; keep one Create branch; move Checkout and Rename into a row menu |
| BR-5 | 3, 4 | Low | color | Each branch keeps one colour (stale is red) | `spike/pointer-events` has a purple dot in Overview and a red dot in List | `ui/src/components/BranchesSection.tsx` (overview rows) | Use the same colour function in both views |

Images: [design 2](../../../design/images/branches/branches-2-switcher-popover.png) · [design 3](../../../design/images/branches/branches-3-branch-graph.png) · [design 4](../../../design/images/branches/branches-4-branch-list.png) · [design 5](../../../design/images/branches/branches-5-create-branch-popover.png) · [now 2](shots/comp-2/branches-2.jpg) · [now 3](shots/comp-2/branches-3.jpg) · [now 4](shots/comp-2/branches-4.jpg) · [now 5](shots/comp-2/branches-5.jpg)

## Test Cases (`design/components/test-cases.md`)

Coverage: frames checked in the app: 1 (KAN-26), 2 (KAN-24 rollup with the Show dropdown and per-ticket groups) and 3 (the inline add row). The running dot pulse is in the CSS. From code only: none.

| # | Frame | Severity | Category | Design | Now | Where | Fix |
|---|---|---|---|---|---|---|---|
| TC-1 | 1, 2 | Medium | state | Each row has the assignee's avatar (initials of a person) | Unassigned rows show a fake "QA" avatar. The UI has no way to set an assignee. An assignee stored by member id (through the API or MCP) shows "3D", the first two characters of the UUID | `ui/src/components/TestCasesSection.tsx:65-69,267` | Resolve the assignee through the members list (`MemberAvatar`), show nothing (or a dashed circle) when unassigned, and add a picker |
| TC-2 | 1, 2 | Medium | missing | The expanded row shows Description, Expected result (with files and "+ Attach file"), Test data (with files) and Notes (with files); proof and note are merged into Notes; the footer reads "Started 4m ago by Ha My · Last edited 1m ago" | It has a separate "Result and proof" field as well as Notes. Only Test data has Attach file. The footer reads only "Last edited 8m ago" | `ui/src/components/TestCasesSection.tsx:354-356` | Merge proof into Notes, add per-field attachments on Expected result and Notes, and add who started or failed the case |
| TC-3 | 2 | Low | type | Child group header "KAN-145 · Write unit tests for drag handle — read-only here" in sentence case grey; only children that have cases are listed | The title is upper-cased ("[COMP-2] WRITE UNIT TESTS … — READ-ONLY HERE"), and children without cases get an empty box "No test cases for this child." | `ui/src/components/TestCasesSection.tsx:891-895`, `TestCasesSection.module.css:457` | Do not uppercase the title; hide empty children (their counts are already in "Show") |
| TC-4 | 3 | Low | layout | The inline add row has the title only, with Add and Cancel | It adds a second "Description (optional…)" field | `ui/src/components/TestCasesSection.tsx:826` | Drop the field; the description is filled in after expanding the row, as the design says |
| TC-5 | 1 | Low | layout | Count label on the left, "+ Add test case" on the right | "✦ Suggest cases" floats in the middle of the row | `ui/src/components/TestCasesSection.tsx:30` | Put it next to Add test case, on the right |

Images: [design 1](../../../design/images/test-cases/test-cases-1-leaf-ticket.png) · [design 2](../../../design/images/test-cases/test-cases-2-parent-rollup.png) · [design 3](../../../design/images/test-cases/test-cases-3-add-inline-row.png) · [now 1](shots/comp-2/test-cases-1.jpg) · [now 2](shots/comp-2/test-cases-2.jpg) · [now 3](shots/comp-2/test-cases-3.jpg)

## Debug Space (`design/components/debug-space.md`)

Coverage: frames checked in the app: 1 and 2 (KAN-26), plus the empty state on KAN-28. The tooltip "Debug — 3 entries · 1 blocked", the kind colours, the pinned strip and the star toggle match.

| # | Frame | Severity | Category | Design | Now | Where | Fix |
|---|---|---|---|---|---|---|---|
| DS-1 | 1 | Low | layout | Chips: All, Root cause, Investigation, Fix attempt, Blocked, Resolved | Investigation, Fix attempt, Root cause, Blocked, Resolved | `ui/src/components/DebugSpaceSection.tsx:34` | Put Root cause first |
| DS-2 | 1 | Low | copy | Pinned strip: a plain one-line summary | The Markdown is stripped badly: "Root cause : onDragEnd fires…" (space before the colon, code style lost) | `ui/src/components/DebugSpaceSection.tsx:582-590` | Render the first line with the inline Markdown renderer instead of stripping it |
| DS-3 | 2 | Medium | missing | The note field has a compact toolbar (B, i, code, link) and a "MARKDOWN" label | A plain `<textarea>` with "(Markdown supported)" in the placeholder | `ui/src/components/DebugSpaceSection.tsx:289` | Reuse the compact MarkdownEditor toolbar (it is shared with New Ticket in the design) |
| DS-4 | 2 | Low | state | The name is prefilled with the current person ("An"); branch and test case are linked after saving, from the card | The name is empty ("Your name…"). Two native selects "Link a branch…" and "Link a test case…" in mono type sit in the form | `ui/src/components/DebugSpaceSection.tsx:320` | Prefill the actor's name; move the link selects to the saved card or style them as chips |

Images: [design 1](../../../design/images/debug-space/debug-space-1-ticket-timeline.png) · [design 2](../../../design/images/debug-space/debug-space-2-log-entry-form.png) · [now 1](shots/comp-2/debug-space-1.jpg) · [now 2](shots/comp-2/debug-space-2.jpg) · [empty states](shots/comp-2/empty-states.jpg)

## Workspace (`design/components/workspace.md`)

Coverage: frames checked in the app: 1 and 4 (KAN-26), and 3 as "no folder yet" (KAN-28). From code only: 2 (turning the setting off would change shared data) and 5 (`WorkspaceSettingsSection.tsx`).

| # | Frame | Severity | Category | Design | Now | Where | Fix |
|---|---|---|---|---|---|---|---|
| WS-1 | 4 | High | component | The retention chip ("Auto-delete in 12 days") opens a popover: THIS TASK'S RETENTION, a checked list (7, 14, 30 days, Keep forever) and the helper text | The chip does nothing. A permanent "Retention Policy" band with a native `<select>` sits under the path | `ui/src/components/WorkspaceSection.tsx:283-304` | Remove the band; make the chip open the popover menu |
| WS-2 | 1 | Medium | copy | Tooltip "Workspace — 6 files · 12.4 MB" | Tooltip "Workspace" | `ui/src/components/TicketModal.tsx:1259` | Build the tooltip from `file_count` and `total_bytes`, as the Test and Debug tooltips are built |
| WS-3 | 2 | Medium | missing | When the workspace is off: "Workspace isn't set up yet", the helper text and an "Open Settings" button | Not built: turning it off hides the Workspace tab everywhere | `ui/src/components/settings/WorkspaceSettingsSection.tsx:88-95`, `WorkspaceSection.tsx` | Keep the button and show the empty state with Open Settings |
| WS-4 | 1 | Low | icon | `~/kanban-workspace/KAN-145`; an icon per file type (image orange, video purple, JSON blue, log grey); folder rows show "3 files"; a read-only footer note | An absolute `/root/…` path; csv and pdf share the same blue icon; folders show no count; no footer | `ui/src/components/WorkspaceSection.tsx:124,436-450` | Show `~` for the home folder, map icons by extension, add the folder count and the footer line |
| WS-5 | 3 | Low | copy | "Empty — the folder exists, nothing's been written to it yet." in a dashed box | A ticket with no folder shows "This ticket has no workspace folder yet…" and "Create folder"; an existing empty folder shows "No files yet. Drop files here…" | `ui/src/components/WorkspaceSection.tsx:332,442` | Use the design's dashed box with the folder icon and wording |
| WS-6 | 5 | Low | copy | Root folder hint "Each task gets {this}/{TICKET-KEY}/ automatically." with Browse… | The hint is about moving folders; Browse… exists only in the desktop app | `ui/src/components/settings/WorkspaceSettingsSection.tsx:97-124` | Add the `{TICKET-KEY}` hint line |

Images: [design 1](../../../design/images/workspace/workspace-1-enabled-with-files.png) · [design 2](../../../design/images/workspace/workspace-2-not-enabled.png) · [design 4](../../../design/images/workspace/workspace-4-retention-menu.png) · [now 1](shots/comp-2/workspace-1.jpg) · [empty states](shots/comp-2/empty-states.jpg)

## New Ticket (`design/components/new-ticket.md`)

Coverage: frame 1 checked in the app (board "+ New Ticket"). The Type segmented buttons with icons and the Cancel and Create Ticket footer match. The Draft with AI strip comes from the AI docs.

| # | Frame | Severity | Category | Design | Now | Where | Fix |
|---|---|---|---|---|---|---|---|
| NT-1 | 1 | High | component | Assignee is a dropdown trigger in the Status-Menu style (dashed avatar, "Unassigned ⌄") | A native `<select>` with the grey OS look | `ui/src/components/TicketModal.tsx:956` | Reuse the AssigneePicker or Filter-bar assignee dropdown |
| NT-2 | 1 | High | missing | Tags field (with pill preview) and Start date beside Due date ("all the current fields stay") | No Tags and no Start date in the create form | `ui/src/components/TicketModal.tsx:909-990` | Add the Tags input with preview pills and a Start date input in the dates row |
| NT-3 | 1 | Medium | component | Priority: chips with coloured dots, ordered Low, Medium, High, Critical, on one line | Signal-bar icons, ordered Critical to Low, and "Low" wraps onto a second row because Estimate shares the line | `ui/src/components/TicketModal.tsx:920-936` | Use dot chips in the design order; give Priority its own row and put Assignee on the right |
| NT-4 | 1 | Medium | component | Description: a bordered box with the compact toolbar (B, i, list, code, image) and a "MARKDOWN" label, about 140 px tall | A bare "Add a description…" line with no box or toolbar until it is focused | `ui/src/components/TicketModal.tsx:909` | Show the boxed editor with its toolbar at rest |
| NT-5 | 1 | Low | component | Estimate buttons include "—" (none) | Starts at 1; there is no "—" | `ui/src/components/TicketModal.tsx:937` | Add the "—" button |

Images: [design 1](../../../design/images/new-ticket/new-ticket-1-modal.png) · [now 1](shots/comp-2/new-ticket-1.jpg)

## Activity (`design/components/activity.md`)

Coverage: frames checked in the app: 1 (KAN-26 and KAN-29: day groups, chips, field bubbles, struck-through old title, Show and Hide changes diff) and 2 (the hover tooltip "Mon, Nov 2 · 5:09 PM / 4 mins ago" is present). 4 is checked in code ("Show N earlier changes"); 5 is in code (`isLoading`). 3 cannot be reached: every ticket has a "created" entry.

| # | Frame | Severity | Category | Design | Now | Where | Fix |
|---|---|---|---|---|---|---|---|
| ACT-1 | 1 | Low | copy | Field rows with clean values | Debug entries appear as "WORK LOG · Developer" with raw Markdown in the chip (`**Root cause**: \`onDragEnd\`…`) | `ui/src/components/ActivitySection.tsx:301` | Label the rows "Debug" and render or strip the Markdown in the chips |
| ACT-2 | 3, 4 | Low | copy | "0 changes · KAN-150", "Show 12 earlier changes"; empty text "Changes to status, assignee, priority and other fields will show up here." | "1 CHANGES · KAN-28" and "Show 1 earlier changes" (always plural); the empty text differs | `ui/src/components/ActivitySection.tsx:1200,1290,1526` | Pluralise; use the design copy |
| ACT-3 | 1 | Low | state | The diff highlights the changed words inside the red and green lines | The whole line is highlighted | `ui/src/components/ActivitySection.tsx` (diff block, about line 1377) | Add a word-level diff mark inside the changed lines |

Images: [design 1](../../../design/images/activity/activity-1-timeline.png) · [design 3](../../../design/images/activity/activity-3-empty.png) · [now 1](shots/comp-2/activity-1.jpg) · [empty states](shots/comp-2/empty-states.jpg)

## Account Menu (`design/components/account-menu.md`)

Coverage: frames 1 and 3 checked in the app (sidebar resting and rail). From code: 2 and 4. Not built: all four.

| # | Frame | Severity | Category | Design | Now | Where | Fix |
|---|---|---|---|---|---|---|---|
| AM-1 | 1, 2, 3 | High | missing | An account row at the bottom of the sidebar (avatar, name, email in mono, chevron) opens a menu: identity header with "Signed in with Google", Account settings, Settings, divider, Sign out in red. The rail shows the avatar only | The sidebar ends with Ask AI, Notifications, Settings, Members and Recycle Bin. There is no account row and no menu (the app has no signed-in user) | `ui/src/components/ProjectSidebar.tsx:355` | Add the row once the backend has a current-user endpoint (the design's TODO) |
| AM-2 | 4 | Medium | missing | "You have been signed out" and "Your session expired" toasts | Not built (no sign-out or 401 flow) | `ui/src/components/Toast.tsx` | Add both toast variants with the sign-out work |

Images: [design 2](../../../design/images/account-menu/account-menu-2-sidebar-menu-open.png) · [design 3](../../../design/images/account-menu/account-menu-3-collapsed-rail.png) · [now 3](shots/comp-2/account-menu-3.jpg)

## Patterns

- **Native `<select>` where the design draws a custom menu:** Type, Priority and Estimate in the sidebar (TD-6), workspace retention (WS-1), the New Ticket assignee (NT-1) and the Debug link pickers (DS-4).
- **Markdown shown raw or stripped badly outside the editor:** alignment fences in view mode (DM-1), Activity chips (ACT-1) and the Debug pinned strip (DS-2).
- **Header summaries and counts:** the Workspace tooltip has no summary (WS-2); "1 changes" and "Show 1 earlier changes" (ACT-2); attachment chips show the type instead of the size (ATT-1).
- **Design pieces never built:** the wave popover (TDP-1), the lane branch graph (BR-1), the retention popover (WS-1), "Workspace isn't set up yet" (WS-3), the uploading state (ATT-3) and the account menu (AM-1).
- **Hard-coded names:** `main` as the baseline (BR-2), a "QA" placeholder avatar and UUID initials (TC-1).
- **Emoji or glyphs as icons:** callouts ℹ ⚠ ⛔ 💡 (DM-2) and the "▾" button in the header (TD-1).
