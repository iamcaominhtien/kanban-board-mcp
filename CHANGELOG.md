# Changelog

All notable changes to this project will be documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/). Versioning follows [Semantic Versioning](https://semver.org/).

---

## [Unreleased]

## [3.16.0] - 2026-11-01

AI accounts: several sign-ins of the same AI CLI, shared between AI members. Design: `design/screens/ai-accounts.md`; notes: `docs/specs/ai-accounts.md`.

### Added
- **AI accounts.** An account is a separate login of one CLI (Claude Code, Codex, opencode or Antigravity) in a folder of its own, so two of them can run at the same time. Members › **AI accounts** lists them with who is signed in (Claude Code reports email and plan), their status and the members using each; the row menu has Check now, Rename, See members using it, Sign out and Remove (which asks what happens to the members on it). An AI member picks an account in the Connect step of **Add AI member**, in its profile and when editing it; “the login already on this computer” stays the default and works as before. Members on one account share its limits, and the picker says so.
- **Sign in inside the app.** **Add account** and **Sign in again** open a window with the CLI's own login in a real terminal, with a line above it that says what it is waiting for (choose a method, finish in the browser, paste a code), key buttons, **Paste code**, **Open in browser** and **Copy link**. Done is decided by asking the CLI who is signed in, never by reading the screen. Where the terminal cannot start, the window shows the command to run in your own terminal and keeps checking. Desktop app only; the web build shows the list read only.
- **A signed-out account holds its members together.** One banner names the account, runs wait and start by themselves after **Sign in again**; a run that finds the session over fails with “Account signed out”.
- **Codex, opencode and Antigravity run tickets.** New AI member types Codex and opencode, and Antigravity (through its `agy` command), work a ticket like Claude Code: steps, changed files, a summary, the board's MCP tools, and the member's permissions. Each CLI is held to them in its own way, and none is started with a flag that skips its permission checks unless the project owner turns on Bypass permissions for that member (see below): Codex runs in its `read-only` or `workspace-write` sandbox (the Allow and Deny tool rules do not apply to it), opencode gets a permission map built from the member's Allow and Deny rules, and Antigravity gets the Allow rules as command rules (its headless mode ends the run at the first action no rule allows, and the run then fails with the reason). Antigravity runs need an AI account.
- **Bypass permissions for Codex, opencode and Antigravity members**, with the same rules as for Claude Code (owner only, typed confirmation, audit entry, work runs only, never in Safe mode). Codex runs with `-s danger-full-access` (no sandbox; the Deny rules do not apply to Codex), opencode allows every command and edit except what a Deny rule stops, and Antigravity gets `--dangerously-skip-permissions` with the Deny rules passed as `command(...)` deny rules (checked: they still block a command under the flag). The Configuration tab now shows Permissions for Codex and opencode members, and the Allow and Deny rules for Antigravity, which are now passed to the run. Antigravity needs no pre-approved command list under Bypass, so a run no longer ends at an unlisted command.
- **MCP:** `ai_team` can list accounts (`accounts`) and put a member on one (`assign_account`). There is no way for an AI to sign in, sign out or remove an account.

- **Configuration tab of Antigravity, Codex and opencode members** now matches what a run really does, like Claude Code's: **Rules** (added to the prompt of every run, with the role / persona), **Permissions** (Allow and Deny rules; Codex runs in its own sandbox) and **Model & limits** (model, run and no-output timeouts, runs per day, parallel runs, extra flags). The model is a list from `agy models` or `opencode models` (Codex: type it); opencode also has **Effort**. Codex gets **Auto-compact at (tokens)**, passed as `model_auto_compact_token_limit`. Antigravity has no such setting: it compacts a long session by itself. The "paste into the Antigravity app" steps, the tick boxes, the permission notes, Workflows and the experimental MCP file sync (`antigravity.sync_mcp`, which wrote a file nothing read) are removed, because runs never read them. A saved configuration that still has those keys keeps working: they are ignored.
- **Antigravity sign-in window.** The terminal is as tall as the window allows (up to 24 rows) with a scrollbar that stays visible, and the mouse wheel scrolls three times faster. On macOS each Antigravity account gets a keychain of its own, so the system no longer asks for a keychain that is not there.

### Fixed
- The sign-in window stayed empty in the desktop app: its security policy blocked the WebSocket to the local server.
- A run of opencode ended at the first prompt it could not answer (`external_directory`, `doom_loop`). They are denied now, so the model gets an error and goes on; a run that does stop says at which permission, without colour codes.
- A run of Antigravity failed with `--effort`, which `agy` refuses with most models; the flag is no longer passed.
- An AI member writing several test cases, comments or checklist items on one ticket was stopped as a "loop". Only the same call (same action, target and content) repeated counts now.
- Antigravity's report to the board (`ai_run`) sent empty criteria because the tool listed no fields for them; the fields are in the tool's schema now. `ai_run` also ignores a `ticket_id` a model adds, and `ai_team` uses the run's project when none is given.
- Antigravity is told that its file tools need absolute paths.
- The name of the assignee in a ticket was 16 px, larger than the other values beside it.

### Changed
- The Antigravity type looks for the `agy` command instead of `antigravity`.
- The developer script `.claude/scripts/ai_profile.py` (several accounts of a CLI from the command line) now shares its code with the server (`server/services/ai/profiles.py`).

## [3.15.2] - 2026-10-30

Hotfix for changes that did not show on the board until the app was restarted, and for the side panels' width.

### Fixed
- **Changes an AI made through the MCP server did not appear on the board.** When the AI is connected over stdio (the desktop app, VS Code and Claude Desktop launch it that way) it runs as its own process, so the "board changed" signal it sent reached nobody; an updated ticket or Docs page showed up only after another action, the 60-second refresh or a restart. The server now watches the database and announces changes that another process made. A change the server itself announced is not announced twice.
- **A slow screen could stop receiving updates.** When a client fell behind, the server dropped it from the live stream without closing it, so the board went quiet until a restart. It now keeps the client and skips its oldest event.
- **The board refetched everything for every event.** An AI editing many things at once made the board reload once per edit. Events within 150 ms are now gathered into one refresh, and a tab that comes back from sleep reconnects (or refreshes) at once.

### Added
- **Resize and maximize the side panels.** Drag the left edge of Board AI, the ticket chat, the idea chat, Shape with AI and the Docs inline comments to widen them (the width is remembered for each panel; double-click the edge or press Home to reset; arrow keys nudge it). The new button in each header fills the window, and Esc restores it.

## [3.15.1] - 2026-10-30

Hotfix for how a mention looks in the comment boxes.

### Fixed
- **A mention in a comment box showed its code.** Picking someone with `@` put `@[PM](member:465eec59-…)` in the ticket comment box and in the Docs comment box. The box now shows `@PM`; the comment is still saved with the member's id when it is sent, so the link, the notification and an AI mention work as before. A name typed by hand (`@Tien Cao`) is linked too, and editing an old comment shows the same plain `@Name`.

## [3.15.0] - 2026-10-30

The desktop menu bar and the user and administrator guide ([#207](https://github.com/iamcaominhtien/kanban-board-mcp/issues/207)). Designs: `design/screens/desktop-menu.md` and `design/screens/guideline-design.md`.

### Added
- **Desktop menu bar** (macOS, Windows and Linux): an app menu on macOS (About, Check for Updates…, Settings… ⌘,, Services, Hide, Quit) and File, Edit, View, Window and Help on every platform, in place of Electron's default menu. File has New Ticket (Ctrl/⌘+N), New Idea (Ctrl/⌘+Shift+N), New Doc Page (Ctrl/⌘+Alt+N), New Project…, Import Data… and Export Data… (Settings › Storage & backup); View switches Board, List, Timeline, Docs, Schedules and Idea Space (Ctrl/⌘+1 to 6, the current view is ticked) and opens Ask AI (Ctrl/⌘+J); Edit has Find in Board (Ctrl/⌘+Shift+F). Help has Keyboard Shortcuts (Ctrl/⌘+/), Documentation, What's New, Set Up AI…, Set Up MCP…, Report an Issue…, Request a Feature…, Open Logs Folder, Export Logs…, Open Data Folder and Copy Diagnostics Info (versions and system facts only, never tickets, Docs, paths, keys or logs); on Windows and Linux Check for Updates… and About are at the bottom of Help. On macOS Help is the system Help menu, so it has the menu search box. All links go to this project's own pages.
- **Four small windows** in the page: Keyboard Shortcuts (searches commands and keys), What's New (the release notes of the running version, from `CHANGELOG.md`), Report an Issue (shows what will be filled in, then opens a new GitHub issue in the browser; the app sends nothing) and About (the system About window on macOS).
- **Check for Updates… from the menu** reuses the existing update flow (the corner notice and Settings › Updates) and adds a toast for a manual check ("You're up to date", or "Couldn't check for updates" with "Open releases page"); the item is greyed while a check runs and reads "Install Update x.y.z…" when one is found. Automatic checks stay silent.
- Items that need data are greyed while the backend is not running (Help keeps working); on macOS with no window open only File › New Window is live.
- **The guide** (`docs/guideline/guide/`): one English user and administrator guide built from one source file per chapter with audience tags (Everyone, Admin, Developer, Desktop app, AI): a full PDF with cover, contents with page numbers and links, bookmarks, a tagged structure and embedded Plus Jakarta Sans and JetBrains Mono, a web version, and stand-alone PDFs (quick start, keyboard shortcut sheet, administration, self-hosting, MCP, privacy, troubleshooting). Values stated from the code (tool count, defaults, statuses, settings pages, environment variables) are read from the code when the guide is built, and the build fails when a figure is missing, a documented variable is gone, or (with `--release`) a chapter is marked "to confirm". Screenshots are taken by `shots/take_screenshots.js` from a demo project. The AI chapters rewrite the Vietnamese AI guide in English.
- **One list of keyboard shortcuts** (`ui/src/components/shortcuts/shortcuts.json`) read by the Keyboard Shortcuts window, the shortcut sheet in the guide and a test that keeps the menu accelerators in line with it.

### Changed
- **Developer tools** are View › Toggle Developer Tools (Ctrl/⌘+Shift+I), active only while the app is in front. The system-wide shortcut is gone.
- Find in Board is Ctrl/⌘+Shift+F, not Ctrl/⌘+F: that key already finds text in a Docs page.

### Notes
- The privacy chapter is marked "to confirm" and is left out of release builds of the guide until what each AI feature puts in a prompt is checked against the code. The guide states 12 MCP tools (the code's count), not the 11 of the design.
- The menu was tested as data per platform; it has not been run in a packaged app on macOS or Windows yet.

## [3.14.1] - 2026-10-30

Hotfix for Board AI, Docs AI and AI comments on Windows, and a switch for the "Changed in vN" markers in Docs.

### Fixed
- **Board AI chat, Docs AI (Ask, Ask on a selection), AI comments on a ticket and ticket runs failed on Windows** with "The command line is too long" (exit 1), `[WinError 206] The filename or extension is too long`, or "Exit code 0." with no answer. The CLI got the prompt and the system prompt as command-line arguments: a long ticket or chat went over cmd.exe's 8191 and Windows' 32767 characters, and cmd.exe (the `claude.cmd` shim) cut a multi-line prompt at its first line break. Past a size limit, and always behind a `.cmd` or `.bat` shim, the prompt now goes to the CLI by stdin and the system prompt by `--system-prompt-file` / `--append-system-prompt-file` (a temporary file, removed when the CLI ends). Short commands elsewhere are unchanged.
- **Docs: the green "Changed in vN" and "Proposed by" bars sat on the bullets of list items**; they are now drawn left of the bullets.

### Added
- **Docs: a switch for the change markers.** An eye button in the "Changes since you last viewed" banner hides or shows the green bars and "Changed in vN" labels in the page (a slashed eye means hidden). The choice is kept in the browser for every page; the banner and "Show changes" stay.

### Changed
- **README**: a release badge and a `releases/latest` download link replace the fixed `v1.4.5` link and the out-of-date platform status, so the README no longer needs an edit for each release. The release instructions drop their README step.

## [3.14.0] - 2026-10-30

The new Idea Space, the Sketch tool and AI where you work ([#203](https://github.com/iamcaominhtien/kanban-board-mcp/issues/203)). Docs: `docs/specs/idea-space.md`, `docs/specs/sketch-tool.md`, `docs/specs/ai-where-you-work.md`.

### Added
- **Idea Space** at workspace level (also for ideas that belong to no project): a list, a stages view and an impact/strength matrix; **Quick add** (Alt+N); **Inbox triage** with Keep, Park (needs a date), Merge (undo for 10 minutes) and Archive (needs a reason), with Z to undo every move and a local duplicate search that needs no model.
- **Stages** Inbox, Exploring, Ready, Building, Parked, Shipped, Archived. A Parked idea whose date has come returns to the Inbox once.
- **The idea page**: a written page (Docs editor), assumptions as records (impact, status, test ticket, "AI" mark), evidence (link, file, ticket, note, sketch, diagram) that can support several assumptions, "I want this" votes, comments, a research log (note, research, interview, experiment, finding, decision; pin; "Use as evidence"), a workspace folder per idea (`IDEA-n`, kept while open and 30 days after, or forever, or as you choose) and an activity trail with authors and before/after.
- **Promote**: a preview of the ticket, evidence carried over, the workspace folder moved, copied or left; the ticket gets a small lightbulb, a "Started as an idea" block and a "From an idea" filter. Ticket Done moves the idea to Shipped; "Won't do" returns it to Exploring; a deleted ticket returns it to Ready. A test ticket for an assumption asks "validated or disproved?" when it is Done.
- **Sketch tool**: a paint-style drawing editor that works offline with no new dependency (pencil, brush, eraser, fill, picker, line/arrow, shapes, text, crop, layers, 100+ undo steps, pen pressure and touch). Insert from `/draw` or the Sketch button in Docs, ticket descriptions, comments and ideas; **Draw on it** on any picture in the file viewer; drafts are kept in the browser; saved as a PNG plus an editable source in the uploads folder (4096 px, 10 layers, 10 MB) with a save conflict card. `![Name](sketch:sk_…)` in markdown; `GET/POST/PUT /api/sketches`.
- **AI where you work**: a chat docked in the ticket page about that ticket (Ask only or Do the work, Post as comment, criteria drafts, cost before sending); the `@` list says what each AI can do and what the mention means is stated under the box; AI in every editor (`/ai`, Ctrl+J, a selection bar with Improve, Shorten, Fix spelling, Explain, Ask…, a draft over the text with the changes marked, "What will be sent", Activity "edited with AI by …"); one switch per project; viewers can read but only members can ask.
- **AI helpers in the Idea Space** (on by default and switchable per project, using the project's Board AI member with a daily cap of their own): triage advice with a reason and confidence, **Shape with AI** (suggests assumptions and a first page, a person adds them), an **Ask** panel, a draft ticket on promote, a file-name based effort guess, and a weekly digest.
- **MCP**: five idea tools for AI members (read ideas, assumptions and the activity; add to the Inbox). AI members cannot move, edit, merge, archive or promote an idea. They are hidden unless `KANBAN_MCP_IDEA_TOOLS=1`.
- **AI help in the Sketch tool**: an **AI** panel in the sketch editor (and an **Ask AI** button on an embedded sketch that opens it) with ONE conversation per person and sketch, built on the scoped chat like the idea chat: it is kept 30 days (private to you), found again when the editor or the embed is opened again, and the model gets the earlier turns plus the **current picture of the drawing with every message** and the text of the ticket, page or idea the sketch is in (fenced as data). Ask in words ("what is missing?", "draw a retry button next to the error"); quick-start chips replace the old Ask / Ideas / Draw tabs. When you ask for a drawing the answer carries a **proposal** (line, arrow, rectangle, ellipse, text, freehand path) that appears as a preview and is put on a **new layer named "AI"** as one undoable step when you press Accept (Discard and Try again are next to it; the thread keeps every proposal marked Accepted or Discarded; the AI never writes pixels and never touches your layers); ideas in an answer can be added as text labels. **Paste a picture, drop one or attach files**: pictures (PNG, JPEG, WebP, GIF, 4 per message, 5 MB each, scaled down when large) go to the model as pictures and can be put on the drawing on a new layer; text files (txt, md, csv, json, log, source code, 200 KB) go as fenced data; anything else (PDF, office files, archives) is refused with a plain message. Attachments are kept privately with the chat and removed when it expires. A sketch that is not saved yet keeps its chat under a key in its local draft and the chat moves to the real id on first save (a copy starts a new chat). "What will be sent" (now with the attachments and the text of the place) and the cost are shown first; the same AI members, project switch, kill switch, per-member and board caps and audit log as the other AI helpers (usage booked as `sketch_chat` / `sketch_draw`, or `idea_sketch_*` for a sketch in an idea, which the Idea Space cap counts); viewers cannot ask, and everything works with AI off. The model also reads pictures in Anthropic, OpenAI-compatible and Claude Code members (several per request). Server: `GET /ai/sketch/state`, `POST /ai/sketch/preview`, `POST /ai/scopes/sketch/{id}/chat` (the shared scope routes), `POST /ai/sketch/chats/{id}/messages` (multipart), `GET /ai/sketch/chats/{id}/files/...`, `POST /ai/sketch/drafts/{id}/accept` and `.../idea`; a new "Sketch AI" switch in Settings → AI.
- **MCP: sketches as files** (the Claude Code CLI path, like diagrams): `docs_read(sketches)` lists a project's sketches, `docs_read(sketch)` writes a sketch's PNG and its editable `.sketch.json` to local paths, `docs_write(sketch_save)` stores a new version from local files with the `version` you read as `base_version` (a stale one is rejected) and `docs_write(sketch_create)` makes a new sketch for a ticket or Docs page. Same tools, new actions; an AI member needs the "edit docs" permission and may only touch sketches of its own project. Limits to respect: 4096 px, 10 layers, 10 MB per file.

### Changed
- **One-time conversion of existing ideas** on first start: draft → Exploring (Inbox if never edited), in review → Exploring, approved → Ready (Building or Shipped when promoted and the ticket is open or Done; Exploring when the ticket was set to Won't do; the link is cleared when the ticket no longer exists), dropped → Archived ("Imported from the old Idea Space"), a revisit date → Parked until that date. Assumptions keep their text and become records with medium impact ("invalidated" is now "disproved"); the problem statement and description become the page body; microthoughts become comments; ICE and energy are kept as notes in Details. Nothing is deleted: the old columns stay in place. Before converting, a copy of the database is saved next to it as `kanban.before-idea-space-<date>.db` (only when there are ideas).
- The old Idea board, card and modal are replaced by the Idea Space screens. The `/api/idea-tickets` CRUD still answers.
- One-shot AI calls (chat, drafts) now also count toward the board's daily cap; an AI name can no longer approve a request.
- The Docs "Export" writes a sketch as a plain image of its PNG.

## [3.13.0] - 2026-10-30

Docs AI (issue 209, following `design/screens/docs-ai.md` and `docs-ai-care.md`), conversations that keep their memory, and one MCP tool for the AI team.

### Added
- **Docs AI**, on by default, and an admin can turn it off per project (Settings › Docs › AI): who answers (an AI member, else the Board AI), what AI may read (all / except hidden / only picked), a style guide page, freshness checks, how AI members' edits are handled (made directly, a proposal, or a draft) and how long a proposal waits. When it is off nothing in Docs shows AI.
- **Hide from AI** and **Use as AI guidance** per page (page info; a lock and a small mark in the tree). One check (`services/docs_ai/access.py`) decides what any AI may read: Ask, summaries, checks, the Board AI chat, AI runs and the MCP `docs_read` of an AI run all skip a hidden page. Guidance pages (limit 8k tokens by default) are added to every AI run in the project and listed as "Read" on the run.
- **Ask the docs**: an Ask tab in the Docs search palette (This space / This page / All my projects). It answers from published pages the asker can see, cites the section (each citation is checked against the page), says "the docs do not say" with the closest pages, or shows both pages when they disagree. A question that matches nothing is answered without calling the model. Open as chat, Copy, Was this right?, Report as out of date. Keywords work for English and Vietnamese questions.
- **The page AI menu** (Ask this page, Summarise, Check if up to date, Create tickets, Suggest links, Translate view, Edit with AI): a summary is a dashed block above the page and is never saved; selecting text offers Explain / Summarise / Ask; Translate view keeps code, links and ticket keys byte for byte and leaves the page unchanged. In the editor `/ai` has a Docs-only group and **Check this page** (unclear text, gaps, unknown links, style guide), with Fix as draft and Ignore.
- **Write with AI**: a page from a ticket, an idea, notes or a prompt, written only from the sources you pick (a "what will be sent" list first; code changes off by default). It opens as your private draft marked "Drafted with AI" with visible `[Needs input: …]` markers, a Gaps list and numbered sources; Publish warns while markers remain. Import Markdown can tidy while importing (split by heading, heading levels, "see X" candidates shown for review). History gets an AI summary of a range and a "with AI" mark; Publish suggests a change note.
- **AI members edit pages directly by default** (still within each member's own permissions; the version shows "with AI"). Choose "Proposal to review" or "Draft only" in Settings › Docs › AI to hold their edits instead: a proposal has a banner, per-change Accept / Reject / Edit, "made against vN", expiry, a purple dot in the tree, a row in Approvals with **Review on page**, and the blocks it would change are marked "Proposed by …" in the page (click to review). Accepting writes into the reviewer's draft; an AI cannot decide its own proposal; a page an AI member creates stays an unpublished draft. Freshness checks and **Suggest an edit** always make proposals. A page hidden from AI is never edited by an AI member.
- **Draw a diagram** (`/ai`): the AI member draws the selected text or the page as an editable draw.io diagram and adds it to your draft, or, with a diagram selected, changes it as a new version. The XML is checked before anything is saved.
- **One Claude Code session for each (page, AI member)**: Ask this page, a tag in a thread, Suggest an edit, summaries, Check this page and the chat about the page all continue the same conversation, so the AI remembers what was said and done on that page. Everyone shares it and the prompt names who is asking. The board's own background freshness checks and questions about the whole space are one-shot.
- **@AI in Docs comment threads**: tag an AI member (Ask / Ask and suggest an edit / Just notify). It answers inside the thread with its sources and cost; a second tag in the same thread continues the same conversation (the thread is the memory; a long thread is summarised; Claude Code continues the member's session for that page). **Suggest an edit** turns a reply into a proposal; long threads get a summary. It never resolves a thread and never answers another AI's reply.
- **Keeping docs true**: a daily and on-demand check compares a page with the tickets and pages it links to (every reason names what was compared and quotes the page), a banner for editors, Still correct (30 days), suggested edits one at a time. **Docs health** lists out of date pages, Done tickets no page mentions, broken links and overlaps.
- **Create tickets from a page**: unchecked items and action items become reviewed drafts (suggested assignee, never set); nothing exists before the button; links the tickets to the page, adds the key to your draft, Undo (kept for 30 minutes, also after a restart).
- **MCP `ai_team`** (the 12th tool, one tool and no more): list AI members with status and spend, usage, ask or give work (a ticket, or a Docs page or thread), runs and one run's steps, cancel / retry / answer, pause / resume, create and update AI members (no key, folder, Bypass permissions or ceiling above Review over MCP), pending approvals (read only), recent Docs AI jobs. Refused inside an AI run except for reads; approvals are decided in the board.

### Changed
- **The Board AI chat keeps its memory with an API key too**: older messages are summarised into the chat (shown as "Earlier messages summarised"), the question is sent once, failed or stopped turns are not sent again. "Ask this page" and ticket asks continue your latest chat on that page or ticket instead of opening a new one; "+" starts a new one, and switching scope adds a divider.
- **API-key AI members remember their work**: the "Activity since your last run" block (their own runs and other members') is in their prompt, the work done before a question is kept when they are answered, and a long run is compacted (step "Long session compacted") like a Claude Code session. A resumed run no longer restarts its token and cost counters at 0.
- The Board AI chat never reads a page hidden from AI, even when a person includes a private doc for the chat, and an AI member's `docs_write` on a hidden page is refused. A page the Board AI chat lists as private is still read by Docs AI, AI runs and MCP.

### Fixed
- Purging a page leaves no Docs AI rows behind.
- **@AI in the first comment of a page**: the @ list offered no AI members on a page that had no comment thread yet (Docs AI looked off there), so a thread could not be started with @AI.
- **Docs lines of the Monday digest** are shown in Board health ("Docs that may be out of date", one line per page); they were stored but never rendered.
- **Tables in "Proposed by …" marks**: a waiting proposal that changes a table row now marks the whole table in the page (it was left unmarked).
- **Import tidy** starts as drawn: split by top-level section, ticket-key chips and heading levels are ticked; "see X" links stay off until you tick them.
- **"Changes since you last viewed"** now sits in the bottom right corner instead of covering the page's Edit and Share buttons, and the history and comments drawers open over it.

Demo: `docs/demo/docs-ai-demo.pdf`: screenshots of the running app with real Claude Code (Haiku) answers.

---

## [3.12.0] - 2026-10-29

One viewer for every image and file (issue 191, following `design/screens/preview-viewer.md` and `preview-types.md`).

### Added
- **One viewer** (`ui/src/components/preview/`) that opens any image or file from the description, comments, Docs pages, attachments and the ticket workspace. Anything that shows a file only says "open this" together with the files around it, so next / previous (arrow keys, buttons, swipe) and the thumbnail strip always make sense there. Header with name, type, size, counter and actions, a details panel (I) with facts and "Used in", full screen (F), Download (D), focus kept inside and returned to what opened it, Esc always closes.
- **Images**: fit, zoom to the pointer (wheel, pinch, + / −), drag to pan, rotate, copy, double-click for Fit / actual size, a map when zoomed in, and a checkerboard / light / dark background for transparent images. SVG is shown as a picture, never as page code.
- **Readers**: text, logs and code (colour, line numbers, search with Ctrl+F, wrap, copy; only the rows in view are drawn, so a long log opens at once; the first 1 MB with a note for larger files); JSON (formatted, tree, raw); Markdown (rendered like Docs, or source); CSV, TSV and Excel (sheets, search, frozen header, first 500 rows, values only); PDF (page thumbnails, zoom, page jump, search); zip, tar and gz (browse folders, preview a file inside; entry and size caps); Word (simplified reading view) and PowerPoint (slide outline with speaker notes), read in the browser without a converter; audio and video; a card with the file facts and Download for everything else.
- **HTML** opens as the real page in a locked frame: empty `sandbox` (no scripts, forms, pop-ups or same-origin access), a CSP that blocks every outside request, scripts, embedded content, event handlers and link targets removed first, notices for blocked content and scripts, Desktop / Tablet / Phone width, and a Source view. The server still serves HTML as plain text.
- **States** that always leave Download as a way out: loading, too large (first part shown), password protected, damaged, missing or no access, a text name with binary data, offline with Retry (files already opened in the session stay available), and a broken file inside a gallery.
- Docs images are clickable (Enter and Space on a focused image too); in the editor, double-click an image or a link to an uploaded file, or press Space on a selected image.
- Attachment cards show a real thumbnail for images.
- Desktop: **Show in folder** next to Open in app; files that can run (`.exe .bat .cmd .ps1 .sh .command .app .msi .jar`) ask first ("Open anyway"). On the web the actions are Download and open and Copy link, and Open in app is shown greyed out with "Only in the desktop app".

### Fixed
- **Open in app on desktop**: the app found a file's place on disk through the `X-File-Path` header of a `HEAD` request, but the server answered `HEAD` with 405 and the CORS layer hid the header from the desktop page (`file://`), so nothing opened. The app now asks `GET /upload-info/<file>`, which returns the path as JSON.
- Serving an upload crashed (500) when the uploads folder has non-latin-1 characters, e.g. a Windows user folder such as `C:\Users\Tiến`, because the path went into a response header. The header is now sent only when it can carry the path.

### Changed
- Replaces `FilePreviewModal`, the workspace `PreviewPanel` and the markdown renderer's own image modal.
- The server sends `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox` with every SVG, so an SVG opened on its own cannot run or load anything.

### Not in this version
- 7z and rar listing, slide pictures for PowerPoint (needs a converter), and Word fonts, page layout, comments and tracked changes.
- Editing a file in another app and saving it back, "Open with…", and a dedicated phone layout (the same viewer works full screen with swipe and pinch).

---

## [3.11.0] - 2026-10-29

### Changed
- **AI keeps one conversation per ticket.** An AI member (Claude Code) resumes its own last session on a ticket instead of starting fresh at every @mention, assignment or re-run; a different AI, or a different ticket, has its own. Each run also gets an "Activity since your last run" block with what the other AI members did on the ticket (who, result, files, status), so a PM asked "what has Dev done?" can answer. If the old session is gone or the CLI cannot resume it, a new one starts with a note on the run. Two runs of the same AI on the same ticket never run at the same time.
- **Run limits only guard automatic runs.** "Max runs per day" is now **Scheduled runs per day** and counts runs a schedule starts; the board's "runs per day" (default 100, was 60) and "runs per ticket a day" (default 15, was 6) count scheduled and AI-started (@mention chain) runs. A run a person starts (@mention, assignment, Run, reply, question) is never limited by them. Settings still at the old defaults move to the new ones.
- **Board AI chat is one session per chat** for a local Claude Code Board AI, so earlier messages are not sent again.
- The number between the +/− buttons of the add-member dialog can be typed; Shift+click moves in bigger steps.

Demo: `docs/demo/ai-sessions-demo.pdf` (14 pages, real Claude Code runs): a PM and a Dev on one ticket, the Dev resuming its session, the run limits not stopping a person, the Ask AI chat session, a real compaction trace and Bypass permissions (the same `touch` refused with it off and run with it on).

Demo: `docs/demo/ai-member-assistant-demo.pdf` (10 pages, real Claude Code runs): the dialog's Ask AI panel and presets, the Board AI asks what it needs, proposes a PM, a Dev and a Reviewer in Vietnamese, revises the whole list on request, and creates them on one click with Undo and an audit trail; plus the stand-in AI when no Board AI is chosen.

### Added
- **The Board AI can set up AI members for you.** Describe the team you want in Ask AI (Ctrl/Cmd + J, from anywhere) or press **✦ Draft with AI** on Members → AI. The Board AI asks what it needs, then shows a card with the proposed members (name, description, persona in your language, role template, ceiling, limits); edit any field or keep chatting to refine it (each answer returns the whole updated list). Nothing exists until an admin or the owner presses **Create**; members are then created as that person through the same code as the Add AI member dialog, audited as created via Board AI, with Undo. A proposal can never carry a key, Bypass permissions, a ceiling past Review or a folder, and an API-key Board AI cannot create members (keys are not copied). Without a chosen Board AI, Ask AI is answered by a stand-in AI member of the project (not saved as the Board AI).
- **Ask AI to fill this in, inside the Add AI member dialog.** Step 3 (Identity & limits) has a new panel above the Start from presets (PM, Dev, Reviewer, Blank): describe the member, the Board AI fills the name, description, persona, limits, ceiling, role template and (Claude Code) model, and you keep prompting to refine it. Every message carries the form as it is now, so hand edits survive. It only fills fields; nothing is created until you press Add AI member, and the same checks apply (ceiling clamped to Review, no key, folder or Bypass taken from the AI). Shown when the project has a Board AI or a stand-in AI member.
- **Ready-made AI members in the Add AI member dialog.** Step 3 has a **Start from** row with **PM**, **Dev** and **Reviewer** (or **Blank**). A role fills in the name, short description, persona (English or Tiếng Việt), parallel runs, scheduled runs per day, status ceiling, the approval switches, the role template (Reviewer uses the Reviewer template) and, for PM and Reviewer, CLI Allow rules without `Edit` and `Write`. Everything stays editable. The roles live in `ui/src/components/ai/memberPresets.json`, which the guideline also reads.
- **Bypass permissions** for Claude Code AI members: Configuration → Permissions → Permission mode. Allow list only stays the default; Bypass lets a work run use any CLI tool without the Allow list (`--permission-mode bypassPermissions`). Only the project owner can turn it on, by typing `bypass permissions`; turning it on or off is audited and the member shows a red chip. Deny rules, the status ceiling, approvals and Safe mode still apply, ask runs stay read-only and the web stays off. New members always start on Allow list only.
- **Auto-compact**: "Auto-compact at" (default 60% of the context window, 10 to 95) per AI member, also used for the Board AI chat, passed to Claude Code as `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`. A compaction shows as a step on the run.
- **AI guideline** (`docs/guideline/ai/huong-dan-dung-ai.pdf`, Vietnamese, 33 pages, also covers sessions, run limits, Auto-compact and Bypass permissions): the AI team to set up (PM, Dev, Reviewer, General as the Board AI) and how they hand work to each other; every field of the Add AI member dialog with the values for each AI; what to do after creating (Role template on the Permissions tab, CLI rules, what an existing `CLAUDE.md` / `.claude/` in the working folder affects, one AI in several projects); the rest of the setup (Board AI, Board assistant, allowed test commands, limits); and copy-paste prompts (persona, instructions, @mentions, style guide, a weekly PM report schedule) for each AI. Also: how to write prompts and tickets, assigning and reviewing work, schedules, safety and cost, 13 common problems and a one-page checklist. The source (`build.py`, screenshots) lives next to the PDF and `docs/guideline/README.md` says how to rebuild it.

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
