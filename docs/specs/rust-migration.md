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
- [ ] Spikes left: FTS5 `bm25` in the bundled SQLite (with the docs search port)
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
- [ ] `uploads.py`
- [~] App shell from `main.py`: middlewares, `/health`, `/version`, `/events`, `READY` done; uploads, static UI and
      draw.io in progress (`kb-files`, `kb-app`)

### P2 Board (`kb-board`, `kb-notify`)

- [ ] projects, members, settings (`services/projects.py`, `members.py`, `api/projects.py`, `members.py`, `settings.py`)
- [ ] workspace and git (`services/workspace.py`, `git_repo.py`, `api/workspace.py`)
- [ ] tickets (`services/tickets.py`, `ticket_guide.py`, `ticket_waves.py`, `proofs.py`, `api/tickets.py`)
- [ ] notifications (`services/notifications.py`, `api/notifications.py`)
- [ ] data and logs (`api/data.py`, `api/logs.py`)

### P3 Docs, drawings, ideas (`kb-docs`, `kb-draw`, `kb-ideas`)

- [ ] docs (`services/docs*.py`, `api/docs.py`)
- [ ] diagrams, sketches, canvases, screenshots (`services/diagram*.py`, `sketches.py`, `canvas*.py`, `screenshots.py`,
      `visual_guides.py`, `drawio_bundle.py`, `api/diagrams.py`, `sketches.py`, `canvases.py`)
- [ ] ideas (`services/idea_*.py`, `api/idea_space.py`, `idea_tickets.py`)

### P4 MCP (`kb-mcp`)

- [ ] registry, instructions, tools, operations (`kanban_mcp/`)
- [ ] `mcp_stdio.py`, `mcp_bridge.py`
- [ ] `services/mcp_clients.py`, `shared_skills.py`, `role_skills.py`, skill assets

### P5 AI (`kb-ai`, `kb-assist`)

- [ ] (a) store, guard, secrets, accounts, signin, cli, stream, steps, launch, runs, runner_link, `runner/`
- [ ] (b) schedules, worktrees, github, repo_scan, plugins, packs, board_skills, mcp_sources, kb, knowledge,
      transcripts, timeline, touches, health, resources, quota, budget, power, flow, teams, profiles and the rest
- [ ] (c) `services/assistant/`, `services/docs_ai/`, `api/ai*.py`, `assist.py`, `schedules.py`, `idea_ai.py`,
      `api/docs_ai/`

### P6 Database kit and migrations (`kb-dbkit`, `kb-db`)

- [ ] `dbkit/probe.py`, `move.py`, `jobs.py`, `assist.py`, `cli.py`, `api/database.py`
- [ ] Migration runner that keeps `alembic_version`; the 80 revisions; a new database from the snapshot, stamped head

### P7 Switch

- [ ] Desktop: `build-desktop.sh`, `desktop/package.json`, `main-helpers.js`; remove the PyInstaller spec and script
- [ ] CI: `ci.yml`, `release.yml`, `nightly-quality.yml`, `sonar-project.properties`
- [ ] Delete the Python server, move `server-rs/` to `server/`
- [ ] `CLAUDE.md`, `.claude/scripts/codegraph.sh`, READMEs, `docs/arch/backend-architecture.md`,
      `docs/guideline/databases.md`, `CHANGELOG.md` (5.0.0)

### P8 Acceptance

- [ ] Whole Rust suite, differential runs, migration differential, UI end to end
- [ ] Start time, memory and installer size against 4.0.1
