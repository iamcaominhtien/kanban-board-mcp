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

### Option 1 — Stdio (recommended for VS Code / Claude Desktop)

Uses `mcp_stdio.py` — the server launches as a subprocess, no manual startup needed.

**First-time setup** (run once):
```bash
uv run alembic upgrade head
```

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

