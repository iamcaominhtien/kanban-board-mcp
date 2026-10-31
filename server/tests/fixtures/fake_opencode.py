#!/usr/bin/env python3
"""A stand-in for `opencode`: replays a real `opencode run --format json` stream."""

import json
import os
import sys
import time
from pathlib import Path

args = sys.argv[1:]
mode = os.environ.get("FAKE_CLI_MODE", "finish")
if args[:1] == ["--version"]:
    print("9.9.9")
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
                        for k in ("KANBAN_RUN_TOKEN", "OPENCODE_CONFIG_CONTENT", "XDG_DATA_HOME")
                    },
                    "cwd": os.getcwd(),
                }
            )
            + "\n"
        )
if mode == "silent":
    time.sleep(300)
for line in (Path(__file__).parent / "real" / "opencode_run.jsonl").read_text().splitlines():
    print(line.replace("/work", os.getcwd()), flush=True)  # the real CLI reports paths under its working folder
