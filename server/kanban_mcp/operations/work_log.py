"""The work log (the "Debug Space" tab)."""

import services.tickets as svc_tickets
from pydantic import Field
from typing import Annotated
from ..common import (
    TicketId,
    WorkLogId,
    WorkLogKind,
    WorkLogRole,
    _edit_ticket,
    notify_on_success,
)


@notify_on_success
async def add_work_log(
    ticket_id: TicketId,
    author: Annotated[str, Field(description="Who wrote it: use your agent name.")],
    role: Annotated[WorkLogRole, Field(description="The author's role on this work.")],
    note: Annotated[str, Field(description="Markdown, max 20,000 chars.")],
    kind: Annotated[
        WorkLogKind,
        Field(
            description="investigation: what you looked at; fix_attempt: something you tried; root_cause: the cause you found; blocked: stuck (shows a red dot on the ticket until a later 'resolved' entry); resolved: fixed."
        ),
    ] = "investigation",
    pinned: Annotated[
        bool, Field(description="Keep this entry at the top of the list.")
    ] = False,
    linked_branch: Annotated[
        str | None,
        Field(
            description="NAME of an existing branch of this ticket this entry is about."
        ),
    ] = None,
    linked_test_case: Annotated[
        str | None,
        Field(
            description="Code ('TC-2') or id of an existing test case of this ticket."
        ),
    ] = None,
) -> dict:
    """Append an entry to the ticket's debug journal (the Debug Space tab): keep a running record of what you investigated,
    tried and found, so humans (and later sessions) can follow along. Returns the updated ticket."""
    return await _edit_ticket(
        ticket_id,
        lambda s: svc_tickets.add_work_log(
            s,
            ticket_id,
            author=author,
            role=role,
            note=note,
            kind=kind,
            pinned=pinned,
            linked_branch=linked_branch,
            linked_test_case=linked_test_case,
        ),
    )


@notify_on_success
async def update_work_log(
    ticket_id: TicketId,
    log_id: WorkLogId,
    note: Annotated[
        str | None, Field(description="New Markdown note; replaces the old one.")
    ] = None,
    kind: WorkLogKind | None = None,
    pinned: bool | None = None,
    linked_branch: Annotated[
        str | None,
        Field(description="Branch NAME to link; an empty string '' removes the link."),
    ] = None,
    linked_test_case: Annotated[
        str | None,
        Field(
            description="Test case code/id to link; an empty string '' removes the link."
        ),
    ] = None,
) -> dict:
    """Correct or extend a work log entry. To record that a problem is fixed, add a new entry with kind 'resolved'
    instead of editing the old one (that keeps the history). Omitted fields are unchanged. Returns the updated ticket."""
    return await _edit_ticket(
        ticket_id,
        lambda s, lid: svc_tickets.update_work_log(
            s,
            ticket_id,
            lid,
            note=note,
            kind=kind,
            pinned=pinned,
            linked_branch=linked_branch,
            linked_test_case=linked_test_case,
        ),
        ("work_log", log_id),
    )


@notify_on_success
async def delete_work_log(ticket_id: TicketId, log_id: WorkLogId) -> dict:
    """Delete a work log entry permanently. Returns the updated ticket."""
    return await _edit_ticket(
        ticket_id,
        lambda s, lid: svc_tickets.delete_work_log(s, ticket_id, lid),
        ("work_log", log_id),
    )
