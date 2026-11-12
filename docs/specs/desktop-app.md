# BA Spec: Desktop App (Electron + Rust server)

## Overview
Package the Kanban Board MCP app (React UI + Rust server) into a single installable desktop application. Users install once and everything works — no manual backend setup, no manual VS Code configuration.

## Problem Statement
Currently, users must: (1) have a toolchain installed, (2) manually run the server, (3) manually run the Vite dev server, and (4) hand-edit VS Code `settings.json` to register the MCP server. This is 4 friction points before the app is usable.

## Chosen Solution: Electron + Rust server

(The first version bundled a Python server with PyInstaller; the server is now the Rust workspace `server-rs/`.)

### Architecture
- **Electron** shell hosts the app (main process + BrowserWindow)
- **React UI** built to static files via `vite build`, loaded via `loadFile()` — no HTTP needed for the UI
- **Two Rust programs** (Cargo packages `kanban-server` and `kanban-mcp-stdio` in `server-rs/bins/`):
  - `kanban-server`: the HTTP server; spawned by Electron on startup. `kanban-server --runner` is the AI runner process.
  - `kanban-mcp-stdio`: stdio MCP entry point; registered in VS Code, called by AI agents (Copilot etc.)
  - `desktop/scripts/build-server.sh` runs `cargo build --release` and lays them out in `dist-server/kanban-mcp-stdio/`,
    which the installer copies to `Resources/kanban-mcp-stdio/{kanban-server,kanban-mcp-stdio}` (`.exe` on Windows).
    There is no runtime folder to ship: each program is one file. The folder keeps the stdio program's name because
    MCP clients outside the app store `Resources/kanban-mcp-stdio/kanban-mcp-stdio` as their command.
  - The script finishes with a smoke test: it starts the built server with temporary folders, waits for `READY port=`,
    calls `GET /health` and stops it.
  - macOS builds this machine's architecture (arm64 on `macos-latest`); `MACOS_UNIVERSAL=1` builds arm64 and x86_64
    and joins them with `lipo`.
- **Dynamic port:** The server picks a free port, prints `READY port=<N>` to stdout, Electron captures it, passes to renderer via contextBridge IPC
- **Shared SQLite DB:** lives in platform user data dir (`~/Library/Application Support/KanbanBoard/kanban.db` on macOS)
- **VS Code MCP auto-setup:** On first launch, Electron writes/merges user-level `mcp.json`:
  - macOS: `~/Library/Application Support/Code/User/mcp.json`
  - Windows: `%APPDATA%\Code\User\mcp.json`

## Acceptance Criteria
1. User installs the app (DMG on macOS, NSIS installer on Windows) — no other software needed
2. App launches and displays the Kanban board UI without any manual steps
3. On first launch, VS Code MCP config is automatically written (safe merge, never overwrites existing servers)
4. AI agents in VS Code (GitHub Copilot) can use kanban-board MCP tools immediately after install
5. SQLite database persists across app updates (stored in user data dir, not app bundle)
6. App quits cleanly (the server process is terminated on app quit)
7. If VS Code is not installed, the app still works for the UI — MCP setup is skipped gracefully

## Folder Structure (desktop/)
```
desktop/
├── main.js           # Electron main process
├── preload.js        # contextBridge for IPC
├── package.json      # Electron + electron-builder config
├── build/            # electron-builder assets (icons, etc.)
└── scripts/
    ├── build-server.sh  # cargo build of both programs + smoke test
    └── fetch-drawio.sh  # the draw.io editor the app ships
```

## Server Notes
- Development: `cd server-rs && cargo build -p kanban-server -p kanban-mcp-stdio`, then `cd desktop && npm run dev`
  starts `server-rs/target/debug/kanban-server`. `KANBAN_SERVER_BIN` names another program to start; if the binary is
  missing the app says to run the cargo command.
- Both programs resolve the DB path from env var `KANBAN_DB_PATH` (set by Electron to user data dir)
- The API secret is written to the server's stdin when `KANBAN_API_SECRET_STDIN=1`
- Both are console programs; Electron starts the server with `windowsHide` so no console window shows on Windows
- Signing: the installer signs the Mach-O files it packs when an identity is set (hardened runtime, entitlements in
  `desktop/build/entitlements.mac.plist`, which Electron's own helpers need); CI builds unsigned

## Out of Scope (v1)
- Linux AppImage
- Auto-update mechanism
- macOS code signing / notarization
- Cursor / Claude Desktop MCP auto-setup

## Risks
- A data file the server reads at run time must be compiled in or shipped: the build's smoke test catches a missing one
- macOS Gatekeeper: unsigned app shows warning; users must right-click → Open (document in README)
