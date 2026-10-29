"""AI work on tickets (docs/specs/ai-gaps.md, section 4): queueing, a second AI waiting for the hold, pause and
resume, raised limits, step output and test results, questions (details, reminders, asking someone else), the ask
thread (regenerate, feedback, replies), the person-edit notes and the revert preview."""

import asyncio
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from models import AiRun, Ticket
from services.ai import runs
from services.ai.context import RunContext
from tests.test_ai import (  # noqa: F401
    _project,
    _runner,
    _ticket,
    _wait,
    env,
)

AN = {"X-Actor": "An Nguyen"}


async def _run(env, run_id):
    async with env["maker"]() as s:
        return await s.get(AiRun, run_id)


async def _assign(c, tid, member_id, start="now", actor="An Nguyen"):
    return await c.post(
        f"/tickets/{tid}/ai/assign",
        json={"member_id": member_id, "start": start},
        headers={"X-Actor": actor},
    )


async def _runs(c, tid):
    return (await c.get(f"/tickets/{tid}/ai/runs")).json()


async def _until(fn, timeout=15.0):
    deadline = asyncio.get_running_loop().time() + timeout
    while True:
        value = await fn()
        if value:
            return value
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError("condition never became true")
        runs.RT.wake.set()
        await asyncio.sleep(0.1)


# --------------------------------------------------------------------------- run view data


async def test_a_command_step_keeps_its_output_exit_code_and_test_results(env):
    c = env["c"]
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"])
    tid = await _ticket(c, pid)
    await _assign(c, tid, m["id"])
    run = await _wait(c, tid, ("finished",))
    cmd = next(s for s in run["steps"] if s["kind"] == "command")
    assert cmd["exit_code"] == 0
    assert "1 failed, 3 passed" in cmd["output"]
    assert cmd["tests"] == {
        "passed": 3,
        "failed": 1,
        "failing": ["tests/test_calc.py::test_sub"],
    }
    # the board's own reading of the test command, apart from what the agent claims
    assert run["tests"]["passed"] == 3 and run["tests"]["failed"] == 1
    assert "pytest" in run["tests"]["command"]


async def test_the_step_estimate_is_the_median_of_the_members_finished_runs(
    env, monkeypatch
):
    c = env["c"]
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"], max_parallel=1)
    counts = []
    for i in range(3):
        tid = await _ticket(c, pid, title=f"Done {i}")
        await _assign(c, tid, m["id"])
        run = await _wait(c, tid, ("finished",))
        counts.append(len(run["steps"]))
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "sleep")
    tid = await _ticket(c, pid, title="Active")
    await _assign(c, tid, m["id"])
    run = await _wait(c, tid, ("running",))
    assert run["step_estimate"] == sorted(counts)[len(counts) // 2]
    await c.post(f"/ai/runs/{run['id']}/cancel", json={})


async def test_no_step_estimate_before_two_finished_runs(env, monkeypatch):
    c = env["c"]
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "sleep")
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"])
    tid = await _ticket(c, pid)
    await _assign(c, tid, m["id"])
    run = await _wait(c, tid, ("running",))
    assert run["step_estimate"] is None
    await c.post(f"/ai/runs/{run['id']}/cancel", json={})


# --------------------------------------------------------------------------- queue and hold


async def test_queue_waits_behind_the_members_current_run_even_with_a_free_slot(
    env, monkeypatch
):
    c = env["c"]
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "sleep")
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"], max_parallel=2)
    first = await _ticket(c, pid, title="First")
    second = await _ticket(c, pid, title="Second")
    await _assign(c, first, m["id"])
    running = await _wait(c, first, ("running",))
    r = await _assign(c, second, m["id"], start="queue")
    assert r.status_code == 200
    queued = r.json()["run"]
    await asyncio.sleep(2.5)  # the scheduler had time to start it if it could
    queued = (await _runs(c, second))[0]
    assert queued["state"] == "queued" and queued["queue_after_current"]
    assert queued["waiting_reason"] == f"Queued behind {first}"
    assert queued["behind_ticket_id"] == first and queued["queue_position"] == 1
    # "Start now" does not wait for the first one: a slot is free
    r = await c.post(f"/ai/runs/{queued['id']}/start-now")
    assert r.status_code == 200
    assert r.json()["state"] in ("starting", "running")
    await c.post(f"/ai/runs/{running['id']}/cancel", json={})
    await c.post(f"/ai/runs/{queued['id']}/cancel", json={})


async def test_a_queued_run_starts_when_the_current_run_ends(env, monkeypatch):
    c = env["c"]
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "sleep")
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"], max_parallel=2)
    first = await _ticket(c, pid, title="First")
    second = await _ticket(c, pid, title="Second")
    await _assign(c, first, m["id"])
    running = await _wait(c, first, ("running",))
    await _assign(c, second, m["id"], start="queue")
    await c.post(f"/ai/runs/{running['id']}/cancel", json={})
    await _wait(c, second, ("starting", "running"))
    await c.post(f"/ai/runs/{(await _runs(c, second))[0]['id']}/cancel", json={})


async def test_start_now_says_what_blocks_it(env, monkeypatch):
    c = env["c"]
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "sleep")
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"], max_parallel=1)
    first = await _ticket(c, pid, title="First")
    second = await _ticket(c, pid, title="Second")
    await _assign(c, first, m["id"])
    running = await _wait(c, first, ("running",))
    await _assign(c, second, m["id"], start="queue")
    queued = (await _runs(c, second))[0]
    r = await c.post(f"/ai/runs/{queued['id']}/start-now")
    assert r.status_code == 409 and "free slot" in r.json()["detail"]
    await c.post(f"/ai/runs/{running['id']}/cancel", json={})
    await c.post(f"/ai/runs/{queued['id']}/cancel", json={})


async def test_a_second_ai_waits_for_the_holder_then_takes_the_hold(env, monkeypatch):
    c = env["c"]
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "sleep")
    pid, _ = await _project(c)
    holder = await _runner(c, pid, env["repo"], name="Claude Code · Backend")
    nxt = await _runner(c, pid, env["repo"], name="Reviewer")
    tid = await _ticket(c, pid)
    await _assign(c, tid, holder["id"])
    hold = await _wait(c, tid, ("running",))
    # starting right now is refused; queueing waits behind the holder
    assert (await _assign(c, tid, nxt["id"], start="now")).status_code == 409
    r = await _assign(c, tid, nxt["id"], start="queue")
    assert r.status_code == 200, r.text
    assert r.json()["ticket"]["assignee"] == holder["id"]  # the holder keeps the ticket
    waiting = next(x for x in await _runs(c, tid) if x["member_id"] == nxt["id"])
    assert waiting["behind_run_id"] == hold["id"] and waiting["state"] == "queued"

    async def _reason():
        run = next(x for x in await _runs(c, tid) if x["member_id"] == nxt["id"])
        return run if run.get("waiting_reason") else None

    waiting = await _until(_reason)
    assert (
        waiting["waiting_reason"]
        == "Waiting for Claude Code · Backend to release " + tid
    )
    assert waiting["behind_member_name"] == "Claude Code · Backend"
    # a third AI cannot queue behind the same hold
    third = await _runner(c, pid, env["repo"], name="Third")
    assert (await _assign(c, tid, third["id"], start="queue")).status_code == 409
    # the board shows the holder, not the waiting run
    board = (await c.get(f"/projects/{pid}/ai/board")).json()["runs"]
    assert [r["member_id"] for r in board if r["ticket_id"] == tid] == [holder["id"]]
    # the hold is released: the second AI takes it and the ticket
    await c.post(f"/ai/runs/{hold['id']}/cancel", json={})
    await _until(lambda: _next_runs(c, tid, nxt["id"], ("starting", "running")))
    t = (await c.get(f"/tickets/{tid}")).json()
    assert t["assignee"] == nxt["id"]
    nxt_run = next(x for x in await _runs(c, tid) if x["member_id"] == nxt["id"])
    assert nxt_run["behind_run_id"] is None
    await c.post(f"/ai/runs/{nxt_run['id']}/cancel", json={})


async def _next_runs(c, tid, member_id, states):
    found = [
        x
        for x in await _runs(c, tid)
        if x["member_id"] == member_id and x["state"] in states
    ]
    return found[0] if found else None


# --------------------------------------------------------------------------- pause and resume


def _proc_state(pid: int) -> str:
    return Path(f"/proc/{pid}/stat").read_text().split()[2]


async def test_pause_stops_the_run_and_resume_continues_it(env, monkeypatch):
    c = env["c"]
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "ticks")
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"])
    tid = await _ticket(c, pid)
    await _assign(c, tid, m["id"])
    run = await _wait(c, tid, ("running",))
    await _until(lambda: _steps_over(c, tid, 4))
    r = await c.post(f"/ai/runs/{run['id']}/pause", headers=AN)
    assert r.status_code == 200 and r.json()["paused"] is True
    os_pid = (await _run(env, run["id"])).pid
    await asyncio.sleep(0.5)
    assert _proc_state(os_pid) == "T"  # stopped
    before = len((await _runs(c, tid))[0]["steps"])
    await asyncio.sleep(1.2)
    paused = (await _runs(c, tid))[0]
    assert len(paused["steps"]) == before and paused["state"] == "running"
    assert any(s["text"] == "Paused by An Nguyen" for s in paused["steps"])
    # pausing twice is harmless; a paused run is not "stuck" for the idle timeout
    assert (await c.post(f"/ai/runs/{run['id']}/pause", headers=AN)).status_code == 200
    r = await c.post(f"/ai/runs/{run['id']}/resume", headers=AN)
    assert r.status_code == 200 and r.json()["paused"] is False
    await _until(lambda: _steps_over(c, tid, before + 3))
    # a paused run can still be cancelled: the stopped process dies
    await c.post(f"/ai/runs/{run['id']}/pause", headers=AN)
    await asyncio.sleep(0.3)
    r = await c.post(f"/ai/runs/{run['id']}/cancel", json={})
    assert r.status_code == 200 and r.json()["state"] == "cancelled"
    assert r.json()["paused"] is False
    await asyncio.sleep(0.5)
    with pytest.raises(FileNotFoundError):
        _proc_state(os_pid)


async def _steps_over(c, tid, n):
    return len((await _runs(c, tid))[0]["steps"]) > n


async def test_only_a_running_run_can_be_paused(env):
    c = env["c"]
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"])
    tid = await _ticket(c, pid)
    await _assign(c, tid, m["id"])
    run = await _wait(c, tid, ("finished",))
    r = await c.post(f"/ai/runs/{run['id']}/pause")
    assert r.status_code == 409 and "only a running run" in r.json()["detail"]
    r = await c.post(f"/ai/runs/{run['id']}/resume")
    assert r.status_code == 409


# --------------------------------------------------------------------------- failed, cancelled, timed out


async def test_raise_limit_starts_a_new_run_with_a_longer_limit(env, monkeypatch):
    c = env["c"]
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "fail")
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"])
    tid = await _ticket(c, pid)
    await _assign(c, tid, m["id"])
    run = await _wait(c, tid, ("failed",))
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "sleep")
    assert (
        await c.post(f"/ai/runs/{run['id']}/retry", json={"limit_min": 0})
    ).status_code == 422
    r = await c.post(f"/ai/runs/{run['id']}/retry", json={"limit_min": 90})
    assert r.status_code == 200
    new = r.json()
    assert new["number"] == run["number"] + 1 and new["limit_min"] == 90
    # a plain retry (no body) still works and carries no limit
    await _wait(c, tid, ("running",))
    cancelled = await c.post(f"/ai/runs/{new['id']}/cancel", json={})
    assert cancelled.status_code == 200, cancelled.text
    await _wait(c, tid, ("cancelled",))
    r = await c.post(f"/ai/runs/{new['id']}/retry")
    assert r.status_code == 200, r.text
    assert r.json()["limit_min"] is None
    await c.post(f"/ai/runs/{r.json()['id']}/cancel", json={})


async def test_cancelling_records_the_status_it_returned_to(env, monkeypatch):
    c = env["c"]
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "sleep")
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"])
    tid = await _ticket(c, pid, status="todo")
    await _assign(c, tid, m["id"])
    await _wait(c, tid, ("running",))
    await _until(lambda: _status_is(c, tid, "in-progress"))
    run = (await _runs(c, tid))[0]
    r = await c.post(f"/ai/runs/{run['id']}/cancel", json={}, headers=AN)
    assert r.status_code == 200
    done = r.json()
    assert [(x["from"], x["to"]) for x in done["status_changes"]] == [
        ("todo", "in-progress"),
        ("in-progress", "todo"),
    ]
    assert done["status_changes"][-1]["kind"] == "cancel"
    assert (await c.get(f"/tickets/{tid}")).json()["status"] == "todo"


async def _status_is(c, tid, status):
    return (await c.get(f"/tickets/{tid}")).json()["status"] == status


async def test_archiving_and_taking_over_leave_a_stop_code(env, monkeypatch):
    c = env["c"]
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "sleep")
    pid, an = await _project(c)
    m = await _runner(c, pid, env["repo"])
    one = await _ticket(c, pid, title="One")
    two = await _ticket(c, pid, title="Two")
    await _assign(c, one, m["id"])
    await _wait(c, one, ("running",))
    await c.patch(f"/tickets/{one}/status", json={"status": "wont_do"}, headers=AN)
    run = (await _runs(c, one))[0]
    assert run["state"] == "cancelled" and run["stop_code"] == "archive"
    assert run["ended_by"] == "An Nguyen"
    await _assign(c, two, m["id"])
    await _wait(c, two, ("running",))
    r = await c.post(f"/tickets/{two}/ai/take-over", json={"member_id": an}, headers=AN)
    assert r.status_code == 200 and r.json()["assignee"] == an
    run = (await _runs(c, two))[0]
    assert run["stop_code"] == "takeover"


# --------------------------------------------------------------------------- questions


async def _asking(env, c, monkeypatch):
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "wait_question")
    pid, an = await _project(c)
    m = await _runner(c, pid, env["repo"])
    tid = await _ticket(c, pid)
    await _assign(c, tid, m["id"])
    run = await _wait(c, tid, ("running",))
    ctx = RunContext(
        run_id=run["id"],
        member_id=m["id"],
        member_name=m["name"],
        project_id=pid,
        ticket_id=tid,
        on_behalf_of="An Nguyen",
        mode="work",
    )
    return pid, an, m, tid, run, ctx


async def test_a_question_keeps_option_descriptions_and_the_recommended_one(
    env, monkeypatch
):
    c = env["c"]
    pid, an, m, tid, run, ctx = await _asking(env, c, monkeypatch)
    await runs.record_question(
        ctx,
        "Cursor or offset?",
        [
            {
                "label": "Cursor",
                "description": "Stable while activity arrives.",
                "recommended": True,
            },
            {"label": "Offset", "description": "Simpler."},
            "Something plain",
        ],
    )
    run = await _wait(c, tid, ("needs_input",))
    q = run["question"]
    assert q["options"] == ["Cursor", "Offset", "Something plain"]
    assert q["option_details"][0] == {
        "label": "Cursor",
        "description": "Stable while activity arrives.",
        "recommended": True,
    }
    assert (
        q["option_details"][2]["description"] == ""
        and not q["option_details"][2]["recommended"]
    )
    await c.post(f"/ai/runs/{run['id']}/cancel", json={})


async def test_unanswered_questions_are_reminded_at_15_min_then_every_2_hours(
    env, monkeypatch
):
    c = env["c"]
    pid, an, m, tid, run, ctx = await _asking(env, c, monkeypatch)
    # a project admin is the "lead" told from 6 h on
    lead = (
        await c.post(
            f"/projects/{pid}/members", json={"name": "Linh Pham", "role": "admin"}
        )
    ).json()
    await runs.record_question(ctx, "Cursor or offset?", ["Cursor", "Offset"])
    run = await _wait(c, tid, ("needs_input",))
    assert run["question"].get("reminders", []) == []

    async def asked_ago(minutes):
        async with env["maker"]() as s:
            row = await s.get(AiRun, run["id"])
            q = json.loads(row.question)
            q["asked_at"] = (datetime.now(UTC) - timedelta(minutes=minutes)).isoformat()
            row.question = json.dumps(q)
            s.add(row)
            await s.commit()
        await runs.tick()
        return (await _runs(c, tid))[0]["question"]

    q = await asked_ago(10)
    assert q.get("reminders", []) == []
    q = await asked_ago(16)
    assert [r["level"] for r in q["reminders"]] == [1] and "lead" not in q["reminders"][
        0
    ]
    q = await asked_ago(17)  # nothing new is due
    assert [r["level"] for r in q["reminders"]] == [1]
    q = await asked_ago(125)
    assert [r["level"] for r in q["reminders"]] == [1, 2]
    q = await asked_ago(7 * 60)
    assert q["reminders"][-1]["level"] == 4  # 15 min, 2 h, 4 h, 6 h
    assert q["reminders"][-1]["lead"] == [lead["name"]]
    from sqlmodel import select

    from models import AiNotification

    async with env["maker"]() as s:
        told = (
            await s.exec(
                select(AiNotification).where(AiNotification.event == "question")
            )
        ).all()
    assert len(told) == 1 and "has waited 7 h" in told[0].title
    await c.post(f"/ai/runs/{run['id']}/cancel", json={})


async def test_ask_someone_else_moves_the_question_and_pending(env, monkeypatch):
    c = env["c"]
    pid, an, m, tid, run, ctx = await _asking(env, c, monkeypatch)
    hoa = (await c.post(f"/projects/{pid}/members", json={"name": "Hoa Mai"})).json()
    await runs.record_question(ctx, "Cursor or offset?", ["Cursor", "Offset"])
    run = await _wait(c, tid, ("needs_input",))
    r = await c.post(
        f"/ai/runs/{run['id']}/ask-someone-else",
        json={"member_id": hoa["id"]},
        headers=AN,
    )
    assert r.status_code == 200
    assert r.json()["question"]["to"] == "Hoa Mai"
    t = (await c.get(f"/tickets/{tid}")).json()
    assert t["pending"] and t["pending_member_id"] == hoa["id"]
    assert any("asked Hoa Mai to answer" in cm["text"] for cm in t["comments"])
    # an AI member is not a person to ask
    r = await c.post(
        f"/ai/runs/{run['id']}/ask-someone-else", json={"member_id": m["id"]}
    )
    assert r.status_code == 409
    # the person who now holds the question can answer it
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "finish")
    r = await c.post(
        f"/ai/runs/{run['id']}/answer",
        json={"text": "Cursor"},
        headers={"X-Actor": "Hoa Mai"},
    )
    assert r.status_code == 200
    await _wait(c, tid, ("finished",))
    t = (await c.get(f"/tickets/{tid}")).json()
    answer = next(cm for cm in t["comments"] if cm.get("answer_to_run") == run["id"])
    assert answer["author"] == "Hoa Mai"


async def test_the_report_keeps_a_clean_test_summary(env):
    c = env["c"]
    pid, an = await _project(c)
    m = await _runner(c, pid, env["repo"])
    tid = await _ticket(c, pid)
    await _assign(c, tid, m["id"])
    run = await _wait(c, tid, ("finished",))
    ctx = RunContext(
        run_id=run["id"],
        member_id=m["id"],
        member_name=m["name"],
        project_id=pid,
        ticket_id=tid,
        on_behalf_of="An Nguyen",
        mode="work",
    )
    await runs.record_report(
        ctx,
        "Done",
        [{"text": "Works", "met": None}],
        {
            "passed": "14",
            "failed": 1,
            "lint": "clean",
            "failing": ["DragHandle.focus"],
            "x": 1,
        },
    )
    report = (await _runs(c, tid))[0]["report"]
    assert report["tests"] == {
        "passed": 14,
        "failed": 1,
        "lint": "clean",
        "failing": ["DragHandle.focus"],
    }


# --------------------------------------------------------------------------- the ask thread


def _pill(m):
    return f"@[{m['name']}](member:{m['id']})"


async def _answered(env, c, monkeypatch, question="why?"):
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "finish")
    pid, an = await _project(c)
    m = await _runner(c, pid, env["repo"])
    tid = await _ticket(c, pid)
    await c.post(
        f"/tickets/{tid}/comments",
        json={"text": f"{_pill(m)} {question}", "author": "user", "ai_intent": "ask"},
        headers=AN,
    )
    run = await _wait(c, tid, ("finished",))
    return pid, m, tid, run


async def test_regenerate_asks_again_and_can_replace_the_old_answer(env, monkeypatch):
    c = env["c"]
    pid, m, tid, run = await _answered(env, c, monkeypatch)
    t = (await c.get(f"/tickets/{tid}")).json()
    first_reply = run["reply_comment_id"]
    assert first_reply
    r = await c.post(
        f"/ai/runs/{run['id']}/regenerate", json={"replace": True}, headers=AN
    )
    assert r.status_code == 200
    new = r.json()
    assert new["mode"] == "ask" and new["number"] == run["number"] + 1
    assert new["source_comment_id"] == run["source_comment_id"]
    assert new["replaces_comment_id"] == first_reply
    await _until(lambda: _ended(c, tid, new["id"]))
    t = (await c.get(f"/tickets/{tid}")).json()
    live = [cm for cm in t["comments"] if (cm.get("ai") or {}).get("kind") == "answer"]
    assert (
        len(live) == 1 and live[0]["id"] != first_reply
    )  # the old answer was replaced
    async with env["maker"]() as s:
        stored = json.loads((await s.get(Ticket, tid)).comments)
    assert next(cm for cm in stored if cm["id"] == first_reply)["deleted_at"]


async def _ended(c, tid, run_id):
    run = next(x for x in await _runs(c, tid) if x["id"] == run_id)
    return run if run["state"] == "finished" else None


async def test_edit_and_re_run_keeps_the_old_answer_and_posts_the_edited_question(
    env, monkeypatch
):
    c = env["c"]
    pid, m, tid, run = await _answered(env, c, monkeypatch)
    r = await c.post(
        f"/ai/runs/{run['id']}/regenerate",
        json={"question": "why? also on touch screens?", "replace": False},
        headers={"X-Actor": "Hoa Mai"},
    )
    assert r.status_code == 200
    new = r.json()
    assert new["instruction"] == "why? also on touch screens?"
    assert new["source_comment_id"] != run["source_comment_id"]
    assert new["started_by"] == "Hoa Mai" and new["replaces_comment_id"] is None
    await _until(lambda: _ended(c, tid, new["id"]))
    t = (await c.get(f"/tickets/{tid}")).json()
    question = next(cm for cm in t["comments"] if cm["id"] == new["source_comment_id"])
    assert question["author"] == "Hoa Mai" and "touch screens" in question["text"]
    answers = [
        cm for cm in t["comments"] if (cm.get("ai") or {}).get("kind") == "answer"
    ]
    assert len(answers) == 2 and not any(a["deleted_at"] for a in answers)


async def test_only_an_ended_answer_can_be_regenerated(env, monkeypatch):
    c = env["c"]
    pid, m, tid, run = await _answered(env, c, monkeypatch)
    work_tid = await _ticket(c, pid, title="Work")
    await _assign(c, work_tid, m["id"])
    work = await _wait(c, work_tid, ("finished",))
    r = await c.post(f"/ai/runs/{work['id']}/regenerate", json={})
    assert r.status_code == 422 and "Retry for work" in r.json()["detail"]


async def test_feedback_keeps_only_known_reasons_and_can_be_taken_back(
    env, monkeypatch
):
    c = env["c"]
    pid, m, tid, run = await _answered(env, c, monkeypatch)
    r = await c.post(
        f"/ai/runs/{run['id']}/feedback",
        json={"rating": "down", "reasons": ["out_of_date", "rude", "too_long"]},
        headers=AN,
    )
    assert r.status_code == 200
    fb = r.json()["feedback"]
    assert fb["rating"] == "down" and fb["reasons"] == ["out_of_date", "too_long"]
    assert fb["by"] == "An Nguyen"
    r = await c.post(
        f"/ai/runs/{run['id']}/feedback", json={"rating": "up", "reasons": ["unsafe"]}
    )
    assert r.json()["feedback"]["reasons"] == []  # reasons belong to a thumbs down
    r = await c.post(f"/ai/runs/{run['id']}/feedback", json={"rating": "none"})
    assert r.json()["feedback"] is None
    r = await c.post(f"/ai/runs/{run['id']}/feedback", json={"rating": "meh"})
    assert r.status_code == 422


async def test_replying_under_an_ai_comment_asks_it_again(env, monkeypatch):
    c = env["c"]
    pid, m, tid, run = await _answered(env, c, monkeypatch)
    reply_to = run["reply_comment_id"]
    r = await c.post(
        f"/tickets/{tid}/comments",
        json={
            "text": "Can you also check touch devices?",
            "author": "user",
            "reply_to": reply_to,
        },
        headers={"X-Actor": "Hoa Mai"},
    )
    assert r.status_code == 200
    comment = r.json()["comments"][-1]
    assert comment["reply_to"] == reply_to and comment["asks_again"] == m["id"]
    again = (await _runs(c, tid))[0]
    assert again["mode"] == "ask" and again["trigger"] == "reply"
    assert again["member_id"] == m["id"] and again["started_by"] == "Hoa Mai"
    assert again["source_comment_id"] == comment["id"]
    assert again["instruction"] == "Can you also check touch devices?"
    await _until(lambda: _ended(c, tid, again["id"]))


async def test_a_reply_that_mentions_the_ai_asks_it_once(env, monkeypatch):
    c = env["c"]
    pid, m, tid, run = await _answered(env, c, monkeypatch)
    before = len(await _runs(c, tid))
    await c.post(
        f"/tickets/{tid}/comments",
        json={
            "text": f"{_pill(m)} and touch?",
            "author": "user",
            "reply_to": run["reply_comment_id"],
            "ai_intent": "ask",
        },
        headers=AN,
    )
    assert len(await _runs(c, tid)) == before + 1


async def test_a_reply_to_a_person_asks_nobody(env, monkeypatch):
    c = env["c"]
    pid, m, tid, run = await _answered(env, c, monkeypatch)
    t = (await c.get(f"/tickets/{tid}")).json()
    question = run["source_comment_id"]
    before = len(await _runs(c, tid))
    r = await c.post(
        f"/tickets/{tid}/comments",
        json={"text": "Agreed", "author": "user", "reply_to": question},
        headers=AN,
    )
    assert r.status_code == 200 and "asks_again" not in r.json()["comments"][-1]
    assert len(await _runs(c, tid)) == before
    assert t  # (the ticket was read before the reply)


# --------------------------------------------------------------------------- edits while the AI works


async def test_a_persons_edit_is_noted_on_the_active_run(env, monkeypatch):
    c = env["c"]
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "sleep")
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"])
    tid = await _ticket(c, pid, description="Keep the order.")
    await _assign(c, tid, m["id"])
    run = await _wait(c, tid, ("running",))
    # the same text again is not an edit; a priority change is not one either
    await c.patch(
        f"/tickets/{tid}",
        json={"description": "Keep the order.", "priority": "high"},
        headers={"X-Actor": "Hoa Mai"},
    )
    assert (await _runs(c, tid))[0]["context_notes"] == []
    await c.patch(
        f"/tickets/{tid}",
        json={"description": "Keep the order. Also hide it on read-only boards."},
        headers={"X-Actor": "Hoa Mai"},
    )
    now = (await _runs(c, tid))[0]
    assert len(now["context_notes"]) == 1
    note = now["context_notes"][0]
    assert (
        note["by"] == "Hoa Mai"
        and note["what"] == "the description"
        and not note["delivered"]
    )
    assert any(s["text"] == "Hoa Mai edited the description" for s in now["steps"])
    text = await runs.take_context_notes(run["id"])
    assert (
        text
        and "Hoa Mai edited the ticket" in text
        and "hide it on read-only boards" in text
    )
    assert await runs.take_context_notes(run["id"]) is None  # delivered once
    refreshed = (await _runs(c, tid))[0]
    assert refreshed["context_notes"][0]["delivered"]
    assert any(
        s["text"].startswith("Context refreshed at step") for s in refreshed["steps"]
    )
    # "Refresh context now" queues another one
    r = await c.post(f"/ai/runs/{run['id']}/refresh-context", headers=AN)
    assert r.status_code == 200 and len(r.json()["context_notes"]) == 2
    await c.post(f"/ai/runs/{run['id']}/cancel", json={})


async def test_an_agents_own_edits_are_not_context_notes(env):
    from kanban_mcp.tools.tickets import manage_ticket
    from services.ai import guard
    from tests.test_ai import _ctx

    ctx, pid, an, m, tid = await _ctx(env)
    tokens = guard.enter(ctx)
    try:
        await manage_ticket(action="update", ticket_id=tid, description="By the AI")
    finally:
        guard.leave(tokens)
    assert await runs.note_person_edit(tid, by="x", what="the title") == 1
    tokens = guard.enter(ctx)
    try:
        assert await runs.note_person_edit(tid, by="x", what="the title") == 0
    finally:
        guard.leave(tokens)


# --------------------------------------------------------------------------- review gate and undo


async def test_a_blocked_move_is_remembered_on_the_run(env):
    from kanban_mcp.tools.tickets import manage_ticket
    from services.ai import guard
    from tests.test_ai import _ctx

    ctx, pid, an, m, tid = await _ctx(env)
    tokens = guard.enter(ctx)
    try:
        with pytest.raises(ValueError, match="status_ceiling"):
            await manage_ticket(action="update", ticket_id=tid, status="done")
    finally:
        guard.leave(tokens)
    row = await _run(env, ctx.run_id)
    assert row.blocked_move == "done"
    run = (await env["c"].get(f"/ai/runs/{ctx.run_id}")).json()
    assert run["blocked_move"] == "done"


async def test_the_revert_preview_names_who_edited_a_field_and_lists_what_stays(env):
    from kanban_mcp.tools.tickets import manage_ticket
    from services.ai import guard
    from tests.test_ai import _ctx

    ctx, pid, an, m, tid = await _ctx(env)
    tokens = guard.enter(ctx)
    try:
        await manage_ticket(action="update", ticket_id=tid, estimate=2)
        await manage_ticket(action="update", ticket_id=tid, priority="critical")
    finally:
        guard.leave(tokens)
    c = env["c"]
    async with env["maker"]() as s:
        row = await s.get(AiRun, ctx.run_id)
        row.files = json.dumps(
            [{"path": "CardFooter.tsx", "added": 24, "removed": 3, "new": False}]
        )
        s.add(row)
        ticket = await s.get(Ticket, tid)
        ticket.branches = json.dumps([{"id": "b1", "name": "ai/kan-142-drag-handle"}])
        s.add(ticket)
        await s.commit()
    await c.patch(
        f"/tickets/{tid}", json={"estimate": 5}, headers={"X-Actor": "Tuan Vo"}
    )
    preview = (await c.get(f"/ai/runs/{ctx.run_id}/revert-preview")).json()
    by_field = {p["field"]: p for p in preview}
    assert by_field["estimate"]["conflict"] is True
    assert by_field["estimate"]["edited_by"] == "Tuan Vo"
    assert (
        by_field["priority"]["conflict"] is False
        and by_field["priority"]["kind"] == "field"
    )
    assert by_field["Files"]["kind"] == "files" and by_field["Files"]["count"] == 1
    assert (
        by_field["Branch"]["kind"] == "branch"
        and by_field["Branch"]["name"] == "ai/kan-142-drag-handle"
    )
