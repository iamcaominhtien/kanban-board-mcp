# Wave 3 fixes — ai (AI members, provider config, Board AI, safety, accounts, team process, Story & Flow)

Reports: [ai-1.md](../ai-1.md) (without the `SCH-` rows), [ai-3.md](../ai-3.md), and two rows of [ai-2.md](../ai-2.md).
Before (5174) and after (5173) screenshots: `/tmp/claude-0/-home-user-kanban-board-mcp/217c9eaa-a832-52d5-8a05-ade5a07b6b57/scratchpad/w3/ai/` (`<scenario>-before.jpg`, `<scenario>-after.jpg`, `<scenario>-both.jpg`; not in the repo).
Screenshots exist for: dock (AB-5), history (AB-9), scope (AB-10), assistant/assistant2 (AB-16 to AB-21), settingsAi/settingsTiers2/settingsOps (AB-15, WV-1 to WV-3, OPS-7), members/inbox/audit (ACC-1, AM-3, SC-5), accounts (OPS-1, OPS-3), addStep1/addStep2 (AM-6, AM-8, AM-9, ACC-2), profile/perms/perms2 (AM-11, SC-2 to SC-4), config2 (PC-3), wfEditor (TP-8, TP-10), wizard (TP-6), settingsWf/settingsTools (TP-9, TP-2, TP-4).
Not shot: both dev servers (5173 and 5174) stopped answering partway through. That leaves SF-2, SF-3, SF-4, AB-11 and TP-11 covered by unit tests only, and TL-7 and AP-4 unchecked in the browser because they need Pause all AI.
No data was added or changed. No AI run, Run test, Test connection, Check (MCP), Read the repository, Pause all AI or Resume was pressed.
Rules kept: no feature, `data-testid` or keyboard path removed, and the number of clicks for an existing action is unchanged. A first pass put Preview and Remove in a ⋯ menu on the AI profile, let Esc close the team wizard and moved "close the dock" off the history view. All three were reverted to the current behaviour, and only the look was kept.

## Board AI — assistant (ai-1)
- AB-1, AB-2, AB-4 · Already fixed.
- AB-3 · Already fixed (wave 2): the dock sits beside the board and the board shrinks (`App.tsx` pads by `--as-dock-w`). One thing is left: at 1440 px the columns keep a minimum width and the board scrolls sideways under the header. That is `Board.module.css`, which is outside my folders.
- AB-5 · Fixed. "Try asking" rows have their own `.as-suggest` class with the design's values (7/10 padding, `#D4E7D9` border, `#F6FAF7`, radius 8, 12 px at weight 400, 12 px green chat icon, 6 px gap) (`assist/AssistDock.tsx`, `assist/assist.css`).
- AB-6 · Skipped. It is in `TicketCard.module.css`, outside my folders.
- AB-7, AB-8 · Skipped (Low).
- AB-9 · Fixed. The history view has its own header: avatar, "Chat history", dot with "Only visible to you", New chat, the history toggle (back to chat), maximize and close. The search field has a magnifier, and the month line is a footer band with a top border (`assist/AssistDock.tsx`).
- AB-10 · Fixed. The scope popover uses bordered radio rows with radio circles, the token size moves into the grey line, and only "~5× cost" is an orange chip (`assist/AssistDock.tsx`, `assist.css`). The leftover header glyphs ⟲ + ⓘ are now line icons.
- AB-11 · Fixed. "AI" and the chevron are one joined split button. Menu items have icons (edit, branch, check, chat) and a separator before "Ask about this ticket". The clicks are the same as before (`assist/TicketAi.tsx`).
- AB-12, AB-14 · Already fixed (wave 2 icons).
- AB-13 · Already fixed in my code: pausing does not hide the editor AI bar (`ai/editor/useEditorAi.tsx`). The Docs selection bubble is in `docs/editor/*` (docs agent, ED-2).
- AB-15 · Fixed. The Board AI card in Settings › AI is tinted (`#F1F8F3` / `#BFDCC7`) with the eyebrow "BOARD AI · ● status" and Change with a refresh icon. "Manage AI members ›" is a link beside the section title (`ai/AiSettingsSection.tsx`, `ai/aiPage.css`). The two-page split (AI and Board assistant) stays as it is.
- AB-16 · Fixed. Feature rows show the name and description on one line, then the cost in mono, then the switch at the trailing edge (`assist/AssistSettings.tsx`).
- AB-17 · Already fixed (wave 2). The design draws Language and "Over the cap" as plain fields, so the styled native select stays, as the brief says.
- AB-18 · Fixed (Low, done with AB-16). Tone uses separate outline pills, and the selected one is light green with a green border.
- AB-19 · Fixed. "What is sent to …" is a bordered card with green check and red ✕ icons in two columns.
- AB-20 · Fixed. Monthly cap and Per request have a mono `$` prefix. "Used this month $x of $y" is in mono, with a progress bar under the row that turns red at the cap.
- AB-21 · Fixed (Low, done with AB-16). Data-scope switches sit at the trailing edge.
- AB-22 · Skipped (Low).

## AI members (ai-1)
- AM-1, AM-2 · Skipped. They are in `components/MembersPanel.tsx`, outside my folders.
- AM-3 · Fixed. "Assistant settings" on the Board AI card is a link (`ai/AiMembersPage.tsx`). The icons were done in wave 2.
- AM-4 · Fixed. The row menu has icons: edit, pause/play, bolt (Test connection) and trash (Remove…).
- AM-5 · Skipped (Low).
- AM-6 · Fixed. A ✕ close in the header on every step of Add AI member (`ai/AddAiMemberModal.tsx`).
- AM-7 · Skipped (Low).
- AM-8 · Fixed. Detection rows have dividers and a green ✓ at the end, the working folder has a folder icon and a mono font, Run test has a bolt, and Back has a chevron (`ai/AddAiMemberModal.tsx`, `ai/ai.css`). Model is a plain field in the design and stays the styled native select.
- AM-9 · Fixed (with ACC-2). Done steps are filled `#2E6F40` with a white check, and the connectors between done steps are green (`ai/ai.css`). The team wizard's stepper gets the same.
- AM-10 · Fixed. "Ask AI to fill this in" gives the real reason: no Board AI, all AI paused, the member paused, or offline with the status detail (`ai/AiFillPanel.tsx` `notReadyReason`, tested).
- AM-11 · Partly fixed. Test connection (bolt), Pause/Resume and Preview/Remove now have icons. Limits and Connection rows have dividers and a wider label column, so "Scheduled runs today" stays on one line (`ai/AiProfile.tsx`, `ai/ai.css`). Moving Preview and Remove into a ⋯ menu was reverted, because it would add a click.

## AI provider configuration (ai-1)
- PC-1 · Fixed. Import, Export and Reset have upload, download and undo icons (`ai/config/ConfigTab.tsx`). The adapter badge tile is left as it is.
- PC-2 · Partly fixed. The CLAUDE.md editor has a header bar inside its frame (file icon, name, Synced chip on the right), and the selected scope pill is outlined green on a tint (`ai/config/parts.tsx` `CodeEditor header`, `InstructionsCard.tsx`, `config.css`). The note was already there. Not done: Markdown colouring inside the textarea, which would need an overlay editor.
- PC-3 · Fixed. Server rows have a tinted icon tile, the kanban row has a lock at the end, status is a dot plus text ("● Connected · n tools"), and "Add server" is primary with a plus. "Attach from library" has an icon (`ai/config/McpCard.tsx`, `config.css`).
- PC-4 · Already fixed (wave 2). The design draws Model and Effort as plain fields with a chevron, which is the styled native select.
- PC-5 · Partly fixed. The working-folder fields have a folder icon (`PermissionsModelCards.tsx`). Skipped: Max turns and Run timeout for Claude Code, because the server never passes them to Claude Code runs (`server/services/ai/runs.py` uses `max_turns=None`). A field would show a setting that does nothing, and wiring it is a server change.
- PC-6 · Fixed (Low, one line). The Synced chip has a sync icon.
- PC-7 · Skipped (Low).

## AI safety & cost (ai-1)
- SC-1 · Already fixed (wave 2). The last 🔒 in the matrix's sub-line text is gone.
- SC-2 · Fixed. The selected mode is tinted per mode (Allowed green, Needs approval amber, Blocked red), and the status ceiling is separate rounded buttons with light green for steps inside the ceiling (`ai/AiPermissionsTab.tsx`, `ai/ai.css`).
- SC-3 · Fixed. Each matrix row starts with a 22 px line-icon tile (eye, chat, pencil, arrow, user, plus, trash, page, check, branch, and a frame for the runner row).
- SC-4 · Fixed. The tester's Action, Ticket and target status are MenuSelects (Action with icons, Ticket with status and title as the second line). The result card shows as soon as both are picked. It reads only, and "Check" stays one click (`ai/AiPermissionsTab.tsx`).
- SC-5 · Fixed. Inbox and Audit log filters are MenuSelect chips: show, agent with avatars, risk, action, date with a clock icon. The ticket search has a magnifier. "Soonest to expire first" is a sort menu (soonest, newest, oldest) that orders the pending list on the client (`ai/AiInbox.tsx`, `ai/AiAuditLog.tsx`, `ai/ai.css`).
- SC-6 · Skipped (Low).
- SC-7 · Already fixed.
- SC-8 · Skipped (Low).

## AI where you work (ai-1)
- WY-1 · Already fixed (wave 2 icons).
- WY-2 · Skipped (Low).
- WY-3 · Skipped. The plan box is already left-aligned (`ai/ticketWork.css` `.tw-plan`). The AI mention pill and the Comment icon are in `components/CommentsSection.tsx` / `comments/`, outside my folders.

## AI accounts (ai-3)
- ACC-1 · Fixed. The Members tabs are a segmented control (grey track, white active pill, amber counts) (`ai/AiMembersPage.tsx`, `ai/ai.css` `.ai-tabs-seg`).
- ACC-2 · Fixed. All four step labels show, and done steps get the green check (`ai/AddAiMemberModal.tsx`).
- ACC-3 · Skipped (Low).
- ACC-4 · Already in code. `accountSub` adds "· n members already use it" when members exist, and the "Shared accounts share one limit" notice shows when the chosen account is shared (`utils/memberAccount.ts`). The audit's account had no members.
- ACC-5, ACC-6 · Skipped (Low).

## AI operations (ai-3)
- OPS-1 · Fixed. There is one header: "Usage window", a chip "n Claude accounts", and one "Run at most [n] at a time per account" control that sets every account. Each row keeps its own compact limit, so a different limit per account is still possible. Rows have a MEMBERS column (this project's AI members on that account) and a CC monogram tile (`ai/accounts/WindowsSection.tsx`, `accounts.css`, tested). The "Move urgent work by itself" switch stays in the row, because the Move dialog only opens when something is waiting.
- OPS-2 · Skipped (Low).
- OPS-3 · Fixed. "Running now" shows the member chip before the ticket.
- OPS-4, OPS-5 · Skipped. They are in `components/aiteam/`, outside my folders.
- OPS-6 · Fixed. A queued run with a pending retry shows the amber line "Lost the connection. Trying again in 2 minutes — second of three." with Stop trying, which cancels the queued run. It uses the run's existing `retries` / `retryAt` (`ai/RunPanel.tsx` `RetryLine`, tested).
- OPS-7 · Partly fixed. Settings › AI › Running the team has "How many at once › At once on this project" (the existing `boardMaxParallel`), with a link to the per-account limit (`ai/AiSettingsSection.tsx`). The retention row is not done: transcript retention lives in Settings › Notifications, and there is no "Show what would go" endpoint, so that needs a server change.

## AI team process (ai-3)
- TP-1 · Already fixed.
- TP-2 · Fixed. The Installed tab has a search field beside the filter chips, and the two notes are cards: "Really used" in green and "No approval step" in amber (`ai/tools/InstalledTab.tsx`, `ai/ai.css`).
- TP-3 · Skipped. Turning "Add from a source" into a dialog with Version and Who-gets-it dropdowns is a restructure of the install flow, which is too large for this wave.
- TP-4 · Fixed. The role filter is a MenuSelect chip "Role: All roles" (`ai/tools/CatalogueTab.tsx`; test updated to pick from it).
- TP-5 · Skipped (Low).
- TP-6 · Fixed. The wizard is a page-like layer that covers the window, with every step and field kept. It has the breadcrumb "<project> / Project settings / AI / Set up the AI team", the title with a project chip, "Nothing is created until the last step" on the right, a close button, one fixed width of 1120 px for every step (no more widening on step 3), a footer bar, and done steps as green checks (`ai/packs/TeamWizard.tsx`, `packs.css`).
- TP-7 · Partly fixed. Step 2 is in two columns: what the board read on the left, what it suggests on the right. Kept: the team as editable name rows with Remove (chips with an edit popover would change how a name is edited).
- TP-8 · Fixed in the UI. Role names come from a fixed map (BA, QA, PM, Dev, User tester …), never `cap(key)`, and "Dev (TDD)" inside a step reads "Build (Dev, TDD)" (`ai/workflow/wfFormat.ts`). The server message "No member for the role ba" is a server change.
- TP-9 · Partly fixed. The "›" stays with the chip after it, so no line ends on a separator, and Edit has a pencil (`ai/workflow/WfUi.tsx`, `WorkflowsSection.tsx`). Import is skipped because there is no import endpoint for templates.
- TP-10 · Fixed. "Who does it", Model, Effort and Review depth are MenuSelects. Who-does-it options have a second line (the pack's tagline, or "The project's checks" / "The step waits for you"). The selected step chip is light (`#E6F2EA` with a `#BFDCC7` border) (`ai/workflow/TemplateEditor.tsx`, `workflow.css`; test updated). The design's "Dev An on this project" hint needs a role→member map, which the client does not have.
- TP-11 · Partly fixed. The workflow on a ticket is a grid of step tiles: number, a check or clock mark, the step, then who holds it, then the state in small caps. Every note, failure, Skip and Open-the-run stays in its tile (`ai/workflow/TicketWorkflow.tsx`, `workflow.css`). "Who did what" was already listed under the strip. Placing the strip on the ticket itself, and the list beside the assignee, is `components/TicketModal.tsx`, outside my folders.
- TP-12 · Skipped. It is the board card step chip (`components/TicketCard*`), outside my folders.

## Board AI wave 3 (ai-3)
- WV-1 · Fixed. The "Just does it" card lists the design's fixed read-only bullets, then any actions lowered into it (`ai/board/BoardAiSection.tsx`, `tierWords.ts`).
- WV-2 · Fixed. The middle card has the 5 grouped bullets, and the last card has the 4 bullets plus "Never, even if asked". The one list of rows uses a MenuSelect chip with a second line (test updated).
- WV-3 · Fixed. The fixed rows come last, and the reason is said once above them with a lock line icon instead of on every row.
- WV-4 · Skipped. Turning ready-made rules into table rows with Start a trial, and the side-by-side editor, is a restructure of the standing orders screen. Left for a later wave.
- WV-5 · Fixed. The header chip says the real scope: "All projects", "This project", or "All projects · some only here" (`ai/board/StandingOrdersSection.tsx`).
- WV-6 · Skipped (Low).
- WV-7 · Skipped. A "Shared" tab needs a separate shared-store list. The current toggle searches it, and a tab of its own needs a server listing.

## Story, Flow (ai-3)
- SF-1 · Already fixed.
- SF-2 · Fixed. A Draft Story with no tickets gets the same full-width lane header (bookmark, title, key, state chip, "0 tickets yet", PM), and the key never wraps (`story/StoryLanes.tsx`, `story.module.css`).
- SF-3 · Fixed (breadcrumb option). The Story page shows "<project> › Board › KAN-n" at its top (`story/StoryPage.tsx`).
- SF-4 · Fixed. With no PM it says "No PM in this project · Make one from the PM pack in Settings › AI" instead of "Run by PM".
- SF-5, SF-6 · Skipped. They are in `components/aiteam/`, outside my folders.

## The AI sets up the commands (ai-3)
- RC-1, RC-3, RC-6 · Skipped (Low).
- RC-2 · Skipped. Server change (`repo_scan.py`).
- RC-4 · Skipped. A settings-page progress bar for a closed wizard needs the running scan job to be visible outside the wizard and a done notice, which is a new flow.
- RC-5 · Skipped. Reusing the wizard's command rows in Settings › AI › Commands is a rework of `code/RepositoriesSection.tsx`.
- RC-7 · Already fixed.

## From ai-2
- TL-7 · Fixed. While all AI is paused, the live column's badge is grey "PAUSED" (no pulse), and the quiet text reads "AI is paused since 16:40. Nothing new starts until an owner or admin resumes…" (`ai/live/LiveFeed.tsx`, tested). Not checked in the browser, because that needs Pause all AI.
- AP-4 · Fixed. The native `title` on the "AI paused" label is replaced by a card that shows on hover and on keyboard focus (`:focus-within`). It shows who and when, the cancelled and held counts, the reason, and "Nothing new starts until an owner or admin resumes." The label points to it with `aria-describedby` (`ai/AiKillSwitch.tsx`, `ai/ai.css`, tested). Not checked in the browser, because that needs Pause all AI.
