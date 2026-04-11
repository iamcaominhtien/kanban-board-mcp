from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel.ext.asyncio.session import AsyncSession

import events as board_events
from database import get_session
from models import MemberCreate, MemberRead
from services.members import create_member, list_members, remove_member

router = APIRouter(tags=["members"])

Session = Annotated[AsyncSession, Depends(get_session)]


@router.get("/projects/{project_id}/members", response_model=list[MemberRead])
async def get_members(project_id: str, session: Session) -> list[MemberRead]:
    members = await list_members(session, project_id)
    return [MemberRead.model_validate(m) for m in members]


@router.post(
    "/projects/{project_id}/members", response_model=MemberRead, status_code=201
)
async def post_member(
    project_id: str, data: MemberCreate, session: Session
) -> MemberRead:
    member = await create_member(session, project_id, data.name, data.color)
    await board_events.publish("invalidate")
    return MemberRead.model_validate(member)


@router.delete("/projects/{project_id}/members/{member_id}", status_code=204)
async def del_member(project_id: str, member_id: str, session: Session) -> None:
    try:
        found = await remove_member(session, project_id, member_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not found:
        raise HTTPException(status_code=404, detail="Member not found")
    await board_events.publish("invalidate")
