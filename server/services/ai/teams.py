"""AI teams (AI v2): a team is a Member row of kind "ai" (the assignee, the avatar, the comment author) with an
`AiTeam` profile (account, model, pack of roles, config). Its lead runs a ticket as one Claude Code session; the
roles of its pack work as subagents (services/ai/roles.py)."""

import json
import re
import uuid
from datetime import UTC, datetime

from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

import database
from models import AiAccount, AiRun, AiTeam, Member, Project, Ticket

from . import accounts, audit, cli, roles
from .providers import PROVIDERS, merged_config
from .store import active_runs, get_profile, get_settings, loads, now_iso, parse_iso

AI_COLORS = [
    "#2E6F40",
    "#6D5DD3",
    "#2F6FB0",
    "#B4791E",
    "#B0446E",
    "#5B6B60",
    "#C4432A",
]
MAX_PERSONA = 4000
MODELS = ("haiku", "sonnet", "opus")
EFFORTS = ("low", "medium", "high", "xhigh", "max")
PERMISSION_MODES = ("bypass", "auto")
HEALTH_INTERVAL_S = 60  # how often the scheduler re-detects runners
HEALTH_STALE_S = 300  # how often a healthy runner's sign-in is checked again
ACCOUNT_STALE_S = 240


class TeamError(ValueError):
    """A request about a team was refused; the message is shown as is."""


def _clean_name(name: str) -> str:
    name = " ".join((name or "").split())
    if not name:
        raise TeamError("Name must not be empty.")
    if len(name) > 80:
        raise TeamError("Name must be at most 80 characters.")
    return name


def _clean_color(color: str) -> str:
    color = (color or "").strip()
    if not re.fullmatch(r"#[0-9a-fA-F]{6}", color):
        raise TeamError("Pick one of the avatar colours.")
    return color.upper()


async def check_name(
    session: AsyncSession, project_id: str, name: str, exclude_id: str | None = None
) -> dict:
    """Names are unique across people and teams in a project (case and surrounding spaces ignored)."""
    clean = " ".join((name or "").split())
    project = await session.get(Project, project_id)
    rows = (
        await session.exec(select(Member).where(Member.project_id == project_id))
    ).all()
    low = clean.lower()
    for m in rows:
        if m.id == exclude_id or m.kind == "ai_removed":
            continue
        if m.name.strip().lower() == low:
            if m.kind == "ai":
                existing = {r.name.strip().lower() for r in rows}
                n = 2
                while f"{low} {n}" in existing:
                    n += 1
                return {
                    "ok": False,
                    "conflict": "ai",
                    "message": f"Another AI team already uses this name. Try “{clean} {n}”.",
                    "suggestion": f"{clean} {n}",
                }
            return {
                "ok": False,
                "conflict": "person",
                "message": f"“{m.name}” is already a member of {project.name if project else 'this project'}.",
                "suggestion": None,
            }
    return {"ok": True, "conflict": None, "message": None, "suggestion": None}


def _validate(data: dict) -> None:
    if (
        data.get("model")
        and data["model"] not in MODELS
        and "-" not in str(data["model"])
    ):
        raise TeamError("The model is haiku, sonnet, opus or a full model id.")
    if data.get("effort") and data["effort"] not in EFFORTS:
        raise TeamError("The effort is low, medium, high, xhigh or max.")
    if data.get("permission_mode") and data["permission_mode"] not in PERMISSION_MODES:
        raise TeamError("The permission mode is bypass or auto.")
    if data.get("persona") and len(data["persona"]) > MAX_PERSONA:
        raise TeamError(f"The persona is at most {MAX_PERSONA} characters.")
    for key in ("max_parallel", "max_runs_per_day", "tokens_per_day"):
        if data.get(key) is not None and int(data[key]) < 1:
            raise TeamError(f"{key.replace('_', ' ').capitalize()} must be at least 1.")
    for key in ("daily_budget", "monthly_cap", "cap_per_run"):
        if data.get(key) is not None and float(data[key]) < 0:
            raise TeamError(f"{key.replace('_', ' ').capitalize()} cannot be negative.")
    if data.get("scope") and data["scope"] not in ("assigned", "project"):
        raise TeamError("The scope is assigned or project.")
    if (
        data.get("pack_key")
        and data["pack_key"] not in roles.TEAM_PACKS
        and not re.fullmatch(r"[a-z0-9_-]{1,40}", data["pack_key"])
    ):
        raise TeamError("Unknown pack.")
    cfg = data.get("config")
    if cfg is not None and not isinstance(cfg, dict):
        raise TeamError("config must be an object.")


async def _checked_account(session: AsyncSession, account_id: str | None) -> str | None:
    if not account_id:
        return None
    account = await session.get(AiAccount, account_id)
    if account is None:
        raise TeamError("That AI account does not exist.")
    if account.cli != "claude":
        raise TeamError(f"{account.name} is not a Claude Code account.")
    return account.id


async def create(
    session: AsyncSession, project_id: str, data: dict, *, by: str
) -> Member:
    """Make a team: its Member row and its profile.

    Raises:
        TeamError: Invalid data or a duplicate name.
    """
    name = _clean_name(data.get("name") or "")
    verdict = await check_name(session, project_id, name)
    if not verdict["ok"]:
        raise TeamError(verdict["message"])
    _validate(data)
    account_id = await _checked_account(session, data.get("account_id"))
    color = _clean_color(data["color"]) if data.get("color") else AI_COLORS[0]
    member = Member(
        id=str(uuid.uuid4()),
        project_id=project_id,
        name=name,
        color=color,
        role="member",
        kind="ai",
    )
    session.add(member)
    await session.flush()
    spec = PROVIDERS["claude-code"]
    profile = AiTeam(
        id=member.id,
        project_id=project_id,
        description=(data.get("description") or "").strip()[:200],
        cli_path=(data.get("cli_path") or None),
        working_dir=(data.get("working_dir") or "").strip() or None,
        account_id=account_id,
        model=data.get("model") or spec["default_model"],
        effort=data.get("effort") or None,
        persona=(data.get("persona") or "").strip(),
        pack_key=data.get("pack_key") or roles.DEFAULT_TEAM_PACK,
        config=json.dumps(merged_config(data.get("config") or {})),
        permission_mode=data.get("permission_mode") or "bypass",
        max_parallel=data.get("max_parallel") or 2,
        daily_budget=data.get("daily_budget"),
        monthly_cap=data.get("monthly_cap"),
        max_runs_per_day=data.get("max_runs_per_day"),
        tokens_per_day=data.get("tokens_per_day"),
        cap_per_run=data.get("cap_per_run"),
        scope=data.get("scope") or "assigned",
        created_by=by,
    )
    session.add(profile)
    await session.commit()
    await session.refresh(member)
    await audit.record(
        project_id,
        "team_created",
        "info",
        member_id=member.id,
        member_name=name,
        on_behalf_of=by,
        detail={"pack": profile.pack_key, "model": profile.model},
    )
    return member


_EDITABLE = (
    "description",
    "cli_path",
    "working_dir",
    "model",
    "effort",
    "persona",
    "pack_key",
    "permission_mode",
    "max_parallel",
    "daily_budget",
    "monthly_cap",
    "max_runs_per_day",
    "tokens_per_day",
    "cap_per_run",
    "scope",
)


async def update(
    session: AsyncSession, member_id: str, data: dict, *, by: str
) -> AiTeam:
    """Edit a team; only the keys sent change."""
    member, profile = await get_profile(session, member_id)
    if member is None or profile is None or member.kind != "ai":
        raise TeamError("AI team not found.")
    _validate(data)
    if "name" in data:
        name = _clean_name(data["name"])
        verdict = await check_name(
            session, member.project_id, name, exclude_id=member_id
        )
        if not verdict["ok"]:
            raise TeamError(verdict["message"])
        member.name = name
        session.add(member)
    if data.get("color"):
        member.color = _clean_color(data["color"])
        session.add(member)
    if "account_id" in data:
        profile.account_id = await _checked_account(session, data["account_id"])
    for key in _EDITABLE:
        if key in data:
            value = data[key]
            if (
                key in ("description", "persona", "working_dir", "cli_path")
                and value is not None
            ):
                value = str(value).strip() or (
                    None if key in ("working_dir", "cli_path") else ""
                )
            setattr(profile, key, value)
    if "config" in data and data["config"] is not None:
        current = merged_config(loads(profile.config, {}))
        profile.config = json.dumps(merged_config({**current, **data["config"]}))
    if any(k in data for k in ("cli_path", "working_dir", "account_id")):
        profile.health = "unknown"
        profile.health_detail = None
        profile.checked_at = None
    profile.updated_at = now_iso()
    session.add(profile)
    await session.commit()
    await session.refresh(profile)
    await audit.record(
        member.project_id,
        "team_updated",
        "info",
        member_id=member_id,
        member_name=member.name,
        on_behalf_of=by,
        detail={"fields": sorted(k for k in data if k != "config")},
    )
    return profile


async def set_paused(
    session: AsyncSession,
    member_id: str,
    paused: bool,
    *,
    by: str,
    cancel_current: bool = False,
    reason: str | None = None,
) -> AiTeam:
    """Pause (new work queues; the current run finishes or is cancelled) or resume."""
    member, profile = await get_profile(session, member_id)
    if member is None or profile is None:
        raise TeamError("AI team not found.")
    profile.paused = paused
    profile.paused_at = now_iso() if paused else None
    profile.paused_reason = (reason or f"Paused by {by}") if paused else None
    session.add(profile)
    await session.commit()
    await session.refresh(profile)
    await audit.record(
        member.project_id,
        "team_paused" if paused else "team_resumed",
        "info",
        member_id=member_id,
        member_name=member.name,
        on_behalf_of=by,
        detail={"cancel_current": cancel_current},
    )
    from . import runs

    if paused and cancel_current:
        for r in await active_runs(session, member_id=member_id):
            if r.state in ("starting", "running") and hasattr(runs, "cancel"):
                try:
                    await runs.cancel(
                        r.id, by=by, reason=f"{member.name} was paused by {by}"
                    )
                except runs.RunError:
                    pass
    else:
        runs.RT.wake.set()
    return profile


async def removal_impact(session: AsyncSession, member_id: str) -> dict:
    """Open tickets and runs in flight that removing the team affects."""
    tickets = (
        await session.exec(
            select(Ticket).where(
                Ticket.assignee == member_id,
                col(Ticket.status).not_in(["done", "wont_do"]),
            )
        )
    ).all()
    runs_ = await active_runs(session, member_id=member_id)
    return {
        "open_tickets": [
            {"id": t.id, "title": t.title, "status": t.status} for t in tickets
        ],
        "active_runs": [
            {"id": r.id, "ticket_id": r.ticket_id, "state": r.state} for r in runs_
        ],
    }


async def remove(
    session: AsyncSession,
    member_id: str,
    *,
    by: str,
    tickets: str = "unassign",
    reassign_to: str | None = None,
) -> dict:
    """Remove a team: its open tickets go to a person or to nobody, its runs are cancelled, the Member row stays
    as history (kind ai_removed)."""
    member, profile = await get_profile(session, member_id)
    if member is None or profile is None or member.kind != "ai":
        raise TeamError("AI team not found.")
    if tickets == "reassign":
        target = await session.get(Member, reassign_to) if reassign_to else None
        if (
            target is None
            or target.project_id != member.project_id
            or target.kind != "human"
        ):
            raise TeamError("Pick a person to reassign the tickets to.")
    import services.tickets as svc_tickets
    from models import TicketUpdate

    from . import runs as svc_runs

    impact = await removal_impact(session, member_id)
    for t in impact["open_tickets"]:
        await svc_tickets.update_ticket(
            session,
            t["id"],
            TicketUpdate(assignee=reassign_to if tickets == "reassign" else None),
        )
    for r in impact["active_runs"]:
        if hasattr(svc_runs, "cancel"):
            try:
                await svc_runs.cancel(
                    r["id"], by=by, reason=f"{member.name} was removed by {by}"
                )
            except svc_runs.RunError:
                pass
    member = await session.get(Member, member_id)
    profile = await session.get(AiTeam, member_id)
    member.kind = "ai_removed"
    session.add(member)
    if profile is not None:
        profile.paused = True
        session.add(profile)
    await session.commit()
    await audit.record(
        member.project_id,
        "team_removed",
        "info",
        member_id=member_id,
        member_name=member.name,
        on_behalf_of=by,
    )
    return {"removed": True}


# ---------------------------------------------------------------------------
# Runner detection and health
# ---------------------------------------------------------------------------


async def detect_local(
    session: AsyncSession | None, cli_path: str | None, account_id: str | None = None
) -> dict:
    """Is Claude Code installed and signed in on this computer (for the account, when the team runs as one)?"""
    account = (
        await session.get(AiAccount, account_id)
        if (session is not None and account_id)
        else None
    )
    base = cli.child_env() if hasattr(cli, "child_env") else None
    env = accounts.env_for(account, base or {}) if account is not None else None
    spec = PROVIDERS["claude-code"]
    info = await cli.detect("claude-code", spec["binary"], cli_path, env=env)
    if account is not None and info["found"]:
        info["logged_in"] = account.status == "signed_in"
        info["account"] = (
            " · ".join(x for x in (account.email, account.plan) if x) or account.name
        )
    info["install"] = spec.get("install")
    info["guide_url"] = spec.get("guide_url")
    return info


async def test_connection(session: AsyncSession, member_id: str) -> dict:
    """Check the team's runner and sign-in and record its health."""
    member, profile = await get_profile(session, member_id)
    if member is None or profile is None:
        raise TeamError("AI team not found.")
    info = await detect_local(session, profile.cli_path, profile.account_id)
    _apply_health(profile, info)
    profile.checked_at = now_iso()
    session.add(profile)
    await session.commit()
    ok = profile.health == "ok"
    if ok:
        version = info.get("version")
        message = "Claude Code " + (f"{version} " if version else "") + "is installed"
        message += (
            f" and signed in ({info['account']})." if info.get("account") else "."
        )
    else:
        message = profile.health_detail or "Claude Code cannot run for this team."
    return {
        **info,
        "ok": ok,
        "message": message,
        "health": profile.health,
        "health_detail": profile.health_detail,
    }


def _apply_health(profile: AiTeam, info: dict) -> None:
    binary = PROVIDERS["claude-code"]["binary"]
    if not info.get("found"):
        profile.health = "runner_missing"
        profile.health_detail = cli.missing(binary, profile.cli_path)
    elif info.get("logged_in") is False:
        profile.health = "not_logged_in"
        profile.health_detail = (
            "Claude Code is installed but not signed in. Sign the account in."
        )
    else:
        profile.health, profile.health_detail = "ok", None


async def health_check() -> int:
    """Re-detect what changes without anyone touching the board: a runner uninstalled or reinstalled, a sign-in that
    expired or came back. Returns how many teams changed state."""
    changed = 0
    now = datetime.now(UTC)
    async with database.async_session() as session:
        rows = (await session.exec(select(AiTeam))).all()
        await accounts.check_all(session, only_stale_s=ACCOUNT_STALE_S)
        for profile in rows:
            member = await session.get(Member, profile.id)
            if member is None or member.kind != "ai":
                continue
            before = profile.health
            checked = parse_iso(profile.checked_at)
            stale = checked is None or (now - checked).total_seconds() > HEALTH_STALE_S
            if profile.health == "ok" and not stale:
                continue
            await session.commit()  # no write lock while the CLI is asked
            info = await detect_local(session, profile.cli_path, profile.account_id)
            _apply_health(profile, info)
            profile.checked_at = now_iso()
            session.add(profile)
            if profile.health != before:
                changed += 1
                await audit.record(
                    profile.project_id,
                    "team_health",
                    "info",
                    member_id=profile.id,
                    member_name=member.name,
                    on_behalf_of="board",
                    detail={"from": before, "to": profile.health},
                )
        await session.commit()
    if changed:
        from .runs import RT

        RT.wake.set()
    return changed


# ---------------------------------------------------------------------------
# Describing
# ---------------------------------------------------------------------------


def status_of(member: Member, profile: AiTeam, runs: list[AiRun], settings) -> dict:
    """The one status a row shows, most blocking first."""
    running = [r for r in runs if r.state in ("starting", "running")]
    if member.kind == "ai_removed":
        return {"code": "removed", "label": "Removed", "detail": None}
    if profile.health == "not_logged_in":
        return {
            "code": "not_logged_in",
            "label": "Not signed in",
            "detail": profile.health_detail,
        }
    if profile.health == "runner_missing":
        return {
            "code": "runner_missing",
            "label": "Runner not detected",
            "detail": profile.health_detail,
        }
    if profile.health == "rate_limited":
        return {
            "code": "rate_limited",
            "label": "Rate-limited",
            "detail": profile.health_detail,
        }
    if settings.paused_all:
        return {
            "code": "paused_all",
            "label": "AI paused",
            "detail": settings.paused_reason,
        }
    if profile.paused:
        return {"code": "paused", "label": "Paused", "detail": profile.paused_reason}
    if running:
        return {
            "code": "running",
            "label": "Running",
            "detail": running[0].ticket_id,
            "ticket_id": running[0].ticket_id,
        }
    return {"code": "idle", "label": "Idle", "detail": None}


async def _account_ref(session: AsyncSession, profile: AiTeam) -> dict | None:
    if not profile.account_id:
        return None
    account = await session.get(AiAccount, profile.account_id)
    if account is None:
        return None
    return {
        "id": account.id,
        "name": account.name,
        "status": account.status,
        "email": account.email,
        "plan": account.plan,
        "method": account.method,
    }


async def _usage_today(session: AsyncSession, member_id: str) -> dict:
    day = datetime.now(UTC).date().isoformat()
    rows = (
        await session.exec(
            select(AiRun).where(
                AiRun.member_id == member_id, col(AiRun.started_at) >= day
            )
        )
    ).all()
    return {
        "runs_today": len(rows),
        "cost_today": round(sum(r.cost_usd or 0 for r in rows), 4),
        "tokens_today": sum((r.tokens_in or 0) + (r.tokens_out or 0) for r in rows),
    }


async def describe(
    session: AsyncSession, member: Member, profile: AiTeam, settings=None
) -> dict:
    """A team for the API."""
    settings = settings or await get_settings(session, member.project_id)
    runs = await active_runs(session, member_id=member.id)
    last = (
        await session.exec(
            select(AiRun)
            .where(AiRun.member_id == member.id, col(AiRun.ended_at).is_not(None))
            .order_by(col(AiRun.ended_at).desc())
            .limit(1)
        )
    ).first()
    assigned = (
        await session.exec(
            select(Ticket).where(
                Ticket.assignee == member.id,
                col(Ticket.status).not_in(["done", "wont_do"]),
            )
        )
    ).all()
    config = merged_config(loads(profile.config, {}))
    team_roles = await roles.roles_for(
        session, member.project_id, profile.pack_key, config
    )
    titles = {t.id: t for t in assigned}
    for r in runs:
        if (
            r.ticket_id
            and r.ticket_id not in titles
            and (t := await session.get(Ticket, r.ticket_id))
        ):
            titles[r.ticket_id] = t
    pack = roles.TEAM_PACKS.get(profile.pack_key or "")
    return {
        "id": member.id,
        "project_id": member.project_id,
        "name": member.name,
        "color": member.color,
        "kind": member.kind,
        "provider": "claude-code",
        "description": profile.description,
        "cli_path": profile.cli_path,
        "working_dir": profile.working_dir,
        "model": profile.model,
        "effort": profile.effort,
        "persona": profile.persona,
        "pack_key": profile.pack_key,
        "pack_name": pack["name"] if pack else profile.pack_key,
        "roles": roles.public(team_roles),
        "config": config,
        "permission_mode": profile.permission_mode,
        "max_parallel": profile.max_parallel,
        "daily_budget": profile.daily_budget,
        "monthly_cap": profile.monthly_cap,
        "max_runs_per_day": profile.max_runs_per_day,
        "tokens_per_day": profile.tokens_per_day,
        "cap_per_run": profile.cap_per_run,
        "scope": profile.scope,
        "paused": profile.paused,
        "paused_at": profile.paused_at,
        "paused_reason": profile.paused_reason,
        "health": profile.health,
        "health_detail": profile.health_detail,
        "checked_at": profile.checked_at,
        "mcp_last_used_at": profile.mcp_last_used_at,
        "account_id": profile.account_id,
        "account_ref": await _account_ref(session, profile),
        "status": status_of(member, profile, runs, settings),
        "running": [
            {
                "run_id": r.id,
                "ticket_id": r.ticket_id,
                "ticket_title": titles[r.ticket_id].title
                if r.ticket_id in titles
                else None,
                "ticket_status": titles[r.ticket_id].status
                if r.ticket_id in titles
                else None,
                "state": r.state,
                "number": r.number,
                "started_at": r.started_at,
            }
            for r in runs
        ],
        "slots_in_use": len([r for r in runs if r.state in ("starting", "running")]),
        "queued": len([r for r in runs if r.state == "queued"]),
        "assigned": [
            {"id": t.id, "title": t.title, "status": t.status} for t in assigned
        ],
        "usage": await _usage_today(session, member.id),
        "last_run": {
            "ticket_id": last.ticket_id,
            "state": last.state,
            "number": last.number,
            "ended_at": last.ended_at,
        }
        if last
        else None,
        "created_by": profile.created_by,
        "created_at": profile.created_at,
        "updated_at": profile.updated_at,
    }


async def list_teams(
    session: AsyncSession, project_id: str, include_removed: bool = False
) -> list[dict]:
    """The project's teams, described."""
    kinds = ["ai", "ai_removed"] if include_removed else ["ai"]
    members = (
        await session.exec(
            select(Member).where(
                Member.project_id == project_id, col(Member.kind).in_(kinds)
            )
        )
    ).all()
    settings = await get_settings(session, project_id)
    out = []
    for m in members:
        profile = await session.get(AiTeam, m.id)
        if profile is not None:
            out.append(await describe(session, m, profile, settings))
    out.sort(key=lambda d: d["created_at"])
    return out
