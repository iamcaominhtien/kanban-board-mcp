# Kanban Board MCP — Server

Python backend exposing a **FastAPI REST API** and an **MCP (Model Context Protocol)** server. AI agents connect via MCP to manage the Kanban board; the React UI connects via REST.

## Architecture

```
main.py          FastAPI app + MCP mount
  ├── GET /health          Health check
  └── /mcp/*              MCP streamable HTTP endpoint (for AI agents)
tests/           pytest async tests (httpx + ASGITransport)
```

Data layer: SQLite via SQLModel + Alembic migrations (aiosqlite for async).

## Setup

Requires [uv](https://docs.astral.sh/uv/).

```bash
# Install dependencies
uv sync --dev
```

## Running

```bash
# Dev server with auto-reload
uv run uvicorn main:app --reload --port 8000
```

API is available at `http://localhost:8000`.

## Testing

```bash
uv run pytest
```

## Code Quality

```bash
# Lint
uv run ruff check .

# Auto-fix lint
uv run ruff check --fix .

# Format
uv run ruff format .
```

## Connecting AI Agents (MCP)

The server offers **12 tools** (25 with the Idea Space tools, `KANBAN_MCP_IDEA_TOOLS=1`), each a family of actions in `kanban_mcp/tools/`: `get_projects`, `list_tickets`, `get_ticket`, `docs_read` (read), `manage_project`, `manage_ticket`, `ticket_items`, `ticket_branches`, `docs_write`, `ai_run` (only inside a board-started AI run), `ai_schedules` and `ai_team` (the AI members, their runs, usage and approvals; `ask` wakes an AI, because an `@mention` in an MCP comment does not). The full table is in the root `README.md`.

### Option 1 — Stdio (recommended for VS Code / Claude Desktop)

Uses `mcp_stdio.py` — the server launches as a subprocess. The database schema is created automatically on first run.

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

### Option 2 — HTTP

Start the server, then connect any MCP client to `http://localhost:8000/mcp`.

