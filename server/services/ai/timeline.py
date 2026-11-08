"""AI Team, Flow, the Timeline view: a sequence diagram of the AI teams (design/screens/ai-team-timeline.md).

One read that answers "who did what, when, and who waited for whom" in a window of time (AI v2): a lifeline for the
person, one for each team's lead and one for each role the lead called, a bar for each run of a lead and each stretch
of work of a role, an arrow for each hand-off, question and answer, and the span in which the whole project was paused.
Everything is built from rows that already exist (`ai_run`, `ai_run_agent` with the markers of `ai_run_step`,
`ai_run_message`); nothing is tracked for this view. The client draws the axis (it decides where quiet time is folded),
so the times here are true times.
"""

from collections import defaultdict
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from models import (
    AiRun,
    AiRunAgent,
    AiRunMessage,
    AiRunStep,
    AiTeam,
    Member,
    Ticket,
)

from . import budget, steps as svc_steps
from .store import get_settings, loads, parse_iso

RANGES = ("hour", "today", "24h", "7d")
MAX_RUNS = 400
MAX_ARROWS = 500
GROUP_WITHIN_S = 90
# Over MAX_ARROWS the picture groups harder (ten minutes) before it drops anything
CROWDED_WITHIN_S = 600
DENSITY_BUCKETS = 60
ACTIVE = ("queued", "starting", "running", "needs_input")
# What a role looks like when its team has no say: a tint of the design's AI colours, by the role's name
ROLE_COLORS = (
    "#2F6FB0",
    "#0F8B8D",
    "#C2417A",
    "#2E6F40",
    "#B8860B",
    "#5B5FA8",
    "#7C5CD6",
)
OFFLINE = ("runner_missing", "not_logged_in")
# Triggers of a run that a note started: a person in the ticket chat, or another AI (`ai_run message`)
NOTE_TRIGGERS = ("message", "ai_message")


def window(
    range_key: str,
    now: datetime,
    since: datetime | None = None,
    until: datetime | None = None,
) -> tuple[datetime, datetime]:
    """The window [since, until] a range names; `since` and `until` (a custom range) win."""
    if since is not None:
        return since, until or now
    if range_key == "hour":
        return now - timedelta(hours=1), now
    if range_key == "24h":
        return now - timedelta(hours=24), now
    if range_key == "7d":
        return now - timedelta(days=7), now
    return budget.today_start(), now


def _iso(at: datetime | None) -> str | None:
    return at.isoformat() if at else None


def role_label(agent_type: str) -> str:
    """ "tester" → "Tester"; "code-reviewer" → "Code reviewer"."""
    words = (agent_type or "agent").replace("-", " ").replace("_", " ").strip()
    return words[:1].upper() + words[1:]


# The three roles the design draws (AiTimeline, AiTeam board 7) have their own colour in the Map and the Timeline
NAMED_ROLE_COLORS = {"dev": "#2F6FB0", "reviewer": "#7C5CD6", "qa": "#0F8B8D"}


def _role_color(agent_type: str) -> str:
    named = NAMED_ROLE_COLORS.get((agent_type or "").strip().lower())
    if named:
        return named
    return ROLE_COLORS[sum(ord(c) for c in agent_type or "agent") % len(ROLE_COLORS)]


def end_kind(r: AiRun) -> str | None:
    """How a finished run ended, in the words the diagram draws: ok, failed, memory (stopped by the system over the RAM
    limit), timeout, stopped (a person), pause_all, limit (the account's usage limit was reached); None while it is live."""
    if r.state == "finished":
        return "ok"
    if r.state == "failed":
        if r.stop_code == "memory":
            return "memory"
        if r.stop_code == "rate_limited":
            return "limit"
        return "timeout" if "timed out" in (r.ended_reason or "").lower() else "failed"
    if r.state == "cancelled":
        if (r.ended_reason or "").startswith("Pause all"):
            return "pause_all"
        return "stopped"
    return None


def _bar(r: AiRun, lane: str, held: bool) -> dict[str, Any]:
    """The bar of a run of a lead."""
    q = loads(r.question, None) or {}
    report = loads(r.report, {})
    return {
        "id": r.id,
        "run_id": r.id,
        "agent_id": None,
        "role": None,
        "label": None,
        "member_id": lane,
        "ticket_id": r.ticket_id or "",
        "number": r.number,
        "mode": r.mode,
        "state": r.state,
        "trigger": r.trigger,
        "autopilot": False,
        "queued_at": r.queued_at,
        "started_at": r.started_at,
        "ended_at": r.ended_at,
        "end_kind": end_kind(r),
        "ended_reason": r.ended_reason,
        "ended_by": r.ended_by,
        "stop_code": r.stop_code,
        "steps": r.steps_count or 0,
        "tokens_in": r.tokens_in or 0,
        "tokens_out": r.tokens_out or 0,
        "tokens_cached": r.tokens_cached,
        "cost_usd": round(r.cost_usd or 0.0, 4),
        "metered": bool(r.metered),
        "summary": (r.summary or report.get("summary") or "")[:240],
        "question": (q.get("text") or "")[:240] if q else None,
        "paused": bool(r.paused),
        # a queued run while the whole project is paused is held, not waiting for a runner
        "held_by_pause": bool(held and r.state == "queued"),
        "model": r.model,
        "peak_rss_mb": r.peak_rss_mb,
        "last_rss_mb": r.last_rss_mb,
        "restarts": loads(r.restarts, []),
    }


def _call_bar(
    r: AiRun, agent: dict[str, Any], lane: str, n: int, call: int, span: dict
) -> dict[str, Any]:
    """The bar of one stretch of work of a role: it starts when the lead called it and ends when it reported back."""
    active = r.state in ACTIVE
    end = span.get("end") or (None if active else (r.ended_at or span["start"]))
    closed_by_run = not span.get("end") and not active
    kind = end_kind(r) if closed_by_run else ("ok" if end else None)
    return {
        "id": f"{agent['id']}:{n}",
        "run_id": r.id,
        "agent_id": agent["id"],
        "role": agent["agent_type"] or "agent",
        "label": f"call {call}",
        "member_id": lane,
        "ticket_id": r.ticket_id or "",
        "number": call,
        "mode": r.mode,
        "state": ("running" if end is None else "finished")
        if kind in (None, "ok")
        else r.state,
        "trigger": "role call",
        "autopilot": False,
        "queued_at": span["start"],
        "started_at": span["start"],
        "ended_at": end,
        "end_kind": kind,
        "ended_reason": r.ended_reason if closed_by_run and kind != "ok" else None,
        "ended_by": None,
        "stop_code": None,
        "steps": agent.get("steps_count") or 0,
        "tokens_in": 0,
        "tokens_out": 0,
        "tokens_cached": None,
        "cost_usd": 0.0,
        "metered": bool(r.metered),
        "summary": (agent.get("last_text") or "")[:240] if end else "",
        "question": None,
        "paused": False,
        "held_by_pause": False,
        "model": r.model,
        "peak_rss_mb": None,
        "last_rss_mb": None,
        "restarts": [],
    }


def _arrow(
    id_: str,
    at: str | None,
    kind: str,
    frm: str,
    to: str,
    ticket_id: str | None,
    run_id: str | None,
    *,
    to_at: str | None = None,
    wait_s: int | None = None,
    label: str | None = None,
    by: str | None = None,
) -> dict[str, Any]:
    return {
        "id": id_,
        "at": at,
        "to_at": to_at or at,
        "kind": kind,
        "from": frm,
        "to": to,
        "ticket_id": ticket_id or None,
        "run_id": run_id,
        "wait_s": wait_s,
        "round": 0,
        "label": label,
        "by": by,
    }


# Questions are what a person looks for: never grouped
ATTENTION = ("ask", "answer")


def _group(arrows: list[dict], within_s: int = GROUP_WITHIN_S) -> list[dict]:
    """Close events between the same two lifelines of the same kind become one arrow with a count."""
    out: list[dict] = []
    last: dict[tuple, dict] = {}
    for a in sorted(arrows, key=lambda x: x["at"] or ""):
        key = (a["kind"], a["from"], a["to"])
        prev = last.get(key)
        at = parse_iso(a["at"])
        prev_at = parse_iso(prev["at_last"]) if prev else None
        if (
            prev is not None
            and at
            and prev_at
            and (at - prev_at).total_seconds() <= within_s
            and a["kind"] not in ATTENTION
        ):
            prev["count"] += 1
            prev["at_last"] = a["at"]
            prev["items"].append({"id": a["id"], "ticket_id": a["ticket_id"]})
            continue
        row = {
            **a,
            "count": 1,
            "at_last": a["at"],
            "parent_id": None,
            "items": [{"id": a["id"], "ticket_id": a["ticket_id"]}],
        }
        out.append(row)
        last[key] = row
    return out


async def _load_agents(
    session: AsyncSession, run_ids: list[str]
) -> dict[str, list[dict[str, Any]]]:
    """The subagents (with their stretches of work) of several runs, oldest first, by run."""
    if not run_ids:
        return {}
    rows = (
        await session.exec(
            select(AiRunAgent)
            .where(col(AiRunAgent.run_id).in_(run_ids))
            .order_by(col(AiRunAgent.started_at).asc())
        )
    ).all()
    marks = (
        await session.exec(
            select(AiRunStep)
            .where(col(AiRunStep.run_id).in_(run_ids), AiRunStep.kind == "role")
            .order_by(col(AiRunStep.seq).asc())
        )
    ).all()
    by_agent: dict[str, list[AiRunStep]] = defaultdict(list)
    for m in marks:
        by_agent[m.agent_id or ""].append(m)
    out: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for a in rows:
        out[a.run_id].append(svc_steps.agent_dict(a, by_agent.get(a.id)))
    return out


async def _last_steps(session: AsyncSession, run_ids: list[str]) -> dict[str, str]:
    """The title of the newest step of each run (what a live run is doing now)."""
    out: dict[str, str] = {}
    for rid in run_ids:
        row = (
            await session.exec(
                select(AiRunStep)
                .where(AiRunStep.run_id == rid, AiRunStep.kind != "role")
                .order_by(col(AiRunStep.seq).desc())
                .limit(1)
            )
        ).first()
        if row:
            out[rid] = (row.title or "")[:120]
    return out


async def name_map(
    session: AsyncSession, project_id: str, teams: dict[str, tuple[Member, AiTeam]]
) -> dict[str, str]:
    """Lower-cased name -> team id, for the names that mean exactly one team: a note's sender is known by its name, so
    a name shared by two teams, or with a person of the project, is left out (it would draw the wrong team)."""
    people = {
        (m.name or "").strip().lower()
        for m in (
            await session.exec(
                select(Member).where(
                    Member.project_id == project_id, Member.kind != "ai"
                )
            )
        ).all()
    }
    seen: dict[str, list[str]] = defaultdict(list)
    for tid, (m, _t) in teams.items():
        seen[m.name.strip().lower()].append(tid)
    return {n: ids[0] for n, ids in seen.items() if len(ids) == 1 and n not in people}


async def timeline(
    session: AsyncSession,
    project_id: str,
    *,
    range_key: str = "today",
    since: datetime | None = None,
    until: datetime | None = None,
    ticket_id: str | None = None,
    team_id: str | None = None,
) -> dict[str, Any]:
    """The sequence diagram's data for a window and a scope (the whole project, one team, or one ticket with its
    sub-tickets)."""
    if range_key not in RANGES:
        range_key = "today"
    now = datetime.now(UTC)
    a, b = window(range_key, now, since, until)
    settings = await get_settings(session, project_id)

    scope_ids: set[str] | None = None
    if ticket_id:
        kids = (
            await session.exec(select(Ticket.id).where(Ticket.parent_id == ticket_id))
        ).all()
        scope_ids = {ticket_id, *kids}

    stmt = select(AiRun).where(
        AiRun.project_id == project_id,
        AiRun.kind == "team",
        col(AiRun.queued_at) <= b.isoformat(),
    )
    if scope_ids is not None:
        stmt = stmt.where(col(AiRun.ticket_id).in_(scope_ids))
    if team_id:
        stmt = stmt.where(AiRun.member_id == team_id)
    candidates = (
        await session.exec(stmt.order_by(col(AiRun.queued_at).desc()).limit(MAX_RUNS))
    ).all()
    runs = [
        r
        for r in reversed(candidates)
        if (parse_iso(r.ended_at) or now) >= a
        and (r.state != "queued" or (parse_iso(r.queued_at) or a) <= b)
    ]
    agents_of = await _load_agents(session, [r.id for r in runs])

    teams: dict[str, tuple[Member, AiTeam]] = {}
    for m, t in (
        await session.exec(
            select(Member, AiTeam)
            .join(AiTeam, col(AiTeam.id) == col(Member.id))
            .where(AiTeam.project_id == project_id)
        )
    ).all():
        teams[m.id] = (m, t)
    used = [m for m in dict.fromkeys(r.member_id for r in runs) if m in teams]
    held = bool(settings.paused_all)
    by_name = await name_map(session, project_id, teams)

    def sender_team(name: str | None, receiver: str) -> str | None:
        """The team a note came from, when `name` is one of the project's teams (and not the receiver itself)."""
        tid = by_name.get((name or "").strip().lower())
        return tid if tid and tid != receiver else None

    def add_sender(sender: str, receiver: str) -> None:
        """A team that wrote a note is drawn to the left of the team that got it (the note runs left to right)."""
        if receiver in used:
            used.insert(used.index(receiver), sender)
        else:
            used.append(sender)

    def lane_name(team_id: str, role: str | None) -> str:
        team = teams[team_id][0].name
        many = len(shown) > 1
        if role is None:
            return team if many else "Lead"
        return f"{role_label(role)} ({team})" if many else role_label(role)

    bars: list[dict[str, Any]] = []
    arrows: list[dict[str, Any]] = []
    waits: list[dict[str, Any]] = []
    role_lanes: dict[str, list[str]] = defaultdict(
        list
    )  # team -> role lane ids, in order of first call
    role_info: dict[str, tuple[str, str]] = {}  # lane -> (team id, agent type)
    calls: dict[str, int] = defaultdict(int)

    runs_by_id = {r.id: r for r in runs}
    for r in runs:
        if r.member_id not in teams:
            continue
        lead = r.member_id
        bar = _bar(r, lead, held)
        bars.append(bar)
        queued_at = r.queued_at
        landed = r.started_at or (None if r.state in ACTIVE else r.ended_at)
        wait_s = None
        q0, q1 = parse_iso(queued_at), parse_iso(landed)
        if q0 and q1:
            wait_s = max(int((q1 - q0).total_seconds()), 0)
        # the person's instruction: not for a schedule, a GitHub event or the API (nobody sat there)
        # a note from another team starts a run too (`message` from the ticket chat, `ai_message` from `ai_run message`):
        # it is an arrow from that team's lead; a note whose sender is no team (the board's agent) draws none
        from_team = (
            sender_team(r.started_by, lead) if r.trigger in NOTE_TRIGGERS else None
        )
        if r.trigger in (
            "assign",
            "run_button",
            "message",
            "docs_threads",
            "retry",
        ) or (r.trigger == "ai_message" and from_team):
            if from_team and from_team not in used:
                add_sender(from_team, r.member_id)
            arrows.append(
                _arrow(
                    f"{r.id}:assign",
                    queued_at,
                    "note" if from_team else "assign",
                    from_team or "you",
                    lead,
                    r.ticket_id,
                    r.id,
                    to_at=landed or queued_at,
                    wait_s=wait_s,
                    by=r.started_by,
                )
            )
        for ag in agents_of.get(r.id, []):
            lane = f"{lead}:{ag['agent_type'] or 'agent'}"
            if lane not in role_info:
                role_info[lane] = (lead, ag["agent_type"] or "agent")
                role_lanes[lead].append(lane)
            for span in ag["spans"]:
                calls[lane] += 1
                cb = _call_bar(r, ag, lane, calls[lane], calls[lane], span)
                bars.append(cb)
                arrows.append(
                    _arrow(
                        f"{cb['id']}:handoff",
                        span["start"],
                        "handoff",
                        lead,
                        lane,
                        r.ticket_id,
                        cb["id"],
                    )
                )
                if cb["ended_at"] and span.get("end"):
                    arrows.append(
                        _arrow(
                            f"{cb['id']}:report",
                            cb["ended_at"],
                            "report",
                            lane,
                            lead,
                            r.ticket_id,
                            cb["id"],
                        )
                    )
        q = loads(r.question, None) or {}
        asked = parse_iso(q.get("asked_at"))
        if asked is not None and asked <= b:
            answered = parse_iso(q.get("answered_at"))
            waits.append(
                {
                    "id": f"{r.id}:q",
                    "member_id": lead,
                    "ticket_id": r.ticket_id,
                    "run_id": r.id,
                    "kind": "question",
                    "from": q["asked_at"],
                    "to": q.get("answered_at"),
                    "text": (q.get("text") or "")[:240],
                    "options": [str(o)[:80] for o in (q.get("options") or [])][:6],
                }
            )
            arrows.append(
                _arrow(
                    f"{r.id}:ask",
                    q["asked_at"],
                    "ask",
                    lead,
                    "you",
                    r.ticket_id,
                    r.id,
                    label=(q.get("text") or "")[:120],
                )
            )
            if answered is not None and answered <= b:
                arrows.append(
                    _arrow(
                        f"{r.id}:answer",
                        q["answered_at"],
                        "answer",
                        "you",
                        lead,
                        r.ticket_id,
                        r.id,
                        wait_s=int((answered - asked).total_seconds()),
                        by=q.get("answered_by"),
                    )
                )
        if r.state == "finished" and r.ended_at:
            arrows.append(
                _arrow(
                    f"{r.id}:done", r.ended_at, "report", lead, "you", r.ticket_id, r.id
                )
            )

    # a person's note to a lead that is already working
    if runs_by_id:
        for m in (
            await session.exec(
                select(AiRunMessage).where(
                    col(AiRunMessage.run_id).in_(list(runs_by_id)),
                    AiRunMessage.direction == "in",
                )
            )
        ).all():
            r = runs_by_id[m.run_id]
            at = parse_iso(m.at)
            if r.member_id not in teams or at is None or at < a or at > b:
                continue
            if (parse_iso(r.queued_at) or at) >= at - timedelta(seconds=2):
                continue  # the instruction that started the run is the assign arrow
            from_team = sender_team(m.peer, r.member_id)
            if from_team and from_team not in used:
                add_sender(from_team, r.member_id)
            arrows.append(
                _arrow(
                    m.id,
                    m.at,
                    "note" if from_team else "assign",
                    from_team or "you",
                    r.member_id,
                    r.ticket_id,
                    None,
                    to_at=m.delivered_at or m.at,
                    label=(m.text or "")[:120],
                    by=m.peer or None,
                )
            )

    arrows = [x for x in arrows if (parse_iso(x["at"]) or a) <= b]

    # lifelines: you, then each team's lead followed by the roles it called (the team map's order)
    live_runs = [r for r in runs if r.state in ACTIVE]
    open_roles = {x["member_id"] for x in bars if x["role"] and x["ended_at"] is None}

    def state_of(team_id: str, lane: str | None) -> str:
        team = teams[team_id][1]
        if team.health in OFFLINE:
            return "offline"
        mine = [r for r in live_runs if r.member_id == team_id]
        if lane is not None:
            return (
                "paused"
                if held or team.paused
                else ("working" if lane in open_roles else "idle")
            )
        if any(r.state == "needs_input" for r in mine):
            return "waiting"
        if held or team.paused:
            return "paused"
        if any(r.state in ("starting", "running") for r in mine):
            return "working"
        return "queued" if mine else "idle"

    lifelines: list[dict[str, Any]] = [
        {
            "id": "you",
            "kind": "you",
            "name": "You",
            "color": "#1E2A22",
            # a dot like the AIs': amber while a run waits for your answer, grey otherwise
            "state": (
                "waiting"
                if any(r.state == "needs_input" for r in live_runs)
                else "idle"
            ),
        }
    ]
    shown = list(used)
    if team_id in teams and team_id not in shown:
        shown.append(
            team_id
        )  # one team on show: it is drawn even when nothing ran in the window
    if scope_ids is None and not team_id:
        shown += [t for t in teams if t not in used and teams[t][0].kind == "ai"]
    for tid in shown:
        m, _t = teams[tid]
        lifelines.append(
            {
                "id": tid,
                "kind": "ai",
                "lead": True,
                "team_id": tid,
                "team_name": m.name,
                "name": lane_name(tid, None),
                "color": m.color,
                "state": state_of(tid, None),
                "quiet": tid not in used,
            }
        )
        for lane in role_lanes.get(tid, []):
            lifelines.append(
                {
                    "id": lane,
                    "kind": "ai",
                    "team_id": tid,
                    "name": lane_name(tid, role_info[lane][1]),
                    "color": _role_color(role_info[lane][1]),
                    "state": state_of(tid, lane),
                }
            )

    grouped = _group(arrows)
    crowded = len(grouped) > MAX_ARROWS
    if crowded:
        grouped = _group(arrows, CROWDED_WITHIN_S)
    truncated = len(grouped) > MAX_ARROWS
    if truncated:
        grouped = grouped[-MAX_ARROWS:]

    density = [0] * DENSITY_BUCKETS
    span_s = max((b - a).total_seconds(), 1.0)
    for x in bars:
        if x["role"]:
            continue
        s = parse_iso(x["started_at"]) or parse_iso(x["queued_at"])
        e = parse_iso(x["ended_at"]) or now
        if s is None:
            continue
        i0 = max(0, int((s - a).total_seconds() / span_s * DENSITY_BUCKETS))
        i1 = min(
            DENSITY_BUCKETS - 1, int((e - a).total_seconds() / span_s * DENSITY_BUCKETS)
        )
        for i in range(i0, i1 + 1):
            density[i] += 1

    last_end = max(
        (parse_iso(x["ended_at"]) for x in bars if x["ended_at"]), default=None
    )

    steps_now = await _last_steps(session, [r.id for r in live_runs][:12])
    titles = (
        {
            t.id: t
            for t in (
                await session.exec(
                    select(Ticket).where(
                        col(Ticket.id).in_({r.ticket_id for r in runs if r.ticket_id})
                    )
                )
            ).all()
        }
        if runs
        else {}
    )
    live = []
    for r in live_runs[:12]:
        if r.member_id not in teams:
            continue
        since_at = parse_iso(r.started_at) or parse_iso(r.queued_at)
        live.append(
            {
                "run_id": r.id,
                "member_id": r.member_id,
                "member_name": teams[r.member_id][0].name,
                "ticket_id": r.ticket_id or "",
                "ticket_title": titles[r.ticket_id].title
                if r.ticket_id in titles
                else "",
                "state": {
                    "needs_input": "waiting_you",
                    "queued": "queued",
                }.get(r.state, "working"),
                "mode": r.mode,
                "trigger": r.trigger,
                "sender": r.started_by,
                "elapsed_s": int((now - since_at).total_seconds())
                if since_at
                else None,
                "step": steps_now.get(r.id, ""),
            }
        )

    pauses = []
    if settings.paused_all and settings.paused_at:
        pauses.append(
            {
                "from": settings.paused_at,
                "to": None,
                "by": None,
                "reason": settings.paused_reason,
                "resumed_by": None,
            }
        )
    return {
        "range": range_key,
        "since": a.isoformat(),
        "until": b.isoformat(),
        "now": now.isoformat(),
        "following": b >= now - timedelta(seconds=5),
        "scope": {
            "kind": "ticket" if ticket_id else "team",
            "ticket_id": ticket_id,
            "team_id": team_id,
        },
        "lifelines": lifelines,
        "bars": bars,
        "arrows": grouped,
        "waits": waits,
        "touches": [],
        "docs": [],
        "pauses": pauses,
        "paused_all": bool(settings.paused_all),
        "paused_at": settings.paused_at if settings.paused_all else None,
        "paused_by": None,
        "live": live,
        "density": density,
        "truncated": truncated,
        "grouped_harder": crowded,
        "last_ended_at": _iso(last_end),
        "tickets": {
            tid: {"title": t.title, "status": t.status}
            for tid, t in titles.items()
            if any(x["ticket_id"] == tid for x in bars)
        },
        "autopilot": {"on": False, "delegate": None, "grace_min": None},
    }
