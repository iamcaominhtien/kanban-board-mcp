"""Story: a job a person hands to the PM, which the PM owns from the plan to Done (design/screens/ai-story-flow.md B).

A Story is a ticket of type ``story`` with a row in ``story``. Its children are the tickets whose parent it is; its
plan says their order and what waits for what. The states are the Story's own (draft, planning, in progress, review,
done, dropped) and its ticket's column follows them: a Story is never dragged. The board drives it: the PM writes the
plan, the person or the PM approves it, the children run on their workflows as soon as what they wait for is done,
and when the last one is done the PM checks the Story's criteria and closes it, or adds one more ticket.
"""

import json
import logging
import re
from datetime import UTC, datetime

from sqlmodel import col, select

from models import AiDecision, AiRun, AiTicketWorkflow, Member, Story, Ticket
from services import ticket_waves

logger = logging.getLogger(__name__)

STATES = ("draft", "planning", "in_progress", "review", "done", "dropped")
STATUS_OF = {
    "draft": "backlog",
    "planning": "todo",
    "in_progress": "in-progress",
    "review": "review",
    "done": "done",
    "dropped": "wont_do",
}
CLOSED = ("done", "wont_do")
BY = "the board (Story)"

PLAN_TASK = (
    "You are the PM of this project and you own Story {story}: {title}. The goal, in the person's words, and the "
    "criteria that say it is done are on {story}.\n\n"
    "Plan it. Read the Story; ask the BA with an @mention only if something is truly unclear. Split it by feature "
    "into tickets, each one thing a person can do or see, taken end to end on its own workflow (its design, build, "
    "tests and review happen inside that ticket). Create them with the board's tools in the order they should be "
    "done, each with parent {story}, status backlog and no assignee, a clear title, a description and acceptance "
    "criteria a tester can check. Do not start them and do not change {story} itself.{revise}\n\n"
    "End your final message with the plan, one line per ticket, in order:\n"
    "`PLAN: <KEY> | after: <KEYS or none> | covers: <criterion numbers>`\n"
    "`after` names the tickets that must be Done first (tickets with no wait between them run at the same time); "
    "`covers` names which of the Story's criteria (1, 2, …) the ticket delivers. Every criterion must be covered."
)
REVISE = (
    "\n\nThis is version {n} of the plan. The person asked: {note}\n"
    "The tickets of the current plan are {keys}. Change them in place where you can (title, description, criteria), "
    "create what is missing, and move a ticket that is no longer needed to Won't do. Give the whole plan again."
)
REVIEW_TASK = (
    "You are the PM of this project and every ticket of Story {story} ({title}) is done. Check each criterion of the "
    "Story against what was built: open its tickets and their evidence, and try the result where you can. Write "
    "what you found as a comment on {story}.\n\n"
    "If every criterion is met, end your final message with exactly `REVIEW: PASS`. If one is not, create one more "
    "ticket with parent {story}, status backlog and no assignee, for what is missing, and end with "
    "`REVIEW: MORE <KEY>` and why."
)


class StoryError(Exception):
    """The Story cannot do that in its state (the API answers 409)."""


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _loads(text: str | None, default):
    try:
        data = json.loads(text or "")
    except ValueError:
        return default
    return data if isinstance(data, type(default)) else default


def plan_of(story: Story) -> dict:
    """The Story's plan as a dict."""
    return _loads(story.plan, {})


def set_plan(story: Story, plan: dict) -> None:
    """Store the Story's plan."""
    story.plan = json.dumps(plan)


def meta_of(story: Story) -> dict:
    """The Story's bookkeeping (the PM run under way, what was told) as a dict."""
    return _loads(story.meta, {})


def set_meta(story: Story, **values) -> None:
    """Set or clear (None) keys of the Story's bookkeeping."""
    meta = meta_of(story)
    for k, v in values.items():
        if v is None:
            meta.pop(k, None)
        else:
            meta[k] = v
    story.meta = json.dumps(meta)


async def get(session, story_id: str) -> tuple[Ticket, Story]:
    """The Story's ticket and row, or LookupError."""
    ticket = await session.get(Ticket, story_id)
    story = await session.get(Story, story_id)
    if ticket is None or story is None:
        raise LookupError("Story not found")
    return ticket, story


async def set_state(session, story: Story, state: str, *, by: str = BY) -> None:
    """The Story's state, and its ticket's column with it (written directly: a Story is never moved by hand)."""
    if story.state != state:
        history = _loads(story.history, [])
        history.append({"at": _now(), "state": state, "by": by})
        story.history = json.dumps(history[-50:])
        story.state = state
    ticket = await session.get(Ticket, story.ticket_id)
    if ticket is not None and ticket.status != STATUS_OF[state]:
        ticket.status = STATUS_OF[state]
        ticket.updated_at = _now()
        session.add(ticket)
    session.add(story)


async def _cfg(session, project_id: str) -> dict:
    from services.ai import ops
    from services.ai.store import get_settings

    return ops.get(await get_settings(session, project_id))


async def _pm(session, project_id: str):
    from services.ai import workflow

    return await workflow.coordinator(session, project_id)


async def children(session, story_id: str) -> list[Ticket]:
    """The tickets whose parent is the Story."""
    return list(
        (
            await session.exec(
                select(Ticket)
                .where(Ticket.parent_id == story_id)
                .order_by(
                    Ticket.created_at, Ticket.id
                )  # the pieces in the order they were made
            )
        ).all()
    )


# ---------------------------------------------------------------------------
# Making a Story
# ---------------------------------------------------------------------------


async def create(
    session,
    project_id: str,
    *,
    title: str,
    goal: str = "",
    criteria: list[str] | None = None,
    approve: str | None = None,
    budget_tokens: int = 0,
    hand: bool = True,
    by: str | None = None,
) -> str:
    """A new Story ticket (a Draft, or handed to the PM at once)."""
    from services import tickets as svc_tickets

    ticket = await svc_tickets.create_ticket(
        session,
        project_id,
        title,
        type="story",
        status="backlog",
        description=goal or "",
        created_by=by,
    )
    for text in [c for c in (criteria or []) if (c or "").strip()]:
        await svc_tickets.add_acceptance_criterion(session, ticket.id, text)
    cfg = await _cfg(session, project_id)
    story = await session.get(Story, ticket.id) or Story(
        ticket_id=ticket.id, project_id=project_id
    )
    story.approve = (
        approve
        if approve in ("person", "pm")
        else ((cfg.get("autonomy") or {}).get("approve") or "person")
    )
    story.budget_tokens = max(0, int(budget_tokens or 0))
    story.created_by = by
    story.history = json.dumps([{"at": _now(), "state": "draft", "by": by or "user"}])
    session.add(story)
    await session.commit()
    if hand:
        await hand_over(session, ticket.id, by=by or "user")
    return ticket.id


async def make_story(session, ticket_id: str, *, by: str) -> str:
    """A ticket becomes a Story: its children, if any, are the plan in the order they were made."""
    ticket = await session.get(Ticket, ticket_id)
    if ticket is None:
        raise LookupError("Ticket not found")
    if await session.get(Story, ticket_id) is not None:
        raise StoryError("It is already a Story.")
    if ticket.parent_id:
        raise StoryError(
            "A Story holds tickets, never Stories: this ticket is inside another one."
        )
    kids = [t for t in await children(session, ticket_id) if t.status != "wont_do"]
    cfg = await _cfg(session, ticket.project_id)
    pm = await _pm(session, ticket.project_id)
    prev_type = ticket.type
    ticket.type = "story"
    session.add(ticket)
    story = Story(
        ticket_id=ticket_id,
        project_id=ticket.project_id,
        approve=(cfg.get("autonomy") or {}).get("approve") or "person",
        pm_id=pm.id if pm else None,
        created_by=by,
        meta=json.dumps({"prev_type": prev_type}),
    )
    await _detach_workflow(session, ticket_id, f"Became a Story ({by}).")
    if kids:
        kids.sort(key=lambda t: t.created_at or "")
        set_plan(
            story,
            {
                "version": 1,
                "by": by,
                "at": _now(),
                "approved_by": by,
                "approved_at": _now(),
                "items": [{"ticket_id": t.id, "after": [], "covers": []} for t in kids],
                "changes": [],
            },
        )
        story.started_at = _now()
        await set_state(session, story, "in_progress", by=by)
    else:
        await set_state(session, story, "draft", by=by)
    await session.commit()
    await drive(session, ticket_id)
    return ticket_id


async def _detach_workflow(session, ticket_id: str, note: str) -> None:
    """The Story's own workflow (if it had one) stops driving it: the Story's plan drives its children now."""
    from services.ai import workflow

    wf = await session.get(AiTicketWorkflow, ticket_id)
    if wf is None or wf.state in ("done", "detached"):
        return
    to_cancel = []
    for row in await workflow.steps_of(session, ticket_id):
        if row.state in ("pending", "active", "waiting", "blocked", "failed"):
            if row.state == "active" and row.run_id:
                to_cancel.append(row.run_id)
            row.state = "skipped"
            row.note = note
            row.ended_at = _now()
            session.add(row)
    wf.state, wf.stop_reason, wf.stop_detail = "detached", None, note
    wf.updated_at = _now()
    session.add(wf)
    await session.commit()
    await workflow._cancel_runs(to_cancel, by=BY, reason=note)


async def promote_split(
    session, wf: AiTicketWorkflow, kids: list[Ticket], run: AiRun
) -> str:
    """The PM split a ticket by feature: the ticket becomes a Story whose plan is the pieces, one after another,
    approved by the PM (its own decision, which a person can override while no piece has started)."""
    from services.ai import decisions

    ticket = await session.get(Ticket, wf.ticket_id)
    member = await session.get(Member, run.member_id)
    pm_name = member.name if member else "the PM"
    prev_type = ticket.type
    ticket.type = "story"
    session.add(ticket)
    kids = sorted(kids, key=lambda t: t.created_at or "")
    items = []
    for i, t in enumerate(kids):
        items.append(
            {"ticket_id": t.id, "after": [kids[i - 1].id] if i else [], "covers": []}
        )
    story = Story(
        ticket_id=ticket.id,
        project_id=ticket.project_id,
        approve="pm",
        pm_id=run.member_id,
        created_by=pm_name,
        handed_at=_now(),
        started_at=_now(),
        meta=json.dumps({"prev_type": prev_type, "split_from_wf": True}),
    )
    set_plan(
        story,
        {
            "version": 1,
            "by": pm_name,
            "at": _now(),
            "approved_by": pm_name,
            "approved_at": _now(),
            "items": items,
            "changes": [],
        },
    )
    session.add(story)
    await _mirror_waits(session, items)
    await set_state(session, story, "in_progress", by=pm_name)
    await session.commit()
    await _detach_workflow(
        session,
        ticket.id,
        f"Split into {', '.join(t.id for t in kids)}: it is a Story now.",
    )
    await decisions.record(
        session,
        ticket.project_id,
        kind="split",
        title=f"Split {ticket.id} into {len(kids)} tickets",
        ticket_id=ticket.id,
        why="Triage said it holds several pieces of work. Split by feature, in this order: "
        + ", ".join(t.id for t in kids),
        member_id=run.member_id,
        ref={"pieces": [t.id for t in kids], "prev_type": prev_type},
    )
    await drive(session, ticket.id)
    return ticket.id


async def undo_split(session, d: AiDecision, *, by: str) -> None:
    """Override of a split: the pieces go to the Recycle Bin (Won't do) and the ticket goes on as one."""
    from services.ai import decisions, workflow

    ref = decisions.ref_of(d)
    sid = d.ticket_id
    ticket = await session.get(Ticket, sid)
    for tid in ref.get("pieces") or []:
        t = await session.get(Ticket, tid)
        if t is not None and t.status not in CLOSED:
            t.status = "wont_do"
            t.wont_do_reason = f"{by} overrode the split: {sid} goes on as one ticket."
            t.updated_at = _now()
            session.add(t)
    story = await session.get(Story, sid)
    if story is not None:
        await session.delete(story)
    if ticket is not None:
        ticket.type = ref.get("prev_type") or "feature"
        ticket.status = "in-progress"
        session.add(ticket)
    wf = await session.get(AiTicketWorkflow, sid)
    if wf is not None:
        rows = await workflow.steps_of(session, sid)
        for row in rows:
            if row.state == "skipped" and (row.note or "").startswith("Split into"):
                row.state, row.note, row.ended_at = "pending", None, None
                session.add(row)
        wf.state, wf.stop_reason, wf.stop_detail = "active", None, None
        wf.depth_note = f"{by} overrode the split: it goes on as one ticket."
        session.add(wf)
    await session.commit()
    if wf is not None:
        await workflow.advance(sid)


# ---------------------------------------------------------------------------
# The plan
# ---------------------------------------------------------------------------


async def hand_over(
    session,
    story_id: str,
    *,
    by: str,
    approve: str | None = None,
    budget_tokens: int | None = None,
) -> None:
    """The person hands the Story to the PM: the PM writes the plan."""
    ticket, story = await get(session, story_id)
    if story.state != "draft":
        raise StoryError("Only a Draft is handed to the PM.")
    if approve in ("person", "pm"):
        story.approve = approve
    if budget_tokens is not None:
        story.budget_tokens = max(0, int(budget_tokens))
    pm = await _pm(session, story.project_id)
    if pm is None:
        raise StoryError(
            "There is no PM in this project to hand it to. Add one from the role packs."
        )
    story.pm_id = pm.id
    story.handed_at = _now()
    await set_state(session, story, "planning", by=by)
    await session.commit()
    await _plan_run(session, story, note=None)


async def _plan_run(session, story: Story, *, note: str | None) -> None:
    from services.ai import manager, runs

    ticket = await session.get(Ticket, story.ticket_id)
    plan = plan_of(story)
    revise = ""
    if note:
        keys = ", ".join(i["ticket_id"] for i in plan.get("items") or []) or "none"
        revise = REVISE.format(
            n=int(plan.get("version") or 0) + 1, note=note.strip()[:1500], keys=keys
        )
    try:
        run = await runs.create_run(
            session,
            ticket_id=story.ticket_id,
            member_id=story.pm_id,
            mode="work",
            trigger=manager.TRIGGER,
            started_by=BY,
            instruction=PLAN_TASK.format(
                story=story.ticket_id, title=ticket.title, revise=revise
            ),
            wait_for_hold=True,
        )
    except runs.RunError as exc:
        await session.refresh(story)  # a hold conflict rolled the session back
        set_meta(
            story, blocked={"kind": "plan", "text": f"The PM could not start: {exc}"}
        )
        session.add(story)
        await session.commit()
        return
    set_meta(
        story,
        job={"run_id": run.id, "job": "plan", "since": run.queued_at, "note": note},
        blocked=None,
    )
    session.add(story)
    await session.commit()


PLAN_LINE = re.compile(
    r"PLAN:\s*`?\s*([A-Za-z][A-Za-z0-9]*-\d+)\s*(?:\|\s*after:\s*([^|\n`]*))?(?:\|\s*covers:\s*([^\n`]*))?",
    re.IGNORECASE,
)
KEY = re.compile(r"[A-Za-z][A-Za-z0-9]*-\d+")


def parse_plan(text: str, keys: list[str]) -> list[dict]:
    """The plan lines of the PM's final message, for the tickets that exist; the rest in creation order after."""
    known = {k.upper(): k for k in keys}
    items, seen = [], set()
    for m in PLAN_LINE.finditer(text or ""):
        key = known.get(m.group(1).upper())
        if key is None or key in seen:
            continue
        seen.add(key)
        after = [
            known[k.upper()]
            for k in KEY.findall(m.group(2) or "")
            if k.upper() in known and known[k.upper()] != key
        ]
        covers = [int(n) for n in re.findall(r"\d+", m.group(3) or "")]
        items.append({"ticket_id": key, "after": after, "covers": covers})
    for k in keys:
        if k not in seen:
            items.append(
                {
                    "ticket_id": k,
                    "after": [items[-1]["ticket_id"]] if items else [],
                    "covers": [],
                }
            )
    return items


async def _mirror_waits(session, items: list[dict]) -> None:
    """What waits for what in the plan is the tickets' own Blocked by, so the board shows it everywhere."""
    for i in items:
        t = await session.get(Ticket, i["ticket_id"])
        if t is None:
            continue
        before = _loads(t.blocked_by, [])
        if sorted(before) != sorted(i.get("after") or []):
            t.blocked_by = json.dumps(i.get("after") or [])
            session.add(t)


async def _after_plan(session, story: Story, run: AiRun, text: str, job: dict) -> None:
    from services.ai import decisions

    kids = [
        t for t in await children(session, story.ticket_id) if t.status != "wont_do"
    ]
    if not kids:
        set_meta(
            story,
            blocked={
                "kind": "plan",
                "text": "The PM wrote no plan"
                + (
                    f" (its run {run.state.replace('_', ' ')})"
                    if run.state != "finished"
                    else ""
                )
                + ". Hand it over again or change the Story.",
            },
        )
        await set_state(session, story, "draft", by=BY)
        await session.commit()
        return
    kids.sort(key=lambda t: t.created_at or "")
    items = parse_plan(text, [t.id for t in kids])
    plan = plan_of(story)
    member = await session.get(Member, run.member_id)
    pm_name = member.name if member else "PM"
    changes = list(plan.get("changes") or [])
    if job.get("note"):
        changes.append(
            {"at": _now(), "text": f"{pm_name} changed the plan: {job['note'][:300]}"}
        )
    plan = {
        "version": int(plan.get("version") or 0) + 1,
        "by": pm_name,
        "at": _now(),
        "waiting": story.approve != "pm",
        "approved_by": None,
        "approved_at": None,
        "note": _summary(text),
        "items": items,
        "changes": changes[-20:],
    }
    set_plan(story, plan)
    await _mirror_waits(session, items)
    session.add(story)
    await session.commit()
    if story.approve == "pm":
        plan["approved_by"], plan["approved_at"] = pm_name, _now()
        set_plan(story, plan)
        story.started_at = story.started_at or _now()
        await set_state(session, story, "in_progress", by=pm_name)
        await session.commit()
        await decisions.record(
            session,
            story.project_id,
            kind="approve_plan",
            title=f"Approved its own plan for {story.ticket_id} (version {plan['version']})",
            ticket_id=story.ticket_id,
            why=f"The Story is set to let the PM approve its plan. {len(items)} tickets.",
            member_id=run.member_id,
            ref={"version": plan["version"]},
        )
        await drive(session, story.ticket_id)
        return
    await _tell(
        session,
        story,
        "story_plan",
        title=f"{story.ticket_id}: the plan waits for you",
        body=f"{pm_name} wrote a plan of {len(items)} tickets. Approve it, change it or send it back.",
    )


def _summary(text: str) -> str:
    """The PM's own words before its plan lines."""
    head = (text or "").split("PLAN:")[0].strip()
    return head[-800:]


async def approve_plan(session, story_id: str, *, by: str) -> None:
    """The person approves the plan that waits: the Story runs."""
    _, story = await get(session, story_id)
    plan = plan_of(story)
    if story.state != "planning" or not plan.get("waiting"):
        raise StoryError("No plan waits for approval.")
    plan.update(waiting=False, approved_by=by, approved_at=_now())
    set_plan(story, plan)
    story.started_at = story.started_at or _now()
    await set_state(session, story, "in_progress", by=by)
    await session.commit()
    await drive(session, story_id)


async def reject_plan(
    session, story_id: str, *, by: str, note: str | None = None
) -> None:
    """The plan is turned down: its tickets go to the Recycle Bin (Won't do) and the Story is a Draft again."""
    _, story = await get(session, story_id)
    if story.state != "planning":
        raise StoryError("Only a plan that waits can be rejected.")
    for t in await children(session, story_id):
        if t.status not in CLOSED:
            t.status = "wont_do"
            t.wont_do_reason = f"{by} rejected the plan of {story_id}" + (
                f": {note}" if note else "."
            )
            t.updated_at = _now()
            session.add(t)
    plan = plan_of(story)
    changes = list(plan.get("changes") or [])
    changes.append(
        {
            "at": _now(),
            "text": f"{by} rejected version {plan.get('version')}"
            + (f": {note}" if note else ""),
        }
    )
    set_plan(
        story, {"version": plan.get("version") or 0, "changes": changes, "items": []}
    )
    await set_state(session, story, "draft", by=by)
    await session.commit()


async def revise_plan(session, story_id: str, *, by: str, note: str) -> None:
    """The person tells the PM what to change: the PM writes the next version."""
    _, story = await get(session, story_id)
    if story.state not in ("planning", "in_progress"):
        raise StoryError(
            "The plan can be changed while the Story is planned or under way."
        )
    if not (note or "").strip():
        raise ValueError("Say what to change.")
    if meta_of(story).get("job"):
        raise StoryError("The PM is already working on it.")
    if story.pm_id is None:
        raise StoryError("There is no PM to write the plan.")
    plan = plan_of(story)
    plan["waiting"] = False
    set_plan(story, plan)
    await set_state(session, story, "planning", by=by)
    await session.commit()
    await _plan_run(session, story, note=f"{note.strip()} (asked by {by})")


async def edit_plan(session, story_id: str, items: list[dict], *, by: str) -> None:
    """Order and waits edited in place by a person."""
    _, story = await get(session, story_id)
    kids = {t.id for t in await children(session, story_id)}
    clean = []
    for i in items:
        tid = i.get("ticket_id")
        if tid not in kids:
            raise ValueError(f"{tid} is not a ticket of this Story.")
        after = [a for a in (i.get("after") or []) if a in kids and a != tid]
        old = next(
            (x for x in plan_of(story).get("items") or [] if x["ticket_id"] == tid), {}
        )
        clean.append(
            {"ticket_id": tid, "after": after, "covers": old.get("covers") or []}
        )
    plan = plan_of(story)
    changes = list(plan.get("changes") or [])
    changes.append({"at": _now(), "text": f"{by} changed the order or the waits."})
    plan.update(items=clean, changes=changes[-20:])
    set_plan(story, plan)
    await _mirror_waits(session, clean)
    session.add(story)
    await session.commit()
    await drive(session, story_id)


async def plan_back_to_person(session, story_id: str, *, by: str) -> None:
    """Override of the PM approving its own plan: the plan waits for the person."""
    _, story = await get(session, story_id)
    plan = plan_of(story)
    plan.update(waiting=True, approved_by=None, approved_at=None)
    set_plan(story, plan)
    story.approve = "person"
    await set_state(session, story, "planning", by=by)
    await session.commit()


# ---------------------------------------------------------------------------
# Driving the children
# ---------------------------------------------------------------------------


async def tokens_used(session, story: Story) -> int:
    """Tokens the Story and its tickets used since it was made."""
    ids = [story.ticket_id, *[t.id for t in await children(session, story.ticket_id)]]
    rows = (
        await session.exec(
            select(AiRun).where(
                col(AiRun.ticket_id).in_(ids), col(AiRun.queued_at) >= story.created_at
            )
        )
    ).all()
    return sum((r.tokens_in or 0) + (r.tokens_out or 0) for r in rows)


async def drive(session, story_id: str) -> None:
    """Start every child that can run (what it waits for is done); review the Story when they are all done."""
    from services.ai import manager

    story = await session.get(Story, story_id)
    if story is None or story.state != "in_progress" or story.paused:
        return
    if meta_of(story).get("job"):
        return  # the PM is working on the plan
    if story.budget_tokens and await tokens_used(session, story) >= story.budget_tokens:
        return  # Blocked on the budget: the person raises it (PATCH) and the Story goes on
    items = plan_of(story).get("items") or []
    tickets = {t.id: t for t in await children(session, story_id)}
    status = {tid: t.status for tid, t in tickets.items()}
    open_ = [
        i
        for i in items
        if status.get(i["ticket_id"]) not in CLOSED and i["ticket_id"] in tickets
    ]
    extra = [
        t
        for tid, t in tickets.items()
        if t.status not in CLOSED and tid not in {i["ticket_id"] for i in items}
    ]
    if extra:  # a ticket the PM or a person added under the Story without the plan: it joins at the end
        plan = plan_of(story)
        plan["items"] = items + [
            {"ticket_id": t.id, "after": [], "covers": []} for t in extra
        ]
        set_plan(story, plan)
        session.add(story)
        await session.commit()
        items = plan["items"]
        open_ += [{"ticket_id": t.id, "after": []} for t in extra]
    if not open_:
        await _start_review(session, story)
        return
    start = []
    closed = {tid for tid, st in status.items() if st in CLOSED}
    for i in open_:
        t = tickets[i["ticket_id"]]
        if t.assignee or await session.get(AiTicketWorkflow, t.id) is not None:
            continue  # under way
        if t.status not in ("backlog", "todo"):
            continue  # a person is on it
        if t.wave_pin is not None:
            # pinned to a wave by hand (TDP-1): it waits for the earlier waves, not for its own waits
            if not ticket_waves.pinned_ready(t, tickets.values(), closed):
                continue
        elif any(
            status.get(a) not in CLOSED for a in i.get("after") or [] if a in status
        ):
            continue
        if t.status == "backlog":
            t.status = "todo"
            t.updated_at = _now()
            session.add(t)
        start.append(t.id)
    if start:
        await session.commit()
        for tid in start:
            manager.later(manager.take(tid, force=True))


async def _start_review(session, story: Story) -> None:
    from services.ai import manager, runs

    await set_state(session, story, "review", by=BY)
    await session.commit()
    if not story.pm_id:
        await _close(
            session, story, "No PM to check it: closed when every ticket was done."
        )
        return
    ticket = await session.get(Ticket, story.ticket_id)
    try:
        run = await runs.create_run(
            session,
            ticket_id=story.ticket_id,
            member_id=story.pm_id,
            mode="work",
            trigger=manager.TRIGGER,
            started_by=BY,
            instruction=REVIEW_TASK.format(story=story.ticket_id, title=ticket.title),
            wait_for_hold=True,
        )
    except runs.RunError as exc:
        set_meta(
            story,
            blocked={
                "kind": "stopped",
                "text": f"The PM could not start the review: {exc}",
            },
        )
        session.add(story)
        await session.commit()
        return
    set_meta(story, job={"run_id": run.id, "job": "review", "since": run.queued_at})
    session.add(story)
    await session.commit()


async def _after_review(
    session, story: Story, run: AiRun, text: str, job: dict
) -> None:
    since = job.get("since") or ""
    new = [
        t
        for t in await children(session, story.ticket_id)
        if (t.created_at or "") >= since and t.status not in CLOSED
    ]
    m = re.search(r"REVIEW:\s*(PASS|MORE)\b(.*)", text or "", re.IGNORECASE | re.DOTALL)
    if new:
        plan = plan_of(story)
        plan["items"] = (plan.get("items") or []) + [
            {"ticket_id": t.id, "after": [], "covers": []} for t in new
        ]
        changes = list(plan.get("changes") or [])
        why = (m.group(2).strip()[:300] if m else "") or "a criterion was not met"
        changes.append(
            {
                "at": _now(),
                "text": f"Review added {', '.join(t.id for t in new)}: {why}",
            }
        )
        plan["changes"] = changes[-20:]
        set_plan(story, plan)
        story.review_note = why
        await set_state(session, story, "in_progress", by=BY)
        await session.commit()
        await drive(session, story.ticket_id)
        return
    if m and m.group(1).upper() == "PASS" and run.state == "finished":
        story.review_note = _summary(text.split("REVIEW:")[0])[-800:] or None
        await _close(session, story, None)
        return
    set_meta(
        story,
        blocked={
            "kind": "question",
            "text": "The PM could not settle the review"
            + (
                f" (its run {run.state.replace('_', ' ')})"
                if run.state != "finished"
                else ""
            )
            + ". Read its comment on the Story and close it or reopen it.",
        },
    )
    session.add(story)
    await session.commit()
    await _tell(
        session,
        story,
        "story_blocked",
        title=f"{story.ticket_id}: the review needs you",
        body="The PM could not settle the review.",
    )


async def _close(session, story: Story, note: str | None) -> None:
    story.closed_at = _now()
    if note:
        story.review_note = note
    set_meta(story, blocked=None)
    await set_state(session, story, "done", by=BY)
    await session.commit()
    ticket = await session.get(Ticket, story.ticket_id)
    await _tell(
        session,
        story,
        "story_done",
        title=f"{story.ticket_id} is done",
        body=ticket.title if ticket else "",
    )


async def after_run(session, story: Story, run: AiRun) -> None:
    """A PM run the Story started ended: read the plan or the review."""
    from services.ai import workflow

    job = meta_of(story).get("job") or {}
    set_meta(story, job=None)
    session.add(story)
    await session.commit()
    text = workflow.run_text(run)
    if job.get("job") == "plan":
        await _after_plan(session, story, run, text, job)
    elif job.get("job") == "review":
        await _after_review(session, story, run, text, job)


async def on_child_done(session, story_id: str) -> None:
    """A child is Done: start what waited for it."""
    await drive(session, story_id)


async def pause(session, story_id: str, *, by: str, paused: bool) -> None:
    """Pause or resume the Story: while paused nothing new starts."""
    _, story = await get(session, story_id)
    story.paused = paused
    history = _loads(story.history, [])
    history.append({"at": _now(), "state": "paused" if paused else "resumed", "by": by})
    story.history = json.dumps(history[-50:])
    session.add(story)
    await session.commit()
    if not paused:
        await drive(session, story_id)


async def reopen(session, story_id: str, *, by: str) -> None:
    """A Story that is Done or dropped is opened again."""
    _, story = await get(session, story_id)
    if story.state not in ("done", "dropped"):
        raise StoryError("Only a Story that is Done or dropped is reopened.")
    story.closed_at = None
    has_plan = bool(plan_of(story).get("items"))
    await set_state(session, story, "in_progress" if has_plan else "draft", by=by)
    await session.commit()
    await drive(session, story_id)


async def drop(session, story_id: str, *, by: str) -> None:
    """Drop the Story (Won't do)."""
    _, story = await get(session, story_id)
    if story.state in ("done", "dropped"):
        raise StoryError("It is already closed.")
    story.closed_at = _now()
    await set_state(session, story, "dropped", by=by)
    await session.commit()


async def update(
    session,
    story_id: str,
    *,
    by: str,
    budget_tokens: int | None = None,
    approve: str | None = None,
) -> None:
    """Change the Story's budget or who approves its plan."""
    _, story = await get(session, story_id)
    if budget_tokens is not None:
        story.budget_tokens = max(0, int(budget_tokens))
    if approve in ("person", "pm"):
        story.approve = approve
    session.add(story)
    await session.commit()
    await drive(session, story_id)


async def _tell(session, story: Story, kind: str, *, title: str, body: str) -> None:
    from services import notifications as centre

    try:
        await centre.emit(
            kind,
            project_id=story.project_id,
            recipients=await centre.owners_and_admins(session, story.project_id),
            title=title,
            body=body,
            target_kind="ticket",
            target_id=story.ticket_id,
            ticket_id=story.ticket_id,
            data={"story": story.ticket_id},
            session=session,
        )
    except Exception:  # noqa: BLE001 - telling the person never breaks the Story
        logger.exception("Could not tell the person about %s", story.ticket_id)


async def tick(project_id: str) -> None:
    """Every minute: Stories under way start what can run (a child that was moved by hand, a budget raised), and a
    Story that has just become Blocked tells the person once."""
    import database

    async with database.async_session() as session:
        rows = (
            await session.exec(
                select(Story).where(
                    Story.project_id == project_id,
                    col(Story.state).in_(("in_progress", "review")),
                )
            )
        ).all()
        for story in rows:
            job = meta_of(story).get("job")
            if job:  # a PM run whose end was lost (a restart): read what it left
                run = await session.get(AiRun, job.get("run_id") or "")
                if run is None or run.ended_at:
                    if run is None:
                        set_meta(story, job=None)
                        session.add(story)
                        await session.commit()
                    else:
                        from services.ai import manager

                        await manager.on_run_ended(
                            run.id
                        )  # under the manager's lock, as a run's own end
                    continue
            await drive(session, story.ticket_id)
            story = await session.get(Story, story.ticket_id)
            blocked = await blocked_of(session, story)
            told = meta_of(story).get("told")
            if blocked and told != blocked["text"]:
                set_meta(story, told=blocked["text"])
                session.add(story)
                await session.commit()
                await _tell(
                    session,
                    story,
                    "story_blocked",
                    title=f"{story.ticket_id} needs you",
                    body=blocked["text"],
                )
            elif not blocked and told:
                set_meta(story, told=None)
                session.add(story)
                await session.commit()


# ---------------------------------------------------------------------------
# Reading a Story
# ---------------------------------------------------------------------------


async def blocked_of(session, story: Story) -> dict | None:
    """Why the Story cannot go on without a person, or None: worked out from its children each time."""
    from services.ai import workflow

    stored = meta_of(story).get("blocked")
    if stored:
        return {
            "kind": stored.get("kind") or "stopped",
            "text": stored.get("text") or "",
            "ticket_id": None,
        }
    if (
        story.state not in ("in_progress", "review")
        or story.paused
        or meta_of(story).get("job")
    ):
        return None
    if story.budget_tokens:
        used = await tokens_used(session, story)
        if used >= story.budget_tokens:
            return {
                "kind": "budget",
                "text": f"It used {used:,} of its {story.budget_tokens:,} tokens. Raise the budget to go on.",
                "ticket_id": None,
            }
    kids = [
        t for t in await children(session, story.ticket_id) if t.status not in CLOSED
    ]
    reasons = []
    for t in kids:
        wf = await session.get(AiTicketWorkflow, t.id)
        if wf is None:
            continue
        if wf.state == "stopped":
            kind = "quota" if wf.stop_reason == "quota_cap" else "stopped"
            reasons.append(
                {
                    "kind": kind,
                    "text": f"{t.id} stopped: {wf.stop_detail or wf.stop_reason}",
                    "ticket_id": t.id,
                }
            )
            continue
        row = await workflow.current_step(session, t.id)
        if row is None:
            continue
        if row.state == "waiting" and row.kind == "person" and row.key != "done":
            reasons.append(
                {
                    "kind": "approval",
                    "text": f"{t.id} waits for you: {row.label}",
                    "ticket_id": t.id,
                }
            )
            continue
        if row.state in ("active", "pending"):
            run = await session.get(AiRun, row.run_id) if row.run_id else None
            if run is not None and run.state == "needs_input":
                reasons.append(
                    {
                        "kind": "question",
                        "text": f"An AI on {t.id} asks you a question.",
                        "ticket_id": t.id,
                    }
                )
                continue
            return None  # something is moving
    if not reasons:
        return None
    return reasons[0]


async def view(
    session, story_id: str, *, touches: list[dict] | None = None, full: bool = False
) -> dict:
    """The Story as the API hands it out (StoryView, docs/specs/ai-story-flow-implementation.md)."""
    from services.ai import decisions, workflow

    ticket, story = await get(session, story_id)
    kids = {t.id: t for t in await children(session, story_id)}
    plan = plan_of(story)
    pm = None
    if story.pm_id:
        m = await session.get(Member, story.pm_id)
        if m is not None:
            pm = {"id": m.id, "name": m.name, "color": getattr(m, "color", None)}
    items = []
    building = waiting = 0
    for n, i in enumerate(plan.get("items") or [], start=1):
        t = kids.get(i["ticket_id"])
        if t is None:
            continue
        row = await workflow.current_step(session, t.id)
        last = None
        if row is None:  # the workflow is over: the AI that worked on it last
            last = next(
                (
                    r
                    for r in reversed(await workflow.steps_of(session, t.id))
                    if r.member_id
                ),
                None,
            )
        held = None
        if last is not None:
            m = await session.get(Member, last.member_id)
            held = {
                "id": last.member_id,
                "name": m.name if m else "AI",
                "role": last.role,
            }
        elif row is not None and row.member_id:
            m = await session.get(Member, row.member_id)
            held = {
                "id": row.member_id,
                "name": m.name if m else "AI",
                "role": row.role,
            }
        elif t.assignee:
            m = await session.get(Member, t.assignee)
            held = {"id": t.assignee, "name": m.name if m else "", "role": None}
        if row is not None and row.state == "active":
            building += 1
        elif t.status not in CLOSED and row is None:
            waiting += 1
        runs_ = (
            await session.exec(
                select(AiRun)
                .where(AiRun.ticket_id == t.id)
                .order_by(col(AiRun.queued_at))
            )
        ).all()
        items.append(
            {
                "order": n,
                "ticket_id": t.id,
                "title": t.title,
                "status": t.status,
                "held_by": held,
                "step": row.label if row is not None else None,
                "after": i.get("after") or [],
                # a wave pinned by hand (TDP-1): the ticket starts after the earlier waves, not after `after`
                "wave_pin": t.wave_pin,
                "covers": i.get("covers") or [],
                "started_at": runs_[0].queued_at if runs_ else None,
                "ended_at": (
                    runs_[-1].ended_at if runs_ and t.status in CLOSED else None
                ),
            }
        )
    criteria = []
    for n, c in enumerate(_loads(ticket.acceptance_criteria, []), start=1):
        if not isinstance(c, dict):
            continue
        cover = next((i for i in items if n in (i["covers"] or [])), None)
        state = "not_started"
        if (
            c.get("done")
            or story.state == "done"
            or (cover and cover["status"] == "done")
        ):
            state = "met"
        elif cover and cover["started_at"]:
            state = "in_progress"
        criteria.append(
            {
                "id": c.get("id"),
                "text": c.get("text") or "",
                "done": bool(c.get("done")),
                "ticket_id": cover["ticket_id"] if cover else None,
                "state": state,
            }
        )
    ids = [story_id, *kids]
    runs_all = (
        await session.exec(select(AiRun).where(col(AiRun.ticket_id).in_(ids)))
    ).all()
    used = sum(
        (r.tokens_in or 0) + (r.tokens_out or 0)
        for r in runs_all
        if (r.queued_at or "") >= story.created_at
    )
    cost = sum(
        (r.cost_usd or 0) for r in runs_all if (r.metered or (r.cost_usd or 0) > 0)
    )
    mine = [t for t in (touches or []) if t.get("ticket_id") in ids]
    needed = len([t for t in mine if t.get("mark") == "needed"])
    avoidable = len([t for t in mine if t.get("mark") == "avoidable"])
    open_kids = [t for t in kids.values() if t.status != "wont_do"]
    out = {
        "id": story_id,
        "project_id": story.project_id,
        "title": ticket.title,
        "goal": ticket.description or "",
        "state": story.state,
        "blocked": await blocked_of(session, story),
        "plan_waiting": bool(plan.get("waiting")) and story.state == "planning",
        "approve": story.approve,
        "paused": story.paused,
        "pm": pm,
        "criteria": criteria,
        "plan": (
            {
                "version": plan.get("version") or 0,
                "by": plan.get("by"),
                "at": plan.get("at"),
                "approved_by": plan.get("approved_by"),
                "approved_at": plan.get("approved_at"),
                "note": plan.get("note"),
                "items": items,
                "changes": plan.get("changes") or [],
            }
            if plan.get("version")
            else None
        ),
        "progress": {
            "done": len([t for t in open_kids if t.status == "done"]),
            "total": len(open_kids),
            "building": building,
            "waiting": waiting,
        },
        "tokens": {"used": used, "budget": story.budget_tokens},
        "cost_usd": round(cost, 4),
        "interventions": {
            "count": needed + avoidable,
            "needed": needed,
            "avoidable": avoidable,
            "by_rule": len(mine) - needed - avoidable,
        },
        "planning": bool(meta_of(story).get("job")),
        "review_note": story.review_note,
        "handed_at": story.handed_at,
        "started_at": story.started_at,
        "closed_at": story.closed_at,
        "created_at": story.created_at,
    }
    if full:
        listing = await decisions.listing(
            session, story.project_id, story=story_id, limit=200
        )
        out["decisions"] = listing["items"]
        out["children"] = [t.id for t in kids.values()]
    return out


TOUCHES_TTL_S = 15  # the touches are read from the whole history: the board polls Stories, so they are kept a while
_TOUCHES: dict[tuple, tuple[float, list[dict]]] = {}


async def _touches(session, project_id: str, since: str | None) -> list[dict]:
    import time

    key = (project_id, since)
    hit = _TOUCHES.get(key)
    if hit and time.monotonic() - hit[0] < TOUCHES_TTL_S:
        return hit[1]
    out = await _read_touches(session, project_id, since)
    if len(_TOUCHES) > 64:
        _TOUCHES.clear()
    _TOUCHES[key] = (time.monotonic(), out)
    return out


async def _read_touches(session, project_id: str, since: str | None) -> list[dict]:
    from services.ai import health
    from services.ai.store import parse_iso

    start = parse_iso(since) if since else None
    try:
        d = await health.load(
            session, project_id, start or datetime(2000, 1, 1, tzinfo=UTC)
        )
    except Exception:  # noqa: BLE001 - the count of touches never breaks the Story
        logger.exception("Could not read the touches of %s", project_id)
        return []
    return list(d.touches)


async def listing(session, project_id: str) -> list[dict]:
    """The project's Stories, oldest first."""
    rows = (
        await session.exec(
            select(Story)
            .where(Story.project_id == project_id)
            .order_by(col(Story.created_at))
        )
    ).all()
    if not rows:
        return []
    touches = await _touches(session, project_id, min(r.created_at for r in rows))
    return [await view(session, r.ticket_id, touches=touches) for r in rows]


async def full_view(session, story_id: str) -> dict:
    """One Story with its decisions and children (the Story page)."""
    story = await session.get(Story, story_id)
    if story is None:
        raise LookupError("Story not found")
    touches = await _touches(session, story.project_id, story.created_at)
    return await view(session, story_id, touches=touches, full=True)
