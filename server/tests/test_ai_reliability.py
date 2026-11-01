"""Reliability of CLI runs (design/screens/ai-operations.md C, D, E): failures by kind, the usage window as a hold,
runs per account, the watchdog's diagnosis and its actions, never twice after a resume, messages to a running AI."""

import asyncio
import json
import subprocess
import sys
import time
from datetime import UTC, datetime, timedelta

import psutil
import pytest

from models import AiAccountState, AiRun
from services.ai import failures, guard, quota, runs, watchdog
from tests.test_ai import _project, _runner, _ticket, _wait, env  # noqa: F401


@pytest.fixture(autouse=True)
def _runs_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("KANBAN_AI_RUNS_DIR", str(tmp_path / "ai-runs"))
    # the retries of a run happen at once in tests
    monkeypatch.setattr(failures, "NETWORK_DELAYS_S", (0, 0, 0))


async def _start(env, mode, monkeypatch, **member):
    c = env["c"]
    monkeypatch.setenv("FAKE_CLAUDE_MODE", mode)
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"], **member)
    tid = await _ticket(c, pid)
    r = await c.post(
        f"/tickets/{tid}/ai/assign", json={"member_id": m["id"], "start": "now"}
    )
    assert r.status_code == 200, r.text
    return pid, m, tid


async def _until(c, tid, pred, timeout=15.0):
    deadline = asyncio.get_running_loop().time() + timeout
    while True:
        rows = (await c.get(f"/tickets/{tid}/ai/runs")).json()
        if rows and pred(rows[0]):
            return rows[0]
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError(
                f"never: {rows[0]['state'] if rows else None} {[s['kind'] for s in rows[0]['steps']] if rows else ''}"
            )
        runs.RT.wake.set()
        await asyncio.sleep(0.1)


async def _needs_row(c, pred, timeout=10.0):
    """The first Needs you row matching `pred`, once it is written (the run's end writes it a moment later)."""
    deadline = asyncio.get_running_loop().time() + timeout
    while True:
        panel = (
            await c.get("/notifications", params={"view": "panel", "tab": "needs"})
        ).json()
        found = [i for i in panel["items"] if pred(i)]
        if found:
            return found[0]
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError(
                f"no such Needs you row: {[i['kind'] for i in panel['items']]}"
            )
        await asyncio.sleep(0.1)


# --------------------------------------------------------------------------- failures by kind


@pytest.mark.parametrize(
    ("result", "code", "stderr", "kind"),
    [
        (
            {
                "text": "You've hit your weekly limit",
                "api_error": "usage_limit_reached",
                "api_status": 429,
            },
            1,
            [],
            "window",
        ),
        ({"text": "API Error: 529 Overloaded", "api_status": 529}, 1, [], "network"),
        (None, 1, ["Error: socket hang up"], "network"),
        (None, 139, ["Segmentation fault"], "crash"),
        ({"text": "Prompt is too long"}, 1, [], "compact"),
        (None, 1, ["Not logged in. Please log in"], "signed_out"),
        ({"text": "Not logged in · Please run /login"}, 1, [], "signed_out"),
        (
            {"text": "API Error: 429 rate_limit_error. Retry after 30 seconds."},
            1,
            [],
            "rate_limit",
        ),
        ({"text": "Something broke"}, 1, [], "error"),
    ],
)
def test_a_stop_is_classified_by_kind(result, code, stderr, kind):
    assert failures.classify(result, code, stderr)[0] == kind


def test_a_rejected_window_wins_over_anything_else_said():
    got, _ = failures.classify({"text": "429"}, 1, [], quota={"status": "rejected"})
    assert got == "window"


async def test_a_used_up_window_holds_the_run_without_counting_a_try(env, monkeypatch):
    c = env["c"]
    pid, m, tid = await _start(env, "window", monkeypatch)
    run = await _until(c, tid, lambda r: any(s["kind"] == "window" for s in r["steps"]))
    assert run["state"] == "queued"
    assert (
        "Not a failure"
        in [s for s in run["steps"] if s["kind"] == "window"][-1]["text"]
    )
    # nothing counted against the member: its health is untouched
    assert (await c.get(f"/ai/members/{m['id']}")).json()["health"] != "rate_limited"
    windows = (await c.get("/ai/windows")).json()["accounts"]
    local = next(a for a in windows if a["key"] == quota.LOCAL)
    assert local["held_until"]
    assert local["seven_day"]["used"] == 1.0
    assert local["waiting"] == 1
    # the reason the run waits is the window, in its own words
    await asyncio.sleep(0.3)
    run = (await c.get(f"/tickets/{tid}/ai/runs")).json()[0]
    assert run["waiting_reason"].startswith("Waiting for the next window")
    # the window reopens: the same run goes on
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "finish")
    async with env["maker"]() as s:
        row = await s.get(AiAccountState, quota.LOCAL)
        row.held_until = (datetime.now(UTC) - timedelta(seconds=1)).isoformat()
        s.add(row)
        await s.commit()
    done = await _wait(c, tid, ("finished",))
    assert done["id"] == run["id"]


async def test_a_network_error_resumes_with_backoff_then_stops_with_a_diagnosis(
    env, monkeypatch
):
    c = env["c"]
    pid, m, tid = await _start(env, "network", monkeypatch)
    run = await _wait(c, tid, ("failed",))
    retries = [s for s in run["steps"] if s["kind"] == "retry"]
    assert len(retries) == 3
    assert "try 3 of 3" in retries[-1]["text"]
    async with env["maker"]() as s:
        row = await s.get(AiRun, run["id"])
    diag = json.loads(row.diagnosis)
    assert diag["cause"] == "network"
    assert len(diag["tried"]) == 3
    assert diag["actions"] == ["retry", "continue_note", "hand_to", "cancel"]
    row_ = await _needs_row(c, lambda i: i["ticket_id"] == tid)
    assert row_["kind"] == "run_failed"
    assert row_["data"]["diagnosis"]["cause"] == "network"


async def test_a_crash_is_resumed_once_then_read_from_stderr(env, monkeypatch):
    c = env["c"]
    pid, m, tid = await _start(env, "crash", monkeypatch)
    run = await _wait(c, tid, ("failed",))
    assert sum(1 for s in run["steps"] if s["kind"] == "retry") == 1
    async with env["maker"]() as s:
        diag = json.loads((await s.get(AiRun, run["id"])).diagnosis)
    assert diag["cause"] == "crash"
    assert "segmentation fault" in diag["means"].lower()


async def test_a_conversation_too_long_starts_fresh_with_a_hand_over(
    env, monkeypatch, tmp_path
):
    c = env["c"]
    record = tmp_path / "args.jsonl"
    monkeypatch.setenv("FAKE_CLAUDE_RECORD", str(record))
    pid, m, tid = await _start(env, "too_long", monkeypatch)
    run = await _wait(c, tid, ("finished",))
    assert any(
        s["kind"] == "retry" and "fresh conversation" in s["text"] for s in run["steps"]
    )
    calls = [json.loads(x) for x in record.read_text().splitlines()]
    last = calls[-1]
    prompt = last[last.index("-p") + 1]
    assert "hand-over" in prompt
    assert "Fix add()" in prompt  # the ticket comes with it, not only the note
    assert "--session-id" in last


async def test_runs_per_account_wait_for_a_free_slot(env, monkeypatch):
    c = env["c"]
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "sleep")
    pid, _ = await _project(c)
    a = await _runner(c, pid, env["repo"], name="A")
    b = await _runner(c, pid, env["repo"], name="B")
    await c.patch(f"/ai/windows/{quota.LOCAL}", json={"max_parallel": 1})
    t1, t2 = await _ticket(c, pid, "one"), await _ticket(c, pid, "two")
    await c.post(
        f"/tickets/{t1}/ai/assign", json={"member_id": a["id"], "start": "now"}
    )
    await _wait(c, t1, ("running",))
    await c.post(
        f"/tickets/{t2}/ai/assign", json={"member_id": b["id"], "start": "now"}
    )
    await asyncio.sleep(0.5)
    second = (await c.get(f"/tickets/{t2}/ai/runs")).json()[0]
    assert second["state"] == "queued"
    assert "free slot on the account" in second["waiting_reason"]
    first = (await c.get(f"/tickets/{t1}/ai/runs")).json()[0]
    await runs.cancel(first["id"], by="t")
    assert (await _wait(c, t2, ("running",)))["state"] == "running"
    await runs.cancel((await c.get(f"/tickets/{t2}/ai/runs")).json()[0]["id"], by="t")


async def test_the_window_reading_of_a_run_is_kept_per_account(env, monkeypatch):
    c = env["c"]
    monkeypatch.setenv("FAKE_CLAUDE_QUOTA", "0.42")
    pid, m, tid = await _start(env, "finish", monkeypatch)
    await _wait(c, tid, ("finished",))
    local = next(
        a
        for a in (await c.get("/ai/windows")).json()["accounts"]
        if a["key"] == quota.LOCAL
    )
    assert local["five_hour"]["used"] == pytest.approx(0.42)
    assert local["held_until"] is None


async def test_urgent_tickets_start_first(env, monkeypatch):
    c = env["c"]
    async with env["maker"]() as s:
        pid, _ = await _project(c)
    low = await _ticket(c, pid, "low", priority="low")
    high = await _ticket(c, pid, "high", priority="critical")
    rows = [
        AiRun(
            project_id=pid,
            ticket_id=low,
            member_id="m",
            queued_at="2026-01-01T00:00:00",
        ),
        AiRun(
            project_id=pid,
            ticket_id=high,
            member_id="m",
            queued_at="2026-01-02T00:00:00",
        ),
    ]
    async with env["maker"]() as s:
        ordered = await runs._by_priority(s, rows)
    assert [r.ticket_id for r in ordered] == [high, low]


# --------------------------------------------------------------------------- the watchdog


def test_a_server_in_the_foreground_is_diagnosed_and_its_child_stopped():
    holder = subprocess.Popen(
        [
            sys.executable,
            "-c",
            "import subprocess, sys, time; subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)']); time.sleep(60)",
        ]
    )
    try:
        time.sleep(0.6)
        w = watchdog.RunWatch()
        w.observe(
            json.dumps(
                {
                    "type": "assistant",
                    "message": {
                        "content": [
                            {
                                "type": "tool_use",
                                "id": "x",
                                "name": "Bash",
                                "input": {"command": "npm run dev"},
                            }
                        ]
                    },
                }
            )
        )
        w.open["x"]["at"] -= watchdog.SERVER_AFTER_S + 5
        w.last_event -= watchdog.SERVER_AFTER_S + 5
        diag = asyncio.run(watchdog.diagnose(w, holder.pid))
        assert diag["cause"] == "foreground_server"
        assert diag["actions"][0] == "stop_child"
        assert "background" in diag["lesson"]
        child = diag["child"]["pid"]
        assert watchdog.stop_child(child)
        time.sleep(0.3)
        assert (
            not psutil.pid_exists(child)
            or psutil.Process(child).status() == psutil.STATUS_ZOMBIE
        )
    finally:
        holder.kill()


def test_a_quiet_run_under_the_threshold_is_left_alone():
    w = watchdog.RunWatch()
    assert asyncio.run(watchdog.diagnose(w, None)) is None


def test_an_interactive_command_is_recognised():
    assert watchdog._INPUT.search("git commit")
    assert not watchdog._INPUT.search('git commit -m "x"')
    assert watchdog._INPUT.search("npx create-vite app")
    assert not watchdog._INPUT.search("npx --yes create-vite app")
    assert watchdog._SERVER.search("cd ui && npm run dev")
    assert watchdog._SERVER.search("uvicorn main:app --reload")
    assert not watchdog._SERVER.search("npm run build")


def test_the_light_models_answer_is_parsed_or_refused():
    got = watchdog.parse_model_answer(
        'Sure: {"cause": "x", "action": "explode", "means": "m"}'
    )
    assert got["action"] == "needs_person"
    assert watchdog.parse_model_answer("no json") is None


async def test_the_runner_diagnoses_a_dev_server_and_stopping_it_lets_the_run_go_on(
    env, monkeypatch, tmp_path
):
    c = env["c"]
    monkeypatch.setattr(watchdog, "SERVER_AFTER_S", 0.5)
    monkeypatch.setattr(runs, "WATCH_EVERY_S", 0.3)
    pidfile = tmp_path / "srv.pid"
    monkeypatch.setenv("FAKE_CLAUDE_PIDFILE", str(pidfile))
    pid, m, tid = await _start(env, "dev_server", monkeypatch)
    run = await _until(
        c, tid, lambda r: any(s["kind"] == "trouble" for s in r["steps"])
    )
    assert run["state"] == "running"
    card = await _needs_row(c, lambda i: i["kind"] == "run_stuck")
    assert card["data"]["diagnosis"]["cause"] == "foreground_server"
    assert [a["id"] for a in card["actions"]][0] == "trouble:stop_child"
    r = await c.post(f"/ai/runs/{run['id']}/trouble", json={"action": "stop_child"})
    assert r.status_code == 200, r.text
    done = await _wait(c, tid, ("finished",))
    assert any("Stopped" in s["text"] for s in done["steps"])
    panel = (
        await c.get("/notifications", params={"view": "panel", "tab": "needs"})
    ).json()
    assert not [
        i for i in panel["items"] if i["kind"] == "run_stuck" and not i.get("done_text")
    ]


# --------------------------------------------------------------------------- never twice, messages, continue, hand to


def test_an_identical_write_after_a_resume_is_skipped_once():
    guard._recent_writes.clear()
    guard._resumed_at.clear()
    fp = guard._fingerprint("ticket_items", "comment.add", {"text": "Done"})
    guard._remember_write("run_1", fp, {"id": "c1"})
    assert (
        guard._repeat_of("run_1", fp) is None
    )  # no resume yet: a second identical write is the AI's choice
    guard.mark_resumed("run_1")
    assert guard._repeat_of("run_1", fp) == {"id": "c1"}
    other = guard._fingerprint("ticket_items", "comment.add", {"text": "Other"})
    assert guard._repeat_of("run_1", other) is None


async def test_a_message_reaches_a_running_ai_with_its_next_board_call(
    env, monkeypatch
):
    c = env["c"]
    pid, m, tid = await _start(env, "sleep", monkeypatch)
    run = await _wait(c, tid, ("running",))
    r = await c.post(
        f"/ai/runs/{run['id']}/tell", json={"text": "Use the cursor, not the offset."}
    )
    assert r.json()["delivered"] == "next_board_call"
    notice = await runs.take_context_notes(run["id"])
    assert "Use the cursor, not the offset." in notice
    assert "edited the ticket" not in notice
    await runs.cancel(run["id"], by="t")


async def test_continue_with_a_note_resumes_the_same_conversation(
    env, monkeypatch, tmp_path
):
    c = env["c"]
    record = tmp_path / "args.jsonl"
    monkeypatch.setenv("FAKE_CLAUDE_RECORD", str(record))
    pid, m, tid = await _start(env, "fail", monkeypatch)
    failed = await _wait(c, tid, ("failed",))
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "finish")
    r = await c.post(
        f"/ai/runs/{failed['id']}/continue", json={"note": "The test DB is in /tmp."}
    )
    assert r.status_code == 200, r.text
    nxt = await _wait(c, tid, ("finished",))
    assert nxt["number"] == failed["number"] + 1
    last = [json.loads(x) for x in record.read_text().splitlines()][-1]
    assert "--resume" in last
    assert last[last.index("--resume") + 1] == failed["session_id"]


async def test_hand_to_another_ai_starts_it_from_a_hand_over(env, monkeypatch):
    c = env["c"]
    pid, m, tid = await _start(env, "fail", monkeypatch)
    failed = await _wait(c, tid, ("failed",))
    other = await _runner(c, pid, env["repo"], name="Claude Code · Second")
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "finish")
    r = await c.post(
        f"/ai/runs/{failed['id']}/hand-to", json={"member_id": other["id"]}
    )
    assert r.status_code == 200, r.text
    assert r.json()["member_id"] == other["id"]
    assert "hand-over" in r.json()["instruction"]
    t = (await c.get(f"/tickets/{tid}")).json()
    assert t["assignee"] == other["id"]
    same = await c.post(f"/ai/runs/{failed['id']}/hand-to", json={"member_id": m["id"]})
    assert same.status_code == 422


async def test_project_ops_settings_merge_over_defaults(env):
    c = env["c"]
    pid, _ = await _project(c)
    got = (await c.get(f"/projects/{pid}/ai/ops")).json()
    assert got["hang_after_min"] == 10
    assert got["worktrees"]["on"] is False
    out = (
        await c.patch(
            f"/projects/{pid}/ai/ops", json={"worktrees": {"on": True}, "nonsense": 1}
        )
    ).json()
    assert out["worktrees"]["on"] is True
    assert out["worktrees"]["base_port"] == 5180
    assert "nonsense" not in out
