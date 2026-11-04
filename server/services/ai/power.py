"""The computer's sleep (plan: "Máy ngủ"). The desktop app keeps the machine awake while an AI runs and, when the
machine wakes, asks the board to look at every run it thinks is running: a CLI that did not survive the sleep is ended
the way the board ends one whose process died (the reader sees the end and the retry and watchdog paths take over)."""

from sqlmodel import col, func, select

from models import AiRun

# a run waiting for a person (needs_input) or queued behind a pause or a cap does not need the machine; one queued
# for a free slot starts as soon as a running one ends, which keeps it awake meanwhile
LIVE = ("starting", "running")


async def active_runs(session) -> int:
    """How many runs are starting or running."""
    return (
        await session.exec(
            select(func.count()).select_from(AiRun).where(col(AiRun.state).in_(LIVE))
        )
    ).one()


async def after_wake(session) -> dict:
    """Check each run the board thinks is running. Returns {"checked": n, "alive": [...], "dead": [...], "orphans":
    [...]}: `dead` had a CLI process of the board's that is gone (it is stopped so the run is resumed or ended by its
    kind), `orphans` have no process or task at all (ended as after a crash)."""
    from . import cli, runs

    rows = (
        await session.exec(
            select(AiRun).where(col(AiRun.state).in_(["starting", "running"]))
        )
    ).all()
    alive, dead, orphans = [], [], []
    for run in rows:
        proc = runs.RT.procs.get(run.id)
        if proc is not None:
            up = proc.proc is not None and proc.proc.returncode is None
            if up:
                alive.append(run.id)
                continue
            dead.append(run.id)
            runs.transcripts.note(
                run.id, "sleep", "The computer woke up; the CLI did not survive."
            )
            await runs.steps.append(
                run.id,
                [
                    {
                        "kind": "start",
                        "title": "The computer woke up; the CLI did not survive.",
                    }
                ],
            )
            proc.kill()  # the reader sees the end: the run is resumed or ended by its kind
        elif run.id in runs.RT.tasks:
            # being started or finished right now: the run's own task owns it
            alive.append(run.id)
        elif run.pid and cli.looks_like_cli(run.pid):
            alive.append(run.id)
        else:
            orphans.append(run.id)
    if orphans:
        await _end_orphans(orphans)
    return {
        "checked": len(rows),
        "alive": alive,
        "dead": dead,
        "orphans": orphans,
    }


async def _end_orphans(run_ids: list[str]) -> None:
    """Runs with no process and no task of the board's: ended as after a crash (only these: `recover_on_startup`
    would also kill CLIs it finds by pid, and a run reached here by pid is alive)."""
    import database

    from . import runs
    from .store import now_iso

    async with database.async_session() as session:
        for run_id in run_ids:
            run = await session.get(AiRun, run_id)
            if (
                run is None
                or run.state not in ("starting", "running")
                or run_id in runs.RT.tasks
            ):
                continue
            run.state = "failed"
            run.ended_at = now_iso()
            run.ended_reason = "The computer slept and this run's CLI did not survive. Retry to start a new run."
            run.ended_by = "board"
            run.stop_code = runs.BOARD_CLOSED
            run.token_hash = None
            session.add(run)
        await session.commit()
