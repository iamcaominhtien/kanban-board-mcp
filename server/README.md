# Kanban Board MCP — Server

The board's backend, a Cargo workspace. It serves the **REST API** the React UI uses, the live **event stream**
(`/events`) and the **MCP (Model Context Protocol)** server AI agents use, on SQLite (the default), PostgreSQL or
MySQL/MariaDB. It is one native program with no runtime to install; the desktop app ships it as it is.

How the crates fit together: [`docs/arch/backend-architecture.md`](../docs/arch/backend-architecture.md). Databases:
[`docs/guideline/databases.md`](../docs/guideline/databases.md).

## The programs

`kanban-server` is the program. What it does depends on its first words:

| Command | What it is |
|---|---|
| `kanban-server` | The HTTP server: REST, the `/events` stream and MCP over HTTP at `/mcp/`. It picks a free port on `127.0.0.1`, prints `READY port=<N>`, and reads the API secret from its standard input when `KANBAN_API_SECRET_STDIN=1` (what the desktop app does). |
| `kanban-server --runner` | The AI runner process. The server starts it itself (it sets `KANBAN_RUNNER=process` unless the variable is already set); you do not start it by hand. |
| `kanban-server mcp-stdio` | The stdio MCP server that editors and AI clients start. `kanban-server mcp-stdio --bridge` forwards stdio to the board's HTTP MCP endpoint with an AI run's token. |
| `kanban-server db <test\|migrate\|use> ...` | The `kanban-db` command line: test a database, copy the board between databases, point the app at one. It is the same program under the name `kanban-db` (a link to `kanban-server`). |
| `kanban-server --routes` | Prints the table of REST routes as JSON and exits. |

`kanban-mcp-stdio` is a small launcher that sits next to `kanban-server` and hands over to
`kanban-server mcp-stdio` with the same standard input and output. It exists so that MCP client entries made by
earlier versions (they name `kanban-mcp-stdio`) keep working.

## The crates

One crate per area, so an area builds and tests on its own. An area's REST routes and MCP operations live in its crate.
A crate depends only on the ones above it in this table; a call that has to go upward is a hook, declared in the lower
crate and registered in `crates/kb-app/src/hooks.rs`.

| Crate | What it holds |
|---|---|
| `kb-base` | What every area shares: configuration, time and JSON in the stored formats, errors as the REST API answers them, the router (`routes`), the actor context, the event bus, secrets, the API secret |
| `kb-log` | The application log (a size-rotating file) and its export |
| `kb-fuzzy` | The fuzzy-search scores (`ratio`, `partial_ratio`, `token_sort_ratio`, `WRatio`) |
| `kb-db` | The database: targets and engine, sessions, the 77 entities, the schema per engine, the 80 migrations, the change log |
| `kb-files` | The uploads folder, the draw.io editor that ships with the app, file responses |
| `kb-dbkit` | Probing a database, copying between databases, the `kanban-db` command, the database routes |
| `kb-notify` | The notification centre and its loop |
| `kb-doctext` | Docs text and access rules shared by the areas that touch Docs |
| `kb-draw` | Diagrams, sketches, canvases, screenshots and exports |
| `kb-docs` | The Docs space: pages, versions, links, the Recycle Bin, search, comments, import |
| `kb-board` | Projects, members, the project's git repository, tickets, workspaces, data backup, logs |
| `kb-ideas` | The Idea Space |
| `kb-skills` | The skills handed to AI agents, the MCP client installs, the Settings routes |
| `kb-ai` | The AI team's base: store, limits, guard, audit, quota, the link to the runner |
| `kb-ai-know` | Role packs, the board's own skills, memory, the knowledge base, plugins |
| `kb-ai-work` | Project environments, git worktrees, the pull request watcher, timeline, flow, activity |
| `kb-ai-run` | The Claude Code CLI and its stream, accounts and sign-in, launch, teams, runs, schedules, the runner |
| `kb-ai-scan` | The repository scan that proposes how a team should work |
| `kb-ai-api` | The AI team's REST routes |
| `kb-assist` | The assistants (Board AI, Docs AI, editor and ideas AI) and their routes |
| `kb-mcp` | The MCP server: JSON-RPC over stdio and HTTP, the tool list, the tools |
| `kb-app` | The app: the router of every area, the middlewares, `/events`, the static UI, what runs for the app's lifetime |
| `bins/kanban-server`, `bins/kanban-mcp-stdio` | The two programs above |
| `testkit` | The test harness: starts the built server on temporary folders, with HTTP, MCP and event-stream clients |
| `fake-claude` | A stand-in for the Claude Code command line, for tests |

## Build

Needs the Rust toolchain (`rust-version` in `Cargo.toml`).

```bash
cd server
cargo build -p kanban-server -p kanban-mcp-stdio -p fake-claude   # debug build, in target/debug/
cargo build --release --locked -p kanban-server -p kanban-mcp-stdio
```

The desktop app's own build, `desktop/scripts/build-server.sh`, runs the release build and a smoke test, and lays
the two programs out in `dist-server/kanban-mcp-stdio/`.

## Run in development

```bash
cd server
cargo run -p kanban-server       # prints READY port=<N>; the database is created and migrated on first start
```

The server opens the database named in `~/.kanban-board/config.json`. To keep a trial run away from your own data, give
it its own folders, as the tests do:

```bash
KANBAN_CONFIG_DIR=/tmp/kb/config KANBAN_DB_PATH=/tmp/kb/data/kanban.db cargo run -p kanban-server
```

It serves the built UI from `ui/dist` (or the folder `KANBAN_UI_DIST` names); for the UI in development run
`npm run dev` in `ui/` as well. The desktop app in development (`cd desktop && npm run dev`) starts
`target/debug/kanban-server`; `KANBAN_SERVER_BIN` names another program.

## Test

```bash
cd server
cargo build -p kanban-server -p kanban-mcp-stdio -p fake-claude     # the tests that go through HTTP or MCP start this build
cargo test -p kb-docs                                               # one crate
cargo test -p kb-docs --test test_docs                              # one test file
```

Run the crates you changed, not the whole workspace. Tests that go through HTTP or MCP use `testkit`: it starts
`target/debug/kanban-server` (`KANBAN_SERVER_BIN` names another build) on a temporary folder with its own
`KANBAN_CONFIG_DIR`, `KANBAN_DB_PATH`, log, workspace and uploads folders, and it removes every `KANBAN_*` variable of your
environment, so a test never touches your data. Start servers in tests only through it.

PostgreSQL and MariaDB: `scripts/dev-databases.sh start` starts a local PostgreSQL and MariaDB (needs their server
programs installed) and prints the two URLs; give them to the tests as `KANBAN_TEST_POSTGRES_URL` and
`KANBAN_TEST_MYSQL_URL`. The tests that need them are skipped when the variables are not set. `scripts/dev-databases.sh stop`
removes them.

Format and lint before you finish a crate: `cargo fmt -p <crate>` and `cargo clippy -p <crate> --all-targets -- -D warnings`.

## `contract/`

Recorded files from the Python server (4.0.1) that the Rust server is held to. They are the expected values of the tests
and, for two of them, part of the build:

- `openapi.json`: every route and model. `cargo test -p kb-app --test route_coverage` compares it with the route table
  (`ROUTE_COVERAGE_STRICT=1` makes a missing route a failure too).
- `mcp-initialize*.json`, `mcp-tools*.json`: the MCP `initialize` and `tools/list` replies (the `-ideas` files are the
  ones with the Idea Space tools on). **`kb-mcp` embeds the `mcp-tools*.json` files and serves the tool list from them**, so
  a change to a tool's description or schema is a change to these files.
- `schema-sqlite.sql`, `schema-postgres.sql`, `schema-mysql.sql`, `alembic-head.txt`: the schema at the newest revision.
- `golden/`: recorded answers (HTTP and MCP), and the output of pure functions (scores, slugs, anchors, Markdown and HTML
  handling, schedule slots across clock changes, `pyjson`). The tests assert against them.
- `migrations/`: a database at each of the 80 revisions (`fixtures/`) and what upgrading it must give (`expected/`).

The Python server and the scripts that generated these files (`gen_*.py`, `export_contract.py`) are gone, and so is the
`PARITY_TARGET=python` mode of `testkit`. The recorded files stay as the regression baseline: do not regenerate them to
make a test pass; change one only when the behavior was meant to change.

## `e2e/`

A Playwright check of the real UI against the server: headless Chromium, one server per scenario on its own temporary
folders, 21 scenarios and 375 steps. Each server gets a stand-in AI (`fake-claude` behind a `claude` script on its
`PATH`, a signed-in account, a sample git repository), so the AI screens run without tokens. It needs the built server
and stand-in (`cargo build -p kanban-server -p kanban-mcp-stdio -p fake-claude`), the built UI (`cd ui && npm ci &&
npm run build`) and Playwright installed globally (`NODE_PATH`).

| Scenarios | What they cover |
|---|---|
| 01–04 | first start, members, tickets (create, edit, parts, relations, move, filter, delete), attachments |
| 05–07 | Docs (pages, publish, versions, search, links, comments, bin, import), Markdown import, drawings (a sketch, a canvas; a diagram without its editor) |
| 08–11 | Idea Space, notifications, settings, live sync between two browsers |
| 13–16 | ticket lifecycle (won't do, reopen, pending, trash, sub-tickets), board views and filters, a ticket's items (criteria, sub-tasks, test cases, work log, links, activity), repository and branches (worktree, graph, merge) |
| 17–18 | file previews (PDF, Word, Excel, PowerPoint, CSV, JSON, Markdown, HTML, audio, ZIP), the Docs editor (slash menu, formatting, table, callout, math, code, find and replace, export) |
| 19–21 (`ai`) | Docs AI, the AI team (accounts, teams, runs, a question answered, the AI Team pages, Settings > AI, schedules, Board AI), the rest of Idea Space (matrix, evidence, Ask AI chat, settings) |
| 22 | appearance, workspace, database wizard, MCP integrations, logs, keyboard, follow bell, notification settings |

Not covered: the draw.io editor (not in the checkout), a real Claude sign-in, the desktop-only windows and OS
notifications.

```bash
cd server/e2e
node run.mjs --target rust                 # all scenarios
node run.mjs --target rust --only 03,05    # some of them (by number)
node run.mjs --target rust --group core    # or ai
```

Screenshots and the report go to `e2e/report/` (`--report <folder>` elsewhere). `E2E_SOFT=1` keeps a scenario going
after a failed step.

The scenarios were written against the Python server of 4.0.3 first. To compare again, check out its last commit
(`36352ea`) in a worktree, run `uv sync` in its `server/`, and run both: `report/diff.md` lists every step whose
answers or screen differ.

```bash
E2E_PYTHON_SERVER=/path/to/worktree/server node run.mjs --target both
```

`stress.mjs` measures the server under load: one project with 81 tickets and 445 Docs pages, N agents calling a mix of
MCP tools (paced at one call a second each, then as fast as they can) while a browser on the shared ticket sends
comments and times them; calls per second, latency per tool, CPU and memory of the server's processes, and every saved
comment looked for at the end. Build the release server first; a database server for `--db postgres|mysql` comes from
`scripts/dev-databases.sh start` (the run makes and drops its own database there).

```bash
cd server/e2e
KANBAN_SERVER_BIN=../target/release/kanban-server node stress.mjs --db sqlite --json sqlite.json
KANBAN_TEST_POSTGRES_URL=postgresql://kanban@127.0.0.1:55432/kanban_test KANBAN_SERVER_BIN=../target/release/kanban-server node stress.mjs --db postgres
```
