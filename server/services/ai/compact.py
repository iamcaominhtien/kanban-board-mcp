"""`/compact` in the ticket chat: summarise the older part of the lead's conversation so it has room again.

A lead that is working is not stopped (tried with Haiku: a `/compact` sent to a working session waits for the end of its
turn, and the board closes the session's input then, so the command would be lost). The board keeps the wish and runs
the compaction itself when the run has ended. A lead that is idle has its last session compacted by the CLI, run once
with `--resume` in the folder the session was made in. For a lead that works for hours, the project's auto-compact level
(Settings > AI) is what keeps its context from filling: Claude Code then compacts between two steps, without a stop."""

import asyncio
import json
import logging
import os

import database
from models import AiAccount, AiRun, AiRunMessage, Ticket
from sqlmodel import col, select

from . import accounts, cli, worktrees
from .runs import RunError
from .store import active_runs, now_iso
from .teams import get_profile

logger = logging.getLogger("kanban.ai.compact")

TIMEOUT_S = 300
WISH = "/compact (when this run has ended)"  # the note the chat leaves on a working run; the run's end acts on it


async def compact_ticket(ticket_id: str, *, by: str) -> dict:
    """Compact the conversation of the team that works the ticket. Returns {"state": "queued" | "done", ...}."""
    async with database.async_session() as session:
        live = [r for r in await active_runs(session, ticket_id=ticket_id)]
        last = (
            await session.exec(
                select(AiRun)
                .where(AiRun.ticket_id == ticket_id, col(AiRun.session_id).is_not(None))
                .order_by(col(AiRun.queued_at).desc())
                .limit(1)
            )
        ).first()
    if live:
        run = live[0]
        async with database.async_session() as session:
            # a row in the run's messages: the process that ends the run (the runner) reads it from the database
            session.add(
                AiRunMessage(run_id=run.id, direction="in", peer=by[:200], text=WISH)
            )
            await session.commit()
        return {"state": "queued", "run_id": run.id}
    if last is None:
        raise RunError("There is no conversation of the team on this ticket yet.")
    return await _compact_idle(last, by=by)


_TASKS: set[asyncio.Task] = set()


def after_run(ticket_id: str, run_id: str) -> None:
    """A run ended: compact the lead's conversation now when someone asked for it while the run worked."""

    async def go() -> None:
        async with database.async_session() as session:
            asked = (
                await session.exec(
                    select(AiRunMessage).where(
                        AiRunMessage.run_id == run_id, AiRunMessage.text == WISH
                    )
                )
            ).first()
            if asked is None:
                return
            await session.delete(asked)
            await session.commit()
        await asyncio.sleep(
            2
        )  # the session file is closed, and a run that follows on the ticket can be seen
        async with database.async_session() as session:
            if await active_runs(session, ticket_id=ticket_id):
                return  # it works again: the auto-compact level looks after it
            last = await session.get(AiRun, run_id)
        if last is None or not last.session_id:
            return
        try:
            await _compact_idle(last, by="the chat")
        except (RunError, OSError) as exc:
            logger.info("compact after run %s skipped: %s", run_id, exc)

    task = asyncio.create_task(go())
    _TASKS.add(task)
    task.add_done_callback(_TASKS.discard)


async def _compact_idle(last: AiRun, *, by: str) -> dict:
    async with database.async_session() as session:
        run = await session.get(AiRun, last.id)
        member, profile = await get_profile(session, run.member_id)
        if member is None or profile is None:
            raise RunError("The team no longer exists.")
        account = (
            await session.get(AiAccount, run.account_id or profile.account_id)
            if (run.account_id or profile.account_id)
            else None
        )
        config_dir = accounts.claude_config_dir(account) if account else None
        ticket = await session.get(Ticket, run.ticket_id)
        tree = await worktrees.for_ticket(session, run.ticket_id) if ticket else None
        cwd = (
            tree.path
            if tree is not None and tree.path and os.path.isdir(tree.path)
            else profile.working_dir
        )
        path, _checked = cli.find_cli("claude", profile.cli_path)
        model, session_id = run.model or profile.model, run.session_id
    if not path or not cwd or not session_id:
        raise RunError("Claude Code, the team's folder or its session was not found.")
    if not cli.session_exists(session_id, config_dir):
        raise RunError("The lead's last conversation is not on this computer any more.")
    args = [
        path,
        "-p",
        "/compact",
        "--resume",
        session_id,
        "--setting-sources",
        "",
        "--output-format",
        "stream-json",
        "--verbose",
    ]
    if model:
        args += ["--model", model]
    base = cli.child_env()
    env = accounts.env_for(account, base) if account else dict(base)
    proc = await asyncio.create_subprocess_exec(
        *args,
        cwd=cwd,
        env=env,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), TIMEOUT_S)
    except asyncio.TimeoutError:
        proc.kill()
        raise RunError("Compacting took too long and was stopped.") from None
    before = after = None
    new_id = session_id
    for line in out.decode("utf-8", "replace").splitlines():
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        if ev.get("session_id"):
            new_id = ev["session_id"]
        meta = (
            ev.get("compact_metadata")
            if ev.get("subtype") == "compact_boundary"
            else None
        )
        if meta:
            before, after = meta.get("pre_tokens"), meta.get("post_tokens")
    if after is None:
        raise RunError("Claude Code did not compact the conversation.")
    async with database.async_session() as session:
        run = await session.get(AiRun, last.id)
        run.session_id = new_id
        run.context_used = after
        session.add(run)
        await session.commit()
    logger.info("compacted %s: %s -> %s tokens (%s)", last.id, before, after, now_iso())
    return {"state": "done", "before": before, "after": after}
