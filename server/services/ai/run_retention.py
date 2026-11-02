"""How long a project keeps its finished AI runs (Settings › AI › Running the team › History; OPS-7).

`AiProjectSettings.run_retention_days` is None by default: every run is kept forever, as always. Only when a person
picks a number of days does the hourly sweep (and the first one after the server starts) remove the project's
finished runs that ended longer ago than that.

What is never removed:
- a run that is not finished: queued, starting, running, waiting for an answer (needs_input) or paused;
- a run that ended this calendar month (UTC): the monthly budgets add up the runs of the month;
- a run another record still points at to work: a run waiting behind it, a workflow step or arbitration, an approval,
  a lesson learned from it, a Docs proposal or an idea comment it wrote, a pinned transcript.

The records that point at a run are never removed with it: audit-log entries (a hash chain, kept by their own
retention), ticket comments and their run link, workflow steps, skill-use counts. They keep their own copy of what
they say (the comment's text and cost, the audit entry's detail); a comment whose run is gone shows without the run
card. A removed run's unpinned transcript (its row and file) goes with it.
"""

from datetime import UTC, datetime, timedelta
from pathlib import Path

from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

import database
from services.ai import transcripts
from models import (
    AiApproval,
    AiLesson,
    AiProjectSettings,
    AiRun,
    AiRunTranscript,
    AiTicketStep,
    AiTicketWorkflow,
    DocsAiProposal,
    IdeaComment,
)

# The choices of the setting; None (or 0 from the API) keeps runs forever
CHOICES = (30, 90, 180, 365)
FINISHED = ("finished", "failed", "cancelled", "timed_out")


def _month_start(now: datetime) -> datetime:
    return now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)


async def _referenced(session: AsyncSession, ids: list[str]) -> set[str]:
    """The run ids among `ids` that another record still points at to work."""
    if not ids:
        return set()
    found: set[str] = set()
    checks = (
        (AiRun, AiRun.behind_run_id),
        (AiTicketStep, AiTicketStep.run_id),
        (AiTicketWorkflow, AiTicketWorkflow.arbitration_run_id),
        (AiApproval, AiApproval.run_id),
        (AiLesson, AiLesson.source_run_id),
        (DocsAiProposal, DocsAiProposal.run_id),
        (IdeaComment, IdeaComment.run_id),
    )
    for i in range(0, len(ids), 400):
        chunk = ids[i : i + 400]
        for _model, column in checks:
            rows = (await session.exec(select(column).where(column.in_(chunk)))).all()
            found.update(r for r in rows if r)
        pinned = (
            await session.exec(
                select(AiRunTranscript.run_id).where(
                    col(AiRunTranscript.run_id).in_(chunk),
                    AiRunTranscript.pinned == True,  # noqa: E712
                )
            )
        ).all()
        found.update(pinned)
    return found


async def plan(
    session: AsyncSession,
    project_id: str,
    days: int | None,
    now: datetime | None = None,
) -> dict:
    """What a retention of `days` would remove now: {days, remove: [run ids], oldest, kept_linked, kept_month}.
    `days` None keeps everything."""
    now = now or datetime.now(UTC)
    out = {
        "days": days,
        "remove": [],
        "oldest": None,
        "kept_linked": 0,
        "kept_month": 0,
    }
    if not days:
        return out
    cutoff = (now - timedelta(days=days)).isoformat()
    month = _month_start(now).isoformat()
    old = (
        await session.exec(
            select(AiRun).where(
                AiRun.project_id == project_id,
                col(AiRun.state).in_(FINISHED),
                col(AiRun.ended_at).is_not(None),
                col(AiRun.ended_at) < cutoff,
                AiRun.paused == False,  # noqa: E712
            )
        )
    ).all()
    this_month = [r for r in old if r.ended_at >= month]
    rest = [r for r in old if r.ended_at < month]
    linked = await _referenced(session, [r.id for r in rest])
    gone = [r for r in rest if r.id not in linked]
    out["remove"] = [r.id for r in gone]
    out["oldest"] = min((r.ended_at for r in gone), default=None)
    out["kept_linked"] = len(rest) - len(gone)
    out["kept_month"] = len(this_month)
    return out


async def sweep(now: datetime | None = None) -> int:
    """Remove the finished runs past each project's retention (projects with none set are not touched)."""
    removed = 0
    async with database.async_session() as session:
        settings = (
            await session.exec(
                select(AiProjectSettings).where(
                    col(AiProjectSettings.run_retention_days).is_not(None)
                )
            )
        ).all()
        for s in settings:
            if not s.run_retention_days:
                continue
            p = await plan(session, s.project_id, s.run_retention_days, now)
            for run_id in p["remove"]:
                run = await session.get(AiRun, run_id)
                if run is None or run.state not in FINISHED:
                    continue  # it changed since the plan (a retry reopened nothing, but be sure)
                tr = await session.get(AiRunTranscript, run_id)
                if tr is not None and not tr.pinned:
                    if tr.path and not tr.deleted_at:
                        transcripts._existing(Path(tr.path)).unlink(missing_ok=True)
                    await session.delete(tr)
                await session.delete(run)
                removed += 1
            await session.commit()
    return removed
