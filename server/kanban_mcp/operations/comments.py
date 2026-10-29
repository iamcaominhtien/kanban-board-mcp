"""Ticket comments."""

import json
import services.tickets as svc_tickets
from pydantic import Field
from typing import Annotated
from .. import common
from ..common import (
    CommentId,
    TicketId,
    _edit_ticket,
    _missing_ticket,
    notify_on_success,
)


@notify_on_success
async def add_comment(
    ticket_id: TicketId,
    text: Annotated[
        str,
        Field(
            description="Markdown (headings, lists, tables, code blocks, links, images). Max 50,000 chars."
        ),
    ],
    author: Annotated[
        str,
        Field(
            description="Name shown next to the comment: use your agent name (e.g. 'Claude')."
        ),
    ],
) -> dict:
    """Post a comment on a ticket: progress reports, findings, questions for the humans. Returns the updated ticket
    (the new comment is last in `comments`)."""
    return await _edit_ticket(
        ticket_id,
        lambda s: svc_tickets.add_comment(s, ticket_id, text=text, author=author),
    )


@notify_on_success
async def update_comment(
    ticket_id: TicketId,
    comment_id: CommentId,
    text: Annotated[
        str, Field(description="New Markdown text; replaces the old text.")
    ],
) -> dict:
    """Edit the text of an existing comment. Returns the updated ticket."""
    return await _edit_ticket(
        ticket_id,
        lambda s, cid: svc_tickets.update_comment(s, ticket_id, cid, text),
        ("comment", comment_id),
    )


@notify_on_success
async def delete_comment(ticket_id: TicketId, comment_id: CommentId) -> dict:
    """Delete a comment (hidden everywhere; `restore_comment` brings it back). Returns the updated ticket."""
    return await _edit_ticket(
        ticket_id,
        lambda s, cid: svc_tickets.delete_comment(s, ticket_id, cid),
        ("comment", comment_id),
    )


@notify_on_success
async def restore_comment(ticket_id: TicketId, comment_id: CommentId) -> dict:
    """Undo `delete_comment`: put a deleted comment back in the thread. Returns the updated ticket."""
    return await _edit_ticket(
        ticket_id, lambda s: svc_tickets.restore_comment(s, ticket_id, comment_id)
    )


async def list_comments(ticket_id: TicketId) -> dict:
    """Read a ticket's comment thread, oldest first: id, author, text (Markdown), time, `edited_at` and who was
    notified. Cheaper than `get_ticket` when you only need the discussion."""
    async with common.async_session() as session:
        ticket = await svc_tickets.get_ticket(session, ticket_id)
        if ticket is None:
            raise _missing_ticket(ticket_id)
        rows = json.loads(ticket.comments or "[]")
    comments = [
        {
            "id": c.get("id"),
            "author": c.get("author"),
            "text": c.get("text"),
            "at": c.get("at"),
            "edited_at": c.get("edited_at"),
            "notified": [n.get("name") for n in c.get("notified") or []],
        }
        for c in rows
        if isinstance(c, dict) and not c.get("deleted_at")
    ]
    return {"ticket_id": ticket_id, "count": len(comments), "comments": comments}
