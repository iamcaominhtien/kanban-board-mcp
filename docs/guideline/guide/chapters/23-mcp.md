---
title: MCP for agents and developers
part: 7
audience: [developer, admin]
summary: The tools an agent sees, and how to connect Claude Code, VS Code and other clients.
reading: 10
standalone: mcp-guide
---
The server speaks MCP, so an agent can read and change your boards, Docs and AI team. It exposes **{fact:tool_count} tools** ({fact:idea_tool_count} more for the Idea Space when switched on). Each tool is a family of related actions chosen with `action`; the tool’s description lists every action and its parameters, and a wrong call is answered with what that action accepts.

## The tools

{fact:tool_names}

| Tool | Read or write | What it does |
| --- | --- | --- |
| `get_projects` | read | All projects, or one project with its members. |
| `list_tickets` | read | Compact, paginated ticket summaries (`status`, `priority`, `q`, `limit`, `offset`). |
| `get_ticket` | read | One ticket with its 10 most recent activity entries, or only its comments. |
| `docs_read` | read | The Docs tree: list, get, search, versions, recycle bin, link check, comments, diagrams and sketches. |
| `manage_project` | write | Create and update projects, add and remove members. |
| `manage_ticket` | write | Create, update, delete, move, block, link, and the workspace. |
| `ticket_items` | write | Comments, work log, criteria, sub-tasks and test cases. |
| `ticket_branches` | write | Git branches for a ticket. |
| `docs_write` | write | Create, update, move, duplicate, delete, restore, import pages, diagrams and sketches. |
| `ai_run` | write | Only inside a run the board started: ask a question, report. |
| `ai_schedules` | destructive | List, create, pause, resume, run and delete AI schedules. |
| `ai_team` | write | Read members, runs, usage and AI accounts; wake an AI, answer or cancel a run, create members, assign a member to an account. Approvals are decided in the board; only a person signs in to an account. |

!!! note "Good to know"
    The server sends usage instructions on connect and marks each tool as read-only or destructive. A failure is a real tool error whose message says how to fix the call. Omitted optional arguments mean “unchanged”; use `clear_fields` on a ticket update to empty a field. An @mention in a comment posted through MCP does **not** wake an AI.

## Connect an agent

### The easy way

Open {menu:Settings › Integrations} and use **MCP integrations**. Press **Install** for **Claude Code** (it runs `claude mcp add` in the User, Project or Local scope) or **Antigravity** (it adds a `kanban` entry to its MCP config). Each row also has Copy command, Copy JSON, Test connection and Remove, and only touches the `kanban` entry. In the desktop app, {menu:Help › Set Up MCP…} opens this page.

@figure settings-integrations "Settings › Integrations: install the MCP server into Claude Code or Antigravity, and set the draw.io editor."

### Stdio, for VS Code and Claude Desktop

The client starts the server as a subprocess; the database is created on first run. In VS Code’s `mcp.json` or the Claude Desktop config:

```json
{
  "servers": {
    "kanban": {
      "type": "stdio",
      "command": "uv",
      "args": ["--directory", "/path/to/kanban-board-mcp/server", "run", "mcp_stdio.py"]
    }
  }
}
```

### HTTP, with the full server running

Start the server ({ch:self-hosting}), then point any MCP client at `http://localhost:8000/mcp/`. The trailing slash is required.

## Idea Space tools

Hidden by default. Set `KANBAN_MCP_IDEA_TOOLS=1` to show them. `list_idea_tickets`, `get_idea_ticket`, `list_idea_assumptions` and `get_idea_activity_trail` read; `create_idea_ticket` adds to the Inbox, marked as suggested by AI with your reason. AI members cannot move, edit, merge, archive, delete or promote an idea.

## Diagram previews

A diagram an agent saves gets its picture from the draw.io editor in a hidden browser. See {ch:diagrams-sketch} for the setting and the variables.
