import json
import uuid
from datetime import datetime, timezone

from sqlalchemy import text
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

import random

from models import (
    ActivityEventRead,
    BoardType,
    IdeaColor,
    IdeaStatus,
    Member,
    Ticket,
    TicketUpdate,
)

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

    # When transitioning to "done", enforce block guards
    if update_data.get("status") == "done":
        effective_block_acs = update_data.get(
            "block_done_if_acs_incomplete", ticket.block_done_if_acs_incomplete
        )
        effective_block_tcs = update_data.get(
            "block_done_if_tcs_incomplete", ticket.block_done_if_tcs_incomplete
        )
        violations = []
        if effective_block_acs:
            acs = _loads(ticket.acceptance_criteria)
            if not acs or any(not ac.get("done") for ac in acs):
                violations.append("not all Acceptance Criteria are passed")
        if effective_block_tcs:
            tcs = _loads(ticket.test_cases)
            if not tcs or any(tc.get("status") != "pass" for tc in tcs):
                violations.append("Test Cases are missing or not all passed")
        if violations:
            raise ValueError(f"Cannot move to Done: {' and '.join(violations)}.")

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


# ---------------------------------------------------------------------------
# Extended link relationships
# ---------------------------------------------------------------------------

VALID_RELATION_TYPES = frozenset(
    {"relates_to", "causes", "caused_by", "duplicates", "duplicated_by"}
)

_INVERSE_RELATION: dict[str, str] = {
    "relates_to": "relates_to",
    "causes": "caused_by",
    "caused_by": "causes",
    "duplicates": "duplicated_by",
    "duplicated_by": "duplicates",
}


def _update_ticket_links(
    session: AsyncSession, ticket: Ticket, links: list[dict]
) -> None:
    ticket.links = _dumps(links)
    ticket.updated_at = datetime.now(UTC).isoformat()
    session.add(ticket)


async def add_ticket_link(
    session: AsyncSession,
    ticket_id: str,
    target_id: str,
    relation_type: str,
) -> dict:
    if ticket_id == target_id:
        raise ValueError("A ticket cannot link to itself")
    if relation_type not in VALID_RELATION_TYPES:
        raise ValueError(
            f"Invalid relation type '{relation_type}'. "
            f"Valid types: {sorted(VALID_RELATION_TYPES)}"
        )

    ticket = await session.get(Ticket, ticket_id)
    target = await session.get(Ticket, target_id)
    if ticket is None or target is None:
        raise ValueError("One or both tickets not found")

    if ticket.project_id != target.project_id:
        raise ValueError("Cannot link tickets across different projects.")

    ticket_links = _loads(ticket.links)
    # Dedup check
    for link in ticket_links:
        if (
            link.get("target_id") == target_id
            and link.get("relation_type") == relation_type
        ):
            return link

    new_link_id = str(uuid.uuid4())
    new_link = {
        "id": new_link_id,
        "target_id": target_id,
        "relation_type": relation_type,
    }
    ticket_links.append(new_link)
    _update_ticket_links(session, ticket, ticket_links)

    # Inverse link on target ticket
    inverse_type = _INVERSE_RELATION[relation_type]
    target_links = _loads(target.links)
    already_has_inverse = any(
        lk.get("target_id") == ticket_id and lk.get("relation_type") == inverse_type
        for lk in target_links
    )
    if not already_has_inverse:
        target_links.append(
            {
                "id": str(uuid.uuid4()),
                "target_id": ticket_id,
                "relation_type": inverse_type,
            }
        )
        _update_ticket_links(session, target, target_links)

    await session.commit()
    return new_link


async def remove_ticket_link(
    session: AsyncSession,
    ticket_id: str,
    link_id: str,
) -> bool:
    ticket = await session.get(Ticket, ticket_id)
    if ticket is None:
        return False

    ticket_links = _loads(ticket.links)
    link_to_remove = next((lk for lk in ticket_links if lk.get("id") == link_id), None)
    if link_to_remove is None:
        return False

    target_id = link_to_remove.get("target_id")
    relation_type = link_to_remove.get("relation_type")

    links_after = [lk for lk in ticket_links if lk.get("id") != link_id]
    _update_ticket_links(session, ticket, links_after)

    # Remove inverse link from target
    if target_id:
        target = await session.get(Ticket, target_id)
        if target is not None:
            inverse_type = _INVERSE_RELATION.get(relation_type, "")
            target_links = _loads(target.links)
            target_after = [
                lk
                for lk in target_links
                if not (
                    lk.get("target_id") == ticket_id
                    and lk.get("relation_type") == inverse_type
                )
            ]
            _update_ticket_links(session, target, target_after)

    await session.commit()
    return True


# ---------------------------------------------------------------------------
# Idea board service functions
# ---------------------------------------------------------------------------


async def list_idea_tickets(
    session: AsyncSession,
    project_id: str,
    status: str | None = None,
) -> list[Ticket]:
    stmt = select(Ticket).where(
        Ticket.project_id == project_id,
        Ticket.board == BoardType.idea,
    )
    if status is not None:
        stmt = stmt.where(Ticket.idea_status == status)
    result = await session.exec(stmt)
    return list(result.all())


async def create_idea_ticket(
    session: AsyncSession,
    project_id: str,
    title: str,
    description: str = "",
    tags: list | None = None,
    idea_emoji: str | None = None,
    idea_color: str | None = None,
) -> Ticket:
    if tags is None:
        tags = []
    if idea_emoji is None:
        idea_emoji = "💡"
    if idea_color is None:
        idea_color = random.choice([c.value for c in IdeaColor])

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
        description=description,
        tags=_dumps(tags),
        board=BoardType.idea,
        idea_status=IdeaStatus.draft,
        idea_emoji=idea_emoji,
        idea_color=idea_color,
    )
    session.add(ticket)
    await session.commit()
    await session.refresh(ticket)
    return ticket


async def update_idea_ticket(
    session: AsyncSession,
    ticket_id: str,
    **kwargs,
) -> Ticket | None:
    ticket = await session.get(Ticket, ticket_id)
    if ticket is None or ticket.board != BoardType.idea:
        return None

    allowed = {"title", "description", "idea_status", "idea_emoji", "idea_color", "tags"}
    if "tags" in kwargs and kwargs["tags"] is not None:
        ticket.tags = _dumps(kwargs["tags"])
    for field, value in kwargs.items():
        if field in allowed and value is not None and field != "tags":
            setattr(ticket, field, value)

    ticket.updated_at = datetime.now(UTC)
    session.add(ticket)
    await session.commit()
    await session.refresh(ticket)
    return ticket


async def promote_idea_to_board(
    session: AsyncSession,
    idea_ticket_id: str,
    project_id: str,
) -> dict | None:
    """Atomically promote an approved idea to main board. Idempotent."""
    idea = await session.get(Ticket, idea_ticket_id)
    if idea is None or idea.board != BoardType.idea:
        return None
    if idea.project_id != project_id:
        return None  # idea doesn't belong to this project

    # Idempotency: check if a main board ticket was already created for this idea
    existing_stmt = select(Ticket).where(
        Ticket.origin_idea_id == idea_ticket_id,
        Ticket.board == BoardType.main,
    )
    result = await session.exec(existing_stmt)
    existing = result.first()

    if existing is None:
        # Not yet promoted — enforce approved gate
        if idea.idea_status != IdeaStatus.approved:
            raise ValueError(f"Idea must be in 'approved' state to promote (current: {idea.idea_status})")
        # Create the main board ticket
        counter_result = await session.execute(
            text(
                "UPDATE project SET ticket_counter = ticket_counter + 1"
                " WHERE id = :pid RETURNING ticket_counter, prefix"
            ),
            {"pid": project_id},
        )
        row = counter_result.one()
        new_id = f"{row.prefix}-{row.ticket_counter}"
        now = datetime.now(UTC)
        main_ticket = Ticket(
            id=new_id,
            project_id=project_id,
            title=idea.title,
            description=idea.description or "",
            type="feature",
            priority="medium",
            status="backlog",
            tags=idea.tags or _dumps([]),
            board=BoardType.main,
            origin_idea_id=idea_ticket_id,
            created_at=now,
            updated_at=now,
        )
        session.add(main_ticket)
        existing = main_ticket

    # Always ensure idea is dropped (idempotent)
    if idea.idea_status != IdeaStatus.dropped:
        idea.idea_status = IdeaStatus.dropped
        idea.updated_at = datetime.now(UTC)
        session.add(idea)

    await session.commit()
    await session.refresh(existing)
    await session.refresh(idea)
    return {"promoted_ticket_id": existing.id, "idea_ticket_id": idea_ticket_id}
