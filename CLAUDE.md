# Code navigation

This repo has a CodeGraph index (symbols, calls, imports for the Rust server and the TS/React UI), exposed as the `codegraph` MCP server (`.mcp.json`, `.vscode/mcp.json`).

- To find callers, callees, or the blast radius of a symbol, or to explore an unfamiliar area, use `codegraph_explore` before reading files or grepping.
- Several symbols share names (for example `clean_title` exists in `server/crates/kb-board/src/tickets/validate.rs` and in `server/crates/kb-docs/src/docs/pages.rs`, and a third one in `server/crates/kb-doctext/src/docs_checklist.rs`); the results list each definition separately, so check the file before editing.
- If the MCP tool is not available, use the same index from the shell: `.claude/scripts/codegraph.sh run callers <symbol>` (also `callees`, `impact`, `query`, `node`, `context`).
- The index is local (`.codegraph/`, git-ignored) and is synced by `.claude/scripts/codegraph.sh`; the CLI version is pinned there.

# Subagents and models

Do not spawn subagents by reflex. Each one costs tokens, often has to gather context you already have, and loses detail in the handoff. A subagent gives you parallelism, a clean context or a fresh pair of eyes, not a smarter answer.

- **Do it yourself** when the task is quick: a handful of tool calls, a lookup whose target you already know, one edit, or a check you can run inline.
- **Delegate** only when it pays: a wide search or a long test run whose output would otherwise fill your context, independent pieces that can run in parallel, or a review by an agent that has not seen how the code was written.
- **Split by context, not by type of work.** Good cuts: independent search paths, components with clean interfaces, checking a finished result. Do not chain agents by role (plan → implement → test → review), and do not split sequential steps of one change or tightly coupled code; do those yourself.
- **At most 3 subagents at a time.** If there are more pieces, run them in waves or do the small ones yourself. If the user asked for a specific number, spawn exactly that many.
- **Brief each one fully**: the goal, the files, what is already ruled out, and what done looks like. No two agents edit the same files, and none waits on another's result. Ask for a short summary back, not raw output.
- **Check what comes back** before relying on it, and do not redo a delegated task yourself. A verifier must run every test related to the change (see Tests below, not just one or two), check against concrete criteria, and report only what affects correctness, not style.

Pick the model and effort for each subagent from the task, not by default:

| Task | Model | Effort |
|---|---|---|
| Mechanical, read-only work: find files or symbols, list callers, grep, read logs, run tests and report the output | `haiku` (often with the `Explore` agent type) | `low` |
| Routine work with a clear spec: implement a well-defined change, write or fix tests, small refactors, review a narrow diff | `sonnet` | `medium` |
| Work that needs the same judgment as you: design-heavy changes, cross-cutting refactors, tricky debugging | the same model as the main session (or a `fork`) | `medium`; `high` or `xhigh` when getting it right depends on cases that are easy to miss (a bug in unfamiliar code, a flaky test, a schema change with many readers) |
| Stuck, no clear way forward, or a decision that needs a second opinion | first the same model at higher effort; only if that still falls short, one tier up (`haiku` → `sonnet` → `opus` → `fable`) | `high` or `xhigh` |

- **Start cheap and escalate on evidence.** Raise the effort first and the model second, and only when a cheaper run came back wrong or thin. When the result can be checked (tests, a verifier), run at low effort and re-run only the failures at `high`.
- Keep `max` for a hard problem worked through without the user (a security hunt); on ordinary work it overthinks.
- An escalation agent is a consultant: give it the code and the facts, ask for a recommendation, and do the implementation yourself (or with a cheaper agent) once the way forward is clear.

# Tests

Run only the tests related to what you changed, never the whole suite (it is slow, and some tests fail in a cloud container for reasons that have nothing to do with the change). Related means:

- in `server/` (the Cargo workspace, one crate per area): `cargo test -p <crate>` for each crate you changed, or one file with `cargo test -p <crate> --test <file>`. When you changed a public function, also the crates that use it (`cargo tree -i <crate> --depth 1` lists them, or use CodeGraph `callers`). The suite of each area:
  - Docs (pages, versions, search, comments, import): `kb-docs`; the Docs text and access rules: `kb-doctext`;
  - the MCP layer (protocol, stdio and the bridge, the tools, including the Docs tools): `kb-mcp`; for the tool list or the instructions: `tests/test_mcp_tool_quality.rs`;
  - the board's skills and the MCP client installs: `kb-skills`;
  - the AI team: `kb-ai` (base), `kb-ai-know`, `kb-ai-work`, `kb-ai-run` (runs, launch, teams, schedules, the runner), `kb-ai-scan`, and its routes `kb-ai-api`, with the `test_ai_*` files of the module you changed; the assistants (Board AI, Docs AI, editor and ideas AI): `kb-assist`;
  - tickets, projects, members, workspaces, data and logs: `kb-board`; drawings and canvases: `kb-draw`; ideas: `kb-ideas`; notifications: `kb-notify`;
  - the database layer and the migrations: `kb-db`; moving data between databases and the `kanban-db` command: `kb-dbkit`;
  - the app shell (middlewares, `/events`, uploads, the static UI, the route table): `kb-app`;
- in `ui/`, `npx vitest run <the folders you changed>` plus `npx tsc --noEmit -p .`, eslint and prettier on the files you touched;
- in `desktop/`, `npm test` when you changed `desktop/`.

Tests that go through HTTP or MCP use the `testkit` crate, which starts the built server binary, so build it first, from `server/`: `cargo build -p kanban-server -p kanban-mcp-stdio -p fake-claude` (`KANBAN_SERVER_BIN` names another binary; the default is `target/debug/kanban-server`). A test that starts a process (a real server, the AI runner) must give it its own `KANBAN_CONFIG_DIR` and `KANBAN_DB_PATH`: `testkit` does, so start servers only through it and never remove that. Without them the process opens the database named in the developer's `~/.kanban-board/config.json` and migrates it. The tests that need PostgreSQL or MariaDB are skipped unless `KANBAN_TEST_POSTGRES_URL` / `KANBAN_TEST_MYSQL_URL` is set (`server/scripts/dev-databases.sh start` starts both).

Find the related suites with CodeGraph (`callers`, `impact`) or a grep for the module's name in `server/crates/*/tests` and the `*.test.ts(x)` files. Say in the PR which suites you ran. Run the whole suite only when the user asks for it.

# Pull requests

Every pull request you create gets an assignee and labels. If the tool that creates it cannot set them (the GitHub MCP `create_pull_request` cannot), set them right after with `issue_write` (`method: update`, the PR number as `issue_number`):

- **Assignee**: `iamcaominhtien`.
- **Labels**: every label that fits, from the repo's existing labels first. If none of them fits, create a new one (short, lowercase, in the style of the existing ones) and use it.
  - `bug`: fixes broken behavior.
  - `enhancement`: a new feature, an improvement, or a chore or CI change.
  - `documentation`: design docs, guides, README or other docs.
  - `dependencies`: adds, removes or bumps a dependency (`Cargo.toml`/`Cargo.lock`, `package.json`/lockfiles).
