# Changelog

All notable changes to this project will be documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/). Versioning follows [Semantic Versioning](https://semver.org/).

---

## [1.2.4] - 2026-04-11

### Changed
- Desktop app now uses the project's Kanban logo instead of the default Electron icon
- Web UI favicon updated to use the repo logo (SVG)
- Added `desktop/scripts/generate-icons.js` to regenerate icons from SVG source

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
