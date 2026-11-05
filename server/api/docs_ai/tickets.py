"""Docs AI API: from a page to tickets (draft with the assistant, create, undo)."""

from typing import Annotated, Any, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlmodel.ext.asyncio.session import AsyncSession

import events as board_events
from database import get_session
from services import activity as svc_activity
from services import docs as svc_docs
from services.assistant import docs as svc
from services.docs_ai import jobs
from services.docs_ai import settings as svc_settings

router = APIRouter(tags=["docs-ai"])
Session = Annotated[AsyncSession, Depends(get_session)]


def by() -> str:
    """The person making the request (X-Actor)."""
    return svc_activity.current_actor() or "user"


class DraftBody(BaseModel):
    """The selection to draft tickets from (the whole page when empty)."""

    selection: Optional[str] = None


@router.post("/docs/pages/{page_id}/ai/tickets/draft")
async def draft_tickets(
    page_id: str, session: Session, body: Optional[DraftBody] = None
) -> dict[str, Any]:
    """Draft tickets from the open items of a page or a selection (a job: `result.drafts`, `result.skipped`).
    Nothing is created."""
    page = await svc_docs.get_page(session, page_id, edit=True)
    await svc_settings.require_enabled(session, page.project_id)
    await svc.ready_or_raise(page.project_id)
    job = await jobs.start(
        session,
        project_id=page.project_id,
        kind="tickets_draft",
        started_by=by(),
        page_id=page.id,
        instruction="Draft tickets from this page",
        result={"input": {"selection": body.selection if body else None}},
    )
    return jobs.to_dict(job)


class TicketDraft(BaseModel):
    """One reviewed ticket draft."""

    title: str
    text: str = ""
    type: str = "task"
    column: str = "backlog"
    project_id: Optional[str] = None
    assignee_id: Optional[str] = None
    due_date: Optional[str] = None


class CreateBody(BaseModel):
    """The reviewed drafts to create as tickets."""

    drafts: list[TicketDraft]
    replace_text: bool = False
    link: bool = True


@router.post("/docs/pages/{page_id}/ai/tickets/create")
async def create_tickets(
    page_id: str, body: CreateBody, session: Session
) -> dict[str, Any]:
    """Create the drafts as tickets and link them to the page. Returns `{tickets, undo_token, replaced, linked}`."""
    out = await svc.create_tickets(
        session, page_id, by(), [d.model_dump() for d in body.drafts], link=body.link
    )
    await board_events.publish(board_events.INVALIDATE)
    return out


class UndoBody(BaseModel):
    """The token a creation returned."""

    undo_token: str


@router.post("/docs/ai/tickets/undo")
async def undo_tickets(body: UndoBody, session: Session) -> dict[str, Any]:
    """Delete the tickets a creation made."""
    out = await svc.undo_tickets(session, body.undo_token, by())
    await board_events.publish(board_events.INVALIDATE)
    return out
