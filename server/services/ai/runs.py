"""Run lifecycle of AI work on tickets (design/components/ai-ticket-work.md, D).

queued → starting → running → finished, with running ⇄ needs_input, and failed / cancelled / timed_out as the other
ends. Retry or "Run again" never reopens an ended run: it creates run #n+1 in queued. One work run holds a ticket at a
time (a unique index enforces it, even under concurrent requests); ask runs never take the hold.

A background scheduler starts queued runs when the member has a free slot, is not paused, has budget and runs left
for the day, and the project's kill switch is off.
"""

import asyncio
import json
import logging
import os
import re
import secrets as pysecrets
import shutil
import tempfile
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

from sqlalchemy.exc import IntegrityError
from sqlmodel import col, select

import database
import events as board_events
import services.activity as svc_activity
import services.tickets as svc_tickets
from models import (
    AiAudit,
    AiMember,
    AiProjectSettings,
    AiRun,
    Member,
    Project,
    Ticket,
    TicketUpdate,
)

from . import (
    approvals,
    audit,
    autopilot,
    budget,
    cli,
    config_service,
    guard,
    safety,
)
from .mcp_sources import folder_servers
from .context import (
    STATUS_LABELS,
    RunContext,
    activity_block,
    delta_block,
    digest,
    instruction_block,
    rules_block,
    snapshot,
    ticket_block,
)
from .mentions import BOARD_AUTHOR
from .permissions import ceiling_rank, check_status_move, status_rank
from .providers import PROVIDERS, kv_dict, merged_config
from .secrets import redact
from .store import (
    active_runs,
    ai_names,
    get_profile,
    get_settings,
    loads,
    now_iso,
    parse_iso,
)

logger = logging.getLogger("kanban.ai")

ACTIVE = ("queued", "starting", "running", "needs_input")
ENDED = ("finished", "failed", "cancelled", "timed_out")
MAX_QUEUED_PER_AGENT = 10
NEEDS_INPUT_HOLD_HOURS = 24
# Minutes after the question when a reminder is due: 15 min, then every 2 h; from 6 h the project's admins too
REMINDER_MINUTES = [15, *range(120, NEEDS_INPUT_HOLD_HOURS * 60, 120)]
REMINDER_LEAD_MINUTES = 360
AUTO_TRIP_CHECK_S = 30  # spend spike and denials (autotrip.py)
STARTING_TIMEOUT_S = 30
MAX_RATE_REQUEUES = 3  # times one run waits out a rate limit before it fails


class RunError(ValueError):
    """A run request was refused; the message says why."""


class RunConflict(RunError):
    """The ticket is already held by another work run."""


class _Runtime:
    """Process-wide state of the runner: live processes, tasks and the scheduler."""

    def __init__(self) -> None:
        """Nothing runs until `start_scheduler()`."""
        self.procs: dict[str, cli.CliProcess] = {}
        self.tasks: dict[str, asyncio.Task] = {}
        self.cancelled: set[str] = set()
        self.waiting: dict[str, str] = {}
        # run id -> how often an Antigravity run was told its action was refused and went on
        self.refusal_retries: dict[str, int] = {}
        # run id -> {approval_id, summary, since} while a tool call waits for a person's decision
        self.waiting_approval: dict[str, dict] = {}
        self.wake = asyncio.Event()
        self.scheduler: asyncio.Task | None = None
        self.board_url: str = os.environ.get("KANBAN_BOARD_URL", "").rstrip("/")
        self.last_publish = 0.0
        self.tick_lock = asyncio.Lock()


RT = _Runtime()


def set_board_url(url: str) -> None:
    """Where a CLI run reaches the board's MCP server (learned from incoming requests)."""
    if not os.environ.get("KANBAN_BOARD_URL"):
        RT.board_url = url.rstrip("/")


async def _publish(force: bool = False) -> None:
    loop = asyncio.get_running_loop()
    if force or loop.time() - RT.last_publish > 1.0:
        RT.last_publish = loop.time()
        await board_events.publish(board_events.INVALIDATE)


# ---------------------------------------------------------------------------
# Serialisation
# ---------------------------------------------------------------------------


def to_dict(run: AiRun, member_name: str | None = None) -> dict:
    """A run for the API (never its token)."""
    started = parse_iso(run.started_at)
    ended = parse_iso(run.ended_at)
    elapsed = None
    if started:
        elapsed = int(((ended or datetime.now(UTC)) - started).total_seconds())
    return {
        "id": run.id,
        "project_id": run.project_id,
        "ticket_id": run.ticket_id,
        "member_id": run.member_id,
        "member_name": member_name,
        "waiting_approval": RT.waiting_approval.get(run.id),
        "number": run.number,
        "mode": run.mode,
        "trigger": run.trigger,
        "state": run.state,
        "started_by": run.started_by,
        "instruction": run.instruction,
        "source_comment_id": run.source_comment_id,
        "reply_comment_id": run.reply_comment_id,
        "chain": loads(run.chain, []),
        "queued_at": run.queued_at,
        "started_at": run.started_at,
        "ended_at": run.ended_at,
        "last_output_at": run.last_output_at,
        "elapsed_s": elapsed,
        "ended_reason": run.ended_reason,
        "ended_by": run.ended_by,
        "exit_code": run.exit_code,
        "summary": run.summary,
        "report": loads(run.report, {}),
        "question": loads(run.question, None),
        "answer": run.answer,
        "session_id": run.session_id,
        "steps": loads(run.steps, []),
        "files": loads(run.files, []),
        "tokens_in": run.tokens_in,
        "context_used": run.context_used,
        "context_window": run.context_window,
        "tokens_out": run.tokens_out,
        "tokens_cached": run.tokens_cached,
        "cost_usd": run.cost_usd,
        "metered": run.metered,
        "status_before": run.status_before,
        "status_changes": loads(run.status_changes, []),
        "model": run.model,
        "waiting_reason": RT.waiting.get(run.id) if run.state == "queued" else None,
        "paused": bool(run.paused and run.state == "running"),
        "paused_at": run.paused_at,
        "behind_run_id": run.behind_run_id,
        "queue_after_current": run.queue_after_current,
        "limit_min": run.limit_min,
        "replaces_comment_id": run.replaces_comment_id,
        "feedback": loads(run.feedback, None),
        "stop_code": run.stop_code,
        "blocked_move": run.blocked_move,
        "context_notes": loads(run.context_notes, []),
        "tests": observed_tests(loads(run.steps, [])),
    }


def observed_tests(steps: list[dict]) -> dict | None:
    """What the board itself saw a test command report (the last one), as {passed, failed, command}: unlike the
    agent's own report, this is read from the command output."""
    for step in reversed(steps):
        if step.get("tests"):
            return {**step["tests"], "command": step.get("text", "")[4:]}
    return None


async def _names(session, member_ids) -> dict[str, str]:
    ids = list({m for m in member_ids if m})
    if not ids:
        return {}
    rows = await session.exec(select(Member).where(col(Member.id).in_(ids)))
    return {m.id: m.name for m in rows.all()}


async def step_estimates(session, runs: list[AiRun]) -> dict[str, int]:
    """For each member with an active work run, how many steps its recent finished work runs took (the median of
    up to ten), so the panel can say "step 9 of ~14". Missing when the member has fewer than two finished runs."""
    members = {r.member_id for r in runs if r.mode == "work" and r.state in ACTIVE}
    out: dict[str, int] = {}
    for member_id in members:
        done = (
            await session.exec(
                select(AiRun)
                .where(
                    AiRun.member_id == member_id,
                    AiRun.mode == "work",
                    AiRun.state == "finished",
                )
                .order_by(col(AiRun.queued_at).desc())
                .limit(10)
            )
        ).all()
        counts = sorted(n for n in (len(loads(d.steps, [])) for d in done) if n > 0)
        if len(counts) >= 2:
            out[member_id] = counts[len(counts) // 2]
    return out


async def queue_info(session, runs: list[AiRun]) -> dict[str, dict]:
    """For queued runs: the position in the member's queue and the ticket they wait behind (the member's running
    ticket, or the holder of the ticket for a second AI)."""
    out: dict[str, dict] = {}
    queued = [r for r in runs if r.state == "queued"]
    for member_id in {r.member_id for r in queued}:
        mine = (
            await session.exec(
                select(AiRun)
                .where(AiRun.member_id == member_id, AiRun.state == "queued")
                .order_by(col(AiRun.queued_at))
            )
        ).all()
        running = (
            await session.exec(
                select(AiRun)
                .where(
                    AiRun.member_id == member_id,
                    col(AiRun.state).in_(["starting", "running"]),
                )
                .order_by(col(AiRun.started_at))
            )
        ).first()
        for i, r in enumerate((r for r in mine if not r.behind_run_id), 1):
            out[r.id] = {
                "queue_position": i,
                "behind_ticket_id": running.ticket_id if running else None,
            }
    for r in queued:
        if r.behind_run_id:
            holder = await session.get(AiRun, r.behind_run_id)
            if holder is not None:
                out[r.id] = {
                    "queue_position": 1,
                    "behind_ticket_id": holder.ticket_id,
                    "behind_member_id": holder.member_id,
                }
    return out


async def runs_to_dicts(session, runs: list[AiRun]) -> list[dict]:
    """Runs with their member names, queue position and step estimate."""
    extra = [r.behind_run_id for r in runs if r.behind_run_id]
    holders = (
        {
            h.id: h
            for h in (
                await session.exec(select(AiRun).where(col(AiRun.id).in_(extra)))
            ).all()
        }
        if extra
        else {}
    )
    names = await _names(
        session,
        [r.member_id for r in runs] + [h.member_id for h in holders.values()],
    )
    estimates = await step_estimates(session, runs)
    queue = await queue_info(session, runs)
    out = []
    for r in runs:
        d = to_dict(r, names.get(r.member_id))
        d["step_estimate"] = estimates.get(r.member_id)
        d.update(queue.get(r.id, {}))
        if d.get("behind_member_id"):
            d["behind_member_name"] = names.get(d["behind_member_id"])
        out.append(d)
    return out


# ---------------------------------------------------------------------------
# Creating runs
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
    source_comment_id: str | None = None,
    include_context: bool = True,
    chain: list[str] | None = None,
    resume_session: str | None = None,
    wait_for_hold: bool = False,
    queue_after_current: bool = False,
    limit_min: int | None = None,
    replaces_comment_id: str | None = None,
    report_back: dict | None = None,
) -> AiRun:
    """Queue a run; the scheduler starts it when it can.

    With `wait_for_hold`, a work run for a ticket another AI holds is queued *behind* the holder instead of being
    refused: it starts when the hold is released (design H1, "Next").

    Raises:
        RunConflict: The ticket is held by another work run.
        RunError: The member cannot run (removed, inbox only), the queue is full, or the ticket's daily run limit
            is used up.
    """
    ticket = await session.get(Ticket, ticket_id)
    if ticket is None:
        raise RunError(f"Ticket {ticket_id} not found.")
    member, profile = await get_profile(session, member_id)
    if (
        member is None
        or profile is None
        or member.kind != "ai"
        or member.project_id != ticket.project_id
    ):
        raise RunError("Only an AI member of this project can run on this ticket.")
    if profile.connection == "inbox":
        raise RunError(
            f"{member.name} is an MCP client with an inbox only: the board cannot start it. "
            "It sees the assignment the next time it reads its tickets."
        )
    if profile.remove_after_run:
        raise RunError(f"{member.name} is being removed; it takes no new runs.")
    if mode not in ("work", "ask"):
        raise RunError("mode must be work or ask")
    queued = [
        r
        for r in await active_runs(session, member_id=member_id)
        if r.state == "queued"
    ]
    if profile.connection == "api_key" and len(queued) >= MAX_QUEUED_PER_AGENT:
        raise RunError(
            f"{member.name} already has {len(queued)} runs queued (limit {MAX_QUEUED_PER_AGENT}). "
            "Wait for some to finish or assign someone else."
        )
    behind: str | None = None
    if mode == "work":
        held = [
            r
            for r in await active_runs(session, ticket_id=ticket_id)
            if r.mode == "work" and not r.behind_run_id
        ]
        if held:
            names = await _names(session, [held[0].member_id])
            if not wait_for_hold or held[0].member_id == member_id:
                raise RunConflict(
                    f"{ticket_id} is held by {names.get(held[0].member_id, 'another AI member')} "
                    f"(run #{held[0].number}, {held[0].state}). Only one agent works on a ticket at a time."
                )
            if any(
                r.mode == "work" and r.behind_run_id
                for r in await active_runs(session, ticket_id=ticket_id)
            ):
                raise RunConflict(
                    f"{ticket_id} already has an AI waiting behind its holder."
                )
            behind = held[0].id
        settings = await get_settings(session, ticket.project_id)
        # The per-ticket limit is a loop guard for API-key members (scheduled or AI-started runs). Claude Code and
        # Antigravity run on the person's own CLI and are not limited
        auto = profile.connection == "api_key" and (
            bool(chain) or trigger == "schedule"
        )
        if auto:
            today = await safety.limited_runs_today(session, ticket_id)
            allowed = settings.runs_per_ticket_per_day + await safety.extra_runs_today(
                session, ticket_id
            )
            if len(today) >= allowed:
                raise RunError(
                    f"Run limit reached: {ticket_id} has used {len(today)} of "
                    f"{allowed} scheduled or AI-started runs today."
                )
    last = (
        await session.exec(
            select(AiRun)
            .where(AiRun.ticket_id == ticket_id)
            .order_by(col(AiRun.number).desc())
            .limit(1)
        )
    ).first()
    run = AiRun(
        project_id=ticket.project_id,
        ticket_id=ticket_id,
        member_id=member_id,
        number=(last.number + 1) if last else 1,
        mode=mode,
        trigger=trigger,
        started_via=svc_activity.current_origin(),
        started_by=started_by,
        instruction=instruction or "",
        source_comment_id=source_comment_id,
        include_context=include_context,
        chain=json.dumps(chain or []),
        session_id=resume_session,
        metered=profile.connection == "api_key",
        model=profile.model,
        behind_run_id=behind,
        queue_after_current=queue_after_current,
        limit_min=limit_min,
        replaces_comment_id=replaces_comment_id,
        report_back=json.dumps(report_back) if report_back else None,
    )
    session.add(run)
    try:
        await session.commit()
    except IntegrityError as exc:
        await session.rollback()
        raise RunConflict(
            f"{ticket_id} is already held by another AI run. Only one agent works on a ticket at a time."
        ) from exc
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
        detail={"mode": mode, "trigger": trigger},
    )
    RT.wake.set()
    await _publish(force=True)
    return run


# ---------------------------------------------------------------------------
# Scheduler
# ---------------------------------------------------------------------------


async def start_scheduler() -> None:
    """Recover runs left by a crash, then start the scheduler loop."""
    await recover_on_startup()
    if RT.scheduler is None or RT.scheduler.done():
        RT.scheduler = asyncio.create_task(_loop())


async def stop_scheduler() -> None:
    """Stop the loop and every CLI process (no process outlives the board)."""
    if RT.scheduler:
        RT.scheduler.cancel()
        try:
            await RT.scheduler
        except (asyncio.CancelledError, Exception):
            pass
        RT.scheduler = None
    for run_id, proc in list(RT.procs.items()):
        RT.cancelled.add(run_id)
        proc.kill()
    for run_id in list(RT.tasks):
        try:
            await cancel(
                run_id,
                by="board",
                reason="The board was closed while the run was in progress.",
                state="failed",
            )
        except RunError:
            pass  # it ended on its own meanwhile
        except Exception:  # noqa: BLE001
            logger.exception("Could not end run %s on shutdown", run_id)


async def _loop() -> None:
    from . import members as svc_members

    from . import autotrip

    last_health = last_trip = asyncio.get_running_loop().time()
    while True:
        try:
            await tick()
            now = asyncio.get_running_loop().time()
            if now - last_health >= svc_members.HEALTH_INTERVAL_S:
                last_health = now
                await svc_members.health_check()
            if now - last_trip >= AUTO_TRIP_CHECK_S:
                last_trip = now
                await autotrip.check()
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            logger.exception("AI scheduler tick failed")
        RT.wake.clear()
        try:
            await asyncio.wait_for(RT.wake.wait(), timeout=2.0)
        except asyncio.TimeoutError:
            pass


async def recover_on_startup() -> None:
    """Runs that were starting or running when the board stopped cannot be resumed: end them as failed and kill a
    leftover CLI process if it is still ours."""
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
            run.state = "failed"
            run.ended_at = now_iso()
            run.ended_reason = "The board restarted while this run was in progress. Retry to start a new run."
            run.token_hash = None
            session.add(run)
        await session.commit()
        lost = [r.id for r in rows if r.id not in RT.tasks]
    for run_id in lost:
        await approvals.mark_run_ended(run_id)


async def _blocking_reason(
    session,
    run: AiRun,
    profile: AiMember,
    member: Member,
    settings: AiProjectSettings,
    skip_queue: bool = False,
) -> str | None:
    """Why a queued run cannot start yet, or None. `skip_queue` ignores "queued behind the current work" (Start now)."""
    if settings.paused_all:
        return "AI is paused for this project"
    if profile.paused:
        return f"{member.name} is paused"
    if profile.token_revoked_at:
        return f"Token revoked by {profile.token_revoked_by or 'a person'} — reconnect {member.name}"
    if profile.health in (
        "key_invalid",
        "not_logged_in",
        "runner_missing",
        "model_retired",
    ):
        return {
            "key_invalid": "API key invalid — fix in AI members",
            "not_logged_in": "CLI not logged in",
            "runner_missing": "Runner not detected",
            "model_retired": "Model retired — choose another",
        }[profile.health]
    retry_at = parse_iso(profile.retry_at)
    if profile.health == "rate_limited" and retry_at and retry_at > datetime.now(UTC):
        secs = max(1, int((retry_at - datetime.now(UTC)).total_seconds()))
        wait = f"{secs} s" if secs < 120 else f"{round(secs / 60)} min"
        return f"Rate-limited by the provider — retrying in about {wait}"
    running = (
        await session.exec(
            select(AiRun).where(
                AiRun.member_id == run.member_id,
                col(AiRun.state).in_(["starting", "running"]),
            )
        )
    ).all()
    if profile.connection == "api_key" and len(running) >= max(1, profile.max_parallel):
        return (
            f"Waiting for a free slot ({len(running)} of {profile.max_parallel} in use)"
        )
    if any(r.ticket_id == run.ticket_id and r.id != run.id for r in running):
        # One conversation per member and ticket: a second run would resume the session while it is in use
        return "Waiting for this AI's earlier run on the same ticket to finish"
    from services.docs_ai import sessions as shared

    if shared.is_busy(shared.ticket_scope(run.ticket_id), run.member_id):
        return "Waiting for a chat with this AI on the same ticket to finish"
    if run.queue_after_current and running and not skip_queue:
        # "Queue": wait behind the work the member is doing, even when a slot is free (design A2)
        return f"Queued behind {running[0].ticket_id}"
    board_running = (
        await session.exec(
            select(AiRun).where(
                AiRun.project_id == run.project_id,
                col(AiRun.state).in_(["starting", "running"]),
            )
        )
    ).all()
    if profile.connection == "api_key" and len(board_running) >= max(
        1, settings.board_max_parallel
    ):
        return (
            f"Waiting for a free slot on the board ({len(board_running)} of "
            f"{settings.board_max_parallel} in use)"
        )
    hit = await budget.blocked_detail(session, profile, settings, budget.run_kind(run))
    if hit:
        policy = (
            settings.board_at_cap
            if hit["scope"] == "board"
            else merged_config(loads(profile.config, {})).get("at_cap", "pause")
        )
        if policy == "ask" and await approvals.request_cap_raise(session, profile, hit):
            await board_events.publish(board_events.INVALIDATE)
        return hit["reason"] + (
            " · waiting for an owner to raise the cap" if policy == "ask" else ""
        )
    return None


_LAST_HOUSEKEEPING = {"at": 0.0}


async def _housekeeping() -> None:
    """Once a minute: expire approvals, release the daily digest, prune old audit entries."""
    loop = asyncio.get_running_loop()
    if loop.time() - _LAST_HOUSEKEEPING["at"] < 60:
        return
    _LAST_HOUSEKEEPING["at"] = loop.time()
    async with database.async_session() as session:
        await approvals.expire(session)
        projects = (await session.exec(select(AiProjectSettings))).all()
    for s in projects:
        await safety.release_digest(s.project_id)
        await safety.check_key_reminders(s.project_id)
    await audit.prune()


async def tick() -> None:
    """Start what can start; time out what has waited too long."""
    async with RT.tick_lock:
        await _housekeeping()
        await autopilot.tick()
        async with database.async_session() as session:
            await _expire_rate_limits(session)
            # Answers that never came: release the hold after 24 h (Pending and the question stay open)
            waiting = (
                await session.exec(select(AiRun).where(AiRun.state == "needs_input"))
            ).all()
            for run in waiting:
                asked = parse_iso(
                    (loads(run.question, {}) or {}).get("asked_at")
                ) or parse_iso(run.last_output_at)
                if asked and datetime.now(UTC) - asked > timedelta(
                    hours=NEEDS_INPUT_HOLD_HOURS
                ):
                    await _end(
                        run.id,
                        "timed_out",
                        "No answer for 24 h; the hold was released. A later answer starts a new run.",
                    )
                elif asked:
                    await _remind(session, run, asked)
            # Starting for too long with no task: lost
            queued = (
                await session.exec(
                    select(AiRun)
                    .where(AiRun.state == "queued")
                    .order_by(col(AiRun.queued_at))
                )
            ).all()
            seen_waiting: dict[str, str] = {}
            for run in queued:
                member, profile = await get_profile(session, run.member_id)
                if member is None or profile is None:
                    await _end(run.id, "failed", "The AI member was removed.")
                    continue
                if run.behind_run_id and not await _promote_waiting(session, run):
                    holder = (
                        await _holders(session, run.ticket_id, exclude=run.id) or [None]
                    )[0]
                    who = (
                        (await _names(session, [holder.member_id])).get(
                            holder.member_id
                        )
                        if holder
                        else None
                    )
                    seen_waiting[run.id] = (
                        f"Waiting for {who or 'the current holder'} to release {run.ticket_id}"
                    )
                    continue
                settings = await get_settings(session, run.project_id)
                reason = await _blocking_reason(session, run, profile, member, settings)
                if reason:
                    seen_waiting[run.id] = reason
                    continue
                await _start(session, run)
            RT.waiting = seen_waiting


async def _remind(session, run: AiRun, asked: datetime) -> None:
    """Reminders for an unanswered question: after 15 min, then every 2 h; from 6 h the project's admins are told
    too. They are recorded on the question; the board shows a dot and a toast for each new one."""
    q = loads(run.question, {}) or {}
    sent = list(q.get("reminders") or [])
    minutes = (datetime.now(UTC) - asked).total_seconds() / 60
    due = [m for m in REMINDER_MINUTES if minutes >= m]
    if len(due) <= (sent[-1]["level"] if sent else 0):
        return
    level = len(due)
    entry = {"at": now_iso(), "level": level}
    if minutes >= REMINDER_LEAD_MINUTES:
        admins = (
            await session.exec(
                select(Member).where(
                    Member.project_id == run.project_id,
                    Member.kind == "human",
                    Member.role == "admin",
                )
            )
        ).all()
        entry["lead"] = [a.name for a in admins]
    sent.append(entry)
    q["reminders"] = sent
    run.question = json.dumps(q)
    session.add(run)
    await session.commit()
    if entry.get("lead"):
        # From 6 h the project's admins are told too, as a notification (not only on the question)
        hours = int(minutes // 60)
        await safety.notify(
            run.project_id,
            "question",
            f"{run.ticket_id}: a question has waited {hours} h",
            f"“{(q.get('text') or '')[:140]}” is still unanswered; the AI holds the ticket until someone answers.",
            ref_kind="run",
            ref_id=run.id,
            member_id=run.member_id,
            people=[*entry["lead"], *([q["to"]] if q.get("to") else [])],
        )
    await _publish(force=True)


async def _holders(session, ticket_id: str, exclude: str | None = None) -> list[AiRun]:
    """The work runs that hold a ticket (never a waiting one)."""
    return [
        r
        for r in await active_runs(session, ticket_id=ticket_id)
        if r.mode == "work" and not r.behind_run_id and r.id != exclude
    ]


async def _promote_waiting(session, run: AiRun) -> bool:
    """A second AI waits for the holder of the ticket; when the hold is released it takes the hold (and the ticket's
    assignee), then starts like any queued run. False while someone still holds it."""
    if await _holders(session, run.ticket_id, exclude=run.id):
        return False
    run.behind_run_id = None
    session.add(run)
    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        return False
    ticket = await session.get(Ticket, run.ticket_id)
    if ticket is not None and ticket.assignee != run.member_id:
        try:
            await svc_tickets.update_ticket(
                session, ticket.id, TicketUpdate(assignee=run.member_id)
            )
        except ValueError:
            logger.warning("Could not assign %s to the next AI", run.ticket_id)
    return True


async def _expire_rate_limits(session) -> None:
    """A rate-limited member is online again once its wait is over; its queued runs start in this same tick."""
    limited = (
        await session.exec(select(AiMember).where(AiMember.health == "rate_limited"))
    ).all()
    now = datetime.now(UTC)
    for profile in limited:
        until = parse_iso(profile.retry_at)
        if until is None or until <= now:
            profile.health, profile.health_detail, profile.retry_at = "ok", None, None
            session.add(profile)
    if limited:
        await session.commit()


async def requeue_rate_limited(run_id: str, wait_s: float, detail: str) -> bool:
    """The provider is rate-limiting this AI member: put the run back in the queue and let it try again after the
    wait (design/screens/ai-members.md, E7), instead of failing it. The member shows Rate-limited meanwhile and
    "Retry now" skips the wait.

    Returns:
        False when the run already waited MAX_RATE_REQUEUES times: the caller fails it, as a provider that
        keeps refusing is not a wait any more.
    """
    async with database.async_session() as session:
        run = await session.get(AiRun, run_id)
        if run is None or run.state in ENDED:
            return True
        if (
            sum(1 for s in loads(run.steps, []) if s.get("kind") == "rate_limited")
            >= MAX_RATE_REQUEUES
        ):
            return False
        member, profile = await get_profile(session, run.member_id)
        wait_s = max(5.0, min(float(wait_s), cli.RATE_WAIT_MAX))
        profile.health = "rate_limited"
        profile.health_detail = detail[:240]
        profile.retry_at = (datetime.now(UTC) + timedelta(seconds=wait_s)).isoformat()
        session.add(profile)
        run.token_hash = None
        run.pid = None
        session.add(run)
        await session.commit()
    await _append(
        run_id,
        steps=[
            {
                "kind": "rate_limited",
                "text": f"{detail} Queued again; it retries in about {int(wait_s)} s.",
            }
        ],
        state="queued",
        started_at=None,
    )
    await audit.record(
        run.project_id,
        "run_rate_limited",
        "info",
        member_id=run.member_id,
        member_name=member.name if member else "",
        on_behalf_of=run.started_by,
        run_id=run.id,
        target=run.ticket_id,
        detail={"wait_s": int(wait_s), "reason": detail},
    )
    RT.wake.set()
    await _publish(force=True)
    return True


async def _requeue_fresh(run_id: str) -> bool:
    """The CLI could not resume the earlier session (it was made in another folder, or is gone): queue the run
    again and let it start a new session. Only once per run; False when it already did."""
    async with database.async_session() as session:
        run = await session.get(AiRun, run_id)
        if run is None or run.state in ENDED:
            return True
        if any(st.get("kind") == "fresh_session" for st in loads(run.steps, [])):
            return False
        run.session_id = None
        run.token_hash = None
        run.pid = None
        session.add(run)
        await session.commit()
    await _append(
        run_id,
        steps=[
            {
                "kind": "fresh_session",
                "text": "The CLI could not resume the earlier session: starting a new one.",
            }
        ],
        state="queued",
        started_at=None,
    )
    RT.wake.set()
    await _publish(force=True)
    return True


async def _start(session, run: AiRun) -> None:
    token = "kbr_" + pysecrets.token_urlsafe(24)
    ticket = await session.get(Ticket, run.ticket_id)
    if ticket is None:
        await _end(run.id, "failed", "The ticket no longer exists.")
        return
    run.state = "starting"
    run.started_at = now_iso()
    run.last_output_at = run.started_at
    run.token_hash = guard.token_hash(token)
    if run.status_before is None:
        run.status_before = ticket.status
    session.add(run)
    await session.commit()
    RT.waiting.pop(run.id, None)
    RT.tasks[run.id] = asyncio.create_task(_execute(run.id, token))
    await _publish(force=True)


# ---------------------------------------------------------------------------
# Execution
# ---------------------------------------------------------------------------


async def _ctx_for(session, run: AiRun) -> RunContext:
    member, _ = await get_profile(session, run.member_id)
    return RunContext(
        run_id=run.id,
        member_id=run.member_id,
        member_name=member.name if member else "AI member",
        project_id=run.project_id,
        ticket_id=run.ticket_id,
        on_behalf_of=run.started_by,
        mode=run.mode,
        chain=loads(run.chain, []),
    )


async def move_status(run_id: str, target: str) -> bool:
    """Move the run's ticket as the AI member (within its ceiling); records the change on the run."""
    async with database.async_session() as session:
        run = await session.get(AiRun, run_id)
        ticket = await session.get(Ticket, run.ticket_id) if run else None
        if run is None or ticket is None or ticket.status == target:
            return False
        _, profile = await get_profile(session, run.member_id)
        if profile is None or check_status_move(profile, ticket.status, target):
            return False
        ctx = await _ctx_for(session, run)
        before = ticket.status
        tokens = guard.enter(ctx)
        try:
            await svc_tickets.update_ticket(
                session, ticket.id, TicketUpdate(status=target)
            )
        finally:
            guard.leave(tokens)
        run = await session.get(AiRun, run_id)
        changes = loads(run.status_changes, [])
        changes.append({"from": before, "to": target, "at": now_iso()})
        run.status_changes = json.dumps(changes)
        session.add(run)
        await session.commit()
    await audit.record(
        ctx.project_id,
        "change_status",
        "allowed",
        member_id=ctx.member_id,
        member_name=ctx.member_name,
        on_behalf_of=ctx.on_behalf_of,
        run_id=run_id,
        target=ctx.ticket_id,
        detail={
            "tool": "board",
            "op": "run_lifecycle",
            "before": {"status": before},
            "after": {"status": target},
        },
    )
    return True


async def _append(
    run_id: str,
    steps: list[dict] | None = None,
    files: list[dict] | None = None,
    results: list[dict] | None = None,
    **fields,
) -> AiRun | None:
    async with database.async_session() as session:
        run = await session.get(AiRun, run_id)
        if run is None:
            return None
        if steps or results:
            stamp = datetime.now(UTC).strftime("%H:%M:%S")
            cur = loads(run.steps, [])
            cur.extend({"at": stamp, **s} for s in steps or [])
            # What a command printed goes onto its own step: exit code, output, and the tests it reported
            for res in results or []:
                step = next(
                    (
                        s
                        for s in reversed(cur)
                        if s.get("tool_id") and s["tool_id"] == res.get("tool_id")
                    ),
                    None,
                )
                if step is not None and step.get("kind") == "command":
                    step["exit_code"] = res["exit_code"]
                    step["output"] = res["output"]
                    tests = cli.parse_tests(res["output"])
                    if tests:
                        step["tests"] = tests
            run.steps = json.dumps(cur[-400:])
        if files:
            cur_files = {f["path"]: f for f in loads(run.files, [])}
            for f in files:
                prev = cur_files.get(f["path"])
                if prev:
                    prev["added"] += f["added"]
                    prev["removed"] += f["removed"]
                else:
                    cur_files[f["path"]] = dict(f)
            run.files = json.dumps(list(cur_files.values()))
        for key, value in fields.items():
            setattr(run, key, value)
        run.last_output_at = now_iso()
        session.add(run)
        await session.commit()
        await session.refresh(run)
    if "cost_usd" in fields and run.metered:
        await safety.check_budget_alerts(run.member_id)
    await _publish()
    return run


async def _execute(run_id: str, token: str) -> None:
    try:
        async with database.async_session() as session:
            run = await session.get(AiRun, run_id)
            member, profile = await get_profile(session, run.member_id)
        if profile.connection == "api_key":
            from . import api_agent

            if run.mode == "work":
                await move_status(run_id, "in-progress") if _should_start_move(
                    run, profile
                ) else None
            await api_agent.execute(run_id, token)
        elif profile.provider in ("claude-code", "antigravity"):
            await _execute_claude(run_id, token)
        else:
            await _end(
                run_id,
                "failed",
                f"{PROVIDERS.get(profile.provider, {}).get('label', profile.provider)} has no headless mode the "
                "board can start. It can still pick up its assigned tickets through MCP.",
            )
    except Exception as exc:  # noqa: BLE001
        logger.exception("AI run %s crashed", run_id)
        await _end(run_id, "failed", f"The runner failed: {redact(str(exc))[:300]}")
    finally:
        RT.tasks.pop(run_id, None)
        RT.procs.pop(run_id, None)
        RT.wake.set()


def _should_start_move(run: AiRun, profile: AiMember) -> bool:
    return (
        run.mode == "work"
        and run.status_before in ("backlog", "todo")
        and ceiling_rank(profile.ceiling) >= status_rank("in-progress")
    )


async def _note_flagged(run: AiRun, ticket: Ticket, humans: set[str], names: set[str]):
    """Record once per run that it was given text that looks like instructions (the audit entry later names the
    source of a blocked action, F5)."""
    from . import injection

    flagged = [
        f
        for f in injection.flags_for_comments(loads(ticket.comments, []), humans, names)
        if f["phrases"]
    ]
    if not flagged:
        return
    async with database.async_session() as session:
        seen = (
            await session.exec(
                select(AiAudit).where(
                    AiAudit.run_id == run.id, AiAudit.action == "injection_detected"
                )
            )
        ).first()
    if seen:
        return
    first = flagged[0]
    await audit.record(
        run.project_id,
        "injection_detected",
        "info",
        member_id=run.member_id,
        run_id=run.id,
        on_behalf_of=run.started_by,
        target=run.ticket_id,
        detail={
            "comment_id": first["comment_id"],
            "author": first["author"],
            "trust": first["trust"],
            "phrases": first["phrases"],
        },
    )


ACTIVITY_RUNS = 10


async def _activity_for(session, run: AiRun, names: set[str]) -> str:
    """Runs of the other AI members on this ticket since this member's last run on it (the latest few when it has
    none), as the board's own record: a resumed session only remembers what its own agent did."""
    mine = (
        await session.exec(
            select(AiRun)
            .where(
                AiRun.ticket_id == run.ticket_id,
                AiRun.member_id == run.member_id,
                AiRun.id != run.id,
                AiRun.queued_at < run.queued_at,
            )
            .order_by(col(AiRun.queued_at).desc())
            .limit(1)
        )
    ).first()
    stmt = select(AiRun).where(
        AiRun.ticket_id == run.ticket_id,
        AiRun.member_id != run.member_id,
        AiRun.id != run.id,
    )
    if mine is not None:
        stmt = stmt.where(AiRun.queued_at > mine.queued_at)
    others = list(
        reversed(
            (
                await session.exec(
                    stmt.order_by(col(AiRun.queued_at).desc()).limit(ACTIVITY_RUNS)
                )
            ).all()
        )
    )
    if not others:
        return ""
    member_names = {
        m.id: m.name
        for m in (
            await session.exec(
                select(Member).where(col(Member.id).in_({r.member_id for r in others}))
            )
        ).all()
    }
    return activity_block(
        others, member_names, since=mine.queued_at if mine is not None else None
    )


async def _build_prompt(
    session,
    run: AiRun,
    profile: AiMember,
    member: Member,
    *,
    resume_note: str | None,
    prior: dict | None = None,
    record: dict | None = None,
):
    """(system, user message, config) of a run, with the project's AI guidance pages added to the system prompt.

    `prior` is what the conversation this run continues was last told about the ticket: the message then carries
    only what changed. `record` receives what this run tells (the system prompt's digest and the ticket snapshot)."""
    system, prompt, config = await _build_prompt_base(
        session,
        run,
        profile,
        member,
        resume_note=resume_note,
        prior=prior,
        record=record,
    )
    from services.docs_ai import access as docs_ai_access

    text, reads = await docs_ai_access.guidance_block(session, run.project_id)
    if text:
        system += "\n\n" + text
        if not any(s.get("kind") == "read" for s in loads(run.steps, [])):
            await _append(
                run.id,
                steps=[
                    {
                        "kind": "read",
                        "text": "Read guidance: "
                        + ", ".join(r["title"] for r in reads),
                        "detail": {"pages": reads},
                    }
                ],
            )
    if record is not None:
        record["system"] = digest(system)
    return system, prompt, config


async def _build_prompt_base(
    session,
    run: AiRun,
    profile: AiMember,
    member: Member,
    *,
    resume_note: str | None,
    prior: dict | None = None,
    record: dict | None = None,
):
    ticket = await session.get(Ticket, run.ticket_id)
    project = await session.get(Project, run.project_id)
    settings = await get_settings(session, run.project_id)
    ctx = await _ctx_for(session, run)
    config = merged_config(loads(profile.config, {}))
    if (
        profile.connection == "api_key"
    ):  # prompt variables, linked docs and the output format (P D1, D5, D7)
        from . import api_prompt

        return await api_prompt.build(
            session, run, profile, member, config, resume_note=resume_note
        )
    team = sorted(
        m.name
        for m in (
            await session.exec(
                select(Member).where(
                    Member.project_id == run.project_id, Member.kind == "ai"
                )
            )
        ).all()
        if m.id != member.id
    )
    system = rules_block(
        ctx,
        profile,
        settings,
        project_name=project.name if project else "",
        ticket_status=ticket.status,
        team=team,
    )
    if profile.persona.strip():
        system += f"\n\nRole / persona (set by the project's people):\n{profile.persona.strip()}"
    # Claude Code reads the instructions from the CLAUDE.md the board writes (config_sync); API agents get them here
    if (config.get("instructions") or "").strip() and profile.provider != "claude-code":
        system += f"\n\nProject instructions:\n{config['instructions'].strip()}"
    if resume_note:
        return system, resume_note, config
    names = await ai_names(session, run.project_id)
    humans = {
        m.name
        for m in (
            await session.exec(
                select(Member).where(
                    Member.project_id == run.project_id, Member.kind == "human"
                )
            )
        ).all()
    }
    parts = []
    if run.include_context and prior is not None:
        await _note_flagged(run, ticket, humans, names)
        parts.append(
            delta_block(
                ticket,
                prior,
                skip_comment_id=run.source_comment_id,
                skip_author=member.name,
            )
        )
        if record is not None:
            record.update(
                mode="delta",
                ticket=snapshot(ticket),
                new_comments=len(
                    [
                        c
                        for c in loads(ticket.comments, [])
                        if isinstance(c, dict)
                        and not c.get("deleted_at")
                        and c.get("id") not in set(prior.get("comments") or [])
                        and c.get("id") != run.source_comment_id
                        and c.get("author") != member.name
                    ]
                ),
            )
        activity = await _activity_for(session, run, names)
        if activity:
            parts.append(activity)
    elif run.include_context:
        await _note_flagged(run, ticket, humans, names)
        if record is not None:
            record.update(mode="full", ticket=snapshot(ticket))
        parts.append(
            ticket_block(
                ticket,
                names,
                humans=humans,
                allow_external=profile.allow_external,
                comments=config["context"].get("comments", True),
                criteria=config["context"].get("criteria", True),
                sub_tickets=(
                    (
                        await session.exec(
                            select(Ticket).where(Ticket.parent_id == ticket.id)
                        )
                    ).all()
                    if config["context"].get("sub_tickets")
                    else None
                ),
            )
        )
        activity = await _activity_for(session, run, names)
        if activity:
            parts.append(activity)
    else:
        parts.append(f'<ticket id="{ticket.id}" trusted>Title: {ticket.title}</ticket>')
    # A mention from another AI member (a chain hop) is data only, never instructions
    started_by_ai = run.started_by in names or bool(loads(run.chain, []))
    parts.append(
        instruction_block(ctx, run.instruction, person_trusted=not started_by_ai)
    )
    return system, "\n\n".join(parts), config


_WRITE_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"]
_WEB_TOOLS = ["WebFetch", "WebSearch"]


def cli_tool_rules(
    allowed: list[str], denied: list[str], *, safe: bool, domains: list[str]
) -> tuple[list[str], list[str]]:
    """The CLI's own tool rules for a run. The board is not a sandbox, but it writes these rules before every run:
    in safe mode the CLI may only read (and use the board's MCP server, where the guard allows read and comment);
    otherwise outbound web calls are limited to the allowed domains, because a run cannot ask a person mid-call."""
    allowed = [a for a in allowed if a.split("(")[0] not in _WEB_TOOLS]
    denied = list(denied)
    if safe:
        allowed = [
            a
            for a in allowed
            if a.split("(")[0] in ("Read", "Glob", "Grep")
            or a == "mcp__kanban"
            or a.startswith("mcp__kanban__")
        ]
        denied += [d for d in _WRITE_TOOLS + _WEB_TOOLS if d not in denied]
        return allowed, denied
    allowed += [f"WebFetch(domain:{d})" for d in domains if isinstance(d, str) and d]
    denied += [d for d in ["WebSearch"] if d not in denied]
    return allowed, denied


def mcp_config(config: dict, token: str, folder: str | None = None) -> dict:
    """The CLI's MCP servers for a member: the board's own (with the token that says who is calling), the enabled
    servers the member's configuration lists and, after them, the ones the working folder's `.mcp.json` lists."""
    mcp = {
        "mcpServers": {
            "kanban": {
                "type": "http",
                "url": f"{RT.board_url or 'http://127.0.0.1:8000'}/mcp/",
                "headers": {"Authorization": f"Bearer {token}"},
            }
        }
    }
    for server in config.get("mcp_servers") or []:
        name = (server.get("name") or "").strip()
        if name and name != "kanban" and server.get("enabled", True):
            spec = {
                k: v
                for k, v in server.items()
                if k in ("type", "command", "args", "url")
            }
            for k in ("env", "headers"):
                if server.get(k):
                    spec[k] = kv_dict(server[k])
            mcp["mcpServers"][name] = spec
    for name, spec in folder_servers(folder).items():
        mcp["mcpServers"].setdefault(
            name, spec
        )  # a server of the member's configuration wins
    return mcp


_AGY_READ_TOOLS = ("get_ticket", "list_tickets", "docs_read", "get_projects")


def antigravity_run_rules(
    mode: str, config: dict, servers: list[str], *, safe: bool, domains: list[str]
) -> tuple[list[str], list[str], bool]:
    """Antigravity's permission rules for a run (`--settings`): (allow, deny, may edit files). A headless run cannot
    ask, so what is not allowed is refused. The person's own `kanban` entry (no run token) is always denied: it would
    act as that person. A question or safe mode is read-only (no edits, no commands), as for Claude Code."""
    board = cli.AGY_BOARD_SERVER
    denied = ["mcp(kanban/*)"]
    others = [f"mcp({name}/*)" for name in servers if name not in ("kanban", board)]
    if mode == "ask" or safe:
        allowed = (
            [f"mcp({board}/*)"]
            if safe
            else [f"mcp({board}/{tool})" for tool in _AGY_READ_TOOLS]
        )
        denied += ["write_file(*)", "command(*)"]
        return allowed + others, denied, False
    allowed = (
        cli.antigravity_rules(list(config.get("allow_rules") or []))
        + [f"mcp({board}/*)"]
        + others
        + [f"read_url({d})" for d in domains if isinstance(d, str) and d]
    )
    denied += cli.antigravity_rules(list(config.get("deny_rules") or []))
    return list(dict.fromkeys(allowed)), list(dict.fromkeys(denied)), True


def antigravity_mcp(mcp: dict) -> dict:
    """The run's MCP servers as Antigravity's `.agents/mcp_config.json` reads them: the board's endpoint is named
    `board` (not `kanban`, the person's own entry), and a server's `type` is not written (it is told by its fields)."""
    servers = {}
    for name, spec in mcp["mcpServers"].items():
        servers[cli.AGY_BOARD_SERVER if name == "kanban" else name] = {
            k: v for k, v in spec.items() if k != "type"
        }
    return {"mcpServers": servers}


def antigravity_brief(cwd: str) -> str:
    """What a new Antigravity conversation is told first: it starts in a scratch folder, the work is in `cwd`."""
    return (
        f"Working folder: {cwd}\n"
        "You are started in an empty scratch folder. All the work is in the working folder above: use absolute paths "
        "inside it and run every command with it as the working directory. The board's tools are on the MCP "
        f"server named {cli.AGY_BOARD_SERVER}."
    )


def _step_context(step: dict) -> dict | None:
    """What a "Sent the ticket" step recorded (kept in `context`; the first version used `detail`)."""
    for holder in (step, step.get("detail")):
        if isinstance(holder, dict) and isinstance(holder.get("context"), dict):
            return holder["context"]
    return None


async def _prior_context(session, run: AiRun, session_id: str) -> dict | None:
    """What the conversation `session_id` was last told about the ticket (the ticket snapshot and the digest of its
    system prompt), or None when that is unknown or the conversation was compacted since: then the ticket is sent
    in full again."""
    rows = (
        await session.exec(
            select(AiRun)
            .where(
                AiRun.ticket_id == run.ticket_id,
                AiRun.member_id == run.member_id,
                AiRun.id != run.id,
                AiRun.session_id == session_id,
                AiRun.queued_at < run.queued_at,
            )
            .order_by(col(AiRun.queued_at).desc())
            .limit(5)
        )
    ).all()
    for prev in rows:
        steps = loads(prev.steps, [])
        at = next(
            (
                i
                for i in range(len(steps) - 1, -1, -1)
                if _step_context(steps[i]) is not None
            ),
            None,
        )
        if at is None:
            continue
        if any(st.get("kind") == "compact" for st in steps[at:]):
            return None
        sent = _step_context(steps[at])
        if not isinstance(sent.get("ticket"), dict):
            return None
        return {**sent["ticket"], "system": sent.get("system")}
    return None


def _context_step(sent: dict) -> list[dict]:
    """The run's step that says what the AI was told about the ticket (and keeps it for the next run)."""
    if sent.get("mode") == "delta":
        n = sent.get("new_comments") or 0
        text = "Sent what changed on the ticket since the last answer" + (
            f" ({n} new comment{'s' if n != 1 else ''}, ids only)" if n else ""
        )
    else:
        text = "Sent the ticket"
    return [{"kind": "read", "text": text, "context": sent}]


async def _session_for(
    session, run: AiRun, provider: str = "claude-code"
) -> tuple[str | None, str | None]:
    """The CLI session this run continues: the one already on the run (a run resumed after a question, a re-run
    after "Request changes"), else the last session this member used on this ticket, so one agent keeps one
    conversation per ticket. Returns (session id or None, a note for the run when a new session starts although
    an older one existed)."""
    wanted = run.session_id
    if not wanted:
        # the member's one conversation on this ticket, which a chat about the ticket may have started
        from services.docs_ai import sessions as shared

        if not any(st.get("kind") == "fresh_session" for st in loads(run.steps, [])):
            found = await shared.lookup(
                shared.ticket_scope(run.ticket_id), run.member_id
            )
            if found:
                return found, None
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
        if prev is None or any(
            st.get("kind") == "fresh_session" for st in loads(run.steps, [])
        ):
            return None, None
        wanted = prev.session_id
    if wanted and cli.session_exists(wanted, provider):
        return wanted, None
    return None, "Earlier session not found on this computer: starting a new one"


async def _execute_claude(
    run_id: str, token: str, resume_note: str | None = None
) -> None:
    """Run the CLI for a run while it holds the member's conversation on the ticket (a chat never uses it at the same
    time)."""
    from services.docs_ai import sessions as shared

    async with database.async_session() as session:
        run = await session.get(AiRun, run_id)
    if run is None:
        return
    scratch: list[
        str
    ] = []  # folders a run made for itself (Antigravity's per-run workspace)
    try:
        async with shared.exclusive(shared.ticket_scope(run.ticket_id), run.member_id):
            await _execute_claude_held(run_id, token, resume_note, scratch)
    finally:
        for folder in scratch:
            shutil.rmtree(folder, ignore_errors=True)


async def _execute_claude_held(
    run_id: str,
    token: str,
    resume_note: str | None = None,
    scratch: list[str] | None = None,
) -> None:
    async with database.async_session() as session:
        run = await session.get(AiRun, run_id)
        member, profile = await get_profile(session, run.member_id)
        agy = profile.provider == "antigravity"
        binary = PROVIDERS.get(profile.provider, {}).get("binary") or "claude"
        path, _ = cli.find_cli(binary, profile.cli_path)
        if not path:
            profile.health = "runner_missing"
            profile.health_detail = f"“{binary}” was not found on this computer"
            session.add(profile)
            await session.commit()
            await _end(
                run_id,
                "failed",
                f"No runner: the {binary} CLI was not found on this computer.",
            )
            return
        cwd = os.path.expanduser(profile.working_dir or "")
        if not cwd or not Path(cwd).is_dir():
            await _end(
                run_id,
                "failed",
                f"Working folder not found on this computer: {profile.working_dir or '(not set)'}",
            )
            return
        # Synced configuration (CLAUDE.md, skills, .mcp.json, settings.json) is written before the CLI starts
        synced = await config_service.sync_for_run(session, profile)
        if not synced["ok"]:
            await _end(run_id, "failed", synced["message"])
            return
        session_id, fresh_note = await _session_for(session, run, profile.provider)
        # A conversation that already holds the ticket is sent only what changed since; its instructions were fixed
        # when it began, so a changed system prompt starts a new conversation instead.
        prior = None
        if session_id and not resume_note and profile.connection != "api_key":
            prior = await _prior_context(session, run, session_id)
        sent: dict = {}
        system, prompt, config = await _build_prompt(
            session,
            run,
            profile,
            member,
            resume_note=resume_note,
            prior=prior,
            record=sent,
        )
        if prior is not None and prior.get("system") != sent.get("system"):
            session_id = None
            fresh_note = "The instructions changed since the last answer: starting a new conversation"
            sent = {}
            system, prompt, config = await _build_prompt(
                session, run, profile, member, resume_note=resume_note, record=sent
            )
        resume = session_id is not None
        if not agy:
            session_id = session_id or str(uuid.uuid4())
        # Antigravity starts in a scratch folder (below), so the folder's own Claude files do not apply to it
        mcp = mcp_config(config, token, None if agy else cwd)
        if run.mode == "ask":
            allowed = [
                "Read",
                "Glob",
                "Grep",
                "mcp__kanban__get_ticket",
                "mcp__kanban__list_tickets",
                "mcp__kanban__docs_read",
                "mcp__kanban__get_projects",
            ]
            if run.trigger == autopilot.TRIGGER:
                allowed.append(
                    "mcp__kanban__ai_run"
                )  # decide / answer, checked by the board
            # the member's other MCP servers answer too (a question is read-only on the board and on the files)
            allowed += [
                f"mcp__{server}" for server in mcp["mcpServers"] if server != "kanban"
            ]
            denied = ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"]
        else:
            allowed = list(config.get("allow_rules") or []) + ["mcp__kanban"]
            for server in mcp["mcpServers"]:
                if server != "kanban":
                    allowed.append(f"mcp__{server}")
            denied = list(config.get("deny_rules") or [])
        settings = await get_settings(session, run.project_id)
        safe = settings.safe_mode or profile.safe_mode
        if agy:
            allowed, denied, edits = antigravity_run_rules(
                run.mode,
                config,
                cli.antigravity_global_servers()
                + [s for s in mcp["mcpServers"] if s != "kanban"],
                safe=safe,
                domains=loads(settings.allowed_domains, []),
            )
        else:
            allowed, denied = cli_tool_rules(
                allowed,
                denied,
                safe=safe,
                domains=loads(settings.allowed_domains, []),
            )
            edits = False
        # An owner's "Bypass permissions" (Claude Code and Antigravity): work runs only, never in safe mode. Deny
        # rules and the board's own checks (status ceiling, approvals) still apply; the web stays off because its
        # domain list needs the allow list the mode skips.
        bypass = (
            config.get("permission_mode") == "bypass"
            and run.mode == "work"
            and not safe
        )
        if bypass:
            denied += [d for d in _WEB_TOOLS if d not in denied]
        if agy:
            workspace = tempfile.mkdtemp(prefix="kanban-agy-")
            if scratch is not None:
                scratch.append(workspace)
            Path(workspace, ".agents").mkdir()
            Path(workspace, ".agents", "mcp_config.json").write_text(
                json.dumps(antigravity_mcp(mcp)), encoding="utf-8"
            )
            args = cli.antigravity_args(
                path,
                prompt=prompt
                if resume
                else f"{antigravity_brief(cwd)}\n\n{system}\n\n{prompt}",
                model=profile.model,
                allowed=allowed,
                denied=denied,
                edits=edits and not safe,
                conversation=session_id,
                add_dirs=[cwd],
                effort=config.get("effort"),
                extra_flags=[
                    f for f in (config.get("extra_flags") or []) if isinstance(f, str)
                ],
                bypass=bypass,
            )
        else:
            args = cli.claude_args(
                path,
                prompt=prompt,
                system=system,
                model=profile.model,
                mcp_config=mcp,
                allowed=allowed,
                denied=denied,
                max_turns=None,  # the CLI's own judgement; a person can Stop the run
                session_id=session_id,
                resume=resume,
                effort=config.get("effort"),
                extra_flags=[
                    f for f in (config.get("extra_flags") or []) if isinstance(f, str)
                ],
                bypass=bypass,
            )
        run.session_id = session_id
        session.add(run)
        await session.commit()
        from services.docs_ai import sessions as shared

        if session_id:
            await shared.remember(
                shared.ticket_scope(run.ticket_id),
                run.member_id,
                run.project_id,
                session_id,
            )
        ceiling_ok = _should_start_move(run, profile) and not resume_note
        compact_at = config.get("compact_at_pct")
    if run_id in RT.cancelled:
        return  # cancelled while starting: never launch the CLI
    if ceiling_ok:
        await move_status(run_id, "in-progress")

    proc = cli.CliProcess(
        args,
        cwd=workspace if agy else cwd,
        env=cli.child_env(compact_at),
        spill=not agy,
    )
    RT.procs[run_id] = proc
    pid = await proc.start()
    if run_id in RT.cancelled:
        proc.kill()  # the cancel came while the process was starting
    await _append(
        run_id,
        steps=[
            {
                "kind": "start",
                "text": (
                    "Continuing after a refused action"
                    if (resume_note or "").startswith("Your last action was refused")
                    else "Answer received — resuming"
                )
                if resume_note
                else (
                    "Read the ticket" if run.mode == "work" else "Reading the question"
                ),
            },
            *([{"kind": "start", "text": fresh_note}] if fresh_note else []),
            *(_context_step(sent) if sent.get("ticket") else []),
            *(
                [
                    {
                        "kind": "start",
                        "text": "Bypass permissions: the CLI runs any tool except what a Deny rule stops (web off)",
                    }
                ]
                if bypass
                else []
            ),
        ],
        pid=pid,
    )
    # A run on a person's own CLI has no time or turn limit: the CLI manages itself and a person can Stop it. Only a
    # CLI that never starts is given up on.
    start_s = STARTING_TIMEOUT_S * 4
    result: dict | None = None
    held_tokens: int | None = None  # what the conversation held at the last model call
    window_tokens: int | None = None
    timed_out: str | None = None
    lines = proc.lines().__aiter__()
    stream = cli.AgyStream(cwd) if agy else None
    remembered = not agy or resume
    ready = False
    pending: asyncio.Future | None = None
    while True:
        if pending is None:
            pending = asyncio.ensure_future(lines.__anext__())
        done, _ = await asyncio.wait({pending}, timeout=60 if ready else start_s)
        if not done:
            if ready or await _is_paused(run_id):
                continue  # a quiet CLI is thinking or a tool is running: keep waiting
            timed_out = "The CLI did not start in time."
            pending.cancel()
            break
        finished, pending = pending, None
        try:
            line = finished.result()
        except StopAsyncIteration:
            break
        parsed = stream.feed(line) if stream else cli.parse_stream_line(line, cwd)
        held_tokens = parsed.get("context_used") or held_tokens
        window_tokens = parsed.get("context_window") or window_tokens
        fields = {}
        if parsed["ready"] and not ready:
            ready = True
            fields["state"] = "running"
            if parsed.get("model"):
                fields["model"] = parsed["model"]
        if parsed["session_id"]:
            fields["session_id"] = parsed["session_id"]
            if not remembered:
                # Antigravity names a new conversation itself: share it with the ticket chat from now on
                remembered = True
                from services.docs_ai import sessions as shared

                await shared.remember(
                    shared.ticket_scope(run.ticket_id),
                    run.member_id,
                    run.project_id,
                    parsed["session_id"],
                )
        if parsed["result"]:
            result = parsed["result"]
        if parsed["steps"] or parsed["files"] or parsed["results"] or fields:
            if run_id in RT.cancelled:
                break
            async with database.async_session() as session:
                cur = await session.get(AiRun, run_id)
                if cur is None or cur.state in ENDED:
                    break
                if "state" in fields and cur.state != "starting":
                    fields.pop("state")
            await _append(
                run_id,
                steps=parsed["steps"],
                files=parsed["files"],
                results=parsed["results"],
                **fields,
            )
    if timed_out:
        proc.kill()
    code = await proc.wait()
    if run_id in RT.cancelled:
        RT.cancelled.discard(run_id)
        return
    usage = {}
    if result:
        usage = {
            "tokens_in": result["tokens_in"],
            "tokens_out": result["tokens_out"],
            "tokens_cached": result.get("tokens_cached"),
            "cost_usd": result["cost_usd"],
        }
    async with database.async_session() as session:
        run = await session.get(AiRun, run_id)
        if run is None or run.state in ENDED:
            return
        if held_tokens:
            run.context_used = held_tokens
            run.context_window = window_tokens or run.context_window
        if usage:
            run.tokens_in += usage["tokens_in"]
            run.tokens_out += usage["tokens_out"]
            if usage["tokens_cached"] is not None:
                run.tokens_cached = (run.tokens_cached or 0) + usage["tokens_cached"]
            run.cost_usd += usage["cost_usd"]
        run.exit_code = code
        session.add(run)
        await session.commit()
        question = loads(run.question, None)
    if timed_out:
        await _end(run_id, "timed_out", timed_out)
        return
    if question and not question.get("answered_at"):
        await _needs_input(run_id)
        return
    if (
        agy
        and result
        and not (result["text"] or "").strip()
        and result.get("refused")
        and not question
    ):
        # A headless Antigravity run ends its turn when the board refuses an action, so it would stop here with
        # nothing done. Tell it what was refused and let it carry on another way (Claude Code gets this as an error).
        tries = RT.refusal_retries.get(run_id, 0)
        refused = "; ".join(result["refused"])[:600]
        if tries < REFUSAL_RETRIES and run_id not in RT.cancelled:
            RT.refusal_retries[run_id] = tries + 1
            await _append(
                run_id,
                steps=[
                    {
                        "kind": "start",
                        "text": f"Antigravity stopped at a refused action: continuing ({tries + 1} of {REFUSAL_RETRIES})",
                    }
                ],
            )
            await _execute_claude_held(
                run_id,
                token,
                resume_note=(
                    f"Your last action was refused by the board's rules and you cannot ask for permission: {refused}. "
                    "Do not repeat it. Carry on with the task another way, using only what you are allowed "
                    "(reading and editing files in the working folder, the board's MCP tools, the shell commands "
                    "the board allows). If you cannot finish, say plainly what you could not do and why."
                ),
                scratch=scratch,
            )
            return
        RT.refusal_retries.pop(run_id, None)
        await _end(
            run_id,
            "failed",
            f"Antigravity stopped after the board refused: {refused}",
        )
        return
    if result and not result["is_error"] and code == 0:
        RT.refusal_retries.pop(run_id, None)
        await _finish(run_id, result["text"])
        return
    rate_wait = cli.rate_limit_wait(
        (result or {}).get("text") or " ".join(proc.stderr_tail[-5:])
    )
    if rate_wait is not None and await requeue_rate_limited(
        run_id, rate_wait, "The provider is rate-limiting the CLI (429)."
    ):
        return
    said = ((result or {}).get("text") or " ".join(proc.stderr_tail[-5:])).lower()
    if resume and "no conversation found" in said and await _requeue_fresh(run_id):
        return
    reason = None
    if result and result.get("subtype") == "error_max_turns":
        reason = f"Reached the turn limit ({config.get('max_turns') or 40} turns)."
    elif result and result.get("text"):
        reason = result["text"][:300]
    else:
        tail = " ".join(proc.stderr_tail[-3:])
        reason = f"Exit code {code}." + (f" {tail[:240]}" if tail else "")
        low = tail.lower()
        if "log in" in low or "login" in low or "not authenticated" in low:
            async with database.async_session() as session:
                _, profile = await get_profile(session, run.member_id)
                profile.health = "not_logged_in"
                profile.health_detail = "The CLI is installed but its session expired."
                session.add(profile)
                await session.commit()
    await _end(run_id, "failed", reason)


# ---------------------------------------------------------------------------
# Endings
# ---------------------------------------------------------------------------


async def post_ai_comment(
    ticket_id: str, member_name: str, text: str, meta: dict
) -> str | None:
    """Post a comment as the AI member; returns its id."""
    async with database.async_session() as session:
        ticket = await svc_tickets.add_comment(
            session, ticket_id, text, author=member_name, meta={"ai": meta}
        )
        if ticket is None:
            return None
        comments = loads(ticket.comments, [])
        return comments[-1]["id"] if comments else None


async def tag_comment(ticket_id: str, comment_id: str | None, meta: dict) -> None:
    """Attach AI metadata (run link, kind) to a comment the AI posted through MCP."""
    if not comment_id:
        return
    async with database.async_session() as session:
        ticket = await session.get(Ticket, ticket_id)
        if ticket is None:
            return
        comments = loads(ticket.comments, [])
        for c in comments:
            if c.get("id") == comment_id and not c.get("ai"):
                c["ai"] = meta
        ticket.comments = json.dumps(comments)
        session.add(ticket)
        await session.commit()


def _output_rules(profile) -> dict:
    """The API agent's output rules (design P D7); local runners have none."""
    if profile is None or profile.connection != "api_key":
        return {}
    return merged_config(loads(profile.config, {}))["output"]


def _usage_line(run: AiRun, profile) -> str:
    """ "6 steps · 14.2k tokens" as the last line of the comment, when the output rules ask for it."""
    if not _output_rules(profile).get("include_usage"):
        return ""
    steps = sum(1 for st in loads(run.steps, []) if st.get("kind") == "model")
    total = (run.tokens_in or 0) + (run.tokens_out or 0)
    tokens = f"{total / 1000:.1f}k" if total >= 1000 else str(total)
    return f"\n\n_{steps} step{'' if steps == 1 else 's'} · {tokens} tokens_"


async def _finish(run_id: str, final_text: str) -> None:
    async with database.async_session() as session:
        run = await session.get(AiRun, run_id)
        if run is None or run.state in ENDED:
            return
        member, profile = await get_profile(session, run.member_id)
        name = member.name if member else "AI member"
        report = loads(run.report, {})
        summary = (report.get("summary") or final_text or "").strip() or "Finished."
        duration = _duration(run)
        meta = {
            "run_id": run.id,
            "run_number": run.number,
            "member_id": run.member_id,
            "duration_s": duration,
            "metered": run.metered,
            "cost_usd": round(run.cost_usd, 4),
            "tokens_in": run.tokens_in,
            "tokens_out": run.tokens_out,
            "model": run.model,
        }
        mode, ticket_id, trigger = run.mode, run.ticket_id, run.trigger
        usage = _usage_line(run, profile)
    if mode == "ask":
        # Autopilot's delegate decides requests; what it decided is in the audit log and on each ticket, not here
        reply_id = (
            None
            if trigger == "autopilot"
            else await post_ai_comment(
                ticket_id,
                name,
                redact(final_text.strip() or "(no answer)") + usage,
                {
                    **meta,
                    "kind": "answer",
                    "question_comment_id": run.source_comment_id,
                },
            )
        )
        if run.replaces_comment_id:
            # “Edit and re-run → Replace it”: the old answer goes (it can be restored from the comment's Undo)
            async with database.async_session() as session:
                await svc_tickets.delete_comment(
                    session, ticket_id, run.replaces_comment_id
                )
        await _end(
            run_id,
            "finished",
            None,
            reply_comment_id=reply_id,
            summary=final_text[:4000],
        )
        return
    reply_id = await post_ai_comment(
        ticket_id,
        name,
        redact(summary) + usage,
        {
            **meta,
            "kind": "summary",
            "criteria": report.get("criteria") or [],
            "tests": report.get("tests"),
        },
    )
    moved = False
    # A scheduled run moves to Review only when its "done when" checks pass (services/ai/schedules.py)
    if (
        trigger != "schedule"
        and profile
        and ceiling_rank(profile.ceiling) >= status_rank("review")
    ):
        async with database.async_session() as session:
            ticket = await session.get(Ticket, ticket_id)
            current = ticket.status if ticket else None
        if current and status_rank(current) < status_rank("review"):
            moved = await move_status(run_id, "review")
    await _end(
        run_id,
        "finished",
        "Moved to Review" if moved else None,
        reply_comment_id=reply_id,
        summary=summary[:8000],
    )


def _clip(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _duration(run: AiRun) -> int:
    started = parse_iso(run.started_at)
    return int((datetime.now(UTC) - started).total_seconds()) if started else 0


async def _needs_input(run_id: str) -> None:
    async with database.async_session() as session:
        run = await session.get(AiRun, run_id)
        if run is None or run.state in ENDED:
            return
        member, _ = await get_profile(session, run.member_id)
        q = loads(run.question, {})
        human = (
            await session.exec(
                select(Member).where(
                    Member.project_id == run.project_id,
                    Member.kind == "human",
                    Member.name == run.started_by,
                )
            )
        ).first()
        ticket = await session.get(Ticket, run.ticket_id)
        if (
            ticket is not None
            and not ticket.pending
            and ticket.status not in ("done", "wont_do")
        ):
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
                    # Pending notes are at most 240 characters; the full question stays on the run
                    note=_clip(
                        f"{member.name if member else 'AI'} asks: {q.get('text', '')}",
                        240,
                    ),
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
    await _append(
        run_id,
        steps=[
            {
                "kind": "question",
                "text": f"Asked {run.started_by}: {q.get('text', '')[:200]}",
            }
        ],
    )
    await _publish(force=True)


async def _end(
    run_id: str, state: str, reason: str | None, *, by: str | None = None, **fields
) -> AiRun | None:
    """Move a run to an ended state (once): releases the hold and kills its token."""
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
        run.paused_at = None
        for key, value in fields.items():
            setattr(run, key, value)
        session.add(run)
        await session.commit()
        await session.refresh(run)
        member, profile = await get_profile(session, run.member_id)
    if state != "finished":
        await _append(
            run_id,
            steps=[
                {
                    "kind": "end",
                    "text": f"{state.replace('_', ' ').capitalize()}: {reason or ''}"[
                        :240
                    ],
                }
            ],
        )
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
    if state in ("failed", "timed_out") and run.mode == "work" and member:
        await post_ai_comment(
            run.ticket_id,
            member.name,
            f"Run #{run.number} {'timed out' if state == 'timed_out' else 'failed'}: {reason or 'no reason given'}. "
            "Partial work is kept. Retry starts a new run." + _usage_line(run, profile),
            {
                "kind": "failed",
                "run_id": run.id,
                "run_number": run.number,
                "member_id": run.member_id,
            },
        )
    if state in ("failed", "timed_out") and run.mode == "ask" and member:
        # The asker sees why there is no answer, in the thread (design/components/ai-ticket-work.md, C2)
        await post_ai_comment(
            run.ticket_id,
            member.name,
            f"Couldn't answer: {reason or 'the run stopped'}. Nothing was changed.",
            {
                "kind": "ask_failed",
                "run_id": run.id,
                "run_number": run.number,
                "member_id": run.member_id,
                "reply_to": run.source_comment_id,
                "cost_usd": run.cost_usd,
            },
        )
    if (
        state in ("failed", "timed_out")
        and run.mode == "work"
        and run.status_before
        and _output_rules(profile).get("move_back_on_failure")
    ):
        await move_status(
            run_id, run.status_before
        )  # output rule: back to the previous status
    if run.mode == "work" and state in ("finished", "failed", "timed_out"):
        await _log_work(run, state, reason)
        await _report_back(run, state, reason)
    if state == "failed":
        await _auto_trip(run.member_id)
    if profile and profile.remove_after_run:
        from . import members as svc_members

        async with database.async_session() as session:
            if not await active_runs(session, member_id=run.member_id):
                await svc_members.finalize_removal(session, run.member_id)
    RT.wake.set()
    await _publish(force=True)
    return run


_LOG_ROLES = (
    ("PM", ("pm", "project manager", "manager")),
    ("BA", ("ba", "analyst", "requirements")),
    ("Designer", ("design", "ux", "ui")),
    ("Tester", ("qa", "test")),
    ("Developer", ("dev", "developer", "engineer", "coder")),
)


def _log_role(member, profile) -> str:
    """The work-log role that fits an AI member, from its name and description."""
    text = f"{member.name} {getattr(profile, 'description', '') or ''}".lower()
    words = set(re.findall(r"[a-z]+", text))
    for role, keys in _LOG_ROLES:
        if any((k in words) if " " not in k else (k in text) for k in keys):
            return role
    return "Other"


async def _log_work(run: AiRun, state: str, reason: str | None) -> None:
    """Every ended work run leaves an entry in the ticket's work log (the Debug Space tab): who worked, for how long,
    what changed, which commands ran and the AI's own summary, so people can follow what the AI did."""
    try:
        async with database.async_session() as session:
            member, profile = await get_profile(session, run.member_id)
            if member is None:
                return
            steps = loads(run.steps, [])
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
            outcome = {
                "finished": "finished",
                "failed": "failed",
                "timed_out": "timed out",
            }[state]
            lines = [
                f"**Run #{run.number}** {outcome} · {seconds // 60} min {seconds % 60} s · "
                f"{(run.tokens_in or 0) + (run.tokens_out or 0):,} tokens · {run.model or 'default model'} · "
                f"started by {run.started_by} ({run.trigger})"
            ]
            said = (report.get("summary") or run.summary or reason or "").strip()
            if said:
                lines += ["", "**Summary**", _clip(said, 1800)]
            if files:
                lines += ["", "**Files changed**"] + [
                    f"- `{f.get('path')}` (+{f.get('added', 0)} −{f.get('removed', 0)})"
                    for f in files[:15]
                ]
            commands = [s["text"] for s in steps if s.get("kind") == "command"][:10]
            if commands:
                lines += ["", "**Commands**"] + [f"- {c}" for c in commands]
            board = list(
                dict.fromkeys(s["text"] for s in steps if s.get("kind") == "board")
            )[:12]
            if board:
                lines += ["", "**Board actions**"] + [f"- {b}" for b in board]
            tests = report.get("tests")
            if isinstance(tests, dict):
                lines += [
                    "",
                    f"**Tests (as reported)**: {tests.get('passed', 0)} passed, {tests.get('failed', 0)} failed",
                ]
            if state != "finished" and reason:
                lines += ["", f"**Why it stopped**: {_clip(reason, 300)}"]
            kind = (
                "blocked"
                if state != "finished"
                else "fix_attempt"
                if files
                else "investigation"
            )
            await svc_tickets.add_work_log(
                session,
                run.ticket_id,
                author=member.name,
                role=_log_role(member, profile),
                note="\n".join(lines),
                kind=kind,
            )
    except Exception:  # noqa: BLE001
        logger.exception("Could not write the work log of run %s", run.id)


REFUSAL_RETRIES = 3
WAKE_RETRY_S = 15.0
WAKE_TRIES = 80  # about 20 minutes of waiting for the delegator to be free


async def _report_back(run: AiRun, state: str, reason: str | None) -> None:
    """Delegated work ended without being passed on: wake the member who delegated it, on the ticket they delegated
    from, to check the result and carry the lifecycle on. If that member is busy on the ticket (or another teammate is
    already waiting for it), the wake waits for its turn instead of being lost."""
    back = loads(run.report_back, None)
    if (
        not isinstance(back, dict)
        or not back.get("member_id")
        or not back.get("ticket_id")
    ):
        return
    async with database.async_session() as session:
        member, _ = await get_profile(session, run.member_id)
    report = loads(run.report, {})
    said = (report.get("summary") or run.summary or reason or "").strip()
    outcome = (
        "finished"
        if state == "finished"
        else f"did not finish ({state.replace('_', ' ')})"
    )
    instruction = (
        f"{member.name if member else 'A teammate'} {outcome} the work you handed over on {run.ticket_id} "
        f"(run #{run.number}). Their summary: {said[:1500] or '(none)'}\n"
        f"Check it against {run.ticket_id}, update your status comment on this ticket, then hand the next "
        "piece of the lifecycle to the right teammate (ai_run handoff), or stop if the lifecycle is done."
    )
    key = f"report_{run.id}"
    RT.tasks[key] = asyncio.create_task(
        _wake_delegator(
            key,
            back,
            instruction,
            started_by=run.started_by,
            chain=[*loads(run.chain, []), run.member_id],
        )
    )


async def _wake_delegator(
    key: str, back: dict, instruction: str, *, started_by: str, chain: list[str]
) -> None:
    try:
        for _ in range(WAKE_TRIES):
            try:
                async with database.async_session() as session:
                    await create_run(
                        session,
                        ticket_id=back["ticket_id"],
                        member_id=back["member_id"],
                        mode="work",
                        trigger="report_back",
                        started_by=started_by,
                        instruction=instruction,
                        chain=chain,
                        wait_for_hold=True,
                    )
                return
            except RunConflict:
                await asyncio.sleep(WAKE_RETRY_S)  # busy: wait for its turn
            except RunError as exc:
                await post_ai_comment(
                    back["ticket_id"],
                    BOARD_AUTHOR,
                    f"Could not wake the member waiting for this result: {exc}",
                    {"board_note": True},
                )
                return
        logger.warning("The delegator %s was never free to hear back", back)
    except Exception:  # noqa: BLE001
        logger.exception("Could not wake the delegator of %s", back)
    finally:
        RT.tasks.pop(key, None)


async def _auto_trip(member_id: str) -> None:
    """Auto-trip on failed runs (the rule and its thresholds live in autotrip.py)."""
    from . import autotrip

    await autotrip.on_run_failed(member_id)


# ---------------------------------------------------------------------------
# People's actions on runs
# ---------------------------------------------------------------------------


async def cancel(
    run_id: str,
    *,
    by: str,
    reason: str | None = None,
    state: str = "cancelled",
    revert_status: bool = True,
    stop_code: str | None = None,
) -> AiRun:
    """Stop a run from any active state; the status the run set returns (and is recorded on the run as a status
    change), files stay as they are. `stop_code` says why when it was not the person's Cancel button: archive,
    deleted, reassigned, takeover, budget."""
    async with database.async_session() as session:
        run = await session.get(AiRun, run_id)
        if run is None:
            raise RunError("Run not found.")
        if run.state in ENDED:
            raise RunError(f"Run #{run.number} already ended ({run.state}).")
        was = run.state
        changes = loads(run.status_changes, [])
        ticket = await session.get(Ticket, run.ticket_id)
    RT.cancelled.add(run_id)
    proc = RT.procs.get(run_id)
    if proc:
        proc.kill()
    task = RT.tasks.get(run_id)
    ended = await _end(
        run_id, state, reason or f"Cancelled by {by}", by=by, stop_code=stop_code
    )
    if task and not task.done() and task is not asyncio.current_task():
        try:
            await asyncio.wait_for(asyncio.shield(task), timeout=10)
        except (asyncio.TimeoutError, asyncio.CancelledError, Exception):  # noqa: BLE001
            pass
    if revert_status and changes and ticket is not None:
        async with database.async_session() as session:
            ticket = await session.get(Ticket, run.ticket_id)
            if (
                ticket
                and ticket.status == changes[-1]["to"]
                and run.status_before
                and ticket.status != run.status_before
            ):
                back = ticket.status
                await svc_tickets.update_ticket(
                    session, ticket.id, TicketUpdate(status=run.status_before)
                )
                # The return is part of the run's story: "To Do → In Progress → To Do · status returned at cancel"
                await _append(
                    run_id,
                    status_changes=json.dumps(
                        [
                            *changes,
                            {
                                "from": back,
                                "to": run.status_before,
                                "at": now_iso(),
                                "kind": "cancel",
                            },
                        ]
                    ),
                )
    if was == "needs_input" and ticket is not None:
        async with database.async_session() as session:
            t = await session.get(Ticket, run.ticket_id)
            if t and t.pending and (t.pending_note or "").find(" asks: ") > 0:
                await svc_tickets.clear_pending(
                    session, t.id, reason="AI run cancelled"
                )
    RT.cancelled.discard(run_id) if not proc else None
    return ended


async def cancel_for_ticket(ticket_id: str, *, by: str, reason: str) -> int:
    """Cancel every active run of a ticket (deleted or archived): run history is kept."""
    async with database.async_session() as session:
        runs = await active_runs(session, ticket_id=ticket_id)
    for r in runs:
        try:
            await cancel(r.id, by=by, reason=reason, revert_status=False)
        except RunError:
            pass
    return len(runs)


_UNSET = object()


async def before_ticket_change(
    ticket_id: str,
    *,
    status: str | None = None,
    assignee=_UNSET,
    deleting: bool = False,
    by: str = "user",
) -> int:
    """A person deletes, archives or reassigns a ticket an AI works on: its runs end first, with the reason.
    Changes the AI makes itself during its run never cancel it."""
    if svc_activity.current_ai():
        return 0
    async with database.async_session() as session:
        runs = await active_runs(session, ticket_id=ticket_id)
        if not runs:
            return 0
        if deleting:
            reason, code = (
                "The ticket was deleted while the run was in progress.",
                "deleted",
            )
        elif status == "wont_do":
            reason, code = "The ticket was archived (Won't Do).", "archive"
        elif assignee is not _UNSET and all(r.member_id != assignee for r in runs):
            who = await session.get(Member, assignee) if assignee else None
            reason = (
                f"Reassigned to {who.name}." if who else "The ticket was unassigned."
            )
            code = "reassigned"
        else:
            return 0
    for r in runs:
        try:
            await cancel(
                r.id, by=by, reason=reason, revert_status=False, stop_code=code
            )
        except RunError:
            pass
    return len(runs)


async def retry(run_id: str, *, by: str, limit_min: int | None = None) -> AiRun:
    """Run again: a new run (#n+1) with the same request; an ended run is never reopened. With `limit_min` the new
    run may take that many minutes ("Raise limit" on a run that timed out)."""
    if limit_min is not None and not 1 <= limit_min <= 24 * 60:
        raise RunError("The limit must be between 1 minute and 24 hours.")
    async with database.async_session() as session:
        old = await session.get(AiRun, run_id)
        if old is None:
            raise RunError("Run not found.")
        if old.state not in ENDED:
            raise RunError(f"Run #{old.number} is still {old.state}; cancel it first.")
        return await create_run(
            session,
            ticket_id=old.ticket_id,
            member_id=old.member_id,
            mode=old.mode,
            trigger="retry",
            started_by=by,
            instruction=old.instruction,
            source_comment_id=old.source_comment_id,
            include_context=old.include_context,
            limit_min=limit_min,
        )


async def _is_paused(run_id: str) -> bool:
    async with database.async_session() as session:
        run = await session.get(AiRun, run_id)
        return bool(run and run.paused)


async def wait_while_paused(run_id: str) -> float:
    """For an agent loop: block while a person has the run paused (until resume, cancel or the end); returns the
    seconds waited, so the loop can extend its own time limit."""
    waited = 0.0
    while await _is_paused(run_id) and run_id not in RT.cancelled:
        await asyncio.sleep(0.5)
        waited += 0.5
    return waited


async def pause_run(run_id: str, *, by: str) -> AiRun:
    """Pause a running run: its CLI (and what it started) is stopped, or its agent loop waits at the next step.
    The run stays `running` with `paused` set; the time spent paused does not count against its limits."""
    async with database.async_session() as session:
        run = await session.get(AiRun, run_id)
        if run is None:
            raise RunError("Run not found.")
        if run.state != "running":
            raise RunError(
                f"Run #{run.number} is {run.state.replace('_', ' ')}; only a running run can be paused."
            )
        if run.paused:
            return run
        _, profile = await get_profile(session, run.member_id)
        proc = RT.procs.get(run_id)
        if profile and profile.connection != "api_key":
            if not cli.can_pause():
                raise RunError("Pausing a local run is not supported on Windows yet.")
            if proc is None or proc.proc is None:
                raise RunError(
                    "The run has no process to pause yet; try again in a moment."
                )
        run.paused = True
        run.paused_at = now_iso()
        session.add(run)
        await session.commit()
        await session.refresh(run)
    if proc is not None and proc.proc is not None:
        cli.suspend_tree(proc.proc.pid, stop=True)
    await _append(run_id, steps=[{"kind": "paused", "text": f"Paused by {by}"}])
    await audit.record(
        run.project_id,
        "run_paused",
        "info",
        member_id=run.member_id,
        on_behalf_of=by,
        run_id=run.id,
        target=run.ticket_id,
        detail={"by": by},
    )
    await _publish(force=True)
    return run


async def resume_run(run_id: str, *, by: str) -> AiRun:
    """Continue a paused run where it stopped."""
    async with database.async_session() as session:
        run = await session.get(AiRun, run_id)
        if run is None:
            raise RunError("Run not found.")
        if not run.paused or run.state != "running":
            raise RunError(f"Run #{run.number} is not paused.")
        run.paused = False
        run.paused_at = None
        session.add(run)
        await session.commit()
        await session.refresh(run)
    proc = RT.procs.get(run_id)
    if proc is not None and proc.proc is not None:
        cli.suspend_tree(proc.proc.pid, stop=False)
    await _append(run_id, steps=[{"kind": "resumed", "text": f"Resumed by {by}"}])
    await _publish(force=True)
    return run


async def start_now(run_id: str, *, by: str) -> AiRun:
    """Start a queued run ahead of the scheduler's next pass (it still needs a free slot, budget and a reachable
    member: when something blocks it, the reason comes back as the error)."""
    async with RT.tick_lock:
        async with database.async_session() as session:
            run = await session.get(AiRun, run_id)
            if run is None:
                raise RunError("Run not found.")
            if run.state != "queued":
                raise RunError(f"Run #{run.number} is {run.state}, not queued.")
            if run.behind_run_id:
                raise RunError(
                    f"{run.ticket_id} is held by another AI: this run starts when it releases the ticket."
                )
            member, profile = await get_profile(session, run.member_id)
            if member is None or profile is None:
                raise RunError("The AI member was removed.")
            settings = await get_settings(session, run.project_id)
            reason = await _blocking_reason(
                session, run, profile, member, settings, skip_queue=True
            )
            if reason:
                raise RunError(f"Can't start now: {reason}.")
            await _start(session, run)
            await session.refresh(run)
            return run


async def answer(run_id: str, *, by: str, text: str, via: str | None = None) -> AiRun:
    """Answer the AI's question from the board: the answer is posted as a comment, Pending clears, the run resumes
    in the same CLI session."""
    text = (text or "").strip()
    if not text:
        raise RunError("Write an answer first.")
    async with database.async_session() as session:
        run = await session.get(AiRun, run_id)
        if run is None:
            raise RunError("Run not found.")
        q = loads(run.question, {}) or {}
        if run.state == "needs_input":
            pass
        elif run.state == "timed_out" and q and not q.get("answered_at"):
            # A late answer starts a new run with the answer as its instruction
            await svc_tickets.add_comment(
                session,
                run.ticket_id,
                f"**Answer:** {text}",
                author=by,
                meta={"answer_to_run": run.id},
            )
            return await create_run(
                session,
                ticket_id=run.ticket_id,
                member_id=run.member_id,
                mode="work",
                trigger="answer",
                started_by=by,
                instruction=f"Earlier you asked: {q.get('text', '')}\nAnswer from {by}: {text}",
            )
        else:
            raise RunError("This run is not waiting for an answer.")
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
        q["answered_via"] = via or svc_activity.current_origin()
        run.question = json.dumps(q)
        run.answer = text
        member, profile = await get_profile(session, run.member_id)
        token = "kbr_" + pysecrets.token_urlsafe(24)
        run.state = "starting"
        run.token_hash = guard.token_hash(token)
        session.add(run)
        await session.commit()
        await session.refresh(run)
    note = (
        f"{by} answered your question “{q.get('text', '')}”:\n{text}\n\n"
        "Continue the work with this answer. Finish as instructed before."
    )
    if profile.connection == "api_key":
        RT.tasks[run_id] = asyncio.create_task(_resume_api(run_id, token, note))
    else:
        RT.tasks[run_id] = asyncio.create_task(_resume_cli(run_id, token, note))
    await _publish(force=True)
    return run


async def _resume_cli(run_id: str, token: str, note: str) -> None:
    try:
        await _execute_claude(run_id, token, resume_note=note)
    except Exception as exc:  # noqa: BLE001
        logger.exception("AI run %s crashed on resume", run_id)
        await _end(run_id, "failed", f"The runner failed: {redact(str(exc))[:300]}")
    finally:
        RT.tasks.pop(run_id, None)
        RT.procs.pop(run_id, None)


async def _resume_api(run_id: str, token: str, note: str) -> None:
    from . import api_agent

    try:
        await api_agent.execute(run_id, token, resume_note=note)
    except Exception as exc:  # noqa: BLE001
        logger.exception("AI run %s crashed on resume", run_id)
        await _end(run_id, "failed", f"The agent loop failed: {redact(str(exc))[:300]}")
    finally:
        RT.tasks.pop(run_id, None)


async def request_changes(
    ticket_id: str, *, by: str, text: str, continue_session: bool
) -> AiRun:
    """Review gate: send the ticket back to its AI with the reviewer's comment as the reason."""
    text = (text or "").strip()
    if not text:
        raise RunError("Say what should change.")
    async with database.async_session() as session:
        last = (
            await session.exec(
                select(AiRun)
                .where(AiRun.ticket_id == ticket_id, AiRun.mode == "work")
                .order_by(col(AiRun.number).desc())
                .limit(1)
            )
        ).first()
        if last is None:
            raise RunError("No AI run on this ticket to send back.")
        await svc_tickets.add_comment(
            session,
            ticket_id,
            f"**Changes requested:** {text}",
            author=by,
            meta={"request_changes": True},
        )
        ticket = await session.get(Ticket, ticket_id)
        if ticket and ticket.status in ("review", "testing", "done"):
            await svc_tickets.update_ticket(
                session, ticket_id, TicketUpdate(status="in-progress")
            )
        return await create_run(
            session,
            ticket_id=ticket_id,
            member_id=last.member_id,
            mode="work",
            trigger="request_changes",
            started_by=by,
            instruction=f"A reviewer requested changes:\n{text}",
            resume_session=last.session_id if continue_session else None,
        )


async def reassign_question(run_id: str, *, by: str, to_member_id: str) -> AiRun:
    """“Ask someone else”: the question goes to another person, who gets the Pending flag instead."""
    async with database.async_session() as session:
        run = await session.get(AiRun, run_id)
        if run is None:
            raise RunError("Run not found.")
        q = loads(run.question, None)
        if run.state != "needs_input" or not q:
            raise RunError("This run is not waiting for an answer.")
        person = await session.get(Member, to_member_id)
        if (
            person is None
            or person.project_id != run.project_id
            or person.kind != "human"
        ):
            raise RunError("Pick a person of this project.")
        member, _ = await get_profile(session, run.member_id)
        q["to"] = person.name
        q["asked_at"] = now_iso()  # the new person's reminders start from now
        q["reminders"] = []
        run.question = json.dumps(q)
        session.add(run)
        await session.commit()
        ticket = await session.get(Ticket, run.ticket_id)
        if ticket is not None and ticket.status not in ("done", "wont_do"):
            await svc_tickets.set_pending(
                session,
                ticket.id,
                "person",
                member_id=person.id,
                note=_clip(
                    f"{member.name if member else 'AI'} asks: {q.get('text', '')}", 240
                ),
            )
        await svc_tickets.add_comment(
            session,
            run.ticket_id,
            f"{by} asked {person.name} to answer {member.name if member else 'the AI'}'s question.",
            author=BOARD_AUTHOR,
            meta={"board_note": True},
        )
    await _append(
        run_id,
        steps=[{"kind": "question", "text": f"Question passed to {person.name}"}],
    )
    await _publish(force=True)
    async with database.async_session() as session:
        return await session.get(AiRun, run_id)


async def regenerate(
    run_id: str, *, by: str, question: str | None = None, replace: bool = False
) -> AiRun:
    """Ask again: a new answer run for the same question, or for an edited one (“Edit and re-run”). The old answer
    stays unless `replace` is set; then it is removed once the new answer is posted."""
    async with database.async_session() as session:
        old = await session.get(AiRun, run_id)
        if old is None:
            raise RunError("Run not found.")
        if old.mode != "ask":
            raise RunError("Only an answer can be regenerated; use Retry for work.")
        if old.state not in ENDED:
            raise RunError(f"Run #{old.number} is still {old.state}.")
        member, _ = await get_profile(session, old.member_id)
        text = (question or "").strip()
        source, instruction = old.source_comment_id, old.instruction
        if text and text != (old.instruction or "").strip():
            ticket = await svc_tickets.add_comment(
                session,
                old.ticket_id,
                f"@[{member.name}](member:{member.id}) {text}",
                author=by,
                meta={"asked_ai": member.id},
            )
            source = loads(ticket.comments, [])[-1]["id"]
            instruction = text
        return await create_run(
            session,
            ticket_id=old.ticket_id,
            member_id=old.member_id,
            mode="ask",
            trigger="regenerate",
            started_by=by,
            instruction=instruction,
            source_comment_id=source,
            include_context=old.include_context,
            replaces_comment_id=old.reply_comment_id if replace else None,
        )


FEEDBACK_REASONS = ("incorrect", "out_of_date", "missed_context", "too_long", "unsafe")


async def set_feedback(
    run_id: str, *, by: str, rating: str, reasons: list[str] | None = None
) -> AiRun:
    """A thumbs up or down on an answer, with the reasons for a thumbs down. `none` takes it back."""
    if rating not in ("up", "down", "none"):
        raise RunError("rating must be up, down or none")
    async with database.async_session() as session:
        run = await session.get(AiRun, run_id)
        if run is None:
            raise RunError("Run not found.")
        run.feedback = (
            None
            if rating == "none"
            else json.dumps(
                {
                    "rating": rating,
                    "reasons": [r for r in (reasons or []) if r in FEEDBACK_REASONS]
                    if rating == "down"
                    else [],
                    "by": by,
                    "at": now_iso(),
                }
            )
        )
        session.add(run)
        await session.commit()
        await session.refresh(run)
        return run


async def mark_blocked_move(run_id: str, target: str) -> None:
    """The AI tried to move the ticket past its ceiling: remember it, so the board can tell the person."""
    await _append(run_id, blocked_move=target)
    await _publish(force=True)


async def note_person_edit(ticket_id: str, *, by: str, what: str) -> int:
    """A person edited a ticket an AI is working on: every active work run records it, and an API-key agent gets the
    new ticket text at its next step (a CLI run reads the ticket through the board's tools, which are always
    current). Returns how many runs were told."""
    if svc_activity.current_ai():
        return 0
    async with database.async_session() as session:
        active = [
            r
            for r in await active_runs(session, ticket_id=ticket_id)
            if r.mode == "work" and r.state in ("starting", "running", "needs_input")
        ]
    for r in active:
        steps = loads(r.steps, [])
        notes = loads(r.context_notes, [])
        notes.append(
            {
                "at": now_iso(),
                "by": by,
                "what": what,
                "step": len(steps),
                "delivered": False,
            }
        )
        await _append(
            r.id,
            steps=[{"kind": "context", "text": f"{by} edited {what}"}],
            context_notes=json.dumps(notes[-20:]),
        )
    return len(active)


async def take_context_notes(run_id: str) -> str | None:
    """For an agent loop: the text to show the model when a person edited the ticket since its last step (the
    ticket as it is now), or None. The notes are marked delivered."""
    async with database.async_session() as session:
        run = await session.get(AiRun, run_id)
        if run is None:
            return None
        notes = loads(run.context_notes, [])
        fresh = [n for n in notes if not n.get("delivered")]
        if not fresh:
            return None
        ticket = await session.get(Ticket, run.ticket_id)
        names = await ai_names(session, run.project_id)
        block = ticket_block(ticket, names) if ticket else ""
        for n in notes:
            n["delivered"] = True
        steps = loads(run.steps, [])
        run.context_notes = json.dumps(notes)
        session.add(run)
        await session.commit()
    await _append(
        run_id,
        steps=[
            {
                "kind": "context",
                "text": f"Context refreshed at step {len(steps)}",
            }
        ],
    )
    who = ", ".join(dict.fromkeys(n["by"] for n in fresh))
    return (
        f"{who} edited the ticket while you were working. Its text now (people's edits win; do not overwrite them):\n"
        f"{block}"
    )


async def refresh_context(run_id: str, *, by: str) -> AiRun:
    """“Refresh context now”: the run gets the ticket as it is, at its next step."""
    async with database.async_session() as session:
        run = await session.get(AiRun, run_id)
        if run is None:
            raise RunError("Run not found.")
        if run.state not in ("starting", "running", "needs_input"):
            raise RunError(f"Run #{run.number} is not working.")
    notes = loads(run.context_notes, [])
    notes.append(
        {
            "at": now_iso(),
            "by": by,
            "what": "the ticket (refresh requested)",
            "step": len(loads(run.steps, [])),
            "delivered": False,
        }
    )
    run = await _append(run_id, context_notes=json.dumps(notes[-20:]))
    return run


# ---------------------------------------------------------------------------
# Kill switch
# ---------------------------------------------------------------------------


async def revoke_tokens(project_id: str, member_ids: list[str], *, by: str) -> int:
    """Revoke the MCP tokens of AI members: a live run's calls are refused at once and the member cannot start a
    run until someone reconnects it (I5)."""
    n = 0
    async with database.async_session() as session:
        for mid in member_ids:
            profile = await session.get(AiMember, mid)
            if profile is None or profile.project_id != project_id:
                continue
            profile.token_revoked_at = now_iso()
            profile.token_revoked_by = by
            session.add(profile)
            n += 1
        await session.commit()
    for mid in member_ids:
        member_name = ""
        async with database.async_session() as session:
            member = await session.get(Member, mid)
            member_name = member.name if member else ""
        await audit.record(
            project_id,
            "token_revoked",
            "info",
            member_id=mid,
            member_name=member_name,
            on_behalf_of=by,
            detail={"by": by},
        )
        await safety.notify(
            project_id,
            "offline",
            f"Token revoked for {member_name}",
            f"{by} revoked the MCP token of {member_name}. It stops at its next call; reconnect it to work again.",
            ref_kind="member",
            ref_id=mid,
            member_id=mid,
        )
    return n


async def reconnect(member_id: str, *, by: str) -> AiMember:
    """Issue the member a fresh connection after its token was revoked."""
    async with database.async_session() as session:
        profile = await session.get(AiMember, member_id)
        if profile is None:
            raise RunError("AI member not found.")
        profile.token_revoked_at = None
        profile.token_revoked_by = None
        session.add(profile)
        await session.commit()
        await session.refresh(profile)
    await audit.record(
        profile.project_id,
        "token_reconnected",
        "info",
        member_id=member_id,
        on_behalf_of=by,
        detail={"by": by},
    )
    RT.wake.set()
    await _publish(force=True)
    return profile


async def pause_all(
    project_id: str,
    *,
    by: str,
    reason: str,
    cancel_running: bool,
    revoke: bool = False,
) -> dict:
    """Pause all AI in a project: nothing new starts, @mentions are not delivered, running runs stop or finish."""
    async with database.async_session() as session:
        settings = await get_settings(session, project_id)
        settings.paused_all = True
        settings.paused_at = now_iso()
        settings.paused_by = by
        settings.paused_reason = (reason or "").strip()[:300] or None
        session.add(settings)
        await session.commit()
        runs = (
            await session.exec(
                select(AiRun).where(
                    AiRun.project_id == project_id,
                    col(AiRun.state).in_(["starting", "running"]),
                )
            )
        ).all()
        queued = (
            await session.exec(
                select(AiRun).where(
                    AiRun.project_id == project_id, AiRun.state == "queued"
                )
            )
        ).all()
    cancelled = 0
    if cancel_running:
        for r in runs:
            try:
                await cancel(
                    r.id, by=by, reason=f"Pause all AI by {by}", revert_status=False
                )
                cancelled += 1
            except RunError:
                pass
    revoked = 0
    if revoke:
        async with database.async_session() as session:
            ids = [
                p.id
                for p in (
                    await session.exec(
                        select(AiMember).where(AiMember.project_id == project_id)
                    )
                ).all()
            ]
        revoked = await revoke_tokens(project_id, ids, by=by)
    async with database.async_session() as session:
        settings = await get_settings(session, project_id)
        settings.paused_cancelled = cancelled
        settings.paused_held = len(queued)
        settings.paused_tokens_revoked = revoke
        session.add(settings)
        await session.commit()
    await audit.record(
        project_id,
        "kill_switch",
        "info",
        member_name=by,
        on_behalf_of=by,
        detail={
            "reason": reason,
            "cancelled": cancelled,
            "held": len(queued),
            "revoked_tokens": revoked,
        },
    )
    await safety.notify(
        project_id,
        "auto_trip",
        "AI is paused",
        f"{by} paused all AI. {cancelled} run cancelled, {len(queued)} queued runs held."
        + (f" Reason: {reason}." if reason else ""),
    )
    await _publish(force=True)
    return {"cancelled": cancelled, "held": len(queued), "revoked_tokens": revoked}


async def resume_all(
    project_id: str, *, by: str, safe_mode: bool, member_ids: list[str] | None
) -> dict:
    """Resume after Pause all AI: optionally in safe mode, optionally only some agents (the others are paused)."""
    async with database.async_session() as session:
        settings = await get_settings(session, project_id)
        settings.paused_all = False
        settings.paused_tokens_revoked = False
        settings.safe_mode = bool(safe_mode)
        session.add(settings)
        profiles = (
            await session.exec(
                select(AiMember).where(AiMember.project_id == project_id)
            )
        ).all()
        resumed = 0
        skipped: list[str] = []
        for p in profiles:
            if member_ids is not None and p.id not in member_ids:
                if not p.paused:
                    p.paused, p.paused_at, p.paused_reason = (
                        True,
                        now_iso(),
                        "Not resumed after Pause all AI",
                    )
                    session.add(p)
                continue
            if await budget.blocked(session, p, settings):
                # Over budget stays out until it resets or the budget is raised (D3)
                skipped.append(p.id)
                continue
            if p.paused:
                p.paused, p.paused_at, p.paused_reason = False, None, None
                session.add(p)
            if p.token_revoked_at:
                # Resuming an agent reconnects it with a fresh token
                p.token_revoked_at = p.token_revoked_by = None
                session.add(p)
            resumed += 1
        await session.commit()
    await audit.record(
        project_id,
        "resume_all",
        "info",
        member_name=by,
        on_behalf_of=by,
        detail={"safe_mode": safe_mode, "members": member_ids, "skipped": skipped},
    )
    RT.wake.set()
    await _publish(force=True)
    return {"resumed": resumed, "skipped": skipped}


# ---------------------------------------------------------------------------
# Called by the agent through the ai_run MCP tool
# ---------------------------------------------------------------------------


def question_options(options: list | None) -> tuple[list[str], list[dict]]:
    """Choices of a question: plain labels, and the details (a line of description, one marked recommended) when the
    agent gave them as {label, description, recommended}."""
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
                {
                    "label": label,
                    "description": description,
                    "recommended": recommended,
                }
            )
    return labels[:6], details[:6]


async def record_question(ctx: RunContext, text: str, options: list | None) -> dict:
    """The agent asks a person: the run ends in Needs input when its process stops."""
    text = (text or "").strip()
    if not text:
        raise ValueError("ai_run(action='ask') needs `question`.")
    if ctx.mode == "ask":
        raise ValueError(
            "An ask run cannot ask back; answer with what you know and say what is missing."
        )
    labels, details = question_options(options)
    q = {
        "text": text[:1000],
        "options": labels,
        "option_details": details,
        "to": ctx.on_behalf_of,
        "asked_at": now_iso(),
    }
    await _append(ctx.run_id, question=json.dumps(q))
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


async def record_handoff(
    ctx: RunContext, member_ref: str, ticket_ref: str | None, instruction: str
) -> dict:
    """The agent hands a ticket to a teammate AI: it assigns the ticket (a permission check like any assignment) and
    queues a work run for them, behind this run when the ticket is this run's own. They answer on the ticket."""
    from . import guard

    if ctx.mode == "ask":
        raise ValueError(
            "An ask run cannot hand work over; say in your answer who should do it next."
        )
    ref = (member_ref or "").strip()
    if not ref:
        raise ValueError(
            "ai_run(action='handoff') needs `member` (the teammate's exact name)."
        )
    ticket_id = (ticket_ref or ctx.ticket_id).strip()
    async with database.async_session() as session:
        ticket = await session.get(Ticket, ticket_id)
        if ticket is None or ticket.project_id != ctx.project_id:
            raise ValueError(f"Ticket {ticket_id} was not found in this project.")
        rows = (
            await session.exec(
                select(Member).where(
                    Member.project_id == ctx.project_id, Member.kind == "ai"
                )
            )
        ).all()
        target = next(
            (m for m in rows if m.id == ref or m.name.casefold() == ref.casefold()),
            None,
        )
        if target is None:
            raise ValueError(
                f"No AI member named '{ref}'. Teammates: {', '.join(sorted(m.name for m in rows))}."
            )
        if target.id == ctx.member_id:
            raise ValueError("You cannot hand a ticket to yourself.")
        profile = await session.get(AiMember, target.id)
        if profile is None or profile.connection == "inbox":
            raise ValueError(
                f"{target.name} is an MCP client with an inbox only: the board cannot start it."
            )
        if (await get_settings(session, ctx.project_id)).paused_all:
            raise ValueError(
                "AI is paused for this project; a person resumes it in the board."
            )
    tokens = guard.enter(ctx) if guard.current() is None else None
    try:
        if ticket.assignee != target.id:
            # handing over is assigning: the member's permission (or a person's approval) decides; handing back to
            # someone who handed work down to this run (up the chain) is always allowed
            if target.id not in ctx.chain:
                await guard.check(
                    ctx,
                    "manage_ticket",
                    "update",
                    {"ticket_id": ticket_id, "assignee": target.id},
                )
            async with database.async_session() as session:
                await svc_tickets.update_ticket(
                    session, ticket_id, TicketUpdate(assignee=target.id)
                )
        async with database.async_session() as session:
            mine = await session.get(AiRun, ctx.run_id)
            # Who is told when this work ends: for another ticket, the sender (to check it and carry on); for the
            # same ticket the sender's own duty passes along with the baton and the last one to finish reports
            if ticket_id != ctx.ticket_id:
                back = {"member_id": ctx.member_id, "ticket_id": ctx.ticket_id}
            else:
                back = loads(mine.report_back, None) if mine else None
                if mine is not None and back:
                    mine.report_back = None
                    session.add(mine)
            try:
                run = await create_run(
                    session,
                    ticket_id=ticket_id,
                    member_id=target.id,
                    mode="work",
                    trigger="handoff",
                    started_by=ctx.on_behalf_of,
                    instruction=(instruction or "").strip()[:2000],
                    chain=[*ctx.chain, ctx.member_id],
                    wait_for_hold=True,
                    report_back=back,
                )
            except RunError as exc:
                await session.rollback()
                raise ValueError(str(exc)) from exc
    finally:
        if tokens is not None:
            guard.leave(tokens)
    await audit.record(
        ctx.project_id,
        "handoff",
        "allowed",
        member_id=ctx.member_id,
        member_name=ctx.member_name,
        on_behalf_of=ctx.on_behalf_of,
        run_id=ctx.run_id,
        target=ticket_id,
        detail={"to": target.name, "run": run.number},
    )
    return {
        "ok": True,
        "ticket": ticket_id,
        "member": target.name,
        "run": run.number,
        "note": f"{target.name} is queued to work on {ticket_id}"
        + (" after you finish." if ticket_id == ctx.ticket_id else "."),
    }


def _clean_tests(tests) -> dict | None:
    """The agent's claim about tests, reduced to {passed, failed, lint, failing[]}."""
    if not isinstance(tests, dict):
        return None

    def count(key: str) -> int:
        try:
            return max(0, int(tests.get(key) or 0))
        except (TypeError, ValueError):
            return 0

    out: dict = {"passed": count("passed"), "failed": count("failed")}
    if tests.get("lint"):
        out["lint"] = str(tests["lint"])[:60]
    failing = tests.get("failing")
    if isinstance(failing, list):
        out["failing"] = [str(f)[:160] for f in failing][:8]
    return out


async def record_report(
    ctx: RunContext, summary: str, criteria: list[dict] | None, tests: dict | None
) -> dict:
    """The agent's own account of what it did; shown as the AI summary (a claim, not proof)."""
    report = {
        "summary": redact((summary or "").strip())[:8000],
        "criteria": [
            {
                "text": str(c.get("text", ""))[:300],
                "met": c.get("met"),
                "evidence": str(c.get("evidence") or "")[:300],
            }
            for c in (criteria or [])
            if isinstance(c, dict)
        ][:30],
        "tests": _clean_tests(tests),
    }
    await _append(
        ctx.run_id,
        steps=[{"kind": "report", "text": "Wrote the summary"}],
        report=json.dumps(report),
    )
    return {"recorded": True, "next": "End with a short final message."}


# ---------------------------------------------------------------------------
# Reading
# ---------------------------------------------------------------------------


async def list_runs(
    session,
    *,
    project_id: str | None = None,
    ticket_id: str | None = None,
    member_id: str | None = None,
    active_only: bool = False,
    limit: int = 100,
) -> list[AiRun]:
    """Runs, newest first."""
    stmt = select(AiRun)
    if project_id:
        stmt = stmt.where(AiRun.project_id == project_id)
    if ticket_id:
        stmt = stmt.where(AiRun.ticket_id == ticket_id)
    if member_id:
        stmt = stmt.where(AiRun.member_id == member_id)
    if active_only:
        stmt = stmt.where(col(AiRun.state).in_(list(ACTIVE)))
    stmt = stmt.order_by(col(AiRun.queued_at).desc()).limit(limit)
    return list((await session.exec(stmt)).all())


async def latest_by_ticket(session, project_id: str) -> dict[str, dict]:
    """For the board: each ticket's active run, or its most recent work run of the last 7 days."""
    since = (datetime.now(UTC) - timedelta(days=7)).isoformat()
    rows = (
        await session.exec(
            select(AiRun)
            .where(AiRun.project_id == project_id)
            .where((col(AiRun.state).in_(list(ACTIVE))) | (AiRun.queued_at >= since))
            .order_by(col(AiRun.queued_at))
        )
    ).all()
    names = await _names(session, [r.member_id for r in rows])
    out: dict[str, dict] = {}
    for r in rows:
        cur = out.get(r.ticket_id)
        if r.mode == "ask" and cur is not None:
            continue
        if cur is not None and cur["state"] in ACTIVE and r.state not in ACTIVE:
            continue
        if r.behind_run_id and cur is not None:
            continue  # a second AI waiting for the holder: the card shows the holder
        d = to_dict(r, names.get(r.member_id))
        d.pop("steps", None)
        d["step_count"] = len(loads(r.steps, []))
        out[r.ticket_id] = d
    estimates = await step_estimates(session, rows)
    queue = await queue_info(session, [r for r in rows if r.state == "queued"])
    for d in out.values():
        d["step_estimate"] = estimates.get(d["member_id"])
        d.update(queue.get(d["id"], {}))
    return out


def status_label(status: str) -> str:
    """Human label of a status."""
    return STATUS_LABELS.get(status, status)
