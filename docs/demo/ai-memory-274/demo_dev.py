#!/usr/bin/env python3
"""A scripted stand-in for the `claude` CLI, for the #274 demo video only (no model is called).

The board starts it as the AI member "Dev An" (role Dev). It does what a real run does through the board's MCP server,
with the run's own token from `--mcp-config`, and tells the board each step as Claude Code's stream-json would:

- **First run** (its prompt has no notes yet): the tests hang with plain `npm test`, work with `npm test -- --run`. It
  keeps that in its role's notes without being asked, keeps the person's request in the ticket's comments ("write in
  Vietnamese") as feedback, leaves a note on the ticket for the next run, and proposes a lesson for every AI.
- **A later run** (its prompt carries the notes): it reads them, runs the tests the right way at once, and writes its
  comment in Vietnamese: what one run learned changed what the next one did.

    cli_path = a wrapper that runs: server/.venv/bin/python docs/demo/ai-memory-274/demo_dev.py "$@"
"""

import asyncio
import json
import re
import sys
import time

args = sys.argv[1:]


def emit(obj):
    print(json.dumps(obj), flush=True)


if args[:1] == ["--version"]:
    print("9.9.9 (Claude Code)")
    sys.exit(0)

prompt = ""
if "--input-format" in args:
    try:
        prompt = json.loads(sys.stdin.readline())["message"]["content"][0]["text"]
    except (ValueError, KeyError, IndexError):
        prompt = ""
elif "-p" in args:
    prompt = args[args.index("-p") + 1]
system = args[args.index("--append-system-prompt") + 1] if "--append-system-prompt" in args else ""
config = json.loads(args[args.index("--mcp-config") + 1])["mcpServers"]["kanban"]
ticket = re.search(r'<ticket id="([A-Z]+-\d+)"', prompt)
ticket_id = ticket.group(1) if ticket else None
remembers = "npm test -- --run" in system
in_vietnamese = "tiếng Việt" in system
session = f"demo-dev-{ticket_id}"
emit({"type": "system", "subtype": "init", "session_id": session, "model": "demo"})


def say(text):
    emit({"type": "assistant", "message": {"content": [{"type": "text", "text": text}]}})


def tool(i, name, inp):
    emit({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": i, "name": name, "input": inp}]}})


def result(i, text, error=False):
    emit(
        {
            "type": "user",
            "message": {"content": [{"type": "tool_result", "tool_use_id": i, "content": text, "is_error": error}]},
        }
    )


async def work():
    from mcp import ClientSession
    from mcp.client.streamable_http import streamablehttp_client

    async with streamablehttp_client(config["url"], headers=config["headers"]) as (r, w, _):
        async with ClientSession(r, w) as s:
            await s.initialize()

            async def call(name, **kw):
                out = await s.call_tool(name, kw)
                data = out.structuredContent
                if data is not None:
                    return data["result"] if set(data) == {"result"} else data
                return json.loads(out.content[0].text) if out.content else {}

            async def mcp(i, name, **kw):
                tool(i, f"mcp__kanban__{name}", kw)
                got = await call(name, **kw)
                result(i, json.dumps(got)[:300])
                return got

            if not remembers:
                say("Reading the ticket, then running the UI tests before I change the export.")
                time.sleep(2)
                tool("b1", "Bash", {"command": "npm test"})
                time.sleep(3)
                result("b1", "Command timed out after 2m: vitest is in watch mode and never exits", error=True)
                say("Plain `npm test` watches and never ends. Trying `npm test -- --run`.")
                time.sleep(2)
                tool("b2", "Bash", {"command": "npm test -- --run"})
                time.sleep(2)
                result("b2", "Test Files  14 passed (14)\n     Tests  96 passed (96)")
                say("That works. Worth remembering, so no Dev pays for it again: saving it in the Dev role's notes.")
                time.sleep(2)
                await mcp(
                    "m1",
                    "knowledge",
                    action="remember",
                    text="Run the UI tests with `npm test -- --run`: plain `npm test` starts vitest in watch mode and "
                    "the run never ends.",
                )
                time.sleep(3)
                say("An asked in a comment for Vietnamese. That is a preference, not a one-off: keeping it as feedback.")
                time.sleep(2)
                await mcp(
                    "m2",
                    "knowledge",
                    action="remember",
                    kind="feedback",
                    text="An wants every comment and report written in Vietnamese (tiếng Việt).",
                )
                time.sleep(3)
                await mcp(
                    "m3",
                    "knowledge",
                    action="remember",
                    scope="ticket",
                    text="Fixed the quoting in ui/src/export/csv.ts. Not done: the header row still uses the old "
                    "column names; start there.",
                )
                time.sleep(3)
                say("One fact every AI on the project should know: proposing it as a lesson for a person to keep.")
                await mcp(
                    "m4",
                    "knowledge",
                    action="remember",
                    scope="project",
                    text="The CSV export must quote any field that contains a comma; its test is "
                    "ui/src/export/csv.test.ts.",
                )
                time.sleep(2)
                await mcp(
                    "c1",
                    "ticket_items",
                    ticket_id=ticket_id,
                    item="comment",
                    text="Đã sửa phần đặt dấu ngoặc kép cho trường có dấu phẩy trong `ui/src/export/csv.ts`.\n\n"
                    "```\n$ npm test -- --run\nTests  96 passed (96)\n```\n\nChưa xong: dòng tiêu đề vẫn dùng tên cột cũ.",
                )
                time.sleep(2)
                return
            say(
                "My notes from earlier runs: run the UI tests with `npm test -- --run` (plain `npm test` never ends), "
                + ("and An wants comments in Vietnamese. " if in_vietnamese else "")
                + "Doing it that way from the start."
            )
            time.sleep(3)
            tool("b1", "Bash", {"command": "npm test -- --run"})
            time.sleep(2)
            result("b1", "Test Files  15 passed (15)\n     Tests  101 passed (101)")
            time.sleep(2)
            await mcp(
                "c1",
                "ticket_items",
                ticket_id=ticket_id,
                item="comment",
                text="Đã thêm xuất CSV cho mục lưu trữ, theo cùng quy tắc đặt dấu ngoặc kép.\n\n"
                "```\n$ npm test -- --run\nTests  101 passed (101)\n```",
            )
            time.sleep(2)


asyncio.run(work())
emit(
    {
        "type": "result",
        "subtype": "success",
        "is_error": False,
        "result": "Done: notes kept for the next run." if not remembers else "Done, following my notes.",
        "total_cost_usd": 0,
        "usage": {"input_tokens": 0, "output_tokens": 0},
        "session_id": session,
    }
)
