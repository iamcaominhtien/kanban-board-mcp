"""
Stdio entry point for the Kanban MCP server.

Use this when connecting via VS Code, Claude Desktop, or any MCP client
that launches the server as a subprocess (stdio transport).

Requires the database to have been migrated first:
    uv run alembic upgrade head
"""

import asyncio
import sys

if "--bridge" in sys.argv:
    # Antigravity's way into a board run: forward to the board's HTTP MCP endpoint with the run's token (see
    # mcp_bridge.py). Handled before anything heavy is imported: no database is needed.
    import mcp_bridge

    mcp_bridge.main()
    sys.exit(0)

import pydantic_defer  # noqa: F401 — first, before any pydantic model is defined
import app_logging
from mcp.server.fastmcp import FastMCP

import database
import kanban_mcp
from database import init_db
from dbkit import targets as db_targets

db_targets.ROLE = "mcp"  # its connections are named "kanban-board mcp …" on PostgreSQL

mcp = FastMCP("kanban-mcp", instructions=kanban_mcp.MCP_INSTRUCTIONS)
kanban_mcp.register(mcp)


async def _startup() -> None:
    await init_db()


async def _main() -> None:
    await _startup()
    # Follow the database setting: when the board switches to another database, this process does too, so the
    # board and the editors always talk to one database (design/screens/ai-databases.md B3)
    follow = asyncio.create_task(database.follow_settings())
    try:
        await mcp.run_stdio_async()
    finally:
        follow.cancel()


if __name__ == "__main__":
    app_logging.setup_logging(stdio=True)
    asyncio.run(_main())
