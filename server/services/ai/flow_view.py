"""AI Team, Flow: the team map and the journey of one ticket (design/screens/ai-team.md, C and D)."""

import dataclasses
import statistics
from collections import Counter, defaultdict
from datetime import UTC, datetime

from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from models import AiMember, AiRun, Ticket

from . import flow, health, pause_log, scope
from .store import get_settings, loads, parse_iso
from .team import RANGES, window_start

YOU = "you"
LIVE_STATES = ("queued", "starting", "running", "needs_input")
_LIVE_LABEL = {
    "queued": "queued",
    "starting": "working",
    "running": "working",
    "needs_input": "waiting_you",
}
_LIVE_RANK = {"working": 0, "waiting_you": 1, "queued": 2}


def _live_row(r: AiRun, names: dict[str, str], tickets: dict[str, Ticket]) -> dict:
    """What an active run is doing right now: who, on which ticket, since when and its latest step."""
    chain = loads(r.chain, [])
    steps = [
        s for s in loads(r.steps, []) if s.get("kind") not in ("system", "compact")
    ]
    t = tickets.get(r.ticket_id)
    now = datetime.now(UTC)
    since = parse_iso(r.started_at) or parse_iso(r.queued_at)
    return {
        "run_id": r.id,
        "member_id": r.member_id,
        "member_name": names.get(r.member_id, "AI"),
        "ticket_id": r.ticket_id,
        "ticket_title": t.title if t else "",
        "state": _LIVE_LABEL.get(r.state, r.state),
        "mode": r.mode,
        "trigger": r.trigger,
        "sender": chain[-1] if chain else r.started_by,
        "elapsed_s": int((now - since).total_seconds()) if since else None,
        "step": (steps[-1].get("text") or "")[:140] if steps else "",
    }


async def live_runs(session: AsyncSession, project_id: str) -> list[dict]:
    """Every run that is queued, working or waiting for a person, the busiest first."""
    runs = (
        await session.exec(
            select(AiRun).where(
                AiRun.project_id == project_id, col(AiRun.state).in_(LIVE_STATES)
            )
        )
    ).all()
    if not runs:
        return []
    from models import Member

    members = (
        await session.exec(select(Member).where(Member.project_id == project_id))
    ).all()
    names = {m.id: m.name for m in members}
    tickets = {
        t.id: t
        for t in (
            await session.exec(
                select(Ticket).where(col(Ticket.id).in_({r.ticket_id for r in runs}))
            )
        ).all()
    }
    rows = [_live_row(r, names, tickets) for r in runs]
    for r, row in zip(runs, rows, strict=True):
        if r.trigger in flow.WORKFLOW_TRIGGERS:
            # the board moved the ticket on: the hand-off under way is from the AI of the step before (D14)
            before = (
                await session.exec(
                    select(AiRun)
                    .where(
                        AiRun.ticket_id == r.ticket_id,
                        col(AiRun.queued_at) < (r.queued_at or ""),
                        AiRun.trigger != "autopilot",
                    )
                    .order_by(col(AiRun.queued_at).desc())
                )
            ).first()
            if before is not None:
                row["sender"] = before.member_id
    return sorted(
        rows, key=lambda x: (_LIVE_RANK.get(x["state"], 3), -(x["elapsed_s"] or 0))
    )


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


EPOCH = datetime(2000, 1, 1, tzinfo=UTC)
# Over this many arrows the map draws the ones that carry weight and folds the rest into one chip (H2)
MAP_EDGES = 12
# Arrows that are never folded: what goes back, the PM's plan
_KEEP_KINDS = ("sent back", "returned", "plan")


def _edge_rows(
    evs: list[dict],
    names: dict[str, str],
    order: list[str],
    runs: list[AiRun],
    live: list[dict],
) -> list[dict]:
    """One arrow per pair and kind for these hand-off events, with the mean wait and whether one is under way."""
    edges: dict[tuple[str, str, str], dict] = {}
    for e in evs:
        src, dst = _ends(e, names)
        checks = e.get("via") == flow.CHECKS
        if src == dst and not checks:
            continue  # the Checks sending the Dev's work back is the one loop onto the same AI
        if e["kind"] == "report back":
            kind = "report back"
        elif e["sent_back"]:
            kind = "sent back"
        elif e["returned"] and e.get("workflow"):
            # a workflow's first review round going back (normal): not a hand-off forward, not counted as sent back
            kind = "returned"
        elif e.get("skipped"):
            kind = "skip"  # the workflow went past a step it skipped for this ticket
        else:
            kind = "flow"
        edge = edges.setdefault(
            (src, dst, kind),
            {
                "from": src,
                "to": dst,
                "kind": kind,
                "count": 0,
                "waits": [],
                "tickets": set(),
                "runs": set(),
                "skipped": [],
                "workflow": False,
                "via": flow.CHECKS if checks else None,
            },
        )
        edge["count"] += 1
        edge["tickets"].add(e["ticket_id"])
        edge["runs"].add(e["run_id"])
        edge["workflow"] = edge["workflow"] or bool(e.get("workflow"))
        for label in e.get("skipped") or []:
            if label not in edge["skipped"]:
                edge["skipped"].append(label)
        if e["wait_s"] is not None:
            edge["waits"].append(e["wait_s"])

    def edge_kind(v: dict) -> tuple[str, list[str]]:
        if v["kind"] == "skip":
            return "skip", v["skipped"]  # the step rows say what was skipped
        if (
            v["kind"] != "flow"
            or v[
                "workflow"
            ]  # a workflow's steps are its template's: no step is skipped by guess
            or v["from"] not in order
            or v["to"] not in order
        ):
            return v["kind"], []
        skipped = skipped_between(runs, order, v["from"], v["to"])
        return ("skip" if skipped else "flow"), [names.get(s, "AI") for s in skipped]

    # the runs under way: the hand-off that started one of them is moving on the map
    live_ids = {x["run_id"] for x in live if x["trigger"] != "autopilot"}
    rows = []
    for v in edges.values():
        kind, skipped = edge_kind(v)
        rows.append(
            {
                "from": v["from"],
                "to": v["to"],
                "kind": kind,
                "skipped": skipped,
                "via": v["via"],
                "count": v["count"],
                "wait_s": int(statistics.mean(v["waits"])) if v["waits"] else None,
                "tickets": sorted(v["tickets"])[:5],
                # a hand-off between these two is under way: the receiver is queued or working on it
                "live": bool(v["runs"] & live_ids)
                or (
                    v["via"] is None
                    and any(
                        x["sender"] == v["from"]
                        and x["member_id"] == v["to"]
                        and x["trigger"] != "autopilot"
                        and x["trigger"] not in flow.WORKFLOW_TRIGGERS
                        for x in live
                    )
                ),
            }
        )
    return rows


def _plan_edges(
    pm: str, sc: scope.Scope, runs: list[AiRun], live: list[dict]
) -> list[dict]:
    """The Story's spoke: one arrow from the PM to each AI that held one of the Story's tickets. The board starts each
    ticket from the PM's plan; the step rows still name the AI before as the sender, so the arrow is drawn from who
    held which child, not from a recorded hand-off."""
    kids = {c.id for c in sc.children}
    held: dict[str, set[str]] = defaultdict(set)
    first: dict[tuple[str, str], AiRun] = {}
    for r in sorted(runs, key=lambda r: r.queued_at or ""):
        if r.ticket_id not in kids or r.member_id == pm or r.trigger == "autopilot":
            continue
        held[r.member_id].add(r.ticket_id)
        first.setdefault((r.ticket_id, r.member_id), r)
    live_ids = {x["run_id"] for x in live}
    out = []
    for mid, tickets in held.items():
        out.append(
            {
                "from": pm,
                "to": mid,
                "kind": "plan",
                "skipped": [],
                "via": None,
                "count": len(tickets),
                "wait_s": None,
                "tickets": sorted(tickets)[:5],
                # the AI is on its first run of a ticket of the plan: the plan just gave it the ticket
                "live": any(
                    first[(t, mid)].id in live_ids for t in tickets if (t, mid) in first
                ),
            }
        )
    return out


def fold(edges: list[dict], limit: int = MAP_EDGES) -> tuple[list[dict], dict]:
    """Past `limit` arrows, keep the ones that carry weight (what goes back, the plan, what moves now, then the
    largest counts) and fold the rest: `{count: hand-offs folded, edges}`."""
    if len(edges) <= limit:
        return edges, {"count": 0, "edges": []}
    must = [i for i, e in enumerate(edges) if e["live"] or e["kind"] in _KEEP_KINDS]
    rest = sorted(
        (i for i in range(len(edges)) if i not in must),
        key=lambda i: (-edges[i]["count"], i),
    )
    keep = set(must) | set(rest[: max(limit - len(must), 0)])
    kept = [e for i, e in enumerate(edges) if i in keep]
    folded = [e for i, e in enumerate(edges) if i not in keep]
    folded.sort(key=lambda e: -e["count"])
    return kept, {"count": sum(e["count"] for e in folded), "edges": folded}


async def _pm_of(
    session: AsyncSession, project_id: str, sc: scope.Scope, names: dict[str, str]
) -> str | None:
    """Who runs the Story: its PM, else the AI the parent ticket is given to, else the project's coordinator."""
    from . import workflow

    for mid in (
        sc.story_row.pm_id if sc.story_row else None,
        sc.story.assignee if sc.story else None,
    ):
        if mid and mid in names:
            return mid
    pm = await workflow.coordinator(session, project_id)
    return pm.id if pm is not None and pm.id in names else None


def _clusters(
    d: health.Data,
    rows: dict,
    runs: list[AiRun],
    evs: list[dict],
    names: dict[str, str],
    order: list[str],
    live: list[dict],
    only: str | None = None,
) -> list[dict]:
    """Whose work it is (H): one cluster per Story with AI work in the range, the busiest first, then one for the
    tickets that are in no Story. Each carries its share of every arrow."""
    of = scope.story_of(d.tickets, rows)
    by: dict[str | None, list[AiRun]] = defaultdict(list)
    for r in runs:
        by[of.get(r.ticket_id)].append(r)
    if only is not None:
        by = {only: by.get(only, [])}
    out = []
    for sid, mine in by.items():
        ids = {r.ticket_id for r in mine}
        share = [e for e in evs if e["ticket_id"] in ids]
        edges = [
            {"from": e["from"], "to": e["to"], "kind": e["kind"], "count": e["count"]}
            for e in _edge_rows(share, names, order, runs, live)
        ]
        if sid is None:
            title, state = scope.NOT_IN_STORY, None
            kids = [d.tickets[t] for t in ids if t in d.tickets]
        else:
            t = d.tickets.get(sid)
            row = rows.get(sid)
            kids = [c for c in d.tickets.values() if c.parent_id == sid]
            title, state = (t.title if t else ""), (row.state if row else None)
        # counted as the Story card counts: Done of the tickets not dropped (Won't do)
        kids = [c for c in kids if c.status != "wont_do"]
        done = len([c for c in kids if c.status == "done"])
        total = len(kids)
        out.append(
            {
                "story_id": sid,
                "title": title,
                "state": state,
                "done": done,
                "total": total,
                "tickets": len(ids),
                "ticket_ids": sorted(ids),
                "handoffs": len(share),
                "edges": edges,
                "runs": len(mine),
                "last_at": max((r.queued_at or "" for r in mine), default=None),
                "live": any(x["ticket_id"] in ids for x in live),
            }
        )
    out.sort(
        key=lambda c: (
            c["story_id"] is None,
            -c["runs"],
            "".join(chr(255 - ord(ch)) for ch in (c["last_at"] or "")),
        )
    )
    return out


async def team_map(
    session: AsyncSession,
    project_id: str,
    range_key: str | None = "7d",
    *,
    story: str | None = None,
    ticket: str | None = None,
) -> dict | None:
    """Who passed work to whom in the range and the scope: a box per AI, an arrow per pair and kind, the totals above,
    the Stories as clusters under the map. None when the Story or the ticket is not in the project.

    A Story or a ticket with no range is shown over its whole life (range "all")."""
    sc = await scope.resolve(session, project_id, story=story, ticket=ticket)
    if sc is None:
        return None
    whole = range_key == "all" or (range_key is None and sc.level != "project")
    if not whole and range_key not in RANGES:
        range_key = "7d"
    now = datetime.now(UTC)
    if whole:
        range_key = "all"
        d = await health.load(session, project_id, EPOCH)
        a = min(
            (
                at
                for r in d.runs
                if sc.has(r.ticket_id) and (at := parse_iso(r.queued_at))
            ),
            default=now,
        )
    else:
        a = window_start(range_key, now)
        d = await health.load(session, project_id, a)
    names = {m.id: m.name for m in d.ais.values()}
    runs = [
        r for r in d.runs if sc.has(r.ticket_id) and (parse_iso(r.queued_at) or a) >= a
    ]
    evs = [
        e
        for e in d.events
        if sc.has(e["ticket_id"])
        and (parse_iso(e["at"]) or a) >= a
        and e["to"] in names
    ]

    live = [x for x in await live_runs(session, project_id) if sc.has(x["ticket_id"])]
    settings = await get_settings(session, project_id)
    profiles = {
        p.id: p
        for p in (
            await session.exec(
                select(AiMember).where(col(AiMember.id).in_(list(d.ais) or [""]))
            )
        ).all()
    }
    pm = await _pm_of(session, project_id, sc, names) if sc.level == "story" else None
    order = usual_order(runs, list(d.ais))
    if sc.level != "project":
        # one Story or one ticket: the AIs that took part, the PM first as the hub
        involved = (
            {r.member_id for r in runs}
            | {x["member_id"] for x in live}
            | {e["from"] for e in evs if e["from"] in names}
            | {e["to"] for e in evs}
            | ({pm} if pm else set())
        )
        order = sorted(
            (m for m in order if m in involved), key=lambda m: (m != pm, order.index(m))
        )
    kids = {c.id for c in sc.children}
    nodes = []
    for mid in order:
        m = d.ais[mid]
        mine = [r for r in runs if r.member_id == mid]
        mine_live = next((x for x in live if x["member_id"] == mid), None)
        held = len(
            [
                r
                for r in d.runs
                if r.member_id == mid
                and r.state == "queued"
                and r.mode == "work"
                and sc.has(r.ticket_id)
            ]
        )
        # The map is history, so nothing on it is erased; while the project is paused each box says where its AI
        # stands now (design/screens/ai-paused.md, D2)
        profile = profiles.get(mid)
        offline = (profile.health if profile else "") in (
            "runner_missing",
            "not_logged_in",
            "key_invalid",
            "model_retired",
        )
        tag = None
        if settings.paused_all or (profile and profile.paused):
            tag = (
                "offline"
                if offline
                else "waiting"
                if mine_live and mine_live.get("state") == "waiting_you"
                else "paused"
            )
        durations = [s for r in mine if (s := flow._secs(r.started_at, r.ended_at))]
        held_ids = sorted({r.ticket_id for r in mine})
        if mid == pm:
            held_ids = sorted(
                set(held_ids) | kids
            )  # the PM runs the Story: every ticket of it is in its box
        nodes.append(
            {
                "id": mid,
                "name": m.name,
                "color": m.color,
                # inside a Story the box lists its tickets (I); elsewhere it counts them
                "tickets": held_ids if sc.level == "story" else len(held_ids),
                "ticket_count": len(held_ids),
                "live_ticket": mine_live["ticket_id"] if mine_live else None,
                "hub": mid == pm,
                "avg_run_s": int(statistics.mean(durations)) if durations else None,
                "asked": len([r for r in mine if loads(r.question, None)]),
                # what this AI is doing right now (the busiest of its active runs), None when idle
                "live": mine_live,
                "live_count": len([x for x in live if x["member_id"] == mid]),
                "pause_tag": tag,
                "held": held if settings.paused_all else 0,
            }
        )

    edge_rows = _edge_rows(evs, names, order, runs, live)
    if pm:
        edge_rows = _plan_edges(pm, sc, runs, live) + edge_rows
    edge_rows, folded = fold(edge_rows)
    kinds = Counter(e["kind"] for e in evs)
    sent = [e for e in evs if e["sent_back"]]
    by_target = Counter(names.get(e["to"], "AI") for e in sent)
    # the measures of the scope only: its runs, hand-offs and touches
    ds = (
        d
        if sc.ids is None
        else dataclasses.replace(
            d,
            runs=[r for r in d.runs if sc.has(r.ticket_id)],
            events=[e for e in d.events if sc.has(e["ticket_id"])],
            touches=[t for t in d.touches if sc.has(t["ticket_id"])],
        )
    )
    measure = health.measure(ds, a, now)
    pp = flow.ping_pong(evs)

    done = health.completed(ds, a, now)
    rows = await scope.story_rows(session, project_id)
    of = scope.story_of(d.tickets, rows)
    clusters = (
        _clusters(d, rows, runs, evs, names, order, live)
        if sc.level == "project"
        else _clusters(d, rows, runs, evs, names, order, live, sc.story.id)
        if sc.level == "story" and sc.story is not None
        else []
    )
    touches = [t for t in ds.touches if (parse_iso(t["at"]) or a) >= a]
    cost_by_ticket: dict[str, float] = defaultdict(float)
    for r in runs:
        cost_by_ticket[r.ticket_id] += (
            r.cost_usd if (r.metered or r.cost_usd > 0) else 0
        )
    picker = []
    live_by_ticket: dict[str, list[dict]] = defaultdict(list)
    for x in live:
        live_by_ticket[x["ticket_id"]].append(x)
    for tid in sorted(
        {r.ticket_id for r in runs},
        key=lambda t: (
            t not in live_by_ticket,
            "".join(
                chr(255 - ord(ch))
                for ch in max(r.queued_at for r in runs if r.ticket_id == t)
            ),
        ),
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
                "story_id": of.get(tid),
                "elapsed_s": flow._secs(first, last),
                "touches": len([x for x in touches if x["ticket_id"] == tid]),
                "bounced": len([e for e in sent if e["ticket_id"] == tid]),
                "cost_usd": round(cost_by_ticket[tid], 4),
                "completed": any(c.ticket_id == tid for c in done),
                "live": live_by_ticket.get(tid, [])[:3],
            }
        )
    return {
        "scope": sc.out(),
        "live": live[:12],
        "paused_all": settings.paused_all,
        "paused_at": settings.paused_at if settings.paused_all else None,
        "range": range_key,
        "since": a.isoformat(),
        "nodes": nodes,
        "edges": edge_rows,
        "folded": folded,
        "clusters": clusters,
        # inside a Story its own ticket (the PM's planning and review) is not one of its tickets
        "tickets": len(
            {r.ticket_id for r in runs}
            - ({sc.story.id} if sc.level == "story" and sc.story else set())
        ),
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
    for tid in d.canvas_open:  # a canvas proposal waits for a person like a Docs one
        proposals[tid] += 1
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


async def _ticket_scope(session: AsyncSession, ticket: Ticket) -> dict:
    """What the One ticket scope adds (J): the steps of its workflow, as the ticket's own workflow strip reads them,
    and the Story (or parent) it is in, for the crumb."""
    from . import workflow

    parent = await session.get(Ticket, ticket.parent_id) if ticket.parent_id else None
    return {
        "workflow": await workflow.view(session, ticket.id),
        "story": {"id": parent.id, "title": parent.title} if parent else None,
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
    extra = await _ticket_scope(session, ticket)
    if not runs and not children:
        return {
            "ticket": {"id": ticket.id, "title": ticket.title, "status": ticket.status},
            "empty": True,
            **extra,
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
    step_of = {s.run_id: s for s in d.steps if s.run_id}
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
                # the workflow step this run did (None for an odd job)
                "step": step_of[r.id].label if r.id in step_of else None,
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
                "details": f"The board took the ticket in and gave it to {names.get(runs[0].member_id, 'an AI')}"
                if flow.is_board(runs[0].started_by)
                else f"{runs[0].started_by} assigned the ticket to {names.get(runs[0].member_id, 'an AI')}",
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
            else "skip"
            if e.get("skipped")
            else e["kind"],
            # the workflow steps this hand-off went past, and "checks" when the Checks sent the work back
            "skipped": e.get("skipped") or [],
            "via": e.get("via"),
        }
        for e in evs
    ]
    pauses = await pause_log.intervals(session, project_id, start, now) if start else []
    paused_s = pause_log.overlap_s(pauses, start, now) if start else 0.0
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
        "live": [
            x
            for x in await live_runs(session, project_id)
            if x["ticket_id"] == ticket_id
        ],
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
            # Paused time is counted apart: it is not waiting for a person and not a bottleneck
            "paused_s": int(paused_s),
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
        **extra,
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
