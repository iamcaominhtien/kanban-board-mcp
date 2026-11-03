"""PC-5: Max turns and Run timeout of a Claude Code member reach its runs only once a person set them (`cli_limits`).
A member made before holds 40 turns and 30 minutes that were never applied: its runs stay unlimited."""

import json

from models import AiMember
from services.ai import runs
from services.ai.providers import cli_limit
from tests.test_ai import _project, _runner, _ticket, _wait, env  # noqa: F401


def test_a_stored_value_is_a_limit_only_when_a_person_turned_it_on():
    assert cli_limit({"max_turns": 40, "run_timeout_min": 30}, "max_turns") is None
    on = {"max_turns": 12, "run_timeout_min": 5, "cli_limits": ["max_turns"]}
    assert cli_limit(on, "max_turns") == 12
    assert cli_limit(on, "run_timeout_min") is None
    assert (
        cli_limit({"max_turns": None, "cli_limits": ["max_turns"]}, "max_turns") is None
    )


async def _args_of_one_run(env, monkeypatch, pid, member_id, title):
    c = env["c"]
    record = env["tmp"] / f"args-{title}.jsonl"
    monkeypatch.setenv("FAKE_CLAUDE_RECORD", str(record))
    tid = await _ticket(c, pid, title=title)
    await c.post(
        f"/tickets/{tid}/ai/assign", json={"member_id": member_id, "start": "now"}
    )
    run = await _wait(c, tid, ("finished", "failed"))
    assert run["state"] == "finished", run
    return json.loads(record.read_text().splitlines()[0])


async def test_max_turns_is_passed_only_when_set(env, monkeypatch):
    c = env["c"]
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"])
    stored = (await c.get(f"/ai/members/{m['id']}")).json()["config"]
    assert stored["max_turns"] == 40 and "cli_limits" not in stored
    args = await _args_of_one_run(env, monkeypatch, pid, m["id"], "Before")
    assert "--max-turns" not in args
    r = await c.patch(
        f"/ai/members/{m['id']}",
        json={"config": {"max_turns": 12, "cli_limits": ["max_turns"]}},
    )
    assert r.status_code == 200, r.text
    args = await _args_of_one_run(env, monkeypatch, pid, m["id"], "After")
    assert args[args.index("--max-turns") + 1] == "12"
    # emptied again: no limit
    await c.patch(f"/ai/members/{m['id']}", json={"config": {"cli_limits": []}})
    args = await _args_of_one_run(env, monkeypatch, pid, m["id"], "Cleared")
    assert "--max-turns" not in args


async def test_only_the_two_limits_can_be_turned_on(env):
    c = env["c"]
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"])
    r = await c.patch(
        f"/ai/members/{m['id']}", json={"config": {"cli_limits": ["max_steps"]}}
    )
    assert r.status_code == 422, r.text


async def test_the_run_timeout_ends_a_run_once_set(env, monkeypatch):
    c = env["c"]
    pid, _ = await _project(c)
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "sleep")
    monkeypatch.setattr(runs, "RUN_TIMEOUT_UNIT_S", 1.5)
    m = await _runner(c, pid, env["repo"])
    async with env["maker"]() as s:
        p = await s.get(AiMember, m["id"])
        cfg = json.loads(p.config)
        cfg["run_timeout_min"] = 1
        cfg["cli_limits"] = ["run_timeout_min"]
        p.config = json.dumps(cfg)
        s.add(p)
        await s.commit()
    tid = await _ticket(c, pid, title="Slow")
    await c.post(
        f"/tickets/{tid}/ai/assign", json={"member_id": m["id"], "start": "now"}
    )
    run = await _wait(c, tid, ("timed_out", "finished", "failed"), timeout=20)
    assert run["state"] == "timed_out", run
    assert "run timeout (1 min)" in run["ended_reason"]
