"""Docs AI API: the assistant in Docs comment threads: the summary of a long thread. In AI v2 the assistant edits when
asked and the page's history undoes it."""

from typing import Annotated, Any

from fastapi import APIRouter, Depends
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from services import activity as svc_activity
from services.assistant import docs as svc
from services.docs_ai import jobs

router = APIRouter(tags=["docs-ai"])
Session = Annotated[AsyncSession, Depends(get_session)]


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
