"""How long a project keeps the details of its finished AI runs (Settings › AI › Running the team › History; OPS-7).

`AiProjectSettings.run_retention_days` is None by default: every run is kept whole forever, as always. Only when a
person picks a number of days does the hourly sweep (and the first one after the server starts) trim the project's
finished runs that ended longer ago than that.

Trimming keeps the run (`AiRun`) and removes only its heavy details:
- its transcript (the compressed file; its row stays and says when it was removed, as the transcript retention does);
- its steps log, the prompt it was given, the notes and restarts and retries of its process, the board's diagnosis.
The row is marked `details_removed_at`, and the run detail says "details removed" where it would show them.

What stays, so nothing a person sees elsewhere changes: the run's number, status, times, cost and tokens (the budgets,
usage history and Story counts sum them), its summary, report, question and answer, files, feedback, and every link
to it (ticket comments, audit entries, workflow steps, schedule runs, decisions, Story records). Its search entry is
rebuilt from what stays.

What is never trimmed:
- a run that is not finished: queued, starting, running, waiting for an answer (needs_input) or paused;
- a run that started this budget month (local time, `budget.month_start`): the monthly budgets add up those runs;
- a run another record still works from: a run waiting behind it, a workflow step or arbitration, an approval, a
  lesson learned from it, a Docs proposal or an idea comment it wrote, a pinned transcript.
"""

from datetime import UTC, datetime, timedelta
from pathlib import Path

from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

import database
from services.ai import budget, transcripts
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

# The choices of the setting; None (or 0 from the API) keeps runs whole forever
CHOICES = (30, 90, 180, 365)
FINISHED = ("finished", "failed", "cancelled", "timed_out")


async def _referenced(session: AsyncSession, ids: list[str]) -> set[str]:
    """The run ids among `ids` that another record still works from."""
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
    """What a retention of `days` would trim now: {days, remove: [run ids], oldest, kept_linked, kept_month}.
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
    # The budget month starts at local midnight on the 1st and sums spend by `started_at`: compare the same way
    month = budget.month_start(now).isoformat()
    old = (
        await session.exec(
            select(AiRun).where(
                AiRun.project_id == project_id,
                col(AiRun.state).in_(FINISHED),
                col(AiRun.ended_at).is_not(None),
                col(AiRun.ended_at) < cutoff,
                AiRun.paused == False,  # noqa: E712
                col(AiRun.details_removed_at).is_(None),
            )
        )
    ).all()

    def in_month(r: AiRun) -> bool:
        return (r.started_at or r.ended_at or "") >= month

    this_month = [r for r in old if in_month(r)]
    rest = [r for r in old if not in_month(r)]
    linked = await _referenced(session, [r.id for r in rest])
    gone = [r for r in rest if r.id not in linked]
    out["remove"] = [r.id for r in gone]
    out["oldest"] = min((r.ended_at for r in gone), default=None)
    out["kept_linked"] = len(rest) - len(gone)
    out["kept_month"] = len(this_month)
    return out


async def trim(session: AsyncSession, run: AiRun, at: str) -> None:
    """Remove a finished run's details and keep the run (see the module doc). The caller commits."""
    tr = await session.get(AiRunTranscript, run.id)
    if tr is not None and not tr.pinned and not tr.deleted_at:
        if tr.path:
            transcripts._existing(Path(tr.path)).unlink(missing_ok=True)
        tr.deleted_at = at
        tr.bytes = 0
        session.add(tr)
    run.steps = "[]"
    run.instruction = ""
    run.context_notes = "[]"
    run.restarts = "[]"
    run.retries = "[]"
    run.diagnosis = None
    run.details_removed_at = at
    session.add(run)
    await transcripts.index(session, run, [])


async def sweep(now: datetime | None = None) -> int:
    """Trim the finished runs past each project's retention (projects with none set are not touched)."""
    removed = 0
    at = (now or datetime.now(UTC)).isoformat()
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
                if run is None or run.state not in FINISHED or run.details_removed_at:
                    continue  # it changed since the plan
                await trim(session, run, at)
                removed += 1
            await session.commit()
    return removed
