"""AI Team, Flow, the Timeline view: a sequence diagram of the AI team (design/screens/ai-team-timeline.md).

One read that answers "who did what, when, and who waited for whom" in a window of time: a lifeline per participant
(the person, Autopilot, each AI, Docs), a bar per run, an arrow per hand-off, question, approval or decision, and the
spans in which the whole project was paused. Everything is built from records that already exist; nothing is tracked
for this view. The client draws the axis (it decides where quiet time is folded), so the times here are true times.
"""

from collections import defaultdict
from datetime import UTC, datetime, timedelta

from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from models import AiMember, AiRun, DocsAiProposal, Ticket

from . import autopilot, budget, flow_view, health, pause_log
from .store import get_settings, loads, parse_iso

RANGES = ("hour", "today", "24h", "7d")
MAX_ARROWS = 500
GROUP_WITHIN_S = 90
PARENT_GROUP_S = 3600
# Over MAX_ARROWS the picture groups harder (ten minutes) before it drops anything
CROWDED_WITHIN_S = 600
DENSITY_BUCKETS = 60


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


def _end_kind(r: AiRun) -> str | None:
    """How a finished run ended, in the words the diagram draws: ok, failed, timeout, stopped (a person), pause_all,
    budget; None while it is live."""
    if r.state == "finished":
        return "ok"
    if r.state == "failed":
        return "failed"
    if r.state == "timed_out":
        return "timeout"
    if r.state == "cancelled":
        if (r.ended_reason or "").startswith("Pause all AI"):
            return "pause_all"
        if r.stop_code == "budget":
            return "budget"
        return "stopped"
    return None


def _bar(r: AiRun, now: datetime, held: bool) -> dict:
    q = loads(r.question, None) or {}
    steps = loads(r.steps, [])
    report = loads(r.report, {})
    return {
        "id": r.id,
        "member_id": r.member_id,
        "ticket_id": r.ticket_id,
        "number": r.number,
        "mode": r.mode,
        "state": r.state,
        "trigger": r.trigger,
        "autopilot": r.trigger == "autopilot",
        "queued_at": r.queued_at,
        "started_at": r.started_at,
        "ended_at": r.ended_at,
        "end_kind": _end_kind(r),
        "ended_reason": r.ended_reason,
        "ended_by": r.ended_by,
        "stop_code": r.stop_code,
        "steps": len(steps),
        "tokens_in": r.tokens_in or 0,
        "tokens_out": r.tokens_out or 0,
        "tokens_cached": r.tokens_cached,
        "cost_usd": round(r.cost_usd, 4),
        "metered": bool(r.metered),
        "summary": (r.summary or report.get("summary") or "")[:240],
        "question": (q.get("text") or "")[:240] if q else None,
        "paused": bool(r.paused),
        # a queued run while the whole project is paused is held, not waiting for an AI or a runner
        "held_by_pause": bool(held and r.state == "queued"),
        "model": r.model,
    }


ATTENTION = ("ask", "perm", "sent_back", "returned", "auto")


def _group(
    arrows: list[dict],
    parent_of: dict[str, str | None],
    within_s: int = GROUP_WITHIN_S,
    parent_within_s: int = PARENT_GROUP_S,
) -> list[dict]:
    """Close events between the same two lifelines of the same kind become one arrow with a count. The report backs of
    a parent ticket's children to one AI group over a longer stretch (they can come a dozen in an hour). Questions,
    permissions, returns and decisions are what a person looks for, so they are never grouped."""
    out: list[dict] = []
    last: dict[tuple, dict] = {}
    for a in sorted(arrows, key=lambda x: x["at"] or ""):
        parent = parent_of.get(a["ticket_id"] or "") if a["kind"] == "report" else None
        key = (a["kind"], a["from"], a["to"], parent)
        prev = last.get(key)
        at = parse_iso(a["at"])
        prev_at = parse_iso(prev["at_last"]) if prev else None
        window = parent_within_s if parent else within_s
        if (
            prev is not None
            and at
            and prev_at
            and (at - prev_at).total_seconds() <= window
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
            "parent_id": parent,
            "items": [{"id": a["id"], "ticket_id": a["ticket_id"]}],
        }
        out.append(row)
        last[key] = row
    return out


async def timeline(
    session: AsyncSession,
    project_id: str,
    *,
    range_key: str = "today",
    since: datetime | None = None,
    until: datetime | None = None,
    ticket_id: str | None = None,
) -> dict:
    """The sequence diagram's data for a window and a scope (the whole team, one ticket, or a parent and its
    children)."""
    if range_key not in RANGES:
        range_key = "today"
    now = datetime.now(UTC)
    a, b = window(range_key, now, since, until)
    settings = await get_settings(session, project_id)
    d = await health.load(session, project_id, a)
    names = {m.id: m.name for m in d.ais.values()}

    scope_ids: set[str] | None = None
    if ticket_id:
        kids = (
            await session.exec(select(Ticket.id).where(Ticket.parent_id == ticket_id))
        ).all()
        scope_ids = {ticket_id, *kids}

    def in_scope(tid: str | None) -> bool:
        return scope_ids is None or (tid in scope_ids)

    def overlaps(r: AiRun) -> bool:
        start = parse_iso(r.queued_at) or a
        end = parse_iso(r.ended_at) or now
        return start <= b and end >= a

    runs = [r for r in d.runs if in_scope(r.ticket_id) and overlaps(r)]
    run_by_id = {r.id: r for r in runs}
    tickets = d.tickets
    held = bool(settings.paused_all)
    bars = [_bar(r, now, held) for r in runs]

    arrows: list[dict] = []
    waits: list[dict] = []
    touches: list[dict] = []
    docs_nodes: list[dict] = []

    ap = autopilot.config(settings)
    delegate_id = ap.get("delegate_id") if ap.get("enabled") else None

    def lane_of(who: str | None) -> str:
        return who if who in names else "you"

    # hand-offs between lifelines, drawn from the sender's last run on the ticket to the receiver's start
    ender: dict[tuple[str, str], list[AiRun]] = defaultdict(list)
    for r in sorted(d.runs, key=lambda r: r.ended_at or ""):
        if r.ended_at:
            ender[(r.ticket_id, r.member_id)].append(r)
    for e in d.events:
        if not in_scope(e["ticket_id"]):
            continue
        at = parse_iso(e["at"])
        recv = run_by_id.get(e["run_id"])
        if at is None or recv is None or at > b:
            continue
        recv_end = parse_iso(recv.ended_at)
        if recv_end is not None and recv_end < a:
            continue
        sender = lane_of(e["from"])
        from_at = e["at"]
        if sender != "you":
            prior = [
                x
                for x in ender.get((e["ticket_id"], sender), [])
                if (parse_iso(x.ended_at) or at) <= at + timedelta(seconds=5)
            ]
            if prior:
                from_at = prior[-1].ended_at
        kind = (
            "sent_back"
            if e["sent_back"]
            else "returned"
            if e["returned"]
            else {
                "assigned": "assign",
                "mention": "mention",
                "hand-off": "handoff",
                "report back": "report",
            }.get(e["kind"], "handoff")
        )
        arrows.append(
            {
                "id": e["run_id"],
                "at": from_at,
                "to_at": recv.started_at or recv.queued_at,
                "kind": kind,
                "from": sender,
                "to": e["to"],
                "ticket_id": e["ticket_id"],
                "run_id": e["run_id"],
                "wait_s": e["wait_s"],
                "round": e["pair_count"] or 0,
                "label": None,
            }
        )

    # questions and approvals: an AI asks a person, the person answers (or Autopilot does, for them)
    for r in runs:
        q = loads(r.question, None) or {}
        if not q.get("asked_at"):
            continue
        asked = parse_iso(q["asked_at"])
        answered = parse_iso(q.get("answered_at"))
        if asked is None or asked > b:
            continue
        via_autopilot = q.get("answered_via") == "autopilot"
        waits.append(
            {
                "id": f"{r.id}:q",
                "member_id": r.member_id,
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
            {
                "id": f"{r.id}:ask",
                "at": q["asked_at"],
                "to_at": q["asked_at"],
                "kind": "ask",
                "from": r.member_id,
                "to": "you",
                "ticket_id": r.ticket_id,
                "run_id": r.id,
                "wait_s": None,
                "round": 0,
                "label": (q.get("text") or "")[:120],
            }
        )
        if answered and answered <= b:
            arrows.append(
                {
                    "id": f"{r.id}:answer",
                    "at": q["answered_at"],
                    "to_at": q["answered_at"],
                    "kind": "auto" if via_autopilot else "answer",
                    "from": "autopilot" if via_autopilot else "you",
                    "to": r.member_id,
                    "ticket_id": r.ticket_id,
                    "run_id": r.id,
                    "wait_s": int((answered - asked).total_seconds()),
                    "round": 0,
                    "label": None,
                    "by": q.get("answered_by"),
                }
            )
    for ap_row in d.approvals:
        if not in_scope(ap_row.ticket_id):
            continue
        req = parse_iso(ap_row.requested_at)
        if req is None or req > b:
            continue
        done = parse_iso(ap_row.decided_at)
        if done is not None and done < a and (req < a):
            continue
        waits.append(
            {
                "id": f"{ap_row.id}:p",
                "member_id": ap_row.member_id,
                "ticket_id": ap_row.ticket_id,
                "run_id": ap_row.run_id,
                "kind": "approval",
                "from": ap_row.requested_at,
                "to": ap_row.decided_at,
                "text": ap_row.summary[:240],
                "risk": ap_row.risk,
                "status": ap_row.status,
            }
        )
        arrows.append(
            {
                "id": f"{ap_row.id}:perm",
                "at": ap_row.requested_at,
                "to_at": ap_row.requested_at,
                "kind": "perm",
                "from": ap_row.member_id,
                "to": "you",
                "ticket_id": ap_row.ticket_id,
                "run_id": ap_row.run_id,
                "wait_s": None,
                "round": 0,
                "label": ap_row.summary[:120],
                "risk": ap_row.risk,
            }
        )
        if done is not None and done <= b and ap_row.status in ("approved", "denied"):
            via_ap = ap_row.decided_via == "autopilot"
            arrows.append(
                {
                    "id": f"{ap_row.id}:decision",
                    "at": ap_row.decided_at,
                    "to_at": ap_row.decided_at,
                    "kind": "auto"
                    if via_ap
                    else ("approve" if ap_row.status == "approved" else "deny"),
                    "from": "autopilot" if via_ap else "you",
                    "to": ap_row.member_id,
                    "ticket_id": ap_row.ticket_id,
                    "run_id": ap_row.run_id,
                    "wait_s": int((done - req).total_seconds()),
                    "round": 0,
                    "label": ap_row.decision_note[:120]
                    if ap_row.decision_note
                    else None,
                    "by": ap_row.decided_by,
                    "denied": ap_row.status == "denied",
                    "risk": ap_row.risk,
                    "summary": ap_row.summary[:240],
                }
            )

    # what the person did on a ticket, the same marks as Flow and "You stepped in"
    for t in d.touches:
        at = parse_iso(t["at"])
        if at is None or at < a or at > b or not in_scope(t["ticket_id"]):
            continue
        touches.append(
            {
                "id": t.get("id") or f"{t['ticket_id']}:{t['at']}",
                "at": t["at"],
                "ticket_id": t["ticket_id"],
                "mark": t["mark"],
                "what": t["what"],
                "who": t["who"],
                "via": t["via"],
            }
        )

    # Docs: pages an AI wrote or proposed changes to
    ai_names = {v: k for k, v in names.items()}
    for v in d.versions:
        at = parse_iso(v.created_at)
        mid = ai_names.get(v.author)
        if at is None or at < a or at > b or mid is None or scope_ids is not None:
            continue
        docs_nodes.append(
            {
                "id": v.id,
                "at": v.created_at,
                "member_id": mid,
                "page_id": v.page_id,
                "title": v.title,
                "version": v.version,
                "kind": "version",
                "status": None,
            }
        )
    proposals = (
        await session.exec(
            select(DocsAiProposal).where(
                DocsAiProposal.project_id == project_id,
                DocsAiProposal.created_at >= a.isoformat(),
                DocsAiProposal.created_at <= b.isoformat(),
            )
        )
    ).all()
    for p in proposals:
        if scope_ids is not None and p.ticket_id not in scope_ids:
            continue
        page = d.pages.get(p.page_id)
        docs_nodes.append(
            {
                "id": p.id,
                "at": p.created_at,
                "member_id": p.member_id,
                "page_id": p.page_id,
                "title": page.title if page else "",
                "version": p.base_version,
                "kind": "proposal",
                "status": p.status,
                "summary": p.summary[:240],
                "changes": len(loads(p.changes, [])),
            }
        )
    for n in docs_nodes:
        arrows.append(
            {
                "id": f"{n['id']}:doc",
                "at": n["at"],
                "to_at": n["at"],
                "kind": "doc",
                "from": n["member_id"],
                "to": "docs",
                "ticket_id": None,
                "run_id": None,
                "wait_s": None,
                "round": 0,
                "label": n["title"][:80],
            }
        )

    # lifelines: you, Autopilot, the AIs in the Team map's order, Docs
    involved = {x["member_id"] for x in bars} | {
        x["from"] for x in arrows if x["from"] in names
    }
    involved |= {x["to"] for x in arrows if x["to"] in names}
    order = flow_view.usual_order([r for r in d.runs if r.queued_at], list(d.ais))
    if scope_ids is not None:
        order = [m for m in order if m in involved]
    live = await flow_view.live_runs(session, project_id)
    profiles = {
        p.id: p
        for p in (
            await session.exec(
                select(AiMember).where(col(AiMember.id).in_(list(d.ais) or [""]))
            )
        ).all()
    }
    lifelines: list[dict] = [
        {"id": "you", "kind": "you", "name": "You", "color": "#1E2A22", "state": None}
    ]
    ap_decided = any(x["kind"] == "auto" for x in arrows)
    ap_runs = any(x["autopilot"] for x in bars)
    if delegate_id or ap_decided or ap_runs:
        lifelines.append(
            {
                "id": "autopilot",
                "kind": "autopilot",
                "name": "Autopilot",
                "color": "#7C5CD6",
                "delegate": names.get(delegate_id or "", None),
                "state": None,
            }
        )
    for mid in order:
        m = d.ais[mid]
        prof = profiles.get(mid)
        mine_live = [x for x in live if x["member_id"] == mid]
        offline = prof is not None and prof.health in (
            "runner_missing",
            "not_logged_in",
            "key_invalid",
            "model_retired",
        )
        state = (
            "offline"
            if offline
            else "waiting"
            if any(x["state"] == "waiting_you" for x in mine_live)
            else "paused"
            if settings.paused_all or (prof and prof.paused)
            else "working"
            if any(x["state"] == "working" for x in mine_live)
            else "queued"
            if mine_live
            else "idle"
        )
        lifelines.append(
            {
                "id": mid,
                "kind": "ai",
                "name": m.name,
                "color": m.color,
                "state": state,
                "quiet": mid not in involved,
            }
        )
    if docs_nodes:
        lifelines.append(
            {
                "id": "docs",
                "kind": "docs",
                "name": "Docs",
                "color": "#9AA8A0",
                "state": None,
            }
        )

    # one arrow per run of close events between the same two lifelines; keep the newest MAX_ARROWS
    parent_of = {tid: t.parent_id for tid, t in tickets.items()}
    grouped = _group(arrows, parent_of)
    crowded = len(grouped) > MAX_ARROWS
    if crowded:
        grouped = _group(arrows, parent_of, CROWDED_WITHIN_S, PARENT_GROUP_S)
    truncated = len(grouped) > MAX_ARROWS
    if truncated:
        grouped = grouped[-MAX_ARROWS:]

    pauses = await pause_log.intervals(session, project_id, a, b)
    density = [0] * DENSITY_BUCKETS
    span = max((b - a).total_seconds(), 1.0)
    for x in bars:
        s = parse_iso(x["started_at"]) or parse_iso(x["queued_at"])
        e = parse_iso(x["ended_at"]) or now
        if s is None:
            continue
        i0 = max(0, int((s - a).total_seconds() / span * DENSITY_BUCKETS))
        i1 = min(
            DENSITY_BUCKETS - 1, int((e - a).total_seconds() / span * DENSITY_BUCKETS)
        )
        for i in range(i0, i1 + 1):
            density[i] += 1

    last_end = max(
        (parse_iso(x["ended_at"]) for x in bars if x["ended_at"]), default=None
    )
    return {
        "range": range_key,
        "since": a.isoformat(),
        "until": b.isoformat(),
        "now": now.isoformat(),
        "following": b >= now - timedelta(seconds=5),
        "scope": {"kind": "ticket" if ticket_id else "team", "ticket_id": ticket_id},
        "lifelines": lifelines,
        "bars": bars,
        "arrows": grouped,
        "waits": waits,
        "touches": touches,
        "docs": docs_nodes,
        "pauses": pauses,
        "paused_all": settings.paused_all,
        "paused_at": settings.paused_at if settings.paused_all else None,
        "paused_by": settings.paused_by if settings.paused_all else None,
        "live": live[:12],
        "density": density,
        "truncated": truncated,
        "grouped_harder": crowded,
        "last_ended_at": _iso(last_end),
        "tickets": {
            tid: {"title": t.title, "status": t.status}
            for tid, t in tickets.items()
            if any(x["ticket_id"] == tid for x in bars)
            or any(x.get("ticket_id") == tid for x in grouped)
        },
        "autopilot": {
            "on": bool(delegate_id),
            "delegate": names.get(delegate_id or "", None),
            "grace_min": ap.get("grace_min"),
        },
    }
