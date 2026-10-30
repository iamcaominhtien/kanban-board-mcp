# C04 · Comments, attachments, members, activity, Recycle Bin

**Bug file:** `bugs/04-collaboration.md` · **Bug ids:** `C04-001`, `C04-002`, …

**Persona:** A team using the board together.

**Goal:** Everything people leave on a ticket or see about each other.

## Read first

The spec for this area. Behaviour that contradicts it is a `logic` bug.

- `docs/guideline/guide/chapters/07-comments.md`
- `design/components/ticket-comments.md`
- `design/components/attachments.md`
- `design/components/activity.md`
- `design/screens/members-view.md`
- `design/screens/preview-viewer.md`
- `design/screens/preview-types.md`

## Setup

A project with three members and a ticket with a long discussion.

Follow the setup in the [README](../README.md#setup).

## Try

Do these like a user would, then go beyond them: wrong input, cancel, undo, twice quickly, reload in the middle, two tabs. Tick them off as you go; add what you find on the way.

- [ ] Comments: add, edit, delete, reply or thread if any, markdown, mention a member (the box shows `@Name`, the saved text and the notification use the right thing: this was just changed in 3.15.1), paste an image, a sketch in a comment, a very long comment, Enter versus Ctrl+Enter.
- [ ] Mentions: the `@` list, filtering by typing, keyboard choice, mention of an AI member and what it says the mention will do, a mention in an old comment of a renamed or removed member.
- [ ] Attachments: upload, many files, large file, wrong type, same name twice, delete, download.
- [ ] File viewer (one viewer for every file): images, PDF, text, code, video, audio, an unknown type, open, zoom, next and previous, close, Draw on it.
- [ ] Activity log: every kind of change appears once with the right author (you, an AI agent, a named member), the filters, before and after values, links to the objects.
- [ ] Recycle Bin: delete a ticket, a doc page and an idea; restore; delete forever; what the empty state says.
- [ ] Real-time refresh: a change made in a second tab or by the MCP server appears without a reload and does not overwrite what you are typing.

## Ask yourself

- Would a team mate understand who did what from the screen alone?
- Would anything here make a careful user stop and doubt the app?

## Done when

- Every item above was tried, or its entry in the bug file says why it could not be.
- Each screen was seen in the light and the dark theme.
- The bug file is committed and pushed, and the last line of it says `Charter finished` with the date and the SHA tested.
