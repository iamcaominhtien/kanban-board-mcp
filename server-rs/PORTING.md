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

## The database (`kb-db`)

- `database.async_session()` / `Depends(get_session)` is `kb_db::session()`: a `Session` that implements SeaORM's
  `ConnectionTrait`, so every query takes `&session`. It follows the Python server's transaction rules: reads run
  without a transaction until the first write, the first write opens one, `session.commit().await?` makes it
  permanent, and dropping the session without a commit rolls back. Commit exactly where the Python code commits.
  There is no unit of work: where Python changes an attribute of a loaded row and commits, write the UPDATE
  (`row.into_active_model()`, set the changed columns, `.update(&session)`). `session.flush()` and
  `session.refresh(row)` need no call (an insert or update returns the stored row).
- Tables are the generated entities `kb_db::entities::<table>` (`Model`, `Entity`, `Column`, `ActiveModel`).
  `entities::<table>::new()` is an `ActiveModel` with the defaults the Python model gives a new row (ids, times,
  `"[]"`...): start from it and set what the Python code sets. Do not edit the generated files; if one is wrong, say
  so in your report.
- Columns are what the database holds: times are ISO strings, lists and objects are JSON text. Parse and write them
  with `serde_json` / `kb_base::pyjson` exactly where the Python code calls `json.loads` / `json.dumps`.
- Foreign keys are **not** enforced on any engine and the code relies on it. Table metadata (columns, kinds, what
  points at what) is in `kb_db::entities::META` for code that walked `SQLModel.metadata`.
- Queries must run on SQLite, PostgreSQL and MySQL: use the SeaORM query builder. For the few hand-written
  statements use `kb_db::sql::statement(backend, "... ? ...", values)` (it renumbers placeholders for PostgreSQL),
  and branch on `session.dialect()` (`"sqlite" | "postgresql" | "mysql"`) exactly where the Python code branches on
  `dialect.name`. `kb_db::database::insert_missing` is `database.insert_missing`; `kb_db::sql::bump_counter` is
  `dbkit.sql.bump_counter`. `IntegrityError` is `DbErr::sql_err()` giving `SqlErr::UniqueConstraintViolation`.
- `kb_db::database::{is_sqlite, get_db_path, get_data_dir, current_target}` are the functions of `database.py`.

## REST routes

- A router file `api/foo.py` becomes `src/api/foo.rs` in the area's crate and exposes `pub fn routes() -> Routes`
  (`kb_base::Routes`): `.get("/projects/{project_id}", handler)`, `.nest("/prefix", inner)`. The crate's
  `api::routes()` merges its files in the order `main.py` includes the routers; `kb-app` already merges every crate.
- Keep the path exactly as FastAPI has it, with one exception: at the same position of a path, every route must use
  the **same parameter name** (axum refuses `/a/{x}` next to `/a/{y}/b`). Pick one name per position.
- Request and response models (`ProjectCreate`, `ProjectRead`... in `models.py` from line 2031, or declared in the
  router file) become `serde` structs in the area crate, next to the code that uses them, with the same field names,
  order and defaults. A response model lists exactly its fields in its order (FastAPI drops anything else).
  `Optional` fields that the Python model defaults to `None` are `Option<T>` with `#[serde(default)]`; a Python
  `model_dump(exclude_none=True)` / `exclude_unset=True` must be reproduced (for `exclude_unset`, use
  `Option<Option<T>>` or a `serde_json::Map` to tell "absent" from "null").
- Status codes as declared (`status_code=201` and so on); a handler that returns `None` with 204 has no body.
- After a change the Python handler calls `events.publish("invalidate", ...)`: call it at the same point.
- The actor of a request is `kb_base::activity::current_actor()`.
- When Python calls into an area that is above this crate in the dependency order (a late `import` inside a
  function, e.g. tickets calling the AI team), declare a hook in this crate: a trait with the functions needed and a
  `static HOOK: OnceLock<Box<dyn Trait>>` with a `set_...` function; call through it and do nothing when it is not
  set. Say which hooks you added in your report; the upper crate's port will fill them.

## Tests

- Port the area's pytest files to `crates/<crate>/tests/<same name>.rs`, one `#[tokio::test]` per Python test with
  the same name and the same assertions, going through the real server with `testkit` (`testkit::Server::start()`,
  `.client()`, `.mcp()`, `.events()`): see `crates/testkit/tests/selftest.rs`. A test that calls service functions
  directly and cannot be expressed through HTTP or MCP becomes a unit test of the Rust module.
- Run the ported file against the Python reference first: `PARITY_TARGET=python cargo test -p <crate> --test <file>`.
  It must pass there (that proves the test was ported faithfully). Then build the server
  (`cargo build -p kanban-server`, in your own `CARGO_TARGET_DIR`, and set `KANBAN_SERVER_BIN` to that binary) and
  make it pass with `PARITY_TARGET=rust`. A test that fails on Python is a wrong port of the test, not a reason to
  change the test until it passes on Rust.
- A reply compared across both servers: compare parsed JSON (key order and spacing of a JSON *response* do not
  matter; the bytes of what is *stored* do).

## The pattern to copy

`crates/kb-board` is the worked example: `src/projects.rs` and `src/members.rs` (services), `src/api/projects.rs`
(a router), `src/schemas.rs` (request and response models), `src/hooks.rs` (a hook into an upper area),
`tests/test_projects.rs` (a ported pytest file with differential checks) and `tests/common/mod.rs`. Read them before
you write anything, and write yours the same way.

- **Errors of a service.** A module whose functions raise gets one `Error` enum: a case per Python exception type
  it raises (`Value(String)` for `ValueError`...), `Db(DbErr)` with `impl From<DbErr>`, and where needed
  `Other(String)` for anything that is a 500. The router maps it to `ApiError` in one small function that mirrors
  the Python `except` clauses.
- **Names.** A Python `_private` function that another module calls loses its underscore and is `pub(crate)` (or
  `pub` when another crate calls it); do not alias on import.
- **Python text and path semantics** are in `kb_base::pytext` (`strip`, `split`, `splitlines`, `isupper`, `repr`...)
  and `kb_base::pypath` (`os.path`): use them where the Python code uses `str` methods whose Rust namesakes differ
  (`str.strip()` strips more than ASCII, `splitlines` knows more line ends). Add a missing one there with a unit
  test, and say so in your report. `str.casefold()` is the `caseless` crate's `default_case_fold_str`.
- **Files and uploads** are in `kb-files`: `FileResponse` / `file_response` is Starlette's `FileResponse` (use it
  for every file a route sends), `uploads` is `uploads.py`, `drawio_bundle` is `services/drawio_bundle.py`.
- **HEAD** on a GET route answers 405 as FastAPI does; the app does this for every route, routers do nothing.
- SeaORM: `sea_query::ExprTrait` must be in scope for `.eq()`, `.is_in()`... on expressions.
- A golden generator that imports the server's modules starts with `sys.path.insert(0, os.getcwd())`, and is run
  with its own `KANBAN_CONFIG_DIR`, `KANBAN_DB_PATH` and `KANBAN_LOG_DIR` (temporary folders), never the developer's.
- Known difference, accepted: Pydantic coerces `"true"` to a bool and `"3"` to an int in a JSON body; the Rust
  server answers 422. The app sends typed JSON.
- Do not stage, commit or push (`git add`, `git mv`, `git rm` included): the orchestrating session commits.
- `kb_base::error::Query<T>` reads repeated keys into a `Vec` field (`kind=a&kind=b`), as FastAPI reads
  `list[str] = Query(...)`. A body that may be left out (`data: Model | None = None`) is
  `kb_base::error::OptionalBody<T>`.
- `dict.pop(key)` on a `serde_json::Map` is `shift_remove` (`remove` swaps the last entry into the hole and changes
  the key order).
- There is no after-commit hook on `Session`: where Python reacts to a commit (a listener, a callback queued on the
  session), call the reaction right after `session.commit().await?`.
- Golden vector files are committed: keep each under about 2 MB (sample the generated cases; a few hundred
  well-chosen cases per function find what thousands do).
- `str(x)` / an f-string of a Python list or dict is its `repr` (`['a', 1]`, single quotes), not JSON:
  `kb_base::pyjson::py_str` / `py_repr`.
- A header read as text is latin-1 in Starlette (`request.headers.get(...)`): decode bytes one to a char, do not use
  `HeaderValue::to_str` (it refuses non-ASCII).
