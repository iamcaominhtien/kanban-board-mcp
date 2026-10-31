"""RAM and CPU of AI runs: the monitor's readings, the memory limit that restarts a run's CLI inside the same run (twice)
and then stops it, a person's Restart, the Resources snapshot and the access level of the resource tools."""

import asyncio
import json
import subprocess
import sys
import time

import pytest

from kanban_mcp.operations import ai_team as ai_ops
from kanban_mcp.tools.ai_team import ai_team as ai_tool
from models import AiMember, AiProjectSettings, AiRun
from services.ai import guard, resources
from services.ai.context import RunContext
from tests.test_ai import _project, _runner, _ticket, _wait, env  # noqa: F401
from tests.test_ai_ticket_work import _assign, _runs, _until

AN = {"X-Actor": "An Nguyen"}


@pytest.fixture
def quick_monitor(monkeypatch):
    monkeypatch.setattr(resources, "SAMPLE_S", 0.15)
    monkeypatch.setattr(resources, "HISTORY_EVERY_S", 0.1)


async def _set_limit(env, project_id, mb):
    async with env["maker"]() as s:
        row = await s.get(AiProjectSettings, project_id)
        if row is None:
            row = AiProjectSettings(project_id=project_id)
        row.run_memory_limit_mb = mb
        s.add(row)
        await s.commit()
    resources.MON.limit_changed(project_id)


async def _run_row(env, run_id) -> AiRun:
    async with env["maker"]() as s:
        return await s.get(AiRun, run_id)


def test_read_run_counts_the_cli_and_what_it_started_apart():
    code = (
        "import subprocess, sys, time\n"
        "subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])\n"
        "time.sleep(30)"
    )
    parent = subprocess.Popen([sys.executable, "-c", code])
    try:
        deadline = time.time() + 10
        reading = None
        while time.time() < deadline:
            reading = resources.read_run(parent.pid)
            if reading and reading["extra_mb"]:
                break
            time.sleep(0.2)
        assert reading["readable"] and reading["cli_rss_mb"] > 3
        assert reading["extra_mb"] > 3  # the child is not part of the CLI's number
    finally:
        parent.kill()
        parent.wait()
    assert resources.read_run(parent.pid) is None  # gone


def test_machine_numbers_are_there():
    machine = resources.read_machine()
    assert (
        machine["ram_total_mb"] > machine["ram_free_mb"] > 0 and machine["cores"] >= 1
    )


async def test_a_run_over_the_limit_restarts_in_the_same_run_twice_then_stops(
    env, monkeypatch, quick_monitor
):
    c = env["c"]
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "sleep")  # a CLI that never ends by itself
    pid, _ = await _project(c)
    await _set_limit(env, pid, 1)  # any process is over 1 MB
    m = await _runner(c, pid, env["repo"])
    tid = await _ticket(c, pid)
    await _assign(c, tid, m["id"])
    run = await _wait(c, tid, ("failed",), timeout=40)
    assert run["stop_code"] == "memory"
    assert "Stopped automatically" in run["ended_reason"]
    assert [r["by"] for r in run["restarts"]] == ["system", "system"]
    assert [r["n"] for r in run["restarts"]] == [1, 2]
    assert all(r["limit_mb"] == 1 and r["rss_mb"] > 1 for r in run["restarts"])
    texts = [s["text"] for s in run["steps"]]
    assert sum(t.startswith("Restarted automatically") for t in texts) == 2
    assert run["peak_rss_mb"] and run["peak_rss_mb"] > 1  # kept with the run
    # the two restarts are one notice with a count, the stop another
    feed = (await c.get(f"/projects/{pid}/ai/notifications")).json()["items"]
    restarted = [n for n in feed if n["event"] == "run_restarted"]
    stopped = [n for n in feed if n["event"] == "run_stopped_memory"]
    assert len(restarted) == 1 and restarted[0]["data"]["count"] == 2
    assert "restarted 2 times" in restarted[0]["title"]
    assert len(stopped) == 1 and stopped[0]["ref_id"] == run["id"]
    assert stopped[0]["desktop"] is True and restarted[0]["desktop"] is False
    # the Timeline draws both: the restart marks and a bar that ended for memory
    tl = (await c.get(f"/projects/{pid}/ai/team/timeline")).json()
    bar = next(b for b in tl["bars"] if b["id"] == run["id"])
    assert bar["end_kind"] == "memory"
    assert [r["n"] for r in bar["restarts"]] == [1, 2] and bar["peak_rss_mb"] > 1
    # and Needs you carries a card for the stop, until the run is retried
    now = (await c.get(f"/projects/{pid}/ai/team/now")).json()
    card = next(i for i in now["needs_you"] if i["kind"] == "memory_stop")
    assert card["run_id"] == run["id"] and card["limit_mb"] == 1
    assert now["restarted_runs"] == 0  # the run has ended
    # Dismiss takes the card away and is kept in the audit log
    assert (await c.post(f"/ai/runs/{run['id']}/dismiss-stop")).status_code == 200
    now = (await c.get(f"/projects/{pid}/ai/team/now")).json()
    assert not [i for i in now["needs_you"] if i["kind"] == "memory_stop"]
    log = (await c.get(f"/projects/{pid}/ai/audit")).json()["entries"]
    assert any(e["action"] == "run_stop_dismissed" for e in log)


async def test_a_person_can_restart_a_running_run(env, monkeypatch, quick_monitor):
    c = env["c"]
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "sleep")
    pid, _ = await _project(c)
    await _set_limit(env, pid, 0)  # no limit
    m = await _runner(c, pid, env["repo"])
    tid = await _ticket(c, pid)
    await _assign(c, tid, m["id"])
    run = await _wait(c, tid, ("running",), timeout=40)
    first_pid = (await _run_row(env, run["id"])).pid
    r = await c.post(f"/ai/runs/{run['id']}/restart", headers=AN)
    assert r.status_code == 200 and r.json() == {"restarting": True}

    async def restarted():
        row = (await _runs(c, tid))[0]
        return row if row["restarts"] and row["state"] == "running" else None

    row = await _until(restarted, timeout=40)
    assert row["restarts"][0]["by"] == "An Nguyen" and row["restarts"][0]["n"] == 1
    assert (
        await _run_row(env, run["id"])
    ).pid != first_pid  # a new CLI process, the same run
    assert row["id"] == run["id"] and row["number"] == run["number"]


async def test_restart_needs_a_running_run(env):
    c = env["c"]
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"])
    tid = await _ticket(c, pid)
    await _assign(c, tid, m["id"])
    run = await _wait(c, tid, ("finished",))
    r = await c.post(f"/ai/runs/{run['id']}/restart", headers=AN)
    assert r.status_code == 409 and "only a running run" in r.json()["detail"].lower()


async def test_the_snapshot_has_the_machine_and_the_live_runs(
    env, monkeypatch, quick_monitor
):
    c = env["c"]
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "sleep")
    pid, _ = await _project(c)
    await _set_limit(env, pid, 0)
    m = await _runner(c, pid, env["repo"])
    tid = await _ticket(c, pid)
    await _assign(c, tid, m["id"])
    run = await _wait(c, tid, ("running",))

    async def read():
        snap = (await c.get(f"/projects/{pid}/ai/resources")).json()
        row = next((r for r in snap["runs"] if r["run_id"] == run["id"]), None)
        return snap if row and row["cli_rss_mb"] and row["history"] else None

    snap = await _until(read)
    row = snap["runs"][0]
    assert row["live"] and row["readable"] and row["member_name"] == m["name"]
    assert row["ticket_id"] == tid and row["peak_rss_mb"] >= row["cli_rss_mb"] > 0
    assert snap["machine"]["cli_count"] == 1 and snap["machine"]["ram_total_mb"] > 0
    assert snap["limits"]["auto_restarts"] == 2 and snap["my_role"]


async def test_the_memory_limit_setting_is_checked(env):
    c = env["c"]
    pid, _ = await _project(c)
    r = await c.patch(f"/projects/{pid}/ai/settings", json={"run_memory_limit_mb": 100})
    assert r.status_code == 422
    for ok in (0, 2048):
        r = await c.patch(
            f"/projects/{pid}/ai/settings", json={"run_memory_limit_mb": ok}
        )
        assert r.status_code == 200 and r.json()["run_memory_limit_mb"] == ok


async def test_access_to_the_resource_tools_is_set_per_member_by_an_owner_or_admin(env):
    c = env["c"]
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"])
    assert m["resource_access"] == "none"
    r = await c.patch(f"/ai/members/{m['id']}", json={"resource_access": "control"})
    assert r.status_code == 200 and r.json()["resource_access"] == "control"
    r = await c.patch(f"/ai/members/{m['id']}", json={"resource_access": "everything"})
    assert r.status_code in (400, 422)


async def _inside_run_of(env, member_id, project_id, ticket_id, run_id="run_x"):
    ctx = RunContext(run_id, member_id, "AI", project_id, ticket_id, "x", "work")
    return guard.enter(ctx)


async def test_an_ai_run_sees_and_acts_only_as_far_as_its_access(env):
    c = env["c"]
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"])
    tid = await _ticket(c, pid)

    async def set_level(level):
        async with env["maker"]() as s:
            row = await s.get(AiMember, m["id"])
            row.resource_access = level
            s.add(row)
            await s.commit()

    tokens = await _inside_run_of(env, m["id"], pid, tid)
    try:
        with pytest.raises(ValueError, match="not turned on"):
            await ai_ops.resources(pid)
        # through the MCP tool the actions do not exist at all for a member with None
        for act in ("resources", "restart"):
            with pytest.raises(ValueError) as gone:
                await ai_tool(act, project_id=pid, run_id="run_other")
            assert "not turned on" not in str(gone.value)
            assert "Unknown action" in str(gone.value)
        await set_level("view")
        snap = await ai_ops.resources(pid)
        assert "machine" in snap and all("history" not in r for r in snap["runs"])
        with pytest.raises(ValueError, match="look at the resources"):
            await ai_ops.restart("run_other")
        await set_level("control")
        with pytest.raises(ValueError, match="own run"):
            await ai_ops.cancel("run_x")
    finally:
        guard.leave(tokens)
    # outside an AI run (a person, or an AI of your own over MCP) the tools work with the person's rights
    assert "machine" in await ai_ops.resources(pid)


async def test_an_ai_with_control_asks_before_stopping_another_ais_run(env):
    c = env["c"]
    pid, _ = await _project(c)
    boss = await _runner(c, pid, env["repo"], name="Boss")
    other = await _runner(c, pid, env["repo"], name="Other")
    tid = await _ticket(c, pid)
    async with env["maker"]() as s:
        row = await s.get(AiMember, boss["id"])
        row.resource_access = "control"
        s.add(row)
        target = AiRun(
            project_id=pid, ticket_id=tid, member_id=other["id"], state="running"
        )
        s.add(target)
        await s.commit()
        target_id = target.id
    tokens = await _inside_run_of(env, boss["id"], pid, tid)
    try:
        asked = await ai_ops.cancel(target_id, "too heavy")
        again = await ai_ops.cancel(target_id, "too heavy")
    finally:
        guard.leave(tokens)
    assert (
        asked["pending_approval"] == again["pending_approval"]
    )  # one request, not two
    assert (await _run_row(env, target_id)).state == "running"  # nothing happened yet
    pending = (await c.get(f"/projects/{pid}/ai/approvals?status=pending")).json()
    mine = next(a for a in pending if a["id"] == asked["pending_approval"])
    assert mine["action"] == "run_control" and mine["risk"] == "medium"
    assert mine["remember_allowed"] is False
    done = await c.post(f"/ai/approvals/{mine['id']}/approve", json={})
    assert done.status_code == 200, done.text
    assert (await _run_row(env, target_id)).state in ("cancelled", "stopped", "failed")


async def test_the_stream_sends_a_snapshot_first(env):
    pid, _ = await _project(env["c"])
    queue = resources.MON.subscribe(pid)
    try:
        snap = await asyncio.wait_for(queue.get(), 5)
        assert snap["machine"]["cores"] >= 1 and snap["runs"] == []
    finally:
        resources.MON.unsubscribe(pid, queue)
    assert json.dumps(snap)  # plain JSON
