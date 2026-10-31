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
# With FAKE_CLAUDE_ACCOUNTS=1 a login is the file <CLAUDE_CONFIG_DIR>/.fake-login (its text is the email), so tests can
# have several accounts that are signed in or out independently, like the real CLI with CLAUDE_CONFIG_DIR.
accounts_on = os.environ.get("FAKE_CLAUDE_ACCOUNTS") == "1"
login_file = os.path.join(os.environ.get("CLAUDE_CONFIG_DIR", ""), ".fake-login")
if args[:2] == ["auth", "status"]:
    if accounts_on:
        ok = os.path.isfile(login_file)
        emit(
            {
                "loggedIn": ok,
                "authMethod": "claude.ai" if ok else "none",
                "email": open(login_file).read().strip() if ok else None,
                "subscriptionType": "max" if ok else None,
            }
        )
        sys.exit(0)
    emit({"loggedIn": mode != "logged_out", "authMethod": "oauth_token"})
    sys.exit(0)
if args[:2] == ["auth", "logout"]:
    if accounts_on and os.path.isfile(login_file):
        os.remove(login_file)
    sys.exit(0)
if args[:2] == ["auth", "login"]:  # the sign-in the board runs in a terminal
    print("Opening your browser to sign in…")
    print(
        "If it does not open, visit: https://claude.example/oauth/authorize?code=true&client_id=x",
        flush=True,
    )
    code = input("Paste code here if prompted > ")
    if code.strip() != "good":
        print("Invalid or expired code")
        sys.exit(1)
    with open(login_file, "w") as fh:
        fh.write(os.environ.get("FAKE_CLAUDE_EMAIL", "an@work.example"))
    print("Login successful", flush=True)
    sys.exit(0)
if "--output-format" in args and args[args.index("--output-format") + 1] == "json":
    if os.environ.get(
        "FAKE_CLAUDE_CONFIG_RECORD"
    ):  # a test run records which account it ran as
        with open(os.environ["FAKE_CLAUDE_CONFIG_RECORD"], "a") as fh:
            fh.write(os.environ.get("CLAUDE_CONFIG_DIR", "") + "\n")
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
config_record = os.environ.get("FAKE_CLAUDE_CONFIG_RECORD")
if config_record:
    with open(config_record, "a") as fh:
        fh.write(os.environ.get("CLAUDE_CONFIG_DIR", "") + "\n")
env_record = os.environ.get("FAKE_CLAUDE_ENV_RECORD")
if env_record:
    with open(env_record, "a") as fh:
        fh.write(os.environ.get("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE", "") + "\n")
session = (
    args[args.index("--session-id") + 1]
    if "--session-id" in args
    else args[args.index("--resume") + 1]
)
if (
    mode == "no_conversation" and "--resume" in args
):  # the CLI cannot find the conversation (other folder)
    emit(
        {
            "type": "result",
            "subtype": "error_during_execution",
            "is_error": True,
            "result": "No conversation found with session ID: " + session,
        }
    )
    sys.exit(1)
if mode == "run_logged_out":  # the session expired between two runs
    sys.stderr.write("Not logged in. Please log in with claude auth login\n")
    sys.exit(1)
config_dir = os.environ.get("CLAUDE_CONFIG_DIR")
if config_dir:  # the real CLI keeps each conversation as a file; the runner checks for it before resuming
    folder = os.path.join(config_dir, "projects", "fake")
    os.makedirs(folder, exist_ok=True)
    open(os.path.join(folder, session + ".jsonl"), "a").close()
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
