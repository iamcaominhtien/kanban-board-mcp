"""Who may read and edit a project's Docs space.

Identity comes from the request actor (``X-Actor``): the board's own user is an admin, the AI agent a
member, and anyone else is looked up by name among the project's members. A name that is not a
member has no access to Docs at all; it can only ask an admin for access.
"""

import json
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from models import DocsCommentEvent, Member, Project
from services import activity
from services.docs_text import DocsError

ROLES = ("viewer", "member", "admin")
EDIT_POLICIES = ("everyone", "members", "admins")
MAX_NOTE = 300


async def members_of(session: AsyncSession, project_id: str) -> list[Member]:
    """Return the project's members."""
    rows = await session.exec(select(Member).where(Member.project_id == project_id))
    return list(rows.all())


def _member(members: list[Member], actor: str) -> Member | None:
    for m in members:
        if m.name.casefold() == actor.casefold():
            return m
    return None


def role_in(members: list[Member], actor: str) -> str:
    """Return the Docs role of an actor.

    The board's own user (``user``) is an admin and the AI agent (``agent``) a member. Anyone else is
    looked up by name among the project's members; a name that is not a member can only read.
    """
    if actor == activity.HUMAN_ACTOR:
        return "admin"
    if actor == activity.AGENT_ACTOR:
        return "member"
    m = _member(members, actor)
    if m is not None:
        return m.role if m.role in ROLES else "member"
    return "viewer"


def has_access(members: list[Member], actor: str) -> bool:
    """True when the actor belongs to the project (the board's user, the agent or a member)."""
    return actor in (activity.HUMAN_ACTOR, activity.AGENT_ACTOR) or (
        _member(members, actor) is not None
    )


def can_edit(role: str, policy: str) -> bool:
    """Whether a role may edit pages under the project's edit policy."""
    if policy == "everyone":
        return True
    if policy == "admins":
        return role == "admin"
    return role in ("member", "admin")


async def access_of(session: AsyncSession, project: Project) -> dict[str, Any]:
    """Describe what the current actor may do in a project's Docs space.

    Returns:
        ``{access, role, can_edit, policy, me, admins}``; ``admins`` names who gets an access request.
    """
    members = await members_of(session, project.id)
    actor = activity.current_actor()
    role = role_in(members, actor)
    access = has_access(members, actor)
    policy = project.docs_edit_policy or "members"
    return {
        "access": access,
        "role": role if access else None,
        "can_edit": access and can_edit(role, policy),
        "policy": policy,
        "me": actor,
        "admins": [m.name for m in members if m.role == "admin"],
    }


async def require_reader(session: AsyncSession, project: Project) -> None:
    """Raise 403 ``docs_no_access`` when the actor is not part of the project."""
    actor = activity.current_actor()
    if actor in (activity.HUMAN_ACTOR, activity.AGENT_ACTOR):
        return
    if not has_access(await members_of(session, project.id), actor):
        raise DocsError(
            403,
            "docs_no_access",
            f"Docs in {project.name} is limited to project members.",
        )


async def require_editor(session: AsyncSession, project: Project) -> None:
    """Raise 403 ``read_only`` when the project's edit policy does not let the actor edit pages."""
    actor = activity.current_actor()
    if actor == activity.HUMAN_ACTOR:
        return
    members = await members_of(session, project.id)
    if not has_access(members, actor):
        raise DocsError(
            403,
            "docs_no_access",
            f"Docs in {project.name} is limited to project members.",
        )
    policy = project.docs_edit_policy or "members"
    if not can_edit(role_in(members, actor), policy):
        who = "project admins" if policy == "admins" else "project members"
        raise DocsError(
            403,
            "read_only",
            f"Only {who} can edit pages in this space. You can still read published pages.",
        )


async def request_access(
    session: AsyncSession, project: Project, note: str = ""
) -> dict[str, Any]:
    """Ask the project's admins for access to Docs.

    The request is an Activity entry (``access_request``) that notifies every admin and the board's
    own user. A second request from the same person within ten minutes is not sent again.

    Args:
        project: Project whose Docs the actor wants to read.
        note: Optional note to the admins.

    Returns:
        ``{sent, admins}``; ``sent`` is False when the actor already has access or just asked.
    """
    members = await members_of(session, project.id)
    actor = activity.current_actor()
    admins = [m.name for m in members if m.role == "admin"]
    if has_access(members, actor):
        return {"sent": False, "admins": admins}
    since = (datetime.now(UTC) - timedelta(minutes=10)).isoformat()
    recent = await session.exec(
        select(DocsCommentEvent).where(
            DocsCommentEvent.project_id == project.id,
            DocsCommentEvent.kind == "access_request",
            DocsCommentEvent.actor == actor,
            DocsCommentEvent.created_at >= since,
        )
    )
    if recent.first() is not None:
        return {"sent": False, "admins": admins}
    session.add(
        DocsCommentEvent(
            project_id=project.id,
            page_id=None,
            kind="access_request",
            actor=actor,
            recipients=json.dumps([activity.HUMAN_ACTOR, *admins]),
            snippet=" ".join(note.split())[:MAX_NOTE],
        )
    )
    await session.commit()
    return {"sent": True, "admins": admins}
