---
title: Board, List and Timeline
part: 2
audience: [everyone]
summary: Three views of the same tickets, and how to move work between them.
reading: 6
---
The Board, the List and the Timeline show the same tickets. Switch between them at the top of the project. In the desktop app you can also use the View menu, or ++Mod+1++ for Board, ++Mod+2++ for List and ++Mod+3++ for Timeline.

## Board

Columns are statuses. Drag a card to move it. Three things can stop a move:

- A ticket that is **blocked** by an open ticket asks you to confirm before it moves.
- A ticket marked **pending** asks for a confirmation before it goes to Done.
- A ticket with **Done requires** guards (for example every test case must pass) cannot go to Done until they are met.

Moving a ticket out of Done or Won’t Do asks for a reason, so reopening is on record. The card shows a reopen count.

@figure board-overview "The Board. (1) Switch between Board, List, Timeline, Docs and Schedules. (2) New Ticket. (3) Search tickets." markers=66,5;94,5;14,11

## List

The same tickets as rows, with sortable columns. Use it when you want to scan many tickets at once or compare estimates and dates.

@figure list-view "The List view, grouped by status."

## Timeline

Tickets with start and due dates appear as bars on a Gantt-style timeline, so you can see overlap and gaps.

@figure timeline-view "The Timeline. It stays empty until tickets have start or due dates."

## Filters

The filter bar narrows every view: type, priority, assignee, search, reopened tickets, pending tickets and tickets that began as an idea. Filters stay while you switch views.

!!! note "Docs and Schedules"
    The same switcher also holds **Docs** ({ch:docs}) and **Schedules** ({ch:schedules}). Search tickets is only on the ticket views, so {menu:Edit › Find in Board} takes you back to the Board first.

## Where to go next

Break a big ticket into parts: {ch:structure}.
