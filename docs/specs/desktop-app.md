# BA Spec: Desktop App (Electron + PyInstaller)

## Overview
Package the Kanban Board MCP app (React UI + Python FastAPI backend) into a single installable desktop application. Users install once and everything works — no manual backend setup, no manual VS Code configuration.

## Problem Statement
Currently, users must: (1) have Python installed, (2) manually run the FastAPI server, (3) manually run the Vite dev server, and (4) hand-edit VS Code `settings.json` to register the MCP server. This is 4 friction points before the app is usable.

## Chosen Solution: Electron + PyInstaller

### Architecture
- **Electron** shell hosts the app (main process + BrowserWindow)
- **React UI** built to static files via `vite build`, loaded via `loadFile()` — no HTTP needed for the UI
- **Two PyInstaller binaries:**
  - `kanban-server`: FastAPI + uvicorn HTTP server; spawned by Electron on startup
  - `kanban-mcp-stdio`: stdio MCP entry point; registered in VS Code, called by AI agents (Copilot etc.)
- **Dynamic port:** Python server picks a free port (socket trick), prints `READY port=<N>` to stdout, Electron captures it, passes to renderer via contextBridge IPC
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
6. App quits cleanly (Python child process terminated on app quit)
7. If VS Code is not installed, the app still works for the UI — MCP setup is skipped gracefully

## Folder Structure (desktop/)
```
desktop/
├── main.js           # Electron main process
├── preload.js        # contextBridge for IPC
├── package.json      # Electron + electron-builder config
├── build/            # electron-builder assets (icons, etc.)
└── scripts/
    └── build-python.sh  # PyInstaller build script for both binaries
```

## PyInstaller Notes
- `kanban-server` entry: `server/main.py` with `freeze_support()` + `workers=1` + port-from-socket
- `kanban-mcp-stdio` entry: `server/mcp_stdio.py`
- Both binaries resolve DB path from env var `KANBAN_DB_PATH` (set by Electron to user data dir)
- Hidden imports: `collect_submodules('uvicorn')`, `copy_metadata('pydantic')`

## Out of Scope (v1)
- Linux AppImage
- Auto-update mechanism
- macOS code signing / notarization
- Cursor / Claude Desktop MCP auto-setup

## Risks
- PyInstaller + uvicorn hidden imports may require iteration (mitigated: research confirmed known list)
- macOS Gatekeeper: unsigned app shows warning; users must right-click → Open (document in README)
