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

The server exposes MCP over **streamable HTTP** at `http://localhost:8000/mcp`. Start the server first, then connect any MCP-compatible client.

### VS Code / Claude Desktop

```json
{
  "servers": {
    "kanban": {
      "url": "http://localhost:8000/mcp",
      "type": "http"
    }
  }
}
```

