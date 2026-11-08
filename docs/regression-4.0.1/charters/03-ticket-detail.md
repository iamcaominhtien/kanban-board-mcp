# C03 · Ticket detail

**Bug file:** `bugs/03-ticket-detail.md` · **Bug ids:** `C03-001`, `C03-002`, …

**Persona:** Someone writing a careful ticket and keeping it up to date.

**Goal:** Everything inside an open ticket: the description editor and every section.

## Read first

The spec for this area. Behaviour that contradicts it is a `logic` bug.

- `docs/guideline/guide/chapters/04-tickets.md`
- `docs/guideline/guide/chapters/06-structure.md`
- `design/components/ticket-detail.md`
- `design/components/description-markdown.md`
- `design/components/new-ticket.md`
- `design/components/add-ac.md`
- `design/components/add-subticket.md`
- `design/components/relations.md`
- `design/components/tags.md`
- `design/components/ticket-detail-parent.md`
- `design/components/ticket-pending.md`
- `design/components/ticket-reopen.md`

## Setup

A project with tickets that have parents, children and links.

Follow the setup in the [README](../README.md#setup).

## Try

Do these like a user would, then go beyond them: wrong input, cancel, undo, twice quickly, reload in the middle, two tabs. Tick them off as you go; add what you find on the way.

- [ ] New ticket: every field, validation, create and keep adding, cancel with unsaved text (is the user warned?).
- [ ] Title and fields: inline edit, Esc to cancel, Enter to save, blur to save, a failed save.
- [ ] Description editor: headings, bold, italic, links, lists, task lists, tables (add and remove rows and columns), code blocks with language, quotes, rules, paste text from the web and from Word, paste and upload images, drop a file, `/` menu, drag handle, undo and redo, very long text, round trip: what you saved is what you get after a reload.
- [ ] Acceptance criteria: add, edit, check, reorder, delete; progress on the card; the effect on Done.
- [ ] Sub-tickets and sub-tasks: add, open, change status, delete, what the parent shows, a parent of a parent, moving a child.
- [ ] Blocks, blocked-by and links: add, remove, a cycle, a link to a deleted ticket, Done blocked by an open blocker and the message about it.
- [ ] Estimates and dates: formats, past dates, end before start, clearing.
- [ ] Type, priority, tags (new tag, long tag, many tags), assignee.
- [ ] Work log, Pending, Won't do, Reopen dialogs.
- [ ] Keyboard keys on an open ticket (see the guide) and Esc to close; the browser Back button; a ticket URL opened directly; navigating to the next and previous ticket if offered.
- [ ] Delete a ticket: confirmation, effect on children and links, Recycle Bin and restore.

## Ask yourself

- Is it obvious what is saved and what is not? Is there ever a moment of doubt?
- Can the user lose typed text by closing, clicking out or reloading?
- Would anything here make a careful user stop and doubt the app?

## Done when

- Every item above was tried, or its entry in the bug file says why it could not be.
- Each screen was seen in the light and the dark theme.
- The bug file is committed and pushed, and the last line of it says `Charter finished` with the date and the SHA tested.
