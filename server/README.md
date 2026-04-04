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

> **Note:** `ruff` is not yet configured in `pyproject.toml`. Add it to `[dependency-groups].dev` to enable the commands below.

```bash
# Format
uv run ruff format .

# Lint
uv run ruff check .

# Auto-fix lint
uv run ruff check --fix .
```

## Connecting to Claude Desktop (MCP)

Add this to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

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
