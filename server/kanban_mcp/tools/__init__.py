"""The 9 tools the agent sees. Each is a family of related operations picked with `action`.

Why so few: an agent pays for every tool description and schema on every session. Grouping by noun keeps all the
capabilities while the tool list shrinks to a fraction of its size. The operations themselves live in
`kanban_mcp.operations` (one function per verb); a tool only routes `action` (and `item` for ticket sub-items) to one
of them. Annotations are per tool, so a tool that can delete is marked destructive as a whole.
"""

from collections.abc import Callable

from mcp.types import ToolAnnotations

from .. import operations as ops
from .branches import ticket_branches
from .docs import docs_read, docs_write
from .items import ticket_items
from .projects import get_projects, manage_project
from .tickets import manage_ticket

_READ = ToolAnnotations(readOnlyHint=True, openWorldHint=False)
_DESTRUCTIVE = ToolAnnotations(
    readOnlyHint=False, destructiveHint=True, idempotentHint=False, openWorldHint=False
)

CORE_TOOL_TABLE: list[tuple[Callable, ToolAnnotations]] = [
    (get_projects, _READ),
    (ops.list_tickets, _READ),
    (ops.get_ticket, _READ),
    (docs_read, _READ),
    (manage_project, _DESTRUCTIVE),  # remove_member
    (manage_ticket, _DESTRUCTIVE),  # delete, unlink
    (ticket_items, _DESTRUCTIVE),  # delete
    (ticket_branches, _DESTRUCTIVE),  # delete (optionally the git branch)
    (docs_write, _DESTRUCTIVE),  # delete
]
