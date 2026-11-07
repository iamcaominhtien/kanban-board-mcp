"""AI runs (v2): one Claude Code session per ticket, led by the team's lead; its roles are subagents.

The board queues a run, starts the CLI with what `launch` prepares, reads its stream into step rows (`stream`,
`steps`), keeps the session for the next turn on the ticket (`--resume`), takes the lead's final report
(`--json-schema`) and ends the run. People talk to a running lead through its stdin (`send_message`); a question
the lead asks (`ai_run ask`) parks the run in `needs_input` until `answer`.
"""

import asyncio
import json
import logging
import time
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime

from sqlmodel import col, select

import database
import events as board_events
import services.tickets as svc_tickets
from models import AiAccount, AiRun, AiRunMessage, AiTeam, Member, Ticket, TicketUpdate

from . import (
    accounts,
    runner_link,
    audit,
    budget,
    cli,
    guard,
    launch,
    quota,
    resources,
    steps,
    stream,
    teams,
    transcripts,
    worktrees,
)
from .context import RunContext
from .providers import merged_config
from .secrets import redact
from .store import active_runs, get_profile, get_settings, loads, now_iso, parse_iso

logger = logging.getLogger("kanban.ai.runs")

ENDED = ("finished", "failed", "cancelled")
ACTIVE = ("queued", "starting", "running", "needs_input")
BOARD_CLOSED = "board_closed"
STARTING_TIMEOUT_S = 180.0
WATCH_EVERY_S = 5.0
RESULT_GRACE_S = 20.0
# A role the lead called runs in the background: the lead's turn can end while it still works, and the CLI then finishes
# the role, wakes the lead for another turn and exits by itself once its input is closed (measured). The board only
# watches: it closes the input at the lead's first real result and never stops a CLI that still has a role working;
# a person's Stop is the only thing that does.


class RunLife:
    """When a live run's CLI may be closed and when it must be stopped, from what its own stream says.

    A CLI session has many turns; each ends with a `result` (a turn with no content, `turns` 0, is the CLI handling a
    notification left by an earlier run: not an answer). At the lead's first real result the input is closed and the CLI
    is left to finish: it ends the roles that still work, wakes the lead for another turn and exits by itself. It is
    stopped only when it lingers with nothing left to wait for (a dev server the lead started)."""

    def __init__(self) -> None:
        """Nothing has been answered and no role works."""
        self.open_agents: set[str] = (
            set()
        )  # roles (local_agent tasks) started and not ended
        self.answered_at: float | None = None

    def feed(self, parsed: dict, now: float) -> bool:
        """Take one parsed line; True when it is the lead's real answer (the caller closes the input)."""
        if parsed["ready"]:
            self.answered_at = None  # a new turn begins (a role reported, or a message came): the lead works again
        for task in parsed["tasks"]:
            if task["event"] == "started" and task["type"] == "local_agent":
                self.open_agents.add(task["id"])
            elif task["event"] == "ended" and task["id"] in self.open_agents:
                self.open_agents.discard(task["id"])
                if not self.open_agents and self.answered_at is not None:
                    self.answered_at = now  # the last role reported: the CLI has the grace to wake the lead
        if parsed["result"]:
            self.answered_at = now
            return True
        return False

    def wait_s(self, now: float, default: float) -> float:
        """How long to wait for the next line before looking at the clock again."""
        if self.answered_at is None:
            return default
        since = now - self.answered_at
        if since < RESULT_GRACE_S:
            return max(0.5, RESULT_GRACE_S - since)
        return WATCH_EVERY_S

    def must_stop(self, now: float) -> bool:
        """The CLI answered and stays open: stop it unless a role still works. A question to a person does not change
        that: the roles finish, then the run waits for the answer."""
        if self.answered_at is None or now - self.answered_at < RESULT_GRACE_S:
            return False
        return not self.open_agents


_UNSET = object()


class RunError(ValueError):
    """A run could not be started or changed; the message is for the person."""


class RunConflict(RunError):
    """The ticket already has an active run."""


@dataclass
class _Runtime:
    wake: asyncio.Event = field(default_factory=asyncio.Event)
    tasks: dict[str, asyncio.Task] = field(default_factory=dict)
    procs: dict[str, cli.CliProcess] = field(default_factory=dict)
    writers: dict[str, steps.StepWriter] = field(default_factory=dict)
    cancelled: set[str] = field(default_factory=set)
    waiting: dict[str, str] = field(default_factory=dict)
    # a CLI that was stopped on purpose (the memory limit, or a person's Restart): who asked and the numbers
    restart_requests: dict[str, dict] = field(default_factory=dict)
    board_url: str | None = None
    scheduler: asyncio.Task | None = None
    last_health: float = 0.0
    db_ready: bool = (
        False  # the API brought the database up to date (the runner may start)
    )


RT = _Runtime()


def set_board_url(url: str) -> None:
    """Where the CLI reaches the board (its MCP endpoint and the hook endpoint). In process mode the API also
    starts the runner once it knows the URL."""
    RT.board_url = url
    # the runner opens the database too: it starts once the API has brought it up to date (start_scheduler)
    if RT.db_ready and not runner_link.in_runner():
        runner_link.ensure_started(url)


def defers_to_runner() -> bool:
    """True in the API process when a runner process owns the CLIs."""
    return runner_link.mode() == "process" and not runner_link.in_runner()


def _url() -> str:
    return RT.board_url or "http://127.0.0.1:8000"


# ---------------------------------------------------------------------------
# Describing
# ---------------------------------------------------------------------------


def _is_live(run: AiRun) -> bool:
    """Can a message reach the CLI of this run right now? This process knows when it runs the CLI itself; with the
    runner process the row says it."""
    proc = RT.procs.get(run.id)
    if proc is not None:
        return bool(proc.live and proc.input_open)
    return bool(run.live) and run.state in ("starting", "running")


def to_dict(run: AiRun) -> dict:
    """A run for the API: no steps (they are rows, fetched by page)."""
    return {
        "id": run.id,
        "project_id": run.project_id,
        "kind": run.kind,
        "ticket_id": run.ticket_id,
        "target": run.target,
        "member_id": run.member_id,
        "number": run.number,
        "mode": run.mode,
        "trigger": run.trigger,
        "state": run.state,
        "started_by": run.started_by,
        "instruction": run.instruction,
        "queued_at": run.queued_at,
        "started_at": run.started_at,
        "ended_at": run.ended_at,
        "last_output_at": run.last_output_at,
        "ended_reason": run.ended_reason,
        "ended_by": run.ended_by,
        "exit_code": run.exit_code,
        "summary": run.summary,
        "report": loads(run.report, {}),
        "question": loads(run.question, None) if run.question else None,
        "answer": run.answer,
        "session_id": run.session_id,
        "session_name": run.session_name,
        "files": loads(run.files, []),
        "tokens_in": run.tokens_in,
        "tokens_out": run.tokens_out,
        "tokens_cached": run.tokens_cached,
        "cost_usd": run.cost_usd,
        "context_used": run.context_used,
        "context_window": run.context_window,
        "pid": run.pid,
        "model": run.model,
        "effort": run.effort,
        "paused": run.paused,
        "stop_code": run.stop_code,
        "peak_rss_mb": run.peak_rss_mb,
        "last_rss_mb": run.last_rss_mb,
        "restarts": loads(run.restarts, []),
        "diagnosis": loads(run.diagnosis, None) if run.diagnosis else None,
        "retries": loads(run.retries, []),
        "account_id": run.account_id,
        "steps_count": run.steps_count,
        "live": _is_live(run),
        "waiting_reason": (RT.waiting.get(run.id) or run.waiting_reason)
        if run.state == "queued"
        else None,
    }


async def _publish_run(run_id: str) -> None:
    async with database.async_session() as session:
        run = await session.get(AiRun, run_id)
    if run is not None:
        await board_events.publish_typed("ai.run", {"run": to_dict(run)})
        board_events.mark_own_change()


# ---------------------------------------------------------------------------
# Queueing
# ---------------------------------------------------------------------------


async def create_run(
    session,
    *,
    ticket_id: str,
    member_id: str,
    mode: str = "work",
    trigger: str = "assign",
    started_by: str = "user",
    instruction: str = "",
    resume_session: str | None = None,
    kind: str = "team",
    target: str | None = None,
    **_ignored,
) -> AiRun:
    """Queue a run of a team on a ticket; the scheduler starts it when it can.

    Raises:
        RunConflict: The ticket already has a run going (send it a message instead).
        RunError: The team cannot run.
    """
    ticket = await session.get(Ticket, ticket_id) if ticket_id else None
    if ticket_id and ticket is None:
        raise RunError(f"Ticket {ticket_id} not found.")
    member, profile = await get_profile(session, member_id)
    if resume_session and ticket_id:
        from . import session_history

        # a conversation a person started over is closed: the new run starts a new one
        if resume_session in await session_history.closed_session_ids(
            session, ticket_id
        ):
            resume_session = None
    project_id = (
        ticket.project_id if ticket else (profile.project_id if profile else None)
    )
    if (
        member is None
        or profile is None
        or member.kind != "ai"
        or (ticket and member.project_id != ticket.project_id)
    ):
        raise RunError("Only an AI team of this project can run on this ticket.")
    if mode not in ("work", "ask"):
        raise RunError("mode must be work or ask")
    if ticket_id:
        for r in await active_runs(session, ticket_id=ticket_id):
            if r.state == "queued" and r.member_id == member_id:
                # one queue entry per team and ticket: the new request joins it
                r.instruction = "\n\n".join(
                    t for t in (r.instruction, instruction) if t
                )
                session.add(r)
                await session.commit()
                await session.refresh(r)
                RT.wake.set()
                return r
            if r.state in ("starting", "running", "needs_input"):
                who = (
                    (await session.get(Member, r.member_id))
                    if r.member_id != member_id
                    else member
                )
                raise RunConflict(
                    f"{ticket_id} already has a run going ({who.name if who else 'a team'}, run #{r.number}, "
                    f"{r.state}). Send it a message instead of starting another run."
                )
    last = (
        (
            await session.exec(
                select(AiRun)
                .where(AiRun.ticket_id == ticket_id)
                .order_by(col(AiRun.number).desc())
                .limit(1)
            )
        ).first()
        if ticket_id
        else None
    )
    run = AiRun(
        project_id=project_id,
        kind=kind,
        ticket_id=ticket_id,
        target=target,
        member_id=member_id,
        number=(last.number + 1) if last else 1,
        mode=mode,
        trigger=trigger,
        started_by=started_by,
        instruction=instruction or "",
        session_id=resume_session,
        session_name=ticket_id or target,
        model=profile.model,
        effort=profile.effort or merged_config(loads(profile.config, {})).get("effort"),
        account_id=profile.account_id,
    )
    session.add(run)
    await session.commit()
    await session.refresh(run)
    await audit.record(
        run.project_id,
        "run_queued",
        "info",
        member_id=member_id,
        member_name=member.name,
        on_behalf_of=started_by,
        run_id=run.id,
        target=ticket_id,
        detail={"trigger": trigger, "mode": mode},
    )
    RT.wake.set()
    await board_events.publish_typed("ai.run", {"run": to_dict(run)})
    return run


async def _blocking_reason(
    session, run: AiRun, profile: AiTeam, member: Member, settings
) -> str | None:
    """Why a queued run cannot start yet, or None."""
    if settings.paused_all:
        return "AI is paused for this project"
    if profile.paused:
        return f"{member.name} is paused"
    account_id = run.account_id or profile.account_id
    if account_id:
        account = await session.get(AiAccount, account_id)
        if account is not None and account.status == "needs_sign_in":
            return f"Account {account.name} needs sign-in"
    if profile.health in ("not_logged_in", "runner_missing"):
        return {
            "not_logged_in": "Claude Code is not signed in",
            "runner_missing": "Runner not detected",
        }[profile.health]
    own_retry = parse_iso(run.retry_at)
    if own_retry and own_retry > datetime.now(UTC):
        secs = max(1, int((own_retry - datetime.now(UTC)).total_seconds()))
        return f"Retrying in about {secs if secs < 120 else str(round(secs / 60)) + ' min'}{' s' if secs < 120 else ''}"
    try:
        window = await quota.blocking(session, run, profile)
    except Exception:  # noqa: BLE001 - quota is advice, never a reason to stall forever
        window = None
    if window:
        return window
    running = (
        await session.exec(
            select(AiRun).where(
                AiRun.member_id == run.member_id,
                col(AiRun.state).in_(["starting", "running"]),
            )
        )
    ).all()
    if len(running) >= max(1, profile.max_parallel or 1):
        return (
            f"Waiting for a free slot ({len(running)} of {profile.max_parallel} in use)"
        )
    if any(r.ticket_id == run.ticket_id and r.id != run.id for r in running):
        return "Waiting for this team's earlier run on the same ticket to finish"
    board_running = (
        await session.exec(
            select(AiRun).where(
                AiRun.project_id == run.project_id,
                col(AiRun.state).in_(["starting", "running"]),
            )
        )
    ).all()
    if len(board_running) >= max(1, settings.board_max_parallel or 1):
        return f"Waiting for a free slot on the board ({len(board_running)} of {settings.board_max_parallel} in use)"
    try:
        hit = await budget.blocked_detail(session, profile, settings, "person")
    except Exception:  # noqa: BLE001
        hit = None
    if hit:
        return hit["reason"]
    return None


async def tick() -> None:
    """Start what can start."""
    async with database.async_session() as session:
        try:
            await quota.release_expired(session)
        except Exception:  # noqa: BLE001
            logger.debug("quota release failed", exc_info=True)
        queued = (
            await session.exec(
                select(AiRun)
                .where(AiRun.state == "queued")
                .order_by(col(AiRun.queued_at).asc())
            )
        ).all()
        for run in queued:
            if run.id in RT.tasks:
                continue
            member, profile = await get_profile(session, run.member_id)
            if member is None or profile is None:
                run.state = "failed"
                run.ended_at = now_iso()
                run.ended_reason = "The team no longer exists."
                session.add(run)
                await session.commit()
                continue
            settings = await get_settings(session, run.project_id)
            reason = await _blocking_reason(session, run, profile, member, settings)
            if reason:
                if run.waiting_reason != reason:
                    run.waiting_reason = reason
                    RT.waiting[run.id] = reason
                    session.add(run)
                    await session.commit()
                    await board_events.publish_typed("ai.run", {"run": to_dict(run)})
                continue
            RT.waiting.pop(run.id, None)
            run.waiting_reason = None
            await _start(session, run)


async def _loop() -> None:
    while True:
        try:
            RT.wake.clear()
            await tick()
            if time.monotonic() - RT.last_health >= teams.HEALTH_INTERVAL_S:
                RT.last_health = time.monotonic()
                try:
                    await teams.health_check()
                except Exception:  # noqa: BLE001
                    logger.exception("The team health check failed")
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            logger.exception("The run scheduler failed on one pass")
        try:
            await asyncio.wait_for(RT.wake.wait(), timeout=2.0)
        except asyncio.TimeoutError:
            pass


async def start_scheduler() -> None:
    """Recover what the last start left, then start what waits. The API process in `process` mode starts the runner
    instead (it owns the CLIs)."""
    RT.db_ready = True
    if defers_to_runner():
        runner_link.ensure_started(RT.board_url)
        return
    await recover_on_startup()
    if RT.scheduler is None or RT.scheduler.done():
        RT.scheduler = asyncio.create_task(_loop())


async def stop_scheduler() -> None:
    """The board is closing: stop the scheduler and the CLIs; their runs are ended as board_closed."""
    if defers_to_runner():
        runner_link.stop()
        return
    if RT.scheduler is not None:
        RT.scheduler.cancel()
        try:
            await RT.scheduler
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            pass
        RT.scheduler = None
    for run_id in list(RT.procs):
        try:
            await cancel(
                run_id,
                by="board",
                reason="The board closed.",
                stop_code=BOARD_CLOSED,
                quiet=True,
            )
        except RunError:
            pass
    for task in list(RT.tasks.values()):
        task.cancel()
    RT.tasks.clear()
    RT.procs.clear()


async def recover_on_startup() -> None:
    """Runs that were starting or running when the board stopped go back to the queue with their conversation; a
    CLI of ours still alive is stopped."""
    async with database.async_session() as session:
        rows = (
            await session.exec(
                select(AiRun).where(col(AiRun.state).in_(["starting", "running"]))
            )
        ).all()
        for run in rows:
            if run.id in RT.tasks:
                continue
            if run.pid and cli.looks_like_cli(run.pid):
                cli.kill_tree(run.pid)
            run.state = "queued"
            run.token_hash = None
            run.pid = None
            run.paused = False
            run.instruction = "\n\n".join(
                t
                for t in (
                    run.instruction,
                    "The board restarted while you were working: continue from where you were.",
                )
                if t
            )
            session.add(run)
        await session.commit()


async def _start(session, run: AiRun) -> None:
    token = guard.new_token()
    run.state = "starting"
    run.started_at = run.started_at or now_iso()
    run.last_output_at = now_iso()
    run.token_hash = guard.token_hash(token)
    session.add(run)
    await session.commit()
    RT.waiting.pop(run.id, None)
    RT.tasks[run.id] = asyncio.create_task(_execute(run.id, token))
    await board_events.publish_typed("ai.run", {"run": to_dict(run)})


# ---------------------------------------------------------------------------
# Execution
# ---------------------------------------------------------------------------


async def _ctx_for(session, run: AiRun) -> RunContext:
    member, _ = await get_profile(session, run.member_id)
    return RunContext(
        run_id=run.id,
        member_id=run.member_id,
        member_name=member.name if member else "AI",
        project_id=run.project_id,
        ticket_id=run.ticket_id,
        on_behalf_of=run.started_by,
        mode=run.mode,
        trigger=run.trigger or "",
    )


async def _session_for(
    session, run: AiRun, config_dir: str | None
) -> tuple[str | None, str | None]:
    """The CLI session this run continues: its own, else the team's last one on this ticket. (session id, note)."""
    wanted = run.session_id
    closed: set[str] = set()
    if run.ticket_id:
        from . import session_history

        closed = await session_history.closed_session_ids(session, run.ticket_id)
    if wanted in closed:
        wanted = None
    if not wanted and run.ticket_id:
        prev = (
            await session.exec(
                select(AiRun)
                .where(
                    AiRun.ticket_id == run.ticket_id,
                    AiRun.member_id == run.member_id,
                    AiRun.id != run.id,
                    col(AiRun.session_id).is_not(None),
                    col(AiRun.started_at).is_not(None),
                )
                .order_by(col(AiRun.queued_at).desc())
                .limit(1)
            )
        ).first()
        wanted = prev.session_id if prev and prev.session_id not in closed else None
    if wanted and cli.session_exists(wanted, config_dir, "claude-code"):
        return wanted, None
    if wanted:
        return (
            None,
            "Earlier conversation not found on this computer: starting a new one",
        )
    return None, None


async def _execute(run_id: str, token: str, note: str | None = None) -> None:
    try:
        await _execute_cli(run_id, token, note)
    except Exception as exc:  # noqa: BLE001
        logger.exception("AI run %s crashed", run_id)
        await _end(run_id, "failed", f"The runner failed: {redact(str(exc))[:300]}")
    finally:
        RT.tasks.pop(run_id, None)
        RT.procs.pop(run_id, None)
        RT.cancelled.discard(run_id)
        RT.restart_requests.pop(run_id, None)


async def _execute_cli(run_id: str, token: str, note: str | None) -> None:
    async with database.async_session() as session:
        run = await session.get(AiRun, run_id)
        if run is None or run.state in ENDED:
            return
        member, profile = await get_profile(session, run.member_id)
        if member is None or profile is None:
            await _end(run_id, "failed", "The team no longer exists.")
            return
        ticket = await session.get(Ticket, run.ticket_id) if run.ticket_id else None
        cwd = profile.working_dir
        port: int | None = None
        if ticket is not None:
            try:
                row = await worktrees.ensure(session, ticket, profile.working_dir)
                if row is not None:
                    cwd = row.path
                    port = row.port
            except worktrees.WorktreeError as exc:
                await _end(
                    run_id,
                    "failed",
                    f"The worktree could not be made: {exc}",
                    stop_code="board_fault",
                )
                return
        if not cwd:
            await _end(run_id, "failed", "The team has no working folder.")
            return
        account = (
            await session.get(AiAccount, run.account_id or profile.account_id)
            if (run.account_id or profile.account_id)
            else None
        )
        config_dir = accounts.claude_config_dir(account) if account else None
        session_id, fresh_note = await _session_for(session, run, config_dir)
        resume = session_id is not None
        session_id = session_id or str(uuid.uuid4())
        run.session_id = session_id
        run.session_name = run.session_name or run.ticket_id or run.target
        session.add(run)
        await session.commit()
        await session.refresh(run)
        try:
            prepared = await launch.prepare(
                session,
                run,
                profile,
                member,
                token=token,
                board_url=_url(),
                cwd=cwd,
                session_id=session_id,
                resume=resume,
                note=note,
            )
        except RuntimeError as exc:
            await _end(run_id, "failed", str(exc), stop_code="runner_missing")
            return
        if port:
            # the ticket's worktree has a port of its own: the app the AI starts there listens on $PORT
            prepared.env["PORT"] = str(port)
    await transcripts.begin(
        run_id,
        project_id=run.project_id,
        member_id=run.member_id,
        system=prepared.system,
        prompt=prepared.prompt,
        args=prepared.record_args or None,
        resume=resume,
        session_id=session_id,
        note=fresh_note,
    )
    writer = RT.writers[run_id] = steps.StepWriter(run_id)
    writer.add(
        [
            {
                "kind": "start",
                "title": ("Resumed the conversation" if resume else "Started")
                + (f" · {fresh_note}" if fresh_note else ""),
            }
        ]
    )
    proc = cli.CliProcess(
        prepared.args,
        prepared.cwd,
        env=prepared.env,
        first_message=prepared.prompt if prepared.live else None,
    )
    try:
        pid = await proc.start()
    except OSError as exc:
        await writer.close()
        await _end(run_id, "failed", f"Could not start Claude Code: {exc}")
        return
    RT.procs[run_id] = proc
    if resume:
        guard.mark_resumed(run_id)
    resources.MON.track(run_id, proc, run.project_id)
    async with database.async_session() as session:
        cur = await session.get(AiRun, run_id)
        if cur is not None:
            cur.pid = pid
            cur.live = bool(prepared.live)
            session.add(cur)
            await session.commit()
    async with database.async_session() as session:
        known = {a["id"]: a["agent_type"] for a in await steps.agents(session, run_id)}
    parser = stream.Parser(prepared.cwd, known)
    quota_key = quota.key_for(profile, run)
    result: dict | None = None
    ready = False
    life = RunLife()
    lingered = False
    timed_out: str | None = None
    held_tokens: int | None = None
    window_tokens: int | None = None
    lines = proc.lines().__aiter__()
    pending: asyncio.Future | None = None
    while True:
        if pending is None:
            pending = asyncio.ensure_future(lines.__anext__())
        wait_s = WATCH_EVERY_S if ready else STARTING_TIMEOUT_S
        wait_s = life.wait_s(time.monotonic(), wait_s)
        done, _ = await asyncio.wait({pending}, timeout=wait_s)
        if not done:
            if run_id in RT.cancelled:
                pending.cancel()
                proc.kill()
                break
            if life.answered_at is not None and life.must_stop(time.monotonic()):
                lingered = True  # it answered but stays open (a dev server it started): stop it
                pending.cancel()
                proc.kill()
                break
            if ready:
                continue
            timed_out = "Claude Code did not start in time."
            pending.cancel()
            proc.kill()
            break
        finished, pending = pending, None
        try:
            line = finished.result()
        except StopAsyncIteration:
            break
        transcripts.feed(run_id, line)
        parsed = parser.parse(line)
        if parsed["rate_limit"]:
            try:
                await quota.record(quota_key, parsed["rate_limit"])
            except Exception:  # noqa: BLE001
                logger.debug("quota record failed", exc_info=True)
        held_tokens = parsed["context_used"] or held_tokens
        window_tokens = parsed["context_window"] or window_tokens
        fields: dict = {}
        if parsed["ready"] and not ready:
            ready = True
            fields["state"] = "running"
            if parsed["model"]:
                fields["model"] = parsed["model"]
        if parsed["session_id"] and parsed["session_id"] != session_id:
            fields["session_id"] = parsed["session_id"]
        for res in parsed["results"]:
            await _attach_result(writer, run_id, res)
        if parsed["messages_in"] or parsed["messages_out"]:
            await _record_messages(
                run_id, parsed["messages_in"], parsed["messages_out"]
            )
        if life.feed(parsed, time.monotonic()):
            result = parsed["result"]
            if proc.live:
                proc.end_input()
                fields["live"] = False
        if parsed["rows"] or parsed["agents"] or parsed["files"] or fields:
            if run_id in RT.cancelled:
                proc.kill()
                break
            writer.add(
                parsed["rows"],
                agents=parsed["agents"],
                files=parsed["files"],
                fields=fields,
            )
    if timed_out:
        proc.kill()
    code = await proc.wait()
    if lingered:
        code = 0
    await writer.close()
    await steps.close_roles(run_id)
    RT.writers.pop(run_id, None)
    await resources.MON.untrack(run_id)
    if run_id in RT.cancelled:
        return
    request = RT.restart_requests.pop(run_id, None)
    if request is not None:
        # the CLI was stopped on purpose (over the memory limit, or a person pressed Restart): the run goes on in a
        # new CLI that resumes the conversation, or ends when the system already restarted it too often
        await _restart_inside_run(run_id, token, request)
        return
    async with database.async_session() as session:
        run = await session.get(AiRun, run_id)
        if run is None or run.state in ENDED:
            return
        if held_tokens:
            run.context_used = held_tokens
            run.context_window = window_tokens or run.context_window
        if result:
            run.tokens_in += result["tokens_in"]
            run.tokens_out += result["tokens_out"]
            if result.get("tokens_cached") is not None:
                run.tokens_cached = (run.tokens_cached or 0) + result["tokens_cached"]
            run.cost_usd += result["cost_usd"]
            if result.get("structured"):
                run.report = json.dumps(result["structured"])
        run.exit_code = code
        session.add(run)
        await session.commit()
        question = loads(run.question, None) if run.question else None
    if timed_out:
        await _end(run_id, "failed", timed_out)
        return
    if question and not question.get("answered_at"):
        await _needs_input(run_id)
        return
    if result and not result["is_error"]:
        await _finish(run_id, result)
        return
    if result and result["is_error"]:
        reason = (
            result.get("text")
            or result.get("api_error")
            or "Claude Code reported an error."
        )
        if (
            result.get("api_error") == "usage_limit_reached"
            or result.get("api_status") == 429
        ):
            await _end(
                run_id,
                "failed",
                f"The account's usage limit is reached: {redact(reason)[:300]}",
                stop_code="rate_limited",
            )
        else:
            await _end(run_id, "failed", redact(reason)[:600])
        return
    tail = " · ".join(proc.stderr_tail[-3:])
    await _end(
        run_id,
        "failed",
        f"Claude Code exited with code {code}" + (f": {tail}" if tail else ""),
    )


async def _attach_result(writer: steps.StepWriter, run_id: str, res: dict) -> None:
    detail = {"exit_code": res["exit_code"], "is_error": res["is_error"]}
    if res.get("tests"):
        detail["tests"] = res["tests"]
    for row in writer.rows:
        if row.get("tool_id") == res["tool_id"]:
            row["output"] = res["output"]
            row["detail"] = {**(row.get("detail") or {}), **detail}
            return
    await steps.attach_result(run_id, res["tool_id"], res["output"], detail)


async def _record_messages(
    run_id: str, incoming: list[dict], outgoing: list[dict]
) -> None:
    async with database.async_session() as session:
        for m in incoming:
            session.add(
                AiRunMessage(
                    run_id=run_id,
                    direction="in",
                    peer=m["peer"][:200],
                    text=m["text"][:8000],
                    delivered_at=now_iso(),
                )
            )
        for m in outgoing:
            session.add(
                AiRunMessage(
                    run_id=run_id,
                    direction="out",
                    peer=m["peer"][:200],
                    text=m["text"][:8000],
                    delivered_at=now_iso(),
                )
            )
        await session.commit()
    for m in [*incoming, *outgoing]:
        await board_events.publish_typed(
            "ai.message", {"run_id": run_id, "peer": m["peer"], "text": m["text"][:500]}
        )


# ---------------------------------------------------------------------------
# Ending
# ---------------------------------------------------------------------------


def _usage_line(run: AiRun) -> str:
    tokens = (run.tokens_in or 0) + (run.tokens_out or 0)
    return (
        f"\n\n<sub>Run #{run.number} · {tokens:,} tokens · {run.model or 'default model'}</sub>"
        if tokens
        else ""
    )


async def _post_comment(
    ticket_id: str | None, author: str, text: str, meta: dict
) -> str | None:
    if not ticket_id:
        return None
    async with database.async_session() as session:
        ticket = await svc_tickets.add_comment(
            session, ticket_id, text, author=author, meta=meta
        )
        comments = loads(ticket.comments, []) if ticket else []
        return comments[-1].get("id") if comments else None


async def _chat_was_enough(run_id: str, report: dict, status: str) -> bool:
    """A run a person's chat message started, and the team says in its report that the chat answer is enough
    (`comment_needed: false`) and did answer with `ai_run reply` while it ran: its report stays on the run and the
    ticket gets no closing comment that only says "I replied in the chat". (Any status but `blocked`: a team often
    says `partial` after a chat answer because the ticket's own work is still open.) A report that does not say so, a run
    that did not answer in the chat, and any run that is not a chat message get the comment, so work never goes
    unreported. (Not used as a sign: the run's workspace files can be empty after real work; the open items repeat
    "a person moves the ticket to done" in every report.)"""
    if (
        status == "blocked"
        or report.get("comment_needed") is not False
        or report.get("branch")
    ):
        return False
    from models import AiChat, AiChatMessage

    async with database.async_session() as session:
        run = await session.get(AiRun, run_id)
        if run is None or run.trigger != "message" or not run.ticket_id:
            return False
        since = run.started_at or run.queued_at or ""
        answered = (
            await session.exec(
                select(AiChatMessage.id)
                .join(AiChat, AiChat.id == AiChatMessage.chat_id)
                .where(
                    AiChat.scope == "ticket",
                    AiChat.scope_id == run.ticket_id,
                    AiChatMessage.role == "ai",
                    AiChatMessage.member_id == run.member_id,
                    AiChatMessage.state == "done",
                    col(AiChatMessage.finished_at) >= since,
                )
                .limit(1)
            )
        ).first()
        return answered is not None


async def _finish(run_id: str, result: dict) -> None:
    async with database.async_session() as session:
        run = await session.get(AiRun, run_id)
        if run is None or run.state in ENDED:
            return
        member, _profile = await get_profile(session, run.member_id)
        name = member.name if member else "AI"
        report = result.get("structured") or {}
        summary = (
            report.get("summary") or result.get("text") or ""
        ).strip() or "Finished."
        status = report.get("status") or "done"
        settings = await get_settings(session, run.project_id)
        run.summary = summary[:8000]
        run.report = json.dumps(report or {"summary": summary})
        session.add(run)
        await session.commit()
        lessons_mode = settings.lessons_mode
        lessons_max = settings.lessons_max
        ticket_id = run.ticket_id
        number = run.number
    # lessons the lead proposes go to the project's memory: kept at once while the project has room for them
    # (`lessons_max`), else for a person to review
    from . import knowledge

    try:
        async with database.async_session() as session:
            room = lessons_max - len(
                await knowledge.lessons(session, run.project_id, "kept")
            )
    except Exception:  # noqa: BLE001 - a lesson is a bonus
        room = 0
    for text in (report.get("lessons") or [])[:5]:
        if isinstance(text, str) and text.strip():
            keep = lessons_mode == "auto" and room > 0
            try:
                async with database.async_session() as session:
                    await knowledge.add_lesson(
                        session,
                        run.project_id,
                        text.strip()[:300],
                        by=name,
                        state="kept" if keep else "proposed",
                        proposed_by=name,
                        source_ticket_id=ticket_id,
                        source_run_id=run_id,
                    )
                if keep:
                    room -= 1
            except Exception:  # noqa: BLE001 - a lesson is a bonus
                logger.debug("lesson not kept", exc_info=True)
    if status == "question" and (report.get("asks") or []):
        asks = [a for a in report["asks"] if isinstance(a, str) and a.strip()]
        async with database.async_session() as session:
            run = await session.get(AiRun, run_id)
            run.question = json.dumps(
                {
                    "text": asks[0][:1000],
                    "options": [],
                    "to": run.started_by,
                    "asked_at": now_iso(),
                    "more": asks[1:6],
                }
            )
            session.add(run)
            await session.commit()
        await _post_comment(
            ticket_id,
            name,
            f"**{name} asks:** {asks[0]}"
            + (
                "\n\n" + "\n".join(f"- {a}" for a in asks[1:6]) if len(asks) > 1 else ""
            ),
            {"kind": "question", "run_id": run_id, "run_number": number},
        )
        await _needs_input(run_id)
        return
    lines = [summary]
    if report.get("open_items"):
        lines.append("**Open:** " + "; ".join(str(x) for x in report["open_items"][:8]))
    skills_used = [str(x) for x in (report.get("skills") or []) if str(x).strip()][:12]
    if skills_used:
        lines.append("Skills: " + ", ".join(f"`{x}`" for x in skills_used))
    if report.get("branch"):
        lines.append(
            f"Branch: `{report['branch']}`"
            + (f" · PR {report['pr_url']}" if report.get("pr_url") else "")
        )
    async with database.async_session() as session:
        run = await session.get(AiRun, run_id)
        text = "\n\n".join(lines) + _usage_line(run)
    if await _chat_was_enough(run_id, report, status):
        # the answer is in the ticket chat (with its "Post as comment"): a closing comment would say it twice
        reply_id = None
    else:
        reply_id = await _post_comment(
            ticket_id,
            name,
            redact(text),
            {
                "kind": "summary",
                "run_id": run_id,
                "run_number": number,
                "member_id": run.member_id,
                "status": status,
            },
        )
    state = "finished"
    reason = None
    if status == "blocked":
        reason = (
            "Blocked: " + (report.get("open_items") or ["see the summary"])[0][:200]
        )
    await _end(run_id, state, reason, reply_comment_id=reply_id)


async def _needs_input(run_id: str) -> None:
    async with database.async_session() as session:
        run = await session.get(AiRun, run_id)
        if run is None or run.state in ENDED:
            return
        member, _ = await get_profile(session, run.member_id)
        q = loads(run.question, {}) or {}
        ticket = await session.get(Ticket, run.ticket_id) if run.ticket_id else None
        if (
            ticket is not None
            and not ticket.pending
            and ticket.status not in ("done", "wont_do")
        ):
            human = (
                await session.exec(
                    select(Member).where(
                        Member.project_id == run.project_id,
                        Member.kind == "human",
                        Member.name == run.started_by,
                    )
                )
            ).first()
            ctx = await _ctx_for(session, run)
            tokens = guard.enter(ctx)
            try:
                await svc_tickets.set_pending(
                    session,
                    ticket.id,
                    "person" if human else "party",
                    member_id=human.id if human else None,
                    party=None
                    if human
                    else (
                        run.started_by if run.started_by != "user" else "the board user"
                    ),
                    note=(
                        f"{member.name if member else 'AI'} asks: {q.get('text', '')}"
                    )[:240],
                )
            except ValueError:
                logger.warning(
                    "Could not set Pending on %s for run %s", ticket.id, run_id
                )
            finally:
                guard.leave(tokens)
        run = await session.get(AiRun, run_id)
        run.state = "needs_input"
        run.token_hash = None
        run.pid = None
        q["asked_at"] = q.get("asked_at") or now_iso()
        run.question = json.dumps(q)
        session.add(run)
        await session.commit()
    await steps.append(
        run_id,
        [
            {
                "kind": "question",
                "title": f"Asked {run.started_by}: {q.get('text', '')[:200]}",
            }
        ],
        fields={},
    )
    guard.forget_run(run_id)
    await _publish_run(run_id)
    try:
        from services import notifications as centre

        await centre.on_run_question(run_id)
    except Exception:  # noqa: BLE001
        logger.exception("The question notice of run %s failed", run_id)


async def _log_work(run: AiRun, state: str, reason: str | None) -> None:
    """Every ended work run leaves an entry in the ticket's work log."""
    if not run.ticket_id:
        return
    try:
        async with database.async_session() as session:
            member, profile = await get_profile(session, run.member_id)
            if member is None:
                return
            rows = await steps.all_rows(session, run.id)
            files = loads(run.files, [])
            report = loads(run.report, {})
            seconds = (
                int(
                    (
                        (parse_iso(run.ended_at) or datetime.now(UTC))
                        - (parse_iso(run.started_at) or datetime.now(UTC))
                    ).total_seconds()
                )
                if run.started_at
                else 0
            )
            lines = [
                f"**Run #{run.number}** {state} · {seconds // 60} min {seconds % 60} s · "
                f"{(run.tokens_in or 0) + (run.tokens_out or 0):,} tokens · {run.model or 'default model'} · "
                f"started by {run.started_by} ({run.trigger})"
            ]
            said = (report.get("summary") or run.summary or reason or "").strip()
            if said:
                lines += ["", "**Summary**", said[:1800]]
            if files:
                lines += ["", "**Files changed**"] + [
                    f"- `{f.get('path')}` (+{f.get('added', 0)} −{f.get('removed', 0)})"
                    for f in files[:15]
                ]
            commands = [s.title for s in rows if s.kind == "command"][:10]
            if commands:
                lines += ["", "**Commands**"] + [f"- {c}" for c in commands]
            agents = [s.title for s in rows if s.kind == "subagent"][:8]
            if agents:
                lines += ["", "**Roles used**"] + [f"- {a}" for a in agents]
            board = list(dict.fromkeys(s.title for s in rows if s.kind == "board"))[:12]
            if board:
                lines += ["", "**Board actions**"] + [f"- {b}" for b in board]
            tests = report.get("tests")
            if isinstance(tests, dict):
                lines += [
                    "",
                    f"**Tests (as reported)**: {tests.get('passed', 0)} passed, {tests.get('failed', 0)} failed",
                ]
            if state != "finished" and reason:
                lines += ["", f"**Why it stopped**: {reason[:300]}"]
            kind = (
                "blocked"
                if state != "finished"
                else ("fix_attempt" if files else "investigation")
            )
            await svc_tickets.add_work_log(
                session,
                run.ticket_id,
                author=member.name,
                role="Developer",
                note="\n".join(lines),
                kind=kind,
            )
    except Exception:  # noqa: BLE001
        logger.exception("Could not write the work log of run %s", run.id)


async def _end(
    run_id: str,
    state: str,
    reason: str | None,
    *,
    by: str | None = None,
    quiet: bool = False,
    **fields,
) -> AiRun | None:
    """Move a run to an ended state (once): kills its token, closes the transcript, logs, tells people."""
    async with database.async_session() as session:
        run = await session.get(AiRun, run_id)
        if run is None or run.state in ENDED:
            return run
        run.state = state
        run.ended_at = now_iso()
        run.ended_reason = reason
        run.ended_by = by
        run.token_hash = None
        run.pid = None
        run.paused = False
        run.live = False
        run.waiting_reason = None
        for key, value in fields.items():
            setattr(run, key, value)
        session.add(run)
        await session.commit()
        await session.refresh(run)
        member, _profile = await get_profile(session, run.member_id)
    writer = RT.writers.pop(run_id, None)
    if writer is not None:
        await writer.close()
    try:
        if reason:
            transcripts.note(run_id, "end", f"{state}: {reason}")
        await transcripts.finish(run_id)
    except Exception:  # noqa: BLE001
        logger.exception("Could not finish the transcript of run %s", run_id)
    await steps.append(
        run_id,
        [
            {
                "kind": "end",
                "title": f"{state.capitalize()}"
                + (f": {reason}" if reason else "")[:240],
            }
        ],
        fields={"state": state},
    )
    guard.forget_run(run_id)
    await audit.record(
        run.project_id,
        f"run_{state}",
        "info",
        member_id=run.member_id,
        member_name=member.name if member else "",
        on_behalf_of=run.started_by,
        run_id=run.id,
        target=run.ticket_id,
        detail={"reason": reason, "by": by},
    )
    if not quiet:
        if state == "failed" and member and run.ticket_id:
            await _post_comment(
                run.ticket_id,
                member.name,
                f"Run #{run.number} failed: {reason or 'no reason given'}. Partial work is kept; Retry starts a new run."
                + _usage_line(run),
                {
                    "kind": "failed",
                    "run_id": run.id,
                    "run_number": run.number,
                    "member_id": run.member_id,
                },
            )
        if run.mode == "work" and state in ("finished", "failed"):
            await _log_work(run, state, reason)
        try:
            from services import notifications as centre

            await centre.on_run_ended(run.id)
        except Exception:  # noqa: BLE001
            logger.exception("The end notice of run %s failed", run_id)
        if run.ticket_id:
            try:
                await worktrees.tidy_after_run(run.ticket_id, run.id)
            except Exception:  # noqa: BLE001
                logger.debug("tidy after run failed", exc_info=True)
    if run.ticket_id:
        # a Review hand-over (push, pull request) that waited for this run to stop goes now
        worktrees.after_run(run.ticket_id)
        try:
            from . import compact

            compact.after_run(run.ticket_id, run.id)
        except Exception:  # noqa: BLE001 - a compaction asked for in the chat is a convenience
            logger.debug("compact after run failed", exc_info=True)
    RT.wake.set()
    await _publish_run(run_id)
    return run


# ---------------------------------------------------------------------------
# Actions
# ---------------------------------------------------------------------------


async def cancel(
    run_id: str,
    *,
    by: str,
    reason: str | None = None,
    stop_code: str | None = None,
    quiet: bool = False,
) -> AiRun:
    """Stop a run from any active state; files stay as they are."""
    async with database.async_session() as session:
        run = await session.get(AiRun, run_id)
        if run is None:
            raise RunError("Run not found.")
        if run.state in ENDED:
            raise RunError(f"Run #{run.number} already ended ({run.state}).")
        was = run.state
        ticket_id = run.ticket_id
    if defers_to_runner() and was != "queued":
        await runner_link.command(
            run_id, "cancel", {"by": by, "reason": reason, "stop_code": stop_code}
        )
        async with database.async_session() as session:
            return await session.get(AiRun, run_id)
    RT.cancelled.add(run_id)
    proc = RT.procs.get(run_id)
    if proc:
        proc.kill()
    task = RT.tasks.get(run_id)
    ended = await _end(
        run_id,
        "cancelled",
        reason or f"Cancelled by {by}",
        by=by,
        stop_code=stop_code,
        quiet=quiet,
    )
    if task and not task.done() and task is not asyncio.current_task():
        try:
            await asyncio.wait_for(asyncio.shield(task), timeout=10)
        except (asyncio.TimeoutError, asyncio.CancelledError, Exception):  # noqa: BLE001
            pass
    if was == "needs_input" and ticket_id:
        async with database.async_session() as session:
            t = await session.get(Ticket, ticket_id)
            if t and t.pending and (t.pending_note or "").find(" asks: ") > 0:
                await svc_tickets.clear_pending(
                    session, t.id, reason="AI run cancelled"
                )
    RT.cancelled.discard(run_id)
    return ended


async def cancel_for_ticket(
    ticket_id: str, *, by: str, reason: str, stop_code: str | None = None
) -> int:
    """Stop every active run on a ticket; returns how many."""
    n = 0
    async with database.async_session() as session:
        rows = await active_runs(session, ticket_id=ticket_id)
    for r in rows:
        try:
            await cancel(r.id, by=by, reason=reason, stop_code=stop_code)
            n += 1
        except RunError:
            pass
    return n


RESTART_NOTE = (
    "Your process was restarted ({why}). The conversation and every file are as you left them. Look at "
    "`git status` and the last steps, then carry on with the task from where you stopped; do not start over."
)


async def _memory_breach(run_id: str, rss_mb: float, limit_mb: int) -> None:
    """The monitor saw a run's CLI pass the memory limit: stop it; the run goes on in a new CLI (or ends)."""
    proc = RT.procs.get(run_id)
    if proc is None:
        return
    RT.restart_requests[run_id] = {
        "by": "system",
        "rss_mb": rss_mb,
        "limit_mb": limit_mb,
    }
    proc.kill()


resources.MON.on_breach = _memory_breach


async def restart_run(run_id: str, *, by: str) -> AiRun:
    """Start a running run's CLI again inside the same run (it resumes its conversation); memory is released.

    Raises:
        RunError: The run is not running a CLI.
    """
    async with database.async_session() as session:
        run = await session.get(AiRun, run_id)
    if run is None:
        raise RunError("Run not found.")
    if run.state != "running":
        raise RunError("Only a running run can be restarted.")
    if defers_to_runner():
        await runner_link.command(run_id, "restart", {"by": by})
        return run
    proc = RT.procs.get(run_id)
    if proc is None or proc.proc is None:
        raise RunError("Only a running run can be restarted.")
    reading = resources.MON.readings.get(run_id) or {}
    RT.restart_requests[run_id] = {
        "by": by,
        "rss_mb": reading.get("cli_rss_mb"),
        "limit_mb": await resources.MON.limit_mb(run.project_id),
    }
    proc.kill()
    return run


async def _tell_memory(
    kind: str, run: AiRun, title: str, body: str, data: dict
) -> None:
    """The board's notice of a restart or a stop for memory (one row per run; restarts merge: "restarted 2 times")."""
    from services import notifications as centre

    try:
        async with database.async_session() as session:
            await centre.emit(
                kind,
                project_id=run.project_id,
                recipients=await centre.owners_and_admins(session, run.project_id),
                title=title,
                body=body,
                target_kind="run",
                target_id=run.id,
                ticket_id=run.ticket_id,
                member_id=run.member_id,
                data=data,
                session=session,
            )
    except Exception:  # noqa: BLE001 - the notice never stops the run
        logger.exception(
            "Could not tell anyone that run %s used too much memory", run.id
        )


async def _restart_inside_run(run_id: str, token: str, request: dict) -> None:
    """The CLI was stopped on purpose: log it and start a new CLI in the same run. After `AUTO_RESTARTS` restarts by
    the system, the next breach ends the run instead (stop code `memory`)."""
    by = request["by"]
    rss, limit = request.get("rss_mb"), request.get("limit_mb")
    async with database.async_session() as session:
        run = await session.get(AiRun, run_id)
        if run is None or run.state in ENDED:
            return
        log = resources.restarts_of(run)
        by_system = sum(1 for r in log if r.get("by") == "system")
        if by == "system" and by_system >= resources.AUTO_RESTARTS:
            stop_run = run
        else:
            stop_run = None
            entry = {
                "at": now_iso(),
                "rss_mb": rss,
                "limit_mb": limit,
                "by": by,
                "n": len(log) + 1,
            }
            run.restarts = resources.dump(log + [entry])
            session.add(run)
            await session.commit()
            await session.refresh(run)
    ticket = run.ticket_id or "A run"
    if stop_run is not None:
        gb = f"{rss / 1024:.2f} GB" if rss else "too much memory"
        lim = f"{limit / 1024:.1f} GB" if limit else "the limit"
        await audit.record(
            run.project_id,
            "run_stopped_memory",
            "info",
            member_name="System",
            member_id=run.member_id,
            run_id=run_id,
            target=run.ticket_id,
            detail={"rss_mb": rss, "limit_mb": limit, "restarts": len(log)},
        )
        await _tell_memory(
            "run_stopped_memory",
            run,
            f"{ticket}: stopped, out of memory",
            f"The CLI went over {lim} again after {resources.AUTO_RESTARTS} restarts. Partial work is kept; retry it or raise the limit.",
            {"rss_mb": rss, "limit_mb": limit, "ticket_id": run.ticket_id},
        )
        await _end(
            run_id,
            "failed",
            f"Stopped automatically: the CLI went over the memory limit ({gb} of {lim}) again after "
            f"{resources.AUTO_RESTARTS} restarts. Partial work in the folder is kept.",
            stop_code="memory",
        )
        return
    await audit.record(
        run.project_id,
        "run_restarted",
        "info",
        member_name="System" if by == "system" else by,
        member_id=run.member_id,
        run_id=run_id,
        target=run.ticket_id,
        detail=entry,
    )
    if by == "system":
        gb = f"{rss / 1024:.2f} GB" if rss else "too much memory"
        lim = f"{limit / 1024:.1f} GB" if limit else "the limit"
        text = (
            f"Restarted automatically: the CLI reached {gb}, over the {lim} limit "
            f"(restart {by_system + 1} of {resources.AUTO_RESTARTS})"
        )
        why = f"it used {gb} of memory, over the {lim} limit"
        await _tell_memory(
            "run_restarted",
            run,
            f"{ticket}: restarted (memory)",
            f"The CLI reached {gb}, over the {lim} limit, and started again in the same run.",
            {"rss_mb": rss, "limit_mb": limit, "ticket_id": run.ticket_id},
        )
    else:
        text = f"Restarted by {by}"
        why = f"{by} restarted it"
    await steps.append(run_id, [{"kind": "start", "title": text}])
    transcripts.note(run_id, "restart", text)
    await _publish_run(run_id)
    await _execute_cli(run_id, token, RESTART_NOTE.format(why=why))


async def answer(run_id: str, *, by: str, text: str) -> AiRun:
    """Answer the lead's question: the answer is a comment on the ticket and the run resumes its conversation."""
    text = (text or "").strip()
    if not text:
        raise RunError("Write an answer first.")
    if defers_to_runner():
        async with database.async_session() as session:
            run = await session.get(AiRun, run_id)
            if run is None:
                raise RunError("Run not found.")
            if run.state != "needs_input":
                raise RunError("This run is not waiting for an answer.")
        await runner_link.command(run_id, "answer", {"by": by, "text": text})
        async with database.async_session() as session:
            return await session.get(AiRun, run_id)
    async with database.async_session() as session:
        run = await session.get(AiRun, run_id)
        if run is None:
            raise RunError("Run not found.")
        if run.state != "needs_input":
            raise RunError("This run is not waiting for an answer.")
        q = loads(run.question, {}) or {}
        if run.ticket_id:
            await svc_tickets.add_comment(
                session,
                run.ticket_id,
                f"**Answer:** {text}",
                author=by,
                meta={"answer_to_run": run.id},
            )
            ticket = await session.get(Ticket, run.ticket_id)
            if ticket and ticket.pending:
                await svc_tickets.clear_pending(
                    session, ticket.id, reason="Answered the AI's question"
                )
        run = await session.get(AiRun, run_id)
        q["answered_at"] = now_iso()
        q["answered_by"] = by
        run.question = json.dumps(q)
        run.answer = text
        token = guard.new_token()
        run.state = "starting"
        run.token_hash = guard.token_hash(token)
        session.add(run)
        await session.commit()
        await session.refresh(run)
    note = f"{by} answered your question “{q.get('text', '')}”:\n{text}\n\nContinue the work with this answer and finish as instructed."
    RT.tasks[run_id] = asyncio.create_task(_execute(run_id, token, note))
    await _publish_run(run_id)
    return run


async def retry(run_id: str, *, by: str) -> AiRun:
    """A new run on the same ticket and team, continuing the conversation."""
    async with database.async_session() as session:
        run = await session.get(AiRun, run_id)
        if run is None:
            raise RunError("Run not found.")
        if run.state not in ENDED:
            raise RunError("The run is still going.")
        return await create_run(
            session,
            ticket_id=run.ticket_id,
            member_id=run.member_id,
            mode=run.mode,
            trigger="retry",
            started_by=by,
            instruction="Continue the work: the earlier run ended before it was done."
            if not run.instruction
            else run.instruction,
            resume_session=run.session_id,
            kind=run.kind,
            target=run.target,
        )


async def send_message(
    run_id: str, text: str, *, by: str, peer: str | None = None
) -> dict:
    """A note to a run: into the running lead's input when it is live; else kept for its next turn (a run that ended
    gets a new run on the same conversation)."""
    text = (text or "").strip()
    if not text:
        raise RunError("Write a message first.")
    if defers_to_runner():
        async with database.async_session() as session:
            run = await session.get(AiRun, run_id)
            if run is None:
                raise RunError("Run not found.")
            state = run.state
        if state in ("starting", "running", "needs_input"):
            await runner_link.command(
                run_id, "message", {"by": by, "text": text, "peer": peer}
            )
            return {"delivered": "runner", "run_id": run_id}
    async with database.async_session() as session:
        run = await session.get(AiRun, run_id)
        if run is None:
            raise RunError("Run not found.")
        row = AiRunMessage(
            run_id=run_id, direction="in", peer=(peer or by)[:200], text=text[:8000]
        )
        session.add(row)
        await session.commit()
        await session.refresh(row)
        state, ticket_id, member_id, session_id = (
            run.state,
            run.ticket_id,
            run.member_id,
            run.session_id,
        )
    proc = RT.procs.get(run_id)
    if (
        proc is not None
        and proc.live
        and proc.input_open
        and state in ("starting", "running")
    ):
        if await proc.send(f"{peer or by} says:\n{text}"):
            async with database.async_session() as session:
                row = await session.get(AiRunMessage, row.id)
                row.delivered_at = now_iso()
                session.add(row)
                await session.commit()
            await steps.append(
                run_id,
                [
                    {
                        "kind": "message",
                        "title": f"From {peer or by}: {text[:140]}",
                        "detail": {"direction": "in", "peer": peer or by},
                    }
                ],
            )
            return {"delivered": "live", "run_id": run_id}
    if state in ENDED:
        async with database.async_session() as session:
            new = await create_run(
                session,
                ticket_id=ticket_id,
                member_id=member_id,
                trigger="message",
                started_by=by,
                instruction=f"{peer or by} says:\n{text}",
                resume_session=session_id,
            )
        return {"delivered": "new_run", "run_id": new.id}
    if state == "needs_input":
        await answer(run_id, by=by, text=text)
        return {"delivered": "answer", "run_id": run_id}
    return {"delivered": "queued", "run_id": run_id}


async def pending_messages(run_id: str) -> list[AiRunMessage]:
    """The messages a run has not been given yet."""
    async with database.async_session() as session:
        return list(
            (
                await session.exec(
                    select(AiRunMessage).where(
                        AiRunMessage.run_id == run_id,
                        AiRunMessage.direction == "in",
                        col(AiRunMessage.delivered_at).is_(None),
                    )
                )
            ).all()
        )


# ---------------------------------------------------------------------------
# What the board's tools and the ticket flow call
# ---------------------------------------------------------------------------


def question_options(options: list | None) -> tuple[list[str], list[dict]]:
    """The labels and details of a question\'s options."""
    labels: list[str] = []
    details: list[dict] = []
    for o in options or []:
        if isinstance(o, dict):
            label = str(o.get("label") or o.get("text") or "").strip()[:200]
            description = str(o.get("description") or "").strip()[:300]
            recommended = bool(o.get("recommended"))
        else:
            label, description, recommended = str(o).strip()[:200], "", False
        if label:
            labels.append(label)
            details.append(
                {"label": label, "description": description, "recommended": recommended}
            )
    return labels[:6], details[:6]


async def record_question(ctx: RunContext, text: str, options: list | None) -> dict:
    """The lead asks a person (ai_run ask): the run parks in Needs input when its process stops."""
    text = (text or "").strip()
    if not text:
        raise ValueError("ai_run(action='ask') needs `question`.")
    labels, details = question_options(options)
    q = {
        "text": text[:1000],
        "options": labels,
        "option_details": details,
        "to": ctx.on_behalf_of,
        "asked_at": now_iso(),
    }
    async with database.async_session() as session:
        run = await session.get(AiRun, ctx.run_id)
        if run is None:
            raise ValueError("Run not found.")
        run.question = json.dumps(q)
        session.add(run)
        await session.commit()
    await audit.record(
        ctx.project_id,
        "ask_person",
        "info",
        member_id=ctx.member_id,
        member_name=ctx.member_name,
        on_behalf_of=ctx.on_behalf_of,
        run_id=ctx.run_id,
        target=ctx.ticket_id,
        detail={"question": q["text"]},
    )
    return {
        "posted": True,
        "to": ctx.on_behalf_of,
        "next": "Stop now and end your turn. The board resumes this run with the answer.",
    }


async def record_report(ctx: RunContext, report: dict) -> dict:
    """An explicit report through the tool (the final JSON report is the usual way)."""
    async with database.async_session() as session:
        run = await session.get(AiRun, ctx.run_id)
        if run is None:
            raise ValueError("Run not found.")
        run.report = json.dumps(report or {})
        if report.get("summary"):
            run.summary = str(report["summary"])[:8000]
        session.add(run)
        await session.commit()
    return {"recorded": True}


async def before_ticket_change(
    ticket_id: str,
    *,
    status=_UNSET,
    assignee=_UNSET,
    deleting: bool = False,
    by: str | None = None,
) -> None:
    """A person changes a ticket an AI may be working on: a deletion ends its runs; a reassignment away from the
    team ends them too."""
    if deleting:
        await cancel_for_ticket(
            ticket_id,
            by=by or "board",
            reason="The ticket was deleted.",
            stop_code="deleted",
        )
        return
    if assignee is not _UNSET:
        async with database.async_session() as session:
            rows = [
                r
                for r in await active_runs(session, ticket_id=ticket_id)
                if r.member_id != assignee
            ]
        for r in rows:
            try:
                await cancel(
                    r.id,
                    by=by or "board",
                    reason="The ticket was reassigned.",
                    stop_code="reassigned",
                )
            except RunError:
                pass


async def note_person_edit(
    ticket_id: str, *, by: str | None = None, what: str = ""
) -> None:
    """A person edited the ticket while a lead works on it: the lead hears it on its live input."""
    async with database.async_session() as session:
        rows = [
            r
            for r in await active_runs(session, ticket_id=ticket_id)
            if r.state in ("starting", "running")
        ]
    for r in rows:
        proc = RT.procs.get(r.id)
        if proc is not None and proc.live and proc.input_open:
            await proc.send(
                f"{by or 'A person'} edited {what or 'the ticket'}: read it again before you go on."
            )


async def wake_new_assignee(
    ticket_id: str,
    assignee_id: str | None,
    *,
    by: str | None = None,
    instruction: str = "",
) -> AiRun | None:
    """A ticket was given to a team: its lead starts (or hears about it when already on the ticket)."""
    if not assignee_id:
        return None
    async with database.async_session() as session:
        member = await session.get(Member, assignee_id)
        profile = await session.get(AiTeam, assignee_id)
        ticket = await session.get(Ticket, ticket_id)
        if member is None or profile is None or member.kind != "ai" or ticket is None:
            return None
        if ticket.status in ("done", "wont_do"):
            return None
        active = await active_runs(session, ticket_id=ticket_id, member_id=assignee_id)
        if active:
            live = [r for r in active if r.state in ("starting", "running")]
            if live and instruction:
                await send_message(live[0].id, instruction, by=by or "board")
            return active[0]
        try:
            return await create_run(
                session,
                ticket_id=ticket_id,
                member_id=assignee_id,
                trigger="assign",
                started_by=by or "user",
                instruction=instruction or "",
            )
        except RunError as exc:
            await session.rollback()
            logger.info(
                "Assigning %s to %s started nothing: %s", ticket_id, member.name, exc
            )
            return None


async def start_on_ticket(
    session,
    ticket_id: str,
    *,
    member_id: str | None,
    by: str,
    instruction: str = "",
    mode: str = "work",
) -> AiRun:
    """Run on a ticket from the board: the assigned team, else the one given, else the project's only team."""
    ticket = await session.get(Ticket, ticket_id)
    if ticket is None:
        raise RunError("Ticket not found.")
    team_id = member_id
    if not team_id and ticket.assignee:
        m = await session.get(Member, ticket.assignee)
        if m is not None and m.kind == "ai":
            team_id = m.id
    if not team_id:
        rows = (
            await session.exec(
                select(Member).where(
                    Member.project_id == ticket.project_id, Member.kind == "ai"
                )
            )
        ).all()
        if len(rows) == 1:
            team_id = rows[0].id
        else:
            raise RunError(
                "Pick a team: the ticket has no AI assignee"
                + (
                    " and the project has several teams."
                    if rows
                    else " and the project has no team yet."
                )
            )
    if ticket.assignee != team_id and mode == "work":
        await svc_tickets.update_ticket(
            session, ticket_id, TicketUpdate(assignee=team_id)
        )
    active = [
        r
        for r in await active_runs(session, ticket_id=ticket_id)
        if r.state in ("starting", "running", "needs_input")
    ]
    if active and active[0].member_id == team_id:
        # the team is already on it: a note reaches its lead; nothing to say means nothing to start
        if instruction:
            out = await send_message(active[0].id, instruction, by=by)
            async with database.async_session() as s2:
                return await s2.get(AiRun, out["run_id"])
        return active[0]
    return await create_run(
        session,
        ticket_id=ticket_id,
        member_id=team_id,
        mode=mode,
        trigger="run_button",
        started_by=by,
        instruction=instruction,
    )


async def deliver_to_ticket(ticket_id: str, text: str, *, by: str) -> dict:
    """The one primitive of AI-to-AI and person-to-AI contact: a note to the ticket's team. Live when its lead runs,
    else a new turn on its conversation; a ticket with no team gets the note as a comment."""
    async with database.async_session() as session:
        ticket = await session.get(Ticket, ticket_id)
        if ticket is None:
            raise RunError("Ticket not found.")
        active = [r for r in await active_runs(session, ticket_id=ticket_id)]
        if active:
            return await send_message(active[0].id, text, by=by)
        last = (
            await session.exec(
                select(AiRun)
                .where(AiRun.ticket_id == ticket_id)
                .order_by(col(AiRun.queued_at).desc())
                .limit(1)
            )
        ).first()
        team_id = None
        if ticket.assignee:
            m = await session.get(Member, ticket.assignee)
            team_id = m.id if (m is not None and m.kind == "ai") else None
        team_id = team_id or (last.member_id if last else None)
        if team_id is None:
            await svc_tickets.add_comment(
                session, ticket_id, text, author=by, meta={"kind": "message"}
            )
            return {"delivered": "comment", "run_id": None}
        run = await create_run(
            session,
            ticket_id=ticket_id,
            member_id=team_id,
            trigger="message",
            started_by=by,
            instruction=f"{by} says:\n{text}",
            resume_session=last.session_id
            if last and last.member_id == team_id
            else None,
        )
        return {"delivered": "new_run", "run_id": run.id}
