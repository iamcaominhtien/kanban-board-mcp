#!/usr/bin/env python3
"""A tiny stdio MCP server with two tools, used to test the status probe of the Configuration tab."""

from mcp.server.fastmcp import FastMCP

app = FastMCP("fake")


@app.tool()
def ping() -> str:
    """Answer pong."""
    return "pong"


@app.tool()
def add(a: int, b: int) -> int:
    """Add two numbers."""
    return a + b


if __name__ == "__main__":
    app.run()
