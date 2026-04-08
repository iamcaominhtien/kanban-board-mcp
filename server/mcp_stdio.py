"""
Stdio entry point for the Kanban MCP server.

Use this when connecting via VS Code, Claude Desktop, or any MCP client
that launches the server as a subprocess (stdio transport).

Requires the database to have been migrated first:
    uv run alembic upgrade head
"""

import asyncio

from mcp.server.fastmcp import FastMCP

import mcp_tools as _mcp_tools
from database import init_db

mcp = FastMCP("kanban-mcp")
_mcp_tools.register(mcp)


async def _startup() -> None:
    await init_db()


if __name__ == "__main__":
    asyncio.run(_startup())
    mcp.run(transport="stdio")
