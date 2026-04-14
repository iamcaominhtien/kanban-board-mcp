# Changelog

All notable changes to this project will be documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/). Versioning follows [Semantic Versioning](https://semver.org/).

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
