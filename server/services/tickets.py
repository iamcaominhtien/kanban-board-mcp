import json
import uuid
from datetime import datetime, timezone

from sqlalchemy import text
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from models import ActivityEventRead, Member, Ticket, TicketUpdate

UTC = timezone.utc


def _loads(value: str) -> list:
    if not value:
        return []
    return json.loads(value)


def _dumps(value: list) -> str:
    return json.dumps(value)


async def list_tickets(
    session: AsyncSession,
    project_id: str,
    status: str | None = None,
    priority: str | None = None,
    q: str | None = None,
    include_wont_do: bool = False,
) -> list[Ticket]:
    stmt = select(Ticket).where(Ticket.project_id == project_id)
    if status is not None:
        stmt = stmt.where(Ticket.status == status)
    elif not include_wont_do:
        stmt = stmt.where(Ticket.status != "wont_do")
    if priority is not None:
        stmt = stmt.where(Ticket.priority == priority)
    if q is not None:
        escaped = q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        stmt = stmt.where(Ticket.title.ilike(f"%{escaped}%", escape="\\"))
    result = await session.exec(stmt)
    return list(result.all())


async def get_ticket(session: AsyncSession, ticket_id: str) -> Ticket | None:
    return await session.get(Ticket, ticket_id)


async def create_ticket(
    session: AsyncSession,
    project_id: str,
    title: str,
    type: str = "task",
    priority: str = "medium",
    status: str = "backlog",
    description: str = "",
    parent_id: str | None = None,
    estimate: float | None = None,
    due_date: str | None = None,
    start_date: str | None = None,
    tags: list | None = None,
    created_by: str | None = None,
    assignee: str | None = None,
) -> Ticket:
    if tags is None:
        tags = []

    if parent_id is not None:
        parent = await session.get(Ticket, parent_id)
        if parent is None:
            raise ValueError(f"Parent ticket '{parent_id}' not found")
        if parent.parent_id is not None:
            raise ValueError("Cannot nest tickets more than 1 level deep")

    # Validate assignee belongs to this project
    if assignee is not None:
        assignee_member = await session.get(Member, assignee)
        if assignee_member is None or assignee_member.project_id != project_id:
            raise ValueError("Assignee must be a member of this project")

    # Auto-assign created_by to first available member if not provided
    if created_by is None:
        first_member = await session.exec(
            select(Member).where(Member.project_id == project_id).limit(1)
        )
        m = first_member.first()
        if m is not None:
            created_by = m.id

    result = await session.execute(
        text(
            "UPDATE project SET ticket_counter = ticket_counter + 1"
            " WHERE id = :pid RETURNING ticket_counter, prefix"
        ),
        {"pid": project_id},
    )
    row = result.one()
    ticket_id = f"{row.prefix}-{row.ticket_counter}"

    ticket = Ticket(
        id=ticket_id,
        project_id=project_id,
        title=title,
        type=type,
        priority=priority,
        status=status,
        description=description,
        parent_id=parent_id,
        estimate=estimate,
        due_date=due_date,
        start_date=start_date,
        tags=_dumps(tags),
        created_by=created_by,
        assignee=assignee,
    )
    session.add(ticket)
    await session.commit()
    await session.refresh(ticket)
    return ticket


_AUDITABLE = (
    "title",
    "status",
    "priority",
    "type",
    "estimate",
    "due_date",
    "start_date",
)


async def update_ticket(
    session: AsyncSession, ticket_id: str, data: TicketUpdate
) -> Ticket | None:
    ticket = await session.get(Ticket, ticket_id)
    if ticket is None:
        return None

    update_data = data.model_dump(exclude_unset=True)

    if (
        update_data.get("status") == "wont_do"
        and not (update_data.get("wont_do_reason") or "").strip()
    ):
        raise ValueError("wont_do_reason is required when status is wont_do")

    if update_data.get("status") == "wont_do" and ticket.parent_id is not None:
        raise ValueError("Child tickets cannot be set to wont_do")

    # Validate assignee belongs to the ticket's project
    if "assignee" in update_data and update_data["assignee"] is not None:
        assignee_member = await session.get(Member, update_data["assignee"])
        if assignee_member is None or assignee_member.project_id != ticket.project_id:
            raise ValueError("Assignee must be a member of this project")

    # Clear wont_do_reason when transitioning away from wont_do
    if "status" in update_data and update_data["status"] != "wont_do":
        update_data.setdefault("wont_do_reason", None)

    activity = _loads(ticket.activity_log)

    for field, new_val in update_data.items():
        old_val = getattr(ticket, field)
        if field in _AUDITABLE and old_val != new_val:
            activity.append(
                {
                    "field": field,
                    "from": old_val,
                    "to": new_val,
                    "at": datetime.now(UTC).isoformat(),
                }
            )
        # JSON list fields need serialization
        if field == "tags":
            setattr(ticket, field, _dumps(new_val))
        else:
            setattr(ticket, field, new_val)

    ticket.activity_log = _dumps(activity)
    ticket.updated_at = datetime.now(UTC).isoformat()

    session.add(ticket)
    await session.commit()
    await session.refresh(ticket)
    return ticket


async def delete_ticket(session: AsyncSession, ticket_id: str) -> bool:
    ticket = await session.get(Ticket, ticket_id)
    if ticket is None:
        return False
    await session.delete(ticket)
    await session.commit()
    return True


# ---------------------------------------------------------------------------
# Sub-entity: comments
# ---------------------------------------------------------------------------


async def add_comment(
    session: AsyncSession, ticket_id: str, text: str, author: str = "user"
) -> Ticket | None:
    ticket = await session.get(Ticket, ticket_id)
    if ticket is None:
        return None
    comments = _loads(ticket.comments)
    comments.append(
        {
            "id": str(uuid.uuid4()),
            "text": text,
            "author": author,
            "at": datetime.now(UTC).isoformat(),
        }
    )
    ticket.comments = _dumps(comments)
    ticket.updated_at = datetime.now(UTC).isoformat()
    session.add(ticket)
    await session.commit()
    await session.refresh(ticket)
    return ticket


async def delete_comment(
    session: AsyncSession, ticket_id: str, comment_id: str
) -> Ticket | None:
    ticket = await session.get(Ticket, ticket_id)
    if ticket is None:
        return None
    comments = _loads(ticket.comments)
    ticket.comments = _dumps([c for c in comments if c.get("id") != comment_id])
    ticket.updated_at = datetime.now(UTC).isoformat()
    session.add(ticket)
    await session.commit()
    await session.refresh(ticket)
    return ticket


# ---------------------------------------------------------------------------
# Sub-entity: acceptance criteria
# ---------------------------------------------------------------------------


async def add_acceptance_criterion(
    session: AsyncSession, ticket_id: str, text: str
) -> Ticket | None:
    ticket = await session.get(Ticket, ticket_id)
    if ticket is None:
        return None
    acs = _loads(ticket.acceptance_criteria)
    acs.append({"id": str(uuid.uuid4()), "text": text, "done": False})
    ticket.acceptance_criteria = _dumps(acs)
    ticket.updated_at = datetime.now(UTC).isoformat()
    session.add(ticket)
    await session.commit()
    await session.refresh(ticket)
    return ticket


async def toggle_acceptance_criterion(
    session: AsyncSession, ticket_id: str, criterion_id: str
) -> Ticket | None:
    ticket = await session.get(Ticket, ticket_id)
    if ticket is None:
        return None
    acs = _loads(ticket.acceptance_criteria)
    for ac in acs:
        if ac.get("id") == criterion_id:
            ac["done"] = not ac.get("done", False)
            break
    ticket.acceptance_criteria = _dumps(acs)
    ticket.updated_at = datetime.now(UTC).isoformat()
    session.add(ticket)
    await session.commit()
    await session.refresh(ticket)
    return ticket


async def delete_acceptance_criterion(
    session: AsyncSession, ticket_id: str, criterion_id: str
) -> Ticket | None:
    ticket = await session.get(Ticket, ticket_id)
    if ticket is None:
        return None
    acs = _loads(ticket.acceptance_criteria)
    ticket.acceptance_criteria = _dumps([a for a in acs if a.get("id") != criterion_id])
    ticket.updated_at = datetime.now(UTC).isoformat()
    session.add(ticket)
    await session.commit()
    await session.refresh(ticket)
    return ticket


# ---------------------------------------------------------------------------
# Sub-entity: work log
# ---------------------------------------------------------------------------


async def add_work_log(
    session: AsyncSession, ticket_id: str, author: str, role: str, note: str
) -> Ticket | None:
    ticket = await session.get(Ticket, ticket_id)
    if ticket is None:
        return None
    logs = _loads(ticket.work_log)
    logs.append(
        {
            "id": str(uuid.uuid4()),
            "author": author,
            "role": role,
            "note": note,
            "at": datetime.now(UTC).isoformat(),
        }
    )
    ticket.work_log = _dumps(logs)
    ticket.updated_at = datetime.now(UTC).isoformat()
    session.add(ticket)
    await session.commit()
    await session.refresh(ticket)
    return ticket


async def delete_work_log(
    session: AsyncSession, ticket_id: str, log_id: str
) -> Ticket | None:
    ticket = await session.get(Ticket, ticket_id)
    if ticket is None:
        return None
    logs = _loads(ticket.work_log)
    ticket.work_log = _dumps([lg for lg in logs if lg.get("id") != log_id])
    ticket.updated_at = datetime.now(UTC).isoformat()
    session.add(ticket)
    await session.commit()
    await session.refresh(ticket)
    return ticket


# ---------------------------------------------------------------------------
# Sub-entity: test cases
# ---------------------------------------------------------------------------


async def add_test_case(
    session: AsyncSession,
    ticket_id: str,
    title: str,
    status: str = "pending",
    proof: str | None = None,
    note: str | None = None,
) -> Ticket | None:
    ticket = await session.get(Ticket, ticket_id)
    if ticket is None:
        return None
    tcs = _loads(ticket.test_cases)
    tcs.append(
        {
            "id": str(uuid.uuid4()),
            "title": title,
            "status": status,
            "proof": proof,
            "note": note,
        }
    )
    ticket.test_cases = _dumps(tcs)
    ticket.updated_at = datetime.now(UTC).isoformat()
    session.add(ticket)
    await session.commit()
    await session.refresh(ticket)
    return ticket


async def update_test_case(
    session: AsyncSession,
    ticket_id: str,
    tc_id: str,
    status: str,
    proof: str | None = None,
    note: str | None = None,
) -> Ticket | None:
    ticket = await session.get(Ticket, ticket_id)
    if ticket is None:
        return None
    tcs = _loads(ticket.test_cases)
    for tc in tcs:
        if tc.get("id") == tc_id:
            tc["status"] = status
            if proof is not None:
                tc["proof"] = proof
            if note is not None:
                tc["note"] = note
            break
    ticket.test_cases = _dumps(tcs)
    ticket.updated_at = datetime.now(UTC).isoformat()
    session.add(ticket)
    await session.commit()
    await session.refresh(ticket)
    return ticket


async def delete_test_case(
    session: AsyncSession, ticket_id: str, tc_id: str
) -> Ticket | None:
    ticket = await session.get(Ticket, ticket_id)
    if ticket is None:
        return None
    tcs = _loads(ticket.test_cases)
    ticket.test_cases = _dumps([t for t in tcs if t.get("id") != tc_id])
    ticket.updated_at = datetime.now(UTC).isoformat()
    session.add(ticket)
    await session.commit()
    await session.refresh(ticket)
    return ticket


async def get_project_activities(
    session: AsyncSession, project_id: str, limit: int = 200
) -> list[ActivityEventRead]:
    tickets = await list_tickets(session, project_id, include_wont_do=True)
    events: list[ActivityEventRead] = []
    for ticket in tickets:
        events.append(
            ActivityEventRead(
                ticketId=ticket.id,
                ticketTitle=ticket.title,
                event_type="created",
                at=ticket.created_at,
                detail=None,
            )
        )
        for entry in _loads(ticket.activity_log):
            events.append(
                ActivityEventRead(
                    ticketId=ticket.id,
                    ticketTitle=ticket.title,
                    event_type=f"changed:{entry.get('field', '')}",
                    at=entry.get("at", ticket.created_at),
                    detail=f"{entry.get('from')} \u2192 {entry.get('to')}",
                )
            )
        for comment in _loads(ticket.comments):
            events.append(
                ActivityEventRead(
                    ticketId=ticket.id,
                    ticketTitle=ticket.title,
                    event_type="commented",
                    at=comment.get("at", ticket.created_at),
                    detail=comment.get("text", ""),
                )
            )
    events.sort(key=lambda e: e.at, reverse=True)
    return events[:limit]


# ---------------------------------------------------------------------------
# Block / Blocked-by relationships
# ---------------------------------------------------------------------------


async def link_block(
    session: AsyncSession, blocker_id: str, blocked_id: str
) -> tuple[Ticket, Ticket] | None:
    """Make blocker_id block blocked_id. Updates both tickets."""
    if blocker_id == blocked_id:
        raise ValueError("A ticket cannot block itself")
    blocker = await session.get(Ticket, blocker_id)
    blocked = await session.get(Ticket, blocked_id)
    if blocker is None or blocked is None:
        return None

    blocker_blocks = _loads(blocker.blocks)
    if blocked_id not in blocker_blocks:
        blocker_blocks.append(blocked_id)
    blocker.blocks = _dumps(blocker_blocks)
    blocker.updated_at = datetime.now(UTC).isoformat()

    blocked_by_list = _loads(blocked.blocked_by)
    if blocker_id not in blocked_by_list:
        blocked_by_list.append(blocker_id)
    blocked.blocked_by = _dumps(blocked_by_list)
    blocked.updated_at = datetime.now(UTC).isoformat()

    session.add(blocker)
    session.add(blocked)
    await session.commit()
    await session.refresh(blocker)
    await session.refresh(blocked)
    return blocker, blocked


async def unlink_block(
    session: AsyncSession, blocker_id: str, blocked_id: str
) -> tuple[Ticket, Ticket] | None:
    """Remove block relationship between the two tickets."""
    blocker = await session.get(Ticket, blocker_id)
    blocked = await session.get(Ticket, blocked_id)
    if blocker is None or blocked is None:
        return None

    blocker_blocks = _loads(blocker.blocks)
    blocker.blocks = _dumps([x for x in blocker_blocks if x != blocked_id])
    blocker.updated_at = datetime.now(UTC).isoformat()

    blocked_by_list = _loads(blocked.blocked_by)
    blocked.blocked_by = _dumps([x for x in blocked_by_list if x != blocker_id])
    blocked.updated_at = datetime.now(UTC).isoformat()

    session.add(blocker)
    session.add(blocked)
    await session.commit()
    await session.refresh(blocker)
    await session.refresh(blocked)
    return blocker, blocked
