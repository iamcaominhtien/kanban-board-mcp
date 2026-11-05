"""The computer's sleep (services/ai/power.py, api/ai_power.py): runs that need the machine awake, and the check
after it woke, against v2 runs of a team."""

import pytest
from sqlmodel import select

from models import AiRun
from services.ai import power, runs
from tests.ai_helpers import _project, _runner, _ticket, env  # noqa: F401


@pytest.fixture(autouse=True)
def _dirs(tmp_path, monkeypatch):
    monkeypatch.setenv("KANBAN_AI_RUNS_DIR", str(tmp_path / "ai-runs"))
    monkeypatch.delenv("KANBAN_RUNNER", raising=False)


async def _run(env, state, pid=None):  # noqa: F811
    c = env["c"]
    if "project" not in env:
        env["project"], _ = await _project(c)
        env["team"] = (await _runner(c, env["project"], env["repo"]))["id"]
    t = await _ticket(c, env["project"])
    async with env["maker"]() as s:
        run = AiRun(
            project_id=env["project"],
            ticket_id=t,
            member_id=env["team"],
            state=state,
            pid=pid,
        )
        s.add(run)
        await s.commit()
        return run.id


class _Proc:
    def __init__(self, code):
        self.proc = type("P", (), {"returncode": code})()
        self.killed = False

    def kill(self):
        self.killed = True


async def test_active_counts_starting_and_running_only(env):  # noqa: F811
    c = env["c"]
    assert (await c.get("/ai/power")).json() == {"active": 0}
    for state in ("queued", "starting", "running", "needs_input", "finished"):
        await _run(env, state)
    async with env["maker"]() as s:
        assert await power.active_runs(s) == 2
    assert (await c.get("/ai/power")).json() == {"active": 2}


async def test_wake_ends_a_run_with_no_process_like_after_a_crash(env):  # noqa: F811
    c = env["c"]
    run_id = await _run(env, "running", pid=999999)
    r = await c.post("/ai/power/wake")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["orphans"] == [run_id] and body["checked"] == 1
    async with env["maker"]() as s:
        run = await s.get(AiRun, run_id)
        assert run.state == "failed" and run.stop_code == runs.BOARD_CLOSED
        assert run.ended_by == "board" and run.token_hash is None
        assert "slept" in run.ended_reason and run.ended_at


async def test_wake_stops_a_dead_cli_and_leaves_a_live_one(env):  # noqa: F811
    dead, live = await _run(env, "running"), await _run(env, "starting")
    runs.RT.procs[dead] = _Proc(-9)
    runs.RT.procs[live] = _Proc(None)
    async with env["maker"]() as s:
        out = await power.after_wake(s)
    assert out["dead"] == [dead] and out["alive"] == [live] and out["orphans"] == []
    assert runs.RT.procs[dead].killed and not runs.RT.procs[live].killed
    # the dead run got a visible step so the reader sees why it ended
    from services.ai import steps

    async with env["maker"]() as s:
        rows = await steps.read(s, dead, limit=10)
    assert any("did not survive" in r["title"] for r in rows)
    runs.RT.procs.clear()


async def test_wake_leaves_a_run_whose_task_is_being_started(env):  # noqa: F811
    run_id = await _run(env, "starting")
    runs.RT.tasks[run_id] = object()
    try:
        async with env["maker"]() as s:
            out = await power.after_wake(s)
    finally:
        runs.RT.tasks.pop(run_id, None)
    assert out["alive"] == [run_id] and out["orphans"] == []
    async with env["maker"]() as s:
        assert (await s.get(AiRun, run_id)).state == "starting"


async def test_wake_with_nothing_running_is_quiet(env):  # noqa: F811
    async with env["maker"]() as s:
        assert await power.after_wake(s) == {
            "checked": 0,
            "alive": [],
            "dead": [],
            "orphans": [],
        }
        assert not (await s.exec(select(AiRun))).all()


async def test_wake_is_handed_to_the_runner_in_process_mode(env, monkeypatch):  # noqa: F811
    from services.ai import runner_link

    sent = []

    async def command(target, name, payload, wait=True):
        sent.append((target, name, wait))

    monkeypatch.setenv("KANBAN_RUNNER", "process")
    monkeypatch.delenv("KANBAN_IN_RUNNER", raising=False)
    monkeypatch.setattr(runner_link, "command", command)
    run_id = await _run(env, "running", pid=999999)
    async with env["maker"]() as s:
        out = await power.after_wake(s)
    assert out["deferred"] is True and sent == [("*", "wake", False)]
    async with env["maker"]() as s:
        assert (await s.get(AiRun, run_id)).state == "running"
