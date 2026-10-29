"""Auto-trip rules (design/screens/ai-safety-cost.md, D6): they protect against a runaway agent when nobody is
watching. Each rule has a switch and thresholds an owner or admin can edit; when one trips, the agent is paused (or put
in safe mode, or its run stopped), the trip is audited and people are told. Only a person resumes.

- failed runs: N failed runs in M minutes → pause the agent (checked when a run fails)
- spend spike: spend in the last M minutes above F × the agent's 7-day norm for that span → pause the agent
- repeated denials: N blocked or denied actions in M minutes → safe mode for the agent
- loop: the same action on the same target N times in M minutes → stop the run and hold the ticket
- many agents: N agents tripped in M minutes → pause all AI in the project (off by default)
"""

import json
import logging
from datetime import UTC, datetime, timedelta

from sqlmodel import col, func, select

import database
from models import AiAudit, AiMember, AiProjectSettings, AiRun, Member, Ticket

from . import audit
from .store import get_settings, loads, now_iso

log = logging.getLogger("kanban.ai.autotrip")

DEFAULTS: dict[str, dict] = {
    "failed_runs": {"on": True, "count": 5, "minutes": 10},
    "spend_spike": {"on": True, "factor": 3.0, "minutes": 15, "min_usd": 0.5},
    "denials": {"on": True, "count": 6, "minutes": 10},
    "loop": {"on": True, "count": 4, "minutes": 5},
    "many_agents": {"on": False, "count": 3, "minutes": 30},
}
LABELS = {
    "failed_runs": ("Failed runs", "Pause that agent"),
    "spend_spike": ("Spend spike", "Pause that agent"),
    "denials": ("Repeated denials", "Safe mode for agent"),
    "loop": ("Loop detected", "Stop run, hold ticket"),
    "many_agents": ("Many agents tripped", "Pause all AI"),
}
LIMITS = {
    "count": (2, 100),
    "minutes": (1, 24 * 60),
    "factor": (1.5, 50.0),
    "min_usd": (0.0, 100.0),
}


def rules(settings: AiProjectSettings) -> dict[str, dict]:
    """The project's rules with defaults filled in."""
    raw = loads(getattr(settings, "auto_trip", "{}"), {}) or {}
    return {k: {**d, **(raw.get(k) or {})} for k, d in DEFAULTS.items()}


def describe(settings: AiProjectSettings) -> list[dict]:
    """The rules table for the UI: switch, thresholds, "trips when" and "then" in words."""
    out = []
    for key, r in rules(settings).items():
        label, then = LABELS[key]
        when = {
            "failed_runs": lambda: f"{r['count']} failed runs in {r['minutes']} min",
            "spend_spike": lambda: (
                f"Spend {r['factor']:g}× its 7-day norm for {r['minutes']} min"
            ),
            "denials": lambda: f"{r['count']} blocked or denied in {r['minutes']} min",
            "loop": lambda: f"Same action {r['count']}× in {r['minutes']} min",
            "many_agents": lambda: f"{r['count']} agents in {r['minutes']} min",
        }[key]()
        out.append({"key": key, "label": label, "when": when, "then": then, **r})
    return out


def validate(patch: list[dict] | dict) -> dict:
    """Clean an edit from the UI (a list of {key, on, count, minutes, factor}) into the stored shape."""
    items = (
        patch
        if isinstance(patch, list)
        else [{"key": k, **v} for k, v in patch.items()]
    )
    out: dict[str, dict] = {}
    for item in items:
        key = item.get("key")
        if key not in DEFAULTS:
            raise ValueError(f"Unknown auto-trip rule: {key}")
        clean: dict = {}
        if "on" in item:
            clean["on"] = bool(item["on"])
        for field, (lo, hi) in LIMITS.items():
            if field in item and field in DEFAULTS[key] and item[field] is not None:
                value = float(item[field])
                if not lo <= value <= hi:
                    raise ValueError(
                        f"{LABELS[key][0]}: {field} must be between {lo:g} and {hi:g}."
                    )
                clean[field] = value if field in ("factor", "min_usd") else int(value)
        out[key] = clean
    return out


async def _since(minutes: float) -> str:
    return (datetime.now(UTC) - timedelta(minutes=minutes)).isoformat()


async def _trip(
    project_id: str,
    member_id: str,
    rule: str,
    reason: str,
    *,
    action: str = "pause",
    run_id: str | None = None,
) -> bool:
    """Apply a rule's action once; returns whether anything changed."""
    from . import runs, safety

    async with database.async_session() as session:
        member = await session.get(Member, member_id)
        profile = await session.get(AiMember, member_id)
        if profile is None:
            return False
        name = member.name if member else "An AI member"
        if action == "pause":
            if profile.paused:
                return False
            profile.paused = True
            profile.paused_at = now_iso()
            profile.paused_reason = f"Auto-paused: {reason}"
        elif action == "safe_mode":
            if profile.safe_mode:
                return False
            profile.safe_mode = True
        session.add(profile)
        await session.commit()
    if action == "stop" and run_id:
        try:
            await runs.cancel(
                run_id,
                by="auto-trip",
                reason=f"Loop detected: {reason}. The ticket is held for a person.",
            )
        except runs.RunError:
            return False
        await _hold_ticket(run_id, reason)
    await audit.record(
        project_id,
        "auto_trip",
        "info",
        member_id=member_id,
        member_name=name,
        run_id=run_id,
        detail={"rule": rule, "reason": reason, "then": LABELS[rule][1]},
    )
    await safety.notify(
        project_id,
        "auto_trip",
        f"{name}: {LABELS[rule][0].lower()}",
        f"{reason}. {LABELS[rule][1]}; only an owner or admin can undo it.",
        ref_kind="member",
        ref_id=member_id,
        member_id=member_id,
    )
    await _many_agents(project_id)
    return True


async def _hold_ticket(run_id: str, reason: str) -> None:
    from services import tickets as svc_tickets

    async with database.async_session() as session:
        run = await session.get(AiRun, run_id)
        ticket = await session.get(Ticket, run.ticket_id) if run else None
        if ticket is None or ticket.pending:
            return
        try:
            await svc_tickets.set_pending(
                session,
                ticket.id,
                "party",
                party="A person (auto-trip)",
                note=f"Held by auto-trip: {reason}",
                actor="auto-trip",
            )
        except Exception:  # noqa: BLE001 - holding is best effort; the run is already stopped
            log.exception("Could not hold %s", ticket.id)


async def _many_agents(project_id: str) -> None:
    from . import runs

    async with database.async_session() as session:
        settings = await get_settings(session, project_id)
        r = rules(settings)["many_agents"]
        if not r["on"] or settings.paused_all:
            return
        tripped = (
            await session.exec(
                select(func.count(func.distinct(AiAudit.member_id))).where(
                    AiAudit.project_id == project_id,
                    AiAudit.action == "auto_trip",
                    col(AiAudit.created_at) >= await _since(r["minutes"]),
                )
            )
        ).one()
    if int(tripped or 0) >= r["count"]:
        await runs.pause_all(
            project_id,
            by="auto-trip",
            reason=f"Auto-trip: {tripped} agents tripped in {r['minutes']} min",
            cancel_running=False,
        )


async def on_run_failed(member_id: str) -> None:
    """Failed runs: called when a run of the agent fails."""
    async with database.async_session() as session:
        profile = await session.get(AiMember, member_id)
        if profile is None:
            return
        r = rules(await get_settings(session, profile.project_id))["failed_runs"]
        if not r["on"]:
            return
        failed = (
            await session.exec(
                select(func.count()).where(
                    AiRun.member_id == member_id,
                    AiRun.state == "failed",
                    col(AiRun.ended_at) >= await _since(r["minutes"]),
                )
            )
        ).one()
        last = (
            await session.exec(
                select(AiRun)
                .where(AiRun.member_id == member_id, AiRun.state == "failed")
                .order_by(col(AiRun.ended_at).desc())
                .limit(1)
            )
        ).first()
    if int(failed or 0) >= r["count"]:
        why = f" ({last.ended_reason[:80]})" if last and last.ended_reason else ""
        await _trip(
            profile.project_id,
            member_id,
            "failed_runs",
            f"{failed} failed runs in {r['minutes']} minutes{why}",
        )


async def check() -> None:
    """Spend spike, repeated denials and loops for every agent (called from the run scheduler loop)."""
    async with database.async_session() as session:
        profiles = (await session.exec(select(AiMember))).all()
        settings_by: dict[str, AiProjectSettings] = {}
        for p in profiles:
            if p.project_id not in settings_by:
                settings_by[p.project_id] = await get_settings(session, p.project_id)
    for p in profiles:
        r = rules(settings_by[p.project_id])
        try:
            if r["spend_spike"]["on"] and p.connection == "api_key" and not p.paused:
                await _spend_spike(p, r["spend_spike"])
            if r["denials"]["on"] and not p.safe_mode:
                await _denials(p, r["denials"])
            if r["loop"]["on"]:
                await _loops(p, r["loop"])
        except Exception:  # noqa: BLE001
            log.exception("Auto-trip check failed for %s", p.id)


async def _spend_spike(p: AiMember, r: dict) -> None:
    window = float(r["minutes"])
    async with database.async_session() as session:

        async def spend(since: str) -> float:
            return float(
                (
                    await session.exec(
                        select(func.coalesce(func.sum(AiRun.cost_usd), 0.0)).where(
                            AiRun.member_id == p.id, col(AiRun.started_at) >= since
                        )
                    )
                ).one()
                or 0.0
            )

        recent = await spend(await _since(window))
        week = await spend(await _since(7 * 24 * 60))
    norm = (week - recent) / (7 * 24 * 60 / window)
    if recent >= float(r["min_usd"]) and recent > float(r["factor"]) * max(norm, 0.01):
        await _trip(
            p.project_id,
            p.id,
            "spend_spike",
            f"${recent:.2f} in {window:g} min, {recent / max(norm, 0.01):.0f}× its 7-day norm",
        )


async def _denials(p: AiMember, r: dict) -> None:
    async with database.async_session() as session:
        n = (
            await session.exec(
                select(func.count()).where(
                    AiAudit.member_id == p.id,
                    col(AiAudit.result).in_(["blocked", "denied"]),
                    col(AiAudit.created_at) >= await _since(r["minutes"]),
                )
            )
        ).one()
    if int(n or 0) >= r["count"]:
        await _trip(
            p.project_id,
            p.id,
            "denials",
            f"{n} blocked or denied in {r['minutes']} minutes",
            action="safe_mode",
        )


async def _loops(p: AiMember, r: dict) -> None:
    async with database.async_session() as session:
        runs_ = (
            await session.exec(
                select(AiRun).where(
                    AiRun.member_id == p.id,
                    col(AiRun.state).in_(["starting", "running"]),
                )
            )
        ).all()
        for run in runs_:
            rows = (
                await session.exec(
                    select(AiAudit.action, AiAudit.target, func.count())
                    .where(
                        AiAudit.run_id == run.id,
                        col(AiAudit.result).in_(
                            ["allowed", "blocked", "denied", "needs_approval"]
                        ),
                        col(AiAudit.created_at) >= await _since(r["minutes"]),
                    )
                    .group_by(AiAudit.action, AiAudit.target)
                )
            ).all()
            hit = next(
                (
                    (a, t, n)
                    for a, t, n in rows
                    if n >= r["count"] and a not in ("read",)
                ),
                None,
            )
            if hit:
                a, t, n = hit
                await _trip(
                    p.project_id,
                    p.id,
                    "loop",
                    f"{a.replace('_', ' ')} on {t or 'the same target'} {n}× in {r['minutes']} min",
                    action="stop",
                    run_id=run.id,
                )


def dumps(value: dict) -> str:
    """JSON for the settings column."""
    return json.dumps(value)
