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
from models import AiLesson, AiProjectKnowledge, AiRun, Ticket

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
        row = AiProjectKnowledge(project_id=project_id)
        session.add(row)
        await session.flush()
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
    out, used = [], 0
    for r in sorted(rows, key=lambda r: (-(r.uses or 0), r.created_at), reverse=False):
        cost = estimate_tokens(r.text)
        if used + cost > LESSON_TOKEN_CAP:
            continue
        out.append(r)
        used += cost
    return out


async def prompt_block(session, project_id: str, *, record_use: bool = False) -> str:
    """The text every run on the project gets in its system prompt: the instructions, then the kept lessons."""
    row = await session.get(AiProjectKnowledge, project_id)
    settings = await get_settings(session, project_id)
    cap = int(ops.get(settings).get("lessons_in_prompt") or 20)
    kept = _fits(await lessons(session, project_id, state="kept"))[:cap]
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
    if record_use and kept:
        now = _now()
        for r in kept:
            r.uses = (r.uses or 0) + 1
            r.last_used_at = now
            session.add(r)
        await session.commit()
    return "\n\n".join(parts)


async def summary(session, project_id: str) -> dict:
    """The knowledge page: instructions, lessons, and how many tokens they add to every prompt."""
    row = await get(session, project_id)
    rows = await lessons(session, project_id)
    kept = _fits([r for r in rows if r.state == "kept"])
    instr_tokens = estimate_tokens(row.instructions or "")
    lesson_tokens = sum(estimate_tokens(r.text) for r in kept)
    await session.commit()
    return {
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
# A light model proposes at most one lesson when a ticket ends
# ---------------------------------------------------------------------------

LESSON_PROMPT = (
    "You read the log of an AI coding agent's work on one ticket. Propose AT MOST ONE lesson that would save the next "
    "AI on this project time or a mistake: a fact about this repository or how it is worked on (a command that must be "
    "run a certain way, a file that must not be touched, a trap that cost several attempts). Not a summary of the "
    "work, not generic advice. If nothing like that happened, propose nothing. Answer with ONE JSON object only: "
    '{"lesson": "one or two sentences, or empty", "why": "what in the log shows it"}.\n\n'
)


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
        for block in (ev.get("message") or {}).get("content") or []:
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


def parse_proposal(text: str) -> str | None:
    """The lesson in the light model's answer, or None."""
    import re

    m = re.search(r"\{.*\}", text or "", re.DOTALL)
    if not m:
        return None
    try:
        data = json.loads(m.group(0))
    except ValueError:
        return None
    lesson = " ".join(str(data.get("lesson") or "").split())
    return lesson[:600] or None


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
        out, _ = await asyncio.wait_for(child.communicate(), timeout=180)
    except (OSError, asyncio.TimeoutError):
        return None
    try:
        return json.loads(out.decode(errors="replace") or "{}").get("result")
    except ValueError:
        return None


async def propose_from_ticket(ticket_id: str) -> AiLesson | None:
    """When a ticket ends: a light model reads its last AI work run and proposes at most one lesson. Once per ticket."""
    from models import AiAccount
    from services import notifications as centre

    from .store import get_profile

    async with database.async_session() as session:
        ticket = await session.get(Ticket, ticket_id)
        if ticket is None:
            return None
        settings = await get_settings(session, ticket.project_id)
        if not ops.get(settings).get("propose_lessons"):
            return None
        done = (
            await session.exec(
                select(AiLesson).where(AiLesson.source_ticket_id == ticket_id)
            )
        ).first()
        if done is not None:
            return None
        run = (
            await session.exec(
                select(AiRun)
                .where(AiRun.ticket_id == ticket_id, AiRun.mode == "work")
                .order_by(col(AiRun.queued_at).desc())
                .limit(1)
            )
        ).first()
        if run is None:
            return None
        member, profile = await get_profile(session, run.member_id)
        if (
            profile is None
            or profile.provider != "claude-code"
            or profile.connection == "api_key"
        ):
            return None
        account_id = run.account_id or profile.account_id
        account = await session.get(AiAccount, account_id) if account_id else None
    records = await transcripts.read(run.id)
    if not records:
        return None
    answer = await _ask_light_model(LESSON_PROMPT + digest(records), profile, account)
    lesson = parse_proposal(answer or "")
    async with database.async_session() as session:
        # mark the ticket as read even when nothing was proposed, so it is never read twice
        marker = AiLesson(
            project_id=run.project_id,
            text=lesson or "",
            state="proposed" if lesson else "none",
            source_ticket_id=ticket_id,
            source_run_id=run.id,
            proposed_by="model",
        )
        session.add(marker)
        await session.commit()
        await session.refresh(marker)
        if not lesson:
            return None
        await centre.emit(
            "lesson",
            project_id=run.project_id,
            recipients=await centre.owners_and_admins(session, run.project_id),
            title=f"A lesson proposed from {ticket_id}",
            body=lesson[:300],
            target_kind="lesson",
            target_id=marker.id,
            ticket_id=ticket_id,
            member_id=run.member_id,
            data={"run_id": run.id},
            session=session,
        )
        return marker


async def propose_from_diagnosis(run_id: str, text: str) -> AiLesson | None:
    """A diagnosis named something the project will meet again (a dev server that hung): propose it."""
    async with database.async_session() as session:
        run = await session.get(AiRun, run_id)
        if run is None:
            return None
        return await add_lesson(
            session,
            run.project_id,
            text,
            by="the board",
            state="proposed",
            source_ticket_id=run.ticket_id,
            source_run_id=run_id,
            proposed_by="diagnosis",
        )


def on_ticket_done(ticket_id: str) -> None:
    """Called when a ticket moves to Done: the proposal runs in the background, never in the request."""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    task = loop.create_task(_safe_propose(ticket_id))
    _TASKS.add(task)
    task.add_done_callback(_TASKS.discard)


_TASKS: set[asyncio.Task] = set()


async def _safe_propose(ticket_id: str) -> None:
    try:
        await propose_from_ticket(ticket_id)
    except Exception:  # noqa: BLE001 - a proposal must never disturb the board
        logger.exception("Could not propose a lesson for %s", ticket_id)
