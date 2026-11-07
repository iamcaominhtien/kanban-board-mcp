"""What the project knows and what its AIs learned (design/screens/ai-operations.md, H; plan D18 a and b).

- **Instructions**: one text per project, written by a person, in the system prompt of every run on the project
  (before the member's own persona). Project-wide, so it is not copied into each member's CLAUDE.md.
- **Memory (lessons)**: short facts learned the hard way. An AI proposes one (a light model reading a finished ticket's
  run, or a diagnosis such as "the dev server must run in the background"); a person keeps, edits or drops it. Only
  kept lessons go into the prompt, capped at ``LESSON_TOKEN_CAP``.

The system prompt is fixed at the first request of a conversation, so a change takes effect on the next run (the
runner starts a fresh conversation when the instructions it would send differ from the ones the conversation has).
"""

import asyncio
import json
import logging
import tempfile
from datetime import UTC, datetime

from sqlmodel import col, select

import database
from models import AiLesson, AiProjectKnowledge, AiRun

from . import ops, transcripts
from .config_model import estimate_tokens
from .store import get_settings

logger = logging.getLogger(__name__)

LESSON_TOKEN_CAP = 2000
PROMPT_BUDGET = 8000


def _now() -> str:
    return datetime.now(UTC).isoformat()


async def get(session, project_id: str) -> AiProjectKnowledge:
    """The project's knowledge row, created on first use."""
    row = await session.get(AiProjectKnowledge, project_id)
    if row is None:
        await database.insert_missing(
            session, AiProjectKnowledge, project_id=project_id
        )
        row = await session.get(AiProjectKnowledge, project_id)
    return row


async def set_instructions(
    session, project_id: str, text: str, *, by: str
) -> AiProjectKnowledge:
    """Replace the project's instructions; the previous text goes into the history."""
    row = await get(session, project_id)
    history = json.loads(row.history or "[]")
    if (row.instructions or "").strip():
        history.append(
            {"at": row.updated_at, "by": row.updated_by, "text": row.instructions}
        )
    row.instructions = text or ""
    row.history = json.dumps(history[-30:])
    row.updated_at = _now()
    row.updated_by = by
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return row


async def lessons(session, project_id: str, state: str | None = None) -> list[AiLesson]:
    """The project's lessons, newest first."""
    stmt = select(AiLesson).where(AiLesson.project_id == project_id)
    if state:
        stmt = stmt.where(AiLesson.state == state)
    return list(
        (await session.exec(stmt.order_by(col(AiLesson.created_at).desc()))).all()
    )


async def add_lesson(
    session,
    project_id: str,
    text: str,
    *,
    by: str,
    state: str = "kept",
    source_ticket_id: str | None = None,
    source_run_id: str | None = None,
    proposed_by: str | None = None,
) -> AiLesson | None:
    """Add a lesson (a person's is kept at once; an AI's is a proposal). None when the same text already exists."""
    text = " ".join((text or "").split())[:600]
    if not text:
        raise ValueError("Write the lesson.")
    same = (
        await session.exec(
            select(AiLesson).where(
                AiLesson.project_id == project_id,
                AiLesson.text == text,
                AiLesson.state != "dropped",
            )
        )
    ).first()
    if same is not None:
        return None
    row = AiLesson(
        project_id=project_id,
        text=text,
        state=state,
        source_ticket_id=source_ticket_id,
        source_run_id=source_run_id,
        proposed_by=proposed_by or by,
        kept_by=by if state == "kept" else None,
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return row


async def update_lesson(
    session,
    lesson_id: str,
    *,
    by: str,
    text: str | None = None,
    state: str | None = None,
) -> AiLesson:
    """Keep, edit or drop a lesson."""
    row = await session.get(AiLesson, lesson_id)
    if row is None:
        raise LookupError("Lesson not found.")
    if text is not None:
        clean = " ".join(text.split())[:600]
        if not clean:
            raise ValueError("A lesson cannot be empty.")
        row.text = clean
    if state is not None:
        if state not in ("proposed", "kept", "dropped"):
            raise ValueError("A lesson is proposed, kept or dropped.")
        row.state = state
        if state == "kept":
            row.kept_by = by
    row.updated_at = _now()
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return row


def _fits(rows: list[AiLesson]) -> list[AiLesson]:
    """Kept lessons up to the cap, the most used and most recent first."""
    from .memory import _neg

    out, used = [], 0
    # newest first among equally used ones (it sorted the oldest first, so a fresh lesson was the one left out)
    for r in sorted(rows, key=lambda r: (-(r.uses or 0), _neg(r.created_at))):
        cost = estimate_tokens(r.text)
        if used + cost > LESSON_TOKEN_CAP:
            continue
        out.append(r)
        used += cost
    return out


async def prompt_block(session, project_id: str, *, record_use: bool = False) -> str:
    """The project's part of every run's system prompt: the instructions, then the kept lessons."""
    text, _used = await block_for(session, project_id, record_use=record_use)
    return text


async def block_for(
    session,
    project_id: str,
    *,
    role: str | None = None,
    member_id: str | None = None,
    ticket_id: str | None = None,
    record_use: bool = False,
    notes_on: bool = True,
) -> tuple[str, dict]:
    """(text, used) for a run's system prompt: the instructions, the kept lessons, the member's own notes (its role's)
    and the notes on its ticket (issue #274). ``used`` is what the run carried: {lessons, notes}, recorded on the run
    so a person sees "used 3 lessons" and which."""
    from . import memory

    row = await session.get(AiProjectKnowledge, project_id)
    settings = await get_settings(session, project_id)
    cap = int(ops.get(settings).get("lessons_in_prompt") or 20)
    kept = _fits(await lessons(session, project_id, state="kept"))[:cap]
    own, on_ticket = (
        await memory.for_run(
            session, project_id, role=role, member_id=member_id, ticket_id=ticket_id
        )
        if notes_on and (member_id or ticket_id)
        else ([], [])
    )
    parts = []
    if row is not None and (row.instructions or "").strip():
        parts.append(
            f"Project instructions (written by the project's people, for every AI on this project):\n{row.instructions.strip()}"
        )
    if kept:
        parts.append(
            "What the AIs on this project learned (lessons kept by a person; follow them):\n"
            + "\n".join(f"- {r.text}" for r in kept)
        )
    if own:
        whose = f"the {role} role's" if role else "your own"
        parts.append(
            f"Your notes ({whose} memory, kept across runs by you and your teammates of the same role; update them "
            "when they are wrong):\n"
            + "\n".join(
                f"- [{n.id}]{' (a person said)' if n.kind == 'feedback' else ''} {n.text}"
                for n in own
            )
        )
    if on_ticket:
        parts.append(
            f"Notes on this ticket (left by earlier runs on {ticket_id}; read them before you start):\n"
            + "\n".join(
                f"- [{n.id}] ({n.written_by or 'a run'}) {n.text}" for n in on_ticket
            )
        )
    used = {
        "lessons": [{"id": r.id, "text": r.text} for r in kept],
        "notes": [
            {"id": n.id, "scope": n.scope, "text": n.text} for n in [*own, *on_ticket]
        ],
        "tokens": sum(estimate_tokens(r.text) for r in kept)
        + sum(estimate_tokens(n.text) for n in [*own, *on_ticket]),
    }
    if record_use and (kept or own or on_ticket):
        now = _now()
        for r in [*kept, *own, *on_ticket]:
            r.uses = (r.uses or 0) + 1
            r.last_used_at = now
            session.add(r)
        await session.commit()
    return "\n\n".join(parts), used


async def for_run(session, run: AiRun, profile) -> str:
    """The memory block of one run, recorded on the run (``memory_used``)."""
    from . import plugins as ai_plugins

    settings = await get_settings(session, run.project_id)
    text, used = await block_for(
        session,
        run.project_id,
        role=ai_plugins.role_of(profile),
        member_id=profile.id,
        ticket_id=run.ticket_id,
        record_use=True,
        notes_on=ops.get(settings).get("ai_notes", True) is not False,
    )
    session.add(run)
    await session.commit()
    return text


async def summary(session, project_id: str) -> dict:
    """The knowledge page: instructions, lessons, and how many tokens they add to every prompt."""
    from . import memory

    row = await get(session, project_id)
    rows = await lessons(session, project_id)
    kept = _fits([r for r in rows if r.state == "kept"])
    instr_tokens = estimate_tokens(row.instructions or "")
    lesson_tokens = sum(estimate_tokens(r.text) for r in kept)
    notes = await memory.notes(session, project_id)
    flags = await memory.flags(session, project_id)
    labels = await memory.labels(session, notes)
    await session.commit()
    return {
        "proposals": sum(1 for r in rows if r.state == "proposed"),
        "notes": [
            {**memory.note_dict(n), "scope_label": labels.get((n.scope, n.scope_key))}
            for n in notes
        ],
        "note_caps": memory.MAX_NOTES,
        # a list, not a dict keyed by id: the UI camel-cases dict keys, ids included
        "flags": [{"id": k, **f} for k, fs in flags.items() for f in fs],
        "project_id": project_id,
        "instructions": row.instructions or "",
        "instructions_tokens": instr_tokens,
        "updated_at": row.updated_at,
        "updated_by": row.updated_by,
        "history": json.loads(row.history or "[]"),
        "lessons": [lesson_dict(r) for r in rows if r.state in ("proposed", "kept")],
        "lessons_tokens": lesson_tokens,
        "lesson_cap": LESSON_TOKEN_CAP,
        "total_tokens": instr_tokens + lesson_tokens,
        "budget": PROMPT_BUDGET,
        "unused": [r.id for r in rows if r.state == "kept" and not r.uses],
    }


def lesson_dict(r: AiLesson) -> dict:
    """A lesson for the API."""
    return {
        "id": r.id,
        "text": r.text,
        "state": r.state,
        "tokens": estimate_tokens(r.text),
        "source_ticket_id": r.source_ticket_id,
        "source_run_id": r.source_run_id,
        "proposed_by": r.proposed_by,
        "kept_by": r.kept_by,
        "uses": r.uses or 0,
        "last_used_at": r.last_used_at,
        "created_at": r.created_at,
        "updated_at": r.updated_at,
    }


# ---------------------------------------------------------------------------
# The light model (notes after a run, the repository scan)
# ---------------------------------------------------------------------------

LIGHT_MODEL_TIMEOUT_S = 180


def digest(records: list[dict], limit: int = 12000) -> str:
    """A short text of a run for the light model: what the AI said, the commands it ran and how they ended, errors."""
    out: list[str] = []
    for rec in records:
        if rec.get("k") == "note":
            out.append(f"[board] {rec.get('text')}")
            continue
        ev = rec.get("e") if rec.get("k") == "event" else None
        if not isinstance(ev, dict):
            continue
        for block in transcripts.blocks_of(ev):
            if not isinstance(block, dict):
                continue
            if block.get("type") == "text" and ev.get("type") == "assistant":
                out.append(f"AI: {(block.get('text') or '')[:400]}")
            elif block.get("type") == "tool_use":
                inp = block.get("input") or {}
                what = (
                    inp.get("command")
                    or inp.get("file_path")
                    or inp.get("pattern")
                    or ""
                )
                out.append(f"tool {block.get('name')}: {str(what)[:200]}")
            elif block.get("type") == "tool_result" and block.get("is_error"):
                body = block.get("content")
                if isinstance(body, list):
                    body = " ".join(
                        str(c.get("text", "")) for c in body if isinstance(c, dict)
                    )
                out.append(f"  error: {str(body)[:300]}")
    text = "\n".join(out)
    return text[-limit:]


async def _ask_light_model(prompt: str, profile, account) -> str | None:
    from . import accounts, cli

    path, _ = cli.find_cli("claude", profile.cli_path)
    if not path:
        return None
    env = cli.child_env(None)
    if account is not None:
        env = accounts.env_for(account, env)
    try:
        child = await asyncio.create_subprocess_exec(
            path,
            "-p",
            prompt,
            "--model",
            "haiku",
            "--output-format",
            "json",
            "--permission-mode",
            "dontAsk",
            "--strict-mcp-config",
            "--mcp-config",
            '{"mcpServers": {}}',
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
            cwd=tempfile.gettempdir(),
        )
        out, _ = await asyncio.wait_for(
            child.communicate(), timeout=LIGHT_MODEL_TIMEOUT_S
        )
    except asyncio.TimeoutError:  # before OSError, which it is a kind of
        cli.kill_tree(child.pid)  # never left behind
        await child.wait()
        return None
    except OSError:
        return None
    try:
        return json.loads(out.decode(errors="replace") or "{}").get("result")
    except ValueError:
        return None


async def propose(
    session,
    project_id: str,
    text: str,
    *,
    by: str,
    proposed_by: str,
    source_ticket_id: str | None = None,
    source_run_id: str | None = None,
    member_id: str | None = None,
) -> AiLesson | None:
    """Propose a lesson and tell the project's owners and admins it waits for them (an AI in a run, an outside agent
    over MCP, a diagnosis). None when the same lesson is already there."""
    from services import notifications as centre

    row = await add_lesson(
        session,
        project_id,
        text,
        by=by,
        state="proposed",
        source_ticket_id=source_ticket_id,
        source_run_id=source_run_id,
        proposed_by=proposed_by,
    )
    if row is None:
        return None
    try:
        await centre.emit(
            "lesson",
            project_id=project_id,
            recipients=await centre.owners_and_admins(session, project_id),
            title=f"A lesson proposed by {proposed_by}"
            + (f" on {source_ticket_id}" if source_ticket_id else ""),
            body=row.text[:300],
            target_kind="lesson",
            target_id=row.id,
            ticket_id=source_ticket_id,
            member_id=member_id,
            data={"run_id": source_run_id} if source_run_id else {},
            session=session,
        )
    except Exception:  # noqa: BLE001 - the proposal stands even if nobody could be told
        logger.exception("Could not tell anyone about lesson %s", row.id)
    return row


async def propose_from_diagnosis(run_id: str, text: str) -> AiLesson | None:
    """A diagnosis named something the project will meet again (a dev server that hung): propose it. A person is told,
    as for a proposal at the end of a ticket (it used to wait unseen)."""
    async with database.async_session() as session:
        run = await session.get(AiRun, run_id)
        if run is None:
            return None
        return await propose(
            session,
            run.project_id,
            text,
            by="the board",
            proposed_by="diagnosis",
            source_ticket_id=run.ticket_id,
            source_run_id=run_id,
            member_id=run.member_id,
        )
