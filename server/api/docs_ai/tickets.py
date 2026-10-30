"""Docs AI API: from a page to tickets (draft, create, undo)."""

from typing import Annotated, Any, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlmodel.ext.asyncio.session import AsyncSession

import events as board_events
from database import get_session
from services import activity as svc_activity
from services.docs_ai import jobs
from services.docs_ai import tickets as svc

router = APIRouter(tags=["docs-ai"])
Session = Annotated[AsyncSession, Depends(get_session)]


def by() -> str:
    """The person making the request (X-Actor)."""
    return svc_activity.current_actor() or "user"


class DraftBody(BaseModel):
    """The text a person selected, when they did."""

    selection: Optional[str] = None


@router.post("/docs/pages/{page_id}/ai/tickets/draft")
async def draft_tickets(
    page_id: str, session: Session, body: Optional[DraftBody] = None
) -> dict[str, Any]:
    """Draft tickets from the unchecked items of a page or a selection (a job: `result.drafts`, `result.skipped`).
    Nothing is created. People who can edit the page."""
    job = await svc.start(session, page_id, body.selection if body else None, by())
    return jobs.to_dict(job)


class TicketDraft(BaseModel):
    """One reviewed draft."""

    title: str
    text: str = ""
    type: str = "task"
    column: str = "backlog"
    project_id: Optional[str] = None
    assignee_id: Optional[str] = None
    due_date: Optional[str] = None


class CreateBody(BaseModel):
    """The reviewed drafts and the two choices of the dialog."""

    drafts: list[TicketDraft]
    replace_text: bool = False
    link: bool = True


@router.post("/docs/pages/{page_id}/ai/tickets/create")
async def create_tickets(
    page_id: str, body: CreateBody, session: Session
) -> dict[str, Any]:
    """Create the drafts as tickets, link them to the page and (optionally) put their keys on the lines in the
    caller's draft of the page. Returns `{tickets, undo_token, replaced, linked}`."""
    out = await svc.create(
        session,
        page_id,
        by(),
        [d.model_dump() for d in body.drafts],
        replace_text=body.replace_text,
        link=body.link,
    )
    await board_events.publish(board_events.INVALIDATE)
    return out


class UndoBody(BaseModel):
    """The token `create` returned."""

    undo_token: str


@router.post("/docs/ai/tickets/undo")
async def undo_tickets(body: UndoBody, session: Session) -> dict[str, Any]:
    """Delete the tickets a creation made and restore the draft text if it did not change."""
    out = await svc.undo(session, body.undo_token, by())
    await board_events.publish(board_events.INVALIDATE)
    return out
