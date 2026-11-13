# Moving the server from Python to Rust

Status: **in progress** (started 2026-11-11). This page is the plan and the progress checklist. Update the checklist in
the same commit as the work, so a later session can continue from it.

## Why

The server (`server/`, v4.0.1) is Python: FastAPI + the `mcp` SDK + SQLModel, about 84k lines without tests and
migrations, shipped inside the Electron app as a PyInstaller bundle. Goals of the move:

- **Fast start and a small installer**: no PyInstaller bundle and no Python runtime in the desktop app.
- **Performance and memory** with many AI runs and open event streams.
- **Type safety**: one statically typed binary that does not depend on a Python environment.

Scope: the whole server, all three databases (SQLite, PostgreSQL, MySQL/MariaDB), no change in behavior.

## Decisions

1. **Parallel rewrite, one switch.** The Rust code lives in `server-rs/`. `server/` (Python) is **frozen** and is the
   reference to compare against until the switch, then it is deleted and `server-rs/` becomes `server/`. A mixed mode
   (both runtimes serving one board) was rejected: the server has ten background loops and a lot of in-process state
   (context variables, run tokens, per-canvas locks), so a mixed mode needs temporary shims in Python, which are a new
   source of bugs that only exists during the move. No feature work goes into `server/` during the move.
2. **What must not change** (the parity contract):
   - Byte for byte: paths, methods, status codes, JSON shapes, the `detail` text of application errors, SSE payloads,
     MCP tool names / descriptions / schemas / annotations and the `instructions`, the `READY port=N` line, the API
     secret on stdin, the binary names and folder (`kanban-mcp-stdio/kanban-server`,
     `kanban-mcp-stdio/kanban-mcp-stdio`, so existing MCP client entries keep working), the `KANBAN_*` environment
     variables, `config.json`, what is stored in the database (ISO times with microseconds and `+00:00`, JSON in TEXT
     columns written the way `json.dumps` writes it), the `alembic_version` table, the Fernet key and keychain entry.
   - Same meaning, not the same words: the 422 validation messages that Pydantic generates.
   - 5.0.0 does not change the schema, so a user can still go back to 4.0.x.
3. **Stack**

   | Job | Python | Rust |
   |---|---|---|
   | HTTP, SSE, WebSocket | FastAPI, uvicorn | `axum` 0.8, `tokio`, `tower-http` |
   | Three databases, switched at run time | SQLModel | `sea-orm` 2.0 on `sqlx` 0.9; raw SQL for FTS5 |
   | MCP | `mcp` FastMCP | a small JSON-RPC layer of our own (initialize, ping, tools/list, tools/call over stdio and stateless HTTP): the replies of FastMCP are part of the contract down to the framing, and the surface is small; `tools/list` is served from the snapshot exported from Python |
   | Actor / AI attribution | `ContextVar` (`services/activity.py`) | `tokio::task_local!`, set by the middleware and the MCP layer |
   | Events | `events.py` | bounded queue of 100 per subscriber, oldest dropped when full |
   | git | gitpython and the `git` binary | the `git` binary |
   | Fuzzy search | rapidfuzz | own port of `ratio`, `partial_ratio`, `token_sort_ratio`, `WRatio`, checked against golden vectors made by rapidfuzz |
   | Other | keyring, Fernet, psutil, PyYAML, defusedxml, zipfile, zoneinfo, pypdf, websockets (CDP), pty | `keyring`, `fernet`, `sysinfo`, `serde_yaml`, `quick-xml` (no DTD, no entities), `zip`, `chrono-tz`, `pdf-extract`, `tokio-tungstenite`, `portable-pty` |

4. **Workspace** (one crate per area, so areas build on their own; an area's REST router and MCP operations live in
   its crate):

   ```
   server-rs/crates/
     kb-base    config, logging, version, errors, time and pyjson, activity context, events, secrets
     kb-db      targets and engine, the 78 entities, schema snapshot, migrations, SQL helpers, change log
     kb-board   projects, members, settings, workspace, git_repo, tickets, uploads, data, logs
     kb-notify  notifications
     kb-docs    docs*, docs_search, docs_import, docs_comments
     kb-draw    diagrams, sketches, canvases, screenshots and export (CDP)
     kb-ideas   idea_*
     kb-ai      services/ai and the runner
     kb-assist  assistant and docs_ai
     kb-dbkit   probe, move, jobs, cli
     kb-mcp     registry, protocol, stdio, bridge, mcp_clients, skills (embedded assets)
     kb-app     router assembly, the four middlewares, SSE, static UI, lifespan
     bins       kanban-server (also --runner), kanban-mcp-stdio (also --bridge)
     testkit    parity harness, fake-claude, fake-mcp-server
   ```

   Where Python imports late to break a cycle (tickets and AI runs, notifications and every area), Rust uses hook
   traits declared in `kb-base` and registered at startup.
5. **Python that stays**: only the scripts of the skills that Claude Code runs on the user's machine
   (`services/slides_skill/scripts`, `services/demo_video_skill/scripts`, `office_examples`). The server only reads
   them as data, so they become embedded assets.

## How parity is checked

1. **Contract snapshots** exported from the Python server into `server-rs/contract/`: `openapi.json` (every route and
   model), the MCP `initialize` and `tools/list` replies, the schema at head for the three dialects, and **golden
   vectors** for pure functions (fuzzy scores, slugs, anchors, Markdown and HTML handling, schedule slots across DST,
   Fernet, `pyjson`).
2. **Tests are ported first and proven on Python first.** Each pytest file of an area is ported to Rust tests that go
   through real HTTP or MCP (`testkit`), with `PARITY_TARGET=python|rust`. They must pass on the Python server (which
   proves the port of the test is faithful) before they are the acceptance gate for the Rust code. Tests that call
   service functions directly become unit tests of the matching Rust module.
3. **Differential runs**: the same request script against both servers, each on its own copy of a database; the JSON
   replies and a dump of every table are compared (ids and times normalized).
4. **Route coverage**: a script compares `openapi.json` with the Rust route table; zero missing before the switch.
5. **Migration differential**: for each of the 80 revisions, Python builds a database at that revision with sample
   rows, Rust upgrades it to head, and schema and rows are compared with Python's upgrade.
6. **End to end** with the real UI (Playwright) against the Rust server for the main flows.
7. Every process a test starts gets its own `KANBAN_CONFIG_DIR` and `KANBAN_DB_PATH`.

A phase is done when its ported tests pass on Python and on Rust, the differential run shows no difference, the area's
routes are all served, `cargo fmt` and `clippy -D warnings` are clean, and the checklist below is updated.

## Limits to know

- The work is done in a Linux container. Platform code for macOS and Windows (the sign-in PTY, process groups, the
  keychain, signing and packaging) is only compiled and tested in CI: **run a real desktop build before a release**.
- No real `claude` sign-in is possible in the container: the AI team is checked with `fake-claude` (a port of
  `tests/fixtures/fake_claude.py`) and with differential runs.
- PDF text extraction (`pypdf` to `pdf-extract`) can differ on complex PDFs; measured on the fixtures.

## Progress

Legend: `[ ]` not started, `[~]` in progress, `[x]` done and verified.

### P0 Ground and contract

- [x] Plan in the repo (this page)
- [x] Python reference server runs in the container (`uv sync`, `READY port=N`)
- [x] Contract snapshots: `openapi.json`, MCP replies, schema for three dialects (`server-rs/contract/`)
- [x] Cargo workspace with every crate stubbed
- [x] `testkit`: start either server on temporary folders, HTTP and MCP clients; route coverage
      (`cargo test -p kb-app --test route_coverage -- --nocapture`)
- [x] `sea-orm` on the three databases: one scenario passes on SQLite, PostgreSQL 16 and MariaDB 10.11
      (`scripts/dev-databases.sh start`, then `KANBAN_TEST_POSTGRES_URL` / `KANBAN_TEST_MYSQL_URL` for `cargo test -p kb-db`)
- [x] FTS5 `bm25` in the bundled SQLite (with the docs search port)
- [x] Golden vectors: `contract/golden/gen_<name>.py` writes `<name>.json` (first one: fuzzy scores)
- [x] Module dependency map: the crate order is base, db, files, notify, doctext, draw, docs, board, ideas, skills, ai,
      assist, dbkit, mcp, app; a call that goes up this order is a hook (PORTING.md)

### P1 Foundation (`kb-base`, `kb-db`, `kb-app`)

- [x] `config.py`, `version.py`, `app_logging.py` (`kb-log`), `api_secret.py`
- [x] `events.py` (pub/sub in `kb-base`, the database watcher in `kb-db`), `services/activity.py`,
      `services/ai/secrets.py` (`kb-base::secrets`), rapidfuzz scorers (`kb-fuzzy`)
- [x] `database.py`, `dbkit/targets.py`, `dbkit/types.py` (in the schema snapshots), `dbkit/sql.py`, `dbkit/changes.py`
      (upgrading an older database waits for P6: a database that is not at head is refused, never changed)
- [x] `models.py`: 77 entities generated by `contract/gen_entities.py` (request / response models go with each area)
- [x] `uploads.py`, `services/drawio_bundle.py`, Starlette's `FileResponse` (`kb-files`)
- [x] App shell from `main.py`: middlewares (CORS and HEAD as Starlette answers them), `/health`, `/version`,
      `/events`, uploads, static UI, draw.io, `READY`

### P2 Board (`kb-board`, `kb-notify`)

- [x] projects, members, git (`services/projects.py`, `members.py`, `git_repo.py`, `docs_access.py`, `api/projects.py`,
      `members.py`)
- [x] settings (`api/settings.py`, in `kb-skills` with the MCP clients it calls)
- [x] workspace (`services/workspace.py`, `api/workspace.py`)
- [x] tickets, part 1: the ticket itself, search, uploads (`services/tickets.py` to line 800, `ticket_guide.py`,
      `ticket_waves.py`, `proofs.py`, the core routes of `api/tickets.py`)
- [x] tickets, part 2: comments, criteria, sub-tasks, work log, test cases, blocks, links, branches, reopen, pending
      (all 43 routes of `api/tickets.py` are served)
- [x] notifications (`services/notifications.py`, `api/notifications.py`; the notification checks inside the docs and
      ticket suites are ported with those areas)
- [x] data and logs (`api/data.py`, `api/logs.py`)

### P3 Docs, drawings, ideas (`kb-docs`, `kb-draw`, `kb-ideas`)

- [x] the low-level Docs text modules (`docs_text`, `docs_anchors`, `docs_checklist`, `docs_edit`, `docs_templates`,
      `docs_guide` in `kb-doctext`)
- [x] docs, part 1: pages, versions, links, the bin, search with FTS5 (`services/docs.py`, `docs_search.py`,
      `docs_work.py`, 38 routes of `api/docs.py`)
- [x] docs, part 2: comments and import (`docs_comments.py`, `docs_import.py`, the other routes of `api/docs.py`)
- [x] diagrams and sketches (`services/diagram*.py`, `sketches.py`, `api/diagrams.py`, `sketches.py`)
- [x] canvases, part 1 (`services/canvases.py`, `canvas_png.py`, `canvas_html.py`, `canvas_locks.py`, 30 routes of
      `api/canvases.py`)
- [x] canvases, part 2: comment threads, delivery, design guide, screenshots (`canvas_comments.py`,
      `canvas_delivery.py`, `canvas_design.py`, `screenshots.py`, `visual_guides.py`; every route of
      `api/canvases.py` is served)
- [x] ideas (`services/idea_*.py`, `api/idea_space.py`, `idea_tickets.py`; the nine tests of the
      `f4a6b8c0d2e4` migration wait for the migration port)

### P4 MCP (`kb-mcp`)

- [x] the protocol (HTTP and stdio), registry, argument validation, instructions, the project tools
- [x] the ticket, item, branch and idea tools (`list_tickets`, `get_ticket`, `manage_ticket`, `ticket_items`,
      `ticket_branches`, the five idea tools)
- [x] `docs_read` and `docs_write` with every action (pages, comments, import, diagrams, sketches, canvases, pictures,
      guides)
- [x] `ai_run`, `ai_schedules`, `knowledge`, `board_wait` (200 recorded calls equal Python's; all 13 tools and the 5
      idea tools are served)
- [x] `mcp_stdio.py`, `mcp_bridge.py` (byte-equal to the Python programs)
- [x] `services/mcp_clients.py`, `shared_skills.py`, `role_skills.py`, skill assets (`kb-skills`; the skill folders are
      embedded unchanged)

### P5 AI (`kb-ai`, `kb-assist`)

- [x] base (`kb-ai`): store, config_model, paths, providers, ops, injection, hook_guard, pictures, power, quota, budget,
      profiles, mcp_sources, runner_link, audit, context, guard, comment_view, steps, transcripts
- [x] `kb-ai-know`: packs, roles, board_skills, memory, kb, knowledge, plugins
- [x] `kb-ai-work`: project_env, worktrees, github, timeline, flow, activity (the GitHub watcher runs from the app's
      lifespan)
- [x] `kb-ai-scan`: repo_scan (59 repository layouts give the same findings as Python; the rescan loop is wired into
      the app's lifespan with the runs port)
- [x] `kb-ai-run`, part 1: cli, stream, resources, accounts, signin; `fake-claude`, the stand-in CLI of the tests
- [x] `kb-ai-run`, part 2a: teams, launch (everything a run is started with equals Python in 52 situations)
- [x] `kb-ai-run`, part 2b: runs, messaging, `runner/`, the hook and event routes (16 run scenarios give the same
      answers, rows and events as Python, with the runs in the board's process and in the runner process)
- [x] `kb-ai-api`, part 1: the account, sign-in, knowledge and power routes (one account route waits for teams)
- [x] `kb-ai-run`, part 3: schedules, compact, session_history, touches, health (692 slot cases over 25 time zones
      and both clock changes, 34 loop stories compared row by row, the real loop with the stand-in CLI)
- [x] `kb-assist`, part 1: the assistant's engine and the Board AI chat (errors, settings, sessions, skills, drafts,
      receipt, engine, health, chat)
- [x] `kb-assist`, part 2: `assistant/docs.py`, `editor.py`, `ideas.py`, `services/docs_ai/` (the services; their
      routes are in the line below)
- [x] the assistants' routes: `assist.py`, `ai_editor.py`, `ai_sketch.py`, `idea_ai.py`, `api/docs_ai/`, and the four
      Docs hand-off routes of `api/docs.py` (370 recorded answers equal Python's)
- [x] the other AI routes: `api/ai.py`, `ai_board.py`, `ai_code.py`, `ai_tools.py`, `schedules.py` (route coverage:
      496 of 496; the order of the 126 AI routes equals Python's)

### P6 Database kit and migrations (`kb-dbkit`, `kb-db`)

- [x] `dbkit/probe.py`, `move.py`, `jobs.py`, `assist.py`, `cli.py`, `api/database.py` (a database made by the Rust
      server on PostgreSQL or MySQL is identical to one made by the Python server)
- [x] Migration runner that keeps `alembic_version` and orders revisions as Alembic does; the 80 revisions, each proven
      on SQLite against Python's upgrade of the same database (`contract/migrations/`, 90 fixtures), and the nine
      revisions after the head of 3.37.0 on PostgreSQL and MariaDB; a failed upgrade rolls back whole on SQLite and
      PostgreSQL

### Open issues (to close before the switch)

- MySQL only: the float columns are `FLOAT` (single precision) there. The Python driver read them as text (`0.1`); the
  Rust driver reads the 4-byte value (`0.10000000149`). Decide: a float type for the entities that reads as Python
  did, or widen the columns in the first Rust migration.
- `GET /database/command` still prints the `uv run python -m dbkit.cli` command outside a packaged app. The Rust CLI
  is `kanban-server db ...` (and `kanban-db ...` when the program is started under that name): change the text at
  the switch, and ship a `kanban-db` link or tell the packaged text to say `kanban-server db`.
- Hooks still without an implementation: `kb_board::hooks::{AiTeamsHook, AiRunsHook}`, `kb_dbkit::hooks::AssistantHook`,
  `kb_docs::hooks::{AiGuardHook, AssignHook, CommentsHook, CanvasesHook}`, `kb_draw::hooks::{CanvasDocs, CanvasDelivery}`. Hooks are
  registered in `kb-app/src/hooks.rs`.
- Tests waiting for another port:
  the docs tools tests of MCP.
- A JSON body that leaves out several required fields names only the first in the 422; FastAPI lists all.
- `kb_base::time::parse_iso` accepts shapes `datetime.fromisoformat` refuses; `kb_ai::store::parse_iso` is the exact
  port. Make the exact one the shared one.
- `Session` has no savepoint (`begin_nested`): `transcripts::finish` logs a failed FTS statement and commits.
- PDF text (`pdf-extract`) equals `pypdf` on the test fixtures; on the repository's own PDFs it differs in whitespace
  (`pypdf` splits Vietnamese words) and in one file in the bullet character. Accepted unless search quality suffers.
- On Windows `kb-ai-run` has only been type-checked in part (no Windows C toolchain here): it compiles first in CI.
- `kb_assist::seams::Runs::wake_new_assignee` gives no error: a failure to start the run of a page's new assignee is
  logged, where Python answers 500.
- The servers under test run in a time zone where it is morning (`testkit::morning_zone`, the `TZ` variable): from
  18:00 on a working day the board writes each person's card of the day, and tests that count notification rows
  failed in the evening on both servers.
- The template database of `testkit` no longer carries the workspace settings of the server that made it (three
  recorded MCP files held a stale folder because of it and were recorded again).
- The UI end-to-end check (`server-rs/e2e`, `node run.mjs --target both`) with every route served: 137 core steps and
  the 10 AI screens pass on both servers with no console error. What still differs is expected (the version number,
  the development command of the MCP entry) or changes from run to run (whether the toast of a mention is shown
  before the page marks it read). The servers run in the morning zone here too. draw.io is not covered (the editor
  is not in the checkout).
- To do at the switch, found while writing the documentation: `docs/guideline/guide/facts.py` reads Python files of
  the server (version, MCP tools, models): read them from `Cargo.toml` and `contract/` instead; the `Databases` job
  of `ci.yml` is switched off (`if: false`); the README's feature list still names API-key models, which 4.0.0
  removed. `kanban-server --port N` serves on a fixed port for the UI's dev server (8000).
- Tests that need the UI not to be built read the index page as the recorded 404 (`Resp::is_ui_index` in
  `testkit`), since both servers fall back to `ui/dist` of the checkout.
- The sign-in route writes its audit entry through a private copy of `touches.record_signin` in
  `kb-ai-api/src/api/ai_accounts.rs`; replace it when `touches` is ported.
- `kb_base::activity` has no getter for the "suggested by" value (`kb-ai-work` reads it through `entry`).
- Size: the release binary of `kanban-server` was 68 MB on Linux. `kanban-mcp-stdio` is now a launcher of well under
  1 MB that hands over to `kanban-server mcp-stdio` beside it (on Unix it becomes that program; on Windows it runs it
  as a child and waits: try a real MCP client on Windows before the release). Still to try: a size-optimised release
  profile and one copy of the embedded assets.
- Before this work already: the x64 macOS dmg carries an arm64 server (the build uses the host architecture only).
  `MACOS_UNIVERSAL=1` in `build-server.sh` builds both and joins them; the workflows do not set it yet.
- `kb_base::secrets` has no test backend for the keychain: the two tests of `test_ai_keychain.py` are not ported.
- Carried over from Python unchanged, to review after the switch: the screenshot helper's local server lists
  directories, and its host check lets decimal and hexadecimal IP hosts through.

### P7 Switch

- [x] The development command of the MCP entry is the workspace's `target/debug/kanban-mcp-stdio`
      (`kb_skills::mcp_clients`); the demo skill's `start_board.py` builds and starts `kanban-server`; the database
      command text (`GET /database/command`) names the running program (`<kanban-server> db ...`)
- [ ] One copy of the BA templates and the design examples (now in `kb-skills`, `kb-doctext` and `kb-draw`)

- [x] Desktop: `build-desktop.sh`, `desktop/scripts/build-server.sh` (a release build and a smoke test),
      `desktop/package.json`, `main-helpers.js` (development starts `server-rs/target/debug/kanban-server`;
      `KANBAN_SERVER_BIN` overrides); the PyInstaller spec and script are removed. Not run on macOS or Windows yet
- [x] CI: `ci.yml` (fmt, clippy, and `cargo check` on macOS and Windows), `release.yml`, `nightly-quality.yml`,
      `sonar-project.properties`; the jobs the owner had switched off stay off. The workflows have not run yet
- [x] `SERVER_DIR` in `desktop/scripts/build-server.sh`, `desktop/main-helpers.js` and the three workflows, and the
      paths in `sonar-project.properties`, name `server/`
- [x] The 4.0.2 and 4.0.3 fixes of the Python server (merged from `main` during the port) are ported: runner
      announcements, the SQLite write gate, no lost ticket changes, faster Docs pages, the port kept across restarts
- [x] The Python server is deleted and `server-rs/` is `server/`. The last commit with the Python server is the parent
      of the commit that removed it (`git log --diff-filter=D -- server/main.py`). Its recorded answers stay in
      `contract/golden/` as the expected values; the generators (`gen_*.py`, `export_contract.py`, `gen_entities.py`)
      and the `PARITY_TARGET=python` mode went with it (the test harness says so when asked for it)
- [x] `CLAUDE.md`, READMEs, `docs/arch/backend-architecture.md`, `docs/guideline/databases.md`, the guide's
      `facts.py` and cover version, `CHANGELOG.md` (5.0.0); the app's version is 5.0.0 (`desktop/`, `ui/`)
- Left: the guide's three AI facts (`ai_parallel`, `ai_runs_per_day`, `ai_daily_budget`) read
  `server/services/ai/members.py`, which 4.0.0 removed (AI v2): the guide build has failed on them since 4.0.0, and
  the chapters that use them describe limits AI v2 no longer has. They need a rewrite of those chapters.

### P8 Acceptance

- [ ] Whole Rust suite, differential runs, migration differential, UI end to end
- [ ] Start time, memory and installer size against 4.0.1
