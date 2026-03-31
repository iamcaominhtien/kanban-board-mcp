---
name: work-logging
description: "Agent must log work to the active Kanban ticket description after completing meaningful steps, for transparency, maintainability, and continuity. Applies to all agents and all files. Also: report bugs found in SKILLS or MCP tools as Kanban bug tickets."
applyTo: "**"
---

# Work Logging & Transparency

## When Working on a Kanban Ticket

After each meaningful step, append a `## Work Log` section to the ticket description via the `kanbander` agent.

```
## Work Log

- [YYYY-MM-DD] <agent>: <what was done and why>
```

- Use ISO date format, identify the agent by name, 1–2 sentences per entry
- Never overwrite existing entries
- Delegate via: `Use the kanbander agent to update ticket #N description: append to Work Log — ...`

## When NOT on a Kanban Ticket

No logging needed — skip entirely.

## Bugs in SKILLS or MCP Tools

If a SKILL or MCP tool behaves unexpectedly, create a bug ticket via kanbander:

```
Title: [BUG] <SkillOrTool>: <short description>
- Attempted: ...
- Actual: ...
- Expected: ...
```

Then continue with a workaround if possible.
