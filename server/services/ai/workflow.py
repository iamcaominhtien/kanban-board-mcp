"""Workflows: a ticket follows a few named steps, each with a role (design/screens/ai-team-process.md E–I; plan
D8–D14, D24).

- A **template** is an ordered list of steps; four are ready-made (Quick fix, Standard feature, Feature with a UI,
  Research) and a project can save its own. Templates are versioned and a ticket keeps the version it started on.
- A **step** names a role (a role pack key), or is done by code (**Checks**: the project's test, lint and build
  commands, no quota, before any AI review), or waits for a person (the design approval and the last step: a person is
  asked twice at most, D10).
- A step's role resolves to a member when it starts: the one that already worked on this ticket in that role, else a
  free one, else any (a ticket keeps the same Dev across its steps, D14).
- The **assignee** is whoever holds the ticket now, set by the step; the step rows keep who did what and are never
  overwritten. A hand-off is moving to the next step.
- **Review** always happens; only its depth changes (light / standard / deep, D13). Triage picks it; a person may
  change it; a ticket sent back twice moves up a level only when Triage chose the level.
- **No round limit** (D11): it stops on no progress (the same two roles swapped it three times and the diff changed by
  under 5% between the last two, or the reviewer repeated an objection it already made), a board fault, or a quota cap
  the person turned on. No progress goes to the **coordinator** (a PM member, D12/D24), whose ruling gets one chance:
  if it comes back again it goes to a person, with the ruling attached.
"""

import asyncio
import copy
import json
import logging
import re
import subprocess
from datetime import UTC, datetime
from pathlib import Path

from rapidfuzz import fuzz
from sqlmodel import col, select

import database
from models import (
    AiMember,
    AiRun,
    AiTicketStep,
    AiTicketWorkflow,
    AiWorkflowTemplate,
    Member,
    Ticket,
    TicketUpdate,
)

from . import flags, ops
from .store import get_settings, loads

logger = logging.getLogger(__name__)

GIVES = ("ticket", "criteria", "design", "previous_note", "transcript")

BUILTIN_TEMPLATES: list[dict] = [
    {
        "key": "quick_fix",
        "name": "Quick fix",
        "description": "A bug with an obvious cause",
        "steps": [
            {"key": "triage", "label": "Triage", "kind": "ai", "role": "triage"},
            {
                "key": "fix",
                "label": "Fix",
                "kind": "ai",
                "role": "dev",
                "hands_in": "A branch with the fix, a failing test run and a passing one",
            },
            {"key": "checks", "label": "Checks", "kind": "code"},
            {
                "key": "review",
                "label": "Review",
                "kind": "ai",
                "role": "reviewer",
                "depth": "light",
            },
            {"key": "done", "label": "Done", "kind": "person"},
        ],
    },
    {
        "key": "standard",
        "name": "Standard feature",
        "description": "The default for most tickets",
        "steps": [
            {"key": "triage", "label": "Triage", "kind": "ai", "role": "triage"},
            {
                "key": "shape",
                "label": "Shape",
                "kind": "ai",
                "role": "ba",
                "hands_in": "Acceptance criteria a tester can check",
            },
            {
                "key": "build",
                "label": "Build",
                "kind": "ai",
                "role": "dev",
                "hands_in": "A branch with the change, a failing test run and a passing one, and a note of what the reviewer should look at",
            },
            {"key": "checks", "label": "Checks", "kind": "code"},
            {
                "key": "test",
                "label": "Test",
                "kind": "ai",
                "role": "qa",
                "hands_in": "What passed and what did not, with proof",
            },
            {
                "key": "review",
                "label": "Review",
                "kind": "ai",
                "role": "reviewer",
                "depth": "standard",
            },
            {"key": "done", "label": "Done", "kind": "person"},
        ],
    },
    {
        "key": "feature_ui",
        "name": "Feature with a UI",
        "description": "Anything a person will look at",
        "steps": [
            {"key": "triage", "label": "Triage", "kind": "ai", "role": "triage"},
            {
                "key": "shape",
                "label": "Shape",
                "kind": "ai",
                "role": "ba",
                "hands_in": "Acceptance criteria a tester can check",
            },
            {
                "key": "design",
                "label": "Design",
                "kind": "ai",
                "role": "designer",
                "hands_in": "A mock-up on a canvas frame, every state drawn",
            },
            {
                "key": "approve_design",
                "label": "You approve the design",
                "kind": "person",
            },
            {
                "key": "build",
                "label": "Build",
                "kind": "ai",
                "role": "dev",
                "hands_in": "A branch with the change, a failing test run and a passing one, and a note of what the reviewer should look at",
            },
            {"key": "checks", "label": "Checks", "kind": "code"},
            {
                "key": "try",
                "label": "Try it",
                "kind": "ai",
                "role": "user_tester",
                "hands_in": "What it tried, and where it got stuck",
            },
            {
                "key": "review",
                "label": "Review",
                "kind": "ai",
                "role": "reviewer",
                "depth": "standard",
            },
            {"key": "done", "label": "Done", "kind": "person"},
        ],
    },
    {
        "key": "research",
        "name": "Research",
        "description": "A question, not a change",
        "steps": [
            {"key": "triage", "label": "Triage", "kind": "ai", "role": "triage"},
            {
                "key": "investigate",
                "label": "Investigate",
                "kind": "ai",
                "role": "dev",
                "hands_in": "What was found, with sources",
            },
            {
                "key": "write_up",
                "label": "Write it up",
                "kind": "ai",
                "role": "ba",
                "hands_in": "A Docs page that answers the question",
            },
            {"key": "done", "label": "Done", "kind": "person"},
        ],
    },
]

DEPTH_MODEL = {"light": "haiku", "standard": "sonnet", "deep": "opus"}
DEPTH_UP = {"light": "standard", "standard": "deep", "deep": "deep"}
NO_PROGRESS_ROUNDS = 3
NO_PROGRESS_DIFF = 0.05
REPEAT_SIMILARITY = 85
# who sends work back without being an AI in a dispute: the Checks by code, and a person
NOT_AI_ROLES = {"checks", "person"}
VERDICT = re.compile(
    r"VERDICT:\s*(PASS|CHANGES|REVIEWER|DEV|SPLIT|UNDECIDED)\b", re.IGNORECASE
)


class WorkflowError(ValueError):
    """The workflow cannot do that."""


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _step_defaults(step: dict) -> dict:
    out = {
        "key": step.get("key")
        or re.sub(r"[^a-z0-9_]+", "_", (step.get("label") or "step").lower()),
        "label": step.get("label") or step.get("key") or "Step",
        "kind": step.get("kind")
        if step.get("kind") in ("ai", "code", "person")
        else "ai",
        "role": step.get("role"),
        "hands_in": step.get("hands_in") or "",
        "gives": [
            g
            for g in (
                step.get("gives") or ["ticket", "criteria", "design", "previous_note"]
            )
            if g in GIVES
        ],
        "model": step.get("model"),
        "effort": step.get("effort"),
        "retry_model": step.get("retry_model"),
        "depth": step.get("depth"),
    }
    if out["kind"] == "ai" and not out["role"]:
        raise WorkflowError(f"The step {out['label']} needs a role.")
    return out


def normalize(template: dict) -> dict:
    """A template's steps, checked: every AI step has a role, and the last step waits for a person."""
    steps = [_step_defaults(s) for s in template.get("steps") or []]
    if not steps:
        raise WorkflowError("A workflow needs at least one step.")
    if steps[-1]["kind"] != "person":
        steps.append(_step_defaults({"key": "done", "label": "Done", "kind": "person"}))
    keys = [s["key"] for s in steps]
    if len(set(keys)) != len(keys):
        raise WorkflowError("Two steps have the same key.")
    people = sum(1 for s in steps if s["kind"] == "person")
    return {
        **template,
        "steps": steps,
        "person_stops": people,
        "warning": "This template stops for you more than twice."
        if people > 2
        else None,
    }


def builtin_template(key: str) -> dict | None:
    """A ready-made template."""
    found = next((t for t in BUILTIN_TEMPLATES if t["key"] == key), None)
    return (
        normalize(copy.deepcopy(found)) | {"version": 1, "builtin": True}
        if found
        else None
    )


def _row_template(row: AiWorkflowTemplate) -> dict:
    body = json.loads(row.body or "{}")
    return normalize({**body, "key": row.key, "name": row.name}) | {
        "id": row.id,
        "version": row.version,
        "builtin": False,
        "updated_at": row.updated_at,
    }


async def list_templates(session, project_id: str) -> list[dict]:
    """Ready-made templates and the project's own (the project's wins on the same key)."""
    own = {
        r.key: r
        for r in (
            await session.exec(
                select(AiWorkflowTemplate).where(
                    AiWorkflowTemplate.project_id == project_id
                )
            )
        ).all()
    }
    out = [
        (
            _row_template(own.pop(t["key"]))
            if t["key"] in own
            else builtin_template(t["key"])
        )
        for t in BUILTIN_TEMPLATES
    ]
    return out + [_row_template(r) for r in own.values()]


async def get_template(session, project_id: str, key: str) -> dict | None:
    """One template by key."""
    row = (
        await session.exec(
            select(AiWorkflowTemplate).where(
                AiWorkflowTemplate.project_id == project_id,
                AiWorkflowTemplate.key == key,
            )
        )
    ).first()
    return _row_template(row) if row else builtin_template(key)


async def save_template(
    session, project_id: str, key: str, body: dict, *, by: str
) -> dict:
    """Create or change a template (a new version each time; tickets already on it keep their version)."""
    key = re.sub(r"[^a-z0-9_]+", "_", (key or "").lower()).strip("_")
    if not key:
        raise WorkflowError("A template needs a key.")
    norm = normalize({**body, "key": key})
    row = (
        await session.exec(
            select(AiWorkflowTemplate).where(
                AiWorkflowTemplate.project_id == project_id,
                AiWorkflowTemplate.key == key,
            )
        )
    ).first()
    if row is None:
        base = builtin_template(key)
        row = AiWorkflowTemplate(
            project_id=project_id,
            key=key,
            name=norm.get("name") or (base or {}).get("name") or key,
            version=(base or {}).get("version", 0) + 1 if base else 1,
        )
    else:
        hist = json.loads(row.history or "[]")
        hist.append(
            {
                "version": row.version,
                "body": json.loads(row.body or "{}"),
                "at": row.updated_at,
                "by": row.updated_by,
            }
        )
        row.history = json.dumps(hist[-20:])
        row.version += 1
    row.name = norm.get("name") or row.name
    row.body = json.dumps(
        {
            "name": row.name,
            "description": norm.get("description") or "",
            "steps": norm["steps"],
        }
    )
    row.updated_at = _now()
    row.updated_by = by
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return _row_template(row)


# ---------------------------------------------------------------------------
# A ticket's workflow
# ---------------------------------------------------------------------------


async def of_ticket(session, ticket_id: str) -> AiTicketWorkflow | None:
    """The ticket's workflow row, or None (an odd job with no workflow)."""
    return await session.get(AiTicketWorkflow, ticket_id)


async def steps_of(session, ticket_id: str) -> list[AiTicketStep]:
    """Every step row of the ticket's current workflow, in order (attempts of a step after a send-back follow it)."""
    wf = await session.get(AiTicketWorkflow, ticket_id)
    base = wf.seq_base if wf is not None else 0
    rows = list(
        (
            await session.exec(
                select(AiTicketStep)
                .where(
                    AiTicketStep.ticket_id == ticket_id, col(AiTicketStep.seq) >= base
                )
                .order_by(col(AiTicketStep.seq))
            )
        ).all()
    )
    return rows


async def attach(
    session,
    ticket: Ticket,
    template_key: str,
    *,
    by: str,
    depth: str | None = None,
    depth_by: str | None = None,
    start: bool = True,
) -> AiTicketWorkflow:
    """Put a ticket on a workflow (its version is kept) and start the first step."""
    existing = await session.get(AiTicketWorkflow, ticket.id)
    if existing is not None and existing.template_key and existing.state != "detached":
        raise WorkflowError(f"{ticket.id} already follows a workflow.")
    if existing is not None:
        # an odd job's reviewer row, or a detached workflow: the new workflow replaces it (its steps stay as history)
        for old_row in await steps_of(session, ticket.id):
            if old_row.state not in ("done", "skipped", "superseded"):
                old_row.state = "superseded"
                session.add(old_row)
        await session.delete(existing)
        await session.commit()
    template = await get_template(session, ticket.project_id, template_key)
    if template is None:
        raise WorkflowError(f"No workflow called {template_key}.")
    wf = AiTicketWorkflow(
        ticket_id=ticket.id,
        project_id=ticket.project_id,
        template_key=template["key"],
        template_name=template["name"],
        template_version=template.get("version", 1),
        steps=json.dumps(template["steps"]),
        review_depth=depth,
        depth_by=depth_by or ("person" if depth else None),
        attached_by=by,
    )
    session.add(wf)
    # after an earlier workflow on the same ticket, the new steps come after its history
    base = max((r.seq for r in await steps_of(session, ticket.id)), default=-100) + 100
    wf.seq_base = base
    for i, step in enumerate(template["steps"]):
        session.add(
            AiTicketStep(
                ticket_id=ticket.id,
                seq=base + i * 100,
                idx=i,
                key=step["key"],
                label=step["label"],
                kind=step["kind"],
                role=step.get("role"),
            )
        )
    await session.commit()
    await session.refresh(wf)
    if start:
        await advance(ticket.id)
    return wf


async def _close_needs(
    session, ticket_id: str, waiting: list[str], *, by: str, why: str
) -> None:
    """The workflow no longer waits for anyone: its open flags resolve and the Needs you rows of its waiting steps
    close."""
    from services import notifications as centre

    for kind in flags.KINDS:
        await flags.resolve(session, ticket_id, kind, by=by, how=why)
    for step_id in waiting:
        await centre.resolve_target("step", step_id, why, by=by)
    await centre.resolve_target(
        "ticket", ticket_id, why, by=by, kinds=list(flags.KINDS)
    )


async def detach(session, ticket_id: str, *, by: str) -> None:
    """Take a ticket off its workflow (the step rows stay as history; a step that waited for a person no longer
    does; a run already going finishes as an odd job's would)."""
    wf = await session.get(AiTicketWorkflow, ticket_id)
    if wf is None:
        return
    wf.state = "detached"
    wf.updated_at = _now()
    session.add(wf)
    waiting = []
    for row in await steps_of(session, ticket_id):
        if row.state in ("pending", "active", "waiting", "blocked"):
            if row.state == "waiting":
                waiting.append(row.id)
            row.state = "skipped"
            row.note = f"Taken off the workflow by {by}."
            row.ended_at = _now()
            session.add(row)
    await session.commit()
    await _close_needs(
        session, ticket_id, waiting, by=by, why="The ticket was taken off its workflow."
    )


def _template_steps(wf: AiTicketWorkflow) -> list[dict]:
    return json.loads(wf.steps or "[]")


async def current_step(session, ticket_id: str) -> AiTicketStep | None:
    """The step being worked on (the latest attempt of the first step that is not done)."""
    rows = await steps_of(session, ticket_id)
    for r in rows:
        if r.state in ("pending", "active", "waiting", "blocked", "failed"):
            return r
    return None


async def resolve_member(
    session, project_id: str, ticket_id: str, role: str
) -> AiMember | None:
    """The member for a step's role: one that already worked on this ticket in that role, else a free one, else any."""
    from . import plugins as ai_plugins

    profiles = [
        p
        for p in (
            await session.exec(
                select(AiMember).where(AiMember.project_id == project_id)
            )
        ).all()
        if ai_plugins.role_of(p) == role and not p.paused
    ]
    if not profiles:
        return None
    done_here = {
        s.member_id
        for s in await steps_of(session, ticket_id)
        if s.role == role and s.member_id
    }
    for p in profiles:
        if p.id in done_here:
            return p
    busy = {
        r.member_id
        for r in (
            await session.exec(
                select(AiRun).where(
                    col(AiRun.state).in_(
                        ["queued", "starting", "running", "needs_input"]
                    )
                )
            )
        ).all()
    }
    free = [p for p in profiles if p.id not in busy]
    return (free or profiles)[0]


def _instruction(
    step: dict,
    row: AiTicketStep,
    wf: AiTicketWorkflow,
    previous_note: str | None,
    ticket: Ticket,
) -> str:
    parts = [
        f"You are doing the step “{step['label']}” of the workflow “{wf.template_name}” on {ticket.id}."
    ]
    if step.get("hands_in"):
        parts.append(
            f"What you must hand in: {step['hands_in']}. The step is not done until the board can see it."
        )
    if previous_note and "previous_note" in step.get("gives", []):
        parts.append(f"The previous step's note:\n{previous_note}")
    if row.note_in:
        parts.append(row.note_in)
    if step.get("role") == "reviewer":
        depth = wf.review_depth or step.get("depth") or "standard"
        parts.append(
            f"Review depth: {depth}. You get the diff, the criteria and the hand-over note, not the other AI's transcript. "
            "Check every acceptance criterion against the change"
            + (
                ", read the code around it and whoever calls it, and run the tests yourself"
                if depth == "deep"
                else ", and run the tests"
                if depth == "standard"
                else ""
            )
            + ". End your final message with exactly one line: `VERDICT: PASS`, or `VERDICT: CHANGES` followed by what to change and why. "
            "Do not repeat an objection you already made once it was answered."
        )
    if step.get("role") == "triage":
        parts.append(
            "Set the ticket's labels, then end your final message with `DEPTH: light`, `DEPTH: standard` or `DEPTH: deep` "
            "(light: a small obvious change; deep: a migration, money, permissions, or anything marked risky), and, when "
            "another workflow fits better, a line `WORKFLOW: quick_fix|standard|feature_ui|research`."
        )
    parts.append(
        "When you are done, report and end; the board moves the ticket to the next step. Do not hand the ticket to another AI yourself."
    )
    return "\n\n".join(parts)


# ticket id -> [its lock, how many callers hold or wait for it]
_ADVANCE_LOCKS: dict[str, list] = {}


async def advance(ticket_id: str) -> None:
    """Start whatever the workflow's current step needs: an AI run, the checks by code, or a person's decision.
    One at a time per ticket (the server is one process), so two callers never both start the same step."""
    entry = _ADVANCE_LOCKS.setdefault(ticket_id, [asyncio.Lock(), 0])
    entry[1] += 1
    try:
        async with entry[0]:
            await _advance(ticket_id)
    finally:
        entry[1] -= 1
        if entry[1] == 0 and _ADVANCE_LOCKS.get(ticket_id) is entry:
            _ADVANCE_LOCKS.pop(ticket_id, None)


async def _advance(ticket_id: str) -> None:
    async with database.async_session() as session:
        wf = await session.get(AiTicketWorkflow, ticket_id)
        ticket = await session.get(Ticket, ticket_id)
        if wf is None or ticket is None or wf.state not in ("active",):
            return
        row = await current_step(session, ticket_id)
        if row is None:
            wf.state = "done"
            session.add(wf)
            await session.commit()
            return
        if row.state not in ("pending",):
            return
        steps = _template_steps(wf)
        step = (
            steps[row.idx]
            if row.idx < len(steps)
            else {"label": row.label, "kind": row.kind, "role": row.role}
        )
        previous = (
            await session.exec(
                select(AiTicketStep)
                .where(
                    AiTicketStep.ticket_id == ticket_id,
                    AiTicketStep.state == "done",
                    col(AiTicketStep.seq) < row.seq,
                )
                .order_by(col(AiTicketStep.seq).desc())
            )
        ).first()
        prev_note = previous.note if previous else None
        if row.kind == "person":
            row.state = "waiting"
            row.started_at = _now()
            session.add(row)
            await session.commit()
            await _tell_person(session, ticket, row)
            if row.key == "done" and ticket.status not in ("review", "done"):
                from services import tickets as svc_tickets

                await svc_tickets.update_ticket(
                    session, ticket.id, TicketUpdate(status="review")
                )
            return
        if row.kind == "code":
            row.state = "active"
            row.started_at = _now()
            session.add(row)
            await session.commit()
            _start_checks(ticket_id, row.id)
            return
        member = await resolve_member(session, wf.project_id, ticket_id, row.role)
        if member is None:
            row.state = "blocked"
            row.note = f"No member for the role {row.role} on this project."
            session.add(row)
            await session.commit()
            await flags.open_flag(
                session,
                ticket_id,
                wf.project_id,
                "no_member",
                {"role": row.role, "step": row.label},
            )
            return
        from . import runs

        model, effort = step.get("model"), step.get("effort")
        if row.role == "reviewer":
            model = model or DEPTH_MODEL.get(
                wf.review_depth or step.get("depth") or "standard"
            )
        if row.attempt > 1 and step.get("retry_model"):
            model, effort = step["retry_model"], "high"
        elif row.attempt > 1 and row.role == "dev":
            # Opus at high only on the second attempt at the same step, never on the first (pack Dev, C)
            model, effort = "opus", "high"
        if ticket.assignee != member.id:
            from services import tickets as svc_tickets

            await svc_tickets.update_ticket(
                session, ticket.id, TicketUpdate(assignee=member.id)
            )
        try:
            run = await runs.create_run(
                session,
                ticket_id=ticket_id,
                member_id=member.id,
                mode="work",
                trigger="workflow",
                started_by=wf.attached_by or "user",
                instruction=_instruction(step, row, wf, prev_note, ticket),
                model_override=model,
                effort_override=effort,
            )
        except runs.RunError as exc:
            row.state = "blocked"
            row.note = str(exc)
            session.add(row)
            await session.commit()
            return
        row.state = "active"
        row.member_id = member.id
        row.run_id = run.id
        row.started_at = _now()
        session.add(row)
        await session.commit()


_TASKS: set[asyncio.Task] = set()


def _start_checks(ticket_id: str, step_id: str) -> None:
    task = asyncio.get_running_loop().create_task(_run_checks(ticket_id, step_id))
    _TASKS.add(task)
    task.add_done_callback(_TASKS.discard)


async def recover() -> int:
    """At startup: the Checks of a step left `active` ran in a task the restart killed; run them again."""
    async with database.async_session() as session:
        rows = (
            await session.exec(
                select(AiTicketStep).where(
                    AiTicketStep.kind == "code", AiTicketStep.state == "active"
                )
            )
        ).all()
        todo = []
        for row in rows:
            wf = await session.get(AiTicketWorkflow, row.ticket_id)
            if wf is not None and wf.state == "active" and row.seq >= wf.seq_base:
                todo.append((row.ticket_id, row.id))
    for ticket_id, step_id in todo:
        _start_checks(ticket_id, step_id)
    return len(todo)


async def _tell_person(session, ticket: Ticket, row: AiTicketStep) -> None:
    from services import notifications as centre

    recipients = await centre.owners_and_admins(session, ticket.project_id)
    if row.key == "done":
        return  # the last step is the ticket in Review: the board already shows it there
    await centre.emit(
        "workflow_step",
        project_id=ticket.project_id,
        recipients=recipients,
        title=f"{ticket.id}: {row.label}",
        body=f"The workflow waits for you at “{row.label}”.",
        target_kind="step",
        target_id=row.id,
        ticket_id=ticket.id,
        data={"step": row.key},
        session=session,
    )


async def _run_checks(ticket_id: str, step_id: str) -> None:
    """The Checks step, by code: the project's test, lint and build commands in the ticket's worktree (or folder)."""
    try:
        async with database.async_session() as session:
            row = await session.get(AiTicketStep, step_id)
            wf = await session.get(AiTicketWorkflow, ticket_id)
            settings = await get_settings(session, wf.project_id)
            cmds = {
                k: v
                for k, v in (ops.get(settings).get("commands") or {}).items()
                if (v or "").strip()
            }
            from models import AiWorktree

            wt = await session.get(AiWorktree, ticket_id)
            folder = (
                wt.path
                if wt is not None
                and wt.state in ("active", "conflict", "kept")
                and Path(wt.path).is_dir()
                else None
            )
            if folder is None:
                last = (
                    await session.exec(
                        select(AiTicketStep)
                        .where(
                            AiTicketStep.ticket_id == ticket_id,
                            col(AiTicketStep.member_id).is_not(None),
                        )
                        .order_by(col(AiTicketStep.seq).desc())
                    )
                ).first()
                prof = await session.get(AiMember, last.member_id) if last else None
                folder = prof.working_dir if prof else None
        if cmds and not (folder and Path(folder).expanduser().is_dir()):
            # commands that never ran prove nothing: the review must not start on them
            async with database.async_session() as session:
                row = await session.get(AiTicketStep, step_id)
                if row is None or row.state != "active":
                    return
                row.state = "blocked"
                row.result = json.dumps(
                    {"checks": [], "no_commands": False, "no_folder": True}
                )
                row.note = (
                    "The check commands are set, but there is no folder to run them in: the ticket has no "
                    "worktree and no AI member that worked on it has a working folder."
                )
                session.add(row)
                await session.commit()
            return
        results = []
        ok = True
        for name in ("lint", "build", "test"):
            cmd = cmds.get(name)
            if not cmd:
                continue
            started = datetime.now(UTC)
            try:
                res = await asyncio.to_thread(
                    subprocess.run,
                    cmd,
                    shell=True,
                    cwd=str(Path(folder).expanduser()),
                    capture_output=True,
                    text=True,
                    timeout=20 * 60,
                )
                tail = (res.stdout + res.stderr).strip().splitlines()[-15:]
                passed = res.returncode == 0
            except subprocess.TimeoutExpired:
                tail, passed = ["Timed out after 20 minutes."], False
            results.append(
                {
                    "name": name,
                    "command": cmd,
                    "ok": passed,
                    "tail": tail,
                    "seconds": int((datetime.now(UTC) - started).total_seconds()),
                }
            )
            ok = ok and passed
            if not passed:
                break
        evidence = await tdd_evidence(ticket_id)
        async with database.async_session() as session:
            row = await session.get(AiTicketStep, step_id)
            if row is None or row.state != "active":
                return  # sent back, skipped or detached while the checks ran
            row.result = json.dumps(
                {"checks": results, "tdd": evidence, "no_commands": not cmds}
            )
            row.ended_at = _now()
            if ok:
                row.state = "done"
                row.note = (
                    "Checks passed: " + ", ".join(r["name"] for r in results)
                    if results
                    else "No check commands are set for this project."
                )
                session.add(row)
                await session.commit()
            else:
                row.state = "done"
                row.outcome = "failed"
                row.note = (
                    f"{results[-1]['name']} failed: `{results[-1]['command']}`\n"
                    + "\n".join(results[-1]["tail"])
                )
                session.add(row)
                await session.commit()
        if ok:
            await advance(ticket_id)
        else:
            await send_back(
                ticket_id,
                to_role="dev",
                note=f"The checks failed. Fix this before anything else:\n{row.note}",
                by="Checks",
                from_role="checks",
            )
    except Exception as exc:  # noqa: BLE001 - the step must fail where a person sees it, never stay active
        logger.exception("Checks failed to run on %s", ticket_id)
        try:
            async with database.async_session() as session:
                row = await session.get(AiTicketStep, step_id)
                if row is not None and row.state == "active":
                    row.state = "failed"
                    row.ended_at = _now()
                    row.note = f"The checks could not run: {exc}"[:2000]
                    session.add(row)
                    await session.commit()
        except Exception:  # noqa: BLE001
            logger.exception("Could not mark the checks of %s as failed", ticket_id)


async def send_back(
    ticket_id: str, *, to_role: str, note: str, by: str, from_role: str | None = None
) -> AiTicketStep | None:
    """Back to the last step done by `to_role` (a new attempt of it, after the steps already done), then on again.
    Counts a round between the two roles and stops on no progress (D11)."""
    async with database.async_session() as session:
        wf = await session.get(AiTicketWorkflow, ticket_id)
        if wf is None or wf.state != "active":
            return None
        rows = await steps_of(session, ticket_id)
        target = next(
            (r for r in reversed(rows) if r.role == to_role and r.kind == "ai"), None
        )
        if target is None:
            return None
        current = await current_step(session, ticket_id)
        sender_role = from_role or (
            current.role if current and current.role else by.lower()
        )
        pair = "|".join(sorted([to_role, str(sender_role)]))
        rounds = json.loads(wf.rounds or "{}")
        rounds[pair] = rounds.get(pair, 0) + 1
        wf.rounds = json.dumps(rounds)
        objections = json.loads(wf.objections or "[]")
        objections.append(
            {
                "at": _now(),
                "by": by,
                "role": sender_role,
                "text": note[:2000],
                "diff": await _diff_size(session, ticket_id),
            }
        )
        wf.objections = json.dumps(objections[-20:])
        session.add(wf)
        # every step after the target becomes pending again (a new attempt row each, so history is kept)
        base_seq = max(r.seq for r in rows) + 1
        later_template = [
            r for r in rows if r.idx >= target.idx and r.state != "superseded"
        ]
        latest_by_idx: dict[int, AiTicketStep] = {}
        for r in later_template:
            latest_by_idx[r.idx] = r
        new_target = None
        to_cancel: list[str] = []
        for i, idx in enumerate(sorted(latest_by_idx)):
            old = latest_by_idx[idx]
            if old.state in ("pending", "active", "waiting", "blocked"):
                if old.state == "active" and old.run_id:
                    to_cancel.append(old.run_id)
                old.state = "superseded"
                session.add(old)
            fresh = AiTicketStep(
                ticket_id=ticket_id,
                seq=base_seq + i,
                idx=old.idx,
                key=old.key,
                label=old.label,
                kind=old.kind,
                role=old.role,
                attempt=old.attempt + 1 if idx == target.idx else old.attempt,
                note_in=(f"Sent back by {by}: {note}" if idx == target.idx else None),
                member_id=old.member_id if idx == target.idx else None,
            )
            session.add(fresh)
            if idx == target.idx:
                new_target = fresh
        await session.commit()
        # the step's run is no longer wanted: its end finds the row superseded and moves nothing (on_run_ended)
        await _cancel_runs(to_cancel, by=by, reason=f"Sent back by {by}.")
        # only two AIs going round is no progress: Checks are facts, and a person is never overruled (D24)
        ai_pair = not {to_role, str(sender_role)} & NOT_AI_ROLES
        stop = await _no_progress(session, wf, pair, rounds[pair]) if ai_pair else None
        if stop:
            if new_target is not None:
                new_target.state = "blocked"
                session.add(new_target)
            wf.state = "stopped"
            wf.stop_reason = "no_progress"
            wf.stop_detail = stop
            session.add(wf)
            await session.commit()
            await start_arbitration(ticket_id, why=stop)
            return new_target
        # a ticket sent back twice moves up a review level, only when Triage chose the level (G)
        if (
            to_role == "dev"
            and rounds[pair] >= 2
            and wf.depth_by == "triage"
            and wf.review_depth
            and wf.review_depth != "deep"
        ):
            wf.review_depth = DEPTH_UP[wf.review_depth]
            wf.depth_note = (
                f"Sent back twice: the review moved up to {wf.review_depth}."
            )
            session.add(wf)
            await session.commit()
        elif (
            to_role == "dev"
            and rounds[pair] >= 2
            and wf.depth_by == "person"
            and wf.review_depth != "deep"
        ):
            wf.depth_note = (
                "Sent back twice: the depth would have gone up, but you set it by hand."
            )
            session.add(wf)
            await session.commit()
    await advance(ticket_id)
    return new_target


async def _cancel_runs(run_ids: list[str], *, by: str, reason: str) -> None:
    from . import runs

    for run_id in run_ids:
        try:
            await runs.cancel(run_id, by=by, reason=reason, revert_status=False)
        except runs.RunError:
            pass  # it already ended


async def _diff_size(session, ticket_id: str) -> int | None:
    """Lines changed on the ticket's branch against its base (the worktree), or None."""
    from models import AiWorktree

    wt = await session.get(AiWorktree, ticket_id)
    if wt is None or not Path(wt.path).is_dir():
        return None
    try:
        out = await asyncio.to_thread(
            subprocess.run,
            ["git", "diff", "--shortstat", wt.base],
            cwd=wt.path,
            capture_output=True,
            text=True,
            timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    nums = [int(n) for n in re.findall(r"(\d+) (?:insertion|deletion)", out.stdout)]
    return sum(nums) if out.returncode == 0 else None


async def _no_progress(
    session, wf: AiTicketWorkflow, pair: str, count: int
) -> str | None:
    """Why the loop stops, or None: the same two roles swapped it three times and the diff changed by under 5%
    between the last two, or the reviewer repeated an objection it already made."""
    objections = [
        o
        for o in json.loads(wf.objections or "[]")
        if o.get("role") not in NOT_AI_ROLES
    ]
    if len(objections) >= 2:
        last, *earlier = reversed(objections)
        for prev in earlier:
            if (
                prev.get("role") == last.get("role")
                and fuzz.token_set_ratio(prev["text"], last["text"])
                >= REPEAT_SIMILARITY
            ):
                return f"The {last.get('role')} repeated an objection it already made: “{last['text'][:160]}”."
    if count >= NO_PROGRESS_ROUNDS and len(objections) >= 2:
        a, b = objections[-2].get("diff"), objections[-1].get("diff")
        if (
            a is not None
            and b is not None
            and max(a, b) > 0
            and abs(a - b) / max(a, b) < NO_PROGRESS_DIFF
        ):
            return f"Passed back and forth {count} times and the diff barely changed ({a} → {b} lines)."
        if a is None or b is None:
            return None
    return None


async def _retried_row(
    session, wf: AiTicketWorkflow, run: AiRun
) -> AiTicketStep | None:
    """The failed step a "Try again", "Continue with a note" or "Hand to another AI" run carries on (it has a new
    run id): the latest failed AI step of the ticket's workflow; a retry must also be that step's own instruction."""
    failed = [
        r
        for r in await steps_of(session, run.ticket_id)
        if r.state == "failed" and r.kind == "ai"
    ]
    if not failed:
        return None
    row = failed[-1]
    if run.trigger == "retry" and f"the step “{row.label}”" not in (
        run.instruction or ""
    ):
        return None  # a retry of some other run on this ticket
    return row


async def on_run_ended(run_id: str) -> None:
    """A run of a workflow step ended: finish the step and move on, send it back, or stop."""
    async with database.async_session() as session:
        run = await session.get(AiRun, run_id)
        if run is None:
            return
        row = (
            await session.exec(
                select(AiTicketStep).where(AiTicketStep.run_id == run_id)
            )
        ).first()
        wf = await session.get(AiTicketWorkflow, run.ticket_id)
        if wf is None:
            return
        if row is None:
            row = (
                await session.exec(
                    select(AiTicketStep).where(
                        AiTicketStep.ticket_id == run.ticket_id,
                        AiTicketStep.state == "active",
                        AiTicketStep.member_id == run.member_id,
                    )
                )
            ).first()
        if (
            row is None
            and run.trigger in ("retry", "handoff")
            and (
                wf.state == "active"
                or (wf.state == "stopped" and wf.stop_reason == "board_fault")
            )
        ):
            row = await _retried_row(session, wf, run)
            if row is not None:
                # the retry takes the failed step back: it is this step's run now
                row.state, row.run_id, row.member_id = "active", run.id, run.member_id
                row.note = None
                session.add(row)
                if wf.state == "stopped" and wf.stop_reason == "board_fault":
                    wf.state, wf.stop_reason, wf.stop_detail = "active", None, None
                    session.add(wf)
                    await session.commit()
                    await flags.resolve(
                        session,
                        run.ticket_id,
                        "board_fault",
                        by=run.started_by or "user",
                        how=f"Retried in run #{run.number}",
                    )
                await session.commit()
        # a step sent back, skipped or settled while its run went on: that run's end moves nothing
        if row is None or row.state != "active" or wf.state != "active":
            return
        report = loads(run.report, {}) or {}
        # the run's summary is often the report's own: each distinct text once
        text = "\n".join(
            dict.fromkeys(x for x in (report.get("summary"), run.summary) if x)
        )
        if run.state != "finished":
            diag = loads(run.diagnosis, {}) or {}
            row.state = "failed"
            row.note = run.ended_reason
            row.ended_at = _now()
            session.add(row)
            if diag.get("board_fault"):
                wf.state = "stopped"
                wf.stop_reason = "board_fault"
                wf.stop_detail = diag.get("what")
                session.add(wf)
                await session.commit()
                await flags.open_flag(
                    session,
                    run.ticket_id,
                    wf.project_id,
                    "board_fault",
                    {"step": row.label, "what": diag.get("what")},
                )
            else:
                await session.commit()
            return
        verdict = VERDICT.findall(text)
        row.state = "done"
        row.note = text[:4000] or "Done."
        row.ended_at = _now()
        if row.role == "triage":
            # Triage may pick another template while nothing after it has started (D8: it picks, a person changes it)
            pick = re.search(r"WORKFLOW:\s*([a-z_]+)", text, re.IGNORECASE)
            if pick and pick.group(1).lower() != wf.template_key:
                chosen = await get_template(
                    session, wf.project_id, pick.group(1).lower()
                )
                started_later = [
                    r
                    for r in await steps_of(session, run.ticket_id)
                    if r.idx > row.idx and r.state != "pending"
                ]
                if chosen is not None and not started_later:
                    for r in await steps_of(session, run.ticket_id):
                        if r.idx > row.idx:
                            await session.delete(r)
                    wf.template_key, wf.template_name = chosen["key"], chosen["name"]
                    wf.template_version = chosen.get("version", 1)
                    wf.steps = json.dumps(chosen["steps"])
                    for i, step in enumerate(chosen["steps"]):
                        if i == 0 and step.get("role") == "triage":
                            continue  # its own Triage step is the one just done
                        session.add(
                            AiTicketStep(
                                ticket_id=run.ticket_id,
                                seq=wf.seq_base + i * 100,
                                idx=i,
                                key=step["key"],
                                label=step["label"],
                                kind=step["kind"],
                                role=step.get("role"),
                            )
                        )
                    session.add(wf)
            m = re.search(r"DEPTH:\s*(light|standard|deep)", text, re.IGNORECASE)
            if m and wf.depth_by != "person":
                wf.review_depth = m.group(1).lower()
                wf.depth_by = "triage"
                session.add(wf)
        session.add(row)
        await session.commit()
        if row.role == "reviewer" and verdict and verdict[-1].upper() == "CHANGES":
            row.outcome = "changes"
            session.add(row)
            await session.commit()
            changes = text.split("VERDICT:")[-1]
            await send_back(
                run.ticket_id,
                to_role="dev",
                note=changes.strip()[:2000] or text[:2000],
                by="Reviewer",
                from_role="reviewer",
            )
            return
        if row.role == "reviewer":
            row.outcome = "pass"
            session.add(row)
            await session.commit()
    await advance(run.ticket_id)


async def decide_person_step(
    ticket_id: str, *, approve: bool, note: str | None, by: str
) -> None:
    """A person decided the step that waits for them: approve moves on; send back returns to the step before it."""
    async with database.async_session() as session:
        row = await current_step(session, ticket_id)
        if row is None or row.kind != "person" or row.state != "waiting":
            raise WorkflowError("The workflow is not waiting for you.")
        if row.key == "done" and approve:
            raise WorkflowError("Move the ticket to Done to finish it.")
        row.state = "done"
        row.outcome = "approved" if approve else "sent_back"
        row.member_id = None
        row.note = f"{'Approved' if approve else 'Sent back'} by {by}" + (
            f": {note}" if note else ""
        )
        row.ended_at = _now()
        session.add(row)
        await session.commit()
        prev_ai = next(
            (
                r
                for r in reversed(await steps_of(session, ticket_id))
                if r.kind == "ai" and r.seq < row.seq
            ),
            None,
        )
    if approve:
        await advance(ticket_id)
    elif prev_ai is not None:
        await send_back(
            ticket_id,
            to_role=prev_ai.role,
            note=note or "Changes requested.",
            by=by,
            from_role="person",
        )


async def on_ticket_done(ticket_id: str) -> None:
    """The ticket reached Done: the last step is done and the workflow ends."""
    async with database.async_session() as session:
        wf = await session.get(AiTicketWorkflow, ticket_id)
        if wf is None or wf.state in ("done", "detached"):
            return
        waiting = []
        for row in await steps_of(session, ticket_id):
            if row.state in ("pending", "waiting", "active", "blocked"):
                if row.state == "waiting":
                    waiting.append(row.id)
                row.state = "done" if row.key == "done" else "skipped"
                row.ended_at = _now()
                session.add(row)
        wf.state = "done"
        wf.updated_at = _now()
        session.add(wf)
        await session.commit()
        await _close_needs(
            session, ticket_id, waiting, by="user", why="The ticket is Done."
        )


# ---------------------------------------------------------------------------
# Arbitration (D12, D24; design H)
# ---------------------------------------------------------------------------

ARBITRATION_TASK = (
    "You are the coordinator. Two AIs on {ticket} are not converging: {why}\n\n"
    "The reviewer's objections, newest last:\n{objections}\n\n"
    "The developer's last notes:\n{dev}\n\n"
    "Read the ticket, its criteria and the diff. Decide: side with the reviewer (the developer must make the change), "
    "side with the developer (the review passes), or split the ticket (the disputed part becomes a ticket of its own). "
    "You may propose a change to an acceptance criterion but never make one. If it is a product question only a person "
    "can answer, say you cannot decide. End your final message with exactly one line: `VERDICT: REVIEWER`, "
    "`VERDICT: DEV`, `VERDICT: SPLIT` or `VERDICT: UNDECIDED`, then one sentence of reason."
)


async def coordinator(
    session, project_id: str, exclude: set[str] | frozenset[str] = frozenset()
) -> AiMember | None:
    """The coordinator: the project's chosen PM member, else the first member made from the PM pack. Never a paused
    member, nor one in `exclude` (a party to the dispute: it cannot be independent of both, D12)."""
    from . import plugins as ai_plugins

    def fits(p: AiMember | None) -> bool:
        return p is not None and not p.paused and p.id not in exclude

    settings = await get_settings(session, project_id)
    chosen = ops.get(settings).get("coordinator_id")
    if chosen:
        prof = await session.get(AiMember, chosen)
        if fits(prof) and prof.project_id == project_id:
            return prof
    for p in (
        await session.exec(select(AiMember).where(AiMember.project_id == project_id))
    ).all():
        if ai_plugins.role_of(p) == "pm" and fits(p):
            return p
    return None


async def start_arbitration(ticket_id: str, *, why: str) -> AiRun | None:
    """No progress: the coordinator rules first (one chance); a second time, with no coordinator free of the
    dispute, or one that cannot start, it goes to a person with the ruling attached."""
    from services import notifications as centre

    from . import runs

    async with database.async_session() as session:
        wf = await session.get(AiTicketWorkflow, ticket_id)
        ticket = await session.get(Ticket, ticket_id)
        if wf is None or ticket is None:
            return None
        rulings = json.loads(wf.rulings or "[]")
        rows = await steps_of(session, ticket_id)
        # whoever worked on the ticket's steps is a party to it, not an independent coordinator
        parties = {s.member_id for s in rows if s.member_id}
        pm = None if rulings else await coordinator(session, wf.project_id, parties)
        run = None
        could_not_start = None
        if pm is not None:
            objections = [
                o
                for o in json.loads(wf.objections or "[]")
                if o.get("role") not in NOT_AI_ROLES
            ]
            dev_notes = [s.note for s in rows if s.role == "dev" and s.note][-2:]
            try:
                run = await runs.create_run(
                    session,
                    ticket_id=ticket_id,
                    member_id=pm.id,
                    mode="work",
                    trigger="arbitration",
                    started_by=wf.attached_by or "user",
                    instruction=ARBITRATION_TASK.format(
                        ticket=ticket_id,
                        why=why,
                        objections="\n".join(
                            f"- {o['text'][:600]}" for o in objections[-4:]
                        )
                        or "(none recorded)",
                        dev="\n".join(f"- {n[:600]}" for n in dev_notes)
                        or "(none recorded)",
                    ),
                    wait_for_hold=True,
                )
            except runs.RunError as exc:
                could_not_start = str(exc)
        await flags.open_flag(
            session,
            ticket_id,
            wf.project_id,
            "arbitration",
            {
                "why": why,
                "rulings": rulings,
                "with": "coordinator" if run is not None else "person",
                **({"coordinator_error": could_not_start} if could_not_start else {}),
            },
        )
        if run is not None:
            wf.arbitration_run_id = run.id
            session.add(wf)
            await session.commit()
            return run
        if rulings:
            title, extra = (
                ": the coordinator could not settle it",
                f" Ruling: {rulings[-1]['verdict']} — {rulings[-1]['reason']}",
            )
        elif could_not_start:
            title, extra = (
                ": the coordinator could not start",
                f" The coordinator could not start: {could_not_start}",
            )
        else:
            title, extra = "", ""
        await centre.emit(
            "arbitration",
            project_id=wf.project_id,
            recipients=await centre.owners_and_admins(session, wf.project_id),
            title=f"Dev and Reviewer are not converging on {ticket_id}{title}",
            body=why + extra,
            target_kind="ticket",
            target_id=ticket_id,
            ticket_id=ticket_id,
            data={"why": why, "rulings": rulings},
            session=session,
        )
        return None


async def on_arbitration_ended(run_id: str) -> None:
    """The coordinator ruled: apply it, or pass it to a person."""
    async with database.async_session() as session:
        run = await session.get(AiRun, run_id)
        wf = await session.get(AiTicketWorkflow, run.ticket_id) if run else None
        if run is None or wf is None or wf.arbitration_run_id != run_id:
            return
        text = (
            "\n".join(
                x
                for x in ((loads(run.report, {}) or {}).get("summary"), run.summary)
                if x
            )
            or ""
        )
        found = VERDICT.findall(text)
        verdict = found[-1].upper() if found else "UNDECIDED"
        reason = (
            text.split("VERDICT:")[-1].split("\n", 1)[-1].strip()[:400]
            if found
            else (run.ended_reason or "No ruling.")
        )
        rulings = json.loads(wf.rulings or "[]")
        rulings.append(
            {
                "at": _now(),
                "by": "coordinator",
                "member_id": run.member_id,
                "verdict": verdict.lower(),
                "reason": reason,
                "run_id": run_id,
            }
        )
        wf.rulings = json.dumps(rulings)
        wf.arbitration_run_id = None
        session.add(wf)
        await session.commit()
    if verdict in ("REVIEWER", "DEV", "SPLIT"):
        await apply_ruling(
            run.ticket_id, verdict.lower(), by="the coordinator", reason=reason
        )
    else:
        await start_arbitration(
            run.ticket_id, why=f"The coordinator could not decide: {reason}"
        )


async def apply_ruling(ticket_id: str, side: str, *, by: str, reason: str = "") -> dict:
    """Side with the reviewer (back to the developer), with the developer (the review passes), or split the ticket."""
    from services import tickets as svc_tickets

    async with database.async_session() as session:
        wf = await session.get(AiTicketWorkflow, ticket_id)
        ticket = await session.get(Ticket, ticket_id)
        if wf is None or ticket is None:
            raise WorkflowError("This ticket follows no workflow.")
        await flags.resolve(
            session, ticket_id, "arbitration", by=by, how=f"{side}: {reason}"[:400]
        )
        if by != "the coordinator":
            rulings = json.loads(wf.rulings or "[]")
            rulings.append({"at": _now(), "by": by, "verdict": side, "reason": reason})
            wf.rulings = json.dumps(rulings)
        wf.state = "active"
        wf.stop_reason = None
        wf.rounds = json.dumps({})
        session.add(wf)
        await session.commit()
        objections = json.loads(wf.objections or "[]")
        last = objections[-1]["text"] if objections else ""
        rows = await steps_of(session, ticket_id)
        blocked = next((r for r in reversed(rows) if r.state == "blocked"), None)
        out: dict = {"side": side}
        if side == "reviewer":
            if blocked is not None:
                blocked.state = "pending"
                blocked.note_in = f"Ruling ({by}): the reviewer is right. {reason}\nWhat to change: {last}"
                session.add(blocked)
                await session.commit()
        elif side in ("dev", "split"):
            # the dispute is settled: the work the reviewer asked for is not done, but the Checks still run and the
            # review still happens (everything is reviewed, D13), told of the ruling
            review = next((r for r in reversed(rows) if r.role == "reviewer"), None)
            for r in rows:
                if r.state not in ("blocked", "pending") or (
                    review is not None and r.idx > review.idx
                ):
                    continue
                if r.kind == "code" or r.role == "reviewer":
                    r.state = "pending"
                    if r.role == "reviewer":
                        r.note_in = (
                            f"Ruling ({by}): the developer is right on “{last[:600]}”. {reason}\n"
                            "Do not raise that objection again; review the rest."
                        )
                else:
                    r.state = "skipped"
                    r.note = f"Settled by {by}: {side}"
                session.add(r)
            await session.commit()
            if side == "split":
                child = await svc_tickets.create_ticket(
                    session,
                    ticket.project_id,
                    f"From {ticket_id}: {last[:80]}"
                    if last
                    else f"Split from {ticket_id}",
                    description=f"Split from {ticket_id} by {by}.\n\n{last}",
                    parent_id=ticket_id,
                    status="todo",
                    created_by=by,
                )
                out["new_ticket"] = child.id
    await advance(ticket_id)
    return out


# ---------------------------------------------------------------------------
# Test-first evidence (design I)
# ---------------------------------------------------------------------------

_ASSERTION = re.compile(
    r"(AssertionError|assert\s|expected\b|toBe|toEqual|toMatch|Expected:|FAILED .*::|✗|×\s)",
    re.IGNORECASE,
)
_NOT_RUN = re.compile(
    r"(ImportError|ModuleNotFoundError|SyntaxError|IndentationError|collection error|errors during collection|Cannot find module|ENOENT|No such file|not found|TypeError: .* is not a function)",
    re.IGNORECASE,
)


def _test_file(command: str, output: str) -> str | None:
    m = re.search(
        r"([\w./-]+(?:test[\w.-]*|_test|\.test|\.spec)\.(?:py|ts|tsx|js|jsx|go|rs))",
        f"{command}\n{output}",
    )
    return m.group(1) if m else None


def _step_iso(run: AiRun, at: str | None) -> str | None:
    """A step's time ("HH:MM:SS", UTC) as a full ISO time on its run's day, so the page can show it in local time."""
    day = (run.started_at or run.queued_at or "")[:10]
    if not at or len(at) != 8 or not day:
        return at
    return f"{day}T{at}+00:00"


async def tdd_evidence(ticket_id: str) -> dict:
    """A red run and a later green one, matched by command, test file and test name, red only on an assertion (a run
    that died on an import error or a typo never ran the test, so it proves nothing). Read from the runs' own command
    steps — nothing new is recorded."""
    async with database.async_session() as session:
        rows = (
            await session.exec(
                select(AiRun)
                .where(AiRun.ticket_id == ticket_id, AiRun.mode == "work")
                .order_by(col(AiRun.queued_at))
            )
        ).all()
    events = []
    for run in rows:
        for st in loads(run.steps, []):
            if st.get("kind") == "command" and st.get("tests"):
                events.append(
                    {
                        "run_id": run.id,
                        "number": run.number,
                        "at": _step_iso(run, st.get("at")),
                        "command": st.get("text", "")[4:],
                        "tests": st["tests"],
                        "output": st.get("output") or "",
                    }
                )
    red = None
    for ev in events:
        failed = ev["tests"].get("failed", 0)
        if failed and red is None:
            if _NOT_RUN.search(ev["output"]) and not _ASSERTION.search(ev["output"]):
                continue  # the suite never ran the test: not evidence
            if not _ASSERTION.search(ev["output"]):
                continue
            red = ev
        elif red is not None and not failed and ev["tests"].get("passed"):
            same_cmd = (
                ev["command"].split("|")[0].strip()
                == red["command"].split("|")[0].strip()
            )
            names = red["tests"].get("failing") or []
            if same_cmd and (
                not names
                or not any(n in ev["output"] for n in names if "FAIL" in ev["output"])
            ):
                return {
                    "proven": True,
                    "red": {
                        "run": red["number"],
                        "at": red["at"],
                        "command": red["command"],
                        "failed": red["tests"]["failed"],
                        "failing": names,
                        "why": "failed on an assertion",
                    },
                    "green": {
                        "run": ev["number"],
                        "at": ev["at"],
                        "command": ev["command"],
                        "passed": ev["tests"]["passed"],
                    },
                    "file": _test_file(red["command"], red["output"]),
                }
    return {
        "proven": False,
        "why": "No run where a test failed on an assertion and then passed with the same command."
        if events
        else "No test run was recorded on this ticket.",
        "runs_seen": len(events),
    }


# ---------------------------------------------------------------------------
# For the API and the screens
# ---------------------------------------------------------------------------


async def view(session, ticket_id: str) -> dict | None:
    """The ticket's workflow as the strip draws it: template, depth, every step row with who did it, the stop."""
    wf = await session.get(AiTicketWorkflow, ticket_id)
    if wf is None or not wf.template_key:
        return None  # an odd job (only a reviewer set) is not a workflow
    rows = await steps_of(session, ticket_id)
    names = {
        m.id: m.name
        for m in (
            await session.exec(
                select(Member).where(
                    col(Member.id).in_({r.member_id for r in rows if r.member_id})
                )
            )
        ).all()
    }
    return {
        "ticket_id": ticket_id,
        "template_key": wf.template_key,
        "template_name": wf.template_name,
        "template_version": wf.template_version,
        "state": wf.state,
        "stop_reason": wf.stop_reason,
        "stop_detail": wf.stop_detail,
        "review_depth": wf.review_depth,
        "depth_by": wf.depth_by,
        "depth_note": wf.depth_note,
        "rounds": json.loads(wf.rounds or "{}"),
        "rulings": json.loads(wf.rulings or "[]"),
        "objections": json.loads(wf.objections or "[]"),
        "steps": [
            {
                "id": r.id,
                "idx": r.idx,
                "key": r.key,
                "label": r.label,
                "kind": r.kind,
                "role": r.role,
                "state": r.state,
                "attempt": r.attempt,
                "member_id": r.member_id,
                "member_name": names.get(r.member_id or ""),
                "run_id": r.run_id,
                "note": r.note,
                "note_in": r.note_in,
                "outcome": r.outcome,
                "result": json.loads(r.result) if r.result else None,
                "started_at": r.started_at,
                "ended_at": r.ended_at,
            }
            for r in rows
            if r.state != "superseded"
        ],
    }


async def set_depth(session, ticket_id: str, depth: str, *, by: str) -> None:
    """A person sets the review depth (it is then never raised by itself)."""
    if depth not in DEPTH_MODEL:
        raise WorkflowError("The depth is light, standard or deep.")
    wf = await session.get(AiTicketWorkflow, ticket_id)
    if wf is None:
        raise WorkflowError("This ticket follows no workflow.")
    wf.review_depth = depth
    wf.depth_by = "person"
    wf.depth_note = f"Set to {depth} by {by}."
    session.add(wf)
    await session.commit()


async def metrics(session, project_id: str, days: int = 30) -> list[dict]:
    """Per template, over the last `days`: tickets, median time to done, passed review first, rounds, cost per ticket."""
    from datetime import timedelta
    from statistics import median

    since = (datetime.now(UTC) - timedelta(days=days)).isoformat()
    wfs = (
        await session.exec(
            select(AiTicketWorkflow).where(
                AiTicketWorkflow.project_id == project_id,
                col(AiTicketWorkflow.created_at) >= since,
            )
        )
    ).all()
    out = []
    for key in {w.template_key for w in wfs} | {t["key"] for t in BUILTIN_TEMPLATES}:
        group = [w for w in wfs if w.template_key == key]
        durations, first_pass, rounds_all, costs = [], 0, [], []
        for w in group:
            rows = await steps_of(session, w.ticket_id)
            if w.state == "done":
                try:
                    durations.append(
                        (
                            datetime.fromisoformat(w.updated_at)
                            - datetime.fromisoformat(w.created_at)
                        ).total_seconds()
                    )
                except (TypeError, ValueError):
                    pass
            reviews = [r for r in rows if r.role == "reviewer" and r.outcome]
            if reviews and reviews[0].outcome == "pass":
                first_pass += 1
            rounds_all.append(sum(json.loads(w.rounds or "{}").values()))
            runs_ = (
                await session.exec(select(AiRun).where(AiRun.ticket_id == w.ticket_id))
            ).all()
            costs.append(sum(r.cost_usd or 0 for r in runs_))
        reviewed = 0
        for w in group:
            if any(
                r.role == "reviewer" and r.outcome
                for r in await steps_of(session, w.ticket_id)
            ):
                reviewed += 1
        out.append(
            {
                "template_key": key,
                "tickets": len(group),
                "median_hours": round(median(durations) / 3600, 1)
                if durations
                else None,
                "passed_first": round(first_pass / reviewed, 2) if reviewed else None,
                "rounds_avg": round(sum(rounds_all) / len(rounds_all), 1)
                if rounds_all
                else None,
                "cost_per_ticket": round(sum(costs) / len(costs), 2) if costs else None,
            }
        )
    return sorted(out, key=lambda m: -m["tickets"])


async def skip_step(ticket_id: str, *, by: str, step_id: str | None = None) -> None:
    """Skip the step the workflow is stuck on for this ticket only (no member for its role, a person's choice); the
    workflow goes on with the next one."""
    async with database.async_session() as session:
        wf = await session.get(AiTicketWorkflow, ticket_id)
        if wf is None:
            raise WorkflowError("This ticket follows no workflow.")
        row = (
            await session.get(AiTicketStep, step_id)
            if step_id
            else await current_step(session, ticket_id)
        )
        if (
            row is None
            or row.ticket_id != ticket_id
            or row.state in ("done", "skipped", "superseded")
        ):
            raise WorkflowError("There is no step to skip.")
        if row.key == "done":
            raise WorkflowError("The last step is yours: move the ticket to Done.")
        to_cancel = [row.run_id] if row.state == "active" and row.run_id else []
        waiting = [row.id] if row.state == "waiting" else []
        row.state = "skipped"
        row.note = f"Skipped by {by} for this ticket."
        row.ended_at = _now()
        session.add(row)
        was_stopped = wf.state == "stopped"
        if was_stopped:
            wf.state = "active"
            wf.stop_reason = None
            if wf.arbitration_run_id:
                to_cancel.append(
                    wf.arbitration_run_id
                )  # a person settled it by skipping
                wf.arbitration_run_id = None
            session.add(wf)
        await session.commit()
        # the skipped step's run is no longer wanted (its end finds the row skipped and moves nothing)
        await _cancel_runs(to_cancel, by=by, reason=f"The step was skipped by {by}.")
        how = f"{row.label} skipped"
        await flags.resolve(session, ticket_id, "no_member", by=by, how=how)
        if was_stopped:
            # the stop is over: what it waited for no longer waits
            for kind in ("arbitration", "board_fault", "no_progress", "quota_cap"):
                await flags.resolve(session, ticket_id, kind, by=by, how=how)
        if waiting:
            from services import notifications as centre

            await centre.resolve_target("step", waiting[0], how, by=by)
    await advance(ticket_id)


async def set_reviewer(
    session, ticket: Ticket, member_id: str | None, *, by: str
) -> AiTicketWorkflow:
    """An odd job (no workflow) gets an optional reviewer (D14): when its work run finishes, that AI reviews it."""
    wf = await session.get(AiTicketWorkflow, ticket.id)
    if wf is not None and wf.template_key:
        raise WorkflowError(
            "This ticket follows a workflow: its review is a step of it."
        )
    if wf is None:
        wf = AiTicketWorkflow(
            ticket_id=ticket.id,
            project_id=ticket.project_id,
            template_key="",
            template_name="Odd job",
            state="odd",
            attached_by=by,
        )
    wf.reviewer_id = member_id
    wf.updated_at = _now()
    session.add(wf)
    await session.commit()
    await session.refresh(wf)
    return wf


async def on_odd_job_finished(run_id: str) -> str | None:
    """An odd job's work run finished and it has a reviewer: start the review. Returns the review run's id."""
    from . import runs

    async with database.async_session() as session:
        run = await session.get(AiRun, run_id)
        if (
            run is None
            or run.state != "finished"
            or run.mode != "work"
            or run.trigger == "review"
        ):
            return None
        wf = await session.get(AiTicketWorkflow, run.ticket_id)
        if (
            wf is None
            or wf.template_key
            or not wf.reviewer_id
            or wf.reviewer_id == run.member_id
        ):
            return None
        review = await runs.create_run(
            session,
            ticket_id=run.ticket_id,
            member_id=wf.reviewer_id,
            mode="work",
            trigger="review",
            started_by=run.started_by,
            instruction=(
                "Review the change on this ticket. You get the diff and the criteria, not the other AI's transcript. "
                "End your final message with `VERDICT: PASS`, or `VERDICT: CHANGES` and what to change and why."
            ),
            wait_for_hold=True,
        )
        return review.id
