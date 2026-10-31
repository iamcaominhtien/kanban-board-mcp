#!/usr/bin/env python3
"""A stand-in for `codex`: replays a real `codex exec --json` stream. FAKE_CLI_RECORD gets the command line and the
variables the board is supposed to set, FAKE_CLI_MODE picks a failure."""

import json
import os
import sys
import time
from pathlib import Path

args = sys.argv[1:]
mode = os.environ.get("FAKE_CLI_MODE", "finish")
if args[:1] == ["--version"]:
    print("codex-cli 9.9.9")
    sys.exit(0)
if args[:2] == ["login", "status"]:
    print("Logged in using ChatGPT" if mode != "logged_out" else "Not logged in")
    sys.exit(0 if mode != "logged_out" else 1)
record = os.environ.get("FAKE_CLI_RECORD")
if record:
    with open(record, "a") as fh:
        fh.write(
            json.dumps(
                {
                    "args": args,
                    "env": {
                        k: os.environ.get(k)
                        for k in (
                            "KANBAN_RUN_TOKEN",
                            "CODEX_HOME",
                            "OPENCODE_CONFIG_CONTENT",
                        )
                    },
                    "cwd": os.getcwd(),
                }
            )
            + "\n"
        )
if mode == "run_logged_out":
    sys.stderr.write("Not logged in. Please log in with codex login\n")
    sys.exit(1)
if mode == "silent":
    time.sleep(300)
for line in (
    (Path(__file__).parent / "real" / "codex_run.jsonl").read_text().splitlines()
):
    print(
        line.replace("/work", os.getcwd()), flush=True
    )  # the real CLI reports paths under its working folder
