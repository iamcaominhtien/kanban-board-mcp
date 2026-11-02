# Wave 3 fixes — ideas (Idea Space and Sketch)

Report: [ideas.md](../ideas.md). Folders edited: `ui/src/components/ideas/` only (nothing in `ui/src/components/sketch/` needed a change).
Before (5174) and after (5173) screenshots: `/tmp/claude-0/-home-user-kanban-board-mcp/217c9eaa-a832-52d5-8a05-ade5a07b6b57/scratchpad/w3/ideas/` (`<ID>-before.jpg`, `<ID>-after.jpg`; not in the repo).
No data was added, deleted or changed on purpose, and no AI action was pressed. One side effect that already existed: opening an idea page makes the editor save its normalised text once ("Page text edited +0 −1", this is IP-15). It happened on both 5173 and 5174 while taking the screenshots.
Rules kept: no feature, `data-testid` or keyboard path was removed. Where the design drops something the app has (the IDEA key, the voter avatars on stage cards, the native project select in the "not in a project" banner), it was kept and moved.
New shared piece: `ideas/ideaIcons.tsx` (`IdeaIcon`) has the Idea Space's own line icons (flask, flag, rocket, inbox tray, merge, archive, calendar, thumb…), with the paths taken from `design/source/Idea*.dc.html`. Any `LineIcon` name also works. `ideaShared.tsx` gains `StateCard` (icon, coloured title, body, actions below) and `shortDate`.

## Idea Space — list, stages & matrix
- ISV-1 · Fixed. Stage chips use the design's colours (Exploring `#E8F1FA/#244E78`, Ready `#E6F2EA/#1F5A31`, Building `#FFF1E0/#8A4B08`, Parked grey, Shipped `#EFE8FB/#5B3AA6`, Inbox amber) and show the stage icon before the label. Readiness badges were brought into line too (Growing blue, At risk red) (`ideaShared.tsx` `StagePill`, `ideaIcons.tsx` `STAGE_ICONS`, `ideas.css`).
- ISV-2 · Fixed. `ReadinessBar` is one continuous 96 px bar: green for the validated share, red for the disproved share, grey for the rest ("testing" counts as grey) (`ideaShared.tsx`, `ideas.css`).
- ISV-3 · Skipped — Low.
- ISV-4 · Skipped — Low.
- ISV-5 · Skipped — Low (the triage header's count is amber now, see ICT-1).
- ISV-6 · Fixed. Warnings (At risk, Stale n days, Back 1 Dec, the archive reason) are chips with icons beside the title. The second line shows the tags, then the source with its icon or the owner (else the author) with a pencil. The IDEA key stays, last and muted (`IdeaList.tsx`: `IdeaCell`, `WarningChip`).
- ISV-7 · Fixed in passing (Low): park dates read "Back 1 Dec" in the list, stage cards and details (`shortDate`).
- ISV-8 · Skipped — Low.
- ISV-9 · Fixed. The column header is a coloured dot, the name and the count. Cards show the title, a warning chip, tags, the bar, then a thumb vote count (the voters' names are in its tooltip), the key, the ticket chip with a status dot, "Back …" for parked ideas, and a **Promote** button on Ready cards. Promote goes through the same move flow as dropping a card on Building (`IdeaStages.tsx`).
- ISV-10 · Fixed. Building and Shipped no longer show the "Drop an idea here" box, only the column note. The drop handlers stay, so dropping on Building still opens Promote and dropping on Shipped still explains the rule (`IdeaStages.tsx`).
- ISV-11 · Skipped — Low.
- ISV-12 · Fixed. Every dot has its label (truncated at 240 px, "(disproved)" added). `spreadDots` moves dots apart so that no two labels overlap, and labels near the right edge sit on the left of their dot. Clicking a label selects the dot as well (`IdeaMatrix.tsx`, tested in `ideaViews.test.tsx`).
- ISV-13 · Fixed. Quadrant tints (`#FEF6E7` test first, `#F1F8F3` well supported, `#FBFCFB`, white) and caption colours, the axis captions "IMPACT IF WRONG → higher" and "EVIDENCE → stronger", the Test row as a tinted box with the ticket chip, a primary "↗ Open the idea" and an outline "✓ Mark validated", stacked (`IdeaMatrix.tsx`).
- ISV-14 · Not counted (same as ai-1; selects were styled app-wide in wave 2). Three of them became the design's dropdown along the way: the Quick idea/Keep project pill, "Link to assumption" and "Use as evidence" (see ICT-6, IW-2).

## Idea Space — capture & triage
- ICT-1 · Fixed. Triage has its own header: "← Idea Space", "Triage", the scope switcher, the subtitle, a progress bar and "n of m sorted". Ask, New idea and the notification bell stay in it. Below is a full-height split: the Inbox list is flush left (380 px, "Inbox · n to sort" amber pill, "newest first", "Oldest waiting" footer) and the idea in focus is on the right, with the decisions at the bottom (`Triage.tsx`, `IdeaSpace.tsx`, `ideas.css`). One path is longer by a click: from triage, List/Stages/Matrix are no longer tabs in the header. "← Idea Space" goes back to the view you came from (1 click as before); switching to another view takes a second click.
- ICT-2 · Fixed. Decision cards have the flask, pause, merge and archive icons, the label, the hint and the key cap as a full-width strip at the bottom. Keep tints green on hover/focus, and Merge is tinted amber on hover/focus and whenever a likely duplicate was found. The key hint line has the keyboard icon (`Triage.tsx` `DecisionButton`).
- ICT-3 · Fixed in passing (Low): list rows have a source icon, the time right-aligned, and a "No project" chip. The "Similar" chip is not added.
- ICT-4 · Fixed. Park has a fourth chip "Pick a date" (pressed when the date matches no preset; it opens the picker) and a date field "📅 Mon, 30 Nov 2026" with the native date input invisibly on top, so typing and the picker still work (`TriageDialogs.tsx` `ParkDialog`).
- ICT-5 · Skipped — needs a server field. Keep has no "suggest after keeping" option, and Shape drafts live only in the Shape panel's local state. A switch could not do what it says without starting an AI run in a new flow.
- ICT-6 · Fixed. Quick idea is compact: the title field, "Project [● Kanban Board ⌄]" as a pill (`MenuSelect` chip, `testId="project-pill"`), tag chips with "+ tag" on one line with icon buttons on the right (picture → details/paste, brush → `quick-add-sketch`, frame → `quick-add-canvas`), the details field when opened, and the similar banner with a merge icon and the bold quoted title (ICT-7). Same clicks as before (`IdeaCapture.tsx`, `TriageDialogs.tsx` `ProjectPill`, `TagInput bare`).
- ICT-7 · Fixed in passing (Low): see ICT-6.
- ICT-8 · Skipped — Low.
- ICT-9 · Fixed in passing (Low): the empty Inbox has a ✓ in a circle and "+ New idea". The weekly count line needs a server field (only this pass's count is known).

## Idea Space — the idea page
- IP-1 · Fixed. Header: "← Idea Space", the amber IDEA chip, the idea title, "Saved" (moved from the editor into the header), three icon buttons for Research log, Workspace and Activity (`tab-log`, `tab-workspace`, `tab-activity` kept; pressed state; hover shows a short summary such as "Research log — 3 entries"; a second click goes back to the page), a separator, Ask AI, Park, Shape with AI, Promote, ⋯. Four underline tabs remain: Page, Assumptions, Evidence, Comments. Each tool has its own heading (`IdeaPage.tsx`, `IdeaDiscussion.tsx`).
- IP-2 · Fixed. Underline tabs with a 2 px `#2E6F40` underline on the active one (`.is-utabs`, `.is-utab`).
- IP-3 · Fixed. "← Idea Space" uses the arrow icon, Park the pause icon and Promote the rocket. "Shape with AI" is the purple outline AI button with the sparkle icon (`IdeaAiPanel.tsx` `ShapeButton`, `.is-btn-ai`).
- IP-4 · Fixed. Readiness card: "READINESS" with the badge on the right, the 200 px bar with "n of m", the explanation with the next assumption quoted in bold, and a separate "↗ Go to it" button (`IdeaPage.tsx`).
- IP-5 · Fixed. Details: Project is a plain "● Kanban Board ⌄" (`MenuSelect`), Stage is the stage pill (plus "until 1 Dec"), Owner shows an avatar and name, and Effort shows the value in bold. Owner and Effort are text that turns into a field on one click (Enter or blur saves, Esc cancels), so it is the same single click as before. The value column is wider (86 px label column) (`ClickToEdit`).
- IP-6 · Fixed. Linked is a list of chips with their role: the ticket (with its status), each test ticket ("test"), the source Doc / comment / ticket ("source"), "merged into", and the "No ticket yet" line. There is no "related" chip because the idea has no related-ticket field.
- IP-7 · Fixed in passing (Low): the meta line has no stray separator and shows stage, readiness, owner avatar, source with icon and tags. "👍 I want this", the avatars and "n people want this" are on a second line.
- IP-8 · Fixed. An opened assumption shows EVIDENCE cards (kind icon, title, kind, Remove), the add form, a TEST block (the test ticket chip and "When … is Done, you are asked…", or "No test yet · Create test"), and "✓ Mark validated / ✕ Mark disproved". Rows have a chevron button that opens and closes them (`IdeaAssumptions.tsx`). Not done: "Changed to Testing by …", because activity entries do not say which assumption they are about (needs a server field).
- IP-9 · Fixed in passing (Low): "**We believe**" is bold. The pills and the collapsed add row were not done.
- IP-10 · Fixed. "Suggest with AI" sits in the add row and in the "No assumptions yet" box. It is hidden while AI help is off and opens Shape with AI without starting a run (`data-testid="suggest-assumptions"`).
- IP-11 · Fixed. Every banner of the page is a `StateCard`: an icon, a coloured title line, the body, then the buttons below. This covers archived, shipped (outcome buttons), ticket dropped/deleted, disproved, not touched for n days and not in a project (`IdeaPage.tsx` `Banners`).
- IP-12 · Fixed in passing (Low): "No assumptions yet" is a dashed box.
- IP-13 · Fixed. Evidence tab is a card list: a kind icon in a tinted square, the title (links in the theme green), "Note · used by 2 assumptions · An Nguyen, 3h ago", the "Supports:" lines and Remove. Sketches and diagrams drawn in the page are listed as "in the page · not used by an assumption yet". Checkboxes use the green accent (`IdeaEvidenceTab.tsx`).
- IP-14 · Skipped — outside my folders. The text-AI bubble belongs to `ui/src/components/ai/editor/useEditorAi.tsx`, and the selection after inserting a sketch is set by `ui/src/components/docs/editor/DocsEditor.tsx` (`insertSketch`). Both are read-only for me. Nothing in `sketch/` can drop the editor's selection.
- IP-15 · Skipped — Low (still happens, see above).
- IP-16 · Fixed. Shape with AI header: sparkle icon, "Shape with AI", the member. A "Reading:" row has chips (This idea, n comments, related Docs and tickets, repo (read only) when allowed). While working there is a progress line with a spinner and a seconds counter. Starters are chips above the input, each with its cost, and the input has a send button. Not done: Stop and "$… so far", because the shape request cannot be cancelled and reports its cost only at the end (needs a server change).

## Idea Space — promote & migration
- IPM-1 · Fixed. The description is a rendered preview (Problem, Idea, the sketch, the lists) with "From idea IDEA-n · n people want this". A click on the preview (or Enter on it) turns it into the textarea with the focus, so editing is still one click. An "Edit / Preview" button switches back and forth (`PromoteDialog.tsx`).
- IPM-2 · Fixed. "What comes with it" is a tick list with all nine rows. Ticked: problem text, open assumptions, validated, evidence, sketches and diagrams, demand (when there is any), and workspace folder (when it has files and is not left behind). Unticked: research log and activity, and disproved. Each row has its "→ where it goes" line (`CarryRow`).
- IPM-3 · Skipped — Low.
- IPM-4 · Fixed. The building state is the green card: rocket, "Promoted to [● KAN-38] · Backlog · assignee · promoted 3h ago" and "↗ Open ticket", then "[⚡ Building] → moves to Shipped when KAN-38 is Done". The status is shown as a label ("Backlog", "In progress") (`IdeaPage.tsx`).
- IPM-5 · Skipped — Low (and `TicketCard.tsx` is outside my folders).
- IPM-6 · Skipped — Low (and `TicketModal.tsx` is outside my folders).

## Sketch
- SK-1 · Skipped — Low (and the slash menu is in `docs/editor/`).
- SK-2 · Skipped — Low.
- SK-3 · Skipped — Low.

## Idea Space — AI help
- IAI-1 · Fixed, apart from bulk accept. The advice summary is a purple row at the top of the Inbox list (count pill, "… read the n new ideas. You decide; archive is always one by one.", Get advice / Ask again). Each list row with advice shows the reason, a "✧ Merge/Park/…" chip, "Confidence: High", and Accept / Ignore. Accept opens the same dialog the key would. The triage header has the switch "AI advice is on for this project", which is the same setting as Settings › Idea Space (`AdviceSwitch`). "Why … suggests …" stays in the focus pane (`IdeaAiExtras.tsx`, `Triage.tsx`). Not done: "Accept Merge and Park" in one click, because every decision goes through its own dialog today and a bulk accept would change how those moves are confirmed. Also not done: "No suggestion: not sure" rows, because the server does not keep which ideas got no advice (needs a server field).
- IAI-2 · Fixed. The Ask panel is docked below the Idea Space header, next to the list, instead of covering the header. Ask, Inbox, New idea and the bell stay visible, and Ask shows as pressed (`IdeaSpace.tsx` `.is-main-row`, `.is-ai-panel-docked`).
- IAI-3 · Fixed, apart from the action buttons. Header "✧ Ask about ideas · member · ✕", starters as pill chips above the input, a send icon button, and the sources as chips with the idea title (click opens the idea). Not done: "Create test ticket" and the other action buttons in answers, because the answer has no actions (needs a server field).
- IAI-4 · Fixed. The digest is a card: "✧ Weekly digest" chip, "Monday 17:33 · $0.000 · read 10 ideas", then one row per finding with its icon (clock, merge, flask, calendar, inbox tray), the count in bold, the IDEA links and a Review (opens the first idea) or Open Inbox button. The AI's sentence comes after the rows, then the footer note. Open Inbox, Write it now and Hide are in one row. Before a digest exists it is one slim line (`IdeaAiExtras.tsx` `DigestCard`).
- IAI-5 · Skipped — Low.
- IAI-6 · Skipped — Low.

## Idea Space — research log, workspace & activity
- IW-1 · Counted as IP-1 (fixed there).
- IW-2 · Fixed. Heading "Research log · n entries · IDEA-n" with "+ Log entry" (focuses the composer), kind filter chips, a Newest first / Oldest first toggle, and the pinned-finding strip. The composer stays open as before, so it takes the same clicks. It has coloured kind chips with icons, a toolbar (bold, italic, code, link wrap the selection; Attach uploads a file as an entry attachment; "Link to assumption" is a `MenuSelect`), Cancel and Add to log. The AI button of the design is not added. The timeline has a rail and kind-coloured dots, kind chips with icons, a pin mark, the avatar, name and time on the right, and a ⋯ menu (Pin/Unpin, Delete). Attachments, "Supports: …", "Test ticket …" and "✓ Use as evidence" (a `MenuSelect`, `testId="use-as-evidence-<id>"`) are chips (`IdeaDiscussion.tsx` `IdeaLog`). Not done: the author's role ("Researcher", "Owner"), because entries do not carry it.
- IW-3 · Skipped — Low.
- IW-4 · Fixed. Each activity row has a kind icon in a tinted circle, the bold kind ("Assumption", "Stage", "Page", "Research log", "Demand"…), the subject, before → after chips (stage pills, or state chips for "marked as validated"), a "By AI" chip, and the avatar and time on the right. Text the server cut at 60 characters gets "…". "Show n earlier changes" pages the list 30 at a time (`IdeaActivityTab`). Not done: naming which assumption changed, because the entry does not say (needs a server field).

## Counts
Fixed: 31 of the 33 Critical/High/Medium rows (8 High: ISV-12, ICT-1, IP-1, IPM-1, IAI-1, IAI-2, IW-2 fixed, IP-14 skipped; 25 Medium: all fixed except ICT-5). Partly done inside a fixed row, with the reason given above: IP-8, IP-16, IAI-1, IAI-3, IW-2, IW-4.
Skipped: IP-14 (files outside my folders) and ICT-5 (needs a server field). The Low rows are skipped, except the ones fixed in passing: ISV-7, ICT-3, ICT-7, ICT-9, IP-7, IP-9, IP-12.
Tests: `ui/src/components/ideas/ideaViews.test.tsx` (new: label spreading, one-bar readiness, stage icon, short date).
