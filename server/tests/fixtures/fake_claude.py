#!/usr/bin/env python3
"""A stand-in for the `claude` CLI used by the AI runner tests. FAKE_CLAUDE_MODE picks the behaviour."""

import json
import os
import subprocess
import sys
import time

args = sys.argv[1:]
mode = os.environ.get("FAKE_CLAUDE_MODE", "finish")


def emit(obj):
    print(json.dumps(obj), flush=True)


if args[:1] == ["--version"]:
    print("9.9.9 (Claude Code)")
    sys.exit(0)
if args[:2] == ["auth", "status"]:
    emit({"loggedIn": mode != "logged_out", "authMethod": "oauth_token"})
    sys.exit(0)
if "--output-format" in args and args[args.index("--output-format") + 1] == "json":
    if mode == "logged_out":
        emit(
            {
                "type": "result",
                "is_error": True,
                "result": "Not logged in · Please run /login",
            }
        )
        sys.exit(1)
    emit({"type": "result", "subtype": "success", "is_error": False, "result": "pong"})
    sys.exit(0)

record = os.environ.get("FAKE_CLAUDE_RECORD")
if record:
    with open(record, "a") as fh:
        fh.write(json.dumps(args) + "\n")
session = (
    args[args.index("--session-id") + 1]
    if "--session-id" in args
    else args[args.index("--resume") + 1]
)
emit(
    {
        "type": "system",
        "subtype": "init",
        "session_id": session,
        "model": "claude-haiku-test",
    }
)
if mode == "silent":
    time.sleep(300)
if mode == "spawn":
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(300)"])
    with open(os.environ["FAKE_CLAUDE_PIDFILE"], "w") as fh:
        fh.write(str(child.pid))
    emit(
        {
            "type": "assistant",
            "message": {"content": [{"type": "text", "text": "Working…"}]},
        }
    )
    time.sleep(300)
if mode == "sleep":
    emit(
        {
            "type": "assistant",
            "message": {"content": [{"type": "text", "text": "Thinking about it"}]},
        }
    )
    time.sleep(300)
emit(
    {
        "type": "assistant",
        "message": {
            "content": [
                {
                    "type": "tool_use",
                    "id": "t1",
                    "name": "Edit",
                    "input": {
                        "file_path": os.path.join(os.getcwd(), "calc.py"),
                        "old_string": "a - b",
                        "new_string": "a + b",
                    },
                },
                {
                    "type": "tool_use",
                    "id": "t2",
                    "name": "Bash",
                    "input": {"command": "pytest -q API_TOKEN=sk-ant\x2dsecret123456"},
                },
            ]
        },
    }
)
emit(
    {
        "type": "user",
        "message": {
            "content": [
                {
                    "type": "tool_result",
                    "tool_use_id": "t2",
                    "is_error": False,
                    "content": "$ pytest -q\n..F.\nFAILED tests/test_calc.py::test_sub\n1 failed, 3 passed in 0.12s\n",
                }
            ]
        },
    }
)
if mode == "ticks":
    # one step every 0.2 s for a while: the pause / resume tests watch the steps stop and continue
    for i in range(60):
        emit(
            {
                "type": "assistant",
                "message": {"content": [{"type": "text", "text": f"tick {i}"}]},
            }
        )
        time.sleep(0.2)
if mode == "rate_limit":
    emit(
        {
            "type": "result",
            "subtype": "error_during_execution",
            "is_error": True,
            "result": "API Error: 429 rate_limit_error. Retry after 30 seconds.",
        }
    )
    sys.exit(1)
if mode == "fail":
    emit(
        {
            "type": "result",
            "subtype": "error_during_execution",
            "is_error": True,
            "result": "Something broke",
        }
    )
    sys.exit(1)
if mode == "wait_question":
    # the test posts a question for this run while it waits, then lets it exit (FAKE_CLAUDE_GATE: once that file
    # exists, which the test creates right after asking)
    gate = os.environ.get("FAKE_CLAUDE_GATE")
    end = time.time() + float(
        os.environ.get("FAKE_CLAUDE_WAIT", "10" if gate else "1.5")
    )
    while time.time() < end and not (gate and os.path.exists(gate)):
        time.sleep(0.02)
emit(
    {
        "type": "result",
        "subtype": "success",
        "is_error": False,
        "result": "Fixed add(); tests pass.",
        "total_cost_usd": 0.01,
        "usage": {"input_tokens": 100, "output_tokens": 20},
        "session_id": session,
    }
)
