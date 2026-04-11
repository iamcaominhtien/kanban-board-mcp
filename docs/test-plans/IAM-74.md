---
title: "Test Plan: IAM-74 Desktop App (Electron + PyInstaller + VS Code MCP Auto-Setup)"
type: test
status: stable
ticket: IAM-74
version: 1.0.0
created: 2026-04-11
updated: 2026-04-11
executed: 2026-04-11
authors: [GitHub Copilot (QC Agent)]
related:
  - docs/specs/desktop-app.md
---

# Test Plan: IAM-74 Desktop App (Electron + PyInstaller + VS Code MCP Auto-Setup)

## Scope

Validate the desktop packaging foundation introduced by IAM-74:

- Electron launches the built React UI from `ui/dist/index.html`
- Electron spawns the Python `kanban-server` binary or dev server process, reads `READY port=<N>`, and exposes the backend port to the renderer via IPC
- SQLite path selection respects `KANBAN_DB_PATH` and defaults correctly when unset
- First launch safely writes or merges VS Code `mcp.json` for `kanban-mcp-stdio`
- App behavior remains safe when VS Code is missing or `mcp.json` is corrupt
- Desktop packaging outputs remain testable through DMG and NSIS manual validation

Out of scope:

- Auto-update flows
- Code signing or notarization
- Linux packaging
- Deep Copilot workflow testing beyond a smoke invocation of the registered MCP server

## Risk Focus

Highest-risk areas for this ticket:

1. `desktop/vscode-setup.js`: safe merge, corrupt JSON handling, atomic write, and VS Code missing behavior
2. `desktop/main.js`: backend child-process launch, READY-port discovery, setup-flag behavior, and shutdown path
3. `server/database.py`: `KANBAN_DB_PATH` resolution and parent-directory creation
4. `server/main.py`: dynamic port startup contract and health reachability after READY

## Automation Strategy

| Area | Tooling | Executable Now | Notes |
|---|---|---|---|
| Desktop pure logic (`desktop/main.js` helpers, `desktop/vscode-setup.js`) | Node test runner | Yes | Best fit for deterministic source-code validation without needing a packaged Electron app |
| Server path resolution and READY boot contract | `pytest` via `uv run` | Yes | Validates `KANBAN_DB_PATH`, dynamic port startup, `/health`, and `/mcp` availability |
| Browser / Playwright UI | Limited | Not used for final AC sign-off | Browser automation cannot prove Electron `file://` loading, preload IPC, packaged child-process lifecycle, or VS Code config registration |
| Packaged desktop app | Manual | Required | Needed for end-to-end validation of AC1-AC6 and installer outputs |

## Executed Automatable Results

| Suite | Command | Result |
|---|---|---|
| Desktop source-code unit tests | `cd desktop && npm test` | 16 passed, 0 failed |
| Server unit and integration tests | `cd server && uv run pytest tests/test_database.py tests/test_main.py` | 5 passed, 0 failed |
| Total executed automatable tests | Combined | 21 passed, 0 failed |

Executed files:

- `desktop/tests/main-helpers.test.js`
- `desktop/tests/vscode-setup.test.js`
- `server/tests/test_database.py`
- `server/tests/test_main.py`

## Acceptance Criteria Coverage Matrix

| AC | Requirement | Source-code automation | Packaged manual validation |
|---|---|---|---|
| AC1 | App launches and shows Kanban UI | Partial | Required |
| AC2 | VS Code MCP config auto-written on first launch | Strong | Required |
| AC3 | GitHub Copilot can use kanban-board MCP tools after install | Partial | Required |
| AC4 | SQLite DB persists in user data dir across restarts | Partial | Required |
| AC5 | App quits cleanly and terminates Python child process | Partial | Required |
| AC6 | Graceful degradation if VS Code not installed | Strong | Required |
| AC7 | `KANBAN_DB_PATH` env var respected | Strong | Recommended final smoke in packaged build |

## Detailed Test Cases

| ID | AC | Level | Automation | Description | Steps | Expected | Status |
|---|---|---|---|---|---|---|---|
| IAM74-UT-01 | AC7 | Unit | Node | Packaged backend launch spec sets `KANBAN_DB_PATH` to user data dir and targets packaged binary | Execute `desktop/tests/main-helpers.test.js` case `buildBackendLaunchSpec uses packaged binary and user data db path` | Command resolves to `kanban-server(.exe)` and env includes `<userData>/kanban.db` | ✅ Pass |
| IAM74-UT-02 | AC1, AC7 | Unit | Node | Dev backend launch spec prefers project virtualenv and falls back to `python3` when absent | Execute `buildBackendLaunchSpec prefers project virtualenv in dev mode` and `falls back to python3` | Correct interpreter selection, cwd, and `KANBAN_DB_PATH` env produced | ✅ Pass |
| IAM74-UT-03 | AC1 | Unit | Node | READY parser extracts the backend port from aggregated stdout | Execute `parseReadyPort extracts a ready signal from aggregated stdout` | `READY port=<N>` is parsed only when present | ✅ Pass |
| IAM74-UT-04 | AC2 | Unit | Node | Setup gate only runs in packaged builds without the marker file and only writes the done flag after successful registration states | Execute `setup flag helpers only mark successful packaged registration states` | Packaged-only behavior enforced; `registered` and `already-registered` mark completion | ✅ Pass |
| IAM74-UT-05 | AC5 | Unit | Node | Quit helper terminates only valid child processes | Execute `terminateBackendProcess only kills valid child processes` | `kill()` invoked when process ref exists; null ref is safe | ✅ Pass |
| IAM74-UT-06 | AC2, AC6 | Unit | Node | VS Code config directory resolution handles installed vs missing VS Code correctly | Execute `getVSCodeUserConfigDir returns null...` and `getVSCodeMcpConfigPath resolves...` | Missing VS Code yields null; existing directory resolves `mcp.json` path correctly | ✅ Pass |
| IAM74-UT-07 | AC2 | Unit | Node | Safe merge preserves unrelated MCP servers | Execute `mergeMcpConfig preserves unrelated servers during safe merge` | Existing server entries remain untouched and `kanban-board` is added | ✅ Pass |
| IAM74-UT-08 | AC2 | Unit | Node | Already-registered path is idempotent | Execute `registerMcpServer returns already-registered...` | Existing identical entry is left unchanged; no destructive rewrite needed | ✅ Pass |
| IAM74-UT-09 | AC2 | Unit | Node | Corrupt `mcp.json` returns parse-error and does not overwrite user data | Execute `readJsonSafe returns null for corrupt JSON...` and `registerMcpServer returns parse-error...` | Corrupt file contents remain unchanged; function returns `parse-error` | ✅ Pass |
| IAM74-UT-10 | AC2 | Unit | Node | Atomic write succeeds and cleans temporary file on failure | Execute `registerMcpServer writes a merged config atomically...` and `returns write-error and removes temp file...` | Successful write produces merged config; failed write returns `write-error` and removes `.tmp` | ✅ Pass |
| IAM74-UT-11 | AC6 | Unit | Node | Missing VS Code returns a non-fatal status | Execute `registerMcpServer returns vscode-not-found...` | `vscode-not-found` returned instead of throwing | ✅ Pass |
| IAM74-PY-01 | AC7 | Unit | Pytest | Database defaults to repo-local `kanban.db` when env var is absent | Execute `tests/test_database.py::test_database_uses_repo_default_path_when_env_missing` | `DATABASE_URL` targets the default path under `server/` | ✅ Pass |
| IAM74-PY-02 | AC7 | Unit | Pytest | Database resolves custom `KANBAN_DB_PATH` and creates missing parent directories | Execute `tests/test_database.py::test_database_resolves_env_path_and_creates_parent_directory` | Env path is resolved absolutely and parent directory is created | ✅ Pass |
| IAM74-PY-03 | AC1, AC7 | Integration | Pytest | Server emits `READY port=<N>` and is reachable on `/health` after startup | Execute `tests/test_main.py::test_main_emits_ready_signal_and_serves_health` | READY line appears, dynamic port opens, `/health` returns `200 {"status":"ok"}` | ✅ Pass |
| IAM74-PY-04 | AC3 | Integration | Pytest | MCP HTTP mount is reachable from the server process | Execute `tests/test_main.py::test_mcp_endpoint_is_reachable` | `/mcp` is mounted and does not return `404` | ✅ Pass |
| IAM74-MAN-01 | AC1 | Manual packaged app | DMG / NSIS install | Fresh install launches desktop app and shows Kanban UI with no manual backend steps | 1. Install DMG or NSIS build. 2. Launch app. 3. Observe initial board load. | Window opens, Kanban board renders, no user setup required | ⬜ Pending |
| IAM74-MAN-02 | AC2 | Manual packaged app | macOS and Windows | First launch creates or safely merges `mcp.json` without overwriting existing servers | 1. Pre-create `mcp.json` with another server entry. 2. Launch packaged app first time. 3. Open resulting `mcp.json`. | `kanban-board` entry exists, unrelated entries remain intact, no duplicates | ⬜ Pending |
| IAM74-MAN-03 | AC2, AC6 | Manual packaged app | macOS and Windows | Corrupt `mcp.json` does not get overwritten and app still launches | 1. Write invalid JSON into user `mcp.json`. 2. Launch packaged app. 3. Verify UI startup. 4. Re-open `mcp.json`. | App launches; config file remains unchanged; registration is skipped safely | ⬜ Pending |
| IAM74-MAN-04 | AC3 | Manual packaged app | VS Code + Copilot | GitHub Copilot can discover and invoke `kanban-board` MCP tools after install | 1. Launch packaged app once. 2. Open VS Code. 3. Confirm MCP config entry exists. 4. Ask Copilot to use a kanban-board MCP tool. | Tool discovery succeeds and a simple MCP command executes | ⬜ Pending |
| IAM74-MAN-05 | AC4, AC7 | Manual packaged app | macOS and Windows | Data persists across app restart using the user data directory database | 1. Launch app. 2. Create `[TEST] IAM-74 persistence` item. 3. Quit app. 4. Relaunch app. | Ticket persists after restart and DB file remains under user data dir | ⬜ Pending |
| IAM74-MAN-06 | AC4 | Manual packaged app | Upgrade scenario | Data persists across app upgrade/install replacement | 1. Install build A. 2. Create test data. 3. Install build B over A. 4. Relaunch. | Data remains present because DB lives outside the app bundle | ⬜ Pending |
| IAM74-MAN-07 | AC5 | Manual packaged app | Activity Monitor / Task Manager | Quitting the app terminates the Python child process cleanly | 1. Launch app. 2. Identify `kanban-server` process. 3. Quit app. 4. Re-check process list. | `kanban-server` no longer exists after quit | ⬜ Pending |
| IAM74-MAN-08 | AC6 | Manual packaged app | Clean machine or renamed Code profile | App works when VS Code is not installed | 1. Run build on a machine without VS Code user config directory. 2. Launch app. | App still launches and UI remains usable; no fatal startup error | ⬜ Pending |
| IAM74-MAN-09 | AC1, AC2, AC3, AC5 | Manual packaged app | Electron runtime smoke | Verify preload IPC and backend port wiring inside the packaged app | 1. Launch packaged app. 2. Open DevTools if enabled or use app diagnostics build. 3. Inspect renderer requests against `127.0.0.1:<dynamic-port>`. | Renderer successfully talks to backend using IPC-provided port; no dead backend or hardcoded port assumptions | ⬜ Pending |
| IAM74-MAN-10 | Feature packaging | Manual packaged app | Build pipeline | Verify electron-builder emits DMG on macOS and NSIS installer on Windows | 1. Run desktop packaging pipeline on each OS. 2. Inspect generated artifacts under `dist-desktop/`. | DMG produced on macOS; NSIS installer produced on Windows | ⬜ Pending |

## Browser vs Packaged-App Guidance

### Browser-automatable

- Source-level logic and backend integration can be automated now through Node and `pytest`
- A browser smoke test against a manually started backend can validate generic board rendering, but it does not validate Electron-specific behavior

### Not meaningfully browser-automatable

- `loadFile()` packaging behavior
- `preload.js` contextBridge wiring in the Electron sandbox
- Python child-process lifecycle owned by Electron main process
- First-launch `mcp.json` registration from the packaged app
- Clean shutdown of the packaged child process
- Installer artifact behavior (DMG / NSIS)

For those paths, a packaged desktop build is the required test surface.

## Evidence From Executed Tests

- `desktop/tests/vscode-setup.test.js` covers safe merge, corrupt JSON preservation, atomic write success/failure cleanup, and `vscode-not-found`
- `desktop/tests/main-helpers.test.js` covers backend launch command construction, env injection, READY parsing, setup gating, and shutdown helper behavior
- `server/tests/test_database.py` proves `KANBAN_DB_PATH` default and override behavior
- `server/tests/test_main.py` proves dynamic port startup emits READY and serves `/health`, and that `/mcp` is mounted

## Exit Criteria

IAM-74 can be considered QC-complete when:

1. All automatable source-code tests remain green
2. Manual packaged-app cases IAM74-MAN-01 through IAM74-MAN-10 are executed on the intended release platforms
3. Copilot MCP invocation is proven once from the installed app path
4. No startup crash or data-loss behavior is observed for missing or corrupt VS Code config states