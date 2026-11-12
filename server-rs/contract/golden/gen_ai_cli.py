"""Golden vectors for the pure functions of `services/ai/cli.py` (`crates/kb-ai-run/src/cli/`): the command lines
`spill_long_args` builds on each platform branch (a short command, a long one, behind a Windows `.cmd` shim), the
Windows command line of a list of arguments, `looks_like_cli`, the CLI's environment, what a limit message means
(`rate_limit_line`, `rate_limit_wait`, `reset_wait` in many zones and across DST), tool calls as step texts, test
counts and result texts.

Run from `server/`:  .venv/bin/python ../server-rs/contract/golden/gen_ai_cli.py
Writes `ai_cli.json` next to this file.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import UTC, datetime
from pathlib import Path
from unittest import mock

work = tempfile.mkdtemp(prefix="gen-ai-cli-")
os.environ["KANBAN_CONFIG_DIR"] = f"{work}/config"
os.environ["KANBAN_DB_PATH"] = f"{work}/data/kanban.db"
os.environ["KANBAN_LOG_DIR"] = f"{work}/logs"
os.environ["KANBAN_AI_KEY_FILE"] = f"{work}/ai.key"
os.environ["CLAUDE_CONFIG_DIR"] = f"{work}/claude"
os.environ["HOME"] = f"{work}/home"
os.environ["TMPDIR"] = work
tempfile.tempdir = None
sys.path.insert(0, os.getcwd())

from services.ai import cli  # noqa: E402

OUT = Path(__file__).with_name("ai_cli.json")
out: dict = {}
SECRET = "sk-ant-" + "a1b2c3d4e5f6g7h8"

# --------------------------------------------------------------------------------------------------------------
# command lines
# --------------------------------------------------------------------------------------------------------------
ARG_LISTS = [
    ["claude"],
    ["claude", "-p", "hi"],
    ["claude", "-p", "hi there", "--system-prompt", "be brief"],
    ["claude", "-p", "", "--model", "sonnet"],
    ["claude", "-p", 'say "hi"', "--x", "back\\slash", "trail\\", 'q\\"x', "a b\\", "tab\there", "\\\\server\\share"],
    ["C:\\Program Files\\nodejs\\claude.exe", "-p", "x", "--append-system-prompt", "rules ✓"],
    ["claude", "--output-format", "stream-json", "--verbose", "--session-id", "0a1b", "--permission-mode", "bypassPermissions", "--model", "opus", "--effort", "high", "--mcp-config", '{"mcpServers": {"kanban": {"type": "http", "url": "http://127.0.0.1:8000/mcp"}}}', "--json-schema", '{"type": "object"}', "--disallowedTools", "Bash(rm:*)", "WebFetch", "-p", "Fix the bug in add()"],
    ["claude", "-p", "p" * 500, "--output-format", "stream-json", "--system-prompt", "s" * 500],
    ["claude", "-p", "x" * 300, "--append-system-prompt", "rules ✓" * 20],
    ["claude", "--system-prompt", "S" * 300, "--append-system-prompt", "A" * 300, "-p", "P" * 300],
    ["claude", "-p", "--input-format", "stream-json", "--system-prompt", "S" * 400],
    ["claude", "--system-prompt"],
    ["claude", "-p"],
    ["claude", "x" * 400, "-p"],
    ["claude", "-p", "one", "-p", "two" * 200, "--system-prompt", "a", "--system-prompt", "b" * 300],
    ["claude", "-p", "Tôi cần AI ✓ " * 30, "--system-prompt", "é" * 150],
    ["claude", "--system-prompt-file", "/tmp/x.txt", "-p", "y" * 400],
    [r"C:\npm\claude.cmd", "-p", "line one\nline two & more | %PATH%", "--system-prompt", "rules\nmore"],
    [r"C:\npm\CLAUDE.CMD", "-p", "short"],
    [r"C:\tools\run.bat", "--append-system-prompt", "x"],
    [r"C:\bin\claude.exe", "-p", "line one\nline two & more | %PATH%"],
    ["claude.cmd"],
    [],
]


def spill_cases():
    cases = []
    for platform in ("linux", "darwin", "win32"):
        for limit in (None, 200, 60):
            for prompt_on_stdin in (True, False):
                for args in ARG_LISTS:
                    with mock.patch.object(cli.sys, "platform", platform):
                        default = 6000 if platform == "win32" else 100_000
                        with mock.patch.object(cli, "_MAX_COMMAND_CHARS", limit or default):
                            through = cli._through_cmd_exe(args)
                            got, stdin_text, folder = cli.spill_long_args(list(args), prompt_on_stdin=prompt_on_stdin)
                    files = {}
                    if folder:
                        for name in sorted(os.listdir(folder)):
                            files[name] = Path(folder, name).read_text(encoding="utf-8")
                        got = [a.replace(folder, "<TEMP>") for a in got]
                        assert os.path.basename(folder).startswith("kanban-cli-")
                        shutil.rmtree(folder)
                    cases.append(
                        {
                            "platform": platform,
                            "max_chars": limit or default,
                            "prompt_on_stdin": prompt_on_stdin,
                            "args": args,
                            "through_cmd_exe": through,
                            "out": got,
                            "stdin": stdin_text,
                            "files": files if folder else None,
                        }
                    )
    return cases


out["spill"] = spill_cases()
out["max_command_chars"] = {}
for platform in ("linux", "darwin", "win32"):
    with mock.patch.object(sys, "platform", platform):
        out["max_command_chars"][platform] = 6000 if sys.platform == "win32" else 100_000
out["list2cmdline"] = [{"args": a, "out": subprocess.list2cmdline(a)} for a in ARG_LISTS] + [
    {"args": a, "out": subprocess.list2cmdline(a)}
    for a in (["a\\\\b c", 'd"e'], ['"'], ["\\"], ["a\tb"], ["", ""], ['\\"'], ['x\\\\"y z'], ["ünï cödé", "✓"])
]

# --------------------------------------------------------------------------------------------------------------
# looks_like_cli: the decision on a command line (the Linux branch reads /proc/<pid>/cmdline)
# --------------------------------------------------------------------------------------------------------------
COMMAND_LINES = [
    b"/home/an/.local/bin/claude\0-p\0hi\0--output-format\0stream-json\0",
    b"node\0/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js\0--output-format\0json\0",
    b"claude\0--json\0",
    b"claude\0--format\0x\0",
    b"claude\0-p\0hi\0",
    b"vim\0notes.txt\0--output-format\0",
    b"python\0fake_claude.py\0-p\0x\0--output-format\0stream-json\0",
    b"/opt/tools/codex\0exec\0--json\0",
    b"CLAUDE\0--output-format\0json\0",
    b"",
    b"claude --output-format stream-json",
    b"cl\0aude\0--output-format\0",
    b"claude\0--output\0-format\0",
    b"claude\xff\xfe\0--output-format\0",
    "kl\u00e4ude\0claude\0--formatter\0".encode(),
]


class FakeProc:
    def __init__(self, raw):
        self.raw = raw

    def read_bytes(self):
        return self.raw


def looks_cases():
    cases = []
    for raw in COMMAND_LINES:
        for binary in (None, "claude", "codex", "", "node"):
            with mock.patch.object(cli, "Path", lambda _p, raw=raw: FakeProc(raw)), mock.patch.object(cli.sys, "platform", "linux"):
                got = cli.looks_like_cli(4242, binary)
            cases.append({"cmd": raw.replace(b"\0", b" ").decode(errors="replace"), "binary": binary, "out": got})
    return cases


out["looks_like_cli"] = looks_cases()

# --------------------------------------------------------------------------------------------------------------
# the CLI's environment
# --------------------------------------------------------------------------------------------------------------
ENVS = [
    {"PATH": "/usr/bin", "HOME": "/home/an"},
    {"PATH": "/usr/bin", "CLAUDECODE": "1", "CLAUDE_CODE_ENTRYPOINT": "cli", "CLAUDE_CODE_SESSION_ID": "abc", "CLAUDE_CONFIG_DIR": "/x", "CLAUDE_CODE_OTHER": "kept"},
    {"MCP_TOOL_TIMEOUT": "5", "A": "1"},
    {"CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": "50", "Z": "ž"},
    {},
]
out["child_env"] = []
for env in ENVS:
    for pct in (None, 0, 70, 100):
        with mock.patch.dict(os.environ, env, clear=True):
            got = cli.child_env(pct)
        out["child_env"].append({"env": list(env.items()), "pct": pct, "out": list(got.items())})

# --------------------------------------------------------------------------------------------------------------
# limits
# --------------------------------------------------------------------------------------------------------------
LIMIT_TEXTS = [
    "API Error: 429 rate_limit_error. Retry after 30 seconds.",
    "API Error: 529 Overloaded",
    '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
    "You've hit your weekly limit · resets 4pm (Asia/Saigon)",
    "You've hit your limit · resets Nov 2 at 4pm (Asia/Saigon)",
    "You hit your limit of 5 files",
    "you hit your Opus limit of 3",
    "hit your limit limit of things",
    "hit your weekly limit of 10 and hit your limit today",
    "HIT YOUR SESSION LIMIT",
    "hit your limits",
    "hit your two word limit",
    "Claude usage limit reached|1760000000",
    "Claude AI usage limit reached|176000000",
    "usage limit reached|17600000001",
    "5-hour limit reached ∙ resets 3:30pm (America/New_York)",
    "Weekly limit reached, resets Nov 3, 9am",
    "opus limit reached",
    "Monthly limit reached. resets Dec 31 at 11:59pm (UTC)",
    "Too Many Requests",
    "ratelimit hit",
    "rate-limit hit",
    "rate  limit",
    "port 4290 is busy",
    "error 429",
    "RESOURCE_EXHAUSTED: quota",
    "insufficient_quota",
    "You have exhausted your daily quota",
    "Quota exceeded for quota metric 'x'",
    "retry-after: 120",
    "429 retry after 3",
    "429 Retry-After header says 99999999",
    "429 retry after soon",
    "429 retry after about ten or 15 seconds",
    "Everything is fine",
    "",
    "first line\nsecond: rate limit exceeded for key " + SECRET + "\nthird: 429",
    "   padded 429 line   \r\nnext",
    "x" * 200 + " rate limit " + "y" * 200,
    "429\u2028after a separator",
    "no limit\x0b429 after a vertical tab",
]
NOW = 1_760_000_000.0  # 2025-10-09T08:53:20Z
out["rate_limit_line"] = [{"text": t, "out": cli.rate_limit_line(t)} for t in LIMIT_TEXTS] + [{"text": None, "out": cli.rate_limit_line(None)}]

RESET_TEXTS = [
    "resets 4pm (Asia/Saigon)",
    "resets 4pm",
    "reset 4:05 PM (Asia/Ho_Chi_Minh)",
    "resets 12am (UTC)",
    "resets 12pm (UTC)",
    "resets 12:59pm (Europe/Berlin)",
    "resets 1am (America/New_York)",
    "resets 3:30pm (America/New_York)",
    "resets Nov 2 at 4pm (Asia/Saigon)",
    "resets Nov 3, 9am",
    "resets November 3 9am (Europe/London)",
    "resets Sept. 30 at 11pm (America/Los_Angeles)",
    "resets Oct 9 at 8am (UTC)",
    "resets Oct 9 at 9am (UTC)",
    "resets Oct 8 at 9am (UTC)",
    "resets Oct 7 at 9am (UTC)",
    "resets Jan 1 at 12am (Pacific/Auckland)",
    "resets Feb 29 at 1pm (UTC)",
    "resets Feb 30 at 1pm (UTC)",
    "resets Mar 0 at 1pm (UTC)",
    "resets Dec 31, 11:59pm (Etc/GMT+12)",
    "resets Marvelous 3 at 4pm (UTC)",
    "resets Xyz 3 at 4pm (UTC)",
    "resets Ma 3 at 4pm (UTC)",
    "resets Mayday 3 at 4pm (UTC)",
    "resets Jun 15 at 2:30am (Europe/Paris)",
    "resets 2:30am (Europe/Paris)",
    "resets 2:30am (America/Sao_Paulo)",
    "resets 13pm (UTC)",
    "resets 0am (UTC)",
    "resets 4:60pm (UTC)",
    "resets 4:5pm (UTC)",
    "resets 04:05pm (UTC)",
    "resets 4 pm (UTC)",
    "resets 4pmish (UTC)",
    "resets 4pm (Nowhere/City)",
    "resets 4pm (asia/saigon)",
    "resets 4pm (EST)",
    "resets 4pm (GMT)",
    "resets 4pm (America/Argentina/Buenos_Aires)",
    "resets 4pm (Etc/GMT-14)",
    "resets 4pm(UTC)",
    "resets 4pm  ( UTC )",
    "RESETS 4PM (UTC)",
    "resets at 4pm (UTC)",
    "it resets  \n 4pm (UTC)",
    "resets soon",
    "no time here",
    "",
    "resets 9am, then resets 10pm (UTC)",
]
MOMENTS = [
    "2025-10-09T08:53:20+00:00",
    "2025-10-09T08:53:20.250000+00:00",
    "2025-10-09T15:59:59.999999+07:00",
    "2025-03-09T06:30:00+00:00",  # the night clocks go forward in New York
    "2025-11-02T05:30:00+00:00",  # ... and back
    "2025-03-30T00:30:00+00:00",  # Paris
    "2025-10-26T00:30:00+00:00",
    "2024-02-28T23:00:00+00:00",
    "2023-12-31T23:59:59+00:00",
    "2025-01-01T00:00:00+00:00",
    "9999-12-31T22:00:00+00:00",
    "0001-01-01T10:00:00+00:00",
]
LOCAL_ZONES = ["UTC", "Asia/Ho_Chi_Minh", "America/New_York", "Europe/Paris", "Australia/Lord_Howe", "Pacific/Kiritimati"]


def with_zone(zone):
    os.environ["TZ"] = zone
    time.tzset()


out["reset_wait"] = []
for zone in LOCAL_ZONES:
    with_zone(zone)
    for text in RESET_TEXTS:
        for moment in MOMENTS:
            if zone != "UTC" and ("(" in text and ")" in text) and moment != MOMENTS[0] and "Nowhere" not in text and "asia/" not in text:
                continue  # the message names its zone: the computer's does not matter, once is enough
            now = datetime.fromisoformat(moment)
            wait = cli.reset_wait(text, now)
            if moment.startswith("0001") and wait is not None:
                # before 1890 a zone is on its local mean time, which differs between versions of the zone data: the
                # year 1 is here for the dates Python cannot hold, not for those
                continue
            out["reset_wait"].append({"local": zone, "text": text, "now": moment, "out": wait})
with_zone("UTC")

out["rate_limit_wait"] = []
for zone in ("UTC", "Asia/Ho_Chi_Minh"):
    with_zone(zone)

    class Frozen(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime.fromtimestamp(NOW, tz)

    with mock.patch.object(cli.time, "time", lambda: NOW), mock.patch.object(cli, "datetime", Frozen):
        for text in LIMIT_TEXTS + [None]:
            out["rate_limit_wait"].append({"local": zone, "epoch": NOW, "text": text, "out": cli.rate_limit_wait(text)})
with_zone("UTC")

# --------------------------------------------------------------------------------------------------------------
# tool calls, tests and results
# --------------------------------------------------------------------------------------------------------------
out["short"] = [
    {"text": t, "n": n, "out": cli._short(t, n)}
    for t in ("", "short", "  many   spaces\n and\tlines  ", "x" * 160, "x" * 161, "é" * 200, "a\x1cb\x1fc", "một hai ba " * 30, "😀" * 10)
    for n in (160, 10, 5, 1)
]
TOOLS = [
    ("Edit", {"file_path": "/w/repo/src/calc.py", "old_string": "a - b", "new_string": "a + b"}),
    ("Edit", {"file_path": "/w/repo/src/calc.py", "old_string": "1\n2\n3\n", "new_string": "1\r\n2\r3\x0c4\x1c5\x1d6\x1e7\x858\u20289\u2029"}),
    ("Edit", {"file_path": "/other/place.py"}),
    ("Edit", {"file_path": "/w/repo"}),
    ("Edit", {"file_path": "/w/repo/"}),
    ("Edit", {"file_path": "/w/repo/./a//b/../c.py"}),
    ("Edit", {"file_path": "/w/repo/../repo/x.py"}),
    ("Edit", {"file_path": "/w/repo2/x.py"}),
    ("Edit", {"file_path": "/"}),
    ("MultiEdit", {"file_path": "/w/repo/a.ts", "edits": [{"old_string": "a", "new_string": "b\nc"}, {"old_string": "x\ny", "new_string": ""}, {}]}),
    ("MultiEdit", {"file_path": "/w/repo/a.ts", "edits": [], "old_string": "o", "new_string": "n\nn"}),
    ("Write", {"file_path": "/w/repo/new.md", "content": "# T\n\nbody"}),
    ("Write", {"file_path": "/w/repo/new.md", "content": ""}),
    ("Write", {"file_path": "/w/repo/new.md"}),
    ("Read", {"file_path": "/w/repo/README.md"}),
    ("Read", {"file_path": "/etc/passwd"}),
    ("Bash", {"command": "pytest -q   tests/ \n -x"}),
    ("Bash", {"command": "z" * 300}),
    ("Bash", {}),
    ("Bash", {"command": None}),
    ("Grep", {"pattern": "def add\\("}),
    ("Glob", {"pattern": "**/*.py" + "y" * 90}),
    ("Glob", {}),
    ("Skill", {"skill": "tdd:red-green"}),
    ("Skill", {"skill": 5}),
    ("Skill", {"skill": None}),
    ("Skill", {}),
    ("Task", {"subagent_type": "Explore", "description": "Find the callers", "prompt": "Where?"}),
    ("Agent", {"prompt": "Only a prompt " + "p" * 200}),
    ("Agent", {}),
    ("Agent", {"subagent_type": 5, "description": ["a", 1, None]}),
    ("mcp__kanban__ticket", {"action": "update", "ticket_id": "KAN-1"}),
    ("mcp__kanban__ticket_item", {"action": "add", "item": "comment", "ticket_id": "KAN-1"}),
    ("mcp__kanban__docs_read", {"action": "list", "project_id": "p1"}),
    ("mcp__kanban__project", {}),
    ("mcp__x", {"ticket_id": 5}),
    ("mcp__", {}),
    ("mcp__a__b__", {"action": "go"}),
    ("WebFetch", {"url": "https://example.com", "prompt": "Tóm tắt ✓"}),
    ("Other", {}),
    ("Other", {"big": "v" * 400}),
    ("Other", {"nested": {"a": [1, 2.5, None, True]}, "text": 'q"uote'}),
    ("", {"a": 1}),
    ("Skillful", {"skill": "x"}),
]
out["describe_tool"] = []
for name, inp in TOOLS:
    kind, text, change = cli.describe_tool(name, inp, "/w/repo")
    out["describe_tool"].append({"name": name, "input": inp, "cwd": "/w/repo", "out": [kind, text, change]})

TEST_OUTPUTS = [
    "$ pytest -q\n..F.\nFAILED tests/test_calc.py::test_sub\n1 failed, 3 passed in 0.12s\n",
    "\x1b[31mFAILED\x1b[0m tests/test_calc.py::test_add\n\x1b[31m\x1b[1m1 failed\x1b[0m, \x1b[32m3 passed\x1b[0m in 0.10s",
    "4 passed in 0.10s",
    "12 passing (3s)\n  2 failing\n\n  ✗ renders the list\n  × saves the form",
    "✗ renders the list\n× saves the form\nFAIL src/app.test.ts\n1 failed",
    "Tests: 2 failed, 10 passed, 12 total",
    "Tests: 2 FAILED, 10 PASSED",
    "3 passed\n5 passed\n1 failed\n0 failed",
    "FAILED a\nFAILED b\nFAILED c\nFAILED d\nFAILED e\nFAILED f\n6 failed",
    "FAILED   spaced name   \n1 failed",
    "FAILED\n\n  after blank lines\n1 failed",
    "FAILED " + "n" * 200 + "\n1 failed",
    "FAILED x\r\n1 failed\r\n",
    "not FAILED here\n1 failed",
    "nothing to see",
    "",
    "x1 passed",
    "1 passedx",
    "12345678901234567890 passed",
    "0 passed",
    "passed 3",
    "3  passed",
    "3 passed\x1b[0m\x1b[32m4 passing",
]
out["parse_tests"] = [{"output": t, "out": cli.parse_tests(t)} for t in TEST_OUTPUTS]
out["strip_ansi"] = [
    {"text": t, "out": cli.strip_ansi(t)}
    for t in ("\x1b[32m6 passed\x1b[0m", "plain", "", "\x1b[1;31mbold red\x1b[0m and \x1b[?25l hidden", "\x1b]0;title\x07 kept", "\x1b[38;5;196mcolour\x1b[m", "broken \x1b[12 no end")
]
CONTENTS = [
    "plain text",
    "",
    None,
    [{"type": "text", "text": "first"}, {"type": "text", "text": "second"}],
    [{"type": "image"}, "skipped", None, 5, {"text": "bare"}],
    [],
    {"a": 1, "b": [True, None, 1.5, "x'y", 'q"']},
    42,
    0,
    1.5,
    True,
    False,
]
out["result_text"] = [{"content": c, "out": cli._result_text(c)} for c in CONTENTS]
out["message_of"] = [
    {"event": ev, "out": cli.message_of(ev)}
    for ev in ({"message": {"content": []}}, {"message": "text"}, {"message": None}, {}, {"message": [1]}, "not a dict", None, [1], {"message": {}})
]

text_out = json.dumps(out, ensure_ascii=False, indent=1)
OUT.write_text(text_out + "\n", encoding="utf-8")
print(f"{OUT.name}: " + ", ".join(f"{k} {len(v)}" for k, v in out.items()) + f", {len(text_out)} bytes")
