"""AI Team, Flow: the team map and the journey of one ticket (design/screens/ai-team.md, C and D)."""

import statistics
from collections import Counter, defaultdict
from datetime import UTC, datetime

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from models import AiRun, Ticket

from . import flow, health
from .store import loads, parse_iso
from .team import RANGES, window_start

YOU = "you"


def _end_of(r: AiRun, now: datetime) -> datetime | None:
    return parse_iso(r.ended_at) or (
        now if r.state in ("starting", "running", "needs_input") else None
    )


def _ends(e: dict, names: dict[str, str]) -> tuple[str, str]:
    return (
        e["from"] if e["from"] in names else YOU,
        e["to"] if e["to"] in names else YOU,
    )


def usual_order(runs: list[AiRun], members: list[str]) -> list[str]:
    """The team's usual order: members sorted by where they usually come in on a ticket (the mean place of their first
    run, from 0 for first to 1 for last). Members with no runs keep their place at the end."""
    first: dict[str, dict[str, str]] = defaultdict(dict)
    for r in sorted(runs, key=lambda r: r.queued_at or ""):
        first[r.ticket_id].setdefault(r.member_id, r.queued_at or "")
    places: dict[str, list[float]] = defaultdict(list)
    for held in first.values():
        if len(held) < 2:
            continue
        ranked = sorted(held, key=lambda m: held[m])
        for i, m in enumerate(ranked):
            places[m].append(i / (len(ranked) - 1))
    keyed = {
        m: (sum(places[m]) / len(places[m]) if places[m] else 2.0) for m in members
    }
    return sorted(members, key=lambda m: (keyed[m], members.index(m)))


def skipped_between(
    runs: list[AiRun], order: list[str], src: str, dst: str
) -> list[str]:
    """Members that usually hold a ticket between `src` and `dst` before `dst` does, but did not on this hand-off: the
    ones a forward hand-off skips. A member counts as usual when it held the ticket before `dst` on at least half of
    the tickets `dst` held."""
    i, j = order.index(src), order.index(dst)
    if j - i < 2:
        return []
    by_t: dict[str, list[AiRun]] = defaultdict(list)
    for r in sorted(runs, key=lambda r: r.queued_at or ""):
        by_t[r.ticket_id].append(r)
    held_dst = [rows for rows in by_t.values() if any(r.member_id == dst for r in rows)]
    out = []
    for mid in order[i + 1 : j]:
        before = 0
        for rows in held_dst:
            firsts = {}
            for r in rows:
                firsts.setdefault(r.member_id, r.queued_at or "")
            if mid in firsts and firsts[mid] < firsts[dst]:
                before += 1
        if held_dst and before * 2 >= len(held_dst):
            out.append(mid)
    return out


async def team_map(
    session: AsyncSession, project_id: str, range_key: str = "7d"
) -> dict:
    """Who passed work to whom in the range: a box per AI, an arrow per pair and kind, the totals above."""
    if range_key not in RANGES:
        range_key = "7d"
    now = datetime.now(UTC)
    a = window_start(range_key, now)
    d = await health.load(session, project_id, a)
    names = {m.id: m.name for m in d.ais.values()}
    runs = [r for r in d.runs if (parse_iso(r.queued_at) or a) >= a]
    evs = [e for e in d.events if (parse_iso(e["at"]) or a) >= a and e["to"] in names]

    order = usual_order(runs, list(d.ais))
    nodes = []
    for mid in order:
        m = d.ais[mid]
        mine = [r for r in runs if r.member_id == mid]
        durations = [s for r in mine if (s := flow._secs(r.started_at, r.ended_at))]
        nodes.append(
            {
                "id": mid,
                "name": m.name,
                "color": m.color,
                "tickets": len({r.ticket_id for r in mine}),
                "avg_run_s": int(statistics.mean(durations)) if durations else None,
                "asked": len([r for r in mine if loads(r.question, None)]),
            }
        )

    edges: dict[tuple[str, str, str], dict] = {}
    for e in evs:
        src, dst = _ends(e, names)
        if src == dst:
            continue
        kind = (
            "report back"
            if e["kind"] == "report back"
            else "sent back"
            if e["sent_back"]
            else "flow"
        )
        edge = edges.setdefault(
            (src, dst, kind),
            {
                "from": src,
                "to": dst,
                "kind": kind,
                "count": 0,
                "waits": [],
                "tickets": set(),
            },
        )
        edge["count"] += 1
        edge["tickets"].add(e["ticket_id"])
        if e["wait_s"] is not None:
            edge["waits"].append(e["wait_s"])

    def edge_kind(v: dict) -> tuple[str, list[str]]:
        if v["kind"] != "flow" or v["from"] not in order or v["to"] not in order:
            return v["kind"], []
        skipped = skipped_between(runs, order, v["from"], v["to"])
        return ("skip" if skipped else "flow"), [names.get(s, "AI") for s in skipped]

    edge_rows = [
        {
            "from": v["from"],
            "to": v["to"],
            "kind": edge_kind(v)[0],
            "skipped": edge_kind(v)[1],
            "count": v["count"],
            "wait_s": int(statistics.mean(v["waits"])) if v["waits"] else None,
            "tickets": sorted(v["tickets"])[:5],
        }
        for v in edges.values()
    ]
    kinds = Counter(e["kind"] for e in evs)
    sent = [e for e in evs if e["sent_back"]]
    by_target = Counter(names.get(e["to"], "AI") for e in sent)
    measure = health.measure(d, a, now)
    pp = flow.ping_pong(evs)

    done = health.completed(d, a, now)
    touches = [t for t in d.touches if (parse_iso(t["at"]) or a) >= a]
    cost_by_ticket: dict[str, float] = defaultdict(float)
    for r in runs:
        cost_by_ticket[r.ticket_id] += (
            r.cost_usd if (r.metered or r.cost_usd > 0) else 0
        )
    picker = []
    for tid in sorted(
        {r.ticket_id for r in runs},
        key=lambda t: max(r.queued_at for r in runs if r.ticket_id == t),
        reverse=True,
    )[:40]:
        t = d.tickets.get(tid)
        mine = [r for r in runs if r.ticket_id == tid]
        first = min(r.queued_at for r in mine)
        last = max((r.ended_at or r.queued_at) for r in mine)
        picker.append(
            {
                "id": tid,
                "title": t.title if t else "",
                "status": t.status if t else "",
                "elapsed_s": flow._secs(first, last),
                "touches": len([x for x in touches if x["ticket_id"] == tid]),
                "bounced": len([e for e in sent if e["ticket_id"] == tid]),
                "cost_usd": round(cost_by_ticket[tid], 4),
                "completed": any(c.ticket_id == tid for c in done),
            }
        )
    return {
        "range": range_key,
        "since": a.isoformat(),
        "nodes": nodes,
        "edges": edge_rows,
        "tickets": len({r.ticket_id for r in runs}),
        "stats": {
            "handoffs": len(evs),
            # lists, not dicts keyed by a name: the UI camel-cases keys, which would mangle "report back" and AI names
            "kinds": [{"kind": k, "count": n} for k, n in kinds.items()],
            "sent_back": len(sent),
            "sent_back_share": len(sent) / len(evs) if evs else None,
            "sent_back_to": [{"name": k, "count": n} for k, n in by_target.items()],
            "ping_pong": [{"ticket_id": t, "count": n} for t, n in pp.items()],
            "waiting_share": measure["speed"]["waiting_share"],
            "returned": len([e for e in evs if e["returned"]]),
        },
        "picker": picker,
    }


def _docs_block(d: health.Data, page_ids: list[str]) -> list[dict]:
    """The Docs pages a ticket delivered: each published version, and the review threads as resolved, open or orphaned
    (its text changed), with what still needs a person."""
    pages = []
    for pid in page_ids:
        page = d.pages.get(pid)
        if page is None:
            continue
        versions = sorted(
            (v for v in d.versions if v.page_id == pid), key=lambda v: v.version
        )
        threads = []
        for th in d.threads:
            if th.page_id != pid:
                continue
            state = (
                "resolved"
                if th.status == "resolved"
                else "orphaned"
                if th.anchor_state == "orphaned"
                else "open"
            )
            threads.append(
                {
                    "id": th.id,
                    "at": th.created_at,
                    "by": th.created_by,
                    "state": state,
                    "resolved_by": th.resolved_by,
                    "resolved_at": th.resolved_at,
                }
            )
        waiting = len(
            [p for p in d.proposals if p.page_id == pid and p.status == "waiting"]
        )
        counts = Counter(t["state"] for t in threads)
        pages.append(
            {
                "id": pid,
                "title": page.title,
                "version": page.version,
                "versions": [
                    {
                        "version": v.version,
                        "at": v.created_at,
                        "author": v.author,
                        "note": v.note,
                        "with_ai": v.with_ai,
                    }
                    for v in versions
                ],
                "threads": threads,
                "counts": {
                    k: counts.get(k, 0) for k in ("resolved", "open", "orphaned")
                },
                "waiting_proposals": waiting,
                "needs_person": counts.get("open", 0)
                + counts.get("orphaned", 0)
                + waiting,
            }
        )
    return pages


def _parent_block(
    d: health.Data,
    ticket: Ticket,
    children: list[Ticket],
    names: dict[str, str],
    now: datetime,
    done_ids: set[str],
) -> dict:
    """A PM-led lifecycle: a parent ticket with a child per deliverable, who holds each, whether it is delivered and
    what blocks the rest, on one time line."""
    pending: Counter = Counter()
    for ap in d.approvals:
        if ap.status == "pending" and ap.ticket_id:
            pending[ap.ticket_id] += 1
    proposals: Counter = Counter()
    for p in d.proposals:
        if p.status == "waiting" and p.ticket_id:
            proposals[p.ticket_id] += 1
    rows = []
    lead = ticket.assignee
    start = None
    work_by_t: dict[str, list[AiRun]] = defaultdict(list)
    for r in d.runs:
        work_by_t[r.ticket_id].append(r)
    for c in children:
        runs = sorted(work_by_t.get(c.id, []), key=lambda r: r.queued_at or "")
        work = [r for r in runs if r.mode == "work"]
        deliver = (
            health.deliverable_of(d, c.id, work)
            if work
            else {"kind": None, "label": "", "page_ids": []}
        )
        active = [
            r
            for r in runs
            if r.state in ("starting", "running", "needs_input", "queued")
        ]
        asking = [r for r in runs if r.state == "needs_input"]
        waiting_you = pending[c.id] + proposals[c.id] + len(asking)
        pages = _docs_block(d, deliver.get("page_ids", []))
        threads_need = sum(p["counts"]["open"] + p["counts"]["orphaned"] for p in pages)
        held = active[-1] if active else (work[-1] if work else None)
        segs = []
        for r in runs:
            s = parse_iso(r.started_at) or parse_iso(r.queued_at)
            e = _end_of(r, now) or s
            if s and e:
                start = min(start, s) if start else s
                q = loads(r.question, None) or {}
                qa = parse_iso(q.get("asked_at"))
                an = parse_iso(q.get("answered_at")) or (
                    now if r.state == "needs_input" else None
                )
                segs.append(
                    {
                        "member_id": r.member_id,
                        "start": s.isoformat(),
                        "end": e.isoformat(),
                        "wait": {"from": qa.isoformat(), "to": an.isoformat()}
                        if qa and an and an > qa
                        else None,
                        "state": r.state,
                    }
                )
        blockers = [
            b
            for b in loads(c.blocked_by, [])
            if b not in done_ids and any(x.id == b for x in children)
        ]
        if c.id in done_ids:
            state = "delivered_threads" if threads_need else "delivered"
        elif waiting_you:
            state = "waiting_you"
        elif active:
            state = "working"
        elif blockers:
            state = "blocked"
        else:
            state = "not_started"
        rows.append(
            {
                "id": c.id,
                "title": c.title,
                "status": c.status,
                "deliverable": deliver.get("label", ""),
                "deliverable_kind": deliver.get("kind"),
                "held_by": names.get(held.member_id)
                if held
                else names.get(c.assignee or "", None),
                "held_by_id": held.member_id if held else c.assignee,
                "state": state,
                "threads_need": threads_need,
                "waiting_you": waiting_you,
                "proposals": proposals[c.id],
                "blockers": blockers,
                "segments": segs,
            }
        )
    by_id = {r["id"]: r for r in rows}
    alert = None
    for r in rows:
        if r["state"] == "blocked":
            for b in r["blockers"]:
                blocker = by_id.get(b)
                if blocker and blocker["waiting_you"]:
                    bits = []
                    if blocker["proposals"]:
                        bits.append(
                            f"{blocker['proposals']} proposed change{'s' if blocker['proposals'] != 1 else ''}"
                        )
                    other = blocker["waiting_you"] - blocker["proposals"]
                    if other:
                        bits.append(
                            f"{other} question or approval{'s' if other != 1 else ''}"
                        )
                    alert = {
                        "child": r["id"],
                        "blocker": b,
                        "text": f"{r['title']} is blocked. {b} has {' and '.join(bits)} that need you. Nothing else is holding it.",
                    }
                    break
        if alert:
            break
    all_ids = {c.id for c in children} | {ticket.id}
    report_backs = [
        e
        for e in d.events
        if e["ticket_id"] in all_ids
        and e["kind"] == "report back"
        and (not lead or e["to"] == lead)
    ]
    touches = [t for t in d.touches if t["ticket_id"] in all_ids]
    cost = sum(
        r.cost_usd
        for r in d.runs
        if r.ticket_id in all_ids and (r.metered or r.cost_usd > 0)
    )
    waiting_s = 0.0
    for r in d.runs:
        if r.ticket_id in all_ids:
            q = loads(r.question, None) or {}
            qa = parse_iso(q.get("asked_at"))
            an = parse_iso(q.get("answered_at")) or (
                now if r.state == "needs_input" else None
            )
            if qa and an and an > qa:
                waiting_s += (an - qa).total_seconds()
    for ap in d.approvals:
        if ap.ticket_id in all_ids and ap.decided_at:
            waiting_s += max(flow._secs(ap.requested_at, ap.decided_at) or 0, 0)
    counts = Counter(r["state"] for r in rows)
    return {
        "lead": {"id": lead, "name": names.get(lead or "", None)} if lead else None,
        "members": [
            {"id": m.id, "name": m.name, "color": m.color} for m in d.ais.values()
        ],
        "children": rows,
        "start": start.isoformat() if start else None,
        "end": now.isoformat(),
        "alert": alert,
        "report_backs": len(report_backs),
        "tiles": {
            "children": len(rows),
            "delivered": counts["delivered"] + counts["delivered_threads"],
            "waiting": counts["waiting_you"] + counts["blocked"],
            "not_started": counts["not_started"],
            "blocked": counts["blocked"],
            "elapsed_s": int((now - start).total_seconds()) if start else 0,
            "waiting_s": int(waiting_s),
            "touches": len(touches),
            "touches_expected": len(
                [t for t in touches if t["mark"] in ("by_rule", "needed")]
            ),
            "touches_avoidable": len([t for t in touches if t["mark"] == "avoidable"]),
            "cost_usd": round(cost, 4),
        },
    }


async def ticket_journey(
    session: AsyncSession, project_id: str, ticket_id: str
) -> dict | None:
    """One ticket from the first assignment to now: a lane per AI and one for the person, bars for runs, arrows for
    hand-offs, diamonds for every time a person stepped in, and the split of elapsed time."""
    ticket = await session.get(Ticket, ticket_id)
    if ticket is None or ticket.project_id != project_id:
        return None
    now = datetime.now(UTC)
    d = await health.load(session, project_id, datetime(2000, 1, 1, tzinfo=UTC))
    names = {m.id: m.name for m in d.ais.values()}
    runs = sorted(
        [r for r in d.runs if r.ticket_id == ticket_id], key=lambda r: r.queued_at or ""
    )
    children = (
        await session.exec(select(Ticket).where(Ticket.parent_id == ticket_id))
    ).all()
    if not runs and not children:
        return {
            "ticket": {"id": ticket.id, "title": ticket.title, "status": ticket.status},
            "empty": True,
        }
    start = (
        parse_iso(runs[0].queued_at)
        if runs
        else parse_iso(ticket.created_at if hasattr(ticket, "created_at") else None)
    )
    evs = [e for e in d.events if e["ticket_id"] == ticket_id]
    touches = [t for t in d.touches if t["ticket_id"] == ticket_id]

    bars = []
    working = waiting = 0.0
    for r in runs:
        s = parse_iso(r.started_at) or parse_iso(r.queued_at)
        e = _end_of(r, now) or s
        q = loads(r.question, None) or {}
        wait = None
        paused_s = 0.0
        if q.get("asked_at"):
            qa = parse_iso(q["asked_at"])
            an = parse_iso(q.get("answered_at")) or (
                now if r.state == "needs_input" else e
            )
            if qa and an and an > qa:
                wait = {"from": qa.isoformat(), "to": an.isoformat()}
                paused_s = (an - qa).total_seconds()
                waiting += paused_s
        if s and e:
            working += max((e - s).total_seconds() - paused_s, 0)
        report = loads(r.report, {})
        bars.append(
            {
                "run_id": r.id,
                "member_id": r.member_id,
                "number": r.number,
                "state": r.state,
                "trigger": r.trigger,
                "start": s.isoformat() if s else None,
                "end": e.isoformat() if e else None,
                "wait": wait,
                "summary": (r.summary or report.get("summary") or "")[:300],
                "steps": len(loads(r.steps, [])),
                "cost_usd": round(r.cost_usd, 4)
                if (r.metered or r.cost_usd > 0)
                else None,
                "tokens": (r.tokens_in or 0) + (r.tokens_out or 0),
                "ended_reason": r.ended_reason,
                "files": len(loads(r.files, [])),
                "limit_min": r.limit_min,
            }
        )
    for ap in d.approvals:
        if ap.ticket_id == ticket_id and ap.decided_at:
            waiting += max(flow._secs(ap.requested_at, ap.decided_at) or 0, 0)
    last = runs[-1] if runs else None
    end = (_end_of(last, now) if last else None) or now
    elapsed = (end - start).total_seconds() if start and end else 0
    done_ids = {
        c.ticket_id for c in health.completed(d, datetime(2000, 1, 1, tzinfo=UTC), now)
    }
    done = next(
        (
            c
            for c in health.completed(d, datetime(2000, 1, 1, tzinfo=UTC), now)
            if c.ticket_id == ticket_id
        ),
        None,
    )
    work = [r for r in runs if r.mode == "work"]
    deliver = (
        health.deliverable_of(d, ticket_id, work)
        if work
        else {"kind": None, "label": "", "branch": None, "page_ids": [], "files": 0}
    )
    accepted = health.accepted_at(d, ticket_id, work[-1].queued_at) if work else None
    lanes = []
    seen = []
    for r in runs:
        if r.member_id not in seen:
            seen.append(r.member_id)
    for mid in seen:
        m = d.ais.get(mid)
        lanes.append(
            {
                "id": mid,
                "name": m.name if m else names.get(mid, "AI"),
                "color": m.color if m else None,
            }
        )
    cost = sum(r.cost_usd for r in runs if r.metered or r.cost_usd > 0)
    diamonds = [
        {
            "at": t["at"],
            "who": t["who"],
            "via": t["via"],
            "what": t["what"],
            "mark": t["mark"],
            "why": t["why"],
            "details": t["details"],
        }
        for t in touches
    ]
    if runs:
        diamonds.append(
            {
                "at": runs[0].queued_at,
                "who": runs[0].started_by,
                "via": runs[0].started_via,
                "what": "Started it",
                "mark": "start",
                "why": "",
                "details": f"{runs[0].started_by} assigned the ticket to {names.get(runs[0].member_id, 'an AI')}",
            }
        )
    diamonds.sort(key=lambda x: x["at"] or "")
    arrows = [
        {
            "run_id": e["run_id"],
            "at": e["at"],
            "from": e["from"] if e["from"] in names else YOU,
            "to": e["to"],
            "kind": "sent back"
            if e["sent_back"]
            else "returned"
            if e["returned"]
            else e["kind"],
        }
        for e in evs
    ]
    return {
        "ticket": {
            "id": ticket.id,
            "title": ticket.title,
            "status": ticket.status,
            "parent_id": ticket.parent_id,
        },
        "empty": False,
        "start": start.isoformat() if start else None,
        "end": end.isoformat() if end else None,
        "running": bool(
            last and last.state in ("starting", "running", "needs_input", "queued")
        ),
        "lanes": lanes,
        "bars": bars,
        "arrows": arrows,
        "touches": diamonds,
        "strip": {
            "elapsed_s": int(elapsed),
            "working_s": int(min(working, elapsed)),
            "waiting_s": int(min(waiting, elapsed)),
            "between_s": int(max(elapsed - working - waiting, 0)),
            "runs": len(runs),
            "handoffs": len(evs),
            "returned": len([e for e in evs if e["returned"]]),
            "sent_back": len([e for e in evs if e["sent_back"]]),
            "touches": len(touches),
            "touches_needed": len([t for t in touches if t["mark"] == "needed"]),
            "touches_avoidable": len([t for t in touches if t["mark"] == "avoidable"]),
            "cost_usd": round(cost, 4),
            "completed_at": done.at if done else None,
            "deliverable": {
                **deliver,
                "summary": ((last.summary or "")[:200]) if last else "",
                "accepted_at": accepted,
                "pages": [
                    {"id": p, "title": d.pages[p].title, "version": d.pages[p].version}
                    for p in deliver["page_ids"]
                ],
            },
        },
        "docs": _docs_block(d, deliver["page_ids"]),
        "parent": _parent_block(d, ticket, list(children), names, now, done_ids)
        if children
        else None,
        "children": [
            {
                "id": c.id,
                "title": c.title,
                "status": c.status,
                "holder": names.get(c.assignee or "", c.assignee),
                "state": next(
                    (
                        r.state
                        for r in sorted(
                            [x for x in d.runs if x.ticket_id == c.id],
                            key=lambda x: x.queued_at or "",
                            reverse=True,
                        )
                    ),
                    None,
                ),
            }
            for c in children
        ],
    }
