---
title: Tickets
part: 2
audience: [everyone]
summary: Create a ticket, describe it, set its type, priority and status, and find it again.
reading: 8
---
A ticket is one piece of work. Create it when you want to track something, even if you are the only person who will ever see it.

## Create a ticket

1. Open the project and press **New Ticket** (++Mod+N++ in the desktop app).
2. Type a title. Everything else can wait.
3. Choose a type and a priority if you know them.
4. Press **Create Ticket**. The ticket appears in the Backlog.

@figure new-ticket "The New Ticket window, opened from the board."

!!! tip
    Start with only a title. Add a description, tags and dates once the work is real. If the idea is not ready to be work yet, put it in the Idea Space instead ({ch:ideas}).

## Types, priorities and statuses

| Field | Values |
| --- | --- |
| Type | {fact:ticket_types} |
| Priority | {fact:ticket_priorities} |
| Status | {fact:ticket_statuses} |

`wont_do` is shown as **Won’t Do**. Tickets set to Won’t Do leave the board and go to the Recycle Bin, where they can be restored.

## The description

The description is written in a WYSIWYG editor and stored as plain Markdown. You can use tables, task lists, code blocks and pasted or uploaded images. Press ++Mod+J++ or type `/ai` to get AI help in the editor ({ch:board-ai}), and use **Sketch** to draw a picture in place ({ch:diagrams-sketch}).

## What else a ticket holds

- **Acceptance criteria**: lines that say when the work is done ({ch:structure}).
- **Sub-tickets, links and blockers** ({ch:structure}).
- **Comments and attachments** ({ch:comments}).
- **Test cases** and a **Debug Space** journal ({ch:testing}).
- **Branches** and a **Workspace** folder ({ch:branches}).
- **Estimates, dates and assignees**, and an **Activity** log of who changed what: you, an AI agent or a named member.

@figure ticket-detail "A ticket: description, acceptance criteria, relations and, on the right, status, branch, assignee, priority and “Done requires” guards."

## Keyboard keys on an open ticket

With a ticket open and no text box focused, ++R++ reopens a Done or Won’t Do ticket and ++P++ sets it pending (or resumes it).

## Finding tickets

Type in **Search tickets…** on the board. The search runs on the server and ignores small typing mistakes. Use the filters for type, priority and assignee. In the desktop app, {menu:Edit › Find in Board} moves the cursor to the search box (++Mod+Shift+F++).

## Where to go next

Views of the same tickets are in {ch:views}. If a ticket gets large, split it ({ch:structure}).
