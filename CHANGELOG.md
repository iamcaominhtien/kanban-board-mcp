# Changelog

All notable changes to this project will be documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/). Versioning follows [Semantic Versioning](https://semver.org/).

---

## [Unreleased]

## [3.37.1] - 2026-11-03

### Changed
- **The server starts faster: about 1.4 s sooner to answer, the MCP stdio server about 0.2 s.** Measured from launch to the first answer, against 3.37.0: the HTTP server went from 4.5 s to 3.1 s and the stdio server from 1.7 s to 1.5 s. Each API route is now built once instead of twice; pydantic builds a model's schema the first time it is used rather than at startup; and a SQLite database that is already up to date no longer loads the migration tool at each start. The API itself is unchanged, except that the Docs AI endpoints now list their `docs-ai` tag once in the OpenAPI spec instead of twice.

## [3.37.0] - 2026-11-03

Choose your database: SQLite (still the default), PostgreSQL or MySQL/MariaDB, and move between them (design: `design/screens/ai-databases.md`, #307). Guide: `docs/guideline/databases.md`.

### Added
- **A Database card in App settings › Storage & backup.** It says what the board uses (engine, where, size, tables, tickets, and for a server its version, latency and whether the connection is encrypted), with **Move to another database…**, and on a server **Edit connection…**, **Test connection** and **Use the SQLite file again**. `KANBAN_DATABASE_URL` sets the database for a server and locks the card; `KANBAN_DB_PASSWORD` gives its password.
- **Move to another database**, in four steps: **Where to** (the test reaches the server, signs in, checks the version, the encoding or character set, the right to create tables and an encrypted connection, and says how to fix each problem, with the statement to copy), **Check** (what will be copied, and values the target cannot take as they are, before anything is written), **Copy** (table by table, with progress, pause, resume and cancel; the source is only read, from one consistent snapshot) and **Verify** (row counts, a random sample read back value by value, the links between rows, the counters, docs search). **Switch** points the board at the new database without a restart; if the board was used during the copy, the latest state is copied first. Any direction works.
- **An AI helps when a copy stops.** The wizard shows where (table, row, column, the column's type on both sides, the value's length) and **Ask the AI** sends exactly that, never the rows or a password, to an AI member of the board. It proposes a change to the new database; only `ALTER TABLE` on the board's tables can be applied, and the board runs it, resumes and verifies. **Edit it myself** and **Ask something else** are there too.
- **`kanban-db`** (`uv run python -m dbkit.cli`): `test`, `migrate --from … --to … [--dry-run] [--verify] [--resume] [--empty-first]` and `use`, with the same copy code and exit codes 0 done, 1 verify failed, 2 cannot connect, 3 target not empty, 4 stopped.
- **The board cannot reach its database**: a screen instead of errors, which tries again every 8 seconds, with Edit connection and Use the old SQLite file instead. The app starts in that state rather than failing when the server is down at startup.
- CI: a **Databases** job runs the move tests (with a round trip SQLite → PostgreSQL → MariaDB → SQLite compared row by row) and the ticket, project, idea, docs and MCP suites on PostgreSQL 16 and MariaDB 10.11.

### Changed
- **Faster lookups on every engine**: indexes on `member.project_id` (filtered by more than 90 queries), `ticket (project_id, status)`, `ticket.parent_id`, `ticket.assignee` and `docs_page.parent_id`; each of these lookups scanned the whole table before (migration `e8b0d2f4a6c9`).
- **SQLite shares the file better between the board and the MCP process editors launch**: a writer now waits up to 30 seconds for the other one instead of failing with "database is locked" after 5, commits skip an fsync (`synchronous=NORMAL`, safe with WAL), and temporary data stays in memory.
- **Export on PostgreSQL or MySQL** is the same ZIP with a SQLite copy of every table, so one export loads into any engine and into older versions of the app; **import** on a server database replaces its data and puts the previous data back if anything fails.
- The stdio MCP server runs in one event loop and follows a database switch made in the board or with `kanban-db use`.
- **Shorter holds of the write lock** (one writer at a time on SQLite), found by timing every write transaction of the AI, workflow, notification, docs and ticket suites:
  - a notification reads what each recipient's row depends on in three queries for all recipients instead of three per recipient, while it holds the lock: 84 to 20 ms median with the event loop busy (5 recipients);
  - checking whether a queued run waits on its account no longer writes a row on every scheduler tick;
  - a new canvas, a canvas copy (every frame's files and the overview picture) and a new sketch write their files before the row is inserted, not while the lock is held;
  - the hourly retention sweep commits every 50 runs instead of once for all of a project's old runs.
- Lists that came back in SQLite's insertion order by chance now ask for it (members, tickets, a Story's pieces, standing orders, plugins, worktrees, workflows, an idea's advice), and so do the "first" choices (the default ticket creator, the project's first admin, the AI that takes a workflow step), so the order is the same on every engine.

### Notes for PostgreSQL and MySQL
- Links between tables are kept by the app and not enforced by the server, exactly as on SQLite, where `PRAGMA foreign_keys` was never on (the app writes some rows before the row they point at, and keeps rows whose parent went to the bin).
- On MySQL/MariaDB long text is `LONGTEXT`; key and indexed text columns are `VARCHAR(255)`. Tables are `utf8mb4` with the binary collation, so text compares exactly as on the other engines.
- Docs, knowledge-base and history search use SQLite's FTS5 index; on a server they use the plain search the board already had as a fallback.
- Attachments, AI run logs and skills stay in the data folder on this computer.
## [3.36.1] - 2026-11-03

### Fixed
- **Deleting a project failed with "no such table: docs_ai_ignore" on some databases.** A pre-release build had run the Docs AI migration without that table, and a migration never runs twice. A new migration creates the table when it is missing (and leaves it alone when it is there), so the project deletes, and a page's ignored "Check this page" findings can be saved again.

## [3.36.0] - 2026-11-03

Fast mode for the AI team: a quick result of about the same quality, on the tickets you choose.

### Added
- **⚡ Fast, per ticket, and turning it on runs nothing.** The ticket header has a ⚡ Fast switch, with or without a workflow and before any AI is on the ticket; it only sets the ticket's pace. It applies when an AI starts on the ticket, whichever way: a workflow step, an @mention in a comment, an assignment, a schedule, an AI tagging another. Ticking Fast when you put a ticket on a workflow, or the workflow's **Pace** row, sets the same thing.
- **On a workflow**, fast mode:
  - skips the steps a quick result can do without: Triage, the BA's Shape, QA's Test and the User tester's Try (a template's step may say `"fast": "skip"` or `"keep"`; a workflow is never left without an AI step to do the work). The strip shows them as "skipped · fast"; a step blocked for want of a member (no BA on the team, say) is skipped too;
  - runs every AI step one effort level lower (medium → low) and the review one depth lower (standard → light, on Haiku), unless a person set the depth;
  - tells each step to go straight to the simplest thing that meets the criteria, and the reviewer to send work back only for what breaks a criterion or the build. A failing test run first is not asked for; a passing run of the project's checks is.
  - Switching the pace never starts a step by itself: a step it leaves waiting (the one before was skipped) gets a **Start** button.
- **Tagging an AI in a comment.** On a fast ticket the run it starts is fast (one effort level lower, told to answer or work straight to the point, and to say what it did not check). On any ticket, **⚡ Fast** in the comment box makes that one answer or piece of work fast and leaves the ticket's pace alone; on a fast ticket the box says "Fast · ticket" instead. The Ask button and a reply to an AI's comment take it too.
- What keeps the quality: the **Checks** by code and the **Review** always run, and a step sent back, a retry or an explicit higher effort run at their full effort and model (a Dev's second attempt is still Opus at high).
- API: `GET`/`PUT /tickets/{id}/ai/pace`, `POST /tickets/{id}/ai/workflow/start`, `pace` on `POST /tickets/{id}/ai/workflow` (and `PATCH .../workflow/pace`), `ai_fast` on a comment, `fast` on `POST /tickets/{id}/ai/ask`; the workflow view has `pace` and `review_runs_at`. Over MCP: `ai_team(set_pace)` (works without a workflow, runs nothing) and `pace` on `start_workflow` and `ask`; the team guide says when. The Board AI can turn it on or off (`pace`, with an Undo).

### Changed
- Tool list: about 190 characters more (`pace` on `ai_team`).

### Checked
- Live, real Claude Code runs on the board (`docs/demo/fast-mode/record_demo.js`, screenshots in `docs/screenshots/fast-mode/`): the same ticket twice on "Standard feature" (discount codes at checkout, four criteria), at the same time, each in its own worktree. Normal: Triage (Haiku), Shape, Build and Test (Sonnet), Review deep (Opus at high, as Triage chose), ready for the person after 4m 23s, 2.59M tokens. Fast: Build (Sonnet at low) and Review light (Haiku at low), ready after 0m 55s, 0.46M tokens. Both passed review first time, and both passed 6 of 6 acceptance tests written beforehand and never shown to the AIs.
- A fast quick fix, live: Triage skipped, Fix, Checks and Review ran, ready in about 45 s; the Dev said in its note that fast mode let it skip the red run.
- Live, comments (`docs/demo/fast-mode/record_comments_demo.js`, screenshots `c*.png`): turning Fast on in the header started no run; @Dev An on the fast ticket ran at low effort, was told so, and said what it had not checked; Fast ticked on one comment of a normal ticket ran at low effort and left the ticket normal. Then "Do the work" from a comment on the fast and the normal ticket, each in its own worktree: both changes passed 3 of 3 hidden acceptance tests, in two recordings. On work this small one run is within noise: the question took 11–20 s at either pace, the change 29 s and 31 s fast against 43 s and 27 s normal. What fast mode reliably saves is the steps a workflow skips (above); on a single run it is one effort level and a shorter brief.

## [3.35.1] - 2026-11-03

### Fixed
- **A ticket another one still blocks can no longer be moved to Done.** The ticket guide told AIs not to, but the board let anyone do it (dragging the card, the status menu, the API, MCP). Done is now refused while a blocker is open (not Done or Won't do), with the blocker named: "Cannot move to Done: it is blocked by LIVE-5 (todo); finish that first, or remove the block if it no longer holds." Found in the live runs of #269.
- **The ticket panel no longer says "Moved to Done" before the board agrees.** Choosing Done in the status menu showed the success toast at once, even when the board then refused (open criteria or test cases, and now an open blocker); it now says so only once saved, and otherwise shows "Couldn't move to Done" with the reason and keeps the status as it was.

## [3.35.0] - 2026-11-03

Talk to the AI team from the screen and over MCP, and hand work between an AI, a person and an outside agent with nothing lost (#272).

### Added
- **A handoff note at every step.** Each workflow step ends with a short note of fixed form on the ticket: **Done** (what was done), **Where** (the branch, files, pages), **Left** (what is left, and why) and **Check** (what the next role should check first). The AI gives it with `ai_run(action='report', handoff={...})` or a `HANDOFF` block at the end of its message; without one, the board writes what it knows (the summary, the files changed) and says the rest was not said. The next step's task opens with it ("Read this first"), the comments show it as a card, and the workflow strip shows each step's Done and Left instead of the run's whole text. `ai_run(handoff)` between AIs takes the same note.
- **Take a ticket back and give it back.** Take over stops the run, pauses the workflow at its step, gives the ticket to the person and leaves a note of what the AI did so far (with the person's reason). **Give back to AI** takes a note in the same four fields; the workflow goes on from that step, or, without a workflow, the AI that had it takes it again, and either way it reads the note first. `POST /tickets/{id}/ai/take-over` (now with `text`), `POST /tickets/{id}/ai/hand-over`.
- **Who has it.** The ticket shows one line under the assignee: which AI is working on it and at which step, the person who took it back, or whom it waits on (an answer, a person's step, a stopped workflow), with Take over or Give back beside it. `GET /tickets/{id}/ai/holder`; `get_ticket` returns it as `held_by`.
- **Over MCP**: `ai_team(hand_over)` makes an outside agent's work the team's input in one call (links its branch and Docs pages to the ticket, posts its note, and starts a workflow, resumes one, tells the running AI, or gives it to an AI member); `ai_team(take_back)`; `ai_team(tell, run_id, text)` sends a message to an AI while it works, as the Live commentary's reply box does.
- The MCP team guide (`ai_team(guide)`) has the note's form, handing over and back, `tell`, and a session step by step: give a goal, follow it with `board_wait`, answer a question, approve the plan. The same form is in the board's `evidence-and-handover` skill (`docs_read(guides)` for other agents); a test checks the three are the same text.

### Changed
- `add_branch` can record a branch that already exists in the repository (`adopt`), so an outside agent's branch is linked as it is.
- Tool list: about 480 characters more (the note's four fields on `ai_run`, the three `ai_team` actions, `held_by`).

### Checked
- A scripted session as an outside agent, over MCP only: gives a goal (`give_story`), follows it with `board_wait`, answers the PM's question and approves the plan; the Story runs to done (fake CLI).
- A three-step workflow (BA → Dev → QA) leaves a note at each step, and each next step's prompt opens with the one before (fake CLI, and a live run on sonnet: the Dev followed the BA's Check, the QA ran the command the Dev gave in Where, 6 of 6 cases passed with proof, 6 of 6 criteria ticked).
- Live, take over then give back: the Dev's task opened with the person's note, it noticed one line of the note was wrong (the language of WTH-1) and asked instead of following it. An outside agent on the board's MCP server alone gave a ticket back with `ai_team(hand_over)` and followed it with `board_wait` and `held_by`.
- Fixed before release, found in those live runs: a ticket given back counted as a second attempt, so its Dev was moved up to Opus; the take-back note said "user" for the person and copied refused tool calls; the workflow strip showed a ticket taken back as "It stopped going round" with a red Failed step.

## [3.34.3] - 2026-11-03

From the live AI runs of #269 (scenarios QA → PM and an outside agent on its own).

### Fixed
- **An AI no longer writes a cause it has not checked into a ticket.** An outside Claude Code, with only the board's MCP, opened a bug ticket saying "`cli.py` calls `int(...)`" right after reading `cli.py` had failed (the file does not exist), and fixed it only in a later work log; the description stayed wrong. "Never claim without checking" covered only where a file, branch or page is. It now covers a cause or a result too (name a file, function or line as the cause only once you have read it, a result only once you have run it; otherwise "not checked"), and says to correct a wrong statement where it was written (the description, a criterion), not only in a later note. It is in every run's prompt, the MCP instructions, the ticket guide, and `manage_ticket`'s `description`.

### Changed
- **The ticket guide says where the change is before Review**: the branch and commit, or "not committed, in <folder>" when the agent was asked not to commit. In the same live run the agent handed the ticket to Review with its change uncommitted, and a second agent in another checkout, finding nothing, concluded the work had not been done.
- The live runs (QA → PM, an outside agent on its own) are written up in `docs/ui-audit/269/ai-and-workspace.md`, section 6.

## [3.34.2] - 2026-11-03

Also found by the #274 live check: neither Dev ran the repository's own tests, and their work stayed on `main`, so both tickets went to Review with nothing run.

### Fixed
- **A run is told the project's own checks by name** (Settings › AI › Commands): "This project's own checks, allowed in every run: tests `./test.sh`…". They were already allowed, but the prompt only said "the project's test command", so a live Dev ran `python3 -m unittest` (refused) and never `./test.sh`.
- **`python -m unittest` and `python3 -m unittest` are allowed** wherever pytest is (a Dev's, QA's and Reviewer's tests, and the default allow list).
- **A run that commits, without a worktree, can reach the ticket's branch**: `git switch` and `git checkout -b` are allowed (`git switch -f`, `--force` and `--discard-changes` are not), and the prompt says how. A live Dev's `git checkout <branch>` was refused and its work stayed uncommitted on `main`. Plain `git checkout` stays refused: it also throws away changes. The prompt says to make the branch from the base, not from another ticket's branch (a live Dev branched SHOP-2 off SHOP-1, where the checkout stood).
- **An outside agent proposes a lesson without asking first**: `knowledge(action='memory')` now says, where the agent decides, that a project lesson is only a proposal a person keeps or drops. Live: sonnet proposed two lessons on its own (it asked before, three times out of three), and so did haiku in the last round.
- Checked live (sonnet): Dev An ran `./test.sh`, met its watch mode, ran `./test.sh --once`, kept that in its notes and committed on its branch; Dev Binh, given the note on another ticket, ran `./test.sh --once` the first time.

## [3.34.1] - 2026-11-03

Found by the live check of #274 (real Claude Code runs, sonnet): two Devs kept no memory at all, though the rule was in their prompt and the `keeping-memory` skill was there. Dev An wrote in Vietnamese as a person asked in a comment, and had `python3 -m unittest` and `git checkout` refused, and kept none of it; Dev Binh, the next Dev, wrote in English and ran the same refused commands.

### Fixed
- **A run hands over what it learned in its report**: `ai_run(action='report', learned=[{text, scope, kind}])`, kept as notes for the next run of its role (or on its ticket), with a person's request as feedback. Every run already calls report; the prompt asks for `learned` there (`[]` if nothing). API-key members' report takes it too.
- **The board keeps what a run did not**: once a work run ends, a light model reads the run, what people wrote on the ticket and the notes the role already keeps, and adds at most 3 notes for the role (a command that works or is refused here, where something is, a person's request), marked "the board, from Dev An's run". In the live check it kept An's request for Vietnamese, which the run itself had not, and the next Dev, on a ticket with no comment from An, wrote in Vietnamese. Claude Code members on a subscription; off with "Let the AIs keep their own notes".
- An outside agent was asking before it proposed a lesson: `knowledge` now says a project lesson is only a proposal.
- `docs/demo/ai-memory-274/live_check.py`: the live check, to run again; three rounds in `docs/ui-audit/274/memory.md`.

## [3.34.0] - 2026-11-03

The AI team keeps its own memory, without being asked, and a person can see it, trust it and correct it (#274). Why it felt absent, and the screens 1:1 with the design: `docs/ui-audit/274/memory.md`.

### Added
- **Memory a run writes itself**: `knowledge(action='remember')` keeps a note in the run's role memory (every member of the role reads it at the start of a run; a member without a role keeps its own), on its ticket (every later run on that ticket reads it, so what one run learned reaches the next), or proposes a project lesson for a person to keep. A person's correction is kept as feedback and read first. Notes are live at once, deduplicated and capped (30 per role, 15 per ticket); a full memory refuses a write and names the notes to replace. `forget` removes one; a person edits or deletes any of them.
- **`keeping-memory`, a skill for every role**: what is worth keeping (a command that must be run a certain way, where something is, a trap, a person's correction), where it goes, how to write it, what never to keep. In the board's plugin and in `docs_read(guides)`; one line of it in every run's prompt and in the MCP instructions.
- **AI Team › Memory**, with a count of what waits for you (lessons proposed, memory that may be out of date); Project knowledge opens on Memory while anything waits, with "N waiting for you".
- **What a run used**: each run records the lessons and notes its prompt carried; Run history › What it was given › Project memory says "Used 2 lessons and 2 notes, 90 tokens" and which. Saving a note is a step of the run.
- **Over MCP**, for an agent outside the board: `knowledge(action='memory')` reads the instructions, lessons and notes; `remember` proposes a lesson or leaves a ticket note.
- **Stale memory is flagged** for a person: a lesson or note naming a file none of the project's checkouts has, or one a newer lesson or note says something close to (a possible contradiction when one of them negates).
- Settings › AI › Project knowledge › "Let the AIs keep their own notes" (on by default).

### Fixed
- **API-key members never got the project's instructions or lessons** in their prompt.
- A lesson proposed by a diagnosis waited unseen: it now notifies the project's owners and admins, as an end-of-ticket proposal does.
- When kept lessons outgrow the cap, the newest of equally used ones stays in the prompt (the oldest did).

## [3.33.1] - 2026-11-03

Found by the live check of #268 (real Claude Code runs, sonnet and haiku): a BA writes a spec on a Docs page, the Dev on the ticket reads it and builds from it.

### Fixed
- **An AI member wrote its Docs page at the top of the tree.** A BA (sonnet) asked to "write the spec as a Docs page" wrote a good page, but never opened the `docs-pages` skill: a run's prompt named its role's skill and the shared ones, not the Docs guide, so the page did not go under Requirements as the guide says. Every run is now told to open `docs-pages` (outside Claude Code: `docs_read(action='docs_guide')`) before it creates or changes a page, unless a project switched the skill off, and the BA's skill says where a spec page goes. Run again: the BA opened the guide, searched and listed the tree, read the existing spec and put the new page under Requirements.
## [3.33.0] - 2026-11-03

The ticket design rows #269 had left open: the ones in shared parts of the screen, and the ones that needed data from the server.

### Added
- **"Review requested — Name" on a Review card** (Main Board), with the member's avatar. A ticket says whose review it waits for: "Review by" in its sidebar (shown in Review, or once set), `review_requested_from` over the API and `manage_ticket(update)` over MCP. When a ticket enters Review with nobody asked, the board asks the AI its workflow (or odd job) names as reviewer; a person's choice is never replaced. Activity reads "Review by Nobody → Reviewer Rin".
- **Files under a test case's Expected result and Notes**, with Attach file under each, as Test data already had.
- **A test case says who**: "Started 4m ago by Ha My", "Failed 3h ago by Ha My", from whoever started it or set its result.
- **Doc references in Activity from everywhere on a ticket**: a `[[page]]` added or removed in a comment (also when it is edited, deleted or restored) or a test case, and a page linked or unlinked by hand in Linked docs, each say where ("in a comment", "in test case TC-1", "in Linked docs"). The description already had them.

### Changed
- **The ticket header is 71 px as drawn**: the AI buttons are 30 px like the view buttons (they were 32 and 34).
- **Doc pills and the doc side panel as designed**: a section pill reads "API › #Endpoints"; the hover card's breadcrumb is the page's path ("Architecture › API"); the panel header is path › page › # section; opening it from a ticket slides the ticket left so the panel no longer covers its right column (not in full screen).
- **Dropdown chevrons are 9 px** (`MenuSelect`), as drawn. Every dropdown that uses it changes.
- **The compact Markdown editor** (New Ticket's description, test case fields) has the drawn look at rest: a `#C7D2CB` border with no ring and a "MARKDOWN" label in its toolbar; the green ring shows while typing. The ticket's own description editor is unchanged.

### Fixed
- New Ticket opened with the focus in the description in the dev app (React StrictMode ran the editor's focus twice); it opens in the title.

### Database
- Migration `d8a0c2e4f6b8` adds the nullable `ticket.review_requested_from`; existing tickets are unchanged.

## [3.32.0] - 2026-11-03

Docs for every AI, and Docs in a window of its own (#268): an AI, on the board or outside it, works in Docs as a person does, and a person can move Docs out of the board into its own window and dock it back.

### Added
- **Docs in its own window.** "Open in its own window" (beside the page tree) moves the Docs space of the project into a separate window: only Docs, under a thin bar with the project's name and **Dock back** (Ctrl+Shift+D). The board's Docs tab says where Docs went, with "Show the window" and "Dock back here", and its tab carries a small window mark. A page opened from a ticket or a link while Docs is out opens in that window; a ticket opened from the window opens on the board. Docking back (from either window) closes the window and opens Docs in the board on the page it was showing; with no board left to go back to, the window becomes the board itself. In the desktop app the window is a real app window (the only second window the app opens; it may change the board like the main one); in a browser it is a pop-up.
- **Edit a part of a page, not the page**: `docs_write(action='edit')` changes one section (by its heading) or one passage (`find`, exact and unique) and publishes it as a new version; several edits in one call (`items`) are one version, all or nothing. From an older `base_version` a section edit goes on only if that section still reads the same (a change elsewhere does not stop it); otherwise it is refused with the section as it is now. `docs_read(get, section=...)` reads one part of a long page. API-key AI members get the same as `edit_doc`.
- **Upload a file over MCP**: `docs_write(action='upload')` stores a picture or any file the board keeps (by path, with the same rules as 3.31.0's ticket attachments, or base64 for an agent whose files are on another machine) and puts it on a page (at the end, in a section or after a passage) and/or posts it on a ticket. Key and secret files are refused.
- **The Docs guide**, one text in two places: the `docs-pages` skill of the board's plugin for Claude Code runs and `docs_read(action='docs_guide')` for other agents: a page or a ticket comment, how pages are organised, read before you write, how to edit a part safely, **the Markdown the editor keeps** (headings, bold, `==highlight==`, code, links, `[[Page#Section]]`, ticket keys, lists, task lists, tables, code blocks, `> [!INFO]` / `[!WARNING]` / `[!SUCCESS]` callouts, pictures with a width, files, diagrams, math; `@Name` only in comments), pictures and files, comments on a passage, pages and tickets both ways. The MCP instructions point to it.
- **Pages and tickets see each other**: `get_ticket` lists the ticket's pages under `docs` (and why each is tied), and a board AI run's prompt lists them with their ids, so the Dev on a ticket reads the BA's spec. The Docs AI reads the tickets a page links (status, description, open criteria) when it answers a thread on the page or a question about it.
- **Work from a page**: `docs_write(action='tickets')` turns the open tasks of a page (or of a passage) into tickets, links them and puts each key on its line; `docs_write(action='assign')` and the page menu's **Give to an AI member…** give a page to an AI member to write or review, as a ticket linked to the page and assigned to it, whose run starts. **The page shows the AI at work on it**: who, running for how long, what it is doing now, and the ticket (`docs_read(get).work` for agents).
- **Highlight** in the editor and the reading view, stored as `==text==`.

### Changed
- The 1:1 check of the nine Docs designs against the app: the tables are in `docs/ui-audit/docs-268/`, with before and after screenshots in `docs/screenshots/docs-268/`.

## [3.31.0] - 2026-11-03

Tickets look like their designs, and every AI uses every part of a ticket: criteria, sub-tickets, blocks, work log, test cases, attachments, Docs links and branches; files a person should see go to the ticket's Workspace and never into the branch (#269).

### Added
- **A ticket guide for every AI**: what a good title, description and acceptance criteria are, when to use a sub-task, a sub-ticket, a Story, a block or a link, how to keep the work log, a comment a person reads in ten seconds, test cases and attachments as evidence, where each kind of file goes (code in the worktree, committed; reports, screenshots, logs and exports in the Workspace), never saying a file is somewhere without looking, and what each of the twelve roles leaves on a ticket. It is the `working-with-tickets` skill of the board's plugin and `docs_read(action='ticket_guide')` for any other agent: one text, a test checks both are the same. Each run's prompt says what its own role leaves on a ticket.
- **Attachments over MCP**: `ticket_items(item='attachment', path=…, text=…)` posts a file in a comment, so it shows in the ticket's Attachments, and returns `attached.markdown` to reuse in a test case's proof or the description. An agent outside a board run names the file by its absolute path; a picture or document named that way in a comment, work log, proof or Docs page is attached too (keys, `.env` and anything under a dot folder never are).
- `manage_ticket(create)` takes `acceptance_criteria`: they are written with the ticket, so the AI team's intake never takes a new ticket before it has any.
- **What blocks a worktree's clean-up, and what to do about it**: the ticket's AI view lists the files not committed (outputs marked) with **Move N outputs to the Workspace**, **Commit the code** and **Discard…** (asks first).
- **Move a Workspace to another ticket** of the same project (Move to ticket… in the panel, `POST /tickets/{id}/workspace/move`), recorded in both tickets' activity.

### Changed
- Every work run of a ticket is told where files go: code in the worktree, committed; outputs a person should see in the ticket's Workspace, whose path it gets (the folder is made when the run starts, when Workspace is on). Claude Code runs may write there (`--add-dir`); a file there can be named in a proof or comment like one in the worktree. The QA and user-tester skills and workflow steps keep their screenshots and reports there.
- **When a run ends, the outputs it left in the worktree** (untracked screenshots, logs, reports, exports) move to `Workspace/from-worktree/<date-time>/`, and the work log says what moved and where. A run waiting for an answer keeps its files.
- `get_ticket` says what is really there: `workspace` {path, exists, file_count, files, note} read from disk, `workspace_path` only when the folder exists, and `worktree` {path, branch, state, uncommitted, outputs, note}.
- A rule in every run's prompt and in the MCP instructions: never claim without checking. Before saying a file, branch or page exists or where it is, look, and name the exact place.
- The work-log `role` field says which role a QA (Tester) or a reviewer (Other) takes.
- **Every run may run the project's own test, lint and build commands** (Settings › AI › Commands), whatever its allow list names. In a live run the Reviewer's list named only pytest and npm, so on a project tested with `python3 -m unittest` it could not run the tests and sent the ticket back twice for the Dev to paste their output.
- **A run with an allow list is told to type commands plainly** (`git diff main...HEAD`, not `git -C <path> …` or `cd <path> && …`): an allow rule matches the start of a command, so a live Reviewer's `git -C` calls were refused and it took the shell for switched off. Checked again with the Reviewer's own settings: no refusal, the tests ran.
- **The QA ticks the criteria its passing cases prove**, and the guide says a "met" in a report ticks nothing on the ticket. A live run ended with 12 test cases passed and not one criterion ticked.
- **Ticket screens 1:1 with their designs**, read from the design source (`design/source/*.dc.html`), one table per design in `docs/ui-audit/269/` (detail: 84 rows, 29 fixed; board: 61 rows):
  - Ticket detail: every button in the ticket panel was drawn in Arial (the Add buttons, tooltips, the Pending and Reopen buttons): they use the app's font. Criteria rows 26 px apart (were 36), no empty band and doubled line above Attachments, the comment box's Attach button has the paperclip, the Pending and Reopened badges are pills, the pending banner's status pill has the status's own colour (it was always blue), the Set Pending dialog's status dots match the status menu, test-case group headers and the time of a pending case as in the design, Linked docs' origin chips in blue.
  - Card: a Done card keeps a dark title and shows no priority bars; a Testing card shows "Test — 2 pass · 1 running · 1 pending"; the design's gaps and priority-bar size; the blocked lock where Main Board draws it; an unassigned card shows the dashed empty circle instead of a grey "?".
  - Drag and drop: the card tilts −1.5° as drawn, the ghost keeps its place without shifting the cards below, and the drop slot takes the dragged card's height.
  - New Ticket, the filter menus and the top bar: sizes, gaps and icons as drawn. List View: a Done row keeps a dark title.
  - Event timeline: an assignee change names the person, and an added or removed item reads "Added test case — …" instead of "none → …".
  - Kept on purpose: comments newest first by default (wave 3 kept it; the toggle gives the design's order), and where the code does more than an older design (Story, AI and schedule chips, the Workspace's file manager).
- The dev server proxies `/upload-info`, so attachment chips show their size there too.

### Fixed
- **A QA's screenshots and logs were committed into the product's branch**: the hand-over at Review and Done ran `git add -A` on the worktree, so whatever a run left there went into the pull request or the merge. Outputs now go to the Workspace first, and stay out of the commit when the Workspace is off.
- **A PM said a QA's files were "in the Workspace" that had never been made**: `get_ticket` gave the Workspace's path whether or not the folder existed, no run was told about the Workspace, and a Claude Code run could not have written there anyway.
- Open folder on a machine without a file manager made the ticket's Workspace folder before failing, leaving an empty folder behind.
- The tests no longer make ticket folders in the home folder (`KANBAN_WORKSPACE_ROOT`).

## [3.30.0] - 2026-11-03

Wave 5 of the design audit's fixes: the findings that needed data from the server (`docs/ui-audit/2026-11-design-audit/fixes/<area>.md`). Nothing changes for an existing project or its data until a person turns the new thing on; Docs AI off by default applies to new projects only.

### Added
- **A sub-ticket's wave can be pinned by hand** in the wave popover (− n +, "Auto-set from Blocked by"). Unpinned waves are computed as before; sub-ticket order and Story orchestration honour a pin (TDP-1).
- **Run history retention** in Settings › AI › Running the team: "Keep run details for" (Keep forever by default). Only the details of finished runs go (transcript, steps, prompt, logs); every run stays in the history with its cost, status, summary and links. Runs of this budget month, active runs and runs another record works from are never trimmed (OPS-7).
- **Max turns and Run timeout** for Claude Code members apply once a person saves them; existing members stay unlimited (PC-5). "Open folder" in the desktop app (PC-7).
- **Idea Space:** Keep can ask an AI member to suggest a problem statement and assumptions (off by default); Stop on Shape with AI; AI advice can say "not sure"; "Accept Merge and Park" with one confirmation; Ask answers offer actions that open a pre-filled dialog (ICT-5, IP-16, IAI-1, IAI-3). The empty Inbox says how many ideas you sorted this week (ICT-9). An opened assumption says who changed it and when (IP-8, IW-4).
- **Docs:** pages have a path link (`?docs=architecture/api`); old links by page id keep working, and old paths keep resolving after a rename or move (AC-4).
- **More data on screen:** CLI versions on account cards (ACC-5), role codes on AI Team cards (AT-4), lane counts while tickets load (AL-1), "Needs you" and "Docs" notification filters (NT-5), a Shared tab in the knowledge base (WV-7).

### Changed
- **Docs AI is off by default for new projects** (AI-1). Existing projects keep their setting.
- The pause notification names a person instead of "user" (NT-1); a new canvas keeps the page title as typed (CA-1); role names in messages read BA, QA, Dev (TP-8).
- The repo scan tells a missing script, file or make target ("wrong command") from a failing suite more often (RC-2).

### Database
- Migrations `b5e7d9f1a3c4` and `c6f8a0b2d4e6` add three nullable columns (`ticket.wave_pin`, `ai_project_settings.run_retention_days`, `ai_run.details_removed_at`); existing rows are unchanged.

## [3.29.0] - 2026-11-03

The Board AI manages the AI team: it advises what each AI could use and sets it up, by itself when the owner allows it.

### Added
- **The Board AI sets up the AI team.** In a project chat it can make an AI member from a role pack (so it gets that role's skill and tools), give an existing member a role, change its instructions, model or effort, bring it to its pack's latest version, install a plugin from the catalogue or a git URL, switch a plugin or one of the board's skills on or off (for the project or one member), add or remove an MCP server, a hook or a skill of a member's own. Each is one change in its answer, with Undo.
- **It knows the team to advise from**: every member with its role, model, plugins, MCP servers, hooks and skills, the role packs, the catalogue and the board's skills are in its context, so "what should our Dev add to test the UI?" gets an answer from what exists.
- **Settings › AI › Board AI › Manages the AI team**: with it on, these changes are made at once and keep an Undo, at any size (setting up a whole team is not a bulk action); off (the default), each asks first. Only the project owner can turn it on, over the screen and over the API, and the switch is audited.
- An MCP server or a hook runs a command on this computer: its change says the command on the card and in the receipt, and the audit log keeps it as a warning.

## [3.28.0] - 2026-11-03

Each AI role works like a good professional in that role, and the roles work together (#273). Measured with live sonnet runs, before and after, on the same small task per role.

### Added
- **A skill per role.** The board's own plugin has one skill for each ready-made role: `role-triage`, `role-pm` (plan a Story, split it by outcome, rule on a disagreement, when to ask a person), `role-ba` (criteria a tester can check, the edges, a spec page on Docs), `role-dev` (reproduce, a test that fails on an assertion, the same command green, small commits, what to log, the note for the reviewer), `role-reviewer` (what to look for and in what order, must-fix or suggestion, one point per comment, the verdict), `role-qa` (QA and QC: test cases from the criteria, every run with its proof, a failure anyone can repeat), `role-user-tester` (one real person, five seconds, the task, a mistake, the screenshots in the comment). The Designer's stays the canvas design guide. Only a member of that role gets its skill, its prompt says to open it first, and a project switches it off like any board skill. Agents outside Claude Code read the same text with `docs_read(action='role_guide', query=<role>)`.
- **The BA picks its document like a developer picks an architecture**, from a table in its skill: criteria only for small clear work, a **bugfix spec** (current, expected, what must not change), a **feature spec** (stories by priority each testable on its own, Given/When/Then, edge cases, numbered requirements, `[NEEDS CLARIFICATION]`, measurable success criteria; required whenever design, build or test work from it), a **decision table**, a **use case**, an **example map**, a **one-pager**, a **data dictionary** and **quality requirements**, plus a checklist before handing in. Researched from BABOK, GitHub Spec Kit, Kiro, EARS, Cockburn, example mapping and Shape Up, and from studies of AI-written requirements (well-formed, but failing quality checks more often and running long). The templates ride beside the `role-ba` skill and are page templates in Docs › New page too.
- **Four more ready-made roles**, each with a persona, a skill, its tools and limits: **Technical writer** (docs for one reader and one task, every step tried, committed on the ticket's branch), **DevOps** (CI and environments: pinned, least privilege, proven by running the commands; deploying or spending is a person's call), **Security reviewer** (follows untrusted input, proves each finding with a local test it does not commit, rates it, `VERDICT:` line; never changes the code) and **Data analyst** (exact definitions, the data looked at first, a script that reruns, the answer with numbers, one chart per finding and the caveats). The repository scan may propose them when a project calls for them.
- **How the roles work together**: a shared skill, `working-together` (who does what, read the handoff first, never redo another role's work, ask the PM rather than guess, what to do when blocked or when you disagree), and a core rule in every run's prompt. A run's list of teammates now names each one's role, so it knows whom to ask.

### Changed
- Role packs are at version 11: every persona points to its role's skill.
- A workflow step no longer says a decision goes to "the coordinator with ai_run(ask)" (that reaches the person): scope and priority go to the PM with an @mention, a person's call to `ai_run(ask)`.
- Settings › AI: the role packs table lists twelve roles; the board's skills show which role a skill is for, and a member's page lists only its own role's skill. The role chips, the template editor and the own-plugins grid know the new roles.

### Fixed
- **A real red-then-green run was marked unproven** when the red run's output was piped or redirected (`pytest -q t.py 2>&1 | tail -16`) and the green one was not: the board now compares the test commands without the pipe and the redirections.

## [3.27.1] - 2026-11-03

The desktop app opens again: 3.27.0 showed "Can't start the local server" on every start.

### Fixed
- **The installed app could not start its server.** The build left out the `slides` skill's folder (its guide, themes, scripts and examples), which the server reads while it starts, so both programs (`kanban-server` and `kanban-mcp-stdio`) exited with `FileNotFoundError: …/services/slides_skill/guide.md`. A checkout never showed it. The folder is now part of the bundle (`desktop/common_spec.py`).

### Added
- A test that every data file under `server/services/` is in the desktop bundle, at the path the code reads it from.
- The Python build (`desktop/scripts/build-python.sh`, run by `build-desktop.sh` and the release workflow) starts the built `kanban-server` and fails unless it reports READY, so a bundle that cannot start is never packaged or released.

## [3.27.0] - 2026-11-02

Canvas, draw.io and Sketch for any AI, on the board or outside it: which one fits, a guide for diagrams, and a way to see what it drew before handing it in (#267).

### Added
- **A draw.io guide for every AI**: which tool fits (a screen or page that is looked at → Canvas; boxes and arrows a team will edit → draw.io; a person's hand drawing → Sketch), which kind of diagram answers which question (flowchart, swimlanes, sequence, state machine, architecture, data model, a plan), layout on a grid of 10 with standard sizes, styles from one palette, labels, groups and lanes, how to change one shape without wrecking a person's layout, and how to look and hand in. It is the `drawio-diagrams` skill of the board's plugin in Claude Code runs and `docs_read(action='diagram_guide')` for any other agent: one text, a test checks both are the same.
- **AIs read Sketches, they do not draw them**, written down as the `sketches` skill (and in `diagram_guide`): a Sketch is worth something because a person drew it while thinking; strokes drawn by code are a fake hand-drawn look nobody can edit by its parts, and a Diagram or a Canvas frame shows the same thing better. An AI reads a person's sketch and turns it into the right drawing; the one Sketch it makes is a screenshot for a person to mark on.
- **`docs_read(action='picture')`: look at what you drew.** A PNG of a diagram, a canvas frame (at any width: 390 for the phone), a sketch, or a local `.drawio`, `.svg`, `.html` or frame folder before it is handed in, drawn by the desktop app's own Chromium (`--export-png`) or a Chrome / Chromium / Edge on the machine; no Playwright needed. Without any browser it says so and gives a wireframe. The answer carries `markdown`, a copy of the picture on the board, to put in a comment, so an outside agent can hand in a comment with a picture too. The page is served from a throwaway 127.0.0.1 server that only serves its own folder, and the hidden browser loads only that and public hosts (fonts, CDNs), never another port of the machine or the private network; an AI run may only look at files in its working folder.
- **Flow, suggested for the PM, BA, Designer and Dev**: the owner's diagram plugin (github.com/iamcaominhtien/flow: flowchart, swimlanes, sequence, ER, architecture, C4, state, BPMN, DFD, screen flow, mind map, Gantt and more, laid out from a short JSON spec and checked) is in the catalogue of plugins, and the draw.io guide says when to lay a diagram out with it and how its `.drawio` reaches the board (`diagram_create`, then the same look and hand-in steps). Tried on ten of its examples: the board reads each one as a model and draws its picture.
- **`docs_read(action='diagram')` reads a diagram as a model**: shapes (id, label, shape, box, style, the group it is in), links (from, to, label) and `problems` (a link to nothing, shapes on top of each other), without writing a file; `path` still writes the `.drawio` to edit.
- The MCP instructions say which drawing to use (with "the sign-up flow and its screens" as both: the flow as a Diagram, the screens on a Canvas) and where the guides are; the PM, BA, Designer and Dev point to the draw.io guide (ready-made packs v10), and the Designer looks at its frames with `docs_read(picture)` instead of starting a web server. Live runs showed a BA and a Dev that were told a diagram "helps" drew none: the BA now hands in a diagram for a flow with branches, and a Dev's page on how parts fit together or what happens in which order carries one.

### Changed
- A diagram whose page the editor stored compressed is written out as plain XML by `docs_read(diagram, path)`, so it can be edited as text. A path without an extension that does not exist yet is a folder (`…/out` was written as a file named `out`).
- `diagram_create` and `diagram_save` say what will look broken in the saved file (`problems`, and how to fix them).
- **The plain preview draws a link the way the editor does**: through the bends it was given (`<Array as="points">`) and, for an orthogonal link, as an elbow between the facing sides. It drew every link as a straight line, so a loop an agent had routed around the outside showed as a diagonal through the shapes, and a live BA run added bends it could not see.
- Canvas comments read over MCP carry the element they are pinned on (`at`, in the form `canvas_comment` takes) and when each was written.
- A Sketch made from a picture alone (an agent's screenshot) has the picture on a locked layer and an empty **Marks** layer above it, chosen: a person's marks never change the picture, as with Draw on it.

### Fixed
- **A diagram's check took decoration for shapes on top of each other**: a step's number chip, a lane's name tab, a lane or pool frame behind its steps, an icon on a disc. Only two shapes of about the same size that partly cover each other are reported now (Flow's files had 5 or 6 false reports each, an AI would have "fixed" them).
- A diagram in a ticket or a comment drew a second bordered box inside its card (the text's picture style); it is one card again, the drawing on white (Diagrams design B).
- A canvas in a ticket description was capped at 560 px, half the description; it is as wide as the text, like a diagram or a sketch (Canvas design G1).
- The large view of a canvas names each board under its picture in the filmstrip, the current one in white (Canvas design H1); the pictures were unnamed.

## [3.26.6] - 2026-11-02

Wave 4, the last of the design audit's fixes: the Low findings, and the rows wave 3 left because they sat in another area's files (`docs/ui-audit/2026-11-design-audit/fixes/<area>.md`). As in wave 3, nothing is removed or takes more clicks, and an independent review against the previous release checked it.

### Changed
- **Board and ticket.**
  - The board's columns can shrink to 176 px, so six columns fit at 1440 px.
  - A ticket on a workflow shows its step strip on the Ticket view.
  - A board card's step chip turns red with "blocked" when its AI step has no member.
  - File cards show their size.
  - File types have the design's tints and labels (CSV, Markdown, HTML, Audio, Video).
  - The list's sort menu, test cases, debug space, workspace and activity got smaller polish.
  - The CSS uses the design's colour tokens, with the same colours.
- **AI screens and AI Team.**
  - Members show avatars, and the role is a menu with the same three choices.
  - The AI paused dialog shows the project, budget and safe-mode details.
  - Account rows were polished.
  - Run history filters are chips, and "Export this page" saves the runs on screen as CSV.
  - Now, Flow, Health, Resources and Timeline were polished.
- **Docs, Idea Space and app.**
  - The page menu says "Delete page".
  - A page hidden from AI offers "Show to AI" to editors and keeps the server's own explanation.
  - In the search palette, an exact ticket key is listed first.
  - Canvas, sketch, the idea list (project name and colour), MCP integrations (tool count chip), notifications and the splash screen were polished.
  - Images with transparency open on the checkerboard.

### Fixed
- **A selection bar could show over a picture.** No AI selection bar can open while a sketch, image or diagram is selected in the editor (ideas IP-14).

## [3.26.5] - 2026-11-02

Wave 3 of the design audit's fixes: the Critical, High and Medium findings screen by screen (`docs/ui-audit/2026-11-design-audit`; what was done for each finding is in `fixes/<area>.md`). No feature is removed and no action takes more clicks than before; where the design would have changed how something works, the look was matched and the behaviour kept.

### Changed
- **Board and ticket.** Pointing at a parent card shows its group: a green ring on it and its sub-tickets and the links between them (a click still opens it). Tags are added from a picker with search, the project's tags and Create. The wave badge of a sub-ticket opens the wave popover (read-only: the wave comes from Blocked by). The workspace's retention is a menu on its chip instead of a band. New Ticket gets the assignee menu with avatars, Tags and Start date. The list view, toasts, branches, debug space and test cases follow the design.
- **Docs.** The breadcrumb has its own row and the page actions sit beside the title. Comment numbers sit right after the highlighted text. The find bar no longer covers the page actions. One bar shows on a selection; the AI actions (Improve, Shorten, Fix spelling, Explain, Ask) are behind its "AI" item. Tables are saved compact. The comment composer has the design's header and toolbar. The draw.io error card says what happened and offers Download .drawio. Canvas opens one side panel at a time.
- **AI screens.** Board AI dock (suggestions, history, scope, the joined AI button), Settings › Board assistant and AI, members, the add-member steps, the configuration cards, the permissions tester, Inbox and Audit log filters, account limits, the team wizard, the workflow editor, tools and the Story lanes follow the design. While all AI is paused the live feed says so, and the paused label shows its details on hover and on keyboard focus.
- **AI Team and Schedules.** The range is the design's button on every tab, with Custom… on the Timeline. The seven-day Timeline is one list with an hourly chart per day. The run inspector offers Open, Pause or Resume, Approve or Deny. Health follows the design's order and banners. The machine meters show again and the Resources chart reaches the limit per run. Schedules get a searchable time zone and the design's dropdowns.
- **Idea Space.** Triage is its own screen (the List, Stages and Matrix tabs stay in its header) with decision cards, the stage pills, the matrix, the idea page header and tabs, Quick idea and the promote preview follow the design.
- **App.** The AI paused banner sits under the top bar and its label beside New Ticket; the person who paused gets no extra toast and nobody sees zero counts. The members panel, desktop windows, the notification panel, quiet-hours fields (24 h) and the file preview toolbar follow the design.
- Dropdowns read their chosen value to screen readers.

### Fixed
- **Opening a page saved it.** Opening an idea or a Docs page and leaving it without typing saved the editor's own rewrite of the text as an edit ("Page text edited"); only a real edit saves now (ideas IP-15).
- **Machine meters on AI Team › Resources** were collapsed to nothing by a CSS rule (RS-1).

## [3.26.4] - 2026-11-02

Wave 2 of the design audit's fixes: the same problem fixed everywhere at once (`docs/ui-audit/2026-11-design-audit/SUMMARY.md`, "What goes wrong most often").

### Fixed
- **Dropdowns look like the design's.** Every dropdown in the app (about 130, from the AI screens to Settings and Idea Space) is drawn with the design's box, corners, text size, chevron and green focus halo instead of the operating system's grey control. They stay real dropdowns: the keyboard, type-ahead and screen readers work as before. Date and time fields get the same box.
- **Line icons instead of characters and emoji.** About 280 glyphs used as icons (✦ ✕ ✓ 🔒 ⚠ ▾ ↻ ✎ 📄 💬 ⚙ ➤ 🛡 …) are the design's line icons, in the Ask AI dock, the AI screens, AI Team, Schedules, the ticket, Docs and Idea Space. Icon-only buttons keep or gain a spoken name. Keyboard hints (⌘ ⇧ ↵), arrows written as words and × as "times" stay as they are.
- **One focus ring.** Text fields no longer get a second ring inside their own focus border; buttons, links, checkboxes and radios keep the keyboard ring (comp-1).
- **Ticket cards fit their content** instead of a 140 px minimum that left an empty band under a one-line title (comp-1 TC-1).
- **Hint lines in the AI screens** (role packs, Set up the AI team) are small grey text instead of body text with a bold word broken onto its own line (ai-3 TP-1).

## [3.26.3] - 2026-11-02

A full design audit, and the first wave of fixes: what was broken or behaved wrongly (`docs/ui-audit/2026-11-design-audit`, 375 findings across 81 artboards; finding ids in brackets).

### Added
- **The design audit.** One report per area (AI, components, board, Idea Space, Docs, app), each finding with the design and the app side by side, the code that draws it and a fix, and a summary with the plan (`docs/ui-audit/2026-11-design-audit/SUMMARY.md`).

### Fixed
- **The Ask AI dock covered the board.** The page now leaves the dock's width free: the board, its header and New Ticket shrink beside it (AB-1). The board header wraps instead of pushing New Ticket and the view tabs out of the window, and the project name stays on one line (AB-2).
- **Popovers inside a ticket opened in the wrong place.** The ticket panel kept a transform after its opening animation, so the `@` and `[[` suggesters (and other menus) opened off by the panel's offset, often off-screen (CM-3).
- **The comment action bar (Edit, Delete, Copy link) never showed** on hover (CM-2).
- **Esc in a ticket.** Esc saved the tag being typed, did not cancel a new criterion and did not close the ticket: three closed dialogs kept listening for Esc. Esc now cancels the field and keeps the ticket open; a comma adds a tag (TG-3, AC-1).
- **New branch from `main` in a repository whose default is `master`** failed with "Branch 'main' does not exist"; a new branch starts from the repository's default branch (BR-2).
- **Centred and right-aligned text showed `::: center`** once saved; it now renders aligned (DM-1).
- **"Read the repository" in Set up the AI team called an AI** although it says no quota is spent; it reads files only (RC-7). A command run where there is no `package.json` is "command is wrong", not "the repo's own lint fails" (RC-2).
- **Switching projects showed the previous project's cards** under the new name; it shows the loading skeleton (LD-1).
- **Timeline:** resizing a bar opened the ticket (TV-2); the event list showed raw values such as `todo → done` and `None → None` (TV-4).
- **Charts:** the usage axis read "1, 1, 0" and the RAM axis skipped 0.2 GB (SC-7, RS-2).
- **AI Team:** Flow › Timeline showed two Copy link buttons and two range pickers (TL-1, AT-2); Health said "Only 0 runs" instead of "No AI work between …" with Widen to 30 days (RV-1).
- **Docs:** Ctrl+K in the editor opened the search over the link field (ED-3); at 1100 px the breadcrumb vanished and the page menu was cut off (DP-2).

### Security
- **An uploaded HTML file ran with the app's origin** in its preview and could read the app's storage or call its API as the viewer. It now runs in a sandboxed frame of its own origin; its scripts, forms and pop-ups still work (PT-1).

## [3.26.2] - 2026-11-02

### Fixed
- **A Bypass permissions run's first step no longer says "(web off)" when it may use the web.** The note was fixed text, so a run on a project with web search on showed "web off" and then made about twenty WebSearch calls. It is now read from the deny rules the CLI is given ("web search on, web fetch on", or "off" or "limited" where a rule stops it), and opencode's says what its config does with web fetch.

## [3.26.1] - 2026-11-02

### Fixed
- **The board server did not start on Windows** since 3.25.0: the slides skill's themes and guide were read in the machine's default encoding (cp1252 on Windows), which cannot decode their Vietnamese, while the shared skills were being built at start-up. Every file of the skill is now read and written as UTF-8, and a test checks it.
- **A copied template slide could open as a broken file in PowerPoint**: a chart's relationships were renumbered one by one, so its data could point at its style part, and its style and colours stayed shared with the original; a picture background kept the original's relationship id. Charts now get their own data, style and colours, renumbered in one pass, and backgrounds are renumbered too.
- `html_to_pptx.py`: a video or poster in a folder with a space (or on a Windows drive) was not found; three-digit colours (`#fff`) and empty chart labels crashed; previews moved across drives failed.
- `pptx_template.py`: a theme's system colours (`windowText`) showed instead of their hex and crashed when used; an empty table cell or label, a row longer than the first, a number as text, or a picture already in a placeholder crashed; the inventory now prints Vietnamese on a Windows console.
- `render.py`: page files from a deck of 10 or more slides could not be renamed on Windows and sorted wrongly past 99; a file name with `[` or a path with a quote broke Quick Look and PowerShell.
- The board's plugin folder kept files an earlier version shipped and this one does not; they are removed when the folder is written.

## [3.26.0] - 2026-11-02

The rest of the schedules design (`AiSchedules.dc.html`, `Notifications.dc.html`) and a safety fix found while testing them (#271).

### Added
- **“Run started by schedule” is a line in the notification centre**, with Open run (it was only a toast). It is its own kind, `schedule_started` (“A scheduled run started”, for information, grouped as “N scheduled runs started”), so it can be switched off in Settings › Notifications on its own; the Schedules family on the notifications page lists it with the finished and skipped ones.
- **Whoever follows a ticket (the bell) hears of its schedule events**, as the design says (“Comments, runs and schedule events of this ticket”), not only the schedule's creator and the people it names.
- **Run menu › Queue for next free slot**: the run waits behind what the AI is doing and starts when it is free (`POST /tickets/{id}/ai/run` takes `queue: true`). It sits between Schedule a run… and View schedules, as designed.
- **Edit budget** in a schedule's warning when its AI is over its budget: it opens AI Team › Usage for that AI.

### Fixed
- **A CLI path you set is never replaced by another program.** When the path was refused (outside your home folder or the usual install folders) or could not run, the board looked for a `claude` on PATH and used that one: a test member with a stand-in CLI spent real Claude quota. Now there is no CLI, the AI shows “runner missing”, and the reason names the path and what is wrong with it (“not executable”, “outside the folders the board allows”), and says to fix or clear it. With no path set, PATH is searched as before.
- An AI that answered `auth status` with something that is not a JSON object made the connection test fail with a server error; it is now taken as “not signed in”.

## [3.25.0] - 2026-11-02

### Added
- **Decks a person is proud to present: the `slides` skill** (#277, asked for by the owner after a first office-files run made a deck that "looked like a report pasted on slides"). The story first (titles that state the point, one idea per slide, a cover and an ask), then one of three ways: a new deck designed in HTML and turned into a PowerPoint file whose text stays editable (`html_to_pptx.py`: text boxes in the same font and place, pictures and CSS art behind them, native charts, videos, speaker notes, an Office-font copy for people without the web fonts); a deck in the person's own template (`pptx_template.py`: inventory the layouts, theme and sample slides, copy and fill them, add a chart or table the template has no slot for, compare each slide with its source); or a change to an existing deck. Pictures are found on the web with their source and licence, or drawn (SVG, HTML, diagrams, open icon sets); motion is drawn in HTML frame by frame and joined into an MP4. `render.py` renders any office file to pictures with the first way the machine has (LibreOffice, PowerPoint/Word/Excel from a script, Quick Look) and says which. Twelve themes ship with it, each with its own art direction, a Vietnamese sample deck and an Office font pair (Ledger, Pitch, Capital, Pop, Keynote, Folio, Lesson, Paper, Sunny, Blueprint, Clinic, Công văn), and an example deck made for its product (Giọt's monthly report). Two live runs (sonnet) made a marketing proposal and a revenue report in a company template; what they got wrong (a growth in dong compared with growth in dollars, a template's cover picture of another subject) is now in the skill.
- **office-files looks at a file on any machine**: LibreOffice, then Office driven from a script, Quick Look, an approximation from code said to be one, and for a deck with no app, asking whether to install LibreOffice.
- **Shared skills for every AI role** (#277, agreed with the owner from what live runs got wrong: a report that claimed what nobody did, a server left running so the run never ended, a hand-in without screenshots, a choice made without asking, English labels on a Vietnamese canvas). The board's plugin gains four skills: `working-a-ticket` (read the project first, plan, stay in your role, review your own work, report only what is true), `evidence-and-handover` (proof a person can see, a handoff note, a closing comment), `repo-and-machine` (git, stop what you started, ports, write only in your folder) and `asking-and-writing` (when to ask and how, when to decide and say so, the project's language everywhere), and three the owner asked for in the brainstorm: `brainstorming` (work out with a person what to build, in rounds, approaches with their trade-offs, the agreed list written down), `end-user-eyes` (the first-time, five-second and one-real-task tests, the user's words, the machine-made look) and `office-files` (Excel with real formulas, Word with real styles, decks with a point and a look, each rendered to images with LibreOffice and looked at before it is handed in; written here, since Anthropic's document skills may not be copied). Their most important rules are in every work run's prompt; agents outside Claude Code read the same text through `docs_read(guides)`, which the MCP instructions now point to. Every persona (packs v9) and the workflow's step text point to the skills instead of repeating them.
- **The board's own skills can be switched off**, for the project on the Installed tab or for one member on its page (`ops.board_skills`); a run gets a folder with only the skills on for it.

### Changed
- **The Designer designs with more taste.** The canvas design guide now asks for a composition with intent and a ground with depth where the tone calls for it, colours in `oklch()` with accents that share chroma and lightness, balanced titles, card grids that fold to one column on a phone, and a last check: would someone remember it? It names the habits to avoid (cream, serif and terracotta every time; Inter as the display face). In every state the main action stays on the first phone screen, and no short label breaks over two lines. The Designer loads the board's guide by its full name, even when it is assigned a ticket outside a workflow, and treats other design skills as ideas. It keeps a "Design system" Docs page when the project has none, looks at its frames through a local server (the browser does not open `file://`), and hands in a ticket comment with screenshots of the key screens.
- **The Designer presents a design document, at the level of the board's own design.** The guide now teaches how a canvas is presented, not only how a frame looks: pages in order (Foundations, Components, then one page per area of screens), each board a spec board with an eyebrow, a title, one sentence on what it is for and lettered sections, the states of one thing side by side in one row under a label (never a frame per state), and a short caption beside each decision. Foundations come first and at full depth, every value named by its use (`Card title / 15 / 600 / lh 1.35`, `16 side gutter`, "Dot colour only. The name always sits beside it."). It says when to be restrained (an app people use every day: calm neutrals, one colour that carries meaning, density, hierarchy from type, no decoration) and when bold fits (a landing page, a poster). The handoff adds a spec per screen on Docs. The skill carries two exemplar boards trimmed from the board's own design canvas (a foundations board and a feature board with states side by side), as pictures and markup, and the guide makes them the bar: their structure and craft, never their brand. `docs_read(design_guide)` gives their folder to an agent outside Claude Code. The Designer pack (v5) and the Design step ask for all of this.
- **The Designer stops looking machine-made.** The skill carries `craft.md`: why a screen reads as made by an AI (white rounded cards on a tinted ground, icons in pale circles, tinted alert boxes, pills everywhere, one blue, a row of equal buttons), what a designer does instead, and how type, colour, composition and a signature only this product has give it a face. The guide drops "restraint for product UI", which produced a sterile dashboard, for "calm is not characterless"; tokens no longer prescribe 8/12/16 radii, tinted state boxes and hairline cards; the exemplars are the bar for how a design is presented, not a look to copy. For a new product the Designer draws the main screen three ways on a Directions page and keeps the strongest, and after building it fixes the three most template-like things on each main screen. `docs_read(design_guide)` also gives `craft`.
- **taste-skill** (`Leonxlnx/taste-skill`, MIT: art direction against the generic AI look) and **impeccable** (`pbakaus/impeccable`, Apache-2.0) are in the catalogue for a person to add; impeccable is suggested to no role because its hooks run a downloaded helper on every edit.
- **Niche frontend skills in the catalogue**, each checked for a license, no hooks and nothing fetched at run time (a subset where a repository also has skills that need an API key, a browser download or an MCP engine): make-interfaces-feel-better, Emil Kowalski's design engineering (animation craft and reviews, native feel on a phone), GSAP, motion-design (LottieFiles), UI foundations (dembrandt: type scales, palettes, states, density, WCAG), Web quality (accessibility, performance), tufte-data-viz, three.js (three.js, React Three Fiber, WebGPU), WebGL animation (particles, GLSL backgrounds, hero scenes), Shader art and Generative art.
- The guide adds a Wireframes page (the main element drawn as a grey silhouette at its true size, with its motion as arrows and timings, not a hatched box) and motion and SVG made for the product (shown running and as key frames with timing), and writes the canvas in the product's language.
- **A Claude Code run is told its skills.** The prompt lists each skill installed for the member by the exact name the Skill tool takes, with the work it covers (from the catalogue's new `use`). A live Designer run had twelve plugins loaded and opened none of them, then debugged a three.js shader error the `threejs-shaders` skill covers. The step no longer calls them "ideas".
- **The Designer keeps only skills that teach a craft or check work.** A run made to plan and open every skill (eleven) took its palette, type scale and surfaces from their rule sets and came out one flat hue, no better than a run that opened none, at a higher cost; every earlier run had opened only the board's guide. The Designer pack (v8) now installs `design` (critique, accessibility review, handoff), Emil Kowalski's animation skills, `motion-design` and `tufte-data-viz`. taste-skill, the dembrandt UI foundations, ui-ux-pro-max, make-interfaces-feel-better and frontend-design stay in the catalogue for a person to add. The guide, the skills block and the Design step say a skill never sets the look: it is opened for motion, 3D or a chart, or to check boards already drawn.
- Catalogue entries install only the skills that add something: eight of dembrandt's (surfaces, hierarchy, type scale, palette, theme, component family, states and errors, phone vs desktop), only `ui-ux-pro-max` from its plugin (its `ui-styling` teaches shadcn and Tailwind, the template look, and its `design` calls outside logo APIs), three of Anthropic's design skills (critique, accessibility review, handoff), and no second `threejs-animation`.
- `canvas_create` places frames on page tabs: `"page"` in a frame's `frame.json` (frames with the same page share a tab; a new canvas's first tab takes the first name, an existing tab of that name is reused), and `"page"` on the labels and notes of `canvas.json`.
- The Designer pack (v4) no longer installs Anthropic's `canvas-design` skill (poster art as a PNG, whose name hid the board's own guide) or Figma (it signs in through a browser, which a run cannot do); both stay in the catalogue. Playwright is suggested for the Designer.

### Fixed
- **A run whose AI left a server running in the background never ended.** The Designer starts `python3 -m http.server &` to look at its frames; after its final answer the CLI waited for that server for good, so the run stayed "running", its cost was never counted and the member could take no other work. A CLI that has answered and does not exit within 30 seconds is now stopped and the run finishes normally, and whatever a CLI leaves running in its process group is stopped when it exits.
- **The first run of a member made from a pack started without the pack's plugins.** They install in the background when the member is made, and the run listed its plugin folders before they landed, so a new Designer never had its design skills. A run now waits for the project's installs still running (up to three minutes).
- A plugin from a repository with no manifest (a bare `skills/` folder) is named after the repository (`make-interfaces-feel-better`, `emilkowalski-skills`); it was named after the board's staging folder, so a second one was refused as already installed.
- A repository that is a single skill (one `SKILL.md` at its root) installs under the name in its `SKILL.md`; it was named after the folder it was cloned into, so two such skills clashed.
- A plugin whose repository links one of its own files from another folder installs, with the file copied in place of the link (`ui-ux-pro-max`, the Designer's palettes and font pairings, never installed before). A link out of the repository, or a folder link into its own parents, is still refused.

## [3.24.0] - 2026-11-02

AI schedules checked end to end against their design (#271).

### Added
- **The Board AI manages schedules**, as the design says (it could not see them before). It reads them (they are in its context with their ids, and `ai_schedules` `list` / `get` / `preview` work for a Board AI answer), makes, changes, pauses, resumes and runs one with an Undo (`schedule_create`, `schedule_edit`, `schedule_pause`, `schedule_resume`, `schedule_run`), and asks first before deleting one (`schedule_delete`, locked in the ask-first tier). The board checks every change as it checks the editor's (permission, budget, the reviewer is another AI, a test command is entered) and the Board AI is told why when it refuses. Four schedules at once are a bulk action. Undo takes a new schedule away (or pauses it when it already ran), restores the changed fields, and flips a pause or resume; a run that started is stopped. An AI run of a ticket still cannot use `ai_schedules`.
- **Start from a template** in New schedule: Nightly test run (every night at 02:00, runs your tests), Weekly dependency check (Monday 09:00, lists outdated or vulnerable packages, upgrades nothing) and Daily summary (weekdays 18:00, what moved on the board). One click fills the days, the time, the checks, the limits and the words for the AI; the ticket, the AI and the time zone stay as you chose. The test command of the nightly run is left for you: the board cannot know it.
- **MCP `ai_schedules(action='preview')`**: the same fields as `create`, nothing saved; returns the plain-language summary, the next 5 runs and every error or warning, so an agent can fix a schedule before it creates it.
- The schedule block on a ticket shows under the ticket's header in both views (it was only in the AI activity view, where nobody looked); one-offs that already ran stay out of it while something else is planned. A board card's chip carries the AI's avatar, as designed, and its text is cut with an ellipsis instead of clipped.

- From the design's HTML: a busy AI says where the run will queue (“Claude Code · Backend has no free slot. KAN-142 is running. This run queues at position #1… Max wait 30 min”); a local runner that missed its last slots shows “Runner often offline at 02:00” under the next run; a slot waiting for its AI offers **Use backup AI**; a skipped run in the notification centre offers **Reschedule**; and “Tests pass” on an AI without a Dev, QA or Reviewer role warns that its CLI may refuse to run the tests (the board runs them after it finishes).

### Fixed
- **The Schedules tab's column titles were not over their columns** (and the week's day names did not line up): the table header used the class name `sc-head`, which the Ask AI chat also uses. Schedules classes `sc-head`, `sc-chip` and `sc-tile` are now `sc-thead`, `sc-pill` and `sc-stat`.
- A schedule waiting for its AI (paused, over budget, runner away) showed a red "That time has passed" in its detail. A one-off whose time has come is being run; the message is for the editor only.
- A one-off a few seconds ahead said "That time has passed. Next free time: tomorrow". It now says it is less than a minute away.
- The time boxes (At, window end) followed the browser's language (`02:00 AM` in English, a 24 h schedule everywhere else). They are 24 h, typed as `0230`, `2:30` or `02:30`.
- Selects in Schedules (filters, time zone, limits) use the design's chevron instead of each system's arrow.
- A review that could not run copied the CLI's whole error into the notification; it is cut to one line.
- MCP `ai_schedules` ignored a field it did not know (`timezone` for `tz`) and created the schedule with the default; it now names the unknown field and lists the ones that exist. `notify` is in the field list.
## [3.23.2] - 2026-11-02

Settings drawn the way the design draws it (#283, design `design/screens/settings-structure.md`, `settings-pages.md`).

### Fixed
- **The Settings page did not follow its design.** The top bar now has a bordered *Back to board*, the *Settings* title and a search box with its icon and the `/` key; the list of pages has its tinted background, an icon for each page, *App settings · all projects* and a project picker drawn as a drop-down (colour dot, name, key), with a dot beside Updates when an update is ready.
- Every page has its title with a scope chip (*Project · Kanban Board* or *App*) and its sections as cards: a title, one line on what it does, and *Saved* or the error beside the title. A column *On this page* on the right lists the sections, follows the scroll and jumps to one; in a narrow window it becomes a row of pills above the sections (it replaces the row of buttons at the top of Settings › AI).
- Search results show the page icon, where the setting lives and the typed word marked, with the result count and the ↑ ↓ Enter Esc hints; *No results* offers words to try.
- Appearance picks the look with two cards (colour strips, the one in use marked) instead of a *Switch to B&W* button with an emoji. Storage & backup, Repositories, Docs, Integrations (MCP, Full control, Diagrams), Updates, Diagnostics, Board assistant and Idea Space use the same cards, switches, fields and pill options. A switch replaces the checkboxes in Docs AI and Idea Space.
- Repositories saves each setting by itself like every other section (the *Save repo* and *Save worktree settings* buttons are gone; *Apply* appears when a path is edited, *Unlink* stays). The project picker works with the keyboard (arrows, Home, End, Esc).

## [3.23.1] - 2026-11-02

Set up the AI team: the AI sets up the project's commands, and the board proves them (#282, design `design/screens/ai-repo-commands.md`).

### Added
- **The AI sets up the commands.** Step 3 of Set up the AI team (now *Commands*) lets Claude Code read the repository in a temporary copy (Read, Glob and Grep only) and propose the prepare, test, lint and build commands, each with where it came from and a note. You watch its steps and a live log, and can cancel; it stops by itself after 10 minutes and keeps going if the window closes (the wizard picks it up again). *Type them myself* stays one click away, and is the way when Claude Code is missing or not signed in.
- **The board proves every command.** Each one runs once in a scratch worktree the way a ticket runs it, and gets its own row: works, *command is wrong* (the shell could not run it), *the repo's own tests fail* (the command is right), or not run and why. Run one row or all again, or *Ask the AI to fix* with a sentence.
- **An environment per project.** Extra folders in front of the PATH (Homebrew, nvm…) for everything the project runs: the wizard's trial, a ticket's prepare, the workflow checks, a schedule's test check and the AI members' own runs. The AI's step finds a program the app's PATH lacks (`npm` in `/opt/homebrew/bin`) and adds its folder. Editable in the wizard and in Settings › AI.
- **A command saved but not a check yet.** A test, lint or build command that fails in the repository itself can stay saved without being a check, so it does not send every ticket back to Dev. The wizard suggests it, Confirm says what a failing check would cost, and Settings › AI has *Use as a check* per command.

### Fixed
- **`npm: command not found` (exit 127) when the app was opened from the Dock**, in the wizard's trial and on tickets: commands ran with the app's short PATH, which has no Homebrew or nvm.
- The trial stopped at the first failure and then said *Test: not tried (no command)*; every command now has its own result and a reason when it did not run.
- A tooling folder (`.github/skills/…/scripts`, `.claude/…`) no longer lands in the suggested prepare command.
- A folder the AI members cannot work in (outside the home folder and `KANBAN_AI_ROOTS`) is refused when the wizard reads it, with what to do, instead of every member being skipped at Create.

## [3.23.0] - 2026-11-02

AI permissions: fewer needless stops, the risky things still with a person (#275).

### Added
- **What each role runs without asking.** Every Claude Code run that is not in safe mode gets its role's tools on top of the member's own allow list: a Dev edits, installs packages (npm, pnpm, yarn, pip, uv, poetry, go, cargo), runs the tests, lint and build and commits on its branch; QA installs, runs the tests, starts the app and drives the browser; a Designer writes its frames, serves them on a local port and looks at them in the browser; the Reviewer runs the tests; the User tester starts the app. Never `git push`, `sudo` or a forced delete.
- **Web search per project**: Off, By role (PM, BA, Designer, Dev: the roles that look things up) or Every role. Web pages stay limited to the allowed domains outside Bypass.
- **Presets** Careful, Normal and Trusted in Settings › AI › Safety and limits and AI Team › Safety, each explained in a line. Careful: no Bypass, no web search, Docs edits wait for you. Normal (the default): as before, plus the role tools and web search by role. Trusted (the owner's): every work run of a local CLI in Bypass with the web open. The status ceiling, deletes, approvals and safe mode hold in all three.
- **Ask once, then remember.** A tool the CLI refused for lack of a rule (it cannot ask mid-call) becomes one request with the narrowest rule that covers it (“Let Dev run `npm install left-pad`” → `Bash(npm install:*)`). Answer it for this ticket, this project or every AI with the role (the owner's), and the run carries on where it stopped. A board approval can be remembered the same way: once, this ticket, this project, or the role. Remembered answers are listed in AI Team › Safety with Revoke. A push, `sudo` or a forced delete is asked every time, a person's deny rule is never asked about, and high risk is decided once each time.
- **What stopped the AIs** (AI Team › Safety): every refused action, refused tool, permission question and “I cannot” in the runs, grouped, with the role, what it was trying to do, how often, and what the board does about it now (fixed, a setting, or kept on purpose with the reason).
- **The permissions guide** for an AI: the `board-permissions` skill in every Claude Code run, and `docs_read(action='permissions_guide')` for any MCP agent, with what the calling AI may do right now (its board actions, ceiling, role tools, web search, remembered rules).

### Changed
- **Every refusal says why and what next.** The AI reads `Instead: …` (leave the ticket and say it is ready, propose the change in a comment, hand it over); the person's notice says what to switch on, or that it is kept on purpose. “Why was this blocked?” shows both.
- **The owner may go past a lock or the role template, after a warning.** On an AI's Permissions tab the greyed modes keep their look and the 🔒 (Delete tickets and Delete docs past Needs approval, anything looser than the template), but for the project owner they are clickable: a dialog says what it risks (a deleted ticket is gone for good), asks to tick “I understand” for a lock, and records the change as Owner-enabled with the name and time. Admins and members still cannot (the design's A1 lock becomes the owner's decision, as the owner asked in #275).
- Handing a ticket to a teammate from inside a run with `ai_team(action='ask', intent='work')` now goes through as `ai_run(action='handoff')`, with the same checks, instead of being refused.

### Fixed
- **Evidence an AI names by path**, on top of 3.22.1's worktree fix: the member's own folder still counts after the worktree (a file saved there before the worktree was made), an absolute path inside either is accepted, and the refusal names the folders it looked in.

## [3.22.1] - 2026-11-02

### Added
- **The draw.io editor comes with the desktop app.** Diagrams open with nothing to run and work offline: the board serves draw.io 32.6.9 (Apache 2.0, pinned and trimmed by `desktop/scripts/fetch-drawio.sh`) at `/drawio`, with every feature that needs an internet service off. Settings › Diagrams has *Built into the app* as the default; a self-hosted setting left at the old default address uses it too. The installer grows by about 21 MB (65 MB installed).
- Docs: attach Excel, Word, PDF or any file to a page (toolbar button, `/file`, drop or paste); it shows as a file card.
- An AI run attaches pictures and documents (Excel, PDF, logs) named by a path in its working folder to Docs pages, comments and work logs.

### Fixed
- Diagrams: Edit spun for 20 seconds and failed when no draw.io editor ran at the address; it now says so at once and offers another editor. The editor loaded twice on opening (the page stood still meanwhile), and loading spinners in the Diagrams, splash, app-loading and sidebar screens did not spin (their CSS modules had no keyframes). The public editor was blocked by the window's policy and could never open. Download .drawio works in the desktop app.
- An AI run in a ticket's worktree could not attach its screenshots ("no such file" / "outside the working folder").
- Windows: Checks crashed on command output the console code page could not decode; AI account sign-in had no terminal (it opens a console window now).
- Set up the AI team: suggested commands no longer go into folders git does not track or `cd` the commands after them; Next and Try again try the commands as edited.
- A sent comment came back as the draft; links in Docs pages did nothing (web links now open in the browser, page links by slug resolve); saving the PM pack failed with 422; accepting a Docs AI proposal failed with 409 when the reviewer had an old draft.
- Vietnamese ticket titles make readable branch names; `ticket_items` without `action` adds (or updates with `item_id`); a 403 for a request outside the board's window names the MCP tool to use.

## [3.22.0] - 2026-11-02

A notification that needs the person reaches them when the board is not in front (#270, `design/screens/notifications.md` J).

### Added
- **System notifications in the browser.** The board in a background tab shows a system notification for a *Needs you* (the Web Notifications API), allowed from Settings › Notifications with *Send a test*, never asked on first load. One tab sends (a Web Lock; the tabs tell each other over a `BroadcastChannel` whether one is in front, and then a toast is enough), at most one every 20 s with the rest grouped, withdrawn when the question is answered anywhere, and a click brings the tab up at the thing itself.
- **A sound for a *Needs you*, never for information**: a choice of Chime, Drop or Bell (or off) in Settings › Notifications, with *Play* to hear it. The browser plays it in the tab that notifies and in the window being looked at; the desktop app plays it from its main process, so it sounds with the window closed (macOS) too. If the browser would not let the page make sound yet (nobody has clicked on it), the system's own sound stands in.
- **A reminder when a *Needs you* stays unanswered**: *Remind me if unanswered* (never, 5, 10, 15, 30 or 60 min; 15 by default). A *Needs you* nobody has opened after that time notifies once more, with the sound, saying *Still waiting*. Once per request, never in quiet hours.
- **Not to slip**: the tab's icon gets a red dot while something needs you, and on macOS the dock bounces once for a *Needs you* that arrives while the window is not in front.

### Changed
- **In the window**, the toast for a *Needs you* stays until it is acted on or closed (it used to fade after 12 s), and plays the sound.
- **Sound is on by default** (a chime), because a silent notification is easy to miss. It is only ever for a *Needs you*. Switch it off in Settings › Notifications. The desktop app's notices used to be silent unless this was switched on, which was off by default.
- A question's first reminder is now this setting (15 min by default, as before) instead of a fixed 15 min; the repeats every 2 h stay.

## [3.21.2] - 2026-11-02

### Changed
- **Settings › AI is five groups, not ten loose sections** (`design/screens/settings-pages.md` I: no more than 5 sections a page). *Board AI* (the picker, what it may do by itself, standing orders), *Safety and limits*, *Running the team* (operations and Team on its own), *Members and workflows* (role packs, workflows, skills and plugins) and *Knowledge and code* (project knowledge, repositories). A menu, On this page, stays at the top and jumps to each. Safety and limits uses the same grouped rows as the rest, with the unit beside each number, and its hints now say what happens at a cap.

### Fixed
- **Settings › AI › Repositories: a title is no longer squeezed into a narrow column** next to a wide select (*Hand over finished code by*). Its rows are the same grouped rows as everywhere else.
- **Settings › AI › Operations looks like its design** (`design/screens/ai-operations.md` K, `ai-story-flow.md` L). The first card now has the same grouped rows as *Team on its own* (a heading and a line per group, a rule between rows) instead of loose rows, and a long option name in a select no longer widens the control and squeezes the row's title into a narrow column.

## [3.21.1] - 2026-11-02

### Changed
- **An agent knows how to work with the AI team over MCP.** `ai_team(action='guide')` explains when to ask an AI (an answer in a comment, nothing changed), hand it one ticket (`intent='work'`), send a heads-up (`intent='notify'`), put a ticket on a workflow, or give a goal to the PM as a Story, and what to do while it runs. The server instructions carry the same choice in short, and `ai_team(members)` now says each AI's role.

### Added
- `ai_team` actions to hand work over as the board does: `workflows`, `workflow`, `start_workflow`; `stories`, `story`, `give_story`, `approve_plan`, `revise_plan`, `reject_plan`; `decisions` and `override` for what the PM decided in the person's place. Inside an AI run only the reads are allowed.
- `list_tickets` filters by `type` (the Stories) and `parent_id` (a Story's tickets).

### Fixed
- The MCP tool docs say what an agent got wrong: setting an AI member as a ticket's assignee does not start it, an @mention in a comment does not wake an AI, a ticket created in the intake column is taken by the team, and a `story` ticket is planned and run through `ai_team(give_story)`. `board_wait` says to wait there after handing work to the team instead of polling.

## [3.21.0] - 2026-11-02

Story, Flow by scope and Live commentary that follows it, plus the AI screens that ran without a design (`design/screens/ai-story-flow.md`).

### Added
- **Story**: a fifth ticket type the PM owns from the goal to Done. Give a Story to the PM with a goal, the criteria that say it is done, who approves the plan (pre-selected from the project) and a token budget. The PM writes the plan (its tickets, what waits for what, which criterion each covers); you approve it, change it, tell the PM what to change, or reject it, or the PM approves its own. The tickets run as soon as what they wait for is done; when the last one is done the PM checks every criterion and closes the Story or adds one more ticket. A Story moves with its own state (Draft, Planning, In progress, Review, Done, dropped) and is never dragged; Blocked says what it waits for. A ticket Triage finds too big becomes a Story when the PM splits it, and "Make this a Story" turns a ticket with children into one.
- **Story on the board**: the Story card (progress, the plan that waits for you, Blocked, times you stepped in), a chip naming the Story on its tickets, and Group by Story (lanes in the six columns, remembered per person). The Story page: goal and criteria, the plan, what the PM decided for you with Override, tokens and money, autonomy.
- **Decided for you**: every decision the PM took in your place (approved or sent back a design, split a ticket, retried a step, approved its own plan, answered a question, decided a permission) is recorded, with Override while nothing was built on it and the reason when it can no longer be undone. A new AI Team tab lists them with filters.
- **Flow by scope**: one scope bar (whole project, one Story, one ticket) over the Team map, the Timeline and Live commentary, with a picker, a breadcrumb and a link to copy. The project map groups the work by Story; a Story puts the PM at the centre with a timeline per ticket; a ticket shows its workflow's steps.
- **Live commentary follows the scope**: Highlights or Everything, dense commands folded, Needs you pinned, a line lit on the drawing, and a reply box to an AI that is working.
- **While you were away** on Now, **Autonomy by Story** in Health, a ticket stopped at its token cap on Now and on its card with Resume and **Raise the cap**.
- **Evidence** on a ticket: one block with the gate, Dev's red and green runs and the Tester's pictures and logs; a testing step with no evidence can be accepted with a reason, and accepting work without test-first evidence asks why.
- **AIs talking to each other** fold into one line in ticket comments and Docs threads, with Join in.
- **Team on its own** grouped by what it decides, with who approves the design, the risk tiers explained, a confirmation before the PM decides for you, and a state for a project with no PM.
- **Packs and plugins**: see what a pack update changes, update and go back (30 days); choose which roles load each of your own Claude Code plugins; Bypass permissions per pack, with the warning.
- **Workflow picker** with each workflow's steps and the roles a project lacks, and a **Keep awake** chip that shows when the computer is held awake and switches it.

### Fixed
- Two runs starting together no longer fail creating the project's Docs AI settings.
- The Bypass warning says the web is open in bypass, as it is since 3.20.0.

## [3.20.0] - 2026-11-02

The AI team on Claude Code, all nine phases of `docs/specs/ai-claude-code-implementation.md` (designs `design/screens/ai-operations.md`, `ai-team-process.md`, `ai-board-wave3.md`).

### Added
- **The board keeps its own transcript of every run.** What it sent (system prompt, prompt, a note) and every line the CLI printed, secrets masked, compressed when the run ends, searchable (FTS5), pinned against the retention (the notification retention, 90 days; the run's summary stays for ever), exported as Markdown or JSON. Claude Code deletes its own session files after about 30 days; the board no longer depends on them. **AI Team › Run history** finds a run by its words, member, state, skill or time; one run's page shows what it was given and every tool call with its input and output.
- **Skills and subagents counted from the stream** (the CLI's `Skill` and `Task` tools): real use per skill, per plugin and per member.
- **An AI in trouble is diagnosed before anything is done.** A run that prints nothing for a while is looked at by code: a server started in the foreground, a command waiting for a key, a board call open for 15 minutes, a long build that is only slow, a child eating memory. Only when the code cannot tell does Haiku read the last steps (a proposal, never applied by itself). The card offers what fits: stop that command and keep the run, tell the AI, wait 30 min, continue with a note, cancel. A child that eats memory is stopped instead of the whole CLI.
- **Failures by kind.** A used-up usage window holds every run of the account until it reopens and is never counted as a try; a dropped connection, a 5xx or a 529 resumes with backoff (30 s, 2 min, 10 min); a crash resumes once, then is read from stderr; a conversation too long starts fresh with a hand-over note; a board fault is retried and never held against the AI; a signed-out account holds its runs and resumes them on sign-in; every run the board's closing cut off goes on; after the computer sleeps every CLI is checked. An identical write right after a resume is skipped (never twice).
- **The usage window of each Claude account, read from Claude Code itself** (its `rate_limit_event`): 5-hour and weekly bars with their reset times, at most 2 runs at a time per account (a setting), and urgent work (High or Critical) moved to an account with room, by itself when turned on, otherwise with one click.
- **Needs you carries the diagnosis**: what happened, what the board found, what it already tried, and the four ways out of a stopped run (Try again · Continue with a note · Hand to another AI · Open the run); six filters; new rows for a run in trouble, a board fault, a merge conflict, two AIs that cannot agree, urgent work waiting for a window, a workflow step that waits for you.
- **Send a running AI a message** from the run or the ticket: it reads it at its next turn (Claude Code with its input open, a project setting) or with its next board call.
- **Project knowledge**: instructions for every AI on the project (with history) and the lessons its AIs learned — proposed by a light model when a ticket reaches Done, or by a diagnosis ("start the dev server in the background"), kept, edited or dropped by a person, capped at 2,000 tokens, counted per run.
- **One git worktree per ticket**, beside the repository (`<repo>.worktrees/<KEY>`), on its own branch and port, with the project's prepare command run once; never removed while something is uncommitted; *Clean up finished*. **Hand-over** by project: a draft pull request at Review, ready at Done; or merge on this machine, only when a person moves the ticket to Done or presses Merge, never while the main checkout is dirty, a conflict rolled back and offered to an AI or to you; or push the branch.
- **A member's skills, subagents and hooks load per run** (`--plugin-dir`, after spikes S1–S4), not written into the repository; a one-time migration removes what the board once wrote (never your own files).
- **Skills and plugins from a source**: a git URL, a marketplace or a folder, no review step, the commit recorded, *See what changed* before an update, pin, reload, reset, remove, roll back; the *Suggested for a role* catalogue (Anthropic's design plugin, ui-ux-pro-max, frontend-design, canvas-design, webapp-testing, Figma, Chrome DevTools and Playwright MCP); on for a project, a role, or one member.
- **Eight role packs** — Triage, PM, BA, Designer, Dev (TDD), Reviewer, QA, User tester — versioned, exportable, importable, and a member made from one. **Give a project a team**: a scan of the repository by code, a proposal, a trial run of the prepare and test commands in a scratch worktree, then Create.
- **Workflows**: four ready-made templates (Quick fix, Standard feature, Feature with a UI, Research) and an editor; a ticket's strip of steps with who held it; the assignee follows the step and the history is never overwritten; **Checks** run the project's test, lint and build commands before any AI review; review at a depth Triage picks (light, standard, deep → Haiku, Sonnet, Opus); a person is asked at most twice (the design and the last step); no round limit, but **no progress goes to the coordinator** (a PM member), whose ruling gets one chance; Opus at high only on a second attempt; an odd job's optional reviewer; skip a step for one ticket; **test-first evidence** (red on an assertion, then green with the same command). Measures per template in AI Team › Health; board filters "waits for me" and by role.
- **The Board AI acts as you, by risk tier** (D23): looking up just happens; small and reversible changes (up to three tickets, one project — move, assign, comment, start or stop one run, put a ticket on a workflow, pause one AI) are done with one Undo; Done, bulk changes, deleting, Pause all, permissions, budgets, merging and anything outside the board ask first, and that set is locked server-side.
- **Five AI signals** as cards in Board health (a hung AI, three failed runs, a window nearly used, a long Needs you, an arbitration waiting). **Standing orders**: a rule in your words becomes a rule you can read, runs in trial first (it only writes down what it would have done), goes live after its trial, only ever does what can be undone, and every firing has its history and one Undo; Pause all AI stops the rules too.
- **GitHub**: red CI on a pull request the board opened goes back to the Dev with the failing log (checked against the base branch first), and people's review comments too; pushing to that pull request's branch and replying on its threads are part of the run.
- **The knowledge base, with no embeddings**: upload PDFs, images (described once by a light model), text and code; keyword search ranked by BM25 with a table of contents; a store per project and a shared one a project opts into; private documents stay private; what an AI reads is fenced as untrusted. Two MCP tools: `knowledge` (index, search, read) and `board_wait` (wait for the board to move, for an AI working from outside).
- **Eval suites** on a sandbox project, marked by code, with the scores kept over time.
- **The team runs itself** (plan D8, D24; Settings › AI › Operations, *The team on its own*):
  - **New tickets are taken.** A ticket that lands in the intake column, assigned to nobody, goes on the project's default workflow and its Triage (the one you chose, else any) takes it. Only tickets that arrive after you turn it on; a ticket given to one AI stays an odd job, one given to a person is theirs.
  - **The PM runs the team.** A step that failed is tried again once by the board, then goes to the PM, which tries it with a note or passes it to you; the questions and permission requests nobody picked up go to the PM first (as the project's Autopilot delegate, within its risk ceiling and hourly limit); a ticket Triage says is several pieces of work is split by the PM into child tickets, each taken like a new ticket, and the parent ends when they are all Done.
  - **A blocked step starts again by itself** once its cause goes (a member is added or resumed, a daily cap resets, the worktree is back), and while it waits it asks you in Needs you instead of sitting there silently.
  - **Done can be the board's move**: with *after review*, a ticket whose checks passed, whose test went red first and whose every review passed is moved to Done (which merges) by the board. Anything short of that still waits for you.
  - **A token cap per ticket** (D11): the workflow stops for you when one ticket has used it; *Let it go on* gives it the cap again.
  - **Test-first is enforced** (design I): a Dev step with no failing run before the passing one is not done; the choice — *Accept without it, just this once* or *Turn the rule off for this project* — waits at the last step, and with the PM on the board first sends it back to the Dev once.
  - **The Board AI manages the team for you** (D20, D24): it creates the pieces of a split ticket, messages the AI working on a ticket, and hands long coordination of a ticket to the PM, each by tier with its Undo.
  - **GitHub on its own** (D21): red CI the change caused and review comments on the board's pull request go to the ticket's Dev by themselves (a setting, on by default).
  - A step is given what its template asks for: the acceptance criteria, the Designer's hand-in (so the Build gets the design, not only "Approved by …"), and what the previous step's run reported.
  - A member made from a pack keeps the pack's model for a second attempt and its model per review depth; a deep review runs at high effort.
  - **The PM can decide the design for you** (`autonomy.approve = pm`): it opens the canvas, its frames and the diagrams, judges them as a design lead would (hierarchy, type, spacing, colour, consistency, not only coverage), comments on the frames that fall short, and approves or sends them back. Questions and permission requests go to the PM at once (no grace minutes by default).
  - **Splitting by feature**: the PM splits a product into things a person can do or see, each taken end to end on its own workflow (design, build, tests, review inside it); the pieces run one after another in the order the PM made them.
  - **Two new workflows**, *Docs* (the BA writes a Docs page, a light review) and *Chore* (a change with no behaviour to test: a version bump, a changelog, a README), and Triage picks them.
  - **Proof, not prose**: every step is told to show its work (screenshots, the command and its output); QA and the User tester go back once when the ticket carries no evidence, and a step still without it never lets the board move the ticket to Done. Reviewers comment on the thing itself (the Docs section, the canvas frame, file:line) and check that their earlier comments were answered; an AI that needs a teammate @mentions them.
  - A step moves its ticket to In progress when an AI starts on it; an AI keeps the work log, comments when the next step needs to know something and ticks the criteria it checked (a reviewer may, without asking).
  - A question to an AI that is working on the same ticket (the ticket chat, an ask run) is told what that work is doing now, so it answers about the work as it is.
- **The AIs work with what you would have in Claude Code**:
  - **Bypass permissions** for every ready-made role but Triage when the project's owner makes the member from a pack (deny rules, the status ceiling and approvals still hold); the **web is open** in that mode.
  - **Your own Claude Code plugins** (the ones installed for your user in `~/.claude` and not switched off) load in every Claude Code run (`own_claude`, on by default).
  - The **canvas design guide** reaches every run whole, as the board's `canvas-design` skill (and `docs_read(design_guide)` for other agents): it no longer rides in the MCP server instructions, which Claude Code cuts at 10,000 characters.
  - The Designer, BA and PM write the files of a canvas or a diagram; the Designer and the PM look at frames in a browser (Playwright MCP), the Designer starts from a direction and tokens and checks its frames at phone and desktop width; the User tester starts the app it tries. Every role knows which drawing fits (a Canvas for screens, a draw.io Diagram for a structure or a flow, a Sketch for a rough draft).
  - Ready-made packs have a version (now 3): a member made from an older one shows the update and takes the pack's persona, tools and rights with one click, keeping its name, folder, account and model. A pack's plugins are installed when a member is made from it.
- **Live commentary** beside the Team map and the Timeline: a live-chat feed of what each AI is doing (commands and their results, edits, hand-ins, the board's moves), with the AIs working now, filters, pause and a slim rail when folded.
- **Flow reads workflows**: the Team map, the Timeline and One ticket draw a workflow's hand-offs between the AIs that held its steps (moving while the next AI works), the first return from a review, sends-back from the Checks and skipped steps; the board's own intake is not a hand-off from you.
- **Keep the computer awake while an AI runs** (desktop, View menu, on by default), and after the computer wakes every run it thought was going is checked.
- **Evals**: the problem, recovery and coordination suites have tasks, and the suites can run on a schedule (Haiku by default).
- **The repository scan** looks again when the CI or the packages change, and a light model refines its suggestion when an account is signed in.

### Changed
- A run on a person's own Claude Code login is limited per account (2 by default), no longer unlimited.
- A run whose account signed out is held, not failed.
- The board's MCP instructions now say that an @mention inside an AI run does wake the other AI, and name `ai_run(action='handoff')`.
- **A Board AI on Claude Code looks things up with its tools and changes the board only through its answer**, so every change it makes has its risk tier and its Undo (the board refuses a change made with a board tool). It can now change a ticket's labels too.

### Fixed
- **An AI writing its own work log no longer waits for a person's approval** when its role may not edit ticket fields (a Reviewer, a Triage): a work log note is the AI's account of its own work and needs only the right to comment.

## [3.19.0] - 2026-11-01

One place for what needs you and what happened: Notifications ([#253](https://github.com/iamcaominhtien/kanban-board-mcp/issues/253), design `design/screens/notifications.md`, spec `docs/specs/notifications.md`).

### Added
- **A bell and a panel on every screen.** The red number counts only what needs you (a question, an approval, a failed run, a blocked permission, a signed-out account, a mention, a page proposal, a cap reached); updates show as a blue dot. The panel has two tabs, *Needs you* (oldest waiting first, with Answer, Approve, Retry, Sign in again right on the row) and *Updates*, grouped by day, with Snooze and Mute on hover. Keyboard: N, J/K, Enter, E, S, Esc, Shift N.
- **All notifications**, a page for every project: search, All · Unread · Needs you · Snoozed · Done · Cleared, days, project and kind filters. Notifications are kept 90 days (a setting); clearing a row is a state, not a delete.
- **A notification closes itself.** Answer the AI in the ticket, decide the approval in AI Team, sign the account in or retry the run, and the row goes grey with why ("Done — you answered in the ticket") in every open window within a second. A row whose ticket was deleted says so and offers only Dismiss.
- **Many events at once are one row**: eight AI finishing within ten minutes is "8 AI finished work", expandable, and one desktop notice.
- **The day in one card** at 18:00 on weekdays (a setting): runs finished and failed, what still waits for you, what it cost, Docs published, tomorrow's schedules. Counted, not written by an AI.
- **Desktop notifications from the app itself**: the Electron main process follows the notification log, so notifications keep coming with the window closed (macOS), two windows give one, at most one every 20 s (the rest grouped), a notice is withdrawn when its event resolves, clicking opens the thing itself, and the dock or taskbar shows the Needs you number. Permission and *Send a test* in Settings; quiet hours obeyed. The web build shows the count in the tab title.
- **Follow and mute** a ticket, a Docs page, a Docs space, a project or a kind; a mute never hides something that needs you.
- **Settings › Notifications**, one app-wide page: In app and Desktop per event (In app is locked on for everything that needs you), quiet hours, Do not disturb, sound, the day card, retention and the Muted list.
- An event log with increasing ids (`/notifications/log`, `/notifications/feed?since=`) that the panel, the desktop app and later an external AI waiting on the board all read; a recipient is a person or an AI member.

### Changed
- **Toasts are for the moment only**: a Needs you event while you are looking, a failure of something you just did, or an Undo. At most three at a time; a fourth collapses into "+N more". "Saved", "Copied" and the like are a quiet grey line at the bottom for 2 s.
- The six features that toasted on their own (AI runs, schedules, Docs publishes, Docs comments, AI accounts, AI safety) now write to the one log; nothing arrives twice.
- "Off" means quiet, not unrecorded: an AI safety event is always recorded, even when both switches are off.
- The notification switches moved from each project's AI settings to the app-wide Settings › Notifications; the Docs space Follow is now one case of following.

### Removed
- The 09:00 AI safety digest: quiet safety events are ordinary Updates rows when they happen, and the day card is the only summary. Board health keeps its own 09:00 digest.

### Fixed
- **A step of an AI run could be lost**, such as "Paused by …" when output was still arriving: two steps written at the same moment each overwrote the other's list. They are now written one at a time per run.

## [3.18.2] - 2026-11-01

Two fixes for AI members: pictures on the Docs pages they write, and no replay of old "finished" toasts.

### Changed
- **The release page lists two guide files instead of eight**: the full guide PDF, and `kanban-board-guide-sheets-<version>.zip` with the stand-alone PDFs (quick start, shortcut sheet, administration, MCP, self-hosting, troubleshooting, desktop menu).

### Fixed
- **Pictures on a Docs page written by an AI member were broken.**
  - **Cause:** an AI referenced its screenshots by a path in its working folder (`qa/evidence/TC-1.png`), which the board cannot show.
  - **Fix:** inside an AI run, such a picture is now copied into the board and the link rewritten to `/uploads/…`, as test case proofs already did. A picture the page already held stays as written when its file is gone, so an AI can still edit an imported page. A new picture whose file does not exist is refused with what to do.
- **Opening the app or switching project showed a pile of old "finished" toasts.**
  - **Cause:** every AI run of the project that had finished hours earlier was announced again as if it had just happened.
  - **Fix:** the first load of a project now only records the states. A run first seen later is announced only when it was queued after that.

## [3.18.1] - 2026-11-01

A smaller desktop app, and two fixes for the installed app.

### Changed
- **The desktop app is about 100 MB smaller once installed** (Windows 466 MB → about 366 MB, macOS 398 MB → about 295 MB), and the download about 36 MB smaller (Windows installer 162 MB → about 126 MB, macOS 181–188 MB → about 143–150 MB). The two Python programs (`kanban-server`, `kanban-mcp-stdio`) were two separate folders, each with its own copy of the Python runtime and every library (about 50 MB each); they are now built into one folder that shares them, `Resources/kanban-mcp-stdio/`. The stdio binary keeps its path, so MCP clients set up by an older version keep working. The command-line tools that came with FastAPI and MCP (`fastapi run/deploy`, `mcp dev`, with sentry, rich and pygments) are no longer packed, and only the English and Vietnamese Chromium locales are kept (the other ~50 took 45 MB; a missing one falls back to English).

### Fixed
- **In the installed app, connecting an MCP client (Claude Code, Codex, Antigravity…) wrote a path that did not exist.** Since 3.1.1 (the onedir layout, `Resources/kanban-server/`) the server looked for `kanban-mcp-stdio` next to itself, in the wrong folder. Both programs now sit in the same folder, so the path is right.
- **Time zones did not work without the operating system's time zone database** (Windows, trimmed Linux images): a reset time such as “resets 4pm (Asia/Saigon)” and a schedule's time zone were silently ignored. The time zone data now ships with the app.

## [3.18.0] - 2026-11-01

The AI team, tighter: a question has the rights of work, Canvas AI and Autopilot work with it, proof on test cases, and fewer limits stop a team.

### Added
- **Canvas AI works like the AI team.** *Ask AI* is answered by the AI that knows the canvas (the one working on its ticket, else the one that last proposed or commented, else its maker, else the project's default), shown as “Answering: …” with the reason and changeable; the ribbon on the frame shows its name. The whole canvas goes along (an outline of every frame, and for an AI on this computer the other frames' source to look at), a source is never cut, a reply that was cut off is asked again, a failure says what the AI answered, and a double *Ctrl J* is one job. A local AI gets up to 15 minutes and the panel waits as long.
- **@Name an AI in a canvas comment and it answers in the thread**, like on a Docs page: one job per AI mentioned, an AI's own comment wakes nobody, and a frame comment has **Send & propose** (the AI answers and prepares the change). *Propose a fix* goes to the AI that wrote the comment and sends the whole thread, and it is offered on a person's comment too.
- **A canvas keeps one conversation with its AI**: a Docs page's canvas uses the page's session, a ticket's canvas the ticket's (while a run uses it, the ask keeps its own), any other canvas its own.
- **A canvas proposal waits as “Needs you”** in the team's Now list (*Review on canvas*) and counts in the ticket's flow; **Autopilot may accept or reject it, and a Docs proposal too** (its brief shows the changed lines or the text each change puts on the page; a Docs change is decided in the owner's name, as a person must, with “Autopilot (name): reason” as the note, and the page is published as the owner with the AI marked, or, if it cannot be, the text waits in the owner's draft and the delegate is told; it is marked “(Autopilot)”, counts in the hour's decisions, and a frame a person is editing or that changed stays for them).

- **A test case's proof is shown, and can be a picture, a command, a link or a reason.** Until now the `proof` an AI wrote on a test case was stored but never shown. The test case has a **Result and proof** field (Markdown, like Expected result, with uploads). An AI writes a screenshot as `![login](qa/evidence/TC-1.png)`: the board copies the file from the run's working folder, so it shows on the ticket and survives a cleaned folder (a missing file, a file outside the folder, keys and `.env` are refused with what to do). When a result cannot be shown, the proof says `Not provable: <why>`; that is shown apart from a proof.
- **Missing proof is flagged.** A test case set to pass or fail with no proof shows a **No proof** badge, the Review summary lists those cases (and the ones taken on trust), and `ai_run` report tells the AI which cases to back before it finishes. A run's prompt says how to write the proof and not to invent it.
- **A QA preset**, and proof rules in the Dev and Reviewer presets: QA lists test cases before the build, writes checks test-first, runs them on the real app and logs bugs as tickets. The report's `tests` may carry the `command` that was run.

### Added
- **The board's REST API now answers only its own window when it changes something.** An AI run with a shell (Bypass, or a broad Bash rule) could `curl` the loopback API as the owner: approve its own requests, switch Safe mode off, lift the limits. The desktop app now gives its window a random secret per launch (written to the server's standard input, not to its environment, which `ps` shows to other programs) and the server refuses every POST, PUT, PATCH and DELETE without it, except the MCP endpoint (a run's own token) and the client log. Reading stays open. Started by hand (development, tests) nothing is checked.

### Changed
- **A question (an ask run) has the rights of work.** Only Autopilot's delegate, which reads text nobody vouches for, still only reads and decides. A question to a member can now edit files, run what its rules allow, change the board within the member's permissions and hand work over; the member's permissions, approvals, Safe mode and Bypass rules apply as for work, and a Claude Code question uses the work sandbox.
- **A canvas comment or proposal needs only the Comment permission**, because neither changes a frame until it is accepted.
- **Fewer limits stop a team of AIs.** The board's runs per day no longer counts members on a person's own CLI (it stays for members billed by the call); handing work to a teammate AI needs no approval on each hop (Safe mode and a read-only member still cannot); the pending-approval caps are 50 per AI and 200 per project (they were 10 and 25) and Autopilot may decide up to 2000 an hour (it was 200). A run says which other AIs work in the same folder at that moment. The “waiting for an owner to raise the cap” note appears only where a request to raise the cap exists.
- **Report-backs to a busy PM are not lost.** Several teammates finishing while the PM works tell it once, with every report, in a run queued behind its current one; when it is never free the ticket says so.

### Fixed
- **A rate-limit was guessed from any “rate” or “limit” in an error.** The Board AI, the Docs AI and the canvas now recognise a limit by the same wordings as a run, wait until the time it resets when the message gives one, and no longer treat “failed to generate” as a limit.
- **An AI run could read or write any folder through the canvas tools.** It can no longer name the computer's root, the home folder or a dot-folder in it; secrets, `.git`, `node_modules` and key files are left out; a folder that does not exist yet is checked too; and in Safe mode nothing is written to a folder.
- **The Board AI chat, the Docs AI and the other answers from a member ignored its AI account.** They ran under the login already on the computer (the one that may be at its limit) and looked for their conversations in the wrong folder. They now use the account of the member that serves them, and a conversation shared by a ticket's runs and its chat is found in the account's folder.
- **Autopilot decided in Safe mode, and decided what it was not shown.** It no longer decides while the project or the asking AI is in Safe mode, a request approved in Safe mode is not applied, and `decide` / `answer` accept only the requests and questions in the delegate's brief (which also respects the grace time).
- **A ticket given to a paused AI, or whose run could not be queued, waited unseen.** A paused AI now has its run queued for when it is resumed; when no run can start the ticket gets a comment that says so, and a handoff that cannot be queued puts the previous assignee back.
- **A plan limit (“You've hit your weekly limit · resets Nov 2 at 4pm”, quota exhausted) failed every run at once.** It is now waited for like any rate limit, until its reset time when the message gives one, and the member shows Rate-limited meanwhile.
- **Closing the board counted as the AI's failure.** A run that was still going when the board was closed is recorded, but no “failed” comment, status move, work-log entry, report-back to the PM or auto-trip count follows.
- **On macOS a CLI left over from a crash was never found, so it was never stopped.** It is now recognised through `ps` where there is no `/proc`.
- **A paused schedule still started a slot that was already waiting, and a schedule run cut off by closing the board started again behind a paused schedule or past its time.**
- **Settings sent empty answered 500; “Runs per ticket per day” accepted 0.** They answer 422 with the range.
- **The Timeline lost a run queued before its window that was still going; the Team map did not show a paused AI that waits for you; the “AI” filter of You stepped in did nothing; clearing the Autopilot numbers saved 0; the Timeline answer box kept the draft of another question; Stop and Restart on Resources could be sent twice.**
- **Work the board's closing cut off now goes on at the next start.** The run is resumed in the same conversation, with the same chain and the same duty to report back to the PM; Retry keeps that duty too. Before, the PM was only woken by the failure, and not at all now that closing is a quiet end.
- **Resuming cut-off work is bounded.** It happens once per piece of work (a resumed run that is cut off again is not resumed again, so a run that brings the board down cannot loop), never for a scheduled run (its schedule restarts it) and never for a run a person had paused. A member set to be removed after its run is removed when a crash was its last run too. Plan-limit wording of Claude Code, Antigravity and OpenAI (“5-hour limit reached”, “exhausted your daily quota”, `insufficient_quota`) is recognised.
- **A member on an AI account also reads the MCP servers and plugins of its own account**, not those of the default login.
- **A plan limit is read more carefully:** “Context limit reached”, “Disk quota exceeded” and the like are not waited for as rate limits, and the reason shown is the CLI's own line.
- **Autopilot decides only ids the board wrote in its brief**, not an id an AI wrote inside its question; a fix round or a retry of a schedule is no longer refused for coming after the slot's start deadline; a proof named after a login flow (`reset-password.png`) is no longer refused as a secret.
- **A proof can no longer copy hidden folders or files named for secrets** (`.claude`, `.config`, `credentials*`, `secrets*`); code in a proof is left as written.
- **A ticket an AI gave to another AI waited for ever.** When an AI changed a ticket's assignee to another AI (by editing it, or in an edit a person or Autopilot approved) the new assignee was never started, nothing on the board said so, and the lifecycle stood still. The receiver now gets a work run, queued behind the sender's, as `ai_run` handoff does.

- **A question to an Antigravity member failed at its first `ls`.** A question runs in plan mode and was given no command at all; Antigravity ends the whole run at the first command nothing allows, and the card then said to add an Allow rule. A question may now run the reading commands (`ls`, `cat`, `grep`, `git status/diff/log`…) like any run. A run that ends with a status other than success now says which status the CLI reported.

### Changed
- **An Antigravity question has the permissions of work.** A question to an Antigravity member (with or without an AI account) ran with no commands but a short reading list, and one command outside it (`git -C <folder> status`) ended the whole run with “command was denied”. It now gets the member's Allow and Deny rules, the file tools and, for a member on Bypass permissions, Bypass, like a work run. Safe mode still makes it read-only; the board's own guard still refuses to let a question change the ticket, and the prompt still asks it not to change anything. A failed question no longer ends its reason with two full stops.
- **Autopilot decides at once by default.** The time it leaves a person to decide first (`grace_min`) starts at 0 minutes instead of 2 for new projects; the Autopilot card still changes it (0 to 240).
- **Antigravity runs without an AI account again.** A member on “the login already on this computer” runs as before (a scratch workspace that carries the run's MCP config, this run's own token count, the list of models from `agy models`); a member on an AI account runs through the account's stdio bridge (`adapters.py`). The Antigravity member test and the run command use `agy`; `--effort` is not passed to it (it refuses it with most models). The auto-trip “loop” rule stays removed for CLI members, as with the other limits.

## [3.17.0] - 2026-11-01

Canvas: boards (called frames) on one large plane, a peer of Sketch and Diagram. Design: `design/screens/canvas.md`; notes: `docs/specs/canvas.md`. [#246](https://github.com/iamcaominhtien/kanban-board-mcp/issues/246).

### Added
- **Canvas.** Frames (an HTML page with its CSS and pictures, a picture, a Sketch, a Diagram or an empty frame) sit side by side on one plane with notes, arrows, labels and page tabs. It is an attachment of its owner (ticket, comment, idea, Docs page) shown as `![Name](canvas:cv_…)`, or its own **Docs page** (layers icon; **Docs › New page › Canvas**), and **Move to Docs** turns one into the other without changing the id. Entry points: the Canvas button of every markdown toolbar, `/canvas`, the New idea dialog, **Open on a canvas** on an HTML file or picture in the file viewer, and the New canvas dialog (blank, from files, ask AI).
- **The editor**: header, page tabs, plane with zoom 10% to 400% and Fit, a map, snapping guides, multi-select, tool bar (Select, Hand, Board, Note, Arrow, Label, Comment), Boards and Comments panels, every key in the design (press `?`). Below 40% frames show a picture of their last state, from 40% they are drawn live. A frame's source opens in an editor with a live preview.
- **Locks and merging.** One lock per frame, only while its content is open for changing (10 idle minutes, warned first). Moves, notes, arrows and comments need no lock and merge per item; only the same item changed by two people shows the "saved a newer version" card (Save as copy, Load theirs, Replace theirs). A failed save keeps a draft on this computer.
- **Open frames.** HTML frames run like a file opened in a browser: scripts, handlers, CDN libraries, fonts and outside images all work, with no cleaning, no `Content-Security-Policy` and no `sandbox` (Preview of an HTML file is open the same way). In the large view and Present, **Try it** (`I`) lets a page take clicks. Because the board has no sign-in, a script in a frame can call the board's API; open files from others only if you trust them.
- **In text**: a card with an overview (hover: Edit, Download, View full size, Copy link; ⋯: Move to Docs, Save as copy, Remove from text), one frame or a chip ("Show…" in the editors), a large view (steps, filmstrip, width switch, comments, all frames with G) and **Present** (dark full screen). References: pages and frames in the `[[` suggester (`[[Settings flow#Sign in]]`), Linked docs on a ticket, backlinks of a canvas page, exports write an outline picture.
- **History**: a version on every Done, accepted proposal, restore and (Docs pages) every 10 minutes; name, look at, compare (side by side and source diff), restore (makes a new version).
- **Comments** pinned to a frame (the pin moves with it) or to the plane, with threads, filters, resolve, mentions, Create ticket and Copy link.
- **AI.** **Ask AI** (Ctrl J) on selected frames prepares a proposal with before and after and per-frame accept / reject, saved as one version. The AI never overwrites, never takes a lock (a proposal for a locked frame waits) and never resolves a person's thread; an AI comment can offer **Propose a fix**.
- **MCP**, with no new tool: `docs_read` `canvases` and `canvas` (frames, notes, arrows, labels, comments, proposals; a frame's source or files), `docs_write` `canvas_create` (a canvas, or frames added to one, from a folder of pages), `canvas_comment` and `canvas_propose`. The instructions tell an AI to write frames responsive (Desktop / Tablet / Phone redraw the same page) and append a design guide, the same text for every MCP agent and for the Ask AI job (context first, a named direction and 2 to 4 different options when it is open, real copy and nothing added unasked, tokens first, hierarchy, real controls and every state, contrast, a check before sending); the repo's `canvas-design` skill (`.claude/skills/canvas-design/SKILL.md`) is generated from the same text and a test keeps them equal. They need the member's Edit docs permission.
- Export: ZIP of every frame or one frame, the board as a 2x PNG, an outline overview, PDF through the print dialog. Import: HTML files, pictures, a ZIP of a built page, `.sketch` and `.drawio` files.

### Changed
- Fixed: **Present** in the large view (button and `P`) closed the viewer instead of presenting.
- **Comment pins follow their element.** A pin put on a frame remembers the element under it (a CSS selector, its text, where inside it and the frame width) and is drawn on that element when the page is laid out at another width: in the editor after a resize and in the large view's Desktop / Tablet / Phone switch (pins are now drawn there too). Without the element (a picture, a missing element) it stays at its saved x and y. `docs_write(canvas_comment)` takes `at` (a CSS selector, or `text=Add task`) so an AI points at a place, not only a frame. New migration `c1d2e3f4a5b7` adds `canvas_thread.anchor`.
- **Download as image, SVG or GIF.** A frame's menu › Download offers Files (ZIP), Image (PNG, 2x), SVG (the page inside the SVG, scripts removed) and, for a page that animates with CSS, GIF (up to 6 seconds, stepped frame by frame at 15 a second, drawn at up to 2x with one shared, dithered palette). They draw the page as it looks after its scripts ran (the old image export drew the source without scripts, so a page built by JavaScript came out empty); **Copy board as image** and the header menu use the same drawing. Adds `html-to-image` and `gifenc`.
- **Try it** works in the editor too (button on the selected frame, key `I`, a Stop chip). A frame with `fit` (or **Size › Fit height to content**) gets the height of its page, measured once by the editor. `canvas_create` takes `x`, `y` and `fit` per frame and a top-level `canvas.json` with notes, arrows and labels, and orders frames by folder name.
- The default MCP tool list is about 1,800 characters longer (the five canvas actions); the size test allows for it.
- `docs_page` has a `kind` (`page` or `canvas`).

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
