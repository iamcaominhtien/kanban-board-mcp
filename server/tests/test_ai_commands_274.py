"""What the #274 live check found outside memory: a Dev never learned the project's own test command (it ran
`python3 -m unittest`, refused, instead of the repository's `./test.sh`), and with no worktree its `git checkout
<branch>` was refused, so its work stayed on main. The run is now told the project's checks by name, the standard
library's test runner is allowed, and a run that commits may move to the ticket's branch."""

import json

import pytest

from services.ai import runs, tool_rules
from tests.test_ai import FAKE, _project, _runner, _ticket, _wait, env  # noqa: F401


@pytest.fixture(autouse=True)
def _runs_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("KANBAN_AI_RUNS_DIR", str(tmp_path / "ai-runs"))


def _last(record) -> list[str]:
    return [json.loads(x) for x in record.read_text().splitlines()][-1]


def _flag(args: list[str], name: str) -> str:
    return args[args.index(name) + 1] if name in args else ""


async def _dev_run(env, monkeypatch, tmp_path, ops: dict | None = None) -> list[str]:
    c = env["c"]
    record = tmp_path / "args.jsonl"
    monkeypatch.setenv("FAKE_CLAUDE_RECORD", str(record))
    pid, _ = await _project(c)
    if ops:
        r = await c.patch(f"/projects/{pid}/ai/ops", json=ops)
        assert r.status_code == 200, r.text
    m = await _runner(c, pid, env["repo"])
    await c.patch(f"/ai/members/{m['id']}", json={"config": {"role": "dev"}})
    tid = await _ticket(c, pid)
    await c.post(
        f"/tickets/{tid}/ai/assign", json={"member_id": m["id"], "start": "now"}
    )
    run = await _wait(c, tid, ("finished", "failed"))
    assert run["state"] == "finished", run
    return _last(record)


def test_commands_line_names_each_check_and_says_which_are_not_required():
    line = runs.commands_line(
        {
            "commands": {"test": "./test.sh  --once", "lint": "", "build": "make"},
            "checks_off": ["build"],
        }
    )
    assert "tests `./test.sh --once`" in line
    assert "build `make` (saved, not yet a required check)" in line
    assert "lint" not in line
    assert runs.commands_line({"commands": {"test": "", "lint": "", "build": ""}}) == ""


async def test_a_run_is_told_the_projects_own_test_command(env, monkeypatch, tmp_path):
    args = await _dev_run(
        env,
        monkeypatch,
        tmp_path,
        {"commands": {"test": "./test.sh", "lint": "", "build": ""}},
    )
    system = _flag(args, "--append-system-prompt")
    assert (
        "This project's own checks, allowed in every run: tests `./test.sh`" in system
    )
    assert "Bash(./test.sh:*)" in _flag(args, "--allowedTools")


async def test_a_dev_without_a_worktree_may_run_unittest_and_reach_the_tickets_branch(
    env, monkeypatch, tmp_path
):
    args = await _dev_run(env, monkeypatch, tmp_path)
    allowed = _flag(args, "--allowedTools").split(",")
    denied = _flag(args, "--disallowedTools").split(",")
    assert "Bash(python3 -m unittest:*)" in allowed
    assert set(tool_rules.BRANCH_SWITCH) <= set(allowed)
    assert set(tool_rules.BRANCH_DENY) <= set(denied)
    # plain `git checkout <path>` throws away changes: it stays refused
    assert "Bash(git checkout:*)" not in allowed
    system = _flag(args, "--append-system-prompt")
    assert "git switch <branch>" in system
    # a live Dev made SHOP-2's branch from SHOP-1's, where the checkout stood
    assert "never from another ticket's branch" in system


async def test_a_run_that_does_not_commit_gets_no_branch_switching(
    env, monkeypatch, tmp_path
):
    c = env["c"]
    record = tmp_path / "args.jsonl"
    monkeypatch.setenv("FAKE_CLAUDE_RECORD", str(record))
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"])
    await c.patch(f"/ai/members/{m['id']}", json={"config": {"role": "reviewer"}})
    tid = await _ticket(c, pid)
    await c.post(
        f"/tickets/{tid}/ai/assign", json={"member_id": m["id"], "start": "now"}
    )
    await _wait(c, tid, ("finished", "failed"))
    allowed = _flag(_last(record), "--allowedTools").split(",")
    assert not set(tool_rules.BRANCH_SWITCH) & set(allowed)
