---
description: "Generate a daily standup report from the Kanban board."
---

// turbo
1. Fetch all issues from the Kanban board (Project ID: `39346b74-72ac-4595-a3f0-39f0c45f4f30`).
2. Group issues by status:
   - **Done (since yesterday)**
   - **In Progress**
   - **Up Next / Blocked**
3. For each in-progress issue, check for notes, blockers, or completion report details.
4. Format the output as follows:

### Daily Standup — {today's date}

**✅ Done**
- [#{id}] {title} — {summary}

**🔄 In Progress**
- [#{id}] {title} — {status}

**⏭ Up Next**
- [#{id}] {title} — {priority}

**🚧 Blockers**
- {blocker or "None"}

Keep entries concise (one line per issue).
