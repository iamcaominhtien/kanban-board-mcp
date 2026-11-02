"""The team runs itself (plan D8, D24): new tickets are taken, what goes wrong goes to the coordinator first, and a
person is asked only for what is theirs.

- **Intake** (D8, `ops.intake`): a ticket that lands in the intake column, assigned to nobody and on no workflow, is
  put on the project's default workflow, and its Triage takes it. A ticket given straight to one AI stays an odd job;
  one given to a person is theirs. Only tickets that arrive after intake was turned on: turning it on never starts
  the whole backlog at once.
- **The manager** (D24, `ops.manager`): the coordinator (the project's PM) runs the team.
  - A step that failed is tried again once by the board; a second failure goes to the PM, which tries it again with a
    note or passes it to a person.
  - A ticket Triage says is several pieces of work goes to the PM, which splits it into child tickets; the children
    are taken like new tickets and the parent waits until they are all Done.
  - The questions and permission requests AIs ask go to the PM before a person (it decides them as the project's
    Autopilot delegate, within its risk ceiling and hourly limit; what it leaves undecided stays for a person).
- **Blocked steps** start again by themselves once their cause goes (`workflow.retry_blocked`), on every tick and
  when a member is added or resumed.

Board faults never go to the PM: they go to a person straight away (plan, "Hàng chờ cần người").
"""

import asyncio
import logging
import re
from datetime import UTC, datetime

from sqlmodel import col, select

import database
from models import (
    AiProjectSettings,
    Member,
    AiRun,
    AiTicketStep,
    AiTicketWorkflow,
    Story,
    Ticket,
    TicketUpdate,
)
from services import stories

from . import decisions, ops, workflow
from .store import get_settings

logger = logging.getLogger(__name__)

TRIGGER = "manager"
TICK_S = 60
INTAKE_PER_TICK = 10
BY = "the board (intake)"

FAILED_TASK = (
    "You are the coordinator of this project. The step “{step}” of {ticket} failed twice.\n\n"
    "What its AI was asked and what came back, newest last:\n{attempts}\n\n"
    "Read the ticket and its last runs. If another attempt can work, say what the AI must do differently. If it needs "
    "something only a person can give (a decision, an account, access, a product answer), say what. End your final "
    "message with exactly one line: `DECISION: RETRY` followed by the note for the next attempt, or `DECISION: PERSON` "
    "followed by what the person must do."
)

SPLIT_TASK = (
    "You are the coordinator of this project. Triage says {ticket} holds several pieces of work: {why}\n\n"
    "Split it by feature, not by stage: each piece is one thing a person can do or see, taken end to end on its own "
    "workflow (its design, build, tests and review happen inside that piece). Only what belongs to no one feature is "
    "a piece of its own: defining the product first, the release last. "
    "Create one ticket per piece with the board's tools, each with parent {ticket}, status todo and no "
    "assignee, a clear title, a description and acceptance criteria a tester can check. Keep what depends on what in "
    "the descriptions. Create them in the order they must be done: the board runs them one after another in that "
    "order, each on a workflow. Do not start them and do not change {ticket} itself. "
    "End your final message with exactly one line: `SPLIT:` followed by the keys you created, comma separated, or "
    "`SPLIT: none` and why when it is one piece of work after all."
)

APPROVE_TASK = (
    "You are the coordinator of this project, and you decide “{step}” on {ticket} as the person would. What the step "
    "before it handed in:\n{hand_in}\n\n"
    "Read the ticket and its acceptance criteria, then open everything the hand-in links: the Docs pages, the canvas "
    "and its frames (docs_read canvas), the diagrams. For a design, judge it as a design lead would, on how it looks "
    "and not only on what it covers: look at the screenshots on the ticket, or open the frames yourself in the "
    "browser (Playwright) at phone and desktop width, and ask: is there one clear visual hierarchy, a consistent type "
    "scale and spacing, colour used with intent, real copy, aligned edges, states that look like the same product, and "
    "would a person be glad to use it? A plain, unstyled or generic-looking design is not approved, however complete. "
    "Where it falls short, comment on the thing itself, one point each: on the canvas frame (docs_write "
    "canvas_comment), on the Docs page at its section, otherwise on the ticket. "
    "Approve when every criterion is met, nothing a builder needs is missing and it looks finished; otherwise ask for "
    "the changes, the most important first. End "
    "your final message with exactly one line: `DECISION: APPROVE` and one sentence why, or `DECISION: CHANGES` "
    "followed by what to change."
)

_TASKS: set[asyncio.Task] = set()
_LOOP: dict = {"task": None}
_INTAKE_LOCK = asyncio.Lock()
# one decision at a time: a run's end and the tick's repair never apply the same PM job twice
_JOB_LOCK = asyncio.Lock()


def later(coro) -> None:
    """Run `coro` in the background; its failure is logged, never raised into the caller."""

    async def go() -> None:
        try:
            await coro
        except Exception:  # noqa: BLE001 - the team's bookkeeping never breaks the action that caused it
            logger.exception("The manager failed")

    try:
        task = asyncio.get_running_loop().create_task(go())
    except RuntimeError:  # no loop (a sync caller in a test): nothing to schedule
        coro.close()
        return
    _TASKS.add(task)
    task.add_done_callback(_TASKS.discard)


def _now() -> str:
    return datetime.now(UTC).isoformat()


async def _cfg(session, project_id: str) -> dict:
    return ops.get(await get_settings(session, project_id))


# ---------------------------------------------------------------------------
# Intake (D8)
# ---------------------------------------------------------------------------


def _arrived_since(ticket: Ticket, since: str | None, *, moved: bool = False) -> bool:
    """Created after intake was turned on, or moved into its column just now (`moved`). An old ticket that was only
    edited (a comment, a field) does not count: turning intake on never starts the backlog."""
    if not since:
        return False
    return (ticket.created_at or "") >= since or (
        moved and (ticket.updated_at or "") >= since
    )


async def take(ticket_id: str, *, force: bool = False, moved: bool = False) -> bool:
    """Put a new ticket on the default workflow and start it. `force`: a piece the coordinator split off, taken
    whatever the intake setting. Returns whether it was taken."""
    async with (
        _INTAKE_LOCK
    ):  # one at a time: two events about the same ticket never attach it twice
        async with database.async_session() as session:
            ticket = await session.get(Ticket, ticket_id)
            if ticket is None or ticket.assignee or ticket.type == "story":
                return False  # a Story is not built: its plan drives its children (services/stories.py)
            if await session.get(AiTicketWorkflow, ticket_id) is not None:
                return False
            if not force and await _piece_of_split(session, ticket):
                return False  # the pieces of a split run one after another: the manager takes them (_next_piece)
            cfg = await _cfg(session, ticket.project_id)
            intake = cfg.get("intake") or {}
            key = cfg.get("workflow_default") or ""
            if not key:
                return False
            if not force and not (
                intake.get("on")
                and ticket.status == (intake.get("status") or "todo")
                and _arrived_since(ticket, intake.get("since"), moved=moved)
            ):
                return False
            try:
                await workflow.attach(session, ticket, key, by=BY, start=False)
            except workflow.WorkflowError as exc:
                logger.info("Intake could not take %s: %s", ticket_id, exc)
                return False
            await _skip_triage_if_none(session, ticket)
    await workflow.advance(ticket_id)
    return True


async def _piece_of_split(session, ticket: Ticket) -> bool:
    if not ticket.parent_id:
        return False
    if await session.get(Story, ticket.parent_id) is not None:
        return True  # a ticket of a Story starts when its plan says so (services/stories.py)
    parent = await session.get(AiTicketWorkflow, ticket.parent_id)
    return parent is not None and parent.stop_reason == "split"


async def _skip_triage_if_none(session, ticket: Ticket) -> None:
    """With no Triage on the project the default workflow stays as it is: its Triage step is skipped, not blocked."""
    from models import AiMember

    from . import plugins as ai_plugins

    rows = await workflow.steps_of(session, ticket.id)
    first = rows[0] if rows else None
    if first is None or first.role != "triage":
        return
    members = (
        await session.exec(
            select(AiMember).where(AiMember.project_id == ticket.project_id)
        )
    ).all()
    if any(ai_plugins.role_of(m) == "triage" for m in members):
        return
    first.state = "skipped"
    first.note = "No Triage on this project: the default workflow is kept."
    first.ended_at = _now()
    session.add(first)
    await session.commit()


def on_ticket(ticket_id: str, *, moved: bool = False) -> None:
    """A ticket was created, or `moved` into another column: take it if it is new work for the team (in the
    background)."""
    later(take(ticket_id, moved=moved))


async def sweep_intake(project_id: str, cfg: dict) -> int:
    """Tickets an event missed (the server was down, a bulk import): take them on the tick."""
    intake = cfg.get("intake") or {}
    if not intake.get("on") or not intake.get("since"):
        return 0
    async with database.async_session() as session:
        rows = (
            await session.exec(
                select(Ticket).where(
                    Ticket.project_id == project_id,
                    Ticket.status == (intake.get("status") or "todo"),
                    col(Ticket.assignee).is_(None),
                )
            )
        ).all()
        ids = [
            t.id
            for t in rows
            if _arrived_since(t, intake["since"])
            and await session.get(AiTicketWorkflow, t.id) is None
        ]
    taken = 0
    for ticket_id in ids[:INTAKE_PER_TICK]:
        taken += await take(ticket_id)
    return taken


def stamp(patch: dict, before: dict) -> dict:
    """A settings change that turns intake on dates it: only tickets that arrive from now on are taken."""
    want = (patch.get("intake") or {}).get("on")
    if want and not (before.get("intake") or {}).get("on"):
        patch = {**patch, "intake": {**patch["intake"], "since": _now()}}
    return patch


async def sync_autopilot(session, settings: AiProjectSettings, cfg: dict) -> None:
    """The manager on: the PM is the project's Autopilot delegate, so the questions and permission requests nobody
    picked up go to it first. Off again: the Autopilot it turned on goes off (one a person set up stays)."""
    from . import autopilot

    current = autopilot.config(settings)
    manager = cfg.get("manager") or {}
    if manager.get("on"):
        pm = await workflow.coordinator(session, settings.project_id)
        if pm is None:
            return
        if current["enabled"] and current["enabled_by"] != TRIGGER:
            return  # a person's own Autopilot: theirs to change
        settings.autopilot = autopilot.dumps(
            {
                **current,
                "enabled": True,
                "delegate_id": pm.id,
                "approvals": True,
                "questions": True,
                "max_risk": manager.get("max_risk") or "medium",
                "grace_min": int(manager.get("grace_min") or 0),
                "per_hour_limit": int(manager.get("per_hour_limit") or 20),
                "enabled_by": TRIGGER,
                "enabled_at": current["enabled_at"] or _now(),
            }
        )
    elif current["enabled"] and current["enabled_by"] == TRIGGER:
        settings.autopilot = autopilot.dumps({**current, "enabled": False})
    session.add(settings)


# ---------------------------------------------------------------------------
# A failed step (D24: the coordinator before a person)
# ---------------------------------------------------------------------------


PM_RETRIES = 2  # after the board's own retry, the coordinator may send a step round this many times


async def _failures(session, ticket_id: str, idx: int) -> list[AiTicketStep]:
    """The earlier failed attempts of a step, each marked with who tried it again."""
    return [
        r
        for r in await workflow.steps_of(session, ticket_id)
        if r.idx == idx and r.outcome in ("retried", "retried_by_pm")
    ]


async def _again(session, row: AiTicketStep, note: str, member_id: str | None) -> None:
    """A new attempt of the failed step, and fresh rows for the steps after it, after every row there is (the old
    rows stay as history, as a send-back keeps them)."""
    rows = await workflow.steps_of(session, row.ticket_id)
    base = max(r.seq for r in rows) + 1
    latest: dict[int, AiTicketStep] = {}
    for r in rows:
        if r.idx >= row.idx and r.state != "superseded":
            latest[r.idx] = r
    latest[row.idx] = row
    for i, idx in enumerate(sorted(latest)):
        old = latest[idx]
        if old.state in ("pending", "blocked", "failed"):
            old.state = "superseded"
            session.add(old)
        first = idx == row.idx
        session.add(
            AiTicketStep(
                ticket_id=row.ticket_id,
                seq=base + i,
                idx=old.idx,
                key=old.key,
                label=old.label,
                kind=old.kind,
                role=old.role,
                attempt=old.attempt + 1 if first else old.attempt,
                note_in=note[:2000] if first else None,
                member_id=member_id if first else None,
            )
        )
    await session.commit()


async def on_step_failed(ticket_id: str, step_id: str) -> None:
    """A step's run failed: what the board or the PM does about it (one decision at a time)."""
    async with _JOB_LOCK:
        await _on_step_failed(ticket_id, step_id)


async def _on_step_failed(ticket_id: str, step_id: str) -> None:
    """A step's run failed (not a board fault): the board tries it once more; a second failure goes to the PM."""
    async with database.async_session() as session:
        wf = await session.get(AiTicketWorkflow, ticket_id)
        row = await session.get(AiTicketStep, step_id)
        if wf is None or row is None or wf.state != "active" or row.state != "failed":
            return
        cfg = await _cfg(session, wf.project_id)
        if not (cfg.get("manager") or {}).get("on"):
            return  # without the manager a failed step waits for a person, as it always did
        earlier = await _failures(session, ticket_id, row.idx)
        by_pm = sum(1 for r in earlier if r.outcome == "retried_by_pm")
        if not earlier:
            row.outcome = "retried"
            await _again(
                session,
                row,
                f"The last attempt failed: {row.note or 'no reason given'}. Try again; if the same thing gets in the "
                "way, say exactly what.",
                row.member_id,
            )
            go_on = True
        else:
            go_on = False
            if by_pm >= PM_RETRIES:
                await _to_person(
                    session,
                    wf,
                    row,
                    f"It failed {len(earlier) + 1} times, the coordinator's tries included.",
                )
                return
            pm = await workflow.coordinator(
                session, wf.project_id, {row.member_id or ""}
            )
            attempts = "\n".join(
                f"- attempt {r.attempt}: {(r.note or '')[:500]}"
                for r in [*earlier, row][-3:]
            )
            if pm is None:
                await _to_person(
                    session, wf, row, "There is no coordinator (PM) free to look at it."
                )
                return
            from . import runs

            try:
                run = await runs.create_run(
                    session,
                    ticket_id=ticket_id,
                    member_id=pm.id,
                    mode="work",
                    trigger=TRIGGER,
                    started_by="the board (manager)",
                    instruction=FAILED_TASK.format(
                        step=row.label, ticket=ticket_id, attempts=attempts
                    ),
                    wait_for_hold=True,
                )
            except runs.RunError as exc:
                await _to_person(
                    session, wf, row, f"The coordinator could not start: {exc}"
                )
                return
            workflow.set_meta(
                wf, manager_run={"run_id": run.id, "job": "failed", "step_id": row.id}
            )
            session.add(wf)
            await session.commit()
    if go_on:
        await workflow.advance(ticket_id)


async def _to_person(
    session, wf: AiTicketWorkflow, row: AiTicketStep, why: str
) -> None:
    ticket = await session.get(Ticket, wf.ticket_id)
    await workflow._raise(
        session,
        ticket,
        "step_blocked",
        f"{row.label} failed and waits for you",
        why,
        {"step": row.label, "why": "failed"},
    )


# ---------------------------------------------------------------------------
# Splitting a ticket (D24: the coordinator splits work)
# ---------------------------------------------------------------------------


async def approve(ticket_id: str, step_id: str) -> None:
    """A step that waits for a person, decided by the coordinator (`autonomy.approve = pm`; one decision at a time)."""
    async with _JOB_LOCK:
        await _approve(ticket_id, step_id)


async def _approve(ticket_id: str, step_id: str) -> None:
    from . import runs

    async with database.async_session() as session:
        wf = await session.get(AiTicketWorkflow, ticket_id)
        row = await session.get(AiTicketStep, step_id)
        if (
            wf is None
            or row is None
            or row.state != "waiting"
            or workflow.meta_of(wf).get("manager_run")
        ):
            return
        pm = await workflow.coordinator(session, wf.project_id)
        before = [
            r
            for r in await workflow.steps_of(session, ticket_id)
            if r.state == "done" and r.seq < row.seq and r.note
        ]
        ticket = await session.get(Ticket, ticket_id)
        try:
            if pm is None:
                raise runs.RunError(
                    "The project has no coordinator (a member made from the PM pack)."
                )
            run = await runs.create_run(
                session,
                ticket_id=ticket_id,
                member_id=pm.id,
                mode="work",
                trigger=TRIGGER,
                started_by="the board (manager)",
                instruction=APPROVE_TASK.format(
                    step=row.label,
                    ticket=ticket_id,
                    hand_in=(before[-1].note if before else "(nothing)")[:4000],
                ),
                wait_for_hold=True,
            )
        except runs.RunError as exc:
            row.note = (
                f"The coordinator could not look at it ({exc}): it waits for a person."
            )
            session.add(row)
            await session.commit()
            await workflow._tell_person(session, ticket, row)
            return
        workflow.set_meta(
            wf, manager_run={"run_id": run.id, "job": "approve", "step_id": row.id}
        )
        row.note = "The coordinator looks at it."
        session.add(wf)
        session.add(row)
        await session.commit()


async def split(ticket_id: str, why: str) -> None:
    """The PM splits the ticket (one decision at a time)."""
    async with _JOB_LOCK:
        await _split(ticket_id, why)


async def _split(ticket_id: str, why: str) -> None:
    """Triage says the ticket is several pieces of work: the PM splits it into child tickets."""
    from . import runs

    async with database.async_session() as session:
        wf = await session.get(AiTicketWorkflow, ticket_id)
        if (
            wf is None
            or wf.stop_reason != "split"
            or workflow.meta_of(wf).get("manager_run")
        ):
            return  # not split, or the PM already works on it
        pm = await workflow.coordinator(session, wf.project_id)
        if pm is None:
            await _resume(
                session,
                wf,
                "No coordinator (PM) to split it: it goes on as one ticket.",
            )
            go_on = True
        else:
            go_on = False
            try:
                run = await runs.create_run(
                    session,
                    ticket_id=ticket_id,
                    member_id=pm.id,
                    mode="work",
                    trigger=TRIGGER,
                    started_by="the board (manager)",
                    instruction=SPLIT_TASK.format(ticket=ticket_id, why=why),
                    wait_for_hold=True,
                )
            except runs.RunError as exc:
                await _resume(
                    session,
                    wf,
                    f"The coordinator could not start ({exc}): it goes on as one ticket.",
                )
                go_on = True
            else:
                workflow.set_meta(
                    wf,
                    manager_run={
                        "run_id": run.id,
                        "job": "split",
                        "since": run.queued_at,
                    },
                )
                session.add(wf)
                await session.commit()
    if go_on:
        await workflow.advance(ticket_id)


async def _resume(session, wf: AiTicketWorkflow, note: str) -> None:
    wf.state, wf.stop_reason, wf.stop_detail = "active", None, None
    wf.depth_note = note
    wf.updated_at = _now()
    session.add(wf)
    await session.commit()


async def _children(session, ticket_id: str, since: str | None) -> list[Ticket]:
    rows = (
        await session.exec(select(Ticket).where(Ticket.parent_id == ticket_id))
    ).all()
    return [t for t in rows if not since or (t.created_at or "") >= since]


async def on_run_ended(run_id: str) -> None:
    """A PM run ended: apply its decision (one decision at a time)."""
    async with _JOB_LOCK:
        await _on_run_ended(run_id)


async def _on_run_ended(run_id: str) -> None:
    """A run the manager started ended: apply what the PM decided."""
    async with database.async_session() as session:
        run = await session.get(AiRun, run_id)
        if run is None:
            return
        story = await session.get(Story, run.ticket_id)
        if (
            story is not None
            and (stories.meta_of(story).get("job") or {}).get("run_id") == run_id
        ):
            await stories.after_run(session, story, run)
            return
        wf = await session.get(AiTicketWorkflow, run.ticket_id)
        job = workflow.meta_of(wf).get("manager_run") if wf else None
        if not job or job.get("run_id") != run_id:
            return
        workflow.set_meta(wf, manager_run=None)
        session.add(wf)
        text = workflow.run_text(run)
        if job["job"] == "approve":
            await session.commit()
            await _after_approve(session, wf, run, text, job)
            return
        if job["job"] == "split":
            await _after_split(session, wf, run, text, job)
            return
        row = await session.get(AiTicketStep, job.get("step_id") or "")
        current = await workflow.current_step(session, run.ticket_id)
        if (
            row is None
            or wf.state != "active"
            or row.state != "failed"
            or current is None
            or current.id != row.id
        ):
            await (
                session.commit()
            )  # the step moved on while the PM looked (a person retried or skipped it)
            return
        m = re.search(
            r"DECISION:\s*(RETRY|PERSON)\b(.*)", text, re.IGNORECASE | re.DOTALL
        )
        if run.state != "finished" or m is None or m.group(1).upper() == "PERSON":
            await session.commit()
            await _to_person(
                session,
                wf,
                row,
                (m.group(2).strip()[:600] if m else "")
                or f"The coordinator could not settle it (its run {run.state.replace('_', ' ')}).",
            )
            return
        row.outcome = "retried_by_pm"
        why = m.group(2).strip()[:1500]
        await _again(session, row, f"The coordinator says: {why}", None)
        await decisions.record(
            session,
            wf.project_id,
            kind="retry",
            title=f"Tried “{row.label}” of {run.ticket_id} again",
            ticket_id=run.ticket_id,
            why=why,
            member_id=run.member_id,
            ref={"step_id": row.id, "run_id": run.id},
        )
    await workflow.advance(run.ticket_id)


async def _after_approve(
    session, wf: AiTicketWorkflow, run: AiRun, text: str, job: dict
) -> None:
    row = await session.get(AiTicketStep, job.get("step_id") or "")
    if row is None or row.state != "waiting":
        return  # decided meanwhile (a person did)
    m = re.search(
        r"DECISION:\s*(APPROVE|CHANGES)\b(.*)", text, re.IGNORECASE | re.DOTALL
    )
    member = await session.get(Member, run.member_id)
    by = member.name if member else "the coordinator"
    if run.state != "finished" or m is None:
        row.note = "The coordinator could not decide it: it waits for a person."
        session.add(row)
        await session.commit()
        ticket = await session.get(Ticket, wf.ticket_id)
        await workflow._tell_person(session, ticket, row)
        return
    note = m.group(2).strip()[:1500] or None
    approve = m.group(1).upper() == "APPROVE"
    await workflow.decide_person_step(wf.ticket_id, approve=approve, note=note, by=by)
    await decisions.record(
        session,
        wf.project_id,
        kind="approve_design" if approve else "send_back",
        title=(
            f"Approved “{row.label}” of {wf.ticket_id}"
            if approve
            else f"Sent {wf.ticket_id} back from “{row.label}”"
        ),
        ticket_id=wf.ticket_id,
        why=note or "",
        member_id=run.member_id,
        ref={"step_id": row.id, "run_id": run.id},
    )


async def _after_split(
    session, wf: AiTicketWorkflow, run: AiRun, text: str, job: dict
) -> None:
    children = await _children(session, wf.ticket_id, job.get("since"))
    # pieces the PM made are the split even when its run did not finish: never run them and the whole ticket too
    if not children:
        await _resume(
            session,
            wf,
            "Not split"
            + (
                f": {text.split('SPLIT:')[-1].strip()[:300]}"
                if "SPLIT:" in text
                else ""
            )
            + ". It goes on as one ticket.",
        )
        await workflow.advance(wf.ticket_id)
        return
    # the split ticket becomes a Story: its plan is the pieces in the order the PM made them (A, "a ticket the PM
    # finds too big is promoted to a Story")
    workflow.set_meta(wf, split=[t.id for t in children])
    session.add(wf)
    await session.commit()
    await stories.promote_split(session, wf, children, run)


async def _next_piece(session, pieces: list[str]) -> None:
    """Start the first piece that is not Done, in the order the coordinator created them, unless it is under way."""
    rows = {
        t.id: t
        for t in (
            await session.exec(select(Ticket).where(col(Ticket.id).in_(pieces)))
        ).all()
    }
    for piece in pieces:
        t = rows.get(piece)
        if t is None or t.status == "done":
            continue
        if await session.get(AiTicketWorkflow, piece) is None and not t.assignee:
            await take(piece, force=True)
        return


async def on_ticket_done(ticket_id: str) -> None:
    """A ticket reached Done: its Story starts what waited for it; the last piece of a split ticket finishes it."""
    async with database.async_session() as session:
        ticket = await session.get(Ticket, ticket_id)
        if ticket is None or not ticket.parent_id:
            return
        if await session.get(Story, ticket.parent_id) is not None:
            await stories.on_child_done(session, ticket.parent_id)
            return
        await _parent_check(session, ticket.parent_id)


async def _parent_check(session, parent_id: str) -> None:
    wf = await session.get(AiTicketWorkflow, parent_id)
    pieces = workflow.meta_of(wf).get("split") if wf else None
    if not pieces or wf.state != "stopped" or wf.stop_reason != "split":
        return
    open_ = [
        t.id
        for t in (
            await session.exec(select(Ticket).where(col(Ticket.id).in_(pieces)))
        ).all()
        if t.status != "done"
    ]
    if open_:
        await _next_piece(session, pieces)
        return
    # every piece is Done: the parent's own steps up to the last one are done by its pieces
    for row in await workflow.steps_of(session, parent_id):
        if row.state in ("pending", "blocked") and row.key != "done":
            row.state = "skipped"
            row.note = "Done in its pieces: " + ", ".join(pieces)
            row.ended_at = _now()
            session.add(row)
    wf.state, wf.stop_reason = "active", None
    wf.stop_detail = None
    session.add(wf)
    await session.commit()
    cfg = await _cfg(session, wf.project_id)
    ticket = await session.get(Ticket, parent_id)
    if (cfg.get("autonomy") or {}).get("done") == "after_review" and ticket is not None:
        from services import tickets as svc_tickets

        from . import guard

        tokens = guard.suspend()
        try:
            await svc_tickets.update_ticket(
                session, parent_id, TicketUpdate(status="done")
            )
        finally:
            guard.leave(tokens)
        return
    await workflow.advance(parent_id)


# ---------------------------------------------------------------------------
# The tick
# ---------------------------------------------------------------------------


async def tick() -> None:
    """Every minute: blocked steps try again, missed tickets are taken, split parents whose pieces are done finish."""
    await workflow.retry_blocked()
    async with database.async_session() as session:
        rows = (await session.exec(select(AiProjectSettings))).all()
        projects = [(s.project_id, ops.get(s), s.paused_all) for s in rows]
    for project_id, cfg, paused in projects:
        if paused:
            continue
        try:
            await sweep_intake(project_id, cfg)
            await stories.tick(project_id)
            if (cfg.get("manager") or {}).get("on"):
                await _repair(project_id)
                async with database.async_session() as session:
                    parents = (
                        await session.exec(
                            select(AiTicketWorkflow).where(
                                AiTicketWorkflow.project_id == project_id,
                                AiTicketWorkflow.stop_reason == "split",
                            )
                        )
                    ).all()
                    for wf in parents:
                        await _parent_check(session, wf.ticket_id)
        except Exception:  # noqa: BLE001 - one project's trouble never stops the others
            logger.exception("The manager's tick failed on %s", project_id)


async def _repair(project_id: str) -> None:
    """What a restart cut off: a PM run that ended without its decision applied (it was cut and resumed as a retry,
    or its end was lost), a split with no PM run, a failed step nobody is looking at. Each is picked up again."""
    from . import runs

    async with database.async_session() as session:
        wfs = (
            await session.exec(
                select(AiTicketWorkflow).where(
                    AiTicketWorkflow.project_id == project_id,
                    col(AiTicketWorkflow.state).in_(["active", "stopped"]),
                )
            )
        ).all()
        todo: list = []
        for wf in wfs:
            job = workflow.meta_of(wf).get("manager_run")
            if job:
                run = await session.get(AiRun, job.get("run_id") or "")
                if run is None or run.state in runs.ENDED:
                    todo.append(on_run_ended(job["run_id"]) if run else None)
                continue
            if (
                wf.state == "stopped"
                and wf.stop_reason == "split"
                and not workflow.meta_of(wf).get("split")
            ):
                todo.append(split(wf.ticket_id, wf.stop_detail or ""))
            elif wf.state == "active":
                row = await workflow.current_step(session, wf.ticket_id)
                cfg = await _cfg(session, project_id)
                if (
                    row is not None
                    and row.kind == "person"
                    and row.state == "waiting"
                    and row.key != "done"
                    and (cfg.get("autonomy") or {}).get("approve") == "pm"
                    and row.note
                    != "The coordinator could not decide it: it waits for a person."
                    and not (row.note or "").startswith(
                        "The coordinator could not look at it"
                    )
                ):
                    todo.append(approve(wf.ticket_id, row.id))
                    continue
                if (
                    row is not None
                    and row.state == "failed"
                    and row.outcome is None
                    and row.kind == "ai"
                ):
                    run = await session.get(AiRun, row.run_id or "")
                    if run is not None and run.state in ("failed", "timed_out"):
                        todo.append(on_step_failed(wf.ticket_id, row.id))
    for coro in todo:
        if coro is not None:
            await coro


def kick(project_id: str | None = None) -> None:
    """Something that may unblock a step changed (a member added or resumed): try now, not at the next tick."""
    later(workflow.retry_blocked(project_id))


async def _loop() -> None:
    while True:
        try:
            await tick()
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            logger.exception("The manager's tick failed")
        await asyncio.sleep(TICK_S)


def start() -> None:
    """Start the manager's loop (once)."""
    if _LOOP["task"] is None or _LOOP["task"].done():
        _LOOP["task"] = asyncio.get_running_loop().create_task(_loop())


async def stop() -> None:
    """Stop the manager's loop."""
    task = _LOOP["task"]
    _LOOP["task"] = None
    if task is not None:
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            pass
