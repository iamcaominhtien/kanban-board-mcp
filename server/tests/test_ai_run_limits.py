"""How much of the machine a CLI may use: it runs at a low priority on macOS when asked and is stopped when it grows past a
memory limit (some CLI versions leak many GB)."""

import subprocess
import sys

import pytest

from services.ai import cli, runs
from tests.test_ai import _project, _runner, _ticket, _wait, env  # noqa: F401
from tests.test_ai_ticket_work import _assign

AN = {"X-Actor": "An Nguyen"}


def test_low_priority_is_opt_in_and_macos_only(monkeypatch):
    monkeypatch.delenv("KANBAN_CLI_LOW_PRIORITY", raising=False)
    assert cli.low_priority_prefix() == []
    monkeypatch.setenv("KANBAN_CLI_LOW_PRIORITY", "1")
    if sys.platform == "darwin":
        assert cli.low_priority_prefix()[-1] == "-b"
    else:
        assert cli.low_priority_prefix() == []


def test_the_memory_limit_defaults_and_can_be_changed(monkeypatch):
    monkeypatch.delenv("KANBAN_RUN_MAX_RSS_MB", raising=False)
    assert cli.run_memory_limit_mb() == 4096
    monkeypatch.setenv("KANBAN_RUN_MAX_RSS_MB", "512")
    assert cli.run_memory_limit_mb() == 512
    monkeypatch.setenv("KANBAN_RUN_MAX_RSS_MB", "lots")
    assert cli.run_memory_limit_mb() == 4096


@pytest.mark.skipif(sys.platform == "win32", reason="reads `ps`")
def test_tree_memory_counts_the_children_too():
    code = (
        "import subprocess, sys, time\n"
        "subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])\n"
        "time.sleep(30)"
    )
    parent = subprocess.Popen([sys.executable, "-c", code])
    try:
        import time

        deadline = time.time() + 10
        used = None
        while time.time() < deadline:
            used = cli.tree_rss_mb(parent.pid)
            alone = cli.tree_rss_mb(parent.pid)
            if used and alone:
                break
            time.sleep(0.2)
        # two Python processes: more than one of them could hold
        assert used is not None and used > 5
    finally:
        cli.kill_tree(parent.pid)
        parent.wait()
    assert cli.tree_rss_mb(parent.pid) is None  # gone


async def test_a_run_that_passes_the_memory_limit_is_stopped(env, monkeypatch):
    c = env["c"]
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "sleep")  # a CLI that never ends by itself
    monkeypatch.setenv("KANBAN_RUN_MAX_RSS_MB", "1")  # any process is over this
    monkeypatch.setattr(runs, "MEMORY_CHECK_S", 0.2)
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"])
    tid = await _ticket(c, pid)
    await _assign(c, tid, m["id"])
    run = await _wait(c, tid, ("failed",))
    assert "Stopped: the CLI was using" in run["ended_reason"]
    assert "limit" in run["ended_reason"]
