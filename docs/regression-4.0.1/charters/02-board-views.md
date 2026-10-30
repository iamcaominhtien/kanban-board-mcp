# C02 · Board, List, Timeline and filters

**Bug file:** `bugs/02-board-views.md` · **Bug ids:** `C02-001`, `C02-002`, …

**Persona:** A person who plans and moves work all day.

**Goal:** The three views, drag and drop, grouping, filters and search must be fast, correct and consistent with each other.

## Read first

The spec for this area. Behaviour that contradicts it is a `logic` bug.

- `docs/guideline/guide/chapters/05-views.md`
- `docs/guideline/guide/chapters/04-tickets.md`
- `design/screens/main-board.md`
- `design/screens/list-view.md`
- `design/screens/timeline-view.md`
- `design/components/drag-drop.md`
- `design/components/ticket-card.md`
- `design/components/board-grouping.md`
- `design/components/status-menu.md`

## Setup

A project with about 60 tickets: all types, priorities and statuses (Review, Testing, Pending, Won't do), some with dates, estimates, sub-tickets, tags, assignees and an AC progress.

Follow the setup in the [README](../README.md#setup).

## Try

Do these like a user would, then go beyond them: wrong input, cancel, undo, twice quickly, reload in the middle, two tabs. Tick them off as you go; add what you find on the way.

- [ ] Board: every column and its count; card contents (key, title, type, priority, estimate, tags, date, parent badge, AC progress, test case state, idea marker, schedule marker).
- [ ] Drag and drop: to another column, within a column, to an invalid place, with the keyboard, on a touch size, on a long board that scrolls, while the list is filtered, two cards quickly one after the other. Reload after each: is the order kept?
- [ ] Status menu on a card and in the ticket: every status transition, what is blocked (Done requires, blocked-by), Pending (needs a reason or date), Won't do, Reopen. Each dialog: Esc, backdrop click, Cancel.
- [ ] Grouping on the board, if offered.
- [ ] List view: sort, columns, selection, open a ticket, return to the same place.
- [ ] Timeline: tickets with and without dates, overdue, very long span, zoom or scroll, drag to change dates if possible, dependencies.
- [ ] Filters (type, priority, assignee, from idea) and search by title, key and tag: single, combined, cleared, zero results, in each view. Are the filters kept when switching views? After reload?
- [ ] Find in Board: Ctrl/⌘+Shift+F.
- [ ] Performance: scrolling and dragging with 300+ tickets.

## Ask yourself

- Can you tell, without opening a card, what it is and what state it is in?
- Is there feedback after every drop, even when the server is slow?
- Would anything here make a careful user stop and doubt the app?

## Done when

- Every item above was tried, or its entry in the bug file says why it could not be.
- Each screen was seen in the light and the dark theme.
- The bug file is committed and pushed, and the last line of it says `Charter finished` with the date and the SHA tested.
