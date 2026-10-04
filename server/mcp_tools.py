import json
from datetime import datetime, timezone
from functools import wraps
from typing import Literal

import events as board_events
from mcp.server.fastmcp import FastMCP
from pydantic import ValidationError
from sqlalchemy import text
from sqlalchemy.exc import NoResultFound

import services.idea_tickets as svc_idea_tickets
import services.members as svc_members
import services.projects as svc_projects
import services.activity as svc_activity
import services.tickets as svc_tickets
import services.workspace as svc_workspace
from database import async_session
from models import (
    IDEA_COLORS,
    IDEA_STATUSES,
    IdeaTicketRead,
    MemberRead,
    ProjectCreate,
    ProjectRead,
    Ticket,
    TicketRead,
    TicketUpdate,
)

_UNSET = object()
_VALID_IDEA_STATUSES = frozenset(IDEA_STATUSES)
_VALID_IDEA_COLORS = frozenset(IDEA_COLORS)


def _ticket_to_dict(ticket: Ticket) -> dict:
    """Serialize a Ticket to dict."""
    return TicketRead.from_ticket(ticket).model_dump()


def _idea_ticket_to_dict(ticket) -> dict:
    """Serialize an IdeaTicket to dict."""
    return IdeaTicketRead.from_idea_ticket(ticket).model_dump()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _next_ticket_id(session, project_id: str) -> str:
    """Increment project ticket_counter and return the next ticket ID (e.g. 'IAM-5')."""
    result = await session.execute(
        text(
            "UPDATE project SET ticket_counter = ticket_counter + 1"
            " WHERE id = :pid RETURNING ticket_counter, prefix"
        ),
        {"pid": project_id},
    )
    row = result.one()
    return f"{row.prefix}-{row.ticket_counter}"


def notify_on_success(func):
    """Decorator that publishes an SSE invalidation event after a successful mutation."""

    @wraps(func)
    async def wrapper(*args, **kwargs):
        # Changes made through MCP tools are attributed to the AI agent
        token = svc_activity.set_actor(svc_activity.AGENT_ACTOR)
        try:
            result = await func(*args, **kwargs)
        finally:
            svc_activity.reset_actor(token)
        if result is not None:
            await board_events.publish(board_events.INVALIDATE)
        return result

    return wrapper


async def list_projects() -> list[dict]:
    """List all projects on the Kanban board. Returns id, name, prefix, color, ticket_counter."""
    async with async_session() as session:
        projects = await svc_projects.list_projects(session)
        return [ProjectRead.model_validate(p).model_dump() for p in projects]


@notify_on_success
async def create_project(name: str, prefix: str, color: str = "#6366f1") -> dict:
    """Create a new Kanban project.

    Args:
        name: Human-readable project name (e.g. "My App")
        prefix: Short uppercase ticket prefix, max 6 chars (e.g. "MYAPP")
        color: Hex accent color for the project (e.g. "#6366f1")

    Returns the created project.
    """
    async with async_session() as session:
        data = ProjectCreate(name=name, prefix=prefix.upper(), color=color)
        project = await svc_projects.create_project(session, data)
        result = ProjectRead.model_validate(project).model_dump()
    return result


async def list_tickets(
    project_id: str,
    status: str | None = None,
    priority: str | None = None,
    q: str | None = None,
) -> list[dict]:
    """List tickets for a project.

    Optionally filter by status (backlog/todo/in-progress/done),
    priority (low/medium/high/critical), or search text (q matches title).
    Returns list of full ticket objects.
    """
    async with async_session() as session:
        tickets = await svc_tickets.list_tickets(
            session,
            project_id,
            status=status,
            priority=priority,
            q=q,
            include_wont_do=True,
        )
        return [_ticket_to_dict(t) for t in tickets]


@notify_on_success
async def create_ticket(
    project_id: str,
    title: str,
    type: Literal["bug", "feature", "task", "chore"] = "task",
    priority: Literal["low", "medium", "high", "critical"] = "medium",
    status: Literal[
        "backlog", "todo", "in-progress", "review", "testing", "done"
    ] = "backlog",
    description: str = "",
    parent_id: str | None = None,
    estimate: float | None = None,
    due_date: str | None = None,
    tags: list[str] | None = None,
) -> dict | None:
    """Create a new ticket in a project. The ticket ID is auto-generated as PREFIX-N (e.g. IAM-5).

    Args:
        project_id: The project's UUID
        title: Ticket title (required)
        type: bug | feature | task | chore (default: task)
        priority: low | medium | high | critical (default: medium)
        status: backlog | todo | in-progress | review | testing | done (default: backlog)
        description: Markdown description
        parent_id: Optional parent ticket ID for subtasks (max 1 level deep)
        estimate: Story points (e.g. 1, 2, 3, 5, 8)
        due_date: ISO date string (e.g. "2026-04-15")
        tags: List of tag strings

    Returns the created ticket.
    """
    try:
        async with async_session() as session:
            ticket = await svc_tickets.create_ticket(
                session,
                project_id=project_id,
                title=title,
                type=type,
                priority=priority,
                status=status,
                description=description,
                parent_id=parent_id,
                estimate=estimate,
                due_date=due_date,
                tags=tags or [],
            )
            result = TicketRead.from_ticket(ticket).model_dump()
    except NoResultFound:
        raise ValueError(f"Project not found: {project_id}")
    return result


async def get_ticket(ticket_id: str) -> dict | None:
    """Get the full details of a ticket by its ID (e.g. 'IAM-1').

    Returns the ticket or None if not found.
    """
    async with async_session() as session:
        ticket = await svc_tickets.get_ticket(session, ticket_id)
        if ticket is None:
            return None
        data = TicketRead.from_ticket(ticket).model_dump()
        info = await svc_workspace.get_workspace_path(session, ticket_id, create=False)
        if info is not None and info["enabled"]:
            data["workspace_path"] = info["path"]
        return data


async def get_ticket_workspace_path(ticket_id: str) -> dict | None:
    """Get the local scratch folder for a ticket (e.g. 'IAM-1').

    The folder is created if missing. Read and write files in it directly with
    your own file tools - temporary logs, repro scripts, screenshots, drafts.
    Returns {enabled, path, exists}, or None if the ticket does not exist.
    When enabled is false the Workspace feature is turned off; do not use it.
    """
    async with async_session() as session:
        return await svc_workspace.get_workspace_path(session, ticket_id, create=True)


@notify_on_success
async def update_ticket_status(
    ticket_id: str,
    status: Literal[
        "backlog", "todo", "in-progress", "review", "testing", "done", "wont_do"
    ],
    wont_do_reason: str | None = None,
) -> dict | None:
    """Update the status of a ticket. Valid statuses: backlog, todo, in-progress, review, testing, done, wont_do.

    `wont_do_reason` is required when status is "wont_do" (child tickets cannot be set to wont_do).
    Automatically appends a status change entry to the ticket's activity log.
    Returns the updated ticket or None if not found.
    """
    data: dict = {"status": status}
    if wont_do_reason is not None:
        data["wont_do_reason"] = wont_do_reason
    try:
        async with async_session() as session:
            ticket = await svc_tickets.update_ticket(session, ticket_id, TicketUpdate(**data))
            if ticket is None:
                return None
            result = TicketRead.from_ticket(ticket).model_dump()
    except ValidationError as exc:
        raise ValueError(str(exc)) from exc
    return result


_CLEARABLE_FIELDS = frozenset(
    {"estimate", "due_date", "start_date", "parent_id", "assignee", "repo_path", "wont_do_reason"}
)


@notify_on_success
async def update_ticket(
    ticket_id: str,
    title: str | None = None,
    description: str | None = None,
    type: Literal["bug", "feature", "task", "chore"] | None = None,
    priority: Literal["low", "medium", "high", "critical"] | None = None,
    status: (
        Literal[
            "backlog", "todo", "in-progress", "review", "testing", "done", "wont_do"
        ]
        | None
    ) = None,
    estimate: float | None = None,
    due_date: str | None = None,
    start_date: str | None = None,
    parent_id: str | None = None,
    tags: list[str] | None = None,
    assignee: str | None = None,
    repo_path: str | None = None,
    wont_do_reason: str | None = None,
    block_done_if_acs_incomplete: bool | None = None,
    block_done_if_tcs_incomplete: bool | None = None,
    clear_fields: list[str] | None = None,
) -> dict | None:
    """Update one or more fields on a ticket. Only provided (non-None) fields are updated.
    Returns the updated ticket dict, or None if not found.

    - `assignee` is a member id of the ticket's project (see list_members).
    - `status="wont_do"` requires `wont_do_reason` (child tickets cannot be set to wont_do).
    - `block_done_if_*_incomplete` make moving to Done fail until all acceptance criteria / test cases pass.
    - Passing None means "leave unchanged". To empty a nullable field, list it in `clear_fields`
      (any of: estimate, due_date, start_date, parent_id, assignee, repo_path, wont_do_reason).
    """
    fields = {
        "title": title,
        "description": description,
        "type": type,
        "priority": priority,
        "status": status,
        "estimate": estimate,
        "due_date": due_date,
        "start_date": start_date,
        "parent_id": parent_id,
        "tags": tags,
        "assignee": assignee,
        "repo_path": repo_path,
        "wont_do_reason": wont_do_reason,
        "block_done_if_acs_incomplete": block_done_if_acs_incomplete,
        "block_done_if_tcs_incomplete": block_done_if_tcs_incomplete,
    }
    update_data = {k: v for k, v in fields.items() if v is not None}
    for name in clear_fields or []:
        if name not in _CLEARABLE_FIELDS:
            raise ValueError(
                f"Cannot clear '{name}'. Clearable fields: {sorted(_CLEARABLE_FIELDS)}"
            )
        if name in update_data:
            raise ValueError(f"'{name}' was both set and listed in clear_fields")
        update_data[name] = None
    try:
        async with async_session() as session:
            ticket = await svc_tickets.update_ticket(
                session, ticket_id, TicketUpdate(**update_data)
            )
            if ticket is None:
                return None
            result = TicketRead.from_ticket(ticket).model_dump()
    except ValidationError as exc:
        raise ValueError(str(exc)) from exc
    return result


@notify_on_success
async def delete_ticket(ticket_id: str) -> dict | None:
    """Permanently delete a ticket. Child tickets are detached, and block/link references
    to it are removed from other tickets. Returns {"deleted": ticket_id} or None if not found."""
    async with async_session() as session:
        found = await svc_tickets.delete_ticket(session, ticket_id)
    return {"deleted": ticket_id} if found else None


@notify_on_success
async def block_ticket(blocker_id: str, blocked_id: str) -> dict | None:
    """Make `blocker_id` block `blocked_id` (same project, no circular chains).
    Returns both updated tickets, or None if either is missing."""
    async with async_session() as session:
        result = await svc_tickets.link_block(session, blocker_id, blocked_id)
        if result is None:
            return None
        blocker, blocked = result
        return {
            "blocker": TicketRead.from_ticket(blocker).model_dump(),
            "blocked": TicketRead.from_ticket(blocked).model_dump(),
        }


@notify_on_success
async def unblock_ticket(blocker_id: str, blocked_id: str) -> dict | None:
    """Remove the block between `blocker_id` and `blocked_id`. Returns both updated tickets."""
    async with async_session() as session:
        result = await svc_tickets.unlink_block(session, blocker_id, blocked_id)
        if result is None:
            return None
        blocker, blocked = result
        return {
            "blocker": TicketRead.from_ticket(blocker).model_dump(),
            "blocked": TicketRead.from_ticket(blocked).model_dump(),
        }


@notify_on_success
async def link_tickets(
    ticket_id: str,
    target_id: str,
    relation_type: Literal[
        "relates_to", "causes", "caused_by", "duplicates", "duplicated_by"
    ],
) -> dict:
    """Link two tickets of the same project (the inverse link is added on the target).
    Returns the created link {id, target_id, relation_type}."""
    async with async_session() as session:
        return await svc_tickets.add_ticket_link(session, ticket_id, target_id, relation_type)


@notify_on_success
async def unlink_tickets(ticket_id: str, link_id: str) -> dict | None:
    """Remove a link (and its inverse on the other ticket). Returns {"removed": link_id} or None."""
    async with async_session() as session:
        removed = await svc_tickets.remove_ticket_link(session, ticket_id, link_id)
    return {"removed": link_id} if removed else None


@notify_on_success
async def delete_test_case(ticket_id: str, test_case_id: str) -> dict | None:
    """Delete a test case from a ticket. Returns the updated ticket."""
    async with async_session() as session:
        ticket = await svc_tickets.delete_test_case(session, ticket_id, test_case_id)
        if ticket is None:
            return None
        return TicketRead.from_ticket(ticket).model_dump()


@notify_on_success
async def checkout_branch(ticket_id: str, branch_id: str) -> dict | None:
    """Check out a ticket branch in the linked git repository's working tree.
    Returns the updated ticket, or None if not found."""
    async with async_session() as session:
        ticket = await svc_tickets.checkout_branch(session, ticket_id, branch_id)
        if ticket is None:
            return None
        return TicketRead.from_ticket(ticket).model_dump()


@notify_on_success
async def add_comment(ticket_id: str, text: str, author: str) -> dict | None:
    """Add a comment to a ticket. `text` supports full Markdown (headings, lists,
    tables, code blocks, links, images, etc.). Returns the updated ticket."""
    async with async_session() as session:
        ticket = await svc_tickets.add_comment(
            session, ticket_id, text=text, author=author
        )
        if ticket is None:
            return None
        result = TicketRead.from_ticket(ticket).model_dump()
    return result


@notify_on_success
async def update_comment(ticket_id: str, comment_id: str, text: str) -> dict | None:
    """Edit an existing comment's text. `text` supports full Markdown (headings,
    lists, tables, code blocks, links, images, etc.). Returns the updated ticket."""
    async with async_session() as session:
        ticket = await svc_tickets.update_comment(session, ticket_id, comment_id, text)
        if ticket is None:
            return None
        result = TicketRead.from_ticket(ticket).model_dump()
    return result


@notify_on_success
async def delete_comment(ticket_id: str, comment_id: str) -> dict | None:
    """Delete a comment from a ticket. Returns the updated ticket."""
    async with async_session() as session:
        ticket = await svc_tickets.delete_comment(session, ticket_id, comment_id)
        if ticket is None:
            return None
        result = TicketRead.from_ticket(ticket).model_dump()
    return result


@notify_on_success
async def add_work_log(
    ticket_id: str,
    author: str,
    role: Literal["PM", "Developer", "BA", "Tester", "Designer", "Other"],
    note: str,
    kind: Literal["investigation", "fix_attempt", "root_cause", "blocked", "resolved"] = "investigation",
    pinned: bool = False,
    linked_branch: str | None = None,
    linked_test_case: str | None = None,
) -> dict | None:
    """Log work or debug entry on a ticket. Returns the updated ticket."""
    async with async_session() as session:
        ticket = await svc_tickets.add_work_log(
            session,
            ticket_id,
            author=author,
            role=role,
            note=note,
            kind=kind,
            pinned=pinned,
            linked_branch=linked_branch,
            linked_test_case=linked_test_case,
        )
        if ticket is None:
            return None
        result = TicketRead.from_ticket(ticket).model_dump()
    return result


@notify_on_success
async def update_work_log(
    ticket_id: str,
    log_id: str,
    note: str | None = None,
    kind: Literal["investigation", "fix_attempt", "root_cause", "blocked", "resolved"] | None = None,
    pinned: bool | None = None,
    linked_branch: str | None = None,
    linked_test_case: str | None = None,
) -> dict | None:
    """Update a work or debug entry on a ticket. Returns the updated ticket."""
    async with async_session() as session:
        ticket = await svc_tickets.update_work_log(
            session,
            ticket_id,
            log_id,
            note=note,
            kind=kind,
            pinned=pinned,
            linked_branch=linked_branch,
            linked_test_case=linked_test_case,
        )
        if ticket is None:
            return None
        result = TicketRead.from_ticket(ticket).model_dump()
    return result


@notify_on_success
async def delete_work_log(ticket_id: str, log_id: str) -> dict | None:
    """Delete a work or debug entry from a ticket. Returns the updated ticket."""
    async with async_session() as session:
        ticket = await svc_tickets.delete_work_log(session, ticket_id, log_id)
        if ticket is None:
            return None
        result = TicketRead.from_ticket(ticket).model_dump()
    return result


@notify_on_success
async def add_test_case(
    ticket_id: str,
    title: str,
    status: Literal["pending", "running", "pass", "fail"] = "pending",
    description: str | None = None,
    expected_result: str | None = None,
    notes: str | None = None,
    proof: str | None = None,
    note: str | None = None,
    assignee: str | None = None,
) -> dict | None:
    """Add a test case to a ticket. Returns the updated ticket."""
    async with async_session() as session:
        ticket = await svc_tickets.add_test_case(
            session,
            ticket_id,
            title=title,
            status=status,
            proof=proof,
            note=note,
            description=description,
            expected_result=expected_result,
            notes=notes,
            assignee=assignee,
        )
        if ticket is None:
            return None
        result = TicketRead.from_ticket(ticket).model_dump()
    return result


@notify_on_success
async def update_test_case(
    ticket_id: str,
    test_case_id: str,
    title: str | None = None,
    status: Literal["pending", "running", "pass", "fail"] | None = None,
    description: str | None = None,
    expected_result: str | None = None,
    notes: str | None = None,
    proof: str | None = None,
    note: str | None = None,
    assignee: str | None = None,
) -> dict | None:
    """Update a test case's status, title, description, expected_result, notes, or assignee. Returns the updated ticket."""
    async with async_session() as session:
        ticket = await svc_tickets.get_ticket(session, ticket_id)
        if ticket is None:
            return None
        tcs = json.loads(ticket.test_cases) if ticket.test_cases else []
        current = next((tc for tc in tcs if tc.get("id") == test_case_id), None)
        if current is None:
            return None
        updated = await svc_tickets.update_test_case(
            session,
            ticket_id,
            test_case_id,
            title=title,
            status=status,
            proof=proof,
            note=note,
            description=description,
            expected_result=expected_result,
            notes=notes,
            assignee=assignee,
        )
        if updated is None:
            return None
        result = TicketRead.from_ticket(updated).model_dump()
    return result


@notify_on_success
async def add_branch(
    ticket_id: str,
    name: str,
    branch_from: str = "main",
    status: Literal["baseline", "open", "merged", "stale", "archived"] = "open",
    pr_url: str | None = None,
    commit_hash: str | None = None,
    linked_ticket_id: str | None = None,
    ahead_count: int = 0,
    behind_count: int = 0,
) -> dict | None:
    """Create a branch on a ticket. Returns the updated ticket."""
    async with async_session() as session:
        ticket = await svc_tickets.add_branch(
            session,
            ticket_id,
            name=name,
            branch_from=branch_from,
            status=status,
            pr_url=pr_url,
            commit_hash=commit_hash,
            linked_ticket_id=linked_ticket_id,
            ahead_count=ahead_count,
            behind_count=behind_count,
        )
        if ticket is None:
            return None
        result = TicketRead.from_ticket(ticket).model_dump()
    return result


@notify_on_success
async def update_branch(
    ticket_id: str,
    branch_id: str,
    name: str | None = None,
    status: Literal["baseline", "open", "merged", "stale", "archived"] | None = None,
    branch_from: str | None = None,
    pr_url: str | None = None,
    commit_hash: str | None = None,
    linked_ticket_id: str | None = None,
    ahead_count: int | None = None,
    behind_count: int | None = None,
) -> dict | None:
    """Update a branch on a ticket. Returns the updated ticket."""
    async with async_session() as session:
        ticket = await svc_tickets.update_branch(
            session,
            ticket_id,
            branch_id,
            name=name,
            status=status,
            branch_from=branch_from,
            pr_url=pr_url,
            commit_hash=commit_hash,
            linked_ticket_id=linked_ticket_id,
            ahead_count=ahead_count,
            behind_count=behind_count,
        )
        if ticket is None:
            return None
        result = TicketRead.from_ticket(ticket).model_dump()
    return result


@notify_on_success
async def delete_branch(
    ticket_id: str,
    branch_id: str,
) -> dict | None:
    """Delete a branch from a ticket. Returns the updated ticket."""
    async with async_session() as session:
        ticket = await svc_tickets.delete_branch(session, ticket_id, branch_id)
        if ticket is None:
            return None
        result = TicketRead.from_ticket(ticket).model_dump()
    return result


@notify_on_success
async def create_child_ticket(
    parent_ticket_id: str,
    title: str,
    type: Literal["bug", "feature", "task", "chore"] = "task",
    priority: Literal["low", "medium", "high", "critical"] = "medium",
    description: str = "",
) -> dict | None:
    """Create a child ticket under an existing ticket. Returns the new ticket dict, or None if parent not found."""
    try:
        async with async_session() as session:
            parent = await svc_tickets.get_ticket(session, parent_ticket_id)
            if parent is None:
                return None
            ticket = await svc_tickets.create_ticket(
                session,
                project_id=parent.project_id,
                parent_id=parent_ticket_id,
                title=title,
                type=type,
                priority=priority,
                description=description,
            )
            result = TicketRead.from_ticket(ticket).model_dump()
    except (NoResultFound, ValueError):
        return None
    return result


@notify_on_success
async def add_acceptance_criterion(ticket_id: str, description: str) -> dict | None:
    """Add a new acceptance criterion to a ticket. Returns the updated ticket."""
    async with async_session() as session:
        ticket = await svc_tickets.add_acceptance_criterion(
            session, ticket_id, text=description
        )
        if ticket is None:
            return None
        result = TicketRead.from_ticket(ticket).model_dump()
    return result


@notify_on_success
async def toggle_acceptance_criterion(ticket_id: str, criterion_id: str) -> dict | None:
    """Toggle the done/not-done state of an acceptance criterion. Returns the updated ticket."""
    async with async_session() as session:
        ticket = await svc_tickets.toggle_acceptance_criterion(
            session, ticket_id, criterion_id
        )
        if ticket is None:
            return None
        result = TicketRead.from_ticket(ticket).model_dump()
    return result


@notify_on_success
async def delete_acceptance_criterion(ticket_id: str, criterion_id: str) -> dict | None:
    """Remove an acceptance criterion from a ticket. Returns the updated ticket."""
    async with async_session() as session:
        ticket = await svc_tickets.delete_acceptance_criterion(
            session, ticket_id, criterion_id
        )
        if ticket is None:
            return None
        result = TicketRead.from_ticket(ticket).model_dump()
    return result


async def list_members(project_id: str) -> list[dict]:
    """List all members of a project. Returns id, name, color, project_id, created_at."""
    async with async_session() as session:
        members = await svc_members.list_members(session, project_id)
        return [MemberRead.model_validate(m).model_dump() for m in members]


@notify_on_success
async def add_member(project_id: str, name: str, color: str | None = None) -> dict:
    """Add a member to a project.

    Args:
        project_id: The project UUID
        name: Member's display name
        color: Optional hex color for avatar background (auto-assigned if not provided)

    Returns the created member.
    """
    async with async_session() as session:
        member = await svc_members.create_member(session, project_id, name, color)
        result = MemberRead.model_validate(member).model_dump()
    return result


@notify_on_success
async def remove_member(project_id: str, member_id: str) -> dict:
    """Remove a member from a project.

    Cannot remove if member created any tickets.
    Tickets assigned to the member will be unassigned first.
    Returns a dict {"ok": bool}.
    """
    async with async_session() as session:
        try:
            removed = await svc_members.remove_member(session, project_id, member_id)
        except ValueError as exc:
            return {"ok": False, "error": str(exc)}
        result = {"ok": removed}
    return result


async def list_idea_tickets(
    project_id: str,
    idea_status: str | None = None,
    q: str | None = None,
) -> list[dict]:
    """List idea tickets for a project.

    Args:
        project_id: The project UUID
        idea_status: Optional filter by status (draft | in_review | approved | dropped)
        q: Optional substring search on title and description

    Returns list ordered by last_touched_at descending.
    """
    if idea_status is not None and idea_status not in _VALID_IDEA_STATUSES:
        return {
            "error": f"Invalid idea_status '{idea_status}'. Valid values: {', '.join(sorted(_VALID_IDEA_STATUSES))}"
        }
    async with async_session() as session:
        tickets = await svc_idea_tickets.list_idea_tickets(
            session, project_id=project_id, idea_status=idea_status, q=q
        )
        return [_idea_ticket_to_dict(t) for t in tickets]


@notify_on_success
async def create_idea_ticket(
    project_id: str,
    title: str,
    description: str = "",
    idea_color: str = "yellow",
    idea_emoji: str = "💡",
    idea_energy: str | None = None,
    tags: list[str] | None = None,
    problem_statement: str | None = None,
) -> dict | None:
    """Create a new idea ticket. ID is auto-generated as IDEA-N (global counter).

    Args:
        project_id: The project UUID (required)
        title: Idea title (required)
        description: Markdown description
        idea_color: Named color (yellow, orange, lime, pink, blue, purple, teal) — default: yellow
        idea_emoji: Single emoji character (default 💡)
        idea_energy: low | medium | high
        tags: List of tag strings
        problem_statement: Markdown problem statement

    Returns the created idea ticket.
    """
    if idea_color not in _VALID_IDEA_COLORS:
        return {"error": f"idea_color must be one of: {', '.join(sorted(IDEA_COLORS))}"}
    try:
        async with async_session() as session:
            ticket = await svc_idea_tickets.create_idea_ticket(
                session,
                project_id=project_id,
                title=title,
                description=description,
                idea_color=idea_color,
                idea_emoji=idea_emoji,
                idea_energy=idea_energy,
                tags=tags or [],
                problem_statement=problem_statement,
            )
            result = _idea_ticket_to_dict(ticket)
    except ValueError as exc:
        return {"error": str(exc)}
    return result


async def get_idea_ticket(ticket_id: str) -> dict | None:
    """Get the full details of an idea ticket by its ID (e.g. 'IDEA-1').

    Returns the idea ticket or None if not found.
    """
    async with async_session() as session:
        ticket = await svc_idea_tickets.get_idea_ticket(session, ticket_id)
        if ticket is None:
            return None
        return _idea_ticket_to_dict(ticket)


@notify_on_success
async def update_idea_ticket(
    ticket_id: str,
    title: str | None = None,
    description: str | None = None,
    idea_color: str | None = None,
    idea_emoji: str | None = None,
    idea_energy: str | None = _UNSET,
    tags: list[str] | None = None,
    problem_statement: str | None = _UNSET,
    ice_impact: int | None = None,
    ice_effort: int | None = None,
    ice_confidence: int | None = None,
    revisit_date: str | None = _UNSET,
) -> dict | None:
    """Update one or more fields on an idea ticket. Only provided (non-None) fields are updated.

    Nullable fields (idea_energy, problem_statement, revisit_date) can be explicitly cleared
    to None by passing null. ICE values are auto-clamped to 1–5.
    Updates last_touched_at and appends to activity_trail.
    Returns the updated idea ticket, or None if not found.
    """
    if idea_color is not None and idea_color not in _VALID_IDEA_COLORS:
        return {"error": f"idea_color must be one of: {', '.join(sorted(IDEA_COLORS))}"}
    _nullable = {"idea_energy", "problem_statement", "revisit_date"}
    fields = {
        "title": title,
        "description": description,
        "idea_color": idea_color,
        "idea_emoji": idea_emoji,
        "idea_energy": idea_energy,
        "tags": tags,
        "problem_statement": problem_statement,
        "ice_impact": ice_impact,
        "ice_effort": ice_effort,
        "ice_confidence": ice_confidence,
        "revisit_date": revisit_date,
    }
    update_data = {
        k: v
        for k, v in fields.items()
        if v is not _UNSET and (v is not None or k in _nullable)
    }
    try:
        async with async_session() as session:
            ticket = await svc_idea_tickets.update_idea_ticket(
                session, ticket_id, **update_data
            )
            if ticket is None:
                return None
            result = _idea_ticket_to_dict(ticket)
    except ValueError as exc:
        return {"error": str(exc)}
    return result


@notify_on_success
async def delete_idea_ticket(ticket_id: str) -> dict | None:
    """Delete an idea ticket by its ID. Returns {"deleted": true} if successful, None if not found.

    If the idea was previously promoted to a Kanban ticket, the linked ticket is NOT deleted.
    """
    async with async_session() as session:
        deleted = await svc_idea_tickets.delete_idea_ticket(session, ticket_id)
        if not deleted:
            return None
        return {"deleted": True}


@notify_on_success
async def update_idea_status(
    ticket_id: str,
    new_status: Literal["draft", "in_review", "approved", "dropped"],
    reason: str | None = None,
) -> dict | None:
    """Transition an idea ticket to a new status.

    Allowed transitions:
    draft → in_review | dropped
    in_review → approved | draft | dropped
    approved → dropped
    dropped → draft

    Args:
        ticket_id: The idea ticket ID (e.g. 'IDEA-1')
        new_status: Target status
        reason: Optional reason for the transition (appended to activity trail)

    Returns the updated idea ticket, or {"error": ...} if transition is invalid.
    """
    if new_status not in _VALID_IDEA_STATUSES:
        return {
            "error": f"Invalid status '{new_status}'. Must be one of: {', '.join(sorted(_VALID_IDEA_STATUSES))}"
        }
    try:
        async with async_session() as session:
            ticket = await svc_idea_tickets.update_idea_status(
                session, ticket_id, new_status=new_status, reason=reason
            )
            result = _idea_ticket_to_dict(ticket)
    except ValueError as exc:
        return {"error": str(exc)}
    return result


@notify_on_success
async def promote_idea_to_ticket(
    idea_ticket_id: str,
    project_id: str,
    title: str | None = None,
    type_: Literal["bug", "feature", "task", "chore"] = "feature",
    priority: Literal["low", "medium", "high", "critical"] = "medium",
) -> dict | None:
    """Promote an approved idea ticket to a real Kanban ticket.

    Requirements:
    - idea_status must be 'approved'
    - problem_statement must be set and non-empty
    - idea must not have been previously promoted

    Args:
        idea_ticket_id: The idea ticket ID (e.g. 'IDEA-1')
        project_id: The target project UUID
        title: Optional override for the ticket title (defaults to idea title)
        type_: bug | feature | task | chore (default: feature)
        priority: low | medium | high | critical (default: medium)

    Returns the newly created Kanban ticket, or {"error": ...} on failure.
    """
    try:
        async with async_session() as session:
            new_ticket = await svc_idea_tickets.promote_idea_to_ticket(
                session,
                idea_ticket_id=idea_ticket_id,
                project_id=project_id,
                title=title,
                type_=type_,
                priority=priority,
            )
            result = _ticket_to_dict(new_ticket)
    except ValueError as exc:
        return {"error": str(exc)}
    return result


@notify_on_success
async def add_assumption(ticket_id: str, text: str) -> dict | None:
    """Add an assumption to an idea ticket.

    Args:
        ticket_id: The idea ticket ID (e.g. 'IDEA-1')
        text: The assumption text (max 500 chars)

    Returns the updated idea ticket, or {"error": ...} on failure.
    """
    if not text or not text.strip():
        return {"error": "text cannot be empty"}
    try:
        async with async_session() as session:
            ticket = await svc_idea_tickets.add_assumption(session, ticket_id, text)
            result = _idea_ticket_to_dict(ticket)
    except ValueError as exc:
        return {"error": str(exc)}
    return result


@notify_on_success
async def add_microthought(ticket_id: str, text: str) -> dict | None:
    """Add a microthought to an idea ticket.

    Args:
        ticket_id: The idea ticket ID (e.g. 'IDEA-1')
        text: The microthought text (max 500 chars)

    Returns the updated idea ticket, or {"error": ...} on failure.
    """
    try:
        async with async_session() as session:
            ticket = await svc_idea_tickets.add_microthought(session, ticket_id, text)
            result = _idea_ticket_to_dict(ticket)
    except ValueError as exc:
        return {"error": str(exc)}
    return result


@notify_on_success
async def update_assumption_status(
    ticket_id: str,
    assumption_id: str,
    status: Literal["untested", "validated", "invalidated"],
) -> dict | None:
    """Update the status of an assumption on an idea ticket.

    Args:
        ticket_id: The idea ticket ID (e.g. 'IDEA-1')
        assumption_id: The UUID of the assumption to update
        status: New status — untested | validated | invalidated

    Returns the updated idea ticket, or {"error": ...} on failure.
    """
    try:
        async with async_session() as session:
            ticket = await svc_idea_tickets.update_assumption_status(
                session, ticket_id, assumption_id, status
            )
            result = _idea_ticket_to_dict(ticket)
    except ValueError as exc:
        return {"error": str(exc)}
    return result


@notify_on_success
async def delete_assumption(ticket_id: str, assumption_id: str) -> dict | None:
    """Delete an assumption from an idea ticket by its ID.

    Args:
        ticket_id: The idea ticket ID (e.g. 'IDEA-1')
        assumption_id: The UUID of the assumption to delete

    Returns the updated idea ticket, or {"error": ...} on failure.
    """
    try:
        async with async_session() as session:
            ticket = await svc_idea_tickets.delete_assumption(
                session, ticket_id, assumption_id
            )
            result = _idea_ticket_to_dict(ticket)
    except ValueError as exc:
        return {"error": str(exc)}
    return result


@notify_on_success
async def delete_microthought(ticket_id: str, microthought_id: str) -> dict | None:
    """Delete a microthought from an idea ticket by its ID.

    Args:
        ticket_id: The idea ticket ID (e.g. 'IDEA-1')
        microthought_id: The UUID of the microthought to delete

    Returns the updated idea ticket, or {"error": ...} on failure.
    """
    try:
        async with async_session() as session:
            ticket = await svc_idea_tickets.delete_microthought(
                session, ticket_id, microthought_id
            )
            result = _idea_ticket_to_dict(ticket)
    except ValueError as exc:
        return {"error": str(exc)}
    return result


async def get_idea_activity_trail(ticket_id: str) -> list[dict] | dict:
    """Returns the full activity trail for an idea ticket, newest first.

    Args:
        ticket_id: The idea ticket ID (e.g. 'IDEA-1')

    Returns a list of trail entries (newest first), or {"error": ...} if not found.
    """
    async with async_session() as session:
        ticket = await svc_idea_tickets.get_idea_ticket(session, ticket_id)
        if ticket is None:
            return {"error": f"Idea ticket '{ticket_id}' not found"}
        read = IdeaTicketRead.from_idea_ticket(ticket)
        trail = read.activity_trail  # already a Python list, properly parsed
        return list(reversed(trail))


def register(mcp: FastMCP) -> None:
    """Register all Kanban MCP tools with the given FastMCP instance."""
    mcp.tool()(list_projects)
    mcp.tool()(create_project)
    mcp.tool()(list_tickets)
    mcp.tool()(create_ticket)
    mcp.tool()(get_ticket)
    mcp.tool()(get_ticket_workspace_path)
    mcp.tool()(update_ticket_status)
    mcp.tool()(update_ticket)
    mcp.tool()(delete_ticket)
    mcp.tool()(block_ticket)
    mcp.tool()(unblock_ticket)
    mcp.tool()(link_tickets)
    mcp.tool()(unlink_tickets)
    mcp.tool()(delete_test_case)
    mcp.tool()(checkout_branch)
    mcp.tool()(add_comment)
    mcp.tool()(update_comment)
    mcp.tool()(delete_comment)
    mcp.tool()(add_work_log)
    mcp.tool()(update_work_log)
    mcp.tool()(delete_work_log)
    mcp.tool()(add_test_case)
    mcp.tool()(update_test_case)
    mcp.tool()(create_child_ticket)
    mcp.tool()(add_branch)
    mcp.tool()(update_branch)
    mcp.tool()(delete_branch)
    mcp.tool()(add_acceptance_criterion)
    mcp.tool()(toggle_acceptance_criterion)
    mcp.tool()(delete_acceptance_criterion)
    mcp.tool()(list_members)
    mcp.tool()(add_member)
    mcp.tool()(remove_member)
    mcp.tool()(list_idea_tickets)
    mcp.tool()(create_idea_ticket)
    mcp.tool()(get_idea_ticket)
    mcp.tool()(update_idea_ticket)
    mcp.tool()(delete_idea_ticket)
    mcp.tool()(update_idea_status)
    mcp.tool()(promote_idea_to_ticket)
    mcp.tool()(add_assumption)
    mcp.tool()(update_assumption_status)
    mcp.tool()(delete_assumption)
    mcp.tool()(add_microthought)
    mcp.tool()(delete_microthought)
    mcp.tool()(get_idea_activity_trail)
