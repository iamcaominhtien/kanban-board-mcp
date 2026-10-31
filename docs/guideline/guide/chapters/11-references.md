---
title: Comments and references
part: 3
audience: [everyone]
summary: Link pages and tickets to each other, and discuss a passage in place.
reading: 5
---
## Links between pages and tickets

Type `[[` to link to another page: `[[Page name]]` or `[[Page name#Section]]` to point at a heading. Type a ticket key such as `KAN-12` to refer to a ticket; it becomes a chip that shows the ticket’s title and status.

Every page lists what links to it under **Referenced by**, and a ticket lists the pages it links to. If you rename a page or a heading, links to it are rewritten, and a short note tells you about the heading change.

!!! tip
    Check a page for broken links before you publish. Over MCP, `docs_read check_links` does the same for a whole project.

## Comments

Select text in a page to start a comment thread on it. Threads can span several lines. Press ++Ctrl+Alt+M++ to comment on the selection. Anyone with access can reply; resolve a thread when the point is settled.

## Follow a page

Use **Follow** on a page to be told when it changes.

## Hide from AI

A page can be marked **Hide from AI**. A hidden page is skipped by every AI feature: Ask, summaries, checks, the Board AI chat, AI member runs and the MCP `docs_read` of an AI run. A page can instead be marked **Use as AI guidance**, and then it is added to every AI run in the project ({ch:safety}).
