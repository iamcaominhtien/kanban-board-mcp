"""The computer's sleep: runs that need the machine awake, and the check after it woke (services/ai/power.py)."""

import pytest
from sqlmodel import select

from api.ai_power import router as power_router
from main import app
from models import AiRun
from services.ai import power, runs
from tests.test_ai import _project, _runner, _ticket, env  # noqa: F401

if not any(getattr(r, "path", "") == "/ai/power" for r in app.routes):
    # main.py includes it; this keeps the test working before that (ahead of the page catch-all)
    _before = list(app.router.routes)
    app.include_router(power_router)
    _new = [r for r in app.router.routes if r not in _before]
    app.router.routes[:] = _new + _before


@pytest.fixture(autouse=True)
def _dirs(tmp_path, monkeypatch):
    monkeypatch.setenv("KANBAN_AI_RUNS_DIR", str(tmp_path / "ai-runs"))


async def _run(env, state, pid=None):  # noqa: F811
    c = env["c"]
    if "project" not in env:
        env["project"], _ = await _project(c)
        env["member"] = (await _runner(c, env["project"], env["repo"]))["id"]
    p, m = env["project"], {"id": env["member"]}
    t = await _ticket(c, p)
    async with env["maker"]() as s:
        run = AiRun(project_id=p, ticket_id=t, member_id=m["id"], state=state, pid=pid)
        s.add(run)
        await s.commit()
        return run.id


async def test_active_counts_starting_and_running_only(env):  # noqa: F811
    c = env["c"]
    assert (await c.get("/ai/power")).json() == {"active": 0}
    for state in ("queued", "running", "needs_input", "finished"):
        await _run(env, state)
    # queued behind a pause or a cap, or waiting for a person: nothing for the machine to do
    async with env["maker"]() as s:
        assert await power.active_runs(s) == 1
    assert (await c.get("/ai/power")).json() == {"active": 1}


async def test_wake_ends_a_run_with_no_process_like_after_a_crash(env):  # noqa: F811
    c = env["c"]
    run_id = await _run(env, "running", pid=999999)
    r = await c.post("/ai/power/wake")
    assert r.status_code == 200, r.text
    assert r.json()["orphans"] == [run_id]
    async with env["maker"]() as s:
        run = await s.get(AiRun, run_id)
        assert run.state == "failed" and run.stop_code == runs.BOARD_CLOSED


class _Proc:
    def __init__(self, code):
        self.proc = type("P", (), {"returncode": code})()
        self.killed = False

    def kill(self):
        self.killed = True


async def test_wake_stops_a_dead_cli_and_leaves_a_live_one(env):  # noqa: F811
    dead, live = await _run(env, "running"), await _run(env, "running")
    runs.RT.procs[dead] = _Proc(-9)
    runs.RT.procs[live] = _Proc(None)
    async with env["maker"]() as s:
        out = await power.after_wake(s)
    assert out["dead"] == [dead] and out["alive"] == [live] and out["orphans"] == []
    assert runs.RT.procs[dead].killed and not runs.RT.procs[live].killed
    runs.RT.procs.clear()


async def test_wake_with_nothing_running_is_quiet(env):  # noqa: F811
    async with env["maker"]() as s:
        assert await power.after_wake(s) == {
            "checked": 0,
            "alive": [],
            "dead": [],
            "orphans": [],
        }
        assert not (await s.exec(select(AiRun))).all()
