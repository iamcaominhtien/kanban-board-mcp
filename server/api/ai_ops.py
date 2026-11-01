"""REST API of the AI team's operations (design/screens/ai-operations.md C, D, E): a run in trouble and what to do
about it, messages to a running AI, the usage window of each Claude account, the project's AI team settings, and
the open flags of a ticket."""

from typing import Annotated, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel.ext.asyncio.session import AsyncSession

import services.activity as svc_activity
from database import get_session
from models import AiRun
from services.ai import flags as svc_flags
from services.ai import ops as svc_ops
from services.ai import quota as svc_quota
from services.ai import runs as svc_runs
from services.ai.store import get_settings

router = APIRouter(tags=["ai"])
Session = Annotated[AsyncSession, Depends(get_session)]


def _by() -> str:
    return svc_activity.current_actor() or "user"


def _err(exc: Exception, status: int = 422):
    raise HTTPException(status_code=status, detail=str(exc)) from exc


async def _run_dict(session, run: AiRun) -> dict:
    fresh = await session.get(AiRun, run.id)
    await session.refresh(fresh)
    return (await svc_runs.runs_to_dicts(session, [fresh]))[0]


class TroubleBody(BaseModel):
    """What to do about a run the board diagnosed (design C)."""

    action: Literal["stop_child", "tell_ai", "wait", "continue_note", "cancel"]
    note: Optional[str] = None


@router.post("/ai/runs/{run_id}/trouble")
async def post_trouble(run_id: str, body: TroubleBody) -> dict:
    """Act on a diagnosis: stop the child, tell the AI, wait 30 min, continue with a note, or cancel."""
    try:
        return await svc_runs.act_on_trouble(
            run_id, body.action, by=_by(), note=body.note
        )
    except svc_runs.RunError as exc:
        _err(exc)


class NoteBody(BaseModel):
    """A note for an AI."""

    note: str


@router.post("/ai/runs/{run_id}/continue")
async def post_continue(run_id: str, body: NoteBody, session: Session) -> dict:
    """Continue with a note: the same conversation goes on, told the note."""
    try:
        run = await svc_runs.continue_run(run_id, by=_by(), note=body.note)
    except svc_runs.RunConflict as exc:
        _err(exc, 409)
    except svc_runs.RunError as exc:
        _err(exc)
    return await _run_dict(session, run)


class HandBody(BaseModel):
    """Hand the ticket to another AI member."""

    member_id: str
    note: Optional[str] = None


@router.post("/ai/runs/{run_id}/hand-to")
async def post_hand_to(run_id: str, body: HandBody, session: Session) -> dict:
    """Hand to another AI: a new run for that member, starting from a hand-over note."""
    try:
        run = await svc_runs.hand_to(
            run_id, member_id=body.member_id, by=_by(), note=body.note
        )
    except svc_runs.RunConflict as exc:
        _err(exc, 409)
    except svc_runs.RunError as exc:
        _err(exc)
    return await _run_dict(session, run)


class TellBody(BaseModel):
    """A message for a running AI."""

    text: str


@router.post("/ai/runs/{run_id}/tell")
async def post_tell(run_id: str, body: TellBody, session: Session) -> dict:
    """Send a running AI a message (design D20): it reads it at its next turn, or with its next board call."""
    run = await session.get(AiRun, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Run not found")
    if run.state not in ("starting", "running"):
        raise HTTPException(
            status_code=422, detail=f"Run #{run.number} is not running."
        )
    text = (body.text or "").strip()
    if not text:
        raise HTTPException(status_code=422, detail="Write the message.")
    via = await svc_runs.tell(run_id, text[:4000], by=_by())
    return {"delivered": via}


class MoveBody(BaseModel):
    """Run this waiting run on another Claude account."""

    account_id: str


@router.post("/ai/runs/{run_id}/move-account")
async def post_move_account(run_id: str, body: MoveBody, session: Session) -> dict:
    """Move urgent work to an account with room (design E)."""
    try:
        run = await svc_runs.move_account(run_id, account_id=body.account_id, by=_by())
    except svc_runs.RunError as exc:
        _err(exc)
    return await _run_dict(session, run)


@router.get("/ai/windows")
async def get_windows(session: Session) -> dict:
    """Every Claude account's usage window, run limit and what waits on it."""
    return {
        "accounts": await svc_quota.overview(session),
        "room": await svc_quota.room(session),
    }


class WindowBody(BaseModel):
    """An account's run limit and its "move urgent work by itself" switch."""

    max_parallel: Optional[int] = None
    move_urgent: Optional[bool] = None


@router.patch("/ai/windows/{key}")
async def patch_window(key: str, body: WindowBody, session: Session) -> dict:
    """Change how many runs an account takes at once, or whether urgent work moves by itself."""
    row = await svc_quota.set_account(
        session, key, max_parallel=body.max_parallel, move_urgent=body.move_urgent
    )
    return {
        "key": row.key,
        "max_parallel": row.max_parallel,
        "move_urgent": row.move_urgent,
    }


@router.get("/projects/{project_id}/ai/ops")
async def get_ops(project_id: str, session: Session) -> dict:
    """The project's AI team settings over their defaults."""
    return svc_ops.get(await get_settings(session, project_id))


@router.patch("/projects/{project_id}/ai/ops")
async def patch_ops(project_id: str, body: dict, session: Session) -> dict:
    """Change the project's AI team settings (only known keys are kept)."""
    settings = await get_settings(session, project_id)
    out = svc_ops.update(settings, body)
    session.add(settings)
    await session.commit()
    return out


@router.get("/tickets/{ticket_id}/ai/ticket-flags")
async def get_flags(ticket_id: str, session: Session) -> list[dict]:
    """A ticket's flags (merge conflict, arbitration, a stopped workflow), newest first."""
    return await svc_flags.for_ticket(session, ticket_id)
