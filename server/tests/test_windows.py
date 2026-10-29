"""The desktop app runs on Windows too: no Linux-only strftime codes (Windows has no `%-d`, and every request
that used it failed, so Ask AI disappeared from the board) and no /proc to look at processes."""

import pathlib
import re

from services.ai.assist import settings

_UNPORTABLE = re.compile(r"%-[A-Za-z]")


def test_no_platform_specific_strftime_codes():
    root = pathlib.Path(__file__).resolve().parent.parent
    found = [
        f"{p.relative_to(root)}:{i}"
        for folder in ("api", "services", "kanban_mcp")
        for p in (root / folder).rglob("*.py")
        for i, line in enumerate(p.read_text(encoding="utf-8").splitlines(), 1)
        if _UNPORTABLE.search(line)
    ]
    assert found == []


def test_next_month_label_has_no_leading_zero():
    label = settings.next_month_label()
    month, day = label.split()
    assert day == "1" and len(month) == 3


def test_a_leftover_cli_is_recognised_on_windows(monkeypatch):
    """Windows has no /proc: the command line comes from PowerShell, and only our CLI is killed after a crash."""
    import subprocess
    import types

    from services.ai import cli

    seen = {}

    def fake_run(args, **kwargs):
        seen["args"] = args
        line = (
            b"C:\\npm\\claude.cmd -p --output-format stream-json"
            if "42" in args[-1]
            else b"notepad.exe"
        )
        return types.SimpleNamespace(stdout=line, returncode=0)

    monkeypatch.setattr(cli.sys, "platform", "win32")
    monkeypatch.setattr(subprocess, "run", fake_run)
    assert cli.looks_like_cli(42) and not cli.looks_like_cli(43)
    assert seen["args"][0] == "powershell" and "ProcessId=43" in seen["args"][-1]
