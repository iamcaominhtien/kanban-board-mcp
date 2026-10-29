"""The 11 tools the agent sees (9, plus ai_run for runs the board started and ai_schedules). Each is a family of related operations picked with `action`.

Why so few: an agent pays for every tool description and schema on every session. Grouping by noun keeps all the
capabilities while the tool list shrinks to a fraction of its size. The operations themselves live in
`kanban_mcp.operations` (one function per verb); a tool only routes `action` (and `item` for ticket sub-items) to one
of them. Annotations are per tool, so a tool that can delete is marked destructive as a whole.
"""

import functools
from collections.abc import Callable

from mcp.types import ToolAnnotations

from .. import operations as ops
from .ai_run import ai_run
from .branches import ticket_branches
from .docs import docs_read, docs_write
from .items import ticket_items
from .projects import get_projects, manage_project
from .schedules import ai_schedules
from .tickets import manage_ticket

_READ = ToolAnnotations(readOnlyHint=True, openWorldHint=False)


def _checked_read(fn: Callable) -> Callable:
    """A read tool that honours the "Read tickets" permission of an AI run (the guard checks it)."""
    from services.ai import guard

    @functools.wraps(fn)
    async def wrapper(*args, **kwargs):
        return await guard.guarded(
            fn.__name__, "read", kwargs, lambda _g: fn(*args, **kwargs)
        )

    return wrapper


list_tickets = _checked_read(ops.list_tickets)
get_ticket = _checked_read(ops.get_ticket)
docs_read = _checked_read(docs_read)
_WRITE = ToolAnnotations(
    readOnlyHint=False, destructiveHint=False, idempotentHint=False, openWorldHint=False
)
_DESTRUCTIVE = ToolAnnotations(
    readOnlyHint=False, destructiveHint=True, idempotentHint=False, openWorldHint=False
)

CORE_TOOL_TABLE: list[tuple[Callable, ToolAnnotations]] = [
    (get_projects, _READ),
    (list_tickets, _READ),
    (get_ticket, _READ),
    (docs_read, _READ),
    (manage_project, _DESTRUCTIVE),  # remove_member
    (manage_ticket, _DESTRUCTIVE),  # delete, unlink
    (ticket_items, _DESTRUCTIVE),  # delete
    (ticket_branches, _DESTRUCTIVE),  # delete (optionally the git branch)
    (docs_write, _DESTRUCTIVE),  # delete
    (ai_run, _WRITE),  # only inside a run the board started for an AI member
    (ai_schedules, _DESTRUCTIVE),  # delete
]
