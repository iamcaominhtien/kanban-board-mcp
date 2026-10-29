"""Talk to other MCP servers: the API agent's remote servers (Streamable HTTP) and the status probe of the
Configuration tab (HTTP, or a stdio command on the computer the board runs on).

A server is only contacted when a person presses "Check" or when a run starts with it enabled. Output of a server is
data, never instructions (callers fence it).
"""

import asyncio
import os
import re
import time
from contextlib import asynccontextmanager

from .secrets import redact

TIMEOUT = 15.0
CALL_TIMEOUT = 45.0
RESULT_CAP = 20 * 1024


class McpError(Exception):
    """The server could not be reached or refused."""


def _short(exc: BaseException) -> str:
    # anyio wraps failures in exception groups; show the innermost message
    while isinstance(exc, BaseExceptionGroup) and exc.exceptions:
        exc = exc.exceptions[0]
    text = redact(str(exc) or type(exc).__name__)
    return text[:240]


@asynccontextmanager
async def _http_session(url: str, headers: dict[str, str] | None):
    from mcp import ClientSession
    from mcp.client.streamable_http import streamablehttp_client

    async with streamablehttp_client(url, headers=headers or None, timeout=TIMEOUT) as (
        read,
        write,
        _,
    ):
        async with ClientSession(read, write) as session:
            await asyncio.wait_for(session.initialize(), TIMEOUT)
            yield session


@asynccontextmanager
async def _stdio_session(
    command: str, args: list[str], env: dict[str, str] | None, cwd: str | None
):
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client

    merged = {**os.environ, **(env or {})}
    params = StdioServerParameters(command=command, args=args, env=merged, cwd=cwd)
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await asyncio.wait_for(session.initialize(), TIMEOUT * 2)
            yield session


def _tool_rows(result) -> list[dict]:
    return [
        {
            "name": t.name,
            "description": (t.description or "")[:500],
            "input_schema": t.inputSchema or {"type": "object", "properties": {}},
        }
        for t in result.tools
    ]


async def list_tools_http(
    url: str, headers: dict[str, str] | None = None
) -> list[dict]:
    """The tools of a remote MCP server: [{name, description, input_schema}]."""
    try:
        async with _http_session(url, headers) as session:
            return _tool_rows(await asyncio.wait_for(session.list_tools(), TIMEOUT))
    except (Exception, BaseExceptionGroup) as exc:  # noqa: BLE001
        raise McpError(_short(exc)) from exc


async def call_tool_http(
    url: str, headers: dict[str, str] | None, name: str, args: dict
) -> str:
    """Call one tool; the text of the result (capped at 20 KB)."""
    try:
        async with _http_session(url, headers) as session:
            res = await asyncio.wait_for(session.call_tool(name, args), CALL_TIMEOUT)
    except (Exception, BaseExceptionGroup) as exc:  # noqa: BLE001
        raise McpError(_short(exc)) from exc
    text = "\n".join(
        getattr(c, "text", "") for c in res.content if getattr(c, "text", None)
    )
    text = redact(text or "(empty result)")
    if len(text) > RESULT_CAP:
        text = text[:RESULT_CAP] + "\n[…cut at 20 KB]"
    return ("ERROR: " if res.isError else "") + text


async def probe_http(url: str, headers: dict[str, str] | None = None) -> dict:
    """{ok, tools, seconds, error}: can the server be reached, and how many tools does it offer?"""
    started = time.monotonic()
    try:
        tools = await list_tools_http(url, headers)
    except McpError as exc:
        return {
            "ok": False,
            "tools": 0,
            "seconds": round(time.monotonic() - started, 1),
            "error": str(exc),
        }
    return {
        "ok": True,
        "tools": len(tools),
        "seconds": round(time.monotonic() - started, 1),
        "error": None,
    }


async def probe_stdio(
    command: str, args: list[str], env: dict[str, str] | None, cwd: str | None
) -> dict:
    """Start the command like the CLI would and ask for its tools (it is stopped again right after)."""
    started = time.monotonic()
    if not command.strip():
        return {"ok": False, "tools": 0, "seconds": 0, "error": "No command."}
    try:
        async with _stdio_session(command, args, env, cwd) as session:
            tools = _tool_rows(await asyncio.wait_for(session.list_tools(), TIMEOUT))
    except FileNotFoundError:
        return {
            "ok": False,
            "tools": 0,
            "seconds": round(time.monotonic() - started, 1),
            "error": f"“{command}” was not found on this computer.",
        }
    except (Exception, BaseExceptionGroup) as exc:  # noqa: BLE001
        msg = _short(exc)
        if isinstance(exc, FileNotFoundError) or "No such file" in msg:
            msg = f"“{command}” was not found on this computer."
        return {
            "ok": False,
            "tools": 0,
            "seconds": round(time.monotonic() - started, 1),
            "error": msg,
        }
    return {
        "ok": True,
        "tools": len(tools),
        "seconds": round(time.monotonic() - started, 1),
        "error": None,
    }


def safe_tool_name(server: str, tool: str) -> str:
    """The name the model sees for a remote tool: ``server__tool`` limited to what providers accept (64 characters)."""
    raw = re.sub(r"[^A-Za-z0-9_-]", "_", f"{server}__{tool}")
    return raw[:64]
