"""AI Team, Flow, the Map view and the scope picker (AI v2).

The Map answers "how does work pass between the teams and you": nodes are the person, the teams (each with the roles
it called) and the tickets being worked; edges are the team that took a ticket, notes between teams (`ai_run message`),
questions to the person and their answers, parent and child tickets, and blocked-by. Like the Timeline it is built from
rows that already exist (`ai_run`, `ai_run_agent`, `ai_run_message`, the tickets) and nothing is tracked for it.
"""

import json
from collections import defaultdict
from datetime import UTC, datetime
from typing import Any

from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from models import AiRun, AiRunAgent, AiRunMessage, AiTeam, Member, Ticket

from .store import get_settings, loads, parse_iso
from .timeline import ACTIVE, MAX_RUNS, _role_color, name_map, role_label, window

# The tickets the scope picker lists, and the tickets a map draws before it says "narrow the range"
MAX_PICKER_TICKETS = 200
MAX_MAP_TICKETS = 60


def _ids(raw: str | None) -> list[str]:
    try:
        v = json.loads(raw or "[]")
    except ValueError:
        return []
    return [str(x) for x in v] if isinstance(v, list) else []


async def _teams(
    session: AsyncSession, project_id: str
) -> dict[str, tuple[Member, AiTeam]]:
    rows = (
        await session.exec(
            select(Member, AiTeam)
            .join(AiTeam, col(AiTeam.id) == col(Member.id))
            .where(AiTeam.project_id == project_id)
        )
    ).all()
    return {m.id: (m, t) for m, t in rows}


def _team_state(team: AiTeam, mine: list[AiRun], held: bool) -> str:
    if team.health in ("runner_missing", "not_logged_in"):
        return "offline"
    if any(r.state == "needs_input" for r in mine):
        return "waiting"
    if held or team.paused:
        return "paused"
    if any(r.state in ("starting", "running") for r in mine):
        return "working"
    return "queued" if any(r.state in ACTIVE for r in mine) else "idle"


async def flow_map(
    session: AsyncSession,
    project_id: str,
    *,
    range_key: str = "today",
    since: datetime | None = None,
    until: datetime | None = None,
    ticket_id: str | None = None,
    team_id: str | None = None,
) -> dict[str, Any]:
    """The nodes and edges of the Map for a range and a scope (the whole project, one team, or one ticket with its
    sub-tickets). `range_key` `all` is the whole life of the scope."""
    now = datetime.now(UTC)
    settings = await get_settings(session, project_id)
    held = bool(settings.paused_all)
    teams = await _teams(session, project_id)

    scope_ids: set[str] | None = None
    if ticket_id:
        kids = (
            await session.exec(select(Ticket.id).where(Ticket.parent_id == ticket_id))
        ).all()
        scope_ids = {ticket_id, *kids}

    stmt = select(AiRun).where(AiRun.project_id == project_id, AiRun.kind == "team")
    if range_key != "all":
        a, b = window(range_key, now, since, until)
        stmt = stmt.where(col(AiRun.queued_at) <= b.isoformat())
    else:
        a = b = None
    if scope_ids is not None:
        stmt = stmt.where(col(AiRun.ticket_id).in_(scope_ids))
    if team_id:
        stmt = stmt.where(AiRun.member_id == team_id)
    candidates = (
        await session.exec(stmt.order_by(col(AiRun.queued_at).desc()).limit(MAX_RUNS))
    ).all()
    runs = [
        r
        for r in candidates
        if r.member_id in teams and (a is None or (parse_iso(r.ended_at) or now) >= a)
    ]
    run_ids = [r.id for r in runs]
    runs_by_id = {r.id: r for r in runs}

    # roles each team called in these runs (a call is one stretch of work; the count is what the lead used them for)
    roles: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    if run_ids:
        for ag in (
            await session.exec(
                select(AiRunAgent).where(col(AiRunAgent.run_id).in_(run_ids))
            )
        ).all():
            r = runs_by_id.get(ag.run_id)
            if r is not None:
                roles[r.member_id][ag.agent_type or "agent"] += 1

    # takes: the team that worked a ticket
    takes: dict[tuple[str, str], dict[str, Any]] = {}
    for r in runs:
        if not r.ticket_id:
            continue
        e = takes.setdefault(
            (r.member_id, r.ticket_id),
            {
                "count": 0,
                "live": False,
                "waiting": False,
                "last_state": r.state,
                "at": r.queued_at,
            },
        )
        e["count"] += 1
        if r.state in ACTIVE:
            e["live"] = True
        if r.state == "needs_input":
            e["waiting"] = True

    # questions to the person and their answers, by team
    asks: dict[str, dict[str, Any]] = defaultdict(
        lambda: {"asked": 0, "answered": 0, "open": 0, "tickets": [], "text": ""}
    )
    for r in runs:
        q = loads(r.question, None) or {}
        asked = parse_iso(q.get("asked_at"))
        if (
            asked is None
            or (b is not None and asked > b)
            or (a is not None and asked < a)
        ):
            continue
        e = asks[r.member_id]
        e["asked"] += 1
        if q.get("answered_at"):
            e["answered"] += 1
        elif r.state == "needs_input":
            e["open"] += 1  # a question of a run that ended unanswered waits for nobody
        if r.ticket_id and r.ticket_id not in e["tickets"]:
            e["tickets"].append(r.ticket_id)
        e["text"] = (q.get("text") or "")[:160]

    # notes between teams: a team's note to a ticket's team arrives as a message from the sender's name
    by_name = await name_map(session, project_id, teams)
    notes: dict[tuple[str, str], dict[str, Any]] = {}

    def add_note(
        frm: str, to: str, ticket: str | None, text: str, at: str | None
    ) -> None:
        e = notes.setdefault(
            (frm, to), {"count": 0, "tickets": [], "text": "", "at": at}
        )
        e["count"] += 1
        if ticket and ticket not in e["tickets"]:
            e["tickets"].append(ticket)
        e["text"] = text[:160]
        e["at"] = at

    for r in runs:
        sender = by_name.get((r.started_by or "").strip().lower())
        queued = parse_iso(r.queued_at)
        in_window = queued is not None and (
            (a is None or queued >= a) and (b is None or queued <= b)
        )
        if r.trigger == "message" and sender and sender != r.member_id and in_window:
            add_note(sender, r.member_id, r.ticket_id, "", r.queued_at)
    if run_ids:
        for m in (
            await session.exec(
                select(AiRunMessage).where(
                    col(AiRunMessage.run_id).in_(run_ids),
                    AiRunMessage.direction == "in",
                )
            )
        ).all():
            r = runs_by_id[m.run_id]
            sender = by_name.get((m.peer or "").strip().lower())
            at = parse_iso(m.at)
            if not sender or sender == r.member_id or at is None:
                continue
            if (a is not None and at < a) or (b is not None and at > b):
                continue
            started = parse_iso(r.queued_at)
            if (
                r.trigger == "message"
                and started is not None
                and abs((started - at).total_seconds()) < 2
                and (r.started_by or "").strip().lower()
                == (m.peer or "").strip().lower()
            ):
                continue  # the message that started a run is counted from the run itself
            add_note(sender, r.member_id, r.ticket_id, m.text or "", m.at)

    # tickets: the ones worked, plus the parents and blockers they point at (drawn dim, for the edges)
    worked = list(dict.fromkeys(r.ticket_id for r in runs if r.ticket_id))
    truncated = len(worked) > MAX_MAP_TICKETS
    worked = worked[:MAX_MAP_TICKETS]
    rows: dict[str, Ticket] = {}
    if worked:
        for t in (
            await session.exec(select(Ticket).where(col(Ticket.id).in_(worked)))
        ).all():
            rows[t.id] = t
    context_ids: list[str] = []
    for t in list(rows.values()):
        for other in [t.parent_id, *_ids(t.blocked_by)]:
            if other and other not in rows and other not in context_ids:
                context_ids.append(other)
    for t in (
        await session.exec(select(Ticket).where(col(Ticket.id).in_(context_ids)))
        if context_ids
        else []
    ):
        if t.project_id == project_id:
            rows[t.id] = t
    edge_ids = set(rows)

    live_by_ticket: dict[str, str] = {}
    for r in runs:
        if r.ticket_id and r.state in ACTIVE:
            if live_by_ticket.get(r.ticket_id) != "waiting":
                live_by_ticket[r.ticket_id] = (
                    "waiting" if r.state == "needs_input" else "working"
                )
    teams_of: dict[str, list[str]] = defaultdict(list)
    for tid, ticket in takes:
        teams_of[ticket].append(tid)

    tickets = [
        {
            "id": t.id,
            "title": t.title,
            "status": t.status,
            "type": t.type,
            "parent_id": t.parent_id if t.parent_id in edge_ids else None,
            "blocked_by": list(
                dict.fromkeys(
                    x for x in _ids(t.blocked_by) if x in edge_ids and x != t.id
                )
            ),
            "context": t.id not in worked,
            "live": live_by_ticket.get(t.id),
            "teams": teams_of.get(t.id, []),
        }
        for t in rows.values()
    ]

    # a team's state is about everything it does now, not only the runs of the scope
    live_now: dict[str, list[AiRun]] = defaultdict(list)
    for r in (
        await session.exec(
            select(AiRun).where(
                AiRun.project_id == project_id,
                AiRun.kind == "team",
                col(AiRun.state).in_(ACTIVE),
            )
        )
    ).all():
        live_now[r.member_id].append(r)
    team_nodes = []
    for tid, (m, tm) in teams.items():
        if (
            team_id
            and tid != team_id
            and tid not in {x for pair in notes for x in pair}
        ):
            continue
        mine = [r for r in runs if r.member_id == tid]
        team_nodes.append(
            {
                "id": tid,
                "name": m.name,
                "color": m.color,
                "state": _team_state(tm, live_now.get(tid, []), held),
                "runs": len(mine),
                "tickets": len({r.ticket_id for r in mine if r.ticket_id}),
                "roles": [
                    {
                        "id": f"{tid}:{role}",
                        "name": role_label(role),
                        "color": _role_color(role),
                        "calls": n,
                    }
                    for role, n in sorted(roles[tid].items(), key=lambda kv: -kv[1])
                ],
            }
        )

    edges: list[dict[str, Any]] = []
    for (tid, ticket), e in takes.items():
        if ticket in edge_ids:
            edges.append(
                {
                    "id": f"take:{tid}:{ticket}",
                    "kind": "take",
                    "from": tid,
                    "to": ticket,
                    "count": e["count"],
                    "live": e["live"],
                    "waiting": e["waiting"],
                    "tickets": [ticket],
                }
            )
    for (frm, to), e in notes.items():
        edges.append(
            {
                "id": f"note:{frm}:{to}",
                "kind": "note",
                "from": frm,
                "to": to,
                "count": e["count"],
                "tickets": e["tickets"],
                "label": e["text"],
                "live": False,
            }
        )
    for tid, e in asks.items():
        edges.append(
            {
                "id": f"ask:{tid}",
                "kind": "ask",
                "from": tid,
                "to": "you",
                "count": e["asked"],
                "tickets": e["tickets"],
                "label": e["text"],
                "live": e["open"] > 0,
            }
        )
        if e["answered"]:
            edges.append(
                {
                    "id": f"answer:{tid}",
                    "kind": "answer",
                    "from": "you",
                    "to": tid,
                    "count": e["answered"],
                    "tickets": e["tickets"],
                    "live": False,
                }
            )
    for t in tickets:
        if t["parent_id"]:
            edges.append(
                {
                    "id": f"child:{t['parent_id']}:{t['id']}",
                    "kind": "child",
                    "from": t["parent_id"],
                    "to": t["id"],
                    "count": 1,
                    "tickets": [t["id"]],
                    "live": False,
                }
            )
        for blocker in t["blocked_by"]:
            edges.append(
                {
                    "id": f"blocked:{blocker}:{t['id']}",
                    "kind": "blocked",
                    "from": blocker,
                    "to": t["id"],
                    "count": 1,
                    "tickets": [t["id"]],
                    "live": False,
                }
            )

    open_questions = sum(e["open"] for e in asks.values())
    return {
        "range": range_key,
        "since": a.isoformat() if a else None,
        "until": b.isoformat() if b else None,
        "now": now.isoformat(),
        "scope": {"ticket_id": ticket_id, "team_id": team_id},
        "paused_all": held,
        "you": {
            "asked": sum(e["asked"] for e in asks.values()),
            "waiting": open_questions,
        },
        "teams": team_nodes,
        "tickets": tickets,
        "edges": edges,
        "runs": len(runs),
        "truncated": truncated,
        # the newest runs only were read: an old range or "all time" may be missing the oldest ones
        "runs_truncated": len(candidates) >= MAX_RUNS,
        "all_teams": len(teams),
    }


async def flow_scopes(session: AsyncSession, project_id: str) -> dict[str, Any]:
    """What the scope picker offers: the teams, the Stories with AI work and the tickets the teams worked (newest
    first), each with whether a run is live now."""
    teams = await _teams(session, project_id)
    recent = (
        await session.exec(
            select(AiRun)
            .where(AiRun.project_id == project_id, AiRun.kind == "team")
            .order_by(col(AiRun.queued_at).desc())
            .limit(MAX_RUNS)
        )
    ).all()
    per_team: dict[str, dict[str, Any]] = {
        tid: {"runs": 0, "live": False} for tid in teams
    }
    per_ticket: dict[str, dict[str, Any]] = {}
    for r in recent:
        if r.member_id in per_team:
            per_team[r.member_id]["runs"] += 1
            per_team[r.member_id]["live"] = (
                per_team[r.member_id]["live"] or r.state in ACTIVE
            )
        if r.ticket_id:
            e = per_ticket.setdefault(
                r.ticket_id,
                {"at": r.queued_at, "live": False, "waiting": False, "teams": []},
            )
            e["live"] = e["live"] or r.state in ACTIVE
            e["waiting"] = e["waiting"] or r.state == "needs_input"
            if r.member_id not in e["teams"]:
                e["teams"].append(r.member_id)
    ids = list(per_ticket)[:MAX_PICKER_TICKETS]
    tickets = (
        {
            t.id: t
            for t in (
                await session.exec(select(Ticket).where(col(Ticket.id).in_(ids)))
            ).all()
        }
        if ids
        else {}
    )
    # a Story is listed when it is a Story with a worked child, or was worked itself
    parents = {t.parent_id for t in tickets.values() if t.parent_id}
    stories = (
        {
            t.id: t
            for t in (
                await session.exec(
                    select(Ticket).where(
                        col(Ticket.id).in_(parents), Ticket.type == "story"
                    )
                )
            ).all()
        }
        if parents
        else {}
    )
    stories.update({i: t for i, t in tickets.items() if t.type == "story"})
    children: dict[str, list[str]] = defaultdict(list)
    for t in tickets.values():
        if t.parent_id in stories and t.id != t.parent_id:
            children[t.parent_id].append(t.id)

    def story_row(s: Ticket) -> dict[str, Any]:
        kids = children.get(s.id, [])
        mine = [s.id, *kids]
        return {
            "id": s.id,
            "title": s.title,
            "status": s.status,
            "tickets": len(kids),
            "done": sum(1 for k in kids if tickets[k].status == "done"),
            "live": any(per_ticket.get(i, {}).get("live") for i in mine),
            "waiting": any(per_ticket.get(i, {}).get("waiting") for i in mine),
        }

    return {
        "teams": [
            {
                "id": tid,
                "name": m.name,
                "color": m.color,
                "runs": per_team[tid]["runs"],
                "live": per_team[tid]["live"],
            }
            for tid, (m, _t) in teams.items()
        ],
        "stories": sorted(
            (story_row(s) for s in stories.values()),
            key=lambda x: (not x["live"], x["id"]),
        ),
        "tickets": [
            {
                "id": t.id,
                "title": t.title,
                "status": t.status,
                "type": t.type,
                "story_id": t.parent_id if t.parent_id in stories else None,
                "live": per_ticket[t.id]["live"],
                "waiting": per_ticket[t.id]["waiting"],
                "at": per_ticket[t.id]["at"],
                "teams": per_ticket[t.id]["teams"],
            }
            for t in (tickets[i] for i in ids if i in tickets)
            if t.type != "story"
        ],
    }
