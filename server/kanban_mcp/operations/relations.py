"""Blocks and links between tickets."""

import services.tickets as svc_tickets
from pydantic import Field
from typing import Annotated
from .. import common
from ..common import (
    RelationType,
    TicketId,
    _missing_ticket,
    _ticket_to_dict,
    notify_on_success,
)


@notify_on_success
async def block_ticket(
    blocker_id: Annotated[
        str, Field(description="Ticket ID that must be finished first, e.g. 'IAM-3'.")
    ],
    blocked_id: Annotated[
        str, Field(description="Ticket ID that has to wait, e.g. 'IAM-4'.")
    ],
) -> dict:
    """Record that `blocker_id` blocks `blocked_id` ('IAM-4 cannot proceed until IAM-3 is done'); the blocked ticket shows
    a lock on the board. Both tickets must be in the same project; circular chains are refused. Statuses do not change.
    Returns {blocker, blocked} (both updated tickets)."""
    async with common.async_session() as session:
        result = await svc_tickets.link_block(session, blocker_id, blocked_id)
        if result is None:
            raise ValueError(
                f"Ticket '{blocker_id}' or '{blocked_id}' not found. Use list_tickets to see ticket IDs."
            )
        blocker, blocked = result
        return {
            "blocker": _ticket_to_dict(blocker),
            "blocked": _ticket_to_dict(blocked),
        }


@notify_on_success
async def unblock_ticket(
    blocker_id: Annotated[str, Field(description="Ticket ID that was blocking.")],
    blocked_id: Annotated[str, Field(description="Ticket ID that was blocked.")],
) -> dict:
    """Remove a block created by block_ticket (e.g. because the dependency no longer applies). Returns {blocker, blocked}."""
    async with common.async_session() as session:
        result = await svc_tickets.unlink_block(session, blocker_id, blocked_id)
        if result is None:
            raise ValueError(
                f"Ticket '{blocker_id}' or '{blocked_id}' not found. Use list_tickets to see ticket IDs."
            )
        blocker, blocked = result
        return {
            "blocker": _ticket_to_dict(blocker),
            "blocked": _ticket_to_dict(blocked),
        }


@notify_on_success
async def link_tickets(
    ticket_id: TicketId,
    target_id: Annotated[
        str, Field(description="The other ticket's ID (same project).")
    ],
    relation_type: Annotated[
        RelationType,
        Field(
            description="How `ticket_id` relates to `target_id`: relates_to, causes, caused_by, duplicates, duplicated_by. The inverse is added on the target automatically."
        ),
    ],
) -> dict:
    """Create a non-blocking relation between two tickets (use block_ticket for dependencies).
    Returns {id, target_id, relation_type}; keep `id` if you may need unlink_tickets later."""
    async with common.async_session() as session:
        return await svc_tickets.add_ticket_link(
            session, ticket_id, target_id, relation_type
        )


@notify_on_success
async def unlink_tickets(
    ticket_id: Annotated[
        str,
        Field(
            description="The SAME ticket you passed as `ticket_id` to link_tickets (a link has a different id on each of the two tickets)."
        ),
    ],
    link_id: Annotated[
        str,
        Field(
            description="Link id returned by link_tickets, or from that ticket's `links` list in get_ticket."
        ),
    ],
) -> dict:
    """Remove a relation made by link_tickets (and its inverse on the other ticket). Returns {"removed": link_id}."""
    async with common.async_session() as session:
        ticket = await svc_tickets.get_ticket(session, ticket_id)
        if ticket is None:
            raise _missing_ticket(ticket_id)
        removed = await svc_tickets.remove_ticket_link(session, ticket_id, link_id)
    if not removed:
        raise ValueError(
            f"Link '{link_id}' not found on {ticket_id}. A link has a different id on each of its two tickets: use the "
            f"ticket you gave to manage_ticket(action='link'), or read the ids from get_ticket('{ticket_id}').links."
        )
    return {"removed": link_id}
