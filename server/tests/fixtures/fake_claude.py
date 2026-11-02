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
    if os.environ.get("FAKE_CLAUDE_JSON_HANG"):
        # a light model that never answers: its pid goes to that file, so a test can see it is not left behind
        with open(os.environ["FAKE_CLAUDE_JSON_HANG"], "w") as fh:
            fh.write(str(os.getpid()))
        time.sleep(300)
    # a one-shot call (a light model's diagnosis or lesson): FAKE_CLAUDE_JSON_RESULT is its answer
    emit(
        {
            "type": "result",
            "subtype": "success",
            "is_error": False,
            "result": os.environ.get("FAKE_CLAUDE_JSON_RESULT", "pong"),
        }
    )
    sys.exit(0)

record = os.environ.get("FAKE_CLAUDE_RECORD")
if record:
    with open(record, "a") as fh:
        fh.write(json.dumps(args) + "\n")
config_record = os.environ.get("FAKE_CLAUDE_CONFIG_RECORD")
if config_record:
    with open(config_record, "a") as fh:
        fh.write(os.environ.get("CLAUDE_CONFIG_DIR", "") + "\n")
cwd_record = os.environ.get("FAKE_CLAUDE_CWD_RECORD")
if cwd_record:  # where the run works, and the port it was given (worktrees)
    with open(cwd_record, "a") as fh:
        fh.write(
            json.dumps({"cwd": os.getcwd(), "port": os.environ.get("PORT")}) + "\n"
        )
if os.environ.get("FAKE_CLAUDE_COMMIT"):
    # the AI changes a file and commits it on its branch
    with open(os.path.join(os.getcwd(), "calc.py"), "w") as fh:
        fh.write(os.environ["FAKE_CLAUDE_COMMIT"])
    subprocess.run(["git", "add", "-A"], check=False, capture_output=True)
    subprocess.run(
        [
            "git",
            "-c",
            "user.email=ai@test",
            "-c",
            "user.name=AI",
            "commit",
            "-m",
            "AI change",
        ],
        check=False,
        capture_output=True,
    )
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
if os.environ.get("FAKE_CLAUDE_TEXT_MESSAGE"):
    # an event whose `message` is plain text, not an object (seen from a real CLI)
    emit({"type": "system", "message": os.environ["FAKE_CLAUDE_TEXT_MESSAGE"]})
if os.environ.get("FAKE_CLAUDE_RED_TESTS"):
    # a test command that fails, its summary coloured as pytest prints it on a terminal
    emit(
        {
            "type": "assistant",
            "message": {
                "content": [
                    {
                        "type": "tool_use",
                        "id": "red",
                        "name": "Bash",
                        "input": {"command": "python3 -m pytest -q"},
                    }
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
                        "tool_use_id": "red",
                        "is_error": True,
                        "content": "Exit code 1\n\x1b[31mFAILED\x1b[0m tests/test_calc.py::test_add\n"
                        "\x1b[31m\x1b[1m1 failed\x1b[0m, \x1b[32m3 passed\x1b[0m in 0.10s",
                    }
                ]
            },
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
quota_used = os.environ.get("FAKE_CLAUDE_QUOTA")
if quota_used or mode == "window":
    # Claude Code reports the account's usage window in every run (spike S5)
    rejected = mode == "window"
    emit(
        {
            "type": "rate_limit_event",
            "rate_limit_info": {
                "status": "rejected" if rejected else "allowed",
                "resetsAt": int(time.time()) + 3600,
                "rateLimitType": "seven_day" if rejected else "five_hour",
                "unifiedWindows": {
                    "five_hour": {
                        "utilization": float(quota_used or 0.3),
                        "resetsAt": int(time.time()) + 1800,
                        "status": "allowed",
                    },
                    "seven_day": {
                        "utilization": 1.0 if rejected else 0.1,
                        "resetsAt": int(time.time()) + 3600,
                        "status": "rejected" if rejected else "allowed",
                    },
                },
            },
        }
    )
if mode == "window":
    emit(
        {
            "type": "result",
            "subtype": "success",
            "is_error": True,
            "api_error": "usage_limit_reached",
            "api_error_status": 429,
            "result": "You've hit your weekly limit · resets 4pm (Asia/Saigon)",
        }
    )
    sys.exit(1)
if mode == "network":
    emit(
        {
            "type": "result",
            "subtype": "error_during_execution",
            "is_error": True,
            "api_error_status": 529,
            "result": "API Error: 529 Overloaded",
        }
    )
    sys.exit(1)
if mode == "crash":
    sys.stderr.write("Segmentation fault (core dumped)\n")
    sys.exit(139)
live = (
    "--input-format" in args
)  # the prompt and later messages arrive on stdin as stream-json
if live:
    try:
        prompt_text = json.loads(sys.stdin.readline())["message"]["content"][0]["text"]
    except (ValueError, KeyError, IndexError):
        prompt_text = ""
else:
    prompt_text = (
        args[args.index("-p") + 1]
        if "-p" in args and args.index("-p") + 1 < len(args)
        else ""
    )
if mode == "too_long" and "hand-over" not in prompt_text:
    # the conversation is too long until the board starts a fresh one with a hand-over note
    emit(
        {
            "type": "result",
            "subtype": "error_during_execution",
            "is_error": True,
            "result": "Prompt is too long",
        }
    )
    sys.exit(1)
if mode == "dev_server":
    # the AI starts a server in the foreground and the tool call never returns
    emit(
        {
            "type": "assistant",
            "message": {
                "content": [
                    {
                        "type": "tool_use",
                        "id": "srv",
                        "name": "Bash",
                        "input": {"command": "npm run dev"},
                    }
                ]
            },
        }
    )
    # its command line carries the command the AI ran, as a shell would
    server = subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(300)", "npm", "run", "dev"]
    )
    if os.environ.get("FAKE_CLAUDE_PIDFILE"):
        with open(os.environ["FAKE_CLAUDE_PIDFILE"], "w") as fh:
            fh.write(str(server.pid))
    if os.environ.get("FAKE_CLAUDE_HEARTBEAT"):
        # the real CLI says it is alive while a Bash call runs (every 30 s; here every 0.1 s)
        while server.poll() is None:
            emit(
                {
                    "type": "tool_progress",
                    "tool_use_id": "srv-heartbeat-0",
                    "tool_name": "Bash",
                    "parent_tool_use_id": "srv",
                    "elapsed_time_seconds": 30,
                    "heartbeat": True,
                }
            )
            time.sleep(0.1)
    server.wait()  # until the board stops it
    emit(
        {
            "type": "user",
            "message": {
                "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": "srv",
                        "is_error": True,
                        "content": "Command was killed",
                    }
                ]
            },
        }
    )
if mode == "skill" or os.environ.get("FAKE_CLAUDE_SKILL"):
    # a run that uses a skill and a subagent (the board counts them from the stream)
    emit(
        {
            "type": "assistant",
            "message": {
                "content": [
                    {
                        "type": "tool_use",
                        "id": "s1",
                        "name": "Skill",
                        "input": {"skill": "tdd:red-green"},
                    },
                    {
                        "type": "tool_use",
                        "id": "s2",
                        "name": "Task",
                        "input": {
                            "subagent_type": "Explore",
                            "description": "Find the add() callers",
                            "prompt": "Where is add() used?",
                        },
                    },
                ]
            },
        }
    )
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
fail_left = os.environ.get("FAKE_CLAUDE_FAIL_FILE")
if (
    fail_left
    and os.path.exists(fail_left)
    and os.environ.get("FAKE_CLAUDE_FAIL_STEP", "") in prompt_text
):
    # the step's run fails this many more times (the number in the file), then works
    left = int(open(fail_left).read().strip() or 0)
    if left > 0:
        with open(fail_left, "w") as fh:
            fh.write(str(left - 1))
        mode = "fail"
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
final_text = "Fixed add(); tests pass."
# Workflow roles answer from their prompt: a reviewer's verdicts come in order from FAKE_CLAUDE_REVIEW_FILE (one per
# line), a coordinator rules with FAKE_CLAUDE_RULING, Triage sets FAKE_CLAUDE_DEPTH
if "Review depth:" in prompt_text and os.environ.get("FAKE_CLAUDE_REVIEW_FILE"):
    path = os.environ["FAKE_CLAUDE_REVIEW_FILE"]
    lines = open(path).read().splitlines() if os.path.exists(path) else []
    verdict = lines[0] if lines else "PASS"
    with open(path, "w") as fh:
        fh.write("\n".join(lines[1:]))
    final_text = f"Reviewed the change.\nVERDICT: {verdict}"
elif "as the person would" in prompt_text and "You are the coordinator" in prompt_text:
    final_text = f"Looked at the design.\nDECISION: {os.environ.get('FAKE_CLAUDE_APPROVAL', 'APPROVE every state is drawn')}"
elif "failed twice" in prompt_text and "You are the coordinator" in prompt_text:
    final_text = f"Looked at it.\nDECISION: {os.environ.get('FAKE_CLAUDE_DECISION', 'RETRY run the tests with -x first')}"
elif "Split it by feature" in prompt_text:
    # the test creates the pieces while the coordinator "works", then lets it end (FAKE_CLAUDE_SPLIT_GATE)
    gate = os.environ.get("FAKE_CLAUDE_SPLIT_GATE")
    end = time.time() + 20
    while gate and time.time() < end and not os.path.exists(gate):
        time.sleep(0.02)
    final_text = f"Split it.\nSPLIT: {os.environ.get('FAKE_CLAUDE_SPLIT_KEYS', 'none')}"
elif "You are the coordinator" in prompt_text:
    final_text = f"Read both sides.\nVERDICT: {os.environ.get('FAKE_CLAUDE_RULING', 'REVIEWER')}\nThe criterion asks for it."
elif "DEPTH: light" in prompt_text and (
    os.environ.get("FAKE_CLAUDE_DEPTH")
    or os.environ.get("FAKE_CLAUDE_WORKFLOW")
    or os.environ.get("FAKE_CLAUDE_SPLIT")
):
    final_text = f"Sorted it.\nDEPTH: {os.environ.get('FAKE_CLAUDE_DEPTH', 'standard')}"
    if os.environ.get("FAKE_CLAUDE_WORKFLOW"):
        final_text += f"\nWORKFLOW: {os.environ['FAKE_CLAUDE_WORKFLOW']}"
    if os.environ.get("FAKE_CLAUDE_SPLIT"):
        final_text += f"\nSPLIT: {os.environ['FAKE_CLAUDE_SPLIT']}"
emit(
    {
        "type": "result",
        "subtype": "success",
        "is_error": False,
        "result": final_text,
        "total_cost_usd": 0.01,
        "usage": {"input_tokens": 100, "output_tokens": 20},
        "session_id": session,
    }
)
if live:
    for line in sys.stdin:  # messages a person sent while it worked, each one more turn
        try:
            text = json.loads(line)["message"]["content"][0]["text"]
        except (ValueError, KeyError, IndexError):
            continue
        emit(
            {
                "type": "user",
                "isReplay": True,
                "message": {"content": [{"type": "text", "text": text}]},
            }
        )
        emit(
            {
                "type": "result",
                "subtype": "success",
                "is_error": False,
                "result": f"Got it: {text}",
                "session_id": session,
            }
        )
