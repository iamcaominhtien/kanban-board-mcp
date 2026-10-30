"""A long prompt or system prompt must not travel on the command line: Windows refuses a command over 8191 characters
through the `claude.cmd` shim and over 32767 at all ("command line is too long", WinError 206)."""

import json
import os
import shutil
import sys
from pathlib import Path

from services.ai import cli

ECHO = (
    "import json, sys\n"
    "a = sys.argv[1:]\n"
    "def flag(n):\n"
    "    return a[a.index(n) + 1] if n in a else None\n"
    "f = flag('--system-prompt-file')\n"
    "print(json.dumps({'argv': a, 'stdin': sys.stdin.read(),\n"
    "                  'system': open(f, encoding='utf-8').read() if f else None}))\n"
)


def test_a_short_command_is_left_alone():
    args = ["claude", "-p", "hi", "--system-prompt", "be brief"]
    assert cli.spill_long_args(args) == (args, None, None)


def test_a_long_prompt_and_system_prompt_leave_the_command_line(monkeypatch):
    monkeypatch.setattr(cli, "_MAX_COMMAND_CHARS", 200)
    prompt, system = "p" * 500, "s" * 500
    args = [
        "claude", "-p", prompt, "--output-format", "stream-json", "--system-prompt", system,
    ]  # fmt: skip
    out, stdin_text, folder = cli.spill_long_args(args)
    try:
        assert stdin_text == prompt
        assert out[:3] == ["claude", "-p", "--output-format"]
        assert "--system-prompt" not in out and prompt not in out and system not in out
        file = Path(out[out.index("--system-prompt-file") + 1])
        assert file.read_text(encoding="utf-8") == system
        assert len(" ".join(out)) < 200
    finally:
        shutil.rmtree(folder, ignore_errors=True)
    assert args[2] == prompt  # the caller's list is not touched


def test_append_system_prompt_goes_to_its_own_file_flag(monkeypatch):
    monkeypatch.setattr(cli, "_MAX_COMMAND_CHARS", 100)
    rules = "rules ✓" * 20
    out, stdin_text, folder = cli.spill_long_args(
        ["claude", "-p", "x" * 300, "--append-system-prompt", rules]
    )
    try:
        assert stdin_text == "x" * 300
        file = Path(out[out.index("--append-system-prompt-file") + 1])
        assert file.read_text(encoding="utf-8") == rules
    finally:
        shutil.rmtree(folder, ignore_errors=True)


async def test_the_process_gets_the_prompt_on_stdin_and_the_system_prompt_in_a_file(
    monkeypatch, tmp_path
):
    monkeypatch.setattr(cli, "_MAX_COMMAND_CHARS", 300)
    script = tmp_path / "echo.py"
    script.write_text(ECHO, encoding="utf-8")
    prompt, system = "Tôi cần AI ✓ " * 400, "Rules. " * 400
    proc = cli.CliProcess(
        [sys.executable, str(script), "-p", prompt, "--system-prompt", system],
        str(tmp_path),
    )
    await proc.start()
    temp = proc._temp
    assert temp and os.path.isdir(temp)
    lines = [ln async for ln in proc.lines()]
    assert await proc.wait() == 0
    got = json.loads(lines[0])
    assert got["stdin"] == prompt and got["system"] == system
    assert prompt not in got["argv"] and system not in got["argv"]
    assert not os.path.exists(temp)  # removed once the CLI has ended


async def test_a_short_command_still_gets_no_stdin(tmp_path):
    script = tmp_path / "echo.py"
    script.write_text(ECHO, encoding="utf-8")
    proc = cli.CliProcess(
        [sys.executable, str(script), "-p", "hello", "--system-prompt", "sys"],
        str(tmp_path),
    )
    await proc.start()
    lines = [ln async for ln in proc.lines()]
    await proc.wait()
    got = json.loads(lines[0])
    assert got["stdin"] == "" and got["argv"][:2] == ["-p", "hello"]
    assert got["system"] is None


def test_behind_a_windows_cmd_shim_even_a_short_multiline_prompt_leaves_the_command_line(
    monkeypatch,
):
    monkeypatch.setattr(cli.sys, "platform", "win32")
    prompt = "line one\nline two & more | %PATH%"
    out, stdin_text, folder = cli.spill_long_args(
        [r"C:\npm\claude.cmd", "-p", prompt, "--system-prompt", "rules\nmore"]
    )
    try:
        assert stdin_text == prompt
        assert out[1] == "-p" and "--system-prompt-file" in out
        assert prompt not in out
    finally:
        shutil.rmtree(folder, ignore_errors=True)
    # a native claude.exe takes short arguments as they are
    args = [r"C:\bin\claude.exe", "-p", prompt]
    assert cli.spill_long_args(args) == (args, None, None)
