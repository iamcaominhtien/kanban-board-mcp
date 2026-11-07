"""Ticket comments."""

import json
import services.tickets as svc_tickets
from services.ai import comment_view
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
    role: Annotated[
        str | None,
        Field(
            description="The role that speaks (Reviewer, QA, Designer...), shown on the comment."
        ),
    ] = None,
) -> dict:
    """Post a comment on a ticket: progress reports, findings, questions for the humans. Returns the updated ticket
    (the new comment is last in `comments`). In an AI run a picture or a document (an Excel sheet, a PDF) named by
    its path in your working folder is attached: ![shot](qa/evidence/TC-1.png), [sample](ba_work/sample.xlsx)."""
    text = await common.attach_from_run(text)
    meta = {"role": role.strip()[:40]} if role and role.strip() else None
    return await _edit_ticket(
        ticket_id,
        lambda s: svc_tickets.add_comment(
            s, ticket_id, text=text, author=author, meta=meta
        ),
    )


@notify_on_success
async def attach_file(
    ticket_id: TicketId,
    path: Annotated[
        str,
        Field(
            description="The file: in an AI run its path in your working folder (qa/evidence/TC-1.png); outside a board run its absolute path on this computer."
        ),
    ],
    author: Annotated[
        str, Field(description="Name shown on the comment that carries it.")
    ] = "Claude",
    text: Annotated[
        str | None,
        Field(description="What the file shows or why it is here (one line)."),
    ] = None,
    post: Annotated[
        bool,
        Field(
            description="False: keep the copy and return its markdown without a comment of its own, for a file you "
            "put in your closing report (one comment for all your files, not one each)."
        ),
    ] = True,
) -> dict:
    """Attach a file (a screenshot, a log, a report, a PDF, a spreadsheet) to a ticket: the board keeps a copy and posts
    it in a comment, so it shows in the ticket's Attachments with the comment it came from. Returns the ticket with
    `attached: {url, markdown}`; put `markdown` in a test case's proof or the description to show it there too. With
    `post=false` no comment is posted: the file shows in the Attachments once a comment (your report) holds `markdown`."""
    import os

    import uploads

    name = os.path.basename(path.strip()) or "file"
    if os.path.splitext(name)[1].lower() not in uploads.MIME_BY_EXTENSION:
        raise ValueError(
            f"{path}: not a type the board stores (png, jpg, webp, gif, pdf, txt, log, json, csv, md, xlsx, docx, zip, "
            "mp4 …). Zip it, or export it as one of those."
        )
    image = os.path.splitext(name)[1].lower() in uploads.SUPPORTED_IMAGE_EXTENSIONS
    ref = f"{'!' if image else ''}[{name}]({path.strip()})"
    folder = await common.attach_folder()
    import services.proofs as svc_proofs

    # a link to a file is only copied when it is a document; a direct attach copies any type the board stores
    try:
        stored = svc_proofs.localize(ref, folder) if folder else None
    except svc_proofs.ProofError as exc:
        raise ValueError(str(exc)) from exc
    if not stored or "/uploads/" not in stored:
        raise ValueError(
            f"{path}: not attached. Name a file in your working folder (in an AI run) or by its absolute path."
        )
    url = stored[stored.rindex("](") + 2 : -1]
    if not post:
        return {
            "ticket_id": ticket_id,
            "attached": {"url": url, "markdown": stored},
            "note": "No comment was posted: put `markdown` in your closing report, it shows the file there.",
        }
    body = f"{text.strip()}\n\n{stored}" if text and text.strip() else stored
    ticket = await _edit_ticket(
        ticket_id,
        lambda s: svc_tickets.add_comment(s, ticket_id, text=body, author=author),
    )
    return {**ticket, "attached": {"url": url, "markdown": stored}}


@notify_on_success
async def update_comment(
    ticket_id: TicketId,
    comment_id: CommentId,
    text: Annotated[
        str, Field(description="New Markdown text; replaces the old text.")
    ],
) -> dict:
    """Edit the text of an existing comment. Returns the updated ticket."""
    text = await common.attach_from_run(text)
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


async def list_comments(
    ticket_id: TicketId,
    comment_ids: Annotated[
        list[str] | None,
        Field(
            description="Only these comments (ids from get_ticket or from the list of new comments you were given)."
        ),
    ] = None,
    since: Annotated[
        str | None,
        Field(
            description="Only comments written after this ISO date/time, e.g. '2026-10-05T08:00:00Z'."
        ),
    ] = None,
) -> dict:
    """Read a ticket's comment thread, oldest first: id, author, text (Markdown), time, `edited_at` and who was
    notified. Cheaper than `get_ticket` when you only need the discussion; `comment_ids` / `since` narrow it. For an AI
    reader, other AIs' and outsiders' texts come fenced as data."""
    async with common.async_session() as session:
        ticket = await svc_tickets.get_ticket(session, ticket_id)
        if ticket is None:
            raise _missing_ticket(ticket_id)
        rows = [
            c
            for c in json.loads(ticket.comments or "[]")
            if isinstance(c, dict) and not c.get("deleted_at")
        ]
        viewed = await comment_view.for_caller(session, ticket.project_id, rows)
    held_back = 0
    if viewed is not None:
        rows, held_back = viewed["comments"], viewed["held_back"]
    comments = [
        {
            "id": c.get("id"),
            "author": c.get("author"),
            "text": c.get("text"),
            "at": c.get("at"),
            "edited_at": c.get("edited_at"),
            "notified": [n.get("name") for n in c.get("notified") or []],
        }
        for c in comment_view.pick(rows, comment_ids, since)
    ]
    out = {"ticket_id": ticket_id, "count": len(comments), "comments": comments}
    if held_back:
        out["held_back"] = (
            f"{held_back} comment(s) from outside the project are not shown: this AI member does not read "
            "external sources."
        )
    return out
