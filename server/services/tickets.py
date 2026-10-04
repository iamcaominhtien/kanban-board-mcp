import asyncio
import json
import uuid
from datetime import datetime, timezone

from git import GitCommandError
from rapidfuzz import fuzz
from sqlalchemy import text
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from models import (
    ActivityEventRead,
    Member,
    Project,
    Ticket,
    TicketUpdate,
)
from services import git_repo

UTC = timezone.utc

# Fuzzy search: per-field ranking weight, and the min unweighted score a
# field needs to count as a match at all.
_SEARCH_FIELD_WEIGHTS = {
    "id": 2.0,
    "title": 1.5,
    "description": 1.0,
    "tag": 1.0,
}
_SEARCH_MATCH_THRESHOLD = 70.0


def _loads(value: str) -> list:
    if not value:
        return []
    return json.loads(value)


def _dumps(value: list) -> str:
    return json.dumps(value)


def _fuzzy_score(ticket: Ticket, query: str) -> float:
    """Weighted fuzzy-match score of `query` against id/title/description/tags,
    or 0 if nothing matches closely enough."""
    query = query.strip().lower()
    if not query:
        return 100.0

    best = 0.0
    for field, weight in (
        ("id", _SEARCH_FIELD_WEIGHTS["id"]),
        ("title", _SEARCH_FIELD_WEIGHTS["title"]),
        ("description", _SEARCH_FIELD_WEIGHTS["description"]),
    ):
        value = getattr(ticket, field) or ""
        if not value:
            continue
        raw = fuzz.partial_ratio(query, value.lower())
        if raw >= _SEARCH_MATCH_THRESHOLD:
            best = max(best, raw * weight)

    for tag in _loads(ticket.tags):
        if not tag:
            continue
        raw = fuzz.partial_ratio(query, str(tag).lower())
        if raw >= _SEARCH_MATCH_THRESHOLD:
            best = max(best, raw * _SEARCH_FIELD_WEIGHTS["tag"])

    return best


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
    result = await session.exec(stmt)
    tickets = list(result.all())

    if q is not None and q.strip():
        scored = [(t, _fuzzy_score(t, q)) for t in tickets]
        scored = [(t, score) for t, score in scored if score > 0]
        scored.sort(key=lambda pair: pair[1], reverse=True)
        tickets = [t for t, _ in scored]

    return tickets


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

    # Per-ticket git repo override; empty/null falls back to the project's repo
    if "repo_path" in update_data:
        raw_repo = (update_data["repo_path"] or "").strip()
        update_data["repo_path"] = git_repo.normalize_repo_path(raw_repo) if raw_repo else None

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


async def update_comment(
    session: AsyncSession, ticket_id: str, comment_id: str, text: str
) -> Ticket | None:
    ticket = await session.get(Ticket, ticket_id)
    if ticket is None:
        return None
    comments = _loads(ticket.comments)
    found = False
    for c in comments:
        if c.get("id") == comment_id:
            c["text"] = text
            found = True
            break
    if not found:
        return None
    ticket.comments = _dumps(comments)
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
    session: AsyncSession,
    ticket_id: str,
    author: str,
    role: str,
    note: str,
    kind: str = "investigation",
    pinned: bool = False,
    attachments: list | None = None,
    linked_branch: str | None = None,
    linked_test_case: str | None = None,
) -> Ticket | None:
    ticket = await session.get(Ticket, ticket_id)
    if ticket is None:
        return None
    logs = _loads(ticket.work_log)
    now_iso = datetime.now(UTC).isoformat()
    logs.append(
        {
            "id": str(uuid.uuid4()),
            "author": author,
            "role": role,
            "note": note,
            "at": now_iso,
            "kind": kind,
            "pinned": pinned,
            "attachments": attachments or [],
            "linked_branch": linked_branch,
            "linkedBranch": linked_branch,
            "linked_test_case": linked_test_case,
            "linkedTestCase": linked_test_case,
            "updated_at": now_iso,
        }
    )
    ticket.work_log = _dumps(logs)
    ticket.updated_at = now_iso
    session.add(ticket)
    await session.commit()
    await session.refresh(ticket)
    return ticket


async def update_work_log(
    session: AsyncSession,
    ticket_id: str,
    log_id: str,
    note: str | None = None,
    kind: str | None = None,
    pinned: bool | None = None,
    attachments: list | None = None,
    linked_branch: str | None = None,
    linked_test_case: str | None = None,
    author: str | None = None,
    role: str | None = None,
) -> Ticket | None:
    ticket = await session.get(Ticket, ticket_id)
    if ticket is None:
        return None
    logs = _loads(ticket.work_log)
    found = False
    for lg in logs:
        if lg.get("id") == log_id:
            found = True
            if note is not None:
                lg["note"] = note
            if kind is not None:
                lg["kind"] = kind
            if pinned is not None:
                lg["pinned"] = pinned
            if attachments is not None:
                lg["attachments"] = attachments
            if linked_branch is not None:
                lg["linked_branch"] = linked_branch
                lg["linkedBranch"] = linked_branch
            if linked_test_case is not None:
                lg["linked_test_case"] = linked_test_case
                lg["linkedTestCase"] = linked_test_case
            if author is not None:
                lg["author"] = author
            if role is not None:
                lg["role"] = role
            lg["updated_at"] = datetime.now(UTC).isoformat()
            break
    if not found:
        return None
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
    description: str | None = None,
    expected_result: str | None = None,
    notes: str | None = None,
    assignee: str | None = None,
    test_data_files: list | None = None,
) -> Ticket | None:
    ticket = await session.get(Ticket, ticket_id)
    if ticket is None:
        return None
    tcs = _loads(ticket.test_cases)
    # Determine human-readable TC code (TC-1, TC-2, ...)
    max_num = 0
    for item in tcs:
        c = item.get("code") or ""
        if c.startswith("TC-"):
            try:
                num = int(c.split("-")[1])
                if num > max_num:
                    max_num = num
            except ValueError:
                pass
    tc_code = f"TC-{max(len(tcs) + 1, max_num + 1)}"
    now_iso = datetime.now(UTC).isoformat()

    new_tc = {
        "id": str(uuid.uuid4()),
        "code": tc_code,
        "title": title,
        "status": status,
        "description": description,
        "expected_result": expected_result,
        "notes": notes if notes is not None else note,
        "proof": proof,
        "note": note,
        "started_at": now_iso if status == "running" else None,
        "created_at": now_iso,
        "updated_at": now_iso,
        "assignee": assignee,
        "test_data_files": test_data_files or [],
    }
    tcs.append(new_tc)
    ticket.test_cases = _dumps(tcs)
    ticket.updated_at = now_iso
    session.add(ticket)
    await session.commit()
    await session.refresh(ticket)
    return ticket


async def update_test_case(
    session: AsyncSession,
    ticket_id: str,
    tc_id: str,
    status: str | None = None,
    proof: str | None = None,
    note: str | None = None,
    title: str | None = None,
    description: str | None = None,
    expected_result: str | None = None,
    notes: str | None = None,
    assignee: str | None = None,
    test_data_files: list | None = None,
) -> Ticket | None:
    ticket = await session.get(Ticket, ticket_id)
    if ticket is None:
        return None
    tcs = _loads(ticket.test_cases)
    for tc in tcs:
        if tc.get("id") == tc_id:
            old_status = tc.get("status")
            if status is not None:
                tc["status"] = status
                if status == "running" and old_status != "running":
                    tc["started_at"] = datetime.now(UTC).isoformat()
            if title is not None:
                tc["title"] = title
            if description is not None:
                tc["description"] = description
            if expected_result is not None:
                tc["expected_result"] = expected_result
            if notes is not None:
                tc["notes"] = notes
            if proof is not None:
                tc["proof"] = proof
            if note is not None:
                tc["note"] = note
            if assignee is not None:
                tc["assignee"] = assignee
            if test_data_files is not None:
                tc["test_data_files"] = test_data_files
            tc["updated_at"] = datetime.now(UTC).isoformat()
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
# Sub-entity: branches
# ---------------------------------------------------------------------------

VALID_BRANCH_STATUSES = {"baseline", "open", "merged", "stale", "archived"}


async def list_branches(
    session: AsyncSession, ticket_id: str
) -> list[dict] | None:
    ticket = await session.get(Ticket, ticket_id)
    if ticket is None:
        return None
    branches = _loads(getattr(ticket, "branches", "[]"))
    repo_path = await _project_repo_path(session, ticket)
    if repo_path:
        branches = await asyncio.to_thread(_sync_branches_with_git, repo_path, branches)
    return branches


async def _project_repo_path(session: AsyncSession, ticket: Ticket) -> str | None:
    """Effective repo for a ticket: its own override, else the project's."""
    if getattr(ticket, "repo_path", None):
        return ticket.repo_path
    project = await session.get(Project, ticket.project_id)
    return project.repo_path if project else None


def _sync_branches_with_git(repo_path: str, branches: list[dict]) -> list[dict]:
    """Overlay live commit hash and ahead/behind counts from the git repo."""
    repo = git_repo.open_repo(repo_path)
    current = git_repo.current_branch(repo)
    synced = []
    for br in branches:
        br = dict(br)
        br.update(is_current=br.get("name") == current, isCurrent=br.get("name") == current)
        if br.get("status") != "baseline":
            try:
                info = git_repo.branch_info(repo, br["name"], br.get("branch_from") or "main")
            except (git_repo.GitRepoError, GitCommandError):
                # Branch not in this repo (e.g. repo was changed): keep stored values
                br.update(in_repo=False, inRepo=False)
                synced.append(br)
                continue
            br.update(
                in_repo=True,
                inRepo=True,
                commit_hash=info.commit_hash,
                commitHash=info.commit_hash,
                ahead_count=info.ahead_count,
                aheadCount=info.ahead_count,
                behind_count=info.behind_count,
                behindCount=info.behind_count,
            )
        synced.append(br)
    return synced


async def add_branch(
    session: AsyncSession,
    ticket_id: str,
    name: str,
    branch_from: str = "main",
    status: str = "open",
    pr_url: str | None = None,
    commit_hash: str | None = None,
    linked_ticket_id: str | None = None,
    ahead_count: int = 0,
    behind_count: int = 0,
    create_worktree: bool = False,
    worktree_path: str | None = None,
) -> Ticket | None:
    ticket = await session.get(Ticket, ticket_id)
    if ticket is None:
        return None
    if status not in VALID_BRANCH_STATUSES:
        raise ValueError(
            f"Invalid branch status '{status}'. Valid statuses: {sorted(VALID_BRANCH_STATUSES)}"
        )
    branches = _loads(getattr(ticket, "branches", "[]"))
    repo_path = await _project_repo_path(session, ticket)
    resolved_worktree_path: str | None = None
    wants_worktree = create_worktree or bool(worktree_path and worktree_path.strip())
    if wants_worktree and not repo_path:
        raise ValueError(
            "A git worktree needs a linked repository: set a repo path on the project or ticket first"
        )
    if repo_path:
        # Real git repo linked: create the branch there and use its true state.
        def _create() -> git_repo.BranchInfo:
            return git_repo.create_branch(git_repo.open_repo(repo_path), name, branch_from)

        info = await asyncio.to_thread(_create)
        commit_hash = info.commit_hash
        ahead_count = info.ahead_count
        behind_count = info.behind_count

        if create_worktree:
            project = await session.get(Project, ticket.project_id)
            prefix = project.prefix if project else "PRJ"
            template = (
                worktree_path.strip()
                if worktree_path and worktree_path.strip()
                else (
                    project.worktree_template
                    if project and project.worktree_template
                    else "../worktrees/{project}/{ticket_id}-{branch}"
                )
            )
            target_wt = git_repo.resolve_worktree_path(
                template, repo_path, prefix, ticket.id, name
            )

            def _make_wt() -> str:
                return git_repo.add_worktree(git_repo.open_repo(repo_path), target_wt, name)

            try:
                resolved_worktree_path = await asyncio.to_thread(_make_wt)
            except Exception:
                # Don't leave an orphan branch behind when the worktree can't be made
                await asyncio.to_thread(
                    git_repo.delete_branch, git_repo.open_repo(repo_path), name, True
                )
                raise

    now_iso = datetime.now(UTC).isoformat()
    new_branch = {
        "id": str(uuid.uuid4()),
        "name": name,
        "status": status,
        "branch_from": branch_from,
        "branchFrom": branch_from,
        "pr_url": pr_url,
        "prUrl": pr_url,
        "commit_hash": commit_hash,
        "commitHash": commit_hash,
        "linked_ticket_id": linked_ticket_id,
        "linkedTicketId": linked_ticket_id,
        "ahead_count": ahead_count,
        "aheadCount": ahead_count,
        "behind_count": behind_count,
        "behindCount": behind_count,
        "worktree_path": resolved_worktree_path,
        "worktreePath": resolved_worktree_path,
        "created_at": now_iso,
        "createdAt": now_iso,
        "updated_at": now_iso,
        "updatedAt": now_iso,
    }
    branches.append(new_branch)
    ticket.branches = _dumps(branches)
    ticket.updated_at = now_iso
    session.add(ticket)
    await session.commit()
    await session.refresh(ticket)
    return ticket


def _git_guard_update(
    repo_path: str, br: dict, new_name: str | None, new_status: str | None, base: str | None
) -> None:
    """Apply/verify the git side of a branch update before the board record changes."""
    repo = git_repo.open_repo(repo_path)
    old_name = br["name"]
    if not git_repo.branch_exists(repo, old_name):
        return  # branch isn't in this repo (e.g. repo changed): board-only update
    if new_status == "merged" and br.get("status") != "merged":
        base_ref = base or "main"
        if not git_repo.is_merged(repo, old_name, base_ref):
            raise git_repo.GitRepoError(
                f"'{old_name}' still has commits that are not in '{base_ref}'; merge it in git first"
            )
    if new_name and new_name != old_name:
        git_repo.rename_branch(repo, old_name, new_name)


async def update_branch(
    session: AsyncSession,
    ticket_id: str,
    branch_id: str,
    name: str | None = None,
    status: str | None = None,
    branch_from: str | None = None,
    pr_url: str | None = None,
    commit_hash: str | None = None,
    linked_ticket_id: str | None = None,
    ahead_count: int | None = None,
    behind_count: int | None = None,
    remove_worktree: bool = False,
    worktree_path: str | None = None,
) -> Ticket | None:
    ticket = await session.get(Ticket, ticket_id)
    if ticket is None:
        return None
    if status is not None and status not in VALID_BRANCH_STATUSES:
        raise ValueError(
            f"Invalid branch status '{status}'. Valid statuses: {sorted(VALID_BRANCH_STATUSES)}"
        )
    branches = _loads(getattr(ticket, "branches", "[]"))
    found = False
    now_iso = datetime.now(UTC).isoformat()
    repo_for_git = await _project_repo_path(session, ticket)
    for br in branches:
        if br.get("id") == branch_id:
            found = True
            if repo_for_git and br.get("status") != "baseline":
                await asyncio.to_thread(
                    _git_guard_update,
                    repo_for_git,
                    br,
                    name,
                    status,
                    branch_from if branch_from is not None else br.get("branch_from"),
                )
            if name is not None:
                br["name"] = name
            if status is not None:
                br["status"] = status
            if branch_from is not None:
                br["branch_from"] = branch_from
                br["branchFrom"] = branch_from
            if pr_url is not None:
                br["pr_url"] = pr_url
                br["prUrl"] = pr_url
            if commit_hash is not None:
                br["commit_hash"] = commit_hash
                br["commitHash"] = commit_hash
            if linked_ticket_id is not None:
                br["linked_ticket_id"] = linked_ticket_id
                br["linkedTicketId"] = linked_ticket_id
            if ahead_count is not None:
                br["ahead_count"] = ahead_count
                br["aheadCount"] = ahead_count
            if behind_count is not None:
                br["behind_count"] = behind_count
                br["behindCount"] = behind_count
            if remove_worktree and br.get("worktree_path"):
                repo_path = await _project_repo_path(session, ticket)
                if repo_path:
                    wt = br["worktree_path"]
                    # Errors propagate: the board must not claim the worktree is gone
                    await asyncio.to_thread(
                        git_repo.remove_worktree, git_repo.open_repo(repo_path), wt, True
                    )
                br["worktree_path"] = None
                br["worktreePath"] = None
            elif worktree_path is not None:
                br["worktree_path"] = worktree_path if worktree_path.strip() else None
                br["worktreePath"] = br["worktree_path"]
            br["updated_at"] = now_iso
            br["updatedAt"] = now_iso
            break
    if not found:
        return None
    ticket.branches = _dumps(branches)
    ticket.updated_at = now_iso
    session.add(ticket)
    await session.commit()
    await session.refresh(ticket)
    return ticket


async def delete_branch(
    session: AsyncSession,
    ticket_id: str,
    branch_id: str,
    remove_worktree: bool = False,
    delete_git_branch: bool = False,
    force: bool = False,
) -> Ticket | None:
    ticket = await session.get(Ticket, ticket_id)
    if ticket is None:
        return None
    branches = _loads(getattr(ticket, "branches", "[]"))
    target = next((b for b in branches if b.get("id") == branch_id), None)
    repo_path = await _project_repo_path(session, ticket)
    if repo_path and target:
        # Git first: if any step fails, raise before the board record is touched.
        def _git_cleanup() -> None:
            repo = git_repo.open_repo(repo_path)
            if remove_worktree and target.get("worktree_path"):
                git_repo.remove_worktree(repo, target["worktree_path"], True)
            if delete_git_branch and target.get("status") != "baseline":
                git_repo.delete_branch(repo, target["name"], force)

        await asyncio.to_thread(_git_cleanup)

    ticket.branches = _dumps([br for br in branches if br.get("id") != branch_id])
    ticket.updated_at = datetime.now(UTC).isoformat()
    session.add(ticket)
    await session.commit()
    await session.refresh(ticket)
    return ticket


async def checkout_branch(session: AsyncSession, ticket_id: str, branch_id: str) -> Ticket | None:
    """Check out a ticket branch in the linked repository's main working tree."""
    ticket = await session.get(Ticket, ticket_id)
    if ticket is None:
        return None
    branches = _loads(getattr(ticket, "branches", "[]"))
    target = next((b for b in branches if b.get("id") == branch_id), None)
    if target is None:
        return None
    repo_path = await _project_repo_path(session, ticket)
    if not repo_path:
        raise ValueError("Link a git repository to this project or ticket before checking out branches")
    await asyncio.to_thread(
        lambda: git_repo.checkout_branch(git_repo.open_repo(repo_path), target["name"])
    )
    return ticket
