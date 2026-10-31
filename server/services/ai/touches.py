"""AI Team, "You stepped in": every time a person acted on AI work, and whether it was needed
(design/screens/ai-team-review.md, A). Worked out from records the app keeps: approvals, Docs proposals, answered
questions, runs started or stopped by hand, edits made during a run, resolved Docs threads and settings changes.

Each touch carries one mark:
  by_rule    the project is set up to ask for it (approvals, Done)
  needed     only a person had the information or the judgement
  avoidable  a setting, a note in the instructions or an automatic retry would have removed it
"""

import re
from datetime import UTC, datetime

from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from models import (
    AiApproval,
    AiAudit,
    AiMember,
    AiRun,
    DocsAiProposal,
    DocsCommentThread,
    DocsPage,
    Member,
    Ticket,
)

from services.docs_ai import proposals

from . import approvals as svc_approvals
from . import permissions as perms
from .store import loads, parse_iso
from .team import RANGES, window_start

MARKS = ("by_rule", "needed", "avoidable")
# What the touch list calls each kind, in the order of the "What you did" bars
KINDS = {
    "approval": "Approved or denied",
    "docs_proposal": "Accepted or rejected a Docs proposal",
    "done": "Moved to Done, past what the AI may do",
    "answer": "Answered a question",
    "thread": "Resolved a Docs review thread",
    "edit": "Edited the ticket while an AI worked",
    "run": "Started or re-ran a run by hand",
    "stop": "Stopped or took over a run",
    "settings": "Changed an AI’s settings",
}
# A question asked again and again with the same answer is a missing line in the instructions
REPEAT_AT = 3
# Run settings whose raising follows a run that hit its limit
LIMIT_KEYS = ("run_timeout_min", "max_runs_per_day", "tokens_per_day", "cap_per_run")
HAND_STARTS = ("run_button", "retry")
LIMIT_REASONS = ("rate", "limit", "timed out", "timeout")


def _norm(text: str | None) -> str:
    return re.sub(r"\W+", " ", (text or "").lower()).strip()


def _in(value: str | None, since: datetime) -> bool:
    at = parse_iso(value)
    return at is not None and at >= since


def _person(name: str | None, ai_names: set[str]) -> bool:
    return (
        bool(name) and name not in ai_names and name not in ("system", "Board", "board")
    )


def _touch(
    *,
    at: str,
    kind: str,
    who: str,
    via: str | None,
    what: str,
    mark: str,
    why: str,
    details: str = "",
    member_id: str | None = None,
    ticket_id: str | None = None,
    ref: dict | None = None,
) -> dict:
    return {
        "at": at,
        "kind": kind,
        "kind_label": KINDS[kind],
        "who": who,
        "via": via,
        "what": what,
        "mark": mark,
        "why": why,
        "details": details,
        "member_id": member_id,
        "ticket_id": ticket_id,
        "ref": ref or {},
    }


def _quote(text: str | None, n: int = 90) -> str:
    text = " ".join((text or "").split())
    return f"“{text[:n]}{'…' if len(text) > n else ''}”"


async def collect(
    session: AsyncSession, project_id: str, since: datetime
) -> list[dict]:
    """Every touch of the project since `since`, newest first, each with its mark and why."""
    ai_members = (
        await session.exec(
            select(Member).where(Member.project_id == project_id, Member.kind == "ai")
        )
    ).all()
    ai_names = {m.name for m in ai_members}
    names = {m.id: m.name for m in ai_members}
    profiles = {
        p.id: p
        for p in (
            await session.exec(
                select(AiMember).where(col(AiMember.id).in_(list(names) or [""]))
            )
        ).all()
    }
    runs = (
        await session.exec(select(AiRun).where(AiRun.project_id == project_id))
    ).all()
    tickets = {
        t.id: t
        for t in (
            await session.exec(select(Ticket).where(Ticket.project_id == project_id))
        ).all()
    }
    touches: list[dict] = []

    # --- approved or denied (the project asks for these)
    approvals = [
        a
        for a in (
            await session.exec(
                select(AiApproval).where(
                    AiApproval.project_id == project_id,
                    col(AiApproval.status).in_(("approved", "denied")),
                )
            )
        ).all()
        if a.decided_by
        and a.decided_via != "autopilot"  # the delegate AI, not a person
        and not svc_approvals.is_proposal(a)
    ]
    tally: dict[tuple[str, str], list[AiApproval]] = {}
    for a in approvals:
        tally.setdefault((a.member_id, a.action), []).append(a)
    for a in approvals:
        if not _in(a.decided_at, since):
            continue
        label = perms.ACTIONS.get(a.action, (a.action,))[0]
        group = tally[(a.member_id, a.action)]
        ok = len([x for x in group if x.status == "approved"])
        mark, why = (
            "by_rule",
            f"Rule: {label.lower()} needs approval. {ok} of {len(group)} approved.",
        )
        if (
            a.action in svc_approvals.ALWAYS_ALLOWED
            and len(group) >= REPEAT_AT
            and ok == len(group)
        ):
            mark = "avoidable"
            why = f"Approved {ok} of {len(group)} times. “Always allow” would remove this."
        touches.append(
            _touch(
                at=a.decided_at,
                kind="approval",
                who=a.decided_by,
                via=a.decided_via,
                what="Approved" if a.status == "approved" else "Denied",
                mark=mark,
                why=why,
                details=a.summary,
                member_id=a.member_id,
                ticket_id=a.ticket_id,
                ref={"type": "approval", "id": a.id},
            )
        )

    # --- Docs proposals (only where Docs AI holds AI edits)
    for p in (
        await session.exec(
            select(DocsAiProposal).where(
                DocsAiProposal.project_id == project_id,
                col(DocsAiProposal.status).in_(("accepted", "partial", "rejected")),
            )
        )
    ).all():
        if not p.decided_by or not _in(p.decided_at, since):
            continue
        changes = loads(p.changes, [])
        taken = len([c for c in changes if c.get("status") == "accepted"])
        page = await session.get(DocsPage, p.page_id)
        title = page.title if page else "a page"
        touches.append(
            _touch(
                at=p.decided_at,
                kind="docs_proposal",
                who=p.decided_by,
                via=None,
                what="Accepted a proposal" if taken else "Rejected a proposal",
                mark="by_rule",
                why="Rule: edit docs needs approval, with a diff.",
                details=f"Accepted {taken} of {len(changes)} changes to the page {title}",
                member_id=p.member_id,
                ticket_id=p.ticket_id,
                ref={"type": "page", "id": p.page_id},
            )
        )

    # --- answered questions
    answered = []
    for r in runs:
        q = loads(r.question, None) or {}
        if (
            q.get("answered_at")
            and q.get("answered_by")
            and q.get("answered_via") != "autopilot"
        ):
            answered.append((r, q))
    for r, q in answered:
        if not _in(q["answered_at"], since):
            continue
        same = [
            (r2, q2)
            for r2, q2 in answered
            if r2.member_id == r.member_id
            and _norm(q2.get("text")) == _norm(q.get("text"))
            and _norm(r2.answer) == _norm(r.answer)
            and q2["answered_at"] <= q["answered_at"]
        ]
        repeat = len(same) >= REPEAT_AT
        ordinal = {3: "3rd", 4: "4th", 5: "5th"}.get(len(same), f"{len(same)}th")
        touches.append(
            _touch(
                at=q["answered_at"],
                kind="answer",
                who=q["answered_by"],
                via=q.get("answered_via"),
                what="Answered a question",
                mark="avoidable" if repeat else "needed",
                why=(
                    f"The {ordinal} time {names.get(r.member_id, 'the AI')} asked this, with the same answer each time."
                    if repeat
                    else "Only a person could supply it."
                ),
                details=f"{_quote(q.get('text'))} → {_quote(r.answer, 60)}",
                member_id=r.member_id,
                ticket_id=r.ticket_id,
                ref={"type": "run", "id": r.id},
            )
        )

    # --- runs started or re-run by hand, stopped, or edited while they worked
    by_ticket: dict[str, list[AiRun]] = {}
    for r in runs:
        by_ticket.setdefault(r.ticket_id, []).append(r)
    for r in runs:
        if (
            r.trigger in HAND_STARTS
            and _person(r.started_by, ai_names)
            and _in(r.queued_at, since)
        ):
            earlier = [
                x
                for x in by_ticket.get(r.ticket_id, [])
                if x.member_id == r.member_id
                and x.queued_at < r.queued_at
                and x.ended_at
            ]
            prev = max(earlier, key=lambda x: x.queued_at) if earlier else None
            reason = ((prev.ended_reason if prev else "") or "").lower()
            hit_limit = (
                prev is not None
                and prev.state in ("timed_out", "failed")
                and any(
                    w in reason or w in prev.state.replace("_", " ")
                    for w in LIMIT_REASONS
                )
            )
            touches.append(
                _touch(
                    at=r.queued_at,
                    kind="run",
                    who=r.started_by,
                    via=r.started_via,
                    what="Re-ran by hand"
                    if r.trigger == "retry" or prev
                    else "Started a run by hand",
                    mark="avoidable" if hit_limit else "needed",
                    why=(
                        "The last run stopped at a limit. A higher limit or an automatic retry would have done it."
                        if hit_limit
                        else "A person chose to run it."
                    ),
                    details=f"Run #{r.number} of {names.get(r.member_id, 'an AI')}",
                    member_id=r.member_id,
                    ticket_id=r.ticket_id,
                    ref={"type": "run", "id": r.id},
                )
            )
        if (
            r.state == "cancelled"
            and r.ended_by
            and _person(r.ended_by, ai_names)
            and _in(r.ended_at, since)
        ):
            touches.append(
                _touch(
                    at=r.ended_at,
                    kind="stop",
                    who=r.ended_by,
                    via=None,
                    what="Took over a run"
                    if r.stop_code == "takeover"
                    else "Stopped a run",
                    mark="needed",
                    why="A person decided the run should not go on.",
                    details=f"Run #{r.number} of {names.get(r.member_id, 'an AI')}"
                    + (f": {r.ended_reason}" if r.ended_reason else ""),
                    member_id=r.member_id,
                    ticket_id=r.ticket_id,
                    ref={"type": "run", "id": r.id},
                )
            )
        for note in loads(r.context_notes, []):
            if _person(note.get("by"), ai_names) and _in(note.get("at"), since):
                touches.append(
                    _touch(
                        at=note["at"],
                        kind="edit",
                        who=note["by"],
                        via=None,
                        what="Edited the ticket during a run",
                        mark="needed",
                        why="A person changed the ticket while the AI worked; the AI was told.",
                        details=note.get("what") or "",
                        member_id=r.member_id,
                        ticket_id=r.ticket_id,
                        ref={"type": "run", "id": r.id},
                    )
                )

    # --- moved to Done by a person where the AI could only go as far as Review
    for t in tickets.values():
        mine = [r for r in by_ticket.get(t.id, []) if r.mode == "work"]
        if not mine:
            continue
        for e in loads(t.activity_log, []):
            if (
                e.get("field") == "status"
                and e.get("to") == "done"
                and _person(e.get("actor"), ai_names)
                and _in(e.get("at"), since)
            ):
                last = max(mine, key=lambda x: x.queued_at)
                profile = profiles.get(last.member_id)
                ceiling = profile.ceiling if profile else "review"
                if ceiling == "done":
                    continue
                touches.append(
                    _touch(
                        at=e["at"],
                        kind="done",
                        who=e["actor"],
                        via=None,
                        what="Moved to Done",
                        mark="by_rule",
                        why=f"The AI may go up to {ceiling.replace('_', ' ').title()}; Done is a person’s step.",
                        details=t.title,
                        member_id=last.member_id,
                        ticket_id=t.id,
                        ref={"type": "ticket", "id": t.id},
                    )
                )

    # --- resolved Docs review threads that an AI opened
    for th in (
        await session.exec(
            select(DocsCommentThread)
            .join(DocsPage, DocsPage.id == DocsCommentThread.page_id)
            .where(
                DocsPage.project_id == project_id,
                DocsCommentThread.status == "resolved",
            )
        )
    ).all():
        if (
            th.created_by in ai_names
            and _person(th.resolved_by, ai_names)
            and _in(th.resolved_at, since)
        ):
            page = await session.get(DocsPage, th.page_id)
            touches.append(
                _touch(
                    at=th.resolved_at,
                    kind="thread",
                    who=th.resolved_by,
                    via=None,
                    what="Resolved a review thread",
                    mark="needed",
                    why="A review thread closes when a person agrees the text is fixed.",
                    details=f"Thread by {th.created_by} on {page.title if page else 'a page'}",
                    member_id=next(
                        (i for i, n in names.items() if n == th.created_by), None
                    ),
                    ref={"type": "page", "id": th.page_id},
                )
            )

    # --- changed an AI's settings
    for row in (
        await session.exec(
            select(AiAudit).where(
                AiAudit.project_id == project_id, AiAudit.action == "member_updated"
            )
        )
    ).all():
        if not _in(row.created_at, since) or not _person(row.on_behalf_of, ai_names):
            continue
        detail = loads(row.detail, {})
        changes = detail.get("changes") or {}
        raised = [k for k in changes if k in LIMIT_KEYS or k.startswith("config.")]
        shown = ", ".join(
            f"{k.replace('_', ' ')} {v[0]} → {v[1]}"
            for k, v in list(changes.items())[:3]
            if isinstance(v, (list, tuple)) and len(v) == 2
        )
        limits = [k for k in raised if k.replace("config.", "") in LIMIT_KEYS]
        touches.append(
            _touch(
                at=row.created_at,
                kind="settings",
                who=row.on_behalf_of,
                via=detail.get("via"),
                what="Changed settings",
                mark="avoidable" if limits else "needed",
                why="A limit was raised after runs hit it."
                if limits
                else "A person chose the setting.",
                details=shown or "Member settings",
                member_id=row.member_id,
                ref={"type": "audit", "id": row.id},
            )
        )

    touches.sort(key=lambda t: t["at"] or "", reverse=True)
    return touches


def _per_ai(
    touches: list[dict], runs: list[AiRun], ais: dict[str, Member]
) -> list[dict]:
    out = []
    for mid, m in ais.items():
        n_runs = len([r for r in runs if r.member_id == mid])
        n_touch = len([t for t in touches if t["member_id"] == mid])
        out.append(
            {
                "id": mid,
                "name": m.name,
                "color": m.color,
                "runs": n_runs,
                "touches": n_touch,
                "per_10_runs": round(n_touch * 10 / n_runs, 1) if n_runs else None,
            }
        )
    out.sort(key=lambda r: -(r["per_10_runs"] or 0))
    return out


async def stepped_in(
    session: AsyncSession,
    project_id: str,
    range_key: str = "7d",
    *,
    mark: str | None = None,
    member_id: str | None = None,
    person: str | None = None,
    via: str | None = None,
) -> dict:
    """The You stepped in tab: totals, a bar per kind, touches per 10 runs by AI and the touch list (filtered)."""
    if range_key not in RANGES:
        range_key = "7d"
    now = datetime.now(UTC)
    since = window_start(range_key, now)
    touches = await collect(session, project_id, since)
    ais = {
        m.id: m
        for m in (
            await session.exec(
                select(Member).where(
                    Member.project_id == project_id, Member.kind == "ai"
                )
            )
        ).all()
    }
    runs = [
        r
        for r in (
            await session.exec(select(AiRun).where(AiRun.project_id == project_id))
        ).all()
        if _in(r.queued_at, since)
    ]
    tickets_touched = len({t["ticket_id"] for t in touches if t["ticket_id"]})
    tickets_with_ai = len({r.ticket_id for r in runs})
    totals = {
        "touches": len(touches),
        "tickets": tickets_with_ai,
        "per_ticket": round(len(touches) / tickets_with_ai, 1)
        if tickets_with_ai
        else None,
        "by_rule": len([t for t in touches if t["mark"] == "by_rule"]),
        "needed": len([t for t in touches if t["mark"] == "needed"]),
        "avoidable": len([t for t in touches if t["mark"] == "avoidable"]),
        "via_mcp": len([t for t in touches if t["via"] == "mcp"]),
        "tickets_touched": tickets_touched,
    }
    kinds = []
    for key, label in KINDS.items():
        rows = [t for t in touches if t["kind"] == key]
        if not rows:
            continue
        kinds.append(
            {
                "key": key,
                "label": label,
                **{m: len([t for t in rows if t["mark"] == m]) for m in MARKS},
                "total": len(rows),
            }
        )
    people = sorted({t["who"] for t in touches})
    items = [
        t
        for t in touches
        if (not mark or t["mark"] == mark)
        and (not member_id or t["member_id"] == member_id)
        and (not person or t["who"] == person)
        and (not via or t["via"] == via)
    ]
    for t in items:
        t["member_name"] = ais[t["member_id"]].name if t["member_id"] in ais else None
    titles = {
        t.id: t.title
        for t in (
            await session.exec(
                select(Ticket).where(
                    col(Ticket.id).in_(
                        [i["ticket_id"] for i in items if i["ticket_id"]] or [""]
                    )
                )
            )
        ).all()
    }
    for t in items:
        t["ticket_title"] = titles.get(t["ticket_id"])
    return {
        "range": range_key,
        "since": since.isoformat(),
        "totals": totals,
        "kinds": kinds,
        "per_ai": _per_ai(touches, runs, ais),
        "people": people,
        "items": items,
        "docs_proposals_held": await proposals.holds_ai_edits(session, project_id),
    }
