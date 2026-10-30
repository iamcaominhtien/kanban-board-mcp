# C00 · Smoke

**Bug file:** `bugs/00-smoke.md` · **Bug ids:** `C00-001`, `C00-002`, …

**Persona:** Someone who just installed the app and wants to know it basically works.

**Goal:** In 30 minutes, walk the main path of every area once. Run this on every new build. It finds a broken build fast; it does not look for subtle bugs.

## Read first

The spec for this area. Behaviour that contradicts it is a `logic` bug.

- `docs/guideline/guide/chapters/03-quick-start.md`
- `README.md (Features)`

## Setup

Fresh database, no data.

Follow the setup in the [README](../README.md#setup).

## Try

Do these like a user would, then go beyond them: wrong input, cancel, undo, twice quickly, reload in the middle, two tabs. Tick them off as you go; add what you find on the way.

- [ ] Create the first project (name and key). The key starts every ticket number.
- [ ] Create a ticket from the board. Drag it through Backlog, To Do, In Progress, Done. Reload: it stays where you left it.
- [ ] Open the ticket. Write a description with a heading, a list and a pasted image. Add an acceptance criterion, a comment and a sub-ticket.
- [ ] Switch Board, List and Timeline. Filter and search.
- [ ] Docs: create a page, edit it, save a version, link to the ticket with its key.
- [ ] Idea Space: quick add (Alt+N), triage it from the Inbox, promote it to a ticket.
- [ ] Draw a sketch with `/draw` and save it.
- [ ] Settings: open every page once. Switch the theme.
- [ ] Open Ask AI (Ctrl+J) with no AI configured: the message must tell you what to do next.
- [ ] Reload, then stop and start the server: the app recovers without a manual refresh of data.

## Ask yourself

- Does the first minute make sense without reading anything?
- Would anything here make a careful user stop and doubt the app?

## Done when

- Every item above was tried, or its entry in the bug file says why it could not be.
- Each screen was seen in the light and the dark theme.
- The bug file is committed and pushed, and the last line of it says `Charter finished` with the date and the SHA tested.
