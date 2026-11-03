#!/usr/bin/env python3
"""A scripted stand-in for the `claude` CLI, for the #268 demo video only (no model is called).

The board starts it as the AI member "Reviewer" was given a page to review. It does what a real run does through the
board's MCP server, with the run's own token from `--mcp-config`: it reads the page the run's prompt lists under
"Docs pages tied to this ticket", comments on one passage of it (docs_write comment with quote) and sums up on the
ticket, telling the board each step as Claude Code's stream-json would, slowly enough to be seen on the page.

    cli_path = a wrapper that runs: server/.venv/bin/python docs/demo/docs-268/demo_reviewer.py "$@"
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
config = json.loads(args[args.index("--mcp-config") + 1])["mcpServers"]["kanban"]
ticket = re.search(r'<ticket id="([A-Z]+-\d+)"', prompt)
ticket_id = ticket.group(1) if ticket else None
page = re.search(r"page_id ([0-9a-f-]{36})", prompt)
page_id = page.group(1) if page else None
session = "demo-reviewer-session"
emit({"type": "system", "subtype": "init", "session_id": session, "model": "demo"})


def tool(i, name, inp):
    emit(
        {
            "type": "assistant",
            "message": {"content": [{"type": "tool_use", "id": i, "name": f"mcp__kanban__{name}", "input": inp}]},
        }
    )


def result(i, text):
    emit({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": i, "content": text}]}})


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

            emit({"type": "assistant", "message": {"content": [{"type": "text", "text": "Reading the page first."}]}})
            time.sleep(2)
            tool("r1", "docs_read", {"action": "docs_guide"})
            await call("docs_read", action="docs_guide")
            result("r1", "guide read")
            time.sleep(3)
            tool("r2", "docs_read", {"action": "get", "page_id": page_id})
            got = await call("docs_read", action="get", page_id=page_id)
            result("r2", got.get("title", ""))
            time.sleep(4)
            quote = next(
                (
                    ln.strip()
                    for ln in got.get("markdown", "").splitlines()
                    if "attempts" in ln and not ln.lstrip().startswith(("|", "#", ">", "-"))
                ),
                None,
            )
            if quote:
                # the sentence about the attempts, as plain text (the highlight marks are not part of what is read)
                quote = next(
                    (x for x in quote.replace("==", "").split(". ") if "attempts" in x),
                    quote,
                ).rstrip(".")
                tool("c1", "docs_write", {"action": "comment", "page_id": page_id, "quote": quote})
                await call(
                    "docs_write",
                    action="comment",
                    page_id=page_id,
                    quote=quote,
                    body="What does the person see after the 5th failed try? Name the message and how long the lock lasts, so QA can test it.",
                )
                result("c1", "commented")
                time.sleep(4)
            if ticket_id:
                tool("t1", "ticket_items", {"ticket_id": ticket_id, "item": "comment"})
                await call(
                    "ticket_items",
                    ticket_id=ticket_id,
                    item="comment",
                    text=f"Reviewed [[{got.get('title', 'the page')}]]: one point to fix, commented on the passage. The rest reads well.",
                    author="Reviewer",
                )
                result("t1", "posted")
                time.sleep(2)


asyncio.run(work())
emit(
    {
        "type": "result",
        "subtype": "success",
        "is_error": False,
        "result": "Reviewed the page: one comment on the lockout passage.",
        "total_cost_usd": 0,
        "usage": {"input_tokens": 0, "output_tokens": 0},
        "session_id": session,
    }
)
