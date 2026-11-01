"""Noticing things: five signals the board does not watch for today (design/screens/ai-board-wave3.md, F; D25 level 1).

The board-health insights are all about the board (stuck tickets, too much in progress, nothing assigned); these are
about the AIs. All of them are computed by code, so watching costs nothing:

- **ai_hang**: a running AI the watchdog diagnosed (services/ai/watchdog.py) and nobody acted on.
- **ai_failing**: an AI whose last three runs failed.
- **quota_near**: a Claude account past 80% of a usage window.
- **needs_queue**: Needs you is long (more than five rows) or its oldest row is older than four hours.
- **arbitration_wait**: a disagreement sent to the coordinator that has not been picked up for 40 minutes.

Each finding has the shape of a board-health insight ({kind, key, ticket_id, title, detail, data, score, action}) so
the same cards show it, and standing orders (services/ai/orders.py) fire on the same findings.
"""

import json
from datetime import UTC, datetime, timedelta

from sqlmodel import col, select

from models import (
    AiAccountState,
    AiMember,
    AiRun,
    AiTicketFlag,
    AiTicketWorkflow,
    Member,
    Notification,
)

from . import quota
from .store import loads

KINDS = ("ai_hang", "ai_failing", "quota_near", "needs_queue", "arbitration_wait")
# What standing orders also fire on, besides the cards (design G "Rules that come ready-made")
RULE_KINDS = (*KINDS, "run_failed_network", "review_stale", "ci_red")
REVIEW_STALE = timedelta(hours=24)
FAILING_RUNS = 3
QUEUE_LONG = 5
QUEUE_OLD = timedelta(hours=4)
ARBITRATION_WAIT = timedelta(minutes=40)


def _age(iso: str | None) -> timedelta:
    try:
        return datetime.now(UTC) - datetime.fromisoformat(iso) if iso else timedelta(0)
    except ValueError:
        return timedelta(0)


def _mins(td: timedelta) -> int:
    return int(td.total_seconds() // 60)


async def compute(session, project_id: str) -> list[dict]:
    """The AI signals of a project right now."""
    out: list[dict] = []
    names = {
        m.id: m.name
        for m in (
            await session.exec(select(Member).where(Member.project_id == project_id))
        ).all()
    }
    running = (
        await session.exec(
            select(AiRun).where(
                AiRun.project_id == project_id, AiRun.state == "running"
            )
        )
    ).all()
    for run in running:
        diag = loads(run.diagnosis, {}) or {}
        if (
            not diag
            or diag.get("cleared_at")
            or diag.get("trigger") == "The run stopped"
        ):
            continue
        who = names.get(run.member_id, "An AI")
        out.append(
            {
                "kind": "ai_hang",
                "key": f"ai_hang:{run.id}",
                "ticket_id": run.ticket_id,
                "run_id": run.id,
                "member_id": run.member_id,
                "title": f"{who} has produced nothing for {max(1, int(diag.get('quiet_s', 0)) // 60)} minutes on {run.ticket_id}",
                "detail": f"{diag.get('what', '')} {diag.get('means', '')}".strip(),
                "data": {
                    "cause": diag.get("cause"),
                    "actions": diag.get("actions") or [],
                    "minutes": int(diag.get("quiet_s", 0)) // 60,
                },
                "score": 9,
                "action": {
                    "stop_child": "Stop that command",
                    "continue_note": "Continue with a note",
                }.get((diag.get("actions") or ["wait"])[0], "Open the run"),
            }
        )
    profiles = (
        await session.exec(select(AiMember).where(AiMember.project_id == project_id))
    ).all()
    for p in profiles:
        last = (
            await session.exec(
                select(AiRun)
                .where(
                    AiRun.member_id == p.id,
                    col(AiRun.state).in_(
                        ["finished", "failed", "timed_out", "cancelled"]
                    ),
                )
                .order_by(col(AiRun.ended_at).desc())
                .limit(FAILING_RUNS)
            )
        ).all()
        if len(last) == FAILING_RUNS and all(
            r.state in ("failed", "timed_out") for r in last
        ):
            boards = sum(
                1 for r in last if (loads(r.diagnosis, {}) or {}).get("board_fault")
            )
            out.append(
                {
                    "kind": "ai_failing",
                    "key": f"ai_failing:{p.id}:{last[0].id}",
                    "ticket_id": last[0].ticket_id,
                    "run_id": last[0].id,
                    "member_id": p.id,
                    "title": f"{names.get(p.id, 'An AI')}'s last {FAILING_RUNS} runs failed",
                    "detail": (last[0].ended_reason or "")[:200]
                    + (
                        f" {boards} of them were board faults, not the AI's."
                        if boards
                        else ""
                    ),
                    "data": {"runs": [r.id for r in last], "board_faults": boards},
                    "score": 8,
                    "action": "Retry the last one at a higher effort",
                }
            )
    keys = {p.account_id or quota.LOCAL for p in profiles if p.connection != "api_key"}
    for key in keys:
        row = await session.get(AiAccountState, key)
        if row is None:
            continue
        for window, used, resets in (
            ("5-hour", row.five_hour_used, row.five_hour_resets_at),
            ("weekly", row.seven_day_used, row.seven_day_resets_at),
        ):
            if used is not None and used >= quota.NEAR:
                out.append(
                    {
                        "kind": "quota_near",
                        "key": f"quota_near:{key}:{window}:{(resets or '')[:13]}",
                        "ticket_id": None,
                        "account_key": key,
                        "title": f"The account's {window} window is {int(used * 100)}% used",
                        "detail": f"It reopens {resets[11:16] if resets else 'later'}. Work that is not urgent can wait for it.",
                        "data": {"used": used, "window": window, "resets_at": resets},
                        "score": 6,
                        "action": "Hold low-priority work",
                    }
                )
    needs = (
        await session.exec(
            select(Notification).where(
                Notification.project_id == project_id,
                Notification.needs == True,  # noqa: E712
                col(Notification.done_at).is_(None),
            )
        )
    ).all()
    if needs:
        oldest = min(needs, key=lambda n: n.created_at)
        age = _age(oldest.created_at)
        groups = {n.group_key for n in needs}
        if len(groups) > QUEUE_LONG or age > QUEUE_OLD:
            approvals = sum(1 for n in needs if n.kind == "approval")
            out.append(
                {
                    "kind": "needs_queue",
                    "key": f"needs_queue:{project_id}:{datetime.now(UTC).strftime('%Y-%m-%d')}",
                    "ticket_id": None,
                    "title": f"Needs you has {len(groups)} items, the oldest from {age.days and f'{age.days} days ago' or f'{_mins(age)} minutes ago'}",
                    "detail": f"{approvals} are approvals Autopilot could answer under its current ceiling."
                    if approvals
                    else "Oldest first in the Needs you tab.",
                    "data": {
                        "count": len(groups),
                        "approvals": approvals,
                        "oldest_min": _mins(age),
                    },
                    "score": 7,
                    "action": "Show me the approvals"
                    if approvals
                    else "Open Needs you",
                }
            )
    waiting = (
        await session.exec(
            select(AiTicketFlag).where(
                AiTicketFlag.project_id == project_id,
                AiTicketFlag.kind == "arbitration",
                col(AiTicketFlag.resolved_at).is_(None),
            )
        )
    ).all()
    for flag in waiting:
        age = _age(flag.created_at)
        if age < ARBITRATION_WAIT:
            continue
        wf = await session.get(AiTicketWorkflow, flag.ticket_id)
        out.append(
            {
                "kind": "arbitration_wait",
                "key": f"arbitration_wait:{flag.id}",
                "ticket_id": flag.ticket_id,
                "title": f"{flag.ticket_id} has been waiting for arbitration for {_mins(age)} minutes",
                "detail": (json.loads(flag.data or "{}").get("why") or "")[:200],
                "data": {
                    "minutes": _mins(age),
                    "run_id": wf.arbitration_run_id if wf else None,
                },
                "score": 7,
                "action": "Run the arbitration now",
            }
        )
    return out


async def for_rules(session, project_id: str) -> list[dict]:
    """The signals standing orders fire on: the cards above, plus runs that failed on the network, tickets sitting in
    Review, and red CI on a pull request the board opened (wave 3, J)."""
    from models import Ticket

    out = await compute(session, project_id)
    since = (datetime.now(UTC) - timedelta(minutes=30)).isoformat()
    failed = (
        await session.exec(
            select(AiRun).where(
                AiRun.project_id == project_id,
                AiRun.state == "failed",
                col(AiRun.ended_at) >= since,
            )
        )
    ).all()
    for run in failed:
        diag = loads(run.diagnosis, {}) or {}
        if diag.get("cause") == "network":
            out.append(
                {
                    "kind": "run_failed_network",
                    "key": f"run_failed_network:{run.id}",
                    "ticket_id": run.ticket_id,
                    "run_id": run.id,
                    "member_id": run.member_id,
                    "title": f"Run #{run.number} on {run.ticket_id} failed on the network",
                    "detail": diag.get("what") or "",
                    "data": {},
                    "score": 5,
                    "action": "Try once more",
                }
            )
    for t in (
        await session.exec(
            select(Ticket).where(
                Ticket.project_id == project_id, Ticket.status == "review"
            )
        )
    ).all():
        log = loads(t.activity_log, []) or []
        moved = (
            next(
                (
                    e.get("at")
                    for e in reversed(log)
                    if e.get("field") == "status" and e.get("to") == "review"
                ),
                None,
            )
            or t.updated_at
        )
        age = _age(moved)
        if age >= REVIEW_STALE:
            out.append(
                {
                    "kind": "review_stale",
                    "key": f"review_stale:{t.id}:{(moved or '')[:10]}",
                    "ticket_id": t.id,
                    "title": f"{t.id} has been in Review for {age.days or 1} day{'s' if age.days != 1 else ''}",
                    "detail": "Nobody moved or commented on it since.",
                    "data": {"hours": int(age.total_seconds() // 3600)},
                    "score": 4,
                    "action": "Remind",
                }
            )
    from . import github

    out += await github.signals(session, project_id)
    return out
