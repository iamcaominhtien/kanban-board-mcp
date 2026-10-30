#!/usr/bin/env python3
"""A stand-in for the `antigravity` (agy) CLI used by the Antigravity runner tests. FAKE_AGY_MODE picks the behaviour;
FAKE_AGY_RECORD gets one JSON line per run: {args, cwd, mcp}, where mcp is the `.agents/mcp_config.json` it found."""

import json
import os
import sys
import uuid

args = sys.argv[1:]
mode = os.environ.get("FAKE_AGY_MODE", "finish")


def emit(obj):
    print(json.dumps(obj), flush=True)


if args[:1] == ["--version"]:
    print("1.4.11")
    sys.exit(0)

if "--output-format" in args and args[args.index("--output-format") + 1] == "json":
    if mode == "logged_out":
        print("Error: please sign in first", file=sys.stderr)
        sys.exit(1)
    emit({"conversation_id": "t", "status": "SUCCESS", "response": "pong\n"})
    sys.exit(0)

mcp_file = os.path.join(os.getcwd(), ".agents", "mcp_config.json")
record = os.environ.get("FAKE_AGY_RECORD")
if record:
    mcp = None
    if os.path.isfile(mcp_file):
        with open(mcp_file) as fh:
            mcp = json.load(fh)
    with open(record, "a") as fh:
        fh.write(json.dumps({"args": args, "cwd": os.getcwd(), "mcp": mcp}) + "\n")

cid = (
    args[args.index("--conversation") + 1]
    if "--conversation" in args
    else str(uuid.uuid4())
)
home = os.environ.get("KANBAN_AGY_HOME")
if home:  # the real CLI keeps each conversation as a file; the runner checks for it before resuming
    folder = os.path.join(home, "antigravity-cli", "conversations")
    os.makedirs(folder, exist_ok=True)
    open(os.path.join(folder, cid + ".db"), "a").close()


def step(index, **fields):
    emit(
        {
            "event": "step_update",
            "step_update": {"conversation_id": cid, "step_index": index, **fields},
        }
    )


emit(
    {
        "event": "init",
        "conversation_id": cid,
        "init": {"model": "gemini-test", "cwd": os.getcwd(), "tools": ["run_command"]},
    }
)
step(0, state="DONE", step_type="user_input")
if mode == "fail":
    print("AGY_ERROR: the model failed", file=sys.stderr)
    emit(
        {
            "event": "result",
            "result": {
                "conversation_id": cid,
                "status": "ERROR",
                "response": "The model failed",
                "num_turns": 1,
            },
        }
    )
    sys.exit(3)
if mode == "refuse" and "--conversation" not in args:
    # a refused action: the real CLI ends the turn with nothing said
    step(1, state="ACTIVE", step_type="tool", tool_name="run_command", tool_info={"name": "run_command", "parameters": {"CommandLine": "node -v"}})
    step(1, state="ERROR", step_type="tool", tool_name="run_command", tool_info={"name": "run_command", "parameters": {"CommandLine": "node -v"}, "error": {"type": "TOOL_ERROR", "message": 'permission check failed for unsandboxed "node -v": user denied permission to run command'}})
    emit({"event": "result", "result": {"conversation_id": cid, "status": "SUCCESS", "response": "", "num_turns": 1, "denied_actions": [{"action": "command", "display_name": "RunCommand"}]}})
    sys.exit(0)
if mode == "refuse_always":
    step(1, state="ERROR", step_type="tool", tool_name="run_command", tool_info={"name": "run_command", "parameters": {"CommandLine": "node -v"}, "error": {"type": "TOOL_ERROR", "message": 'permission check failed for unsandboxed "node -v": user denied permission to run command'}})
    emit({"event": "result", "result": {"conversation_id": cid, "status": "SUCCESS", "response": "", "num_turns": 1, "denied_actions": [{"action": "command", "display_name": "RunCommand"}]}})
    sys.exit(0)
work = "--mode" in args
if work:
    step(
        1,
        state="ACTIVE",
        step_type="tool",
        tool_name="write_file",
        tool_info={"name": "write_file", "parameters": {"Path": "/work/calc.py"}},
    )
    step(
        1,
        state="DONE",
        step_type="tool",
        tool_name="write_file",
        tool_info={
            "name": "write_file",
            "parameters": {"Path": "/work/calc.py"},
            "output": "ok",
        },
    )
step(
    2,
    state="ACTIVE",
    step_type="tool",
    tool_name="run_command",
    tool_info={
        "name": "run_command",
        "parameters": {"CommandLine": "pytest -q API_TOKEN=sk-ant\x2dsecret123456"},
    },
)
step(
    2,
    state="DONE",
    step_type="tool",
    tool_name="run_command",
    tool_info={
        "name": "run_command",
        "parameters": {"CommandLine": "pytest -q"},
        "output": "1 failed, 3 passed in 0.12s",
    },
)
step(
    3,
    state="ACTIVE",
    step_type="tool",
    tool_name="call_mcp_tool",
    tool_info={
        "name": "call_mcp_tool",
        "parameters": {
            "ServerName": "board",
            "ToolName": "get_ticket",
            "Arguments": {"ticket_id": "T-1"},
        },
    },
)
step(
    3,
    state="ERROR",
    step_type="tool",
    tool_name="call_mcp_tool",
    tool_info={
        "name": "call_mcp_tool",
        "parameters": {"ServerName": "board", "ToolName": "get_ticket"},
        "error": {
            "type": "TOOL_ERROR",
            "message": "permission check failed for mcp board/get_ticket",
        },
    },
)
step(4, state="ACTIVE", step_type="agent_response", text_delta="Fixed ")
step(
    4,
    state="DONE",
    step_type="agent_response",
    text_delta="it\n",
    usage={
        "input_tokens": 1000,
        "output_tokens": 20,
        "thinking_tokens": 5,
        "cache_read_tokens": 200,
        "total_tokens": 1225,
    },
)
result = {
    "conversation_id": cid,
    "status": "SUCCESS",
    "response": "Fixed it\n",
    "num_turns": 1,
    # the whole conversation, so a resumed run must not count it again
    "usage": {"input_tokens": 99999, "output_tokens": 9999},
}
if mode == "denied":
    result["denied_actions"] = [{"action": "command", "display_name": "RunCommand"}]
emit({"event": "result", "result": result})
