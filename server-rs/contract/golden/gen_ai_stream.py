"""Golden vectors for `services/ai/stream.py` (`crates/kb-ai-run/src/stream.rs`): stream-json transcripts fed line by
line to `stream.Parser`, with everything each line gave (rows, agents, tasks, files, results, the result, usage, limits)
and the roles the parser knows at the end. A line the Python parser raises on is recorded as `{"raises": <type>}`.

The transcripts are recorded ones (what `tests/fixtures/fake_claude.py` prints in its modes, the run's folder replaced
by `/w/repo`) and hand-made ones: every event kind the parser handles, each tool, subagent events, usage, limits and
reset times, errors, truncated and malformed lines, a result without a prior message, Unicode, and values of the
wrong type.

Run from `server/`:  .venv/bin/python ../server-rs/contract/golden/gen_ai_stream.py
Writes `ai_stream.json` next to this file.
"""

import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

work = tempfile.mkdtemp(prefix="gen-ai-stream-")
os.environ["KANBAN_CONFIG_DIR"] = f"{work}/config"
os.environ["KANBAN_DB_PATH"] = f"{work}/data/kanban.db"
os.environ["KANBAN_LOG_DIR"] = f"{work}/logs"
os.environ["KANBAN_AI_KEY_FILE"] = f"{work}/ai.key"
os.environ["CLAUDE_CONFIG_DIR"] = f"{work}/claude"
os.environ["HOME"] = f"{work}/home"
sys.path.insert(0, os.getcwd())

from services.ai import stream  # noqa: E402

OUT = Path(__file__).with_name("ai_stream.json")
FAKE = Path(os.getcwd()) / "tests" / "fixtures" / "fake_claude.py"
CWD = "/w/repo"
transcripts: list[dict] = []


def add(name: str, lines: list, cwd: str = CWD, agent_types: dict | None = None) -> None:
    lines = [ln if isinstance(ln, str) else json.dumps(ln) for ln in lines]
    parser = stream.Parser(cwd, agent_types)
    outs = []
    for line in lines:
        try:
            outs.append(parser.parse(line))
        except Exception as exc:  # noqa: BLE001 - which lines raise is part of the vectors
            outs.append({"raises": type(exc).__name__})
    transcripts.append(
        {
            "name": name,
            "cwd": cwd,
            "agent_types": agent_types,
            "lines": lines,
            "outs": outs,
            "agent_types_after": {k: v for k, v in parser.agent_types.items() if isinstance(k, str)},
        }
    )


# --------------------------------------------------------------------------------------------------------------
# recorded: the stand-in CLI in its modes
# --------------------------------------------------------------------------------------------------------------
def record(name: str, mode: str, args: list | None = None, stdin: str | None = None, **env) -> None:
    folder = tempfile.mkdtemp(prefix="run-", dir=work)
    run_env = {
        "PATH": os.environ["PATH"],
        "HOME": f"{work}/home",
        "CLAUDE_CONFIG_DIR": f"{work}/claude",
        "FAKE_CLAUDE_MODE": mode,
        **env,
    }
    args = args or ["-p", "Fix add()", "--output-format", "stream-json", "--session-id", "sess-1"]
    done = subprocess.run(
        [sys.executable, str(FAKE), *args], cwd=folder, env=run_env, input=stdin, capture_output=True, text=True, timeout=60
    )
    real = os.path.realpath(folder)
    lines = [ln.replace(real, CWD).replace(folder, CWD) for ln in done.stdout.splitlines()]
    # the stand-in stamps its limits with the time of the run: a fixed one keeps this file the same on every run
    lines = [re.sub(r'"resetsAt": \d+', '"resetsAt": 1760003600', ln) for ln in lines]
    if done.stderr.strip():
        lines.append(done.stderr.strip())  # what the CLI wrote besides its stream is not JSON
    add(f"recorded: {name}", lines)


LIVE = ["--input-format", "stream-json", "--output-format", "stream-json", "--session-id", "live-1"]


def said(text: str) -> str:
    return json.dumps({"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": text}]}}) + "\n"


record("finish", "finish")
record("finish with red tests, a text message and a quota", "finish", FAKE_CLAUDE_RED_TESTS="1", FAKE_CLAUDE_TEXT_MESSAGE="plain text", FAKE_CLAUDE_QUOTA="0.95", FAKE_CLAUDE_SKILL="1")
record("v2", "v2")
record("v2 ask", "v2_ask")
record("skill", "skill")
record("window", "window")
record("network", "network")
record("rate limit", "rate_limit")
record("fail", "fail")
record("crash", "crash")
record("run logged out", "run_logged_out")
record("too long", "too_long")
record("assistant", "assistant", FAKE_CLAUDE_ASSISTANT_JSON='{"title": "Kế hoạch", "sections": ["A", "B"]}')
record("assistant text", "assistant", FAKE_CLAUDE_ASSISTANT_TEXT="Câu trả lời ✓")
record("no conversation", "no_conversation", ["-p", "x", "--output-format", "stream-json", "--resume", "gone-1"])
record("live with two more messages", "finish", LIVE, said("Fix add()") + said("Also the docs") + said("Cảm ơn ✓"))
record("handoff", "finish", ["-p", "You are doing the step “Build”. Go.", "--output-format", "stream-json", "--session-id", "s"], FAKE_CLAUDE_HANDOFF="1")


# --------------------------------------------------------------------------------------------------------------
# hand-made
# --------------------------------------------------------------------------------------------------------------
def assistant(*blocks, parent=None, usage=None, **more):
    ev = {"type": "assistant", "message": {"content": list(blocks)}}
    if usage is not None:
        ev["message"]["usage"] = usage
    if parent is not None:
        ev["parent_tool_use_id"] = parent
    ev.update(more)
    return ev


def tool(name, inp=None, id_="t1", **more):
    block = {"type": "tool_use", "id": id_, "name": name}
    if inp is not None:
        block["input"] = inp
    block.update(more)
    return block


def text(value):
    return {"type": "text", "text": value}


def user(*blocks, parent=None, **more):
    ev = {"type": "user", "message": {"content": list(blocks)}}
    if parent is not None:
        ev["parent_tool_use_id"] = parent
    ev.update(more)
    return ev


def result_of(tool_id, content, is_error=False, **more):
    return {"type": "tool_result", "tool_use_id": tool_id, "is_error": is_error, "content": content, **more}


SECRET = "sk-ant-" + "a1b2c3d4e5f6g7h8"
LONG = "Dòng chữ dài ✓ " * 40

add(
    "init",
    [
        {"type": "system", "subtype": "init", "session_id": "s-1", "model": "claude-sonnet-4-5"},
        {
            "type": "system",
            "subtype": "init",
            "session_id": "s-2",
            "model": "claude-opus-4",
            "agents": ["general-purpose", "reviewer"],
            "plugins": [{"name": "kanban", "path": "/p"}, "odd", {"path": "/no-name"}, None, 3],
            "tools": ["Bash", "Edit", "mcp__kanban__ticket"],
        },
        {"type": "system", "subtype": "init", "agents": [], "plugins": None, "tools": None},
        {"type": "system", "subtype": "init", "session_id": 12, "model": None, "agents": "text", "plugins": "text", "tools": {"a": 1}},
        {"type": "system", "subtype": "init", "plugins": {"name": "x"}},
        {"type": "system", "subtype": "init", "plugins": 5},
        {"type": "system", "subtype": "init", "plugins": 0},
        {"type": "system", "subtype": "init", "plugins": True},
        {"type": "system", "subtype": "init", "parent_tool_use_id": "a1"},
        {"type": "system"},
        {"type": "system", "subtype": "other"},
        {"type": "system", "subtype": None, "message": "plain text"},
        {"type": "system", "subtype": ["init"]},
    ],
)

add(
    "compact boundary",
    [
        {"type": "system", "subtype": "compact_boundary", "compact_metadata": {"pre_tokens": 180000, "post_tokens": 42000}},
        {"type": "system", "subtype": "compact_boundary", "compact_metadata": {"pre_tokens": 999, "post_tokens": 1000}},
        {"type": "system", "subtype": "compact_boundary", "compact_metadata": {"pre_tokens": 1234567890, "post_tokens": 0}},
        {"type": "system", "subtype": "compact_boundary", "compact_metadata": {"pre_tokens": -1234, "post_tokens": 12}},
        {"type": "system", "subtype": "compact_boundary", "compact_metadata": {"pre_tokens": 180000.0, "post_tokens": 42000}},
        {"type": "system", "subtype": "compact_boundary", "compact_metadata": {"pre_tokens": True, "post_tokens": False}},
        {"type": "system", "subtype": "compact_boundary", "compact_metadata": {"pre_tokens": "180000", "post_tokens": 42000}},
        {"type": "system", "subtype": "compact_boundary", "compact_metadata": {"pre_tokens": 5}},
        {"type": "system", "subtype": "compact_boundary", "compact_metadata": None},
        {"type": "system", "subtype": "compact_boundary"},
        {"type": "system", "subtype": "compact_boundary", "compact_metadata": {}, "parent_tool_use_id": "agent-1"},
        {"type": "system", "subtype": "compact_boundary", "compact_metadata": [1]},
        {"type": "system", "subtype": "compact_boundary", "compact_metadata": "text"},
        {"type": "system", "subtype": "compact_boundary", "compact_metadata": []},
    ],
)

add(
    "tasks",
    [
        assistant(tool("Agent", {"subagent_type": "reviewer", "description": "Review"}, "call-1")),
        {"type": "system", "subtype": "task_started", "task_id": "task-1", "task_type": "local_agent", "tool_use_id": "call-1", "subagent_type": "reviewer"},
        {"type": "system", "subtype": "task_started", "task_id": "task-2", "task_type": "local_agent", "tool_use_id": "unknown", "subagent_type": "tester"},
        {"type": "system", "subtype": "task_started", "task_id": "task-3", "task_type": "local_agent"},
        {"type": "system", "subtype": "task_started", "task_id": "task-4", "task_type": "local_bash", "tool_use_id": "call-1"},
        {"type": "system", "subtype": "task_started", "task_id": 77, "task_type": "local_agent", "subagent_type": 5},
        {"type": "system", "subtype": "task_started", "task_type": "local_agent"},
        {"type": "system", "subtype": "task_started", "task_id": "", "task_type": "local_agent"},
        {"type": "system", "subtype": "task_started", "task_id": "task-5"},
        {"type": "system", "subtype": "task_started", "task_id": "task-6", "task_type": "local_agent", "tool_use_id": ["x"]},
        {"type": "system", "subtype": "task_started", "task_id": "task-6", "task_type": "local_agent", "tool_use_id": 5},
        {"type": "system", "subtype": "task_updated", "task_id": "task-1", "patch": {"status": "completed", "end_time": 1760000000123}},
        {"type": "system", "subtype": "task_updated", "task_id": "task-1", "patch": {"status": "failed", "end_time": 1760000000000}},
        {"type": "system", "subtype": "task_updated", "task_id": "task-1", "patch": {"status": "killed", "end_time": 1760000000123.4567}},
        {"type": "system", "subtype": "task_updated", "task_id": "task-1", "patch": {"status": "stopped"}},
        {"type": "system", "subtype": "task_updated", "task_id": "task-1", "patch": {"status": "running", "end_time": 5}},
        {"type": "system", "subtype": "task_updated", "task_id": "task-1", "patch": {"status": "completed", "end_time": "1760000000123"}},
        {"type": "system", "subtype": "task_updated", "task_id": "task-1", "patch": {"status": "completed", "end_time": True}},
        {"type": "system", "subtype": "task_updated", "task_id": "task-1", "patch": {"status": "completed", "end_time": 0}},
        {"type": "system", "subtype": "task_updated", "task_id": "task-1", "patch": {"status": "completed", "end_time": -1}},
        {"type": "system", "subtype": "task_updated", "task_id": "task-1", "patch": {"status": "completed", "end_time": 1.5}},
        {"type": "system", "subtype": "task_updated", "task_id": "task-1", "patch": {"status": "completed", "end_time": 2.5}},
        {"type": "system", "subtype": "task_updated", "task_id": "task-1", "patch": {"status": "completed", "end_time": 1760000000999.9999}},
        {"type": "system", "subtype": "task_updated", "task_id": "task-1", "patch": {"status": "completed", "end_time": 253402300799999}},
        {"type": "system", "subtype": "task_updated", "task_id": "task-1", "patch": {"status": "completed", "end_time": 253402300800000}},
        {"type": "system", "subtype": "task_updated", "task_id": "task-1", "patch": {"status": "completed", "end_time": 10**30}},
        {"type": "system", "subtype": "task_updated", "task_id": "task-1", "patch": {"status": "completed", "end_time": -62135596800001}},
        {"type": "system", "subtype": "task_updated", "task_id": "task-1", "patch": {}, "status": "completed"},
        {"type": "system", "subtype": "task_updated", "task_id": "task-1", "status": "completed"},
        {"type": "system", "subtype": "task_updated", "task_id": "task-1", "patch": None, "status": "failed"},
        {"type": "system", "subtype": "task_updated", "task_id": "task-1", "patch": "text"},
        {"type": "system", "subtype": "task_updated", "task_id": "task-1", "patch": [1]},
        {"type": "system", "subtype": "task_updated", "task_id": "task-1"},
        {"type": "system", "subtype": "task_updated", "task_id": "task-1", "patch": {"status": ["completed"]}},
        {"type": "system", "subtype": "task_notification", "task_id": "task-1", "status": "completed"},
        {"type": "system", "subtype": "task_notification", "task_id": "task-1", "status": "killed", "patch": {"status": "running", "end_time": 5}},
        {"type": "system", "subtype": "task_notification", "task_id": "task-1", "status": "working"},
        {"type": "system", "subtype": "task_notification", "task_id": "task-1"},
        {"type": "system", "subtype": "task_notification", "status": "completed"},
        {"type": "system", "subtype": "task_notification", "task_id": 3.5, "status": "completed"},
    ],
)
add(
    "tasks of a resumed run",
    [
        {"type": "system", "subtype": "task_started", "task_id": "t-9", "task_type": "local_agent", "tool_use_id": "old-call", "subagent_type": "tester"},
        {"type": "system", "subtype": "task_started", "task_id": "t-10", "task_type": "local_agent", "tool_use_id": "new-call", "subagent_type": "tester"},
        assistant(tool("Task", {"subagent_type": "writer"}, "new-call")),
        {"type": "system", "subtype": "task_started", "task_id": "t-10", "task_type": "local_agent", "tool_use_id": "new-call", "subagent_type": "writer"},
    ],
    agent_types={"old-call": "tester"},
)

add(
    "hooks",
    [
        {"type": "system", "subtype": "hook_event", "hook_event_name": "PreToolUse", "tool_name": "Bash", "agent_id": "a-1", "agent_type": "reviewer"},
        {"type": "system", "subtype": "hook", "event": "SubagentStop"},
        {"type": "system", "subtype": "hook"},
        {"type": "system", "subtype": "whatever", "hook_event_name": "SessionStart"},
        {"type": "system", "hook_event_name": "Stop", "tool_name": ""},
        {"type": "hook", "hook_event_name": "PostToolUse", "tool_name": "Edit", "parent_tool_use_id": "call-1"},
        {"type": "something_else", "hook_event_name": "Notification"},
        {"hook_event_name": "UserPromptSubmit"},
        {"type": "something_else"},
        {"type": "system", "subtype": "hook_event", "hook_event_name": "X" * 250, "tool_name": "Y" * 10},
        {"type": "system", "subtype": "hook_event", "hook_event_name": 5, "tool_name": 7, "agent_id": 0, "agent_type": []},
        {"type": "system", "subtype": "hook_event", "hook_event_name": None, "event": "", "tool_name": None},
        {"type": "tool_progress", "tool_use_id": "srv-heartbeat-0", "tool_name": "Bash", "parent_tool_use_id": "srv", "elapsed_time_seconds": 30, "heartbeat": True},
    ],
)

add(
    "rate limit events",
    [
        {
            "type": "rate_limit_event",
            "rate_limit_info": {
                "status": "allowed",
                "resetsAt": 1760003600,
                "rateLimitType": "five_hour",
                "unifiedWindows": {
                    "five_hour": {"utilization": 0.42, "resetsAt": 1760001800, "status": "allowed"},
                    "seven_day": {"utilization": 0.1, "resetsAt": 1760600000, "status": "allowed"},
                },
            },
        },
        {
            "type": "rate_limit_event",
            "rate_limit_info": {
                "status": "rejected",
                "resetsAt": 1760600000,
                "rateLimitType": "seven_day",
                "unifiedWindows": {
                    "five_hour": {"utilization": 0.3, "resetsAt": 1760001800, "status": "allowed"},
                    "seven_day": {"utilization": 1.0, "resetsAt": 1760600000, "status": "rejected"},
                },
            },
        },
        {"type": "rate_limit_event", "rate_limit_info": {"status": "allowed_warning", "resetsAt": "1760003600", "rateLimitType": "overage"}},
        {"type": "rate_limit_event", "rate_limit_info": {"status": "rejected", "resetsAt": None}},
        {"type": "rate_limit_event", "rate_limit_info": None},
        {"type": "rate_limit_event"},
        {"type": "rate_limit_event", "rate_limit_info": {"unifiedWindows": {"five_hour": "bad", "weird": {"utilization": 0.2}}}},
    ],
)

add(
    "tools of the lead",
    [
        assistant(tool("Edit", {"file_path": "/w/repo/src/calc.py", "old_string": "a - b", "new_string": "a + b"})),
        assistant(tool("Edit", {"file_path": "/w/repo/src/calc.py", "old_string": "one\ntwo\nthree", "new_string": "one\r\ntwo\x0bthree\x0cfour five\n"})),
        assistant(tool("Edit", {"file_path": "/elsewhere/notes.md", "old_string": "", "new_string": "x"})),
        assistant(tool("Edit", {"file_path": "/w/repo", "old_string": None, "new_string": None})),
        assistant(tool("Edit", {"file_path": "/w/repo/a/../b/./c.py"})),
        assistant(tool("Edit", {"file_path": "/w/repo/sub/"})),
        assistant(tool("Edit", {"file_path": "/w/repository/x.py"})),
        assistant(tool("Edit", {"file_path": "/w/repo/API_KEY=" + SECRET + ".py"})),
        assistant(
            tool(
                "MultiEdit",
                {
                    "file_path": "/w/repo/app.ts",
                    "edits": [
                        {"old_string": "a", "new_string": "b\nc"},
                        {"old_string": "x\ny\nz", "new_string": ""},
                        {"new_string": "only new"},
                        {},
                    ],
                },
            )
        ),
        assistant(tool("MultiEdit", {"file_path": "/w/repo/app.ts", "edits": []})),
        assistant(tool("MultiEdit", {"file_path": "/w/repo/app.ts", "edits": None, "old_string": "a", "new_string": "b"})),
        assistant(tool("Write", {"file_path": "/w/repo/docs/guide.md", "content": "# Guide\n\nText\n"})),
        assistant(tool("Write", {"file_path": "/w/repo/empty.txt", "content": ""})),
        assistant(tool("Write", {"file_path": "/w/repo/none.txt"})),
        assistant(tool("Read", {"file_path": "/w/repo/README.md"})),
        assistant(tool("Read", {"file_path": "/etc/hosts"})),
        assistant(tool("Bash", {"command": "pytest -q"})),
        assistant(tool("Bash", {"command": "  echo   one \n two\ttabs  "})),
        assistant(tool("Bash", {"command": "export API_TOKEN=" + SECRET + " && curl -H 'Authorization: Bearer abcdefgh12345678' https://x"})),
        assistant(tool("Bash", {"command": "x" * 200})),
        assistant(tool("Bash", {"command": "y" * 2500})),
        assistant(tool("Bash", {"command": "echo " + "é" * 130})),
        assistant(tool("Bash", {})),
        assistant(tool("Bash", {"command": None})),
        assistant(tool("Bash", {"command": ""})),
        assistant(tool("Bash", {"command": 0})),
        assistant(tool("Grep", {"pattern": "def add\\(", "path": "/w/repo"})),
        assistant(tool("Glob", {"pattern": "**/*.py " + "z" * 100})),
        assistant(tool("Grep", {})),
        assistant(tool("Skill", {"skill": "tdd:red-green"})),
        assistant(tool("Skill", {"skill": 42})),
        assistant(tool("Skill", {"skill": ["a", "b"]})),
        assistant(tool("Skill", {"skill": ""})),
        assistant(tool("Skill", {})),
        assistant(tool("WebFetch", {"url": "https://example.com/a?b=c", "prompt": "Tóm tắt ✓"})),
        assistant(tool("NotebookEdit", {"notebook_path": "/w/repo/n.ipynb", "new_source": "x" * 300})),
        assistant(tool("Odd", {})),
        assistant(tool("Odd")),
        assistant(tool("Odd", [1, 2])),
        assistant(tool("Odd", "text")),
        assistant(tool("ToolSearch", {"query": "select:Read"})),
        assistant(tool("mcp__kanban__ticket", {"action": "update", "ticket_id": "KAN-12", "status": "review"})),
        assistant(tool("mcp__kanban__ticket_item", {"action": "add", "item": "comment", "ticket_id": "KAN-12"})),
        assistant(tool("mcp__kanban__docs_read", {"action": "list", "project_id": "p-1"})),
        assistant(tool("mcp__kanban__project", {})),
        assistant(tool("mcp__plugin_kanban_kanban__ai_run", {"action": "ask", "ticket_id": 12})),
        assistant(tool("mcp__", {"action": "x"})),
        assistant(tool("mcp__a__", {"item": "y", "project_id": ["p"]})),
        assistant(tool("StructuredOutput", {"status": "done", "summary": "Xong"}, "out-1")),
        assistant(tool("TaskCreate", {"subject": "Write the tests", "description": "All of them"}, "p-1")),
        assistant(tool("TaskUpdate", {"taskId": "1", "status": "completed"}, "p-2")),
        assistant(tool("TaskUpdate", {"description": "Second " + "long " * 50}, "p-3")),
        assistant(tool("TodoWrite", {"todos": [{"content": "a", "status": "pending"}]}, "p-4")),
        assistant(tool("TodoWrite", {"subject": 5})),
        assistant(tool("TaskCreate", {"subject": "token " + SECRET})),
        assistant(tool("SendMessage", {"to": "KAN-7", "message": "Please rebase"}, "m-1")),
        assistant(tool("SendMessage", {"recipient": "reviewer", "content": "Done: " + LONG}, "m-2")),
        assistant(tool("SendMessage", {}, "m-3")),
        assistant(tool("SendMessage", {"to": 5, "message": ["a"]}, "m-4")),
        assistant(tool("SendMessage", {"to": "lead", "message": "key " + SECRET})),
    ],
)

add(
    "subagents",
    [
        assistant(tool("Agent", {"subagent_type": "reviewer", "description": "Review the diff", "prompt": "Look at it"}, "call-1")),
        assistant(tool("Task", {"description": "No role given"}, "call-2")),
        assistant(tool("Agent", {"subagent_type": "tester", "prompt": "Only a prompt " + "p" * 200}, "call-3")),
        assistant(tool("Agent", {"subagent_type": "nameless"}, None)),
        assistant(tool("Agent", {"subagent_type": "empty id"}, "")),
        assistant(tool("Agent", {"subagent_type": 5, "description": 7}, "call-4")),
        assistant(tool("Agent", {"subagent_type": "num"}, 99)),
        assistant(tool("Agent", {"subagent_type": "bad id"}, ["x"])),
        assistant(tool("Agent", {"subagent_type": "bad id"}, {"x": 1})),
        assistant(tool("Agent", None, "call-5")),
        assistant(tool("Agent", {"subagent_type": "secret", "description": "use " + SECRET}, "call-6")),
        assistant(tool("Bash", {"command": "git diff --stat"}, "sub-1"), parent="call-1"),
        user(result_of("sub-1", " 1 file changed"), parent="call-1"),
        assistant(text("Looks good: one small change."), parent="call-1"),
        assistant(text(LONG), parent="call-1"),
        assistant(text("  "), parent="call-1"),
        assistant(tool("Edit", {"file_path": "/w/repo/x.py", "old_string": "a", "new_string": "b"}, "sub-2"), parent="call-3", usage={"input_tokens": 500}),
        assistant(tool("Agent", {"subagent_type": "nested"}, "call-7"), parent="call-1"),
        user(result_of("sub-2", "boom", True), parent="call-3"),
        user(result_of("call-1", "Looks good.")),
        assistant(text("from zero"), parent=0),
        assistant(text("from empty"), parent=""),
        assistant(text("from a number"), parent=7),
        assistant(text("from a list"), parent=["call-1"]),
    ],
)

add(
    "text and usage",
    [
        assistant(text("Short answer.")),
        assistant(text("  padded \n lines\tand   spaces  ")),
        assistant(text("x" * 300)),
        assistant(text("x" * 301)),
        assistant(text("é" * 301)),
        assistant(text("Tôi đã sửa lỗi ✓ 😀 שלום مرحبا")),
        assistant(text("")),
        assistant(text(None)),
        assistant(text("   \n\t ")),
        assistant(text("\x1c\x1d keep \x1e\x1f")),
        assistant(text("my key is " + SECRET + " and PASSWORD=hunter2hunter2")),
        assistant(text("one"), text("two"), tool("Bash", {"command": "ls"}), text("three")),
        assistant(text("with usage"), usage={"input_tokens": 100, "cache_creation_input_tokens": 20, "cache_read_input_tokens": 3, "output_tokens": 50}),
        assistant(text("only input"), usage={"input_tokens": 7}),
        assistant(text("zero usage"), usage={"input_tokens": 0}),
        assistant(text("text numbers"), usage={"input_tokens": "12", "cache_read_input_tokens": " 3 "}),
        assistant(text("float numbers"), usage={"input_tokens": 12.9, "cache_read_input_tokens": True}),
        assistant(text("none numbers"), usage={"input_tokens": None, "cache_read_input_tokens": ""}),
        assistant(text("big numbers"), usage={"input_tokens": 2**40, "cache_read_input_tokens": 2**40}),
        assistant(text("usage none"), usage=None),
        assistant(text("usage empty list"), usage=[]),
        assistant(text("bad number"), usage={"input_tokens": "many"}),
        assistant(text("bad number"), usage={"input_tokens": [1]}),
        assistant(text("bad usage"), usage=[1]),
        assistant(text("bad usage"), usage="text"),
        assistant(text("subagent usage"), parent="call-1", usage={"input_tokens": 999}),
        {"type": "assistant"},
        {"type": "assistant", "message": None},
        {"type": "assistant", "message": "plain text"},
        {"type": "assistant", "message": ["list"]},
        {"type": "assistant", "message": {}},
        {"type": "assistant", "message": {"content": None}},
        {"type": "assistant", "message": {"content": "a string"}},
        {"type": "assistant", "message": {"content": {"type": "text", "text": "a dict"}}},
        {"type": "assistant", "message": {"content": ["str", 5, None, [1], {"type": "text", "text": "kept"}]}},
        {"type": "assistant", "message": {"content": 5}},
        {"type": "assistant", "message": {"content": True}},
        {"type": "assistant", "message": {"content": 0}},
        {"type": "assistant", "message": {"content": [{"type": "thinking", "thinking": "hmm"}, {"type": None}, {}]}},
        assistant(text(5)),
        assistant(text(["a"])),
        assistant(text({"a": 1})),
        assistant(text(0)),
        assistant(text([])),
        assistant(tool(5, {})),
        assistant(tool(None, {"command": "x"})),
        assistant(tool("", {"command": "x"})),
        assistant(tool(["Bash"], {})),
        assistant({"type": "tool_use"}),
        assistant(tool("Bash", {"command": 5})),
        assistant(tool("Bash", {"command": ["ls"]})),
        assistant(tool("Grep", {"pattern": {"a": 1}})),
        assistant(tool("Edit", {"file_path": None})),
        assistant(tool("Edit", {"file_path": 5})),
        assistant(tool("Edit", {})),
        assistant(tool("Read", {"file_path": ["x"]})),
        assistant(tool("Edit", {"file_path": "/w/repo/a.py", "old_string": 5})),
        assistant(tool("Edit", {"file_path": "/w/repo/a.py", "new_string": ["x"]})),
        assistant(tool("Edit", {"file_path": "/w/repo/a.py", "old_string": 0, "new_string": False})),
        assistant(tool("MultiEdit", {"file_path": "/w/repo/a.py", "edits": "text"})),
        assistant(tool("MultiEdit", {"file_path": "/w/repo/a.py", "edits": {"a": 1}})),
        assistant(tool("MultiEdit", {"file_path": "/w/repo/a.py", "edits": 5})),
        assistant(tool("MultiEdit", {"file_path": "/w/repo/a.py", "edits": ["x"]})),
        assistant(tool("MultiEdit", {"file_path": "/w/repo/a.py", "edits": [{"new_string": "a"}, None]})),
        assistant(tool("Write", {"file_path": "/w/repo/a.py", "content": 5})),
        assistant(tool("mcp__kanban__ticket", {"action": 5})),
        assistant(tool("mcp__kanban__ticket", {"item": ["x"], "action": "a"})),
        assistant(tool("mcp__kanban__ticket", {"action": 0, "item": None, "ticket_id": 0, "project_id": 0})),
    ],
)

add(
    "user events",
    [
        user(result_of("t1", "$ pytest -q\n..F.\nFAILED tests/test_calc.py::test_sub\n1 failed, 3 passed in 0.12s\n")),
        user(result_of("t2", "Exit code 2\nboom", True)),
        user(result_of("t3", "Exit code 0\nfine")),
        user(result_of("t4", "  Exit code 3 not at the start", True)),
        user(result_of("t5", "\x1b[31mExit code 7\x1b[0m\n\x1b[31m\x1b[1m1 failed\x1b[0m, \x1b[32m3 passed\x1b[0m in 0.10s", True)),
        user(result_of("t6", [{"type": "text", "text": "first"}, {"type": "text", "text": "second ✓"}, {"type": "image"}, "skipped", None])),
        user(result_of("t7", [])),
        user(result_of("t8", None)),
        user(result_of("t9", "")),
        user(result_of("t10", {"a": 1, "b": [True, None, 1.5, "x'y"]})),
        user(result_of("t11", 42)),
        user(result_of("t12", 0)),
        user(result_of("t13", True)),
        user(result_of("t14", 1.0)),
        user(result_of("t15", "token " + SECRET, True)),
        user(result_of("t16", "e" * 400, True)),
        user(result_of("t17", "12 passing\n3 failing\n✗ renders the list\n× saves\nFAIL src/app.test.ts\nFAILED   spaced name  \n")),
        user(result_of("t18", "Tests: 2 FAILED, 10 PASSED")),
        user(result_of("t19", "ok", is_error=1)),
        user(result_of("t20", "ok", is_error="yes")),
        user({"type": "tool_result", "content": "no id"}),
        user({"type": "tool_result"}),
        user(result_of("t21", [{"type": "text", "text": 5}])),
        user(result_of("t22", [{"type": "text", "text": None}])),
        user(result_of("t23", [{"type": "text"}, {"text": "bare"}])),
        user(result_of("a", "one"), result_of("b", "two", True), text("plain")),
        user(text('<cross-session-message from="KAN-7 · Backend">Please rebase on main.</cross-session-message>')),
        user(text('before <cross-session-message from="a" id="1" kind="note">\n  first\n</cross-session-message> between <cross-session-message  from="b">' + LONG + "</cross-session-message> after")),
        user(text('<cross-session-message from="">key ' + SECRET + "</cross-session-message>")),
        user(text('<cross-session-message from="x">unterminated')),
        user(text("<cross-session-message>no from</cross-session-message>")),
        user(text("just text")),
        user(text(None)),
        user(text("")),
        user(text(5)),
        user(text(["x"])),
        {"type": "user", "message": {"content": '<cross-session-message from="str">as a string</cross-session-message>'}},
        {"type": "user", "message": {"content": ""}},
        {"type": "user", "message": {"content": None}},
        {"type": "user", "message": {"content": 5}},
        {"type": "user", "message": {"content": {"type": "tool_result"}}},
        {"type": "user", "message": "plain"},
        {"type": "user"},
        {"type": "user", "isReplay": True, "message": {"content": [{"type": "text", "text": '<cross-session-message from="x">replayed</cross-session-message>'}]}},
        {"type": "user", "isReplay": 1, "message": {"content": 5}},
        {"type": "user", "isReplay": False, "message": {"content": [result_of("r", "not a replay")]}},
        user(text('<cross-session-message from="sub">to a subagent</cross-session-message>'), parent="call-1"),
    ],
)

REPORT = {"status": "done", "summary": "Fixed add(); tests pass.", "lessons": ["Chạy pytest -q"], "open_items": []}
add(
    "results",
    [
        {"type": "result", "subtype": "success", "is_error": False, "result": "Fixed add(); tests pass.", "total_cost_usd": 0.0123, "usage": {"input_tokens": 100, "cache_creation_input_tokens": 20, "cache_read_input_tokens": 3, "output_tokens": 20}, "num_turns": 4, "session_id": "s-1", "modelUsage": {"claude-sonnet-4-5": {"contextWindow": 200000}, "claude-haiku-4-5": {"contextWindow": 1000000}}},
        {"type": "result", "subtype": "success", "is_error": False, "result": json.dumps(REPORT), "structured_output": REPORT, "total_cost_usd": 0.01, "session_id": "s-1"},
        {"type": "result", "subtype": "success", "result": "  " + json.dumps(REPORT) + " \n"},
        {"type": "result", "subtype": "success", "result": "{not json"},
        {"type": "result", "subtype": "success", "result": "[1, 2]"},
        {"type": "result", "subtype": "success", "result": '{"a": 1} trailing'},
        {"type": "result", "subtype": "success", "result": "text", "structured_output": [1]},
        {"type": "result", "subtype": "success", "result": "text", "structured_output": "str"},
        {"type": "result", "subtype": "success", "result": "{}", "structured_output": None},
        {"type": "result", "subtype": "success", "result": '{"k": "v"}', "structured_output": {}},
        {"type": "result", "subtype": "error_during_execution", "is_error": True, "result": "API Error: 529 Overloaded", "api_error_status": 529},
        {"type": "result", "subtype": "error_max_turns", "result": "", "num_turns": 30},
        {"type": "result", "subtype": "success", "is_error": True, "api_error": "usage_limit_reached", "api_error_status": 429, "result": "You've hit your weekly limit · resets 4pm (Asia/Saigon)"},
        {"type": "result", "is_error": False, "result": "no subtype"},
        {"type": "result", "subtype": None, "result": "null subtype"},
        {"type": "result", "subtype": "", "result": "empty subtype"},
        {"type": "result", "is_error": 1, "result": "truthy error"},
        {"type": "result", "result": "key " + SECRET},
        {"type": "result", "result": ["a", {"b": "Việt"}]},
        {"type": "result", "result": {"status": "done"}},
        {"type": "result", "result": 5},
        {"type": "result", "result": 0},
        {"type": "result", "result": None, "num_turns": 2},
        {"type": "result", "subtype": "success", "num_turns": 0, "result": ""},
        {"type": "result", "subtype": "success", "num_turns": 0},
        {"type": "result", "subtype": "success", "num_turns": 0.0},
        {"type": "result", "subtype": "success", "num_turns": False},
        {"type": "result", "subtype": "success", "num_turns": 0, "result": "{}"},
        {"type": "result", "subtype": "success", "num_turns": 0, "structured_output": {}},
        {"type": "result", "subtype": "success", "num_turns": 0, "result": "an answer"},
        {"type": "result", "subtype": "success", "num_turns": 0, "structured_output": {"a": 1}},
        {"type": "result", "subtype": "success", "num_turns": 0, "is_error": True},
        {"type": "result", "subtype": "error_during_execution", "num_turns": 0},
        {"type": "result", "subtype": "success", "num_turns": None},
        {"type": "result", "subtype": "success", "num_turns": "0"},
        {"type": "result", "subtype": "success", "num_turns": 1},
        {"type": "result", "subtype": "success", "num_turns": 0, "session_id": "kept", "modelUsage": {"m": {"contextWindow": 5}}},
        {"type": "result", "result": "costs", "total_cost_usd": "0.5"},
        {"type": "result", "result": "costs", "total_cost_usd": " 1e-3 "},
        {"type": "result", "result": "costs", "total_cost_usd": 3},
        {"type": "result", "result": "costs", "total_cost_usd": True},
        {"type": "result", "result": "costs", "total_cost_usd": None},
        {"type": "result", "result": "costs", "total_cost_usd": "free"},
        {"type": "result", "result": "costs", "total_cost_usd": [1]},
        {"type": "result", "result": "usage", "usage": {"input_tokens": "5", "cache_creation_input_tokens": 1.9, "cache_read_input_tokens": None, "output_tokens": True}},
        {"type": "result", "result": "usage", "usage": None},
        {"type": "result", "result": "usage", "usage": []},
        {"type": "result", "result": "usage", "usage": [1]},
        {"type": "result", "result": "usage", "usage": {"output_tokens": "x"}},
        {"type": "result", "result": "usage", "usage": {"input_tokens": 2**62, "cache_read_input_tokens": 2**62, "output_tokens": 2**62}},
        {"type": "result", "result": "windows", "modelUsage": {"a": {"contextWindow": 0}, "b": {}}},
        {"type": "result", "result": "windows", "modelUsage": {"a": {"contextWindow": "200000"}, "b": "skip", "c": None}},
        {"type": "result", "result": "windows", "modelUsage": {"a": {"contextWindow": 200000.7}}},
        {"type": "result", "result": "windows", "modelUsage": {"a": {"contextWindow": -5}}},
        {"type": "result", "result": "windows", "modelUsage": {}},
        {"type": "result", "result": "windows", "modelUsage": None},
        {"type": "result", "result": "windows", "modelUsage": []},
        {"type": "result", "result": "windows", "modelUsage": [{"contextWindow": 5}]},
        {"type": "result", "result": "windows", "modelUsage": {"a": {"contextWindow": "big"}}},
        {"type": "result", "result": "denials", "permission_denials": [{"tool_name": "Bash", "tool_input": {"command": "rm -rf /"}}, {"tool_name": "Write", "tool_input": "text"}, {"tool_name": "", "tool_input": {}}, {"tool_input": {}}, "str", None, {"tool_name": 5}]},
        {"type": "result", "result": "denials", "permission_denials": None},
        {"type": "result", "result": "denials", "permission_denials": "text"},
        {"type": "result", "result": "denials", "permission_denials": {"tool_name": "x"}},
        {"type": "result", "result": "denials", "permission_denials": 5},
        {"type": "result", "parent_tool_use_id": "call-1", "result": "a subagent's result"},
        {"type": "result"},
    ],
)

add(
    "lines that are not events",
    [
        "",
        "   ",
        "not json at all",
        "Segmentation fault (core dumped)",
        '{"type": "assi',
        '{"type": "assistant", "message": {"content": [{"type": "text", "text": "cut',
        "{",
        "{}",
        '  {"type": "system", "subtype": "init", "session_id": "padded"}  \r\n',
        '\t{"type": "system", "subtype": "init", "session_id": "tab"}\n',
        '\x1c{"type": "system", "subtype": "init", "session_id": "after a separator"}\x1f',
        "[1, 2, 3]",
        '"a string"',
        "null",
        "42",
        '[{"type": "system", "subtype": "init"}]',
        '{"type": "system", "subtype": "init", "session_id": "s"} trailing',
        '{"type": "system", "subtype": "init", "session_id": "s"}{"type": "result"}',
        '{"type": "system", "subtype": "init", "session_id": "dup", "session_id": "last wins"}',
        '{"type": 5}',
        '{"type": null}',
        '{"type": ["assistant"]}',
        '{"type": "ASSISTANT", "message": {"content": [{"type": "text", "text": "wrong case"}]}}',
        '{"type": "assistant", "message": {"content": [{"type": "text", "text": "escapes \\u00e9 \\ud83d\\ude00 \\n \\t \\" \\\\ \\/"}]}}',
        '{"type":"assistant","message":{"content":[{"type":"text","text":"compact json"}]}}',
        '{"type": "assistant", "message": {"content": [{"type": "text", "text": "' + "ท" * 50 + '"}]}}',
        '﻿{"type": "system", "subtype": "init", "session_id": "bom"}',
        '{"type": "system", "subtype": "init", "session_id": "s", }',
        "{'type': 'system'}",
        '{"type": "system", "subtype": "init", "session_id": 1e2, "model": 1.5}',
        '{"type": "system", "subtype": "init", "session_id": 12345678901234567890}',
    ],
)

add(
    "a result without a prior message",
    [
        {"type": "result", "subtype": "success", "is_error": False, "result": "pong", "session_id": "one-shot"},
    ],
)
add(
    "a whole run",
    [
        {"type": "system", "subtype": "init", "session_id": "run-1", "model": "claude-sonnet-4-5", "agents": ["reviewer"], "plugins": [{"name": "kanban"}], "tools": ["Bash"]},
        {"type": "system", "subtype": "hook_event", "hook_event_name": "SessionStart"},
        assistant(text("I will fix add() first."), usage={"input_tokens": 1200, "cache_read_input_tokens": 9000}),
        assistant(tool("Read", {"file_path": "/w/repo/calc.py"}, "r1")),
        user(result_of("r1", "def add(a, b):\n    return a - b\n")),
        assistant(tool("Edit", {"file_path": "/w/repo/calc.py", "old_string": "a - b", "new_string": "a + b"}, "e1")),
        user(result_of("e1", "The file was updated.")),
        assistant(tool("Bash", {"command": "pytest -q"}, "b1")),
        user(result_of("b1", "4 passed in 0.10s\n")),
        assistant(tool("Agent", {"subagent_type": "reviewer", "description": "Review the diff"}, "a1")),
        {"type": "system", "subtype": "task_started", "task_id": "tk1", "task_type": "local_agent", "tool_use_id": "a1", "subagent_type": "reviewer"},
        assistant(tool("Bash", {"command": "git diff --stat"}, "s1"), parent="a1", usage={"input_tokens": 300}),
        user(result_of("s1", " 1 file changed"), parent="a1"),
        assistant(text("Looks good."), parent="a1"),
        {"type": "system", "subtype": "task_updated", "task_id": "tk1", "patch": {"status": "completed", "end_time": 1760000005500}},
        user(result_of("a1", "Looks good.")),
        {"type": "system", "subtype": "compact_boundary", "compact_metadata": {"pre_tokens": 150000, "post_tokens": 30000}},
        {"type": "rate_limit_event", "rate_limit_info": {"status": "allowed", "resetsAt": 1760003600, "rateLimitType": "five_hour", "unifiedWindows": {"five_hour": {"utilization": 0.5, "resetsAt": 1760001800, "status": "allowed"}}}},
        user(text('<cross-session-message from="KAN-9">Do not touch sub().</cross-session-message>')),
        assistant(tool("SendMessage", {"to": "KAN-9", "message": "Understood."}, "m1")),
        assistant(tool("TodoWrite", {"todos": []}, "p1")),
        assistant(tool("StructuredOutput", REPORT, "o1")),
        {"type": "result", "subtype": "success", "is_error": False, "result": json.dumps(REPORT), "structured_output": REPORT, "total_cost_usd": 0.05, "usage": {"input_tokens": 1500, "cache_read_input_tokens": 9000, "output_tokens": 800}, "num_turns": 9, "session_id": "run-1", "modelUsage": {"claude-sonnet-4-5": {"contextWindow": 200000}}},
        {"type": "result", "subtype": "success", "is_error": False, "result": "", "num_turns": 0, "session_id": "run-1"},
    ],
)
add("another folder", [assistant(tool("Edit", {"file_path": "/srv/app/src/a.py"})), assistant(tool("Read", {"file_path": "/srv/app"})), assistant(tool("Write", {"file_path": "/srv/application/b.py", "content": "x"}))], cwd="/srv/app/")

text_out = json.dumps({"transcripts": transcripts}, ensure_ascii=False, indent=1)
OUT.write_text(text_out + "\n", encoding="utf-8")
raises = sum(1 for t in transcripts for o in t["outs"] if "raises" in o)
print(f"{OUT.name}: {len(transcripts)} transcripts, {sum(len(t['lines']) for t in transcripts)} lines ({raises} raise), {len(text_out)} bytes")
