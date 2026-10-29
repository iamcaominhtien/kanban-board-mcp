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


def _hide_from_ai(fn: Callable) -> Callable:
    """Inside an AI run, `docs_read` never shows a page hidden from AI (or outside "only picked"): a direct read is
    refused and lists and searches leave it out. People and other MCP clients see everything they may read."""
    from services.ai import guard

    @functools.wraps(fn)
    async def wrapper(*args, **kwargs):
        ctx = await guard.resolve()
        if ctx is None:
            return await fn(*args, **kwargs)
        from services.docs_ai import access

        from .. import common

        async with common.async_session() as session:
            hidden = await access.all_hidden_page_ids(session)
        if kwargs.get("page_id") in hidden:
            raise ValueError("That page is hidden from AI.")
        result = await fn(*args, **kwargs)
        if isinstance(result, list):
            return [r for r in result if r.get("id") not in hidden]
        if isinstance(result, dict) and isinstance(result.get("pages"), list):
            kept = [r for r in result["pages"] if r.get("page_id", r.get("id")) not in hidden]
            return {**result, "pages": kept, "total": len(kept)} if "total" in result else {**result, "pages": kept}
        return result

    return wrapper


list_tickets = _checked_read(ops.list_tickets)
get_ticket = _checked_read(ops.get_ticket)
docs_read = _checked_read(_hide_from_ai(docs_read))
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
