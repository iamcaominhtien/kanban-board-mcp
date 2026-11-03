"""An outside agent using the project memory over MCP only, for the #274 demo and check (no model: each step is the
call an agent would make).

    server/.venv/bin/python docs/demo/ai-memory-274/external_agent.py <mcp url> <project id>

It reads what the project remembers (instructions, lessons, the AIs' notes) with knowledge(action='memory'), then
proposes a lesson with knowledge(action='remember', scope='project'): a person keeps or drops it on the board.
"""

import asyncio
import json
import sys

from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

URL, PROJECT = sys.argv[1], sys.argv[2]


async def main() -> None:
    async with streamablehttp_client(URL) as (r, w, _):
        async with ClientSession(r, w) as s:
            await s.initialize()

            async def call(name, **kw):
                out = await s.call_tool(name, kw)
                if out.isError:
                    raise SystemExit(out.content[0].text)
                data = out.structuredContent
                if data is not None:
                    return data["result"] if set(data) == {"result"} else data
                return json.loads(out.content[0].text)

            mem = await call("knowledge", action="memory", project_id=PROJECT)
            print(
                f"memory: {len(mem['lessons'])} lessons, {len(mem['notes'])} notes;",
                "first note:",
                mem["notes"][0]["text"] if mem["notes"] else "-",
            )
            got = await call(
                "knowledge",
                action="remember",
                project_id=PROJECT,
                text="Release notes go in CHANGELOG.md under Unreleased, one line per change.",
            )
            print("proposed:", got["lesson"]["id"], got["lesson"]["state"])


asyncio.run(main())
