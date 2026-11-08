"""Docs AI API: the assistant in Docs comment threads: the summary of a long thread. "Suggest an edit" made a
proposal to review; in AI v2 the assistant edits when asked and the page's history undoes it, so that route is gone."""

from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from services import activity as svc_activity
from services.assistant import docs as svc
from services.docs_ai import jobs

router = APIRouter(tags=["docs-ai"])
Session = Annotated[AsyncSession, Depends(get_session)]


class SuggestBody(BaseModel):
    """The comment an edit was suggested from."""

    comment_id: str


@router.post("/docs/ai/threads/{thread_id}/suggest-edit", status_code=202)
async def suggest_edit(
    thread_id: str, body: SuggestBody, session: Session
) -> dict[str, Any]:
    """Gone: proposals are no longer made. Ask the assistant in the thread to make the change."""
    raise HTTPException(
        status_code=410,
        detail="Proposals are gone in AI v2: ask the assistant in the thread to make the change; the page's history undoes it.",
    )


@router.post("/docs/ai/threads/{thread_id}/summary", status_code=202)
async def summarise(thread_id: str, session: Session) -> dict[str, Any]:
    """Summarise a long thread (shown above the replies; it does not resolve the thread)."""
    job = await svc.start_thread_job(
        session,
        thread_id,
        "thread_summary",
        svc_activity.current_actor() or "user",
        "Summarise this thread",
    )
    return jobs.to_dict(job)
