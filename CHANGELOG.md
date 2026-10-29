# Changelog

All notable changes to this project will be documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/). Versioning follows [Semantic Versioning](https://semver.org/).

---

## [Unreleased]

### Added
- **AI guideline** (`docs/guideline/ai/huong-dan-dung-ai.pdf`, Vietnamese, 24 pages): setting up Claude Code and AI members, choosing the Board AI, how to write persona, instructions, tickets and extra instructions (with copy-paste samples), assigning and reviewing work, Board AI prompts, schedules, safety and cost, troubleshooting and a one-page checklist. The source (`build.py`, screenshots) lives next to the PDF and `docs/guideline/README.md` says how to rebuild it.

---

## [3.10.0] - 2026-10-29

Docs brought in line with the design (pages, editor, page actions, search, references, comments and diagrams).

### Added
- **Who can edit pages**: a per-project setting in Settings → Docs (Everyone / Members / Admins, members by default; admins only). Creating, editing, publishing, renaming, moving, duplicating, deleting, restoring and importing pages follow it, so viewers can no longer change pages; they see a disabled Edit with the reason.
- **Request access**: someone outside the project sees "You don't have access to Docs" with an optional note and Request access; the admins get a notification. When Docs is off, non-admins are told to ask an admin; Back to Board and Open project settings work on the Docs error screens.
- Editor shortcuts: Ctrl/Cmd+S saves the draft, Ctrl/Cmd+Enter opens Publish, Ctrl/Cmd+Shift+M toggles Markdown. The Markdown view sits beside the visual editor and both stay in sync.
- "Since you last viewed": changed paragraphs get a green bar and "Changed in vN"; the last version you saw is kept per person on the server, and your own publish or restore doesn't trigger it.
- Publish dialog counts real followers ("N people who follow this space get a notification") and added references; follows are kept on the server.
- Search: "Narrow the search" chips, "Create page" when nothing matches, match counts, ticket chips on each result, counts on the Edited and Status filters, and the results page now sits inside the Docs space with the page tree. "/" focuses the tree filter (Ctrl/Cmd+K opens the palette); Enter there opens the full results.
- References: typing a bare ticket key ("KAN-") in the editor suggests tickets; ticket chips show the ticket title; a markdown cheat sheet (reference syntax, anchors, renames) from the suggester and search help; "Open in side panel" on page hover cards; renaming a heading shows which links keep working through the redirect.
- Delete dialog lists the pages and tickets that link to the page.
- Diagrams: a "Drop a diagram file here" card while dragging a draw.io file onto the editor.
- **Comments over several lines**: an inline comment can now cover a selection across paragraphs, list items or a heading, in the page and in the editor.
- **Richer comments**: paste, drop or attach images and files, draw a diagram, and comments render full Markdown (lists, links, code, images, diagrams, page and ticket chips).

### Fixed
- Long page titles and headings use the full width: the page actions sit on the breadcrumb row, and a heading's hidden section link no longer squeezes its text.
- Editing a page no longer saves `&` as `&amp;` (and `<`, `>` as entities) into the page, which also changed heading links.
- The floating selection toolbar sits above the selection again (it could appear at the top of the window, and its link field off screen), and stays over the page column.
- Table controls show only for the selected row or column and no longer cover the next paragraph; clicking a cell that contains "/" no longer opens the block menu.
- Renaming a page keeps `[[Old title]]` references in tickets working; they show the new title.
- Opening a heading from search scrolls to it; "Filter the tree instead" fills the tree filter; the "Link a doc" picker in tickets is full width and finds sections of linked pages.
- Move to… with no matches clears the preview and disables Move; restore warns "You have an unpublished draft (N autosaves)".
- "Referenced by" and Linked docs show heading text instead of slugs and keep the reference as a chip; hover excerpts no longer show table separator lines.
- A comment that spans a code span or link shows one number badge in the editor.
- The History drawer pushes the page aside and offers View on each version; Recycle Bin rows name child pages and show actions on hover; the Back online banner can be closed.

---

## [3.9.1] - 2026-10-29

### Fixed
- Desktop: the packaged app starts again. 3.9.0 crashed on launch with `Cannot find module './export-svg'` again: a merge dropped `export-svg.js` from the files electron-builder packages (the 3.8.4 fix). CI now runs the desktop tests, including the check that every local module a shipped file requires is shipped, so this can't merge unnoticed.

---

## [3.9.0] - 2026-10-29

### Changed
- **Settings is now a full page** instead of one long modal, following the design in `design/screens/settings-structure.md` and `settings-pages.md`. A list of 9 pages (Project: Repositories, Docs, AI, Board assistant; App: Appearance, Storage & backup, Integrations, Updates on desktop, Diagnostics), a project picker for project settings, search across every setting (jumps to it and highlights it), links such as `?settings=ai`, Esc / Back to board, the last page remembered, and the list collapsing into a drop-down in narrow windows. Same fields and saving as before.
- Importing data now asks inline ("Replace my data") instead of a browser pop-up.

---

## [3.8.4] - 2026-10-29

### Fixed
- Desktop: the packaged app starts again. 3.8.3 crashed on launch with `Cannot find module './export-svg'` because `export-svg.js` was missing from the files electron-builder packages. A test now checks that every local module a shipped file requires is shipped too.

---

## [3.8.3] - 2026-10-29

### Added
- MCP: the AI agent can work with **diagrams** (#167) through the Docs tools, as a file. `docs_read(diagrams)` lists a project's draw.io diagrams; `docs_read(diagram)` writes a diagram's `.drawio` file to a local path; the agent edits it with its own file tools (so every draw.io feature is available); `docs_write(diagram_save)` stores it as a new version (a stale `base_version` is rejected like in Docs) and `docs_write(diagram_create)` makes a new diagram from a file and returns the `[Name](diagram:dg_…)` line to put in a text. `diagram_delete` / `diagram_restore` unlink and bring back. Paths are absolute, as for `import`.
- **Exact previews for what an agent saves.** Nobody has an editor open when an agent saves a diagram, so the server asks the draw.io editor itself, in a hidden browser, for the SVG: the same picture a person gets when they save, with every shape, icon, container and connector as in draw.io. The desktop app does this with its own executable (`Kanban Board --export-svg …`, the Chromium Electron already ships; nothing to install) and tells the server and the VS Code MCP entry how to reach it (`KANBAN_EXPORT_CMD`). A server running without the desktop app uses a Chrome / Chromium / Edge found on the machine (or `KANBAN_CHROME_PATH`) over DevTools. The hidden page may only load the editor's own origin, and nothing is exported when the editor is the public diagrams.net unless `KANBAN_DIAGRAM_EXPORT=public` (`off` switches it off).
- When no hidden browser is available the server draws a plain preview (boxes, ellipses, diamonds, cylinders, arrows and text; other shapes as boxes, arrows above containers), the footer says "Simple preview", and the agent is told what it stored (`preview`). An SVG the agent exports itself can be passed with `svg_path`. Opening the diagram in the editor and saving replaces either with the full drawing.

---

## [3.8.2] - 2026-10-29

### Fixed
- Windows: Board AI no longer fails to load (every `/ai/assist` request raised "Invalid format string"), so **Ask AI** is back on the board, and board health insights about due dates work. Dates are formatted without the Linux-only `%-d`.
- If Board AI cannot load its state, the **Ask AI** entry stays and the dock says what went wrong instead of disappearing; Settings → AI shows the error with Try again instead of loading forever.
- AI screens that waited for data forever when a request failed (adapter matrix, member activity, permissions, revert previews) now show the error with Try again.
- Windows: after a crash, a leftover Claude Code process of an interrupted run is recognised (no /proc there) and stopped.
- AI schedules: a test command that times out is stopped with everything it started, not just its shell.

---

## [3.8.1] - 2026-10-29

### Fixed
- Docs: the page tree rows line up with the search box (same side margins) and the left and right padding is more even; the drag handle no longer takes its own column.

---

## [3.8.0] - 2026-10-29

### Added
- **AI members** (#165). AI members sit next to people: they can be added, assigned tickets and @mentioned, and they do the work through a real run. The Members modal gets **Humans | AI** tabs and a full **AI members page** (Board AI card, list with provider, connection, live status, today's runs and spend, permissions; row menu Edit / Pause / Test connection / Remove; empty state; loading skeleton). The sidebar shows "4 · 1 AI".
- **Two ways to connect.** A *local runner* launches the official CLI you are already signed in to (Claude Code: `claude -p`, headless, `stream-json`, `--permission-mode dontAsk`, `--strict-mcp-config`, a per-run MCP token); the board never reads or stores its login, only the account name `claude auth status` prints. An *API key* member (Anthropic, OpenAI, Gemini, custom OpenAI-compatible endpoint) runs an agent loop on the board with step, token, time and budget limits, retries on 429/5xx and per-run cost. Keys are encrypted at rest; only the last 4 characters ever come back. "Other MCP client" members are inbox-only.
- **Add AI member** stepper: type, connect (CLI detection, sign-in check and a one-line test run, or a key test), identity & limits (unique names across people and AI, persona, parallel runs, daily budget / monthly cap or runs per day), permissions & review (status ceiling, approvals) and the result. **Profile** tabs: Overview (live run log, assigned tickets, limits, connection), Configuration (instructions, model and limits, CLI allow / deny rules, extra MCP servers, API tool groups and context, export JSON, unsaved-changes bar), Permissions, Usage, Activity.
- **AI work on tickets.** The assignee picker has an AI group with live status and reasons; picking an AI asks how to start (start now, queue, assign without running). Run lifecycle: queued, starting, running, needs input, finished, failed, cancelled, timed out, with one holder per ticket (enforced by a unique index), slots per AI and queue positions. Ticket detail gets a sparkle **Run** tab (steps, files touched, commands, status changes, usage, open in terminal, run history), a run chip, the AI's **question card** (answering resumes the same CLI session and clears Pending), the **AI summary** review gate (Approve → Done, Request changes, Take over, Undo run's changes) and approval cards. Board cards show Run / Running / Queued / Asks… / Failed + Retry / AI summary ready, and columns show "1 AI running"; dragging a card an AI holds asks first. Starting moves To Do to In Progress, finishing moves to Review.
- **@mention an AI** in comments: choose Ask (answer in a comment), Do the work (assign + run) or Just notify; AI-to-AI mentions are limited by chain depth and never wake a member already in the chain. `POST /tickets/{id}/ai/ask` asks from a test case note.
- **Safety and cost.** One permission check for every AI action, from MCP and the API loop alike: role templates (Developer, Reviewer, Read-only, Custom), stricter-only overrides, delete locked to approval at most, status ceiling (Review by default; Testing / Done need an extra confirmation), scope, safe mode and the kill switch. Actions that need approval are parked and applied by the board when a person approves; denials post the reason. Daily budget, monthly cap, board daily cap, runs per day, runs per ticket, auto-pause after 5 failed runs in 10 minutes, **Pause all AI** (cancel or let finish, held queue, banner) and **Resume** (checklist, safe mode first). Append-only, hash-chained, redacted **audit log** ("AI name, on behalf of person") with revert per change or per run (changes a person made since are skipped), export and an integrity check; usage dashboard.
- MCP: new `ai_run` tool (`ask`, `report`) for runs the board started; activity entries made by an AI carry `on_behalf_of` and the run.
- API: `/ai/*`, `/projects/{id}/ai/*`, `/tickets/{id}/ai/*` (see `docs/specs/api-contract.md`), `ai_intent` on `POST /tickets/{id}/comments`.
- **Board AI assistant.** An Ask AI dock (Ctrl/Cmd+J, 420 px, the board shrinks beside it) chats about the board, a ticket, a doc or everything shared, with ticket pills, tables, a context line, cost chip, history per person and suggested actions as drafts you apply as yourself (with Undo, conflict and viewer states). **Draft with AI** in New Ticket (similar tickets, per-field accept, suggested assignee), **Improve description** (diff, per-hunk accept), **Split with AI** (sub-tickets with blocked-by links), **Suggest test cases** tied to acceptance criteria with a coverage matrix, **Board health** (daily digest, six insight kinds, act / snooze / dismiss, chips on cards) and **Docs AI** (summary, section from a ticket, link suggestions, selection Summarise / Rewrite / Ask). Settings → AI holds feature switches with monthly cost, language and tone, data scope per project, excluded docs and cost limits; answer thumbs are kept with a reason.
- **AI schedules** (#153). An AI member works on a ticket at a set time, once or on repeat: time zone, end rule, allowed window, backup AI, "done when" checks (criteria ticked, test command exit code, summary, branch or PR, AI checks), AI review by a second AI with fix rounds, limits, catch-up when the runner is offline, notifications. Each slot starts once even across restarts, a pass moves the ticket to Review (never further), three failures in a row pause the schedule. The UI: a **Schedules** tab next to Docs (badge = runs in the next 24 hours) with a list (Upcoming, Paused, History; filters by AI and ticket; pause and resume from the row), a **Week** view with one row per AI (overlaps, offline risk, reviewer rows) and an empty state. **New schedule / Edit** opens as a layer: task, once or repeat with days, time, time zone, end rule and allowed window, AI member and backup, "done when" checks (criteria, tests with command and folder, summary, branch or PR, AI checks the reviewer judges), AI review with fix rounds, limits, what to do when it cannot run on time and who is told; the right side shows the summary, the next 5 runs and the checks as you type, plus **Dry run**. **Schedule detail** shows stats, problems and every run with its check results and the reviewer's verdict; waiting runs can start now, run on another AI or be skipped, and a schedule paused after three failures offers See last run and Resume. Entry points: the ticket's Run menu ("Schedule a run…", "View schedules for this ticket") and "Schedule…" when assigning an AI. A **Schedule block** on the ticket, a chip in the board card footer, schedule entries in Activity and toasts for started, needs input, failed or skipped, and finished runs. MCP: `ai_schedules` tool (list, get, create, update, pause, resume, delete, run_now).
- **AI members, more of the design.** Connection-state card with one action per state, avatar colour and glyph, status sub-lines, rename, profile with running ticket and recent runs, rate-limited runs re-queue and retry after the wait, model-retired detection, periodic re-detection of a missing runner or sign-in, runner host line and web-build notice, "today" at local midnight everywhere. **Projects it can work in**: an AI member can work in several projects as linked copies that share settings, key and one budget. On desktop the key that encrypts API keys lives in the **OS keychain** (a denied keychain saves nothing).
- **Provider configuration.** The Configuration tab shows only what the adapter declares and writes Claude Code's files for real: instructions into `CLAUDE.md` between kanban markers, skills, subagents, hooks (typed confirmation), `.mcp.json` and permissions in `.claude/settings.json`, with a sync preview, diffs, hand-edit conflicts, backups and restore. API agents get a system prompt with `{{ticket}}` `{{project}}` `{{docs}}` `{{comments}}`, Docs tools, custom HTTP tools with a schema editor and test call, remote MCP servers, context and limit settings, output rules and a dry run. A shared library of skills, snippets, MCP servers and tools with versions.
- **AI work on tickets, more of the design.** Mentions of people and AI in comments, descriptions and test-case notes with a grouped autocomplete and a hover card; the composer's Send ▾ and Ask; an Ask thread with streaming, Stop, Regenerate, Edit and re-run, Retry and thumbs; per-run Pause / Resume; Start now, Take over, Undo and Raise limit; a richer run view (step output, exit codes, test results, usage); questions with recommended options, Answer later, Ask someone else and reminders (admins are told from 6 h); a review gate with "What changed"; Activity filters and Revert; two AIs on a ticket (holder and next in line); a person's edits during a run reach the AI at its next step or board call.
- **Safety and cost, more of the design.** Permissions tab with Preview as this AI, provenance and owner-enabled delete; an Inbox for approvals, mentions and questions with bulk decisions; approval cards with before → after and Approve & remember; approvers by risk and delegates; a tool call that needs approval now **waits for the decision**; usage dashboard (ranges, CSV, forecast, cap line, most expensive runs, spend by ticket); budget dialogs, alerts at 80% / 100% and at-cap policies; kill switch with token revoke; project and per-agent safe mode; an audit log with filters, drawer, revert and retention; injection chips; trust by source and allowed domains; per-member MCP tokens; loop cooldowns; notification settings with a daily digest; workspace defaults; **auto-trip rules** (failed runs, spend spike, repeated denials, loops, many agents) with editable thresholds; **project roles** decide who configures and operates AI (viewer, member, admin, owner), and an admin's permission change waits for the owner.

### Security
- A working folder or CLI path given for an AI member must sit inside the home folder (not the home folder itself), another drive or volume, or a folder listed in `KANBAN_AI_ROOTS`; system folders are refused. Configuration files stay inside the working folder (symlinks included).
- A custom HTTP tool's **Test call** calls the saved tool only, never an address sent with the test. Arguments fill the path and query of a tool's URL, never its host; tool URLs must be http(s) and may not point at link-local (cloud metadata), multicast or unspecified addresses.

### Fixed
- Editing a test case no longer drops focus or loses typed text while the field saves.
- Cancelling an AI run while it is starting no longer launches its CLI afterwards or keeps Cancel waiting for 10 seconds.

---

## [3.7.1] - 2026-10-29

### Added
- Docs: the page tree can be **resized** by dragging its right edge (arrow keys work too, double-click resets). The width is remembered.
- Docs: hovering a page title that is cut off in the tree shows the full title in a tooltip right away.

### Changed
- Docs: the page tree is 280px wide by default (was 248px), and the row buttons (add child page, more) overlay the end of the row on hover instead of reserving space, so more of each title is visible.

---

## [3.7.0] - 2026-10-29

### Added
- MCP: the agent can work with **Docs comments** without new tools. `docs_read(action='comments')` lists a page's threads (inline and page comments, status, quoted text, whether the text is still attached); `docs_write` gains `comment` (on exact page text via `quote`, or on the whole page), `reply`, `edit_comment`, `delete_comment`, `resolve` and `reopen`. The agent acts as a member: it can edit and delete only its own comments, and people it mentions or replies to are notified.

## [3.6.0] - 2026-10-28

### Added
- Desktop: **Settings → Updates** shows the installed version and when the app last looked for a new one, with a **Check for updates** button and an **Open releases page** link for downloading the installer by hand. A manual check brings the update notice back, even for a version that was skipped, and a failed automatic check is shown there instead of staying silent.

### Fixed
- Desktop (Windows): the "new version available" notice never appeared on machines behind a proxy or an antivirus that scans HTTPS. The update check and download now use Electron's network stack, which follows the system proxy and certificate store.

---

## [3.5.0] - 2026-10-28

### Added
- **Diagrams (draw.io)** (#167). Draw flows and sketches in any markdown field with the real draw.io editor: ticket description, ticket comments and Docs pages. A diagram is stored as an editable `.drawio` file plus an SVG preview made on save, and sits in the text as one line, `[Auth flow](diagram:dg_8f2a)` (the label is the alt text; `![label](diagram:id)` also works).
- Start a drawing from the **Diagram** action in the description toolbar and the comment composer, or with `/diagram` in Docs; import a `.drawio`, `.xml` or `.svg` (exported from draw.io with its data) by choosing or dropping it. The file opens in the editor first so it can be checked before saving.
- Inline diagrams show a hover / focus toolbar: Edit, Download (`.drawio`, SVG, PNG 2x, copy as image), View full size (zoom and pan) and Copy link, plus a short text summary. States: editor loading, editor unreachable (the diagram stays visible and downloadable), saving and save failed, edit conflict (Save as copy / Reload theirs), read-only, missing diagram, empty diagram and too large. The editor keeps a local draft and asks before closing with unsaved edits.
- API: `POST /projects/{id}/diagrams`, `GET|PUT|DELETE /diagrams/{id}`, `POST /diagrams/{id}/restore`, `GET /diagrams/{id}/versions`, `/svg` and `/download?format=drawio|svg`, `GET /projects/{id}/diagrams?deleted=true` (Recycle Bin). 2 MB limit per file with a clear `diagram_too_large` error; a save needs `base_version`, a stale one answers `409 diagram_conflict`; deleting only unlinks. Members add and edit, viewers view and download.
- Docs: each page version records the diagram versions it used, so restoring a page restores its diagrams.
- Settings: **Diagrams (draw.io)** chooses where the editor runs (admin setting): self-hosted by default (`http://localhost:8080`, for example the `jgraph/drawio` image) or the public diagrams.net editor, which receives the drawing while the editor is open.

---

## [3.4.0] - 2026-10-28

### Added
- Docs: **inline and page comments** (#166). Select text in the page view or the editor and choose Comment (or `Ctrl+Alt+M`): the text is highlighted with a number and the thread lives in the new *Inline comments* panel (All / Open / Resolved tabs). Threads have replies, edit, delete, resolve and reopen; page comments sit at the bottom of the page. `@mentions` (project members only), `[[Page]]` and ticket keys work in comments, and mentions / replies show as toasts and in the panel's Activity list.
- Docs: comments follow the page, not a version. Anchors are re-matched on every publish: moved or slightly edited text keeps its thread, text that is gone **orphans** the thread (kept with a warning, can be re-attached to a new selection or resolved), and publishing shows a warning when open comments would be orphaned.
- Members have a Docs **role** (Viewer reads, Member comments and resolves, Admin can delete any comment; authors edit and delete their own), set in the Members panel or with `PATCH /projects/{id}/members/{memberId}`.

---

## [3.3.0] - 2026-10-28

### Added
- Docs: **LaTeX formulas** rendered with KaTeX. `$...$` is inline and `$$...$$` is a block, in the page view and in the editor, where a formula can be clicked and edited in place. Formulas are stored as plain `$...$` / `$$...$$` Markdown.

### Changed
- Docs: the content column now grows with the screen (`clamp(640px, 62vw, 1120px)`) instead of a fixed 640px, in both the page view and the editor.

### Fixed
- Docs: the "Changes since you last viewed" banner no longer touches the breadcrumb below it.
- Docs: `$` signs that do not open a formula (for example prices such as "$5 and $6") stay plain text in the page view, matching the editor.

---

## [3.2.0] - 2026-10-22

### Added
- **Reopen** a Done / Won't Do ticket (lands in To Do with an amber *Reopened* badge, reopen history, banner and 8 s Undo), from the detail, the status menu, the card menu, `R`, or by dragging a card out of a closed column (inline confirm at the drop point).
- **Pending** flag (waiting on a ticket, a person or a party) that keeps the ticket's column: striped rail, reason strip, `+N pending` column counts, `P` shortcut, Resume with optional comment, blocker-done / blocker-removed prompts, and a confirm before a pending ticket is closed.
- Filter bar chips (`Reopened`, `Pending`, `Hide pending`), project hints, List sorts (*Most reopened*, *Pending first*, *Longest pending*) and markers in List, Timeline and the Activity feed.
- MCP: `manage_ticket` actions `reopen`, `pend` and `resume`; `list_tickets` filters `pending` / `reopened`.
- REST: `POST /tickets/{id}/reopen`, `POST /tickets/{id}/reopen/undo`, `PUT|DELETE /tickets/{id}/pending`, `POST /tickets/{id}/resume`; `completed_at` / `completed_by` on tickets.
- Won't Do now asks for a reason; comments are shown newest first.

---

## [3.1.2] - 2026-10-14

### Fixed
- Desktop: the bundled `kanban-server` is now also a PyInstaller one-folder build, so the app no longer unpacks the whole backend to a temp folder on every launch (the cause of the slow macOS startup). The backend now lives at `Resources/kanban-server/kanban-server`. Unused stdlib and dev-only packages are excluded from both bundles.

## [3.1.1] - 2026-10-14

### Fixed
- Desktop: the bundled `kanban-mcp-stdio` is now a PyInstaller one-folder build with UPX disabled. The one-file build unpacked to a temp folder on every launch, which macOS scanned each time (~28 s startup), so MCP clients timed out (`CONNECT_TIMEOUT` after 30000 ms). The binary now lives at `Resources/kanban-mcp-stdio/kanban-mcp-stdio`; the old `Resources/kanban-mcp-stdio` path is a folder. The VS Code `mcp.json` entry written by older versions is migrated automatically. Claude Code and other clients registered by hand must be re-installed from Settings -> MCP (the Update action) or re-added with the new path.

---

## [3.1.0] - 2026-10-14

### Added
- **Application log export.** The server now keeps a rotating log (`~/.kanban-board/logs/kanban.log`, 5 MB x 6 files, override the folder with `KANBAN_LOG_DIR`) so errors that never reach the screen can be traced. It records:
  - app and uvicorn messages, failed requests (4xx as warnings, 5xx as errors) and uncaught exceptions with tracebacks;
  - errors from the web UI (uncaught errors, unhandled rejections, `console.error`; logger `ui`);
  - failed MCP tool calls (invalid arguments and `ValueError` as warnings, unexpected exceptions as errors with traceback; argument values are not logged);
  - the stdio MCP process, in its own file `kanban-mcp-stdio.log` (logger names prefixed `stdio:`), merged into the export in time order.
- **Settings -> Application Logs** exports the log as a `.log` file for a chosen time range (presets or custom From/To) and minimum level. Also available as `GET /logs/export?since=&until=&level=`.

### Fixed
- Migrations at startup no longer reset Python logging (`fileConfig` in `alembic/env.py` removed the root handlers and disabled existing loggers).

---

## [3.0.1] - 2026-10-08

### Fixed
- **Update notice (desktop)** showed release notes as raw Markdown (`###`, `**`); they are now rendered, and long notes scroll instead of being cut off.

---

## [3.0.0] - 2026-10-08

The MCP server is reworked from 56 tools down to 9, and its code now lives in a package. The MCP changes are breaking for anything that scripts against the MCP tools (see **Changed**), which is why this is a major version. The web UI and REST API are unchanged.

### Changed (breaking for MCP clients)

- **The MCP server now exposes 9 tools instead of 56** (22 instead of 69 with the Idea Space tools). An agent pays for every tool description and schema on every session; grouping by noun keeps every capability while the tool list is about 30% smaller and the choice of tool simpler. Write tools take an `action` (and `ticket_items` an `item`), their descriptions list the parameters each action takes, and a call with a missing or foreign parameter is answered with what that action accepts. The Idea Space tools (hidden by default) are unchanged.
  - `get_projects` replaces `list_projects` and `list_members`.
  - `list_tickets` and `get_ticket` stay; `get_ticket(view='comments')` replaces `list_comments`.
  - `manage_project`: `create_project`, `update_project`, `add_member`, `remove_member`.
  - `manage_ticket`: `create_ticket` and `create_child_ticket` (`create`, with `parent_id`), `update_ticket` and `update_ticket_status` (`update`), `delete_ticket`, `get_ticket_workspace_path` (`workspace`), `block_ticket`, `unblock_ticket`, `link_tickets`, `unlink_tickets`, `link_ticket_doc`, `unlink_ticket_doc`. For `block`/`unblock`, `ticket_id` is the ticket that waits and `target_id` the one it waits for.
  - `ticket_items`: comments, work log, acceptance criteria, sub-tasks and test cases (`add`, `update`, `delete`, `toggle`, `restore`). The work log `kind` is now `log_kind`; the deprecated test case `note` alias is gone (use `notes`).
  - `ticket_branches`: `add_branch`, `update_branch`, `delete_branch`, `checkout_branch`.
  - `docs_read`: `list_docs_pages`, `get_docs_page`, `search_docs`, `list_docs_versions`, `get_docs_version`, `list_docs_recycle_bin`, `resolve_docs_links`.
  - `docs_write`: `create_docs_page`, `update_docs_page`, `move_docs_page`, `duplicate_docs_page`, `delete_docs_page`, `restore_docs_page`, `restore_docs_version`, `import_docs`.
- The 2,300-line `server/mcp_tools.py` is now the `server/kanban_mcp/` package: `tools/` (the 9 tools and their routing), `operations/` (one module per area: projects, members, tickets, relations, comments, work log, test cases, branches, checklists, docs, ideas), `common.py`, `registry.py`, `instructions.py`, `settings.py`. The largest module is under 500 lines. Database access goes through `kanban_mcp.common.async_session()`, which now looks the session factory up on every call.
- **Misspelt parameters are errors**: a tool call with a parameter it does not declare (e.g. `titel=`) used to succeed without changing anything; it now fails with "Extra inputs are not permitted". `get_ticket(view='comments')` refuses the activity options it would ignore.
- The write tools are annotated destructive as a whole (one of their actions deletes); the four read tools stay read-only.

---

## [2.4.0] - 2026-10-08

The desktop app now tells you when a new version is out and downloads it for you.

### Added
- **In-app update notice (desktop)**: the app checks GitHub Releases on launch and every 6 hours; when a newer version exists it shows release notes and downloads the right installer for your OS and CPU (sha256-verified). Windows runs the installer and restarts; macOS opens the disk image. "Later" and "Skip this version" are available.
- Desktop update checks run in packaged builds only; installing on macOS stays a drag-and-drop because the app is not code-signed.

---

## [2.3.1] - 2026-10-08

### Added
- **MCP `get_ticket`** now returns `files`: every uploaded image or file the ticket mentions (description, comments, work log, attachments) with its absolute `path` on the server's disk, so an AI running next to the server can read it.

### Changed
- **Docs**: an unpublished page (for example one just imported from Markdown) now shows a read-only preview of its draft under the "not published yet" notice, instead of hiding the content.
- **Docs editor**: the callout type chip (Info / Warning / Success) also appears on hover, not only for the callout that holds the cursor.

### Fixed
- **Docs reader**: `> [!SUCCESS]`, `[!OK]` and `[!WARN]` callouts rendered as plain quotes with the marker text; they now render as green / amber callouts.

---

## [2.3.0] - 2026-10-06

Docs space: a per-project page tree with a real WYSIWYG editor (Tiptap) that still stores Markdown, built from the Docs design boards; doc references and a rebuilt Comments section inside tickets; full MCP coverage. Mobile layout and roles / access requests are intentionally not part of this release.

### Added
- **Docs view** next to Board / List / Timeline: page tree (drag to reorder or nest, quick filter, inline rename, row menu, collapsible rail under 1200 px), page view with "On this page" and "Referenced by", empty-space hero with five templates (Blank, Requirements, Meeting notes, Decision log, Technical design).
- **Versions**: every publish adds a version; conflict detection (409) with Keep mine / Reload; history drawer with line and word diff (inline or side by side) and Restore, which creates a new version.
- **References**: `[[Page#Section|label]]` and ticket keys render as chips (missing page, missing section, in Recycle Bin states); backlinks ("Referenced by"), and a "Linked docs" section on the ticket detail.
- **Move to…**, **Duplicate** (with sub-pages) and soft delete into the Recycle Bin (30 days, restorable as a whole subtree).
- **MCP tools**: `list_docs_pages`, `get_docs_page`, `create_docs_page`, `update_docs_page` (rejects a stale `base_version`).
- REST API under `/projects/{id}/docs/...` and `/docs/pages/{id}/...`; migration `b9c0d1e2f3a4` adds `docs_page`, `docs_version`, `docs_draft`, `docs_link`.
- **Visual editor** built on Tiptap: formatting and floating toolbars, `/` block menu, `[[` suggester (pages, sections, tickets), callouts, tables with grips and cell tools, task lists, code blocks with syntax colours, images, drag handle, "On this page" rail, Visual | Markdown toggle, Publish and Discard dialogs, conflict banner with "View their changes", offline and back-online banners.
- **Search**: full-text (SQLite FTS5, LIKE fallback) with phrase and `-exclude` syntax, Ctrl/Cmd+K palette, results page with filters, find-in-page (Ctrl/Cmd+F) with Replace in the editor.
- **Import Markdown** from files or whole folders (drag and drop, front matter, folders become parent pages, link check before importing).
- **Rename with link rewrite** (preview of affected pages, Undo), heading-rename aliases so `[[Page#Old]]` keeps working.
- **Per-project Docs switch** in Settings, **offline copy** of recently read pages, **notifications** when someone publishes (Follow space), **hover preview cards** for page and ticket chips, Share and Page info popovers, "Changes since you last viewed" banner, Undo on Move, combined Recycle Bin (pages and tickets), manual ticket-to-page links and a `[[` suggester in ticket descriptions.
- **MCP tools** (13 new): `search_docs`, `move_docs_page`, `duplicate_docs_page`, `delete_docs_page`, `restore_docs_page`, `list_docs_recycle_bin`, `list_docs_versions`, `get_docs_version`, `restore_docs_version`, `resolve_docs_links`, `import_docs`, `link_ticket_doc`, `unlink_ticket_doc`; `update_docs_page` can also rename.
- **Doc references in tickets** (all fields: description, acceptance criteria, test cases, comments, debug notes): `[[Page]]`, `[[Page#Section]]` and ticket keys render as pills (broken page: red dashed, missing section: amber dashed, deleted page: struck through); hover cards for page, section and ticket (300 ms open, 150 ms grace, flips above or shifts left, failed and deleted states with Retry / Restore); click opens a 480 px read-only side panel over the ticket (referenced section scrolled to and tinted, "Referenced from this ticket" strip, Esc and scrim close only the panel, "Open in Docs" keeps `#section`).
- **One `[[` suggester in every field**: pages (recent first), sections after `#` (H2/H3, Whole page), tickets after `KAN-`, members after `@`; works in the rich editors, the comment box, the acceptance criterion row and the debug note. In the editors the pill under the caret becomes raw text and snaps back when the caret leaves.
- **Linked docs by origin**: one row per page with "Mentioned in description / acceptance criterion / test case TC-3 / comment / debug note", a lock for derived links, manual links stay removable; "Referenced by" says "Mentioned in KAN-2 · test case TC-1". Activity logs `doc_ref_added` / `doc_ref_removed` as one "Doc references" entry, shows pills in description diffs with a "Show raw" toggle, and each comment is one "commented · View comment" line that scrolls to and tints the comment.
- **Comments rebuilt**: thread with exact-time tooltip and `edited` marker, hover bar (Edit / Delete / Copy link), Write / Preview composer with toolbar, attachments and a per-ticket draft, edit in place, delete with inline confirm and a 10 s Undo (soft delete + `POST /tickets/{id}/comments/{cid}/restore`), long thread and long comment folding, send-failed and offline-queue states, `@[Name](member:id)` mentions with a computed recipient list (`comment_added` event), `#comment-id` deep links. Esc closes the ticket modal.
- **MCP**: `list_comments` and `restore_comment` (56 tools, 69 with Idea Space).
- Migration `c0d1e2f3a4b5`: `projects.docs_enabled`, `docs_links.origin`, `docs_anchor_aliases`, FTS index.

### Changed
- Docs UI rebuilt from the design boards (tokens, icons, tree, rail with flyouts, page view, dialogs, history and diff).
- PyYAML is now a server dependency (Markdown front matter).

### Fixed
- Regexes that parse `[[references]]`, headings, `@mentions` and search tokens are now linear on hostile input (CodeQL "polynomial regular expression" findings). A heading such as `## C#` keeps its `#`; a closing `#` run is dropped only after a space.
- Esc closes the ticket modal (unless a field, the doc side panel or another dialog is using it); the ticket modal now has `role="dialog"`.
- A deleted page's pill in a ticket offers Restore (the reference resolver returns the page id and who deleted it).
- Dragging a row in the Docs tree no longer selects text.

---

## [2.2.0] - 2026-10-05

Comprehensive file attachment overhaul, interactive Markdown image resizing, consolidated attachments zone, and desktop system app opening.

### Added
- **Multi-format attachment support**: Upload and embed any file type (Word, Excel, PowerPoint, PDF, JSON, text, code, audio, video, archives) across all Markdown editors (Ticket Description, Comments, Work Log, Test Cases).
- **Consolidated Attachments Zone**: Redesigned to strictly match `Attachments.dc.html`, placed after Comments with square image thumbnails, file chips with type badges and direct download buttons, dashed add tile (`+`), and provenance origin tags (Description / Comment author).
- **Interactive Lightbox Preview Modal**: Full-screen preview modal portaled to `document.body` with deep ink/forest darkened blurred backdrop (`rgba(25, 38, 28, 0.65)`), full keyboard navigation (`Esc`), text/code viewer with copy tools, PDF viewer, media player, and Desktop "Open in App" button.
- **Interactive Markdown Image Drag-to-Resize**: Direct drag resizing in the WYSIWYG editor with 6 corner/edge handles, real-time dimension badge, quick percentage presets (25%, 50%, 75%, 100%), natural reset, delete action, and serialized Markdown width persistence (`![alt|width](url)`).
- **Desktop System App Opening**: Electron IPC `openPath` and backend `X-File-Path` headers allowing local files to be opened directly in their default system application (Excel, Word, PowerPoint, Code editor).
- **Sub-tasks checklist** in Ticket Detail: lightweight to-do steps inside a ticket (REST `/tickets/{id}/sub-tasks`, MCP `add_sub_task` / `toggle_sub_task` / `delete_sub_task`, new `sub_tasks` column).

### Changed
- **Ticket Detail design match**: Child-ticket list styled as "Sub-tickets" with status marks and progress counts.
- **Design system alignment**: Unified colors, button styles, typography (`Plus Jakarta Sans`, `JetBrains Mono`), and language (English) across upload notifications, preview modals, and file chips.

---

## [2.1.1] - 2026-10-05

Fix for Claude Code CLI MCP addition syntax.

### Fixed
- **Claude Code MCP add failed with missing `commandOrUrl`**: updated argument ordering in `claude mcp add` to place the server name (`kanban`) immediately after `add`, matching Claude Code CLI syntax requirements.

---

## [2.1.0] - 2026-10-05

One-click MCP setup for AI tools.

### Added
- Settings → MCP integrations: install, update, test and remove the kanban MCP server for Claude Code (User, Project or Local scope, through `claude mcp add`) and Antigravity (Global or Workspace `mcp_config.json`). Only the `kanban` entry is ever changed.

---

## [2.0.2] - 2026-10-05

Fixes for opening and importing backups made by older builds.

### Fixed
- **Databases created by pre-release builds could not be opened** ("Try again" on the splash, or a failed import): they are stamped with a migration (`f6a7b8c9d0e1`, "add_idea_board_fields") that was removed before 1.4.2, and alembic stopped with "Can't locate revision". Such databases are now re-stamped to the nearest existing revision and upgraded normally; all projects and tickets are kept (checked with a real 217-ticket backup).
- **Data folder check recognised by code scanning**: `POST /settings/data-path` still only accepts folders inside your home directory, now written in the form CodeQL understands, which clears 8 "uncontrolled data used in path expression" alerts that this change would otherwise raise. The home folder itself is no longer accepted, only folders inside it.
- **Import of a backup failed with "database disk image is malformed"**: the old `kanban.db-wal` / `-shm` files were left next to the replaced database. Import now checks the uploaded database first (a broken file is rejected with a clear message before anything is changed), removes the old WAL files when swapping, and flushes the WAL into the backup it keeps for rollback.

---

## [2.0.1] - 2026-10-05

Fixes for the 2.0.0 desktop app, found on a fresh install.

### Fixed
- **Desktop app icon was still the old one**: `icon.icns`, `icon.ico` and `icon.png` are regenerated from the current logo, and `generate-icons.js` now reads `ui/public/logo.svg` (the app logo). macOS may keep showing the old icon from its cache until the app is reinstalled or the Dock is restarted (`killall Dock`).
- **Desktop: existing data not loaded after upgrading to 2.0.0** (the app opened on "Create your first project"). A data folder chosen in Settings must win over the desktop's default `KANBAN_DB_PATH`, as it did before 2.0.0; the order was accidentally reversed. Your data was not deleted: it is still in your data folder.
- **Splash "Kanban is taking longer than usual to start" appeared too early**: the wait before it is now 30 s (was 8 s).

---

## [2.0.0] - 2026-10-05

A redesigned interface, real git integration, per-ticket workspaces, a much richer ticket detail, and an MCP server reworked for AI agents. The MCP changes are breaking for anything that scripts against the MCP tools (see **Breaking changes**), which is why this is a major version.

### Breaking changes (MCP)
- **Failures are errors, not `null`**: not-found, validation and workflow errors (e.g. "Done requires…", invalid status moves) are raised as tool errors (`isError`) whose message says how to fix the call and lists the valid ids. Previously some tools returned `None` or `{"error": …}`, and deleting an unknown comment or criterion "succeeded" silently.
- **`list_tickets` returns paginated compact summaries** `{total, count, offset, has_more, tickets}` instead of a plain list of full tickets (`detail=true` returns full objects; `limit` / `offset` page through).
- **The full activity log is no longer returned**: it is about 80% of a typical ticket. `get_ticket` returns only the 10 most recent entries (long texts shortened) plus `activity_total`; `activity_limit=N` changes the number (0 = none, a negative number = the whole history in full), and `activity_since=<ISO time>` returns what changed since then. Tools that change a ticket return it without any activity. Duplicate camelCase keys on branches are dropped.
- **Idea Space tools are hidden from MCP by default** (13 of 47 tools). Set `KANBAN_MCP_IDEA_TOOLS=1` to expose them again. The Idea Space web UI and REST API are unchanged.

### Added
- **Redesigned UI** following the new design system: tokens, icons and logo, ticket card and tags, status menu, toasts, loading states, drag-and-drop motion, the dark sidebar with hover expand, board / list / timeline / members / settings screens, and a restyled Ticket Detail (sidebar, acceptance criteria, sub-tickets, relations, comments, fullscreen toggle, delete as a header action).
- **Review and Testing statuses** across the backend, UI and MCP tools.
- **WYSIWYG Markdown editor** for descriptions, comments and test cases: toolbar, undo/redo, smart bold/italic, tables, task lists, nested lists, code blocks with language, strikethrough, rules and quotes, image upload (picker, paste, drop) with clear error messages, and safe link/image URLs.
- **Git integration**: a git repository per project with a per-ticket override; real branches created through GitPython with live ahead/behind; git worktrees (project defaults, per-ticket customisation); rename, checkout and merge verification against git; honest cleanup and optional git branch deletion; a real commit graph with overview and all-commits views, legend and a commit detail panel.
- **Workspace tab**: a scratch folder per ticket with a real file manager (create folders, upload, drag and drop, preview, download, delete), a Workspace section in Settings (root path, retention), automatic cleanup of Done / Won't do tickets after the retention period (with "Clean now" preview), and "Open folder" on the server machine. Agents get the path from the new MCP tool `get_ticket_workspace_path` (and `workspace_path` in `get_ticket`) and read/write the folder directly.
- **Activity tab**: every entry records who made the change ("You", "AI agent", or a name) and covers comments, acceptance criteria, work log, test cases, blocks and links, branches and checkouts, parent changes, Won't do reasons and repo paths; filters for comments and branches. The REST API accepts an `X-Actor` header; everything done through MCP is attributed to the AI agent.
- **Debug Space**: edit entries, confirm before deleting, real file attachments (new `POST /uploads/files`), links to real branches and test cases, validated kinds/roles, and a red dot only while a `blocked` entry has no later `resolved` one.
- **Test cases**: Running status, rich fields (description, expected result, notes, proof) and real file attachments with their real size.
- **"Done requires" toggles** in the ticket sidebar (all acceptance criteria met / all test cases passed), wired to the guards the backend already enforced.
- **Splash screen**: the first thing painted when the app opens (web and desktop). The logo, wordmark and progress bar are in `index.html`, so they show from the first frame, before any JavaScript loads. The cards intro (1.2 s) plays once per cold start; reloads skip it. The splash stays at least 600 ms, fades into the app in 200 ms, and honours `prefers-reduced-motion`.
- **Server unreachable state**: if the server does not answer within 30 s the splash shows "Can't reach the server" with a Try again button, the last attempt time and a retry countdown (every 10 s, then backing off), and opens the app by itself once the server is back.
- **App loading states**: while data loads the app shows a real shell with skeleton rows and cards of the same size as the real ones (no layout shift), a small status pill (after 300 ms; "Still loading... Check your connection" + Retry after 3 s), "Couldn't load your projects/tickets" with Try again after 15 s, and "Create your first project" when there are no projects.
- **Update required screen**: new `GET /version` (`version`, `latest`, `min_supported_version`); a UI build older than the minimum shows a non-dismissible "A new version is available" screen with Reload now. `KANBAN_MIN_UI_VERSION` overrides the minimum.
- Desktop: **Try again** after a backend start-up failure (new `retry-backend` IPC).
- **MCP**: new tools `update_project`, `delete_ticket`, `block_ticket`, `unblock_ticket`, `link_tickets`, `unlink_tickets`, `delete_test_case`, `checkout_branch`, `delete_work_log` and `get_ticket_workspace_path`; `update_ticket` can set assignee, dates, repo path, Won't do reason and the Done guards and empty fields with `clear_fields`; status tools accept `wont_do` with a reason; `create_ticket` accepts `assignee` and `start_date`; `add_branch` accepts `create_worktree` / `worktree_path`; `delete_branch` accepts `remove_worktree` / `delete_git_branch` / `force`. Test cases can be addressed by code (`TC-2`) and branches by name as well as by id.

### Changed
- **MCP tools reworked for AI use** (names unchanged): every description says when to use the tool, what the arguments mean and what comes back; parameters carry schema descriptions and real enums (`idea_energy` was documented as `low|medium|high` but the valid values are `seed|concept|hot|big_bet`); all tools have read-only / destructive / idempotent annotations; the server sends usage instructions on connect (HTTP and stdio); redundant schema titles are removed. The default tool list is 34 tools, roughly 6.9k tokens.
- **Ticket detail validates input** (HTTP 400 instead of silently accepting): empty or over-long titles, invalid dates or a start after the due date, negative or absurd estimates, bad tags, parents that are the ticket itself, missing, in another project or nested too deep, block links across projects or forming a cycle, and empty or oversized comments, criteria and test-case titles. When the server refuses an edit the form rolls back to the saved value.
- **Deleting a ticket cleans up after itself**: sub-tickets are detached, block and link references on other tickets are removed, and its workspace folder is deleted.
- Description edits are saved once per pause (and on blur or close) instead of once per keystroke, so the Activity tab no longer gets an entry per key.
- Anonymous GUI comments are shown as "You"; the made-up fallback names in the ticket detail are gone.

### Fixed
- **Markdown editor**: switching bold or italic off while typing moved the caret and scrambled the text; merely opening and closing the editor rewrote the description (bold, tables, task lists and code languages could be lost); inline runs typed into an empty editor were saved as separate paragraphs; a rapid burst of saves could land out of order and drop the end of the text.
- **Debug Space** crashed the whole ticket modal on an entry with an unknown kind or role.
- Downloads of attachments now keep their original file name; non-image uploads are served only as downloads.
- Desktop: reloading the window after the backend was already up left the UI waiting for a ready event that never came again; it now asks for the backend port directly.
- Layout polish: ticket modal frame height across tabs, clipped tab icons and badge dots, board columns no longer force horizontal scroll, long branch / commit / author names are truncated, unset due date and estimate show a dash.

### Security
- Workspace paths are validated against the workspace root (real path, symlinks ignored); "Open folder" no longer puts any path on a command line; Markdown link and image URLs are limited to safe schemes and normalised before reaching the DOM; uploaded files that are not images are never served inline.

---

## [1.4.5] - 2026-09-16

### Fixed
- **Desktop app SSE reconnect stuck on the wrong port**: the live-update stream resolved the backend's origin once at mount and never re-checked it, so if that happened before Electron's backend-ready signal arrived (more likely the longer the backend takes to start), it stayed permanently stuck retrying the wrong fallback port every few seconds — each retry force-refetched everything, producing a repeating load/stall cycle. It now re-resolves the origin on every reconnect attempt so it self-corrects.

---

## [1.4.4] - 2026-09-13

### Added
- **Comment editing & deletion**: comments can now be edited and deleted, end-to-end — MCP tools `update_comment`/`delete_comment`, `PATCH`/`DELETE /tickets/{ticket_id}/comments/{comment_id}`, and edit/delete controls on each comment in the UI.
- **Full Markdown for comments**: comment text now gets the same Markdown treatment as ticket descriptions — tables, task lists, code blocks, links, images, headings, etc., rendered via the shared `MarkdownRenderer` and authored with the same toolbar-driven editor (shown on focus, collapses back to a plain box when idle).

### Fixed
- The MCP server's HTTP transport (`/mcp`) was completely broken — every tool call over HTTP raised `RuntimeError: Task group is not initialized`, because the mounted MCP sub-app's lifespan was never started. The stdio transport (used by VS Code/Claude Desktop) was unaffected. Also corrected the documented client URL to `/mcp/` (trailing slash required).

### Changed
- README's MCP tool count corrected (33 tools registered); `add_comment`/`update_comment` tool descriptions now note Markdown support.

---

## [1.4.3] - 2026-09-12

### Added
- **Fuzzy ticket search**: search now matches ticket id/code (e.g. searching `25` finds `MON-25`), title, description, and tags — not just an exact title substring. Matching runs server-side (`rapidfuzz`), ranked by relevance.

### Fixed
- Kanban columns (and List/Timeline views) can now be scrolled to see tickets beyond the visible area — the column container had no real height bound, so overflow was silently clipped instead of scrolling
- Search input no longer flashes the whole board to a blank "Loading tickets…" state and loses focus on every keystroke (ticket query now keeps showing previous results while a new search fetches)

### Changed
- Scrollbars are now hidden on the kanban column, list, and timeline scroll containers (scrolling still works, just no visible track/thumb)

---

## [1.4.2] - 2026-04-26

### Added
- **Idea Board Backend**: full backend integration for Idea Board — REST API + MCP tools for idea tickets (CRUD, status transitions, promote to ticket, microthoughts, assumptions, activity trail)
- **Idea Board API wiring**: React UI fully connected to backend API with SSE real-time invalidation, optimistic status updates with rollback

### Fixed
- Idea board columns now scroll correctly when cards overflow (flex-shrink + min-height fix)
- Idea status names aligned between backend and frontend (draft/in_review/approved/dropped)
- Vite proxy config updated to forward `/api/*` routes to backend

---

## [1.4.1] - 2026-04-22

### Fixed
- **BUG-01** Tags now persist after saving in IdeaTicketModal (missing field in API schema and service)
- **BUG-02** Promote to Board is now atomic and idempotent — dedicated `/promote` endpoint prevents duplicate tickets on retry
- **BUG-03** Full column is now the drag drop target (not just the inner card list), fixing silent no-op when dropping on empty Approved column
- IdeaTicketModal crash when `ideaStatus` is null or unexpected value (status style lookup now has safe fallback)

## [1.4.0] - 2025-07-17

### Added
- **Idea Board**: new per-project idea board with 3 columns (Draft, Approved, Dropped)
- **IdeaCard**: draggable cards with emoji, color accent, status badges, description preview
- **IdeaTicketModal**: full view/edit/approve/drop/promote workflow with 2-stage promotion confirm
- **BoardSwitcher**: pill-tab switcher between main Kanban board and Idea Board (persisted per project)
- **MCP tools**: `list_idea_tickets`, `create_idea_ticket`, `update_idea_ticket`, `promote_idea_ticket`, `drop_idea_ticket`
- **SSE**: targeted idea board cache invalidation via project-scoped `idea_ticket_*` events

---

## [1.3.13] - 2026-04-18

### Fixed
- Drag-and-drop snap-back: ticket no longer returns to original column after drop. Implemented local state synchronous update so the card stays in the destination column immediately.

---

## [1.3.12] - 2026-04-18

### Added
- **B&W TV theme toggle**: A grayscale filter mode inspired by classic black & white TV. Toggle available in the Settings panel; preference persisted across sessions.

---

## [1.3.11] - 2026-04-18

### Changed
- **Ticket Card redesign (IAM-111)**: Added type-color left border accent, hover-reveal drag handle icon, consolidated footer with priority dot, tags (max 2 + overflow), estimate/subtasks/due on one row; assignee avatar moved to header
- **Board layout improvements (IAM-114)**: Column headers with ticket count badge; empty columns show "No tickets" placeholder; board title hierarchy improved
- **Modal polish (IAM-115)**: Ticket detail modal 70/30 layout, create form fields grouped into sections (Basic info / Metadata / Dates), delete confirmation styled as warning strip; Jira-style grouped relations with inline add button and hover-reveal remove

---

## [1.3.10] - 2026-04-18

### Changed
- Redesigned Relations section in ticket detail: replaced 7 separate labeled sections with a compact unified list and single inline "Add relation" form with dropdown type selector and ticket search

---

## [1.3.9] - 2026-04-17

### Added
- **WorkLog (IAM-88)**: Markdown editing and image support for work log notes — supports bold, italic, lists, links, image paste (Ctrl+V), and image file upload
- **Test Case Proof (IAM-89)**: Markdown editing and image support for test case proof field — same capabilities as WorkLog
- Extracted shared `MarkdownRenderer` component for consistent markdown sanitization

---

## [1.3.8] - 2026-04-17

### Added
- Extended ticket relationship types: `relates_to`, `causes`/`caused_by`, `duplicates`/`duplicated_by`
- Bidirectional link management — adding a link auto-creates the inverse on the target ticket
- New API endpoints: POST/DELETE /tickets/{id}/links
- RelationsSection UI shows all relationship types with human-readable labels
- Cross-project links and self-links are blocked server-side

---

## [1.3.7] - 2026-04-17

### Added
- Per-ticket toggles to block Done transition when ACs or TCs are not fully passed (`block_done_if_acs_incomplete`, `block_done_if_tcs_incomplete`)
- Server-side validation returns combined error message when multiple guards fail
- UI toggle switches in ticket detail view for both guards
- Specific backend error messages surfaced in ticket modal (no more generic errors)

---

## [1.3.6] - 2026-04-16

### Improved
- Rename default project member from 'Quản trị viên' to 'Admin'
- Board columns now sort tickets newest-first so new tickets appear at the top; parent-child hierarchy is preserved

---

## [1.3.5] - 2026-04-16

### Improved
- Desktop app startup time on macOS: Electron window now appears immediately (<3s) while the Python MCP backend warms up in parallel. A loading overlay is shown during connection; a graceful error state is displayed if the backend fails to start.

---

## [1.3.4] - 2026-04-15

### Changed
- CI/CD: automated release pipeline via GitHub Actions

---

## [1.3.3] - 2026-04-15

### Fixed
- Markdown tables in ticket descriptions now display with borders, header background, and alternating row colors

---

## [1.3.2] - 2026-04-15

### Fixed
- Markdown tables now render correctly in ticket descriptions (added `remark-gfm` GFM support)

---

## [1.3.1] - 2026-04-14

### Fixed
- Fixed import restoring empty data — SQLite WAL was not checkpointed before export, causing the ZIP to capture an outdated snapshot. Export now runs `PRAGMA wal_checkpoint(TRUNCATE)` before zipping so all committed data is included.

## [1.3.0] - 2026-04-14

### Added
- Settings panel (⚙️ in sidebar) to change the data folder at any time — moves kanban.db and uploads to the new location, persists across restarts.
- Export all data as a ZIP file (database + attachments) from the Settings panel.
- Import a previously exported ZIP to fully replace all data.
- Electron desktop: native folder picker dialog for data folder selection.

### Security
- ZIP Slip protection on import (path traversal via crafted archive entries is blocked).
- ZIP bomb protection on import (500 MB upload cap, 50k file limit, 2 GB uncompressed limit enforced during extraction).
- Data folder path restricted to within the user's home directory.
- Conflict guard prevents overwriting an existing database when changing the data folder.

---

## [1.2.7] - 2026-04-14

### Fixed
- Fixed image file upload in ticket description editor — OS file picker no longer causes the editor to collapse and abort the upload.
- Fixed pasted images overflowing horizontally in the description view — images now scale to fit the container width.
- Added rapid-click guard on image upload button to prevent multiple focus listeners from accumulating.
- Sanitized image filenames in Markdown alt text to prevent malformed Markdown output.

---

## [1.2.6] - 2026-04-13

### Added
- Added support for pasting images from the clipboard into ticket descriptions.
- Added direct image file upload support for ticket descriptions.
- Uploaded images are automatically inserted as markdown at the cursor position.
- Preserved existing autosave and markdown preview behavior for image-rich content.

---

## [1.2.5] - 2026-04-11

### Fixed
- Fixed an issue causing disjoint database instances where the desktop UI hit the user's data directory while the MCP server proxy spawned by VS Code fell back to a localized sqlite instance. Path is now explicitly synced during IDE proxy-setup.

---

## [1.2.4] - 2026-04-11

### Changed
- Desktop app now uses the project's Kanban logo instead of the default Electron icon
- Web UI favicon updated to use the repo logo (SVG)
- Added `desktop/scripts/generate-icons.js` to regenerate icons from SVG source

---

## [1.2.2] - 2026-04-11

### Changed
- Dependency upgrades: Electron 34 → 39, electron-builder 25 → 26, Vite 5 → 8, axios 1.14 → 1.15, cryptography 46.06 → 46.0.7.

---

## [1.2.1] - 2026-04-11

### Fixed
- Fixed blank/white screen on Electron app launch (UI now served from backend HTTP, not `file://`).
- Fixed CORS and Chromium Private Network Access issues in packaged mode.
- Fixed Alembic migration: `blocks` and `blocked_by` missing columns causing 500 errors.
- API base URL routing fix for packaged builds using `window.location.origin`.
- SSE event source memory leak guard added for packaged Electron mode.
- Hardened path traversal protection in static file serving.
- Backend startup script now exits cleanly instead of blank window on failure.

---

## [1.2.0] - 2026-04-11

### Added
- First native installable desktop application release via Electron.
- No manual setup required — installs and runs immediately.
- React UI served from bundled static files via Electron.
- Python FastAPI backend bundled as a PyInstaller binary; spawned automatically on launch.
- MCP stdio binary bundled for VS Code integration.
- VS Code auto-setup: on first launch, automatically registers the `kanban-board` MCP server in VS Code's `mcp.json`.
- SQLite database stored in platform user data directory (persists across updates).
- Clean app quit (Python child process terminated gracefully).

---

## [1.1.0] - 2026-04-10

### Added
- ✨ SSE Auto-refresh: The UI now automatically refreshes when AI agents use MCP tools to create, update, or delete tickets — no manual page reload required.
- Added `GET /events` SSE endpoint to FastAPI backend.
- MCP mutation tools and REST API routes now publish `invalidate` events on a shared async event bus (`server/events.py`).
- React frontend connects via EventSource and calls `queryClient.invalidateQueries()` on events.
- Auto-reconnects after 3s on connection drop.

---

## [v1.0.0] — 2026-04-09

Stable release — promoted from v1.0.0-beta after full end-to-end QC verification (IAM-71).

### Fixed

- **Test Cases UI**: `proof` and `note` fields were not rendered in the ticket modal after `update_test_case` MCP tool updated them. Rows now auto-expand on mount when data is present, and also re-expand when live prop updates arrive while the modal is open. A 📎 indicator is shown in collapsed rows that have proof/note data. (IAM-72)

---

## [v1.0.0-beta] — 2026-04-08

First public beta release. The core Kanban board experience is complete — full MCP server, a polished React UI, and AI agent integration.

### MCP Server

- **15 MCP tools** exposed via streamable HTTP transport (`/mcp`)
- Projects: `list_projects`, `create_project`
- Members: `list_members`, `add_member`, `remove_member`
- Tickets: `create_ticket`, `list_tickets`, `get_ticket`, `update_ticket`, `update_ticket_status`, `create_child_ticket`
- Annotations: `add_comment`, `add_work_log`, `add_test_case`, `update_test_case`
- FastAPI + SQLModel + SQLite backend with Alembic migrations
- Async I/O (`aiosqlite`), auto-generating ticket IDs (`PREFIX-N`)
- Activity log on every ticket status change
- Health check endpoint (`GET /health`)

### UI (React)

- **Board view** — drag-and-drop columns (Backlog → To Do → In Progress → Done) via `@dnd-kit`
- **List view** — grouped by status, sortable by due date or created date, collapsible groups
- **Timeline / Gantt view** — Gantt chart + event timeline sub-views, overdue highlighting
- **Ticket modal** — full ticket detail with inline editing, acceptance criteria checklist, sub-tickets, tags, priority, type, story points, assignee, parent ticket
- **Comments & activity** — threaded comments, work log, test cases with pass/fail/proof
- **Project sidebar** — multi-project navigation, project color coding
- **Members management** — per-project member list with color avatars
- **Recycle bin** — soft-delete and restore tickets
- **Search & filter** — real-time ticket search, priority filter (Critical / High / Medium / Low)
- Connected to the MCP server via REST API (no mock data)
- Bento Grid design system: cream background (`#F5EFE0`), deep burgundy primary (`#3D0C11`), vibrant column accent colors

### Infrastructure

- `uv` for Python dependency management and running the server
- `ruff` for linting and formatting
- `pytest` + `httpx` + `ASGITransport` for async API tests
- Vite + TypeScript for the React build
