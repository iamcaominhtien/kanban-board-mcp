"""Builds the tool list on a FastMCP server: the 9 tools, plus the Idea Space ones when they are switched on."""

from collections.abc import Callable
from typing import Any

from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations

from . import operations as ops
from .settings import ideas_enabled
from .tools import CORE_TOOL_TABLE

_READ = ToolAnnotations(readOnlyHint=True, openWorldHint=False)
_WRITE = ToolAnnotations(
    readOnlyHint=False, destructiveHint=False, idempotentHint=False, openWorldHint=False
)
_UPDATE = ToolAnnotations(
    readOnlyHint=False, destructiveHint=False, idempotentHint=True, openWorldHint=False
)
_DELETE = ToolAnnotations(
    readOnlyHint=False, destructiveHint=True, idempotentHint=False, openWorldHint=False
)

# The Idea Space tools are hidden from the MCP tool list for now (about a quarter of its size). They are fully
# implemented: set KANBAN_MCP_IDEA_TOOLS=1 to expose them again. They keep one tool per verb because their
# "omit = unchanged, explicit null = clear" parameters do not fit the action routing of the other tools.
IDEA_TOOL_TABLE: list[tuple[Callable, ToolAnnotations]] = [
    (ops.list_idea_tickets, _READ),
    (ops.get_idea_ticket, _READ),
    (ops.get_idea_activity_trail, _READ),
    (ops.create_idea_ticket, _WRITE),
    (ops.update_idea_ticket, _UPDATE),
    (ops.update_idea_status, _UPDATE),
    (ops.promote_idea_to_ticket, _WRITE),
    (ops.delete_idea_ticket, _DELETE),
    (ops.add_assumption, _WRITE),
    (ops.update_assumption_status, _UPDATE),
    (ops.delete_assumption, _DELETE),
    (ops.add_microthought, _WRITE),
    (ops.delete_microthought, _DELETE),
]


def _strip_titles(node: Any) -> Any:
    """Pydantic adds a redundant "title" (a prettified copy of the name) to every parameter; the AI reads the whole
    schema on each session, so drop them. Only schema keywords are touched, never a property that is itself named "title"."""
    if isinstance(node, dict):
        out = {}
        for key, value in node.items():
            if key == "title" and isinstance(value, str):
                continue
            out[key] = (
                _strip_properties(value)
                if key == "properties"
                else _strip_titles(value)
            )
        return out
    if isinstance(node, list):
        return [_strip_titles(item) for item in node]
    return node


def _strip_properties(props: Any) -> Any:
    # keys of "properties" are parameter names (one may be called "title"); only recurse into the values
    if not isinstance(props, dict):
        return props
    return {name: _strip_titles(sub) for name, sub in props.items()}


def register(mcp: FastMCP, include_ideas: bool | None = None) -> None:
    """Register the Kanban MCP tools with the given FastMCP instance.
    `include_ideas` defaults to the KANBAN_MCP_IDEA_TOOLS environment variable (off)."""
    if include_ideas is None:
        include_ideas = ideas_enabled()
    for func, annotations in CORE_TOOL_TABLE + (
        IDEA_TOOL_TABLE if include_ideas else []
    ):
        mcp.tool(annotations=annotations)(func)
    for tool in mcp._tool_manager.list_tools():
        tool.parameters = _strip_titles(tool.parameters)
