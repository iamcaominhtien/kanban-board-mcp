"""REST API of AI members, their runs on tickets, approvals, the audit log and the kill switch."""

import csv
import io
import json
import socket
import sys
from typing import Annotated, Any, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import Response
from pydantic import BaseModel
from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

import database
import events as board_events
import services.activity as svc_activity
import services.tickets as svc_tickets
from database import get_session
from models import AiMember, AiRun, Member, Project, Ticket, TicketRead, TicketUpdate
from services.ai import approvals as svc_approvals
from services.ai import audit as svc_audit
from services.ai import members as svc_members
from services.ai import autopilot, autotrip, budget, safety
from services.ai import usage as svc_usage
from services.ai import mentions as svc_mentions
from services.ai import permissions as perms
from services.ai import runs as svc_runs
from services.ai import flow_view as svc_flow
from services.ai import timeline as svc_timeline
from services.ai import health as svc_health
from services.ai import team as svc_team
from services.ai import touches as svc_touches
from services.ai.providers import (
    PRICES,
    PRICES_UPDATED,
    PROVIDERS,
    capability_matrix,
)
from services.ai.secrets import SecretStoreError
from services.ai.store import get_profile, get_settings, loads
from version import APP_VERSION

router = APIRouter(tags=["ai"])

Session = Annotated[AsyncSession, Depends(get_session)]


def _by() -> str:
    """The person making the request (X-Actor, or the board's own user)."""
    return svc_activity.current_actor() or "user"


def _err(exc: Exception, status: int = 400):
    raise HTTPException(status_code=status, detail=str(exc)) from exc


async def _project(session, project_id: str) -> Project:
    project = await session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return project


async def _ai(session, member_id: str) -> tuple[Member, AiMember]:
    member, profile = await get_profile(session, member_id)
    if member is None or profile is None:
        raise HTTPException(status_code=404, detail="AI member not found")
    return member, profile


def _settings_dict(s) -> dict:
    return {
        "project_id": s.project_id,
        "board_ai_id": s.board_ai_id,
        "ai_enabled": s.ai_enabled,
        "paused_all": s.paused_all,
        "paused_at": s.paused_at,
        "paused_by": s.paused_by,
        "paused_reason": s.paused_reason,
        "safe_mode": s.safe_mode,
        "board_daily_cap": s.board_daily_cap,
        "board_monthly_budget": s.board_monthly_budget,
        "max_chain_depth": s.max_chain_depth,
        "runs_per_ticket_per_day": s.runs_per_ticket_per_day,
        "approval_expiry_hours": s.approval_expiry_hours,
        "board_tokens_per_day": s.board_tokens_per_day,
        "board_max_parallel": s.board_max_parallel,
        "board_runs_per_day": s.board_runs_per_day,
        "board_at_cap": s.board_at_cap,
        "approval_on_expiry": s.approval_on_expiry,
        "approvers": safety.approvers_of(s),
        "delegates": safety.delegates_of(s),
        "audit_retention_days": s.audit_retention_days,
        "loop_cooldown_s": s.loop_cooldown_s,
        "no_repeat_chain": s.no_repeat_chain,
        "docs_edits_ask": s.docs_edits_ask,
        "allowed_domains": loads(s.allowed_domains, []),
        "notify": [{"event": k, **v} for k, v in safety.notify_prefs(s).items()],
        "digest": s.digest,
        "key_reminder_days": s.key_reminder_days,
        "paused_cancelled": s.paused_cancelled,
        "paused_held": s.paused_held,
        "paused_tokens_revoked": s.paused_tokens_revoked,
        "paused_let_finish": s.paused_let_finish,
        "paused_safe_before": s.paused_safe_before,
        "auto_trip": autotrip.describe(s),
    }


# ---------------------------------------------------------------------------
# Catalogue and checks used by the Add AI member stepper
# ---------------------------------------------------------------------------


@router.get("/ai/runner")
async def get_runner(request: Request) -> dict:
    """Where local runners run: this server's computer. `local` is true when the request comes from that same
    computer (the desktop app, or a browser on it); a browser elsewhere is the web build, which cannot start a CLI
    on the person's own machine (F6)."""
    host = request.client.host if request.client else ""
    return {
        "host": socket.gethostname(),
        "local": host in ("127.0.0.1", "::1", "localhost")
        or host.startswith("::ffff:127."),
        "app_version": APP_VERSION,
        "platform": sys.platform,
    }


@router.get("/ai/providers")
async def get_providers() -> dict:
    """Adapters, their connection type and models; the permission catalogue and templates."""
    return {
        "providers": PROVIDERS,
        "actions": [
            {"action": a, "label": lbl, "description": d, "risk": r}
            for a, (lbl, d, r) in perms.ACTIONS.items()
        ],
        "templates": perms.TEMPLATES,
        "locks": perms.LOCKS,
        "ceilings": perms.CEILINGS,
        "prices": {k: {"input": v[0], "output": v[1]} for k, v in PRICES.items()},
        "prices_updated": PRICES_UPDATED,
        "capability_matrix": capability_matrix(),
    }


class DetectBody(BaseModel):
    """Which CLI to look for."""

    provider: str
    cli_path: Optional[str] = None


@router.post("/ai/detect")
async def post_detect(body: DetectBody) -> dict:
    """Is the CLI installed here and signed in (account name only, never the token)?"""
    if PROVIDERS.get(body.provider, {}).get("connection") != "local":
        raise HTTPException(
            status_code=422, detail="Only local runners have a CLI to detect."
        )
    return await svc_members.detect_local(body.provider, body.cli_path, latest=True)


class TestRunBody(BaseModel):
    """A one-line test run before saving."""

    provider: str = "claude-code"
    cli_path: Optional[str] = None
    model: Optional[str] = None
    working_dir: Optional[str] = None


@router.post("/ai/test-run")
async def post_test_run(body: TestRunBody) -> dict:
    """Run `claude -p` once with a one-word prompt (step 2a "Run test")."""
    import os

    from services.ai import cli, paths

    path, _ = cli.find_cli(
        PROVIDERS.get(body.provider, {}).get("binary") or "claude", body.cli_path
    )
    if not path:
        return {"ok": False, "error": "The CLI was not found on this computer."}
    folder = None
    if (body.working_dir or "").strip():
        try:
            folder = paths.folder(body.working_dir)
        except paths.PathRefused:
            return {"ok": False, "error": paths.folder_refused(body.working_dir)}
        if not os.path.isdir(folder):
            return {
                "ok": False,
                "error": f"Working folder not found on this computer: {body.working_dir}",
            }
    return await cli.test_run(path, body.model, folder)


class TestKeyBody(BaseModel):
    """A key to try before saving (it is not stored)."""

    provider: str
    api_key: str
    base_url: Optional[str] = None


@router.post("/ai/test-key")
async def post_test_key(body: TestKeyBody) -> dict:
    """Is the key valid? (step 2c / 2d)."""
    return await svc_members.test_key(
        body.provider, body.api_key.strip(), body.base_url
    )


@router.get("/projects/{project_id}/ai/check-name")
async def get_check_name(
    project_id: str, name: str, session: Session, exclude: Optional[str] = None
) -> dict:
    """Live duplicate-name check (F1)."""
    return await svc_members.check_name(session, project_id, name, exclude_id=exclude)


# ---------------------------------------------------------------------------
# AI members
# ---------------------------------------------------------------------------


@router.get("/projects/{project_id}/ai/members")
async def get_ai_members(
    project_id: str, session: Session, include_removed: bool = False
) -> list[dict]:
    """The project's AI members with status, slots, usage and assigned tickets."""
    await _project(session, project_id)
    return await svc_members.list_members(
        session, project_id, include_removed=include_removed
    )


class AiMemberBody(BaseModel):
    """Register or edit an AI member (on edit, only the keys sent change)."""

    name: Optional[str] = None
    provider: Optional[str] = None
    color: Optional[str] = None
    glyph: Optional[str] = None
    description: Optional[str] = None
    cli_path: Optional[str] = None
    working_dir: Optional[str] = None
    base_url: Optional[str] = None
    model: Optional[str] = None
    api_key: Optional[str] = None
    persona: Optional[str] = None
    max_parallel: Optional[int] = None
    daily_budget: Optional[float] = None
    monthly_cap: Optional[float] = None
    max_runs_per_day: Optional[int] = None
    tokens_per_day: Optional[int] = None
    cap_per_run: Optional[float] = None
    warn_at: Optional[list[int]] = None
    safe_mode: Optional[bool] = None
    allow_external: Optional[bool] = None
    template: Optional[str] = None
    ceiling: Optional[str] = None
    confirm_done: Optional[bool] = None
    # the phrase typed to turn on Bypass permissions
    confirm_bypass: Optional[str] = None
    permissions: Optional[dict[str, str]] = None
    scope: Optional[str] = None
    config: Optional[dict[str, Any]] = None


@router.post("/projects/{project_id}/ai/members", status_code=201)
async def post_ai_member(project_id: str, body: AiMemberBody, session: Session) -> dict:
    """Add an AI member. A key that cannot be stored creates nothing (5b)."""
    await _project(session, project_id)
    try:
        member = await svc_members.create(
            session, project_id, body.model_dump(exclude_unset=True), by=_by()
        )
    except SecretStoreError as exc:
        await session.rollback()
        _err(exc, 500)
    except svc_members.AiPermissionDenied as exc:
        await session.rollback()
        _err(exc, 403)
    except ValueError as exc:
        await session.rollback()
        _err(exc, 422)
    _, profile = await _ai(session, member.id)
    if profile.connection == "local":
        # CLI path, version and account name (no test run: the stepper already made one)
        await svc_members.test_connection(session, member.id, full=False)
        member, profile = await _ai(session, member.id)
    await board_events.publish("invalidate")
    return await svc_members.describe(session, member, profile)


@router.get("/ai/members/{member_id}")
async def get_ai_member(member_id: str, session: Session) -> dict:
    """One AI member (profile Overview)."""
    member, profile = await _ai(session, member_id)
    return await svc_members.describe(session, member, profile)


@router.patch("/ai/members/{member_id}")
async def patch_ai_member(member_id: str, body: AiMemberBody, session: Session) -> dict:
    """Edit an AI member; permission and ceiling changes are audited."""
    await _ai(session, member_id)
    try:
        await svc_members.update(
            session, member_id, body.model_dump(exclude_unset=True), by=_by()
        )
    except SecretStoreError as exc:
        _err(exc, 500)
    except svc_members.AiPermissionDenied as exc:
        await session.rollback()
        _err(exc, 403)
    except ValueError as exc:
        _err(exc, 422)
    await board_events.publish("invalidate")
    member, profile = await _ai(session, member_id)
    return await svc_members.describe(session, member, profile)


@router.post("/ai/members/{member_id}/permissions/pending/{decision}")
async def post_pending_decision(
    member_id: str, decision: str, session: Session
) -> dict:
    """The owner confirms or rejects a permission change an admin asked for (H1)."""
    if decision not in ("confirm", "reject"):
        _err(ValueError("decision must be confirm or reject"), 404)
    await _ai(session, member_id)
    try:
        await svc_members.decide_pending(
            session, member_id, by=_by(), confirm=decision == "confirm"
        )
    except svc_members.AiPermissionDenied as exc:
        _err(exc, 403)
    except svc_members.AiMemberError as exc:
        _err(exc, 409)
    await board_events.publish("invalidate")
    member, profile = await _ai(session, member_id)
    return await svc_members.describe(session, member, profile)


class ProjectsBody(BaseModel):
    """Projects an AI member works in."""

    project_ids: list[str]


@router.put("/ai/members/{member_id}/projects")
async def put_member_projects(
    member_id: str, body: ProjectsBody, session: Session
) -> list[dict]:
    """Make an AI member work in these projects: a linked copy is added or removed per project."""
    from services.ai import multiproject

    await _ai(session, member_id)
    try:
        out = await multiproject.set_projects(
            session, member_id, body.project_ids, by=_by()
        )
    except multiproject.ProjectsError as exc:
        _err(exc, 422)
    await board_events.publish("invalidate")
    return out


class PauseBody(BaseModel):
    """Pause one agent (D4)."""

    cancel_current: bool = False
    reason: Optional[str] = None


@router.post("/ai/members/{member_id}/pause")
async def post_pause(member_id: str, body: PauseBody, session: Session) -> dict:
    """Pause: new work queues; the current run finishes, or is cancelled when asked."""
    await _ai(session, member_id)
    await svc_members.set_paused(
        session,
        member_id,
        True,
        by=_by(),
        cancel_current=body.cancel_current,
        reason=body.reason,
    )
    await board_events.publish("invalidate")
    member, profile = await _ai(session, member_id)
    return await svc_members.describe(session, member, profile)


@router.post("/ai/members/{member_id}/resume")
async def post_resume(member_id: str, session: Session) -> dict:
    """Resume a paused agent."""
    await _ai(session, member_id)
    await svc_members.set_paused(session, member_id, False, by=_by())
    await board_events.publish("invalidate")
    member, profile = await _ai(session, member_id)
    return await svc_members.describe(session, member, profile)


@router.post("/ai/members/{member_id}/retry-now")
async def post_retry_now(member_id: str, session: Session) -> dict:
    """Skip a rate limit's wait: queued runs try the provider again at once."""
    await _ai(session, member_id)
    try:
        await svc_members.retry_now(session, member_id, by=_by())
    except ValueError as exc:
        _err(exc, 409)
    await board_events.publish("invalidate")
    member, profile = await _ai(session, member_id)
    return await svc_members.describe(session, member, profile)


class TestBody(BaseModel):
    """Test the saved connection; `full` also makes a one-line run."""

    full: bool = True


@router.post("/ai/members/{member_id}/test")
async def post_test(member_id: str, body: TestBody, session: Session) -> dict:
    """Test connection: CLI + sign-in (+ run), or the API key."""
    await _ai(session, member_id)
    result = await svc_members.test_connection(session, member_id, full=body.full)
    await board_events.publish("invalidate")
    return result


@router.get("/ai/members/{member_id}/removal-impact")
async def get_removal_impact(member_id: str, session: Session) -> dict:
    """Open tickets and runs in flight that removing the member affects."""
    await _ai(session, member_id)
    return await svc_members.removal_impact(session, member_id)


class RemoveBody(BaseModel):
    """Remove AI member choices (F2)."""

    tickets: Literal["reassign", "unassign"] = "unassign"
    reassign_to: Optional[str] = None
    runs: Literal["finish", "cancel"] = "cancel"


@router.post("/ai/members/{member_id}/remove")
async def post_remove(member_id: str, body: RemoveBody, session: Session) -> dict:
    """Remove: reassign or unassign open tickets; cancel the run in progress or let it finish first."""
    await _ai(session, member_id)
    try:
        result = await svc_members.remove(
            session,
            member_id,
            by=_by(),
            tickets=body.tickets,
            reassign_to=body.reassign_to,
            runs_choice=body.runs,
        )
    except ValueError as exc:
        _err(exc, 422)
    await board_events.publish("invalidate")
    return result


@router.get("/ai/members/{member_id}/usage")
async def get_usage(member_id: str, session: Session) -> dict:
    """Usage tab: today, month, 14 days, recent runs."""
    member, profile = await _ai(session, member_id)
    use = await svc_members.usage(session, member_id)
    recent = await svc_runs.list_runs(session, member_id=member_id, limit=20)
    use["recent_runs"] = [
        {k: v for k, v in d.items() if k != "steps"}
        for d in await svc_runs.runs_to_dicts(session, recent)
    ]
    use["metered"] = profile.connection == "api_key"
    use["daily_budget"] = profile.daily_budget
    use["monthly_cap"] = profile.monthly_cap
    use["max_runs_per_day"] = profile.max_runs_per_day
    return use


def _history_entry(e) -> dict:
    """One row of the Permissions tab's change history: who, when, what changed per action."""
    d = svc_audit.to_dict(e)
    detail = d["detail"]
    changes = detail.get("changes") or {}
    diffs = list(changes.get("diffs") or [])
    if not diffs and isinstance(changes.get("permissions"), list):
        old, new = changes["permissions"]
        for action in perms.ACTIONS:
            if (old or {}).get(action) != (new or {}).get(action):
                diffs.append(
                    {
                        "action": action,
                        "label": perms.ACTIONS[action][0],
                        "from": (old or {}).get(action),
                        "to": (new or {}).get(action),
                    }
                )
    other = []
    for key, label in (
        ("template", "Role template"),
        ("ceiling", "Status ceiling"),
        ("scope", "Scope"),
        ("daily_budget", "Daily budget"),
        ("monthly_cap", "Monthly cap"),
    ):
        pair = changes.get(key)
        if isinstance(pair, list) and len(pair) == 2:
            other.append({"label": label, "from": pair[0], "to": pair[1]})
    return {
        "id": d["id"],
        "at": d["created_at"],
        "by": d["on_behalf_of"],
        "by_role": detail.get("by_role"),
        "kind": "created" if d["action"] == "member_created" else "changed",
        "diffs": diffs,
        "other": other,
        "template": detail.get("template"),
        "ceiling": detail.get("ceiling"),
    }


@router.get("/ai/members/{member_id}/permissions")
async def get_permissions(member_id: str, session: Session) -> dict:
    """Permissions tab: the matrix with where each mode comes from, the change history and who may change it."""
    member, profile = await _ai(session, member_id)
    settings = await get_settings(session, member.project_id)
    history = await svc_audit.list_entries(
        session,
        member.project_id,
        member_id=member_id,
        actions=["member_created", "member_updated"],
        limit=200,
    )
    rows = [_history_entry(e) for e in history]
    rows = [r for r in rows if r["kind"] == "created" or r["diffs"] or r["other"]]
    for r in rows:
        if r["by"] and not r["by_role"]:
            r["by_role"] = await safety.role_name(session, member.project_id, r["by"])
    project = await session.get(Project, member.project_id)
    me = _by()
    own = perms.overrides_of(profile)
    return {
        "template": profile.template,
        "ceiling": profile.ceiling,
        "scope": profile.scope,
        "matrix": perms.matrix(profile, settings),
        "history": rows[:20],
        "safe_mode": settings.safe_mode,
        "agent_safe_mode": profile.safe_mode,
        "paused_all": settings.paused_all,
        "override_labels": [perms.ACTIONS[a][0] for a in own],
        "me": {
            "name": me,
            "role": await safety.role_name(session, member.project_id, me),
        },
        "projects": [
            {
                "id": member.project_id,
                "name": project.name if project else "",
                "checked": True,
            }
        ],
    }


class TesterBody(BaseModel):
    """Effective-permission tester: changes nothing."""

    action: str
    ticket_id: Optional[str] = None
    target_status: Optional[str] = None


@router.post("/ai/members/{member_id}/permissions/test")
async def post_permission_test(
    member_id: str, body: TesterBody, session: Session
) -> dict:
    """Can this AI do X on a ticket? Every layer, and the verdict."""
    member, profile = await _ai(session, member_id)
    settings = await get_settings(session, member.project_id)
    decision = perms.effective(profile, body.action, settings)
    checks = [
        {
            "label": layer["layer"],
            "ok": layer["mode"] != "blocked",
            "mode": layer["mode"],
        }
        for layer in decision.layers
    ]
    verdict, reason = decision.mode, decision.reason
    ticket_info = None
    if body.ticket_id:
        ticket = await session.get(Ticket, body.ticket_id)
        if ticket is None:
            raise HTTPException(status_code=404, detail="Ticket not found")
        in_scope = profile.scope == "project" or ticket.assignee == member_id
        ticket_info = {"id": ticket.id, "title": ticket.title, "status": ticket.status}
        checks.append(
            {
                "label": "Scope",
                "ok": in_scope,
                "mode": "allowed" if in_scope else "blocked",
                "note": f"{ticket.id} is assigned to it"
                if ticket.assignee == member_id
                else (
                    "any ticket in the project"
                    if in_scope
                    else f"{ticket.id} is not assigned to it"
                ),
            }
        )
        if not in_scope:
            verdict, reason = "blocked", f"{ticket.id} is outside its scope."
        if body.action == "change_status" and body.target_status:
            why = perms.check_status_move(profile, ticket.status, body.target_status)
            checks.append(
                {
                    "label": "Status ceiling",
                    "ok": why is None,
                    "mode": "blocked" if why else "allowed",
                    "note": why or f"within {profile.ceiling}",
                }
            )
            if why:
                verdict, reason = "blocked", why
    return {
        "verdict": verdict,
        "reason": reason,
        "checks": checks,
        "ticket": ticket_info,
    }


# ---------------------------------------------------------------------------
# Project-level: overview, settings, kill switch, usage
# ---------------------------------------------------------------------------


async def _summary(session, project_id: str) -> dict:
    start = budget.today_start()
    runs_today = (
        await session.exec(
            select(AiRun).where(
                AiRun.project_id == project_id, AiRun.queued_at >= start.isoformat()
            )
        )
    ).all()
    running = (
        await session.exec(
            select(AiRun).where(
                AiRun.project_id == project_id,
                col(AiRun.state).in_(["starting", "running"]),
            )
        )
    ).all()
    return {
        "running_now": len(running),
        "runs_today": len(runs_today),
        "spend_today": round(sum(r.cost_usd for r in runs_today if r.metered), 4),
    }


@router.get("/projects/{project_id}/ai/overview")
async def get_overview(project_id: str, session: Session) -> dict:
    """Everything the AI members page and the board need at once."""
    await _project(session, project_id)
    settings = await get_settings(session, project_id)
    members = await svc_members.list_members(session, project_id)
    summary = await _summary(session, project_id)
    attention = [
        m
        for m in members
        if m["status"]["code"]
        in (
            "key_invalid",
            "not_logged_in",
            "runner_missing",
            "model_retired",
            "over_budget",
            "rate_limited",
        )
    ]
    summary["need_attention"] = len(attention)
    pending = await svc_approvals.list_approvals(session, project_id, status="pending")
    return {
        "settings": _settings_dict(settings),
        "members": members,
        "summary": summary,
        "pending_approvals": len(pending),
    }


@router.get("/projects/{project_id}/ai/team/now")
async def get_team_now(
    project_id: str,
    session: Session,
    range: Literal["today", "7d", "30d"] = "today",
) -> dict:
    """The AI Team view, Now tab: a card per AI, what waits for a person, recent hand-offs, totals of the range."""
    await _project(session, project_id)
    return await svc_team.now_view(session, project_id, range)


@router.get("/projects/{project_id}/ai/team/stepped-in")
async def get_team_stepped_in(
    project_id: str,
    session: Session,
    range: Literal["today", "7d", "30d"] = "7d",
    mark: Optional[Literal["by_rule", "needed", "avoidable"]] = None,
    member_id: Optional[str] = None,
    person: Optional[str] = None,
    via: Optional[Literal["mcp"]] = None,
) -> dict:
    """The AI Team view, You stepped in tab: every touch by a person, marked by rule, needed or avoidable."""
    await _project(session, project_id)
    return await svc_touches.stepped_in(
        session,
        project_id,
        range,
        mark=mark,
        member_id=member_id,
        person=person,
        via=via,
    )


@router.get("/projects/{project_id}/ai/team/health")
async def get_team_health(
    project_id: str,
    session: Session,
    range: Literal["today", "7d", "30d"] = "7d",
) -> dict:
    """The AI Team view, Health tab: five measures, a row per AI and what to fix, with the evidence."""
    await _project(session, project_id)
    return await svc_health.health(session, project_id, range)


class DismissBody(BaseModel):
    """A "What to fix" suggestion to hide."""

    key: str


@router.post("/projects/{project_id}/ai/team/health/dismiss")
async def post_team_health_dismiss(
    project_id: str, body: DismissBody, session: Session
) -> dict:
    """Dismiss a suggestion; it stays hidden. Nothing about the AI team is changed."""
    await _project(session, project_id)
    keys = await svc_health.dismiss(session, project_id, body.key, by=_by())
    return {"dismissed": keys}


@router.get("/projects/{project_id}/ai/team/flow")
async def get_team_flow(
    project_id: str,
    session: Session,
    range: Literal["today", "7d", "30d"] = "7d",
) -> dict:
    """The AI Team view, Flow tab: who passed work to whom, by kind, with how long the next AI waited."""
    await _project(session, project_id)
    return await svc_flow.team_map(session, project_id, range)


def _parse_when(value: Optional[str]):
    """A time from a query (ISO), or None; a bad one is a 422."""
    if not value:
        return None
    from services.ai.store import parse_iso

    at = parse_iso(value)
    if at is None:
        raise HTTPException(status_code=422, detail="Not a time: use ISO 8601.")
    return at


@router.get("/projects/{project_id}/ai/team/timeline")
async def get_team_timeline(
    project_id: str,
    session: Session,
    range: Literal["hour", "today", "24h", "7d"] = "today",
    since: Optional[str] = None,
    until: Optional[str] = None,
    ticket_id: Optional[str] = None,
) -> dict:
    """The AI Team view, Flow tab, Timeline: a sequence diagram of the team (lifelines, runs, hand-offs, questions,
    approvals, Autopilot decisions and pauses) for a window and a scope."""
    await _project(session, project_id)
    a, b = _parse_when(since), _parse_when(until)
    return await svc_timeline.timeline(
        session, project_id, range_key=range, since=a, until=b, ticket_id=ticket_id
    )


@router.get("/projects/{project_id}/ai/team/flow/{ticket_id}")
async def get_team_flow_ticket(
    project_id: str, ticket_id: str, session: Session
) -> dict:
    """One ticket from the first assignment to now: runs, hand-offs, touches and where the time went."""
    await _project(session, project_id)
    out = await svc_flow.ticket_journey(session, project_id, ticket_id)
    if out is None:
        raise HTTPException(status_code=404, detail="Ticket not found")
    return out


@router.get("/projects/{project_id}/ai/board")
async def get_board(project_id: str, session: Session) -> dict:
    """Run state per ticket (card footers, column indicators) plus the kill switch state."""
    await _project(session, project_id)
    settings = await get_settings(session, project_id)
    return {
        # A list, not a dict keyed by ticket id: the UI camel-cases keys, which would mangle "KAN-1"
        "runs": list((await svc_runs.latest_by_ticket(session, project_id)).values()),
        "settings": {
            **_settings_dict(settings),
            "paused_finishing": await svc_runs.finishing_after_pause(
                session, project_id
            ),
            "my_role": await safety.role_name(session, project_id, _by()),
        },
    }


class SettingsBody(BaseModel):
    """Project AI settings."""

    board_ai_id: Optional[str] = None
    ai_enabled: Optional[bool] = None
    safe_mode: Optional[bool] = None
    board_daily_cap: Optional[float] = None
    board_monthly_budget: Optional[float] = None
    max_chain_depth: Optional[int] = None
    runs_per_ticket_per_day: Optional[int] = None
    approval_expiry_hours: Optional[int] = None
    board_tokens_per_day: Optional[int] = None
    board_max_parallel: Optional[int] = None
    board_runs_per_day: Optional[int] = None
    board_at_cap: Optional[str] = None
    approval_on_expiry: Optional[str] = None
    approvers: Optional[dict[str, str]] = None
    delegates: Optional[list[dict[str, Any]]] = None
    audit_retention_days: Optional[int] = None  # 0 keeps entries forever
    loop_cooldown_s: Optional[int] = None
    no_repeat_chain: Optional[bool] = None
    docs_edits_ask: Optional[bool] = None
    allowed_domains: Optional[list[str]] = None
    notify: Optional[list[dict[str, Any]]] = None
    digest: Optional[str] = None
    key_reminder_days: Optional[int] = None
    auto_trip: Optional[list[dict[str, Any]]] = (
        None  # [{key, on, count, minutes, factor}]
    )


@router.patch("/projects/{project_id}/ai/settings")
async def patch_settings(project_id: str, body: SettingsBody, session: Session) -> dict:
    """Board AI, safe mode and board-wide limits."""
    await _project(session, project_id)
    settings = await get_settings(session, project_id)
    data = body.model_dump(exclude_unset=True)
    if "board_ai_id" in data and data["board_ai_id"]:
        member, profile = await _ai(session, data["board_ai_id"])
        if member.project_id != project_id or member.kind != "ai":
            raise HTTPException(
                status_code=422,
                detail="The Board AI must be an AI member of this project.",
            )
        if (
            profile.health
            in ("key_invalid", "not_logged_in", "runner_missing", "model_retired")
            or profile.connection == "inbox"
            or profile.paused
        ):
            raise HTTPException(
                status_code=422,
                detail=f"{member.name} is not reachable right now; fix it first.",
            )
    if (
        data.get("max_chain_depth") is not None
        and not 1 <= data["max_chain_depth"] <= 10
    ):
        raise HTTPException(status_code=422, detail="Max chain depth: 1 to 10.")
    if data.get("approval_expiry_hours") is not None and data[
        "approval_expiry_hours"
    ] not in (1, 4, 24, 72):
        raise HTTPException(
            status_code=422, detail="Approvals expire after 1 h, 4 h, 24 h or 3 days."
        )
    role = await safety.role_name(session, project_id, _by())
    if role == "viewer" or (role == "member" and set(data) - {"safe_mode"}):
        raise HTTPException(
            status_code=403,
            detail="Only owners and admins can change AI limits and rules.",
        )
    if "board_at_cap" in data and data["board_at_cap"] not in ("pause", "stop", "ask"):
        raise HTTPException(status_code=422, detail="At the cap: pause, stop or ask.")
    if "approval_on_expiry" in data and data["approval_on_expiry"] not in (
        "skip",
        "stop",
    ):
        raise HTTPException(
            status_code=422, detail="On expiry: skip the action or stop the run."
        )
    if "digest" in data and data["digest"] not in safety.DIGESTS:
        raise HTTPException(status_code=422, detail="Digest: off, daily or weekdays.")
    daily = data.get("board_daily_cap", settings.board_daily_cap)
    monthly = data.get("board_monthly_budget", settings.board_monthly_budget)
    if daily is not None and monthly is not None and monthly < daily:
        raise HTTPException(
            status_code=422,
            detail=f"The monthly budget must be at least the daily cap (${daily:.2f}).",
        )
    for key, lo, hi in (
        ("board_max_parallel", 1, 50),
        ("board_runs_per_day", 1, 5000),
        ("board_tokens_per_day", 1000, 1_000_000_000),
        ("loop_cooldown_s", 0, 3600),
        ("key_reminder_days", 7, 3650),
    ):
        if data.get(key) is not None and not lo <= data[key] <= hi:
            raise HTTPException(
                status_code=422,
                detail=f"{key.replace('_', ' ').capitalize()}: {lo} to {hi}.",
            )
    if "auto_trip" in data:
        try:
            patch = autotrip.validate(data["auto_trip"] or [])
        except ValueError as exc:
            _err(exc, 422)
        current = loads(settings.auto_trip, {}) or {}
        data["auto_trip"] = autotrip.dumps(
            {
                k: {**(current.get(k) or {}), **v}
                for k, v in {**current, **patch}.items()
            }
        )
    if "approvers" in data:
        merged = {**safety.approvers_of(settings), **(data["approvers"] or {})}
        if any(v not in safety.ROLE_RANK or v == "viewer" for v in merged.values()):
            raise HTTPException(
                status_code=422, detail="Approvers: member, admin or owner."
            )
        data["approvers"] = json.dumps(merged)
    if "delegates" in data:
        clean = []
        for d in data["delegates"] or []:
            if d.get("from") and d.get("to") and d["from"] != d["to"]:
                clean.append(
                    {
                        "from": str(d["from"]),
                        "to": str(d["to"]),
                        "until": d.get("until") or None,
                    }
                )
        data["delegates"] = json.dumps(clean)
    if "allowed_domains" in data:
        domains: list[str] = []
        for d in data["allowed_domains"] or []:
            d = (
                d.strip()
                .lower()
                .removeprefix("https://")
                .removeprefix("http://")
                .strip("/")
            )
            if d and "/" not in d and " " not in d and d not in domains:
                domains.append(d)
        data["allowed_domains"] = json.dumps(domains)
    if "audit_retention_days" in data:
        if data["audit_retention_days"] not in (0, None, 30, 90, 365):
            raise HTTPException(
                status_code=422,
                detail="Retention: 30 days, 90 days, 1 year or forever.",
            )
        data["audit_retention_days"] = data["audit_retention_days"] or None
    if "notify" in data:
        prefs = {}
        for item in data["notify"] or []:
            if item.get("event") in safety.EVENTS:
                prefs[item["event"]] = {
                    "inapp": bool(item.get("inapp")),
                    "desktop": bool(item.get("desktop")),
                }
        data["notify"] = json.dumps({**loads(settings.notify, {}), **prefs})
    old = _settings_dict(settings)
    for key, value in data.items():
        setattr(settings, key, value)
    session.add(settings)
    await session.commit()
    await session.refresh(settings)
    new = _settings_dict(settings)
    await svc_audit.record(
        project_id,
        "settings_updated",
        "info",
        member_name=_by(),
        on_behalf_of=_by(),
        detail={
            "changes": {
                k: [old.get(k), new.get(k)] for k in data if old.get(k) != new.get(k)
            },
            "by_role": role,
        },
    )
    if "audit_retention_days" in data:
        await svc_audit.prune()
    await board_events.publish("invalidate")
    return _settings_dict(settings)


class AutopilotBody(BaseModel):
    """Autopilot: the delegate AI that decides requests for the owner (services/ai/autopilot.py)."""

    enabled: Optional[bool] = None
    delegate_id: Optional[str] = None
    max_risk: Optional[str] = None
    approvals: Optional[bool] = None
    questions: Optional[bool] = None
    grace_min: Optional[int] = None
    per_hour_limit: Optional[int] = None
    full_rights: Optional[bool] = None
    accept_risks: bool = False


@router.get("/projects/{project_id}/ai/autopilot")
async def get_autopilot(project_id: str, session: Session) -> dict:
    """The Autopilot configuration and how much of its hourly allowance is used."""
    await _project(session, project_id)
    return await autopilot.public(session, await get_settings(session, project_id))


@router.put("/projects/{project_id}/ai/autopilot")
async def put_autopilot(project_id: str, body: AutopilotBody, session: Session) -> dict:
    """Owners only. Turning it on, giving the delegate full rights or raising the risk to High needs `accept_risks`."""
    await _project(session, project_id)
    settings = await get_settings(session, project_id)
    if await safety.role_name(session, project_id, _by()) != "owner":
        raise HTTPException(
            status_code=403, detail="Only the project owner sets up Autopilot."
        )
    data = body.model_dump(exclude_unset=True)
    accepted = data.pop("accept_risks", False)
    old = autopilot.config(settings)
    try:
        new = autopilot.validate(data, old)
    except ValueError as exc:
        _err(exc, 422)
    if new["enabled"] or new["full_rights"]:
        if not new["delegate_id"]:
            raise HTTPException(status_code=422, detail="Choose the AI that decides.")
        try:
            member, profile = await _ai(session, new["delegate_id"])
        except HTTPException:
            member = profile = None
        if member is None or member.project_id != project_id or member.kind != "ai":
            raise HTTPException(
                status_code=422,
                detail="The delegate must be an AI member of this project.",
            )
        if profile.connection == "inbox" or profile.paused:
            raise HTTPException(
                status_code=422,
                detail=f"{member.name} cannot run right now; choose another AI.",
            )
    riskier = (
        (new["enabled"] and not old["enabled"])
        or (new["full_rights"] and not old["full_rights"])
        or (new["max_risk"] == "high" and old["max_risk"] != "high")
    )
    if riskier and not accepted:
        raise HTTPException(
            status_code=422,
            detail="Confirm that you understand what the delegate AI may decide for you.",
        )
    if new["enabled"] and not old["enabled"]:
        new = autopilot.stamp(new, _by())
    settings.autopilot = autopilot.dumps(new)
    session.add(settings)
    await session.commit()
    await session.refresh(settings)
    await svc_audit.record(
        project_id,
        "autopilot_changed",
        "info",
        member_name=_by(),
        on_behalf_of=_by(),
        detail={
            "changes": {
                k: [old.get(k), new.get(k)] for k in new if old.get(k) != new.get(k)
            }
        },
    )
    await board_events.publish("invalidate")
    return await autopilot.public(session, settings)


class PauseAllBody(BaseModel):
    """Emergency stop (D2)."""

    reason: str = ""
    cancel_running: bool = True
    revoke_tokens: bool = False


@router.post("/projects/{project_id}/ai/pause-all")
async def post_pause_all(project_id: str, body: PauseAllBody, session: Session) -> dict:
    """Pause all AI in the project; optionally revoke every AI member's MCP token."""
    await _project(session, project_id)
    if await safety.role_name(session, project_id, _by()) == "viewer":
        raise HTTPException(status_code=403, detail="Viewers can't pause AI.")
    return await svc_runs.pause_all(
        project_id,
        by=_by(),
        reason=body.reason,
        cancel_running=body.cancel_running,
        revoke=body.revoke_tokens,
    )


class ResumeAllBody(BaseModel):
    """Resume checklist (D3)."""

    safe_mode: bool = True
    member_ids: Optional[list[str]] = None
    reviewed: bool = False


@router.post("/projects/{project_id}/ai/resume-all")
async def post_resume_all(
    project_id: str, body: ResumeAllBody, session: Session
) -> dict:
    """Resume AI after Pause all AI; never one click: the person confirms they reviewed what happened."""
    await _project(session, project_id)
    if (
        safety.ROLE_RANK[await safety.role_name(session, project_id, _by())]
        < safety.ROLE_RANK["admin"]
    ):
        raise HTTPException(
            status_code=403, detail="Only owners and admins can resume AI."
        )
    if not body.reviewed:
        raise HTTPException(
            status_code=422,
            detail="Confirm that you looked at what the AI did before the stop.",
        )
    try:
        return await svc_runs.resume_all(
            project_id, by=_by(), safe_mode=body.safe_mode, member_ids=body.member_ids
        )
    except svc_runs.AlreadyResumed as exc:
        raise HTTPException(
            status_code=409,
            detail={"code": "already_resumed", "message": str(exc), **exc.info},
        ) from exc


@router.get("/projects/{project_id}/ai/usage")
async def get_project_usage(
    project_id: str,
    session: Session,
    range: Literal["today", "7d", "month", "custom"] = "month",
    since: Optional[str] = None,
    until: Optional[str] = None,
) -> dict:
    """Usage dashboard: tiles, spend by day stacked by agent with the forecast, agents, most expensive runs,
    spend by ticket, the price table and the limits table."""
    await _project(session, project_id)
    data = await svc_usage.dashboard(session, project_id, range, since, until)
    data["limits"] = await svc_usage.limits(session, project_id)
    return data


@router.get("/projects/{project_id}/ai/usage/export")
async def get_usage_export(
    project_id: str,
    session: Session,
    range: Literal["today", "7d", "month", "custom"] = "month",
    since: Optional[str] = None,
    until: Optional[str] = None,
) -> Response:
    """The dashboard of a range as CSV."""
    await _project(session, project_id)
    data = await svc_usage.dashboard(session, project_id, range, since, until)
    return Response(
        svc_usage.to_csv(data),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=ai-usage.csv"},
    )


# ---------------------------------------------------------------------------
# Runs on tickets
# ---------------------------------------------------------------------------


@router.get("/projects/{project_id}/ai/runs")
async def get_project_runs(
    project_id: str,
    session: Session,
    member_id: Optional[str] = None,
    active: bool = False,
    limit: int = 100,
) -> list[dict]:
    """Runs of the project, newest first."""
    rows = await svc_runs.list_runs(
        session,
        project_id=project_id,
        member_id=member_id,
        active_only=active,
        limit=max(1, min(limit, 500)),
    )
    return await svc_runs.runs_to_dicts(session, rows)


@router.get("/tickets/{ticket_id}/ai/runs")
async def get_ticket_runs(ticket_id: str, session: Session) -> list[dict]:
    """Run history of a ticket, newest first."""
    rows = await svc_runs.list_runs(session, ticket_id=ticket_id, limit=200)
    rows.sort(key=lambda r: r.number, reverse=True)
    return await svc_runs.runs_to_dicts(session, rows)


@router.get("/ai/runs/{run_id}")
async def get_run(run_id: str, session: Session) -> dict:
    """One run with its steps, files and usage."""
    run = await session.get(AiRun, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Run not found")
    return (await svc_runs.runs_to_dicts(session, [run]))[0]


class AssignBody(BaseModel):
    """Assign a ticket to an AI member and say how to start (A2)."""

    member_id: str
    start: Literal["now", "queue", "none"] = "now"
    include_context: bool = True
    instruction: str = ""


async def _ticket(session, ticket_id: str) -> Ticket:
    ticket = await session.get(Ticket, ticket_id)
    if ticket is None:
        raise HTTPException(status_code=404, detail="Ticket not found")
    return ticket


@router.post("/tickets/{ticket_id}/ai/assign")
async def post_assign(ticket_id: str, body: AssignBody, session: Session) -> dict:
    """Assign, then start now, queue, or only assign."""
    ticket = await _ticket(session, ticket_id)
    member, profile = await _ai(session, body.member_id)
    if member.project_id != ticket.project_id or member.kind != "ai":
        raise HTTPException(
            status_code=422, detail="Pick an AI member of this project."
        )
    run = None
    wait = False
    if body.start != "none" and profile.connection != "inbox":
        held = [
            r
            for r in await svc_runs.active_runs(session, ticket_id=ticket_id)
            if r.mode == "work" and not r.behind_run_id
        ]
        if held:
            # Queue behind the holder (design H1, "Next"); the assignee changes when it takes the hold
            if body.start == "queue" and held[0].member_id != body.member_id:
                wait = True
            else:
                raise HTTPException(
                    status_code=409,
                    detail=f"{ticket_id} is held by another AI run (#{held[0].number}). "
                    "Queue it to start when the hold is released.",
                )
    if not wait and ticket.assignee != body.member_id:
        try:
            await svc_tickets.update_ticket(
                session, ticket_id, TicketUpdate(assignee=body.member_id)
            )
        except ValueError as exc:
            _err(exc)
    if body.start != "none" and profile.connection != "inbox":
        try:
            run = await svc_runs.create_run(
                session,
                ticket_id=ticket_id,
                member_id=body.member_id,
                mode="work",
                trigger="assign",
                started_by=_by(),
                instruction=body.instruction,
                include_context=body.include_context,
                wait_for_hold=wait,
                queue_after_current=body.start == "queue",
            )
        except svc_runs.RunConflict as exc:
            _err(exc, 409)
        except svc_runs.RunError as exc:
            _err(exc, 422)
    await board_events.publish("invalidate")
    ticket = await _ticket(session, ticket_id)
    return {
        "ticket": TicketRead.from_ticket(ticket).model_dump(),
        "run": (await svc_runs.runs_to_dicts(session, [run]))[0] if run else None,
    }


class RunBody(BaseModel):
    """The Run button: start a run for the ticket's AI assignee (or a named AI member)."""

    member_id: Optional[str] = None
    instruction: str = ""
    include_context: bool = True


@router.post("/tickets/{ticket_id}/ai/run")
async def post_run(ticket_id: str, body: RunBody, session: Session) -> dict:
    """Start a work run."""
    ticket = await _ticket(session, ticket_id)
    member_id = body.member_id or ticket.assignee
    if not member_id:
        raise HTTPException(
            status_code=422, detail="Assign the ticket to an AI member first."
        )
    member, _ = await _ai(session, member_id)
    try:
        run = await svc_runs.create_run(
            session,
            ticket_id=ticket_id,
            member_id=member_id,
            mode="work",
            trigger="run_button",
            started_by=_by(),
            instruction=body.instruction,
            include_context=body.include_context,
        )
    except svc_runs.RunConflict as exc:
        _err(exc, 409)
    except svc_runs.RunError as exc:
        _err(exc, 422)
    return (await svc_runs.runs_to_dicts(session, [run]))[0]


class AskBody(BaseModel):
    """Ask an AI a question about a ticket (composer Ask shortcut, test-case note)."""

    member_id: str
    question: str
    source: Literal["comment", "test_case"] = "comment"
    ref: Optional[str] = None  # e.g. the test case code


@router.post("/tickets/{ticket_id}/ai/ask")
async def post_ask(ticket_id: str, body: AskBody, session: Session) -> dict:
    """Post the question as a comment and start a short ask run that answers below it."""
    ticket = await _ticket(session, ticket_id)
    member, _ = await _ai(session, body.member_id)
    question = (body.question or "").strip()
    if not question:
        raise HTTPException(status_code=422, detail="Write a question first.")
    prefix = f"(On {body.ref}) " if body.source == "test_case" and body.ref else ""
    text = f"@[{member.name}](member:{member.id}) {prefix}{question}"
    ticket = await svc_tickets.add_comment(
        session, ticket_id, text, author=_by(), meta={"asked_ai": member.id}
    )
    comment_id = loads(ticket.comments, [])[-1]["id"]
    try:
        run = await svc_runs.create_run(
            session,
            ticket_id=ticket_id,
            member_id=body.member_id,
            mode="ask",
            trigger="ask",
            started_by=_by(),
            instruction=f"{prefix}{question}",
            source_comment_id=comment_id,
        )
    except svc_runs.RunError as exc:
        _err(exc, 422)
    await board_events.publish("invalidate")
    return (await svc_runs.runs_to_dicts(session, [run]))[0]


class ReasonBody(BaseModel):
    """Optional reason."""

    reason: Optional[str] = None


@router.post("/ai/runs/{run_id}/cancel")
async def post_cancel(run_id: str, body: ReasonBody, session: Session) -> dict:
    """Cancel from any active state; the status the run set returns."""
    try:
        run = await svc_runs.cancel(run_id, by=_by(), reason=body.reason)
    except svc_runs.RunError as exc:
        _err(exc, 409)
    async with database.async_session() as fresh_session:
        fresh = await fresh_session.get(AiRun, run.id)
        return (await svc_runs.runs_to_dicts(fresh_session, [fresh]))[0]


class RetryBody(BaseModel):
    """Retry; `limit_min` raises the run's time limit (a run that timed out)."""

    limit_min: Optional[int] = None


@router.post("/ai/runs/{run_id}/retry")
async def post_retry(
    run_id: str, session: Session, body: Optional[RetryBody] = None
) -> dict:
    """Retry or Run again: a new run #n+1 (optionally with a raised time limit)."""
    try:
        run = await svc_runs.retry(
            run_id, by=_by(), limit_min=body.limit_min if body else None
        )
    except svc_runs.RunConflict as exc:
        _err(exc, 409)
    except svc_runs.RunError as exc:
        _err(exc, 422)
    return (await svc_runs.runs_to_dicts(session, [run]))[0]


async def _run_dict(run_id: str) -> dict:
    async with database.async_session() as fresh:
        run = await fresh.get(AiRun, run_id)
        return (await svc_runs.runs_to_dicts(fresh, [run]))[0]


@router.post("/ai/runs/{run_id}/start-now")
async def post_start_now(run_id: str) -> dict:
    """Start a queued run now (when nothing blocks it)."""
    try:
        run = await svc_runs.start_now(run_id, by=_by())
    except svc_runs.RunError as exc:
        _err(exc, 409)
    return await _run_dict(run.id)


@router.post("/ai/runs/{run_id}/pause")
async def post_pause_run(run_id: str) -> dict:
    """Pause a running run after its current step."""
    try:
        run = await svc_runs.pause_run(run_id, by=_by())
    except svc_runs.RunError as exc:
        _err(exc, 409)
    return await _run_dict(run.id)


@router.post("/ai/runs/{run_id}/resume")
async def post_resume_run(run_id: str) -> dict:
    """Continue a paused run."""
    try:
        run = await svc_runs.resume_run(run_id, by=_by())
    except svc_runs.RunError as exc:
        _err(exc, 409)
    return await _run_dict(run.id)


class AskElsewhereBody(BaseModel):
    """Pass the AI's question to another person."""

    member_id: str


@router.post("/ai/runs/{run_id}/ask-someone-else")
async def post_ask_someone_else(run_id: str, body: AskElsewhereBody) -> dict:
    """“Ask someone else”: the question and the Pending flag go to another person."""
    try:
        run = await svc_runs.reassign_question(
            run_id, by=_by(), to_member_id=body.member_id
        )
    except svc_runs.RunError as exc:
        _err(exc, 409)
    return await _run_dict(run.id)


class RegenerateBody(BaseModel):
    """Ask again; with `question` the edited question is asked (Edit and re-run)."""

    question: Optional[str] = None
    replace: bool = False


@router.post("/ai/runs/{run_id}/regenerate")
async def post_regenerate(run_id: str, body: RegenerateBody) -> dict:
    """Regenerate an answer, or edit the question and re-run."""
    try:
        run = await svc_runs.regenerate(
            run_id, by=_by(), question=body.question, replace=body.replace
        )
    except svc_runs.RunConflict as exc:
        _err(exc, 409)
    except svc_runs.RunError as exc:
        _err(exc, 422)
    await board_events.publish("invalidate")
    return await _run_dict(run.id)


class FeedbackBody(BaseModel):
    """Thumbs up or down on an answer."""

    rating: Literal["up", "down", "none"]
    reasons: list[str] = []


@router.post("/ai/runs/{run_id}/feedback")
async def post_feedback(run_id: str, body: FeedbackBody) -> dict:
    """Rate an answer; a thumbs down carries its reasons."""
    try:
        run = await svc_runs.set_feedback(
            run_id, by=_by(), rating=body.rating, reasons=body.reasons
        )
    except svc_runs.RunError as exc:
        _err(exc, 422)
    return await _run_dict(run.id)


@router.post("/ai/runs/{run_id}/refresh-context")
async def post_refresh_context(run_id: str) -> dict:
    """The run gets the ticket as it is now at its next step."""
    try:
        run = await svc_runs.refresh_context(run_id, by=_by())
    except svc_runs.RunError as exc:
        _err(exc, 409)
    return await _run_dict(run.id)


class AnswerBody(BaseModel):
    """Answer to the AI's question."""

    text: str


@router.post("/ai/runs/{run_id}/answer")
async def post_answer(run_id: str, body: AnswerBody, session: Session) -> dict:
    """Answer and resume (E3)."""
    try:
        run = await svc_runs.answer(run_id, by=_by(), text=body.text)
    except svc_runs.RunError as exc:
        _err(exc, 409)
    return (await svc_runs.runs_to_dicts(session, [run]))[0]


class RequestChangesBody(BaseModel):
    """Review gate: send back to the AI (F2)."""

    text: str
    continue_session: bool = True


@router.post("/tickets/{ticket_id}/ai/request-changes")
async def post_request_changes(
    ticket_id: str, body: RequestChangesBody, session: Session
) -> dict:
    """Reopen the AI's work with the reviewer's comment as the reason."""
    await _ticket(session, ticket_id)
    try:
        run = await svc_runs.request_changes(
            ticket_id, by=_by(), text=body.text, continue_session=body.continue_session
        )
    except svc_runs.RunConflict as exc:
        _err(exc, 409)
    except svc_runs.RunError as exc:
        _err(exc, 422)
    return (await svc_runs.runs_to_dicts(session, [run]))[0]


class TakeOverBody(BaseModel):
    """A person takes the ticket from the AI."""

    member_id: Optional[str] = None


@router.post("/tickets/{ticket_id}/ai/take-over")
async def post_take_over(ticket_id: str, body: TakeOverBody, session: Session) -> dict:
    """Cancel the AI's run (if any) and assign the ticket to a person."""
    await _ticket(session, ticket_id)
    for r in await svc_runs.active_runs(session, ticket_id=ticket_id):
        try:
            await svc_runs.cancel(
                r.id,
                by=_by(),
                reason=f"{_by()} took over the ticket",
                revert_status=False,
                stop_code="takeover",
            )
        except svc_runs.RunError:
            pass
    if body.member_id:
        try:
            await svc_tickets.update_ticket(
                session, ticket_id, TicketUpdate(assignee=body.member_id)
            )
        except ValueError as exc:
            _err(exc)
    await board_events.publish("invalidate")
    ticket = await _ticket(session, ticket_id)
    await session.refresh(ticket)
    return TicketRead.from_ticket(ticket).model_dump()


@router.get("/ai/runs/{run_id}/revert-preview")
async def get_revert_preview(run_id: str, session: Session) -> list[dict]:
    """Undo run's changes: what would revert, who changed a field after the AI (the conflicts), and the rows that
    stay as they are (the files on the branch, the branch)."""
    rows = await svc_approvals.revert_preview(session, run_id)
    run = await session.get(AiRun, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Run not found")
    ticket = await session.get(Ticket, run.ticket_id)
    log = loads(ticket.activity_log, []) if ticket else []
    out = []
    for r in rows:
        r = {**r, "kind": "field"}
        if r["conflict"]:
            later = [
                e
                for e in log
                if e.get("field") == r["field"]
                and not e.get("ai")
                and (e.get("at") or "") >= (run.started_at or run.queued_at)
            ]
            if later:
                r["edited_by"] = later[-1].get("actor")
                r["edited_at"] = later[-1].get("at")
        out.append(r)
    files = loads(run.files, [])
    if files:
        out.append(
            {
                "kind": "files",
                "field": "Files",
                "count": len(files),
                "paths": [f["path"] for f in files][:20],
                "note": "Stay on the branch: git is never touched.",
                "conflict": False,
            }
        )
    branches = (
        [
            b.get("name")
            for b in loads(ticket.branches, [])
            if str(b.get("name", "")).startswith("ai/")
        ]
        if ticket
        else []
    )
    for name in branches[:1]:
        out.append(
            {
                "kind": "branch",
                "field": "Branch",
                "name": name,
                "note": "The branch is kept.",
                "conflict": False,
            }
        )
    return out


@router.post("/ai/runs/{run_id}/revert")
async def post_revert_run(run_id: str, session: Session) -> list[dict]:
    """Undo a run's field and status changes (conflicts are skipped)."""
    return await svc_approvals.revert_run(session, run_id, by=_by())


# ---------------------------------------------------------------------------
# Approvals
# ---------------------------------------------------------------------------


@router.get("/projects/{project_id}/ai/approvals")
async def get_approvals(
    project_id: str,
    session: Session,
    status: Optional[str] = None,
    ticket_id: Optional[str] = None,
    member_id: Optional[str] = None,
    risk: Optional[str] = None,
) -> list[dict]:
    """Inbox › Approvals: pending first (soonest to expire), then decided. Each carries the diff, the AI's reason,
    what triggered the run, whether the ticket changed since, and whether the caller may decide it."""
    return await svc_approvals.list_approvals(
        session,
        project_id,
        status=status,
        ticket_id=ticket_id,
        member_id=member_id,
        risk=risk,
        actor=_by(),
    )


class DecideBody(BaseModel):
    """A person's decision."""

    note: Optional[str] = None
    stop_run: bool = False
    remember: bool = False
    always: bool = False
    accept_updated: bool = False


def _decide_error(exc: Exception):
    if isinstance(exc, svc_approvals.ApprovalForbidden):
        _err(exc, 403)
    _err(exc, 409)


@router.post("/ai/approvals/{approval_id}/approve")
async def post_approve(approval_id: str, body: DecideBody) -> dict:
    """Approve once: the board applies the action as the AI, on behalf of the person. With `remember` the same
    action on the same ticket is approved until the ticket is Done."""
    try:
        return await svc_approvals.decide(
            approval_id,
            by=_by(),
            approve=True,
            note=body.note,
            remember=body.remember,
            always=body.always,
            accept_updated=body.accept_updated,
        )
    except svc_approvals.ApprovalError as exc:
        _decide_error(exc)


@router.post("/ai/approvals/{approval_id}/deny")
async def post_deny(approval_id: str, body: DecideBody) -> dict:
    """Deny with a reason (sent as a comment, saved in the audit log); optionally stop the run."""
    try:
        return await svc_approvals.decide(
            approval_id, by=_by(), approve=False, note=body.note, stop_run=body.stop_run
        )
    except svc_approvals.ApprovalError as exc:
        _decide_error(exc)


class BulkDecideBody(BaseModel):
    """Approve or deny several at once (Low and Medium risk only)."""

    ids: list[str]
    approve: bool
    note: Optional[str] = None


@router.post("/ai/approvals/bulk")
async def post_bulk_decide(body: BulkDecideBody) -> list[dict]:
    """Bulk approve once / deny: High risk requests are skipped and decided one by one."""
    return await svc_approvals.bulk_decide(
        body.ids, by=_by(), approve=body.approve, note=body.note
    )


# ---------------------------------------------------------------------------
# Audit
# ---------------------------------------------------------------------------


def _audit_filters(
    member_id: Optional[str],
    run_id: Optional[str],
    q: Optional[str],
    actions: Optional[str],
    since: Optional[str],
    until: Optional[str],
) -> dict:
    return {
        "member_id": member_id or None,
        "run_id": run_id or None,
        "q": q or None,
        "actions": [a for a in (actions or "").split(",") if a] or None,
        "since": safety.parse_since(since),
        "until": safety.end_of_day(until),
    }


async def _audit_scope(session, project_id: str) -> str | None:
    """Viewers do not see the audit log; members see only the runs they started (H1)."""
    person = _by()
    role = await safety.role_name(session, project_id, person)
    if role == "viewer":
        _err(PermissionError("Viewers cannot open the AI audit log."), 403)
    return person if role == "member" else None


@router.get("/projects/{project_id}/ai/audit")
async def get_audit(
    project_id: str,
    session: Session,
    member_id: Optional[str] = None,
    result: Optional[str] = None,
    run_id: Optional[str] = None,
    q: Optional[str] = None,
    actions: Optional[str] = None,
    since: Optional[str] = None,
    until: Optional[str] = None,
    limit: int = 50,
    before_seq: Optional[int] = None,
) -> dict:
    """AI audit log (append-only, redacted), newest first: filters by agent, action, date, ticket and result;
    counts per result; `has_more` and `next_before` for “Load older”."""
    f = _audit_filters(member_id, run_id, q, actions, since, until)
    f["on_behalf_of"] = await _audit_scope(session, project_id)
    limit = max(1, min(limit, 200))
    rows = await svc_audit.list_entries(
        session,
        project_id,
        result=result or None,
        limit=limit + 1,
        before_seq=before_seq,
        **f,
    )
    more = len(rows) > limit
    rows = rows[:limit]
    counts = await svc_audit.count_results(session, project_id, **f)
    return {
        "entries": await svc_audit.enrich(session, rows),
        "counts": counts,
        "total": sum(counts.values()),
        "has_more": more,
        "next_before": rows[-1].seq if rows else None,
        "retention_days": (
            await get_settings(session, project_id)
        ).audit_retention_days,
    }


@router.get("/projects/{project_id}/ai/audit/verify")
async def get_audit_verify(project_id: str, session: Session) -> dict:
    """Recompute the hash chain (tamper evidence)."""
    return await svc_audit.verify_chain(session)


@router.get("/projects/{project_id}/ai/audit/export")
async def get_audit_export(
    project_id: str,
    session: Session,
    format: Literal["csv", "json"] = Query("csv"),
    member_id: Optional[str] = None,
    result: Optional[str] = None,
    run_id: Optional[str] = None,
    q: Optional[str] = None,
    actions: Optional[str] = None,
    since: Optional[str] = None,
    until: Optional[str] = None,
) -> Response:
    """Export the audit log with the filters on screen; secrets were redacted before the entries were written."""
    f = _audit_filters(member_id, run_id, q, actions, since, until)
    f["on_behalf_of"] = await _audit_scope(session, project_id)
    rows = [
        svc_audit.to_dict(e)
        for e in await svc_audit.list_entries(
            session, project_id, result=result or None, limit=500, **f
        )
    ]
    if format == "json":
        return Response(
            json.dumps(rows, indent=2),
            media_type="application/json",
            headers={"Content-Disposition": "attachment; filename=ai-audit.json"},
        )
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(
        ["time", "ai", "on_behalf_of", "action", "target", "result", "run", "detail"]
    )
    for r in rows:
        writer.writerow(
            [
                r["created_at"],
                r["member_name"],
                r["on_behalf_of"],
                r["action"],
                r["target"],
                r["result"],
                r["run_id"],
                json.dumps(r["detail"]),
            ]
        )
    return Response(
        buf.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=ai-audit.csv"},
    )


class RevertBody(BaseModel):
    """Audit entries to revert."""

    entry_ids: list[str]


@router.post("/ai/audit/revert")
async def post_audit_revert(body: RevertBody, session: Session) -> list[dict]:
    """Revert selected AI changes; conflicts are skipped, not forced."""
    return await svc_approvals.revert_entries(session, body.entry_ids, by=_by())


# Mentions are delivered by POST /tickets/{id}/comments (ai_intent); kept here for the test-case note path
deliver_mentions = svc_mentions.deliver
