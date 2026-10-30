# C05 · Test cases, Debug Space, Workspace

**Bug file:** `bugs/05-quality-and-workspace.md` · **Bug ids:** `C05-001`, `C05-002`, …

**Persona:** Someone who tests and debugs a ticket and keeps files for it.

**Goal:** The per-ticket quality tools and the scratch folder.

## Read first

The spec for this area. Behaviour that contradicts it is a `logic` bug.

- `docs/guideline/guide/chapters/08-testing.md`
- `docs/guideline/guide/chapters/09-branches.md (Workspace)`
- `design/components/test-cases.md`
- `design/components/debug-space.md`
- `design/components/workspace.md`

## Setup

A ticket with children and acceptance criteria.

Follow the setup in the [README](../README.md#setup).

## Try

Do these like a user would, then go beyond them: wrong input, cancel, undo, twice quickly, reload in the middle, two tabs. Tick them off as you go; add what you find on the way.

- [ ] Test cases: add, edit, set pass, fail and running, notes and proof, children's cases shown on the parent, the AC link, "Done requires all passing" and the message when it blocks.
- [ ] Debug Space: add attempts, blockers and fixes; edit, delete, order; long text; markdown.
- [ ] Workspace: create folders and files, rename, move, delete, upload, open a file in the viewer, a name with spaces or Vietnamese, a very deep path, a large file, what the empty state says.
- [ ] How the three show on the card and in the activity log.

## Ask yourself

- Can a new user tell what each of the three is for?
- Would anything here make a careful user stop and doubt the app?

## Done when

- Every item above was tried, or its entry in the bug file says why it could not be.
- Each screen was seen in the light and the dark theme.
- The bug file is committed and pushed, and the last line of it says `Charter finished` with the date and the SHA tested.
