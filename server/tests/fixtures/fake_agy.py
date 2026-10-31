#!/usr/bin/env python3
"""A stand-in for `agy`: replays a real `agy -p --output-format stream-json` stream."""

import json
import os
import sys
import time
from pathlib import Path

args = sys.argv[1:]
mode = os.environ.get("FAKE_CLI_MODE", "finish")
if args[:1] == ["--version"]:
    print("agy 9.9.9")
    sys.exit(0)
if args[:1] == ["models"]:
    if mode == "logged_out":
        sys.stderr.write("Error: Please sign in to view available models.\n")
        sys.exit(1)
    print(
        "Fetching available models..."
    )  # then one id<TAB>label per line, as the real CLI prints
    print("gemini-3.8-flash-high\tGemini 3.8 Flash (High)")
    print("claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)")
    sys.exit(0)
record = os.environ.get("FAKE_CLI_RECORD")
if record:
    with open(record, "a") as fh:
        fh.write(
            json.dumps(
                {
                    "args": args,
                    "env": {
                        k: os.environ.get(k)
                        for k in ("KANBAN_RUN_TOKEN", "KANBAN_MCP_URL", "HOME")
                    },
                    "cwd": os.getcwd(),
                }
            )
            + "\n"
        )
if mode == "run_logged_out":
    sys.stderr.write("Authentication expired. Please log in again.\n")
    sys.exit(1)
if mode == "silent":
    time.sleep(300)
for line in (Path(__file__).parent / "real" / "agy_run.jsonl").read_text().splitlines():
    print(
        line.replace("/work", os.getcwd()), flush=True
    )  # the real CLI reports paths under its working folder
