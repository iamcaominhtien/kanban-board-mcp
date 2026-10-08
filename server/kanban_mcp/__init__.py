"""The Kanban MCP server's tools.

- `operations`: one function per verb (create a ticket, add a comment, ...), the building blocks.
- `tools`: the 9 tools the agent sees; each routes an `action` to one of the operations.
- `registry`: puts the tools on a FastMCP server. `instructions`: what the server tells the agent on connect.
"""

from .instructions import MCP_INSTRUCTIONS, build_instructions
from .registry import IDEA_TOOL_TABLE, register
from .settings import ideas_enabled

__all__ = [
    "IDEA_TOOL_TABLE",
    "MCP_INSTRUCTIONS",
    "build_instructions",
    "ideas_enabled",
    "register",
]
