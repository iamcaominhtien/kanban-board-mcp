"""The AI Team view (design/screens/ai-team.md): what each AI is doing now, what waits for a person, and how work
passed between the AIs. Everything is worked out from records the app already keeps (runs, approvals, Docs
proposals, members), so it works for any project and any date range."""

from datetime import UTC, datetime, timedelta

from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from models import AiApproval, AiRun, DocsAiProposal, DocsPage, Member, Ticket

from . import approvals as svc_approvals
from . import budget
from . import members as svc_members
from . import permissions as perms
from .store import get_settings, loads, parse_iso

RANGES = ("today", "7d", "30d")
# Member states a card can show; `offline` covers a runner or key that cannot be used (the member's own status)
OFFLINE = ("key_invalid", "not_logged_in", "runner_missing", "model_retired")
ACTIVE = ("queued", "starting", "running", "needs_input")
# How a hand-off arrived: what the app recorded in the run's trigger
HANDOFF_KINDS = {
    "assign": "assigned",
    "run_button": "assigned",
    "retry": "assigned",
    "schedule": "assigned",
    "mention": "mention",
    "reply": "mention",
    "ask": "mention",
    "handoff": "hand-off",
    "report_back": "report back",
    "request_changes": "sent back",
    "answer": "answered",
}
SPARK_POINTS = 7
RECENT_HANDOFFS = 8


def window_start(range_key: str, now: datetime | None = None) -> datetime:
    """When `range_key` begins: local midnight for today, else that many days back."""
    now = now or datetime.now(UTC)
    if range_key == "today":
        return budget.today_start()
    return now - timedelta(days=7 if range_key == "7d" else 30)


def _ago_s(value: str | None, now: datetime) -> int | None:
    at = parse_iso(value)
    return max(0, int((now - at).total_seconds())) if at else None


def _spark(runs: list[AiRun], since: datetime, now: datetime) -> list[int]:
    """Runs started so far at SPARK_POINTS even steps of the window (a rising line), for a card's trend."""
    starts = sorted(at for r in runs if (at := parse_iso(r.queued_at)) is not None)
    span = max((now - since).total_seconds(), 1.0)
    out = []
    for i in range(SPARK_POINTS):
        edge = since + timedelta(seconds=span * i / (SPARK_POINTS - 1))
        out.append(len([at for at in starts if at <= edge]) if i else 0)
    return out


def _last_step(run: AiRun) -> dict | None:
    steps = loads(run.steps, [])
    shown = [s for s in steps if s.get("kind") not in ("system", "compact")]
    if not shown:
        return None
    last = shown[-1]
    return {
        "n": len(steps),
        "kind": last.get("kind"),
        "text": (last.get("text") or "")[:160],
    }


def _run_ref(run: AiRun, tickets: dict[str, Ticket]) -> dict:
    t = tickets.get(run.ticket_id)
    return {
        "run_id": run.id,
        "number": run.number,
        "ticket_id": run.ticket_id,
        "ticket_title": t.title if t else None,
        "state": run.state,
        "mode": run.mode,
    }


def _state_of(status_code: str, active: list[AiRun], waiting_approval: bool) -> str:
    """working | waiting | queued | paused | offline | idle: what a glance says about this AI."""
    if status_code in OFFLINE:
        return "offline"
    if any(r.state == "needs_input" for r in active) or waiting_approval:
        return "waiting"
    if any(r.state in ("starting", "running") for r in active):
        return "working"
    if status_code in ("paused", "paused_all", "over_budget", "rate_limited"):
        return "paused"
    if any(r.state == "queued" for r in active):
        return "queued"
    return "idle"


def _usage_of(member: dict, runs: list[AiRun]) -> dict:
    """What the member's runs in the window did. A priced (API-key) member shows dollars; a runner that reports none
    shows tokens, never $0, and says which kind of count it is."""
    metered = member["connection"] == "api_key"
    ended = [
        r for r in runs if r.state in ("finished", "failed", "cancelled", "timed_out")
    ]
    out = {
        "runs": len(runs),
        "ok": len([r for r in ended if r.state == "finished"]),
        "failed": len([r for r in ended if r.state in ("failed", "timed_out")]),
        "metered": metered,
    }
    if metered:
        out["cost_usd"] = round(sum(r.cost_usd for r in runs if r.metered), 4)
        out["daily_budget"] = member.get("daily_budget")
    else:
        out["tokens"] = sum((r.tokens_in or 0) + (r.tokens_out or 0) for r in runs)
        cached = [r.tokens_cached for r in runs if r.tokens_cached is not None]
        if cached:
            # Claude Code counts the cached context on every call: shown apart so a number is not misread
            out["tokens_cached"] = sum(cached)
        out["tokens_kind"] = "new_and_cached" if cached else "input_per_call"
        # a local runner that also prices its runs (Claude Code reports a cost) keeps it as a note
        priced = sum(r.cost_usd for r in runs)
        out["cost_usd"] = round(priced, 4) if priced else None
    return out


def _question_of(run: AiRun) -> dict | None:
    q = loads(run.question, None)
    if not q or q.get("answered_at"):
        return None
    return {
        "text": q.get("text"),
        "asked_at": q.get("asked_at"),
        "options": q.get("options") or [],
    }


async def _members_by_id(session: AsyncSession, project_id: str) -> dict[str, Member]:
    rows = (
        await session.exec(select(Member).where(Member.project_id == project_id))
    ).all()
    return {m.id: m for m in rows}


def _who(member_id: str | None, people_and_ais: dict[str, Member]) -> dict:
    """A hand-off end: an AI member, or a person (`You` is shown for the person looking at the board)."""
    m = people_and_ais.get(member_id or "")
    if m is not None:
        return {
            "id": m.id,
            "name": m.name,
            "color": m.color,
            "kind": "ai" if m.kind == "ai" else "person",
        }
    return {
        "id": member_id or "user",
        "name": member_id or "You",
        "color": None,
        "kind": "person",
    }


def _handoffs(
    runs: list[AiRun],
    tickets: dict[str, Ticket],
    people: dict[str, Member],
    now: datetime,
    limit: int,
) -> list[dict]:
    """Recent hand-offs, newest first. A run is a hand-off when it came from someone else: the sender is the last of
    its chain, or the person who started it. Its kind is the trigger the app recorded."""
    out = []
    for r in sorted(runs, key=lambda r: r.queued_at, reverse=True):
        asked = loads(r.question, None)
        if asked:
            # an AI that asks a person is a hand-off to that person
            t = tickets.get(r.ticket_id)
            at = asked.get("asked_at") or r.queued_at
            out.append(
                {
                    "run_id": r.id,
                    "at": at,
                    "ago_s": _ago_s(at, now),
                    "kind": "asked you",
                    "trigger": "question",
                    "from": _who(r.member_id, people),
                    "to": _who(r.started_by, people),
                    "ticket_id": r.ticket_id,
                    "ticket_title": t.title if t else None,
                    "note": None,
                }
            )
        if r.trigger == "autopilot":
            continue  # the delegate answering for the owner is not work passed on
        chain = loads(r.chain, [])
        sender = chain[-1] if chain else r.started_by
        if sender == r.member_id:
            continue
        t = tickets.get(r.ticket_id)
        out.append(
            {
                "run_id": r.id,
                "at": r.queued_at,
                "ago_s": _ago_s(r.queued_at, now),
                "kind": HANDOFF_KINDS.get(r.trigger, r.trigger),
                "trigger": r.trigger,
                "from": _who(sender, people),
                "to": _who(r.member_id, people),
                "ticket_id": r.ticket_id,
                "ticket_title": t.title if t else None,
                "note": (r.instruction or "").strip().splitlines()[0][:120]
                if (r.instruction or "").strip()
                else None,
            }
        )
    out.sort(key=lambda h: h["at"], reverse=True)
    return out[:limit]


async def needs_you(
    session: AsyncSession,
    project_id: str,
    members: list[dict],
    active: list[AiRun],
    tickets: dict[str, Ticket],
    now: datetime,
) -> list[dict]:
    """Everything that cannot move without a person, oldest first: a question an AI asked, an action waiting for
    approval, a member that is offline, a Docs change waiting for a decision."""
    items: list[dict] = []
    names = {m["id"]: m["name"] for m in members}
    for r in active:
        q = _question_of(r) if r.state == "needs_input" else None
        if q is None:
            continue
        t = tickets.get(r.ticket_id)
        items.append(
            {
                "kind": "question",
                "since": q["asked_at"] or r.ended_at or r.started_at or r.queued_at,
                "member_id": r.member_id,
                "member_name": names.get(r.member_id),
                "ticket_id": r.ticket_id,
                "ticket_title": t.title if t else None,
                "run_id": r.id,
                "text": q["text"],
                "options": q["options"],
                "blocks": r.ticket_id,
            }
        )
    for a in await svc_approvals.list_approvals(session, project_id, status="pending"):
        if a.get("proposal_id"):
            continue  # shown once, as the Docs change it belongs to
        items.append(
            {
                "kind": "approval",
                "since": a["requested_at"],
                "member_id": a["member_id"],
                "member_name": a.get("member_name") or names.get(a["member_id"]),
                "ticket_id": a.get("ticket_id"),
                "ticket_title": a.get("target_title"),
                "run_id": a.get("run_id"),
                "approval_id": a["id"],
                "action": a["action"],
                "action_label": perms.ACTIONS.get(a["action"], (a["action"],))[0],
                "text": a["summary"],
                "risk": a["risk"],
                "always_allowed": a.get("always_allowed", False),
                "diff": a.get("diff") or [],
                "blocks": a.get("ticket_id"),
            }
        )
    for m in members:
        code = m["status"]["code"]
        if code not in OFFLINE:
            continue
        since = m.get("checked_at") or m.get("created_at")
        queued = sorted(
            {
                r.ticket_id
                for r in active
                if r.member_id == m["id"] and r.state == "queued"
            }
            | {t["id"] for t in m["assigned"]}
        )
        items.append(
            {
                "kind": "offline",
                "since": since,
                "member_id": m["id"],
                "member_name": m["name"],
                "text": m["status"].get("detail") or m["status"]["label"],
                "label": m["status"]["label"],
                "tickets_waiting": queued,
            }
        )
    proposals = (
        await session.exec(
            select(DocsAiProposal).where(
                DocsAiProposal.project_id == project_id,
                DocsAiProposal.status == "waiting",
            )
        )
    ).all()
    pages = {
        p.id: p
        for p in (
            await session.exec(
                select(DocsPage).where(
                    col(DocsPage.id).in_([p.page_id for p in proposals] or [""])
                )
            )
        ).all()
    }
    for p in proposals:
        page = pages.get(p.page_id)
        t = tickets.get(p.ticket_id or "")
        changes = loads(p.changes, [])
        items.append(
            {
                "kind": "docs_proposal",
                "since": p.created_at,
                "member_id": p.member_id,
                "member_name": names.get(p.member_id),
                "ticket_id": p.ticket_id,
                "ticket_title": t.title if t else None,
                "page_id": p.page_id,
                "page_title": page.title if page else None,
                "page_version": page.version if page else None,
                "proposal_id": p.id,
                "changes": len(
                    [c for c in changes if c.get("status", "pending") == "pending"]
                ),
                "text": p.summary,
                "blocks": p.ticket_id,
            }
        )
    items.sort(key=lambda i: i["since"] or "")
    for i in items:
        i["waiting_s"] = _ago_s(i["since"], now)
    return items


async def now_view(
    session: AsyncSession, project_id: str, range_key: str = "today"
) -> dict:
    """The Now tab: a card per AI, what needs a person, the latest hand-offs and the totals for the range."""
    if range_key not in RANGES:
        range_key = "today"
    now = datetime.now(UTC)
    since = window_start(range_key, now)
    settings = await get_settings(session, project_id)
    members = await svc_members.list_members(session, project_id)
    people = await _members_by_id(session, project_id)

    in_window = list(
        (
            await session.exec(
                select(AiRun)
                .where(
                    AiRun.project_id == project_id, AiRun.queued_at >= since.isoformat()
                )
                .order_by(col(AiRun.queued_at))
            )
        ).all()
    )
    active = list(
        (
            await session.exec(
                select(AiRun).where(
                    AiRun.project_id == project_id, col(AiRun.state).in_(ACTIVE)
                )
            )
        ).all()
    )
    seen = {r.id for r in in_window}
    for r in active:
        if r.id not in seen:
            in_window.append(r)
    ticket_ids = {r.ticket_id for r in in_window}
    approvals_waiting = (
        await session.exec(
            select(AiApproval).where(
                AiApproval.project_id == project_id, AiApproval.status == "pending"
            )
        )
    ).all()
    ticket_ids |= {a.ticket_id for a in approvals_waiting if a.ticket_id}
    props = (
        await session.exec(
            select(DocsAiProposal.ticket_id).where(
                DocsAiProposal.project_id == project_id,
                DocsAiProposal.status == "waiting",
            )
        )
    ).all()
    ticket_ids |= {t for t in props if t}
    for m in members:
        ticket_ids |= {t["id"] for t in m["assigned"]}
    tickets = {
        t.id: t
        for t in (
            await session.exec(
                select(Ticket).where(col(Ticket.id).in_(list(ticket_ids) or [""]))
            )
        ).all()
    }
    waiting_for = {a.member_id for a in approvals_waiting}

    cards = []
    for m in members:
        mine_active = sorted(
            [r for r in active if r.member_id == m["id"]], key=lambda r: r.queued_at
        )
        mine = [r for r in in_window if r.member_id == m["id"]]
        state = _state_of(m["status"]["code"], mine_active, m["id"] in waiting_for)
        current = next(
            (
                r
                for r in mine_active
                if r.state in ("starting", "running", "needs_input")
            ),
            None,
        )
        queued = [r for r in mine_active if r.state == "queued"]
        last = (
            await session.exec(
                select(AiRun)
                .where(
                    AiRun.member_id == m["id"],
                    col(AiRun.state).in_(
                        ("finished", "failed", "timed_out", "cancelled")
                    ),
                )
                .order_by(col(AiRun.ended_at).desc())
                .limit(1)
            )
        ).first()
        last_ticket = tickets.get(last.ticket_id) if last else None
        if last and last_ticket is None:
            last_ticket = await session.get(Ticket, last.ticket_id)
        limit_min = None
        if current is not None and m["connection"] == "api_key":
            limit_min = current.limit_min or (m.get("config") or {}).get(
                "run_timeout_min"
            )
        pause = None
        if settings.paused_all or m["paused"]:
            stopped = (
                last
                if last is not None
                and last.state == "cancelled"
                and (last.ended_reason or "").startswith("Pause all AI")
                and settings.paused_at
                and (last.ended_at or "") >= settings.paused_at
                else None
            )
            pause = {
                "project": bool(settings.paused_all),
                # Paused on its own too (a person, a budget, a rate limit): Resume does not start it
                "own": bool(m["paused"])
                or m["status"]["code"] in ("over_budget", "rate_limited"),
                "own_label": m["status"]["detail"] or m["status"]["label"],
                "cancelled": {
                    "ticket_id": stopped.ticket_id,
                    "step": len(loads(stopped.steps, [])),
                    "at": stopped.ended_at,
                }
                if stopped is not None
                else None,
            }
        cards.append(
            {
                "id": m["id"],
                "name": m["name"],
                "color": m["color"],
                "glyph": m["glyph"],
                "provider": m["provider"],
                "provider_label": m["provider_label"],
                "connection": m["connection"],
                "model": m["model"],
                "state": state,
                "status": m["status"],
                # A local runner whose state was never read: not offline, and not known to be fine
                "connection_unknown": m["connection"] != "api_key"
                and m["connection"] != "inbox"
                and m["health"] in (None, "", "unknown"),
                "paused": m["paused"],
                "pause": pause,
                "current": {
                    **_run_ref(current, tickets),
                    "step": _last_step(current),
                    "elapsed_s": _ago_s(current.started_at or current.queued_at, now),
                    "limit_min": limit_min,
                    "paused": bool(current.paused),
                    "question": _question_of(current),
                }
                if current is not None
                else None,
                "queued": [_run_ref(r, tickets) for r in queued],
                "assigned": [t["id"] for t in m["assigned"]],
                "last": {
                    **_run_ref(last, tickets),
                    "summary": last.summary,
                    "ended_at": last.ended_at,
                    "ago_s": _ago_s(last.ended_at, now),
                    "usage": _usage_of(m, [last]),
                }
                if last is not None
                else None,
                "usage": _usage_of(m, mine),
                "spark": _spark(mine, since, now),
            }
        )

    metered_total = sum(r.cost_usd for r in in_window if r.metered)
    ended = [
        r
        for r in in_window
        if r.state in ("finished", "failed", "cancelled", "timed_out")
    ]
    total = {
        "runs": len(in_window),
        "ok": len([r for r in ended if r.state == "finished"]),
        "failed": len([r for r in ended if r.state in ("failed", "timed_out")]),
        "running": len([r for r in in_window if r.state in ("starting", "running")]),
        "spent_usd": round(metered_total, 4),
        "daily_cap": settings.board_daily_cap,
    }
    from . import touches as svc_touches

    total["touches"] = len(await svc_touches.collect(session, project_id, since))
    items = await needs_you(session, project_id, members, active, tickets, now)
    from . import autopilot as svc_autopilot

    cfg = svc_autopilot.config(settings)
    total["autopilot"] = {
        "on": bool(cfg["enabled"] and cfg["delegate_id"]),
        "delegate": next(
            (m["name"] for m in members if m["id"] == cfg["delegate_id"]), None
        ),
        "grace_min": cfg["grace_min"],
        "decided": await svc_autopilot.decided_since(session, project_id, since),
    }
    counts: dict[str, int] = {}
    for c in cards:
        counts[c["state"]] = counts.get(c["state"], 0) + 1
    return {
        "range": range_key,
        "since": since.isoformat(),
        "generated_at": now.isoformat(),
        "paused_all": settings.paused_all,
        "members": cards,
        "counts": counts,
        "needs_you": items,
        "handoffs": _handoffs(in_window, tickets, people, now, RECENT_HANDOFFS),
        "totals": total,
        # Docs proposals only exist when Docs AI holds the AI's edits for review: the screen leaves them out otherwise
        "docs_proposals_held": await _holds_edits(session, project_id),
    }


async def _holds_edits(session: AsyncSession, project_id: str) -> bool:
    from services.docs_ai import proposals

    return await proposals.holds_ai_edits(session, project_id)
