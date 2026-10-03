from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel.ext.asyncio.session import AsyncSession

import events as board_events
from database import get_session
from models import TicketRead, WorkspaceSettings, WorkspaceSettingsUpdate
from services import workspace as svc_workspace

router = APIRouter(tags=["workspace"])
Session = Annotated[AsyncSession, Depends(get_session)]


class TicketRetentionBody(BaseModel):
    retention_days: Optional[int] = None  # None = forever or inherit


@router.get("/workspace/settings", response_model=WorkspaceSettings)
async def get_settings(session: Session) -> WorkspaceSettings:
    return await svc_workspace.get_workspace_settings(session)


@router.patch("/workspace/settings", response_model=WorkspaceSettings)
async def patch_settings(
    body: WorkspaceSettingsUpdate, session: Session
) -> WorkspaceSettings:
    settings = await svc_workspace.update_workspace_settings(
        session,
        enabled=body.enabled,
        root_path=body.root_path,
        default_retention_days=body.default_retention_days,
    )
    await board_events.publish("invalidate")
    return settings


@router.get("/tickets/{ticket_id}/workspace")
async def get_ticket_workspace(ticket_id: str, session: Session) -> dict:
    workspace_info = await svc_workspace.get_ticket_workspace(session, ticket_id)
    if workspace_info is None:
        raise HTTPException(status_code=404, detail="Ticket not found")
    return workspace_info


@router.patch("/tickets/{ticket_id}/workspace/retention", response_model=TicketRead)
async def patch_ticket_workspace_retention(
    ticket_id: str, body: TicketRetentionBody, session: Session
) -> TicketRead:
    ticket = await svc_workspace.set_ticket_workspace_retention(
        session, ticket_id, body.retention_days
    )
    if ticket is None:
        raise HTTPException(status_code=404, detail="Ticket not found")
    await board_events.publish("invalidate")
    return TicketRead.from_ticket(ticket)
