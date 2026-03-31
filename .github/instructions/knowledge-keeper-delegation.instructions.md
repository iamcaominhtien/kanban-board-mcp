---
name: knowledge-keeper-delegation
description: When handling docs or project memory, delegate to the knowledge-keeper agent instead of doing it yourself. For Kanban tickets, use the `kanbander` agent.
applyTo: "**"
---

# Delegate to the `knowledge-keeper` Agent

When you encounter any of the tasks below, **do not handle them yourself** — delegate to the `knowledge-keeper` agent instead.

> **Kanban tickets** are handled by the `kanbander` agent, so delegate to it for anything related to the Kanban board.

## Tasks to delegate

| Task | Examples |
|---|---|
| **Documentation** | Create, update, or clean up any file in `docs/`; generate the index; write arch docs, BA specs, ADRs, test plans, API references |
| **Memory / project knowledge** | Store or retrieve architectural decisions, bug fixes, coding patterns, recurring conventions |

## How to delegate

Use `runSubagent` with `knowledge-keeper` as the agent name:

```
Use the knowledge-keeper agent to <task>
```

Examples:
- `Use the knowledge-keeper agent to create an architecture doc for the translation service`
- `Use the knowledge-keeper agent to store this decision: we use Redis for caching because…`

## What NOT to delegate

Keep in your own context:
- Reading existing docs **only to inform your own work** (not to manage them)
- Technical implementation decisions that have no documentation or memory impact
