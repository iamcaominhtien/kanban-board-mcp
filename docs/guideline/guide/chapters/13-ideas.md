---
title: Idea Space
part: 4
audience: [everyone]
summary: Capture ideas fast, sort them in an Inbox, and promote the good ones to tickets.
reading: 9
---
The Idea Space is for thoughts that are not work yet. It is at workspace level, so ideas can belong to a project or to none. Open it from the view switcher (++Mod+6++ in the desktop app).

## Capture

Press ++Alt+N++ anywhere to quick-add an idea, or use **Make idea** on highlighted text. Every route ends in the **Inbox**.

## Triage the Inbox

Work through the Inbox from the keyboard:

| Key | Decision |
| --- | --- |
| ++K++ | **Keep**: it moves to Exploring |
| ++P++ | **Park**: it needs a date; on that date it returns to the Inbox once |
| ++M++ | **Merge** into a similar idea (undo for 10 minutes) |
| ++X++ | **Archive** (needs a reason) |
| ++Z++ | Undo the last move |

A duplicate search runs locally and needs no model.

## Stages

Inbox, Exploring, Ready, Building, Parked, Shipped, Archived. See them as a list, as stages or on an impact and strength matrix.

## The idea page

An idea is a page you write in the Docs editor. It also holds:

- **Assumptions**: each with impact, status and an optional test ticket.
- **Evidence**: links, files, tickets, notes, sketches and diagrams, which can support several assumptions.
- **“I want this” votes** and comments.
- A **research log**: note, research, interview, experiment, finding and decision entries.
- A **workspace folder** (`IDEA-n`) and an **activity trail**.

## Promote to a ticket

**Promote** shows a preview of the ticket. Evidence is carried over and the idea’s folder can be moved, copied or left. The ticket gets a small lightbulb, a “Started as an idea” block, and a **From an idea** filter. When the ticket is Done, the idea moves to Shipped.

!!! ai
    AI helpers (triage advice, **Shape with AI**, an **Ask** panel, a draft ticket on promote, a weekly digest) are on by default and can be switched off per project in {menu:Settings › Idea Space}. They use the project’s Board AI member with a daily cap of their own.

@figure settings-ideas "Settings › Idea Space: the AI helpers, who answers, and the cost cap."

!!! note "MCP"
    Agents can read ideas and add to the Inbox with {fact:idea_tool_count} tools, hidden unless `KANBAN_MCP_IDEA_TOOLS=1`. AI members cannot move, edit, merge, archive or promote an idea.
