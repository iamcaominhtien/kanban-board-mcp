"""What the PM decided in a person's place, and the way back (design/screens/ai-story-flow.md M1).

The manager records a row each time the PM approves a design, sends one back, splits a ticket, retries a step or
approves its own plan; Autopilot records the permissions it decided and the questions it answered for the person.
Override puts the decision back in the person's hands while nothing was built on it yet; past that point the row
says plainly why it can no longer be undone.
"""

import json
from datetime import UTC, datetime

from sqlmodel import col, select

from models import (
    AiDecision,
    AiRun,
    AiTicketStep,
    AiTicketWorkflow,
    Member,
    Story,
    Ticket,
)

KINDS = (
    "approve_design",
    "send_back",
    "split",
    "retry",
    "answer",
    "permission",
    "approve_plan",
)


class DecisionError(Exception):
    """A decision that cannot be overridden (the API answers 409)."""


def _now() -> str:
    return datetime.now(UTC).isoformat()


def ref_of(d: AiDecision) -> dict:
    """The decision's reference (step, run, pieces) as a dict."""
    try:
        data = json.loads(d.ref or "{}")
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


async def story_of(session, ticket_id: str | None) -> str | None:
    """The Story a ticket belongs to: itself when it is one, else its parent when that is one."""
    if not ticket_id:
        return None
    t = await session.get(Ticket, ticket_id)
    if t is None:
        return None
    if t.type == "story":
        return t.id
    if t.parent_id:
        parent = await session.get(Ticket, t.parent_id)
        if parent is not None and parent.type == "story":
            return parent.id
    return None


async def record(
    session,
    project_id: str,
    *,
    kind: str,
    title: str,
    ticket_id: str | None = None,
    why: str = "",
    member_id: str | None = None,
    ref: dict | None = None,
) -> AiDecision:
    """A decision the PM took for the person, committed."""
    d = AiDecision(
        project_id=project_id,
        ticket_id=ticket_id,
        story_id=await story_of(session, ticket_id),
        member_id=member_id,
        kind=kind,
        title=title[:300],
        why=(why or "")[:1500],
        ref=json.dumps(ref or {}),
    )
    session.add(d)
    await session.commit()
    await session.refresh(d)
    return d


async def _after_rows(
    session, ticket_id: str, step_id: str
) -> tuple[AiTicketStep | None, list[AiTicketStep]]:
    from . import workflow

    rows = await workflow.steps_of(session, ticket_id)
    row = next((r for r in rows if r.id == step_id), None)
    if row is None:
        return None, []
    return row, [r for r in rows if r.seq > row.seq and r.state != "superseded"]


async def _started(session, rows: list[AiTicketStep]) -> AiTicketStep | None:
    """The first row after the decision that someone already built on: done, or a run that left the queue."""
    for r in rows:
        if r.state in ("done", "failed"):
            return r
        if r.run_id:
            run = await session.get(AiRun, r.run_id)
            if run is not None and run.state not in ("queued", "cancelled"):
                return r
    return None


async def _pieces_started(session, pieces: list[str]) -> str | None:
    if not pieces:
        return None
    run = (
        await session.exec(
            select(AiRun).where(col(AiRun.ticket_id).in_(pieces)).limit(1)
        )
    ).first()
    return run.ticket_id if run else None


async def why_not(session, d: AiDecision) -> str | None:
    """Why Override is no longer possible, or None while it is."""
    if d.state != "in_effect":
        return "It was already overridden."
    ref = ref_of(d)
    if d.kind == "retry":
        return "A retry is a run, and a run cannot be un-run."
    if d.kind == "answer":
        return "The AI went on with the answer."
    if d.kind == "permission":
        return "The permission was used."
    if d.kind in ("approve_design", "send_back"):
        row, after = await _after_rows(
            session, d.ticket_id or "", ref.get("step_id") or ""
        )
        if row is None:
            return "The step is gone from the workflow."
        wf = await session.get(AiTicketWorkflow, d.ticket_id)
        if wf is None or wf.state in ("done", "detached"):
            return "The workflow has ended."
        built = await _started(session, after)
        if built is not None:
            return f"The next step ({built.label}) has started. Send the ticket back from the ticket instead."
        return None
    if d.kind == "split":
        started = await _pieces_started(session, ref.get("pieces") or [])
        if started:
            return f"{started} has started. Change the plan in the Story page instead."
        return None
    if d.kind == "approve_plan":
        story = await session.get(Story, d.story_id or d.ticket_id or "")
        if story is None or story.state not in ("in_progress", "planning"):
            return "The Story has moved past its plan."
        items = [
            i.get("ticket_id")
            for i in (json.loads(story.plan or "{}").get("items") or [])
        ]
        started = await _pieces_started(session, [i for i in items if i])
        if started:
            return f"{started} has started. Change the plan instead."
        return None
    return "This kind of decision cannot be undone."


def _result(d: AiDecision, blocked: str | None) -> str:
    if d.state == "overridden":
        return f"Overridden by {d.overridden_by or 'a person'}" + (
            f": {d.override_note}" if d.override_note else ""
        )
    if blocked:
        return blocked
    return {
        "approve_design": "In effect: the next step has not started yet.",
        "send_back": "In effect: the step it went back to has not started yet.",
        "split": "In effect: no piece has started yet.",
        "approve_plan": "In effect: no ticket of the plan has started yet.",
    }.get(d.kind, "In effect.")


async def view(session, d: AiDecision, names: dict | None = None) -> dict:
    """The decision as the API hands it out."""
    blocked = await why_not(session, d)
    member = None
    if d.member_id:
        name = (names or {}).get(d.member_id)
        if name is None:
            m = await session.get(Member, d.member_id)
            name = m.name if m else None
        member = {"id": d.member_id, "name": name or "PM"}
    story_title = None
    if d.story_id:
        t = await session.get(Ticket, d.story_id)
        story_title = t.title if t else None
    can = d.state == "in_effect" and blocked is None
    return {
        "id": d.id,
        "at": d.at,
        "kind": d.kind,
        "title": d.title,
        "why": d.why,
        "ticket_id": d.ticket_id,
        "story_id": d.story_id,
        "story_title": story_title,
        "member": member,
        "state": d.state,
        "can_override": can,
        "why_not": None if can or d.state != "in_effect" else blocked,
        "result": _result(d, None if can else blocked),
        "overridden_by": d.overridden_by,
        "overridden_at": d.overridden_at,
        "override_note": d.override_note,
    }


async def listing(
    session,
    project_id: str,
    *,
    story: str | None = None,
    kind: str | None = None,
    overridden: bool | None = None,
    since: str | None = None,
    limit: int = 100,
) -> dict:
    """The decisions, newest first, with the totals of the tab (M1)."""
    q = select(AiDecision).where(AiDecision.project_id == project_id)
    if story:
        q = q.where(AiDecision.story_id == story)
    if since:
        q = q.where(col(AiDecision.at) >= since)
    rows = list((await session.exec(q.order_by(col(AiDecision.at).desc()))).all())
    names = {
        m.id: m.name
        for m in (
            await session.exec(
                select(Member).where(
                    col(Member.id).in_(
                        {r.member_id for r in rows if r.member_id} or {""}
                    )
                )
            )
        ).all()
    }
    views = [await view(session, r, names) for r in rows]
    totals = {
        "decided": len(views),
        "in_effect": len([v for v in views if v["state"] == "in_effect"]),
        "overridable": len([v for v in views if v["can_override"]]),
        "overridden": len([v for v in views if v["state"] == "overridden"]),
        "final": len(
            [v for v in views if v["state"] == "in_effect" and not v["can_override"]]
        ),
    }
    kinds: dict[str, int] = {}
    for v in views:
        kinds[v["kind"]] = kinds.get(v["kind"], 0) + 1
    if kind:
        views = [v for v in views if v["kind"] == kind]
    if overridden is not None:
        views = [v for v in views if (v["state"] == "overridden") == overridden]
    return {
        "items": views[: max(1, min(limit, 500))],
        "totals": totals,
        "kinds": [{"kind": k, "count": n} for k, n in kinds.items()],
    }


async def _back_to_person(session, d: AiDecision, by: str) -> None:
    """The approval step waits for the person again: what came after it is pending again, its queued runs cancelled."""
    from . import workflow

    ref = ref_of(d)
    row, after = await _after_rows(session, d.ticket_id or "", ref.get("step_id") or "")
    if row is None:
        raise DecisionError("The step is gone from the workflow.")
    rows = await workflow.steps_of(session, d.ticket_id)
    base_seq = max(r.seq for r in rows) + 1
    to_cancel = []
    latest: dict[int, AiTicketStep] = {}
    for r in [row, *after]:
        latest[r.idx] = r
    fresh_wait = None
    for i, idx in enumerate(sorted(latest)):
        old = latest[idx]
        if old.state in ("pending", "active", "waiting", "blocked"):
            if old.run_id:
                to_cancel.append(old.run_id)
            old.state = "superseded"
            session.add(old)
        fresh = AiTicketStep(
            ticket_id=old.ticket_id,
            seq=base_seq + i,
            idx=old.idx,
            key=old.key,
            label=old.label,
            kind=old.kind,
            role=old.role,
            attempt=old.attempt,
            state="waiting" if idx == row.idx else "pending",
            started_at=_now() if idx == row.idx else None,
            note_in=(
                f"The PM's decision was overridden by {by}: it waits for you."
                if idx == row.idx
                else None
            ),
        )
        session.add(fresh)
        if idx == row.idx:
            fresh_wait = fresh
    await session.commit()
    await workflow._cancel_runs(
        to_cancel, by=by, reason=f"{by} overrode the PM's decision."
    )
    ticket = await session.get(Ticket, d.ticket_id)
    if ticket is not None and fresh_wait is not None:
        await workflow._tell_person(session, ticket, fresh_wait)


async def override(
    session, decision_id: str, *, by: str, note: str | None = None
) -> dict:
    """Undo a decision the PM took for the person, while nothing was built on it."""
    d = await session.get(AiDecision, decision_id)
    if d is None:
        raise LookupError("Decision not found")
    blocked = await why_not(session, d)
    if blocked:
        raise DecisionError(blocked)
    if d.kind in ("approve_design", "send_back"):
        await _back_to_person(session, d, by)
    elif d.kind == "split":
        from services import stories

        await stories.undo_split(session, d, by=by)
    elif d.kind == "approve_plan":
        from services import stories

        await stories.plan_back_to_person(session, d.story_id or d.ticket_id, by=by)
    d = await session.get(AiDecision, decision_id)
    d.state = "overridden"
    d.overridden_by = by
    d.overridden_at = _now()
    d.override_note = (note or "").strip()[:600] or None
    session.add(d)
    await session.commit()
    return await view(session, d)
