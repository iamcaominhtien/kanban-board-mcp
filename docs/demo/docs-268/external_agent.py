"""An external agent working in Docs over MCP only, for the #268 demo and check (no model: each step is the call an
agent would make).

    server/.venv/bin/python docs/demo/docs-268/external_agent.py <mcp url> <step> [state.json]

Steps, run one at a time by the demo so the screen shows each one land:
  setup    two tickets for the sign-in work
  spec     a spec page with a table, a highlight, a callout, a task list, linked to the two tickets
  picture  the sign-in design as a picture in the "Screens" section (docs_write upload)
  edit     one section changed, nothing else (docs_write edit with base_version)
  comment  a comment on one passage (quote)
  reply    the answer to the person's reply in that thread
  tickets  the open tasks of the page become tickets, their keys put on their lines
Prints what each call returned, briefly. State (ids) is kept in state.json.
"""

import asyncio
import json
import sys
from pathlib import Path

from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

URL, STEP = sys.argv[1], sys.argv[2]
STATE = Path(sys.argv[3] if len(sys.argv) > 3 else "/tmp/docs-268-state.json")
ROOT = Path(__file__).resolve().parents[3]
state = json.loads(STATE.read_text()) if STATE.exists() else {}

SPEC = """## Goal

A person signs in with email and password and lands on their board. ==Five failed attempts in a row lock the account for 15 minutes.==

## Screens

The sign-in page as designed.

## Rules

| Case | What the person sees |
|---|---|
| Wrong password | "Email or password is wrong" under the form |
| Empty field | The field is outlined in red |
| 5 failed attempts | The form is locked for 15 minutes |

> [!WARNING]
> The lock is per account, not per device: someone guessing from two laptops is still stopped.

## Work

The form is {form}; the lock is {lock}.

- [ ] Write the error copy with the designer
- [ ] Check the lock with QA on staging
"""


async def main() -> None:
    async with streamablehttp_client(URL) as (r, w, _):
        async with ClientSession(r, w) as s:
            await s.initialize()

            async def call(tool, **kw):
                out = await s.call_tool(tool, kw)
                if out.isError:
                    raise SystemExit(f"{tool} failed: {out.content[0].text if out.content else ''}")
                data = out.structuredContent
                if data is not None:
                    return data["result"] if set(data) == {"result"} else data
                return json.loads(out.content[0].text) if out.content else {}

            projects = await call("get_projects")
            rows = projects if isinstance(projects, list) else projects.get("projects", [])
            pid = state.get("project_id") or next(p["id"] for p in rows if p["name"] == "Kanban Board")
            state["project_id"] = pid
            if STEP == "setup":
                a = await call(
                    "manage_ticket", action="create", project_id=pid, title="Sign-in form", status="todo"
                )
                b = await call(
                    "manage_ticket",
                    action="create",
                    project_id=pid,
                    title="Lock the account after 5 failed sign-ins",
                    status="todo",
                )
                state["tickets"] = [a["id"], b["id"]]
                print("tickets", state["tickets"])
            elif STEP == "spec":
                guide = await call("docs_read", action="docs_guide")
                print("read docs_guide:", len(guide["guide"]), "chars")
                tree = await call("docs_read", action="list", project_id=pid)
                parent = next((n["id"] for n in tree if n["title"] == "Requirements"), None)
                form, lock = state["tickets"]
                page = await call(
                    "docs_write",
                    action="create",
                    project_id=pid,
                    title="Sign-in — spec",
                    parent_id=parent,
                    markdown=SPEC.format(form=form, lock=lock),
                )
                state["page_id"] = page["id"]
                print("page", page)
            elif STEP == "picture":
                shot = ROOT / "design" / "images" / "login" / "login-1-full-page.png"
                out = await call(
                    "docs_write",
                    action="upload",
                    path=str(shot),
                    name="sign-in-design.png",
                    page_id=state["page_id"],
                    section="Screens",
                )
                print("uploaded", out["markdown"], "page v", out["page"]["version"])
            elif STEP == "edit":
                got = await call("docs_read", action="get", page_id=state["page_id"], section="Rules")
                out = await call(
                    "docs_write",
                    action="edit",
                    page_id=state["page_id"],
                    section="Rules",
                    mode="append",
                    markdown="Locked accounts can be opened early by an admin from Settings › Members.",
                    base_version=got["version"],
                )
                print("edited", out["changed"], "v", out["version"])
            elif STEP == "comment":
                t = await call(
                    "docs_write",
                    action="comment",
                    page_id=state["page_id"],
                    quote="The lock is per account, not per device",
                    body="Should an admin get a notice when an account is locked? Security may want it.",
                )
                state["thread_id"] = t["id"]
                print("thread", t["id"], "on", t.get("quote"))
            elif STEP == "reply":
                threads = await call("docs_read", action="comments", page_id=state["page_id"], state="open")
                t = next(x for x in threads["threads"] if x["id"] == state["thread_id"])
                last = t["comments"][-1]["body"]
                print("person said:", last)
                out = await call(
                    "docs_write",
                    action="reply",
                    thread_id=state["thread_id"],
                    body="Done: the Rules table now says an admin gets a notice, and I left the thread open for you to resolve.",
                )
                await call(
                    "docs_write",
                    action="edit",
                    page_id=state["page_id"],
                    find="| 5 failed attempts | The form is locked for 15 minutes |",
                    markdown="| 5 failed attempts | The form is locked for 15 minutes; admins get a notice |",
                )
                print("replied", len(out["comments"]), "comments in the thread")
            elif STEP == "tickets":
                out = await call("docs_write", action="tickets", page_id=state["page_id"])
                print("tickets", [t["id"] + " " + t["title"] for t in out["tickets"]])
            STATE.write_text(json.dumps(state))


asyncio.run(main())
