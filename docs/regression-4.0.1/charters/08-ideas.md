# C08 · Idea Space

**Bug file:** `bugs/08-ideas.md` · **Bug ids:** `C08-001`, `C08-002`, …

**Persona:** A product thinker who captures ideas all day.

**Goal:** Capture, triage, the idea page, promote and the links back to tickets.

## Read first

The spec for this area. Behaviour that contradicts it is a `logic` bug.

- `docs/guideline/guide/chapters/13-ideas.md`
- `docs/specs/idea-space.md`
- `design/screens/idea-capture-triage.md`
- `design/screens/idea-page.md`
- `design/screens/idea-space-views.md`
- `design/screens/idea-research-log-workspace-activity.md`
- `design/screens/idea-promote-migration.md`
- `design/screens/idea-ai-help.md`

## Setup

A workspace with two projects, 30 ideas in different stages, some with assumptions and evidence, and some with no project.

Follow the setup in the [README](../README.md#setup).

## Try

Do these like a user would, then go beyond them: wrong input, cancel, undo, twice quickly, reload in the middle, two tabs. Tick them off as you go; add what you find on the way.

- [ ] Quick add (Alt+N) from every screen, "Make idea" on highlighted text, an empty idea, a very long one.
- [ ] Inbox triage with the keyboard: Keep, Park (needs a date), Merge (undo for 10 minutes), Archive (needs a reason), Z to undo every move; the duplicate suggestions; a Parked idea whose date has come returns to the Inbox once.
- [ ] Views: list, stages and the impact/strength matrix; project switcher; filters.
- [ ] The idea page: the written page, assumptions (impact, status, test ticket), evidence of every kind (link, file, ticket, note, sketch, diagram) shared by several assumptions, "I want this" votes, comments, the research log with pin and "Use as evidence", the workspace folder and its keep rules, the activity trail, readiness from the assumptions.
- [ ] Promote: the preview, the evidence carried over, the folder moved, copied or left; the ticket's lightbulb, "Started as an idea" block and "From an idea" filter.
- [ ] Round trips: ticket Done moves the idea to Shipped; Won't do returns it to Exploring; a deleted ticket returns it to Ready; a test ticket for an assumption asks "validated or disproved?".
- [ ] With AI off or with no Board AI member: every AI button must be hidden or say why it is off.

## Ask yourself

- Is the triage faster than a spreadsheet? Where would a user hesitate?
- Would anything here make a careful user stop and doubt the app?

## Done when

- Every item above was tried, or its entry in the bug file says why it could not be.
- Each screen was seen in the light and the dark theme.
- The bug file is committed and pushed, and the last line of it says `Charter finished` with the date and the SHA tested.
