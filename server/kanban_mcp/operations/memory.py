"""The project memory over MCP (issue #274): read the instructions, lessons and notes; keep a note; propose a lesson.

Inside a board run the note is the run's own: its role's memory (or its own when it has no role) or its ticket's. An
agent outside the board reads the same memory, proposes a lesson for a person to keep, and leaves notes on a ticket.
"""

from models import Ticket
from services.ai import knowledge, memory, ops as ai_ops
from services.ai import plugins as ai_plugins
from services.ai.store import get_profile, get_settings


async def _ticket(session, project_id: str, ticket_id: str) -> Ticket:
    ticket = await session.get(Ticket, ticket_id)
    if ticket is None:
        ticket = await session.get(Ticket, ticket_id.upper())
    if ticket is None or ticket.project_id != project_id:
        raise LookupError(f"No ticket {ticket_id} in this project.")
    return ticket


async def memory_action(
    session,
    ctx,
    project_id: str,
    action: str,
    *,
    text: str | None,
    scope: str | None,
    kind: str | None,
    note_id: str | None,
    ticket_id: str | None,
    person: str | None,
) -> dict:
    """``knowledge(memory | remember | forget)``."""
    role = None
    if ctx is not None:
        _member, profile = await get_profile(session, ctx.member_id)
        role = ai_plugins.role_of(profile) if profile is not None else None
    if action == "memory":
        return await _read(session, ctx, project_id, role, scope, ticket_id)
    settings = await get_settings(session, project_id)
    if ai_ops.get(settings).get("ai_notes", True) is False and scope != "project":
        raise ValueError(
            "This project has AI notes switched off (Settings › AI › Project knowledge › Memory). Propose a lesson "
            "instead (scope='project')."
        )
    by = ctx.member_name if ctx else (person or "an outside agent")
    if action == "forget":
        if not note_id:
            raise ValueError("forget needs note_id.")
        row = await memory.forget(session, project_id, note_id)
        return {"forgot": row.id, "text": row.text}
    # remember
    if not (text or "").strip():
        raise ValueError("remember needs text.")
    scope = scope or ("role" if ctx else "project")
    run_ticket = ctx.ticket_id if ctx else None
    if scope == "project":
        row = await knowledge.propose(
            session,
            project_id,
            text or "",
            by=by,
            proposed_by=by,
            source_ticket_id=run_ticket or ticket_id,
            source_run_id=ctx.run_id if ctx else None,
            member_id=ctx.member_id if ctx else None,
        )
        if row is None:
            return {"lesson": None, "note": "That lesson is already there."}
        return {
            "lesson": knowledge.lesson_dict(row),
            "note": "Proposed. It reaches every AI's prompt once a person keeps it.",
        }
    if scope == "ticket":
        tid = ticket_id or run_ticket
        if not tid:
            raise ValueError("A ticket note needs ticket_id.")
        ticket = await _ticket(session, project_id, tid)
        key = ticket.id
    else:
        if ctx is None:
            raise ValueError(
                "Role notes are kept by a board run. Outside one, leave a ticket note (scope='ticket') or propose a "
                "lesson (scope='project')."
            )
        scope, key = memory.own_scope(role, ctx.member_id)
    row, what = await memory.write(
        session,
        project_id,
        scope,
        key,
        text or "",
        by=by,
        kind=kind or "learned",
        note_id=note_id,
        source_run_id=ctx.run_id if ctx else None,
        source_ticket_id=run_ticket or ticket_id,
    )
    if ctx is not None and what != "unchanged":
        await _log_on_run(session, ctx.run_id, row, what)
    return {
        "note": memory.note_dict(row),
        "result": what,
        "reaches": (
            f"every later run on {key}"
            if scope == "ticket"
            else (f"every {role} run on this project" if role else "your next runs")
        ),
    }


async def _read(session, ctx, project_id, role, scope, ticket_id) -> dict:
    """What the project remembers, as a run (or an outside agent) would want it."""
    summary = await knowledge.summary(session, project_id)
    out: dict = {
        "instructions": summary["instructions"],
        "lessons": [
            {"id": x["id"], "text": x["text"], "state": x["state"]}
            for x in summary["lessons"]
        ],
    }
    notes = summary["notes"]
    if ctx is not None:
        own_scope, own_key = memory.own_scope(role, ctx.member_id)
        mine = [
            n for n in notes if n["scope"] == own_scope and n["scope_key"] == own_key
        ]
        on_ticket = [
            n
            for n in notes
            if n["scope"] == "ticket" and n["scope_key"] == ctx.ticket_id
        ]
        out["your_notes"] = [_short(n) for n in mine]
        out["ticket_notes"] = [_short(n) for n in on_ticket]
        out["cap"] = {
            "your_notes": memory.MAX_NOTES[own_scope],
            "ticket_notes": memory.MAX_NOTES["ticket"],
        }
    else:
        out["notes"] = [
            {**_short(n), "scope": n["scope"], "scope_key": n["scope_key"]}
            for n in notes
            if not ticket_id or n["scope_key"] == ticket_id
        ]
    if scope:
        keep = {
            "project": ("instructions", "lessons"),
            "role": ("your_notes",),
            "ticket": ("ticket_notes",),
        }
        out = {
            k: v
            for k, v in out.items()
            if k in keep.get(scope, out.keys()) or k == "cap"
        }
    out["how"] = (
        "remember: keep a fact you learned or a person's feedback (scope role, ticket or project); replace a wrong "
        "note with note_id; forget one that no longer holds. See the keeping-memory guide."
    )
    return out


def _short(n: dict) -> dict:
    return {
        "id": n["id"],
        "text": n["text"],
        "kind": n["kind"],
        "by": n["written_by"],
        "uses": n["uses"],
    }


async def _log_on_run(session, run_id: str, row, what: str) -> None:
    """A step on the run, so a person reading it sees what the AI chose to remember."""
    from services.ai import runs

    await runs._append(
        run_id,
        steps=[
            {
                "kind": "memory",
                "text": f"{'Remembered' if what == 'added' else 'Updated a note'}: {row.text[:200]}",
                "note_id": row.id,
                "scope": row.scope,
            }
        ],
    )
