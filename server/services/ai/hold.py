"""Who holds a ticket, and handing it between people, outside agents and the AI team with nothing lost (issue #272).

- **holder**: who has the ticket now: an AI (which, doing what), a person, or someone it waits on (a person's
  answer, a person's step, a stopped workflow), in one sentence the ticket shows.
- **take_back**: a person takes the ticket from the AI team mid-run: the run stops, its workflow pauses at the step it
  was on, the ticket is the person's, and a handoff note of what the AI did so far goes on the ticket.
- **hand_over**: a person or an outside agent gives the ticket to the team with a handoff note (and its branch and
  pages): a paused workflow resumes at its step, a workflow starts, an AI member takes it, or the running AI is told.
  Whoever takes it reads the note first.
"""

from datetime import UTC, datetime

from sqlmodel import col, select

import database
import events as board_events
from models import AiRun, AiTicketStep, AiTicketWorkflow, Member, Ticket, TicketUpdate

from . import handoff
from .store import loads

TAKEN_BACK = "taken_back"


class HoldError(Exception):
    """The ticket cannot be taken back or handed over as asked (the message says why)."""


def _now() -> str:
    return datetime.now(UTC).isoformat()


async def _member(session, member_id: str | None) -> Member | None:
    return await session.get(Member, member_id) if member_id else None


async def _person(session, project_id: str, ref: str | None) -> Member | None:
    """A person of the project by id or name."""
    if not ref:
        return None
    rows = (
        await session.exec(
            select(Member).where(Member.project_id == project_id, Member.kind != "ai")
        )
    ).all()
    return next(
        (m for m in rows if m.id == ref or m.name.casefold() == ref.casefold()), None
    )


async def _ai(session, project_id: str, ref: str | None) -> Member | None:
    if not ref:
        return None
    rows = (
        await session.exec(
            select(Member).where(Member.project_id == project_id, Member.kind == "ai")
        )
    ).all()
    return next(
        (m for m in rows if m.id == ref or m.name.casefold() == ref.casefold()), None
    )


async def _person_name(
    session, ticket: Ticket, by: str, person: Member | None = None
) -> str:
    """The person's name for a sentence: `by`, unless it is the board's own user (no X-Actor), then the person the
    ticket goes to or holds it, else "a person"."""
    from services.activity import HUMAN_ACTOR

    if by and by != HUMAN_ACTOR:
        return by
    if person is not None:
        return person.name
    who = await _member(session, ticket.assignee)
    return who.name if who is not None and who.kind != "ai" else "a person"


async def _work_runs(session, ticket_id: str) -> list[AiRun]:
    from .runs import ACTIVE

    return list(
        (
            await session.exec(
                select(AiRun)
                .where(
                    AiRun.ticket_id == ticket_id,
                    AiRun.mode == "work",
                    col(AiRun.state).in_(list(ACTIVE)),
                )
                .order_by(col(AiRun.queued_at))
            )
        ).all()
    )


async def _last_work_run(session, ticket_id: str) -> AiRun | None:
    return (
        await session.exec(
            select(AiRun)
            .where(AiRun.ticket_id == ticket_id, AiRun.mode == "work")
            .order_by(col(AiRun.queued_at).desc())
        )
    ).first()


# ---------------------------------------------------------------------------
# Who has it
# ---------------------------------------------------------------------------


async def holder(session, ticket: Ticket) -> dict:
    """Who has the ticket now: {kind: ai|person|waiting|nobody, name, member_id, state, waiting_on, step, since,
    text}. `text` is the sentence the ticket shows ("Dev AI is working on it · Build")."""
    from . import workflow as wf_svc

    wf = await session.get(AiTicketWorkflow, ticket.id)
    row = await wf_svc.current_step(session, ticket.id) if wf else None
    step = (
        row.label
        if row is not None and wf and wf.state in ("active", "stopped")
        else None
    )
    runs = await _work_runs(session, ticket.id)
    run = next((r for r in runs if not r.behind_run_id), runs[0] if runs else None)
    out = {
        "kind": "nobody",
        "name": None,
        "member_id": None,
        "state": None,
        "waiting_on": None,
        "step": step,
        "since": None,
        "text": "Nobody has it.",
    }
    on_step = f" · {step}" if step else ""
    if run is not None:
        ai = await _member(session, run.member_id)
        name = ai.name if ai else "An AI"
        out.update(kind="ai", name=name, member_id=run.member_id, state=run.state)
        out["since"] = run.started_at or run.queued_at
        if run.state == "needs_input":
            who = (
                run.started_by
                if run.started_by and run.started_by != "user"
                else "a person"
            )
            out.update(kind="waiting", waiting_on=who)
            out["text"] = f"{name} waits for {who}'s answer{on_step}"
        elif run.state == "queued":
            out["text"] = f"{name} has it, queued to start{on_step}"
        elif run.paused:
            out["text"] = f"{name} has it, paused{on_step}"
        else:
            out["text"] = f"{name} is working on it{on_step}"
        return out
    if wf is not None and wf.state == "stopped" and wf.stop_reason != TAKEN_BACK:
        out.update(kind="waiting", waiting_on="a person", state="stopped")
        out["since"] = wf.updated_at
        out["text"] = "The workflow stopped and waits for a person" + (
            f": {wf.stop_detail}" if wf.stop_detail else ""
        )
        return out
    if (
        wf is not None
        and wf.state == "active"
        and row is not None
        and row.state in ("waiting", "blocked")
    ):
        out.update(kind="waiting", state=row.state, since=row.started_at)
        if row.state == "waiting":
            out["waiting_on"] = "a person"
            out["text"] = f"Waits for a person: {row.label}"
        else:
            out["waiting_on"] = "a person"
            out["text"] = (
                f"Blocked at {row.label}: {row.note or 'it waits for a person'}"
            )
        return out
    who = await _member(session, ticket.assignee)
    if who is not None:
        is_ai = who.kind == "ai"
        out.update(kind="ai" if is_ai else "person", name=who.name, member_id=who.id)
        out["state"] = "idle" if is_ai else None
        if wf is not None and wf.state == "stopped" and wf.stop_reason == TAKEN_BACK:
            out["state"] = TAKEN_BACK
            out["since"] = wf.updated_at
            out["text"] = f"{who.name} took it back from the AI team{on_step}"
        elif is_ai:
            out["text"] = f"{who.name} has it, not running now"
        else:
            out["text"] = f"{who.name} has it"
    return out


# ---------------------------------------------------------------------------
# Take back
# ---------------------------------------------------------------------------


async def take_back(
    ticket_id: str, *, by: str, member_id: str | None = None, text: str | None = None
) -> dict:
    """A person takes the ticket from the AI team: its work runs stop, a workflow pauses at its step, the ticket is
    assigned to `member_id` (or the person named `by`), and a handoff note of what the AI did goes on the ticket.

    Raises:
        HoldError: The ticket does not exist.
    """
    from services import tickets as svc_tickets

    from . import runs as svc_runs

    async with database.async_session() as session:
        ticket = await session.get(Ticket, ticket_id)
        if ticket is None:
            raise HoldError(f"Ticket {ticket_id} not found.")
        person = await _member(session, member_id) or await _person(
            session, ticket.project_id, by
        )
        who = await _person_name(session, ticket, by, person)
        wf = await session.get(AiTicketWorkflow, ticket_id)
        paused = False
        if wf is not None and wf.state == "active":
            # first, so the runs' ends move nothing (on_run_ended sees a stopped workflow)
            wf.state, wf.stop_reason = "stopped", TAKEN_BACK
            wf.stop_detail = f"{who} took it back."
            wf.updated_at = _now()
            session.add(wf)
            await session.commit()
            paused = True
        active = await _work_runs(session, ticket_id)
        holder_run = next((r for r in active if not r.behind_run_id), None)
    cancelled = 0
    for r in active:
        try:
            await svc_runs.cancel(
                r.id,
                by=by,
                reason=f"{who} took the ticket back",
                revert_status=False,
                stop_code="takeover",
            )
            cancelled += 1
        except svc_runs.RunError:
            pass
    note_id = None
    async with database.async_session() as session:
        ticket = await session.get(Ticket, ticket_id)
        if paused:
            for row in await _open_rows(session, ticket_id):
                if row.state in ("active", "blocked", "failed", "pending"):
                    row.state, row.outcome = "failed", TAKEN_BACK
                    row.note = f"Taken back by {who}."
                    row.ended_at = _now()
                    session.add(row)
                    break
            await session.commit()
        source = holder_run
        if source is not None:
            source = await session.get(AiRun, source.id)
        if source is None:
            last = await _last_work_run(session, ticket_id)
            # the AI's own note already says it, when its run ended with one
            if last is not None and not (loads(last.report, {}) or {}).get("handoff"):
                source = last
        if source is not None:
            note = handoff.from_progress(source, ticket, by=who)
            if text:
                note["left"] = f"{note['left']} {who}: {text.strip()}"[
                    : handoff.MAX_FIELD
                ]
            ai = await _member(session, source.member_id)
            note_id = await handoff.post(
                session,
                ticket_id,
                note,
                author=ai.name if ai else "AI",
                to=person.name if person else who,
                run=source,
                complete=False,
            )
            ticket = await session.get(Ticket, ticket_id)
        if person is not None and ticket.assignee != person.id:
            await svc_tickets.update_ticket(
                session, ticket_id, TicketUpdate(assignee=person.id)
            )
            ticket = await session.get(Ticket, ticket_id)
        await session.refresh(ticket)
        held = await holder(session, ticket)
    await board_events.publish("invalidate")
    return {
        "ticket_id": ticket_id,
        "cancelled_runs": cancelled,
        "workflow_paused": paused,
        "note_comment_id": note_id,
        "holder": held,
    }


async def _open_rows(session, ticket_id: str) -> list[AiTicketStep]:
    from . import workflow as wf_svc

    return [
        r
        for r in await wf_svc.steps_of(session, ticket_id)
        if r.state in ("pending", "active", "waiting", "blocked", "failed")
    ]


# ---------------------------------------------------------------------------
# Hand over
# ---------------------------------------------------------------------------


async def _link_work(
    session, ticket: Ticket, branch: str | None, pages: list[str]
) -> list[str]:
    """Put the outside work on the ticket: the branch (recorded as it is when it exists already) and the Docs pages.
    Returns what it linked, in words for the note's Where."""
    from services import docs as svc_docs
    from services import tickets as svc_tickets

    where = []
    if branch:
        known = [
            b.get("name") for b in loads(ticket.branches, []) if isinstance(b, dict)
        ]
        if branch not in known:
            try:
                await svc_tickets.add_branch(
                    session, ticket.id, name=branch, adopt=True
                )
            except Exception as exc:  # noqa: BLE001 - the git error says why, in the caller's words
                raise HoldError(f"Could not link the branch {branch}: {exc}") from exc
        where.append(f"branch `{branch}`")
    for page_id in pages:
        try:
            row = await svc_docs.link_ticket_doc(session, ticket.id, page_id)
        except Exception as exc:  # noqa: BLE001
            raise HoldError(f"Could not link the Docs page {page_id}: {exc}") from exc
        where.append(f"Docs page “{row.get('title') or page_id}” ({page_id})")
    return where


async def hand_over(
    ticket_id: str,
    *,
    by: str,
    note: dict | None = None,
    text: str | None = None,
    member_id: str | None = None,
    workflow: str | None = None,
    branch: str | None = None,
    pages: list[str] | None = None,
) -> dict:
    """Give the ticket to the AI team with a handoff note, in one call. The note's Where gains the branch and pages
    it links. Then, in this order: a workflow paused by a take-back resumes at its step; `workflow` starts one; a
    workflow already going tells its running AI; `member_id` (else the AI that held it last) takes it as a work run.

    Raises:
        HoldError: Nothing to hand to, or the note is empty, or a link fails.
    """
    from services import tickets as svc_tickets

    from . import runs as svc_runs
    from . import workflow as wf_svc

    note = handoff.clean(note) or (
        {"done": text.strip()} if (text or "").strip() else None
    )
    if note is None:
        raise HoldError(
            "A hand-over needs its note: fields {done, where, left, check} (or a text saying what was done)."
        )
    async with database.async_session() as session:
        ticket = await session.get(Ticket, ticket_id)
        if ticket is None:
            raise HoldError(f"Ticket {ticket_id} not found.")
        who = await _person_name(session, ticket, by)
        linked = await _link_work(
            session, ticket, (branch or "").strip() or None, list(pages or [])
        )
        if linked:
            said = note.get("where") or ""
            note["where"] = "; ".join(x for x in [said, *linked] if x)[
                : handoff.MAX_FIELD
            ]
        for key in handoff.FIELDS:
            note[key] = note.get(key) or handoff.NOT_SAID
        if text and note["done"] != text.strip():
            note["check"] = (
                f"{note['check']} {who}: {text.strip()}"
                if note["check"] != handoff.NOT_SAID
                else text.strip()
            )[: handoff.MAX_FIELD]
        wf = await session.get(AiTicketWorkflow, ticket_id)
        target = await _ai(session, ticket.project_id, member_id)
        if member_id and target is None:
            raise HoldError(f"No AI member '{member_id}' in this project.")
        prompt = handoff.for_prompt(
            note, source=f"{who} left when handing the ticket over"
        )
        route = None
        to_label = None
        if wf is not None and wf.state == "stopped" and wf.stop_reason == TAKEN_BACK:
            route = "resumed"
            to_label = "the workflow"
        elif workflow:
            if wf is not None and wf.state not in ("detached", "done"):
                raise HoldError(
                    f"{ticket_id} already follows a workflow ({wf.template_name}): hand it over without `workflow`."
                )
            route = "workflow"
            to_label = f"the {workflow} workflow"
        elif wf is not None and wf.state == "active":
            route = "told"
            to_label = "the AI on it"
        else:
            if target is None:
                last = await _last_work_run(session, ticket_id)
                target = await _member(session, last.member_id) if last else None
                if target is None:
                    assignee = await _member(session, ticket.assignee)
                    target = (
                        assignee
                        if assignee is not None and assignee.kind == "ai"
                        else None
                    )
            if target is None:
                raise HoldError(
                    "Name the AI member (member_id) or a workflow: no AI has worked on this ticket yet."
                )
            route = "member"
            to_label = target.name
        note_id = await handoff.post(
            session, ticket_id, note, author=who, to=to_label, ai=False
        )
        out: dict = {
            "ticket_id": ticket_id,
            "route": route,
            "note_comment_id": note_id,
            "note": note,
        }
        if route == "resumed":
            rows = await _open_rows(session, ticket_id)
            old = next(
                (r for r in rows if r.outcome == TAKEN_BACK), rows[0] if rows else None
            )
            if old is not None and old.state != "waiting":
                # a new attempt of the step taken back, and of every step after it, so the order stays the template's
                # (the rows already there are kept as history, as a send-back keeps them)
                every = await wf_svc.steps_of(session, ticket_id)
                base = max((r.seq for r in every), default=0) + 1
                latest: dict[int, AiTicketStep] = {}
                for r in every:
                    if r.idx >= old.idx and r.state != "superseded":
                        latest[r.idx] = r
                for i, idx in enumerate(sorted(latest)):
                    prev = latest[idx]
                    if prev.state in (
                        "pending",
                        "active",
                        "waiting",
                        "blocked",
                        "failed",
                    ):
                        prev.state = "superseded"
                        session.add(prev)
                    mine = idx == old.idx
                    session.add(
                        AiTicketStep(
                            ticket_id=ticket_id,
                            seq=base + i,
                            idx=prev.idx,
                            key=prev.key,
                            label=prev.label,
                            kind=prev.kind,
                            role=prev.role,
                            attempt=prev.attempt + 1 if mine else prev.attempt,
                            note_in=prompt if mine else None,
                            member_id=prev.member_id if mine else None,
                        )
                    )
            wf.state, wf.stop_reason, wf.stop_detail = "active", None, None
            wf.updated_at = _now()
            session.add(wf)
            await session.commit()
            out["step"] = old.label if old is not None else None
        elif route == "workflow":
            try:
                await wf_svc.attach(session, ticket, workflow, by=by, start=False)
            except wf_svc.WorkflowError as exc:
                raise HoldError(str(exc)) from exc
            first = next(iter(await _open_rows(session, ticket_id)), None)
            if first is not None:
                first.note_in = prompt
                session.add(first)
                await session.commit()
            out["workflow"] = workflow
        elif route == "member":
            if ticket.assignee != target.id:
                await svc_tickets.update_ticket(
                    session, ticket_id, TicketUpdate(assignee=target.id)
                )
            try:
                run = await svc_runs.create_run(
                    session,
                    ticket_id=ticket_id,
                    member_id=target.id,
                    mode="work",
                    trigger="handoff",
                    started_by=by,
                    instruction=prompt,
                    wait_for_hold=True,
                )
            except svc_runs.RunError as exc:
                raise HoldError(str(exc)) from exc
            out.update(member=target.name, run_id=run.id, run_number=run.number)
    if route in ("resumed", "workflow"):
        await wf_svc.advance(ticket_id)
    elif route == "told":
        async with database.async_session() as session:
            running = next(iter(await _work_runs(session, ticket_id)), None)
        if running is not None:
            out["delivered"] = await svc_runs.tell(running.id, prompt, by=by)
            out["run_id"] = running.id
    async with database.async_session() as session:
        ticket = await session.get(Ticket, ticket_id)
        out["holder"] = await holder(session, ticket)
    await board_events.publish("invalidate")
    return out
