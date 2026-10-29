"""Docs AI jobs: one row per Docs AI call, the Docs counterpart of an AI run.

A feature module registers a handler for its job kind (`HANDLERS["check"] = handler`). `start()` creates the row and
runs the handler in the background; the handler returns a result dict and calls `engine.call(job_id=...)`, which adds
tokens, cost, the session and the pages read to the row. Jobs are what the Activity view, the "Read" chips and the
MCP `ai_team` tool report.
"""

import asyncio
import json
import logging
from collections.abc import Awaitable, Callable
from typing import Any

from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

import database
import events as board_events
from models import DocsAiJob
from services.ai.store import loads, now_iso

from .errors import DocsAiError

log = logging.getLogger(__name__)

Handler = Callable[[DocsAiJob], Awaitable[dict[str, Any] | None]]
HANDLERS: dict[str, Handler] = {}
TASKS: dict[str, asyncio.Task] = {}
ACTIVE = ("queued", "running")
MAX_STEPS = 40


def handler(kind: str) -> Callable[[Handler], Handler]:
    """Register the function that does a kind of job."""

    def wrap(fn: Handler) -> Handler:
        HANDLERS[kind] = fn
        return fn

    return wrap


async def _publish() -> None:
    await board_events.publish(board_events.INVALIDATE)


def to_dict(j: DocsAiJob) -> dict[str, Any]:
    """The job as the API and MCP show it."""
    return {
        "id": j.id,
        "project_id": j.project_id,
        "page_id": j.page_id,
        "thread_id": j.thread_id,
        "comment_id": j.comment_id,
        "member_id": j.member_id,
        "kind": j.kind,
        "state": j.state,
        "started_by": j.started_by,
        "instruction": j.instruction,
        "reads": loads(j.reads, []),
        "steps": loads(j.steps, []),
        "result": loads(j.result, {}),
        "error": loads(j.error, {}),
        "tokens_in": j.tokens_in,
        "tokens_out": j.tokens_out,
        "cost": round(j.cost_usd, 6),
        "metered": j.metered,
        "reply_comment_id": j.reply_comment_id,
        "queued_at": j.queued_at,
        "started_at": j.started_at,
        "ended_at": j.ended_at,
    }


async def create(
    session: AsyncSession,
    *,
    project_id: str,
    kind: str,
    started_by: str,
    page_id: str | None = None,
    thread_id: str | None = None,
    comment_id: str | None = None,
    member_id: str | None = None,
    instruction: str = "",
    result: dict[str, Any] | None = None,
) -> DocsAiJob:
    """Record a job (queued). `start` runs it."""
    job = DocsAiJob(
        project_id=project_id,
        kind=kind,
        started_by=started_by,
        page_id=page_id,
        thread_id=thread_id,
        comment_id=comment_id,
        member_id=member_id,
        instruction=instruction[:8000],
        result=json.dumps(result or {}),
    )
    session.add(job)
    await session.commit()
    await session.refresh(job)
    return job


def spawn(job_id: str) -> None:
    """Run a job in the background."""
    task = asyncio.create_task(run(job_id))
    TASKS[job_id] = task
    task.add_done_callback(
        lambda t: TASKS.pop(job_id, None) if TASKS.get(job_id) is t else None
    )


async def start(session: AsyncSession, **kw: Any) -> DocsAiJob:
    """Create a job and run it in the background."""
    job = await create(session, **kw)
    spawn(job.id)
    await _publish()
    return job


async def run(job_id: str) -> None:
    """Do the job: mark it running, call its handler, record the result or the error."""
    async with database.async_session() as session:
        job = await session.get(DocsAiJob, job_id)
        if job is None or job.state != "queued":
            return
        job.state = "running"
        job.started_at = now_iso()
        session.add(job)
        await session.commit()
        await session.refresh(job)
    fn = HANDLERS.get(job.kind)
    try:
        if fn is None:
            raise DocsAiError("unavailable", f"No handler for {job.kind} jobs.")
        result = await fn(job)
    except asyncio.CancelledError:
        await finish(
            job_id,
            state="cancelled",
            error={"code": "cancelled", "message": "Stopped."},
        )
        raise
    except DocsAiError as exc:
        await finish(
            job_id,
            state="failed",
            error={"code": exc.code, "message": str(exc), **exc.extra},
        )
        return
    except Exception as exc:  # noqa: BLE001 - a job that fails must say so
        log.exception("Docs AI job %s (%s) failed", job_id, job.kind)
        await finish(
            job_id,
            state="failed",
            error={
                "code": "error",
                "message": f"Couldn't finish ({type(exc).__name__}).",
            },
        )
        return
    await finish(job_id, state="finished", result=result)


async def finish(
    job_id: str,
    *,
    state: str,
    result: dict[str, Any] | None = None,
    error: dict[str, Any] | None = None,
) -> None:
    """Close a job. `result` merges into what the handler already stored."""
    async with database.async_session() as session:
        job = await session.get(DocsAiJob, job_id)
        if job is None:
            return
        job.state = state
        job.ended_at = now_iso()
        if result is not None:
            job.result = json.dumps({**loads(job.result, {}), **result})
        if error is not None:
            job.error = json.dumps(error)
        session.add(job)
        await session.commit()
    await _publish()


async def update(job_id: str, **fields: Any) -> None:
    """Set columns of a job (JSON columns take Python values)."""
    async with database.async_session() as session:
        job = await session.get(DocsAiJob, job_id)
        if job is None:
            return
        for k, v in fields.items():
            setattr(
                job,
                k,
                json.dumps(v) if k in ("reads", "steps", "result", "error") else v,
            )
        session.add(job)
        await session.commit()


async def add_step(job_id: str, text: str) -> None:
    """Append a visible step ("Reading Architecture › API")."""
    async with database.async_session() as session:
        job = await session.get(DocsAiJob, job_id)
        if job is None:
            return
        steps = loads(job.steps, [])
        steps.append({"at": now_iso(), "text": text})
        job.steps = json.dumps(steps[-MAX_STEPS:])
        session.add(job)
        await session.commit()
    await _publish()


async def set_reads(job_id: str, reads: list[dict[str, Any]]) -> None:
    """Pages the job read (shown as "Read" chips)."""
    await update(job_id, reads=reads)


async def account(job_id: str, out: Any, *, member_id: str | None = None) -> None:
    """Add a completion's tokens and cost to the job."""
    async with database.async_session() as session:
        job = await session.get(DocsAiJob, job_id)
        if job is None:
            return
        job.tokens_in += int(getattr(out, "tokens_in", 0) or 0)
        job.tokens_out += int(getattr(out, "tokens_out", 0) or 0)
        job.cost_usd = round(job.cost_usd + float(getattr(out, "cost", 0) or 0), 6)
        job.metered = bool(job.metered or getattr(out, "metered", False))
        if member_id:
            job.member_id = member_id
        session.add(job)
        await session.commit()


async def get(session: AsyncSession, job_id: str) -> DocsAiJob:
    """A job, or `not_found`."""
    job = await session.get(DocsAiJob, job_id)
    if job is None:
        raise DocsAiError("not_found", "That Docs AI job does not exist.")
    return job


async def list_jobs(
    session: AsyncSession,
    project_id: str,
    *,
    page_id: str | None = None,
    thread_id: str | None = None,
    kind: str | None = None,
    state: str | None = None,
    member_id: str | None = None,
    limit: int = 50,
) -> list[DocsAiJob]:
    """Newest first."""
    stmt = select(DocsAiJob).where(DocsAiJob.project_id == project_id)
    for column, value in (
        (DocsAiJob.page_id, page_id),
        (DocsAiJob.thread_id, thread_id),
        (DocsAiJob.kind, kind),
        (DocsAiJob.state, state),
        (DocsAiJob.member_id, member_id),
    ):
        if value:
            stmt = stmt.where(column == value)
    stmt = stmt.order_by(col(DocsAiJob.queued_at).desc()).limit(max(1, min(limit, 200)))
    return list((await session.exec(stmt)).all())


async def cancel(session: AsyncSession, job_id: str, by: str) -> DocsAiJob:
    """Stop a queued or running job."""
    job = await get(session, job_id)
    if job.state not in ACTIVE:
        return job
    task = TASKS.get(job_id)
    if task and not task.done():
        task.cancel()
    job.state = "cancelled"
    job.ended_at = now_iso()
    job.error = json.dumps({"code": "cancelled", "message": f"Stopped by {by}."})
    session.add(job)
    await session.commit()
    await session.refresh(job)
    await _publish()
    return job


async def recover() -> None:
    """After a restart, jobs that were still going are marked failed so nothing spins forever."""
    async with database.async_session() as session:
        rows = (
            await session.exec(
                select(DocsAiJob).where(col(DocsAiJob.state).in_(list(ACTIVE)))
            )
        ).all()
        for j in rows:
            j.state = "failed"
            j.ended_at = now_iso()
            j.error = json.dumps(
                {
                    "code": "restart",
                    "message": "The board restarted before this finished. Try again.",
                }
            )
            session.add(j)
        if rows:
            await session.commit()
