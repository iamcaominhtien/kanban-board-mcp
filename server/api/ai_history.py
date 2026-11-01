"""REST API of run history: search, the board's own transcript of a run, pin, export, skill use
(design/screens/ai-operations.md, F and G)."""

import json
from typing import Annotated, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from models import AiRun, AiRunTranscript
from services.ai import history as svc_history
from services.ai import transcripts as svc_transcripts

router = APIRouter(tags=["ai"])
Session = Annotated[AsyncSession, Depends(get_session)]


@router.get("/ai/history")
async def get_history(
    session: Session,
    project_id: Optional[str] = None,
    member_id: Optional[str] = None,
    ticket_id: Optional[str] = None,
    state: Optional[str] = None,
    skill: Optional[str] = None,
    since: Optional[str] = None,
    until: Optional[str] = None,
    q: Optional[str] = None,
    pinned: Optional[bool] = None,
    limit: int = Query(default=svc_history.PAGE, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
) -> dict:
    """Runs across the board, newest first, or best match first when `q` searches the transcripts."""
    return await svc_history.list_runs(
        session,
        project_id=project_id,
        member_id=member_id,
        ticket_id=ticket_id,
        state=state,
        skill=skill,
        since=since,
        until=until,
        q=q,
        pinned=pinned,
        limit=limit,
        offset=offset,
    )


async def _run(session, run_id: str) -> AiRun:
    run = await session.get(AiRun, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Run not found")
    return run


@router.get("/ai/runs/{run_id}/transcript")
async def get_transcript(run_id: str, session: Session) -> dict:
    """What the run was given and everything it did, from the board's own copy."""
    run = await _run(session, run_id)
    row = await session.get(AiRunTranscript, run_id)
    records = await svc_transcripts.read(run_id)
    summary = (await svc_history.rows_out(session, [run]))[0]
    return {
        "run": summary,
        "transcript": svc_history.transcript_info(row),
        "entries": svc_history.timeline(records or []),
        "available": records is not None,
    }


class PinBody(BaseModel):
    """Keep a run's transcript whatever the retention."""

    on: bool = True
    by: str = "user"


@router.post("/ai/runs/{run_id}/pin")
async def post_pin(run_id: str, body: PinBody, session: Session) -> dict:
    """Pin or unpin a run."""
    await _run(session, run_id)
    row = await svc_transcripts.pin(run_id, body.on, body.by)
    if row is None:
        raise HTTPException(
            status_code=409, detail="This run has no transcript to keep."
        )
    return svc_history.transcript_info(row)


@router.get("/ai/runs/{run_id}/export")
async def get_export(
    run_id: str, session: Session, format: Literal["md", "json"] = "md"
) -> Response:
    """The run as Markdown or JSON, as a download."""
    run = await _run(session, run_id)
    summary = (await svc_history.rows_out(session, [run]))[0]
    entries = svc_history.timeline(await svc_transcripts.read(run_id) or [])
    name = f"{run.ticket_id}-run-{run.number}"
    if format == "json":
        body = json.dumps(
            {"run": summary, "entries": entries}, indent=2, ensure_ascii=False
        )
        return Response(
            body,
            media_type="application/json",
            headers={"Content-Disposition": f'attachment; filename="{name}.json"'},
        )
    return Response(
        svc_history.to_markdown(summary, entries),
        media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{name}.md"'},
    )


@router.get("/ai/transcripts/usage")
async def get_transcripts_usage() -> dict:
    """Space the board's transcripts take on disk."""
    return await svc_transcripts.usage()


@router.get("/ai/skills/usage")
async def get_skill_usage(
    session: Session, project_id: Optional[str] = None, since: Optional[str] = None
) -> list[dict]:
    """How often each skill and subagent was really used, read from the runs."""
    return await svc_history.skill_usage(session, project_id=project_id, since=since)
