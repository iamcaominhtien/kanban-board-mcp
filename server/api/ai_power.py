"""The computer's sleep: how many runs need the machine awake, and the check after it woke (services/ai/power.py)."""

from typing import Annotated

from fastapi import APIRouter, Depends
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from services.ai import power as svc_power

router = APIRouter(tags=["ai"])
Session = Annotated[AsyncSession, Depends(get_session)]


@router.get("/ai/power")
async def get_power(session: Session) -> dict:
    """How many AI runs are queued, starting or running (the desktop app keeps the computer awake while > 0)."""
    return {"active": await svc_power.active_runs(session)}


@router.post("/ai/power/wake")
async def post_wake(session: Session) -> dict:
    """The computer woke up: look at every run the board thinks is running."""
    return await svc_power.after_wake(session)
