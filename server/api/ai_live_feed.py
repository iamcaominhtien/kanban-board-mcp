"""REST API of AI Team › Flow › Live commentary: the live-chat feed of what each AI is doing (services/ai/live_feed.py)."""

from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from models import Project
from services.ai import live_feed as svc_live_feed

router = APIRouter(tags=["ai"])
Session = Annotated[AsyncSession, Depends(get_session)]


@router.get("/projects/{project_id}/ai/live-feed")
async def get_live_feed(
    project_id: str,
    session: Session,
    after: Optional[str] = None,
    limit: Annotated[int, Query(ge=1, le=svc_live_feed.MAX_LIMIT)] = 200,
) -> dict:
    """The lines after `after` (the cursor of the last answer), oldest first, and the cursor to send next time. Without
    a cursor: the last `limit` lines of the last few hours."""
    if await session.get(Project, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return await svc_live_feed.feed(session, project_id, after=after, limit=limit)
