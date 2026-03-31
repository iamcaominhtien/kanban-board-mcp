---
name: kanbander-delegation
description: When any agent needs to find, create, update, or ask about Kanban tickets, delegate to the kanbander agent instead of doing it yourself.
applyTo: "**"
---

# Delegate Kanban Work to the `kanbander` Agent

The `kanbander` agent is the **only** agent that should interact with the Kanban board.
All other agents — including the default agent — must **never** manage Kanban tickets directly.

## Always delegate to `kanbander` for

| Operation | Examples |
|---|---|
| **Search / find** | Look up a ticket by keyword, feature, or ID |
| **Create** | Open a new ticket for a bug, feature, or task |
| **Update** | Change status, priority, assignee, description |
| **Question / report** | "What tickets are in progress?", "Is there a ticket for X?" |
| **Link** | Associate a ticket with a PR, commit, or doc |

## How to delegate

Use `runSubagent` with `kanbander` as the agent name:

```
Use the kanbander agent to <task>
```

Examples:
- `Use the kanbander agent to find the ticket for the retry feature`
- `Use the kanbander agent to create a ticket: implement rate limiting on the translation API`
- `Use the kanbander agent to mark ticket #42 as done`
- `Use the kanbander agent to list all open tickets in the backlog`

## What NOT to delegate to `kanbander`

Keep in your own context:
- Reading a ticket result **only to inform your own implementation work**
- Technical decisions that have no Kanban tracking impact
