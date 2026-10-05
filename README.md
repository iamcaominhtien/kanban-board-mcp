<p align="center">
  <img src="docs/assets/logo.svg" width="100" alt="Kanban Board MCP" />
</p>

<h1 align="center">Kanban Board MCP</h1>

<p align="center">
  A personal Kanban board with a polished React UI and a Python MCP server — built for AI agent integration.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/React-18-61DAFB?style=flat-square&logo=react&logoColor=white" alt="React" />
  <img src="https://img.shields.io/badge/TypeScript-5-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Vite-8-646CFF?style=flat-square&logo=vite&logoColor=white" alt="Vite" />
  <img src="https://img.shields.io/badge/Python-3.12+-3776AB?style=flat-square&logo=python&logoColor=white" alt="Python" />
  <img src="https://img.shields.io/badge/FastAPI-0.135-009688?style=flat-square&logo=fastapi&logoColor=white" alt="FastAPI" />
  <img src="https://img.shields.io/badge/MCP-1.27-FF6B35?style=flat-square" alt="MCP" />
  <img src="https://img.shields.io/badge/SQLite-003B57?style=flat-square&logo=sqlite&logoColor=white" alt="SQLite" />
</p>

---

## Features

- **Board, List and Timeline** views with drag and drop, filters (type, priority, assignee), search, and **Review / Testing** statuses.
- **Rich ticket detail**: WYSIWYG Markdown description (tables, task lists, code, pasted or uploaded images), acceptance criteria, sub-tickets, comments, blocks and links, estimates, dates, assignees and "Done requires" guards.
- **Test cases** with pass / fail / running state per ticket and child ticket.
- **Real git branches**: link a ticket to a branch, see its commit graph against `main`, check it out, and use git worktrees.
- **Per-ticket Workspace** (a scratch folder with a file manager) and **Debug Space** (a journal of attempts, blockers and fixes).
- **Activity log** of who changed what (you, an AI agent, or a named member), with filters.
- **Idea Space** for early ideas, assumptions and micro-thoughts, promoted to tickets when ready.
- **MCP server for AI agents**: 34 tools over stdio or HTTP, with clear descriptions, annotations and fix-it error messages.
- **Splash screen and loading states** on web and desktop, plus an update-required notice when the UI is too old for the server.
- **Local-first**: SQLite, no external services; also packaged as an Electron desktop app.

## What's Inside

| | |
|---|---|
| **UI** | React 18 + Vite + TypeScript, CSS Modules, drag-and-drop (`@dnd-kit`) |
| **Server** | Python, FastAPI, MCP (Model Context Protocol), SQLite via SQLModel |
| **Storage** | Local-first — SQLite, no external services |

## Screenshots

### Board View
![Board View](docs/screenshots/board-overview.png)

### Ticket Detail — WYSIWYG Markdown with images
Write rich text (tables, task lists, code, pasted images); it is stored as plain Markdown.

![Ticket Detail](docs/screenshots/ticket-modal.png)

### Test Cases
Track pass / fail / running per ticket, including child tickets, and optionally block *Done* until every case passes.

![Test Cases](docs/screenshots/test-cases.png)

### Git Branches
Link a ticket to a real branch, see its commits against `main`, and check it out from the UI.

![Git Branches](docs/screenshots/git-branches.png)

### List View
![List View](docs/screenshots/list-view.png)

### Timeline / Gantt
![Timeline View](docs/screenshots/timeline-view.png)

## Quick Start

### UI (Frontend)
```bash
cd ui
npm install
npm run dev        # http://localhost:5173
```

### MCP Server (Backend)

Requires Python 3.12+ and [uv](https://docs.astral.sh/uv/). The database is created and migrated automatically on first start.

```bash
cd server
uv sync
uv run uvicorn main:app --reload --port 8000
```

## MCP Tools

The server exposes 37 tools for AI agents over MCP (50 with the Idea Space tools enabled). The full list is in `server/mcp_tools.py`:

**Projects & Members**
- `list_projects`, `create_project`, `update_project` (name, color, linked git repo, worktree defaults)
- `list_members`, `add_member`, `remove_member`

**Tickets**
- `list_tickets` — compact, paginated summaries (`status`, `priority`, `q`, `limit`/`offset`; `detail=true` for full objects)
- `get_ticket` — everything about one ticket plus its 10 most recent activity entries (long texts shortened); `activity_limit=N` for a different number (0 = none, negative = the whole history in full), `activity_since=<ISO time>` for what changed since then
- `create_ticket`, `create_child_ticket`, `update_ticket` (incl. assignee, dates, repo path, "Done requires" guards, `clear_fields`), `update_ticket_status`, `delete_ticket`
- `block_ticket`, `unblock_ticket`, `link_tickets`, `unlink_tickets`
- `get_ticket_workspace_path` — the ticket's scratch folder (read/write it with your own file tools)

**Working on a ticket**
- `add_comment`, `update_comment`, `delete_comment`
- `add_work_log`, `update_work_log`, `delete_work_log` — the Debug Space journal
- `add_test_case`, `update_test_case`, `delete_test_case`
- `add_acceptance_criterion`, `toggle_acceptance_criterion`, `delete_acceptance_criterion`
- `add_sub_task`, `toggle_sub_task`, `delete_sub_task` (checklist steps inside a ticket; use `parent_id` for real sub-tickets)
- `add_branch`, `update_branch`, `delete_branch`, `checkout_branch` — real git branches when the project has a linked repo

**Idea Space** (hidden from MCP for now: set `KANBAN_MCP_IDEA_TOOLS=1` to expose these 13 tools; the web UI and REST API are unaffected)
- `list_idea_tickets`, `get_idea_ticket`, `get_idea_activity_trail`, `create_idea_ticket`, `update_idea_ticket`, `update_idea_status`, `promote_idea_to_ticket`, `delete_idea_ticket`
- `add_assumption`, `update_assumption_status`, `delete_assumption`, `add_microthought`, `delete_microthought`

**Conventions agents can rely on**
- The server sends usage instructions on connect (IDs, statuses, flow), and every tool carries read-only / destructive / idempotent annotations.
- Failures are real tool errors (`isError`) whose message says how to fix the call (and lists the valid ids); nothing fails silently.
- Tools that change a ticket return it without its activity log (large); sub-items can be addressed by id, test-case code (`TC-2`) or branch name.
- Omitted optional arguments mean "unchanged"; use `clear_fields` to empty a field. Changes are attributed to the AI agent in the Activity tab.

## Connecting AI Agents

### Easiest — Settings → MCP integrations

Open **Settings** in the app and use **MCP integrations** to install the server into **Claude Code** (runs `claude mcp add` in the User, Project or Local scope) or **Antigravity** (merges a `kanban` entry into `~/.gemini/config/mcp_config.json` or `.agents/mcp_config.json`). Each row also offers Copy command / Copy JSON, Test connection and Remove, and only ever touches the `kanban` entry. The manual options below do the same thing by hand.

### Option 1 — Stdio (recommended for VS Code / Claude Desktop)

The server launches as a subprocess — no manual startup needed. The database schema is created automatically on first run.

Add to VS Code `mcp.json` or Claude Desktop config:
```json
{
  "servers": {
    "kanban": {
      "type": "stdio",
      "command": "uv",
      "args": ["--directory", "/path/to/kanban-board-mcp/server", "run", "mcp_stdio.py"]
    }
  }
}
```

### Option 2 — HTTP (when running the full server)

Start the server first:
```bash
cd server && uv run uvicorn main:app --port 8000
```

Then connect any MCP-compatible client to `http://localhost:8000/mcp/` (note the trailing slash — the mount only matches with it).

## Desktop App Release Status

The desktop app packages the full stack (React UI + FastAPI server + MCP stdio) into a single installable application via Electron.

| Platform | Status | Artifact |
|---|---|---|
| **macOS** (x64 + arm64) | Available | DMG — see [v1.4.5 release](https://github.com/iamcaominhtien/kanban-board-mcp/releases/tag/v1.4.5) |
| **Windows** (NSIS) | Not yet uploaded | Build from source: `./build-desktop.sh` |
| **Linux** | Not yet supported | — |

> **macOS note:** the app is not notarized — right-click → Open on first launch.

## More Docs
- [Server README](server/README.md)
- [UI README](ui/README.md)
- [Architecture](docs/arch/backend-architecture.md)
- [Changelog](CHANGELOG.md)

