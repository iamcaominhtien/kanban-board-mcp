"""What the schedule loop records when it runs for real (`services/ai/schedules.py`, with the runs of
`services/ai/runs.py` on the stand-in CLI `tests/fixtures/fake_claude.py`, mode v2), for
`crates/kb-ai-run/tests/test_ai_schedules_loop.rs`.

Four schedules of one project, each with its own team (two share one), all due before the loop first looks:

- `sch_loop_due`: due a minute ago: its run starts, the lead reports, the slot passes;
- `sch_loop_late`: due ten minutes ago: a catch-up start ("Started HH:MM when it was back.");
- `sch_loop_missed`: due three hours ago with two hours of catch-up: skipped, and people are told;
- `sch_loop_once`: a one-off of half a minute ago: it runs, and the schedule ends with its slot.

The loop is called until every slot is over (`schedules.tick()` each half second, with the runs' own scheduler
running). What is written: the schedules, their slots, the runs, the tickets' Activity, the schedule's feed and the
notifications, with ids replaced by names and the clock times of this run by `HH:MM`. Notifications and the feed are
in the order of their words (the order they are written in depends on which run ends first).

Run from `server/`:  .venv/bin/python ../server-rs/contract/golden/gen_ai_schedule_loop.py
Writes `ai_schedule_loop.json` next to this file.
"""

import asyncio
import json
import os
import re
import shutil
import stat
import sys
import tempfile
from datetime import UTC, datetime, timedelta
from pathlib import Path

work = os.path.realpath(tempfile.mkdtemp(prefix="gen-ai-schedule-loop-"))
os.environ["KANBAN_CONFIG_DIR"] = f"{work}/config"
os.environ["KANBAN_DB_PATH"] = f"{work}/data/kanban.db"
os.environ["KANBAN_LOG_DIR"] = f"{work}/logs"
os.environ["KANBAN_AI_KEY_FILE"] = f"{work}/ai.key"
os.environ["CLAUDE_CONFIG_DIR"] = f"{work}/claude-config"
os.environ["KANBAN_AI_ROOTS"] = work
os.environ["KANBAN_AI_ACCOUNTS_HOME"] = f"{work}/accounts"
os.environ["KANBAN_AI_RUNS_DIR"] = f"{work}/ai-runs"
os.environ["KANBAN_UPLOADS_DIR"] = f"{work}/uploads"
os.environ["KANBAN_WORKSPACE_ROOT"] = f"{work}/workspace"
os.environ["HOME"] = f"{work}/home"
os.environ["PATH"] = f"{work}/bin:/usr/bin:/bin"
os.environ["FAKE_CLAUDE_MODE"] = "v2"
for name in ("KANBAN_DATABASE_URL", "KANBAN_RUNNER", "KANBAN_IN_RUNNER", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "ANTHROPIC_API_KEY"):
    os.environ.pop(name, None)
sys.path.insert(0, os.getcwd())
os.makedirs(f"{work}/home", exist_ok=True)

from sqlmodel import col, select  # noqa: E402

import database  # noqa: E402
from models import AiRun, AiSchedule, AiScheduleRun, Member, NotifyEvent, Project, Ticket  # noqa: E402
from services import notifications  # noqa: E402
from services.ai import runs, schedules, teams  # noqa: E402

OUT = Path(__file__).with_name("ai_schedule_loop.json")
P = "p-loop"
FAKE = f"{work}/tools/claude"
os.makedirs(os.path.dirname(FAKE), exist_ok=True)
shutil.copy(Path(os.getcwd()) / "tests" / "fixtures" / "fake_claude.py", FAKE)
os.chmod(FAKE, os.stat(FAKE).st_mode | stat.S_IXUSR)


async def a_team(name):
    repo = f"{work}/repo-{name[-1].lower()}"
    os.makedirs(repo, exist_ok=True)
    Path(repo, "calc.py").write_text("def add(a, b):\n    return a - b\n")
    async with database.async_session() as session:
        member = await teams.create(session, P, {"name": name, "working_dir": repo, "cli_path": FAKE, "model": teams.MODELS[0]}, by="An Nguyen")
        await teams.test_connection(session, member.id)
        return member.id


def clock_free(text):
    return re.sub(r"\b\d\d:\d\d\b", "HH:MM", text) if isinstance(text, str) else text


async def snapshot(names):
    await notifications.flush_pending()
    async with database.async_session() as session:
        scheds = (await session.exec(select(AiSchedule).where(AiSchedule.project_id == P).order_by(col(AiSchedule.id)))).all()
        slots = (await session.exec(select(AiScheduleRun).where(AiScheduleRun.project_id == P).order_by(col(AiScheduleRun.schedule_id)))).all()
        all_runs = (await session.exec(select(AiRun).where(AiRun.project_id == P).order_by(col(AiRun.ticket_id), col(AiRun.number)))).all()
        tickets = (await session.exec(select(Ticket).where(Ticket.project_id == P).order_by(col(Ticket.id)))).all()
        notes = (await session.exec(select(NotifyEvent).where(NotifyEvent.project_id == P).order_by(col(NotifyEvent.id)))).all()
    names = dict(names)
    names.update({r.id: f"{r.ticket_id}#{r.number}" for r in all_runs})
    names.update({s.id: f"slot of {s.schedule_id}" for s in slots})

    def named(value):
        if isinstance(value, str):
            return names.get(value, value)
        if isinstance(value, list):
            return [named(v) for v in value]
        if isinstance(value, dict):
            return {k: named(v) for k, v in value.items()}
        return value

    feed = [named({k: v for k, v in e.items() if k not in ("id", "at", "project_id")}) for e in schedules.events_since(P, 0)]
    told = [
        {"kind": n.kind, "needs": n.needs, "title": n.title, "target_kind": n.target_kind, "target_id": named(n.target_id), "ticket_id": n.ticket_id, "member": named(n.member_id),
         "data": named({k: v for k, v in json.loads(n.data or "{}").items() if k in ("schedule_id", "event", "action", "srun_id")}), "recipients": json.loads(n.recipients or "[]")}
        for n in notes
        if n.kind in ("schedule", "schedule_started", "run_failed")
    ]
    return {
        "schedules": [
            {"id": s.id, "state": s.state, "paused_reason": s.paused_reason, "failures_in_row": s.failures_in_row, "runs_count": s.runs_count, "has_next": s.next_run_at is not None,
             "saw_the_ticket": s.ticket_seen_at is not None}
            for s in scheds
        ],
        "slots": [
            {"schedule_id": r.schedule_id, "state": r.state, "catch_up": r.catch_up, "member": named(r.member_id), "runs": named(json.loads(r.run_ids)), "attempts": r.attempts,
             "note": clock_free(r.note), "started": r.started_at is not None, "ended": r.ended_at is not None, "cost_usd": r.cost_usd}
            for r in slots
        ],
        "runs": [
            {"run": names[r.id], "member": named(r.member_id), "state": r.state, "kind": r.kind, "trigger": r.trigger, "started_by": r.started_by, "instruction": r.instruction,
             "ended_by": r.ended_by, "report_status": json.loads(r.report or "{}").get("status"), "summary": r.summary}
            for r in all_runs
        ],
        "activity": {t.id: [{"actor": e.get("actor"), "to": e.get("to")} for e in json.loads(t.activity_log or "[]") if e.get("field") == "ai_schedule"] for t in tickets},
        "feed": sorted(feed, key=lambda e: (e["schedule_id"], e["event"], e["text"])),
        "notifications": sorted(told, key=lambda n: (n["kind"], n["title"])),
    }


async def main():
    await database.init_db()
    async with database.async_session() as session:
        session.add(Project(id=P, name="Loop", prefix="LOOP", color="#2E6F40"))
        session.add(Member(id="loop-an", project_id=P, name="An Nguyen", color="#3B82F6", role="admin"))
        for i in range(1, 5):
            session.add(Ticket(id=f"LOOP-{i}", project_id=P, title=f"Loop {i}", status="todo"))
        await session.commit()
    team = {name: await a_team(name) for name in ("Loop A", "Loop B", "Loop C")}
    now = datetime.now(UTC)

    def due(sid, ticket, member, minutes, **kw):
        when = (now - timedelta(minutes=minutes)).isoformat()
        return AiSchedule(id=sid, project_id=P, ticket_id=ticket, member_id=team[member], created_by="An Nguyen", days="[0, 1, 2, 3, 4, 5, 6]", time="00:00", next_run_at=when, **kw)

    once_at = now - timedelta(seconds=30)
    async with database.async_session() as session:
        session.add(due("sch_loop_due", "LOOP-1", "Loop A", 1, instruction="Fix add()."))
        session.add(due("sch_loop_late", "LOOP-2", "Loop C", 10))
        session.add(due("sch_loop_missed", "LOOP-3", "Loop B", 180, notify_people=json.dumps(["Binh"])))
        session.add(AiSchedule(id="sch_loop_once", project_id=P, ticket_id="LOOP-4", member_id=team["Loop B"], created_by="An Nguyen", kind="once",
                               run_at=once_at.replace(tzinfo=None).isoformat(), next_run_at=once_at.isoformat()))
        await session.commit()
    await runs.start_scheduler()
    try:
        deadline = asyncio.get_running_loop().time() + 120
        while True:
            await schedules.tick()
            async with database.async_session() as session:
                slots = (await session.exec(select(AiScheduleRun).where(AiScheduleRun.project_id == P))).all()
            if len(slots) == 4 and all(s.state in schedules.ENDED for s in slots):
                break
            if asyncio.get_running_loop().time() > deadline:
                raise SystemExit(f"the slots never ended: {[(s.schedule_id, s.state, s.note) for s in slots]}")
            await asyncio.sleep(0.5)
    finally:
        await runs.stop_scheduler()
    out = await snapshot({member_id: name for name, member_id in team.items()})
    text = json.dumps(out, ensure_ascii=False, indent=1)
    OUT.write_text(text + "\n", encoding="utf-8")
    print(f"{OUT.name}: {len(text.encode()) // 1024} KB")
    for s in out["slots"]:
        print("  ", s["schedule_id"], s["state"], "|", s["note"])
    print("   feed:", [(e["schedule_id"], e["event"]) for e in out["feed"]])
    print("   notifications:", [(n["kind"], n["title"]) for n in out["notifications"]])


asyncio.run(main())
