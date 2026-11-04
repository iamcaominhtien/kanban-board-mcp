from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel.ext.asyncio.session import AsyncSession

import events as board_events
from database import get_session
from models import MemberCreate, MemberRead, MemberRoleUpdate
from services.members import (
    create_member,
    list_members,
    remove_member,
    set_member_role,
)

router = APIRouter(tags=["members"])

Session = Annotated[AsyncSession, Depends(get_session)]


@router.get("/projects/{project_id}/members", response_model=list[MemberRead])
async def get_members(project_id: str, session: Session) -> list[MemberRead]:
    """List a project's members."""
    members = await list_members(session, project_id)
    return [MemberRead.model_validate(m) for m in members]


@router.post(
    "/projects/{project_id}/members", response_model=MemberRead, status_code=201
)
async def post_member(
    project_id: str, data: MemberCreate, session: Session
) -> MemberRead:
    """Add a member to a project."""
    if data.role not in ("viewer", "member", "admin"):
        raise HTTPException(status_code=422, detail="Invalid role")
    if not " ".join((data.name or "").split()):
        raise HTTPException(status_code=422, detail="Enter a name.")
    # Names are unique across people and AI in a project, so @mentions never point at two members
    found = await check_name(session, project_id, data.name)
    if not found["ok"]:
        msg = (
            f"An AI member already uses the name “{' '.join(data.name.split())}”."
            if found["conflict"] == "ai"
            else found["message"]
        )
        raise HTTPException(status_code=409, detail=msg)
    member = await create_member(session, project_id, data.name, data.color, data.role)
    await board_events.publish("invalidate")
    return MemberRead.model_validate(member)


@router.patch("/projects/{project_id}/members/{member_id}", response_model=MemberRead)
async def patch_member(
    project_id: str, member_id: str, data: MemberRoleUpdate, session: Session
) -> MemberRead:
    """Change a member's Docs role (viewer, member or admin)."""
    try:
        member = await set_member_role(session, project_id, member_id, data.role)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if member is None:
        raise HTTPException(status_code=404, detail="Member not found")
    await board_events.publish("invalidate")
    return MemberRead.model_validate(member)


@router.delete("/projects/{project_id}/members/{member_id}", status_code=204)
async def del_member(project_id: str, member_id: str, session: Session) -> None:
    """Remove a member (rejected while they own tickets)."""
    try:
        found = await remove_member(session, project_id, member_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not found:
        raise HTTPException(status_code=404, detail="Member not found")
    await board_events.publish("invalidate")


async def check_name(
    session: AsyncSession, project_id: str, name: str, exclude_id: str | None = None
) -> dict:
    """Names are unique across people and AI in a project (case and surrounding spaces ignored)."""
    from sqlmodel import select

    from models import Member, Project

    clean = " ".join((name or "").split())
    project = await session.get(Project, project_id)
    rows = (
        await session.exec(select(Member).where(Member.project_id == project_id))
    ).all()
    low = clean.lower()
    for m in rows:
        if m.id == exclude_id or m.kind == "ai_removed":
            continue
        if m.name.strip().lower() == low:
            if m.kind == "ai":
                existing = {r.name.strip().lower() for r in rows}
                n = 2
                while f"{low} {n}" in existing:
                    n += 1
                return {
                    "ok": False,
                    "conflict": "ai",
                    "message": f"Another AI member already uses this name. Try “{clean} {n}”.",
                    "suggestion": f"{clean} {n}",
                }
            return {
                "ok": False,
                "conflict": "person",
                "message": f"“{m.name}” is already a member of {project.name if project else 'this project'}.",
                "suggestion": None,
            }
    return {"ok": True, "conflict": None, "message": None, "suggestion": None}
