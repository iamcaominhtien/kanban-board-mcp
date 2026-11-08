"""AI v2 API: teams, project AI settings, the overview and the board's run chips.

Runs themselves (start, cancel, answer, message, steps) are in stage 3 of docs/specs/ai-v2-implementation.md.
"""

from datetime import datetime
from typing import Annotated, Any, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

import events as board_events
from database import get_session
from models import AiProjectSettings, AiRun, AiTeam, Member, Project
from services import activity as svc_activity
from services.ai import activity as svc_activity_roles
from services.ai import roles as svc_roles
from services.ai import runs as svc_runs
from services.ai import steps as svc_steps
from services.ai import teams as svc_teams
from services.ai import timeline as svc_timeline
from services.ai.store import active_runs, get_settings, loads

router = APIRouter(tags=["ai"])
Session = Annotated[AsyncSession, Depends(get_session)]


def _by() -> str:
    return svc_activity.current_actor() or "user"


def _err(exc: Exception, status: int = 422):
    raise HTTPException(status_code=status, detail=str(exc)) from exc


async def _project(session: AsyncSession, project_id: str) -> Project:
    project = await session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return project


async def _team(session: AsyncSession, member_id: str) -> tuple[Member, AiTeam]:
    member = await session.get(Member, member_id)
    profile = await session.get(AiTeam, member_id)
    if member is None or profile is None or member.kind not in ("ai", "ai_removed"):
        raise HTTPException(status_code=404, detail="AI team not found")
    return member, profile


# --------------------------------------------------------------------------- teams


@router.get("/ai/packs/teams")
async def get_team_packs() -> list[dict]:
    """The ready-made team packs (which roles a team brings) and the role catalogue."""
    return svc_roles.team_packs()


@router.get("/ai/packs/roles")
async def get_role_catalogue() -> list[dict]:
    """Every ready-made role a team may use as a subagent."""
    return svc_roles.public(svc_roles.catalogue())


@router.get("/projects/{project_id}/ai/teams")
async def get_teams(
    project_id: str, session: Session, include_removed: bool = False
) -> list[dict]:
    """The project's AI teams with status, slots and assigned tickets."""
    await _project(session, project_id)
    return await svc_teams.list_teams(
        session, project_id, include_removed=include_removed
    )


class TeamBody(BaseModel):
    """Make or edit a team (on edit, only the keys sent change)."""

    name: Optional[str] = None
    color: Optional[str] = None
    description: Optional[str] = None
    cli_path: Optional[str] = None
    working_dir: Optional[str] = None
    account_id: Optional[str] = None
    model: Optional[str] = None
    effort: Optional[str] = None
    persona: Optional[str] = None
    pack_key: Optional[str] = None
    permission_mode: Optional[str] = None
    max_parallel: Optional[int] = None
    daily_budget: Optional[float] = None
    monthly_cap: Optional[float] = None
    max_runs_per_day: Optional[int] = None
    tokens_per_day: Optional[int] = None
    cap_per_run: Optional[float] = None
    scope: Optional[str] = None
    config: Optional[dict[str, Any]] = None


@router.post("/projects/{project_id}/ai/teams", status_code=201)
async def post_team(project_id: str, body: TeamBody, session: Session) -> dict:
    """Add a team. Its runner and sign-in are checked right away."""
    await _project(session, project_id)
    try:
        member = await svc_teams.create(
            session, project_id, body.model_dump(exclude_unset=True), by=_by()
        )
    except ValueError as exc:
        await session.rollback()
        _err(exc, 422)
    await svc_teams.test_connection(session, member.id)
    await board_events.publish("invalidate")
    member, profile = await _team(session, member.id)
    return await svc_teams.describe(session, member, profile)


@router.get("/ai/teams/{member_id}")
async def get_team(member_id: str, session: Session) -> dict:
    """One team."""
    member, profile = await _team(session, member_id)
    return await svc_teams.describe(session, member, profile)


@router.patch("/ai/teams/{member_id}")
async def patch_team(member_id: str, body: TeamBody, session: Session) -> dict:
    """Edit a team."""
    await _team(session, member_id)
    try:
        await svc_teams.update(
            session, member_id, body.model_dump(exclude_unset=True), by=_by()
        )
    except ValueError as exc:
        await session.rollback()
        _err(exc, 422)
    await board_events.publish("invalidate")
    member, profile = await _team(session, member_id)
    return await svc_teams.describe(session, member, profile)


class PauseBody(BaseModel):
    """Pause one team."""

    cancel_current: bool = False
    reason: Optional[str] = None


@router.post("/ai/teams/{member_id}/pause")
async def post_pause(member_id: str, body: PauseBody, session: Session) -> dict:
    """Pause: new work queues; the current run finishes, or is cancelled when asked."""
    await _team(session, member_id)
    await svc_teams.set_paused(
        session,
        member_id,
        True,
        by=_by(),
        cancel_current=body.cancel_current,
        reason=body.reason,
    )
    await board_events.publish("invalidate")
    member, profile = await _team(session, member_id)
    return await svc_teams.describe(session, member, profile)


@router.post("/ai/teams/{member_id}/resume")
async def post_resume(member_id: str, session: Session) -> dict:
    """Resume a paused team."""
    await _team(session, member_id)
    await svc_teams.set_paused(session, member_id, False, by=_by())
    await board_events.publish("invalidate")
    member, profile = await _team(session, member_id)
    return await svc_teams.describe(session, member, profile)


@router.post("/ai/teams/{member_id}/test")
async def post_test(member_id: str, session: Session) -> dict:
    """Check the runner and the sign-in of the team's account."""
    await _team(session, member_id)
    result = await svc_teams.test_connection(session, member_id)
    await board_events.publish("invalidate")
    return result


@router.get("/ai/teams/{member_id}/removal-impact")
async def get_removal_impact(member_id: str, session: Session) -> dict:
    """Open tickets and runs in flight that removing the team affects."""
    await _team(session, member_id)
    return await svc_teams.removal_impact(session, member_id)


class RemoveBody(BaseModel):
    """What happens to the team's open tickets."""

    tickets: Literal["reassign", "unassign"] = "unassign"
    reassign_to: Optional[str] = None


@router.post("/ai/teams/{member_id}/remove")
async def post_remove(member_id: str, body: RemoveBody, session: Session) -> dict:
    """Remove a team: its tickets go to a person or to nobody, its runs are cancelled."""
    await _team(session, member_id)
    try:
        result = await svc_teams.remove(
            session,
            member_id,
            by=_by(),
            tickets=body.tickets,
            reassign_to=body.reassign_to,
        )
    except ValueError as exc:
        _err(exc, 422)
    await board_events.publish("invalidate")
    return result


# --------------------------------------------------------------------------- settings


def settings_dict(s: AiProjectSettings) -> dict:
    """The project's AI settings for the API."""
    return {
        "project_id": s.project_id,
        "paused_all": s.paused_all,
        "paused_at": s.paused_at,
        "paused_reason": s.paused_reason,
        "board_daily_cap": s.board_daily_cap,
        "board_monthly_budget": s.board_monthly_budget,
        "board_tokens_per_day": s.board_tokens_per_day,
        "board_max_parallel": s.board_max_parallel,
        "board_runs_per_day": s.board_runs_per_day,
        "board_at_cap": s.board_at_cap,
        "run_memory_limit_mb": s.run_memory_limit_mb,
        "audit_retention_days": s.audit_retention_days,
        "permission_mode": s.permission_mode,
        "deny_list": loads(s.deny_list, []),
        "lessons_mode": s.lessons_mode,
        "lessons_max": s.lessons_max,
        "ops": loads(s.ops, {}),
    }


@router.get("/projects/{project_id}/ai/settings")
async def get_ai_settings(project_id: str, session: Session) -> dict:
    """The project's AI settings."""
    await _project(session, project_id)
    return settings_dict(await get_settings(session, project_id))


class SettingsBody(BaseModel):
    """Project AI settings; only the keys sent change."""

    board_daily_cap: Optional[float] = None
    board_monthly_budget: Optional[float] = None
    board_tokens_per_day: Optional[int] = None
    board_max_parallel: Optional[int] = None
    board_runs_per_day: Optional[int] = None
    board_at_cap: Optional[str] = None
    run_memory_limit_mb: Optional[int] = None
    audit_retention_days: Optional[int] = None
    permission_mode: Optional[str] = None
    deny_list: Optional[list[str]] = None
    lessons_mode: Optional[str] = None
    lessons_max: Optional[int] = None
    ops: Optional[dict[str, Any]] = None


@router.patch("/projects/{project_id}/ai/settings")
async def patch_ai_settings(
    project_id: str, body: SettingsBody, session: Session
) -> dict:
    """Change the project's AI settings."""
    import json

    from services.ai import ops as svc_ops

    await _project(session, project_id)
    settings = await get_settings(session, project_id)
    data = body.model_dump(exclude_unset=True)
    if data.get("permission_mode") not in (None, "bypass", "auto"):
        raise HTTPException(
            status_code=422, detail="The permission mode is bypass or auto."
        )
    if data.get("board_at_cap") not in (None, "pause", "stop"):
        raise HTTPException(status_code=422, detail="At the cap: pause or stop.")
    if data.get("lessons_mode") not in (None, "auto", "review"):
        raise HTTPException(
            status_code=422, detail="Lessons are kept auto or after review."
        )
    columns = AiProjectSettings.__table__.columns
    for key, value in data.items():
        if key in ("deny_list", "ops"):
            continue
        col_ = columns.get(key)
        if value is None and col_ is not None and not col_.nullable:
            raise HTTPException(
                status_code=422,
                detail=f"{key.replace('_', ' ').capitalize()} cannot be empty.",
            )
        setattr(settings, key, value)
    if "deny_list" in data:
        rules = [str(r).strip() for r in (data["deny_list"] or []) if str(r).strip()]
        settings.deny_list = json.dumps(rules)
    if data.get("ops") is not None:
        svc_ops.update(settings, data["ops"])
    session.add(settings)
    await session.commit()
    await session.refresh(settings)
    await board_events.publish("invalidate")
    return settings_dict(settings)


class PauseAllBody(BaseModel):
    """Stop every AI of the project."""

    reason: Optional[str] = None
    cancel_running: bool = True


@router.post("/projects/{project_id}/ai/pause-all")
async def post_pause_all(project_id: str, body: PauseAllBody, session: Session) -> dict:
    """The kill switch: nothing new starts; running runs are cancelled unless asked to finish."""
    from services.ai import runs as svc_runs
    from services.ai.store import now_iso

    await _project(session, project_id)
    settings = await get_settings(session, project_id)
    settings.paused_all = True
    settings.paused_at = now_iso()
    settings.paused_reason = body.reason or f"Paused by {_by()}"
    session.add(settings)
    await session.commit()
    if body.cancel_running and hasattr(svc_runs, "cancel"):
        for r in await active_runs(session):
            if r.project_id == project_id and r.state in (
                "starting",
                "running",
                "queued",
            ):
                try:
                    await svc_runs.cancel(r.id, by=_by(), reason=settings.paused_reason)
                except svc_runs.RunError:
                    pass
    await board_events.publish("invalidate")
    return settings_dict(settings)


@router.post("/projects/{project_id}/ai/resume-all")
async def post_resume_all(project_id: str, session: Session) -> dict:
    """Lift the kill switch."""
    from services.ai import runs as svc_runs

    await _project(session, project_id)
    settings = await get_settings(session, project_id)
    settings.paused_all = False
    settings.paused_at = None
    settings.paused_reason = None
    session.add(settings)
    await session.commit()
    svc_runs.RT.wake.set()
    await board_events.publish("invalidate")
    return settings_dict(settings)


# --------------------------------------------------------------------------- overview and board


@router.get("/projects/{project_id}/ai/overview")
async def get_overview(project_id: str, session: Session) -> dict:
    """Counts for the AI Team page header: teams, runs by state, the kill switch. No steps."""
    await _project(session, project_id)
    settings = await get_settings(session, project_id)
    teams = await svc_teams.list_teams(session, project_id)
    runs = (
        await session.exec(select(AiRun).where(AiRun.project_id == project_id))
    ).all()
    by_state: dict[str, int] = {}
    for r in runs:
        by_state[r.state] = by_state.get(r.state, 0) + 1
    return {
        "project_id": project_id,
        "paused_all": settings.paused_all,
        "paused_reason": settings.paused_reason,
        "teams": [
            {
                "id": t["id"],
                "name": t["name"],
                "color": t["color"],
                "status": t["status"],
                "slots_in_use": t["slots_in_use"],
                "queued": t["queued"],
                "health": t["health"],
            }
            for t in teams
        ],
        "runs": by_state,
        "active": [
            {
                "run_id": r.id,
                "ticket_id": r.ticket_id,
                "member_id": r.member_id,
                "state": r.state,
            }
            for r in runs
            if r.state in ("queued", "starting", "running", "needs_input")
        ],
    }


@router.get("/projects/{project_id}/ai/board")
async def get_board(project_id: str, session: Session) -> dict:
    """What a board card shows per ticket: the latest run's state, its team and when it moved. No steps."""
    await _project(session, project_id)
    rows = (
        await session.exec(
            select(AiRun)
            .where(AiRun.project_id == project_id, col(AiRun.ticket_id).is_not(None))
            .order_by(col(AiRun.queued_at).desc())
        )
    ).all()
    out: dict[str, dict] = {}
    for r in rows:
        if r.ticket_id in out:
            continue
        out[r.ticket_id] = {
            "run_id": r.id,
            "member_id": r.member_id,
            "state": r.state,
            "number": r.number,
            "started_at": r.started_at,
            "ended_at": r.ended_at,
            "last_output_at": r.last_output_at,
            "steps_count": r.steps_count,
            "summary": r.summary,
            "question": loads(r.question, None) if r.question else None,
        }
    return {"tickets": out}


# --------------------------------------------------------------------------- runs


async def _run(session: AsyncSession, run_id: str) -> AiRun:
    run = await session.get(AiRun, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Run not found")
    return run


class RunBody(BaseModel):
    """Start a run on a ticket, or tell its running lead something."""

    team_id: Optional[str] = None
    instruction: Optional[str] = None
    mode: Literal["work", "ask"] = "work"


@router.post("/tickets/{ticket_id}/ai/run", status_code=200)
async def post_ticket_run(ticket_id: str, body: RunBody, session: Session) -> dict:
    """Run the ticket's team on it (the assignee, the given team, or the project's only team). A lead already on the
    ticket hears the instruction instead of a second run starting."""
    try:
        run = await svc_runs.start_on_ticket(
            session,
            ticket_id,
            member_id=body.team_id,
            by=_by(),
            instruction=body.instruction or "",
            mode=body.mode,
        )
    except svc_runs.RunConflict as exc:
        _err(exc, 409)
    except ValueError as exc:
        _err(exc, 422)
    await board_events.publish("invalidate")
    return svc_runs.to_dict(run)


@router.get("/tickets/{ticket_id}/ai/runs")
async def get_ticket_runs(
    ticket_id: str, session: Session, limit: int = 30
) -> list[dict]:
    """The ticket's runs, newest first, without steps."""
    rows = (
        await session.exec(
            select(AiRun)
            .where(AiRun.ticket_id == ticket_id)
            .order_by(col(AiRun.queued_at).desc())
            .limit(limit)
        )
    ).all()
    return [svc_runs.to_dict(r) for r in rows]


@router.get("/projects/{project_id}/ai/runs")
async def get_project_runs(
    project_id: str, session: Session, limit: int = 60, state: Optional[str] = None
) -> list[dict]:
    """The project's runs, newest first, without steps."""
    await _project(session, project_id)
    stmt = select(AiRun).where(AiRun.project_id == project_id)
    if state:
        stmt = stmt.where(col(AiRun.state).in_(state.split(",")))
    rows = (
        await session.exec(stmt.order_by(col(AiRun.queued_at).desc()).limit(limit))
    ).all()
    return [svc_runs.to_dict(r) for r in rows]


@router.get("/ai/runs/{run_id}")
async def get_run(run_id: str, session: Session, steps: int = 50) -> dict:
    """One run with its subagents and its newest `steps` steps."""
    run = await _run(session, run_id)
    return {
        **svc_runs.to_dict(run),
        "agents": await svc_steps.agents(session, run_id),
        "steps": await svc_steps.read(session, run_id, limit=steps, last=True),
    }


@router.get("/ai/runs/{run_id}/steps")
async def get_run_steps(
    run_id: str,
    session: Session,
    after: int = 0,
    limit: int = 200,
    agent: Optional[str] = None,
) -> list[dict]:
    """A page of steps after `after` (a seq); `agent` = lead or an agent id."""
    await _run(session, run_id)
    return await svc_steps.read(
        session, run_id, after=after, limit=min(limit, 500), agent_id=agent
    )


@router.get("/ai/runs/{run_id}/steps/{seq}/output")
async def get_step_output(run_id: str, seq: int, session: Session) -> dict:
    """One step with what its command printed."""
    await _run(session, run_id)
    out = await svc_steps.output(session, run_id, seq)
    if out is None:
        raise HTTPException(status_code=404, detail="Step not found")
    return out


@router.get("/ai/runs/{run_id}/messages")
async def get_run_messages(run_id: str, session: Session) -> list[dict]:
    """Messages into and out of the run."""
    from models import AiRunMessage

    await _run(session, run_id)
    rows = (
        await session.exec(
            select(AiRunMessage)
            .where(AiRunMessage.run_id == run_id)
            .order_by(col(AiRunMessage.at).asc())
        )
    ).all()
    return [
        {
            "id": m.id,
            "direction": m.direction,
            "peer": m.peer,
            "text": m.text,
            "at": m.at,
            "delivered_at": m.delivered_at,
        }
        for m in rows
    ]


class TextBody(BaseModel):
    """A message or an answer."""

    text: str = ""


@router.post("/ai/runs/{run_id}/cancel")
async def post_cancel(run_id: str, session: Session) -> dict:
    """Stop the run; files stay as they are."""
    await _run(session, run_id)
    try:
        run = await svc_runs.cancel(run_id, by=_by())
    except ValueError as exc:
        _err(exc, 409)
    await board_events.publish("invalidate")
    return svc_runs.to_dict(run)


@router.get("/tickets/{ticket_id}/ai/sessions")
async def get_sessions(ticket_id: str, session: Session) -> list[dict]:
    """The closed conversations of the ticket's team, newest first."""
    from services.ai import session_history

    return await session_history.list_for_ticket(ticket_id)


@router.post("/tickets/{ticket_id}/ai/sessions/new")
async def post_new_session(ticket_id: str, session: Session) -> dict:
    """Start the team over on this ticket: its conversation is closed into the history, the next run begins anew."""
    from services.ai import session_history

    try:
        row = await session_history.start_over(ticket_id, by=_by())
    except (ValueError, svc_runs.RunError) as exc:
        _err(exc, 409)
    await board_events.publish("invalidate")
    return row


@router.post("/tickets/{ticket_id}/ai/compact")
async def post_compact(ticket_id: str, session: Session) -> dict:
    """`/compact` in the ticket chat: the lead's conversation is summarised (when it is working, after its step)."""
    from services.ai import compact

    try:
        return await compact.compact_ticket(ticket_id, by=_by())
    except (ValueError, svc_runs.RunError) as exc:
        _err(exc, 409)


@router.post("/ai/runs/{run_id}/answer")
async def post_answer(run_id: str, body: TextBody, session: Session) -> dict:
    """Answer the lead's question; the run resumes its conversation."""
    await _run(session, run_id)
    try:
        run = await svc_runs.answer(run_id, by=_by(), text=body.text)
    except ValueError as exc:
        _err(exc, 409)
    await board_events.publish("invalidate")
    return svc_runs.to_dict(run)


@router.post("/ai/runs/{run_id}/message")
async def post_message(run_id: str, body: TextBody, session: Session) -> dict:
    """Tell the run something: live when its lead runs, else its next turn."""
    await _run(session, run_id)
    try:
        return await svc_runs.send_message(run_id, body.text, by=_by())
    except ValueError as exc:
        _err(exc, 422)


@router.post("/ai/runs/{run_id}/retry")
async def post_retry(run_id: str, session: Session) -> dict:
    """A new run on the same ticket and conversation."""
    await _run(session, run_id)
    try:
        run = await svc_runs.retry(run_id, by=_by())
    except ValueError as exc:
        _err(exc, 409)
    await board_events.publish("invalidate")
    return svc_runs.to_dict(run)


@router.get("/projects/{project_id}/ai/live")
async def get_live(project_id: str, session: Session, limit: int = 100) -> dict:
    """The newest steps of the project's active runs (the live panel)."""
    await _project(session, project_id)
    rows = (
        await session.exec(
            select(AiRun).where(
                AiRun.project_id == project_id,
                col(AiRun.state).in_(["starting", "running", "needs_input"]),
            )
        )
    ).all()
    out = []
    for r in rows:
        for s in await svc_steps.read(
            session, r.id, limit=max(5, limit // max(1, len(rows))), last=True
        ):
            out.append({**s, "ticket_id": r.ticket_id, "member_id": r.member_id})
    out.sort(key=lambda s: s["at"])
    return {"runs": [svc_runs.to_dict(r) for r in rows], "steps": out[-limit:]}


@router.get("/projects/{project_id}/ai/team/activity")
async def get_project_activity(project_id: str, session: Session) -> dict:
    """What each team's lead and roles do now, when they last worked, runs and steps today (no money: cost is per run)."""
    await _project(session, project_id)
    teams = await svc_teams.list_teams(session, project_id)
    return {"teams": await svc_activity_roles.project_activity(session, teams)}


@router.get("/ai/teams/{member_id}/activity")
async def get_team_activity(member_id: str, session: Session) -> dict:
    """One team's lead and roles: now, last worked, runs and steps today."""
    member, profile = await _team(session, member_id)
    team = await svc_teams.describe(session, member, profile)
    return await svc_activity_roles.team_activity(
        session, member_id, [r["key"] for r in team["roles"]]
    )


@router.get("/projects/{project_id}/ai/recent")
async def get_recent(
    project_id: str, session: Session, team_id: Optional[str] = None, limit: int = 8
) -> dict:
    """Runs that just ended with the first line of their report, and the latest notes into and out of runs."""
    await _project(session, project_id)
    return await svc_activity_roles.recent(
        session, project_id, team_id=team_id, limit=max(1, min(limit, 50))
    )


@router.get("/projects/{project_id}/ai/team/timeline")
async def get_timeline(
    project_id: str,
    session: Session,
    range: str = "today",
    since: Optional[datetime] = None,
    until: Optional[datetime] = None,
    ticket_id: Optional[str] = None,
) -> dict:
    """The Timeline: a sequence diagram of the teams' runs in a window (the whole project, or one ticket)."""
    await _project(session, project_id)
    return await svc_timeline.timeline(
        session,
        project_id,
        range_key=range,
        since=since,
        until=until,
        ticket_id=ticket_id,
    )
