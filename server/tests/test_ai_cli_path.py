"""A CLI path the person configured is the only one the board tries: a refused or unusable path means no CLI and a
sentence that says why, never another `claude` found on PATH (found when a stand-in path was refused and the board ran
the real Claude on the real account's quota)."""

import os
import stat
from pathlib import Path

from services.ai import cli
from tests.ai_helpers import _project, _runner, _ticket, _wait, env  # noqa: F401


def _program(folder: Path, name: str = "claude", *, executable: bool = True) -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    p = folder / name
    p.write_text("#!/bin/sh\necho 1.0\n")
    p.chmod(p.stat().st_mode | (stat.S_IXUSR if executable else 0))
    if not executable:
        p.chmod(p.stat().st_mode & ~(stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH))
    return p


def test_a_refused_or_unusable_configured_path_is_not_replaced_by_the_one_on_path(
    tmp_path, monkeypatch
):
    on_path = _program(tmp_path / "on-path")
    monkeypatch.setenv("PATH", f"{on_path.parent}{os.pathsep}{os.environ['PATH']}")
    # nothing configured: PATH is searched, as before
    assert cli.find_cli("claude")[0] == str(on_path)
    assert cli.find_cli("claude", "  ")[0] == str(on_path)

    # a path outside the folders the board allows is refused, and PATH is not tried instead
    monkeypatch.delenv("KANBAN_AI_ROOTS", raising=False)
    outside = _program(tmp_path / "outside")
    path, checked = cli.find_cli("claude", str(outside))
    assert path is None and "PATH" not in checked
    said = cli.missing("claude", str(outside))
    assert str(outside) in said and "does not run another claude" in said
    assert "home folder" in said

    # allowed, but not executable, or not there at all
    monkeypatch.setenv("KANBAN_AI_ROOTS", str(tmp_path))
    flat = _program(tmp_path / "flat", executable=False)
    assert cli.find_cli("claude", str(flat))[0] is None
    assert "not executable" in cli.missing("claude", str(flat))
    assert cli.find_cli("claude", str(tmp_path / "nope" / "claude"))[0] is None
    assert "not a file" in cli.missing("claude", str(tmp_path / "nope" / "claude"))

    # allowed and executable: used
    good = _program(tmp_path / "good")
    assert cli.find_cli("claude", str(good))[0] == str(good)
    assert cli.missing("claude") == "“claude” was not found on this computer"


async def test_a_run_of_an_ai_with_an_unusable_cli_path_waits_and_says_why(
    env, monkeypatch, tmp_path
):
    on_path = _program(tmp_path / "on-path")
    monkeypatch.setenv("PATH", f"{on_path.parent}{os.pathsep}{os.environ['PATH']}")
    unusable = _program(tmp_path / "unusable", executable=False)
    c = env["c"]
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"], cli_path=str(unusable))
    tid = await _ticket(c, pid, title="Fix it")
    started = await c.patch(f"/tickets/{tid}", json={"assignee": m["id"]})
    assert started.status_code == 200, started.text
    # the team is marked without a runner, with the reason, and its run waits: nothing else is started
    got = (await c.get(f"/ai/teams/{m['id']}")).json()
    assert got["health"] == "runner_missing"
    assert str(unusable) in got["health_detail"]
    assert "not executable" in got["health_detail"]
    assert "does not run another claude" in got["health_detail"]
    run = (await c.get(f"/tickets/{tid}/ai/runs")).json()[0]
    assert run["state"] == "queued" and run["started_at"] is None
