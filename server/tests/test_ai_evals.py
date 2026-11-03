"""The eval suites that need more than a ticket (a sample repository, a fault the board causes, a workflow) and the
schedule that runs them now and then (services/ai/evals.py). No model is called: the fake CLI plays the AI."""

import asyncio
import os
from datetime import UTC, datetime, timedelta

import pytest

from models import AiRun, AiTicketStep, AiTicketWorkflow, Ticket
from services.ai import evals, runs
from tests.test_ai import _project, _runner, env  # noqa: F401


@pytest.fixture(autouse=True)
def _dirs(tmp_path, monkeypatch):
    monkeypatch.setenv("KANBAN_AI_RUNS_DIR", str(tmp_path / "ai-runs"))
    monkeypatch.setenv("KANBAN_AI_EVALS_DIR", str(tmp_path / "evals"))
    # added to the roots conftest allows (the repository holds the fake CLI), not in their place: a checkout outside
    # the home folder would refuse the fake CLI and fail every eval run
    monkeypatch.setenv(
        "KANBAN_AI_ROOTS",
        os.pathsep.join(
            filter(None, [str(tmp_path), os.environ.get("KANBAN_AI_ROOTS")])
        ),
    )


def _suite(key):
    return next(s for s in evals.SUITES if s["key"] == key)


def test_every_suite_has_a_task_with_a_check():
    for s in evals.SUITES:
        assert s["tasks"], s["key"]
        for t in s["tasks"]:
            assert t["check"], (s["key"], t["title"])


def test_the_hidden_test_fails_on_the_seeded_bug_and_passes_once_fixed():
    task = _suite("problem")["tasks"][0]
    folder = evals.make_repo(task["repo"])
    assert not evals.run_hidden_test(folder, task["repo"]["hidden"])
    path = f"{folder}/calc.py"
    code = open(path).read().replace("len(numbers) + 1", "len(numbers)")
    open(path, "w").write(code)
    assert evals.run_hidden_test(folder, task["repo"]["hidden"])


def test_the_hidden_test_is_not_in_the_repo_the_ai_sees():
    task = _suite("problem")["tasks"][0]
    folder = evals.make_repo(task["repo"])
    import os

    assert task["repo"]["hidden"]["name"] not in os.listdir(folder)


def test_grade_reads_the_new_checks():
    ticket = Ticket(id="E-1", project_id="p", title="t")
    run = AiRun(
        project_id="p", ticket_id="E-1", member_id="m", state="finished", restarts="[]"
    )
    check = {"restarted": True, "state": "finished"}
    score, notes = evals.grade(check, run, ticket)
    assert score == 0.5 and notes
    run.restarts = '[{"by": "board"}]'
    assert evals.grade(check, run, ticket)[0] == 1.0
    assert (
        evals.grade({"hidden_test": True}, run, ticket, {"hidden_test": True})[0] == 1
    )
    assert evals.grade({"hidden_test": True}, run, ticket, {})[0] == 0
    assert (
        evals.grade({"workflow_end": True}, None, ticket, {"workflow": "reached"})[0]
        == 1
    )
    assert (
        evals.grade({"workflow_end": True}, None, ticket, {"workflow": "running"})[0]
        == 0
    )


async def test_the_problem_suite_runs_in_its_own_repo_and_is_marked_by_the_hidden_test(
    env,
):  # noqa: F811
    c = env["c"]
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"])
    r = await c.post("/ai/evals/run", json={"suite": "problem", "member_id": m["id"]})
    assert r.status_code == 200, r.text
    item = r.json()["runs"][0]
    assert item["repo"].startswith(str(env["tmp"] / "evals"))
    for _ in range(150):
        marks = (await c.get("/ai/evals/marks")).json()
        if marks and marks[0]["state"] == "done":
            break
        await asyncio.sleep(0.15)
    # the fake CLI does not fix the bug: the run finished, the hidden test did not pass
    assert marks[0]["state"] == "done"
    assert marks[0]["score"] == 0.5
    assert "hidden test" in marks[0]["details"][0]["notes"][0]


async def test_the_recovery_suite_has_the_board_stop_the_cli(env, monkeypatch):  # noqa: F811
    c = env["c"]
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"])
    called = []

    async def fake_restart(run_id, *, by, note=None):
        called.append((run_id, by))

    monkeypatch.setattr(runs, "restart_run", fake_restart)
    monkeypatch.setattr(evals, "FAULT_DELAY_S", 0)
    r = await c.post("/ai/evals/run", json={"suite": "recovery", "member_id": m["id"]})
    assert r.status_code == 200, r.text
    run_id = r.json()["runs"][0]["run_id"]
    for _ in range(100):
        if called:
            break
        await asyncio.sleep(0.05)
    assert called == [(run_id, "board")]


async def test_the_coordination_suite_attaches_the_quick_fix_workflow(env):  # noqa: F811
    c = env["c"]
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"])
    r = await c.post(
        "/ai/evals/run", json={"suite": "coordination", "member_id": m["id"]}
    )
    assert r.status_code == 200, r.text
    ticket_id = r.json()["runs"][0]["ticket_id"]
    async with env["maker"]() as s:
        wf = await s.get(AiTicketWorkflow, ticket_id)
        assert wf is not None and wf.template_key == "quick_fix"
        assert await evals.workflow_status(s, ticket_id) in ("running", "reached")


async def test_workflow_status_reads_the_steps(env):  # noqa: F811
    c = env["c"]
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"])
    r = await c.post(
        "/ai/evals/run", json={"suite": "coordination", "member_id": m["id"]}
    )
    ticket_id = r.json()["runs"][0]["ticket_id"]
    async with env["maker"]() as s:
        from sqlmodel import select

        rows = (
            await s.exec(
                select(AiTicketStep).where(AiTicketStep.ticket_id == ticket_id)
            )
        ).all()
        for row in rows:
            row.state = "done"
        rows[-1].state = "waiting"
        for row in rows:
            s.add(row)
        await s.commit()
        assert await evals.workflow_status(s, ticket_id) == "reached"
        rows[-1].state = "blocked"
        s.add(rows[-1])
        rows[0].state = "done"
        rows[1].state = "pending"
        s.add(rows[1])
        await s.commit()
        assert await evals.workflow_status(s, ticket_id) == "stopped"


async def test_the_schedule_is_off_by_default_and_checked(env):  # noqa: F811
    c = env["c"]
    d = (await c.get("/ai/evals/schedule")).json()
    assert d["every_days"] == 0 and d["model"] == "haiku"
    ok = await c.patch(
        "/ai/evals/schedule", json={"every_days": 7, "suites": ["board"]}
    )
    assert ok.status_code == 200 and ok.json()["every_days"] == 7
    assert (await c.get("/ai/evals/schedule")).json()["suites"] == ["board"]
    for bad in ({"model": "opus"}, {"every_days": -1}, {"suites": ["nope"]}):
        assert (await c.patch("/ai/evals/schedule", json=bad)).status_code == 422
    bad_run = await c.post(
        "/ai/evals/run", json={"suite": "board", "member_id": "x", "model": "opus"}
    )
    assert bad_run.status_code == 422


async def test_a_scheduled_eval_starts_when_due_and_not_before(env, monkeypatch):  # noqa: F811
    c = env["c"]
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"])
    started = []

    async def fake_run(session, key, member_id, *, by, model=None):
        started.append((key, member_id, model))

    monkeypatch.setattr(evals, "run_suite", fake_run)
    async with env["maker"]() as s:
        assert await evals.run_if_due(s) == []  # off
        await evals.set_schedule(
            s, {"every_days": 2, "suites": ["board", "issue"], "member_id": m["id"]}
        )
        now = datetime.now(UTC)
        assert await evals.run_if_due(s, now=now) == ["board", "issue"]
        assert started == [("board", m["id"], "haiku"), ("issue", m["id"], "haiku")]
        assert await evals.run_if_due(s, now=now + timedelta(days=1)) == []
        assert await evals.run_if_due(s, now=now + timedelta(days=3)) == [
            "board",
            "issue",
        ]


async def test_the_loop_starts_and_stops(env):  # noqa: F811
    evals.start()
    task = evals._LOOP["task"]
    assert task is not None and not task.done()
    await evals.stop()
    assert evals._LOOP["task"] is None
