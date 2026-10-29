"""Acceptance criteria and sub-tasks."""

import services.tickets as svc_tickets
from pydantic import Field
from typing import Annotated
from ..common import CriterionId, SubTaskId, TicketId, _edit_ticket, notify_on_success


@notify_on_success
async def add_acceptance_criterion(
    ticket_id: TicketId,
    description: Annotated[
        str,
        Field(
            description="One checkable condition, e.g. 'Login fails with a clear message on a wrong password' (max 1,000 chars)."
        ),
    ],
) -> dict:
    """Add an acceptance criterion: one checklist item that defines when the ticket is done (starts unchecked).
    Returns the updated ticket."""
    return await _edit_ticket(
        ticket_id,
        lambda s: svc_tickets.add_acceptance_criterion(s, ticket_id, text=description),
    )


@notify_on_success
async def toggle_acceptance_criterion(
    ticket_id: TicketId, criterion_id: CriterionId
) -> dict:
    """Flip a criterion between not-done and done (call it again to undo). Check the current state in the returned
    ticket's `acceptance_criteria[].done`. Returns the updated ticket."""
    return await _edit_ticket(
        ticket_id,
        lambda s, cid: svc_tickets.toggle_acceptance_criterion(s, ticket_id, cid),
        ("criterion", criterion_id),
    )


@notify_on_success
async def delete_acceptance_criterion(
    ticket_id: TicketId, criterion_id: CriterionId
) -> dict:
    """Delete a criterion permanently. Returns the updated ticket."""
    return await _edit_ticket(
        ticket_id,
        lambda s, cid: svc_tickets.delete_acceptance_criterion(s, ticket_id, cid),
        ("criterion", criterion_id),
    )


@notify_on_success
async def add_sub_task(
    ticket_id: TicketId,
    text: Annotated[
        str,
        Field(
            description="One small step, e.g. 'Confirm spec with design' (max 500 chars)."
        ),
    ],
) -> dict:
    """Add a sub-task: a checklist step inside this ticket (not a ticket; for real child tickets use parent_id).
    Returns the updated ticket."""
    return await _edit_ticket(
        ticket_id, lambda s: svc_tickets.add_sub_task(s, ticket_id, text=text)
    )


@notify_on_success
async def toggle_sub_task(ticket_id: TicketId, sub_task_id: SubTaskId) -> dict:
    """Flip a sub-task between not-done and done. Returns the updated ticket."""
    return await _edit_ticket(
        ticket_id,
        lambda s, sid: svc_tickets.toggle_sub_task(s, ticket_id, sid),
        ("sub_task", sub_task_id),
    )


@notify_on_success
async def delete_sub_task(ticket_id: TicketId, sub_task_id: SubTaskId) -> dict:
    """Delete a sub-task. Returns the updated ticket."""
    return await _edit_ticket(
        ticket_id,
        lambda s, sid: svc_tickets.delete_sub_task(s, ticket_id, sid),
        ("sub_task", sub_task_id),
    )
