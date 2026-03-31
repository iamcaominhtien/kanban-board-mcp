---
name: "Daily Standup"
description: "Generate a daily standup report from the Vibe Kanban board for this project. Shows what's in-progress, what was completed recently, and any blockers."
argument-hint: "Optional: mention your name or a specific date (defaults to today)"
agent: "agent"
tools: [vibe_kanban/get_issue, vibe_kanban/list_issues]
---

Generate a daily standup report for this project using the Vibe Kanban board.

**Project ID**: `39346b74-72ac-4595-a3f0-39f0c45f4f30`

## Steps

1. Call `mcp_vibe_kanban_list_issues` with the project ID to fetch all issues.
2. Group issues by status into three buckets:
   - **Done (since yesterday)** — issues with status `done` that appear recently completed
   - **In Progress** — issues currently `in_progress`
   - **Up Next / Blocked** — issues in `todo` or `backlog` that are high priority, or any flagged as blocked
3. For each in-progress issue, call `mcp_vibe_kanban_get_issue` to check for notes, blockers, or completion report details.

## Output Format

Print the standup in this format:

---

### Daily Standup — {today's date}

**✅ Done**
- [#{id}] {title} — {one-line summary from completion report if available}

**🔄 In Progress**
- [#{id}] {title} — {brief status note}

**⏭ Up Next**
- [#{id}] {title} — {priority if set}

**🚧 Blockers**
- {any blockers noted in issue descriptions, or "None"}

---

Keep entries concise — one line per issue. If there are no items in a bucket, write "None".
