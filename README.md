# Kanban Board MCP

A personal Kanban board with a polished React UI and a Python MCP server — built for AI agent integration.

## What's Inside

| | |
|---|---|
| **UI** | React 18 + Vite + TypeScript, Tailwind CSS, drag-and-drop (`@dnd-kit`) |
| **Server** | Python, FastAPI, MCP (Model Context Protocol), SQLite via SQLModel |
| **Storage** | Local-first — SQLite, no external services |

## Screenshots

### Board View
![Board View](docs/screenshots/board-overview.png)

### Ticket Detail
![Ticket Detail](docs/screenshots/ticket-modal.png)

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

Requires [uv](https://docs.astral.sh/uv/).

```bash
cd server
uv sync
uv run uvicorn main:app --reload --port 8000
```

## MCP Tools

The server exposes 15 tools for AI agents over MCP:

**Projects & Members**
- `list_projects` — list all projects
- `create_project` — create a new project
- `list_members` — list project members
- `add_member` — add a member to a project
- `remove_member` — remove a member

**Tickets**
- `create_ticket` — create a ticket (auto-generates ID like `PREFIX-N`)
- `list_tickets` — list & filter tickets by status, priority, or search query
- `get_ticket` — get full ticket details
- `update_ticket` — update title, description, type, priority, etc.
- `update_ticket_status` — change ticket status
- `create_child_ticket` — create a subtask under a parent ticket

**Annotations**
- `add_comment` — add a comment to a ticket
- `add_work_log` — log work with role and note
- `add_test_case` — attach a test case to a ticket
- `update_test_case` — update test case status and proof

## Connecting to Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "kanban": {
      "command": "uv",
      "args": ["run", "python", "-m", "mcp", "run", "main.py"],
      "cwd": "/path/to/kanban-board-mcp/server"
    }
  }
}
```

Or point any MCP-compatible client at `http://localhost:8000/mcp` (streamable HTTP transport).

## More Docs
- [Server README](server/README.md)
- [UI README](ui/README.md)
- [Architecture](docs/backend-architecture.md)

