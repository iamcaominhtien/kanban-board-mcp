"""Handing work to the AI team over MCP: the guide, workflows, Stories and what the PM decided (ai_team actions).

The person's own assistant uses these the way the board's screens do: put a ticket on a workflow, give a Story to the
PM and decide its plan, read and override the PM's decisions. Inside an AI run only the reads are allowed (ai_team
refuses the rest before it gets here).
"""

import events as board_events
from models import Ticket
from services import stories as svc_stories
from services.ai import decisions as svc_decisions
from services.ai import workflow as svc_workflow

from .. import common
from ..team_guide import TEAM_GUIDE
from .ai_team import _by, _in_run_project, _project, _short


async def guide() -> dict:
    """How to work with the board's AI team: when to ask, hand over work, use a workflow or give a Story to the PM."""
    return {"guide": TEAM_GUIDE}


# ---------------------------------------------------------------------------
# Workflows
# ---------------------------------------------------------------------------


async def workflows(project_id: str) -> list[dict]:
    """The workflows a ticket can go on: key, name, what it is for and its steps (role per step)."""
    async with common.async_session() as session:
        await _project(session, project_id)
        rows = await svc_workflow.list_templates(session, project_id)
    return [
        {
            "key": t.get("key"),
            "name": t.get("name"),
            "for": t.get("description") or t.get("tagline"),
            "steps": [
                f"{s.get('label') or s.get('key')} ({s.get('role') or s.get('kind')})"
                for s in t.get("steps") or []
            ],
        }
        for t in rows
    ]


def _workflow_row(view: dict | None) -> dict | None:
    if not view:
        return None
    current = next(
        (
            s
            for s in view.get("steps") or []
            if s.get("state") in ("active", "waiting", "blocked", "failed")
        ),
        None,
    )
    return {
        "ticket_id": view.get("ticket_id"),
        "workflow": view.get("template_key"),
        "state": view.get("state"),
        "stop_reason": view.get("stop_reason"),
        "stop_detail": view.get("stop_detail"),
        "current": (
            {
                "step": current.get("label"),
                "state": current.get("state"),
                "role": current.get("role"),
                "member": current.get("member_name") or current.get("member_id"),
                "note": _short(current.get("note"), 300) or None,
            }
            if current
            else None
        ),
        "steps": [
            {
                "step": s.get("label"),
                "state": s.get("state"),
                "outcome": s.get("outcome"),
                "role": s.get("role"),
            }
            for s in view.get("steps") or []
            if s.get("state") != "superseded"
        ],
    }


async def workflow(ticket_id: str) -> dict:
    """The ticket's workflow: its steps, where it stands, who holds the current step, and why it stopped if it did."""
    async with common.async_session() as session:
        ticket = await _ticket(session, ticket_id)
        _in_run_project(ticket.project_id)
        row = _workflow_row(await svc_workflow.view(session, ticket_id))
    return row or {
        "ticket_id": ticket_id,
        "workflow": None,
        "note": "Not on a workflow: start_workflow puts it on one.",
    }


async def start_workflow(ticket_id: str, workflow: str) -> dict:
    """Put the ticket on a workflow and start its first step (ai_team(workflows) lists the keys)."""
    async with common.async_session() as session:
        ticket = await _ticket(session, ticket_id)
        try:
            await svc_workflow.attach(session, ticket, workflow, by=_by())
        except svc_workflow.WorkflowError as exc:
            raise ValueError(str(exc)) from exc
        out = _workflow_row(await svc_workflow.view(session, ticket_id))
    await board_events.publish("invalidate")
    return out


async def _ticket(session, ticket_id: str) -> Ticket:
    ticket = await session.get(Ticket, ticket_id)
    if ticket is None:
        raise ValueError(
            f"Ticket '{ticket_id}' not found (use the key such as 'IAM-12')."
        )
    return ticket


# ---------------------------------------------------------------------------
# Stories
# ---------------------------------------------------------------------------


def _story_row(v: dict) -> dict:
    plan = v.get("plan") or {}
    return {
        "id": v["id"],
        "title": v["title"],
        "state": v["state"],
        "plan_waiting": v["plan_waiting"],
        "blocked": (v.get("blocked") or {}).get("text"),
        "paused": v["paused"],
        "pm": (v.get("pm") or {}).get("name"),
        "approve": v["approve"],
        "progress": v["progress"],
        "tokens": v["tokens"],
        "plan": [
            {
                "ticket_id": i["ticket_id"],
                "title": i["title"],
                "status": i["status"],
                "after": i["after"],
                "covers": i["covers"],
                "held_by": (i.get("held_by") or {}).get("name"),
                "step": i.get("step"),
            }
            for i in plan.get("items") or []
        ],
        "criteria": [
            {"text": c["text"], "state": c["state"], "ticket_id": c["ticket_id"]}
            for c in v["criteria"]
        ],
    }


async def stories(project_id: str) -> list[dict]:
    """The project's Stories: state, progress, whether the plan waits for the person, what a Blocked one waits for."""
    async with common.async_session() as session:
        await _project(session, project_id)
        return [_story_row(v) for v in await svc_stories.listing(session, project_id)]


async def story(story_id: str) -> dict:
    """One Story with its plan, its criteria and what the PM decided on it."""
    async with common.async_session() as session:
        try:
            v = await svc_stories.full_view(session, story_id)
        except LookupError as exc:
            raise ValueError(
                f"Story '{story_id}' not found (a Story is a ticket key such as 'IAM-12')."
            ) from exc
        _in_run_project(v["project_id"])
    return {
        **_story_row(v),
        "goal": v["goal"],
        "plan_note": (v.get("plan") or {}).get("note"),
        "decisions": [_decision_row(d) for d in v.get("decisions") or []],
    }


async def give_story(project_id: str, text: str, fields: dict | None = None) -> dict:
    """A new Story handed to the PM. text: the goal in the person's words. fields: title (required), criteria (list of
    what makes it done), approve ('person' | 'pm', default the project's), budget_tokens, hand (false: a Draft)."""
    fields = dict(fields or {})
    unknown = set(fields) - {"title", "criteria", "approve", "budget_tokens", "hand"}
    if unknown:
        raise ValueError(
            f"Unknown field(s) {', '.join(sorted(unknown))}: give_story takes title, criteria, approve, budget_tokens, hand."
        )
    title = str(fields.get("title") or "").strip()
    if not title:
        raise ValueError(
            "give_story needs fields.title (the Story's name); text is its goal."
        )
    criteria = fields.get("criteria") or []
    if isinstance(criteria, str):
        criteria = [
            line.strip("-• ").strip() for line in criteria.splitlines() if line.strip()
        ]
    async with common.async_session() as session:
        await _project(session, project_id)
        try:
            sid = await svc_stories.create(
                session,
                project_id,
                title=title,
                goal=(text or "").strip(),
                criteria=[str(c) for c in criteria],
                approve=fields.get("approve"),
                budget_tokens=int(fields.get("budget_tokens") or 0),
                hand=fields.get("hand", True) is not False,
                by=_by(),
            )
        except svc_stories.StoryError as exc:
            raise ValueError(str(exc)) from exc
    await board_events.publish("invalidate")
    return await story(sid)


async def _plan_action(story_id: str, fn, **kwargs) -> dict:
    async with common.async_session() as session:
        try:
            await fn(session, story_id, by=_by(), **kwargs)
        except LookupError as exc:
            raise ValueError(f"Story '{story_id}' not found.") from exc
        except svc_stories.StoryError as exc:
            raise ValueError(str(exc)) from exc
    await board_events.publish("invalidate")
    return await story(story_id)


async def approve_plan(story_id: str) -> dict:
    """Approve the plan that waits for the person: the Story runs."""
    return await _plan_action(story_id, svc_stories.approve_plan)


async def revise_plan(story_id: str, text: str) -> dict:
    """Tell the PM what to change in the plan: it writes the next version."""
    if not (text or "").strip():
        raise ValueError("revise_plan needs text: what the PM should change.")
    return await _plan_action(story_id, svc_stories.revise_plan, note=text)


async def reject_plan(story_id: str, text: str | None = None) -> dict:
    """Turn the plan down: its tickets go to Won't do and the Story is a Draft again. text: why."""
    return await _plan_action(story_id, svc_stories.reject_plan, note=text)


# ---------------------------------------------------------------------------
# What the PM decided in the person's place
# ---------------------------------------------------------------------------


def _decision_row(d: dict) -> dict:
    return {
        "id": d["id"],
        "at": d["at"],
        "kind": d["kind"],
        "title": d["title"],
        "why": _short(d["why"], 300) or None,
        "ticket_id": d["ticket_id"],
        "story_id": d["story_id"],
        "state": d["state"],
        "can_override": d["can_override"],
        "why_not": d["why_not"],
    }


async def decisions(
    project_id: str, story_id: str | None = None, limit: int | None = None
) -> dict:
    """What the PM decided in the person's place, newest first, and which can still be overridden."""
    async with common.async_session() as session:
        await _project(session, project_id)
        out = await svc_decisions.listing(
            session, project_id, story=story_id, limit=limit or 30
        )
    return {"totals": out["totals"], "items": [_decision_row(d) for d in out["items"]]}


async def override(decision_id: str, text: str | None = None) -> dict:
    """Undo a decision the PM took for the person while nothing was built on it. text: why."""
    async with common.async_session() as session:
        try:
            d = await svc_decisions.override(session, decision_id, by=_by(), note=text)
        except LookupError as exc:
            raise ValueError(
                f"Decision '{decision_id}' not found (ai_team(decisions) lists them)."
            ) from exc
        except svc_decisions.DecisionError as exc:
            raise ValueError(str(exc)) from exc
    await board_events.publish("invalidate")
    return _decision_row(d)


# ---------------------------------------------------------------------------
# Handing work over and talking to a running AI (issue #272)
# ---------------------------------------------------------------------------


async def take_back(ticket_id: str, text: str | None = None) -> dict:
    """Take the ticket back from the AI team for the person: its runs stop, its workflow pauses at the step it was
    on, the ticket is the person's, and a handoff note of what the AI did goes on the ticket."""
    from services.ai import hold

    async with common.async_session() as session:
        ticket = await _ticket(session, ticket_id)
        _in_run_project(ticket.project_id)
    try:
        return await hold.take_back(ticket_id, by=_by(), text=text)
    except hold.HoldError as exc:
        raise ValueError(str(exc)) from exc


async def hand_over(
    ticket_id: str,
    fields: dict | None = None,
    text: str | None = None,
    member_id: str | None = None,
    workflow: str | None = None,
) -> dict:
    """Give the ticket to the AI team with a handoff note, in one call: fields {done, where, left, check, branch,
    pages}. A workflow paused by take_back resumes at its step; `workflow` starts one; a workflow going on tells its
    running AI; else `member_id` (default: the AI that held it last) takes it. Whoever takes it reads the note first."""
    from services.ai import hold

    fields = dict(fields or {})
    pages = fields.get("pages") or []
    if isinstance(pages, str):
        pages = [pages]
    async with common.async_session() as session:
        ticket = await _ticket(session, ticket_id)
        _in_run_project(ticket.project_id)
    try:
        return await hold.hand_over(
            ticket_id,
            by=_by(),
            note={k: fields.get(k) for k in ("done", "where", "left", "check")},
            text=text,
            member_id=member_id,
            workflow=workflow,
            branch=fields.get("branch"),
            pages=[str(p) for p in pages],
        )
    except hold.HoldError as exc:
        raise ValueError(str(exc)) from exc


async def tell(run_id: str, text: str) -> dict:
    """Send a message to an AI while it works (Live commentary's reply box): it reaches the run at its next turn, or
    with its next board call; one that ends first goes to the ticket's next run."""
    from models import AiRun
    from services.ai import runs as svc_runs

    text = (text or "").strip()
    if not text:
        raise ValueError("tell needs text: the message for the AI.")
    async with common.async_session() as session:
        run = await session.get(AiRun, run_id)
        if run is None:
            raise ValueError(
                f"Run '{run_id}' not found: ai_team(runs, active_only=true) lists the runs going on."
            )
        _in_run_project(run.project_id)
        if run.state in svc_runs.ENDED:
            raise ValueError(
                f"Run #{run.number} already ended ({run.state}): hand the ticket over instead (ai_team(hand_over))."
            )
    how = await svc_runs.tell(run_id, text, by=_by())
    return {
        "run_id": run_id,
        "delivered": how,
        "note": "It reached the running AI now."
        if how == "input"
        else "The AI reads it with its next board call.",
    }
