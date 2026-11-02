"""AI Team, Now, While you were away (design/screens/ai-story-flow.md M2): what the team did since a time.

Nothing is tracked for it. It is counted from what the board already keeps: the runs (what finished, failed, cost),
the workflow steps and approvals (each time a person was needed), the questions, the PM's decisions and the Stories'
own history and their tickets' activity log (how far each Story moved). It says plainly when nothing happened
(`ran: false`).
"""

from datetime import UTC, datetime, timedelta

from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from models import AiRun, AiTicketStep, AiTicketWorkflow, Story, Ticket

from . import health, scope
from .store import get_settings, loads, parse_iso

FAILED = ("failed", "timed_out")
# the runs of a ticket the window reads further back than `since`, so a ticket finished early in it has its first run
LOOK_BACK = timedelta(days=30)


def status_at(t: Ticket, at: datetime) -> str | None:
    """The ticket's status at a time, from its activity log; None when it did not exist yet."""
    made = parse_iso(t.created_at)
    if made is not None and made > at:
        return None
    changes = sorted(
        (
            e
            for e in loads(t.activity_log, [])
            if isinstance(e, dict)
            and e.get("field") == "status"
            and parse_iso(e.get("at"))
        ),
        key=lambda e: parse_iso(e["at"]),
    )
    before = [e for e in changes if parse_iso(e["at"]) <= at]
    if before:
        return before[-1].get("to") or t.status
    if changes:
        return changes[0].get("from") or t.status
    return t.status


def story_state_at(row: Story | None, at: datetime) -> str | None:
    """The Story's state at a time, from its history; None when it did not exist yet."""
    if row is None:
        return None
    made = parse_iso(row.created_at)
    if made is not None and made > at:
        return None
    state = "draft"
    for h in sorted(
        (h for h in loads(row.history, []) if isinstance(h, dict)),
        key=lambda h: h.get("at") or "",
    ):
        when = parse_iso(h.get("at"))
        if when is not None and when <= at and h.get("state"):
            state = h["state"]
    return state


def _progress(kids: list[Ticket], row: Story | None, at: datetime) -> dict | None:
    """{state, done, total} of a Story at a time, counted as its card counts: Done of the tickets not dropped."""
    statuses = [st for c in kids if (st := status_at(c, at)) is not None]
    state = story_state_at(row, at)
    if not statuses and state is None:
        return None
    open_ = [st for st in statuses if st != "wont_do"]
    return {
        "state": state,
        "done": len([st for st in open_ if st == "done"]),
        "total": len(open_),
    }


def _priced(r: AiRun) -> float:
    return r.cost_usd if (r.metered or r.cost_usd > 0) else 0.0


async def away(
    session: AsyncSession,
    project_id: str,
    since: datetime,
    now: datetime | None = None,
) -> dict:
    """What happened between `since` and now: the Stories that moved, the tickets that finished, each time a person
    was needed, the decisions taken for them, what it cost, what failed, and how much waits for a person now."""
    from . import decisions, live_feed

    until = now or datetime.now(UTC)
    since = min(since.astimezone(UTC), until)  # stored times are UTC strings
    settings = await get_settings(session, project_id)
    d = await health.load(session, project_id, since - LOOK_BACK)
    rows = await scope.story_rows(session, project_id)
    of = scope.story_of(d.tickets, rows)

    def inside(value: str | None) -> bool:
        at = parse_iso(value)
        return at is not None and since <= at <= until

    def overlaps(r: AiRun) -> bool:
        """The run did something in the window: it was queued, started, wrote, ended there, or is working through it.
        A run that only waits for a person (needs input) is not working."""
        if any(
            inside(v) for v in (r.queued_at, r.started_at, r.last_output_at, r.ended_at)
        ):
            return True
        start = parse_iso(r.queued_at)
        return (
            r.state in ("starting", "running") and start is not None and start <= until
        )

    def story_title(sid: str | None) -> str:
        if sid is None:
            return scope.NOT_IN_STORY
        t = d.tickets.get(sid)
        return t.title if t else ""

    ran = [r for r in d.runs if overlaps(r)]
    evs = [e for e in d.events if inside(e["at"])]

    # the tickets whose AI work was finished in the window (built, not necessarily moved to Done by a person)
    finished = []
    for c in sorted(health.completed(d, since, until), key=lambda c: c.at or ""):
        t = d.tickets.get(c.ticket_id)
        finished.append(
            {
                "ticket_id": c.ticket_id,
                "title": t.title if t else "",
                "story_id": of.get(c.ticket_id),
                "at": c.at,
                "member_id": c.last.member_id,
                "sent_back": len(
                    [
                        e
                        for e in evs
                        if e["ticket_id"] == c.ticket_id
                        and (e["sent_back"] or e["returned"])
                    ]
                ),
            }
        )

    # how far each Story moved: its state and its Done count when you left, and now
    active_stories = {of.get(r.ticket_id) for r in ran} - {None}
    stories = []
    for sid in sorted({s for s in of.values()}):
        t = d.tickets.get(sid)
        if t is None:
            continue
        row = rows.get(sid)
        kids = [c for c in d.tickets.values() if c.parent_id == sid]
        before, after = _progress(kids, row, since), _progress(kids, row, until)
        if after is None or (before == after and sid not in active_stories):
            continue
        stories.append(
            {
                "id": sid,
                "title": t.title,
                "from": before,
                "to": after,
                "runs": len([r for r in ran if of.get(r.ticket_id) == sid]),
            }
        )
    stories.sort(key=lambda s: -s["runs"])

    # each time a person was needed: a question, an approval, a step that waits for a person, a plan to approve.
    # What Autopilot (the PM) answered or decided in the person's place is not counted here: it is in `decided`.
    needed: list[dict] = []
    for r in ran:
        q = loads(r.question, None) or {}
        if not q.get("asked_at") or not inside(q["asked_at"]):
            continue
        if q.get("answered_via") == "autopilot":
            continue
        needed.append(
            {
                "at": q["asked_at"],
                "kind": "question",
                "ticket_id": r.ticket_id,
                "member_id": r.member_id,
                "text": (q.get("text") or "")[:240],
                "open": not q.get("answered_at") and r.state == "needs_input",
            }
        )
    for ap in d.approvals:
        if not inside(ap.requested_at) or ap.decided_via == "autopilot":
            continue
        needed.append(
            {
                "at": ap.requested_at,
                "kind": "approval",
                "ticket_id": ap.ticket_id,
                "member_id": ap.member_id,
                "text": ap.summary[:240],
                "open": ap.status == "pending",
            }
        )
    of_project = select(AiTicketWorkflow.ticket_id).where(
        AiTicketWorkflow.project_id == project_id
    )
    person_steps = (
        await session.exec(
            select(AiTicketStep).where(
                col(AiTicketStep.ticket_id).in_(of_project),
                AiTicketStep.kind == "person",
                AiTicketStep.key != "done",  # moving to Done is the person's by rule
                col(AiTicketStep.started_at) >= since.isoformat(),
                col(AiTicketStep.started_at) <= until.isoformat(),
            )
        )
    ).all()
    for s in person_steps:
        if s.state == "superseded" and not s.ended_at:
            continue
        needed.append(
            {
                "at": s.started_at,
                "kind": "step",
                "ticket_id": s.ticket_id,
                "member_id": None,
                "text": s.label or s.key,
                "open": s.state == "waiting",
            }
        )
    for sid, row in rows.items():
        plan = loads(row.plan, {}) or {}
        if (
            row.approve != "person"
            or not plan.get("version")
            or not inside(plan.get("at"))
        ):
            continue
        needed.append(
            {
                "at": plan["at"],
                "kind": "plan",
                "ticket_id": sid,
                "member_id": row.pm_id,
                "text": f"Plan for {story_title(sid)}",
                "open": bool(plan.get("waiting")) and row.state == "planning",
            }
        )
    for n in needed:
        n["story_id"] = of.get(n["ticket_id"] or "")
    needed.sort(key=lambda n: n["at"] or "")

    # what the PM decided in the person's place, and how many of those can still be overridden
    totals = (await decisions.listing(session, project_id, since=since.isoformat()))[
        "totals"
    ]

    # what it cost: every run that ran in the window, whole
    by_story: dict[str | None, dict] = {}
    for r in ran:
        sid = of.get(r.ticket_id)
        row = by_story.setdefault(
            sid,
            {"story_id": sid, "title": story_title(sid), "usd": 0.0, "tokens": 0},
        )
        row["usd"] += _priced(r)
        row["tokens"] += (r.tokens_in or 0) + (r.tokens_out or 0)
    spent_rows = sorted(
        (
            {**v, "usd": round(v["usd"], 4)}
            for v in by_story.values()
            if v["usd"] or v["tokens"]
        ),
        key=lambda v: (v["story_id"] is None, -v["tokens"], -v["usd"]),
    )

    # what went wrong: the runs that failed in the window, and whether the board (or someone) tried again
    failed = []
    for r in sorted(ran, key=lambda r: r.ended_at or ""):
        if r.state not in FAILED or not inside(r.ended_at):
            continue
        again = [
            x
            for x in d.runs
            if x.ticket_id == r.ticket_id
            and x.id != r.id
            and (x.queued_at or "") > (r.queued_at or "")
            and x.trigger != "autopilot"
        ]
        retry = min(again, key=lambda x: x.queued_at or "") if again else None
        failed.append(
            {
                "run_id": r.id,
                "ticket_id": r.ticket_id,
                "member_id": r.member_id,
                "at": r.ended_at,
                "text": "Ran out of time"
                if r.state == "timed_out"
                else ((r.ended_reason or "").strip().splitlines() or ["Failed"])[0][
                    :240
                ],
                "retried": retry is not None,
                "retry_state": retry.state if retry else None,
            }
        )

    stories_now, titles = await scope.index(session, project_id)
    waiting = await live_feed.needs_you_in(
        session, project_id, scope.Scope("project"), stories_now, titles, until
    )
    return {
        "since": since.isoformat(),
        "until": until.isoformat(),
        "ran": bool(ran or totals["decided"] or needed),
        "paused_all": settings.paused_all,
        "stories": stories,
        "finished": finished,
        "needed": needed,
        "decided": {
            "count": totals["decided"],
            "overridable": totals["overridable"],
        },
        "spent": {
            "usd": round(sum(_priced(r) for r in ran), 4),
            "tokens": sum((r.tokens_in or 0) + (r.tokens_out or 0) for r in ran),
            "by_story": spent_rows,
            "daily_cap": settings.board_daily_cap,
        },
        "failed": failed,
        "waiting": len(waiting),
    }
