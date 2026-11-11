# Porting rules (Python server to Rust)

Read `docs/specs/rust-migration.md` first for the plan. These are the rules every port follows, so the crates read
as one codebase and behave as the Python server does. The Python code in `server/` is the specification: port what it
does, including the odd cases, and do not improve behavior on the way.

## General

- Rust 2024, workspace in `server-rs/`. One crate per area (`crates/kb-*`). Declare a crate's dependencies in its own
  `Cargo.toml`; use `{ workspace = true }` for the ones listed under `[workspace.dependencies]` and a pinned version
  for others. Do not edit the workspace `Cargo.toml` or another crate unless your task says so.
- Keep the Python module layout: `services/foo.py` becomes `src/foo.rs` with the same function names (snake_case) and
  the same order, so the two can be read side by side. Carry the docstrings and the comments that explain *why* over
  as doc comments (`///`, `//!`); every public item has one.
- No `unwrap()` / `expect()` outside tests unless the invariant is stated in the message. No `unsafe`.
- Before you finish: `cargo fmt -p <crate>`, `cargo clippy -p <crate> --all-targets -- -D warnings`,
  `cargo test -p <crate>`.
- Text the user or an AI agent reads (error messages, `detail` strings, tool descriptions, prompts) is copied
  **character for character**. Search the Python source for the exact wording; never paraphrase.

## Formats that must not drift (`kb-base`)

- Times: `kb_base::time::now_iso()` is `datetime.now(timezone.utc).isoformat()`; parse with `time::parse_iso`.
  Time columns are strings and are compared as text.
- JSON kept in TEXT columns or built with `json.dumps`: `kb_base::pyjson::dumps` (Python's separators and ASCII
  escapes). `json.dumps(x, indent=2)`, `sort_keys=True`, `ensure_ascii=False` and `separators=(",", ":")` are options
  of `pyjson::Dumps`. `serde_json` keeps key order (`preserve_order`), like a Python dict: build objects in the same
  key order as the Python code.
- Ids: `time::uuid4()` for `str(uuid.uuid4())`, `time::uuid4_hex()` for `uuid4().hex`.
- Python truthiness (`if value:`, `value or default`) differs from `Option`: an empty string, `0`, an empty list are
  false. Port each test as written (`pyjson::truthy` for JSON values).
- String lengths and slices in Python count characters, not bytes: use `.chars()`.

## Errors

- `HTTPException(status, detail)` is `kb_base::ApiError::new(status, detail)` (`ApiError::not_found("...")` and
  friends). Handlers return `ApiResult<T>`.
- A service that raises its own exception type (`ValueError`, `DocsError`, `LookupError`...) gets an error enum in its
  module with the same cases; the router maps it to `ApiError` exactly where the Python router has its `except`.
- Request bodies use `kb_base::error::Body<T>` (not `axum::Json`), query strings `kb_base::error::Query<T>`, path
  values `kb_base::error::Path<T>`: they answer 422 in FastAPI's shape.

## Context and events

- `ContextVar`s are `kb_base::ctx` values (`ctx::set`, `ctx::get`, `ctx::reset`); the actor and AI attribution are in
  `kb_base::activity`. Start a task that must inherit the context with `ctx::spawn`, not `tokio::spawn`.
- `events.publish(...)` is `kb_base::events::publish(event, topics).await`; typed events `events::publish_typed`.

## Processes and tests

- Every process a test starts gets its own `KANBAN_CONFIG_DIR` and `KANBAN_DB_PATH` (and log, workspace and uploads
  folders). `testkit` does this; never start a server another way.
- Golden vectors: when a pure function must give exactly what the Python one gives (scores, slugs, parsed text), add a
  generator `contract/golden/gen_<name>.py` (run with `server/.venv/bin/python` from `server/`) that writes
  `contract/golden/<name>.json`, commit both, and assert against the JSON in a Rust test.
