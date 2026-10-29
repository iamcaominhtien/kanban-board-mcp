"""AI schedules API (design/screens/ai-schedules.md): list, preview, create, edit, pause, run now, dry run, history,
week view, card states and notifications. Errors carry a `code` (invalid, forbidden, conflict, unavailable…)."""

from datetime import UTC, datetime
from typing import Annotated, Any, Optional

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from models import Project
from services import activity as svc_activity
from services.ai import schedules as svc
from services.ai.schedules import ScheduleError

router = APIRouter(tags=["ai-schedules"])
Session = Annotated[AsyncSession, Depends(get_session)]

STATUS = {
    "not_found": 404,
    "invalid": 422,
    "forbidden": 403,
    "conflict": 409,
    "unavailable": 409,
}


async def schedule_error_handler(_request: Request, exc: ScheduleError) -> JSONResponse:
    """`{"detail": message, "code": …, "problems"?: […]}` with the status the code maps to."""
    return JSONResponse(
        status_code=STATUS.get(exc.code, 400),
        content={"detail": str(exc), "code": exc.code, **exc.extra},
    )


def _by() -> str:
    return svc_activity.current_actor() or "user"


async def _project(session: AsyncSession, project_id: str) -> None:
    if await session.get(Project, project_id) is None:
        raise ScheduleError("not_found", "Project not found.")


class ScheduleBody(BaseModel):
    """Fields of a schedule; on PATCH only the ones sent change."""

    ticket_id: Optional[str] = None
    member_id: Optional[str] = None
    backup_member_id: Optional[str] = None
    kind: Optional[str] = None
    run_at: Optional[str] = None
    days: Optional[list[int]] = None
    time: Optional[str] = None
    tz: Optional[str] = None
    ends: Optional[str] = None
    ends_after: Optional[int] = None
    ends_on: Optional[str] = None
    window_end: Optional[str] = None
    checks: Optional[dict[str, Any]] = None
    review: Optional[dict[str, Any]] = None
    limits: Optional[dict[str, Any]] = None
    catch_up: Optional[str] = None
    catch_up_hours: Optional[float] = None
    notify: Optional[list[str]] = None
    notify_people: Optional[list[str]] = None
    instruction: Optional[str] = None


class PreviewBody(ScheduleBody):
    """The editor's current values, and the schedule being edited if any."""

    schedule_id: Optional[str] = None


class SlotAction(BaseModel):
    """start (run late), skip, or use_member (run on another AI)."""

    action: str
    member_id: Optional[str] = None


def _data(body: BaseModel) -> dict:
    return body.model_dump(exclude_unset=True, exclude={"schedule_id"})


@router.get("/projects/{project_id}/ai/schedules")
async def list_schedules(
    project_id: str, session: Session, ticket_id: Optional[str] = None
) -> dict:
    """Schedules with their last run, tab counts and the next-24 h badge."""
    await _project(session, project_id)
    return await svc.list_for(session, project_id, ticket_id=ticket_id)


@router.get("/projects/{project_id}/ai/schedules/history")
async def schedule_history(
    project_id: str, session: Session, limit: int = Query(50, ge=1, le=200)
) -> list[dict]:
    """Scheduled runs across the project, newest first."""
    await _project(session, project_id)
    return await svc.history(session, project_id, limit=limit)


@router.get("/projects/{project_id}/ai/schedules/week")
async def schedule_week(
    project_id: str,
    session: Session,
    start: Optional[str] = None,
    days: int = Query(7, ge=1, le=31),
) -> dict:
    """Planned runs per AI from `start` (default: today, UTC midnight)."""
    await _project(session, project_id)
    if start:
        try:
            at = datetime.fromisoformat(start)
        except ValueError as exc:
            raise ScheduleError("invalid", "start must be an ISO date.") from exc
        at = at if at.tzinfo else at.replace(tzinfo=UTC)
    else:
        at = datetime.now(UTC).replace(hour=0, minute=0, second=0, microsecond=0)
    return await svc.week(session, project_id, at.astimezone(UTC), days)


@router.get("/projects/{project_id}/ai/schedules/cards")
async def schedule_cards(project_id: str, session: Session) -> list[dict]:
    """Card footer state per ticket."""
    await _project(session, project_id)
    states = await svc.for_tickets(session, project_id)
    return [{"ticket_id": k, **v} for k, v in states.items()]


@router.get("/projects/{project_id}/ai/schedules/events")
async def schedule_events(project_id: str, after: int = 0) -> list[dict]:
    """Notifications since `after` (the last id the client showed)."""
    return svc.events_since(project_id, after)


@router.post("/projects/{project_id}/ai/schedules/preview")
async def preview_schedule(
    project_id: str, body: PreviewBody, session: Session
) -> dict:
    """Summary, next 5 runs and checks for the editor, without saving."""
    await _project(session, project_id)
    return await svc.preview(session, project_id, _data(body), _by(), body.schedule_id)


@router.post("/projects/{project_id}/ai/schedules/dry-run")
async def dry_run_schedule(
    project_id: str, body: PreviewBody, session: Session
) -> dict:
    """What the AI would do. Changes nothing."""
    await _project(session, project_id)
    return await svc.dry_run(session, body.schedule_id, project_id, _data(body), _by())


@router.post("/projects/{project_id}/ai/schedules", status_code=201)
async def create_schedule(
    project_id: str, body: ScheduleBody, session: Session
) -> dict:
    """Create a schedule; 422 with `problems` when a check fails."""
    await _project(session, project_id)
    s = await svc.create(session, project_id, _data(body), _by())
    return await svc.to_dict(session, s)


@router.get("/ai/schedules/{schedule_id}")
async def get_schedule(schedule_id: str, session: Session) -> dict:
    """One schedule with stats and run history."""
    return await svc.detail(session, schedule_id)


@router.patch("/ai/schedules/{schedule_id}")
async def patch_schedule(
    schedule_id: str, body: ScheduleBody, session: Session
) -> dict:
    """Edit (creator or admin)."""
    s = await svc.update(session, schedule_id, _data(body), _by())
    return await svc.to_dict(session, s)


@router.delete("/ai/schedules/{schedule_id}", status_code=204)
async def delete_schedule(schedule_id: str, session: Session) -> None:
    """Delete (creator or admin)."""
    await svc.delete(session, schedule_id, _by())


@router.post("/ai/schedules/{schedule_id}/pause")
async def pause_schedule(schedule_id: str, session: Session) -> dict:
    """Pause: no new runs start."""
    s = await svc.set_paused(session, schedule_id, True, _by())
    return await svc.to_dict(session, s)


@router.post("/ai/schedules/{schedule_id}/resume")
async def resume_schedule(schedule_id: str, session: Session) -> dict:
    """Resume from now; the failure count resets."""
    s = await svc.set_paused(session, schedule_id, False, _by())
    return await svc.to_dict(session, s)


@router.post("/ai/schedules/{schedule_id}/run-now")
async def run_schedule_now(schedule_id: str, session: Session) -> dict:
    """Start a run now, outside the plan."""
    r = await svc.run_now(session, schedule_id, _by())
    return svc.run_to_dict(r)


@router.post("/ai/schedule-runs/{run_id}/action")
async def schedule_run_action(run_id: str, body: SlotAction, session: Session) -> dict:
    """Answer a waiting run: start it late, skip it, or run it on another AI."""
    r = await svc.slot_action(session, run_id, body.action, _by(), body.member_id)
    return svc.run_to_dict(r)
