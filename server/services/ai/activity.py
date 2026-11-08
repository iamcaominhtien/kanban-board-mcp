"""What a team's roles are doing and have done (AI Team page, AI v2): read from `ai_run`, `ai_run_agent` and
`ai_run_step`. There is no cost per role (cost belongs to a run), so this module counts runs and steps, never money."""

import re
from datetime import UTC, datetime
from typing import Any

from sqlmodel import col, func, select
from sqlmodel.ext.asyncio.session import AsyncSession

from models import AiRun, AiRunAgent, AiRunMessage, AiRunStep, Ticket

from . import steps as svc_steps
from .store import loads

WORKING_RUN_STATES = ("starting", "running", "needs_input")
ENDED_RUN_STATES = ("finished", "failed", "cancelled", "timed_out")
# Steps that say what a role is doing; hooks and markers do not
_QUIET_KINDS = ("hook", "role", "start", "end")


def _day_start() -> str:
    """Start of today (UTC, as the team's usage counts it)."""
    return datetime.now(UTC).date().isoformat()


_WIKI_LINK = re.compile(r"\[\[(?:[^\]|]+\|)?([^\]]+)\]\]")


def first_line(text: str | None, limit: int = 200) -> str:
    """The first non-empty line of a report, cleaned of Markdown marks (and `[[page]]` links) and cut short."""
    for raw in (text or "").splitlines():
        line = raw.strip().lstrip("#>*-• ").replace("**", "").replace("`", "")
        line = _WIKI_LINK.sub(r"\1", line).strip()
        if line:
            return line if len(line) <= limit else line[: limit - 1].rstrip() + "…"
    return ""


async def _tickets(session: AsyncSession, ids: set[str | None]) -> dict[str, str]:
    wanted = [i for i in ids if i]
    if not wanted:
        return {}
    rows = (await session.exec(select(Ticket).where(col(Ticket.id).in_(wanted)))).all()
    return {t.id: t.title for t in rows}


async def _newest_step(
    session: AsyncSession, run_id: str, agent_id: str | None
) -> dict | None:
    stmt = select(AiRunStep).where(
        AiRunStep.run_id == run_id, col(AiRunStep.kind).not_in(_QUIET_KINDS)
    )
    stmt = stmt.where(
        AiRunStep.agent_id == agent_id
        if agent_id
        else col(AiRunStep.agent_id).is_(None)
    )
    row = (
        await session.exec(stmt.order_by(col(AiRunStep.seq).desc()).limit(1))
    ).first()
    if row is None:
        return None
    return {"title": row.title, "kind": row.kind, "at": row.at}


def _span_end(agent: dict) -> str | None:
    """When the role last stopped (None while it works)."""
    spans = agent.get("spans") or []
    return spans[-1]["end"] if spans else agent.get("ended_at")


async def team_activity(
    session: AsyncSession, member_id: str, role_keys: list[str]
) -> dict[str, Any]:
    """The lead and each role of a team: what it works on now, when it last worked, runs and steps today.

    `role_keys` are the keys of the team's roles, in order. A subagent type that is not a role of the team (one the
    lead made up) is listed after them, so no work goes missing."""
    day = _day_start()
    # runs that matter for "now" and "today": still going, or started or ended today
    runs = (
        await session.exec(
            select(AiRun)
            .where(
                AiRun.member_id == member_id,
                col(AiRun.state).in_([*WORKING_RUN_STATES, "queued"])
                | (col(AiRun.started_at) >= day)
                | (col(AiRun.ended_at) >= day),
            )
            .order_by(col(AiRun.queued_at).desc())
        )
    ).all()
    # the latest agents of each role, even from days ago (for "last worked")
    last_agent_rows = (
        await session.exec(
            select(AiRunAgent, AiRun)
            .join(AiRun, col(AiRun.id) == col(AiRunAgent.run_id))
            .where(AiRun.member_id == member_id)
            .order_by(col(AiRunAgent.started_at).desc())
            .limit(400)
        )
    ).all()
    by_run: dict[str, AiRun] = {r.id: r for r in runs}
    agents_by_run: dict[str, list[dict]] = {
        rid: await svc_steps.agents(session, rid) for rid in by_run
    }
    for _, r in last_agent_rows:
        by_run.setdefault(r.id, r)

    keys = list(role_keys)
    seen = set(keys)
    for agent, _ in last_agent_rows:
        if agent.agent_type and agent.agent_type not in seen:
            seen.add(agent.agent_type)
            keys.append(agent.agent_type)

    # steps today per agent (one grouped query), and the lead's own
    all_agent_ids = [a["id"] for lst in agents_by_run.values() for a in lst]
    steps_today: dict[str | None, int] = {}
    if all_agent_ids:
        rows = (
            await session.exec(
                select(AiRunStep.agent_id, func.count())
                .where(
                    col(AiRunStep.agent_id).in_(all_agent_ids),
                    AiRunStep.at >= day,
                    col(AiRunStep.kind).not_in(_QUIET_KINDS),
                )
                .group_by(AiRunStep.agent_id)
            )
        ).all()
        steps_today = {a: n for a, n in rows}
    lead_steps_today = 0
    if runs:
        lead_steps_today = int(
            (
                await session.exec(
                    select(func.count())
                    .select_from(AiRunStep)
                    .where(
                        col(AiRunStep.run_id).in_([r.id for r in runs]),
                        col(AiRunStep.agent_id).is_(None),
                        AiRunStep.at >= day,
                        col(AiRunStep.kind).not_in(_QUIET_KINDS),
                    )
                )
            ).one()
            or 0
        )

    titles = await _tickets(session, {r.ticket_id for r in by_run.values()})

    def where(run: AiRun) -> dict:
        return {
            "run_id": run.id,
            "ticket_id": run.ticket_id,
            "ticket_title": titles.get(run.ticket_id or ""),
            "number": run.number,
        }

    out_roles: list[dict] = []
    for key in keys:
        working = None
        runs_today: set[str] = set()
        steps = 0
        for rid, lst in agents_by_run.items():
            run = by_run[rid]
            for a in lst:
                if a["agent_type"] != key:
                    continue
                steps += steps_today.get(a["id"], 0)
                is_working = _span_end(a) is None and run.state in WORKING_RUN_STATES
                if (a["started_at"] or "") >= day or is_working:
                    runs_today.add(rid)
                if is_working:
                    working = {
                        **where(run),
                        "since": (a.get("spans") or [{}])[-1].get("start")
                        or a["started_at"],
                        "steps_count": a["steps_count"],
                        "state": run.state,
                        "step": await _newest_step(session, rid, a["id"]),
                        "_agent": a["id"],
                    }
        last = None
        for agent, run in last_agent_rows:
            if agent.agent_type != key:
                continue
            if working and agent.id == working["_agent"]:
                continue  # that is the stretch it is in now
            last = {
                **where(run),
                "at": agent.ended_at or agent.started_at,
                "steps_count": agent.steps_count,
                "text": first_line(agent.last_text, 160) or None,
            }
            break
        if working:
            working.pop("_agent", None)
        out_roles.append(
            {
                "key": key,
                "working": working,
                "last_worked": last,
                "steps_today": steps,
                "runs_today": len(runs_today),
            }
        )

    # the lead itself: working while a run of the team goes
    live = [r for r in runs if r.state in WORKING_RUN_STATES]
    lead_working = None
    if live:
        r = live[0]
        lead_working = {
            **where(r),
            "since": r.started_at,
            "state": r.state,
            "step": await _newest_step(session, r.id, None),
            "context_used": r.context_used,
            "context_window": r.context_window,
        }
    lead_last = next(
        (r for r in runs if r.state in ENDED_RUN_STATES and r.ended_at), None
    )
    return {
        "team_id": member_id,
        "day": day,
        "lead": {
            "working": lead_working,
            "last_worked": (
                {**where(lead_last), "at": lead_last.ended_at, "state": lead_last.state}
                if lead_last
                else None
            ),
            "steps_today": lead_steps_today,
            "runs_today": len([r for r in runs if (r.started_at or "") >= day]),
        },
        "roles": out_roles,
    }


async def project_activity(session: AsyncSession, teams: list[dict]) -> dict[str, Any]:
    """`team_activity` of each described team (see teams.list_teams), by team id."""
    return {
        t["id"]: await team_activity(
            session, t["id"], [r["key"] for r in t.get("roles") or []]
        )
        for t in teams
    }


async def recent(
    session: AsyncSession,
    project_id: str,
    *,
    team_id: str | None = None,
    limit: int = 8,
) -> dict[str, Any]:
    """Runs that just ended, each with the first line of its report, and the latest notes into and out of runs."""
    stmt = select(AiRun).where(
        AiRun.project_id == project_id,
        AiRun.kind == "team",
        col(AiRun.state).in_(ENDED_RUN_STATES),
        col(AiRun.ended_at).is_not(None),
    )
    if team_id:
        stmt = stmt.where(AiRun.member_id == team_id)
    ended = (
        await session.exec(stmt.order_by(col(AiRun.ended_at).desc()).limit(limit))
    ).all()

    mstmt = (
        select(AiRunMessage, AiRun)
        .join(AiRun, col(AiRun.id) == col(AiRunMessage.run_id))
        .where(AiRun.project_id == project_id)
    )
    if team_id:
        mstmt = mstmt.where(AiRun.member_id == team_id)
    notes = (
        await session.exec(mstmt.order_by(col(AiRunMessage.at).desc()).limit(limit))
    ).all()
    titles = await _tickets(
        session, {r.ticket_id for r in ended} | {r.ticket_id for _, r in notes}
    )
    return {
        "runs": [
            {
                "run_id": r.id,
                "ticket_id": r.ticket_id,
                "ticket_title": titles.get(r.ticket_id or ""),
                "member_id": r.member_id,
                "number": r.number,
                "state": r.state,
                "ended_at": r.ended_at,
                "steps_count": r.steps_count,
                "line": first_line(
                    (loads(r.report, {}) or {}).get("summary") or r.summary
                )
                or first_line(r.ended_reason),
            }
            for r in ended
        ],
        "notes": [
            {
                "id": m.id,
                "run_id": r.id,
                "ticket_id": r.ticket_id,
                "ticket_title": titles.get(r.ticket_id or ""),
                "member_id": r.member_id,
                "direction": m.direction,
                "peer": m.peer,
                "text": first_line(m.text, 220),
                "at": m.at,
            }
            for m, r in notes
        ],
    }
