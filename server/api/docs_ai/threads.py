"""Docs AI API: AI in Docs comment threads (docs-ai-care E): "Suggest an edit" and the summary of a long thread.

Answers to an @mention are delivered by the comment endpoints in `api/docs.py` (`services.docs_ai.threads.deliver`).
"""

from typing import Annotated, Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from services import activity as svc_activity
from services.docs_ai import jobs, threads

router = APIRouter(tags=["docs-ai"])
Session = Annotated[AsyncSession, Depends(get_session)]


class SuggestBody(BaseModel):
    """The AI reply whose finding becomes a proposal."""

    comment_id: str


@router.post("/docs/ai/threads/{thread_id}/suggest-edit", status_code=202)
async def suggest_edit(
    thread_id: str, body: SuggestBody, session: Session
) -> dict[str, Any]:
    """The AI member that answered proposes the concrete change (a proposal to review, never an edit)."""
    job = await threads.start_suggest(
        session, thread_id, body.comment_id, svc_activity.current_actor()
    )
    return jobs.to_dict(job)


@router.post("/docs/ai/threads/{thread_id}/summary", status_code=202)
async def summarise(thread_id: str, session: Session) -> dict[str, Any]:
    """Summarise a long thread (shown above the replies; it does not resolve the thread)."""
    job = await threads.start_summary(session, thread_id, svc_activity.current_actor())
    return jobs.to_dict(job)
