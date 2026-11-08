"""The runner process (AI v2 stage 6): a second process starts the CLIs and reads their streams; the API queues
runs and sends commands through ai_run_command; events come back over HTTP."""

import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

import database
from models import AiRun, AiRunCommand
from runner import main as runner_main
from services.ai import runner_link, runs
from tests.ai_helpers import _project, _runner, _ticket, env  # noqa: F401

SERVER = Path(__file__).resolve().parents[1]


@pytest.fixture
def process_mode(monkeypatch):
    monkeypatch.setenv("KANBAN_RUNNER", "process")
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "v2")
    monkeypatch.setattr(runner_link, "_proc", None)
    monkeypatch.setattr(runner_link, "_board_url", None)
    monkeypatch.setattr(
        runner_link, "ensure_started", lambda *a, **k: False
    )  # the test starts the runner itself
    yield


async def _runner_process(env, monkeypatch) -> subprocess.Popen:
    """The real runner, as `main.py --runner`, on the test's database."""
    db_path = env["tmp"] / "ai.db"
    config_dir = (
        env["tmp"] / "runner-config"
    )  # never the developer's own ~/.kanban-board (its database is real)
    config_dir.mkdir(exist_ok=True)
    proc_env = {
        **os.environ,
        "KANBAN_DB_PATH": str(db_path),
        "KANBAN_CONFIG_DIR": str(config_dir),
        "KANBAN_LOG_DIR": str(env["tmp"] / "runner-logs"),
        "KANBAN_RUNNER": "process",
        "KANBAN_IN_RUNNER": "1",
        "KANBAN_BOARD_URL": "http://127.0.0.1:1",  # no API listens: events fail quietly, rows still land
        "KANBAN_INTERNAL_TOKEN": "t",
        "KANBAN_PARENT_PID": str(os.getpid()),
        "FAKE_CLAUDE_MODE": os.environ.get("FAKE_CLAUDE_MODE", "v2"),
        # every CLI of this runner waits for one message (or 30 s) before it answers
        "FAKE_CLAUDE_V2_WAIT_MESSAGE": "1",
        "FAKE_CLAUDE_WAIT": "30",
    }
    proc_env.pop("KANBAN_API_SECRET_STDIN", None)
    log = open(env["tmp"] / "runner.log", "ab")
    proc = subprocess.Popen(
        [sys.executable, str(SERVER / "main.py"), "--runner"],
        cwd=SERVER,
        env=proc_env,
        stdout=log,
        stderr=subprocess.STDOUT,
    )
    return proc


async def _wait_state(
    c, ticket_id: str, states: tuple[str, ...], timeout: float = 40.0
) -> dict:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while True:
        rows = (await c.get(f"/tickets/{ticket_id}/ai/runs")).json()
        if rows and rows[0]["state"] in states:
            return rows[0]
        if loop.time() > deadline:
            raise AssertionError(
                f"run never reached {states}: {rows[0]['state'] if rows else None}"
            )
        await asyncio.sleep(0.2)


async def test_the_runner_process_runs_what_the_api_queues_and_takes_its_commands(
    process_mode, env, monkeypatch
):
    c = env["c"]
    pid, _ = await _project(c)
    team = await _runner(c, pid, env["repo"])
    tid = await _ticket(c, pid)
    assert (await c.get("/ai/runner")).json()["mode"] == "process"
    proc = await _runner_process(env, monkeypatch)
    try:
        # the API only queues: the runner picks the run up and starts the fake CLI, which waits for a message
        await c.patch(f"/tickets/{tid}", json={"assignee": team["id"]})
        run = await _wait_state(c, tid, ("running",))
        for _ in range(100):  # until the runner marked the CLI live (its stdin open)
            run = (await c.get(f"/ai/runs/{run['id']}")).json()
            if run["live"]:
                break
            await asyncio.sleep(0.1)
        assert run["live"], run
        # a message from the API is a command the runner takes and writes into the CLI's input
        r = await c.post(
            f"/ai/runs/{run['id']}/message", json={"text": "Also bump the version."}
        )
        assert r.status_code == 200 and r.json()["delivered"] == "runner", r.text
        done = await _wait_state(c, tid, ("finished",))
        assert (
            done["report"]["status"] == "done" and "bump the version" in done["summary"]
        )
        assert (
            done["live"] is False and done["pid"] is None and done["steps_count"] >= 6
        )
        detail = (await c.get(f"/ai/runs/{run['id']}")).json()
        assert detail["agents"][0]["agent_type"] == "reviewer"
        # a second run, cancelled from the API: again a command the runner takes
        r = await c.post(f"/tickets/{tid}/ai/run", json={"instruction": "once more"})
        assert r.status_code == 200, r.text
        second = r.json()
        running = await _wait_state(c, tid, ("running",))
        assert running["id"] == second["id"]
        r = await c.post(f"/ai/runs/{second['id']}/cancel")
        assert r.status_code == 200, r.text
        ended = await _wait_state(c, tid, ("cancelled",))
        assert ended["id"] == second["id"]
        async with env["maker"]() as s:
            cmds = (await s.exec(__import__("sqlmodel").select(AiRunCommand))).all()
        assert [x.command for x in cmds] == ["message", "cancel"] and all(
            x.taken_at for x in cmds
        )
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill()


async def test_commands_are_taken_once_and_unknown_ones_are_logged(process_mode, env):
    async with env["maker"]() as s:
        s.add(AiRunCommand(run_id="run_x", command="unknown", payload="{}"))
        s.add(
            AiRunCommand(
                run_id="run_y", command="cancel", payload=json.dumps({"by": "t"})
            )
        )
        await s.commit()
    n = await runner_main.poll_commands(once=True)
    assert n == 2
    assert await runner_main.poll_commands(once=True) == 0
    async with env["maker"]() as s:
        rows = (await s.exec(__import__("sqlmodel").select(AiRunCommand))).all()
    assert all(r.taken_at for r in rows)


async def test_the_api_defers_cancel_to_the_runner_in_process_mode(
    process_mode, env, monkeypatch
):
    monkeypatch.setattr(runner_link, "COMMAND_WAIT_S", 0.3)
    c = env["c"]
    pid, _ = await _project(c)
    team = await _runner(c, pid, env["repo"])
    tid = await _ticket(c, pid)
    async with env["maker"]() as s:
        run = AiRun(
            project_id=pid,
            ticket_id=tid,
            member_id=team["id"],
            state="running",
            started_by="An",
        )
        s.add(run)
        await s.commit()
        await s.refresh(run)
    out = await runs.cancel(run.id, by="An")
    assert (
        out.state == "running"
    )  # nothing ran it here: the command waits for the runner
    async with env["maker"]() as s:
        cmd = (await s.exec(__import__("sqlmodel").select(AiRunCommand))).first()
    assert (
        cmd.command == "cancel"
        and json.loads(cmd.payload)["by"] == "An"
        and not cmd.taken_at
    )
    assert runs.defers_to_runner()
    async with database.async_session() as s:
        assert (await s.get(AiRun, run.id)).state == "running"
