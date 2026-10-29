"""Project member operations."""

import services.members as svc_members
from models import MemberRead
from pydantic import Field
from typing import Annotated
from .. import common
from ..common import MemberId, ProjectId, notify_on_success


async def list_members(project_id: ProjectId) -> list[dict]:
    """List a project's members: {id, name, color, project_id, created_at}. Use a member `id` as `assignee`."""
    async with common.async_session() as session:
        members = await svc_members.list_members(session, project_id)
        return [MemberRead.model_validate(m).model_dump() for m in members]


@notify_on_success
async def add_member(
    project_id: ProjectId,
    name: Annotated[str, Field(description="Display name.")],
    color: Annotated[
        str | None, Field(description="Hex avatar color; auto-assigned when omitted.")
    ] = None,
) -> dict:
    """Add a member to a project so tickets can be assigned to them. Returns the member (with its `id`)."""
    async with common.async_session() as session:
        member = await svc_members.create_member(session, project_id, name, color)
        return MemberRead.model_validate(member).model_dump()


@notify_on_success
async def remove_member(project_id: ProjectId, member_id: MemberId) -> dict:
    """Remove a member from a project. Their assigned tickets become unassigned first; refused when the member created
    tickets. Returns {"ok": true}."""
    async with common.async_session() as session:
        removed = await svc_members.remove_member(session, project_id, member_id)
    if not removed:
        raise ValueError(
            f"Member '{member_id}' not found in this project. Use get_projects(project_id) to see member ids."
        )
    return {"ok": True}
